"""Phase 10: C2 interval quality / support status and C4 diagnostic-test value (SIMULATION ONLY).

The shipped C2/C4 stay the default. These tests check: reproducible baseline behaviour, interval construction, explicit unsupported /
insufficiently-validated handling, data-leakage prevention, diagnostic discrimination (including honest inconclusive results), safe handling of
test aborts (mandatory stop, communication loss, timeout), authorization, prediction-versus-observation record integrity and C1-C6 regression.
"""
import copy
import hashlib
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

import torqva.c2_robust as c2r
import torqva.c2c4_study as study
from torqva.c2_robust import (MIN_CELL_N, NONNEGATIVE, NoiseAwarePredictor, PREDICTION_TARGETS, PersistenceConformalPredictor, build_noise_aware, make_case)
from torqva.c4_robust import ConflictGuard, StyleAwareDiagnosticsModel, TEST_SPECS, classify_test_result, style_regime
from torqva.diagnostics import DiagnosticsModel, run_test_on_sim
from torqva.gate import GateInputs, decide
from torqva.hypotheses import HYPS, Posterior
from torqva.incident import S
from torqva.pipeline import Orchestrator, PipelineConfig
from torqva.prediction import ACTIONS, CHECK_HORIZONS, NOISE_FLOOR, SIGNALS, InterventionPredictor, StateSummary, estimate_noise
from torqva.schemas import ActionType, GateVerdict, Hypothesis, Mode, ProposalSource, ProposedAction, Role
from torqva.sim import REGIMES, MotorSim
from torqva.simdevice import SimDevice
from torqva.store import Store
from torqva.supervisor import SafetySupervisor, SupervisorLimits

LIM = SupervisorLimits(vib_rms_stop_g=2.0, max_rpm=3000.0)
Hy = Hypothesis


@pytest.fixture(scope="module")
def control(stack):
    det, tt, hm, dm, _ = stack
    pred = InterventionPredictor(); pred.fit(tt)
    cases = [make_case(h, sev, sd, sp, REGIMES["baseline"], det, tt, hm) for h in HYPS for sev in (0.3, 0.6, 0.9) for sd in (11, 12) for sp in (1200, 1800)]
    pred.calibrate([(c["st"], c["post"], a["action"], a["target"], a["truth"]) for c in cases for a in c["acts"]])
    return pred


@pytest.fixture(scope="module")
def noise_aware(stack, control):
    det, tt, hm, dm, _ = stack
    return build_noise_aware(control, det, tt, hm)


def posterior(top=Hy.IMBALANCE, p=0.9, ood=False, n=10):
    probs = {h: (1 - p) / (len(HYPS) - 1) for h in HYPS}; probs[top] = p
    return Posterior(probs, n, ood)


def state(rpm=1650.0, noise=None, vib=0.07, n=10):
    return StateSummary(rpm, 1650.0, 1.3, 25.0, 22.0, vib, noise or {"rpm": 2.0, "vib_rms": 0.0035, "current": 0.02, "housing": 0.03}, n)


# ============================================================ specification
def test_every_action_and_every_test_has_a_complete_specification():
    for a, _ in ((x, None) for x in ACTIONS):
        spec = PREDICTION_TARGETS[a]
        assert {"preconditions", "predicts", "meaning", "unsupported_when", "observed_as"} <= set(spec)
    for t in ("T1", "T3", "T4"):
        assert {"distinguishes", "evidence", "conditions", "abort", "inconclusive", "effect"} <= set(TEST_SPECS[t])
    assert "not" in PREDICTION_TARGETS["STOP"]["meaning"] or "expected" in PREDICTION_TARGETS["STOP"]["meaning"]


# ============================================================ baseline behaviour is unchanged
def test_control_predictor_behaviour_and_defaults_are_unchanged(stack, control):
    det, tt, hm, dm, _ = stack
    c = make_case(Hy.IMBALANCE, 0.6, 9990, 1650.0, REGIMES["baseline"], det, tt, hm)
    p = control.predict(c["post"], c["st"], "STOP", 0.0, 120)
    assert p.status == "supported" and p.interval_method == "split_conformal_floor" and p.status_reasons == []
    assert (p.lo["rpm"] >= 0).all() and (p.lo["housing"] >= 0).all()                     # the shipped clipping is preserved
    assert control.trust(c["post"], True).trusted is not None                           # signature unchanged (st optional)
    from torqva.service import SimulationService
    assert SimulationService().c2_variant == "control"                                   # the shipped predictor is the default


def test_matched_condition_cases_are_deterministic(stack):
    det, tt, hm, dm, _ = stack
    a = make_case(Hy.LOOSENESS, 0.6, 9991, 1650.0, REGIMES["noisy"], det, tt, hm)
    b = make_case(Hy.LOOSENESS, 0.6, 9991, 1650.0, REGIMES["noisy"], det, tt, hm)
    h = lambda c: hashlib.sha256(repr([[round(getattr(w, s), 9) for s in SIGNALS] for x in c["acts"] for w in x["truth"]]).encode()).hexdigest()
    assert h(a) == h(b)
    # all three actions start from IDENTICAL conditions: the same pre-action state, different futures
    assert len({round(x["truth"][0].t, 6) for x in a["acts"]}) == 1 and a["acts"][2]["truth"][-1].rpm < a["acts"][0]["truth"][-1].rpm


# ============================================================ interval construction
def test_noise_aware_point_predictions_equal_the_control(control, noise_aware):
    st, post = state(), posterior()
    for a in ("CONTINUE_MONITORING", "REDUCE_SPEED", "STOP"):
        pc, pn = control.predict(post, st, a, 1100.0, 120), noise_aware.predict(post, st, a, 1100.0, 120)
        for s in SIGNALS:
            assert np.allclose(pc.mean[s], pn.mean[s])                                   # accuracy is the control's; only intervals differ


def test_extra_noise_widens_intervals_but_calibration_level_noise_does_not(noise_aware):
    post = posterior()
    nom = {s: noise_aware._nominal(s, state()) for s in SIGNALS}
    base = noise_aware.predict(post, state(noise=nom), "CONTINUE_MONITORING", 0.0, 120)
    noisy = noise_aware.predict(post, state(noise={s: 3.0 * v for s, v in nom.items()}), "CONTINUE_MONITORING", 0.0, 120)
    w = lambda p, s: float((p.hi[s] - p.lo[s]).mean())
    for s in SIGNALS:
        assert w(noisy, s) > w(base, s)
    assert noisy.status == "supported" or "measurement_noise" in " ".join(noisy.status_reasons)


def test_interval_never_narrower_than_the_noise_alone_and_nonnegative_clipping_is_only_where_valid(noise_aware):
    st = state(rpm=1650.0)
    p = noise_aware.predict(posterior(), st, "STOP", 0.0, 120)
    z = c2r.Z90 * st.noise["rpm"] * np.sqrt(1 + 1 / st.n_state)
    assert float((p.hi["rpm"] - p.mean["rpm"]).min()) >= z - 1e-9                       # floor = 90 % half-width of the sensor noise alone
    assert p.lo["rpm"][-1] < 0 < p.hi["rpm"][-1]                                         # measured rpm can read below 0 near 0: not clipped
    assert (p.lo["vib_rms"] >= 0).all() and (p.lo["current"] >= 0).all() and set(NONNEGATIVE) == {"vib_rms", "current"}


def test_missing_noise_information_falls_back_to_the_fixed_floor(noise_aware):
    st = state(); st.noise = None
    p = noise_aware.predict(posterior(), st, "CONTINUE_MONITORING", 0.0, 120)
    assert float((p.hi["rpm"] - p.mean["rpm"]).min()) >= NOISE_FLOOR["rpm"] - 1e-9
    assert p.status == "insufficiently_validated" and "noise_level_unknown" in p.status_reasons


def test_noise_estimator_recovers_the_injected_noise_level(stack):
    for nm in (1.0, 2.0):
        s = MotorSim(9992, regime=REGIMES["baseline"] if nm == 1.0 else REGIMES["noisy"]); s.set_setpoint(1650); ws = s.run(80)[20:]
        est = estimate_noise(ws)
        assert 0.7 * 2.0 * nm < est["rpm"] < 1.4 * 2.0 * nm


def test_persistence_baseline_cannot_represent_an_action_effect(stack, control):
    det, tt, hm, dm, _ = stack
    cases = [make_case(h, 0.6, 9993, sp, REGIMES["baseline"], det, tt, hm) for h in (Hy.IMBALANCE, Hy.OVERLOAD) for sp in (1500, 1900)]
    pb = PersistenceConformalPredictor.from_fitted(control)
    pb.calibrate([(c["st"], c["post"], a["action"], a["target"], a["truth"]) for c in cases for a in c["acts"]])
    p = pb.predict(cases[0]["post"], cases[0]["st"], "STOP", 0.0, 120)
    assert np.allclose(p.mean["rpm"], cases[0]["st"].rpm) and p.interval_method == "persistence_conformal"
    assert float((p.hi["rpm"] - p.lo["rpm"]).max()) > 500                                 # the "interval" is huge: it only knows the present


# ============================================================ unsupported / insufficiently validated
@pytest.mark.parametrize("action,target,st_kw,why", [
    ("STOP", 0.0, dict(rpm=10.0), "motor_already_stopped"),
    ("REDUCE_SPEED", 1640.0, dict(), "no_real_speed_reduction"),
    ("REDUCE_SPEED", 0.0, dict(), "no_real_speed_reduction"),
    ("CONTINUE_MONITORING", 0.0, dict(rpm=10.0), "motor_not_running"),
    ("CONTINUE_MONITORING", 0.0, dict(noise={"rpm": 40.0, "vib_rms": 0.05, "current": 0.4, "housing": 0.5}), "measurement_noise"),
])
def test_unsupported_conditions_are_declared_explicitly(noise_aware, action, target, st_kw, why):
    p = noise_aware.predict(posterior(), state(**st_kw), action, target, 120)
    assert p.status == "unsupported" and any(why in r for r in p.status_reasons)


def test_out_of_distribution_evidence_and_small_calibration_are_not_presented_as_validated(noise_aware):
    assert noise_aware.predict(posterior(ood=True), state(), "STOP", 0.0, 120).status == "unsupported"
    thin = copy.deepcopy(noise_aware)
    for k in thin.cells:
        thin.cells[k] = c2r.CellStat(thin.cells[k].q_raw, MIN_CELL_N - 1)
    p = thin.predict(posterior(), state(), "STOP", 0.0, 120)
    assert p.status == "insufficiently_validated" and any("calibration_cells_below" in r for r in p.status_reasons)
    fresh = NoiseAwarePredictor.from_fitted(noise_aware)
    assert fresh.predict(posterior(), state(), "STOP", 0.0, 120).status == "insufficiently_validated"       # never calibrated


def test_trust_refuses_unsupported_conditions(noise_aware):
    assert not noise_aware.trust(posterior(ood=True), True, st=state()).trusted
    assert not noise_aware.trust(posterior(), False, st=state()).trusted
    bad = state(noise={"rpm": 40.0, "vib_rms": 0.05, "current": 0.4, "housing": 0.5})
    t = noise_aware.trust(posterior(), True, st=bad)
    assert not t.trusted and "measurement_noise_outside_calibrated_range" in t.reasons


# ============================================================ data-leakage prevention
def test_split_seeds_are_disjoint_and_unseen_before():
    groups = [set(study.CAL_SEEDS), set(study.VAL_SEEDS), set(study.TEST_SEEDS), set(study.C4_VAL_SEEDS), set(study.C4_TEST_SEEDS), set(study.C4_TEST2_SEEDS)]
    assert all(not (a & b) for i, a in enumerate(groups) for b in groups[i + 1:])
    assert not set().union(*groups) & study.EARLIER_SEEDS
    assert set(c2r.CAL_SEEDS) == set(study.CAL_SEEDS)                                    # the opt-in builder calibrates on CAL only
    test_regs = set(study.TEST_REGIMES) - set(study.VAL_REGIMES)
    assert len(test_regs) >= 6                                                           # most test regimes never appear in validation


def test_final_stage_refuses_without_a_frozen_selection(monkeypatch, tmp_path):
    monkeypatch.setattr(study, "SELECTION_FILE", str(tmp_path / "none.json"))
    with pytest.raises(SystemExit):
        study.stage_final()
    with pytest.raises(SystemExit):
        study.stage_final_c4_v2()


def test_selection_never_generates_data_from_test_seeds_or_regimes():
    """The validation functions may MENTION test seeds (the disjointness assertion) but no data-generating call may take them."""
    import ast, inspect, textwrap
    generators = {"make_cases", "make_case", "pair_cases", "c4_realistic", "prepare_predictors", "build_c4_variants", "build_c4_variants_v2", "c4_final", "stage_final"}
    for fn in (study.stage_validate, study.c4_validate, study.c4_v2_validate):
        tree = ast.parse(textwrap.dedent(inspect.getsource(fn)))
        for node in ast.walk(tree):
            if isinstance(node, ast.Call) and getattr(node.func, "id", getattr(node.func, "attr", "")) in generators:
                names = {n.id for n in ast.walk(node) if isinstance(n, ast.Name)}
                assert not [n for n in names if "TEST" in n], (fn.__name__, names)


# ============================================================ diagnostic discrimination
@pytest.fixture(scope="module")
def dms(stack):
    det, tt, hm, dm, _ = stack
    sa = StyleAwareDiagnosticsModel(); sa.learn(tt, seeds=(1, 2))
    return {"control": dm, "style_aware": sa, "guarded": ConflictGuard(sa)}


def pair_outcome(dm, tt, truth, regime, seed, test="T1", sev=0.6):
    a, b = Hy.LOOSENESS, Hy.SENSOR_FAULT
    prior = {h: 0.0 for h in HYPS}; prior[a] = prior[b] = 0.5
    P0 = Posterior(prior, 10)
    s = MotorSim(seed, regime=regime); s.set_setpoint(1650); s.run(60); s.inject(truth, sev)
    obs, _ = run_test_on_sim(s, test, tt)
    return classify_test_result(P0, dm.update(P0, test, obs), truth)


def test_t1_separates_looseness_from_a_sensor_fault_only_if_the_signature_covers_the_style(stack, dms):
    det, tt, hm, dm, _ = stack
    for style, ctrl_ok in (("stuck", True), ("noisy_harmonics", False)):
        reg = style_regime(style)
        res = {k: [pair_outcome(dms[k], tt, truth, reg, 9960 + i) for truth in (Hy.LOOSENESS, Hy.SENSOR_FAULT) for i in range(6)] for k in ("control", "style_aware")}
        acc = {k: np.mean([r["top1_after"] for r in v]) for k, v in res.items()}
        assert acc["style_aware"] >= 0.9
        assert (acc["control"] >= 0.9) == ctrl_ok                                         # the shipped library is blind to the noisy-harmonics style


def test_unfamiliar_fault_style_ends_inconclusive_never_forced(stack, dms):
    det, tt, hm, dm, _ = stack
    reg = style_regime("intermittent", "intermittent")
    for k in ("control", "style_aware"):
        rs = [pair_outcome(dms[k], tt, truth, reg, 9970 + i) for truth in (Hy.LOOSENESS, Hy.SENSOR_FAULT) for i in range(8)]
        assert np.mean([r["inconclusive"] for r in rs]) >= 0.4                            # ambiguous evidence stays ambiguous
        assert all(r["inconclusive"] or r["top1_after"] or r["confident_wrong"] for r in rs)


def test_result_classification_distinguishes_improved_unchanged_worsened_inconclusive():
    prior = posterior(Hy.IMBALANCE, 0.5)
    up = Posterior({**{h: 0.02 for h in HYPS}, Hy.IMBALANCE: 0.9}, 10)
    down = Posterior({**{h: 0.18 for h in HYPS}, Hy.IMBALANCE: 0.1}, 10)
    assert classify_test_result(prior, up, Hy.IMBALANCE)["effect"] == "improved" and not classify_test_result(prior, up, Hy.IMBALANCE)["inconclusive"]
    assert classify_test_result(prior, down, Hy.IMBALANCE)["effect"] == "worsened"
    assert classify_test_result(prior, prior, Hy.IMBALANCE)["effect"] == "unchanged" and classify_test_result(prior, prior)["inconclusive"]
    ood = Posterior(up.probs, 10, True)
    r = classify_test_result(prior, ood, Hy.LOOSENESS)
    assert r["inconclusive"] and not r["confident_wrong"]                                  # an out-of-distribution outcome can never be a confident error


def test_conflict_guard_stops_a_peaked_prior_from_silently_overriding_the_test(stack, dms):
    """Between the looseness and noisy-harmonics-sensor signatures there is a band where the test evidence alone points to the sensor fault but a
    peaked C1 prior still wins: the plain update is then 'confident looseness' (confidently wrong). The guard must flag exactly that."""
    m = dms["style_aware"].models["T1"]
    mu_l, mu_s = m.comps[Hy.LOOSENESS][0][0], m.comps[Hy.SENSOR_FAULT][1][0]
    prior = {h: 0.002 for h in HYPS}; prior[Hy.LOOSENESS] = 1 - 0.002 * (len(HYPS) - 1)
    P = Posterior(prior, 12)
    band, agree_flags = [], []
    for t in np.linspace(0, 1, 101):
        obs = (1 - t) * mu_s + t * mu_l
        plain, guarded = dms["style_aware"].update(P, "T1", obs), dms["guarded"].update(P, "T1", obs)
        assert guarded.probs == plain.probs and guarded.ood == plain.ood            # the guard never changes the probabilities
        if guarded.conflict:
            band.append((plain.label(), guarded.label()))
            assert guarded.label() == "conflicted"
            gi = GateInputs(False, 0.05, True, False, guarded, True, None, 0, 3, 1, 2)
            assert decide(gi).verdict != GateVerdict.ACT                              # the gate never acts on a conflicted posterior
        if t in (0.0, 1.0):
            agree_flags.append(guarded.conflict)
    assert any(pl == "confident" for pl, _ in band)                                   # the unguarded model WOULD have been confidently wrong here
    assert agree_flags == [False, False]                                              # evidence that agrees with the prior is never flagged


# ============================================================ pipeline integration (supervisor, authorization, aborts)
def build(stack, pred, hm=None, mode=Mode.SIMULATION, control_enabled=True, fault=None, sev=0.0, lim=LIM, sp=1800.0, warm=40, seed=1):
    det, tt, hm0, dm, _ = stack
    sim = MotorSim(seed)
    dev = SimDevice(sim, control_enabled=control_enabled)
    o = Orchestrator(dev, copy.deepcopy(det), copy.deepcopy(tt), hm or hm0, dm, copy.deepcopy(pred), SafetySupervisor(lim), Store(), PipelineConfig(), mode=mode)
    dev.send_line('{"id":9999,"type":"SET_SPEED","p":%g,"p2":0,"p3":0,"ttl":5000,"age":0,"seq":0,"k":"%s"}' % (sp, dev.key))
    dev.poll_lines()
    for _ in range(warm):
        o.step()
    if fault is not None:
        sim.inject(fault, sev)
    return o


def run_until(o, cond, n=1500):
    for _ in range(n):
        o.step()
        if cond(o):
            return True
    return False


def flat(stack):
    hm = copy.deepcopy(stack[2]); hm.temp = 1e6                                          # ambiguous posterior -> the gate asks for a test
    return hm


def test_c2_has_no_path_to_the_device():
    src = Path(c2r.__file__).read_text() + Path(c2r.__file__).with_name("prediction.py").read_text()
    for banned in ("ApprovedAction", "CommandDispatcher", "SafetySupervisor", "dispatch(", "send_line"):
        assert banned not in src, banned
    from torqva.api import create_router
    from torqva.auth import TokenAuth
    from torqva.service import SimulationService
    routes = [(r.path, sorted(getattr(r, "methods", None) or ())) for r in create_router(SimulationService(), TokenAuth([])).routes]
    assert not [p for p, m in routes if "predict" in p and "POST" in m]


def test_unsupported_prediction_blocks_the_action_and_is_recorded(stack, noise_aware, monkeypatch):
    o = build(stack, noise_aware, fault=Hy.IMBALANCE, sev=0.5)
    from torqva.prediction import Prediction
    real = o.pred.predict
    def unsupported(post, st, action, target_rpm=0.0, H=120):
        p = real(post, st, action, target_rpm, H); p.status, p.status_reasons = "unsupported", ["forced_for_test"]; return p
    monkeypatch.setattr(o.pred, "predict", unsupported)
    assert run_until(o, lambda x: any(l["kind"] == "c2_unsupported" for l in x.log), 600)
    assert not [c for c in o.records("command") if c["action"] in ("REDUCE_SPEED", "STOP") and c["counts_as_executed"]]
    docs = o.records("prediction")
    assert docs and all(d["status"] == "unsupported" and d["interval_method"] for d in docs)


def test_prediction_check_record_integrity(stack, noise_aware):
    o = build(stack, noise_aware, fault=Hy.IMBALANCE, sev=0.5)
    o.sup = SafetySupervisor(LIM)
    assert run_until(o, lambda x: len(x.incidents_done) >= 1, 1500)
    chk = [c for c in o.records("prediction_check")]
    assert chk, "an executed action must leave a predicted-vs-observed record"
    c = chk[0]
    assert c["prediction_provenance"] == "PREDICTED" and c["observation_provenance"] == "SIMULATED" and c["recovery_verdict"] is False
    assert c["validated_by_experiments"] is False and c["interval_method"] == "noise_aware_conformal"
    if c["comparison"] == "available":
        pred_doc = next(d for d in o.records("prediction") if d["action"] == c["action"])
        for row in c["rows"]:
            i = (30, 60, 120).index(row["horizon_s"])
            assert row["predicted"] == pytest.approx(pred_doc["mean_at_30_60_120"][row["signal"]][i])      # the stored prediction, unchanged
            assert row["lo"] == pytest.approx(pred_doc["lo_at_30_60_120"][row["signal"]][i])
            w = next(x for x in o.buf if abs(x.t - (c["predicted_at"] + row["horizon_s"])) <= 0.5)
            assert row["observed"] == pytest.approx(getattr(w, row["signal"])) and row["covered"] == (row["lo"] <= row["observed"] <= row["hi"])
    out = o.get("outcome", o.incidents_done[0].id)
    assert "observed" in out and out["outcome"] in ("RECOVERED", "UNRESOLVED", "INCONCLUSIVE", "HUMAN_INSPECTION_REQUIRED")      # a separate record


def test_a_prediction_comparison_exists_only_for_the_action_that_was_actually_executed(stack, noise_aware):
    from torqva.dispatch import CommandRecord
    from torqva.schemas import CommandStatus
    o = build(stack, noise_aware, warm=70)
    o._new_incident()
    st = StateSummary.from_windows(o.buf)
    pc = o.pred.predict(posterior(), st, "REDUCE_SPEED", 0.7 * st.setpoint, 120)
    o._pred_choice, o._predicted_at = pc, o.buf[-1].t - 60.0                              # 60 s have passed since the prediction
    def rec(action, status):
        c = CommandRecord(1, action, "SET_SPEED", {}, "x", "SIMULATION", 99.0, 5000); c.status = status; c.acked_at = o.now
        return c
    ok = rec(ActionType.REDUCE_SPEED, CommandStatus.COMPLETED)
    o._record_prediction_check(ok, True)
    c = o.get("prediction_check", o.inc.id)
    assert c["comparison"] == "available" and c["horizons_reached"] == [30, 60] and c["recovery_verdict"] is False
    assert c["observation_provenance"] == "SIMULATED" and len(c["rows"]) == 2 * len(SIGNALS)
    for executed, cmd in ((False, rec(ActionType.REDUCE_SPEED, CommandStatus.REJECTED)),         # refused by the device
                          (True, rec(ActionType.STOP, CommandStatus.COMPLETED)),                    # a different action ran (e.g. a safe-stop)
                          (False, None)):
        o._record_prediction_check(cmd, executed)
        c = o.get("prediction_check", o.inc.id)
        assert c["comparison"] == "none" and c["rows"] == [] and c["reason"] == "command_not_executed_or_different_action"


def start_test(stack, pred, **kw):
    o = build(stack, pred, hm=flat(stack), fault=Hy.LOOSENESS, sev=0.6, **kw)
    assert run_until(o, lambda x: x.test_running is not None, 1500), [l for l in o.log if l["kind"] == "gate"][-2:]
    return o


def test_mandatory_stop_during_a_diagnostic_test_aborts_it_without_a_diagnosis(stack, control):
    strict = SupervisorLimits(vib_rms_stop_g=2.0, max_rpm=3000.0, temp_stop_c=40.0)
    o = start_test(stack, control, lim=strict)
    n_res = len([l for l in o.log if l["kind"] == "test_result"])
    o.dev.sim.housing = 45.0                                                              # backend limit exceeded while the test runs
    o.step()
    assert any(c.action == ActionType.STOP for c in o.disp.records.values())             # STOP in the same step
    assert any(l["kind"] == "mandatory_stop" for l in o.log)
    for _ in range(60):
        o.step()
    assert len([l for l in o.log if l["kind"] == "test_result"]) == n_res                # no diagnosis was produced from the aborted test


def test_communication_loss_during_a_test_aborts_it_conservatively(stack, control):
    o = start_test(stack, control)
    n_res = len([l for l in o.log if l["kind"] == "test_result"])
    o.heartbeat_enabled = False
    for _ in range(12):
        o.step()
    assert o.dev.estop and o.dev.estop_reason == "HEARTBEAT_LOST"
    assert len([l for l in o.log if l["kind"] == "test_result"]) == n_res and o.test_running is None or o.inc.state in (S.EMERGENCY_STOP, S.CLOSED)


def test_lost_acks_make_a_test_time_out_and_record_an_abort_not_a_result(stack, control):
    o = build(stack, control, hm=flat(stack), fault=Hy.LOOSENESS, sev=0.6)
    o.dev.drop_acks = True
    assert run_until(o, lambda x: any(l["kind"] == "test_aborted" for l in x.log), 900)
    ab = next(l for l in o.log if l["kind"] == "test_aborted")
    assert ab["status"] in ("TIMEOUT", "EXPIRED", "ABORTED", "REJECTED")
    assert not any(l["kind"] == "test_result" for l in o.log[: o.log.index(ab)])
    assert not any(c["counts_as_executed"] for c in o.records("command") if c["action"] == "RUN_TEST")


def test_tests_need_the_supervisor_and_human_approval_in_hardware_mode(stack, control):
    o = build(stack, control, mode=Mode.HARDWARE, control_enabled=True, warm=5)
    ctx = o._ctx()
    t1 = {"test": 1, "fraction": 0.7, "hold_ms": 40000}
    d = o.sup.check(ProposedAction(action=ActionType.RUN_TEST, params=dict(t1), source=ProposalSource.GATE, role=Role.OPERATOR), ctx)
    assert d.approved is None                                                             # no approval -> nothing executable is minted
    llm = o.sup.check(ProposedAction(action=ActionType.RUN_TEST, params=dict(t1), source=ProposalSource.LLM, role=Role.ADMIN, human_approved=True), ctx)
    assert llm.approved is None and "llm_source_forbidden" in llm.reasons
    mand = o.sup.check(ProposedAction(action=ActionType.RUN_TEST, params=dict(t1), source=ProposalSource.HUMAN, role=Role.OPERATOR, human_approved=True),
                       type(ctx)(**{**ctx.__dict__, "housing_c": 99.0}))
    assert mand.approved is None and "mandatory_stop_active" in mand.reasons               # a test is refused while a mandatory stop is active


# ============================================================ regression: the opt-in variant runs the whole C1-C6 loop
def test_full_loop_with_the_noise_aware_predictor_still_recovers_through_the_supervisor(stack, noise_aware):
    o = build(stack, noise_aware, fault=Hy.IMBALANCE, sev=0.5)
    o.dev.sim.inject(Hy.IMBALANCE, 0.5, 1500.0)                                          # clears below 1500 rpm
    assert run_until(o, lambda x: len(x.incidents_done) >= 1, 1500)
    seq = [h[2] for h in o.incidents_done[0].history]
    for must in (S.INVESTIGATING, S.GATE_EVALUATION, S.ACTION_EVALUATION, S.COMMAND_SENT, S.VERIFYING_RECOVERY, S.CLOSED):
        assert must in seq, (must, seq)
    preds = o.records("prediction")
    assert preds and all("status" in p and p["_provenance"] == "PREDICTED" and p["validated_by_experiments"] is False for p in preds)
    cmds = [c for c in o.records("command") if c["action"] != "HEARTBEAT"]
    assert cmds and all(c["status"] for c in cmds)


# ============================================================ API
def test_evaluation_latest_returns_an_evaluation_run_not_other_study_artifacts():
    import hashlib as h
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from torqva.api import create_router
    from torqva.auth import TokenAuth
    from torqva.service import SimulationService
    ent = [{"sha256": h.sha256(b"v").hexdigest(), "user": "vera", "role": "viewer"}]
    app = FastAPI(); app.include_router(create_router(SimulationService(), TokenAuth(ent))); c = TestClient(app)
    H = {"Authorization": "Bearer v"}
    r = c.get("/api/torqva/evaluation/latest", headers=H).json()
    assert r["file"].startswith("eval_sim_run") and r["run"]["schema"].startswith("EvaluationRun") and "c1" in r["run"]
    s = c.get("/api/torqva/evaluation/c2c4", headers=H)
    assert s.status_code == 200
    j = s.json()
    assert j["data_provenance"] == "SIMULATED" and "not counterfactuals" in " ".join(j["limitations"]) and "noise_aware" in j["c2"] and j["test_specs"]["T1"]
    assert c.get("/api/torqva/evaluation/c2c4").status_code == 401 and c.get("/api/torqva/prediction-checks", headers=H).status_code == 200
