"""Phase 11: C4 likelihood calibration and C2 conditional coverage (SIMULATION ONLY).

Experimental variants stay opt-in. These tests check the calibration maths, that calibration cannot raise confidence, that conflicted / uncorroborated /
unfamiliar / aborted diagnostics never authorise an action, the conditional-interval construction and its explicit domain and sample rules, the trend-corrected
state (a separately evaluated point-prediction change), data-separation hygiene, and compatibility with the pipeline.
"""
import copy
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

import torqva.c2cov_study as cov
import torqva.c4cal_study as c4s
from torqva.c2_conditional import (DOMAIN_NOISE_RATIO, MIN_CLASS_N, ConditionalPredictor, RegimeGatedPredictor, weighted_quantile)
from torqva.c2_robust import NoiseAwarePredictor, build_noise_aware, make_case
from torqva.c4_robust import (CalibratedDiagnostics, ConflictGuard, StyleAwareDiagnosticsModel, chi2_sf_df3, classify_test_result, expected_calibration_error,
                              fit_joint_temperatures, fit_temperature, style_regime)
from torqva.diagnostics import run_test_on_sim
from torqva.gate import GateInputs, decide
from torqva.hypotheses import HYPS, Posterior
from torqva.incident import S
from torqva.pipeline import Orchestrator, PipelineConfig
from torqva.prediction import SIGNALS, InterventionPredictor, StateSummary
from torqva.schemas import GateVerdict, Hypothesis as Hy, Mode
from torqva.sim import REGIMES, MotorSim, Window
from torqva.simdevice import SimDevice
from torqva.store import Store
from torqva.supervisor import SafetySupervisor, SupervisorLimits

LIM = SupervisorLimits(vib_rms_stop_g=2.0, max_rpm=3000.0)


def post(top=Hy.LOOSENESS, p=0.9, **kw):
    probs = {h: (1 - p) / (len(HYPS) - 1) for h in HYPS}; probs[top] = p
    return Posterior(probs, 10, **kw)


@pytest.fixture(scope="module")
def sa(stack):
    m = StyleAwareDiagnosticsModel(); m.learn(stack[1], seeds=(1, 2)); return m


# ============================================================ C4 calibration maths
def test_chi_square_survival_function_matches_known_quantiles():
    assert chi2_sf_df3(0.0) == pytest.approx(1.0)
    assert chi2_sf_df3(7.814728) == pytest.approx(0.05, abs=1e-5)
    assert chi2_sf_df3(11.344867) == pytest.approx(0.01, abs=1e-5)
    assert chi2_sf_df3(16.266236) == pytest.approx(0.001, abs=1e-5)
    xs = np.linspace(0, 30, 61)
    assert all(chi2_sf_df3(a) >= chi2_sf_df3(b) for a, b in zip(xs, xs[1:]))                  # monotone


def test_temperature_fit_recovers_calibration_and_flags_overconfidence(sa):
    m = sa.models["T1"]
    rng = np.random.RandomState(7)
    ok, over = [], []
    for h in (Hy.LOOSENESS, Hy.SENSOR_FAULT, Hy.IMBALANCE):
        comps = m.comps[h]
        for _ in range(60):
            mu, var = comps[rng.randint(len(comps))]
            ok.append((mu + rng.randn(3) * np.sqrt(var), h))
            over.append((mu + rng.randn(3) * np.sqrt(var) * 4.0, h))                       # observations 4x more spread than the model believes
    T_ok, _ = fit_temperature(sa, ok)
    T_over, info = fit_temperature(sa, over)
    assert T_ok <= 1.5 and T_over > 3 * T_ok and info["nll_best"] < info["nll_at_T1"]


def test_joint_fit_flattens_an_overconfident_wrong_prior(sa):
    """A near-1.0 prior that is wrong half the time, combined with only moderately informative evidence, must get a large prior temperature; a calibrated prior must not."""
    m = sa.models["T1"]
    mu = {h: m.comps[h][0][0] for h in (Hy.LOOSENESS, Hy.SENSOR_FAULT)}
    rng = np.random.RandomState(3)
    def obs(truth):                                                                              # leans to the truth but is ambiguous (60/40 between the two signatures)
        other = Hy.SENSOR_FAULT if truth == Hy.LOOSENESS else Hy.LOOSENESS
        return 0.6 * mu[truth] + 0.4 * mu[other] + rng.randn(3) * 0.01
    bad, good = [], []
    for i in range(120):
        truth = Hy.LOOSENESS if i % 2 else Hy.SENSOR_FAULT
        wrong = Hy.SENSOR_FAULT if truth == Hy.LOOSENESS else Hy.LOOSENESS
        bad.append((post(wrong if i % 4 < 2 else truth, 1 - 1e-9), obs(truth), truth))        # confident prior, right only half the time
        good.append((post(truth, 0.6), obs(truth), truth))
    (Tp_bad, _), info_bad = fit_joint_temperatures(sa, bad)
    (Tp_good, _), _ = fit_joint_temperatures(sa, good)
    assert Tp_bad >= 5 and Tp_good < Tp_bad and info_bad["nll_best"] < info_bad["nll_at_1_1"]


def test_calibration_wrapper_never_raises_confidence_and_flattens_the_prior(sa):
    mu_l = sa.models["T1"].comps[Hy.LOOSENESS][0][0]
    obs = mu_l * 0.97
    prior = post(Hy.SENSOR_FAULT, 1 - 1e-9)                                                  # confidently wrong prior
    raw = CalibratedDiagnostics(sa, 1.0, None, True).update(prior, "T1", obs)
    cal = CalibratedDiagnostics(sa, 2.0, None, True, prior_temperature=20.0).update(prior, "T1", obs)
    assert sum(cal.probs.values()) == pytest.approx(1.0)
    assert max(cal.probs.values()) <= max(raw.probs.values()) + 1e-9 or cal.top != raw.top  # a flatter combination cannot be more extreme than the raw one
    assert cal.probs[Hy.LOOSENESS] > raw.probs[Hy.LOOSENESS]                                 # the test evidence now counts against the wrong prior


def test_goodness_of_fit_gate_marks_unfamiliar_outcomes_and_keeps_familiar_ones(sa):
    m = sa.models["T1"]
    mu = m.comps[Hy.LOOSENESS][0][0]
    familiar = CalibratedDiagnostics(sa, 1.0, 0.001).update(post(Hy.LOOSENESS, 0.9), "T1", mu)
    odd = CalibratedDiagnostics(sa, 1.0, 0.01).update(post(Hy.LOOSENESS, 0.9), "T1", np.array([2.0, -1.5, 0.11]))
    assert not familiar.ood
    assert odd.ood and odd.label() == "unfamiliar"


def test_uncorroborated_diagnoses_are_never_confident_and_the_gate_never_acts_on_them(sa):
    mu_s = sa.models["T1"].comps[Hy.SENSOR_FAULT][1][0]
    mu_l = sa.models["T1"].comps[Hy.LOOSENESS][0][0]
    obs = 0.5 * mu_s + 0.5 * mu_l                                                              # ambiguous evidence
    p = CalibratedDiagnostics(sa, 1.0, None, True, 0.70, 0.8).update(post(Hy.LOOSENESS, 0.999), "T1", obs)
    assert p.uncorroborated or p.conflict
    assert p.label() in ("uncorroborated", "conflicted")
    gi = GateInputs(False, 0.05, True, False, p, True, None, 0, 3, 1, 2)
    assert decide(gi).verdict != GateVerdict.ACT
    forced = Posterior(post(Hy.IMBALANCE, 0.99).probs, 12, False, False, True)
    assert forced.label() == "uncorroborated" and decide(GateInputs(False, 0.05, True, False, forced, True, None, 0, 3, 1, 2)).verdict != GateVerdict.ACT


def test_classification_never_counts_uncorroborated_or_unfamiliar_as_a_confident_error():
    prior = post(Hy.LOOSENESS, 0.9)
    wrong = Posterior(post(Hy.LOOSENESS, 0.95).probs, 10, False, False, True)
    r = classify_test_result(prior, wrong, Hy.SENSOR_FAULT)
    assert r["inconclusive"] and not r["confident_wrong"] and r["uncorroborated"]
    assert not classify_test_result(prior, Posterior(wrong.probs, 10, True), Hy.SENSOR_FAULT)["confident_wrong"]


def test_expected_calibration_error_basics():
    assert expected_calibration_error([0.9] * 10, [True] * 9 + [False]) == pytest.approx(0.0, abs=1e-9)
    assert expected_calibration_error([0.99] * 10, [True] * 5 + [False] * 5) == pytest.approx(0.49, abs=1e-9)
    assert np.isnan(expected_calibration_error([], []))


def test_calibrated_wrapper_is_compatible_with_the_pipeline_and_aborts_never_diagnose(stack, sa):
    det, tt, hm, dm, _ = stack
    wrapped = CalibratedDiagnostics(sa, 1.5, 0.001, True, 0.70, 0.6, 5.0)
    flat = copy.deepcopy(hm); flat.temp = 1e6
    pred = InterventionPredictor(); pred.fit(tt)
    sim = MotorSim(1)
    dev = SimDevice(sim, control_enabled=True)
    o = Orchestrator(dev, copy.deepcopy(det), copy.deepcopy(tt), flat, wrapped, pred, SafetySupervisor(LIM), Store(), PipelineConfig(), mode=Mode.SIMULATION)
    dev.send_line('{"id":9999,"type":"SET_SPEED","p":1800,"p2":0,"p3":0,"ttl":5000,"age":0,"seq":0,"k":"%s"}' % dev.key)
    dev.poll_lines()
    for _ in range(40):
        o.step()
    sim.inject(Hy.LOOSENESS, 0.6)
    n_res = 0
    for _ in range(1500):
        o.step()
        if o.test_running is not None:
            break
    assert o.test_running is not None, "the wrapper must still allow a test to be proposed and run"
    o.dev.drop_acks = False
    o.heartbeat_enabled = False                                                              # communication loss during the test
    for _ in range(12):
        o.step()
    assert not any(l["kind"] == "test_result" for l in o.log) and (o.dev.estop or o.inc.state in (S.EMERGENCY_STOP, S.CLOSED))


# ============================================================ C2 conditional intervals
def test_weighted_quantile_follows_the_weights():
    v = np.array([1.0, 2.0, 3.0, 4.0])
    assert weighted_quantile(v, np.full(4, 0.25), 0.5) == 2.0
    assert weighted_quantile(v, np.array([0.7, 0.1, 0.1, 0.1]), 0.5) == 1.0
    assert weighted_quantile(v, np.array([0.01, 0.01, 0.01, 0.97]), 0.9) == 4.0


def ramp_windows(slope, n=40, h0=30.0):
    ws = []
    for i in range(n):
        ws.append(Window(float(i), 1650.0, 1650.0, True, 36.0, 23.5, 1.3, 30.0, h0 + slope * i, 22.0, 0.07, 0.06, 0.015, 0.007, 0.01))
    return ws


def test_state_trend_and_lag_correction_remove_the_housing_bias(stack):
    ws = ramp_windows(0.05)
    st = StateSummary.from_windows(ws)
    assert st.trend["housing"] == pytest.approx(0.05, abs=1e-9)
    assert st.housing == pytest.approx(ws[-1].housing - 0.05 * 4.5, abs=1e-9)               # the 10-window mean lags the last window by 4.5 s x slope
    base = InterventionPredictor(); base.fit(stack[1])
    tc = ConditionalPredictor.from_fitted(base, trend_state=True)
    assert tc.corrected_state(st).housing == pytest.approx(ws[-1].housing, abs=1e-9)
    assert ConditionalPredictor.from_fitted(base).corrected_state(st).housing == st.housing   # off by default: the point prediction is unchanged
    assert StateSummary.from_windows(ws[:4]).trend is None                                    # too few windows: no trend


@pytest.fixture(scope="module")
def conditional(stack):
    det, tt, hm, dm, _ = stack
    base = InterventionPredictor(); base.fit(tt)
    cases = [make_case(h, sev, 7_300_000 + i, sp, REGIMES["baseline"], det, tt, hm) for i, (h, sev, sp) in
             enumerate((h, sev, sp) for h in HYPS for sev in (0.3, 0.6, 0.9) for sp in (1350, 1950) for _ in range(6))]
    tuples, labels = cov.cal_tuples(cases)
    cp = ConditionalPredictor.from_fitted(base, class_conditional=True); cp.calibrate(tuples, labels)
    return base, cp, cases


def test_class_conditional_calibration_needs_labels_and_reports_class_counts(conditional):
    base, cp, cases = conditional
    assert set(cp.class_sample_counts()) == {h.value for h in HYPS} and all(n >= MIN_CLASS_N for n in cp.class_sample_counts().values())
    with pytest.raises(AssertionError):
        ConditionalPredictor.from_fitted(base, class_conditional=True).calibrate(cov.cal_tuples(cases[:2])[0])


def test_interval_follows_the_posterior_weighted_class_residuals(conditional):
    base, cp, cases = conditional
    st = cases[0]["st"]
    widths = {}
    for h in HYPS:
        p = cp.predict(post(h, 0.999), st, "CONTINUE_MONITORING", 0.0, 120)
        widths[h] = float((p.hi["housing"] - p.lo["housing"]).mean())
    assert max(widths.values()) > 1.3 * min(widths.values())                                  # different classes get different intervals (that is the point)
    mix = cp.predict(post(Hy.OVERLOAD, 0.5), st, "CONTINUE_MONITORING", 0.0, 120)
    assert cp.predict(post(Hy.OVERLOAD, 0.999), st, "CONTINUE_MONITORING", 0.0, 120).interval_method == "conformal[class_conditional]"
    assert mix.status in ("supported", "insufficiently_validated")


def test_thin_classes_fall_back_to_pooled_residuals_and_are_labelled(conditional):
    base, cp, cases = conditional
    thin = copy.deepcopy(cp)
    thin.min_class_n = 10_000
    st = cases[0]["st"]
    p = thin.predict(post(Hy.OVERLOAD, 0.99), st, "STOP", 0.0, 120)
    assert p.status == "insufficiently_validated" and any("class_conditional_calibration_below" in r for r in p.status_reasons)
    pooled = NoiseAwarePredictor.from_fitted(base)
    pooled.calibrate(cov.cal_tuples(cases)[0])
    q = pooled.predict(post(Hy.OVERLOAD, 0.99), st, "STOP", 0.0, 120)
    assert np.allclose(p.hi["housing"] - p.mean["housing"], q.hi["housing"] - q.mean["housing"], atol=0.05)     # same pooled quantile


def test_conditional_intervals_are_declared_insufficiently_validated_and_untrusted_beyond_the_noise_domain(conditional):
    base, cp, cases = conditional
    c = cases[0]
    nom = {s: cp._nominal(s, c["st"]) for s in SIGNALS}
    inside = copy.deepcopy(c["st"]); inside.noise = {s: 1.3 * v for s, v in nom.items()}
    assert cp.noise_ratio_robust(inside) == pytest.approx(1.3) and cp.noise_ratio_robust(c["st"]) < 1.75
    outside = copy.deepcopy(c["st"]); outside.noise = {s: 2.0 * v for s, v in nom.items()}
    assert DOMAIN_NOISE_RATIO == 1.75
    assert cp.predict(c["post"], inside, "STOP", 0.0, 120).status in ("supported", "insufficiently_validated")
    assert cp.trust(c["post"], True, st=inside).trusted or "conditional_calibration_domain_exceeded" not in cp.trust(c["post"], True, st=inside).reasons
    p = cp.predict(c["post"], outside, "STOP", 0.0, 120)
    assert p.status == "insufficiently_validated" and any("conditional_calibration_domain_exceeded" in r for r in p.status_reasons)
    t = cp.trust(c["post"], True, st=outside)
    assert not t.trusted and "conditional_calibration_domain_exceeded" in t.reasons          # the gate cannot act on it
    shipped_like = NoiseAwarePredictor.from_fitted(base)
    shipped_like.calibrate(cov.cal_tuples(cases)[0])
    assert shipped_like.predict(c["post"], outside, "STOP", 0.0, 120).status == "supported"  # Phase 10 variant unchanged by the new rule


def test_regime_gated_predictor_labels_its_fallback(conditional):
    base, cp, cases = conditional
    g = RegimeGatedPredictor.from_fitted(base, trend_state=True, class_conditional=True)
    tuples, labels = cov.cal_tuples(cases)
    g.calibrate(tuples, labels)
    fb = NoiseAwarePredictor.from_fitted(base); fb.calibrate(tuples); g.attach_fallback(fb)
    c = cases[0]
    out = copy.deepcopy(c["st"]); out.noise = {s: 2.0 * g._nominal(s, c["st"]) for s in SIGNALS}
    p = g.predict(c["post"], out, "STOP", 0.0, 120)
    assert "pooled fallback" in p.interval_method and p.status_reasons[0].startswith("conditional_calibration_domain_exceeded")
    assert "pooled fallback" not in g.predict(c["post"], c["st"], "STOP", 0.0, 120).interval_method


# ============================================================ data separation hygiene
def test_c4_and_c2_study_seeds_are_unique_disjoint_and_unseen_before():
    c4s.assert_seed_hygiene(); cov.assert_seed_hygiene()
    for mod, parts, sets in ((c4s, c4s.BASES, lambda p: c4s.all_seeds(p, c4s.RNAMES, c4s.HYPS)), (cov, cov.BASES, lambda p: cov.seeds_of(p, cov.RNAMES))):
        allv = [x for p in parts for x in sets(p)]
        assert len(allv) == len(set(allv))                                                   # no seed reused across partitions, regimes, faults or severities
    from torqva.c2c4_study import EARLIER_SEEDS
    all_c4 = set().union(*[set(c4s.all_seeds(p, c4s.RNAMES, c4s.HYPS)) for p in c4s.BASES])
    all_c2 = set().union(*[set(cov.seeds_of(p, cov.RNAMES)) for p in cov.BASES])
    assert not (all_c4 | all_c2) & EARLIER_SEEDS and not all_c4 & all_c2


def test_calibration_uses_only_calibration_partition_and_test_is_fresh():
    import ast, inspect, textwrap
    for fn, banned in ((c4s.stage_validate, "TEST"), (c4s.collect_calibration, "TEST"), (cov.stage_validate, "TEST"), (cov._prepare, "TEST")):
        tree = ast.parse(textwrap.dedent(inspect.getsource(fn)))
        for node in ast.walk(tree):
            if isinstance(node, ast.Call) and getattr(node.func, "id", "") in ("make_sessions", "make_cases", "collect_calibration"):
                names = {n.id for n in ast.walk(node) if isinstance(n, ast.Name)}
                consts = {n.value for n in ast.walk(node) if isinstance(n, ast.Constant) and isinstance(n.value, str)}
                assert not [x for x in names if banned in x] and not [x for x in consts if x.startswith(banned)], (fn.__name__, names, consts)
    assert set(c4s.CAL_REGIMES).isdisjoint(c4s.VAL_REGIMES) and not set(c4s.VAL_REGIMES) & set(c4s.TEST_REGIMES)
    assert {c4s.DOMAIN[r] for r in c4s.TEST_REGIMES} == {"in-domain", "novel-level", "unseen-style"}              # test regimes are labelled by how far they extrapolate


def test_final_stages_refuse_without_a_frozen_selection(monkeypatch, tmp_path):
    monkeypatch.setattr(c4s, "SELECTION_FILE", str(tmp_path / "a.json"))
    monkeypatch.setattr(cov, "SELECTION_FILE", str(tmp_path / "b.json"))
    for fn in (c4s.stage_final, cov.stage_final, cov.stage_final_v2):
        with pytest.raises(SystemExit):
            fn()


def test_opt_in_variants_are_not_the_default_and_unknown_names_are_rejected():
    from torqva.evaluation import build_models
    from torqva.service import SimulationService
    assert SimulationService().c2_variant == "control"
    with pytest.raises(ValueError):
        build_models("no_such_variant")


def test_conditional_variant_runs_the_full_loop_through_the_supervisor(stack):
    det, tt, hm, dm, _ = stack
    base = InterventionPredictor(); base.fit(tt)
    cases = [make_case(h, sev, 7_400_000 + i, 1800, REGIMES["baseline"], det, tt, hm) for i, (h, sev) in enumerate((h, sev) for h in HYPS for sev in (0.4, 0.8) for _ in range(8))]
    tuples, labels = cov.cal_tuples(cases)
    cp = ConditionalPredictor.from_fitted(base, class_conditional=True, trend_state=True); cp.calibrate(tuples, labels)
    sim = MotorSim(1)
    dev = SimDevice(sim, control_enabled=True)
    o = Orchestrator(dev, copy.deepcopy(det), copy.deepcopy(tt), hm, dm, cp, SafetySupervisor(LIM), Store(), PipelineConfig(), mode=Mode.SIMULATION)
    dev.send_line('{"id":9999,"type":"SET_SPEED","p":1800,"p2":0,"p3":0,"ttl":5000,"age":0,"seq":0,"k":"%s"}' % dev.key)
    dev.poll_lines()
    for _ in range(40):
        o.step()
    sim.inject(Hy.IMBALANCE, 0.5, 1500.0)
    for _ in range(1500):
        o.step()
        if o.incidents_done:
            break
    assert o.incidents_done
    preds = o.records("prediction")
    assert preds and all("status" in p and p["validated_by_experiments"] is False and p["_provenance"] == "PREDICTED" for p in preds)
    assert [c for c in o.records("command") if c["action"] != "HEARTBEAT"]                  # actions still go only through the supervisor
