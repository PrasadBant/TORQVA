"""C5 recovery verification: all four outcomes, never declared without a fresh window."""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from torqva.dispatch import CommandRecord
from torqva.recovery import RecoveryConfig, assess
from torqva.schemas import ActionType, CommandStatus, Hypothesis, RecoveryOutcome
from torqva.sim import MotorSim


def rec(action=ActionType.REDUCE_SPEED, status=CommandStatus.COMPLETED, acked_at=100.0):
    r = CommandRecord(1, action, "SET_SPEED", {}, "inc", "SIMULATION", 99.0, 5000)
    r.status = status
    r.acked_at = acked_at
    return r


def after_ack(fault, sev, sp, seconds=400, new_sp=None, seed=5, fix_fault=False):
    s = MotorSim(seed); s.set_setpoint(sp); s.run(60)
    s.inject(fault, sev); s.run(30)
    s.t = 100.0
    if new_sp is not None:
        s.set_setpoint(new_sp)
    if fix_fault:
        s.inject(None)
    return s.run(seconds)


def test_recovered_when_fault_removed_and_fresh_window_in_band(stack):
    det, tt, *_ = stack
    ws = after_ack(Hypothesis.IMBALANCE, 0.8, 1500, fix_fault=True)
    a = assess(rec(), ws, det, tt, now=ws[-1].t)
    assert a.outcome == RecoveryOutcome.RECOVERED and all(a.criteria.values())
    assert a.provenance == "MEASURED"


def test_unresolved_when_fault_persists_after_action(stack):
    det, tt, *_ = stack
    ws = after_ack(Hypothesis.IMBALANCE, 0.8, 1500)           # action had no effect
    a = assess(rec(), ws, det, tt, now=ws[-1].t)
    assert a.outcome == RecoveryOutcome.UNRESOLVED and not a.criteria["in_learned_band"]


def test_second_unresolved_escalates_to_human(stack):
    det, tt, *_ = stack
    ws = after_ack(Hypothesis.IMBALANCE, 0.8, 1500)
    a = assess(rec(), ws, det, tt, now=ws[-1].t, previous_unresolved=True)
    assert a.outcome == RecoveryOutcome.HUMAN_INSPECTION_REQUIRED


def test_inconclusive_without_enough_fresh_samples(stack):
    det, tt, *_ = stack
    ws = after_ack(Hypothesis.IMBALANCE, 0.8, 1500, fix_fault=True)
    a = assess(rec(), ws, det, tt, now=100.0 + 30)             # still inside the settle time
    assert a.outcome == RecoveryOutcome.INCONCLUSIVE
    a = assess(rec(), ws, det, tt, now=100.0 + 120 + 20)       # settled, but only ~20 fresh samples
    assert a.outcome == RecoveryOutcome.INCONCLUSIVE and "insufficient_fresh_window" in a.reasons[0]


def test_never_recovered_from_stale_samples_only(stack):
    det, tt, *_ = stack
    ws = after_ack(Hypothesis.IMBALANCE, 0.8, 1500, fix_fault=True)
    pre_only = [w for w in ws if w.t < 100.0 + 5]
    a = assess(rec(), pre_only, det, tt, now=ws[-1].t)
    assert a.outcome == RecoveryOutcome.INCONCLUSIVE


@pytest.mark.parametrize("status", [CommandStatus.REJECTED, CommandStatus.ABORTED, CommandStatus.TIMEOUT,
                                    CommandStatus.EXPIRED, CommandStatus.PENDING])
def test_blocked_or_failed_command_is_never_a_recovery(stack, status):
    det, tt, *_ = stack
    ws = after_ack(Hypothesis.IMBALANCE, 0.8, 1500, fix_fault=True)        # data even looks perfect
    a = assess(rec(status=status), ws, det, tt, now=ws[-1].t)
    assert a.outcome == RecoveryOutcome.INCONCLUSIVE and a.reasons[0].startswith("command_not_executed")


def test_stop_checks_safety_not_anomaly_score(stack):
    det, tt, *_ = stack
    s = MotorSim(7); s.set_setpoint(1500); s.run(60); s.inject(Hypothesis.OVERLOAD, 0.8); s.run(20)
    s.t = 100.0; s.stop()
    ws = s.run(200)
    ok = assess(rec(ActionType.STOP), ws, det, tt, now=ws[-1].t)
    assert ok.outcome == RecoveryOutcome.INCONCLUSIVE and ok.observed["rpm"] < 50     # stopped; fault not verifiable
    bad = assess(rec(ActionType.STOP), ws, det, tt, now=ws[-1].t, safety_ok_after_stop=False)
    assert bad.outcome == RecoveryOutcome.HUMAN_INSPECTION_REQUIRED


def test_stop_with_motor_still_turning_requires_inspection(stack):
    det, tt, *_ = stack
    ws = after_ack(Hypothesis.OVERLOAD, 0.8, 1500)                            # never actually stopped
    a = assess(rec(ActionType.STOP), ws, det, tt, now=ws[-1].t)
    assert a.outcome == RecoveryOutcome.HUMAN_INSPECTION_REQUIRED


def test_unlearned_operating_point_is_inconclusive_not_recovered(stack):
    det, tt, *_ = stack
    ws = after_ack(Hypothesis.IMBALANCE, 0.0, 3000, seed=9)                   # bin never learned
    a = assess(rec(), ws, det, tt, now=ws[-1].t)
    assert a.outcome == RecoveryOutcome.INCONCLUSIVE and "operating_point_not_learned" in a.reasons


def test_gap_in_fresh_window_is_inconclusive(stack):
    det, tt, *_ = stack
    ws = after_ack(Hypothesis.IMBALANCE, 0.8, 1500, fix_fault=True)
    holed = [w for w in ws if not (300 < w.t < 315)]
    a = assess(rec(), holed, det, tt, now=ws[-1].t)
    assert a.outcome == RecoveryOutcome.INCONCLUSIVE and a.reasons == ["gap_in_fresh_window"]
