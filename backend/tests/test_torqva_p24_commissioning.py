"""Phase 24: the commissioning record. Human attestations need evidence, never override firmware interlocks, and never enable motion by themselves. No hardware is touched."""
import json
import sys
import time
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).parent.parent))

from torqva.api import create_router, install_error_handlers
from torqva.auth import TokenAuth
from torqva.commissioning import ENABLE_PHRASE, ITEMS, LIMITS_CONFIRM_PHRASE as CONFIRM, Commissioning, CommissioningError
from torqva.schemas import Role
from torqva.serial_bridge import CmdState, Conn, DeviceBridge, MemoryTransport
from torqva.service import SimulationService
from test_torqva_p16_serial import ENTRIES, H, status, wait

LIM = {"max_current_a": 3.0, "min_voltage_v": 18.0, "max_voltage_v": 24.0, "max_temp_c": 80.0, "max_rpm": 3000.0, "max_duty_pct": 40.0}
EV = "bench record 2026-10-11 signed by the owner"


def verify_all(c):
    for i, _ in ITEMS:
        c.set_item(i, "VERIFIED", EV, "olga")


def test_nothing_is_approved_by_default():
    c = Commissioning()
    assert c.limits is None and not c.physical_control_enabled() and all(v["status"] == "NOT VERIFIED" for v in c.items.values())


def test_evidence_is_required_and_values_are_validated():
    c = Commissioning()
    with pytest.raises(CommissioningError):
        c.set_item("estop", "VERIFIED", "ok", "olga")
    with pytest.raises(CommissioningError):
        c.set_item("nonsense", "VERIFIED", EV, "olga")
    for bad in (0, -1, float("nan"), float("inf"), True, "5", 10**9):
        with pytest.raises(CommissioningError):
            c.set_limits({**LIM, "max_current_a": bad}, EV, "olga", CONFIRM)
    with pytest.raises(CommissioningError):
        c.set_limits({k: v for k, v in LIM.items() if k != "max_rpm"}, EV, "olga", CONFIRM)


def test_enable_needs_every_item_the_limits_and_the_typed_phrase_and_any_regression_disables_it():
    c = Commissioning()
    with pytest.raises(CommissioningError):
        c.set_enable(True, ENABLE_PHRASE, "olga")
    verify_all(c); c.set_limits(LIM, EV, "olga", CONFIRM)
    with pytest.raises(CommissioningError):
        c.set_enable(True, "yes", "olga")
    c.set_enable(True, ENABLE_PHRASE, "olga")
    assert c.physical_control_enabled()
    c.set_item("estop", "BLOCKED", "switch found loose", "olga")
    assert not c.physical_control_enabled()
    c.set_item("estop", "VERIFIED", EV, "olga"); assert not c.physical_control_enabled()      # re-attesting does not silently re-enable
    c.set_enable(True, ENABLE_PHRASE, "olga"); c.set_limits({**LIM, "max_duty_pct": 50}, EV, "olga", CONFIRM)
    assert not c.physical_control_enabled()


def test_the_record_persists_and_a_damaged_or_tampered_file_never_approves_anything(tmp_path):
    p = tmp_path / "c.json"
    c = Commissioning(str(p)); verify_all(c); c.set_limits(LIM, EV, "olga", CONFIRM); c.set_enable(True, ENABLE_PHRASE, "olga")
    assert Commissioning(str(p)).physical_control_enabled()
    d = json.loads(p.read_text()); d["items"]["estop"]["status"] = "NOT VERIFIED"; p.write_text(json.dumps(d))
    assert not Commissioning(str(p)).physical_control_enabled()                                # stale enable does not survive an inconsistent record
    p.write_text("{not json"); c2 = Commissioning(str(p))
    assert c2.load_error and c2.limits is None and not c2.physical_control_enabled()
    d = {"items": {}, "limits": {**LIM, "max_rpm": "fast"}}; p.write_text(json.dumps(d)); assert Commissioning(str(p)).limits is None


def test_attestations_never_override_the_firmware_and_motion_stays_refused():
    b = DeviceBridge(); b.commissioning = Commissioning(); verify_all(b.commissioning); b.commissioning.set_limits(LIM, EV, "olga", CONFIRM); b.commissioning.set_enable(True, ENABLE_PHRASE, "olga")
    tr = MemoryTransport(); b.connect(tr); tr.feed(status(0, blk="ESTOP_INPUT_NOT_VERIFIED"))
    assert wait(lambda: b.model.conn == Conn.CONNECTED)
    il = {r["id"]: r for r in b.snapshot()["interlocks"]}
    assert il["commissioning"]["status"] == "VERIFIED" and il["wiring"]["status"] == "VERIFIED" and il["driver"]["status"] == "VERIFIED"
    assert il["estop"]["status"] == "NOT VERIFIED" and "does not enforce the monitoring input" in il["estop"]["detail"]          # attested, but the firmware cannot see it
    assert il["session"]["status"] == "BLOCKED" and il["supervisor"]["status"] == "BLOCKED"
    bl = b.snapshot()["control_blockers"]
    assert "PHYSICAL CONTROL DISABLED" not in bl and "SECURE DEVICE TRANSPORT NOT CONFIGURED" in bl
    for a, p in (("START", {"duty_pct": 20}), ("SET_SPEED", {"rpm": 1000})):
        assert b.request_command(a, p, "olga", Role.OPERATOR).state == CmdState.REJECTED
    assert tr.written == []
    b.disconnect()


@pytest.fixture()
def api():
    svc = SimulationService()
    app = FastAPI(); app.include_router(create_router(svc, TokenAuth(ENTRIES))); install_error_handlers(app)
    yield svc, TestClient(app, raise_server_exceptions=False)
    svc.bridge.disconnect()


def test_commissioning_routes_are_admin_only_validated_and_audited(api):
    svc, c = api
    assert c.get("/api/torqva/device/commissioning", headers=H("v")).json()["limits"] is None
    for who in ("v", "o"):
        assert c.post("/api/torqva/device/commissioning/items/estop", headers=H(who), json={"status": "VERIFIED", "evidence": EV}).status_code == 403
        assert c.put("/api/torqva/device/commissioning/limits", headers=H(who), json={**LIM, "evidence": EV, "confirm": CONFIRM}).status_code == 403
        assert c.post("/api/torqva/device/commissioning/enable", headers=H(who), json={"enabled": True, "confirm": ENABLE_PHRASE}).status_code == 403
    assert c.post("/api/torqva/device/commissioning/items/estop", headers=H("a"), json={"status": "VERIFIED", "evidence": "x"}).status_code == 422
    assert c.put("/api/torqva/device/commissioning/limits", headers=H("a"), json={**LIM, "max_rpm": 0, "evidence": EV, "confirm": CONFIRM}).status_code == 422
    assert c.post("/api/torqva/device/commissioning/enable", headers=H("a"), json={"enabled": True, "confirm": ENABLE_PHRASE}).status_code == 422
    for i, _ in ITEMS:
        assert c.post(f"/api/torqva/device/commissioning/items/{i}", headers=H("a"), json={"status": "VERIFIED", "evidence": EV}).status_code == 200
    assert c.put("/api/torqva/device/commissioning/limits", headers=H("a"), json={**LIM, "evidence": EV, "confirm": CONFIRM}).status_code == 200
    s = c.post("/api/torqva/device/commissioning/enable", headers=H("a"), json={"enabled": True, "confirm": ENABLE_PHRASE}).json()
    assert s["physical_control_enabled"] is True
    st = c.get("/api/torqva/device/status", headers=H("v")).json()
    assert st["physical_control_enabled"] is True and st["control_limits"]["max_duty_pct"] == 40.0
    assert "SECURE DEVICE TRANSPORT NOT CONFIGURED" in st["control_blockers"]                    # enabling the record does not enable motion


def test_an_absent_motor_supply_is_reported_as_such_and_blocks_motion():
    b = DeviceBridge(); tr = MemoryTransport(); b.connect(tr); tr.feed(status(0, blk="SUPPLY_NOT_PRESENT"))
    assert wait(lambda: b.model.conn == Conn.CONNECTED)
    assert "MOTOR SUPPLY NOT PRESENT (bus voltage below 1 V)" in b.snapshot()["control_blockers"]
    assert b.request_command("START", {"duty_pct": 10}, "olga", Role.ADMIN).state == CmdState.REJECTED and tr.written == []
    b.disconnect()


# ------------------------------------------------------------------------------------------ the lock is derived, not hard-wired (Phase 37)
def _cmds(tr):
    """Written command lines, excluding the periodic authenticated heartbeats."""
    return [json.loads(x) for x in tr.written if json.loads(x)["type"] != "HEARTBEAT"]


def _ready_bridge(commissioned=True, session=True, blk="", mode="HW", state="OK", cfg=1):
    b = DeviceBridge()
    c = Commissioning()
    if commissioned:
        verify_all(c); c.set_limits(LIM, EV, "olga", CONFIRM); c.set_enable(True, ENABLE_PHRASE, "olga")
    b.commissioning = c
    tr = MemoryTransport(); b.connect(tr)
    tr.feed(json.dumps({**json.loads(status(0, mode=mode, blk=blk, state=state, reason="NONE" if state == "OK" else "OVER_CURRENT_INSTANT", fm=0 if state == "OK" else 1)), "cfg": cfg, "ctl": 1}))
    from test_torqva_p16_serial import fast, slow
    tr.feed(fast(1)); tr.feed(slow(2))
    assert wait(lambda: b.model.conn == Conn.CONNECTED and b.model.values.get("housing") and b.model.values.get("rpm"))
    if session:
        b._auth = {"state": "active", "sid": "a" * 16, "sk": b"k" * 32, "expires": b._clock() + 300, "restarts": 0, "dev": "RIG-1"}
    return b, tr


def test_with_every_genuine_prerequisite_met_start_and_speed_travel_the_authorised_path_as_mac_bound_commands():
    b, tr = _ready_bridge()
    assert b.control_blockers() == [], b.control_blockers()
    rec = b.request_command("START", {"duty_pct": 20}, "olga", Role.ADMIN)
    assert rec.state == CmdState.SENT, (rec.state, rec.reasons)
    sent = _cmds(tr)[-1]
    assert sent["type"] == "START" and sent["p"] == 20.0 and sent["sid"] == "a" * 16 and len(sent["m"]) == 32 and sent["k"] == ""
    assert b.request_command("SET_SPEED", {"rpm": 1500}, "olga", Role.ADMIN).state == CmdState.SENT
    over = b.request_command("START", {"duty_pct": 55}, "olga", Role.ADMIN)                    # above the approved 40 % ceiling
    assert over.state == CmdState.REJECTED and "duty_out_of_range" in over.reasons                  # the supervisor enforces the APPROVED ceiling (40 %), not a default
    b.disconnect()


@pytest.mark.parametrize("kw,expected", [({"commissioned": False}, "PHYSICAL CONTROL DISABLED"), ({"session": False}, "SECURE DEVICE TRANSPORT NOT CONFIGURED"),
                                         ({"blk": "ESTOP_INPUT_NOT_VERIFIED"}, "EMERGENCY STOP NOT VERIFIED"), ({"blk": "LIMITS_NOT_APPROVED"}, "SAFETY LIMITS NOT APPROVED"),
                                         ({"blk": "SUPPLY_NOT_PRESENT"}, "MOTOR SUPPLY NOT PRESENT"), ({"state": "EMERGENCY_STOP"}, "SAFETY FAULT LATCHED"), ({"mode": "SIM"}, "DEVICE IS NOT A PHYSICAL DEVICE")])
def test_each_missing_prerequisite_still_blocks_with_its_own_specific_reason_and_nothing_is_written(kw, expected):
    b, tr = _ready_bridge(**kw)
    bl = b.control_blockers()
    assert any(x.startswith(expected) for x in bl), bl
    sent_before = len(_cmds(tr))
    assert b.request_command("START", {"duty_pct": 20}, "olga", Role.ADMIN).state == CmdState.REJECTED
    assert len(_cmds(tr)) == sent_before
    b.disconnect()


def test_blockers_are_ordered_most_actionable_first_and_the_human_enable_decision_comes_last():
    b = DeviceBridge(); b.commissioning = Commissioning()
    bl = b.control_blockers()
    assert bl[0] == "DEVICE NOT CONNECTED" and bl[-1] == "PHYSICAL CONTROL DISABLED"


def test_approved_limits_block_motion_until_the_device_confirms_that_exact_version():
    b, tr = _ready_bridge(cfg=0)                                              # approved (version 1) but the device reports no configuration
    bl = b.control_blockers()
    assert any(x.startswith("APPROVED LIMITS NOT YET CONFIRMED BY THE DEVICE") for x in bl), bl
    il = {r["id"]: r for r in b.snapshot()["interlocks"]}
    assert il["limits"]["status"] == "BLOCKED" and "not confirmed" in il["limits"]["detail"]
    assert b.request_command("START", {"duty_pct": 20}, "olga", Role.ADMIN).state == CmdState.REJECTED
    b.disconnect()
    b2, tr2 = _ready_bridge(cfg=1)
    il = {r["id"]: r for r in b2.snapshot()["interlocks"]}
    assert il["limits"]["status"] == "VERIFIED" and b2.snapshot()["config"] == {"limits": LIM, "approved_version": 1, "device_version": 1, "confirmed": True, "last_push": None}
    b2.disconnect()


def test_limit_changes_need_the_confirmation_phrase_are_versioned_and_recorded_with_previous_and_new_values():
    c = Commissioning()
    with pytest.raises(CommissioningError):
        c.set_limits(LIM, EV, "olga")                                           # no confirmation
    with pytest.raises(CommissioningError):
        c.set_limits({**LIM, "min_voltage_v": 25.0, "max_voltage_v": 24.0}, EV, "olga", CONFIRM)
    for k, bad in (("max_current_a", 9.0), ("max_voltage_v", 30.0), ("max_temp_c", 200.0), ("max_rpm", 90000.0), ("max_duty_pct", 120.0)):
        with pytest.raises(CommissioningError):
            c.set_limits({**LIM, k: bad}, EV, "olga", CONFIRM)                  # above the sensor/measurement ceilings
    assert c.limits is None
    c.set_limits(LIM, EV, "olga", CONFIRM)
    assert c.limits["version"] == 1 and c.limits_history[-1]["previous"] is None
    c.set_limits({**LIM, "max_duty_pct": 30.0}, EV + " reduced", "adam", CONFIRM)
    h = c.limits_history[-1]
    assert c.limits["version"] == 2 and h["by"] == "adam" and h["previous"]["max_duty_pct"] == 40.0 and h["new"]["max_duty_pct"] == 30.0 and h["at"] > 0
    verify_all(c); c.set_enable(True, ENABLE_PHRASE, "olga")
    c.set_limits({**LIM, "max_duty_pct": 25.0}, EV, "olga", CONFIRM)
    assert not c.physical_control_enabled()                                      # a changed limit needs a fresh explicit enable


# ------------------------------------------------------------------------------------------ E-stop monitoring input and the authenticated-USB label (Phase 42)
def _status_with(**extra):
    return json.dumps({**json.loads(status(0, mode="HW", blk="ESTOP_INPUT_NOT_VERIFIED")), "cfg": 1, **extra})


def test_estop_input_state_is_reported_and_never_marks_the_circuit_verified():
    for es, text in ((0, "NOT MONITORED"), (1, "ASSERTED"), (2, "RELEASED"), (3, "UNKNOWN")):
        b = DeviceBridge(); b.commissioning = Commissioning(); verify_all(b.commissioning)         # even a human attestation does not make the firmware enforce it
        tr = MemoryTransport(); b.connect(tr); tr.feed(_status_with(es=es))
        assert wait(lambda: b.model.conn == Conn.CONNECTED)
        s = b.snapshot()
        assert s["estop_input"]["state"] == es and text in s["estop_input"]["label"] and "GPIO 15" in s["estop_input"]["pin"]
        row = {r["id"]: r for r in s["interlocks"]}["estop"]
        assert row["status"] in ("BLOCKED", "NOT VERIFIED") and row["status"] != "VERIFIED"
        assert any(x.startswith("EMERGENCY STOP NOT VERIFIED") for x in s["control_blockers"])
        b.disconnect()


def test_a_status_frame_without_the_es_field_defaults_to_not_monitored_and_bad_values_are_rejected():
    from torqva.serial_bridge import FrameError, parse_frame
    f = json.loads(status(0)); assert parse_frame(json.dumps(f))["es"] == 0
    for bad in (4, -1, "x", True):
        with pytest.raises(FrameError):
            parse_frame(json.dumps({**f, "es": bad}))


def test_the_transport_is_labelled_authenticated_usb_unencrypted_only_while_a_session_is_active():
    b, tr = _ready_bridge()
    s = b.snapshot()
    assert s["transport_label"] == "AUTHENTICATED USB - UNENCRYPTED" and "NOT encrypted" in s["usb_trust_boundary"] and "USB-over-IP" in s["usb_trust_boundary"]
    row = {r["id"]: r for r in s["interlocks"]}["session"]
    assert row["status"] == "VERIFIED" and "UNENCRYPTED" in row["detail"]
    b.disconnect()
    b2 = DeviceBridge(); s2 = b2.snapshot()
    assert s2["transport_label"] == "USB - NO AUTHENTICATED SESSION" and "motion commands are refused" in s2["usb_trust_boundary"]


# ------------------------------------------------------------------------------------------ dead-man heartbeat and the compiled-out control blocker (Phase 44)
def test_authenticated_heartbeats_are_sent_only_with_a_session_and_control_compiled_in_and_their_acks_are_not_command_results():
    b, tr = _ready_bridge()
    assert wait(lambda: any(json.loads(x)["type"] == "HEARTBEAT" for x in tr.written), 3)
    hb = [json.loads(x) for x in tr.written if json.loads(x)["type"] == "HEARTBEAT"][0]
    assert hb["sid"] == "a" * 16 and len(hb["m"]) == 32 and hb["k"] == "" and hb["ttl"] == 5000
    tr.feed(json.dumps({"t": "ack", "id": hb["id"], "status": "ACCEPTED", "reason": "OK", "dev": "RIG-1"}))
    time.sleep(0.3)
    assert b.model.counters["malformed"] == 0 and all(r.action != "HEARTBEAT" for r in b.commands.values())
    b.disconnect()
    b2, tr2 = _ready_bridge(session=False)                                        # no authenticated session: no heartbeat
    time.sleep(1.0)
    assert not any(json.loads(x)["type"] == "HEARTBEAT" for x in tr2.written)
    b2.disconnect()


def test_a_firmware_build_without_motor_control_is_reported_as_a_blocker_not_hidden():
    b = DeviceBridge(); tr = MemoryTransport(); b.connect(tr)
    tr.feed(json.dumps({**json.loads(status(0, mode="HW", blk="")), "ctl": 0, "cfg": 1}))
    assert wait(lambda: b.model.conn == Conn.CONNECTED)
    assert any(x.startswith("FIRMWARE BUILD HAS MOTOR CONTROL COMPILED OUT") for x in b.control_blockers())
    b.disconnect()
