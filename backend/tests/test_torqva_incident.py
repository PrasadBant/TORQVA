"""Incident state machine: every allowed transition, representative forbidden ones, and loop guards."""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from torqva.incident import E, IllegalTransition, Incident, S, T


@pytest.mark.parametrize("key,to", list(T.items()), ids=[f"{k[0].value}-{k[1].value}" for k in T])
def test_every_allowed_transition(key, to):
    frm, ev = key
    inc = Incident("i", state=frm)
    assert inc.fire(ev) == to


def test_every_non_table_pair_is_forbidden():
    always_ok = {E.DEVICE_ESTOP, E.QUALITY_FAIL, E.MANDATORY_STOP}
    for s in S:
        for e in E:
            if (s, e) in T or e in always_ok:
                continue
            with pytest.raises(IllegalTransition):
                Incident("i", state=s).fire(e)


def test_device_estop_from_any_state():
    for s in S:
        assert Incident("i", state=s).fire(E.DEVICE_ESTOP) == S.EMERGENCY_STOP


def test_quality_fail_from_any_nonterminal_state_and_recovers_to_normal():
    for s in S:
        if s in (S.CLOSED, S.EMERGENCY_STOP):
            continue
        inc = Incident("i", state=s)
        assert inc.fire(E.QUALITY_FAIL) == S.SENSOR_UNRELIABLE
        assert inc.fire(E.QUALITY_RESTORED) == S.NORMAL


def test_closed_is_terminal_except_for_estop():
    with pytest.raises(IllegalTransition):
        Incident("i", state=S.CLOSED).fire(E.SCORE_HIGH)
    with pytest.raises(IllegalTransition):
        Incident("i", state=S.CLOSED).fire(E.QUALITY_FAIL)


def test_estop_reset_leads_to_human_inspection_not_normal():
    inc = Incident("i", state=S.EMERGENCY_STOP)
    assert inc.fire(E.ESTOP_RESET) == S.HUMAN_INSPECTION_REQUIRED
    with pytest.raises(IllegalTransition):
        Incident("i", state=S.EMERGENCY_STOP).fire(E.QUALITY_RESTORED)


def test_data_request_loop_guard_escalates():
    inc = Incident("i", state=S.GATE_EVALUATION, max_data_requests=2)
    for _ in range(2):
        inc.fire(E.GATE_MORE_DATA)
        inc.fire(E.MORE_DATA_READY)
    assert inc.fire(E.GATE_MORE_DATA) == S.HUMAN_INSPECTION_REQUIRED


def test_test_budget_guard_escalates():
    inc = Incident("i", state=S.GATE_EVALUATION, max_tests=1)
    inc.fire(E.GATE_TEST); inc.fire(E.TEST_REJECTED)
    assert inc.fire(E.GATE_TEST) == S.HUMAN_INSPECTION_REQUIRED


def test_happy_path_and_failed_command_path():
    inc = Incident("i")
    for ev in (E.SCORE_HIGH, E.PERSISTS, E.HYPOTHESES_RANKED, E.GATE_ACT, E.ACTION_PROPOSED, E.APPROVED,
               E.DISPATCHED, E.ACK_OK, E.REC_RECOVERED, E.CLOSE):
        inc.fire(ev)
    assert inc.state == S.CLOSED

    bad = Incident("j", state=S.AWAITING_ACK)
    assert bad.fire(E.ACK_FAIL) == S.COMMAND_FAILED
    assert bad.fire(E.MORE_DATA_READY) == S.GATE_EVALUATION      # a failed command never reaches recovery
    assert all(h[2] != S.VERIFYING_RECOVERY for h in bad.history)


def test_cannot_skip_ack_to_verification():
    for s in (S.COMMAND_SENT, S.AWAITING_APPROVAL, S.ACTION_EVALUATION):
        with pytest.raises(IllegalTransition):
            Incident("i", state=s).fire(E.REC_RECOVERED)


def test_mandatory_stop_jumps_to_command_from_every_pre_command_state():
    from torqva.incident import _PRE_COMMAND
    for s in _PRE_COMMAND:
        assert Incident("i", state=s).fire(E.MANDATORY_STOP) == S.COMMAND_SENT


def test_mandatory_stop_not_valid_once_a_command_is_in_flight_or_terminal():
    for s in (S.COMMAND_SENT, S.AWAITING_ACK, S.VERIFYING_RECOVERY, S.RECOVERED, S.CLOSED, S.EMERGENCY_STOP):
        with pytest.raises(IllegalTransition):
            Incident("i", state=s).fire(E.MANDATORY_STOP)
