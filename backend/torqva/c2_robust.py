"""Phase 10 - C2 prediction quality (SIMULATION ONLY). The shipped `prediction.InterventionPredictor` is the untouched CONTROL.

What a C2 prediction is (and is not)
  A prediction is the EXPECTED simulated outcome of an action over the next 120 s, estimated from a grey-box model mixed over the fault
  hypotheses, with an interval whose intended reading is: "for comparable simulated runs under matched conditions (same fault class
  distribution, operating point and measurement noise), about 90 % of single future measurements fall inside". It is NOT the exact
  counterfactual of one physical run, it is not a measurement, and it is never evidence of recovery (C5 needs fresh telemetry).
  Observations are stored separately from the prediction that preceded them (`prediction_check` records).

Candidates compared against the control (see c2c4_study.py):
  * PersistenceConformalPredictor - simple statistical baseline: future = present, intervals from split-conformal residuals.
  * NoiseAwarePredictor           - same grey-box mean as the control; intervals are (a) calibrated without a hard-coded noise floor and
                                    (b) widened ONLY for measurement noise beyond the calibration level, estimated from the pre-action
                                    windows; (c) carry an explicit status: supported / unsupported / insufficiently_validated.
"""
from __future__ import annotations

import copy
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Sequence, Tuple

import numpy as np

from .hypotheses import HYPS, Posterior
from .prediction import (ACTIONS, CHECK_HORIZONS, SIGNALS, InterventionPredictor, Prediction, StateSummary, TrustResult,
                         persistence_prediction)
from .sim import REGIMES, MotorSim, Regime, Window, rollout

Z90 = 1.645                  # one-sided 95 % normal quantile: half-width of a 90 % interval for pure Gaussian noise

# ------------------------------------------------------------------------------------------------ prediction-target specification
PREDICTION_TARGETS = {
    "CONTINUE_MONITORING": {
        "preconditions": "motor running (rpm > 50); steady or slowly varying; no mandatory-stop condition",
        "predicts": "rpm, vib_rms, current, housing temperature at t = 30, 60, 120 s after the decision",
        "meaning": "expected value and 90 % interval for a single future 1 s measurement if nothing is changed",
        "unsupported_when": "operating point unfamiliar; posterior out-of-distribution; measurement noise > 3.5x the calibration level",
        "observed_as": "fresh windows at decision time + horizon (prediction_check record, provenance SIMULATED)",
    },
    "REDUCE_SPEED": {
        "preconditions": "motor running; target rpm > 0 and at least 5 % below the current speed; passes the Safety Supervisor",
        "predicts": "same four signals at 30, 60, 120 s",
        "meaning": "expected value and 90 % interval if the commanded reduction is executed and acknowledged promptly",
        "unsupported_when": "no real reduction (target >= 95 % of speed); same conditions as above",
        "observed_as": "same; only counted if the command was executed (a rejected/aborted command never produces a comparison)",
    },
    "STOP": {
        "preconditions": "motor running (rpm > 50); STOP is always permitted by the Supervisor",
        "predicts": "same four signals at 30, 60, 120 s (coast-down, cool-down)",
        "meaning": "expected value and 90 % interval if driven power is removed",
        "unsupported_when": "motor already stopped (nothing to predict); same conditions as above",
        "observed_as": "same",
    },
}
NONNEGATIVE = ("vib_rms", "current")     # clip the lower bound at 0 only where the MEASUREMENT cannot be negative (rms magnitude; exactly 0 when
                                         # driverless). rpm and temperature are measured with additive noise and CAN read below 0 near 0 -> no clip.
MIN_CELL_N = 30              # calibration cases per (signal, action, horizon) cell below which the interval is "insufficiently validated"
NOISE_RATIO_MAX = 3.5        # measurement noise above this multiple of the calibration level = unsupported regime


@dataclass
class CellStat:
    q_raw: float
    n: int


class _Base(InterventionPredictor):
    """Shared helpers: copy fitted parameters from a fitted control so every variant has the SAME point predictions."""

    @classmethod
    def from_fitted(cls, src: InterventionPredictor, **kw):
        o = cls(tau_drive=src.tau_drive, risk_limits=dict(src.risk_limits), target_coverage=src.target_coverage, **kw)
        o.params = copy.deepcopy(src.params)
        o.thermal = src.thermal
        o.version = src.version
        return o


class NoiseAwarePredictor(_Base):
    """Intervals: half^2 = q_raw(cell)^2 + Z^2 * max(sigma_hat^2 - sigma_nom^2, 0) * (1 + 1/n_state) + spread^2, floored at
    Z * sigma_hat * sqrt(1 + 1/n_state) (the 90 % half-width of the measurement noise alone). q_raw is the split-conformal quantile of the
    absolute residual with NO hard-coded floor; sigma_nom is the calibration-time noise (median over calibration states);
    sigma_hat is estimated per case from the pre-action windows. With sigma_hat = sigma_nom it behaves like the control."""

    def __init__(self, *a, min_cell_n: int = MIN_CELL_N, noise_ratio_max: float = NOISE_RATIO_MAX, **kw):
        super().__init__(*a, **kw)
        self.cells: Dict[Tuple[str, str, int], CellStat] = {}
        self.sigma_nom: Dict[str, float] = {}
        self.min_cell_n, self.noise_ratio_max = min_cell_n, noise_ratio_max

    VIB_LEVEL_FLOOR = 0.02      # g: below this the multiplicative vibration-noise model is replaced by the additive floor

    def _noise_unit(self, s: str, st: StateSummary) -> float:
        """Scale that makes the noise level of signal s comparable across states: vibration noise is multiplicative (~5 % of the level), the
        others are additive."""
        return max(st.vib_rms, self.VIB_LEVEL_FLOOR) if s == "vib_rms" else 1.0

    def _nominal(self, s: str, st: StateSummary) -> Optional[float]:
        r = self.sigma_nom.get(s)
        return None if r is None else r * self._noise_unit(s, st)

    def noise_ratio(self, st: StateSummary) -> Optional[float]:
        if not st.noise or not self.sigma_nom:
            return None
        return max(st.noise[s] / max(self._nominal(s, st), 1e-9) for s in SIGNALS if s in self.sigma_nom)

    def calibrate(self, cases) -> None:
        res: Dict[Tuple[str, str, int], List[float]] = {}
        noises: Dict[str, List[float]] = {s: [] for s in SIGNALS}
        H = max(CHECK_HORIZONS)
        for st, post, action, target, truth in cases:
            mean, _ = self._mixture(post, st, action, target, H)
            if st.noise:
                for s in SIGNALS:
                    noises[s].append(st.noise[s] / self._noise_unit(s, st))
            for s in SIGNALS:
                y = np.array([getattr(w, s) for w in truth[:H]])
                for h in CHECK_HORIZONS:
                    res.setdefault((s, action, h), []).append(abs(y[h - 1] - mean[s][h - 1]))
        for k, v in res.items():
            v = np.sort(np.array(v)); n = len(v)
            idx = min(int(np.ceil((n + 1) * self.target_coverage)) - 1, n - 1)
            self.cells[k] = CellStat(float(v[idx]), n)
            self.q[k] = float(v[idx])                       # kept for interface compatibility (trust(), docs)
        self.sigma_nom = {s: float(np.median(v)) for s, v in noises.items() if v}
        self.calibrated = True
        self.version += 1

    # ---------------------------------------------------------------- support status
    def support(self, post: Posterior, st: StateSummary, action: str, target: float) -> Tuple[str, List[str]]:
        why_un, why_insuf = [], []
        if not self.calibrated:
            why_insuf.append("not_calibrated")
        if post.ood:
            why_un.append("hypothesis_evidence_out_of_distribution")
        if st.rpm < 50.0 and action != "STOP":
            why_un.append("motor_not_running")
        if action == "STOP" and st.rpm < 50.0:
            why_un.append("motor_already_stopped")
        if action == "REDUCE_SPEED" and not (0.0 < target <= 0.95 * max(st.rpm, 1.0)):
            why_un.append("no_real_speed_reduction")
        r = self.noise_ratio(st)
        if r is not None and r > self.noise_ratio_max:
            why_un.append(f"measurement_noise_{r:.1f}x_calibration_level")
        elif r is None:
            why_insuf.append("noise_level_unknown")
        small = [k for k, c in self.cells.items() if c.n < self.min_cell_n and k[1] == action]
        if small:
            why_insuf.append(f"calibration_cells_below_{self.min_cell_n}_cases")
        if why_un:
            return "unsupported", why_un + why_insuf
        if why_insuf:
            return "insufficiently_validated", why_insuf
        return "supported", []

    # ---------------------------------------------------------------- intervals
    def _half(self, s: str, action: str, H: int, st: StateSummary, spread: np.ndarray) -> np.ndarray:
        hs = np.array(CHECK_HORIZONS, dtype=float)
        qs = np.array([self.cells[(s, action, int(h))].q_raw if (s, action, int(h)) in self.cells else np.nan for h in hs])
        ok = ~np.isnan(qs)
        if not ok.any():
            q_t = np.zeros(H)
        else:
            q_t = np.interp(np.arange(1, H + 1), np.concatenate([[0.0], hs[ok]]), np.concatenate([[0.0], qs[ok]]))
        sig_nom = self._nominal(s, st)
        sig = (st.noise or {}).get(s, sig_nom)
        if sig is None or sig_nom is None:                     # no noise information: fall back to the control's fixed floor
            from .prediction import NOISE_FLOOR
            return np.sqrt(np.maximum(q_t, NOISE_FLOOR[s]) ** 2 + spread ** 2)
        infl = 1.0 + 1.0 / max(st.n_state, 1)
        extra = Z90 ** 2 * max(sig ** 2 - sig_nom ** 2, 0.0) * infl
        half = np.sqrt(q_t ** 2 + extra)
        half = np.maximum(half, Z90 * sig * np.sqrt(infl))
        return np.sqrt(half ** 2 + spread ** 2)

    def predict(self, post: Posterior, st: StateSummary, action: str, target_rpm: float = 0.0, H: int = 120) -> Prediction:
        mean, spread = self._mixture(post, st, action, target_rpm, H)
        lo, hi = {}, {}
        for s in SIGNALS:
            half = self._half(s, action, H, st, spread[s])
            lo[s], hi[s] = (np.maximum(mean[s] - half, 0.0) if s in NONNEGATIVE else mean[s] - half), mean[s] + half
        risk_by = {}
        from math import erf, sqrt
        for s, lim in self.risk_limits.items():
            sd = (hi[s] - mean[s]) / 1.645 + 1e-9
            z = (lim - mean[s]) / sd
            risk_by[s] = float(np.max(0.5 * (1.0 - np.vectorize(erf)(z / sqrt(2)))))
        status, why = self.support(post, st, action, target_rpm)
        return Prediction(action, target_rpm, H, mean, lo, hi, max(risk_by.values()), risk_by, status=status, status_reasons=why,
                          interval_method="noise_aware_conformal")

    def evaluate_coverage(self, cases) -> Dict[Tuple[str, str, int], float]:
        """Coverage of the intervals predict() actually returns (the control's evaluate_coverage ignores the hypothesis-spread term)."""
        hit: Dict[Tuple[str, str, int], List[int]] = {}
        for st, post, action, target, truth in cases:
            p = self.predict(post, st, action, target, max(CHECK_HORIZONS))
            for s in SIGNALS:
                y = np.array([getattr(w, s) for w in truth[:max(CHECK_HORIZONS)]])
                for h in CHECK_HORIZONS:
                    hit.setdefault((s, action, h), []).append(int(p.lo[s][h - 1] <= y[h - 1] <= p.hi[s][h - 1]))
        self.coverage = {k: float(np.mean(v)) for k, v in hit.items()}
        return self.coverage

    def trust(self, post: Posterior, op_familiar: bool, min_mean_cov: float = 0.8, min_cell_cov: float = 0.5,
              st: Optional[StateSummary] = None) -> TrustResult:
        base = super().trust(post, op_familiar, min_mean_cov, min_cell_cov, st)
        reasons = list(base.reasons)
        if st is not None:
            if st.rpm < 50.0:
                reasons.append("motor_not_running")
            r = self.noise_ratio(st)
            if r is not None and r > self.noise_ratio_max:
                reasons.append("measurement_noise_outside_calibrated_range")
        if post.ood:
            reasons.append("hypothesis_evidence_out_of_distribution")
        reasons = list(dict.fromkeys(reasons))
        return TrustResult(not reasons, reasons)


class PersistenceConformalPredictor(_Base):
    """Simple statistical baseline: the future equals the present for every action; intervals are split-conformal residual quantiles
    per (signal, action, horizon). It cannot represent the effect of an action (the interval just becomes very wide)."""

    def __init__(self, *a, **kw):
        super().__init__(*a, **kw)
        self.cells: Dict[Tuple[str, str, int], CellStat] = {}

    def calibrate(self, cases) -> None:
        res: Dict[Tuple[str, str, int], List[float]] = {}
        H = max(CHECK_HORIZONS)
        for st, post, action, target, truth in cases:
            base = persistence_prediction(st, H)
            for s in SIGNALS:
                y = np.array([getattr(w, s) for w in truth[:H]])
                for h in CHECK_HORIZONS:
                    res.setdefault((s, action, h), []).append(abs(y[h - 1] - base[s][h - 1]))
        for k, v in res.items():
            v = np.sort(np.array(v)); n = len(v)
            idx = min(int(np.ceil((n + 1) * self.target_coverage)) - 1, n - 1)
            self.cells[k] = CellStat(float(v[idx]), n)
        self.calibrated = True

    def predict(self, post: Posterior, st: StateSummary, action: str, target_rpm: float = 0.0, H: int = 120) -> Prediction:
        mean = persistence_prediction(st, H)
        hs = np.array(CHECK_HORIZONS, dtype=float)
        lo, hi = {}, {}
        for s in SIGNALS:
            qs = np.array([self.cells[(s, action, int(h))].q_raw if (s, action, int(h)) in self.cells else np.nan for h in hs])
            ok = ~np.isnan(qs)
            q_t = np.interp(np.arange(1, H + 1), np.concatenate([[0.0], hs[ok]]), np.concatenate([[0.0], qs[ok]])) if ok.any() else np.zeros(H)
            lo[s], hi[s] = np.maximum(mean[s] - q_t, 0.0), mean[s] + q_t
        return Prediction(action, target_rpm, H, mean, lo, hi, 0.0, {}, interval_method="persistence_conformal")


# ------------------------------------------------------------------------------------------------ matched-condition cases and the opt-in builder
FAMILIAR_STATUS = ("OK", "INTERPOLATED", "FROZEN")


def make_case(h, sev: float, seed: int, sp: float, regime: Regime, det, tt, hm) -> Dict:
    """One matched-condition case: a simulated run at fault class `h`, severity, seed, speed and regime; the three actions are rolled out from
    IDENTICAL starting conditions by forking the simulator (possible only in simulation)."""
    from .scenarios import ACTIONS as ACTS, posterior_from
    from .schemas import Hypothesis
    s = MotorSim(seed, regime=regime)
    s.set_setpoint(sp)
    s.run(300 if h == Hypothesis.COOLING_FAILURE else 60)
    s.inject(h, sev)
    pre = s.run(60)
    post, _ = posterior_from(pre, det, tt, hm)
    st = StateSummary.from_windows(pre)
    acts = []
    for a, frac in ACTS:
        tgt = frac * sp
        acts.append({"action": a, "target": tgt, "truth": rollout(s, a, 120, tgt)})
    return {"h": h, "sev": sev, "seed": seed, "sp": sp, "regime": regime.name, "st": st, "post": post,
            "op_fam": det.score(pre[-1]).status in FAMILIAR_STATUS, "acts": acts}


CAL_SEEDS, CAL_SPEEDS, CAL_SEV = tuple(range(9601, 9607)), (1200, 1800), (0.3, 0.6, 0.9)


def build_noise_aware(src: InterventionPredictor, det, tt, hm) -> "NoiseAwarePredictor":
    """The opt-in candidate: same fitted grey-box parameters as `src`, intervals calibrated on 216 baseline-regime calibration cases."""
    cases = [make_case(h, sev, sd, sp, REGIMES["baseline"], det, tt, hm) for h in HYPS for sev in CAL_SEV for sd in CAL_SEEDS for sp in CAL_SPEEDS]
    na = NoiseAwarePredictor.from_fitted(src)
    na.calibrate([(c["st"], c["post"], a["action"], a["target"], a["truth"]) for c in cases for a in c["acts"]])
    return na
