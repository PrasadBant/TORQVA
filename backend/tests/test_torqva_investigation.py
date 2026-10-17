"""Evidence-to-action trace, counterfactual experiment lab, adaptive diagnostic testing with evidence sufficiency, and Decision Receipts
(simulation only). Real SimulationService runs throughout; where a test sets a state by hand (a posterior, invalid windows, no learned
signatures) the comment says so."""
import copy
import hashlib
import sys
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).parent.parent))

from torqva.api import create_router
from torqva.auth import TokenAuth
from torqva.hypotheses import HYPS, Posterior
from torqva.schemas import Hypothesis
from torqva.service import SimulationService
from torqva import workbench as wb
from torqva import investigation as inv

H = lambda t: {"Authorization": f"Bearer {t}"}
B = "/api/torqva"
entry = lambda tok, user, role: {"sha256": hashlib.sha256(tok.encode()).hexdigest(), "user": user, "role": role}


@pytest.fixture(scope="module")
def svc():
    return SimulationService()


@pytest.fixture(scope="module")
def c(svc):
    app = FastAPI()
    app.include_router(create_router(svc, TokenAuth([entry("v", "vera", "viewer"), entry("o", "olga", "operator")])))
    return TestClient(app)


def start(c, approval=True, fault="imbalance", seed=4):
    assert c.post(f"{B}/simulation/start", json={"fault": fault, "severity": 0.5, "clears_below_rpm": 1500, "seed": seed,
                                                  "require_human_approval": approval}, headers=H("o")).status_code == 200


def until_pending(c):
    for _ in range(6):
        c.post(f"{B}/simulation/step", json={"seconds": 30}, headers=H("o"))
        if c.get(f"{B}/status", headers=H("v")).json().get("pending_approval"):
            return
    raise AssertionError("no action was held for approval")


def ambiguous(a="imbalance", b="looseness"):
    """A hand-set two-way ambiguity (stand-in for an ambiguous ranking), so the planner has something to resolve."""
    probs = {h: 0.0 for h in HYPS}
    probs[Hypothesis(a)], probs[Hypothesis(b)] = 0.5, 0.5
    return Posterior(probs, 15)


# ------------------------------------------------------------------------------------------------ evidence sufficiency + adaptive C4
def test_without_a_ranking_more_evidence_is_required_and_no_test_runs(svc, c):
    start(c)
    c.post(f"{B}/simulation/step", json={"seconds": 20}, headers=H("o"))
    s = c.get(f"{B}/simulation/workbench/plan", headers=H("v")).json()["sufficiency"]
    assert s["status"] == "MORE_EVIDENCE_REQUIRED" and "no hypothesis ranking" in s["reason"]
    r = c.post(f"{B}/simulation/workbench/adaptive", json={"budget": 2}, headers=H("o")).json()
    assert r["status"] == "MORE_EVIDENCE_REQUIRED" and r["stages"] == []


def test_adaptive_planner_picks_the_most_informative_eligible_test_and_explains_the_others(svc):
    o = svc.orch
    keep, t0, sp0 = o.post, o.now, o.dev.sim.setpoint
    o.post = ambiguous()                                                  # hand-set ambiguity (see helper)
    try:
        r = wb.run_adaptive(o, o.dm, o.hm, budget=2)
    finally:
        o.post = keep
    assert o.now == t0 and o.dev.sim.setpoint == sp0                     # the live run did not move
    assert r["stages"], r["reason"]
    st = r["stages"][0]
    gains = {a["test"]: a["expected_info_gain_nats"] for a in st["alternatives"] if a["eligible"]}
    assert all(st["expected_info_gain_nats"] >= g for g in gains.values())
    assert st["selected"] == "T1"                                        # the speed step is what separates imbalance from looseness
    assert {a["test"] for a in st["alternatives"]} == {"T3", "T4"} and all(a["not_selected_because"] for a in st["alternatives"])
    assert st["posterior_before"]["top_p"] == 0.5 and st["posterior_after"] and len(st["observation"]) == 3
    assert r["status"] in wb.SUFFICIENCY and r["reason"]
    if r["status"] == "SUFFICIENT_EVIDENCE":
        assert r["posterior_final"]["label"] == "confident"


def test_invalid_recent_windows_stop_everything(svc):
    o = svc.orch
    saved = [w.valid for w in o.buf[-10:]]
    keep = o.post
    for w in o.buf[-10:]:
        w.valid = False                                                   # hand-set invalid input
    o.post = ambiguous()
    try:
        assert wb.sufficiency(o, o.dm)["status"] == "INVALID_INPUT"
        r = wb.run_adaptive(o, o.dm, o.hm, budget=2)
        assert r["status"] == "INVALID_INPUT" and r["stages"] == []
    finally:
        for w, v in zip(o.buf[-10:], saved):
            w.valid = v
        o.post = keep


def test_without_learned_signatures_no_test_is_supported(svc, monkeypatch):
    o = svc.orch
    keep = o.post
    monkeypatch.setattr(o.dm, "models", {})                               # hand-set: no learned outcome signature
    o.post = ambiguous()
    try:
        r = wb.run_adaptive(o, o.dm, o.hm, budget=2)
        assert r["status"] == "TEST_NOT_SUPPORTED" and "no signature learned" in r["reason"]
    finally:
        o.post = keep


def test_a_certain_ranking_with_nothing_left_to_learn_is_not_forced(svc):
    o = svc.orch
    keep = o.post
    probs = {h: 0.0 for h in HYPS}; probs[Hypothesis("looseness")] = 1.0
    o.post = Posterior(probs, 15)                                         # hand-set: certain, but looseness needs a speed-step test first
    try:
        r = wb.run_adaptive(o, o.dm, o.hm, budget=2)
        assert r["status"] == "INCONCLUSIVE" and "would remove only" in r["reason"] and r["stages"] == []
    finally:
        o.post = keep


def test_adaptive_route_validates_the_budget_and_needs_an_operator(c):
    assert c.post(f"{B}/simulation/workbench/adaptive", json={"budget": 9}, headers=H("o")).status_code == 422
    assert c.post(f"{B}/simulation/workbench/adaptive", json={"budget": 1}, headers=H("v")).status_code == 403


# ------------------------------------------------------------------------------------------------ counterfactual lab
def test_counterfactual_branches_share_one_start_and_leave_the_live_run_untouched(svc, c):
    until_pending(c)
    o = svc.orch
    before = (o.now, o.dev.sim.setpoint, wb._digest(o.dev.sim), len(o.buf))
    r = c.post(f"{B}/simulation/workbench/counterfactual", json={"targets": [1400, 1260], "include_continue": True, "include_stop": True,
                                                                 "horizon_s": 60}, headers=H("o"))
    assert r.status_code == 200, r.text
    d = r.json()
    assert (o.now, o.dev.sim.setpoint, wb._digest(o.dev.sim), len(o.buf)) == before
    assert [b["label"] for b in d["branches"]] == ["Continue", "Reduce to 1400 rpm", "Reduce to 1260 rpm", "STOP (coast)"]
    assert all(b["status"] == "completed" and len(b["observed"]) == 60 for b in d["branches"])
    first = {b["label"]: b["observed"][0]["dt"] for b in d["branches"]}
    assert set(first.values()) == {1.0}                                    # same clock, same horizon
    fin = {b["label"]: b["metrics"]["final_mean_last_10s"]["rpm"] for b in d["branches"]}
    assert abs(fin["Reduce to 1400 rpm"] - 1400) < 80 and abs(fin["Reduce to 1260 rpm"] - 1260) < 80 and fin["STOP (coast)"] < fin["Reduce to 1260 rpm"]
    assert len({b["window_hash"] for b in d["branches"]}) == 4             # the actions really diverged
    pr = d["branches"][1]["prediction"]
    assert pr["rows"] and all(x["horizon_s"] in (30, 60) for x in pr["rows"])     # only horizons inside the experiment
    assert d["inputs"]["state_digest"] and d["inputs"]["model_versions"]["c2_predictor"] is not None and d["inputs"]["seed"] == 4
    again = c.post(f"{B}/simulation/workbench/counterfactual/{d['id']}/rerun", headers=H("o")).json()
    assert again["identical"] is True and again["state_digest"] == again["state_digest_now"]
    got = c.get(f"{B}/simulation/workbench/counterfactual/{d['id']}", headers=H("v")).json()
    assert got["id"] == d["id"] and got["rerunnable"] is True
    assert c.get(f"{B}/simulation/workbench/counterfactual/CF-9999", headers=H("v")).status_code == 404


def test_counterfactual_inputs_are_validated(c):
    bad = [{"targets": [1400], "include_continue": False, "include_stop": False, "horizon_s": 60},
           {"targets": [1400], "horizon_s": 45}, {"targets": [5000], "horizon_s": 60}, {"targets": [1, 2, 3, 4], "horizon_s": 60}]
    for b in bad:
        assert c.post(f"{B}/simulation/workbench/counterfactual", json=b, headers=H("o")).status_code == 422, b
    assert c.post(f"{B}/simulation/workbench/counterfactual", json={"targets": [1400], "horizon_s": 60}, headers=H("v")).status_code == 403


def test_a_failed_branch_is_reported_as_failed(svc, monkeypatch):
    o = svc.orch
    real = wb._branch
    def boom(snap, action, target, horizon, risk_limits):
        if action == "STOP":
            raise RuntimeError("forced failure for the test")
        return real(snap, action, target, horizon, risk_limits)
    monkeypatch.setattr(wb, "_branch", boom)
    d = wb.counterfactual(o, [1400], True, True, 30, {})
    stop = next(b for b in d["branches"] if b["action"] == "STOP")
    assert stop["status"] == "failed" and "forced failure" in stop["error"] and "observed" not in stop


# ------------------------------------------------------------------------------------------------ decision receipts + trace
def test_a_refused_request_leaves_a_receipt_as_visible_as_an_accepted_one(svc, c):
    basis = c.get(f"{B}/simulation/workbench/predict", params={"targets": [1400]}, headers=H("v")).json()["basis"]
    old = {**basis, "t": basis["t"] - 100}
    r = c.post(f"{B}/simulation/workbench/request", json={"action": "REDUCE_SPEED", "target_rpm": 1400, "basis": old}, headers=H("o"))
    assert r.status_code == 409 and "decision receipt R-" in r.json()["detail"]
    rid = r.json()["detail"].split("decision receipt ")[1].rstrip(")")
    rec = c.get(f"{B}/simulation/workbench/receipts/{rid}", headers=H("v")).json()
    assert rec["decision"] == "REFUSED" and rec["command"] is None and rec["digest_valid"]
    assert [x["state"] for x in rec["lifecycle"]][-1] == "REJECTED" and rec["unresolved"]
    assert rec["snapshot"]["stale"] and rec["snapshot"]["telemetry"]["provenance"] == "SIMULATED"
    assert svc.orch.pending is not None                                    # nothing was dispatched


def test_pending_receipt_reevaluates_the_held_action(c):
    p = c.get(f"{B}/simulation/workbench/receipts", headers=H("v")).json()["pending"]
    assert p and p["state"] == "AWAITING_APPROVAL" and p["gate_now"]["verdict"] and isinstance(p["still_valid"], bool)


def test_an_accepted_request_has_a_frozen_snapshot_and_a_lifecycle_from_records(svc, c):
    basis = c.get(f"{B}/simulation/workbench/predict", params={"targets": [1400]}, headers=H("v")).json()["basis"]
    r = c.post(f"{B}/simulation/workbench/request", json={"action": "REDUCE_SPEED", "target_rpm": 1400, "basis": basis, "candidate_id": "P-A"}, headers=H("o"))
    assert r.status_code == 200, r.text
    rid = r.json()["receipt_id"]
    rec = c.get(f"{B}/simulation/workbench/receipts/{rid}", headers=H("v")).json()
    states = [x["state"] for x in rec["lifecycle"]]
    assert rec["decision"] == "ACCEPTED" and states[:3] == ["PROPOSED", "AWAITING_APPROVAL", "ACCEPTED"]
    assert "RECOVERED" not in states and "EXECUTED" not in states                # nothing claimed before the records exist
    snap_t = rec["snapshot"]["telemetry"]["t"]
    assert rec["snapshot"]["gate"]["verdict"] == "ACT" and rec["snapshot"]["prediction"]["target_rpm"] == 1400
    for _ in range(4):
        c.post(f"{B}/simulation/step", json={"seconds": 30}, headers=H("o"))
    later = c.get(f"{B}/simulation/workbench/receipts/{rid}", headers=H("v")).json()
    assert later["snapshot"]["telemetry"]["t"] == snap_t and later["snapshot_sha256"] == rec["snapshot_sha256"]   # never refreshed
    st2 = [x["state"] for x in later["lifecycle"]]
    assert "ACKNOWLEDGED" in st2 and st2.index("ACKNOWLEDGED") > st2.index("ACCEPTED")
    assert "EXECUTED" not in st2                                            # the simulated device never reports completion of a speed change
    if "RECOVERED" in st2 or "RECOVERY_FAILED" in st2:
        assert "VERIFICATION_PENDING" in st2
    # a changed snapshot is detected
    o = svc.orch
    stored = o.get("decision_receipt", rid); stored.pop("_provenance", None)
    stored["snapshot"]["telemetry"]["rpm"] = 1.0
    o._put("decision_receipt", rid, stored, "SIMULATED", o.now)
    assert inv.receipt(o, rid)["digest_valid"] is False
    with pytest.raises(ValueError):
        inv.write_receipt(o, rid, {}, "ACCEPTED", {}, [], {})            # written once


def test_trace_connects_observation_to_outcome_with_real_record_references(svc, c):
    t = c.get(f"{B}/simulation/workbench/trace", headers=H("v")).json()
    stages = {s["stage"]: s for s in t["stages"]}
    for s in ("observation", "hypothesis", "prediction", "decision"):
        assert stages[s]["reached"], s
    log = svc.orch.log
    for s in t["stages"]:
        for e in s["events"]:
            src = e["source"]
            if src["record"] == "log":
                assert log[src["index"]]["kind"] == e["kind"]                     # the reference points at the record shown
    opened = next(e for e in stages["observation"]["events"] if e["kind"] == "incident_opened")
    assert opened["data"]["window"]["provenance"] == "SIMULATED"
    assert any(e["kind"] == "analyst_action" for e in stages["decision"]["events"])
    assert any(e["kind"] == "counterfactual" for e in stages["prediction"]["events"])
    assert c.get(f"{B}/simulation/workbench/trace", params={"incident": "INC-999"}, headers=H("v")).status_code == 404


def test_pipeline_actions_get_derived_receipts(c):
    start(c, approval=False, seed=4)
    for _ in range(5):
        c.post(f"{B}/simulation/step", json={"seconds": 30}, headers=H("o"))
    rows = c.get(f"{B}/simulation/workbench/receipts", headers=H("v")).json()["receipts"]
    derived = [r for r in rows if r["kind"] == "pipeline"]
    assert derived, rows
    rec = c.get(f"{B}/simulation/workbench/receipts/{derived[0]['id']}", headers=H("v")).json()
    assert rec["derived"] and rec["snapshot"]["gate"] and rec["lifecycle"][0]["state"] == "PROPOSED"
    assert "AWAITING_APPROVAL" not in [x["state"] for x in rec["lifecycle"]]    # auto-approved in this scenario: no approval invented
