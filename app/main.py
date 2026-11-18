import copy
import io
import json
import re
import zipfile
from pathlib import Path
from urllib.parse import urlparse

from fastapi import FastAPI, Request, UploadFile, File
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pypdf import PdfReader
from docx import Document

from .domain import (DomainError, apply_patch, block, delete_exact_ranges, demo_document, document_hash, empty_document,
                     import_text, local_structure, scope_blocks, uid, validate_document)
from .providers import HuggingFaceProvider, fixture_check, fixture_edit
from .store import Conflict, Store, now

app = FastAPI(title="Storyscene", docs_url=None, redoc_url=None)
store = Store()
provider = HuggingFaceProvider()


@app.exception_handler(DomainError)
async def domain_error(_, exc):
    return JSONResponse({"detail": str(exc)}, status_code=409 if isinstance(exc, Conflict) else 422)


@app.exception_handler(KeyError)
async def missing(_, exc):
    return JSONResponse({"detail": "The requested item is missing or invalid. Reload and select it again."}, status_code=404)


@app.middleware("http")
async def local_request_guard(request: Request, call_next):
    if request.url.path.startswith("/api/") and request.method not in {"GET", "HEAD"}:
        if request.headers.get("x-storyscene") != "local-app":
            return JSONResponse({"detail": "Use the Storyscene application to make changes."}, status_code=403)
        origin = request.headers.get("origin")
        if origin and urlparse(origin).netloc != request.headers.get("host"):
            return JSONResponse({"detail": "Cross-origin writes are not allowed."}, status_code=403)
        if int(request.headers.get("content-length", "0")) > 12 * 1024 * 1024:
            return JSONResponse({"detail": "Maximum upload size: 12 MB."}, status_code=413)
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "no-referrer"
    if request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
    return response


def ready(p):
    if p["pending"]:
        raise DomainError("Accept or reject the current provisional revision first.")


def has_story(p):
    if not any(b["text"].strip() for b in p["document"]["blocks"]):
        raise DomainError("Import or write a story first. Check-in never creates story text.")


def snapshot(p):
    return copy.deepcopy({k: p[k] for k in ["document", "refs", "annotations", "structureDirty", "diagnostic"]})


def provisional(p, document, name, summary, kind="edit", impacts=None):
    ready(p)
    before = snapshot(p)
    p["document"] = document
    p["pending"] = {"id": uid("change"), "name": name[:160], "summary": summary, "before": before, "kind": kind, "impacts": impacts or [], "created": now()}
    p["structureDirty"] = kind not in {"draft", "scene"}
    p["diagnostic"] = None
    p["clarification"] = None


def valid_findings(result, doc, allowed):
    blocks = {b["id"]: b["text"] for b in doc["blocks"]}
    findings = result.get("findings")
    if not isinstance(findings, list):
        raise DomainError("The diagnostic response has no valid findings list. Nothing was changed.")
    output = []
    for f in findings:
        quote, bid = f.get("quote"), f.get("blockId")
        if bid not in blocks or not quote or blocks[bid].count(quote) != 1:
            raise DomainError("A diagnostic could not be anchored to an exact, unique passage. Nothing was changed.")
        if f.get("category") not in {"change", "remove", "continuity"} or f.get("severity") not in {"high", "medium", "low"}:
            raise DomainError("The model returned an unknown diagnostic category.")
        if f["category"] == "remove" and bid not in allowed:
            raise DomainError("A deletion target was outside your scope. The response was not used.")
        if not isinstance(f.get("note"), str) or not f["note"].strip():
            raise DomainError("A diagnostic explanation is missing.")
        output.append({**f, "id": uid("finding"), "dismissed": False})
    return output


@app.get("/api/health")
def health():
    return {"ok": True, "version": "1.0.0", "storage": "local SQLite", "ai": provider.status()}


@app.get("/api/projects")
def projects():
    return store.listing()


@app.post("/api/projects")
def create(data: dict):
    mode = data.get("mode", "edit")
    if mode not in {"edit", "check"}:
        raise DomainError("Unknown mode.")
    doc = demo_document() if data.get("demo") else empty_document(data.get("title", "Untitled story"))
    refs = []
    if data.get("demo"):
        sc = doc["scenes"][0]
        for level, ident in [("scene", sc["id"]), ("chapter", sc["chapterId"])]:
            refs.append({"id": uid("ref"), "label": "Rose", "kind": "character", "entityId": "rose", "scope": {"level": level, "id": ident},
                "sceneId": sc["id"], "confirmed": True, "created": now(), "sample": True})
    return store.create(doc, mode, refs)


@app.post("/api/restore-backup")
def restore_backup(data: dict):
    try:
        return store.restore_backup(data)
    except (TypeError, ValueError, KeyError) as exc:
        raise DomainError(str(exc) if isinstance(exc, DomainError) else "This project backup is incomplete or invalid.")


@app.get("/api/projects/{pid}")
def project(pid: str):
    return store.get(pid)


@app.patch("/api/projects/{pid}")
def update(pid: str, data: dict):
    content_changed = "document" in data
    def op(p):
        if "mode" in data:
            ready(p)
            if data["mode"] not in {"check", "edit"}:
                raise DomainError("Unknown mode.")
            p["mode"], p["clarification"] = data["mode"], None
        if "document" in data:
            doc = validate_document(data["document"])
            if doc != p["document"]:
                p["document"] = doc
                p["structureDirty"] = bool(doc["scenes"])
                p["clarification"] = None
        if "annotations" in data:
            if len(json.dumps(data["annotations"])) > 500000:
                raise DomainError("Too many ink annotations; clear some strokes.")
            p["annotations"] = data["annotations"]
    return store.mutate(pid, data["rev"], op, "Author's manuscript edits" if content_changed else None)


@app.post("/api/extract")
async def extract(file: UploadFile = File(...)):
    raw = await file.read(12 * 1024 * 1024 + 1)
    if len(raw) > 12 * 1024 * 1024:
        raise DomainError("Maximum upload size: 12 MB.")
    ext = Path(file.filename or "").suffix.lower()
    try:
        if ext == ".txt":
            text = raw.decode("utf-8-sig")
        elif ext == ".pdf":
            pdf = PdfReader(io.BytesIO(raw))
            if pdf.is_encrypted:
                raise DomainError("Unlock this PDF before importing it.")
            if len(pdf.pages) > 200:
                raise DomainError("This prototype accepts PDFs up to 200 pages.")
            text = "\n\n".join(p.extract_text() or "" for p in pdf.pages)
        elif ext == ".docx":
            with zipfile.ZipFile(io.BytesIO(raw)) as archive:
                if sum(i.file_size for i in archive.infolist()) > 40 * 1024 * 1024:
                    raise DomainError("The expanded Word document is too large.")
            doc = Document(io.BytesIO(raw))
            text = "\n\n".join(p.text for p in doc.paragraphs if p.text.strip())
            tables = [" | ".join(c.text for c in row.cells) for table in doc.tables for row in table.rows]
            if tables:
                text += "\n\n" + "\n\n".join(tables)
        else:
            raise DomainError("Choose a text PDF, DOCX or UTF-8 TXT file.")
    except DomainError:
        raise
    except Exception:
        raise DomainError("This document could not be read. Try an unlocked text PDF, a DOCX file or UTF-8 TXT.")
    validated = import_text(text, Path(file.filename or "Imported story").stem)
    return {"text": "\n\n".join(b["text"] for b in validated["blocks"]), "title": validated["title"],
            "note": "Text extracted locally. Review paragraph order; original page layout, comments and rich formatting are not imported."}


@app.post("/api/projects/{pid}/import")
def import_story(pid: str, data: dict):
    doc = import_text(data.get("text", ""), data.get("title", "Imported story"))
    def op(p):
        ready(p)
        p.update(document=doc, refs=[], annotations=[], diagnostic=None, outline=None, clarification=None, structureDirty=False)
    return store.mutate(pid, data["rev"], op, "Imported manuscript", "import")


@app.get("/api/settings")
def settings():
    return provider.status()


@app.post("/api/settings")
def configure(data: dict):
    if "token" in data and data["token"]:
        token = str(data["token"]).strip()
        if not token.startswith("hf_") or len(token) < 10:
            raise DomainError("Enter a Hugging Face access token beginning with hf_.")
        provider.token = token
    if data.get("clearToken"):
        provider.token = ""
    provider.model = str(data.get("model", provider.model)).strip()
    return provider.status()


@app.post("/api/projects/{pid}/references")
def reference(pid: str, data: dict):
    def op(p):
        if data.get("remove"):
            p["refs"] = [r for r in p["refs"] if r["id"] != data["remove"]]
            return
        ref = copy.deepcopy(data["reference"])
        scope_blocks(p["document"], ref["scope"])
        if not str(ref.get("label", "")).strip():
            raise DomainError("Give the reference a label.")
        ref["label"] = str(ref["label"])[:140]
        ref["id"] = ref.get("id") or uid("ref")
        ref["created"] = now()
        ref["confirmed"] = True
        ref["originVersion"] = p["head"]
        p["refs"] = [r for r in p["refs"] if r["id"] != ref["id"]]
        if not any(r.get("entityId") == ref.get("entityId") and r["label"] == ref["label"] and r["scope"] == ref["scope"] for r in p["refs"]):
            p["refs"].append(ref)
    return store.mutate(pid, data["rev"], op)


@app.post("/api/projects/{pid}/structure")
async def structure(pid: str, data: dict):
    p = store.get(pid)
    ready(p)
    has_story(p)
    custom = data.get("custom")
    if data.get("engine") == "local":
        counts = custom or {"chapters": min(2, len(p["document"]["blocks"])), "sections": 1, "scenes": min(12, len(p["document"]["blocks"]))}
        doc = local_structure(p["document"], **counts)
    else:
        result = await provider.call("structure", {"document": p["document"], "custom": custom})
        if result.get("questions"):
            raise DomainError("Structure needs clarification: " + " ".join(result["questions"]))
        doc = validate_document({**p["document"], **{k: result[k] for k in ["chapters", "scenes", "characters"]}})
        if {b["id"] for b in doc["blocks"]} != {bid for s in doc["scenes"] for bid in s["blockIds"]}:
            raise DomainError("The proposed structure omitted some passages. It was not applied.")
        if custom and (len(doc["chapters"]) != custom["chapters"] or len(doc["scenes"]) != custom["scenes"] or any(len(c["sections"]) != custom["sections"] for c in doc["chapters"])):
            raise DomainError("The model did not meet your requested counts. Adjust the counts or retry.")
    def op(current):
        current.update(document=doc, structureDirty=False, clarification=None)
    return store.mutate(pid, data["rev"], op, "Story structure refreshed", "structure")


@app.post("/api/projects/{pid}/execute")
async def execute(pid: str, data: dict):
    p = store.get(pid)
    ready(p)
    has_story(p)
    prompt = str(data.get("prompt", "")).strip()
    if not prompt:
        raise DomainError("Describe your request before executing it.")
    if p["clarification"] and not str(data.get("answer", "")).strip():
        raise DomainError("Answer the open clarification question before executing again.")
    if data.get("mode") != p["mode"]:
        raise DomainError("The request mode changed. Review your request before executing it.")
    scopes = data.get("scopes", [])
    if not scopes:
        raise DomainError("Confirm a scope before executing.")
    allowed = set().union(*(scope_blocks(p["document"], s) for s in scopes))
    refs = data.get("references", [])
    for ref in refs:
        if not ref.get("confirmed"):
            raise DomainError("Resolve the reference scope first.")
        scope_blocks(p["document"], ref["scope"])
    engine = data.get("engine", "hf")
    operation = "check" if p["mode"] == "check" else "edit"
    if engine == "demo":
        result = (fixture_check if operation == "check" else fixture_edit)(p["document"], prompt, allowed)
    else:
        result = await provider.call(operation, {"document": p["document"], "request": prompt, "references": refs,
            "allowedBlockIds": sorted(allowed), "scopes": scopes, "recheck": bool(data.get("recheck")), "clarificationAnswer": data.get("answer", "")})
    if result.get("questions"):
        questions = [str(q)[:500] for q in result["questions"][:4]]
        return store.mutate(pid, data["rev"], lambda x: x.update(clarification=questions))
    if operation == "check":
        findings = valid_findings(result, p["document"], allowed)
        diagnostic = {"findings": findings, "hash": document_hash(p["document"]), "prompt": prompt, "scopes": scopes,
            "engine": engine, "recheck": bool(data.get("recheck")), "coverage": result.get("coverage", "All submitted passages; automated interpretation remains fallible."), "created": now()}
        return store.mutate(pid, data["rev"], lambda x: x.update(diagnostic=diagnostic, clarification=None))
    try:
        doc = apply_patch(p["document"], result, allowed)
    except (TypeError, ValueError, KeyError) as exc:
        raise DomainError(str(exc) if isinstance(exc, DomainError) else "Invalid edit response. Nothing was applied.")
    return store.mutate(pid, data["rev"], lambda x: provisional(x, doc, str(result.get("name", "Story revision")), str(result.get("summary", "Review the proposed changes.")), impacts=result.get("impacts", [])))


@app.post("/api/projects/{pid}/diagnostics")
def diagnostic_action(pid: str, data: dict):
    def op(p):
        if not p["diagnostic"]:
            raise DomainError("No diagnostic is available.")
        for f in p["diagnostic"]["findings"]:
            if f["id"] == data["id"]:
                f["dismissed"] = not f.get("dismissed", False)
    return store.mutate(pid, data["rev"], op)


@app.post("/api/projects/{pid}/deletion-preview")
def deletion_preview(pid: str, data: dict):
    def op(p):
        ready(p)
        d = p["diagnostic"]
        if p["mode"] != "check" or not d or not d["recheck"] or d["engine"] != "hf" or d["hash"] != document_hash(p["document"]):
            raise DomainError("A current Hugging Face recheck is required before exact deletion.")
        if any(f["category"] != "remove" for f in d["findings"]):
            raise DomainError("Resolve and recheck all remaining issues first. Dismissing a note does not authorize deletion.")
        selected = [f for f in d["findings"] if f["id"] in data.get("ids", [])]
        if not selected or any(f["category"] != "remove" for f in selected):
            raise DomainError("Select the exact excerpts to remove.")
        doc = copy.deepcopy(p["document"])
        for b in doc["blocks"]:
            excerpts = [f["quote"] for f in selected if f["blockId"] == b["id"]]
            intervals = sorted((b["text"].find(q), b["text"].find(q) + len(q)) for q in excerpts)
            if any(a < 0 or (i and a < intervals[i-1][1]) for i, (a, z) in enumerate(intervals)):
                raise DomainError("Deletion excerpts overlap or have changed; recheck the text.")
            if excerpts:
                b.update(delete_exact_ranges(b, intervals))
        provisional(p, validate_document(doc), "Confirmed excerpt removal", "Only the selected exact excerpts were removed. Accept to keep, reject to restore.", "deletion")
    return store.mutate(pid, data["rev"], op)


@app.post("/api/projects/{pid}/replace-scene")
def replace_scene(pid: str, data: dict):
    def op(p):
        ready(p)
        if p["mode"] != "edit":
            raise DomainError("Scene replacement is available in Edit. In Check-in, write directly in the manuscript.")
        scene = next(s for s in p["document"]["scenes"] if s["id"] == data["sceneId"])
        ids = scene["blockIds"]
        if not ids:
            raise DomainError("This scene has no source text.")
        patch = {"changes": [{"blockId": ids[0], "text": data["text"]}], "deletions": ids[1:]}
        doc = apply_patch(p["document"], patch, set(ids))
        provisional(p, doc, f"New text · {scene['title']}", "Exact author-provided replacement. Downstream coherence has not been checked.")
    return store.mutate(pid, data["rev"], op)


@app.post("/api/projects/{pid}/scene-operation")
def scene_operation(pid: str, data: dict):
    def op(p):
        ready(p)
        if p["mode"] != "edit":
            raise DomainError("In Check-in, prepare a hypothetical request instead of changing the scene structure.")
        doc = copy.deepcopy(p["document"])
        scene = next((s for s in doc["scenes"] if s["id"] == data.get("sceneId")), None)
        if not scene:
            raise DomainError("Select an existing scene first.")
        action = data.get("action")
        impacts = [{"blockId": bid, "note": "This passage depended on the scene being changed. Its continuity needs a new check."} for bid in scene["impactBlockIds"]]
        ids = set(scene["blockIds"])
        if action in {"move", "delete"} and any(ids & set(s["blockIds"]) for s in doc["scenes"] if s["id"] != scene["id"]):
            raise DomainError("This scene shares source passages with another scene. Edit the shared text explicitly before moving or deleting it.")
        if action == "delete":
            doc["scenes"] = [s for s in doc["scenes"] if s["id"] != scene["id"]]
            doc["blocks"] = [b for b in doc["blocks"] if b["id"] not in ids]
            for s in doc["scenes"]:
                for field in ["inheritedBlockIds", "impactBlockIds"]:
                    s[field] = [bid for bid in s[field] if bid not in ids]
            name = "Scene removed · " + scene["title"]
        elif action == "move":
            target = next((s for s in doc["scenes"] if s["id"] == data.get("targetId")), None)
            if not target or target["id"] == scene["id"] or not target["blockIds"]:
                raise DomainError("Choose a different scene as the destination.")
            if any(set(target["blockIds"]) & set(s["blockIds"]) for s in doc["scenes"] if s["id"] != target["id"]):
                raise DomainError("The destination shares source passages. Choose a scene with unshared text.")
            moving = [b for b in doc["blocks"] if b["id"] in ids]
            remaining = [b for b in doc["blocks"] if b["id"] not in ids]
            locations = [i for i, b in enumerate(remaining) if b["id"] in target["blockIds"]]
            before = data.get("position") == "before"
            at = min(locations) if before else max(locations) + 1
            doc["blocks"] = remaining[:at] + moving + remaining[at:]
            doc["scenes"].remove(scene)
            at_scene = doc["scenes"].index(target) + (0 if before else 1)
            scene.update(chapterId=target["chapterId"], sectionId=target["sectionId"])
            doc["scenes"].insert(at_scene, scene)
            name = "Moved · " + scene["title"]
        elif action == "add":
            text = str(data.get("text", "")).strip()
            title = str(data.get("title", "New scene")).strip()
            if not text or not title:
                raise DomainError("Give the new scene a title and text, or use an AI request to generate its content.")
            new_block = block(text)
            after_scene = scene
            if data.get("newChapter"):
                after_scene = [s for s in doc["scenes"] if s["chapterId"] == scene["chapterId"]][-1]
                insertion_ids = {bid for s in doc["scenes"] if s["chapterId"] == scene["chapterId"] for bid in s["blockIds"]}
            else:
                insertion_ids = ids
            locations = [i for i, b in enumerate(doc["blocks"]) if b["id"] in insertion_ids]
            at = max(locations) + 1 if locations else len(doc["blocks"])
            doc["blocks"].insert(at, new_block)
            chapter_id, section_id = scene["chapterId"], scene["sectionId"]
            if data.get("newChapter"):
                chapter_id, section_id = uid("c"), uid("sec")
                doc["chapters"].insert(next(i for i, c in enumerate(doc["chapters"]) if c["id"] == scene["chapterId"]) + 1,
                    {"id": chapter_id, "title": str(data["newChapter"])[:180], "sections": [{"id": section_id, "title": "Section 1"}]})
            new_scene = {"id": uid("s"), "title": title[:180], "chapterId": chapter_id, "sectionId": section_id,
                "blockIds": [new_block["id"]], "inheritedBlockIds": [], "impactBlockIds": [], "summary": text[:240], "action": "Author-created scene", "setting": "", "art": "room",
                "characters": [c for c in doc["characters"] if re.search(r"\b" + re.escape(c["name"]) + r"\b", text, re.I)]}
            doc["scenes"].insert(doc["scenes"].index(after_scene) + 1, new_scene)
            name = "New scene · " + title
        else:
            raise DomainError("Unknown scene action.")
        provisional(p, validate_document(doc), name, "Direct scene operation. Read the affected text before accepting; downstream coherence has not been checked.", "scene-operation", impacts)
    return store.mutate(pid, data["rev"], op)


@app.post("/api/projects/{pid}/review")
def review(pid: str, data: dict):
    p = store.get(pid)
    if not p["pending"]:
        raise DomainError("There is no provisional revision to review.")
    if data.get("decision") not in {"accept", "reject"}:
        raise DomainError("Choose accept or reject.")
    name = p["pending"]["name"] if data["decision"] == "accept" else "Returned to previous manuscript"
    def op(current):
        if data["decision"] == "reject":
            # Preserve even manually edited provisional content in a recoverable version.
            current.update(copy.deepcopy(current["pending"]["before"]))
        current["pending"] = None
    checkpoint = "Unaccepted draft · " + p["pending"]["name"] if data["decision"] == "reject" else None
    return store.mutate(pid, data["rev"], op, name, data["decision"], checkpoint_name=checkpoint)


@app.post("/api/projects/{pid}/outline")
async def outline(pid: str, data: dict):
    p = store.get(pid)
    ready(p)
    if p["mode"] != "edit" or p["document"]["blocks"]:
        raise DomainError("Outline-first creation starts in an empty Edit project.")
    result = await provider.call("outline", {"prompt": data.get("prompt", ""), "custom": data.get("custom")})
    if result.get("questions"):
        raise DomainError("Please clarify: " + " ".join(result["questions"]))
    if not result.get("chapters") or not result.get("characters"):
        raise DomainError("The model did not return a usable outline.")
    custom = data.get("custom")
    if custom and (len(result["chapters"]) != custom["chapters"] or sum(len(c.get("scenes", [])) for c in result["chapters"]) != custom["scenes"]):
        raise DomainError("The proposed outline did not meet the requested counts. Retry or adjust the counts.")
    return store.mutate(pid, data["rev"], lambda x: x.update(outline={"content": result, "approved": False}))


@app.post("/api/projects/{pid}/approve-outline")
def approve_outline(pid: str, data: dict):
    def op(p):
        ready(p)
        if p["mode"] != "edit" or p["document"]["blocks"] or not p["outline"]:
            raise DomainError("No outline is awaiting approval.")
        content = data["outline"]
        if not content.get("chapters") or not content.get("characters"):
            raise DomainError("Keep at least one character and chapter in the plan.")
        p["outline"] = {"content": content, "approved": True}
    return store.mutate(pid, data["rev"], op)


@app.post("/api/projects/{pid}/draft")
async def draft(pid: str, data: dict):
    p = store.get(pid)
    ready(p)
    if p["mode"] != "edit" or p["document"]["blocks"] or not p["outline"] or not p["outline"]["approved"]:
        raise DomainError("Approve the outline in an empty Edit project before drafting.")
    result = await provider.call("draft", {"approvedOutline": p["outline"]["content"]})
    if result.get("questions"):
        raise DomainError("Please clarify the outline: " + " ".join(result["questions"]))
    for b in result.get("blocks", []):
        b.update(block(b["text"], b["id"]))
    doc = validate_document(result)
    if not doc["blocks"] or {b["id"] for b in doc["blocks"]} != {bid for s in doc["scenes"] for bid in s["blockIds"]}:
        raise DomainError("The generated story has an incomplete structure. Nothing was applied.")
    plan = p["outline"]["content"]
    if [c["title"] for c in doc["chapters"]] != [c["title"] for c in plan["chapters"]] or [s["title"] for s in doc["scenes"]] != [s["title"] for c in plan["chapters"] for s in c.get("scenes", [])]:
        raise DomainError("The draft did not preserve the approved chapter and scene plan. Nothing was applied.")
    return store.mutate(pid, data["rev"], lambda x: provisional(x, doc, "First draft", "Story drafted from your approved outline.", "draft"))


@app.get("/api/projects/{pid}/versions")
def versions(pid: str):
    return store.versions(pid)


@app.get("/api/projects/{pid}/versions/{vid}")
def version(pid: str, vid: str):
    return store.version(pid, vid)


@app.post("/api/projects/{pid}/versions/{vid}")
def version_action(pid: str, vid: str, data: dict):
    source = store.version(pid, vid)
    if data.get("action") == "rename":
        store.rename(pid, vid, str(data.get("name", "Untitled variant")))
        return {"ok": True}
    if data.get("action") not in {"branch", "restore"}:
        raise DomainError("Unknown version action.")
    def op(p):
        ready(p)
        # References and ink can change without a new prose checkpoint.
        if not (data["action"] == "branch" and vid == p["head"]):
            p.update(copy.deepcopy(source["snapshot"]))
        if data.get("point") and data["point"].get("level") != "story":
            scope_blocks(p["document"], data["point"])
        p.update(diagnostic=None, clarification=None, outline=None)
    name = data.get("name") or ("Variant · " if data["action"] == "branch" else "Restored · ") + source["name"]
    return store.mutate(pid, data["rev"], op, name, data["action"], parent=vid, point=data.get("point"))


@app.get("/api/projects/{pid}/export")
def export(pid: str, format: str = "txt"):
    p = store.get(pid)
    if format == "json":
        data = {"format": "storyscene-1", "project": p, "versions": [store.version(pid, v["id"]) for v in store.versions(pid)]}
        return Response(json.dumps(data, ensure_ascii=False, indent=2), media_type="application/json", headers={"Content-Disposition": 'attachment; filename="Storyscene_project.json"'})
    return Response("\n\n".join(b["text"] for b in p["document"]["blocks"]), media_type="text/plain; charset=utf-8", headers={"Content-Disposition": 'attachment; filename="Storyscene_manuscript.txt"'})


app.mount("/", StaticFiles(directory=Path(__file__).resolve().parents[1] / "web", html=True), name="web")
