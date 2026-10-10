"""Scenario builders shared by tests and the evaluation suite (simulation only)."""
from __future__ import annotations

from typing import List, Optional, Sequence, Tuple

from .detection import BaselineDetector, ThermalTracker
from .hypotheses import HypothesisModel, Posterior
from .prediction import StateSummary
from .schemas import Hypothesis
from .sim import REGIMES, MotorSim, Window, rollout

ACTIONS = (("CONTINUE_MONITORING", 0.0), ("REDUCE_SPEED", 0.7), ("STOP", 0.0))


def warm_session(h: Optional[Hypothesis], sev: float, seed: int, sp: float, pre_s: int = 60, post_s: int = 60,
                 regime: str = "baseline"):
    """Run a motor to steady state, inject a fault, observe `post_s`. Returns (sim, windows_after_fault)."""
    s = MotorSim(seed, regime=REGIMES[regime])
    s.set_setpoint(sp)
    s.run(pre_s if h != Hypothesis.COOLING_FAILURE else 300)
    s.inject(h, sev)
    return s, s.run(post_s)


def posterior_from(windows: Sequence[Window], det: BaselineDetector, tt: ThermalTracker, hm: HypothesisModel,
                   last: int = 15) -> Tuple[Posterior, List]:
    tt.reset(windows[0].housing)
    zs = []
    for w in windows:
        tt.update(w)
        sc = det.score(w)
        if sc.z is not None:
            zs.append(sc.z)
    return hm.posterior(zs[-last:]), zs


def action_cases(h, sev, seed, sp, det, tt, hm, horizon: int = 120, regime: str = "baseline"):
    """[(state, posterior, action, target_rpm, TRUE future windows)] for CONTINUE / REDUCE / STOP."""
    s, pre = warm_session(h, sev, seed, sp, regime=regime)
    post, _ = posterior_from(pre, det, tt, hm)
    st = StateSummary.from_windows(pre)
    out = []
    for a, frac in ACTIONS:
        tgt = frac * sp
        out.append((st, post, a, tgt, rollout(s, a, horizon, tgt)))
    return out
