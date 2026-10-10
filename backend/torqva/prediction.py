"""C2 — action-conditioned intervention outcome prediction (grey-box, with conformal intervals).

This is a model-based prediction of what is likely to happen under each action. It is labelled
"Intervention Outcome Prediction (unvalidated)" until a model version has been validated against
Intervention Outcome Experiments (docs/TORQVA_ARCHITECTURE.md). Predictions are PREDICTED provenance and
are stored separately from the observations that later confirm or refute them.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Optional, Sequence, Tuple

import numpy as np

from .detection import ThermalTracker
from .hypotheses import HYPS, Posterior
from .schemas import Hypothesis
from .sim import MotorSim, Window

ACTIONS = ("CONTINUE_MONITORING", "REDUCE_SPEED", "STOP")
SIGNALS = ("rpm", "vib_rms", "current", "housing")
CHECK_HORIZONS = (30, 60, 120)
# Measurement-noise floors for interval half-widths (a prediction cannot be tighter than the sensor).
NOISE_FLOOR = {"rpm": 3.0, "vib_rms": 0.006, "current": 0.04, "housing": 0.15}
OPERATIONAL_COST = {"CONTINUE_MONITORING": 0.0, "REDUCE_SPEED": 0.3, "STOP": 1.0}


def estimate_noise(ws: Sequence[Window], n: int = 40, min_windows: int = 12) -> Optional[Dict[str, float]]:
    """Per-signal measurement-noise scale from window-to-window differences of the last `n` windows (robust: MAD of the first differences,
    insensitive to constant offsets and slow trends). None if there are too few windows."""
    w = list(ws)[-n:]
    if len(w) < min_windows:
        return None
    out = {}
    for s in SIGNALS:
        d = np.diff(np.array([getattr(x, s) for x in w], dtype=float))
        out[s] = float(1.4826 * np.median(np.abs(d - np.median(d))) / np.sqrt(2.0))
    return out


@dataclass
class StateSummary:
    rpm: float
    setpoint: float
    current: float
    housing: float
    ambient: float
    vib_rms: float
    noise: Optional[Dict[str, float]] = None      # estimated measurement noise per signal (used only by the noise-aware predictor)
    n_state: int = 10                             # windows averaged into rpm/current/housing/vib_rms
    trend: Optional[Dict[str, float]] = None      # least-squares slope per second over the same windows (Phase 11: used only by the opt-in conditional predictor)

    @staticmethod
    def from_windows(ws: Sequence[Window], n: int = 10) -> "StateSummary":
        w = list(ws)[-n:]
        m = lambda f: float(np.mean([f(x) for x in w]))
        t = np.arange(len(w), dtype=float)
        trend = {s: float(np.polyfit(t, [getattr(x, s) for x in w], 1)[0]) for s in SIGNALS} if len(w) >= 5 else None
        return StateSummary(m(lambda x: x.rpm), w[-1].setpoint, m(lambda x: x.current), m(lambda x: x.housing),
                            w[-1].ambient, m(lambda x: x.vib_rms), estimate_noise(ws), len(w), trend)


@dataclass
class Prediction:
    action: str
    target_rpm: float
    horizon_s: int
    mean: Dict[str, np.ndarray]            # signal -> value at t = 1..H
    lo: Dict[str, np.ndarray]
    hi: Dict[str, np.ndarray]
    risk: float                            # P(crossing a warn limit within horizon)
    risk_by_signal: Dict[str, float]
    provenance: str = "PREDICTED"
    # Phase 10: explicit support status. "supported" is the only status that may drive a decision; the baseline predictor always says so.
    status: str = "supported"                # supported | unsupported | insufficiently_validated
    status_reasons: List[str] = field(default_factory=list)
    interval_method: str = "split_conformal_floor"


@dataclass
class TrustResult:
    trusted: bool
    reasons: List[str]


@dataclass
class HypothesisParams:
    vib_exp: float
    tau_coast: float
    cool_mult: float
    c0: float          # current = c0 + c1 * rpm (while driven)
    c1: float


class InterventionPredictor:
    def __init__(self, tau_drive: float = 1.0, risk_limits: Optional[Dict[str, float]] = None,
                 target_coverage: float = 0.9):
        self.tau_drive = tau_drive
        self.params: Dict[Hypothesis, HypothesisParams] = {}
        self.thermal: Optional[ThermalTracker] = None
        self.risk_limits = risk_limits or {"housing": 50.0, "vib_rms": 0.35, "current": 2.2}
        self.target_coverage = target_coverage
        self.q: Dict[Tuple[str, str, int], float] = {}        # conformal half-widths
        self.coverage: Dict[Tuple[str, str, int], float] = {}
        self.calibrated = False
        self.version = 0
        self.validated_by_experiments = False                  # set only by the experiment runner

    # ---------------- fitting from labelled sessions (sim now, real later) ----------------
    def fit(self, thermal: ThermalTracker, setpoints=(900, 1500, 2100), severity: float = 0.7, seeds=(1, 2)) -> None:
        self.thermal = thermal
        for h in HYPS:
            pairs, curr, coasts, vibs = [], [], [], []
            for seed in seeds:
                for sp in setpoints:
                    s = MotorSim(700 + seed); s.set_setpoint(sp); s.run(40); s.inject(h, severity)
                    w = s.run(30)[10:]
                    pairs.append((np.mean([x.rpm for x in w]), np.mean([x.vib_rms for x in w])))
                    curr.append((np.mean([x.rpm for x in w]), np.mean([x.current for x in w])))
                s = MotorSim(800 + seed); s.set_setpoint(1800); s.run(40); s.inject(h, severity); s.run(10)
                s.stop(); cw = s.run(25)
                r = np.array([max(x.rpm, 1) for x in cw]); keep = r > 150
                t = np.arange(len(r), dtype=float)
                coasts.append(-1.0 / min(np.polyfit(t[keep], np.log(r[keep]), 1)[0], -1e-4) if keep.sum() > 3 else 5.0)
            P = np.array(pairs)
            exp_ = np.polyfit(np.log(P[:, 0]), np.log(np.maximum(P[:, 1], 1e-6)), 1)[0]
            C = np.array(curr)
            c1, c0 = np.polyfit(C[:, 0], C[:, 1], 1)
            # cooling multiplier from a long fixed-load run
            s = MotorSim(900); s.set_setpoint(1500); s.run(200); s.inject(h, severity)
            long = s.run(700)
            tt = ThermalTracker()
            ok = tt.fit(long[100:])
            cm = float(np.clip(tt.b / thermal.b, 0.1, 1.5)) if (ok and thermal.b) else 1.0
            self.params[h] = HypothesisParams(float(np.clip(exp_, 0.5, 3.0)), float(np.clip(np.mean(coasts), 0.8, 20)), cm,
                                              float(c0), float(c1))
        self.version += 1

    # ---------------- per-hypothesis rollout ----------------
    def _path(self, h: Hypothesis, st: StateSummary, action: str, target: float, H: int) -> Dict[str, np.ndarray]:
        p = self.params[h]
        t = np.arange(1, H + 1, dtype=float)
        r0 = max(st.rpm, 1.0)
        if action == "CONTINUE_MONITORING":
            rpm = np.full(H, st.rpm)
        elif action == "REDUCE_SPEED":
            rpm = target + (st.rpm - target) * np.exp(-t / self.tau_drive)
        else:
            rpm = st.rpm * np.exp(-t / p.tau_coast)
        vib = st.vib_rms * (np.maximum(rpm, 1e-6) / r0) ** p.vib_exp
        driven = action != "STOP"
        offset = st.current - (p.c0 + p.c1 * st.rpm)
        cur = np.maximum(p.c0 + p.c1 * rpm + offset, 0.0) if driven else np.zeros(H)
        a, b = self.thermal.a, self.thermal.b * p.cool_mult
        T = np.empty(H); Tc = st.housing
        for i in range(H):
            Tc = Tc + a * cur[i] ** 2 - b * (Tc - st.ambient)
            T[i] = Tc
        return {"rpm": rpm, "vib_rms": vib, "current": cur, "housing": T}

    def _mixture(self, post: Posterior, st: StateSummary, action: str, target: float, H: int):
        paths = {h: self._path(h, st, action, target, H) for h in HYPS if h in self.params}
        probs = np.array([post.probs[h] for h in paths])
        probs = probs / probs.sum()
        mean, spread = {}, {}
        for s in SIGNALS:
            M = np.vstack([paths[h][s] for h in paths])
            mu = probs @ M
            mean[s] = mu
            spread[s] = np.sqrt(probs @ (M - mu) ** 2)          # between-hypothesis spread
        return mean, spread

    # ---------------- conformal calibration ----------------
    def calibrate(self, cases: Sequence[Tuple[StateSummary, Posterior, str, float, Sequence[Window]]]) -> None:
        """cases: (state, posterior, action, target_rpm, TRUE future windows). Split-conformal, per signal x action x horizon."""
        res: Dict[Tuple[str, str, int], List[float]] = {}
        for st, post, action, target, truth in cases:
            H = max(CHECK_HORIZONS)
            mean, _ = self._mixture(post, st, action, target, H)
            for s in SIGNALS:
                y = np.array([getattr(w, {"housing": "housing"}.get(s, s)) for w in truth[:H]])
                for h in CHECK_HORIZONS:
                    res.setdefault((s, action, h), []).append(abs(y[h - 1] - mean[s][h - 1]))
        for k, v in res.items():
            v = np.sort(np.array(v)); n = len(v)
            idx = min(int(np.ceil((n + 1) * self.target_coverage)) - 1, n - 1)
            self.q[k] = max(float(v[idx]), NOISE_FLOOR[k[0]])
        self.calibrated = True
        self.version += 1

    def evaluate_coverage(self, cases) -> Dict[Tuple[str, str, int], float]:
        hit: Dict[Tuple[str, str, int], List[int]] = {}
        for st, post, action, target, truth in cases:
            H = max(CHECK_HORIZONS)
            mean, _ = self._mixture(post, st, action, target, H)
            for s in SIGNALS:
                y = np.array([getattr(w, s) for w in truth[:H]])
                for h in CHECK_HORIZONS:
                    q = self.q.get((s, action, h))
                    if q is not None:
                        hit.setdefault((s, action, h), []).append(int(abs(y[h - 1] - mean[s][h - 1]) <= q))
        self.coverage = {k: float(np.mean(v)) for k, v in hit.items()}
        return self.coverage

    # ---------------- prediction ----------------
    def predict(self, post: Posterior, st: StateSummary, action: str, target_rpm: float = 0.0, H: int = 120) -> Prediction:
        mean, spread = self._mixture(post, st, action, target_rpm, H)
        lo, hi = {}, {}
        hs = np.array(CHECK_HORIZONS, dtype=float)
        for s in SIGNALS:
            qs = np.array([self.q.get((s, action, int(h)), np.nan) for h in hs])
            if np.all(np.isnan(qs)):
                q_t = np.full(H, np.nan)
            else:
                ok = ~np.isnan(qs)
                q_t = np.interp(np.arange(1, H + 1), np.concatenate([[0.0], hs[ok]]), np.concatenate([[0.0], qs[ok]]))
            half = np.sqrt(np.nan_to_num(q_t, nan=0.0) ** 2 + spread[s] ** 2)
            lo[s], hi[s] = np.maximum(mean[s] - half, 0.0), mean[s] + half     # rpm, vibration, current, deg C-above-zero cannot be negative
        risk_by = {}
        for s, lim in self.risk_limits.items():
            sd = (hi[s] - mean[s]) / 1.645 + 1e-9
            z = (lim - mean[s]) / sd
            from math import erf, sqrt
            pr = 0.5 * (1.0 - np.vectorize(erf)(z / sqrt(2)))
            risk_by[s] = float(np.max(pr))
        return Prediction(action, target_rpm, H, mean, lo, hi, max(risk_by.values()), risk_by)

    def compare(self, post: Posterior, st: StateSummary, reduce_to: float, H: int = 120) -> List[Prediction]:
        preds = [self.predict(post, st, "CONTINUE_MONITORING", 0.0, H),
                 self.predict(post, st, "REDUCE_SPEED", reduce_to, H),
                 self.predict(post, st, "STOP", 0.0, H)]
        # risk first (rounded so noise-level differences fall through to cost), then operational cost
        return sorted(preds, key=lambda p: (round(p.risk, 2), OPERATIONAL_COST[p.action]))

    def trust(self, post: Posterior, op_familiar: bool, min_mean_cov: float = 0.8, min_cell_cov: float = 0.5,
              st: Optional[StateSummary] = None) -> TrustResult:
        """Is it reasonable to let C2's ranking drive a decision? Conservative: any failed check -> not trusted."""
        reasons = []
        if not self.calibrated:
            reasons.append("not_calibrated")
        if self.coverage:
            if float(np.mean(list(self.coverage.values()))) < min_mean_cov:
                reasons.append("mean_coverage_below_target")
            if min(self.coverage.values()) < min_cell_cov:
                reasons.append("some_signal_action_cell_poorly_covered")
        if not op_familiar:
            reasons.append("operating_point_unfamiliar")
        if post.top_p < 0.4:
            reasons.append("posterior_too_flat")
        return TrustResult(not reasons, reasons)


def persistence_prediction(st: StateSummary, H: int) -> Dict[str, np.ndarray]:
    """Baseline C2 must beat: the future equals the present, whatever the action."""
    return {"rpm": np.full(H, st.rpm), "vib_rms": np.full(H, st.vib_rms), "current": np.full(H, st.current),
            "housing": np.full(H, st.housing)}
