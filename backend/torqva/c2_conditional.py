"""Phase 11 - C2 conditional coverage (SIMULATION ONLY). Opt-in; the shipped predictor and the Phase 10 noise-aware predictor are unchanged.

Diagnosis (development seeds): the Phase 10 candidate's overload coverage (79 %) is almost entirely HOUSING TEMPERATURE (coverage 0.42 vs >= 0.9 for the other
signals). The posterior is right (mass 1.0 on overload) and an oracle posterior gives the same coverage, so it is not hypothesis disagreement; it is not noise.
The housing prediction is biased by +0.2 C at every action and horizon: the state is the MEAN of the last 10 windows, which lags a steadily rising temperature
by 4.5 s x slope; overload heats ~3x faster than the other faults (0.050 vs 0.015 C/s), so it lags most (+0.22 C vs +0.07 C; correlation of lag with slope 0.95).

Two separately evaluated candidates:
  * class_conditional (interval-only): the residual quantile is the posterior-weighted mixture of per-fault-class residual distributions (classes with fewer than
    `min_class_n` calibration cases fall back to the pooled residuals and the prediction is labelled insufficiently validated if such a class carries weight).
  * trend_state (POINT-PREDICTION change, reported independently): the housing state is the trend-corrected value at the last window (mean + slope x (n-1)/2).
"""
from __future__ import annotations

import dataclasses
from typing import Dict, List, Optional, Sequence, Tuple

import numpy as np

from .c2_robust import NoiseAwarePredictor, CellStat
from .hypotheses import HYPS, Posterior
from .prediction import CHECK_HORIZONS, SIGNALS, StateSummary
from .schemas import Hypothesis

MIN_CLASS_N = 30
# Validation (v2: noise x1.5 / x2 / hard) supported class-conditional coverage >= 0.90 for every fault only up to ~1.5x the calibration noise (worst fault 0.906 at x1.5; 0.891 at x2;
# 0.83 in the hard regime). Beyond it the conditional intervals are LABELLED insufficiently validated and are not trusted (the gate then cannot act on them).
# The domain statistic is the MEDIAN noise ratio over the additive-noise signals (rpm, current, housing): unlike the max over all four signals used by the Phase 10 'unsupported' rule it is
# unaffected by fault-induced vibration variability (baseline median 1.00, p99 1.31 for every fault class; x1.5 -> 1.50; x2 -> 1.97; hard -> 2.02). The threshold 1.75 is the midpoint between
# the validated 1.5x and the first failing level (2x), allowing for the +-0.25 scatter of the estimate (baseline: 0 % flagged; x1.5: 12 %; x2: 83 %).
DOMAIN_NOISE_RATIO = 1.75
DOMAIN_SIGNALS = ("rpm", "current", "housing")


def weighted_quantile(values: np.ndarray, weights: np.ndarray, level: float) -> float:
    o = np.argsort(values)
    v, w = values[o], weights[o]
    c = np.cumsum(w) / w.sum()
    return float(v[min(int(np.searchsorted(c, level, side="left")), len(v) - 1)])


class ConditionalPredictor(NoiseAwarePredictor):
    def __init__(self, *a, trend_state: bool = False, class_conditional: bool = False, min_class_n: int = MIN_CLASS_N, domain_ratio_max: Optional[float] = DOMAIN_NOISE_RATIO, **kw):
        super().__init__(*a, **kw)
        self.trend_state, self.class_conditional, self.min_class_n = trend_state, class_conditional, min_class_n
        self.domain_ratio_max = domain_ratio_max      # class-conditional intervals are validated only up to this measurement-noise ratio (see DOMAIN_NOISE_RATIO)
        self.class_res: Dict[Tuple[str, str, int], Dict[Hypothesis, np.ndarray]] = {}
        self.pooled_res: Dict[Tuple[str, str, int], np.ndarray] = {}

    @property
    def method_name(self) -> str:
        parts = ["class_conditional" if self.class_conditional else "pooled", "trend_state" if self.trend_state else None]
        return "conformal[" + "+".join(p for p in parts if p) + "]"

    # ---------------- point-prediction change (explicit, separately evaluated) ----------------
    def corrected_state(self, st: StateSummary) -> StateSummary:
        if not self.trend_state or not st.trend:
            return st
        return dataclasses.replace(st, housing=st.housing + st.trend["housing"] * (st.n_state - 1) / 2.0)

    def _mixture(self, post, st, action, target, H):
        return super()._mixture(post, self.corrected_state(st), action, target, H)

    # ---------------- calibration ----------------
    def calibrate(self, cases, labels: Optional[Sequence[Hypothesis]] = None) -> None:
        """cases: (state, posterior, action, target, truth windows); labels: the TRUE fault class of each case (needed for class-conditional calibration)."""
        super().calibrate(cases)
        if not self.class_conditional:
            return
        assert labels is not None and len(labels) == len(cases), "class-conditional calibration needs the true fault class of every calibration case"
        H = max(CHECK_HORIZONS)
        per: Dict[Tuple[str, str, int], Dict[Hypothesis, List[float]]] = {}
        for (st, post, action, target, truth), lab in zip(cases, labels):
            mean, _ = self._mixture(post, st, action, target, H)
            for s in SIGNALS:
                y = np.array([getattr(w, s) for w in truth[:H]])
                for h in CHECK_HORIZONS:
                    per.setdefault((s, action, h), {}).setdefault(lab, []).append(abs(y[h - 1] - mean[s][h - 1]))
        for k, d in per.items():
            self.class_res[k] = {h: np.sort(np.array(v)) for h, v in d.items()}
            self.pooled_res[k] = np.sort(np.concatenate([np.array(v) for v in d.values()]))

    def class_sample_counts(self) -> Dict[str, int]:
        any_cell = next(iter(self.class_res.values()), {})
        return {h.value: len(v) for h, v in any_cell.items()}

    # ---------------- conditional interval ----------------
    def _q_at_horizons(self, s: str, action: str, post: Optional[Posterior]) -> np.ndarray:
        if not self.class_conditional or post is None:
            return super()._q_at_horizons(s, action, post)
        out = []
        for h in CHECK_HORIZONS:
            k = (s, action, int(h))
            if k not in self.pooled_res:
                out.append(np.nan); continue
            vals, wts = [], []
            for hyp in HYPS:
                w = post.probs.get(hyp, 0.0)
                if w <= 1e-6:
                    continue
                arr = self.class_res[k].get(hyp)
                if arr is None or len(arr) < self.min_class_n:
                    arr = self.pooled_res[k]                           # not enough class-specific evidence: pooled residuals
                vals.append(arr); wts.append(np.full(len(arr), w / len(arr)))
            v, w = np.concatenate(vals), np.concatenate(wts)
            n_eff = 1.0 / float(np.sum((w / w.sum()) ** 2)) if w.sum() > 0 else 1.0
            out.append(weighted_quantile(v, w, min(self.target_coverage * (1.0 + 1.0 / max(n_eff, 1.0)), 1.0)))
        return np.array(out)

    def noise_ratio_robust(self, st: StateSummary) -> Optional[float]:
        if not st.noise or not self.sigma_nom:
            return None
        return float(np.median([st.noise[s] / max(self._nominal(s, st), 1e-9) for s in DOMAIN_SIGNALS if s in self.sigma_nom]))

    def _outside_conditional_domain(self, st: StateSummary) -> Optional[float]:
        if not self.class_conditional or self.domain_ratio_max is None:
            return None
        r = self.noise_ratio_robust(st)
        return r if (r is not None and r > self.domain_ratio_max) else None

    def trust(self, post, op_familiar, min_mean_cov=0.8, min_cell_cov=0.5, st=None):
        base = super().trust(post, op_familiar, min_mean_cov, min_cell_cov, st)
        if st is not None and self._outside_conditional_domain(st) is not None:
            from .prediction import TrustResult
            return TrustResult(False, list(dict.fromkeys(base.reasons + ["conditional_calibration_domain_exceeded"])))
        return base

    def support(self, post, st, action, target):
        status, why = super().support(post, st, action, target)
        r = self._outside_conditional_domain(st)
        if r is not None and status != "unsupported":
            return "insufficiently_validated", [f"conditional_calibration_domain_exceeded:noise_{r:.1f}x_(validated_to_{self.domain_ratio_max:g}x)"] + why
        if self.class_conditional and status == "supported":
            thin = [h.value for h in HYPS if post.probs.get(h, 0.0) >= 0.1 and len(next(iter(self.class_res.values()), {}).get(h, [])) < self.min_class_n]
            if thin:
                return "insufficiently_validated", [f"class_conditional_calibration_below_{self.min_class_n}_cases:{','.join(thin)}"]
        return status, why


class RegimeGatedPredictor(ConditionalPredictor):
    """Class-conditional, trend-corrected intervals INSIDE their validated calibration domain (measured noise <= `domain_ratio_max` x the calibration level);
    OUTSIDE it the Phase 10 pooled noise-aware prediction (a separate predictor, calibrated on the same cases) is returned and labelled as a fallback.
    Rationale (test finding): class-specific residual distributions calibrated at baseline noise do not transfer under heavy noise shift (sensor-fault coverage
    0.81 in the hard regime), whereas the pooled quantile plus the noise term stays near 0.9. The measured noise ratio needs no labels."""

    def __init__(self, *a, domain_ratio_max: float = 1.5, **kw):
        super().__init__(*a, **kw)
        self.domain_ratio_max = domain_ratio_max
        self.fallback: Optional[NoiseAwarePredictor] = None

    def attach_fallback(self, fb: NoiseAwarePredictor) -> None:
        self.fallback = fb

    def in_conditional_domain(self, st: StateSummary) -> bool:
        r = self.noise_ratio_robust(st)
        return r is None or r <= self.domain_ratio_max

    def predict(self, post, st, action, target_rpm: float = 0.0, H: int = 120):
        if self.fallback is not None and not self.in_conditional_domain(st):
            p = self.fallback.predict(post, st, action, target_rpm, H)
            p.status_reasons = ["conditional_calibration_domain_exceeded:pooled_fallback"] + list(p.status_reasons)
            p.interval_method = "noise_aware_conformal[pooled fallback]"
            return p
        return super().predict(post, st, action, target_rpm, H)

    def trust(self, post, op_familiar, min_mean_cov=0.8, min_cell_cov=0.5, st=None):
        if self.fallback is not None and st is not None and not self.in_conditional_domain(st):
            return self.fallback.trust(post, op_familiar, min_mean_cov, min_cell_cov, st)
        return super().trust(post, op_familiar, min_mean_cov, min_cell_cov, st)
