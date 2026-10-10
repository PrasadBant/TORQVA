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
    out: Dict[str, object] = {"inconclusive": bool(post.ood or getattr(post, "conflict", False) or not (post.top_p >= p_conf and post.margin >= margin)),
                              "ood": bool(post.ood), "conflict": bool(getattr(post, "conflict", False)),
                              "top": post.top.value, "top_p": round(post.top_p, 4), "entropy_change": round(post.entropy - prior.entropy, 4)}
    if truth is not None:
        d = post.probs[truth] - prior.probs[truth]
        out.update({"p_truth_before": round(prior.probs[truth], 4), "p_truth_after": round(post.probs[truth], 4),
                    "effect": "improved" if d >= delta else ("worsened" if d <= -delta else "unchanged"),
                    "top1_before": prior.top == truth, "top1_after": post.top == truth,
                    "confident_wrong": bool((not post.ood) and (not getattr(post, "conflict", False)) and post.top_p >= p_conf
                                                and post.margin >= margin and post.top != truth)})
    return out
