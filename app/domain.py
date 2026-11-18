"""Pure document rules. AI output never bypasses scope or revision checks."""
import copy
import hashlib
import html
import json
import re
import uuid
from html.parser import HTMLParser


def uid(prefix="item"):
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


class DomainError(ValueError):
    pass


class CleanHTML(HTMLParser):
    allowed = {"b", "strong", "i", "em", "u", "mark", "br", "p", "div", "h2", "h3", "blockquote"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []
        self.text = []
        self.hidden = 0

    def handle_starttag(self, tag, attrs):
        if tag in {"script", "style"}:
            self.hidden += 1
        if not self.hidden and tag in self.allowed:
            self.parts.append(f"<{tag}>")
            if tag == "br":
                self.text.append("\n")

    def handle_endtag(self, tag):
        if tag in {"script", "style"}:
            self.hidden = max(0, self.hidden - 1)
            return
        if not self.hidden and tag in self.allowed and tag != "br":
            self.parts.append(f"</{tag}>")
            if tag in {"p", "div", "h2", "h3", "blockquote"}:
                self.text.append("\n")

    def handle_data(self, data):
        if not self.hidden:
            self.parts.append(html.escape(data))
            self.text.append(data)


def clean_html(value):
    parser = CleanHTML()
    parser.feed(str(value))
    return "".join(parser.parts), "".join(parser.text)


def delete_exact_ranges(b, intervals):
    """Delete only text in the approved ranges; retain surrounding rich-text tags."""
    class Deleter(HTMLParser):
        def __init__(self):
            super().__init__(convert_charrefs=True)
            self.text_position = 0
            self.parts = []

        def covered(self, at):
            return any(start <= at < end for start, end in intervals)

        def handle_starttag(self, tag, attrs):
            if tag == "br":
                if not self.covered(self.text_position):
                    self.parts.append("<br>")
                self.text_position += 1
            elif tag in CleanHTML.allowed:
                self.parts.append(f"<{tag}>")

        def handle_endtag(self, tag):
            if tag in CleanHTML.allowed and tag != "br":
                self.parts.append(f"</{tag}>")
                if tag in {"p", "div", "h2", "h3", "blockquote"}:
                    self.text_position += 1

        def handle_data(self, value):
            kept = "".join(c for i, c in enumerate(value) if not self.covered(self.text_position + i))
            self.parts.append(html.escape(kept))
            self.text_position += len(value)
    parser = Deleter()
    parser.feed(b["html"])
    markup, actual = clean_html("".join(parser.parts))
    expected = b["text"]
    for start, end in reversed(intervals):
        expected = expected[:start] + expected[end:]
    if actual != expected:
        raise DomainError("This excerpt crosses a rich-text paragraph boundary. Remove it manually, then recheck; no automatic deletion was applied.")
    return {"id": b["id"], "html": markup, "text": actual}


def block(text, ident=None):
    return {"id": ident or uid("b"), "text": text, "html": html.escape(text).replace("\n", "<br>")}


def empty_document(title="Untitled story"):
    return {"title": title, "blocks": [], "chapters": [], "scenes": [], "characters": []}


def validate_document(document):
    doc = copy.deepcopy(document)
    if not isinstance(doc, dict) or not isinstance(doc.get("blocks"), list):
        raise DomainError("Invalid story document.")
    doc["title"] = str(doc.get("title", "Untitled story"))[:180]
    if len(doc["blocks"]) > 4000:
        raise DomainError("This prototype supports up to 4,000 text passages.")
    seen = set()
    for b in doc["blocks"]:
        if not isinstance(b, dict) or not b.get("id") or b["id"] in seen:
            raise DomainError("Every passage must have a unique ID.")
        seen.add(b["id"])
        b["html"], b["text"] = clean_html(b.get("html", html.escape(str(b.get("text", "")))))
    if sum(len(b["text"]) for b in doc["blocks"]) > 250000:
        raise DomainError("The first version supports up to 250,000 characters per project.")
    for field in ["characters", "chapters", "scenes"]:
        doc.setdefault(field, [])
        if not isinstance(doc[field], list):
            raise DomainError(f"Invalid {field} list.")
    character_ids = set()
    for c in doc["characters"]:
        if not isinstance(c, dict) or not isinstance(c.get("id"), str) or not isinstance(c.get("name"), str) or not c["name"].strip() or c["id"] in character_ids:
            raise DomainError("Every character needs a unique ID and a name.")
        character_ids.add(c["id"])
    chapter_ids, section_ids, scene_ids = set(), set(), set()
    for c in doc["chapters"]:
        if not isinstance(c, dict) or not isinstance(c.get("id"), str) or not isinstance(c.get("title"), str) or c["id"] in chapter_ids:
            raise DomainError("Duplicate chapter ID.")
        chapter_ids.add(c["id"])
        for s in c.get("sections", []):
            if not isinstance(s, dict) or not isinstance(s.get("id"), str) or not isinstance(s.get("title"), str) or s["id"] in section_ids:
                raise DomainError("Duplicate section ID.")
            section_ids.add(s["id"])
    for s in doc["scenes"]:
        if not isinstance(s, dict) or not isinstance(s.get("id"), str) or not isinstance(s.get("title"), str) or s["id"] in scene_ids or s.get("chapterId") not in chapter_ids:
            raise DomainError("Invalid scene hierarchy.")
        scene_ids.add(s["id"])
        parent = next(c for c in doc["chapters"] if c["id"] == s["chapterId"])
        if s.get("sectionId") not in {x["id"] for x in parent.get("sections", [])}:
            raise DomainError("A scene must belong to a section in its chapter.")
        for field in ["blockIds", "inheritedBlockIds", "impactBlockIds"]:
            if not isinstance(s.get(field, []), list) or not set(s.get(field, [])) <= seen:
                raise DomainError("A scene refers to a passage that does not exist.")
            s.setdefault(field, [])
        s.setdefault("characters", [])
        if not isinstance(s["characters"], list) or any(not isinstance(c, dict) or c.get("id") not in character_ids or not isinstance(c.get("name"), str) for c in s["characters"]):
            raise DomainError("A scene character must match the story's cast.")
        s.setdefault("summary", "")
        s.setdefault("setting", "")
        s.setdefault("action", "")
        s.setdefault("art", "room")
    return doc


def document_hash(doc):
    return hashlib.sha256(json.dumps(doc, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def scope_blocks(doc, scope):
    level, target = scope.get("level"), scope.get("id")
    if level == "story":
        return {b["id"] for b in doc["blocks"]}
    if level == "passage":
        result = {b["id"] for b in doc["blocks"] if b["id"] == target}
    else:
        field = {"scene": "id", "section": "sectionId", "chapter": "chapterId"}.get(level)
        if not field:
            raise DomainError("Choose a scene, section, chapter, passage or story scope.")
        result = {bid for s in doc["scenes"] if s.get(field) == target for bid in s["blockIds"]}
    if not result:
        raise DomainError("This scope is missing or empty. Select it again.")
    return result


def apply_patch(doc, patch, allowed):
    """Validate the complete patch before changing any content."""
    changes, insertions, deletions = patch.get("changes", []), patch.get("insertions", []), patch.get("deletions", [])
    ids = {b["id"] for b in doc["blocks"]}
    changed_ids = [x.get("blockId") for x in changes]
    if len(changed_ids) != len(set(changed_ids)):
        raise DomainError("The model returned conflicting edits for a passage.")
    if not set(changed_ids + deletions) <= allowed or not set(changed_ids + deletions) <= ids:
        raise DomainError("The model attempted to change text outside the selected scope. Nothing was applied.")
    if set(changed_ids) & set(deletions):
        raise DomainError("A passage cannot be replaced and deleted in the same revision.")
    for item in insertions:
        if item.get("afterBlockId") not in allowed or item["afterBlockId"] in deletions:
            raise DomainError("An insertion is outside the permitted scope or follows a deleted passage.")
    if not changes and not insertions and not deletions:
        raise DomainError("No changes were returned. Clarify the instruction and try again.")
    output = copy.deepcopy(doc)
    replacements = {x["blockId"]: block(str(x["text"]), x["blockId"]) for x in changes}
    output["blocks"] = []
    inserted = {}
    for b in doc["blocks"]:
        if b["id"] not in deletions:
            output["blocks"].append(replacements.get(b["id"], b))
        for item in insertions:
            if item["afterBlockId"] == b["id"]:
                new = block(str(item["text"]))
                output["blocks"].append(new)
                inserted.setdefault(b["id"], []).append(new["id"])
    for scene in output["scenes"]:
        for field in ["blockIds", "inheritedBlockIds", "impactBlockIds"]:
            scene[field] = [i for i in scene[field] if i not in deletions]
        for parent, new_ids in inserted.items():
            if parent in scene["blockIds"]:
                scene["blockIds"].extend(new_ids)
    for update in patch.get("sceneUpdates", []):
        prior = next((s for s in doc["scenes"] if s["id"] == update.get("id")), None)
        if not prior or not set(prior["blockIds"]) <= allowed:
            raise DomainError("The model attempted to update a scene outside the selected scope.")
        scene = next(s for s in output["scenes"] if s["id"] == update["id"])
        for key in ["title", "characters", "summary", "action", "setting", "art"]:
            if key in update:
                scene[key] = update[key]
    return validate_document(output)


def import_text(text, title):
    text = text.replace("\r\n", "\n").strip()
    if not text:
        raise DomainError("No readable text was found. Scanned PDFs need OCR before import.")
    doc = empty_document(title)
    paragraphs = re.split(r"\n\s*\n", text)
    doc["blocks"] = [block(p.strip()) for p in paragraphs if p.strip()]
    return validate_document(doc)


def local_structure(doc, chapters=1, sections=1, scenes=None):
    """Explicitly mechanical grouping, never presented as semantic AI analysis."""
    out = copy.deepcopy(doc)
    count = len(out["blocks"])
    scenes = scenes or min(12, count)
    if chapters < 1 or sections < 1 or scenes < chapters * sections or scenes > count:
        raise DomainError("Use at least one scene per section and no more scenes than text passages.")
    previous = {tuple(s["blockIds"]): s for s in out["scenes"]}
    old_chapters = out["chapters"]
    out["chapters"], out["scenes"] = [], []
    for ci in range(chapters):
        old = old_chapters[ci] if ci < len(old_chapters) else {}
        c = {"id": old.get("id", uid("c")), "title": old.get("title", f"Chapter {ci + 1}"), "sections": []}
        for si in range(sections):
            prior = old.get("sections", [])[si] if si < len(old.get("sections", [])) else {}
            c["sections"].append({"id": prior.get("id", uid("sec")), "title": prior.get("title", f"Section {si + 1}")})
        out["chapters"].append(c)
    for index in range(scenes):
        start, stop = index * count // scenes, (index + 1) * count // scenes
        group = out["blocks"][start:stop]
        key = tuple(b["id"] for b in group)
        old = previous.get(key, {})
        position = index * chapters * sections // scenes
        chapter = out["chapters"][position // sections]
        characters = [c for c in out["characters"] if any(re.search(r"\b" + re.escape(c["name"]) + r"\b", b["text"], re.I) for b in group)]
        out["scenes"].append({"id": old.get("id", uid("s")), "title": old.get("title", f"Scene {index+1}"),
            "chapterId": chapter["id"], "sectionId": chapter["sections"][position % sections]["id"],
            "blockIds": list(key), "characters": characters, "summary": group[0]["text"][:240],
            "action": old.get("action", ""), "setting": old.get("setting", ""), "art": old.get("art", "room"),
            "inheritedBlockIds": [], "impactBlockIds": []})
    return validate_document(out)


def demo_document():
    texts = [
        "Rose waited beneath the ivy-covered arch, a brass key hidden in her palm. When Lea arrived, Rose pressed it into her hand. ‘The archive opens only after midnight,’ she whispered.",
        "Lea took the forest path toward the city. She promised Rose that she would return before dawn. In her pocket, the brass key felt heavier with every step.",
        "At the city gate, a watchman asked Lea why she was travelling alone. She showed him the sealed letter Rose had given her, and he stepped aside.",
        "At midnight, Lea reached the archive. She turned the brass key in the old lock. Inside, a single lamp illuminated a desk covered with forgotten letters.",
        "The letter on the desk bore her mother's handwriting. It revealed that Rose had guarded the archive for years, keeping its stories safe until Lea was ready to read them.",
        "As dawn broke, Lea returned to the arch. Rose was still waiting. Lea placed the key between them and said, ‘This time, we will tell the story together.’",
    ]
    doc = import_text("\n\n".join(texts), "The Midnight Archive")
    doc["characters"] = [{"id": "rose", "name": "Rose", "role": "Keeper of the archive", "color": "rose"}, {"id": "lea", "name": "Lea", "role": "A curious traveller", "color": "teal"}]
    doc = local_structure(doc, 2, 1, 6)
    doc["chapters"][0]["title"] = "A borrowed key"
    doc["chapters"][1]["title"] = "What the archive kept"
    titles = ["The key", "The journey", "The gate", "The archive", "The letter", "The return"]
    arts = ["arch", "forest", "gate", "archive", "letter", "return"]
    for i, scene in enumerate(doc["scenes"]):
        scene["title"], scene["art"] = titles[i], arts[i]
        scene["setting"] = ["Ivy arch", "Forest path", "City gate", "Archive", "Reading room", "Ivy arch"][i]
        scene["characters"] = doc["characters"] if i in {0, 5} else [doc["characters"][1]]
        scene["action"] = ["Rose gives Lea the key", "Lea walks toward the city", "Lea shows the letter", "Lea unlocks the archive", "Lea discovers Rose's past", "Rose and Lea reunite"][i]
        scene["inheritedBlockIds"] = [] if i == 0 else [doc["blocks"][0]["id"]]
        scene["impactBlockIds"] = [doc["blocks"][j]["id"] for j in ({0: [3, 4, 5], 1: [5], 2: [3], 3: [4]}.get(i, []))]
    return doc
