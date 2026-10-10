"""C1 robustness extensions (Phase 8). SIMULATION-validated only; nothing here has seen a physical motor.

`detection.BaselineDetector` is the untouched CONTROL. This module adds, without changing any existing interface:

* `AdaptiveBaselineDetector`  - identical fit/score to the control when no session reference is supplied
                                (tested bit-for-bit); can additionally score against an immutable `SessionReference`.
* `RobustBaselineDetector`    - Candidate A: median/MAD location+scale, winsorised covariance, tunable relative scale floor.
* `ReferenceRegistry`         - Candidate B: versioned, validated, auditable, reversible per-session reference
                                (vibration common-mode gain + per-feature noise inflation) estimated from a TRUSTED healthy
                                warm-up. The trained baseline itself is never modified.
* `assess_session`            - Candidate C: explicit HEALTHY / FAULT / UNFAMILIAR_REGIME verdict. A flagged session whose
                                deviation is a coherent common-mode vibration gain shift, a pure noise inflation, or
                                outside the learned speed range is "unfamiliar regime" (needs more evidence), not a fault.

Design assumption (stated, not proven): healthy nuisance shifts of the vibration sensor/environment are COMMON-MODE across the
vibration channels (a gain), while mechanical faults are CHANNEL-SELECTIVE (imbalance moves 1x only, looseness moves 2x/3x/HF).
Current, duty, voltage, power and thermal residual are deliberately NOT adapted: they carry the overload / supply-voltage /
cooling faults, so a shift there is never absorbed.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field, replace
from typing import Callable, Dict, List, Optional, Sequence, Tuple

import numpy as np

from .detection import ABS_SCALE_FLOOR, REL_SCALE_FLOOR, BaselineDetector, BinModel, Score
from .sim import FEATURES, Window

VIB = ("vib_rms", "v1x", "v2x", "v3x", "vhf")
VIB_IDX = [FEATURES.index(f) for f in VIB]
NONVIB_IDX = [i for i in range(len(FEATURES)) if i not in VIB_IDX]
MIN_FLAGGED = 8                  # same session rule as the existing evaluation: >= 8 anomalous windows
LOG_EPS = 1e-6


# ======================================================================================================== reference
@dataclass(frozen=True)
class SessionReference:
    """Immutable per-session correction of the trained baseline. gain: multiplicative on the vibration means;
    nu: per-feature multiplicative inflation (>=1) of the trained scales."""
    version: int
    gain: float
    nu: Tuple[float, ...]
    n_warmup: int
    metrics: Tuple[Tuple[str, float], ...] = ()


@dataclass
class ReferenceConfig:
    coh_tol: float = 0.10            # max |per-channel log gain - common log gain| for a nuisance (common-mode) shift
    gain_lo: float = 0.70
    gain_hi: float = 1.40
    nu_max: float = 3.5
    nu_deadzone: float = 1.25        # estimates below this are sampling noise: not inflated
    stat_tol: float = 0.06           # warm-up must be stationary: |first-half - second-half| log gain
    min_warmup: int = 30
    max_unlearned_frac: float = 0.2
    self_check_max_flag: float = 0.05
    probe_factor: float = 1.6        # sensitivity probe: v1x x1.6 (~ imbalance severity 0.1) must still be flagged
    probe_min_flag: float = 0.7


@dataclass
class ReferenceProposal:
    accepted: bool
    reason: str
    reference: Optional[SessionReference]
    metrics: Dict[str, float] = field(default_factory=dict)


class ReferenceRegistry:
    """Versioned proposals -> validated activation -> rollback, every step logged (append-only list; pass `audit` to also forward
    each entry to the append-only audit store). Active model is never mutated: a reference is a separate immutable object."""

    def __init__(self, audit: Optional[Callable[[Dict], None]] = None):
        self.log: List[Dict] = []
        self._versions: List[SessionReference] = []
        self._active: List[int] = []         # stack of activated versions; top = active, below = last known good
        self._audit = audit
        self._seq = 0

    def _emit(self, event: str, version: Optional[int], reason: str, metrics: Optional[Dict] = None) -> None:
        self._seq += 1
        e = {"seq": self._seq, "event": event, "version": version, "reason": reason, "metrics": metrics or {}}
        self.log.append(e)
        if self._audit:
            self._audit(e)

    @property
    def active(self) -> Optional[SessionReference]:
        return self._versions[self._active[-1] - 1] if self._active else None

    def propose(self, det: "AdaptiveBaselineDetector", warm: Sequence[Window], trusted: bool, *, incident_open: bool = False,
                in_cooldown: bool = False, cfg: Optional[ReferenceConfig] = None) -> ReferenceProposal:
        cfg = cfg or ReferenceConfig()
        version = len(self._versions) + 1
        self._emit("proposed", version, "warm-up of %d windows" % len(warm))
        prop = _estimate_reference(det, warm, trusted, incident_open, in_cooldown, cfg, version)
        if not prop.accepted:
            self._emit("rejected", version, prop.reason, prop.metrics)
            return prop
        self._versions.append(prop.reference)
        self._active.append(version)
        self._emit("accepted", version, prop.reason, prop.metrics)
        return prop

    def rollback(self) -> Optional[SessionReference]:
        """Return to the last known-good reference (or to the unadapted trained baseline if there is none)."""
        if not self._active:
            raise RuntimeError("no active reference to roll back")
        v = self._active.pop()
        self._emit("rolled_back", v, "returned to version %s" % (self._active[-1] if self._active else "trained baseline"))
        return self.active


def _steady_models(det: "AdaptiveBaselineDetector", warm: Sequence[Window]):
    rows, models, unlearned = [], [], 0
    for w in warm:
        if not det.steady(w):
            continue
        m, _status, _b = det.resolve_model(w)
        if m is None:
            unlearned += 1
            continue
        rows.append(w); models.append(m)
    return rows, models, unlearned


def _log_gain_matrix(rows: Sequence[Window], models: Sequence[BinModel]) -> np.ndarray:
    X = np.array([r.features()[VIB_IDX] for r in rows]); M = np.array([m.mean[VIB_IDX] for m in models])
    return np.log(np.maximum(X, LOG_EPS) / np.maximum(M, LOG_EPS))


def _estimate_nuisance(det, rows, models, cfg: ReferenceConfig):
    """Common-mode vibration gain + per-feature noise inflation from `rows`. Returns (ok, reason, gain, nu, metrics)."""
    Lw = _log_gain_matrix(rows, models)                          # n x 5
    Lc = np.median(Lw, axis=0)
    common = float(np.median(Lc))
    spread = float(np.max(np.abs(Lc - common)))
    m = {"spread": spread, "log_gain": common}
    if spread > cfg.coh_tol:
        return False, "incoherent_vibration_channels", 1.0, None, m          # channel-selective: looks like a fault, not a gain shift
    gain = math.exp(common)
    m["gain"] = gain
    if not (cfg.gain_lo <= gain <= cfg.gain_hi):
        return False, "gain_outside_envelope", gain, None, m
    half = len(Lw) // 2
    drift = float(abs(np.median(np.median(Lw[:half], axis=0)) - np.median(np.median(Lw[half:], axis=0))))
    m["drift"] = drift
    if drift > cfg.stat_tol:
        return False, "non_stationary_warmup", gain, None, m
    # per-feature noise inflation from first differences (insensitive to constant offsets and slow trends)
    X = np.array([r.features() for r in rows]); S = np.array([mm.scale for mm in models])
    g = np.ones(len(FEATURES)); g[VIB_IDX] = gain
    D = np.diff(X, axis=0) / (S[1:] * g)
    est = 1.4826 * np.median(np.abs(D - np.median(D, axis=0)), axis=0) / math.sqrt(2.0)
    m["nu_max_seen"] = float(est.max())
    if float(est.max()) > cfg.nu_max:
        return False, "noise_outside_envelope", gain, None, m
    nu = np.where(est >= cfg.nu_deadzone, est, 1.0)
    m["nu_max"] = float(nu.max())
    return True, "ok", gain, nu, m


def _estimate_reference(det, warm, trusted, incident_open, in_cooldown, cfg: ReferenceConfig, version: int) -> ReferenceProposal:
    def no(reason, **m):
        return ReferenceProposal(False, reason, None, {k: float(v) for k, v in m.items()})

    if not trusted or incident_open or in_cooldown:
        return no("untrusted_observations")                     # never learn from unconfirmed / incident / cooldown periods
    if any((not w.valid) for w in warm):
        return no("invalid_telemetry_in_warmup")
    rows, models, unlearned = _steady_models(det, warm)
    if len(rows) < cfg.min_warmup:
        return no("insufficient_steady_warmup", n=len(rows))
    if unlearned / max(unlearned + len(rows), 1) > cfg.max_unlearned_frac:
        return no("unfamiliar_operating_region", unlearned=unlearned)
    ok, reason, gain, nu, met = _estimate_nuisance(det, rows, models, cfg)
    if not ok:
        return no(reason, **met)
    ref = SessionReference(version, gain, tuple(float(x) for x in nu), len(rows),
                           (("gain", gain), ("spread", met["spread"]), ("drift", met["drift"]), ("nu_max", met["nu_max"])))
    # validation BEFORE activation 1: the candidate must regard its own trusted warm-up as healthy
    flag = float(np.mean([det.score(w, ref).anomalous for w in rows]))
    mets = {**met, "self_flag": flag, "n": len(rows)}
    if flag > cfg.self_check_max_flag:
        return ReferenceProposal(False, "self_check_failed", None, mets)
    # validation 2: it must not have been made blind - a synthetic 1x amplitude fault must still be flagged
    probe = float(np.mean([det.score(_probe(w, cfg.probe_factor), ref).anomalous for w in rows]))
    mets["probe_flag"] = probe
    if probe < cfg.probe_min_flag:
        return ReferenceProposal(False, "sensitivity_lost", None, mets)
    return ReferenceProposal(True, "validated", ref, mets)


def _probe(w: Window, factor: float) -> Window:
    """Generic synthetic fault: scale the 1x channel (and the composite rms accordingly). Not tied to simulator internals."""
    v1 = w.v1x * factor
    rms = math.sqrt(max(w.vib_rms ** 2 - w.v1x ** 2 + v1 ** 2, 0.0))
    return replace(w, v1x=v1, vib_rms=rms)


# ================================================================================================= detectors
_ACTIVE = object()      # sentinel: "use the detector's own active reference"


class AdaptiveBaselineDetector(BaselineDetector):
    """Control-identical fit. `score(w)` uses `self.reference` (None by default => bit-identical to the control);
    `score(w, ref)` scores against an explicit reference (None = the unadapted trained baseline). The trained bins are never
    modified by a reference."""

    def __init__(self, *a, **kw):
        super().__init__(*a, **kw)
        self.reference: Optional[SessionReference] = None

    def resolve_model(self, w: Window) -> Tuple[Optional[BinModel], str, int]:
        """Same bin/interpolation logic as BaselineDetector.score, returning the (possibly interpolated) bin model."""
        if not w.valid or not w.driven or w.setpoint <= 0:
            return None, "UNLEARNED_BIN", -1
        b = self.bin_of(w.setpoint)
        if not self.steady(w):
            return None, "TRANSIENT", b
        sp = w.setpoint
        near = [m for bb, m in self.bins.items() if abs(bb - b) <= 1]
        lo = max((m for m in near if m.anchor_rpm <= sp), key=lambda m: m.anchor_rpm, default=None)
        hi = min((m for m in near if m.anchor_rpm >= sp), key=lambda m: m.anchor_rpm, default=None)
        if lo is None and hi is None:
            return None, "UNLEARNED_BIN", b
        if b not in self.bins and not (lo is not None and hi is not None and lo is not hi):
            return None, "UNLEARNED_BIN", b
        status = "OK" if b in self.bins else "INTERPOLATED"
        if lo is None or hi is None or lo is hi:
            m = lo or hi
        else:
            t = (sp - lo.anchor_rpm) / max(hi.anchor_rpm - lo.anchor_rpm, 1e-9)
            near_m = lo if t < 0.5 else hi
            m = BinModel(lo.mean + t * (hi.mean - lo.mean), near_m.prec, lo.scale + t * (hi.scale - lo.scale),
                         lo.threshold + t * (hi.threshold - lo.threshold), near_m.n, near_m.frozen, sp)
        return m, status, b

    def score(self, w: Window, ref=_ACTIVE) -> Score:
        if ref is _ACTIVE:
            ref = self.reference
        m, status, b = self.resolve_model(w)
        if m is None:
            return Score(None, None, False, b, status)
        x = w.features()
        mean, scale = m.mean, m.scale
        if ref is not None:
            mean = mean.copy(); mean[VIB_IDX] = mean[VIB_IDX] * ref.gain
            scale = scale * np.array(ref.nu); scale = scale.copy()
            scale[VIB_IDX] = scale[VIB_IDX] * ref.gain          # the multiplicative sensor noise scales with the gain too
        z = (x - mean) / scale
        d = float(z @ m.prec @ z)
        contrib = {f: float(abs(zi)) for f, zi in zip(FEATURES, z)}
        if m.frozen:
            status = "FROZEN"
        return Score(d, m.threshold, d > m.threshold, b, status, contrib, z)


class RobustBaselineDetector(AdaptiveBaselineDetector):
    """Candidate A. Median/MAD location and scale (instead of trimmed mean/std), winsorised covariance, and a tunable
    relative scale floor `rel_floor` (control: 0.03) that sets how much unmodelled healthy variation is tolerated."""

    def __init__(self, bin_width_rpm: float = 300.0, percentile: float = 99.5, min_train: int = 30, rel_floor: float = REL_SCALE_FLOOR,
                 winsor: float = 3.0):
        super().__init__(bin_width_rpm, percentile, min_train)
        self.rel_floor, self.winsor = rel_floor, winsor

    def _fit_bin(self, X: np.ndarray) -> BinModel:
        med = np.median(X, axis=0)
        mad = np.median(np.abs(X - med), axis=0) * 1.4826 + 1e-9
        keep = np.all(np.abs(X - med) < 4.0 * mad, axis=1)
        Xk = X[keep] if keep.sum() >= self.min_train else X
        center = np.median(Xk, axis=0)
        s_mad = np.median(np.abs(Xk - center), axis=0) * 1.4826
        floor = np.array([max(ABS_SCALE_FLOOR.get(f, 0.0), self.rel_floor * abs(c)) for f, c in zip(FEATURES, center)])
        scale = np.maximum(s_mad, floor) + 1e-6
        Z = np.clip((Xk - center) / scale, -self.winsor, self.winsor)
        cov = np.cov(Z, rowvar=False)
        cov = 0.9 * cov + 0.1 * np.eye(cov.shape[0])
        prec = np.linalg.inv(cov)
        Zs = (Xk - center) / scale
        scores = np.einsum("ij,jk,ik->i", Zs, prec, Zs)
        return BinModel(center, prec, scale, float(np.percentile(scores, self.percentile)) * 1.5, len(Xk))


# ========================================================================================== Candidate C verdict
@dataclass
class CoherenceConfig:
    coh_tol: float = 0.10            # shared with ReferenceConfig.coh_tol
    min_common: float = 0.04         # |common-mode log gain| below this is not a regime change
    unlearned_frac: float = 0.5
    ref: ReferenceConfig = field(default_factory=ReferenceConfig)

    def __post_init__(self):
        self.ref = replace(self.ref, coh_tol=self.coh_tol)


@dataclass
class SessionAssessment:
    verdict: str                     # HEALTHY | FAULT | UNFAMILIAR
    reason: str
    flagged: int
    scored: int
    unlearned: int
    metrics: Dict[str, float] = field(default_factory=dict)
    flags: List[bool] = field(default_factory=list)       # per window (steady, learned) anomalous flags, for delay metrics
    max_ratio: float = 0.0           # max score/threshold over the session


def assess_session(det: AdaptiveBaselineDetector, windows: Sequence[Window], *, ref: Optional[SessionReference] = None,
                   regime_aware: bool = False, min_flagged: int = MIN_FLAGGED, cfg: Optional[CoherenceConfig] = None) -> SessionAssessment:
    """Session verdict. regime_aware=False reproduces the control decision rule (FAULT iff >= min_flagged anomalous windows)."""
    cfg = cfg or CoherenceConfig()
    scored, flags, ratios, unlearned, steady_n = [], [], [], 0, 0
    for w in windows:
        sc = det.score(w, ref)
        if det.steady(w) and w.valid and w.driven:
            steady_n += 1
            if sc.value is None:
                unlearned += 1
        if sc.value is not None and sc.threshold:
            scored.append((w, sc)); flags.append(sc.anomalous); ratios.append(sc.value / sc.threshold)
    flagged = int(sum(flags))
    base = dict(flagged=flagged, scored=len(scored), unlearned=unlearned, flags=flags, max_ratio=float(max(ratios) if ratios else 0.0))
    if regime_aware and steady_n and unlearned / steady_n >= cfg.unlearned_frac:
        return SessionAssessment("UNFAMILIAR", "operating_region_not_in_trained_bins", **base)
    if regime_aware and steady_n == 0:
        return SessionAssessment("UNFAMILIAR", "no_steady_evidence", **base)
    if flagged < min_flagged:
        return SessionAssessment("HEALTHY", "below_flag_count", **base)
    if not regime_aware:
        return SessionAssessment("FAULT", "flag_count" if ref is None else "residual_anomaly_after_session_reference", **base)
    # ---- flagged (with or without a warm-up reference; a shift AFTER the warm-up is still a shift): is the deviation EXPLAINABLE by a healthy nuisance (common-mode vibration gain
    # and/or measurement-noise inflation estimated from this very session)? If a channel-selective or protected-channel deviation
    # remains, it is a fault. Explainable => unfamiliar regime: escalate for more evidence, never silently "healthy".
    rows = [w for w, _ in scored]; models = [det.resolve_model(w)[0] for w in rows]
    ok, reason, gain, nu, met = _estimate_nuisance(det, rows, models, cfg.ref)
    met = {k: float(v) for k, v in met.items()}
    if not ok:
        if reason == "incoherent_vibration_channels":          # channel-selective: the signature of a mechanical / sensor fault
            return SessionAssessment("FAULT", "channel_selective_anomaly", metrics=met, **base)
        # Drifting, out-of-envelope or otherwise not explainable by a static nuisance: drift vs fault cannot be separated with
        # confidence, so the regime is UNCERTAIN (escalate for evidence). It is never silently classified healthy or confirmed.
        return SessionAssessment("UNFAMILIAR", "uncertain_" + reason, metrics=met, **base)
    sref = SessionReference(0, gain, tuple(float(x) for x in nu), len(rows))
    resid = int(sum(det.score(w, sref).anomalous for w in rows))
    met["flagged_after_nuisance_model"] = resid
    if resid < min_flagged and (abs(math.log(gain)) >= cfg.min_common or float(np.max(nu)) > 1.0):
        return SessionAssessment("UNFAMILIAR", "explained_by_session_gain_or_noise", metrics=met, **base)
    return SessionAssessment("FAULT", "residual_anomaly_after_nuisance_model", metrics=met, **base)


def first_confirmed(flags: Sequence[bool], n: int = 5) -> Optional[int]:
    run = 0
    for i, f in enumerate(flags):
        run = run + 1 if f else 0
        if run >= n:
            return i - n + 1
    return None
