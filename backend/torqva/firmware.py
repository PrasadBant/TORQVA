"""Firmware Manager: release validation and storage, deployment lifecycle and the device-facing download (ESP32-S3 application OTA).

What is checked, and how (nothing is taken from what an uploader types):
  * the file is a real ESP application image: magic 0xE9, segment table inside the file, the image checksum byte and, when the build appends it, the SHA-256 of the
    image (esp_image_header_t / esp_image_segment_header_t layout); the chip id in the header must be 9 (ESP32-S3);
  * the version comes from the TORQVA_FW_ID string compiled into the firmware (src/main.cpp); a typed version must match it;
  * the size must fit the inactive OTA partition (TORQVA_OTA_MAX_BYTES, default = app1 of the project's partition table, 3264 KB) and, at deployment, the size
    the device itself reports;
  * authenticity: an ECDSA P-256 / SHA-256 signature over "torqva-fw|1|<ver>|<size>|<sha256>|esp32s3", verified against the release public key
    (TORQVA_OTA_PUBLIC_KEY = path to a PEM file). SHA-256 alone is integrity, never authenticity. The device verifies the same signature with its compiled-in key.
Storage: TORQVA_FIRMWARE_DIR (default backend/data/firmware, git-ignored): images/<sha256>.bin and an index releases.json (atomic writes), and an append-only
history.jsonl. Large images never go into the in-memory document store. Release records are immutable; nothing is deleted by the application.
The device downloads with a one-time-per-deployment token (no bearer token: the device has none) that is valid only for that deployment's release, for a limited time.
Every deployment state below is either something the device reported or a backend fact (sent, link lost, timed out); nothing is assumed.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import struct
import threading
import time
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

CHIP_ESP32S3 = 9
CANON_PREFIX = "torqva-fw|1"
DEFAULT_MAX_BYTES = 3264 * 1024              # app1 (ota_1) of default_8MB.csv, the partition table this firmware is built with
VERSION_RE = re.compile(r"^(\d+)\.(\d+)\.(\d+)(?:-([A-Za-z0-9.]+))?$")
MARKER = b"TORQVA_FW_ID:"
TOKEN_TTL_S = 30 * 60
REBOOT_GRACE_S = 15 * 60                     # after REBOOTING, how long the device has to come back and report before the outcome is "verification pending"
DEPLOY_MIN_INTERVAL_S = 60.0
UPLOAD_LIMIT_PER_MIN = 10


class FirmwareError(Exception):
    def __init__(self, code: str, detail: str = "", status: int = 400):
        super().__init__(detail or code)
        self.code, self.detail, self.status = code, detail or code, status


# ---------------------------------------------------------------------------------------------------------- versions
def parse_version(v: str) -> Optional[Tuple[int, int, int, int, str]]:
    m = VERSION_RE.match(v or "")
    if not m:
        return None
    return int(m.group(1)), int(m.group(2)), int(m.group(3)), 0 if m.group(4) else 1, m.group(4) or ""


def version_compare(a: str, b: str) -> Optional[int]:
    """-1 / 0 / 1 like the firmware's version_compare (a suffixed build sorts before its release); None when either is not a version."""
    x, y = parse_version(a), parse_version(b)
    if x is None or y is None:
        return None
    return (x > y) - (x < y)


# ---------------------------------------------------------------------------------------------------------- image validation
def parse_esp_image(data: bytes) -> Dict[str, Any]:
    """Structural check of an ESP-IDF application image. Raises FirmwareError with a specific code."""
    if not data:
        raise FirmwareError("EMPTY", "the file is empty")
    if len(data) < 24 + 8 or data[0] != 0xE9:
        raise FirmwareError("NOT_ESP_IMAGE", "not an ESP application image (magic 0xE9 missing): a bootloader, partition table, flash dump or other file is not accepted")
    seg_count = data[1]
    if not 1 <= seg_count <= 16:
        raise FirmwareError("BAD_SEGMENTS", f"implausible segment count {seg_count}")
    chip_id = struct.unpack_from("<H", data, 12)[0]
    hash_appended = data[23] == 1
    pos, checksum = 24, 0xEF
    segments = []
    for i in range(seg_count):
        if pos + 8 > len(data):
            raise FirmwareError("BAD_SEGMENTS", f"segment {i} header beyond the end of the file")
        load, length = struct.unpack_from("<II", data, pos)
        pos += 8
        if length > len(data) - pos:
            raise FirmwareError("BAD_SEGMENTS", f"segment {i} ({length} bytes) runs past the end of the file")
        for byte in data[pos:pos + length]:
            checksum ^= byte
        segments.append({"load": load, "length": length})
        pos += length
    pos += 15 - (pos % 16)                       # padding: the checksum byte sits in the last byte of a 16-byte block
    if pos >= len(data):
        raise FirmwareError("BAD_SEGMENTS", "the image ends before its checksum byte")
    if data[pos] != checksum:
        raise FirmwareError("IMAGE_CHECKSUM_FAILED", "the image checksum byte does not match its segments (corrupt or truncated image)")
    pos += 1
    hash_ok = None
    if hash_appended:
        if pos + 32 > len(data):
            raise FirmwareError("BAD_SEGMENTS", "the appended SHA-256 is missing")
        hash_ok = hashlib.sha256(data[:pos]).digest() == data[pos:pos + 32]
        if not hash_ok:
            raise FirmwareError("IMAGE_HASH_MISMATCH", "the SHA-256 appended by the build does not match the image (corrupt image)")
        pos += 32
    # esp_app_desc_t follows the first segment header: magic 0xABCD5432 at offset 32
    app: Dict[str, Any] = {}
    if len(data) >= 32 + 256 and struct.unpack_from("<I", data, 32)[0] == 0xABCD5432:
        def cstr(off: int, n: int) -> str:
            return data[off:off + n].split(b"\0", 1)[0].decode("ascii", "replace")
        app = {"secure_version": struct.unpack_from("<I", data, 36)[0], "app_version": cstr(48, 32), "project": cstr(80, 32), "time": cstr(112, 16),
               "date": cstr(128, 16), "idf": cstr(144, 32)}
    return {"chip_id": chip_id, "segments": len(segments), "hash_appended": hash_appended, "hash_ok": hash_ok, "image_end": pos, "app": app}


def firmware_identity(data: bytes) -> Dict[str, str]:
    """The TORQVA_FW_ID string compiled into the firmware: ver=<x.y.z>;chip=esp32s3;proto=1;"""
    i = data.find(MARKER)
    if i < 0:
        raise FirmwareError("NO_FIRMWARE_ID", "no TORQVA_FW_ID in the image: not TORQVA firmware, or built before the Firmware Manager existed")
    end = data.find(b"\0", i)
    raw = data[i + len(MARKER): end if end > 0 else i + 160].decode("ascii", "replace")
    out = dict(kv.split("=", 1) for kv in raw.split(";") if "=" in kv)
    if parse_version(out.get("ver", "")) is None:
        raise FirmwareError("BAD_VERSION", f"the firmware version {out.get('ver')!r} is not MAJOR.MINOR.PATCH[-suffix]")
    return out


def canonical(ver: str, size: int, sha: str, chip: str = "esp32s3") -> str:
    return f"{CANON_PREFIX}|{ver}|{size}|{sha}|{chip}"


class SignatureVerifier:
    """ECDSA P-256 verification with the configured release public key. Missing key = nothing verifies (releases stay not deployable)."""

    def __init__(self, pem_path: Optional[str]):
        self.path, self.key, self.error, self.fingerprint = pem_path, None, "", ""
        if not pem_path:
            self.error = "no release public key configured (TORQVA_OTA_PUBLIC_KEY)"
            return
        try:
            from cryptography.hazmat.primitives import serialization
            from cryptography.hazmat.primitives.asymmetric import ec
            key = serialization.load_pem_public_key(Path(pem_path).read_bytes())
            if not isinstance(key, ec.EllipticCurvePublicKey) or key.curve.name != "secp256r1":
                raise ValueError("the key is not an ECDSA P-256 public key")
            der = key.public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
            self.key, self.fingerprint = key, hashlib.sha256(der).hexdigest()[:16]
        except Exception as e:                                       # noqa: BLE001 - any failure leaves verification unavailable, never permissive
            self.error = f"release public key unusable: {type(e).__name__}"

    @property
    def available(self) -> bool:
        return self.key is not None

    def verify(self, message: str, sig_b64: str) -> bool:
        if not self.key:
            return False
        try:
            from cryptography.exceptions import InvalidSignature
            from cryptography.hazmat.primitives import hashes
            from cryptography.hazmat.primitives.asymmetric import ec
            sig = base64.b64decode(sig_b64.strip(), validate=True)
            if not 8 <= len(sig) <= 80:
                return False
            try:
                self.key.verify(sig, message.encode(), ec.ECDSA(hashes.SHA256()))
                return True
            except InvalidSignature:
                return False
        except (ValueError, TypeError):
            return False


# ---------------------------------------------------------------------------------------------------------- storage
class FirmwareStore:
    """Private release storage on disk. Fails closed: an unreadable index blocks uploads and deployments instead of being replaced."""

    def __init__(self, root: str):
        self.root = Path(root)
        self.images = self.root / "images"
        self.index_path = self.root / "releases.json"
        self.history_path = self.root / "history.jsonl"
        self.lock = threading.RLock()
        self.load_error = ""
        self.releases: Dict[str, Dict[str, Any]] = {}
        self.images.mkdir(parents=True, exist_ok=True)
        if self.index_path.exists():
            try:
                raw = json.loads(self.index_path.read_text(encoding="utf-8"))
                if not isinstance(raw, dict) or not isinstance(raw.get("releases"), dict):
                    raise ValueError("not a release index")
                for rid, rec in raw["releases"].items():
                    if not (isinstance(rec, dict) and re.fullmatch(r"[0-9a-f]{12}", rid) and re.fullmatch(r"[0-9a-f]{64}", rec.get("sha256", "")) and rec["sha256"][:12] == rid):
                        raise ValueError(f"corrupt release record {rid!r}")
                self.releases = raw["releases"]
            except (ValueError, OSError) as e:
                self.load_error = f"firmware release index unreadable: {e}"

    def _atomic_write(self, path: Path, data: bytes) -> None:
        tmp = path.with_name(f".{path.name}.{secrets.token_hex(4)}.tmp")
        with open(tmp, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)

    def image_path(self, sha: str) -> Path:
        if not re.fullmatch(r"[0-9a-f]{64}", sha or ""):
            raise FirmwareError("BAD_RELEASE", "invalid image reference", 404)
        p = (self.images / f"{sha}.bin").resolve()
        if p.parent != self.images.resolve():
            raise FirmwareError("BAD_RELEASE", "invalid image reference", 404)
        return p

    def add(self, rec: Dict[str, Any], data: bytes) -> None:
        with self.lock:
            if self.load_error:
                raise FirmwareError("STORAGE_UNAVAILABLE", self.load_error, 503)
            self._atomic_write(self.image_path(rec["sha256"]), data)
            releases = dict(self.releases)
            releases[rec["id"]] = rec
            self._atomic_write(self.index_path, json.dumps({"releases": releases}, indent=1, sort_keys=True).encode())
            self.releases = releases

    def read_image(self, rec: Dict[str, Any]) -> bytes:
        data = self.image_path(rec["sha256"]).read_bytes()
        if hashlib.sha256(data).hexdigest() != rec["sha256"]:
            raise FirmwareError("STORAGE_CORRUPT", "the stored image no longer matches its release checksum", 500)
        return data

    def append_history(self, event: Dict[str, Any]) -> None:
        with self.lock:
            with open(self.history_path, "a", encoding="utf-8") as f:
                f.write(json.dumps(event, sort_keys=True) + "\n")
                f.flush()
                os.fsync(f.fileno())

    def history(self, limit: int = 200) -> List[Dict[str, Any]]:
        if not self.history_path.exists():
            return []
        out = []
        for line in self.history_path.read_text(encoding="utf-8").splitlines()[-limit:]:
            try:
                out.append(json.loads(line))
            except ValueError:
                out.append({"kind": "unreadable_history_line"})
        return out


# ---------------------------------------------------------------------------------------------------------- deployments
# Stages shown to the operator, in order. Each is set only by a device report or a backend fact.
STAGES = ["REQUESTED", "AUTHORIZED", "PREPARING", "WIFI", "MANIFEST", "DOWNLOADING", "VERIFYING", "READY", "REBOOTING", "WAITING_FOR_RECONNECTION", "SELF_TEST", "CONFIRMED"]
TERMINAL = {"CONFIRMED", "FAILED", "REFUSED", "ROLLED_BACK", "VERIFICATION_PENDING"}
DEVICE_STATES = {"AUTHORIZED", "PREPARING", "WIFI", "MANIFEST", "DOWNLOADING", "VERIFYING", "READY", "REBOOTING", "SELF_TEST", "CONFIRMED", "ROLLBACK", "FAILED", "REFUSED"}


class FirmwareManager:
    def __init__(self, bridge: Any, root: Optional[str] = None, public_key: Optional[str] = None, base_url: Optional[str] = None,
                 max_bytes: Optional[int] = None, clock: Callable[[], float] = time.monotonic, wall: Callable[[], float] = time.time):
        self.bridge = bridge
        self.store = FirmwareStore(root or os.environ.get("TORQVA_FIRMWARE_DIR") or str(Path(__file__).resolve().parents[1] / "data" / "firmware"))
        self.verifier = SignatureVerifier(public_key if public_key is not None else os.environ.get("TORQVA_OTA_PUBLIC_KEY"))
        self.base_url = base_url if base_url is not None else os.environ.get("TORQVA_OTA_PUBLIC_BASE_URL", "")
        self.max_bytes = int(max_bytes or os.environ.get("TORQVA_OTA_MAX_BYTES") or DEFAULT_MAX_BYTES)
        self.clock, self.wall = clock, wall
        self.lock = threading.RLock()
        self.deployments: Dict[str, Dict[str, Any]] = {}
        self.active: Optional[str] = None
        self._last_deploy: Dict[str, float] = {}
        self._uploads: List[float] = []
        self._token_key = secrets.token_bytes(32)                 # per backend process: tokens do not survive a restart
        if bridge is not None:
            bridge.ota_listener = self.on_device_frame

    # ---- configuration facts
    def base_url_problem(self) -> str:
        u = self.base_url or ""
        if not u:
            return "no device-facing HTTPS URL configured (TORQVA_OTA_PUBLIC_BASE_URL)"
        if not u.startswith("https://"):
            return "the device-facing URL must use https"
        host = re.sub(r"^https://", "", u).split("/", 1)[0].rsplit(":", 1)[0].lower().strip("[]")
        if host in ("localhost", "0.0.0.0", "::1") or host.startswith("127.") or not host:
            return "the device-facing URL must be reachable by the device (not localhost / 127.0.0.1)"
        return ""

    def config(self) -> Dict[str, Any]:
        return {"signature_verification": "AVAILABLE" if self.verifier.available else "UNAVAILABLE", "signature_detail": self.verifier.error,
                "key_fingerprint": self.verifier.fingerprint, "device_url": self.base_url or None, "device_url_problem": self.base_url_problem(),
                "max_image_bytes": self.max_bytes, "storage": "UNAVAILABLE" if self.store.load_error else "OK", "storage_detail": self.store.load_error}

    # ---- releases
    def validate(self, data: bytes, signature: str, claimed_version: str = "") -> Tuple[Dict[str, Any], Dict[str, Dict[str, str]]]:
        """Every check with its own status (VERIFIED / FAILED / PENDING / UNAVAILABLE). Raises only for a file that is not an image at all."""
        checks: Dict[str, Dict[str, str]] = {}
        if len(data) > self.max_bytes:
            raise FirmwareError("TOO_LARGE", f"{len(data)} bytes exceeds the inactive OTA partition ({self.max_bytes} bytes)", 413)
        info = parse_esp_image(data)
        checks["image"] = {"status": "VERIFIED", "detail": f"{info['segments']} segments, checksum ok" + (", appended SHA-256 ok" if info["hash_appended"] else "")}
        chip_ok = info["chip_id"] == CHIP_ESP32S3
        checks["chip"] = {"status": "VERIFIED" if chip_ok else "FAILED", "detail": "ESP32-S3" if chip_ok else f"image is for chip id {info['chip_id']}, not the ESP32-S3 (9)"}
        ident = firmware_identity(data)
        ver = ident["ver"]
        if claimed_version and claimed_version != ver:
            raise FirmwareError("VERSION_MISMATCH", f"the entered version {claimed_version!r} does not match the version compiled into the image ({ver!r})")
        checks["partition"] = {"status": "VERIFIED", "detail": f"{len(data)} of {self.max_bytes} bytes; the device's own partition size is checked again at deployment"}
        sha = hashlib.sha256(data).hexdigest()
        checks["integrity"] = {"status": "VERIFIED", "detail": f"SHA-256 {sha}"}
        msg = canonical(ver, len(data), sha)
        if not self.verifier.available:
            checks["signature"] = {"status": "UNAVAILABLE", "detail": self.verifier.error}
        elif not signature:
            checks["signature"] = {"status": "FAILED", "detail": "no signature supplied (backend/tools/sign_firmware.py sign)"}
        elif self.verifier.verify(msg, signature):
            checks["signature"] = {"status": "VERIFIED", "detail": f"ECDSA P-256, key {self.verifier.fingerprint}"}
        else:
            checks["signature"] = {"status": "FAILED", "detail": "the signature does not match this image and version for the configured release key"}
        rec = {"id": sha[:12], "sha256": sha, "version": ver, "size": len(data), "chip": "esp32s3" if chip_ok else f"chip {info['chip_id']}", "proto": ident.get("proto", ""),
               "build": info["app"], "signature": signature.strip() if signature else "", "canonical": msg}
        return rec, checks

    def upload(self, data: bytes, signature: str, user: str, version: str = "", notes: str = "", description: str = "") -> Dict[str, Any]:
        now = self.clock()
        with self.lock:
            self._uploads = [t for t in self._uploads if now - t < 60]
            if len(self._uploads) >= UPLOAD_LIMIT_PER_MIN:
                raise FirmwareError("RATE_LIMITED", "too many uploads in the last minute", 429)
            self._uploads.append(now)
        if self.store.load_error:
            raise FirmwareError("STORAGE_UNAVAILABLE", self.store.load_error, 503)
        rec, checks = self.validate(data, signature, version)
        if rec["id"] in self.store.releases or any(r["sha256"] == rec["sha256"] for r in self.store.releases.values()):
            raise FirmwareError("DUPLICATE_RELEASE", f"this image is already release {rec['id']}", 409)
        if any(r["version"] == rec["version"] for r in self.store.releases.values()):
            raise FirmwareError("DUPLICATE_VERSION", f"a release with version {rec['version']} already exists; build a new version", 409)
        deployable = all(c["status"] == "VERIFIED" for c in checks.values())
        rec.update({"checks": checks, "deployable": deployable, "uploaded_by": user, "uploaded_at": self.wall(), "notes": notes[:2000], "description": description[:500],
                    "status": "APPROVED" if deployable else "NOT DEPLOYABLE"})
        self.store.add(rec, data)
        self.store.append_history({"kind": "release_uploaded", "release": rec["id"], "version": rec["version"], "sha256": rec["sha256"], "by": user, "at": rec["uploaded_at"],
                                   "deployable": deployable, "signature": checks["signature"]["status"]})
        return self.public_release(rec)

    def public_release(self, rec: Dict[str, Any]) -> Dict[str, Any]:
        out = {k: v for k, v in rec.items() if k != "canonical"}
        out["deployments"] = [self.public_deployment(d) for d in self.deployments.values() if d["release"] == rec["id"]][-5:]
        return out

    def releases(self) -> List[Dict[str, Any]]:
        return sorted((self.public_release(r) for r in self.store.releases.values()), key=lambda r: r["uploaded_at"], reverse=True)

    def release(self, rid: str) -> Dict[str, Any]:
        rec = self.store.releases.get(rid)
        if not rec:
            raise FirmwareError("UNKNOWN_RELEASE", "no such release", 404)
        return rec

    # ---- device facts
    def device(self) -> Dict[str, Any]:
        snap = self.bridge.snapshot() if self.bridge is not None else {}
        info = getattr(self.bridge, "ota_info", None) if self.bridge is not None else None
        info_age = None if not info else round(self.clock() - info["_at"], 1)
        return {"connected": snap.get("connection") == "CONNECTED", "connection": snap.get("connection"), "handshake": bool(snap.get("handshake")),
                "device_id": snap.get("device_id"), "firmware": snap.get("firmware"), "chip": "ESP32-S3" if snap.get("handshake") else None,
                "session_active": bool((snap.get("session") or {}).get("active")), "safety_state": snap.get("safety_state"), "drive": snap.get("drive"),
                "ota": None if not info else {k: v for k, v in info.items() if not k.startswith("_")}, "ota_age_s": info_age}

    def eligibility(self, rec: Optional[Dict[str, Any]], device_id: str = "") -> List[str]:
        """Every reason the release cannot be deployed to the connected device now (empty = eligible). Device-side checks are repeated by the firmware."""
        d = self.device()
        why: List[str] = []
        if self.store.load_error:
            why.append("firmware storage is unavailable")
        if p := self.base_url_problem():
            why.append(p)
        if not self.verifier.available:
            why.append("signature verification is unavailable")
        if not d["connected"] or not d["handshake"]:
            why.append("device not connected")
        elif device_id and d["device_id"] != device_id:
            why.append(f"the connected device is {d['device_id']!r}, not {device_id!r}")
        if d["connected"] and not d["session_active"]:
            why.append("no authenticated session with the device (identity not proven)")
        o = d["ota"]
        if d["connected"] and (o is None or d["ota_age_s"] is None or d["ota_age_s"] > 5):
            why.append("OTA NOT CONFIGURED: the device reports no OTA capability (initial USB installation of OTA-capable firmware required)")
        elif o is not None and not o.get("cap"):
            why.append(f"OTA NOT CONFIGURED on the device: {o.get('why') or 'no reason given'}")
        elif o is not None and o.get("blk"):
            why.append(f"the device refuses an update now: {o['blk']}")
        if d["safety_state"] == "EMERGENCY_STOP":
            why.append("a safety trip is latched (an update never clears it)")
        if d["connected"] and d["drive"] not in (None, "IDLE"):
            why.append("the motor drive is not idle")
        if self.active and self.deployments[self.active]["state"] not in TERMINAL:
            why.append("another deployment is in progress")
        if rec is not None:
            if not rec.get("deployable"):
                why.append("the release did not pass every validation check")
            if o is not None and o.get("psz") and rec["size"] > o["psz"]:
                why.append(f"the image ({rec['size']} bytes) does not fit the device's inactive partition ({o['psz']} bytes)")
            installed = d["firmware"] or ""
            c = version_compare(rec["version"], installed) if installed else None
            if installed and c is None:
                why.append(f"the installed version {installed!r} cannot be compared")
            elif c is not None and c <= 0:
                why.append(f"{rec['version']} is not newer than the installed {installed} (no reinstall or downgrade)")
        return why

    # ---- deployment
    def deploy(self, rid: str, device_id: str, user: str, confirm: str, bench_power_disconnected: bool) -> Dict[str, Any]:
        rec = self.release(rid)
        now = self.clock()
        with self.lock:
            last = self._last_deploy.get(device_id, -1e9)
            if now - last < DEPLOY_MIN_INTERVAL_S:
                raise FirmwareError("RATE_LIMITED", f"one deployment per device every {int(DEPLOY_MIN_INTERVAL_S)} s", 429)
            if not bench_power_disconnected:
                raise FirmwareError("BENCH_ATTESTATION_REQUIRED", "confirm that the motor power stage is physically disconnected")
            phrase = f"INSTALL {rec['version']} ON {device_id}"
            if confirm != phrase:
                raise FirmwareError("CONFIRMATION_REQUIRED", f"type exactly: {phrase}")
            why = self.eligibility(rec, device_id)
            if why:
                raise FirmwareError("NOT_ELIGIBLE", "; ".join(why), 409)
            dep_id = secrets.token_hex(6)
            token = hmac.new(self._token_key, f"{dep_id}|{rid}".encode(), hashlib.sha256).hexdigest()[:32]
            d = self.device()
            dep = {"id": dep_id, "release": rid, "version": rec["version"], "sha256": rec["sha256"], "device_id": device_id, "from_version": d["firmware"], "requested_by": user,
                   "requested_at": self.wall(), "state": "REQUESTED", "reason": "", "bytes": 0, "total": rec["size"], "events": [], "token": token,
                   "token_expires": now + TOKEN_TTL_S, "downloads": 0, "updated": now, "rebooting_since": None}
            self.deployments[dep_id] = dep
            self.active = dep_id
            self._last_deploy[device_id] = now
        self._event(dep, "REQUESTED", f"by {user}")
        self.store.append_history({"kind": "deployment_requested", "deployment": dep_id, "release": rid, "version": rec["version"], "sha256": rec["sha256"], "device": device_id,
                                   "from_version": dep["from_version"], "by": user, "at": dep["requested_at"], "bench_power_disconnected": True})
        ok, why = self.bridge.request_ota(rid, rec["version"], token)
        if not ok:
            self._finish(dep, "FAILED", f"the update request could not be sent: {why}")
        return self.public_deployment(dep)

    def _event(self, dep: Dict[str, Any], state: str, detail: str = "") -> None:
        dep["events"].append({"state": state, "detail": detail, "at": self.wall()})
        dep["events"] = dep["events"][-60:]

    def _finish(self, dep: Dict[str, Any], state: str, reason: str) -> None:
        if dep["state"] in TERMINAL:
            return
        dep["state"], dep["reason"], dep["updated"] = state, reason, self.clock()
        self._event(dep, state, reason)
        self.store.append_history({"kind": "deployment_result", "deployment": dep["id"], "release": dep["release"], "version": dep["version"], "device": dep["device_id"],
                                   "result": state, "reason": reason, "at": self.wall()})

    def on_device_frame(self, f: Dict[str, Any]) -> None:
        """Called by the serial bridge for every "ota" / "ota_info" frame (and link events with t="link")."""
        with self.lock:
            dep = self.deployments.get(self.active) if self.active else None
        if dep is None or dep["state"] in TERMINAL:
            return
        t = f.get("t")
        if t == "link":                                              # connection facts from the bridge
            if not f.get("connected") and dep["state"] in ("REBOOTING", "READY"):
                dep["state"], dep["updated"] = "WAITING_FOR_RECONNECTION", self.clock()
                self._event(dep, "WAITING_FOR_RECONNECTION", "the device disconnected for its restart")
            elif not f.get("connected") and dep["state"] not in ("WAITING_FOR_RECONNECTION", "SELF_TEST"):
                dep["reason"] = "the device link was lost during the update"
                self._event(dep, dep["state"], dep["reason"])
            return
        if t == "ota_info":
            # The previous image is running again and says the attempt rolled back
            if f.get("last") == "ROLLED_BACK" and f.get("lver") == dep["version"] and dep["state"] in ("REBOOTING", "WAITING_FOR_RECONNECTION", "SELF_TEST", "ROLLBACK"):
                self._finish(dep, "ROLLED_BACK", "the new image did not pass its first-boot checks; the previous firmware is running")
            return
        st = f.get("st")
        if st not in DEVICE_STATES:
            return
        if st in ("SELF_TEST", "CONFIRMED", "ROLLBACK"):
            # boot reports carry the running version, not a request id
            if f.get("ver") != dep["version"]:
                return
            # ...and only count after this deployment reached its restart: a boot report seen earlier (a stale frame, or a
            # board already running that version) is never taken as confirmation of this update
            if dep["state"] not in ("READY", "REBOOTING", "WAITING_FOR_RECONNECTION", "SELF_TEST", "ROLLBACK"):
                return
            if st == "CONFIRMED":
                self._finish(dep, "CONFIRMED", f"version {dep['version']} confirmed by the device after its self-tests")
            elif st == "ROLLBACK":
                dep["state"], dep["reason"] = "ROLLBACK", f.get("why") or ""
                self._event(dep, "ROLLBACK", f"self-test failed: {f.get('why')}; the device is restarting into the previous firmware")
            else:
                dep["state"] = "SELF_TEST"
                self._event(dep, "SELF_TEST", "the new image is running its first-boot checks")
            dep["updated"] = self.clock()
            return
        if f.get("rel") != dep["release"]:
            return
        if st in ("FAILED", "REFUSED"):
            self._finish(dep, st, f.get("why") or "no reason given")
            return
        dep["state"], dep["updated"] = st, self.clock()
        if st == "DOWNLOADING":
            dep["bytes"], dep["total"] = int(f.get("b") or 0), int(f.get("n") or dep["total"])
        if st == "REBOOTING":
            dep["rebooting_since"] = self.clock()
        if not dep["events"] or dep["events"][-1]["state"] != st:
            self._event(dep, st, f.get("why") or "")

    def tick(self) -> None:
        """Backend facts that come from time alone: a device that does not come back is not called failed, it is 'verification pending'."""
        with self.lock:
            dep = self.deployments.get(self.active) if self.active else None
        if dep is None or dep["state"] in TERMINAL:
            return
        now = self.clock()
        if dep["state"] in ("REBOOTING", "WAITING_FOR_RECONNECTION", "SELF_TEST", "ROLLBACK") and dep["rebooting_since"] and now - dep["rebooting_since"] > REBOOT_GRACE_S:
            self._finish(dep, "VERIFICATION_PENDING", "the device has not reported the outcome since its restart; check the device")
        elif dep["state"] in ("REQUESTED", "AUTHORIZED", "PREPARING", "WIFI", "MANIFEST", "DOWNLOADING", "VERIFYING") and now - dep["updated"] > 300:
            self._finish(dep, "FAILED", f"no progress from the device for 5 minutes (last state {dep['state']})")

    def public_deployment(self, dep: Dict[str, Any]) -> Dict[str, Any]:
        return {k: v for k, v in dep.items() if k not in ("token", "token_expires", "updated", "rebooting_since")}

    def deployment(self, dep_id: str) -> Dict[str, Any]:
        self.tick()
        dep = self.deployments.get(dep_id)
        if not dep:
            raise FirmwareError("UNKNOWN_DEPLOYMENT", "no such deployment", 404)
        return self.public_deployment(dep)

    def current(self) -> Optional[Dict[str, Any]]:
        self.tick()
        return self.public_deployment(self.deployments[self.active]) if self.active else None

    # ---- device-facing download
    def authorize_download(self, rid: str, token: str) -> Dict[str, Any]:
        """The deployment this token belongs to. Same answer for every failure (no oracle for which part was wrong)."""
        with self.lock:
            dep = self.deployments.get(self.active) if self.active else None
            ok = (dep is not None and dep["release"] == rid and isinstance(token, str) and len(token) == 32 and hmac.compare_digest(dep["token"], token)
                  and self.clock() < dep["token_expires"] and dep["state"] not in TERMINAL and dep["downloads"] < 12)
            if not ok:
                raise FirmwareError("FORBIDDEN", "download not authorized", 403)
            dep["downloads"] += 1
        return dep

    def manifest(self, rid: str, token: str) -> Dict[str, Any]:
        self.authorize_download(rid, token)
        rec = self.release(rid)
        return {"rel": rec["id"], "ver": rec["version"], "size": rec["size"], "sha256": rec["sha256"], "chip": "esp32s3", "sig": rec["signature"]}

    def image(self, rid: str, token: str) -> bytes:
        self.authorize_download(rid, token)
        return self.store.read_image(self.release(rid))
