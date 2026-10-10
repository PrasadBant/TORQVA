"""Persistence for TORQVA records: a small typed document store on SQLite (in-memory or file).

Kinds: incident, decision, prediction, command, outcome, model_version, case, audit.  Audit rows are
append-only (no update/delete API). Every row carries its data provenance (SIMULATED | MEASURED).
"""
from __future__ import annotations

import json
import sqlite3
import threading
import time
from typing import Any, Dict, List, Optional

KINDS = ("session", "incident", "decision", "prediction", "command", "outcome", "model_version", "case",
         "lab_session", "experiment", "attestation_candidate", "reference_state", "prediction_check")


class StaleRevision(Exception):
    """Compare-and-set failed: the document changed since the caller read it."""


def _jsonable(o: Any):
    try:
        import numpy as np
        if isinstance(o, np.ndarray):
            return o.tolist()
        if isinstance(o, (np.floating, np.integer)):
            return o.item()
    except Exception:
        pass
    if hasattr(o, "value"):
        return o.value
    if hasattr(o, "__dict__"):
        return o.__dict__
    return str(o)


class Store:
    def __init__(self, path: str = ":memory:"):
        self._db = sqlite3.connect(path, check_same_thread=False)
        self._lock = threading.Lock()
        with self._lock:
            self._db.execute("CREATE TABLE IF NOT EXISTS docs (kind TEXT, id TEXT, provenance TEXT, ts REAL, body TEXT, "
                             "PRIMARY KEY(kind, id))")
            self._db.execute("CREATE TABLE IF NOT EXISTS audit (n INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL, kind TEXT, "
                             "actor TEXT, detail TEXT)")
            # Reference (baseline) versions are immutable: no UPDATE/DELETE, ever.
            self._db.execute("CREATE TABLE IF NOT EXISTS ref_versions (version INTEGER PRIMARY KEY, ts REAL, body TEXT)")
            self._db.execute("CREATE TRIGGER IF NOT EXISTS ref_no_update BEFORE UPDATE ON ref_versions "
                             "BEGIN SELECT RAISE(ABORT, 'reference versions are immutable'); END")
            self._db.execute("CREATE TRIGGER IF NOT EXISTS ref_no_delete BEFORE DELETE ON ref_versions "
                             "BEGIN SELECT RAISE(ABORT, 'reference versions are immutable'); END")
            self._db.execute("CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit "
                             "BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END")
            self._db.execute("CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit "
                             "BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END")
            self._db.commit()

    def put(self, kind: str, id: str, body: Dict[str, Any], provenance: str, ts: Optional[float] = None) -> None:
        if kind not in KINDS:
            raise ValueError(kind)
        with self._lock:
            self._db.execute("INSERT OR REPLACE INTO docs VALUES (?,?,?,?,?)",
                             (kind, str(id), provenance, ts if ts is not None else time.time(),
                              json.dumps(body, default=_jsonable)))
            self._db.commit()

    def get(self, kind: str, id: str) -> Optional[Dict[str, Any]]:
        with self._lock:
            r = self._db.execute("SELECT body, provenance FROM docs WHERE kind=? AND id=?", (kind, str(id))).fetchone()
        return None if r is None else {**json.loads(r[0]), "_provenance": r[1]}

    def list(self, kind: str, provenance: Optional[str] = None) -> List[Dict[str, Any]]:
        q, a = "SELECT body, provenance FROM docs WHERE kind=?", [kind]
        if provenance:
            q += " AND provenance=?"; a.append(provenance)
        with self._lock:
            rows = self._db.execute(q + " ORDER BY ts, id", a).fetchall()
        return [{**json.loads(b), "_provenance": p} for b, p in rows]

    def audit(self, kind: str, actor: str, detail: Dict[str, Any], ts: Optional[float] = None) -> None:
        with self._lock:
            self._db.execute("INSERT INTO audit (ts, kind, actor, detail) VALUES (?,?,?,?)",
                             (ts if ts is not None else time.time(), kind, actor, json.dumps(detail, default=_jsonable)))
            self._db.commit()

    def audit_log(self, kind: Optional[str] = None) -> List[Dict[str, Any]]:
        q, a = "SELECT n, ts, kind, actor, detail FROM audit", []
        if kind:
            q += " WHERE kind=?"; a.append(kind)
        with self._lock:
            rows = self._db.execute(q + " ORDER BY n", a).fetchall()
        return [{"n": n, "ts": ts, "kind": k, "actor": ac, "detail": json.loads(d)} for n, ts, k, ac, d in rows]

    # ---------- atomic state change + audit (the record and its audit row commit together or not at all) ----------
    def _audit_row(self, kind: str, actor: str, detail: Dict[str, Any], ts: Optional[float]) -> None:
        self._db.execute("INSERT INTO audit (ts, kind, actor, detail) VALUES (?,?,?,?)",
                         (ts if ts is not None else time.time(), kind, actor, json.dumps(detail, default=_jsonable)))

    def put_audited(self, kind: str, id: str, body: Dict[str, Any], provenance: str, audit_kind: str, actor: str,
                    detail: Dict[str, Any], expect_rev: Optional[int] = None, ref_version: Optional[Dict[str, Any]] = None) -> None:
        """Compare-and-set on body['rev'] (when expect_rev is given), then document + audit (+ optional immutable reference
        version) in ONE transaction. Any failure, including the audit write, rolls everything back and re-raises."""
        if kind not in KINDS:
            raise ValueError(kind)
        with self._lock:
            try:
                if expect_rev is not None:
                    r = self._db.execute("SELECT body FROM docs WHERE kind=? AND id=?", (kind, str(id))).fetchone()
                    cur = json.loads(r[0]).get("rev") if r else None
                    if cur != expect_rev:
                        raise StaleRevision(f"{kind}/{id}: expected rev {expect_rev}, found {cur}")
                if ref_version is not None:
                    self._db.execute("INSERT INTO ref_versions VALUES (?,?,?)",
                                     (ref_version["version"], time.time(), json.dumps(ref_version, default=_jsonable)))
                self._db.execute("INSERT OR REPLACE INTO docs VALUES (?,?,?,?,?)",
                                 (kind, str(id), provenance, time.time(), json.dumps(body, default=_jsonable)))
                self._audit_row(audit_kind, actor, detail, None)
                self._db.commit()
            except BaseException:
                self._db.rollback()
                raise

    def ref_versions(self) -> List[Dict[str, Any]]:
        with self._lock:
            rows = self._db.execute("SELECT body FROM ref_versions ORDER BY version").fetchall()
        return [json.loads(b) for (b,) in rows]
