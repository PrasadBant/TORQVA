"""Phase 7 acceptance: the full SIMULATED workflow, plus failure paths.

Everything here is simulation. A blocked or aborted action must never be recorded as a successful recovery.
"""
import copy
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from torqva.hypotheses import HYPS
from torqva.incident import S
from torqva.pipeline import Orchestrator, PipelineConfig
from torqva.prediction import InterventionPredictor
from torqva.scenarios import action_cases
from torqva.schemas import (ActionType, CommandStatus, Hypothesis, Mode, Provenance, RecoveryOutcome, Role)
from torqva.simdevice import SimDevice
from torqva.sim import MotorSim
from torqva.store import Store
from torqva.supervisor import SafetySupervisor, SupervisorLimits

LIM = SupervisorLimits(vib_rms_stop_g=2.0, max_rpm=3000.0)


@pytest.fixture(scope="module")
def predictor(stack):
    det, tt, hm, dm, zs_for = stack
    pred = InterventionPredictor()
    pred.fit(tt)
    cal = [c for h in HYPS for sev in (0.3, 0.6, 0.9) for seed in (11, 12) for sp in (1200, 1800)
           for c in action_cases(h, sev, seed, sp, det, tt, hm)]
    pred.calibrate(cal)
    test = [c for h in HYPS for sev in (0.4, 0.8) for seed in (21, 22) for sp in (1500, 2000)
            for c in action_cases(h, sev, seed, sp, det, tt, hm)]
    pred.evaluate_coverage(test)
    return pred


def build(stack, predictor, seed=1, fault=None, sev=0.0, clears_below=None, mode=Mode.SIMULATION, control=True,
          hm=None, cfg=None, lim=LIM, sp=1800.0, warm=40, inject_after=0):
    det, tt, hm0, dm, _ = stack
    sim = MotorSim(seed)
    dev = SimDevice(sim, control_enabled=control)
    o = Orchestrator(dev, copy.deepcopy(det), copy.deepcopy(tt), hm or hm0, dm, copy.deepcopy(predictor),
                     SafetySupervisor(lim), Store(), cfg or PipelineConfig(), mode=mode)
    sim.set_setpoint(sp)
    for _ in range(warm):
        o.step()
    if fault is not None:
        sim.inject(fault, sev, clears_below)
    return o


def run(o, until, max_s=1500):
    for _ in range(max_s):
        o.step()
        if until(o):
            return True
    return False


def states(o):
    return [t for h in ([o.inc] if o.inc else []) + o.incidents_done for t in [x[2] for x in h.history]]


# ---------------- success path ----------------
def test_full_loop_detect_rank_gate_predict_supervise_dispatch_ack_verify_record(stack, predictor):
    o = build(stack, predictor, fault=Hypothesis.IMBALANCE, sev=0.5, clears_below=1500.0)
    assert not o.incidents_done                                         # healthy warm-up: no confirmed incident
    assert o.inc is None or o.inc.state in (S.NORMAL, S.ANOMALY_SUSPECTED)
    assert run(o, lambda x: len(x.incidents_done) >= 1, 1200)
    inc = o.incidents_done[0]
    seq = [h[2] for h in inc.history]
    for must in (S.ANOMALY_SUSPECTED, S.INVESTIGATING, S.GATE_EVALUATION, S.ACTION_EVALUATION, S.AWAITING_APPROVAL,
                 S.COMMAND_SENT, S.AWAITING_ACK, S.VERIFYING_RECOVERY, S.RECOVERED, S.CLOSED):
        assert must in seq, (must, seq)
    # 1) detected + hypotheses ranked with a stored plain-language gate reason and inputs
    gate = [d for d in o.store.list("decision") if "inputs" in d]
    assert gate and gate[0]["reason"] and "top_p" in gate[0]["inputs"]
    # 2) predictions are stored separately, labelled PREDICTED and unvalidated
    preds = o.store.list("prediction")
    assert len(preds) == 3 and all(p["_provenance"] == "PREDICTED" for p in preds)
    assert all(p["validated_by_experiments"] is False for p in preds)
    # 3) supervisor decision recorded before dispatch; command acked by the device
    cmds = [c for c in o.store.list("command") if c["action"] != "HEARTBEAT"]
    assert cmds and cmds[0]["status"] in ("ACCEPTED", "COMPLETED") and cmds[0]["counts_as_executed"]
    # 4) outcome is MEASURED-in-simulation (SIMULATED provenance), separate from predictions
    out = o.store.get("outcome", inc.id)
    assert out["outcome"] == "RECOVERED" and out["command_executed"] and out["_provenance"] == "SIMULATED"
    assert out["n_fresh"] >= 60
    # 5) learning dataset gets exactly one eligible case, SIMULATED, system-labelled
    assert len(o.cases) == 1 and o.cases[0].provenance == Provenance.SIMULATED
    assert o.store.audit_log("transition")


def test_unresolved_when_the_problem_persists_is_not_recovery(stack, predictor):
    o = build(stack, predictor, fault=Hypothesis.IMBALANCE, sev=0.5, clears_below=None)
    assert run(o, lambda x: len(x.incidents_done) >= 1, 1500)
    out = o.store.get("outcome", o.incidents_done[0].id)
    assert out["outcome"] != "RECOVERED"


def test_diagnostic_test_path_updates_posterior_then_acts(stack, predictor):
    det, tt, hm, dm, _ = stack
    flat = copy.deepcopy(hm); flat.temp = 1e6                          # evidence barely moves the posterior -> ambiguous -> test
    o = build(stack, predictor, fault=Hypothesis.LOOSENESS, sev=0.6, hm=flat)
    assert run(o, lambda x: len(x.incidents_done) >= 1 or (x.inc and x.inc.state == S.HUMAN_INSPECTION_REQUIRED), 2500)
    kinds = [l["kind"] for l in o.log]
    assert "test_result" in kinds, [l for l in o.log if l["kind"] == "gate"]
    run_test_cmds = [c for c in o.store.list("command") if c["action"] == "RUN_TEST"]
    assert run_test_cmds and run_test_cmds[0]["counts_as_executed"]    # only a COMPLETED test counts
    tr = next(l for l in o.log if l["kind"] == "test_result")
    assert tr["test"] in ("T1", "T3")


# ---------------- failure paths ----------------
def test_device_rejection_is_not_a_recovery_and_is_not_executed(stack, predictor):
    o = build(stack, predictor, fault=Hypothesis.IMBALANCE, sev=0.5, clears_below=1500.0)
    o.dev.reject_next = "BUSY"                                          # the first real command is refused by the device
    assert run(o, lambda x: any(h[1].value == "ACK_FAIL" for i in ([x.inc] if x.inc else []) + x.incidents_done
                                for h in i.history), 300)
    for _ in range(3):
        o.step()
    failed = [c for c in o.store.list("command") if c["status"] == "REJECTED"]
    assert failed and not any(c["counts_as_executed"] for c in failed)
    # the failed command never reached recovery verification
    inc = o.incidents_done[0] if o.incidents_done else o.inc
    hist = [(h[0].value, h[1].value, h[2].value) for h in inc.history]
    i_fail = next(i for i, h in enumerate(hist) if h[1] == "ACK_FAIL")
    assert hist[i_fail][2] == "COMMAND_FAILED" and hist[i_fail + 1][2] == "GATE_EVALUATION"
    assert not o.cases or all(c.command_executed for c in o.cases)


def test_lost_acks_time_out_and_never_count_as_executed(stack, predictor):
    o = build(stack, predictor, fault=Hypothesis.IMBALANCE, sev=0.5, clears_below=1500.0)
    o.dev.drop_acks = True
    run(o, lambda x: any(c["status"] in ("TIMEOUT", "EXPIRED") for c in x.store.list("command")), 600)
    to = [c for c in o.store.list("command") if c["status"] in ("TIMEOUT", "EXPIRED")]
    assert to and not any(c["counts_as_executed"] for c in to)
    assert not any(o.store.get("outcome", i.id) and o.store.get("outcome", i.id)["outcome"] == "RECOVERED"
                   for i in o.incidents_done)


def test_heartbeat_loss_trips_device_and_latches_until_button(stack, predictor):
    o = build(stack, predictor)
    o.heartbeat_enabled = False
    for _ in range(6):
        o.step()
    assert o.dev.estop and o.inc is not None and o.inc.state == S.EMERGENCY_STOP
    assert o.dev.sim.rpm < 1800
    # commands are refused while latched
    from torqva.schemas import ProposedAction, ProposalSource
    d = o.sup.check(ProposedAction(action=ActionType.START, params={"duty_pct": 20}, source=ProposalSource.HUMAN,
                                   role=Role.OPERATOR, human_approved=True), o._ctx())
    assert d.approved is None and "mandatory_stop_active" in d.reasons


def test_mandatory_stop_is_dispatched_immediately_without_consulting_the_gate(stack, predictor):
    # Backend limit (40 C) deliberately stricter than the device's (60 C), so the backend rule is what fires.
    strict = SupervisorLimits(vib_rms_stop_g=2.0, max_rpm=3000.0, temp_stop_c=40.0)
    o = build(stack, predictor, fault=Hypothesis.IMBALANCE, sev=0.5, lim=strict)
    run(o, lambda x: x.inc is not None and x.inc.state in (S.ANOMALY_SUSPECTED, S.INVESTIGATING), 100)
    assert o.inc is not None and not o.dev.estop
    o.dev.sim.housing = 45.0
    n_gate_before = len([l for l in o.log if l["kind"] == "gate"])
    o.step()
    stops = [c for c in o.disp.records.values() if c.action == ActionType.STOP]
    assert stops, "STOP must be dispatched in the same step the limit is exceeded"
    assert len([l for l in o.log if l["kind"] == "gate"]) == n_gate_before
    assert any(l["kind"] == "mandatory_stop" for l in o.log)
    o.step(); o.step()
    assert o.dev.sim.setpoint == 0.0


def test_invalid_sensors_block_all_actions_except_stop(stack, predictor):
    o = build(stack, predictor, fault=Hypothesis.IMBALANCE, sev=0.5)
    o.dev.stuck_sensor = True
    run(o, lambda x: False, 80)
    cmds = [c for c in o.disp.records.values() if c.action not in (ActionType.HEARTBEAT, ActionType.STOP)]
    assert not cmds
    assert not o.cases


def test_hardware_mode_without_control_enabled_never_dispatches(stack, predictor):
    o = build(stack, predictor, fault=Hypothesis.IMBALANCE, sev=0.5, mode=Mode.HARDWARE, control=False)
    run(o, lambda x: x.inc is not None and x.inc.state in (S.HUMAN_INSPECTION_REQUIRED, S.CLOSED), 600)
    assert not [c for c in o.disp.records.values() if c.action not in (ActionType.HEARTBEAT, ActionType.STOP)]


def test_hardware_mode_waits_for_human_approval_then_executes(stack, predictor):
    o = build(stack, predictor, fault=Hypothesis.IMBALANCE, sev=0.5, clears_below=1500.0, mode=Mode.HARDWARE, control=True)
    assert run(o, lambda x: x.pending is not None, 800)
    assert o.inc.state == S.AWAITING_APPROVAL
    assert not [c for c in o.disp.records.values() if c.action == ActionType.REDUCE_SPEED]    # nothing sent yet
    o.approve(Role.OPERATOR)
    assert [c for c in o.disp.records.values() if c.action == ActionType.REDUCE_SPEED]


def test_pipeline_is_deterministic(stack, predictor):
    outs = []
    for _ in range(2):
        o = build(stack, predictor, fault=Hypothesis.IMBALANCE, sev=0.5, clears_below=1500.0)
        run(o, lambda x: len(x.incidents_done) >= 1, 1200)
        outs.append([(l["t"], l["kind"]) for l in o.log])
    assert outs[0] == outs[1]
