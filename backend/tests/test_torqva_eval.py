"""The evaluation suite must run, be labelled as simulation, keep MEASURED empty and never allow false recoveries."""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from torqva import evaluation


@pytest.fixture(scope="module")
def run():
    return evaluation.run_all()


def test_run_is_labelled_simulation_and_measured_is_empty(run):
    assert run["data_provenance"] == "SIMULATED"
    assert "NO MEASURED DATA" in run["measured"]["status"]
    assert "Simulation only" in run["WARNING"]
    assert run["git_sha"] and run["config_hash"]


def test_train_and_test_seeds_are_disjoint():
    test_seeds = {201, 202, 203, 204, 205, 301, 302, 303, 401, 402, 403, 501, 502, 503, 504, 505, 601, 602, 603,
                  701, 710}
    assert not (set(evaluation.TRAIN_SEEDS) & test_seeds)
    assert not (set(evaluation.TEST_SPEEDS) & set(evaluation.SPEEDS_LEARNED))      # test speeds never seen in training


def test_no_false_recovery_declarations(run):
    assert run["c5"]["FALSE_RECOVERY_DECLARATIONS"] == 0


def test_c1_healthy_false_alarms_are_rare_and_beats_fixed_thresholds_on_mild_faults(run):
    c1 = run["c1"]
    assert c1["healthy"]["c1"]["window_false_alarm_rate"] < 0.02
    assert c1["healthy"]["c1"]["confirmed_false_incidents"] == 0
    d = c1["detection"]
    for key in ("imbalance@0.1", "overload@0.1", "looseness@0.1"):
        assert d[key]["c1"]["detected_fraction"] > d[key]["legacy"]["detected_fraction"]


def test_c2_beats_persistence_for_speed_changing_actions(run):
    for k, v in run["c2"]["mae"].items():
        if k.startswith(("REDUCE_SPEED", "STOP")):
            assert v["model"] < v["persistence"], k


def test_c2_is_reported_unvalidated(run):
    assert run["c2"]["validated_by_intervention_experiments"] is False


def test_hypothesis_ranking_far_above_chance_but_false_confidence_is_reported(run):
    h = run["hypotheses"]
    assert h["top1_accuracy"] > 3 * h["random_baseline"]
    assert "false_confident_rate" in h and h["confusion"]["matrix"]
    for v in h["test_value"].values():
        assert v["accuracy_after_test"] > v["accuracy_before_test"]
