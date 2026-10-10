"""Per-device authentication keys for the authenticated USB session (see esp32/torqva_fw/lib/torqva_core/auth.h).

The key file lives outside the repository's tracked content (backend/data/device_keys.json, git-ignored) and is never logged, returned by an API, or put in a snapshot.
Provisioning is a deliberate offline step (backend/tools/provision_device_key.py): generate 32 random bytes, store them here, write them into the device's NVS.
A device whose id is empty or the factory default has no key: an unprovisioned identity cannot be authenticated.
"""
from __future__ import annotations

import json
import os
import re
import secrets
import tempfile
import threading
from pathlib import Path
from typing import Dict, Optional

_ID = re.compile(r"^[A-Za-z0-9_.-]{1,64}$")
_HEX64 = re.compile(r"^[0-9a-f]{64}$")
FACTORY_IDS = ("", "UNPROVISIONED")


class KeyStoreError(ValueError):
    pass


class KeyStore:
    def __init__(self, path: Optional[str] = None):
        self._path = Path(path) if path else None
        self._lock = threading.Lock()
        self._keys: Dict[str, str] = {}
        self.load_error: Optional[str] = None
        self._load()

    def _load(self) -> None:
        if not self._path or not self._path.exists():
            return
        try:
            d = json.loads(self._path.read_text(encoding="utf-8"))
            self._keys = {k: v for k, v in d.get("keys", {}).items() if _ID.match(k) and k not in FACTORY_IDS and isinstance(v, str) and _HEX64.match(v)}
        except Exception as e:                                                  # noqa: BLE001
            self.load_error = f"device key file ignored: {type(e).__name__}"    # a damaged file yields NO keys, never a guessed one
            self._keys = {}

    def get(self, device_id: Optional[str]) -> Optional[bytes]:
        with self._lock:
            h = self._keys.get(device_id or "")
            return bytes.fromhex(h) if h else None

    def has(self, device_id: Optional[str]) -> bool:
        return self.get(device_id) is not None

    def provision(self, device_id: str, rotate: bool = False) -> bytes:
        """Creates and stores a new random 32-byte key. Refuses factory ids and an existing key unless rotate=True. Returns the key ONCE, for writing into the device."""
        if not _ID.match(device_id or "") or device_id in FACTORY_IDS:
            raise KeyStoreError("a real device id is required (not empty or UNPROVISIONED)")
        if not self._path:
            raise KeyStoreError("no key file configured")
        with self._lock:
            if device_id in self._keys and not rotate:
                raise KeyStoreError("a key already exists for this device; pass rotate to replace it (the device must be re-provisioned)")
            key = secrets.token_bytes(32)
            self._keys[device_id] = key.hex()
            self._path.parent.mkdir(parents=True, exist_ok=True)
            fd, tmp = tempfile.mkstemp(dir=str(self._path.parent), prefix=".keys-", suffix=".tmp")
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump({"keys": self._keys}, f, indent=1)
            try:
                os.chmod(tmp, 0o600)
            except OSError:
                pass
            os.replace(tmp, self._path)
            return key
