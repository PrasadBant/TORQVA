"""Phase 10 - C4 diagnostic-test quality (SIMULATION ONLY). The shipped `diagnostics.DiagnosticsModel` is the untouched CONTROL.

Finding that motivated this module: the T1 speed-step observation CAN separate mechanical looseness from a faulty vibration channel
(harmonic speed-exponent ~1.05 for looseness vs ~0.1 for a noisy-harmonics sensor fault), but the shipped signature library contains only
ONE sensor-fault style ("stuck"), so outcomes from another style fall outside every learned signature. `StyleAwareDiagnosticsModel` keeps
one signature component per fault STYLE and scores an outcome against the mixture. Styles not in the library (held out in the study)
must end as inconclusive / out-of-distribution, never as a forced diagnosis.

Test specifications below are documentation AND data: the study and the UI read them.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Optional, Sequence, Tuple

import numpy as np

from .detection import ThermalTracker
from .diagnostics import TESTS, DiagnosticsModel, OutcomeModel, run_test_on_sim
from .hypotheses import HYPS, Posterior
from .schemas import Hypothesis
from .sim import MotorSim, Regime

TEST_SPECS = {
    "T1": {
        "name": "speed-step (down to 70 % for 40 s)",
        "distinguishes": "imbalance vs looseness (1x vs harmonic speed exponent); looseness vs sensor fault (harmonics scale with speed only for looseness)",
        "evidence": "[speed exponent of 1x vibration, speed exponent of 2x+3x harmonics, change in current per rpm]",
        "conditions": "motor steady; speed only lowered; vibration limit commissioned; Safety Supervisor ALLOW/DEFER; operator approval in hardware mode",
        "abort": "mandatory stop, device safety trip, command rejected/aborted/timeout/expired (communication loss), incident e-stop",
        "inconclusive": "outcome unlike every learned signature (out-of-distribution), or posterior still not confident (top < 0.70 or margin < 0.30)",
        "effect": "posterior is updated by the outcome likelihood; an out-of-distribution outcome is flagged and can never make a diagnosis confident",
    },
    "T3": {
        "name": "thermal observation (hold load for up to 300 s)",
        "distinguishes": "cooling failure (thermal residual keeps rising) vs electrical/mechanical overload (it does not)",
        "evidence": "[slope of the thermal residual, deg C per 100 s]",
        "conditions": "housing temperature below the warn limit at start; Supervisor ALLOW/DEFER",
        "abort": "housing temperature at the stop limit (mandatory stop), safety trip, command failure",
        "inconclusive": "out-of-distribution slope or confident posterior not reached",
        "effect": "as above",
    },
    "T4": {
        "name": "coast-down (driver disabled, 40 s)",
        "distinguishes": "friction/overload (short coast-down) vs cooling failure or electrical faults (normal coast-down)",
        "evidence": "[ln tau of the rpm decay]",
        "conditions": "motor running; stopping is always permitted; result needs rpm > 150 for at least 4 s of decay",
        "abort": "command failure; a latched e-stop makes the decay meaningless (inconclusive)",
        "inconclusive": "decay too short to fit, or outcome out-of-distribution",
        "effect": "as above",
    },
}

# style -> simulator regime parameters (single source of truth for fitting and for held-out evaluation)
SENSOR_STYLES = ("stuck", "noisy_harmonics", "intermittent")
LOOSENESS_STYLES = ("steady", "intermittent")


def style_regime(sensor: str = "stuck", looseness: str = "steady", noise: float = 1.0, offsets: bool = False) -> Regime:
    return Regime(f"{sensor}/{looseness}/n{noise}", noise_mult=noise, session_offsets=offsets, sensor_fault_mode=sensor, looseness_mode=looseness)


@dataclass
class MixtureOutcomeModel:
    comps: Dict[Hypothesis, List[Tuple[np.ndarray, np.ndarray]]]       # hypothesis -> [(mu, var) per fault style]
    ood_thr: Optional[float] = None

    def loglik(self, h: Hypothesis, obs: np.ndarray) -> float:
        ll = [float(-0.5 * np.sum((obs - mu) ** 2 / var + np.log(var))) for mu, var in self.comps[h]]
        m = max(ll)
        return m + float(np.log(np.mean(np.exp(np.array(ll) - m))))


class StyleAwareDiagnosticsModel(DiagnosticsModel):
    """Same Bayesian use as the control; the signature of a hypothesis is a mixture over the fault styles in `train_styles`."""

    def __init__(self, train_sensor_styles: Sequence[str] = ("stuck", "noisy_harmonics"), train_looseness_styles: Sequence[str] = ("steady",)):
        super().__init__()
        self.sensor_styles, self.looseness_styles = tuple(train_sensor_styles), tuple(train_looseness_styles)

    def _styles(self, h: Hypothesis) -> List[Tuple[str, str]]:
        if h == Hypothesis.SENSOR_FAULT:
            return [(s, "steady") for s in self.sensor_styles]
        if h == Hypothesis.LOOSENESS:
            return [("stuck", l) for l in self.looseness_styles]
        return [("stuck", "steady")]

    def learn(self, tracker: ThermalTracker, setpoint: float = 1800.0, severities=(0.4, 0.7, 0.9), seeds=(1, 2, 3),
              tests: Sequence[str] = TESTS, seed_base: int = 1100) -> None:
        for test in tests:
            comps: Dict[Hypothesis, List[Tuple[np.ndarray, np.ndarray]]] = {}
            all_ll: List[Tuple[Hypothesis, np.ndarray]] = []
            for h in HYPS:
                comps[h] = []
                for sensor, lm in self._styles(h):
                    reg = style_regime(sensor, lm)
                    obs_list = []
                    for sev in severities:
                        for seed in seeds:
                            sim = MotorSim(seed_base + seed, regime=reg)
                            sim.set_setpoint(setpoint)
                            sim.run(60 if test != "T3" else 200)
                            sim.inject(h, sev)
                            obs, _ = run_test_on_sim(sim, test, tracker)
                            obs_list.append(obs)
                    mu = np.mean(obs_list, axis=0)
                    var = np.var(obs_list, axis=0) + 0.05 ** 2 + 0.05 * np.abs(mu) ** 2 * 0.1
                    comps[h].append((mu, var))
                    all_ll += [(h, o) for o in obs_list]
            mm = MixtureOutcomeModel(comps)
            mm.ood_thr = float(min(mm.loglik(h, o) for h, o in all_ll) - 6.0)
            self.models[test] = mm                                   # duck-typed: loglik / ood_thr (update() uses nothing else)
        self.version += 1

    def expected_info_gain(self, post: Posterior, test: str, n_mc: int = 200, seed: int = 0) -> float:
        m = self.models[test]
        rng = np.random.RandomState(seed)
        h0, total = post.entropy, 0.0
        for h in HYPS:
            ph = post.probs[h]
            if ph < 1e-4:
                continue
            for _ in range(n_mc):
                mu, var = m.comps[h][rng.randint(len(m.comps[h]))]
                obs = mu + rng.randn(*mu.shape) * np.sqrt(var)
                total += ph * (h0 - self.update(post, test, obs).entropy) / n_mc
        return float(total)


class ConflictGuard:
    """Wraps any diagnostics model. After the normal Bayesian update it also computes the LIKELIHOOD-ONLY posterior (uniform over the
    hypotheses that had non-zero prior). If that evidence alone confidently (>= p_conf) names a different hypothesis than the updated
    posterior, the prior is overriding the test: the result is flagged `conflict` and can never be 'confident'. Finding behind it: the
    C1-evidence posterior can be so peaked (look-alike sensor faults read as looseness) that no single test outcome can overturn it, which
    produced confident-wrong diagnoses; a conflict is escalated, not resolved by the prior."""

    def __init__(self, model, p_conf: float = 0.70):
        self.model, self.p_conf = model, p_conf

    def __getattr__(self, name):                    # models, version, expected_info_gain, best_test, learn ... delegate unchanged
        return getattr(self.model, name)

    def update(self, post: Posterior, test: str, obs: np.ndarray) -> Posterior:
        out = self.model.update(post, test, obs)
        m = self.model.models[test]
        hs = [h for h in HYPS if post.probs[h] > 0.0]
        ll = np.array([m.loglik(h, obs) for h in hs])
        pl = np.exp(ll - ll.max()); pl /= pl.sum()
        top_l = hs[int(np.argmax(pl))]
        conflict = bool((not out.ood) and top_l != out.top and float(pl.max()) >= self.p_conf)
        return Posterior(out.probs, out.n_windows, out.ood, conflict)


# ------------------------------------------------------------------------------------------------ result classification
def classify_test_result(prior: Posterior, post: Posterior, truth: Optional[Hypothesis] = None, delta: float = 0.10,
                         p_conf: float = 0.70, margin: float = 0.30) -> Dict[str, object]:
    """What a diagnostic test did. Without ground truth only `inconclusive` can be judged; with truth (simulation) also improved / worsened.
    Inconclusive = out-of-distribution outcome, or the posterior is still not confident. A test never forces a diagnosis."""
    out: Dict[str, object] = {"inconclusive": bool(post.ood or getattr(post, "conflict", False) or getattr(post, "uncorroborated", False)
                                                   or not (post.top_p >= p_conf and post.margin >= margin)),
                              "ood": bool(post.ood), "conflict": bool(getattr(post, "conflict", False)), "uncorroborated": bool(getattr(post, "uncorroborated", False)),
                              "top": post.top.value, "top_p": round(post.top_p, 4), "entropy_change": round(post.entropy - prior.entropy, 4)}
    if truth is not None:
        d = post.probs[truth] - prior.probs[truth]
        out.update({"p_truth_before": round(prior.probs[truth], 4), "p_truth_after": round(post.probs[truth], 4),
                    "effect": "improved" if d >= delta else ("worsened" if d <= -delta else "unchanged"),
                    "top1_before": prior.top == truth, "top1_after": post.top == truth,
                    "confident_wrong": bool((not post.ood) and (not getattr(post, "conflict", False)) and (not getattr(post, "uncorroborated", False)) and post.top_p >= p_conf
                                                and post.margin >= margin and post.top != truth)})
    return out


# ------------------------------------------------------------------------------------------------ Phase 11: calibrated likelihoods
import math as _math


def chi2_sf_df3(x: float) -> float:
    """Survival function of the chi-square distribution with 3 degrees of freedom (closed form; the T1 observation has 3 components)."""
    x = max(float(x), 0.0)
    return float(_math.erfc(_math.sqrt(x / 2.0)) + _math.sqrt(2.0 * x / _math.pi) * _math.exp(-x / 2.0))


def fit_temperature(model, samples: Sequence[Tuple[np.ndarray, Hypothesis]], test: str = "T1", grid: Optional[Sequence[float]] = None,
                    floor: float = 1e-6) -> Tuple[float, Dict[str, float]]:
    """Temperature T >= 1 minimising the mean negative log-likelihood of the TRUE hypothesis under the LIKELIHOOD-ONLY posterior
    p_T(h | obs) ~ exp(loglik_h(obs) / T) (uniform prior over all hypotheses: independent of any C1 prior). samples = [(obs, truth)]."""
    m = model.models[test]
    L = np.array([[m.loglik(h, o) for h in HYPS] for o, _ in samples])
    idx = np.array([HYPS.index(t) for _, t in samples])
    out = {}
    best = (None, np.inf)
    for T in (grid if grid is not None else np.geomspace(1.0, 40.0, 81)):
        z = L / T; z -= z.max(axis=1, keepdims=True)
        p = np.exp(z); p /= p.sum(axis=1, keepdims=True)
        nll = float(-np.mean(np.log(np.maximum(p[np.arange(len(idx)), idx], floor))))
        out[f"{T:.3f}"] = nll
        if nll < best[1]:
            best = (float(T), nll)
    return best[0], {"nll_at_T1": out[f"{1.0:.3f}"], "nll_best": best[1], "n": len(samples)}


def fit_joint_temperatures(model, sessions: Sequence[Tuple[Posterior, np.ndarray, Hypothesis]], test: str = "T1", prior_grid: Optional[Sequence[float]] = None,
                           lik_grid: Optional[Sequence[float]] = None, floor: float = 1e-6) -> Tuple[Tuple[float, float], Dict[str, float]]:
    """Joint fit of (prior temperature, likelihood temperature) by the mean NLL of the TRUE hypothesis under the POST-TEST posterior
    p(h | prior, obs) ~ prior_h^(1/Tp) * exp(loglik_h(obs) / T). sessions = [(C1 prior posterior, T1 observation, truth)]. Both sources of evidence are
    calibrated: the C1 prior is often near-1.0 and wrong under shift, which a likelihood temperature alone cannot repair."""
    m = model.models[test]
    L = np.array([[m.loglik(h, o) for h in HYPS] for _, o, _ in sessions])
    LP = np.array([[np.log(max(p.probs[h], 1e-12)) for h in HYPS] for p, _, _ in sessions])
    idx = np.array([HYPS.index(t) for _, _, t in sessions])
    best, grid = ((1.0, 1.0), np.inf), {}
    for Tp in (prior_grid if prior_grid is not None else (1, 1.5, 2, 3, 5, 8, 12, 20, 30, 50, 80, 120)):
        for T in (lik_grid if lik_grid is not None else (1, 1.5, 2, 3, 5, 8)):
            z = LP / Tp + L / T; z -= z.max(axis=1, keepdims=True)
            p = np.exp(z); p /= p.sum(axis=1, keepdims=True)
            nll = float(-np.mean(np.log(np.maximum(p[np.arange(len(idx)), idx], floor))))
            grid[f"{Tp}/{T}"] = nll
            if nll < best[1]:
                best = ((float(Tp), float(T)), nll)
    return best[0], {"nll_at_1_1": grid["1/1"], "nll_best": best[1], "n": len(sessions)}


class CalibratedDiagnostics:
    """Opt-in wrapper around a style-aware model: (1) the test log-likelihood is divided by a temperature fitted on CALIBRATION data;
    (2) optional goodness-of-fit abstention: if the observation is a poor fit (chi-square p < alpha) to the best component of the winning
    hypothesis the result is marked unfamiliar (never confident); (3) the conflict guard, computed with the same tempered likelihood.
    Probabilities of competing hypotheses are never made MORE extreme than the base model's; the wrapper cannot raise confidence."""

    def __init__(self, model, temperature: float = 1.0, gof_alpha: Optional[float] = None, conflict_guard: bool = True, p_conf: float = 0.70,
                 corroboration: Optional[float] = None, prior_temperature: float = 1.0):
        self.model, self.temperature, self.gof_alpha, self.conflict_guard, self.p_conf = model, float(temperature), gof_alpha, conflict_guard, p_conf
        self.prior_temperature = float(prior_temperature)   # >= 1 flattens the (overconfident) C1 prior before it is combined with the test likelihood
        self.corroboration = corroboration            # if set: confident only when the likelihood-only posterior ALSO names the same top hypothesis with >= this probability

    def __getattr__(self, name):
        return getattr(self.model, name)

    def _gof_p(self, m, h: Hypothesis, obs: np.ndarray) -> float:
        d2 = min(float(np.sum((obs - mu) ** 2 / var)) for mu, var in m.comps[h])
        return chi2_sf_df3(d2)

    def update(self, post: Posterior, test: str, obs: np.ndarray) -> Posterior:
        m = self.model.models[test]
        T = self.temperature
        ll = np.array([m.loglik(h, obs) for h in HYPS])
        lp = np.array([np.log(max(post.probs[h], 1e-12)) for h in HYPS]) / self.prior_temperature + ll / T
        lp -= lp.max()
        p = np.exp(lp); p /= p.sum()
        probs = {h: float(x) for h, x in zip(HYPS, p)}
        top = HYPS[int(np.argmax(p))]
        ood = bool(m.ood_thr is not None and ll.max() < m.ood_thr)
        if (not ood) and self.gof_alpha is not None and hasattr(m, "comps"):
            ood = self._gof_p(m, top, obs) < self.gof_alpha
        conflict = uncorroborated = False
        if (self.conflict_guard or self.corroboration is not None) and not ood:
            hs = [h for h in HYPS if post.probs[h] > 0.0]
            z = np.array([m.loglik(h, obs) for h in hs]) / T
            pl = np.exp(z - z.max()); pl /= pl.sum()
            lik_top, lik_p = hs[int(np.argmax(pl))], float(pl.max())
            conflict = bool(self.conflict_guard and lik_top != top and lik_p >= self.p_conf)
            if self.corroboration is not None and not conflict:
                uncorroborated = bool(not (lik_top == top and float(pl[hs.index(top)]) >= self.corroboration))
        return Posterior(probs, post.n_windows, ood, conflict, uncorroborated)


def expected_calibration_error(conf: Sequence[float], correct: Sequence[bool], bins: int = 10) -> float:
    conf, correct = np.asarray(conf, dtype=float), np.asarray(correct, dtype=float)
    if len(conf) == 0:
        return float("nan")
    edges = np.linspace(0.0, 1.0, bins + 1)
    e = 0.0
    for lo, hi in zip(edges[:-1], edges[1:]):
        sel = (conf > lo) & (conf <= hi) if lo > 0 else (conf >= lo) & (conf <= hi)
        if sel.any():
            e += sel.mean() * abs(conf[sel].mean() - correct[sel].mean())
    return float(e)
