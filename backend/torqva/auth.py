"""Bearer-token authentication with roles. FAIL CLOSED: with no tokens configured, every endpoint refuses.

Tokens are never stored in clear: configuration holds SHA-256 digests.
  TORQVA_TOKENS='[{"sha256":"<hex of token>","user":"alice","role":"admin"}]'
Generate a token + digest:  python -m torqva.auth
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
from dataclasses import dataclass
from typing import Dict, List, Optional

from .schemas import Role

_ORDER = {Role.VIEWER: 0, Role.OPERATOR: 1, Role.ADMIN: 2}


@dataclass(frozen=True)
class Principal:
    user: str
    role: Role

    def at_least(self, role: Role) -> bool:
        return _ORDER[self.role] >= _ORDER[role]


class AuthConfigError(Exception):
    pass


class TokenAuth:
    def __init__(self, entries: Optional[List[Dict[str, str]]] = None):
        self._entries: List[Dict[str, str]] = []
        for e in entries or []:
            if not {"sha256", "user", "role"} <= set(e):
                raise AuthConfigError("token entry needs sha256, user, role")
            Role(e["role"])                              # validates
            if len(e["sha256"]) != 64:
                raise AuthConfigError("sha256 must be 64 hex chars")
            self._entries.append(dict(e))

    @classmethod
    def from_env(cls) -> "TokenAuth":
        raw = os.environ.get("TORQVA_TOKENS", "")
        return cls(json.loads(raw) if raw else [])

    @property
    def configured(self) -> bool:
        return bool(self._entries)

    def authenticate(self, token: Optional[str]) -> Optional[Principal]:
        if not token or not self._entries:
            return None
        digest = hashlib.sha256(token.encode()).hexdigest()
        found: Optional[Principal] = None
        for e in self._entries:                           # constant-time over all entries
            if hmac.compare_digest(digest, e["sha256"].lower()):
                found = Principal(e["user"], Role(e["role"]))
        return found


def new_token() -> Dict[str, str]:
    t = secrets.token_urlsafe(32)
    return {"token": t, "sha256": hashlib.sha256(t.encode()).hexdigest()}


if __name__ == "__main__":
    n = new_token()
    print("token (give to the user, shown once):", n["token"])
    print("config entry:", json.dumps({"sha256": n["sha256"], "user": "<name>", "role": "operator"}))
