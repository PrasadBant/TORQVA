"""Phase 10 - C2 interval quality and C4 diagnostic-test value (SIMULATION ONLY; simulator uncalibrated; no measured data).

    python -m torqva.c2c4_study validate     # all selection on VALIDATION sessions/regimes only -> docs/eval/c2c4_phase10_selection.json
    python -m torqva.c2c4_study final        # one run on held-out TEST sessions/regimes with the frozen selection

Matched-condition design (not "the same physical run"): every case is a simulated run at a given fault class/severity/seed/speed/regime;
the three candidate actions are rolled out from IDENTICAL starting conditions by forking the simulator, so predicted and observed outcomes
for chosen and non-chosen actions are comparable. This is a property of the simulator; a real motor cannot be forked.

Splits (session = seed): CAL fits conformal calibration; VAL chooses between variants; TEST is used once. Seeds are disjoint from every
earlier phase and from each other (asserted). The shipped control keeps its own shipped calibration; `control_recal` is the same code
re-calibrated on CAL so that "more calibration data" is separated from "a better method".
"""
from __future__ import annotations

import argparse
import copy
import gzip
import hashlib
import io
import json
import os
from typing import Dict, List, Optional, Sequence, Tuple

import numpy as np

from .c1_study import wilson
from .c2_robust import (CAL_SEEDS, CAL_SPEEDS, CAL_SEV, FAMILIAR_STATUS as FAMILIAR, MIN_CELL_N, NoiseAwarePredictor, PersistenceConformalPredictor,
                        PREDICTION_TARGETS, make_case)
from .c4_robust import (LOOSENESS_STYLES, SENSOR_STYLES, TEST_SPECS, ConflictGuard, StyleAwareDiagnosticsModel, classify_test_result, style_regime)
from .detection import ThermalTracker
from .diagnostics import run_test_on_sim
from .evaluation import build_models
from .hypotheses import HYPS, Posterior
from .prediction import ACTIONS as ACT_FRAC_UNUSED, CHECK_HORIZONS, NOISE_FLOOR, SIGNALS, InterventionPredictor, StateSummary
from .scenarios import ACTIONS, posterior_from
from .schemas import Hypothesis
from .sim import REGIMES, MotorSim, Regime, rollout

DOCS_EVAL = os.path.join(os.path.dirname(__file__), "..", "..", "docs", "eval")
SELECTION_FILE = os.path.join(DOCS_EVAL, "c2c4_phase10_selection.json")

VAL_SEEDS, VAL_SPEEDS, VAL_SEV = tuple(range(9701, 9704)), (1500, 2000), (0.4, 0.8)
TEST_SEEDS, TEST_SPEEDS, TEST_SEV = tuple(range(9801, 9807)), (1350, 1650, 1950), (0.3, 0.6, 0.9)
C4_VAL_SEEDS, C4_TEST_SEEDS, C4_TEST2_SEEDS = tuple(range(9911, 9919)), tuple(range(9921, 9933)), tuple(range(9941, 9953))
C4_SEVS, C4_SPEEDS = (0.3, 0.6, 0.9), (1500, 1950)
EARLIER_SEEDS = {0, 101, 102, 11, 12, 21, 22, 700, 701, 702, 800, 801, 802, 900, 1000, 1001, 1002, 1003, 1101, 1102, 1103,
                 *range(201, 206), *range(301, 304), *range(401, 404), *range(501, 506), *range(601, 604), *range(701, 711),
                 8001, 8002, 8101, 8102, 8103, 8201, 8202, *range(8301, 8307), *range(9001, 9004), *range(9101, 9107), *range(9201, 9213),
                 *range(9301, 9310), 9501, 9502}
VAL_REGIMES = {"baseline": REGIMES["baseline"], "noise_x1.5": Regime("noise_x1.5", noise_mult=1.5), "session_shift": REGIMES["session_shift"]}
TEST_REGIMES = {"baseline": REGIMES["baseline"], "noisy": REGIMES["noisy"], "session_shift": REGIMES["session_shift"],
                "confusable_sensor": REGIMES["confusable_sensor"], "intermittent": REGIMES["intermittent"], "hard": REGIMES["hard"],
                "noise_x3": Regime("noise_x3", noise_mult=3.0), "unfamiliar_speed_2400": REGIMES["baseline"]}
TEST_REGIME_SPEEDS = {"unfamiliar_speed_2400": (2400,)}


# =============================================================================================== C2
def make_cases(regimes: Dict[str, Regime], seeds, speeds, sevs, det, tt, hm, speeds_by_regime=None) -> List[Dict]:
    out = []
    for rn, rg in regimes.items():
        for h in HYPS:
            for sev in sevs:
                for sd in seeds:
                    for sp in (speeds_by_regime or {}).get(rn, speeds):
                        c = make_case(h, sev, sd, sp, rg, det, tt, hm)
                        c["regime"] = rn
                        out.append(c)
    return out


def cal_tuples(cases):
    return [(c["st"], c["post"], a["action"], a["target"], a["truth"]) for c in cases for a in c["acts"]]


def prepare_predictors(det, tt, hm, pred):
    cal = make_cases({"baseline": REGIMES["baseline"]}, CAL_SEEDS, CAL_SPEEDS, CAL_SEV, det, tt, hm)
    tuples = cal_tuples(cal)
    control = pred                                           # the shipped predictor, exactly as shipped
    control_recal = copy.deepcopy(pred); control_recal.q = {}; control_recal.calibrate(tuples)
    noise_aware = NoiseAwarePredictor.from_fitted(pred); noise_aware.calibrate(tuples)
    persist = PersistenceConformalPredictor.from_fitted(pred); persist.calibrate(tuples)
    return {"control": control, "control_recal": control_recal, "persistence_conformal": persist, "noise_aware": noise_aware}, len(cal)


def evidence_coverage(preds: Dict, val_baseline_cases) -> None:
    """Fill each predictor's per-cell coverage (used only by trust()) from VALIDATION baseline cases, never from test data."""
    t = cal_tuples(val_baseline_cases)
    for P in preds.values():
        if hasattr(P, "evaluate_coverage"):
            P.evaluate_coverage(t)


def score_cases(P, cases, label: str) -> List[Tuple]:
    """Rows: (regime, fault, sev, speed, seed, action, signal, h, y, mean, lo, hi, persist, status, trusted, op_fam) using the intervals predict() returns."""
    rows = []
    for c in cases:
        st, post = c["st"], c["post"]
        trusted_flag = P.trust(post, c["op_fam"], st=st).trusted if hasattr(P, "trust") else True
        for a in c["acts"]:
            p = P.predict(post, st, a["action"], a["target"], 120)
            for s in SIGNALS:
                for h in CHECK_HORIZONS:
                    y = float(getattr(a["truth"][h - 1], s))
                    rows.append((c["regime"], c["h"].value, c["sev"], c["sp"], c["seed"], a["action"], s, h, y, float(p.mean[s][h - 1]),
                                 float(p.lo[s][h - 1]), float(p.hi[s][h - 1]), float(getattr(st, s)), p.status, trusted_flag, c["op_fam"]))
    return rows


def _agg(rows: Sequence[Tuple]) -> Dict:
    if not rows:
        return {"n": 0}
    R = np.array([[r[8], r[9], r[10], r[11], r[12]] for r in rows], dtype=float)
    y, m, lo, hi, per = R.T
    sc = np.array([2 * NOISE_FLOOR[r[6]] for r in rows])
    cov = (y >= lo) & (y <= hi)
    k, n = int(cov.sum()), len(rows)
    width = (hi - lo) / sc
    iscore = ((hi - lo) + (2 / 0.1) * np.maximum(lo - y, 0) + (2 / 0.1) * np.maximum(y - hi, 0)) / sc
    ok = np.array([r[13] == "supported" for r in rows]); trusted = np.array([bool(r[14]) for r in rows])
    out = {"n": n, "coverage": k / n, "coverage_ci95": wilson(k, n), "mean_width_norm": float(width.mean()), "median_width_norm": float(np.median(width)),
           "interval_score_norm": float(iscore.mean()), "mae_model": float(np.mean(np.abs(y - m))), "mae_persistence": float(np.mean(np.abs(y - per))),
           "status_supported_frac": float(ok.mean()), "trusted_frac": float(trusted.mean())}
    if trusted.any():
        kt = int(cov[trusted].sum()); out["coverage_when_trusted"] = kt / int(trusted.sum()); out["coverage_when_trusted_ci95"] = wilson(kt, int(trusted.sum()))
    return out


def summarize(rows: Sequence[Tuple]) -> Dict:
    out = {"overall": _agg(rows), "by_regime": {}}
    for rg in dict.fromkeys(r[0] for r in rows):
        rr = [r for r in rows if r[0] == rg]
        e = {"overall": _agg(rr), "by_action": {a: _agg([r for r in rr if r[5] == a]) for a, _ in ACTIONS},
             "by_signal": {s: _agg([r for r in rr if r[6] == s]) for s in SIGNALS},
             "by_fault": {h.value: _agg([r for r in rr if r[1] == h.value]) for h in HYPS},
             "by_severity": {str(v): _agg([r for r in rr if r[2] == v]) for v in sorted({r[2] for r in rr})}}
        cells = {}
        for a, _ in ACTIONS:
            for s in SIGNALS:
                for h in CHECK_HORIZONS:
                    g = [r for r in rr if r[5] == a and r[6] == s and r[7] == h]
                    k = sum(r[10] <= r[8] <= r[11] for r in g)
                    cells[f"{a}/{s}/{h}"] = {"n": len(g), "coverage": k / max(len(g), 1), "ci95": wilson(k, len(g))}
        e["worst_cells"] = dict(sorted(cells.items(), key=lambda kv: kv[1]["coverage"])[:5])
        e["worst_cell_coverage"] = min(c["coverage"] for c in cells.values())
        out["by_regime"][rg] = e
    return out


def stage_validate() -> Dict:
    assert not (set(CAL_SEEDS) | set(VAL_SEEDS) | set(TEST_SEEDS) | set(C4_VAL_SEEDS) | set(C4_TEST_SEEDS) | set(C4_TEST2_SEEDS)) & EARLIER_SEEDS, "seed overlap with earlier phases"
    groups = [set(CAL_SEEDS), set(VAL_SEEDS), set(TEST_SEEDS), set(C4_VAL_SEEDS), set(C4_TEST_SEEDS), set(C4_TEST2_SEEDS)]
    assert all(not (a & b) for i, a in enumerate(groups) for b in groups[i + 1:]), "split seeds overlap"
    det, tt, hm, dm, pred, _ = build_models()
    preds, n_cal = prepare_predictors(det, tt, hm, pred)
    val = make_cases(VAL_REGIMES, VAL_SEEDS, VAL_SPEEDS, VAL_SEV, det, tt, hm)
    evidence_coverage(preds, [c for c in val if c["regime"] == "baseline"])
    c2 = {k: summarize(score_cases(P, val, k)) for k, P in preds.items()}
    # ----- C2 selection rule (written down before the test is touched)
    ctl, cand = c2["control_recal"], c2["noise_aware"]
    reg = list(VAL_REGIMES)
    worst = lambda S: min(S["by_regime"][r]["overall"]["coverage"] for r in reg)
    meanscore = lambda S: float(np.mean([S["by_regime"][r]["overall"]["interval_score_norm"] for r in reg]))
    trusted = lambda S: S["by_regime"]["baseline"]["overall"]["trusted_frac"]
    sel_c2 = {"rule": "adopt noise_aware iff (worst per-regime VALIDATION coverage >= control_recal's) AND (mean normalised interval score <= control_recal's) AND "
                      "(baseline-regime trusted fraction >= control_recal's - 0.05: a predictor that abstains everywhere is not an improvement); else keep the control",
              "baseline_trusted_frac": {"control_recal": trusted(ctl), "noise_aware": trusted(cand)},
              "worst_regime_coverage": {"control_recal": worst(ctl), "noise_aware": worst(cand)},
              "mean_interval_score": {"control_recal": meanscore(ctl), "noise_aware": meanscore(cand)}}
    sel_c2["adopt_noise_aware"] = bool(worst(cand) >= worst(ctl) and meanscore(cand) <= meanscore(ctl) and trusted(cand) >= trusted(ctl) - 0.05)
    # ----- C4 selection
    c4 = c4_validate(det, tt, hm, dm)
    c4v2 = c4_v2_validate(det, tt, hm, dm)
    sel = {"stage": "validation", "seeds": {"cal": CAL_SEEDS, "val": VAL_SEEDS, "c4_val": C4_VAL_SEEDS}, "n_cal_cases": n_cal,
           "c2_val": {k: {r: summarize_small(v["by_regime"][r]["overall"]) for r in reg} for k, v in c2.items()}, "c2_selection": sel_c2,
           "c4_val": c4["val"], "c4_selection": c4["selection"], "c4_v2_val": {"realistic": c4v2["realistic"], "pair": c4v2["pair"]},
           "c4_v2_selection": c4v2["selection"]}
    os.makedirs(DOCS_EVAL, exist_ok=True)
    with open(SELECTION_FILE, "w") as f:
        json.dump(sel, f, indent=1, default=float)
    return sel


def summarize_small(a: Dict) -> Dict:
    return {k: (round(v, 4) if isinstance(v, float) else v) for k, v in a.items() if k in ("n", "coverage", "mean_width_norm", "interval_score_norm", "mae_model", "trusted_frac")}


# =============================================================================================== C4
FOCUS_PAIRS = {"T1": [(Hypothesis.IMBALANCE, Hypothesis.LOOSENESS), (Hypothesis.LOOSENESS, Hypothesis.SENSOR_FAULT), (Hypothesis.IMBALANCE, Hypothesis.SENSOR_FAULT)],
               "T3": [(Hypothesis.OVERLOAD, Hypothesis.COOLING_FAILURE)], "T4": [(Hypothesis.OVERLOAD, Hypothesis.COOLING_FAILURE)]}
C4_REGIMES = {"baseline(stuck)": style_regime("stuck", "steady"), "confusable_sensor(noisy-harmonics)": style_regime("noisy_harmonics", "steady"),
              "intermittent(held-out style)": style_regime("intermittent", "intermittent"), "noisy x2": style_regime("stuck", "steady", 2.0),
              "session_shift": style_regime("stuck", "steady", 1.0, True), "hard": style_regime("noisy_harmonics", "intermittent", 2.0, True)}
C4_VAL_REGIMES = ("baseline(stuck)", "confusable_sensor(noisy-harmonics)")


def pair_cases(dm_variants: Dict, tt, test: str, a: Hypothesis, b: Hypothesis, regime: Regime, seeds, setspeeds=C4_SPEEDS, sevs=C4_SEVS) -> Dict[str, List[Dict]]:
    prior = {h: 0.0 for h in HYPS}; prior[a] = prior[b] = 0.5
    P0 = Posterior(prior, 10)
    out = {k: [] for k in dm_variants}
    for truth in (a, b):
        for sev in sevs:
            for sd in seeds:
                for sp in setspeeds:
                    sim = MotorSim(sd, regime=regime)
                    sim.set_setpoint(sp); sim.run(60 if test != "T3" else 200); sim.inject(truth, sev)
                    obs, _ = run_test_on_sim(sim, test, tt)
                    for k, dm in dm_variants.items():
                        out[k].append(classify_test_result(P0, dm.update(P0, test, obs), truth))
    return out


def _c4_agg(rs: List[Dict]) -> Dict:
    n = len(rs)
    acc = sum(r["top1_after"] for r in rs)
    cw = sum(r["confident_wrong"] for r in rs)
    k = lambda e: sum(r["effect"] == e for r in rs)
    return {"n": n, "accuracy_after": acc / n, "accuracy_ci95": wilson(acc, n), "accuracy_no_test": 0.5, "improved": k("improved") / n,
            "unchanged": k("unchanged") / n, "worsened": k("worsened") / n, "inconclusive": sum(r["inconclusive"] for r in rs) / n,
            "out_of_distribution": sum(r["ood"] for r in rs) / n, "confident_wrong": cw / n}


def build_c4_variants(tt, dm):
    sa = StyleAwareDiagnosticsModel(("stuck", "noisy_harmonics"), ("steady",)); sa.learn(tt, seeds=(1, 2))
    allstyles = StyleAwareDiagnosticsModel(SENSOR_STYLES, LOOSENESS_STYLES); allstyles.learn(tt, seeds=(1, 2))
    return {"control": dm, "style_aware": sa, "style_aware_all_styles(upper bound)": allstyles}


def c4_validate(det, tt, hm, dm) -> Dict:
    V = build_c4_variants(tt, dm)
    res = {}
    for rn in C4_VAL_REGIMES:
        a, b = Hypothesis.LOOSENESS, Hypothesis.SENSOR_FAULT
        cs = pair_cases({k: V[k] for k in ("control", "style_aware")}, tt, "T1", a, b, C4_REGIMES[rn], C4_VAL_SEEDS)
        res[rn] = {k: _c4_agg(v) for k, v in cs.items()}
    ok = all(res[r]["style_aware"]["accuracy_after"] >= res[r]["control"]["accuracy_after"] - 0.02 for r in C4_VAL_REGIMES) and \
        res["confusable_sensor(noisy-harmonics)"]["style_aware"]["accuracy_after"] > res["confusable_sensor(noisy-harmonics)"]["control"]["accuracy_after"] \
        and all(res[r]["style_aware"]["confident_wrong"] <= res[r]["control"]["confident_wrong"] + 0.02 for r in C4_VAL_REGIMES)
    return {"val": res, "selection": {"rule": "adopt style_aware iff, on VALIDATION looseness-vs-sensor T1 cases in both the stuck and noisy-harmonics regimes, accuracy >= control - 0.02, "
                                      "strictly better in the noisy-harmonics regime, and confident-wrong rate <= control + 0.02", "adopt_style_aware": bool(ok)}}


def c4_final(det, tt, hm, dm) -> Dict:
    V = build_c4_variants(tt, dm)
    out = {"focus": {}, "matrix_baseline": {}, "realistic_T1": {}}
    for test, pairs in FOCUS_PAIRS.items():
        for a, b in pairs:
            for rn, rg in C4_REGIMES.items():
                cs = pair_cases(V, tt, test, a, b, rg, C4_TEST_SEEDS)
                out["focus"][f"{test}|{a.value}-vs-{b.value}|{rn}"] = {k: _c4_agg(v) for k, v in cs.items()}
    # discrimination matrix: every pair x every test in the baseline regime (separation, 50/50 prior)
    for test in ("T1", "T3", "T4"):
        for i, a in enumerate(HYPS):
            for b in HYPS[i + 1:]:
                cs = pair_cases({"control": V["control"]}, tt, test, a, b, C4_REGIMES["baseline(stuck)"], C4_TEST_SEEDS[:4], C4_SPEEDS[:1], (0.6,))
                g = _c4_agg(cs["control"])
                out["matrix_baseline"][f"{test}|{a.value}-vs-{b.value}"] = {"accuracy_after": g["accuracy_after"], "inconclusive": g["inconclusive"], "n": g["n"]}
    # realistic: pre-test posterior from C1 evidence in flagged sessions, then T1 (looseness / sensor fault only), vs the no-test decision
    from .scenarios import warm_session
    for rn in ("baseline(stuck)", "confusable_sensor(noisy-harmonics)", "intermittent(held-out style)", "noisy x2", "hard"):
        rg = C4_REGIMES[rn]
        rows = {k: [] for k in V}
        for truth in (Hypothesis.LOOSENESS, Hypothesis.SENSOR_FAULT):
            for sev in C4_SEVS:
                for sd in C4_TEST_SEEDS[:6]:
                    sim = MotorSim(sd, regime=rg); sim.set_setpoint(1650); sim.run(60); sim.inject(truth, sev)
                    pre = sim.run(40)
                    tt.reset(pre[0].housing); zs = []
                    for w in pre:
                        tt.update(w); sc = det.score(w)
                        if sc.anomalous and sc.z is not None:
                            zs.append(sc.z)
                    if len(zs) < 8:
                        continue
                    P0 = hm.posterior(zs[-15:])
                    obs, _ = run_test_on_sim(sim, "T1", tt)
                    for k, dm_ in V.items():
                        rows[k].append(classify_test_result(P0, dm_.update(P0, "T1", obs), truth))
        out["realistic_T1"][rn] = {k: ({**_c4_agg(v), "no_test_top1": float(np.mean([r["top1_before"] for r in v])), "flagged_sessions": len(v)} if v else {"n": 0}) for k, v in rows.items()}
    return out


# ------------------------------------------------------------------ C4 v2 (conflict guard), designed AFTER the v1 test showed confident-wrong results
C4_V2_VAL_REGIMES = {"baseline(stuck)": C4_REGIMES["baseline(stuck)"], "confusable_sensor(noisy-harmonics)": C4_REGIMES["confusable_sensor(noisy-harmonics)"],
                     "noisy x1.5": style_regime("stuck", "steady", 1.5), "noisy-harmonics x1.5": style_regime("noisy_harmonics", "steady", 1.5)}


def build_c4_variants_v2(tt, dm):
    sa = StyleAwareDiagnosticsModel(("stuck", "noisy_harmonics"), ("steady",)); sa.learn(tt, seeds=(1, 2))
    return {"control": dm, "control_guarded": ConflictGuard(dm), "style_aware": sa, "style_aware_guarded": ConflictGuard(sa)}


def c4_realistic(V: Dict, det, tt, hm, regimes: Dict[str, Regime], seeds, sevs=C4_SEVS) -> Dict:
    """Pre-test posterior from C1 evidence in flagged looseness / sensor-fault sessions, then T1; compared with the no-test decision."""
    out = {}
    for rn, rg in regimes.items():
        rows = {k: [] for k in V}
        for truth in (Hypothesis.LOOSENESS, Hypothesis.SENSOR_FAULT):
            for sev in sevs:
                for sd in seeds:
                    sim = MotorSim(sd, regime=rg); sim.set_setpoint(1650); sim.run(60); sim.inject(truth, sev)
                    pre = sim.run(40)
                    tt.reset(pre[0].housing); zs = []
                    for w in pre:
                        tt.update(w); sc = det.score(w)
                        if sc.anomalous and sc.z is not None:
                            zs.append(sc.z)
                    if len(zs) < 8:
                        continue
                    P0 = hm.posterior(zs[-15:])
                    obs, _ = run_test_on_sim(sim, "T1", tt)
                    for k, dm_ in V.items():
                        rows[k].append(classify_test_result(P0, dm_.update(P0, "T1", obs), truth))
        out[rn] = {k: ({**_c4_agg(v), "no_test_top1": float(np.mean([r["top1_before"] for r in v])), "flagged_sessions": len(v),
                        "conflict_rate": float(np.mean([r.get("conflict", False) for r in v]))} if v else {"n": 0}) for k, v in rows.items()}
    return out


def c4_v2_validate(det, tt, hm, dm) -> Dict:
    V = build_c4_variants_v2(tt, dm)
    real = c4_realistic(V, det, tt, hm, C4_V2_VAL_REGIMES, C4_VAL_SEEDS)
    pair = {}
    for rn in ("baseline(stuck)", "confusable_sensor(noisy-harmonics)"):
        cs = pair_cases(V, tt, "T1", Hypothesis.LOOSENESS, Hypothesis.SENSOR_FAULT, C4_REGIMES[rn], C4_VAL_SEEDS)
        pair[rn] = {k: _c4_agg(v) for k, v in cs.items()}
    g = "style_aware_guarded"
    ok = (all(real[r][g]["accuracy_after"] >= real[r][g]["no_test_top1"] - 0.02 for r in real if real[r][g].get("n"))
          and all(real[r][g]["confident_wrong"] <= 0.02 for r in real if real[r][g].get("n"))
          and all(pair[r][g]["accuracy_after"] >= pair[r]["control"]["accuracy_after"] - 0.02 for r in pair))
    return {"realistic": real, "pair": pair,
            "selection": {"rule": "adopt style_aware_guarded iff on VALIDATION (realistic flagged sessions in 4 regimes + clean pairs): accuracy_after >= no-test top-1 - 0.02, "
                                  "confident-wrong <= 0.02 in every regime, and clean-pair accuracy >= control - 0.02", "adopt_style_aware_guarded": bool(ok),
                          "note": "v2 was designed after the v1 TEST run showed confident-wrong results in the hard regime; its final evaluation therefore uses NEW seeds (C4_TEST2) "
                                  "and its regimes are no longer untouched"}}


def stage_final_c4_v2() -> Dict:
    if not os.path.exists(SELECTION_FILE):
        raise SystemExit("run `validate` first")
    det, tt, hm, dm, pred, _ = build_models()
    V = build_c4_variants_v2(tt, dm)
    real = c4_realistic(V, det, tt, hm, C4_REGIMES, C4_TEST2_SEEDS[:8])
    focus = {}
    for test, pairs in FOCUS_PAIRS.items():
        if test != "T1":
            continue
        for a, b in pairs:
            for rn, rg in C4_REGIMES.items():
                cs = pair_cases(V, tt, test, a, b, rg, C4_TEST2_SEEDS)
                focus[f"{test}|{a.value}-vs-{b.value}|{rn}"] = {k: _c4_agg(v) for k, v in cs.items()}
    res = {"schema": "C4Phase10V2Final/1", "data_provenance": "SIMULATED", "seeds": C4_TEST2_SEEDS, "variants": list(V),
           "note": "v2 was designed after the v1 test run; these are FRESH SEEDS, not untouched regimes. Simulation only.", "realistic_T1": real, "focus_T1": focus}
    with open(os.path.join(DOCS_EVAL, "c2c4_phase10_c4_v2_final.json"), "w") as f:
        json.dump(res, f, indent=1, default=float)
    return res


# =============================================================================================== final
def stage_final() -> Dict:
    if not os.path.exists(SELECTION_FILE):
        raise SystemExit("no frozen selection: run `python -m torqva.c2c4_study validate` first (the test set is never used for selection)")
    with open(SELECTION_FILE) as f:
        sel = json.load(f)
    sel_hash = hashlib.sha256(json.dumps({"c2": sel["c2_selection"], "c4": sel["c4_selection"]}, sort_keys=True, default=str).encode()).hexdigest()[:12]
    det, tt, hm, dm, pred, _ = build_models()
    preds, n_cal = prepare_predictors(det, tt, hm, pred)
    val_base = make_cases({"baseline": REGIMES["baseline"]}, VAL_SEEDS, VAL_SPEEDS, VAL_SEV, det, tt, hm)
    evidence_coverage(preds, val_base)
    test = make_cases(TEST_REGIMES, TEST_SEEDS, TEST_SPEEDS, TEST_SEV, det, tt, hm, TEST_REGIME_SPEEDS)
    c2 = {}
    records = []
    for k, P in preds.items():
        rows = score_cases(P, test, k)
        c2[k] = summarize(rows)
        if k in ("control", "noise_aware"):
            for r in rows:
                if r[7] in (30, 60, 120):
                    records.append({"variant": k, "regime": r[0], "fault": r[1], "severity": r[2], "speed": r[3], "seed": r[4], "action": r[5],
                                    "signal": r[6], "horizon_s": r[7], "observed": round(r[8], 4), "predicted": round(r[9], 4), "lo": round(r[10], 4),
                                    "hi": round(r[11], 4), "status": r[13], "trusted": r[14]})
    res = {"schema": "C2C4Phase10Final/1", "data_provenance": "SIMULATED",
           "WARNING": "Simulation only; simulator uncalibrated; no physical motor was operated. Predictions are expected outcomes under matched simulated conditions, not counterfactuals of one physical run and not measurements.",
           "selection_sha": sel_hash, "frozen": {"c2": sel["c2_selection"], "c4": sel["c4_selection"]},
           "seeds": {"cal": CAL_SEEDS, "val": VAL_SEEDS, "test": TEST_SEEDS, "c4_val": C4_VAL_SEEDS, "c4_test": C4_TEST_SEEDS}, "n_cal_cases": n_cal,
           "test_cases": len(test), "prediction_targets": PREDICTION_TARGETS, "test_specs": TEST_SPECS, "c2": c2, "c4": c4_final(det, tt, hm, dm)}
    with open(os.path.join(DOCS_EVAL, "c2c4_phase10_final.json"), "w") as f:
        json.dump(res, f, indent=1, default=float)
    with open(os.path.join(DOCS_EVAL, "c2c4_phase10_predictions.jsonl.gz"), "wb") as raw, gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) as gz, io.TextIOWrapper(gz, encoding="utf-8", newline="\n") as f:
        for r in records:                                    # mtime=0, no filename: regenerating is byte-for-byte reproducible
            f.write(json.dumps(r) + "\n")
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("stage", choices=["validate", "final", "final-c4-v2"])
    a = ap.parse_args()
    r = {"validate": stage_validate, "final": stage_final, "final-c4-v2": stage_final_c4_v2}[a.stage]()
    if a.stage == "final-c4-v2":
        print(json.dumps(r["realistic_T1"], indent=0, default=float)[:200]); return
    print(json.dumps({"c2_selection": (r.get("c2_selection") or r["frozen"]["c2"]), "c4_selection": (r.get("c4_selection") or r["frozen"]["c4"])}, indent=1, default=float))


if __name__ == "__main__":
    main()
