"""C6 learning pipeline: eligibility, gating, rollback, separation, and the safety-isolation invariant."""
import ast
import copy
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from torqva.hypotheses import HYPS, HypothesisModel
from torqva.learning import (CaseRecord, LabelSource, LearningRegistry, Status, eligible, evaluate_model,
                             split_by_provenance)
from torqva.scenarios import posterior_from, warm_session
from torqva.schemas import Hypothesis, Provenance, RecoveryOutcome


def make_case(stack, h, sev, seed, sp=1500, src=LabelSource.LAB_GROUND_TRUTH, outcome=RecoveryOutcome.RECOVERED,
              executed=True, valid=True, prov=Provenance.SIMULATED, cid=None):
    det, tt, hm, dm, zs_for = stack
    _, pre = warm_session(h, sev, seed, sp)
    _, zs = posterior_from(pre, det, tt, hm)
    return CaseRecord(cid or f"{h.value}-{seed}", prov, h, src, outcome, executed, valid, zs, f"s{seed}")


@pytest.fixture(scope="module")
def pool(stack):
    cases = []
    for h in HYPS:
        for seed in range(3000, 3006):
            cases.append(make_case(stack, h, 0.5, seed, 1200 if seed % 2 else 1800))
    return cases


def test_eligibility_rules(stack):
    ok = make_case(stack, Hypothesis.IMBALANCE, 0.6, 1)
    assert eligible(ok)
    assert not eligible(make_case(stack, Hypothesis.IMBALANCE, 0.6, 2, outcome=RecoveryOutcome.INCONCLUSIVE))
    assert not eligible(make_case(stack, Hypothesis.IMBALANCE, 0.6, 3, outcome=RecoveryOutcome.HUMAN_INSPECTION_REQUIRED))
    assert not eligible(make_case(stack, Hypothesis.IMBALANCE, 0.6, 4, executed=False))     # blocked / aborted action
    assert not eligible(make_case(stack, Hypothesis.IMBALANCE, 0.6, 5, valid=False))
    assert not eligible(make_case(stack, Hypothesis.IMBALANCE, 0.6, 6, src=LabelSource.LLM))


def test_sim_and_measured_cases_are_separate_datasets(stack):
    a = make_case(stack, Hypothesis.IMBALANCE, 0.6, 1)
    b = make_case(stack, Hypothesis.IMBALANCE, 0.6, 2, prov=Provenance.MEASURED)
    d = split_by_provenance([a, b])
    assert set(d) == {Provenance.SIMULATED, Provenance.MEASURED}


def test_training_skipped_with_too_few_cases(stack, pool):
    det, tt, hm, *_ = stack
    reg = LearningRegistry(copy.deepcopy(hm), Provenance.SIMULATED)
    assert reg.train_candidate(pool[:3], Provenance.SIMULATED) is None
    assert reg.train_candidate(pool, Provenance.MEASURED) is None           # wrong provenance -> no data
    assert len(reg.versions) == 1


def test_candidate_trained_on_blocked_actions_gets_no_data(stack, pool):
    det, tt, hm, *_ = stack
    reg = LearningRegistry(copy.deepcopy(hm), Provenance.SIMULATED)
    blocked = [CaseRecord(**{**c.__dict__, "command_executed": False}) for c in pool]
    assert reg.train_candidate(blocked, Provenance.SIMULATED) is None


def test_worse_candidate_is_rejected_and_champion_unchanged(stack, pool):
    det, tt, hm, *_ = stack
    reg = LearningRegistry(copy.deepcopy(hm), Provenance.SIMULATED)
    champ_id = reg.champion.id
    # Deliberately poisoned candidate: swap two hypotheses' signatures.
    bad = copy.deepcopy(hm)
    a, b = Hypothesis.IMBALANCE, Hypothesis.OVERLOAD
    bad.mu[a], bad.mu[b] = hm.mu[b], hm.mu[a]
    bad.var[a], bad.var[b] = hm.var[b], hm.var[a]
    cand = reg._add(bad, "hypothesis_model", Status.CANDIDATE, ["poison"], Provenance.SIMULATED, "poisoned")
    res = reg.gate(cand, pool)
    assert not res.promoted
    assert not reg.promote(cand, res)
    assert reg.champion.id == champ_id and cand.status == Status.RETIRED


def test_improving_candidate_is_promoted_then_rollback_restores_previous(stack, pool):
    det, tt, hm, *_ = stack
    # A weak champion (fit on very little data) so that learning from outcomes can help.
    weak = HypothesisModel()
    weak.fit({h: [np.random.RandomState(1).randn(10) * 3 for _ in range(6)] for h in HYPS})
    reg = LearningRegistry(weak, Provenance.SIMULATED)
    train = [c for c in pool if int(c.session_id[1:]) < 3004]       # stratified by session: every class in both
    hold = [c for c in pool if int(c.session_id[1:]) >= 3004]
    cand = reg.train_candidate(train, Provenance.SIMULATED, min_cases=6)
    assert cand is not None and cand.status == Status.CANDIDATE
    res = reg.gate(cand, hold)
    assert res.promoted, (res.reasons, res.champion_metrics, res.candidate_metrics)
    assert res.candidate_metrics["false_confident_rate"] <= res.champion_metrics["false_confident_rate"]
    old = reg.champion.id
    assert reg.promote(cand, res)
    assert reg.champion.id == cand.id
    reg.rollback()
    assert reg.champion.id == old and cand.status == Status.RETIRED


def test_hardware_promotion_needs_human_approval(stack, pool):
    det, tt, hm, *_ = stack
    weak = HypothesisModel()
    weak.fit({h: [np.random.RandomState(1).randn(10) * 3 for _ in range(6)] for h in HYPS})
    reg = LearningRegistry(weak, Provenance.MEASURED)
    mpool = [CaseRecord(**{**c.__dict__, "provenance": Provenance.MEASURED}) for c in pool]
    cand = reg.train_candidate([c for c in mpool if int(c.session_id[1:]) < 3004], Provenance.MEASURED)
    res = reg.gate(cand, [c for c in mpool if int(c.session_id[1:]) >= 3004])
    assert res.promoted
    assert not reg.promote(cand, res, hardware_mode=True, hardware_human_approved=False)
    assert cand.status == Status.SHADOW and reg.champion.id == 1
    assert reg.promote(cand, res, hardware_mode=True, hardware_human_approved=True)


def test_rollback_never_lands_on_a_rejected_candidate(stack, pool):
    det, tt, hm, *_ = stack
    reg = LearningRegistry(copy.deepcopy(hm), Provenance.SIMULATED)
    rej = reg._add(copy.deepcopy(hm), "hypothesis_model", Status.CANDIDATE, [], Provenance.SIMULATED, "x")
    reg.promote(rej, type("R", (), {"promoted": False, "reasons": ["x"]})())
    good = reg._add(copy.deepcopy(hm), "hypothesis_model", Status.CANDIDATE, [], Provenance.SIMULATED, "y")
    reg.promote(good, type("R", (), {"promoted": True, "reasons": ["ok"]})())
    assert reg.rollback().id == 1


def test_learning_module_cannot_reach_safety_code():
    """Invariant: C6 has no import path to the supervisor, dispatcher or limits."""
    src = (Path(__file__).parent.parent / "torqva" / "learning.py").read_text()
    imported = set()
    for node in ast.walk(ast.parse(src)):
        if isinstance(node, ast.ImportFrom):
            imported.add((node.module or "").split(".")[0] + "." + node.names[0].name if node.level else node.module)
            imported.add(node.module)
        elif isinstance(node, ast.Import):
            imported.update(n.name for n in node.names)
    flat = " ".join(str(x) for x in imported)
    for forbidden in ("supervisor", "dispatch", "incident"):
        assert forbidden not in flat


def test_supervisor_limits_unchanged_by_learning(stack, pool):
    from torqva.supervisor import SupervisorLimits
    before = SupervisorLimits()
    det, tt, hm, *_ = stack
    reg = LearningRegistry(copy.deepcopy(hm), Provenance.SIMULATED)
    reg.train_candidate(pool, Provenance.SIMULATED)
    assert SupervisorLimits() == before
