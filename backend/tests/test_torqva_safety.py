"""Safety Supervisor + dispatcher tests. These encode the master-prompt safety invariants."""
import json
import sys
from dataclasses import replace
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from torqva.dispatch import CommandDispatcher
from torqva.schemas import (
    ActionType, CommandStatus, Connection, DecisionVerdict, DeviceSafetyState, Mode,
    ProposalSource, ProposedAction, Role,
)
from torqva.supervisor import (
    ApprovedAction, SafetySupervisor, SupervisorContext, SupervisorLimits,
)

LIM = SupervisorLimits(vib_rms_stop_g=2.0, max_rpm=3000.0)


def ctx(**kw):
    base = dict(mode=Mode.SIMULATION, hardware_control_enabled=False, connection=Connection.CONNECTED,
                device_state=DeviceSafetyState.OK, telemetry_age_s=0.1, sensors_valid=True,
                motor_running=True, current_setpoint_rpm=1500.0, housing_c=30.0, current_a=1.0, voltage_v=24.0)
    base.update(kw)
    return SupervisorContext(**base)


def prop(action, source=ProposalSource.GATE, role=Role.OPERATOR, approved=False, **params):
    return ProposedAction(action=action, params=params, source=source, role=role, human_approved=approved)


sup = SafetySupervisor(LIM)


# ---- ApprovedAction can't be forged ----
def test_approved_action_cannot_be_constructed_directly():
    with pytest.raises(PermissionError):
        ApprovedAction(ActionType.START, {"duty_pct": 30}, ProposalSource.GATE, None, None, Mode.SIMULATION)


def test_dispatcher_rejects_unapproved_proposal():
    sent = []
    d = CommandDispatcher(sent.append, "k")
    with pytest.raises(PermissionError):
        d.dispatch(prop(ActionType.STOP), 0.0)     # raw ProposedAction, not supervisor-minted
    assert sent == []


# ---- STOP ----
def test_stop_always_allowed_even_when_everything_else_is_wrong():
    c = ctx(connection=Connection.DISCONNECTED, telemetry_age_s=99, sensors_valid=False,
            device_state=DeviceSafetyState.UNKNOWN)
    d = sup.check(prop(ActionType.STOP, role=Role.VIEWER, source=ProposalSource.HUMAN), c)
    assert d.verdict == DecisionVerdict.ALLOW and d.approved is not None


def test_stop_allowed_from_llm_source_too():
    # Making the system safer is never blocked, but the LLM can't originate anything else.
    d = sup.check(prop(ActionType.STOP, source=ProposalSource.LLM), ctx())
    assert d.verdict == DecisionVerdict.ALLOW


# ---- LLM / uncertainty ----
def test_llm_cannot_dispatch_anything_but_stop():
    for a, p in [(ActionType.START, {"duty_pct": 20}), (ActionType.REDUCE_SPEED, {"rpm": 1000}),
                 (ActionType.RUN_TEST, {"test": 1, "fraction": 0.7})]:
        d = sup.check(prop(a, source=ProposalSource.LLM, **p), ctx())
        assert d.verdict == DecisionVerdict.REJECT and "llm_source_forbidden" in d.reasons


# ---- mandatory stop ----
@pytest.mark.parametrize("kw,reason", [
    (dict(housing_c=61.0), "housing_temp_at_stop_limit"),
    (dict(current_a=4.2), "current_at_stop_limit"),
    (dict(voltage_v=19.0), "supply_voltage_out_of_window"),
    (dict(voltage_v=26.0), "supply_voltage_out_of_window"),
    (dict(vib_rms_g=2.5), "vibration_at_stop_limit"),
    (dict(device_state=DeviceSafetyState.EMERGENCY_STOP), "device_emergency_stop"),
])
def test_mandatory_stop_blocks_other_actions_and_never_depends_on_gate(kw, reason):
    c = ctx(**kw)
    d = sup.check(prop(ActionType.REDUCE_SPEED, rpm=1000), c)
    assert d.verdict == DecisionVerdict.REJECT and d.mandatory_stop and reason in d.reasons
    s = sup.check(prop(ActionType.STOP), c)
    assert s.verdict == DecisionVerdict.ALLOW and s.mandatory_stop


def test_mandatory_stop_blocks_even_a_human_approved_diagnostic_test():
    d = sup.check(prop(ActionType.RUN_TEST, source=ProposalSource.HUMAN, approved=True, test=1, fraction=0.7),
                  ctx(housing_c=65))
    assert d.verdict == DecisionVerdict.REJECT and d.mandatory_stop


# ---- preconditions ----
def test_rejects_when_disconnected_stale_or_sensors_invalid():
    for kw, reason in [(dict(connection=Connection.DEGRADED), "device_not_connected"),
                       (dict(telemetry_age_s=5), "telemetry_stale"),
                       (dict(sensors_valid=False), "sensors_not_valid")]:
        d = sup.check(prop(ActionType.REDUCE_SPEED, rpm=1000), ctx(**kw))
        assert d.verdict == DecisionVerdict.REJECT and reason in d.reasons


def test_viewer_human_cannot_command_motion():
    d = sup.check(prop(ActionType.START, source=ProposalSource.HUMAN, role=Role.VIEWER, duty_pct=20), ctx())
    assert d.verdict == DecisionVerdict.REJECT and "viewer_not_authorised" in d.reasons


def test_reset_estop_requires_admin():
    c = ctx(device_state=DeviceSafetyState.EMERGENCY_STOP)
    d = sup.check(prop(ActionType.RESET_ESTOP, source=ProposalSource.HUMAN, role=Role.OPERATOR), c)
    assert d.verdict == DecisionVerdict.REJECT and "reset_requires_admin" in d.reasons


def test_admin_can_reset_latched_estop_but_not_while_a_limit_is_still_exceeded():
    c = ctx(device_state=DeviceSafetyState.EMERGENCY_STOP, motor_running=False)
    ok = sup.check(prop(ActionType.RESET_ESTOP, source=ProposalSource.HUMAN, role=Role.ADMIN, approved=True), c)
    assert ok.verdict == DecisionVerdict.ALLOW and ok.approved is not None
    hot = ctx(device_state=DeviceSafetyState.EMERGENCY_STOP, motor_running=False, housing_c=65)
    bad = sup.check(prop(ActionType.RESET_ESTOP, source=ProposalSource.HUMAN, role=Role.ADMIN, approved=True), hot)
    assert bad.verdict == DecisionVerdict.REJECT and "housing_temp_at_stop_limit" in bad.reasons


# ---- envelope ----
def test_reduce_speed_only_downwards_and_within_floor():
    ok = sup.check(prop(ActionType.REDUCE_SPEED, rpm=1000), ctx())
    assert ok.verdict == DecisionVerdict.ALLOW
    for rpm in (1600, 1500, 400):    # increase, equal, below 30 % floor
        d = sup.check(prop(ActionType.REDUCE_SPEED, rpm=rpm), ctx())
        assert d.verdict == DecisionVerdict.REJECT and "reduce_target_outside_envelope" in d.reasons


def test_start_duty_cap():
    assert sup.check(prop(ActionType.START, duty_pct=70), ctx(motor_running=False)).verdict == DecisionVerdict.ALLOW
    d = sup.check(prop(ActionType.START, duty_pct=71), ctx(motor_running=False))
    assert d.verdict == DecisionVerdict.REJECT and "duty_out_of_range" in d.reasons


def test_speed_commands_refused_until_commissioned():
    s0 = SafetySupervisor(SupervisorLimits())
    d = s0.check(prop(ActionType.SET_SPEED, rpm=1000), ctx())
    assert d.verdict == DecisionVerdict.REJECT and "speed_not_commissioned" in d.reasons


def test_tests_refused_until_vibration_limit_commissioned():
    s0 = SafetySupervisor(SupervisorLimits(max_rpm=3000))
    d = s0.check(prop(ActionType.RUN_TEST, test=1, fraction=0.7), ctx())
    assert d.verdict == DecisionVerdict.REJECT and "vibration_limit_not_commissioned" in d.reasons


def test_test_envelope_and_budget():
    assert sup.check(prop(ActionType.RUN_TEST, test=1, fraction=0.7), ctx()).verdict == DecisionVerdict.ALLOW
    d = sup.check(prop(ActionType.RUN_TEST, test=1, fraction=1.3), ctx())
    assert "test_fraction_outside_envelope" in d.reasons
    d = sup.check(prop(ActionType.RUN_TEST, test=1, fraction=0.7), ctx(tests_run_in_incident=2))
    assert "test_budget_exhausted" in d.reasons
    d = sup.check(prop(ActionType.RUN_TEST, test=9), ctx())
    assert "unknown_test" in d.reasons
    d = sup.check(prop(ActionType.RUN_TEST, test=1, fraction=0.7), ctx(test_active=True))
    assert "test_active" in d.reasons


def test_t2_not_hardware_validated():
    # T2 isn't even in the device test set; unknown_test is raised in both modes.
    d = sup.check(prop(ActionType.RUN_TEST, test=2), ctx())
    assert d.verdict == DecisionVerdict.REJECT


# ---- approval / mode ----
def test_hardware_requires_enabled_flag_then_human_approval():
    c = ctx(mode=Mode.HARDWARE, hardware_control_enabled=False)
    d = sup.check(prop(ActionType.REDUCE_SPEED, approved=True, rpm=1000), c)
    assert d.verdict == DecisionVerdict.REJECT and "hardware_control_not_enabled" in d.reasons
    c = ctx(mode=Mode.HARDWARE, hardware_control_enabled=True)
    assert sup.check(prop(ActionType.REDUCE_SPEED, rpm=1000), c).verdict == DecisionVerdict.DEFER
    assert sup.check(prop(ActionType.REDUCE_SPEED, approved=True, rpm=1000), c).verdict == DecisionVerdict.ALLOW


def test_simulation_auto_approve_is_configurable():
    strict = SafetySupervisor(replace(LIM, auto_approve_in_simulation=False))
    assert strict.check(prop(ActionType.REDUCE_SPEED, rpm=1000), ctx()).verdict == DecisionVerdict.DEFER


def test_deferred_and_rejected_decisions_carry_no_executable_action():
    d = sup.check(prop(ActionType.REDUCE_SPEED, rpm=9999), ctx())
    assert d.approved is None
    c = ctx(mode=Mode.HARDWARE, hardware_control_enabled=True)
    assert sup.check(prop(ActionType.REDUCE_SPEED, rpm=1000), c).approved is None


def test_limits_object_is_immutable():
    with pytest.raises(Exception):
        sup.limits.max_duty_pct = 100.0


# ---- dispatcher ----
def approved(action=ActionType.START, **params):
    d = sup.check(prop(action, **params), ctx(motor_running=False))
    assert d.approved is not None, d.reasons
    return d.approved


def test_dispatch_builds_firmware_line_with_key_and_ttl():
    sent = []
    d = CommandDispatcher(sent.append, "sim-key")
    rec = d.dispatch(approved(duty_pct=30), 0.0)
    msg = json.loads(sent[0])
    assert msg["type"] == "START" and msg["p"] == 30 and msg["k"] == "sim-key" and msg["ttl"] == 5000
    assert rec.status == CommandStatus.PENDING


def test_ack_progression_and_executed_semantics():
    d = CommandDispatcher(lambda s: None, "k")
    rec = d.dispatch(approved(duty_pct=30), 0.0)
    d.on_ack({"id": rec.id, "status": "ACCEPTED", "reason": "OK"}, 0.1)
    assert rec.counts_as_executed()
    d.on_ack({"id": rec.id, "status": "COMPLETED"}, 0.2)
    d.on_ack({"id": rec.id, "status": "ACCEPTED"}, 0.3)       # late replay must not downgrade
    assert rec.status == CommandStatus.COMPLETED


@pytest.mark.parametrize("status", ["REJECTED", "ABORTED"])
def test_rejected_or_aborted_never_counts_as_executed(status):
    d = CommandDispatcher(lambda s: None, "k")
    rec = d.dispatch(approved(duty_pct=30), 0.0)
    d.on_ack({"id": rec.id, "status": status, "reason": "X"}, 0.1)
    assert not rec.counts_as_executed()


def test_run_test_counts_only_when_completed():
    d = CommandDispatcher(lambda s: None, "k")
    a = sup.check(prop(ActionType.RUN_TEST, test=1, fraction=0.7, hold_ms=10000), ctx()).approved
    rec = d.dispatch(a, 0.0)
    d.on_ack({"id": rec.id, "status": "ACCEPTED"}, 0.1)
    assert not rec.counts_as_executed()                       # accepted but not finished
    d.on_ack({"id": rec.id, "status": "ABORTED", "reason": "LINK_LOST"}, 9.0)
    assert not rec.counts_as_executed()


def test_resend_same_id_then_timeout_without_ack():
    sent = []
    d = CommandDispatcher(sent.append, "k", ack_timeout_s=1.0, max_resends=2, default_ttl_ms=60000)
    rec = d.dispatch(approved(duty_pct=30), 0.0)
    d.poll(1.1); d.poll(2.2)
    assert len(sent) == 3 and len({json.loads(s)["id"] for s in sent}) == 1
    d.poll(3.3)
    assert rec.status == CommandStatus.TIMEOUT and not rec.counts_as_executed()


def test_expired_before_ack_is_not_executed():
    d = CommandDispatcher(lambda s: None, "k", ack_timeout_s=100, default_ttl_ms=2000)
    rec = d.dispatch(approved(duty_pct=30), 0.0)
    d.poll(2.5)
    assert rec.status == CommandStatus.EXPIRED
    d.on_ack({"id": rec.id, "status": "ACCEPTED"}, 3.0)       # late ack does not resurrect it
    assert rec.status == CommandStatus.EXPIRED and not rec.counts_as_executed()


def test_continue_monitoring_is_not_a_device_command():
    d = CommandDispatcher(lambda s: None, "k")
    a = sup.check(prop(ActionType.CONTINUE_MONITORING), ctx()).approved
    with pytest.raises(ValueError):
        d.dispatch(a, 0.0)
