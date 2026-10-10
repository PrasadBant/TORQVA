"""Phase 11 - C4 likelihood calibration study (SIMULATION ONLY; simulator uncalibrated; no measured data).

    python -m torqva.c4cal_study validate   # fit temperatures on CALIBRATION data, choose the candidate on VALIDATION data -> c4cal_phase11_selection.json
    python -m torqva.c4cal_study final      # one run on FRESH test sessions with the frozen choice                          -> c4cal_phase11_final.json

Why: Phase 10 showed the style-aware T1 library is confidently wrong in a hard regime. Diagnosis on development seeds (5,000,000+): most
confident-wrong cases were a wrong C1 prior beating correct test evidence (the conflict guard fixes those); the rest were test likelihoods that
are themselves wrong because the signature is far too narrow for fault styles it was not trained on (steady looseness sd 0.10 vs intermittent 0.71).

Data separation. Every session has a UNIQUE seed drawn from a partition-specific range (CAL 1,000,000+, VAL 2,000,000+, TEST 3,000,000+; indexed by
regime, fault class, severity and replicate), so no seed is shared between partitions, regimes, fault classes or severities, and the simulator's
offset stream (seed + 99991) cannot collide with another session's main seed (asserted). Signature libraries are trained on their own small seeds
(1101+). Phase 10 regimes and its test seeds (9xxx) were inspected; those results are EXPLORATORY and are not reused as evidence here.
Calibration domain. A first attempt that calibrated on mild regimes only fitted T = 1.0 exactly (a no-op: the calibration data contained no overconfident case),
so CAL and VAL now cover the SHIFTS AND STYLES the model must be reliable under, at noise levels / combinations that differ from the test regimes. TEST regimes are
labelled in-domain (style and level seen in calibration), novel-level (same styles, different level or combination) or unseen-style; only the last two test
extrapolation. Generalisation over seeds is tested everywhere; generalisation over regimes only in the labelled subsets.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from typing import Dict, List, Optional, Sequence, Tuple

import numpy as np

from .c1_study import wilson
from .c4_robust import (CalibratedDiagnostics, ConflictGuard, StyleAwareDiagnosticsModel, classify_test_result, expected_calibration_error,
                        fit_joint_temperatures, fit_temperature, style_regime)
from .diagnostics import run_test_on_sim
from .evaluation import build_models
from .hypotheses import HYPS, Posterior
from .schemas import Hypothesis as Hy
from .sim import MotorSim

DOCS_EVAL = os.path.join(os.path.dirname(__file__), "..", "..", "docs", "eval")
SELECTION_FILE = os.path.join(DOCS_EVAL, "c4cal_phase11_selection.json")
BASES = {"CAL": 1_000_000, "VAL": 2_000_000, "TEST": 3_000_000}
K_MAX = 32                                                    # replicate slots per (regime, truth, severity)
SEVS = (0.3, 0.6, 0.9)
K_COUNT = {"CAL": 16, "VAL": 16, "TEST": 24}
REGIMES = {
    "clean(stuck)": style_regime("stuck", "steady"),
    "confusable(noisy-harm)": style_regime("noisy_harmonics", "steady"),
    "noise x1.5": style_regime("noisy_harmonics", "steady", 1.5),
    "noise x1.75": style_regime("noisy_harmonics", "steady", 1.75),
    "noise x2": style_regime("noisy_harmonics", "steady", 2.0),
    "offsets": style_regime("noisy_harmonics", "steady", 1.0, True),
    "offsets+noise x1.5": style_regime("noisy_harmonics", "steady", 1.5, True),
    "stuck+noise x2+offsets": style_regime("stuck", "steady", 2.0, True),
    "loose-intermittent": style_regime("noisy_harmonics", "intermittent"),
    "hard": style_regime("noisy_harmonics", "intermittent", 2.0, True),
    "hard-lite": style_regime("noisy_harmonics", "intermittent", 1.5, True),
    "hard-val": style_regime("noisy_harmonics", "intermittent", 1.75, True),
    "loose-intermittent x1.25": style_regime("noisy_harmonics", "intermittent", 1.25),
    "sensor-intermittent": style_regime("intermittent", "intermittent"),
    "extreme(noise x3+offsets, intermittent sensor)": style_regime("intermittent", "intermittent", 3.0, True),
}
RNAMES = list(REGIMES)
CAL_REGIMES = ("clean(stuck)", "confusable(noisy-harm)", "noise x1.5", "offsets", "stuck+noise x2+offsets", "loose-intermittent", "hard-lite")
VAL_REGIMES = ("noise x1.75", "offsets+noise x1.5", "hard-val", "loose-intermittent x1.25")
TEST_REGIMES = ("clean(stuck)", "confusable(noisy-harm)", "noise x2", "offsets", "stuck+noise x2+offsets", "loose-intermittent", "hard",
                "sensor-intermittent", "extreme(noise x3+offsets, intermittent sensor)")
DOMAIN = {"clean(stuck)": "in-domain", "confusable(noisy-harm)": "in-domain", "offsets": "in-domain", "stuck+noise x2+offsets": "in-domain", "loose-intermittent": "in-domain",
          "noise x2": "novel-level", "hard": "novel-level", "sensor-intermittent": "unseen-style", "extreme(noise x3+offsets, intermittent sensor)": "unseen-style"}
PAIR_TRUTHS = (Hy.IMBALANCE, Hy.LOOSENESS, Hy.SENSOR_FAULT)
LIB_STYLES = {"sa": (("stuck", "noisy_harmonics"), ("steady",)), "sa+loose-int": (("stuck", "noisy_harmonics"), ("steady", "intermittent"))}


def seed_for(part: str, regime: str, truth: Hy, sev: float, k: int) -> int:
    assert 0 <= k < K_MAX
    return BASES[part] + ((RNAMES.index(regime) * len(HYPS) + HYPS.index(truth)) * len(SEVS) + SEVS.index(sev)) * K_MAX + k


def all_seeds(part: str, regimes, truths) -> List[int]:
    return [seed_for(part, r, t, s, k) for r in regimes for t in truths for s in SEVS for k in range(K_COUNT[part])]


def assert_seed_hygiene() -> None:
    sets = {p: set(all_seeds(p, RNAMES, HYPS)) for p in BASES}
    for p, s in sets.items():
        assert len(s) == len(RNAMES) * len(HYPS) * len(SEVS) * K_MAX or len(s) == len(all_seeds(p, RNAMES, HYPS)), p
        assert len(s) == len(all_seeds(p, RNAMES, HYPS)), f"duplicate seeds inside {p}"
    for a in sets:
        for b in sets:
            if a < b:
                assert not sets[a] & sets[b], (a, b)
    allv = set().union(*sets.values())
    assert not {x + 99991 for x in allv} & allv, "offset stream collides with a main seed"
    assert max(len(x) for x in sets.values()) < 99991


def make_sessions(part: str, regimes: Sequence[str], truths: Sequence[Hy], det, tt, hm) -> List[Dict]:
    out = []
    for rn in regimes:
        for truth in truths:
            for sev in SEVS:
                for k in range(K_COUNT[part]):
                    sd = seed_for(part, rn, truth, sev, k)
                    sim = MotorSim(sd, regime=REGIMES[rn]); sim.set_setpoint(1650); sim.run(60); sim.inject(truth, sev)
                    pre = sim.run(40); tt.reset(pre[0].housing); zs = []
                    for w in pre:
                        tt.update(w); sc = det.score(w)
                        if sc.anomalous and sc.z is not None:
                            zs.append(sc.z)
                    obs, _ = run_test_on_sim(sim, "T1", tt)
                    out.append({"regime": rn, "truth": truth, "sev": sev, "seed": sd, "obs": obs, "flagged": len(zs) >= 8,
                                "P0": hm.posterior(zs[-15:]) if len(zs) >= 8 else None})
    return out


# ------------------------------------------------------------------------------------------------ candidates
GOF_ALPHAS = (None, 0.001, 0.01)
CORROBORATION = (None, 0.6, 0.8)


def build_models_for_study(tt, dm, cal: Sequence[Dict]) -> Tuple[Dict, Dict]:
    """cal = CALIBRATION sessions only. Fits, per signature library: the likelihood-only temperature (diagnostic) and the JOINT (prior, likelihood)
    temperatures by post-test NLL on the realistic calibration sessions (flagged looseness / sensor-fault)."""
    libs = {}
    for name, (sensor, loose) in LIB_STYLES.items():
        m = StyleAwareDiagnosticsModel(sensor, loose); m.learn(tt, seeds=(1, 2)); libs[name] = m
    cal_obs = [(s["obs"], s["truth"]) for s in cal]
    realistic_cal = [(s["P0"], s["obs"], s["truth"]) for s in cal if s["flagged"] and s["truth"] in (Hy.LOOSENESS, Hy.SENSOR_FAULT)]
    lik_only, joint, fit = {}, {}, {}
    for name, m in libs.items():
        T, info = fit_temperature(m, cal_obs)
        (Tp, Tl), jinfo = fit_joint_temperatures(m, realistic_cal)
        lik_only[name], joint[name] = T, (Tp, Tl)
        fit[name] = {"likelihood_only": {"T": T, **info}, "joint": {"prior_T": Tp, "likelihood_T": Tl, **jinfo}}
    models: Dict[str, object] = {"shipped": dm, "style_aware": libs["sa"], "style_aware+guard(Phase10)": ConflictGuard(libs["sa"])}
    for lib, m in libs.items():
        for tempered in (False, True):
            Tp, Tl = joint[lib] if tempered else (1.0, 1.0)
            for a in GOF_ALPHAS:
                for c in CORROBORATION:
                    tag = f"Tp={Tp:g},Tl={Tl:g}" if tempered else "raw"
                    models[f"cal[{lib}|{tag}|gof={a}|corr={c}]"] = CalibratedDiagnostics(m, Tl, a, True, 0.70, c, Tp)
    return models, {"likelihood_only_temperatures": lik_only, "joint_temperatures": {k: list(v) for k, v in joint.items()}, "fit": fit, "n_realistic_calibration_sessions": len(realistic_cal)}


# ------------------------------------------------------------------------------------------------ metrics
def pair_prior(a: Hy, b: Hy) -> Posterior:
    p = {h: 0.0 for h in HYPS}; p[a] = p[b] = 0.5
    return Posterior(p, 10)


def realistic(model, sessions: Sequence[Dict]) -> Dict:
    """Pre-test posterior from C1 evidence (flagged looseness / sensor-fault sessions) -> T1 -> post-test posterior."""
    rs = []
    for s in sessions:
        if not s["flagged"] or s["truth"] not in (Hy.LOOSENESS, Hy.SENSOR_FAULT):
            continue
        post = model.update(s["P0"], "T1", s["obs"])
        r = classify_test_result(s["P0"], post, s["truth"]); r["truth"] = s["truth"].value; r["top_p"] = float(post.top_p)
        r["correct"] = bool(post.top == s["truth"]); r["conflict"] = bool(getattr(post, "conflict", False))
        rs.append(r)
    return _agg(rs)


def _agg(rs: List[Dict]) -> Dict:
    n = len(rs)
    if not n:
        return {"n": 0}
    f = lambda key: sum(bool(r[key]) for r in rs)
    conf_correct = sum((not r["inconclusive"]) and r["top1_after"] for r in rs)
    per_class = {}
    for cls in ("looseness", "sensor_fault"):
        g = [r for r in rs if r["truth"] == cls]
        if g:
            per_class[cls] = {"n": len(g), "confident_wrong": sum(r["confident_wrong"] for r in g) / len(g), "useful": sum((not r["inconclusive"]) and r["top1_after"] for r in g) / len(g),
                              "inconclusive": sum(r["inconclusive"] for r in g) / len(g)}
    worse_dec = sum(r["top1_before"] and not r["top1_after"] for r in rs)
    cw = f("confident_wrong")
    out = {"n": n, "accuracy_after": f("top1_after") / n, "accuracy_ci95": wilson(f("top1_after"), n), "no_test_top1": f("top1_before") / n,
           "useful": conf_correct / n, "useful_ci95": wilson(conf_correct, n), "confident_wrong": cw / n, "confident_wrong_ci95": wilson(cw, n),
           "inconclusive": f("inconclusive") / n, "conflict": f("conflict") / n, "uncorroborated": f("uncorroborated") / n, "ood_or_gof_abstain": f("ood") / n,
           "decision_worse_than_prior": worse_dec / n, "p_truth_worsened": sum(r["effect"] == "worsened" for r in rs) / n, "per_class": per_class}
    conf = [r["top_p"] for r in rs]; cor = [r["correct"] for r in rs]
    out["ece_top_prob"] = expected_calibration_error(conf, cor) if n >= 100 else None
    out["brier_top"] = float(np.mean([(c - float(k)) ** 2 for c, k in zip(conf, cor)]))
    return out


def pairwise(model, sessions: Sequence[Dict], a: Hy, b: Hy) -> Dict:
    P = pair_prior(a, b)
    rs = []
    for s in sessions:
        if s["truth"] in (a, b):
            post = model.update(P, "T1", s["obs"]); r = classify_test_result(P, post, s["truth"])
            r["truth"] = s["truth"].value; r["top_p"] = float(post.top_p); r["correct"] = bool(post.top == s["truth"]); r["conflict"] = bool(getattr(post, "conflict", False))
            rs.append(r)
    g = _agg(rs)
    return {k: g.get(k) for k in ("n", "accuracy_after", "accuracy_ci95", "useful", "confident_wrong", "inconclusive", "conflict")}


def by_regime(model, sessions, regimes) -> Dict:
    return {rn: realistic(model, [s for s in sessions if s["regime"] == rn]) for rn in regimes}


# ------------------------------------------------------------------------------------------------ stages
def collect_calibration(det, tt, hm) -> List[Dict]:
    return make_sessions("CAL", CAL_REGIMES, HYPS, det, tt, hm)


def stage_validate() -> Dict:
    assert_seed_hygiene()
    det, tt, hm, dm, pred, _ = build_models()
    cal = collect_calibration(det, tt, hm)
    models, cinfo = build_models_for_study(tt, dm, cal)
    val = make_sessions("VAL", VAL_REGIMES, PAIR_TRUTHS, det, tt, hm)
    rows = {}
    for name, m in models.items():
        pooled = realistic(m, val)
        rows[name] = {"pooled": {k: pooled.get(k) for k in ("n", "accuracy_after", "no_test_top1", "useful", "confident_wrong", "inconclusive", "conflict", "decision_worse_than_prior", "per_class")},
                      "by_regime": {rn: {k: g.get(k) for k in ("n", "useful", "confident_wrong", "inconclusive", "conflict")} for rn, g in by_regime(m, val, VAL_REGIMES).items()}}
    # ----- selection rule (written before any test data is generated)
    cands = [k for k in models if k.startswith("cal[")]
    ref = "style_aware+guard(Phase10)"
    worst_regime = lambda k: max(v["confident_wrong"] for v in rows[k]["by_regime"].values())

    def feasible(k):
        r = rows[k]
        worst_class = max(c["confident_wrong"] for c in r["pooled"]["per_class"].values())
        return worst_class <= 0.02 and worst_regime(k) <= 0.05 and r["pooled"]["decision_worse_than_prior"] <= 0.05

    feas = [k for k in cands if feasible(k)]
    order = lambda k: (-rows[k]["pooled"]["useful"], len(k))
    best = sorted(feas, key=order)[0] if feas else None
    # adoption additionally needs a real improvement over the Phase 10 guarded model on VALIDATION: >= 2 points lower worst-regime confident-wrong,
    # or (not higher worst-regime confident-wrong AND >= 3 points more useful decisions)
    improves = bool(best and (worst_regime(ref) - worst_regime(best) >= 0.02 or
                              (worst_regime(best) <= worst_regime(ref) and rows[best]["pooled"]["useful"] - rows[ref]["pooled"]["useful"] >= 0.03)))
    chosen = best if improves else None
    # For reporting only: the candidate closest to feasibility (lowest worst-regime confident-wrong, then highest useful rate). It is evaluated on TEST
    # to learn whether the improvement generalises, but it is NOT adopted unless `chosen` is set.
    closest = best or sorted(cands, key=lambda k: (worst_regime(k), -rows[k]["pooled"]["useful"], len(k)))[0]
    sel = {"stage": "validation", "protocol": "CAL fits temperatures; VAL selects; TEST is generated only by `final`", "cal_regimes": CAL_REGIMES, "val_regimes": VAL_REGIMES,
           "n_cal_sessions": len(cal), "n_val_sessions": len(val), "calibration": cinfo,
           "rule": "feasible = worst per-class confident-wrong <= 2 % pooled AND <= 5 % in every VALIDATION regime AND decision-worse-than-prior <= 5 %; best = feasible candidate with "
                   "the highest useful rate (correct and not inconclusive), ties -> simpler name; ADOPTED only if it beats the Phase 10 guarded model on VALIDATION (worst-regime "
                   "confident-wrong lower by >= 2 points, or not higher with >= 3 points more useful decisions); otherwise nothing is adopted and the shipped model stays the default",
           "validation": rows, "feasible": feas, "best_feasible": best, "closest_to_feasible": closest, "improves_on_phase10_guard": improves, "chosen": chosen}
    os.makedirs(DOCS_EVAL, exist_ok=True)
    with open(SELECTION_FILE, "w") as f:
        json.dump(sel, f, indent=1, default=float)
    return sel


def stage_final() -> Dict:
    if not os.path.exists(SELECTION_FILE):
        raise SystemExit("no frozen selection: run `python -m torqva.c4cal_study validate` first (test data is never used for calibration or selection)")
    assert_seed_hygiene()
    with open(SELECTION_FILE) as f:
        sel = json.load(f)
    det, tt, hm, dm, pred, _ = build_models()
    cal = collect_calibration(det, tt, hm)
    models, cinfo = build_models_for_study(tt, dm, cal)
    chosen, best, closest = sel["chosen"], sel.get("best_feasible"), sel.get("closest_to_feasible")
    names = ["shipped", "style_aware", "style_aware+guard(Phase10)"] + ([closest] if closest else [])
    test = make_sessions("TEST", TEST_REGIMES, PAIR_TRUTHS, det, tt, hm)
    res = {"schema": "C4CalPhase11Final/1", "data_provenance": "SIMULATED",
           "WARNING": "Simulation only; simulator uncalibrated; no physical motor was operated. Phase 10 regimes/seeds were inspected: they are exploratory, not evidence here.",
           "selection_sha": hashlib.sha256(json.dumps({"chosen": chosen, "best": best, "closest": closest, "rule": sel["rule"]}, sort_keys=True).encode()).hexdigest()[:12], "chosen": chosen,
           "best_feasible": best, "closest_to_feasible": closest, "adopted_on_validation": bool(chosen), "regime_domain": {r: DOMAIN[r] for r in TEST_REGIMES},
           "calibration": cinfo, "n_test_sessions": len(test), "test_regimes": TEST_REGIMES, "sessions_per_regime_truth_severity": K_COUNT["TEST"],
           "unique_seeds": len({s["seed"] for s in test}), "realistic": {}, "pooled": {}, "pairwise": {}}
    for nm in names:
        m = models[nm]
        res["realistic"][nm] = by_regime(m, test, TEST_REGIMES)
        res["pooled"][nm] = realistic(m, test)
        res["pairwise"][nm] = {rn: {f"{a.value}-vs-{b.value}": pairwise(m, [s for s in test if s["regime"] == rn], a, b)
                                    for a, b in ((Hy.LOOSENESS, Hy.SENSOR_FAULT), (Hy.IMBALANCE, Hy.LOOSENESS), (Hy.IMBALANCE, Hy.SENSOR_FAULT))} for rn in TEST_REGIMES}
    # likelihood-only calibration of the library with/without temperature on the TEST outcomes (all pairs of interest)
    with open(os.path.join(DOCS_EVAL, "c4cal_phase11_final.json"), "w") as f:
        json.dump(res, f, indent=1, default=float)
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("stage", choices=["validate", "final"])
    a = ap.parse_args()
    r = stage_validate() if a.stage == "validate" else stage_final()
    print(json.dumps({"chosen": r["chosen"], "closest_to_feasible": r.get("closest_to_feasible"), "n_feasible": len(r.get("feasible", []))}, default=float))


if __name__ == "__main__":
    main()
