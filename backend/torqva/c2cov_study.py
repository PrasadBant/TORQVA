"""Phase 11 - C2 conditional-coverage study (SIMULATION ONLY; simulator uncalibrated; no measured data).

    python -m torqva.c2cov_study validate   # calibrate on CAL, choose on VAL                    -> docs/eval/c2cov_phase11_selection.json
    python -m torqva.c2cov_study final      # one run on fresh TEST cases with the frozen choice -> docs/eval/c2cov_phase11_final.json

Question: why was overload coverage 79 % (Phase 10) and can conditional coverage be improved without simply widening every interval?
Answer from stratified diagnosis (development seeds): the failure is the HOUSING signal (coverage 0.42 vs >= 0.90 elsewhere), caused by a +0.2 C state-estimation
lag (mean of the last 10 windows of a steadily rising temperature; lag = 4.5 s x slope; overload heats ~3x faster). See `c2_conditional.py`.

Protocol. A case = one simulated run (fault class, severity, speed, regime, seed) with the three actions rolled out from identical conditions. Every case has a UNIQUE seed
from a partition-specific range (CAL 7,000,000+, VAL 8,000,000+, TEST 9,000,000+; indexed by regime, fault, severity, speed, replicate), so no seed is shared between
partitions, regimes, fault classes or severities (asserted). Phase 10 regimes/seeds were inspected: those numbers are exploratory. Uncertainty: rows within a case are
not independent, so confidence intervals are CASE-LEVEL bootstrap intervals (deterministic); subgroup results are reported only where >= 30 cases exist.
Variants (all share the shipped grey-box parameters; the point prediction changes only where stated): shipped | phase10_noise_aware | class_conditional (interval only) |
trend_state (POINT-PREDICTION change) | trend_state + class_conditional.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from typing import Dict, List, Optional, Sequence, Tuple

import numpy as np

from .c2_conditional import ConditionalPredictor, MIN_CLASS_N, RegimeGatedPredictor
from .c2_robust import NoiseAwarePredictor, make_case
from .c2c4_study import score_cases
from .evaluation import build_models
from .hypotheses import HYPS
from .prediction import CHECK_HORIZONS, NOISE_FLOOR, SIGNALS
from .schemas import Hypothesis as Hy
from .sim import REGIMES, Regime

DOCS_EVAL = os.path.join(os.path.dirname(__file__), "..", "..", "docs", "eval")
SELECTION_FILE = os.path.join(DOCS_EVAL, "c2cov_phase11_selection.json")
BASES = {"CAL": 7_000_000, "VAL": 8_000_000, "TEST": 9_000_000, "VAL2": 8_500_000, "TEST2": 9_500_000}
K_MAX = 16
K_COUNT = {"CAL": 8, "VAL": 6, "TEST": 10, "VAL2": 6, "TEST2": 10}
SEVS = (0.3, 0.6, 0.9)
SPEEDS = (1350, 1650, 1950)
CAL_SPEEDS_ = (1350, 1650, 1950)
REGIME_OBJS: Dict[str, Regime] = {
    "baseline": REGIMES["baseline"], "noise_x1.5": Regime("noise_x1.5", noise_mult=1.5), "session_shift": REGIMES["session_shift"], "noisy": REGIMES["noisy"],
    "confusable_sensor": REGIMES["confusable_sensor"], "intermittent": REGIMES["intermittent"], "hard": REGIMES["hard"], "noise_x3": Regime("noise_x3", noise_mult=3.0),
    "unfamiliar_speed_2400": REGIMES["baseline"]}
RNAMES = list(REGIME_OBJS)
VAL_REGIMES = ("baseline", "noise_x1.5", "session_shift")
VAL2_REGIMES = ("baseline", "noise_x1.5", "session_shift", "noisy", "hard")      # v2: harsher validation after the v1 test exposed the heavy-shift weakness
TEST_REGIMES = ("baseline", "noisy", "session_shift", "confusable_sensor", "intermittent", "hard", "noise_x3", "unfamiliar_speed_2400")
REGIME_SPEEDS = {"unfamiliar_speed_2400": (2400,)}
MIN_CASES = 30                                                  # subgroup reporting threshold (cases)


def seed_for(part: str, regime: str, fault: Hy, sev: float, sp: float, k: int, speeds=SPEEDS) -> int:
    assert 0 <= k < K_MAX
    si = list(speeds).index(sp)
    return BASES[part] + ((((RNAMES.index(regime) * len(HYPS) + HYPS.index(fault)) * len(SEVS) + SEVS.index(sev)) * 3 + si) * K_MAX + k)


def seeds_of(part: str, regimes) -> List[int]:
    out = []
    for r in regimes:
        sp_list = REGIME_SPEEDS.get(r, SPEEDS)
        for h in HYPS:
            for sev in SEVS:
                for sp in sp_list:
                    out += [seed_for(part, r, h, sev, sp, k, sp_list) for k in range(K_COUNT[part])]
    return out


def assert_seed_hygiene() -> None:
    sets = {p: seeds_of(p, RNAMES) for p in BASES}
    for p, s in sets.items():
        assert len(s) == len(set(s)), f"duplicate seeds inside {p}"
        assert len(s) < 99991
    for a in sets:
        for b in sets:
            if a < b:
                assert not set(sets[a]) & set(sets[b]), (a, b)
    allv = set().union(*map(set, sets.values()))
    assert not {x + 99991 for x in allv} & allv, "offset stream collides with a main seed"
    from . import c4cal_study as c4
    c4s = set().union(*[set(c4.all_seeds(p, c4.RNAMES, c4.HYPS)) for p in c4.BASES])
    from .c2c4_study import EARLIER_SEEDS
    assert not allv & (c4s | EARLIER_SEEDS), "overlap with earlier phases"


def make_cases(part: str, regimes, det, tt, hm, k_override: Optional[int] = None) -> List[Dict]:
    out = []
    for r in regimes:
        sp_list = REGIME_SPEEDS.get(r, SPEEDS)
        for h in HYPS:
            for sev in SEVS:
                for sp in sp_list:
                    for k in range(k_override or K_COUNT[part]):
                        c = make_case(h, sev, seed_for(part, r, h, sev, sp, k, sp_list), sp, REGIME_OBJS[r], det, tt, hm)
                        c["regime"] = r
                        out.append(c)
    return out


def cal_tuples(cases):
    return [(c["st"], c["post"], a["action"], a["target"], a["truth"]) for c in cases for a in c["acts"]], [c["h"] for c in cases for _ in c["acts"]]


def build_conditional_variant(pred, det, tt, hm, trend: bool = False) -> ConditionalPredictor:
    """The opt-in Phase 11 predictor (TORQVA_C2_VARIANT=conditional | trend_conditional): class-conditional intervals calibrated on the 432 CAL cases; the per-cell
    coverage used by trust() comes from VALIDATION baseline cases only. trend=True adds the separately justified trend-corrected housing state (point-prediction change)."""
    cal = make_cases("CAL", ("baseline",), det, tt, hm)
    tuples, labels = cal_tuples(cal)
    v = ConditionalPredictor.from_fitted(pred, class_conditional=True, trend_state=trend)
    v.calibrate(tuples, labels)
    vt, _ = cal_tuples(make_cases("VAL", ("baseline",), det, tt, hm, k_override=2))
    v.evaluate_coverage(vt)
    return v


def build_variants(pred, cal_cases, gated: bool = False) -> Dict:
    tuples, labels = cal_tuples(cal_cases)
    out = {"shipped": pred}
    p10 = NoiseAwarePredictor.from_fitted(pred); p10.calibrate(tuples); out["phase10_noise_aware"] = p10
    for name, kw in (("class_conditional", dict(class_conditional=True)), ("trend_state", dict(trend_state=True)),
                     ("trend_state+class_conditional", dict(trend_state=True, class_conditional=True))):
        v = ConditionalPredictor.from_fitted(pred, **kw)
        v.calibrate(tuples, labels)
        out[name] = v
    if gated:
        g = RegimeGatedPredictor.from_fitted(pred, trend_state=True, class_conditional=True)
        g.calibrate(tuples, labels); g.attach_fallback(p10)
        out["regime_gated(trend+class, fallback=phase10)"] = g
    return out


# ------------------------------------------------------------------------------------------------ metrics
def boot_ci(per_case: np.ndarray, n_boot: int = 400, seed: int = 0) -> Tuple[float, float]:
    if len(per_case) < 2:
        return (float("nan"), float("nan"))
    rs = np.random.RandomState(seed)
    m = [float(np.mean(per_case[rs.randint(0, len(per_case), len(per_case))])) for _ in range(n_boot)]
    return (float(np.percentile(m, 2.5)), float(np.percentile(m, 97.5)))


def group_stats(rows: Sequence[Tuple]) -> Dict:
    """rows: score_cases tuples. Case-level coverage = mean over that case's rows; CI by bootstrap over cases."""
    if not rows:
        return {"n_cases": 0, "n_rows": 0}
    cases: Dict[Tuple, List[int]] = {}
    for r in rows:
        cases.setdefault((r[0], r[1], r[2], r[3], r[4]), []).append(int(r[10] <= r[8] <= r[11]))
    per_case = np.array([np.mean(v) for v in cases.values()])
    lo, hi, y, mu = (np.array([r[i] for r in rows], dtype=float) for i in (10, 11, 8, 9))
    sc = np.array([2 * NOISE_FLOOR[r[6]] for r in rows])
    width = (hi - lo) / sc
    sup = np.array([r[13] == "supported" for r in rows]); tr = np.array([bool(r[14]) for r in rows])
    cov = (y >= lo) & (y <= hi)
    out = {"n_cases": len(per_case), "n_rows": len(rows), "coverage_rows": float(cov.mean()), "coverage_case_level": float(per_case.mean()),
           "coverage_ci95_case_bootstrap": boot_ci(per_case), "width_median": float(np.median(width)), "width_mean": float(width.mean()), "width_p90": float(np.percentile(width, 90)),
           "mae_norm": float(np.mean(np.abs(y - mu) / np.array([NOISE_FLOOR[r[6]] for r in rows]))), "supported_frac": float(sup.mean()), "trusted_frac": float(tr.mean())}
    if tr.any():
        out["coverage_when_trusted"] = float(cov[tr].mean())
    return out


def evaluate(rows: Sequence[Tuple], regimes) -> Dict:
    res = {}
    for rg in regimes:
        rr = [r for r in rows if r[0] == rg]
        e = {"overall": group_stats(rr), "by_fault": {}, "overload_by_signal": {}, "overload_by_action": {}, "worst_fault_cell": None}
        worst = None
        for h in HYPS:
            g = [r for r in rr if r[1] == h.value]
            st = group_stats(g)
            st["reported"] = st["n_cases"] >= MIN_CASES
            e["by_fault"][h.value] = st if st["reported"] else {"n_cases": st["n_cases"], "reported": False, "note": f"fewer than {MIN_CASES} cases"}
            if st["reported"] and (worst is None or st["coverage_case_level"] < worst[1]):
                worst = (h.value, st["coverage_case_level"])
        e["worst_fault_cell"] = worst
        ov = [r for r in rr if r[1] == "overload"]
        for s in SIGNALS:
            e["overload_by_signal"][s] = {k: v for k, v in group_stats([r for r in ov if r[6] == s]).items() if k in ("n_cases", "coverage_case_level", "coverage_ci95_case_bootstrap", "width_median", "mae_norm")}
        for a in ("CONTINUE_MONITORING", "REDUCE_SPEED", "STOP"):
            e["overload_by_action"][a] = {k: v for k, v in group_stats([r for r in ov if r[5] == a]).items() if k in ("n_cases", "coverage_case_level", "coverage_ci95_case_bootstrap")}
        res[rg] = e
    return res


# ------------------------------------------------------------------------------------------------ stages
def _prepare(gated: bool = False):
    det, tt, hm, dm, pred, _ = build_models()
    cal = make_cases("CAL", ("baseline",), det, tt, hm)
    variants = build_variants(pred, cal, gated)
    val_base = make_cases("VAL", ("baseline",), det, tt, hm)
    t, _ = cal_tuples(val_base)
    for P in variants.values():
        if hasattr(P, "evaluate_coverage"):
            P.evaluate_coverage(t)                                # trust() input from VALIDATION baseline cases only
    return det, tt, hm, pred, cal, variants


def stage_validate(v2: bool = False) -> Dict:
    assert_seed_hygiene()
    det, tt, hm, pred, cal, variants = _prepare(gated=v2)
    part, VR = ("VAL2", VAL2_REGIMES) if v2 else ("VAL", VAL_REGIMES)
    val = make_cases(part, VR, det, tt, hm)
    ev = {k: evaluate(score_cases(P, val, k), VR) for k, P in variants.items()}
    ref = "phase10_noise_aware"
    cands = [k for k in variants if k not in ("shipped", ref)]
    def worst(k, rg): return ev[k][rg]["worst_fault_cell"][1]
    def feasible(k):
        for rg in VR:
            c = ev[k][rg]["overall"]
            if not (0.85 <= c["coverage_case_level"] <= 0.95):
                return False
        b, r = ev[k]["baseline"]["overall"], ev[ref]["baseline"]["overall"]
        if b["width_median"] / r["width_median"] > 1.30 or b["trusted_frac"] < r["trusted_frac"] - 0.05:
            return False
        if b["mae_norm"] / r["mae_norm"] > 1.02:                  # a point-prediction change must not make predictions worse
            return False
        for h in HYPS:                                           # ... for any fault class
            mk, mr = ev[k]["baseline"]["by_fault"][h.value], ev[ref]["baseline"]["by_fault"][h.value]
            if mk.get("reported") and mr.get("reported") and mk["mae_norm"] > 1.05 * mr["mae_norm"]:
                return False
        return True
    feas = [k for k in cands if feasible(k)]
    score = lambda k: float(np.mean([worst(k, rg) for rg in VR]))
    best = max(feas, key=lambda k: (score(k), -len(k))) if feas else None
    improves = bool(best and score(best) - score(ref) >= 0.03)
    sel = {"stage": "validation", "seeds": {"cal_cases": len(cal), "val_regimes": VR, "partition": part}, "min_cases_per_subgroup": MIN_CASES, "min_class_n": MIN_CLASS_N,
           "class_sample_counts": variants["class_conditional"].class_sample_counts(),
           "rule": "feasible = case-level coverage in [0.85, 0.95] in every VALIDATION regime AND baseline median width <= 1.30x the Phase 10 candidate AND baseline trusted fraction not lower by > 0.05 "
                   "AND (point-prediction change) pooled MAE <= 1.02x and no fault class's MAE worse by > 5 %; best = highest mean worst-fault coverage over the VALIDATION regimes; "
                   "ADOPTED only if that beats the Phase 10 candidate by >= 3 points; otherwise nothing new is adopted",
           "worst_fault_coverage": {k: {rg: ev[k][rg]["worst_fault_cell"] for rg in VR} for k in ev},
           "validation": {k: {rg: {x: ev[k][rg]["overall"].get(x) for x in ("n_cases", "coverage_case_level", "coverage_ci95_case_bootstrap", "width_median", "mae_norm", "trusted_frac")}
                              | {"overload": ev[k][rg]["by_fault"]["overload"].get("coverage_case_level")} for rg in VR} for k in ev},
           "feasible": feas, "best_feasible": best, "improves_on_phase10_by_3_points": improves, "chosen": best if improves else None}
    os.makedirs(DOCS_EVAL, exist_ok=True)
    with open(SELECTION_FILE.replace("selection", "v2_selection") if v2 else SELECTION_FILE, "w") as f:
        json.dump(sel, f, indent=1, default=float)
    return sel


def stage_final() -> Dict:
    if not os.path.exists(SELECTION_FILE):
        raise SystemExit("no frozen selection: run `python -m torqva.c2cov_study validate` first (the test set is never used for calibration or selection)")
    assert_seed_hygiene()
    with open(SELECTION_FILE) as f:
        sel = json.load(f)
    det, tt, hm, pred, cal, variants = _prepare()
    test = make_cases("TEST", TEST_REGIMES, det, tt, hm)
    names = list(variants)                                        # every variant is reported (the chosen one is flagged)
    res = {"schema": "C2CovPhase11Final/1", "data_provenance": "SIMULATED",
           "WARNING": "Simulation only; simulator uncalibrated; no physical motor was operated. Empirical coverage is not a guarantee. Phase 10 regimes/seeds were inspected (exploratory).",
           "selection_sha": hashlib.sha256(json.dumps({"c": sel["chosen"], "b": sel["best_feasible"], "r": sel["rule"]}, sort_keys=True).encode()).hexdigest()[:12],
           "chosen": sel["chosen"], "best_feasible": sel["best_feasible"], "min_cases_per_subgroup": MIN_CASES, "n_test_cases": len(test),
           "unique_seeds": len({c["seed"] for c in test}), "calibration_cases": len(cal), "class_sample_counts": variants["class_conditional"].class_sample_counts(), "variants": {}}
    for k in names:
        rows = score_cases(variants[k], test, k)
        res["variants"][k] = evaluate(rows, TEST_REGIMES)
    with open(os.path.join(DOCS_EVAL, "c2cov_phase11_final.json"), "w") as f:
        json.dump(res, f, indent=1, default=float)
    return res


def stage_final_v2() -> Dict:
    """v2: the regime-gated predictor was designed AFTER the v1 test showed heavy-shift weakness; it is validated on VAL2 (which includes noisy and hard) and evaluated on
    FRESH test seeds (TEST2). The regimes themselves are therefore not untouched; seed-level generalisation only."""
    vp = SELECTION_FILE.replace("selection", "v2_selection")
    if not os.path.exists(vp):
        raise SystemExit("no frozen v2 selection: run `python -m torqva.c2cov_study validate-v2` first")
    assert_seed_hygiene()
    with open(vp) as f:
        sel = json.load(f)
    det, tt, hm, pred, cal, variants = _prepare(gated=True)
    test = make_cases("TEST2", TEST_REGIMES, det, tt, hm)
    res = {"schema": "C2CovPhase11V2Final/1", "data_provenance": "SIMULATED",
           "WARNING": "Simulation only; fresh seeds, but v2 was designed after the v1 test: regimes are not untouched. Empirical coverage is not a guarantee.",
           "chosen": sel["chosen"], "best_feasible": sel["best_feasible"], "min_cases_per_subgroup": MIN_CASES, "n_test_cases": len(test), "unique_seeds": len({c["seed"] for c in test}),
           "calibration_cases": len(cal), "variants": {}}
    for k in variants:
        res["variants"][k] = evaluate(score_cases(variants[k], test, k), TEST_REGIMES)
    with open(os.path.join(DOCS_EVAL, "c2cov_phase11_v2_final.json"), "w") as f:
        json.dump(res, f, indent=1, default=float)
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("stage", choices=["validate", "final", "validate-v2", "final-v2"])
    a = ap.parse_args()
    r = {"validate": stage_validate, "final": stage_final, "validate-v2": lambda: stage_validate(True), "final-v2": stage_final_v2}[a.stage]()
    print(json.dumps({"chosen": r["chosen"], "best_feasible": r["best_feasible"]}, default=float))


if __name__ == "__main__":
    main()
