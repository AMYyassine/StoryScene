"""Acceptance tests for state transitions, imports and model boundaries. No paid API calls."""
import copy
import io
import json
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient
from docx import Document
from pypdf import PdfWriter
from pypdf.generic import DictionaryObject, NameObject, DecodedStreamObject

from app import main
from app.domain import DomainError, apply_patch, delete_exact_ranges, demo_document, document_hash, local_structure, scope_blocks
from app.store import Store


class StorysceneTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.old_store, self.old_provider = main.store, main.provider
        main.store = Store(self.temp.name)
        from app.providers import HuggingFaceProvider
        main.provider = HuggingFaceProvider()
        main.provider.token, main.provider.model = "", ""
        self.client = TestClient(main.app)
        self.headers = {"X-Storyscene": "local-app"}
        self.p = self.client.post("/api/projects", json={"demo": True}, headers=self.headers).json()

    def tearDown(self):
        self.client.close()
        main.store, main.provider = self.old_store, self.old_provider
        self.temp.cleanup()

    def send(self, endpoint, data=None, method="post", code=200):
        response = getattr(self.client, method)(f"/api/projects/{self.p['id']}{endpoint}", json={"rev": self.p["rev"], **(data or {})}, headers=self.headers)
        self.assertEqual(response.status_code, code, response.text)
        result = response.json()
        if code == 200 and "document" in result:
            self.p = result
        return result

    def request(self, **extra):
        return {"mode": self.p["mode"], "prompt": "Remove Rose from this scene", "engine": "demo", "scopes": [{"level": "scene", "id": self.p["document"]["scenes"][0]["id"]}], **extra}

    def test_static_assets_and_health(self):
        for path in ["/", "/app.js", "/art.js", "/style.css", "/api/health"]:
            self.assertEqual(self.client.get(path).status_code, 200)
        self.assertFalse(self.client.get("/api/settings").json()["configured"])

    def test_check_in_never_changes_manuscript(self):
        self.send("", {"mode": "check"}, "patch")
        original = copy.deepcopy(self.p["document"])
        self.send("/execute", self.request())
        self.assertEqual(original, self.p["document"])
        self.assertIsNone(self.p["pending"])
        self.assertGreater(len(self.p["diagnostic"]["findings"]), 0)
        self.assertFalse(self.p["diagnostic"]["stale"])

    def test_empty_check_in_cannot_generate(self):
        self.p = self.client.post("/api/projects", json={"mode": "check"}, headers=self.headers).json()
        self.send("/execute", {"mode": "check", "prompt": "Write a story", "scopes": [{"level": "story", "id": "story"}]}, code=422)
        self.send("/outline", {"prompt": "A forest"}, code=422)

    def test_edit_is_scoped_and_reject_restores_all_state(self):
        original = copy.deepcopy(self.p["document"])
        self.send("/execute", self.request())
        self.assertIsNotNone(self.p["pending"])
        self.assertNotEqual(original["blocks"][0], self.p["document"]["blocks"][0])
        self.assertEqual(original["blocks"][1:], self.p["document"]["blocks"][1:])
        self.assertEqual([c["name"] for c in self.p["document"]["scenes"][0]["characters"]], ["Lea"])
        self.send("", {"mode": "check"}, "patch", code=422)
        self.send("/review", {"decision": "reject"})
        self.assertEqual(original, self.p["document"])
        self.assertIsNone(self.p["pending"])
        self.assertIn("rejected-draft", [v["kind"] for v in main.store.versions(self.p["id"])])

    def test_reject_preserves_manual_edits_to_provisional_draft(self):
        original = copy.deepcopy(self.p["document"])
        self.send("/execute", self.request())
        doc = copy.deepcopy(self.p["document"])
        doc["blocks"][0]["html"] = "A manually revised provisional passage."
        self.send("", {"document": doc}, "patch")
        self.send("/review", {"decision": "reject"})
        self.assertEqual(original, self.p["document"])
        rejected = next(v for v in main.store.versions(self.p["id"]) if v["kind"] == "rejected-draft")
        recovered = main.store.version(self.p["id"], rejected["id"])
        self.assertEqual(recovered["snapshot"]["document"]["blocks"][0]["text"], "A manually revised provisional passage.")

    def test_accept_branch_restore_keep_all_versions(self):
        first = self.p["head"]
        original = copy.deepcopy(self.p["document"])
        self.send("/execute", self.request())
        self.send("/review", {"decision": "accept"})
        accepted = self.p["head"]
        self.send(f"/versions/{first}", {"action": "branch", "name": "Original route"})
        branch = self.p["head"]
        self.assertEqual(original, self.p["document"])
        self.send(f"/versions/{accepted}", {"action": "restore"})
        versions = main.store.versions(self.p["id"])
        self.assertEqual(len(versions), 4)
        self.assertTrue({first, accepted, branch, self.p["head"]} <= {v["id"] for v in versions})
        self.assertEqual(main.store.version(self.p["id"], branch)["parent"], first)

    def test_same_character_different_scopes_and_branch_preserves_refs(self):
        sc = self.p["document"]["scenes"][0]
        for level, ident in [("scene", sc["id"]), ("chapter", sc["chapterId"])]:
            self.send("/references", {"reference": {"label": "Rose", "kind": "character", "entityId": "rose", "scope": {"level": level, "id": ident}}})
        self.assertEqual(len(self.p["refs"]), 2)
        self.send(f"/versions/{self.p['head']}", {"action": "branch", "name": "With references"})
        self.assertEqual(len(self.p["refs"]), 2)

    def test_bad_scope_model_output_rejected_atomically(self):
        original = copy.deepcopy(self.p)
        bad = {"changes": [{"blockId": self.p["document"]["blocks"][-1]["id"], "text": "Unexpected rewrite"}]}
        with patch.object(main.provider, "call", new=AsyncMock(return_value=bad)):
            self.send("/execute", self.request(engine="hf"), code=422)
        current = main.store.get(self.p["id"])
        self.assertEqual(original["rev"], current["rev"])
        self.assertEqual(original["document"], current["document"])

    def test_response_on_stale_revision_rejected(self):
        p = copy.deepcopy(self.p)
        async def model_response(*args):
            doc = copy.deepcopy(p["document"])
            doc["blocks"][0]["html"] = "Author changed the story during inference."
            main.store.mutate(p["id"], p["rev"], lambda x: x.update(document=main.validate_document(doc)))
            return {"changes": [{"blockId": p["document"]["blocks"][0]["id"], "text": "Old model result"}]}
        with patch.object(main.provider, "call", side_effect=model_response):
            self.send("/execute", self.request(engine="hf"), code=409)
        current = main.store.get(self.p["id"])
        self.assertEqual(current["document"]["blocks"][0]["text"], "Author changed the story during inference.")
        self.assertIsNone(current["pending"])

    def test_model_ambiguity_does_not_apply_edits(self):
        original = copy.deepcopy(self.p["document"])
        with patch.object(main.provider, "call", new=AsyncMock(return_value={"questions": ["Is Rose absent or dead?"]})):
            self.send("/execute", self.request(engine="hf"))
        self.assertEqual(original, self.p["document"])
        self.assertEqual(self.p["clarification"], ["Is Rose absent or dead?"])

    def test_provider_failure_preserves_document(self):
        original = copy.deepcopy(self.p["document"])
        with patch.object(main.provider, "call", new=AsyncMock(side_effect=DomainError("Provider timed out"))):
            self.send("/execute", self.request(engine="hf"), code=422)
        self.assertEqual(original, main.store.get(self.p["id"])["document"])

    def test_diagnostic_stales_after_manual_edit(self):
        self.send("", {"mode": "check"}, "patch")
        self.send("/execute", self.request())
        doc = copy.deepcopy(self.p["document"])
        doc["blocks"][0]["html"] = "Rose has left."
        self.send("", {"document": doc}, "patch")
        self.assertTrue(self.p["diagnostic"]["stale"])
        self.send("/deletion-preview", {"ids": [self.p["diagnostic"]["findings"][0]["id"]]}, code=422)

    def test_exact_deletion_requires_current_real_recheck(self):
        self.send("", {"mode": "check"}, "patch")
        b = self.p["document"]["blocks"][0]
        result = {"findings": [{"blockId": b["id"], "quote": "Rose waited", "category": "remove", "severity": "low", "note": "Exact requested excerpt."}], "coverage": "All submitted text."}
        with patch.object(main.provider, "call", new=AsyncMock(return_value=result)):
            self.send("/execute", self.request(engine="hf"))
            fid = self.p["diagnostic"]["findings"][0]["id"]
            self.send("/deletion-preview", {"ids": [fid]}, code=422)
            self.send("/execute", self.request(engine="hf", recheck=True))
        fid = self.p["diagnostic"]["findings"][0]["id"]
        old = copy.deepcopy(self.p["document"])
        self.send("/deletion-preview", {"ids": [fid]})
        self.assertEqual(self.p["document"]["blocks"][0]["text"], old["blocks"][0]["text"].replace("Rose waited", "", 1))
        self.assertEqual(self.p["document"]["blocks"][1:], old["blocks"][1:])
        self.assertEqual(self.p["pending"]["kind"], "deletion")

    def test_unanchored_diagnostic_is_rejected(self):
        self.send("", {"mode": "check"}, "patch")
        result = {"findings": [{"blockId": self.p["document"]["blocks"][0]["id"], "quote": "A made-up quote", "category": "change", "severity": "high", "note": "Not in the story"}]}
        with patch.object(main.provider, "call", new=AsyncMock(return_value=result)):
            self.send("/execute", self.request(engine="hf"), code=422)

    def test_structure_counts_preserve_text(self):
        original = copy.deepcopy(self.p["document"]["blocks"])
        self.send("/structure", {"engine": "local", "custom": {"chapters": 2, "sections": 1, "scenes": 6}})
        self.assertEqual(self.p["document"]["blocks"], original)
        self.send("/structure", {"engine": "local", "custom": {"chapters": 3, "sections": 2, "scenes": 4}}, code=422)

    def test_import_txt_docx_and_text_pdf(self):
        txt = self.client.post("/api/extract", headers=self.headers, files={"file": ("story.txt", b"Rose arrives.\n\nLea waits.", "text/plain")})
        self.assertEqual(txt.status_code, 200, txt.text)
        self.assertIn("Rose arrives.", txt.json()["text"])
        doc = Document();doc.add_paragraph("A Word story with Rose.")
        raw = io.BytesIO();doc.save(raw)
        word = self.client.post("/api/extract", headers=self.headers, files={"file": ("story.docx", raw.getvalue(), "application/vnd.openxmlformats-officedocument.wordprocessingml.document")})
        self.assertEqual(word.status_code, 200, word.text)
        self.assertIn("A Word story", word.json()["text"])
        writer = PdfWriter();page = writer.add_blank_page(width=612, height=792)
        font = DictionaryObject({NameObject("/Type"): NameObject("/Font"), NameObject("/Subtype"): NameObject("/Type1"), NameObject("/BaseFont"): NameObject("/Helvetica")})
        page[NameObject("/Resources")] = DictionaryObject({NameObject("/Font"): DictionaryObject({NameObject("/F1"): writer._add_object(font)})})
        stream = DecodedStreamObject();stream.set_data(b"BT /F1 12 Tf 50 700 Td (Rose in a PDF story.) Tj ET")
        page[NameObject("/Contents")] = writer._add_object(stream)
        raw = io.BytesIO();writer.write(raw)
        pdf = self.client.post("/api/extract", headers=self.headers, files={"file": ("story.pdf", raw.getvalue(), "application/pdf")})
        self.assertEqual(pdf.status_code, 200, pdf.text)
        self.assertIn("Rose in a PDF", pdf.json()["text"])

    def test_blank_pdf_and_invalid_file_rejected(self):
        writer = PdfWriter();writer.add_blank_page(100, 100);raw = io.BytesIO();writer.write(raw)
        response = self.client.post("/api/extract", headers=self.headers, files={"file": ("scan.pdf", raw.getvalue(), "application/pdf")})
        self.assertEqual(response.status_code, 422)
        self.assertIn("OCR", response.json()["detail"])
        response = self.client.post("/api/extract", headers=self.headers, files={"file": ("bad.exe", b"no", "application/octet-stream")})
        self.assertEqual(response.status_code, 422)

    def test_rich_text_is_sanitized_without_destroying_styles(self):
        doc = copy.deepcopy(self.p["document"])
        doc["blocks"][0]["html"] = '<b>Rose</b> <i>waits</i> <u>here</u><script>alert(1)</script><img src=x onerror=alert(1)>'
        self.send("", {"document": doc}, "patch")
        b = self.p["document"]["blocks"][0]
        self.assertEqual(b["text"], "Rose waits here")
        self.assertIn("<b>Rose</b>", b["html"])
        self.assertNotIn("script", b["html"])
        self.assertNotIn("img", b["html"])

    def test_backup_round_trip_preserves_versions_and_excludes_token(self):
        main.provider.token = "hf_TEST_SECRET_DO_NOT_EXPORT"
        self.send("/execute", self.request())
        self.send("/review", {"decision": "accept"})
        response = self.client.get(f"/api/projects/{self.p['id']}/export?format=json")
        self.assertNotIn(main.provider.token, response.text)
        original = response.json()
        response = self.client.post("/api/restore-backup", json=original, headers=self.headers)
        self.assertEqual(response.status_code, 200, response.text)
        restored = response.json()
        self.assertNotEqual(restored["id"], self.p["id"])
        self.assertEqual(restored["document"], self.p["document"])
        self.assertEqual(len(main.store.versions(restored["id"])), len(original["versions"]))

    def test_scene_move_add_delete_are_provisional(self):
        doc = copy.deepcopy(self.p["document"])
        scene, target = doc["scenes"][0], doc["scenes"][2]
        self.send("/scene-operation", {"action": "move", "sceneId": scene["id"], "targetId": target["id"], "position": "after"})
        self.assertEqual(self.p["document"]["scenes"][2]["id"], scene["id"])
        self.assertEqual(self.p["document"]["blocks"][2]["id"], doc["blocks"][0]["id"])
        self.send("/review", {"decision": "reject"})
        self.assertEqual(self.p["document"], doc)
        self.send("/scene-operation", {"action": "add", "sceneId": scene["id"], "title": "Another door", "text": "Lea opened another door."})
        self.assertEqual(len(self.p["document"]["scenes"]), 7)
        self.send("/review", {"decision": "accept"})
        added = self.p["document"]["scenes"][1]
        self.send("/scene-operation", {"action": "delete", "sceneId": added["id"]})
        self.assertEqual(len(self.p["document"]["scenes"]), 6)
        self.assertEqual(len(self.p["document"]["blocks"]), 6)

    def test_outline_approval_required_before_draft(self):
        self.p = self.client.post("/api/projects", json={"mode": "edit"}, headers=self.headers).json()
        outline = {"title": "A plan", "characters": [{"name": "Rose", "role": "Traveller"}], "chapters": [{"title": "Start", "summary": "Rose arrives", "scenes": [{"title": "Arrival", "summary": "The start"}]}]}
        self.send("/draft", {}, code=422)
        with patch.object(main.provider, "call", new=AsyncMock(return_value=outline)):
            self.send("/outline", {"prompt": "A travel story"})
        self.assertEqual(self.p["document"]["blocks"], [])
        self.send("/draft", {}, code=422)
        self.send("/approve-outline", {"outline": outline})
        self.assertEqual(self.p["document"]["blocks"], [])
        draft = demo_document()
        outline["chapters"] = [{"title": c["title"], "summary": "Approved", "scenes": [{"title": s["title"], "summary": "Approved"} for s in draft["scenes"] if s["chapterId"] == c["id"]]} for c in draft["chapters"]]
        self.send("/approve-outline", {"outline": outline})
        with patch.object(main.provider, "call", new=AsyncMock(return_value=draft)):
            self.send("/draft")
        self.assertIsNotNone(self.p["pending"])

    def test_api_writes_require_local_app_header(self):
        response = self.client.post("/api/projects", json={})
        self.assertEqual(response.status_code, 403)

    def test_exact_deletion_preserves_surrounding_formatting(self):
        b = {"id": "a", "html": "<b>Rose</b> waited. <i>Lea stayed.</i>", "text": "Rose waited. Lea stayed."}
        output = delete_exact_ranges(b, [(0, 5)])
        self.assertEqual(output["text"], "waited. Lea stayed.")
        self.assertIn("<i>Lea stayed.</i>", output["html"])

    def test_new_chapter_inserted_at_chapter_boundary(self):
        doc = copy.deepcopy(self.p["document"])
        self.send("/scene-operation", {"action": "add", "sceneId": doc["scenes"][0]["id"], "title": "Interlude", "text": "Lea waits.", "newChapter": "The pause"})
        self.assertEqual(self.p["document"]["chapters"][1]["title"], "The pause")
        self.assertEqual(self.p["document"]["scenes"][3]["title"], "Interlude")
        self.assertEqual(self.p["document"]["blocks"][3]["text"], "Lea waits.")

    def test_structure_rejects_omitted_passages(self):
        doc = copy.deepcopy(self.p["document"])
        result = {k: doc[k] for k in ["scenes", "chapters", "characters"]}
        result["scenes"] = result["scenes"][:-1]
        with patch.object(main.provider, "call", new=AsyncMock(return_value=result)):
            self.send("/structure", {"engine": "hf"}, code=422)
        self.assertEqual(self.p["document"], doc)

    def test_invalid_model_metadata_cannot_change_other_scenes(self):
        doc = copy.deepcopy(self.p["document"])
        result = {"changes": [{"blockId": doc["blocks"][0]["id"], "text": "Allowed text"}], "sceneUpdates": [{"id": doc["scenes"][-1]["id"], "title": "Out of scope"}]}
        with patch.object(main.provider, "call", new=AsyncMock(return_value=result)):
            self.send("/execute", self.request(engine="hf"), code=422)
        self.assertEqual(self.p["document"], doc)
        response = self.client.post("/api/projects", json={}, headers={**self.headers, "Origin": "https://other.example"})
        self.assertEqual(response.status_code, 403)

    def test_sample_never_silently_rewrites_custom_story(self):
        doc = copy.deepcopy(self.p["document"])
        doc["blocks"][0]["html"] = "A completely different scene with Rose."
        self.send("", {"document": doc}, "patch")
        self.send("/execute", self.request(), code=422)


if __name__ == "__main__":
    unittest.main()
