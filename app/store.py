import copy
import json
import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from .domain import DomainError, document_hash, empty_document, uid, validate_document


def now():
    return datetime.now(timezone.utc).isoformat()


class Conflict(DomainError):
    pass


class Store:
    def __init__(self, root=None):
        root = Path(root or os.environ.get("STORYSCENE_DATA_DIR", Path(__file__).resolve().parents[1] / "data"))
        root.mkdir(parents=True, exist_ok=True)
        self.path = root / "storyscene.sqlite3"
        with self.connect() as db:
            db.executescript("""
              CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
              CREATE TABLE IF NOT EXISTS versions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
                parent TEXT, name TEXT NOT NULL, kind TEXT NOT NULL, created TEXT NOT NULL,
                point TEXT, snapshot TEXT NOT NULL);
              CREATE INDEX IF NOT EXISTS version_project ON versions(project_id);
            """)

    def connect(self):
        db = sqlite3.connect(self.path, timeout=20)
        db.row_factory = sqlite3.Row
        return db

    def get(self, ident, db=None):
        if db is None:
            with self.connect() as conn:
                return self.get(ident, conn)
        row = db.execute("SELECT payload FROM projects WHERE id=?", (ident,)).fetchone()
        if row is None:
            raise KeyError("Project not found")
        p = json.loads(row[0])
        self._status(p)
        return p

    @staticmethod
    def _status(p):
        if p.get("diagnostic"):
            p["diagnostic"]["stale"] = p["diagnostic"]["hash"] != document_hash(p["document"])

    def listing(self):
        with self.connect() as db:
            projects = [json.loads(r[0]) for r in db.execute("SELECT payload FROM projects")]
        return [{"id": p["id"], "title": p["document"]["title"], "updated": p["updated"], "mode": p["mode"]} for p in sorted(projects, key=lambda p: p["updated"], reverse=True)]

    def create(self, document=None, mode="edit", refs=None):
        p = {"id": uid("project"), "rev": 0, "head": None, "mode": mode, "document": document or empty_document(),
             "refs": refs or [], "diagnostic": None, "outline": None, "pending": None, "structureDirty": False,
             "clarification": None, "annotations": [], "updated": now()}
        with self.connect() as db:
            self._version(db, p, "Original story", "initial")
            db.execute("INSERT INTO projects VALUES (?,?)", (p["id"], json.dumps(p)))
        return p

    def _version(self, db, project, name, kind, parent=None, point=None):
        ident = uid("v")
        snapshot = copy.deepcopy({k: project[k] for k in ["document", "refs", "mode", "structureDirty", "annotations"]})
        db.execute("INSERT INTO versions VALUES (?,?,?,?,?,?,?,?)", (ident, project["id"], parent or project["head"], name[:160], kind, now(), json.dumps(point), json.dumps(snapshot)))
        project["head"] = ident
        return ident

    def mutate(self, ident, expected_rev, operation, version_name=None, kind="manual", parent=None, point=None, checkpoint_name=None):
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            p = self.get(ident, db)
            if p["rev"] != expected_rev:
                raise Conflict("The story changed while this request was running. Reload the project before applying it.")
            if checkpoint_name:
                self._version(db, p, checkpoint_name, "rejected-draft")
            operation(p)
            if version_name:
                self._version(db, p, version_name, kind, parent, point)
            p["rev"] += 1
            p["updated"] = now()
            self._status(p)
            db.execute("UPDATE projects SET payload=? WHERE id=?", (json.dumps(p), ident))
        return p

    def versions(self, project_id):
        with self.connect() as db:
            rows = db.execute("SELECT id,parent,name,kind,created,point FROM versions WHERE project_id=? ORDER BY created", (project_id,)).fetchall()
        return [{**dict(r), "point": json.loads(r["point"])} for r in rows]

    def version(self, project_id, ident):
        with self.connect() as db:
            row = db.execute("SELECT * FROM versions WHERE project_id=? AND id=?", (project_id, ident)).fetchone()
        if row is None:
            raise KeyError("Version not found")
        return {**dict(row), "snapshot": json.loads(row["snapshot"]), "point": json.loads(row["point"])}

    def rename(self, project_id, ident, name):
        self.version(project_id, ident)
        with self.connect() as db:
            db.execute("UPDATE versions SET name=? WHERE project_id=? AND id=?", (name[:160], project_id, ident))

    def restore_backup(self, data):
        if data.get("format") != "storyscene-1" or not isinstance(data.get("versions"), list):
            raise DomainError("Choose a Storyscene project backup exported by this application.")
        p = copy.deepcopy(data["project"])
        p["document"] = validate_document(p["document"])
        if p.get("pending"):
            p["pending"]["before"]["document"] = validate_document(p["pending"]["before"]["document"])
        versions = copy.deepcopy(data["versions"])
        if len(versions) > 10000:
            raise DomainError("This backup contains too many versions.")
        mapping = {v["id"]: uid("v") for v in versions}
        if len(mapping) != len(versions) or p.get("head") not in mapping:
            raise DomainError("This backup has invalid version identities.")
        for v in versions:
            v["snapshot"]["document"] = validate_document(v["snapshot"]["document"])
            if v.get("parent") and v["parent"] not in mapping:
                raise DomainError("A parent version is missing from this backup.")
        p.update(id=uid("project"), rev=0, updated=now(), head=mapping[p["head"]])
        p.setdefault("annotations", [])
        p.setdefault("refs", [])
        p.setdefault("outline", None)
        p.setdefault("clarification", None)
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            for v in versions:
                db.execute("INSERT INTO versions VALUES (?,?,?,?,?,?,?,?)", (mapping[v["id"]], p["id"], mapping.get(v.get("parent")), v["name"], v["kind"], v["created"], json.dumps(v.get("point")), json.dumps(v["snapshot"])))
            db.execute("INSERT INTO projects VALUES (?,?)", (p["id"], json.dumps(p)))
        return p

