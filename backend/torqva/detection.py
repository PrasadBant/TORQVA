"""C1 — self-learning anomaly detection across operating-speed bins.

One robust Gaussian per RPM bin (median/MAD-trimmed mean + shrunk covariance), Mahalanobis score,
threshold = high percentile of the *training* scores. Includes a drift guard (Page-Hinkley on per-bin
scores) that freezes learning for a bin. Everything is versioned and can be rolled back.
"""
from __future__ import annotations

import copy
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Sequence, Tuple

import numpy as np

from .sim import FEATURES, Window

MIN_TRAIN = 30
# Per-feature scale floors. A healthy feature with a tiny training spread (e.g. the thermal residual, which is ~0 by
# construction) must not make ordinary measurement noise look like a many-sigma event.
ABS_SCALE_FLOOR = {"thermal_resid": 0.3, "voltage": 0.05, "duty": 0.3, "i_per_krpm": 0.01}
REL_SCALE_FLOOR = 0.03


@dataclass
class BinModel:
    mean: np.ndarray
    prec: np.ndarray                  # inverse covariance
    scale: np.ndarray                 # per-feature std (for contribution reporting)
    threshold: float
    n: int
    frozen: bool = False
    anchor_rpm: float = 0.0           # mean training setpoint: the speed at which `mean` is valid


@dataclass
class Score:
    value: Optional[float]            # None if bin unlearned
    threshold: Optional[float]
    anomalous: bool
    bin: int
    status: str                       # "OK" | "UNLEARNED_BIN" | "INTERPOLATED" | "FROZEN"
    contributions: Dict[str, float] = field(default_factory=dict)
    z: Optional[np.ndarray] = None    # signed per-feature z-scores vs the bin baseline


class BaselineDetector:
    def __init__(self, bin_width_rpm: float = 300.0, percentile: float = 99.5, min_train: int = MIN_TRAIN):
        self.bin_width = bin_width_rpm
        self.percentile = percentile
        self.min_train = min_train
        self.bins: Dict[int, BinModel] = {}
        self.version = 0
        self._history: List[Dict[int, BinModel]] = []
        self._buf: Dict[int, List[np.ndarray]] = {}

    # ---------- training ----------
    def bin_of(self, rpm: float) -> int:
        return int(rpm // self.bin_width)

    @staticmethod
    def steady(w: Window) -> bool:
        return bool(w.valid and w.driven and w.setpoint > 0 and abs(w.rpm - w.setpoint) < 0.03 * w.setpoint)

    def fit(self, windows: Sequence[Window]) -> int:
        """Learn baselines from windows the human marked healthy. Returns the new version number."""
        self._history.append(copy.deepcopy(self.bins))
        groups: Dict[int, List[np.ndarray]] = {}
        for w in windows:
            if self.steady(w):
                groups.setdefault(self.bin_of(w.setpoint), []).append(w.features())
        anchors: Dict[int, float] = {}
        for w in windows:
            if self.steady(w):
                anchors.setdefault(self.bin_of(w.setpoint), []).append(w.setpoint)
        for b, rows in groups.items():
            if len(rows) >= self.min_train and not (b in self.bins and self.bins[b].frozen):
                m = self._fit_bin(np.vstack(rows))
                m.anchor_rpm = float(np.mean(anchors[b]))
                self.bins[b] = m
        self.version += 1
        return self.version

    def _fit_bin(self, X: np.ndarray) -> BinModel:
        med = np.median(X, axis=0)
        mad = np.median(np.abs(X - med), axis=0) * 1.4826 + 1e-9
        keep = np.all(np.abs(X - med) < 4.0 * mad, axis=1)          # trim gross outliers
        Xk = X[keep] if keep.sum() >= self.min_train else X
        mean = Xk.mean(axis=0)
        floor = np.array([max(ABS_SCALE_FLOOR.get(f, 0.0), REL_SCALE_FLOOR * abs(m)) for f, m in zip(FEATURES, mean)])
        std = np.maximum(Xk.std(axis=0), floor) + 1e-6
        Z = (Xk - mean) / std
        cov = np.cov(Z, rowvar=False)
        lam = 0.1                                                    # shrink toward identity: small-sample stability
        cov = (1 - lam) * cov + lam * np.eye(cov.shape[0])
        prec = np.linalg.inv(cov)
        scores = np.einsum("ij,jk,ik->i", Z, prec, Z)
        thr = float(np.percentile(scores, self.percentile)) * 1.5      # margin for unseen healthy variation
        return BinModel(mean, prec, std, thr, len(Xk))

    # ---------- scoring ----------
    def _score_in_bin(self, m: BinModel, x: np.ndarray) -> Tuple[float, Dict[str, float], np.ndarray]:
        z = (x - m.mean) / m.scale
        d = float(z @ m.prec @ z)
        contrib = {f: float(abs(zi)) for f, zi in zip(FEATURES, z)}
        return d, contrib, z

    def score(self, w: Window) -> Score:
        if not w.valid or not w.driven or w.setpoint <= 0:
            return Score(None, None, False, -1, "UNLEARNED_BIN")
        b = self.bin_of(w.setpoint)
        if not self.steady(w):                       # speed still changing: excluded (master prompt C1.1)
            return Score(None, None, False, b, "TRANSIENT")
        x = w.features()
        sp = w.setpoint
        near = [m for bb, m in self.bins.items() if abs(bb - b) <= 1]
        lo = max((m for m in near if m.anchor_rpm <= sp), key=lambda m: m.anchor_rpm, default=None)
        hi = min((m for m in near if m.anchor_rpm >= sp), key=lambda m: m.anchor_rpm, default=None)
        if lo is None and hi is None:
            return Score(None, None, False, b, "UNLEARNED_BIN")
        if b not in self.bins and not (lo is not None and hi is not None and lo is not hi):
            return Score(None, None, False, b, "UNLEARNED_BIN")
        status = "OK" if b in self.bins else "INTERPOLATED"
        if lo is None or hi is None or lo is hi:
            m = lo or hi            # inside a single-anchor bin: use it as is
        else:
            # Baseline varies smoothly with speed: interpolate mean/scale/threshold between the two anchors.
            t = (sp - lo.anchor_rpm) / max(hi.anchor_rpm - lo.anchor_rpm, 1e-9)
            near_m = lo if t < 0.5 else hi
            m = BinModel(lo.mean + t * (hi.mean - lo.mean), near_m.prec, lo.scale + t * (hi.scale - lo.scale),
                         lo.threshold + t * (hi.threshold - lo.threshold), near_m.n, near_m.frozen, sp)
        d, c, z = self._score_in_bin(m, x)
        if m.frozen:
            status = "FROZEN"
        return Score(d, m.threshold, d > m.threshold, b, status, c, z)

    def coverage(self) -> Dict[int, int]:
        return {b: m.n for b, m in sorted(self.bins.items())}

    # ---------- versioning ----------
    def rollback(self) -> int:
        if not self._history:
            raise RuntimeError("no earlier version")
        self.bins = self._history.pop()
        self.version += 1
        return self.version


class ThermalTracker:
    """First-order housing model  dT/dt = a*I^2 - b*(T - Ta), fitted from healthy data only.
    Its residual (measured - predicted) is the thermal feature: cooling problems show up as a growing residual.
    """

    def __init__(self):
        self.a: Optional[float] = None
        self.b: Optional[float] = None
        self._model_T: Optional[float] = None

    def fit(self, windows: Sequence[Window]) -> bool:
        if len(windows) < 60:
            return False
        T = np.array([w.housing for w in windows])
        Ta = np.array([w.ambient for w in windows])
        I2 = np.array([w.current ** 2 for w in windows])
        dT = np.diff(T)
        # smooth the noisy derivative over a lag of 10 s
        lag = 10
        y = (T[lag:] - T[:-lag]) / lag
        X = np.column_stack([I2[:-lag:1][: len(y)], -(T[:-lag] - Ta[:-lag])])
        coef, *_ = np.linalg.lstsq(X, y, rcond=None)
        if not (coef[0] > 0 and coef[1] > 0):
            return False
        self.a, self.b = float(coef[0]), float(coef[1])
        return True

    @property
    def fitted(self) -> bool:
        return self.a is not None

    def reset(self, measured_T: float) -> None:
        self._model_T = measured_T

    def update(self, w: Window) -> float:
        """Advance the model one second, return residual and store it on the window."""
        if not self.fitted:
            return 0.0
        if self._model_T is None:
            self._model_T = w.housing
        self._model_T += self.a * w.current ** 2 - self.b * (self._model_T - w.ambient)
        w.thermal_resid = w.housing - self._model_T
        return w.thermal_resid


class DriftGuard:
    """Page-Hinkley on a per-bin score stream. Gradual upward drift freezes learning for that bin."""

    def __init__(self, delta: float = 0.05, lam: float = 15.0):
        self.delta, self.lam = delta, lam
        self._mean: Dict[int, float] = {}
        self._n: Dict[int, int] = {}
        self._cum: Dict[int, float] = {}
        self._min: Dict[int, float] = {}
        self.alerts: List[int] = []

    def update(self, b: int, score: float) -> bool:
        n = self._n.get(b, 0) + 1
        m = self._mean.get(b, 0.0) + (score - self._mean.get(b, 0.0)) / n
        cum = self._cum.get(b, 0.0) + (score - m - self.delta)
        mn = min(self._min.get(b, 0.0), cum)
        self._n[b], self._mean[b], self._cum[b], self._min[b] = n, m, cum, mn
        if cum - mn > self.lam and n > 20:
            if b not in self.alerts:
                self.alerts.append(b)
            return True
        return False


def continual_update_allowed(score: Score, incident_open: bool, in_cooldown: bool, bin_frozen: bool) -> bool:
    """Guardrails for continuous learning (master prompt C1.6)."""
    if incident_open or in_cooldown or bin_frozen:
        return False
    if score.value is None or score.threshold is None:
        return False
    return score.value < 0.5 * score.threshold
