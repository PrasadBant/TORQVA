"""Wi-Fi device link (torqva/device_link.py, /api/torqva/device/link): the device protocol runs unchanged over a WebSocket. A Python stand-in plays the
device side of the existing mutual challenge-response (the same proofs the firmware core computes; tests/test_torqva_p27_auth_session.py checks Python
and C++ agree). No network, no hardware: FastAPI's TestClient."""
import hashlib
import hmac
import json
import secrets
import sys
import time
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

sys.path.insert(0, str(Path(__file__).parent.parent))

from torqva import device_link as dl
from torqva.api import create_router, install_error_handlers
from torqva.auth import TokenAuth
from torqva.device_keys import KeyStore
from torqva.schemas import Role
from torqva.serial_bridge import Conn, MemoryTransport
from torqva.service import SimulationService
from test_torqva_p16_serial import ENTRIES, status, wait

KEY = bytes(range(7, 39))
LINK = "/api/torqva/device/link"


@pytest.fixture
def app(tmp_path, monkeypatch):
    monkeypatch.setenv("TORQVA_DEVICE_LINK", "1")
    svc = SimulationService()
    ks = KeyStore(str(tmp_path / "keys.json")); ks._keys["RIG-1"] = KEY.hex()
    svc.bridge.keystore = ks
    a = FastAPI(); a.include_router(create_router(svc, TokenAuth(ENTRIES))); install_error_handlers(a)
    yield svc, TestClient(a)
    if svc.bridge.connected:
        svc.bridge.disconnect("test end")


class WsDevice:
    """The device side of protocol 1 over the link: status frames with a gapless seq, and the device half of the handshake."""

    def __init__(self, ws, key=KEY, dev="RIG-1"):
        self.ws, self.key, self.dev, self.seq = ws, key, dev, 0

    def frame(self, line):
        self.ws.send_text(line)

    def boot(self, prof="ota_led_bench"):
        self.frame(status(self.seq, dev=self.dev, blk="NO_SECURE_SESSION")); self.seq += 1
        self.frame(json.dumps({"t": "ota_info", "seq": self.seq, "ts": 100, "cap": 1, "why": "", "run": "ota_0", "psz": 3342336, "pend": 0, "last": "", "lver": "",
                               "blk": "", "busy": 0, **({"prof": prof} if prof else {})})); self.seq += 1

    def recv(self, t):
        for _ in range(50):
            m = json.loads(self.ws.receive_text())
            if m.get("t") == t:
                return m
        raise AssertionError(f"no {t}")

    def handshake(self):
        cn = self.recv("hello")["cn"]
        dn = secrets.token_hex(16)
        self.frame(json.dumps({"t": "auth_ch", "dn": dn, "proof": hmac.new(self.key, f"dev|{cn}|{dn}|{self.dev}".encode(), hashlib.sha256).hexdigest()}))
        a = self.recv("auth")
        good = hmac.compare_digest(a["proof"], hmac.new(self.key, f"cli|{dn}|{cn}|{self.dev}|{a['ttl']}".encode(), hashlib.sha256).hexdigest())
        if good:                                                  # the device only answers a backend that proved the key
            self.frame(json.dumps({"t": "auth_ok", "sid": hmac.new(self.key, f"sid|{cn}|{dn}".encode(), hashlib.sha256).hexdigest()[:16], "ttl": a["ttl"]}))
        return good


def closed_code(ws):
    try:
        for _ in range(100):
            ws.receive_text()
    except WebSocketDisconnect as e:
        return e.code
    return None


def refusal(c):
    """The close code of a link refused before or right after it was accepted."""
    try:
        with c.websocket_connect(LINK) as ws:
            return closed_code(ws)
    except WebSocketDisconnect as e:
        return e.code


def test_the_link_is_off_unless_enabled(app, monkeypatch):
    _, c = app
    monkeypatch.setenv("TORQVA_DEVICE_LINK", "0")
    assert refusal(c) == 4404


def test_a_device_authenticates_over_wifi_with_the_existing_mutual_handshake_and_disconnects_cleanly(app):
    svc, c = app
    b = svc.bridge
    with c.websocket_connect(LINK) as ws:
        d = WsDevice(ws); d.boot()
        assert d.handshake()                                                      # the backend proved the key to the device
        assert wait(lambda: b.session_active())
        snap = b.snapshot()
        assert snap["transport"]["kind"] == "wifi" and snap["connection"] == "CONNECTED" and snap["device_profile"] == "ota_led_bench"
        assert snap["wifi_link"]["active"] and snap["session"]["active"]
        rec = b.request_command("START", {"duty_pct": 10}, "adam", Role.ADMIN)          # the bench profile is refused over Wi-Fi too
        assert rec.state.value == "REJECTED" and any("OTA LED BENCH DEVICE" in r for r in rec.reasons)
    assert wait(lambda: not b.connected)
    snap = b.snapshot()
    assert snap["transport"] is None and snap["connection"] == "DISCONNECTED" and not snap["session"]["active"]
    assert snap["wifi_link"]["active"] is False and snap["wifi_link"]["events"][-1]["kind"] == "disconnected"


def test_the_raw_key_is_never_sent_to_the_device(app):
    svc, c = app
    with c.websocket_connect(LINK) as ws:
        d = WsDevice(ws); d.boot()
        sent = []
        orig = d.recv

        def spy(t):
            m = orig(t); sent.append(json.dumps(m)); return m
        d.recv = spy
        assert d.handshake()
        assert all(KEY.hex() not in s for s in sent)


def test_a_device_with_the_wrong_key_never_gets_a_session_and_the_link_is_closed(app, monkeypatch):
    svc, c = app
    monkeypatch.setattr(dl, "LINK_AUTH_TIMEOUT_S", 1.5)
    with c.websocket_connect(LINK) as ws:
        d = WsDevice(ws, key=bytes(32 * [9])); d.boot()
        cn = d.recv("hello")["cn"]
        dn = "a" * 32
        d.frame(json.dumps({"t": "auth_ch", "dn": dn, "proof": hmac.new(d.key, f"dev|{cn}|{dn}|RIG-1".encode(), hashlib.sha256).hexdigest()}))
        assert closed_code(ws) == 1000
    assert not svc.bridge.session_active() and wait(lambda: not svc.bridge.connected)
    assert "no authenticated session" in svc.bridge.snapshot()["wifi_link"]["events"][-1]["reason"]


def test_a_second_link_is_refused_while_a_device_is_connected(app, monkeypatch):
    svc, c = app
    monkeypatch.setattr(dl, "LINK_MIN_INTERVAL_S", 0.0)
    with c.websocket_connect(LINK) as ws:
        d = WsDevice(ws); d.boot(); assert d.handshake()
        assert refusal(c) == 4409
        assert svc.bridge.session_active()                                         # the first device is undisturbed


def test_connection_attempts_are_rate_limited_per_address(app):
    svc, c = app
    with c.websocket_connect(LINK) as ws:
        ws.close()
    wait(lambda: not svc.bridge.connected)
    assert refusal(c) == 4409
    assert svc.bridge.snapshot()["wifi_link"]["events"][-1]["reason"] == "RATE_LIMITED"


def test_an_oversized_message_closes_the_link(app):
    svc, c = app
    with c.websocket_connect(LINK) as ws:
        ws.send_text("x" * (dl.LINK_MAX_MSG + 1))
        assert closed_code(ws) == 1000
    assert wait(lambda: not svc.bridge.connected)


def test_an_led_bench_device_on_usb_hands_over_to_its_wifi_link_but_a_production_device_is_not_displaced(app, monkeypatch):
    svc, c = app
    monkeypatch.setattr(dl, "LINK_MIN_INTERVAL_S", 0.0)
    b = svc.bridge
    for prof, expect_handover in (("", False), ("ota_led_bench", True)):
        usb = MemoryTransport(); usb.kind = "usb"
        b.connect(usb)
        usb.feed(status(0, blk="NO_SECURE_SESSION"))
        usb.feed(json.dumps({"t": "ota_info", "seq": 1, "ts": 1, "cap": 1, "why": "", "run": "ota_0", "psz": 1, "pend": 0, "last": "", "lver": "", "blk": "", "busy": 0,
                             **({"prof": prof} if prof else {})}))
        assert wait(lambda: b.model.conn == Conn.CONNECTED and b.ota_info is not None and b.device_profile() == prof)
        if expect_handover:
            with c.websocket_connect(LINK) as ws:
                d = WsDevice(ws); d.boot(); assert d.handshake()
                assert wait(lambda: b.session_active())
                assert b.snapshot()["transport"]["kind"] == "wifi" and b._transport is not usb
        else:
            assert refusal(c) == 4409
            assert b._transport is usb                                             # the production device keeps its USB session
            b.disconnect("next case")
        wait(lambda: not b.connected)


def test_a_replayed_or_gapped_sequence_over_wifi_is_counted_like_on_usb(app):
    svc, c = app
    b = svc.bridge
    with c.websocket_connect(LINK) as ws:
        d = WsDevice(ws); d.boot(); assert d.handshake()
        line = status(d.seq, blk="")
        d.frame(line); d.frame(line)                                               # duplicate
        d.frame(status(d.seq + 5, blk=""))                                         # gap
        assert wait(lambda: b.snapshot()["counters"]["duplicates"] >= 1 and b.snapshot()["counters"]["gaps"] >= 1)
