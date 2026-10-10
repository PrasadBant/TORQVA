"""Phase 15A: acknowledgement identity binding, quarantine depth, and 'simulation never becomes physical control' checks. No hardware, nothing flashed."""
import re
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from torqva.dispatch import CommandDispatcher
from torqva.schemas import ActionType, CommandStatus, Connection, DecisionVerdict, DeviceSafetyState, Mode, ProposalSource, ProposedAction, Role
from torqva.supervisor import SafetySupervisor, SupervisorContext, SupervisorLimits

ROOT = Path(__file__).resolve().parents[2]
LEGACY = ROOT / "esp32" / "firmware" / "smart_motor_monitor" / "smart_motor_monitor.ino"
MAIN = (ROOT / "esp32" / "torqva_fw" / "src" / "main.cpp").read_text()


def approved():
    sup = SafetySupervisor(SupervisorLimits(vib_rms_stop_g=2.0, max_rpm=3000.0))
    ctx = SupervisorContext(mode=Mode.SIMULATION, hardware_control_enabled=True, connection=Connection.CONNECTED, device_state=DeviceSafetyState.OK, telemetry_age_s=0.0,
                            sensors_valid=True, motor_running=True, current_setpoint_rpm=1800.0)
    d = sup.check(ProposedAction(action=ActionType.SET_SPEED, source=ProposalSource.HUMAN, role=Role.OPERATOR, params={"rpm": 1500.0}, human_approved=True), ctx)
    assert d.verdict == DecisionVerdict.ALLOW
    return d.approved


# ------------------------------------------------------------------------------------------------ acknowledgement binding
def test_acknowledgements_must_carry_the_expected_device_identity_when_one_is_required():
    d = CommandDispatcher(lambda s: None, "k", device_id="RIG-01")
    rec = d.dispatch(approved(), 0.0)
    for bad in ({"id": rec.id, "status": "ACCEPTED"},                        # no identity
                {"id": rec.id, "status": "ACCEPTED", "dev": "RIG-02"},        # another device
                {"id": rec.id, "status": "ACCEPTED", "dev": ""},
                {"id": rec.id, "status": "ACCEPTED", "dev": None},
                {"id": rec.id, "status": "COMPLETED", "dev": "rig-01"}):     # identity is case-sensitive
        assert d.on_ack(bad, 0.1) is None
    assert d.records[rec.id].status == CommandStatus.PENDING and d.rejected_acks == 5
    assert d.on_ack({"id": rec.id, "status": "ACCEPTED", "dev": "RIG-01"}, 0.2).status == CommandStatus.ACCEPTED


def test_an_ack_for_an_unknown_command_or_with_a_tampered_status_never_changes_state():
    d = CommandDispatcher(lambda s: None, "k", device_id="RIG-01")
    rec = d.dispatch(approved(), 0.0)
    assert d.on_ack({"id": rec.id + 99, "status": "COMPLETED", "dev": "RIG-01"}, 0.1) is None
    assert d.on_ack({"id": rec.id, "status": "TOTALLY_FINE", "dev": "RIG-01"}, 0.1).status == CommandStatus.PENDING


def test_a_duplicate_or_replayed_ack_is_idempotent_and_does_not_resurrect_a_finished_command():
    d = CommandDispatcher(lambda s: None, "k", device_id="RIG-01")
    rec = d.dispatch(approved(), 0.0)
    d.on_ack({"id": rec.id, "status": "ACCEPTED", "dev": "RIG-01"}, 0.1)
    d.on_ack({"id": rec.id, "status": "ACCEPTED", "dev": "RIG-01"}, 0.2)
    d.on_ack({"id": rec.id, "status": "COMPLETED", "dev": "RIG-01"}, 0.3)
    d.on_ack({"id": rec.id, "status": "ACCEPTED", "dev": "RIG-01"}, 0.4)
    assert rec.status == CommandStatus.COMPLETED and rec.history.count("ACCEPTED") == 1


def test_communication_loss_times_a_command_out_it_is_never_assumed_executed():
    sent = []
    d = CommandDispatcher(sent.append, "k", ack_timeout_s=1.0, max_resends=1, device_id="RIG-01")
    rec = d.dispatch(approved(), 0.0)
    for t in (1.1, 2.2, 3.3, 6.0):
        d.poll(t)
    assert rec.status in (CommandStatus.TIMEOUT, CommandStatus.EXPIRED) and not rec.counts_as_executed()


def test_simulation_dispatch_needs_no_device_identity():
    d = CommandDispatcher(lambda s: None, "k")                                 # simulation: identity not required, behaviour unchanged
    rec = d.dispatch(approved(), 0.0)
    assert d.on_ack({"id": rec.id, "status": "ACCEPTED"}, 0.1).status == CommandStatus.ACCEPTED


# ------------------------------------------------------------------------------------------------ simulation never becomes physical control
def test_no_backend_code_path_constructs_the_hardware_mode():
    for f in (ROOT / "backend" / "torqva").glob("*.py"):
        text = f.read_text()
        if f.name in ("schemas.py",) or "test" in f.name:
            continue
        if f.name == "serial_bridge.py":                                  # builds a HARDWARE-mode supervisor CONTEXT only, with hardware control hard-wired off
            t = f.read_text()
            assert "hardware_control_enabled=False" in t and "hardware_control_enabled=True" not in t
            continue
        assert "Mode.HARDWARE" not in text.replace("ctx.mode == Mode.HARDWARE", "").replace("mode == Mode.HARDWARE", ""), f.name
    assert "Mode.SIMULATION" in (ROOT / "backend" / "torqva" / "service.py").read_text()


def test_firmware_never_establishes_a_secure_session_because_no_secured_transport_is_implemented():
    code = chr(10).join(l.split("//")[0] for l in MAIN.splitlines())    # ignore comments
    assert "set_secure_session" not in code
    assert "cfg.relaxed_interlocks = false" in MAIN


def test_reset_reason_latches_a_fault_for_watchdog_brownout_and_panic_only():
    block = MAIN[MAIN.index("switch (esp_reset_reason())"):]
    block = block[:block.index("default: break;")]
    for r in ("ESP_RST_TASK_WDT", "ESP_RST_INT_WDT", "ESP_RST_WDT", "ESP_RST_BROWNOUT", "ESP_RST_PANIC"):
        assert r in block
    assert "latch_boot_fault(TripReason::RESET_FAULT)" in block
    for r in ("ESP_RST_POWERON", "ESP_RST_SW", "ESP_RST_USB"):
        assert r not in block


# ------------------------------------------------------------------------------------------------ legacy quarantine depth
def test_legacy_motor_on_stays_disabled_even_when_the_compile_override_is_defined():
    src = LEGACY.read_text()
    fn = src[src.index("void setMotorState(bool turnOn) {"):]
    gate = fn[:fn.index("pinMode(PIN_R_EN, OUTPUT);")]
    assert "#ifndef TORQVA_LEGACY_ENABLE_MOTOR" in gate and "return;" in gate and "REFUSED" in gate
    assert "TORQVA_LEGACY_ENABLE_MOTOR" not in "".join(p.read_text() for p in (ROOT / "esp32" / "torqva_fw").rglob("*.ini"))


def _preprocess(tmp_path, *defs):
    for h in re.findall(r"#include\s*[<\"]([^>\"]+)[>\"]", LEGACY.read_text()):         # empty stand-ins for the Arduino headers (preprocessing only, nothing is compiled)
        f = tmp_path / h; f.parent.mkdir(parents=True, exist_ok=True); f.write_text("")
    r = subprocess.run(["g++", "-E", "-P", "-x", "c++", "-I", str(tmp_path), *defs, str(LEGACY)], capture_output=True, text=True)
    return r.stdout


@pytest.mark.skipif(not shutil.which("g++"), reason="no host C++ preprocessor")
def test_with_only_the_compile_override_the_actuation_branch_is_preprocessed_out(tmp_path):
    out = _preprocess(tmp_path, "-DTORQVA_LEGACY_UNSAFE_ACKNOWLEDGED")
    assert "MOTOR_ON REFUSED" in out[out.index("void setMotorState(bool turnOn)"):][:900]
    both = _preprocess(tmp_path, "-DTORQVA_LEGACY_UNSAFE_ACKNOWLEDGED", "-DTORQVA_LEGACY_ENABLE_MOTOR")
    assert "MOTOR_ON REFUSED" not in both[both.index("void setMotorState(bool turnOn)"):][:900]


def test_hardware_pages_that_reuse_the_legacy_pin_map_say_it_is_not_a_verified_contract():
    for rel in ("docs/hardware.md", "docs/HARDWARE_WIRING.md"):
        assert "quarantined legacy sketch" in (ROOT / rel).read_text(), rel
