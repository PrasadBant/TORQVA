"""Link admission: a board that redials from the same address replaces its dead (silent) link; a live link and any other address are still refused."""
import json
from types import SimpleNamespace

import pytest

from torqva.device.device_link import STANDBY, USB_HANDSHAKE_GRACE_S, DeviceLinkManager, WsTransport
from torqva.device.serial_bridge import link_diag_view
from torqva.device.wire_protocol import FrameError, parse_frame
from test_torqva_p16_serial import status


class FakeBridge:
    def __init__(self, kind, remote):
        self.connected = True
        self._transport = SimpleNamespace(kind=kind, remote=remote)
        self.model = SimpleNamespace(status={"ok": 1}, conn="CONNECTED", last_rx=0.0)
        self.now = 100.0
        self.autoconnect = None
        self.disconnected_with = None

    def _clock(self):
        return self.now

    def device_profile(self):
        return "production"

    def disconnect(self, why):
        self.disconnected_with = why
        self.connected = False


def mgr(kind, remote):
    b = FakeBridge(kind, remote)
    t = [100.0]

    def clock():
        t[0] += 10.0                                           # well apart: the per-address rate limit never interferes
        return t[0]
    return DeviceLinkManager(b, clock=clock), b


def test_same_address_redial_replaces_a_silent_wifi_link():
    m, b = mgr("wifi", "10.0.0.41")
    b.now, b.model.last_rx = 100.0, 95.0                       # the old link has said nothing for 5 s: its socket is dead
    ok, why = m.admit("10.0.0.41")
    assert ok and why == ""
    assert "same device address" in b.disconnected_with
    assert any(e["kind"] == "superseded" for e in m.history)


def test_a_live_link_is_never_displaced_even_by_the_same_address():
    m, b = mgr("wifi", "10.0.0.41")
    b.now, b.model.last_rx = 100.0, 99.8                       # frames are still arriving
    ok, why = m.admit("10.0.0.41")
    assert not ok and why.startswith("LINK_BUSY") and b.disconnected_with is None


def test_a_different_address_is_still_refused_while_a_wifi_link_is_active():
    m, b = mgr("wifi", "10.0.0.41")
    b.now, b.model.last_rx = 100.0, 95.0
    ok, why = m.admit("10.0.0.99")
    assert not ok and why.startswith("LINK_BUSY")
    assert b.disconnected_with is None and b.connected


def test_a_handshaken_usb_session_is_never_replaced_by_wifi_the_link_waits_as_standby():
    m, b = mgr("usb", None)
    ok, why = m.admit("10.0.0.41")
    assert ok and why == STANDBY
    assert b.disconnected_with is None and b.connected                 # USB stays the one authoritative transport
    assert any(e["kind"] == "standby" for e in m.history)


class FakeLoop:
    def is_closed(self):
        return False

    def call_soon_threadsafe(self, fn, *a):
        pass


def standby_link(m, remote):
    tr = WsTransport(FakeLoop(), remote)
    tr.mode = "standby"
    m.attached(tr)
    return tr


def test_only_one_standby_slot_and_the_same_address_may_redial_into_it():
    m, b = mgr("usb", None)
    first = standby_link(m, "10.0.0.41")
    ok, why = m.admit("10.0.0.99")
    assert not ok and why.startswith("LINK_BUSY")                      # a live standby from another address keeps the slot
    ok, why = m.admit("10.0.0.41")
    assert ok and why == STANDBY and m.standby is None                 # the same board redialled: its old standby link is closed
    assert first._closed.is_set()


def test_standby_is_promoted_only_when_the_usb_session_is_gone():
    m, b = mgr("usb", None)
    tr = standby_link(m, "10.0.0.41")
    connected = []
    b.connect = lambda t: connected.append(t)
    assert not m.try_promote(tr) and tr.mode == "standby"              # handshaken USB: no promotion
    b.connected = False
    assert m.try_promote(tr)
    assert connected == [tr] and tr.mode == "active" and m.active is tr and m.standby is None and m.promotions == 1
    assert any(e["kind"] == "handover" for e in m.history)


def test_standby_takes_over_from_a_usb_port_that_never_handshakes():
    m, b = mgr("usb", None)
    tr = standby_link(m, "10.0.0.41")
    b.connect = lambda t: None
    b.model.status, b.model.conn, b.model.connecting_since = None, "CONNECTING", b.now - USB_HANDSHAKE_GRACE_S - 1
    assert m.try_promote(tr)
    assert "no TORQVA handshake" in b.disconnected_with


def test_standby_feed_keeps_only_liveness_and_the_claimed_id():
    m, _ = mgr("usb", None)
    tr = standby_link(m, "10.0.0.41")
    tr.feed = None                                                     # would raise if anything were routed to the bridge
    m.standby_feed(tr, status(0, dev="RIG-1") + "\nnot json\n")
    assert tr.standby_dev == "RIG-1" and tr.standby_bad == 1


def test_link_events_are_recorded_as_json_lines(tmp_path):
    b = FakeBridge("usb", None)
    m = DeviceLinkManager(b, clock=lambda: 1000.0, log_path=tmp_path / "log.jsonl")
    m.admit("10.0.0.41")
    m.record("link_diag", {"avg_send_ms": 4, "updated_at": 1})
    rows = [json.loads(x) for x in (tmp_path / "log.jsonl").read_text().splitlines()]
    assert [r["kind"] for r in rows] == ["link_standby", "link_diag"]
    assert rows[1]["avg_send_ms"] == 4 and "updated_at" not in rows[1]


def test_link_diag_frame_is_validated_and_named():
    line = json.dumps({"t": "link_diag", "seq": 0, "ts": 5, "ps": 0, "nd": 1, "wdr": 200, "wdn": 2, "mh": 150000, "pq": 3, "tq": 9, "td": 4, "pd": 0, "rd": 0,
                       "fr": 120, "sa": 6, "sh": [100, 15, 4, 1, 0], "rx": 3, "cc": 4409, "lu": 61, "sl": 3000, "so": 1200})
    v = link_diag_view(parse_frame(line))
    assert v["power_save"] == "off" and v["tcp_nodelay_sockets"] == 1 and v["wifi_disconnect_reason"] == "beacon timeout (AP lost)"
    assert v["send_histogram"][">=1000 ms"] == 0 and v["send_histogram"]["<20 ms"] == 100 and v["last_close_code"] == 4409
    with pytest.raises(FrameError):
        parse_frame(line.replace("[100, 15, 4, 1, 0]", "[1, 2]"))


def test_standby_identity_is_trusted_only_after_a_keyed_proof_of_our_own_challenge():
    import hashlib, hmac as _h
    m, b = mgr("usb", None)
    key = bytes(range(32))
    b.keystore = SimpleNamespace(get=lambda dev: key if dev == "RIG-1" else None)
    tr = standby_link(m, "10.0.0.41")
    ch = json.loads(m.standby_challenge(tr, now=0.0))
    assert ch["t"] == "id_ch" and len(ch["cn"]) == 32
    assert m.standby_challenge(tr, now=1.0) is None                    # one open challenge at a time
    proof = lambda cn, dn, dev, k=key: _h.new(k, f"idp|{cn}|{dn}|{dev}".encode(), hashlib.sha256).hexdigest()
    dn = "ab" * 16
    m.standby_feed(tr, json.dumps({"t": "id_ok", "dn": dn, "proof": proof("00" * 16, dn, "RIG-1"), "dev": "RIG-1"}))   # answers someone else's challenge
    assert tr.id_verified_dev is None and tr.id_failures == 1
    m.standby_feed(tr, json.dumps({"t": "id_ok", "dn": dn, "proof": proof(ch["cn"], dn, "RIG-1"), "dev": "RIG-1"}))     # challenge already consumed
    assert tr.id_verified_dev is None
    ch = json.loads(m.standby_challenge(tr, now=10.0))
    m.standby_feed(tr, json.dumps({"t": "id_ok", "dn": dn, "proof": proof(ch["cn"], dn, "RIG-1", bytes(32)), "dev": "RIG-1"}))   # wrong key
    assert tr.id_verified_dev is None
    ch = json.loads(m.standby_challenge(tr, now=20.0))
    m.standby_feed(tr, json.dumps({"t": "id_ok", "dn": dn, "proof": proof(ch["cn"], dn, "RIG-1"), "dev": "RIG-1"}))
    assert tr.id_verified_dev == "RIG-1" and m.status()["standby"]["authenticated"] is True
    assert any(e["kind"] == "standby_authenticated" for e in m.history)
