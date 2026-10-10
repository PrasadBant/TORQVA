"""Phase 12 - fresh-seed CONFIRMATION of the frozen Phase 11 decisions (SIMULATION ONLY).

Nothing is re-fitted, re-selected or re-tuned here. The Phase 11 selection files (`c2cov_phase11_*selection.json`, `c4cal_phase11_selection.json`) are read as frozen, models are
rebuilt exactly as Phase 11 built them (same CAL/VAL partitions), and every variant is evaluated on a NEW partition `CONF` whose seeds are disjoint from every earlier phase
(C2: 10,000,000+, C4: 4,000,000+; checked by the existing hygiene assertions, which iterate over every registered partition). The question answered is: do the Phase 11 conclusions
replicate on seeds nobody has looked at, and where do they not?

    python -m torqva.generalization_study confirm      ->  docs/eval/generalization_phase12_final.json

Limits that remain: same simulator and fault generator as calibration (self-consistent, uncalibrated); regimes were seen in Phase 11 (only the seeds are fresh); C1 and the gate (C3) are
evaluated by `python -m torqva.evaluation` (unchanged, reproduced in Phase 12) and are not re-run here.
"""
from __future__ import annotations

import argparse
import contextlib
import json
import os
from typing import Dict

import numpy as np

from . import c2cov_study as c2s
from . import c4cal_study as c4s
from .c2c4_study import score_cases
from .evaluation import build_models
from .schemas import Hypothesis as Hy

DOCS_EVAL = os.path.join(os.path.dirname(__file__), "..", "..", "docs", "eval")
OUT = os.path.join(DOCS_EVAL, "generalization_phase12_final.json")
C2_CONF_BASE, C4_CONF_BASE = 10_000_000, 4_000_000
C2_K, C4_K = 10, 24


@contextlib.contextmanager
def conf_partitions():
    """Register the CONF partition on both studies for the duration of one run only (module state is restored afterwards, so other tests see the Phase 11 partitions)."""
    c2s.BASES["CONF"], c2s.K_COUNT["CONF"] = C2_CONF_BASE, C2_K
    c4s.BASES["CONF"], c4s.K_COUNT["CONF"] = C4_CONF_BASE, C4_K
    try:
        yield
    finally:
        c2s.BASES.pop("CONF", None); c2s.K_COUNT.pop("CONF", None)
        c4s.BASES.pop("CONF", None); c4s.K_COUNT.pop("CONF", None)


def _load(name: str) -> Dict:
    with open(os.path.join(DOCS_EVAL, name)) as f:
        return json.load(f)


def worst_subgroup(ev: Dict) -> Dict:
    """Lowest case-level coverage over every (regime, fault) cell with >= MIN_CASES cases, plus the same restricted to cells the predictor TRUSTS."""
    cells = [(rg, h, st) for rg, e in ev.items() for h, st in e["by_fault"].items() if st.get("reported")]
    if not cells:
        return {}
    w = min(cells, key=lambda c: c[2]["coverage_case_level"])
    return {"regime": w[0], "fault": w[1], "coverage": w[2]["coverage_case_level"], "ci95": w[2]["coverage_ci95_case_bootstrap"], "n_cases": w[2]["n_cases"], "n_cells_reported": len(cells),
            "n_cells_below_0.85": sum(c[2]["coverage_case_level"] < 0.85 for c in cells)}


def c2_confirm() -> Dict:
    c2s.assert_seed_hygiene()
    det, tt, hm, pred, cal, variants = c2s._prepare(gated=True)
    test = c2s.make_cases("CONF", c2s.TEST_REGIMES, det, tt, hm)
    out = {"n_test_cases": len(test), "unique_seeds": len({c["seed"] for c in test}), "partition": "CONF", "seed_base": C2_CONF_BASE, "variants": {}}
    for k, P in variants.items():
        ev = c2s.evaluate(score_cases(P, test, k), c2s.TEST_REGIMES)
        out["variants"][k] = {"by_regime": ev, "worst_sufficiently_sampled_subgroup": worst_subgroup(ev),
                              "abstention_by_regime": {rg: 1.0 - (e["overall"].get("trusted_frac") or 0.0) for rg, e in ev.items()},
                              "supported_fraction_by_regime": {rg: e["overall"].get("supported_frac") for rg, e in ev.items()}}
    # replication of the frozen Phase 11 claims (stated BEFORE looking at CONF): baseline-domain claims only; no heavy-shift claim was ever made
    b = lambda k, f: out["variants"][k]["by_regime"]["baseline"]["by_fault"]["overload"][f]
    claims = {
        "class_conditional overload coverage in baseline >= 0.90": b("class_conditional", "coverage_case_level") >= 0.90,
        "class_conditional overload coverage beats Phase 10 candidate by >= 0.05": b("class_conditional", "coverage_case_level") - b("phase10_noise_aware", "coverage_case_level") >= 0.05,
        "class_conditional baseline overall coverage within [0.85, 0.95]": 0.85 <= out["variants"]["class_conditional"]["by_regime"]["baseline"]["overall"]["coverage_case_level"] <= 0.95,
        "trend state lowers baseline MAE vs Phase 10 candidate": out["variants"]["trend_state"]["by_regime"]["baseline"]["overall"]["mae_norm"] < out["variants"]["phase10_noise_aware"]["by_regime"]["baseline"]["overall"]["mae_norm"],
    }
    out["phase11_claims_replicated"] = claims
    heavy = ("noisy", "hard", "noise_x3", "unfamiliar_speed_2400")
    out["heavy_shift_gap_persists"] = {k: {rg: out["variants"][k]["worst_sufficiently_sampled_subgroup"] and min(
        (st["coverage_case_level"] for st in out["variants"][k]["by_regime"][rg]["by_fault"].values() if st.get("reported")), default=None) for rg in heavy}
        for k in ("phase10_noise_aware", "class_conditional", "regime_gated(trend+class, fallback=phase10)")}
    return out


def c4_confirm() -> Dict:
    c4s.assert_seed_hygiene()
    sel = _load("c4cal_phase11_selection.json")
    det, tt, hm, dm, pred, _ = build_models()
    cal = c4s.collect_calibration(det, tt, hm)
    models, cinfo = c4s.build_models_for_study(tt, dm, cal)
    closest = sel["closest_to_feasible"]
    names = ["shipped", "style_aware", "style_aware+guard(Phase10)", closest]
    test = c4s.make_sessions("CONF", c4s.TEST_REGIMES, c4s.PAIR_TRUTHS, det, tt, hm)
    out = {"n_test_sessions": len(test), "unique_seeds": len({s["seed"] for s in test}), "partition": "CONF", "seed_base": C4_CONF_BASE, "candidate": closest,
           "regime_domain": {r: c4s.DOMAIN[r] for r in c4s.TEST_REGIMES}, "variants": {}}
    for nm in names:
        m = models[nm]
        per = c4s.by_regime(m, test, c4s.TEST_REGIMES)
        pooled = c4s.realistic(m, test)
        out["variants"][nm] = {"pooled": pooled, "by_regime": per,
                               "pairwise": {rn: {f"{a.value}-vs-{b.value}": c4s.pairwise(m, [s for s in test if s["regime"] == rn], a, b)
                                                 for a, b in ((Hy.LOOSENESS, Hy.SENSOR_FAULT), (Hy.IMBALANCE, Hy.LOOSENESS), (Hy.IMBALANCE, Hy.SENSOR_FAULT))} for rn in c4s.TEST_REGIMES}}
    # the PRE-REGISTERED Phase 11 acceptance bar, applied to the fresh seeds (all regimes in this table; in-domain/novel/unseen shown separately)
    def bar(nm):
        v = out["variants"][nm]; pooled = v["pooled"]
        wc = max(c["confident_wrong"] for c in pooled["per_class"].values())
        regs = {rg: g.get("confident_wrong") for rg, g in v["by_regime"].items() if g.get("n")}
        return {"worst_class_confident_wrong": wc, "pooled_confident_wrong": pooled["confident_wrong"], "worst_regime_confident_wrong": max(regs.values()), "worst_regime": max(regs, key=regs.get),
                "decision_worse_than_prior": pooled["decision_worse_than_prior"],
                "meets_bar": bool(wc <= 0.02 and max(regs.values()) <= 0.05 and pooled["decision_worse_than_prior"] <= 0.05)}
    out["acceptance_bar_on_fresh_seeds"] = {nm: bar(nm) for nm in names}
    ref = out["variants"]["style_aware+guard(Phase10)"]; cand = out["variants"][closest]
    out["candidate_vs_phase10_guard"] = {
        "pooled_confident_wrong": [ref["pooled"]["confident_wrong"], cand["pooled"]["confident_wrong"]],
        "pooled_accuracy_after": [ref["pooled"]["accuracy_after"], cand["pooled"]["accuracy_after"]],
        "pooled_decision_worse": [ref["pooled"]["decision_worse_than_prior"], cand["pooled"]["decision_worse_than_prior"]],
        "regimes_where_candidate_has_lower_accuracy": [rg for rg in c4s.TEST_REGIMES if cand["by_regime"][rg].get("n") and ref["by_regime"][rg].get("n")
                                                       and cand["by_regime"][rg]["accuracy_after"] < ref["by_regime"][rg]["accuracy_after"] - 0.02],
        "adopt": bool(out["acceptance_bar_on_fresh_seeds"][closest]["meets_bar"])}
    return out


def confirm() -> Dict:
    with conf_partitions():
        res = {"schema": "GeneralizationPhase12/1", "data_provenance": "SIMULATED",
               "WARNING": "Simulation only; simulator uncalibrated and self-consistent with the predictors; no physical motor operated. Fresh seeds, but the regimes were seen in Phase 11. "
                          "Nothing was re-fitted or re-selected; no variant is adopted by this study.",
               "frozen_selections": {"c2": c2s.SELECTION_FILE.split(os.sep)[-1], "c4": c4s.SELECTION_FILE.split(os.sep)[-1]},
               "c2": c2_confirm(), "c4": c4_confirm()}
    with open(OUT, "w") as f:
        json.dump(res, f, indent=1, default=float)
    return res


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("stage", choices=["confirm"]); ap.parse_args()
    r = confirm()
    print(json.dumps({"c2_claims": r["c2"]["phase11_claims_replicated"], "c4_adopt": r["c4"]["candidate_vs_phase10_guard"]["adopt"]}, default=float))


if __name__ == "__main__":
    main()
