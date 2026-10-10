"""C5 — verified recovery. Recovery is declared only from FRESH post-acknowledgement evidence.

A prediction (even a confident one) is never evidence of recovery. A command that was rejected, aborted,
timed out or expired can never lead to RECOVERED. Outcomes are recorded separately from predictions.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Optional, Sequence

import numpy as np

from .detection import BaselineDetector, ThermalTracker
from .dispatch import CommandRecord
from .schemas import ActionType, CommandStatus, RecoveryOutcome
from .sim import Window

# Per-signal settle time after the ack (thermal >> vibration), seconds.
SETTLE_S = {"vib": 10.0, "electrical": 10.0, "thermal": 120.0}


@dataclass(frozen=True)
class RecoveryConfig:
    min_fresh_samples: int = 60
    min_fresh_seconds: float = 30.0
    max_valid_gap_s: float = 3.0
    frac_in_band: float = 0.9
    worsening_slope_per_min: float = 0.5      # in units of baseline-threshold fractions per minute


@dataclass
class RecoveryAssessment:
    outcome: RecoveryOutcome
    reasons: List[str]
    criteria: Dict[str, bool] = field(default_factory=dict)
    n_fresh: int = 0
    fresh_since: Optional[float] = None
    # Stored separately from the prediction that preceded the action:
    observed: Dict[str, float] = field(default_factory=dict)
    provenance: str = "MEASURED"


def assess(cmd: CommandRecord, post_ack: Sequence[Window], det: BaselineDetector, tt: ThermalTracker,
           now: float, stopped: bool = False, safety_ok_after_stop: bool = True,
           previous_unresolved: bool = False, cfg: RecoveryConfig = RecoveryConfig()) -> RecoveryAssessment:
    # 0. The action must actually have taken effect on the device.
    if cmd.status != CommandStatus.COMPLETED and cmd.status != CommandStatus.ACCEPTED:
        return RecoveryAssessment(RecoveryOutcome.INCONCLUSIVE, [f"command_not_executed:{cmd.status.value}"])
    if cmd.action == ActionType.RUN_TEST and cmd.status != CommandStatus.COMPLETED:
        return RecoveryAssessment(RecoveryOutcome.INCONCLUSIVE, ["test_not_completed"])
    if cmd.acked_at is None:
        return RecoveryAssessment(RecoveryOutcome.INCONCLUSIVE, ["no_ack_time"])

    # 1. Only samples measured after the ack plus settle time count; later-than-now samples can't exist.
    settle = SETTLE_S["thermal"] if cmd.action in (ActionType.REDUCE_SPEED, ActionType.SET_SPEED) else SETTLE_S["vib"]
    t0 = cmd.acked_at + settle
    fresh = [w for w in post_ack if w.t >= t0 and w.t <= now]
    if not fresh:
        return RecoveryAssessment(RecoveryOutcome.INCONCLUSIVE, ["no_fresh_samples_yet"], n_fresh=0, fresh_since=t0)

    valid = [w for w in fresh if w.valid]
    span = fresh[-1].t - fresh[0].t
    if len(valid) < cfg.min_fresh_samples or span < cfg.min_fresh_seconds:
        return RecoveryAssessment(RecoveryOutcome.INCONCLUSIVE,
                                  [f"insufficient_fresh_window:{len(valid)}/{cfg.min_fresh_samples} samples, {span:.0f}/{cfg.min_fresh_seconds:.0f}s"],
                                  n_fresh=len(valid), fresh_since=t0)
    gaps = np.diff([w.t for w in valid])
    if len(gaps) and gaps.max() > cfg.max_valid_gap_s:
        return RecoveryAssessment(RecoveryOutcome.INCONCLUSIVE, ["gap_in_fresh_window"], n_fresh=len(valid), fresh_since=t0)

    # 2. After STOP the criterion is safety, not anomaly score (the motor is not running).
    if cmd.action == ActionType.STOP:
        last_rpm = float(np.mean([w.rpm for w in valid[-5:]]))
        if not safety_ok_after_stop or last_rpm > 50:
            return RecoveryAssessment(RecoveryOutcome.HUMAN_INSPECTION_REQUIRED,
                                      ["safety_criterion_failed_after_stop" if not safety_ok_after_stop else "motor_still_turning_after_stop"],
                                      n_fresh=len(valid), fresh_since=t0)
        return RecoveryAssessment(RecoveryOutcome.INCONCLUSIVE, ["stopped_condition_not_verifiable_while_motor_off"],
                                  {"stopped_safely": True}, len(valid), t0, {"rpm": last_rpm})

    # 3. Running: anomaly score within the learned band for the CURRENT bin, trend not worsening.
    tt.reset(valid[0].housing)
    scores = []
    for w in valid:
        tt.update(w)
        sc = det.score(w)
        scores.append(sc)
    if any(s.value is None for s in scores):
        return RecoveryAssessment(RecoveryOutcome.INCONCLUSIVE, ["operating_point_not_learned"], n_fresh=len(valid), fresh_since=t0)
    ratio = np.array([s.value / s.threshold for s in scores])
    in_band = float(np.mean(ratio <= 1.0))
    slope = float(np.polyfit(np.arange(len(ratio)), ratio, 1)[0] * 60.0)
    crit = {"in_learned_band": in_band >= cfg.frac_in_band,
            "trend_not_worsening": slope <= cfg.worsening_slope_per_min}
    obs = {"frac_in_band": in_band, "score_over_threshold_mean": float(ratio.mean()), "trend_per_min": slope,
           "rpm": float(np.mean([w.rpm for w in valid])), "housing": float(np.mean([w.housing for w in valid[-10:]]))}
    if all(crit.values()):
        return RecoveryAssessment(RecoveryOutcome.RECOVERED, ["fresh_window_within_learned_band"], crit, len(valid), t0, obs)
    if previous_unresolved:
        return RecoveryAssessment(RecoveryOutcome.HUMAN_INSPECTION_REQUIRED, ["second_unresolved"], crit, len(valid), t0, obs)
    return RecoveryAssessment(RecoveryOutcome.UNRESOLVED, [k for k, v in crit.items() if not v], crit, len(valid), t0, obs)
