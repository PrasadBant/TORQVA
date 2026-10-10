"""C3 — Confidence-aware decision gate. Deterministic ordered rules; every decision logs its inputs.

The gate only *proposes* a verdict. It cannot send anything: actions still pass the Safety Supervisor.
Uncertainty never delays a stop: rule 1 is evaluated first and ignores confidence entirely.
"""
from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import Dict, Optional

from .hypotheses import Posterior
from .schemas import GateVerdict


@dataclass(frozen=True)
class GateConfig:
    p_confident: float = 0.70
    margin_confident: float = 0.30
    min_info_gain_nats: float = 0.15
    risk_high: float = 0.60
    risk_moderate: float = 0.30
    # Diagnoses that a single speed cannot tell apart physically (mechanical looseness vs a faulty vibration channel):
    # never 'confident' until a speed-step test has been run in this incident.
    test_required_for: tuple = ("looseness", "sensor_fault")


@dataclass
class TestOption:
    __test__ = False        # not a pytest class
    name: str
    info_gain: float
    safe: bool                      # passed Safety Supervisor pre-check


@dataclass
class GateInputs:
    mandatory_stop: bool
    risk: float                     # 0..1 probability of crossing a warn/stop limit in the horizon
    data_ok: bool
    sensor_unreliable: bool
    posterior: Posterior
    c2_trusted: bool
    best_test: Optional[TestOption]
    data_requests: int
    max_data_requests: int
    tests_run: int
    max_tests: int
    op_point_familiar: bool = True


@dataclass
class GateDecision:
    verdict: GateVerdict
    reason: str
    test: Optional[str] = None
    inputs: Dict = field(default_factory=dict)


def _log(i: GateInputs) -> Dict:
    p = i.posterior
    return {"mandatory_stop": i.mandatory_stop, "risk": round(i.risk, 4), "data_ok": i.data_ok,
            "sensor_unreliable": i.sensor_unreliable, "top": p.top.value, "top_p": round(p.top_p, 4),
            "margin": round(p.margin, 4), "posterior_label": p.label(), "ood": p.ood, "n_windows": p.n_windows,
            "c2_trusted": i.c2_trusted, "op_point_familiar": i.op_point_familiar,
            "best_test": i.best_test.name if i.best_test else None,
            "best_test_gain": round(i.best_test.info_gain, 4) if i.best_test else None,
            "best_test_safe": i.best_test.safe if i.best_test else None,
            "data_requests": i.data_requests, "tests_run": i.tests_run}


def decide(i: GateInputs, cfg: GateConfig = GateConfig()) -> GateDecision:
    log = _log(i)
    # 1. Mandatory rule or high risk -> stop. Evaluated before and independent of any confidence value.
    if i.mandatory_stop:
        return GateDecision(GateVerdict.SAFE_STOP, "A mandatory stop condition is active.", None, log)
    if i.risk >= cfg.risk_high:
        return GateDecision(GateVerdict.SAFE_STOP, f"Predicted risk {i.risk:.2f} is at or above {cfg.risk_high:.2f}.", None, log)

    # 2. Poor data quality.
    if not i.data_ok:
        if i.sensor_unreliable:
            return GateDecision(GateVerdict.SENSOR_UNRELIABLE, "Sensor data failed quality checks.", None, log)
        if i.data_requests >= i.max_data_requests:
            return GateDecision(GateVerdict.ESCALATE_HUMAN, "Data still insufficient after the allowed number of requests.", None, log)
        return GateDecision(GateVerdict.REQUEST_MORE_DATA, "Data quality is not sufficient to decide.", None, log)

    # 3. Confident posterior and trusted predictions -> act.
    needs_test = i.posterior.top.value in cfg.test_required_for and i.tests_run == 0
    confident = (i.posterior.top_p >= cfg.p_confident and i.posterior.margin >= cfg.margin_confident
                 and not i.posterior.ood and not needs_test)
    if confident and i.c2_trusted and i.op_point_familiar:
        return GateDecision(GateVerdict.ACT, f"Top hypothesis '{i.posterior.top.value}' at {i.posterior.top_p:.2f} "
                            f"with margin {i.posterior.margin:.2f}; predictions trusted.", None, log)

    # Why we are not acting (for the plain-language reason).
    why = []
    if needs_test:
        why.append(f"'{i.posterior.top.value}' cannot be told from its look-alike without a speed-step test")
    if not confident and not needs_test:
        why.append(f"hypotheses are {i.posterior.label()} (top {i.posterior.top_p:.2f}, margin {i.posterior.margin:.2f})")
    if not i.c2_trusted:
        why.append("intervention predictions are not trusted")
    if not i.op_point_familiar:
        why.append("operating point is unfamiliar")
    why_s = "; ".join(why)

    low_risk = i.risk < cfg.risk_moderate
    # 4. Informative, safe test available and risk is low.
    t = i.best_test
    if t and t.safe and t.info_gain >= cfg.min_info_gain_nats and low_risk and i.tests_run < i.max_tests:
        return GateDecision(GateVerdict.RUN_DIAGNOSTIC_TEST,
                            f"Not acting: {why_s}. Test {t.name} is expected to remove {t.info_gain:.2f} nats of uncertainty.",
                            t.name, log)
    # 5. Observe longer if risk is low and budget remains.
    if low_risk and i.data_requests < i.max_data_requests:
        return GateDecision(GateVerdict.REQUEST_MORE_DATA, f"Not acting: {why_s}. No safe informative test; observing longer.", None, log)
    # 6. Moderate risk and still uncertain -> stop rather than gamble.
    if not low_risk:
        return GateDecision(GateVerdict.SAFE_STOP, f"Not acting: {why_s}, and risk {i.risk:.2f} is not low.", None, log)
    # 7. Budgets exhausted.
    return GateDecision(GateVerdict.ESCALATE_HUMAN, f"Not acting: {why_s}; data-request and test budgets are exhausted.", None, log)
