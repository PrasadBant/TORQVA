"""Test doubles for Wi-Fi provisioning and network switching: an in-memory flash and a fake board that behaves like the firmware's network logic.

FakeBridge reads the NVS image that was actually written (parse_partition) after the simulated restart, applies the same rules as lib/torqva_core/communication/wifi_trial.h
(a staged network is TRIED for a bounded time and reverts unless committed; a boot loop abandons it), and exposes the snapshot / request / ack surface of DeviceBridge.
Time is a fake clock that only advances when the code under test sleeps, so every timeout path runs instantly and deterministically.
"""
from __future__ import annotations

import datetime
import struct
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID

from torqva.device.nvs import NVS_OFFSET, NVS_SIZE, parse_partition

PASSWORD = "Hunter2-Secret-Pass"
BASE = "https://192.168.1.50:8443"
DEVICE = "RIG-1"
MAX_BOOT_TRIES = 3


def make_pki(secrets_dir: Path, lan_ip: str = "192.168.1.50") -> str:
    tls = secrets_dir / "tls"
    tls.mkdir(parents=True, exist_ok=True)
    now = datetime.datetime.now(datetime.timezone.utc)
    ca_key = ec.generate_private_key(ec.SECP256R1())
    ca_name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Test CA")])
    ca = (x509.CertificateBuilder().subject_name(ca_name).issuer_name(ca_name).public_key(ca_key.public_key())
          .serial_number(x509.random_serial_number()).not_valid_before(now - datetime.timedelta(minutes=5))
          .not_valid_after(now + datetime.timedelta(days=30))
          .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
          .sign(ca_key, hashes.SHA256()))
    srv_key = ec.generate_private_key(ec.SECP256R1())
    import ipaddress
    gw = (x509.CertificateBuilder().subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, lan_ip)]))
          .issuer_name(ca.subject).public_key(srv_key.public_key()).serial_number(x509.random_serial_number())
          .not_valid_before(now - datetime.timedelta(minutes=5)).not_valid_after(now + datetime.timedelta(days=10))
          .add_extension(x509.SubjectAlternativeName([x509.DNSName(lan_ip), x509.IPAddress(ipaddress.IPv4Address(lan_ip))]), critical=False)
          .sign(ca_key, hashes.SHA256()))
    ca_pem = ca.public_bytes(serialization.Encoding.PEM).decode("ascii")
    (tls / "bench_ca.pem").write_text(ca_pem, encoding="ascii")
    (tls / "gateway_cert.pem").write_bytes(gw.public_bytes(serialization.Encoding.PEM))
    (tls / "bench_ca_key.pem").write_bytes(ca_key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    return ca_pem


def partition_table() -> bytes:
    entries = [(0x01, 0x02, 0x9000, 0x5000, b"nvs"), (0x01, 0x03, 0xE000, 0x2000, b"otadata"), (0x00, 0x10, 0x10000, 0x330000, b"app0")]
    out = b""
    for ptype, sub, off, size, name in entries:
        out += struct.pack("<HBBII", 0x50AA, ptype, sub, off, size) + name.ljust(16, b"\0") + struct.pack("<I", 0)
    return out.ljust(0xC00, b"\xff")


class Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t

    def sleep(self, s):
        self.t += s


class FakeFlash:
    """In-memory flash. Records every write so tests can prove only the NVS region changed."""

    def __init__(self, flash: bytearray, fail_readback: bool = False, chip: str = "ESP32-S3", explode_on_write: bool = False):
        self.flash, self.chip, self.fail_readback, self.explode_on_write = flash, chip, fail_readback, explode_on_write
        self.writes, self.resets, self.closed, self.rebooted = [], 0, False, False

    def open(self):
        return self.chip

    def read(self, offset, size):
        return bytes(self.flash[offset:offset + size])

    def write(self, offset, data):
        self.writes.append((offset, len(data)))
        if self.explode_on_write:
            self.flash[offset:offset + 64] = b"\x00" * 64                  # a write that died half way
            raise OSError("serial port vanished during the write")
        self.flash[offset:offset + len(data)] = data
        if self.fail_readback:
            self.flash[offset + 100] ^= 0x5A

    def reset(self):
        self.resets += 1
        self.rebooted = True

    def close(self):
        self.closed = True


class FakeBridge:
    """DeviceBridge stand-in with a simulated board. See the module docstring."""

    def __init__(self, keystore, clock: Clock, *, flash: Optional[FakeFlash] = None, networks: Optional[Dict[str, Dict[str, Any]]] = None,
                 supports_staging: bool = True, committed: Tuple[str, str] = ("HomeNet", "password1"), usb_unplug_after: Optional[float] = None,
                 connect_failures: int = 0, device_id: str = DEVICE, join_delay_s: float = 6.0, start_on: Optional[str] = None):
        class _AC:
            def __init__(s):
                s.paused = 0

            def pause(s):
                s.paused += 1

            def resume(s):
                s.paused -= 1
        self.autoconnect = _AC()
        self.keystore, self.clock, self.flash = keystore, clock, flash
        self.networks = networks if networks is not None else {"HomeNet": {"password": "password1", "gateway_ok": True}, "OtherNet": {"password": "otherpass1", "gateway_ok": True}}
        self.supports_staging, self.device_id, self.join_delay_s = supports_staging, device_id, join_delay_s
        self.usb_unplug_after, self.connect_failures = usb_unplug_after, connect_failures
        self.committed_ssid, self.committed_pass = committed
        self.trial = False
        self.trial_ssid = self.trial_pass = ""
        self.trial_end = 0.0
        self.usb_attached = False
        self.unplug_at: Optional[float] = None
        self.joined_at = 0.0
        self.link_since = 0.0
        self._last_link: Optional[str] = None
        self.sys_acks: Dict[int, Dict[str, str]] = {}
        self._next = 100
        self.disconnects = 0
        self.drive = "IDLE"
        self.scan_networks = [{"ssid": "HomeNet", "rssi": -48, "channel": 6, "security": "WPA2", "frequency_mhz": 2437, "band": "2.4 GHz"},
                              {"ssid": "OtherNet", "rssi": -71, "channel": 11, "security": "WPA2/WPA3", "frequency_mhz": 2462, "band": "2.4 GHz"}]
        self.scan_fail: Optional[str] = None
        self.scan_calls = 0
        self.stage_calls = []
        self.commit_calls = 0
        self.stage_reject: Optional[str] = None
        self.last_net: Optional[Dict[str, Any]] = None
        # Where the board starts: no link at all (the usual USB-provisioning start), already on its committed Wi-Fi network, or on USB.
        self.joined_at = 0.0 if start_on == "wifi" else float("inf")
        self.usb_attached = start_on == "usb"
        self.link_since = clock() - 100

    # ---- board behaviour
    def _wall(self) -> float:
        return self.clock()

    def _can_join(self, ssid: str, password: str) -> bool:
        net = self.networks.get(ssid)
        return bool(net) and net["password"] == password

    def _boot_from_flash(self) -> None:
        """What the firmware does at boot, using the NVS image that was really written."""
        entries = parse_partition(bytes(self.flash.flash[NVS_OFFSET:NVS_OFFSET + NVS_SIZE]))
        g = lambda k: (entries.get(("torqva_ota", k)).value if entries.get(("torqva_ota", k)) else "")
        self.committed_ssid, self.committed_pass = g("ssid"), g("pass")
        self.trial = False
        if g("n_ssid"):
            tries = int(g("n_try") or 0)
            if tries < MAX_BOOT_TRIES:
                self.trial, self.trial_ssid, self.trial_pass = True, g("n_ssid"), g("n_pass")
                self.trial_end = self.clock() + float(g("n_tr") or 300)
        self.authkey = (entries.get(("torqva", "authkey")).value if entries.get(("torqva", "authkey")) else "")
        self.nvs_entries = entries

    def _effective(self) -> Tuple[str, str]:
        return (self.trial_ssid, self.trial_pass) if self.trial else (self.committed_ssid, self.committed_pass)

    def _advance(self) -> None:
        now = self.clock()
        if self.usb_attached and self.unplug_at is not None and now >= self.unplug_at:
            self.usb_attached = False
            self.joined_at = now + 3.0
        if self.trial and now >= self.trial_end:                        # the trial ended without a commit: the previous network is used again
            self.trial = False
            self.joined_at = now + 3.0

    def _link(self) -> Optional[str]:
        self._advance()
        if self.usb_attached:
            return "usb"
        ssid, pw = self._effective()
        if self.clock() >= self.joined_at and self._can_join(ssid, pw) and self.networks[ssid].get("gateway_ok", True):
            return "wifi"
        return None

    # ---- DeviceBridge surface
    @property
    def connected(self) -> bool:
        return self._link() is not None

    def disconnect(self, reason="requested"):
        self.disconnects += 1
        self.usb_attached = False

    def connect(self, transport):
        if self.connect_failures > 0:
            self.connect_failures -= 1
            raise RuntimeError("no device on port")
        if self.flash is not None and self.flash.rebooted:
            self.flash.rebooted = False
            self._boot_from_flash()
            if self.usb_unplug_after is not None:
                self.unplug_at = self.clock() + self.usb_unplug_after
        self.usb_attached = True

    def snapshot(self) -> Dict[str, Any]:
        kind = self._link()
        if kind != self._last_link:
            self._last_link, self.link_since = kind, self.clock()
        snap: Dict[str, Any] = {"connection": "CONNECTED" if kind else "DISCONNECTED", "transport": None, "handshake": bool(kind), "device_id": self.device_id if kind else None,
                                "session": {"active": bool(kind)}, "telemetry_fresh": bool(kind), "drive": self.drive if kind else None, "safety_state": "OK" if kind else None,
                                "ota": {"cap": 1, "why": ""} if kind else None, "net_info": self.last_net, "wifi_state": None}
        if kind == "usb":
            snap["transport"] = {"kind": "usb", "port": "COM7"}
        elif kind == "wifi":
            snap["transport"] = {"kind": "wifi", "remote": "192.168.1.77"}
            ssid, _ = self._effective()
            self.last_net = {"ssid": ssid, "rssi": -55, "ip": "192.168.1.77", "updated_at": self._wall()}
            snap["net_info"] = self.last_net
        if kind and self.supports_staging:
            left = max(0, int(self.trial_end - self.clock())) if self.trial else 0
            snap["wifi_state"] = {"supported": True, "trial": self.trial, "left_s": left, "active_ssid": self.committed_ssid, "age_s": 0.5}
        return snap

    def _ack(self, status: str, reason: str = "OK") -> int:
        self._next += 1
        self.sys_acks[self._next] = {"status": status, "reason": reason}
        return self._next

    def sys_ack(self, cid):
        return self.sys_acks.get(cid)

    def request_wifi_stage(self, ssid, password, base_url, trial_s, user, role):
        self.stage_calls.append({"ssid": ssid, "base_url": base_url, "trial_s": trial_s})
        if self._link() is None:
            return False, "device not connected", None
        if self.stage_reject:
            return True, "", self._ack("REJECTED", self.stage_reject)
        if not self.supports_staging:
            return True, "", self._ack("REJECTED", "WIFI_STAGE_UNSUPPORTED")
        self.trial, self.trial_ssid, self.trial_pass = True, ssid, password
        self.trial_end = self.clock() + float(trial_s or 120)
        self.joined_at = self.clock() + self.join_delay_s
        return True, "", self._ack("ACCEPTED")

    def request_wifi_commit(self, user, role):
        self.commit_calls += 1
        if self._link() is None:
            return False, "device not connected", None
        if self.trial and self._link() == "wifi":
            self.committed_ssid, self.committed_pass, self.trial = self.trial_ssid, self.trial_pass, False
            return True, "", self._ack("ACCEPTED")
        return True, "", self._ack("REJECTED", "NO_TRIAL")

    def request_wifi_scan(self, user, role):
        self.scan_calls += 1
        if self._link() is None:
            return False, "device not connected", None
        return True, "", self._ack("ACCEPTED")

    def wifi_scan_result(self):
        if self.scan_fail:
            return {"state": "failed", "why": self.scan_fail, "networks": [], "started_at": 1.0, "finished_at": 2.0}
        return {"state": "done", "why": "", "networks": [dict(n) for n in self.scan_networks], "started_at": 1.0, "finished_at": 2.0}

    def console_seen(self, kind, since):
        link = self._link()
        return link == kind and self.clock() - self.link_since >= 1.0
