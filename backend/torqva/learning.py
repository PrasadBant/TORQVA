"""C6 — outcome-based learning with a gated, versioned, reversible pipeline.

Only low-parameter, safety-neutral components are learnable (hypothesis signatures/priors). Hard limits,
envelopes, mandatory-stop rules and the Safety Supervisor are NOT importable from here: a test enforces it.
"""
from __future__ import annotations

import copy
from dataclasses import dataclass, field
from enum import Enum
from typing import Dict, List, Optional, Sequence

import numpy as np

from .hypotheses import HYPS, HypothesisModel
from .schemas import Hypothesis, Provenance, RecoveryOutcome


class LabelSource(str, Enum):
    HUMAN_CONFIRMED = "HUMAN_CONFIRMED"
    LAB_GROUND_TRUTH = "LAB_GROUND_TRUTH"
    SYSTEM = "SYSTEM"          # the system's own diagnosis; reduced weight
    LLM = "LLM"                # never eligible


LABEL_WEIGHT = {LabelSource.HUMAN_CONFIRMED: 1.0, LabelSource.LAB_GROUND_TRUTH: 1.0, LabelSource.SYSTEM: 0.3,
                LabelSource.LLM: 0.0}


@dataclass
class CaseRecord:
    id: str
    provenance: Provenance                 # SIMULATED and MEASURED are different datasets
    label: Hypothesis
    label_source: LabelSource
    outcome: RecoveryOutcome
    command_executed: bool                 # device confirmed the action took effect
    data_valid: bool
    z_windows: List[np.ndarray]            # C1 signed z-vectors at diagnosis time
    session_id: str = ""


def eligible(c: CaseRecord) -> bool:
    return (c.outcome in (RecoveryOutcome.RECOVERED, RecoveryOutcome.UNRESOLVED) and c.command_executed
            and c.data_valid and c.label_source != LabelSource.LLM and len(c.z_windows) >= 5)


def split_by_provenance(cases: Sequence[CaseRecord]) -> Dict[Provenance, List[CaseRecord]]:
    out: Dict[Provenance, List[CaseRecord]] = {}
    for c in cases:
        out.setdefault(c.provenance, []).append(c)
    return out


class Status(str, Enum):
    CANDIDATE = "candidate"
    SHADOW = "shadow"
    CHAMPION = "champion"
    RETIRED = "retired"


@dataclass
class ModelVersion:
    id: int
    kind: str
    status: Status
    model: HypothesisModel
    trained_on: List[str]
    provenance: Provenance
    metrics: Dict[str, float] = field(default_factory=dict)
    note: str = ""
    ever_champion: bool = False


@dataclass
class PromotionResult:
    promoted: bool
    reasons: List[str]
    champion_metrics: Dict[str, float]
    candidate_metrics: Dict[str, float]


def evaluate_model(model: HypothesisModel, cases: Sequence[CaseRecord], p_conf: float = 0.7) -> Dict[str, float]:
    n = len(cases)
    if n == 0:
        return {"n": 0}
    acc = conf_wrong = nll = 0.0
    for c in cases:
        post = model.posterior(c.z_windows[-15:])
        acc += post.top == c.label
        conf_wrong += (post.top_p >= p_conf and post.top != c.label)
        nll += -np.log(max(post.probs[c.label], 1e-9))
    return {"n": float(n), "top1": acc / n, "false_confident_rate": conf_wrong / n, "nll": nll / n}


class LearningRegistry:
    def __init__(self, initial: HypothesisModel, provenance: Provenance, trained_on: Sequence[str] = ()):
        self.versions: List[ModelVersion] = []
        self._next = 1
        self.audit: List[str] = []
        self._add(initial, "bootstrap", Status.CHAMPION, list(trained_on), provenance, "initial champion")

    # ---------------- helpers ----------------
    def _add(self, model, kind, status, trained_on, prov, note="") -> ModelVersion:
        v = ModelVersion(self._next, kind, status, model, trained_on, prov, note=note,
                         ever_champion=(status == Status.CHAMPION))
        self._next += 1
        self.versions.append(v)
        self.audit.append(f"v{v.id} created as {status.value}: {note}")
        return v

    @property
    def champion(self) -> ModelVersion:
        return [v for v in self.versions if v.status == Status.CHAMPION][-1]

    # ---------------- training ----------------
    def train_candidate(self, cases: Sequence[CaseRecord], provenance: Provenance, min_cases: int = 6,
                        weight_replicas: int = 3) -> Optional[ModelVersion]:
        """Refit hypothesis signatures from eligible cases of ONE provenance. Returns None if too little data."""
        pool = [c for c in cases if eligible(c) and c.provenance == provenance]
        if len(pool) < min_cases:
            self.audit.append(f"training skipped: {len(pool)} eligible {provenance.value} cases < {min_cases}")
            return None
        base = self.champion.model
        cand = copy.deepcopy(base)
        samples: Dict[Hypothesis, List[np.ndarray]] = {h: [] for h in HYPS}
        for c in pool:
            reps = max(1, int(round(LABEL_WEIGHT[c.label_source] * weight_replicas)))
            for _ in range(reps):
                samples[c.label] += list(c.z_windows[-20:])
        # Blend with the champion's existing signature so a handful of cases cannot swing it wildly.
        blended: Dict[Hypothesis, List[np.ndarray]] = {}
        for h, zs in samples.items():
            if len(zs) >= 5 and h in base.mu:
                prior_pts = [base.mu[h]] * len(zs)             # shrinkage toward the champion
                blended[h] = list(zs) + prior_pts
            elif len(zs) >= 5:
                blended[h] = zs
        counts = {h: sum(1 for c in pool if c.label == h) for h in HYPS}
        pri = {h: (counts[h] + 1.0) for h in HYPS}                     # Laplace-smoothed priors
        cand.fit(blended, priors=pri)
        return self._add(cand, "hypothesis_model", Status.CANDIDATE, [c.id for c in pool], provenance,
                         f"trained on {len(pool)} cases")

    # ---------------- promotion gate ----------------
    def gate(self, cand: ModelVersion, holdout: Sequence[CaseRecord], min_gain: float = 0.02) -> PromotionResult:
        hold = [c for c in holdout if eligible(c) and c.provenance == cand.provenance]
        champ_m = evaluate_model(self.champion.model, hold)
        cand_m = evaluate_model(cand.model, hold)
        cand.metrics = cand_m
        reasons: List[str] = []
        if cand_m.get("n", 0) < 5:
            reasons.append("holdout_too_small")
        else:
            improved = (cand_m["top1"] - champ_m["top1"] >= min_gain) or (champ_m["nll"] - cand_m["nll"] >= 0.05)
            if not improved:
                reasons.append("no_target_metric_improved")
            if cand_m["false_confident_rate"] > champ_m["false_confident_rate"] + 1e-9:
                reasons.append("regression_false_confident_rate")
            if cand_m["top1"] < champ_m["top1"] - 1e-9:
                reasons.append("regression_top1")
        return PromotionResult(not reasons, reasons or ["improved_without_regression"], champ_m, cand_m)

    def promote(self, cand: ModelVersion, result: PromotionResult, hardware_human_approved: bool = False,
                hardware_mode: bool = False) -> bool:
        if not result.promoted:
            cand.status = Status.RETIRED
            self.audit.append(f"v{cand.id} rejected: {','.join(result.reasons)}")
            return False
        if hardware_mode and not hardware_human_approved:
            self.audit.append(f"v{cand.id} awaiting human approval for hardware promotion")
            cand.status = Status.SHADOW
            return False
        self.champion.status = Status.RETIRED
        cand.status = Status.CHAMPION
        cand.ever_champion = True
        self.audit.append(f"v{cand.id} promoted to champion")
        return True

    def rollback(self) -> ModelVersion:
        """Re-instate the most recent earlier version that was once champion (never a rejected candidate)."""
        cur = self.champion
        prev = [v for v in self.versions if v.ever_champion and v.id < cur.id and v.status == Status.RETIRED]
        if not prev:
            raise RuntimeError("nothing to roll back to")
        target = prev[-1]
        cur.status = Status.RETIRED
        target.status = Status.CHAMPION
        self.audit.append(f"rolled back v{cur.id} -> v{target.id}")
        return target
