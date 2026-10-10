"""Phase 27: the authenticated USB session, backend side against the REAL C++ firmware core (fitl CLI): Python and C++ must independently derive the same proofs, session id and
command MACs. No serial port, no hardware. Key store tests use a temporary file."""
import hashlib
import hmac
import json
import sys
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from torqva.device_keys import KeyStore, KeyStoreError
from torqva.schemas import Role
from torqva.serial_bridge import CmdState, Conn, DeviceBridge, FrameError, MemoryTransport, parse_frame
from test_torqva_p16_serial import FITL, FitlTransport, wait

KEY = bytes(range(1, 33))
STATUS = {"t": "status", "seq": 0, "ts": 0, "fw": "3.0.0", "wiring": "W", "limits_v": 1, "state": "OK", "reason": "NONE", "mode": "HW", "drive": "IDLE", "ctl": 0,
          "hb_age": 4294967295, "test": 0, "proto": 1, "dev": "RIG-1", "blk": "NO_SECURE_SESSION", "fm": 0}


def keystore(tmp_path, dev="FITL-1", key=KEY):
    ks = KeyStore(str(tmp_path / "keys.json"))
    ks._keys[dev] = key.hex()
    return ks


def bridge_with_fitl(tmp_path, key=KEY):
    tr = FitlTransport("--strict", "--auth-key", KEY.hex())            # the firmware core always holds KEY; the bridge may hold a different one
    b = DeviceBridge(expected_device_id="FITL-1"); b.keystore = keystore(tmp_path, key=key); b.connect(tr)
    return b, tr


def pump(b, tr, cond, n=60):
    for _ in range(n):
        if cond():
            return True
        tr.advance(100); time.sleep(0.05)
    return cond()


# ------------------------------------------------------------------------------------------ key store and frames
def test_key_store_provisions_random_keys_refuses_factory_ids_and_never_overwrites(tmp_path):
    ks = KeyStore(str(tmp_path / "k.json"))
    for bad in ("", "UNPROVISIONED", "has space", "x" * 80):
        with pytest.raises(KeyStoreError):
            ks.provision(bad)
    k1 = ks.provision("RIG-1"); assert len(k1) == 32 and ks.get("RIG-1") == k1
    with pytest.raises(KeyStoreError):
        ks.provision("RIG-1")
    k2 = ks.provision("RIG-1", rotate=True); assert k2 != k1
    assert KeyStore(str(tmp_path / "k.json")).get("RIG-1") == k2 and ks.get("OTHER") is None
    (tmp_path / "k.json").write_text("{broken"); bad = KeyStore(str(tmp_path / "k.json"))
    assert bad.load_error and bad.get("RIG-1") is None
    (tmp_path / "k.json").write_text(json.dumps({"keys": {"A": "zz", "UNPROVISIONED": "00" * 32}})); assert KeyStore(str(tmp_path / "k.json")).get("A") is None


def test_auth_frames_are_validated_strictly():
    assert parse_frame(json.dumps({"t": "auth_ok", "sid": "0123456789abcdef", "ttl": 1000}))["sid"] == "0123456789abcdef"
    for bad in ({"t": "auth_ok", "sid": "XYZ", "ttl": 1000}, {"t": "auth_ch", "dn": "ab", "proof": "cd"}, {"t": "auth_ok", "sid": "0123456789abcdef", "ttl": -1},
                {"t": "auth_err", "reason": "x" * 40}):
        with pytest.raises(FrameError):
            parse_frame(json.dumps(bad))


# ------------------------------------------------------------------------------------------ interoperability with the real C++ core
@pytest.mark.skipif(not FITL.exists(), reason="fitl CLI not built (pio run -e fitl)")
def test_python_and_the_firmware_core_agree_on_proofs_session_id_and_command_macs(tmp_path):
    b, tr = bridge_with_fitl(tmp_path)
    assert pump(b, tr, b.session_active), b._auth
    a = b._auth
    snap = b.snapshot()
    assert snap["session"]["active"] and {r["id"]: r["status"] for r in snap["interlocks"]}["session"] == "VERIFIED"
    assert "SECURE DEVICE TRANSPORT NOT CONFIGURED" not in snap["control_blockers"]

    def line(cid, seq, p, mac_p=None):
        canon = f"{cid}|START|{(mac_p if mac_p is not None else p):.3f}|0.000|0.000|5000|{seq}|0|{a['sid']}"
        m = hmac.new(a["sk"], canon.encode(), hashlib.sha256).hexdigest()[:32]
        return json.dumps({"id": cid, "type": "START", "p": p, "p2": 0, "p3": 0, "ttl": 5000, "age": 0, "seq": seq, "sid": a["sid"], "m": m})

    def acks_after(text):
        cid = json.loads(text)["id"]
        tr._io(text)                                                                      # the bridge's own heartbeats may interleave: select the acknowledgement of THIS command
        return [a for a in (json.loads(x) for x in list(tr._lines) if x.startswith('{"t":"ack"')) if a["id"] == cid]

    good = acks_after(line(5001, 900001, 20.0))
    assert good and good[0]["reason"] not in ("BAD_MAC", "NO_SECURE_SESSION", "WRONG_SESSION", "REPLAY"), good        # authentic: the interlocks decide, never the MAC
    assert acks_after(line(5002, 900002, 25.0, mac_p=20.0))[0]["reason"] == "BAD_MAC"                                  # tampered parameter
    assert acks_after(line(5003, 900001, 20.0))[0]["reason"] == "REPLAY"                                                # an old counter with a valid MAC
    rec = b.request_command("STOP", {}, "vera", Role.VIEWER)                                                           # the bridge's own STOP carries sid + m
    assert pump(b, tr, lambda: rec.state == CmdState.EXECUTED), (rec.state, rec.reasons)
    b.disconnect(); tr.close()


@pytest.mark.skipif(not FITL.exists(), reason="fitl CLI not built (pio run -e fitl)")
def test_a_wrong_key_never_produces_a_session_and_the_bridge_reports_why(tmp_path):
    b, tr = bridge_with_fitl(tmp_path, key=bytes(32 * [9]))
    assert pump(b, tr, lambda: b._auth.get("state") == "failed")
    assert not b.session_active() and "failed to prove" in b._auth["error"]
    assert any(x.startswith("NO AUTHENTICATED SESSION") for x in b.snapshot()["control_blockers"])
    b.disconnect(); tr.close()


def test_without_a_key_for_the_device_no_hello_is_ever_sent_and_the_old_blocker_remains():
    b = DeviceBridge(); tr = MemoryTransport(); b.connect(tr)
    tr.feed(json.dumps(STATUS))
    assert wait(lambda: b.model.conn == Conn.CONNECTED); time.sleep(0.5)
    assert tr.written == [] and "SECURE DEVICE TRANSPORT NOT CONFIGURED" in b.snapshot()["control_blockers"]
    b.disconnect()


def test_a_device_that_cannot_prove_the_key_or_sends_unsolicited_auth_frames_is_not_trusted(tmp_path):
    b = DeviceBridge(); b.keystore = keystore(tmp_path, dev="RIG-1"); tr = MemoryTransport(); b.connect(tr)
    tr.feed(json.dumps(STATUS))
    assert wait(lambda: len(tr.written) == 1 and json.loads(tr.written[0])["t"] == "hello")
    tr.feed(json.dumps({"t": "auth_ch", "dn": "0" * 32, "proof": "0" * 64}))                 # an impostor guesses
    assert wait(lambda: b._auth.get("state") == "failed") and not b.session_active()
    tr.feed(json.dumps({"t": "auth_ok", "sid": "0" * 16, "ttl": 1000}))                      # unsolicited success
    time.sleep(0.2)
    assert not b.session_active() and b.model.counters["malformed"] >= 1
    assert len(tr.written) == 1                                                              # no "auth" reply was ever sent to the impostor
    b.disconnect()


def test_a_disconnect_drops_the_session_and_nothing_is_replayed(tmp_path):
    b = DeviceBridge(); b.keystore = keystore(tmp_path, dev="RIG-1"); tr = MemoryTransport(); b.connect(tr)
    b._auth = {"state": "active", "sid": "a" * 16, "sk": b"k" * 32, "expires": b._clock() + 100, "restarts": 0, "dev": "RIG-1"}
    b.model.conn = Conn.CONNECTED
    assert b.session_active()
    b.disconnect()
    assert b._auth == {"state": "none"} and not b.session_active() and tr.written == []


# ------------------------------------------------------------------------------------------ runtime limits pushed over the authenticated session (real C++ core)
@pytest.mark.skipif(not FITL.exists(), reason="fitl CLI not built (pio run -e fitl)")
def test_approved_limits_are_pushed_authenticated_and_applied_by_the_real_firmware_core(tmp_path):
    from torqva.commissioning import Commissioning, LIMITS_CONFIRM_PHRASE
    c = Commissioning()
    tr = FitlTransport("--strict", "--auth-key", KEY.hex())
    b = DeviceBridge(expected_device_id="FITL-1"); b.keystore = keystore(tmp_path); b.commissioning = c; b.connect(tr)
    assert pump(b, tr, b.session_active), b._auth
    pump(b, tr, lambda: False, n=5)
    assert b.device_cfg_version() == 0 and b.snapshot()["start_blocked_reason"] == "LIMITS_NOT_APPROVED"            # nothing approved: nothing pushed, nothing defaulted
    c.set_limits({"max_current_a": 3.0, "min_voltage_v": 18.0, "max_voltage_v": 24.0, "max_temp_c": 60.0, "max_rpm": 3000.0, "max_duty_pct": 30.0}, "bench datasheet checked", "olga", LIMITS_CONFIRM_PHRASE)
    assert pump(b, tr, b.limits_confirmed, n=80), (b._cfg, b.model.status)                                           # pushed, MAC verified by the C++ core, applied, reported in status
    s = b.snapshot()
    assert s["config"]["confirmed"] and s["config"]["device_version"] == 1 and s["config"]["last_push"]["ack_ok"] is True
    assert s["start_blocked_reason"] != "LIMITS_NOT_APPROVED"                                                         # the firmware's limits gate is now satisfied by the authenticated configuration
    il = {r["id"]: r["status"] for r in s["interlocks"]}
    assert il["limits"] == "VERIFIED"
    # a new approval is a new version, pushed and confirmed the same way
    c.set_limits({"max_current_a": 2.5, "min_voltage_v": 18.0, "max_voltage_v": 24.0, "max_temp_c": 60.0, "max_rpm": 3000.0, "max_duty_pct": 30.0}, "reduced after test", "adam", LIMITS_CONFIRM_PHRASE)
    assert pump(b, tr, lambda: b.device_cfg_version() == 2 and b.limits_confirmed(), n=80)
    b.disconnect(); tr.close()


@pytest.mark.skipif(not FITL.exists(), reason="fitl CLI not built (pio run -e fitl)")
def test_a_device_that_refuses_the_configuration_keeps_motion_blocked_and_the_reason_is_shown(tmp_path):
    from torqva.commissioning import Commissioning, LIMITS_CONFIRM_PHRASE
    c = Commissioning(); c.set_limits({"max_current_a": 3.0, "min_voltage_v": 18.0, "max_voltage_v": 24.0, "max_temp_c": 60.0, "max_rpm": 3000.0, "max_duty_pct": 30.0}, "bench datasheet checked", "olga", LIMITS_CONFIRM_PHRASE)
    tr = FitlTransport("--strict", "--auth-key", KEY.hex())
    b = DeviceBridge(expected_device_id="FITL-1"); b.keystore = keystore(tmp_path); b.commissioning = c; b.connect(tr)
    assert pump(b, tr, b.session_active)
    assert pump(b, tr, b.limits_confirmed, n=80)
    c.limits["max_current_a"] = 99.0                                                                  # a corrupted record: the firmware's ceiling check must refuse it (version bumped to be pushed)
    c.limits["version"] = 2
    assert pump(b, tr, lambda: b._cfg.get("ack_ok") is False, n=80), b._cfg
    assert b._cfg["ack_reason"] == "CURRENT_OUT_OF_RANGE" and b.device_cfg_version() == 1 and not b.limits_confirmed()
    assert any("device refused: CURRENT_OUT_OF_RANGE" in x for x in b.snapshot()["control_blockers"])
    b.disconnect(); tr.close()
