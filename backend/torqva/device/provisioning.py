"""Automatic Wi-Fi provisioning and pairing over USB (ESP32-S3).

One job at a time (``DEVICE_OPERATIONS``):

1. Validate: device id, serial port, SSID/password, backend URL, the TLS trust anchor AND that the gateway certificate names the backend address, the device
   identity key, and the safety state of any device currently owned by the backend.
2. Release the port: pause USB auto-connect and close the backend's serial owner.
3. Read: confirm the partition table still places ``nvs`` at 0x9000/0x5000, read the NVS partition and parse every entry (strict; corruption aborts).
4. Plan (``plan_network_config``, shared with scripts/setup/provision_wireless.py): replace only the TORQVA-managed keys. Every other entry is carried over unchanged,
   including OTA last-known-good records and saved runtime limits. When the board's firmware supports staged networks and a working network is stored, the NEW
   network is written as *staged* keys and the working one is left untouched.
5. Write the merged image (built in memory, never in a temp file) to 0x9000 only, then read it back and require an exact match.
6. Restart the board, reconnect over USB and require the authenticated device handshake with the expected device id and fresh telemetry.
7. Wireless: wait (without holding the lock) for the same device on its Wi-Fi link; verify identity, authentication, fresh telemetry, console and OTA; then, for a
   staged network, COMMIT it. If it never pairs the board returns to its previous network by itself.

A successful NVS write is never reported as pairing. Pairing = step 6 passed. Wireless operation = step 7 passed.
"""
from __future__ import annotations

import copy
import ipaddress
import json
import os
import re
import socket
import struct
import tempfile
import threading
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

from torqva.device import pki
from torqva.device.nvs import (
    NVS_OFFSET,
    NVS_SIZE,
    NvsEntry,
    NvsError,
    encode_partition,
    parse_partition,
)
from torqva.device.operation_lock import DEVICE_OPERATIONS, OperationBusy
from torqva.models.schemas import Role

PARTITION_TABLE_OFFSET = 0x8000
PARTITION_TABLE_SIZE = 0xC00
ESP_CHIP = "ESP32-S3"
FLASH_BAUD = 460800
MAX_BASE_URL = 128                      # wire limit of the device's wifi frames
DEFAULT_TRIAL_S = 300                   # USB-staged trial: time to unplug the cable and let the board join the new network
_PORT_RE = re.compile(r"(?i)COM\d{1,4}|/dev/(ttyUSB|ttyACM)\d+")
_DEVICE_RE = re.compile(r"[A-Za-z0-9_-]{1,32}")

# Keys TORQVA owns in NVS. Everything else in the partition is preserved byte-for-byte in meaning.
MANAGED_KEYS = frozenset({("torqva", "authkey"), ("torqva_ota", "ssid"), ("torqva_ota", "pass"),
                          ("torqva_ota", "base"), ("torqva_ota", "ca")})
STAGED_KEYS = frozenset({("torqva_ota", k) for k in ("n_ssid", "n_pass", "n_base", "n_try", "n_tr")})

TERMINAL_STATES = frozenset({"PAIRED_WIRELESS", "WIRELESS_PENDING", "COMMITTED", "ROLLED_BACK", "FAILED", "INTERRUPTED"})
STATES = ("QUEUED", "RELEASING_PORT", "READING_NVS", "WRITING_NVS", "VERIFYING_NVS", "RESTARTING", "RECONNECTING",
          "VERIFYING_DEVICE", "WIRELESS_WAIT", "COMMITTING", "PAIRED_WIRELESS", "WIRELESS_PENDING",
          "STAGING", "SWITCHING", "VERIFYING_PAIRING", "WAITING_ROLLBACK", "COMMITTED", "ROLLED_BACK", "FAILED", "INTERRUPTED")
_PROGRESS = {"QUEUED": 0, "RELEASING_PORT": 5, "READING_NVS": 15, "WRITING_NVS": 35, "VERIFYING_NVS": 60, "RESTARTING": 70,
             "RECONNECTING": 80, "VERIFYING_DEVICE": 90, "WIRELESS_WAIT": 95, "COMMITTING": 98, "PAIRED_WIRELESS": 100,
             "WIRELESS_PENDING": 95, "STAGING": 15, "SWITCHING": 40, "VERIFYING_PAIRING": 70, "WAITING_ROLLBACK": 60, "COMMITTED": 100,
             "ROLLED_BACK": 100, "FAILED": 100, "INTERRUPTED": 100}

PUBLIC_FIELDS = ("id", "kind", "device_id", "port", "ssid", "base_url", "requested_by", "state", "progress", "detail", "logs", "created_at", "updated_at",
                 "identity", "chip", "wireless", "checks", "recovery", "error_code", "staged", "stage_note", "previous_ssid", "write_state",
                 "unknown_device_state", "wait_until", "trial_s")                    # error_code is added by _fail and persisted with the rest
PUBLIC_FIELDS = PUBLIC_FIELDS + ("error_code",)


class ProvisioningError(Exception):
    def __init__(self, code: str, message: str, status: int = 409):
        super().__init__(message)
        self.code, self.message, self.status = code, message, status


# ---------------------------------------------------------------- validation (pure)

def validate_wifi(ssid: str, password: str) -> List[str]:
    """Same SSID rules as the wireless path (``DeviceBridge.request_wifi_config``) so a network set over USB can be changed later over Wi-Fi."""
    problems = []
    if not ssid or len(ssid.encode("utf-8")) > 32:
        problems.append("SSID must be 1 to 32 bytes")
    if any(ord(c) < 32 or c in '"\\' for c in ssid):
        problems.append("SSID contains characters that are not allowed (control characters, quotes or backslash)")
    if not (8 <= len(password.encode("utf-8")) <= 63):
        problems.append("Wi-Fi password must be 8 to 63 bytes (WPA2/WPA3 passphrase); open networks are not supported by TORQVA provisioning")
    if any(ord(c) < 32 for c in password):
        problems.append("Wi-Fi password contains control characters")
    return problems


def validate_base_url(url: str) -> List[str]:
    problems = []
    if not url.startswith("https://"):
        problems.append("backend address must begin with https://")
    if len(url) > MAX_BASE_URL:
        problems.append(f"backend address exceeds {MAX_BASE_URL} characters")
    if any(ord(c) < 33 for c in url):
        problems.append("backend address must not contain spaces or control characters")
    if not pki.host_of(url):
        problems.append("backend address has no host")
    return problems


def default_secrets_dir() -> Path:
    """Same location the provisioning script uses, so the existing bench CA and gateway certificate are reused."""
    override = os.environ.get("TORQVA_SECRETS_DIR")
    if override:
        return Path(override)
    base = Path(os.environ.get("LOCALAPPDATA") or (Path.home() / ".config"))
    return base / "Torqva" / "secrets"


def detect_lan_ip() -> str:
    """Primary LAN IPv4 used for routing to the internet. No packet is sent."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.connect(("8.8.8.8", 80))
            ip = ipaddress.IPv4Address(s.getsockname()[0])
        finally:
            s.close()
        if not ip.is_loopback and not ip.is_unspecified:
            return str(ip)
    except OSError:
        pass
    return ""


def parse_partition_table(raw: bytes) -> List[Dict[str, Any]]:
    """Entries of the flashed partition table (name, type, subtype, offset, size). Stops at the end marker; refuses anything unreadable."""
    out = []
    for i in range(0, len(raw) - 31, 32):
        e = raw[i:i + 32]
        if e[:2] in (b"\xff\xff", b"\xeb\xeb"):
            break
        if e[:2] != b"\xaa\x50":
            raise ProvisioningError("PARTITION_TABLE_INVALID", "the device partition table is not readable; USB recovery is required", 409)
        ptype, sub, off, size = struct.unpack_from("<BBII", e, 2)
        out.append({"name": e[12:28].split(b"\0", 1)[0].decode("ascii", "replace"), "type": ptype, "subtype": sub, "offset": off, "size": size})
    return out


def check_partition_table(raw: bytes) -> None:
    """Fail unless the flashed partition table places ``nvs`` exactly where the write will go (and nothing overlaps it)."""
    parts = parse_partition_table(raw)
    nvs = [p for p in parts if p["name"] == "nvs"]
    if not nvs:
        raise ProvisioningError("PARTITION_LAYOUT_MISMATCH", "the device partition table has no nvs partition; the write was refused", 409)
    p = nvs[0]
    if (p["type"], p["subtype"], p["offset"], p["size"]) != (0x01, 0x02, NVS_OFFSET, NVS_SIZE):
        raise ProvisioningError("PARTITION_LAYOUT_MISMATCH",
                                f"the device's NVS partition is at 0x{p['offset']:x}/0x{p['size']:x}, not the expected 0x{NVS_OFFSET:x}/0x{NVS_SIZE:x}; the write was refused", 409)
    end = NVS_OFFSET + NVS_SIZE
    for q in parts:
        if q is not p and q["offset"] < end and NVS_OFFSET < q["offset"] + q["size"]:
            raise ProvisioningError("PARTITION_LAYOUT_MISMATCH", f"partition {q['name']!r} overlaps the NVS range; the write was refused", 409)


# ---------------------------------------------------------------- the one NVS planner (shared with scripts/setup/provision_wireless.py)

@dataclass
class NetworkPlan:
    entries: List[NvsEntry]
    staged: bool
    note: str             # why the change is not staged ("" when it is)
    identity: str         # reused | created | rotated
    existing_count: int


def _val(existing: Dict[Tuple[str, str], NvsEntry], ns: str, key: str) -> str:
    e = existing.get((ns, key))
    return e.value if e is not None else ""


def group_by_namespace(entries: List[NvsEntry]) -> List[NvsEntry]:
    """The encoder writes a namespace row whenever the namespace changes, so a namespace must never appear in two runs."""
    groups: Dict[str, List[NvsEntry]] = {}
    for e in entries:
        groups.setdefault(e.namespace, []).append(e)
    return [e for g in groups.values() for e in g]


def resolve_identity(existing: Dict[Tuple[str, str], NvsEntry], keystore: Any, device_id: str, rotate: bool = False) -> Tuple[bytes, str]:
    """The device authentication key to write. An existing identity is NEVER changed by an incidental network update."""
    nvs_key = _val(existing, "torqva", "authkey")
    if keystore is None:
        raise ProvisioningError("KEYSTORE_MISSING", "the device key store is not configured", 503)
    if rotate:
        return keystore.provision(device_id, rotate=True), "rotated"
    key = keystore.get(device_id)
    if key is not None:
        if nvs_key and nvs_key != key.hex():
            raise ProvisioningError("KEY_MISMATCH", "the board already holds a device key that differs from this backend's key store, so writing would change its identity. "
                                                   "Restore the matching key store, or rotate the key deliberately.", 409)
        return key, "reused"
    if nvs_key:
        raise ProvisioningError("IDENTITY_UNKNOWN", f"the board already has a device key but this backend has none for {device_id!r}. Add that device's key to the key store, "
                                                   "or erase the board's NVS to start a fresh identity.", 409)
    return keystore.provision(device_id), "created"


def plan_network_config(existing: Dict[Tuple[str, str], NvsEntry], *, device_key: bytes, identity: str, ssid: str, password: str, base_url: str,
                        ca_pem: str, stage_capable: bool, trial_s: int = DEFAULT_TRIAL_S) -> NetworkPlan:
    """Entries of the new NVS image. Every unrelated entry survives; the working network survives whenever the change can be staged."""
    ca = ca_pem.strip()
    has_active = all(_val(existing, "torqva_ota", k) for k in ("ssid", "pass", "base"))
    same_ca = _val(existing, "torqva_ota", "ca") == ca
    staged = bool(stage_capable and has_active and same_ca)
    if staged:
        note = ""
    elif not stage_capable:
        note = "the board's firmware does not report staged-network support, so the new network replaces the old one directly"
    elif not has_active:
        note = "the board has no stored working network to fall back to"
    else:
        note = "the trust anchor changes together with the network, so the previous network could not authenticate the backend"
    keep = [e for k, e in existing.items() if k not in STAGED_KEYS and k != ("torqva", "authkey") and (staged or k not in MANAGED_KEYS)]
    entries = keep + [NvsEntry("torqva", "authkey", "hex2bin", device_key.hex())]
    if staged:
        entries += [NvsEntry("torqva_ota", "n_ssid", "string", ssid), NvsEntry("torqva_ota", "n_pass", "string", password),
                    NvsEntry("torqva_ota", "n_base", "string", base_url), NvsEntry("torqva_ota", "n_tr", "u32", str(int(trial_s))),
                    NvsEntry("torqva_ota", "n_try", "u8", "0")]
    else:
        entries += [NvsEntry("torqva_ota", "ssid", "string", ssid), NvsEntry("torqva_ota", "pass", "string", password),
                    NvsEntry("torqva_ota", "base", "string", base_url), NvsEntry("torqva_ota", "ca", "string", ca)]
    return NetworkPlan(group_by_namespace(entries), staged, note, identity, len(existing))


# ---------------------------------------------------------------- flash access

def _load_esptool():
    try:
        import esptool
        return esptool
    except ImportError as exc:
        # PlatformIO's bundled copy is deliberately NOT used as a fallback: it needs its own extra dependencies (intelhex, bitstring, ...) and fails at import
        # time on a plain backend environment.
        raise ProvisioningError("ESPTOOL_MISSING", f"esptool is not installed in the backend environment ({exc}); run: pip install -r backend/requirements.txt", 503) from exc


class EsptoolFlash:
    """In-process esptool adapter: no subprocess, no temp files, nothing written except the NVS region."""

    def __init__(self, port: str):
        self.port = port
        self.esp: Any = None

    def open(self) -> str:
        esptool = _load_esptool()
        rom = esptool.cmds.detect_chip(port=self.port)
        # Reading flash is a stub-loader command: the chip's built-in ROM loader does not implement it (it answers with a dropped serial stream).
        # The command line esptool loads the stub first for the same reason.
        self.esp = rom.run_stub()
        try:
            self.esp.change_baud(FLASH_BAUD)
        except Exception:                                                  # noqa: BLE001 - a slower link still works
            pass
        try:
            size = esptool.cmds.detect_flash_size(self.esp)
            if size:
                self.esp.flash_set_parameters(esptool.util.flash_size_bytes(size))
        except Exception:                                                  # noqa: BLE001 - the write path sets the default size below
            pass
        return str(getattr(self.esp, "CHIP_NAME", ""))

    def read(self, offset: int, size: int) -> bytes:
        return bytes(self.esp.read_flash(offset, size))

    def write(self, offset: int, data: bytes) -> None:
        block = self.esp.FLASH_WRITE_SIZE
        blocks = self.esp.flash_begin(len(data), offset)
        for seq in range(blocks):
            chunk = data[seq * block:(seq + 1) * block]
            chunk = chunk + b"\xff" * (block - len(chunk))
            self.esp.flash_block(chunk, seq)
        self.esp.flash_finish(reboot=False)

    def reset(self) -> None:
        self.esp.hard_reset()

    def close(self) -> None:
        port = getattr(self.esp, "_port", None)
        if port is not None:
            try:
                port.close()
            except Exception:                                          # noqa: BLE001
                pass
        self.esp = None


def write_network_config(flash: Any, *, device_id: str, keystore: Any, ssid: str, password: str, base_url: str, ca_pem: str, stage_capable: bool,
                         trial_s: int = DEFAULT_TRIAL_S, rotate_key: bool = False, erase_damaged: bool = False,
                         phase: Optional[Callable[[str, str], None]] = None) -> Dict[str, Any]:
    """Read -> plan -> write -> verify on an already-constructed flash adapter. The ONE implementation behind both the web service and the setup script.

    ``phase(name, detail)`` is called at READING_NVS, WRITING_NVS and NVS_VERIFIED. Raises ProvisioningError on every refusal; the board is untouched unless
    ``WRITING_NVS`` was reported. A damaged NVS partition is refused unless ``erase_damaged`` is set: then it is rebuilt from scratch, which loses whatever
    could not be read (the device key is rewritten from the key store; saved runtime limits and OTA records are not recoverable and the board re-learns them)."""
    phase = phase or (lambda name, detail: None)
    phase("READING_NVS", "reading the device partition table and NVS partition")
    chip = flash.open()
    if chip != ESP_CHIP:
        raise ProvisioningError("WRONG_CHIP", f"the board reports {chip or 'an unknown chip'}; TORQVA provisioning supports {ESP_CHIP} only", 409)
    check_partition_table(flash.read(PARTITION_TABLE_OFFSET, PARTITION_TABLE_SIZE))
    current = flash.read(NVS_OFFSET, NVS_SIZE)
    rebuilt = False
    try:
        existing = parse_partition(current)
    except NvsError as exc:
        if not erase_damaged:
            raise ProvisioningError("NVS_UNREADABLE", f"the device's NVS partition is damaged ({exc}); it was not modified. Choose 'rebuild the damaged settings' to replace it "
                                                      "(unreadable saved settings are lost), or recover over USB", 409) from exc
        existing, rebuilt = {}, True
    key, identity = resolve_identity(existing, keystore, device_id, rotate_key)
    plan = plan_network_config(existing, device_key=key, identity=identity, ssid=ssid, password=password, base_url=base_url, ca_pem=ca_pem,
                               stage_capable=stage_capable, trial_s=trial_s)
    try:
        image = encode_partition(plan.entries, NVS_SIZE)
    except Exception as exc:                                               # noqa: BLE001
        raise ProvisioningError("NVS_FULL", f"the merged configuration does not fit the NVS partition ({type(exc).__name__})", 409) from exc
    phase("WRITING_NVS", "writing the merged NVS image to 0x9000 only")
    flash.write(NVS_OFFSET, image)
    phase("VERIFYING_NVS", "reading the partition back and comparing it with the image that was written")
    readback = flash.read(NVS_OFFSET, NVS_SIZE)
    if readback != image:
        raise ProvisioningError("NVS_VERIFY_FAILED", "the NVS partition read back differs from the written image; the board must be provisioned again over USB", 409)
    wanted = {(e.namespace, e.key): (e.encoding, e.value) for e in plan.entries}
    if {k: (v.encoding, v.value) for k, v in parse_partition(readback).items()} != wanted:
        raise ProvisioningError("NVS_VERIFY_FAILED", "the logical NVS content does not match the requested configuration", 409)
    phase("NVS_VERIFIED", "the written configuration was read back and matches")
    return {"chip": chip, "existing_entries": plan.existing_count, "identity": identity, "staged": plan.staged, "stage_note": plan.note, "image_size": len(image), "rebuilt": rebuilt}


# ---------------------------------------------------------------- persistent job history

class JobHistory:
    """Public job records (never a password, key or certificate), kept in a JSON file so a backend restart does not lose them.

    ``reconcile()`` runs once at start-up: a job that was still running when the backend stopped is marked INTERRUPTED. If it had started writing flash, the board's
    configuration is uncertain, so a quarantine record is stored and re-applied to the operation lock until a verified USB provisioning (or an operator) clears it."""

    def __init__(self, path: Optional[Path] = None, limit: int = 100, wall: Callable[[], float] = time.time):
        self.path = Path(path) if path else None
        self.limit = limit
        self.wall = wall
        self._mu = threading.RLock()
        self._jobs: Dict[str, Dict[str, Any]] = {}
        self._quarantine: Optional[Dict[str, str]] = None
        self._load()

    # -- persistence
    def _load(self) -> None:
        if self.path is None or not self.path.exists():
            return
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
            for j in data.get("jobs", []):
                if isinstance(j, dict) and isinstance(j.get("id"), str):
                    self._jobs[j["id"]] = {k: j[k] for k in PUBLIC_FIELDS if k in j}
            q = data.get("quarantine")
            self._quarantine = dict(q) if isinstance(q, dict) else None
        except (OSError, ValueError):
            try:
                self.path.replace(self.path.with_suffix(".corrupt"))      # keep the unreadable file for inspection; start clean
            except OSError:
                pass

    def _flush(self) -> None:
        if self.path is None:
            return
        data = {"version": 1, "jobs": list(self._jobs.values())[-self.limit:], "quarantine": self._quarantine}
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            fd, tmp = tempfile.mkstemp(prefix=self.path.name + ".", dir=str(self.path.parent))
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                json.dump(data, fh, separators=(",", ":"))
            os.replace(tmp, self.path)                                  # atomic: a crash never leaves a half-written history
        except OSError:
            pass                                                        # history is best-effort; the live job record is unaffected

    # -- API
    def put(self, public_job: Dict[str, Any]) -> None:
        with self._mu:
            self._jobs[public_job["id"]] = {k: copy.deepcopy(public_job[k]) for k in PUBLIC_FIELDS if k in public_job}
            while len(self._jobs) > self.limit:
                self._jobs.pop(next(iter(self._jobs)))
            self._flush()

    def get(self, job_id: str) -> Optional[Dict[str, Any]]:
        with self._mu:
            j = self._jobs.get(job_id)
            return copy.deepcopy(j) if j is not None else None

    def recent(self, limit: int = 20) -> List[Dict[str, Any]]:
        with self._mu:
            rows = list(self._jobs.values())[-limit:]
            return [copy.deepcopy({k: v for k, v in j.items() if k != "logs"}) for j in reversed(rows)]

    @property
    def quarantine(self) -> Optional[Dict[str, str]]:
        with self._mu:
            return None if self._quarantine is None else dict(self._quarantine)

    def set_quarantine(self, reason: str, job: str = "") -> None:
        with self._mu:
            self._quarantine = {"reason": reason, "job": job}
            self._flush()

    def clear_quarantine(self) -> None:
        with self._mu:
            self._quarantine = None
            self._flush()

    def reconcile(self) -> List[Dict[str, Any]]:
        """Mark jobs that were running when the backend stopped. Returns them."""
        out = []
        with self._mu:
            for job in self._jobs.values():
                if job.get("state") in TERMINAL_STATES:
                    continue
                writing = job.get("write_state") == "writing"
                job.update({"state": "INTERRUPTED", "progress": 100, "error_code": "BACKEND_RESTARTED", "updated_at": self.wall()})
                if job.get("kind") == "network_switch":
                    job["detail"] = ("The backend stopped during a network change. If the change had not been committed the board returns to its previous network by itself; "
                                     "check the Device status.")
                    job["recovery"] = ["Open Device status and confirm which network the board is on.", "If it is offline, wait two minutes for it to restore its previous network, "
                                       "then reconnect it over USB if it does not return."]
                elif writing:
                    job["unknown_device_state"] = True
                    job["detail"] = ("The backend stopped while the board's network settings were being written. The board's configuration is unknown. "
                                     "Other device operations are blocked until it is provisioned again over USB (which re-reads and verifies it).")
                    job["recovery"] = ["Connect the board over USB with motor power disconnected.", "Run Configure & Connect again; it reads the current configuration and verifies the write."]
                    self._quarantine = {"reason": "an interrupted Wi-Fi configuration write left the board's state unknown", "job": job["id"]}
                else:
                    job["detail"] = "The backend stopped before the board was changed or after its configuration had been verified. Check the Device status."
                    job["recovery"] = ["Check the Device status; run Configure & Connect again if the board is not on the intended network."]
                out.append(copy.deepcopy(job))
            if out:
                self._flush()
        return out


# ---------------------------------------------------------------- pairing verification (shared by USB provisioning and network switching)

def signal_bars(rssi: Optional[float]) -> int:
    if rssi is None:
        return 0
    return 4 if rssi >= -55 else 3 if rssi >= -65 else 2 if rssi >= -75 else 1


class PairingVerifier:
    """Decides, from the live device snapshot only, whether the board is paired over Wi-Fi. A joined network or an open socket is not pairing."""

    def __init__(self, bridge: Any, clock: Callable[[], float] = time.monotonic, sleep: Callable[[float], None] = time.sleep, wall: Callable[[], float] = time.time):
        self.bridge, self.clock, self.sleep, self.wall = bridge, clock, sleep, wall

    def wireless_ok(self, device_id: str, ssid: Optional[str], net_after: float = 0.0) -> Tuple[bool, str]:
        snap = self.bridge.snapshot()
        if (snap.get("transport") or {}).get("kind") != "wifi":
            return False, "the board is not on the Wi-Fi link"
        if snap.get("device_id") != device_id:
            return False, f"the board identifies as {snap.get('device_id')!r}, not {device_id!r}"
        if not (snap.get("session") or {}).get("active"):
            return False, "no authenticated session on the Wi-Fi link"
        if ssid is not None:
            ni = snap.get("net_info") or {}
            if ni.get("ssid") != ssid or float(ni.get("updated_at") or 0) < net_after:
                return False, "the board has not reported joining that network yet"
        if not snap.get("telemetry_fresh"):
            return False, "telemetry over Wi-Fi is not fresh yet"
        return True, ""

    def wait(self, predicate: Callable[[], Tuple[bool, str]], timeout_s: float, interval_s: float = 1.0) -> Tuple[bool, str]:
        deadline = self.clock() + timeout_s
        last = ""
        while True:
            ok, last = predicate()
            if ok:
                return True, ""
            if self.clock() >= deadline:
                return False, last
            self.sleep(interval_s)

    def extra_checks(self, since_wall: float, console_wait_s: float = 10.0) -> Dict[str, Any]:
        """Console and OTA readiness over the wireless link. Informational: they never block a commit, but a failure is reported.
        The device's first log line over a new link can trail the pairing by a moment, so the console is given a short, bounded time."""
        seen, _ = self.wait(lambda: (bool(self.bridge.console_seen("wifi", since_wall)), ""), console_wait_s, 0.5)
        ota = (self.bridge.snapshot().get("ota") or {})
        return {"console": "ok" if seen else "no log line seen over Wi-Fi",
                "ota_ready": "ok" if ota.get("cap") == 1 else (f"not ready: {ota.get('why') or 'the device has not reported OTA capability'}")}

    def commit(self, device_id: str, ssid: str, user: str, ack_timeout_s: float = 10.0, state_timeout_s: float = 20.0) -> None:
        """Ask the board to make the network on trial permanent, and wait until IT reports the trial over. Raises ProvisioningError on any doubt."""
        ok, why, cid = self.bridge.request_wifi_commit(user, Role.ADMIN)
        if not ok:
            raise ProvisioningError("COMMIT_NOT_SENT", f"the commit request could not be sent ({why})", 409)

        def acked() -> Tuple[bool, str]:
            a = self.bridge.sys_ack(cid)
            if a is None:
                return False, "no acknowledgement yet"
            if a.get("status") == "REJECTED":
                raise ProvisioningError("COMMIT_REJECTED", f"the board refused the commit ({a.get('reason')}); it will restore its previous network", 409)
            return True, ""
        ok, why = self.wait(acked, ack_timeout_s, 0.5)
        if not ok:
            raise ProvisioningError("COMMIT_UNCONFIRMED", "the board did not acknowledge the commit; it will restore its previous network if the trial ends", 409)

        def committed() -> Tuple[bool, str]:
            ws = self.bridge.snapshot().get("wifi_state") or {}
            if ws.get("supported") and not ws.get("trial") and ws.get("active_ssid") == ssid and ws.get("age_s", 99) < 6:
                return True, ""
            return False, "the board still reports a trial"
        ok, why = self.wait(committed, state_timeout_s, 0.5)
        if not ok:
            raise ProvisioningError("COMMIT_UNCONFIRMED", "the board acknowledged the commit but still reports a trial network; it may restore its previous network", 409)


# ---------------------------------------------------------------- scan

SCAN_NOTE = ("The ESP32-S3 supports 2.4 GHz Wi-Fi only (channels 1-14). 5 GHz networks cannot be seen or used; if your router combines both bands under one name, "
             "enable its 2.4 GHz radio. Hidden networks are not listed: type their name by hand.")


def run_scan(bridge: Any, user: str, *, snapshot: Optional[Dict[str, Any]] = None, lock: Any = DEVICE_OPERATIONS, timeout_s: float = 8.0,
             clock: Callable[[], float] = time.monotonic, sleep: Callable[[float], None] = time.sleep, cache: Optional[Dict[str, Any]] = None,
             cache_ttl_s: float = 12.0) -> Dict[str, Any]:
    """Ask the connected, authenticated board to scan. The board scans asynchronously (its control loop never waits). Refused while an operation runs or the motor
    is not idle, because a scan briefly leaves the home channel; repeated requests within ``cache_ttl_s`` return the previous result instead of scanning again."""
    snap = snapshot if snapshot is not None else bridge.snapshot()
    now = clock()
    if cache and cache.get("at") is not None and now - cache["at"] < cache_ttl_s and cache.get("result"):
        return {**cache["result"], "cached": True}
    if lock.active is not None:
        raise ProvisioningError("BUSY", f"{lock.active} is running; scan again when it has finished", 409)
    if snap.get("connection") not in ("CONNECTED", "STALE") or not (snap.get("session") or {}).get("active"):
        raise ProvisioningError("NO_AUTHENTICATED_LINK", "scanning needs the board connected with an authenticated session (USB or Wi-Fi); you can still type the network name by hand", 409)
    if snap.get("drive") != "IDLE":
        raise ProvisioningError("NOT_SAFE_STATE", "the motor drive is not confirmed idle; a scan briefly leaves the home channel, so it is refused while the motor runs", 409)
    ws = snap.get("wifi_state") or {}
    if not ws.get("supported"):
        raise ProvisioningError("UNSUPPORTED_FIRMWARE", "this firmware cannot scan for networks; update the firmware or type the network name by hand", 409)
    ok, why, cid = bridge.request_wifi_scan(user, Role.ADMIN)
    if not ok:
        raise ProvisioningError("SCAN_NOT_SENT", f"the scan request could not be sent ({why})", 409)
    deadline = clock() + timeout_s
    while True:
        res = bridge.wifi_scan_result()
        if res["state"] in ("done", "failed"):
            break
        if clock() >= deadline:
            res = {**res, "state": "failed", "why": "SCAN_TIMEOUT"}
            break
        sleep(0.25)
    if res["state"] != "done":
        why = res.get("why") or "SCAN_FAILED"
        raise ProvisioningError("SCAN_FAILED", {"SCAN_BUSY": "the board is already scanning or scanned moments ago; try again in 10 seconds"}.get(why, f"the board could not scan ({why})"), 409)
    current = ((snap.get("net_info") or {}).get("ssid")) or ""
    committed = ws.get("active_ssid") or ""
    nets = []
    for n in sorted(res["networks"], key=lambda n: -n["rssi"]):
        nets.append({**n, "bars": signal_bars(n["rssi"]), "current": n["ssid"] == current, "configured": n["ssid"] == committed})
    result = {"networks": nets, "current_ssid": current, "configured_ssid": committed, "note": SCAN_NOTE, "scanned_at": res.get("finished_at"), "cached": False}
    if cache is not None:
        cache["at"], cache["result"] = now, result
    return result


# ---------------------------------------------------------------- USB provisioning job

class WifiProvisioner:
    """Owns USB provisioning jobs. Every collaborator is injectable so the flow is testable without hardware."""

    def __init__(self, bridge: Any, *, secrets_dir: Path, gateway_port: int = 8443, flash_factory: Callable[[str], Any] = EsptoolFlash,
                 lan_ip: Callable[[], str] = detect_lan_ip, lock: Any = DEVICE_OPERATIONS, history: Optional[JobHistory] = None,
                 clock: Callable[[], float] = time.monotonic, sleep: Callable[[float], None] = time.sleep, wall: Callable[[], float] = time.time,
                 phase_timeout_s: float = 60.0, job_timeout_s: float = 240.0, wireless_timeout_s: float = 285.0, stall_s: float = 120.0, run_async: bool = True):
        self.bridge = bridge
        self.secrets_dir = Path(secrets_dir)
        self.gateway_port = gateway_port
        self.flash_factory = flash_factory
        self.lan_ip = lan_ip
        self.lock = lock
        self.history = history or JobHistory(None, wall=wall)
        self.clock, self.sleep, self.wall = clock, sleep, wall
        self.phase_timeout_s, self.job_timeout_s, self.wireless_timeout_s, self.stall_s = phase_timeout_s, job_timeout_s, wireless_timeout_s, stall_s
        self.run_async = run_async
        self.verifier = PairingVerifier(bridge, clock, sleep, wall)
        self.jobs: Dict[str, Dict[str, Any]] = {}
        self._mu = threading.RLock()
        self._scan_cache: Dict[str, Any] = {}
        self.history.reconcile()                  # jobs that were running when the backend stopped are marked INTERRUPTED (and may quarantine the lock)
        self.restore_quarantine()

    # ---- start-up
    def restore_quarantine(self) -> None:
        """Re-apply a persisted 'device state unknown' record to the operation lock (after reconcile)."""
        q = self.history.quarantine
        if q:
            self.lock.quarantine(q.get("reason", "device state unknown"), q.get("job", ""))

    def clear_recovery(self, user: str) -> None:
        self.history.clear_quarantine()
        self.lock.clear_quarantine()

    # ---- addresses and status (no secrets)
    def default_base_url(self) -> str:
        """Automatic backend address: the LAN interface the laptop routes through, on the gateway port."""
        ip = self.lan_ip()
        if not ip:
            raise ProvisioningError("LAN_ADDRESS_UNKNOWN", "could not detect the laptop's LAN address; enter the backend address in Advanced settings", 409)
        return f"https://{ip}:{self.gateway_port}"

    def gateway_check(self, base_url: str) -> None:
        """The device checks the gateway certificate's host name: refuse before changing anything if it does not name this address."""
        host = pki.host_of(base_url)
        if not pki.gateway_cert_covers(self.secrets_dir, host):
            raise ProvisioningError("GATEWAY_CERT_HOST_MISMATCH",
                                    f"the HTTPS gateway certificate does not name {host or 'that address'} (or has expired), so the board would reject the gateway. "
                                    "Reissue the gateway certificate for this address and restart the gateway (npm run dev:lan), then try again.", 409)

    def reissue_gateway_cert(self, host: str) -> Dict[str, Any]:
        if not (self.secrets_dir / "tls" / "bench_ca_key.pem").exists():
            raise ProvisioningError("CA_KEY_MISSING", "the bench CA private key is not available here, so a gateway certificate cannot be issued", 409)
        try:
            ipaddress.IPv4Address(host)
        except ValueError as exc:
            raise ProvisioningError("BAD_HOST", "the gateway certificate can only be issued for a literal IPv4 address", 422) from exc
        pki.ensure_tls_certs(self.secrets_dir, host)
        return {"host": host, "restart_required": True, "detail": "The gateway certificate was reissued. Restart the HTTPS gateway so it loads it."}

    def _snapshot(self) -> Dict[str, Any]:
        try:
            return self.bridge.snapshot()
        except Exception:                                                  # noqa: BLE001
            return {}

    def current_network(self) -> Dict[str, Any]:
        snap = self._snapshot()
        ni = snap.get("net_info") or {}
        ws = snap.get("wifi_state") or {}
        tr = snap.get("transport") or {}
        return {"connected": snap.get("connection") in ("CONNECTED", "STALE"), "transport": tr.get("kind"), "device_id": snap.get("device_id"),
                "ssid": ni.get("ssid") or "", "rssi": ni.get("rssi"), "bars": signal_bars(ni.get("rssi")), "ip": ni.get("ip") or "", "band": "2.4 GHz" if ni.get("ssid") else "",
                "configured_ssid": ws.get("active_ssid") or "", "staging_supported": bool(ws.get("supported")), "trial": bool(ws.get("trial")), "trial_left_s": ws.get("left_s") or 0,
                "session_active": bool((snap.get("session") or {}).get("active")), "telemetry_fresh": bool(snap.get("telemetry_fresh"))}

    def status(self) -> Dict[str, Any]:
        ca, ca_detail = pki.read_trust_anchor(self.secrets_dir)
        ip = self.lan_ip()
        try:
            _load_esptool()
            esptool_ok = True
        except ProvisioningError:
            esptool_ok = False
        busy = self.lock.active
        quarantine = self.lock.quarantined
        gw_ok, gw_detail = True, ""
        if ip and ca is not None and not pki.gateway_cert_covers(self.secrets_dir, ip):
            gw_ok, gw_detail = False, f"the gateway certificate does not name this laptop's address {ip}"
        return {
            "esptool": esptool_ok, "trust_anchor": ca is not None, "trust_anchor_detail": ca_detail,
            "default_backend_url": f"https://{ip}:{self.gateway_port}" if ip else "",
            "gateway_cert_ok": gw_ok, "gateway_cert_detail": gw_detail,
            "busy_operation": busy, "recovery_required": quarantine,
            "available": esptool_ok and ca is not None and busy is None and quarantine is None,
            "available_for_usb": esptool_ok and ca is not None and busy is None,
            "steps": list(STATES), "current_network": self.current_network(),
        }

    def get(self, job_id: str) -> Dict[str, Any]:
        with self._mu:
            job = self.jobs.get(job_id)
            if job is not None:
                return self._public(job)
        stored = self.history.get(job_id)
        if stored is None:
            raise ProvisioningError("UNKNOWN_JOB", "no such provisioning job", 404)
        return self._stalled(stored)

    def history_list(self, limit: int = 20) -> List[Dict[str, Any]]:
        return [self._stalled(j) for j in self.history.recent(limit)]

    # ---- start
    def start(self, *, device_id: str, port: str, ssid: str, password: str, base_url: str, user: str, confirm_physical: bool,
              snapshot: Optional[Dict[str, Any]] = None, rotate_key: bool = False, erase_damaged_nvs: bool = False) -> Dict[str, Any]:
        if not confirm_physical:
            raise ProvisioningError("PHYSICAL_CONFIRMATION_REQUIRED", "confirm that motor power is disconnected before provisioning", 409)
        if not _DEVICE_RE.fullmatch(device_id or ""):
            raise ProvisioningError("BAD_DEVICE_ID", "device id must be 1 to 32 letters, digits, '-' or '_'", 422)
        if not _PORT_RE.fullmatch(port or ""):
            raise ProvisioningError("BAD_PORT", "select a supported serial port (COMn or /dev/ttyACM*, /dev/ttyUSB*)", 422)
        problems = validate_wifi(ssid, password) + validate_base_url(base_url or "")
        if problems:
            raise ProvisioningError("INVALID_INPUT", "; ".join(problems), 422)
        ca, ca_detail = pki.read_trust_anchor(self.secrets_dir)
        if ca is None:
            raise ProvisioningError("TRUST_ANCHOR_MISSING", ca_detail, 409)
        self.gateway_check(base_url)

        snap = snapshot if snapshot is not None else self._snapshot()
        self._check_device_state(snap, device_id, port)
        ws = snap.get("wifi_state") or {}
        stage_capable = bool(ws.get("supported")) and snap.get("device_id") == device_id and snap.get("connection") in ("CONNECTED", "STALE")
        tr = snap.get("transport") or {}
        reconnect_port = tr.get("port") if (tr.get("kind") == "usb" and snap.get("connection") in ("CONNECTED", "STALE")) else None

        try:
            held = self.lock.try_acquire("wifi_provisioning")
        except OperationBusy as busy:
            raise ProvisioningError("BUSY", f"{busy.active} is running; wait for it to finish", 409) from busy

        now = self.wall()
        job = {"id": uuid.uuid4().hex[:12], "kind": "usb_provisioning", "device_id": device_id, "port": port, "ssid": ssid, "base_url": base_url, "requested_by": user,
               "state": "QUEUED", "progress": 0, "detail": "queued", "logs": [], "created_at": now, "updated_at": now, "identity": "pending", "chip": None,
               "wireless": False, "checks": {}, "recovery": [], "staged": False, "stage_note": "", "previous_ssid": ws.get("active_ssid") or "", "write_state": "none",
               "unknown_device_state": False, "wait_until": None, "trial_s": int(self.wireless_timeout_s) + 15}
        with self._mu:
            self.jobs[job["id"]] = job
        self.history.put(self._public(job))
        # Secrets stay in this closure only; they are never stored on the job record.
        secrets = {"password": password, "ca": ca, "held": held, "stage_capable": stage_capable, "reconnect_port": reconnect_port, "rotate": rotate_key, "erase_damaged": erase_damaged_nvs,
                   "t0": self.clock()}
        if self.run_async:
            threading.Thread(target=self._run, args=(job, secrets), daemon=True, name=f"wifi-prov-{job['id']}").start()
        else:
            self._run(job, secrets)
        return self._public(job)

    def _check_device_state(self, snap: Dict[str, Any], device_id: str, port: str) -> None:
        """Refuse to restart a board that is connected and not verifiably safe. A disconnected backend needs no check."""
        if snap.get("connection") not in ("CONNECTED", "STALE", "CONNECTING"):
            return
        if (snap.get("transport") or {}).get("kind") == "wifi":
            raise ProvisioningError("USE_WIRELESS_NETWORK_CHANGE", "this board is connected over Wi-Fi; use Change Network instead of USB provisioning", 409)
        if snap.get("device_id") and snap.get("device_id") != device_id:
            raise ProvisioningError("IDENTITY_MISMATCH", f"the connected device is {snap.get('device_id')!r}, not {device_id!r}", 409)
        if snap.get("drive") != "IDLE":
            raise ProvisioningError("NOT_SAFE_STATE", "the motor drive is not confirmed idle; stop the motor before provisioning", 409)
        if snap.get("safety_state") == "EMERGENCY_STOP":
            raise ProvisioningError("NOT_SAFE_STATE", "a safety trip is latched; reset it before provisioning", 409)

    # ---- worker
    def _log(self, job: Dict[str, Any], secrets: Dict[str, Any], message: str) -> None:
        text = message.replace(secrets["password"], "********") if secrets.get("password") else message
        with self._mu:
            job["logs"] = (job["logs"] + [f"{time.strftime('%H:%M:%S')} {text}"])[-200:]
            job["updated_at"] = self.wall()

    def _set(self, job: Dict[str, Any], secrets: Dict[str, Any], state: str, detail: str) -> None:
        with self._mu:
            job["state"], job["progress"], job["detail"] = state, _PROGRESS[state], detail
        self._log(job, secrets, f"{state}: {detail}")
        self.history.put(self._public(job))

    def _deadline(self, job: Dict[str, Any], secrets: Dict[str, Any], label: str) -> None:
        """Checked BETWEEN steps only (never inside a flash call), so a timeout can never strand a half-finished write that we do not know about."""
        if self.clock() - secrets["t0"] > self.job_timeout_s:
            raise ProvisioningError("TIMEOUT", f"the provisioning run exceeded {int(self.job_timeout_s)} s before {label}", 409)

    def _on_phase(self, job: Dict[str, Any], secrets: Dict[str, Any], name: str, detail: str) -> None:
        if name == "WRITING_NVS":
            job["write_state"] = "writing"                  # from here on the board's configuration is uncertain until the read-back matches
        elif name == "NVS_VERIFIED":
            job["write_state"] = "verified"
            self._log(job, secrets, detail)
            return
        self._set(job, secrets, name, detail)

    def _run(self, job: Dict[str, Any], secrets: Dict[str, Any]) -> None:
        held = secrets["held"]
        ac = getattr(self.bridge, "autoconnect", None)
        paused = False
        flash = None
        try:
            if ac is not None and hasattr(ac, "pause"):
                ac.pause()
                paused = True
            self._set(job, secrets, "RELEASING_PORT", "closing the backend's serial connection so the flasher can own the port")
            self.bridge.disconnect("wifi provisioning")
            self._deadline(job, secrets, "reading the board")

            flash = self.flash_factory(job["port"])
            result = write_network_config(
                flash, device_id=job["device_id"], keystore=getattr(self.bridge, "keystore", None), ssid=job["ssid"], password=secrets["password"],
                base_url=job["base_url"], ca_pem=secrets["ca"], stage_capable=secrets["stage_capable"], trial_s=int(self.wireless_timeout_s) + 15,
                rotate_key=secrets["rotate"], erase_damaged=secrets["erase_damaged"], phase=lambda n, d: self._on_phase(job, secrets, n, d))
            job.update({"chip": result["chip"], "identity": result["identity"], "staged": result["staged"], "stage_note": result["stage_note"]})
            job["checks"].update({"existing_entries": result["existing_entries"], "nvs_verified": True})
            if result["rebuilt"]:
                job["checks"]["nvs_rebuilt"] = True
                self._log(job, secrets, "the damaged NVS partition was rebuilt from scratch (unreadable saved settings were not recoverable)")
            self._log(job, secrets, f"NVS merge: {result['existing_entries']} existing entries kept; identity {result['identity']}; "
                                    f"{'staged (previous network kept)' if result['staged'] else 'direct write: ' + result['stage_note']}")

            self._set(job, secrets, "RESTARTING", "restarting the board so it loads the new network configuration")
            flash.reset()
            flash.close()
            flash = None
            self._deadline(job, secrets, "reconnecting")

            self._set(job, secrets, "RECONNECTING", "reconnecting over USB and waiting for the authenticated handshake")
            self._reconnect(job["port"], secrets, job)
            self._set(job, secrets, "VERIFYING_DEVICE", "checking device identity, session and fresh telemetry")
            self._verify_device(job, secrets)
            self.history.clear_quarantine()
            self.lock.clear_quarantine()                    # a verified USB provisioning re-established a known state

            # USB pairing verified; release the lock before the optional wireless wait (unplugging the cable must not block other work).
            held.release()
            job["wait_until"] = self.wall() + self.wireless_timeout_s
            self._set(job, secrets, "WIRELESS_WAIT", "USB pairing verified. Keep USB connected: waiting for the board's Wi-Fi link to be verified before you unplug")
            if self._wait_wireless(job, secrets):
                if job["staged"]:
                    self._set(job, secrets, "COMMITTING", "paired and telemetry is fresh; committing the new network on the board")
                    self.verifier.commit(job["device_id"], job["ssid"], job["requested_by"])
                job["wireless"] = True
                self._set(job, secrets, "PAIRED_WIRELESS", "wireless link verified with the same device identity" + ("; the new network is now permanent" if job["staged"] else ""))
            else:
                prev = f" It will return to {job['previous_ssid']!r} by itself." if job["staged"] and job["previous_ssid"] else ""
                self._set(job, secrets, "WIRELESS_PENDING", "USB pairing is verified, but the wireless link was not seen in time." + prev)
                job["recovery"] = self._wireless_recovery(job)
        except ProvisioningError as exc:
            self._fail(job, secrets, exc.code, exc.message)
        except Exception as exc:                                             # noqa: BLE001
            self._fail(job, secrets, "UNEXPECTED", f"{type(exc).__name__}: {exc}")
        finally:
            if flash is not None:
                try:
                    flash.close()
                except Exception:                                            # noqa: BLE001
                    pass
            if job.get("write_state") == "writing":
                # A write was started and never verified: the configuration is uncertain. Do NOT simply release the lock.
                job["unknown_device_state"] = True
                reason = "a Wi-Fi configuration write was not verified; the board's stored network settings are uncertain"
                self.lock.quarantine(reason, job["id"])
                self.history.set_quarantine(reason, job["id"])
            held.release()
            self._restore_usb(job, secrets)
            if paused and ac is not None:
                try:
                    ac.resume()
                except Exception:                                            # noqa: BLE001
                    pass
            self.history.put(self._public(job))

    def _wireless_recovery(self, job: Dict[str, Any]) -> List[str]:
        steps = ["Confirm the Wi-Fi name and password (2.4 GHz only).", "Confirm this laptop's address still matches the backend address and the HTTPS gateway is running."]
        if job["staged"]:
            steps.append("No action is needed for the old network: the board restores it after the trial. Reconnect the USB cable and run Configure & Connect again to retry.")
        else:
            steps.append("Power-cycle the board with USB unplugged; if it still does not join, provision it again over USB.")
        return steps

    def _restore_usb(self, job: Dict[str, Any], secrets: Dict[str, Any]) -> None:
        """USB connection recovery: if the backend owned the port before this job and nothing owns it now, take it back (best effort, bounded)."""
        port = secrets.get("reconnect_port")
        if not port or getattr(self.bridge, "connected", False):
            return
        from torqva.device.transport import SerialTransport
        deadline = self.clock() + 15.0
        while self.clock() < deadline:
            try:
                self.bridge.connect(SerialTransport(port))
                self._log(job, secrets, f"USB connection to {port} restored")
                return
            except Exception:                                                # noqa: BLE001
                self.sleep(1.0)
        self._log(job, secrets, f"could not reopen {port}; use Reconnect once the board is back")

    def _device_snapshot_ready(self, job: Dict[str, Any]) -> Tuple[bool, str]:
        snap = self.bridge.snapshot()
        session = (snap.get("session") or {}).get("active")
        if snap.get("handshake") and session and snap.get("device_id") == job["device_id"]:
            return True, ""
        if snap.get("device_id") not in (None, job["device_id"]):
            raise ProvisioningError("IDENTITY_MISMATCH", f"the board identifies as {snap.get('device_id')!r}, not {job['device_id']!r}", 409)
        return False, "waiting for the authenticated handshake"

    def _reconnect(self, port: str, secrets: Dict[str, Any], job: Dict[str, Any]) -> None:
        from torqva.device.transport import SerialTransport, TransportError

        deadline = self.clock() + self.phase_timeout_s
        last = ""
        while True:
            try:
                self.bridge.connect(SerialTransport(port))
                return
            except (TransportError, RuntimeError, OSError) as exc:
                last = str(exc)
            if self.clock() >= deadline:
                raise ProvisioningError("RESTART_FAILED", f"the board did not reappear on {port} after restart ({last or 'no response'}). The NVS write was verified; check the board, then retry USB recovery", 409)
            self.sleep(1.0)

    def _verify_device(self, job: Dict[str, Any], secrets: Dict[str, Any]) -> None:
        ok, why = self.verifier.wait(lambda: self._device_snapshot_ready(job), self.phase_timeout_s)
        if not ok:
            raise ProvisioningError("AUTH_FAILED", "the board did not complete the authenticated handshake with the reused device key. Check the key store and provision again", 409)
        job["checks"]["authenticated_session"] = True
        ok, why = self.verifier.wait(lambda: (bool(self.bridge.snapshot().get("telemetry_fresh")), "telemetry is not fresh"), self.phase_timeout_s, 0.5)
        if not ok:
            raise ProvisioningError("TELEMETRY_STALE", "the board is authenticated but telemetry is not fresh", 409)
        job["checks"]["telemetry_fresh"] = True
        self._log(job, secrets, f"verified device {job['device_id']} over USB")

    def _standby_ready(self) -> bool:
        return bool(((self.bridge.snapshot().get("readiness") or {}).get("wifi_standby") or {}).get("ready"))

    def _wait_wireless(self, job: Dict[str, Any], secrets: Dict[str, Any]) -> bool:
        since_wall = self.wall()
        wireless = lambda: self.verifier.wireless_ok(job["device_id"], job["ssid"], since_wall - 5.0)
        # Phase 1, USB still plugged in: the board's Wi-Fi link arrives as a STANDBY link (USB keeps the session). Only once it is live, from the board's own
        # address, is the user told to unplug, so the cable is never pulled before Wi-Fi is known to work.
        ok, why = self.verifier.wait(lambda: (True, "") if (wireless()[0] or self._standby_ready()) else (False, "waiting for the board's Wi-Fi link"),
                                     self.wireless_timeout_s, 2.0)
        if ok and not wireless()[0]:
            job["checks"]["wifi_standby"] = True
            job["wait_until"] = self.wall() + self.wireless_timeout_s
            self._set(job, secrets, "WIRELESS_WAIT", "Wi-Fi verified while USB is connected (standby link from this board). Unplug the USB cable now: "
                                                     "the board continues over Wi-Fi and authenticates there")
            ok, why = self.verifier.wait(wireless, self.wireless_timeout_s, 2.0)
        elif ok:
            ok, why = True, ""
        if not ok:
            self._log(job, secrets, f"wireless pairing not verified: {why}")
            return False
        job["checks"]["wireless_session"] = True
        job["checks"]["wireless_telemetry"] = True
        job["checks"].update(self.verifier.extra_checks(since_wall - 5.0))
        return True

    def _fail(self, job: Dict[str, Any], secrets: Dict[str, Any], code: str, message: str) -> None:
        with self._mu:
            job["state"], job["progress"], job["error_code"] = "FAILED", 100, code
            job["detail"] = message
            job["updated_at"] = self.wall()
        self._log(job, secrets, f"FAILED [{code}]: {message}")
        if not job["recovery"]:
            job["recovery"] = ["Keep the board on USB with motor power disconnected.", "Fix the reported problem, then run Configure & Connect again.",
                               "If the board is not responding, use USB recovery from the Firmware Manager."]
        self.history.put(self._public(job))

    def _stalled(self, public: Dict[str, Any]) -> Dict[str, Any]:
        out = dict(public)
        out["stalled"] = public.get("state") not in TERMINAL_STATES and (self.wall() - float(public.get("updated_at") or 0)) > self.stall_s
        return out

    def _public(self, job: Dict[str, Any]) -> Dict[str, Any]:
        with self._mu:
            pub = {k: (copy.deepcopy(v) if isinstance(v, (list, dict)) else v) for k, v in job.items() if k in PUBLIC_FIELDS}
        return self._stalled(pub)
