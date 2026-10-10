"""C4 — active fault diagnosis: test library, learned outcome signatures, information-gain selection.

Test outcome signatures are fitted from executed tests on labelled sessions (simulation for now; real
sessions later). Selection maximises expected entropy reduction of the hypothesis posterior.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Dict, List, Optional, Sequence, Tuple

import numpy as np

from .detection import ThermalTracker
from .hypotheses import HYPS, Posterior
from .schemas import Hypothesis
from .sim import MotorSim, Window

TESTS = ("T1", "T3", "T4")
TEST_ID = {"T1": 1, "T3": 3, "T4": 4}


# ---------------- observation extraction ----------------
def _mean(ws: Sequence[Window], f: Callable[[Window], float]) -> float:
    return float(np.mean([f(w) for w in ws]))


def obs_t1(before: Sequence[Window], after: Sequence[Window]) -> np.ndarray:
    """[speed exponent of 1x vibration, speed exponent of 2x+3x harmonics, change in current-per-rpm]
    for a speed step-down. Imbalance: both exponents ~2. Looseness: harmonics scale far less steeply.
    (The looseness exponent in simulation is a modelling assumption: it must be re-fitted on real fault data.)
    """
    r0, r1 = _mean(before, lambda w: w.rpm), _mean(after, lambda w: w.rpm)
    lr = np.log(r1 / r0)

    def expo(f):
        a, b = _mean(before, f), _mean(after, f)
        return float(np.clip(np.log(max(b, 1e-6) / max(a, 1e-6)) / lr, -2, 6))

    i0 = _mean(before, lambda w: w.current / max(w.rpm, 1) * 1000)
    i1 = _mean(after, lambda w: w.current / max(w.rpm, 1) * 1000)
    return np.array([expo(lambda w: w.v1x), expo(lambda w: w.v2x + w.v3x),
                     float(np.log(max(i1, 1e-6) / max(i0, 1e-6)))])


def obs_t3(windows: Sequence[Window], tracker: ThermalTracker) -> np.ndarray:
    """[slope of thermal residual in deg C per 100 s] over the observation window."""
    tracker.reset(windows[0].housing)
    res = np.array([tracker.update(w) for w in windows])
    t = np.arange(len(res), dtype=float)
    slope = np.polyfit(t, res, 1)[0] * 100.0
    return np.array([float(slope)])


def obs_t4(windows: Sequence[Window]) -> np.ndarray:
    """[ln tau of the coast-down] fitted to the rpm decay after the driver was disabled."""
    rpm = np.array([max(w.rpm, 1.0) for w in windows])
    keep = rpm > 150
    t = np.arange(len(rpm), dtype=float)[keep]
    if keep.sum() < 4:
        return np.array([np.log(2.0)])
    slope = np.polyfit(t, np.log(rpm[keep]), 1)[0]
    tau = -1.0 / min(slope, -1e-4)
    return np.array([float(np.log(np.clip(tau, 0.5, 60)))])


# ---------------- execution (simulation) ----------------
def run_test_on_sim(sim: MotorSim, test: str, tracker: Optional[ThermalTracker] = None,
                    fraction: float = 0.7, hold_s: int = 40, observe_s: int = 300) -> Tuple[np.ndarray, List[Window]]:
    """Execute a diagnostic test on a simulated motor, as the device executor would (lower/equal speed only)."""
    if test == "T1":
        before = sim.run(20)[5:]
        sim.set_setpoint(sim.setpoint * fraction)
        w = sim.run(hold_s)
        return obs_t1(before, w[-15:]), w
    if test == "T3":
        w = sim.run(observe_s)
        return obs_t3(w, tracker or ThermalTracker()), w
    if test == "T4":
        sim.run(10)
        sim.stop()
        w = sim.run(40)
        return obs_t4(w), w
    raise ValueError(test)


# ---------------- learned outcome models ----------------
@dataclass
class OutcomeModel:
    mu: Dict[Hypothesis, np.ndarray]
    var: Dict[Hypothesis, np.ndarray]
    ood_thr: Optional[float] = None     # best-hypothesis log-likelihood below this = outcome unlike any learned signature

    def loglik(self, h: Hypothesis, obs: np.ndarray) -> float:
        return float(-0.5 * np.sum((obs - self.mu[h]) ** 2 / self.var[h] + np.log(self.var[h])))


class DiagnosticsModel:
    def __init__(self):
        self.models: Dict[str, OutcomeModel] = {}
        self.version = 0

    def learn(self, tracker: ThermalTracker, setpoint: float = 1800.0, severities=(0.4, 0.7, 0.9),
              seeds=(1, 2, 3), tests: Sequence[str] = TESTS) -> None:
        for test in tests:
            samples: Dict[Hypothesis, List[np.ndarray]] = {h: [] for h in HYPS}
            for h in HYPS:
                for sev in severities:
                    for seed in seeds:
                        sim = MotorSim(1000 + seed)
                        sim.set_setpoint(setpoint)
                        sim.run(60 if test != "T3" else 200)          # reach steady state (and warm up for T3)
                        sim.inject(h, sev)
                        obs, _ = run_test_on_sim(sim, test, tracker)
                        samples[h].append(obs)
            mu = {h: np.mean(v, axis=0) for h, v in samples.items()}
            var = {h: np.var(v, axis=0) + 0.05 ** 2 + 0.05 * np.abs(mu[h]) ** 2 * 0.1 for h, v in samples.items()}
            om = OutcomeModel(mu, var)
            lls = [om.loglik(h, o) for h, v in samples.items() for o in v]
            om.ood_thr = float(min(lls) - 6.0)                  # 6 nats below the worst training outcome
            self.models[test] = om
        self.version += 1

    # ---------------- Bayesian use ----------------
    def update(self, post: Posterior, test: str, obs: np.ndarray) -> Posterior:
        m = self.models[test]
        lp = np.array([np.log(max(post.probs[h], 1e-12)) + m.loglik(h, obs) for h in HYPS])
        lp -= lp.max()
        p = np.exp(lp); p /= p.sum()
        ood = bool(m.ood_thr is not None and max(m.loglik(h, obs) for h in HYPS) < m.ood_thr)
        return Posterior({h: float(x) for h, x in zip(HYPS, p)}, post.n_windows, ood)

    def expected_info_gain(self, post: Posterior, test: str, n_mc: int = 200, seed: int = 0) -> float:
        """E[H(prior) - H(posterior)] over simulated outcomes drawn from the learned signatures."""
        m = self.models[test]
        rng = np.random.RandomState(seed)
        h0 = post.entropy
        total = 0.0
        for h in HYPS:
            ph = post.probs[h]
            if ph < 1e-4:
                continue
            for _ in range(n_mc):
                obs = m.mu[h] + rng.randn(*m.mu[h].shape) * np.sqrt(m.var[h])
                total += ph * (h0 - self.update(post, test, obs).entropy) / n_mc
        return float(total)

    def best_test(self, post: Posterior, allowed: Sequence[str], cost: Optional[Dict[str, float]] = None
                  ) -> Optional[Tuple[str, float]]:
        cost = cost or {"T1": 0.02, "T3": 0.10, "T4": 0.08}
        best = None
        for t in allowed:
            if t not in self.models:
                continue
            g = self.expected_info_gain(post, t)
            score = g - cost.get(t, 0.0)
            if best is None or score > best[2]:
                best = (t, g, score)
        return (best[0], best[1]) if best else None
