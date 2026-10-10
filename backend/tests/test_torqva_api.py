"""TORQVA API: fail-closed auth, roles, audit, idempotent approval, provenance tagging."""
import hashlib
import sys
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).parent.parent))

from torqva.api import create_router
from torqva.auth import AuthConfigError, TokenAuth
from torqva.service import SimulationService


def entry(token, user, role):
    return {"sha256": hashlib.sha256(token.encode()).hexdigest(), "user": user, "role": role}


@pytest.fixture(scope="module")
def service():
    return SimulationService()


def client(service, entries):
    app = FastAPI()
    app.include_router(create_router(service, TokenAuth(entries)))
    return TestClient(app)


H = lambda t: {"Authorization": f"Bearer {t}"}
ENTRIES = [entry("v-tok", "vera", "viewer"), entry("o-tok", "olga", "operator"), entry("a-tok", "adam", "admin")]


def test_no_tokens_configured_means_everything_refuses(service):
    c = client(service, [])
    for path in ("/api/torqva/status", "/api/torqva/incidents"):
        assert c.get(path, headers=H("anything")).status_code == 503
    assert c.post("/api/torqva/commands/stop", headers=H("anything")).status_code == 503


def test_missing_or_wrong_token_is_401(service):
    c = client(service, ENTRIES)
    assert c.get("/api/torqva/status").status_code == 401
    assert c.get("/api/torqva/status", headers=H("nope")).status_code == 401
    assert c.get("/api/torqva/status", headers={"Authorization": "Basic abc"}).status_code == 401


def test_bad_auth_config_is_rejected():
    with pytest.raises(AuthConfigError):
        TokenAuth([{"sha256": "short", "user": "x", "role": "viewer"}])
    with pytest.raises(Exception):
        TokenAuth([{"sha256": "0" * 64, "user": "x", "role": "root"}])


def test_viewer_can_read_but_not_control(service):
    c = client(service, ENTRIES)
    assert c.get("/api/torqva/status", headers=H("v-tok")).status_code == 200
    assert c.post("/api/torqva/simulation/start", json={}, headers=H("v-tok")).status_code == 403
    assert c.post("/api/torqva/approvals/approve", headers=H("v-tok")).status_code == 403
    assert c.get("/api/torqva/audit", headers=H("v-tok")).status_code == 403
    assert c.post("/api/torqva/commands/reset-estop", headers=H("o-tok")).status_code == 403    # admin only


def test_denied_attempts_are_audited(service):
    c = client(service, ENTRIES)
    c.post("/api/torqva/simulation/start", json={}, headers=H("v-tok"))
    a = c.get("/api/torqva/audit", params={"kind": "denied"}, headers=H("a-tok")).json()
    assert any(x["actor"] == "vera" and x["detail"]["needed"] == "operator" for x in a)


def test_status_is_labelled_simulation_with_unvalidated_c2(service):
    c = client(service, ENTRIES)
    c.post("/api/torqva/simulation/start", json={"fault": "imbalance", "severity": 0.5, "clears_below_rpm": 1500},
           headers=H("o-tok"))
    s = c.get("/api/torqva/status", headers=H("v-tok")).json()
    assert s["mode"] == "SIMULATION" and s["provenance"] == "SIMULATED"
    assert s["models"]["c2_label"] == "Intervention Outcome Prediction (unvalidated)"


def test_unknown_fault_and_bad_ranges_are_422(service):
    c = client(service, ENTRIES)
    assert c.post("/api/torqva/simulation/start", json={"fault": "gremlins"}, headers=H("o-tok")).status_code == 422
    assert c.post("/api/torqva/simulation/start", json={"severity": 3}, headers=H("o-tok")).status_code == 422
    assert c.post("/api/torqva/simulation/start", json={"setpoint_rpm": 99999}, headers=H("o-tok")).status_code == 422


def test_full_loop_over_api_and_all_data_is_tagged_simulated(service):
    c = client(service, ENTRIES)
    c.post("/api/torqva/simulation/start", json={"fault": "imbalance", "severity": 0.5, "clears_below_rpm": 1500, "seed": 3},
           headers=H("o-tok"))
    for _ in range(5):
        c.post("/api/torqva/simulation/step", json={"seconds": 100}, headers=H("o-tok"))
    out = c.get("/api/torqva/outcomes", headers=H("v-tok")).json()
    assert out and out[-1]["outcome"] == "RECOVERED" and out[-1]["_provenance"] == "SIMULATED"
    tel = c.get("/api/torqva/telemetry", headers=H("v-tok")).json()
    assert tel["provenance"] == "SIMULATED" and all(s["provenance"] == "SIMULATED" for s in tel["samples"])
    assert all(p["_provenance"] == "PREDICTED" for p in c.get("/api/torqva/predictions", headers=H("v-tok")).json())
    cmds = c.get("/api/torqva/commands", headers=H("v-tok")).json()
    assert any(x["action"] == "REDUCE_SPEED" and x["counts_as_executed"] for x in cmds)


def test_human_approval_gate_and_idempotent_approve(service):
    c = client(service, ENTRIES)
    c.post("/api/torqva/simulation/start", json={"fault": "imbalance", "severity": 0.5, "clears_below_rpm": 1500, "seed": 4,
                                                   "require_human_approval": True}, headers=H("o-tok"))
    for _ in range(4):
        c.post("/api/torqva/simulation/step", json={"seconds": 30}, headers=H("o-tok"))
        if c.get("/api/torqva/status", headers=H("v-tok")).json().get("pending_approval"):
            break
    st = c.get("/api/torqva/status", headers=H("v-tok")).json()
    assert st["pending_approval"] and st["pending_approval"]["action"] == "REDUCE_SPEED"
    assert not any(x["action"] == "REDUCE_SPEED" for x in c.get("/api/torqva/commands", headers=H("v-tok")).json())
    assert c.post("/api/torqva/approvals/approve", headers=H("v-tok")).status_code == 403
    assert c.post("/api/torqva/approvals/approve", headers=H("o-tok")).status_code == 200
    assert c.post("/api/torqva/approvals/approve", headers=H("o-tok")).status_code == 409      # second approve: nothing pending
    reds = [x for x in c.get("/api/torqva/commands", headers=H("v-tok")).json() if x["action"] == "REDUCE_SPEED"]
    assert len(reds) == 1                                                                       # dispatched exactly once
    ev = c.get("/api/torqva/audit", params={"kind": "approve"}, headers=H("a-tok")).json()
    assert ev and ev[-1]["actor"] == "olga"


def test_viewer_can_stop_and_it_is_audited(service):
    c = client(service, ENTRIES)
    c.post("/api/torqva/simulation/start", json={"seed": 5}, headers=H("o-tok"))
    c.post("/api/torqva/simulation/step", json={"seconds": 10}, headers=H("o-tok"))
    r = c.post("/api/torqva/commands/stop", headers=H("v-tok"))
    assert r.status_code == 200 and "not yet acknowledged" in r.json()["note"]
    c.post("/api/torqva/simulation/step", json={"seconds": 5}, headers=H("o-tok"))
    assert c.get("/api/torqva/status", headers=H("v-tok")).json()["device"]["setpoint_rpm"] == 0.0
    assert any(x["actor"] == "vera" for x in c.get("/api/torqva/audit", params={"kind": "stop_requested"}, headers=H("a-tok")).json())


def test_audit_log_is_append_only(service):
    import sqlite3
    with pytest.raises(sqlite3.DatabaseError):
        service.store._db.execute("DELETE FROM audit")
    with pytest.raises(sqlite3.DatabaseError):
        service.store._db.execute("UPDATE audit SET actor='x'")


def test_step_without_simulation_is_409():
    c = client(SimulationService(), ENTRIES)
    assert c.post("/api/torqva/simulation/step", json={"seconds": 1}, headers=H("o-tok")).status_code == 409


def test_the_retired_monitoring_routes_no_longer_exist():
    import main
    from fastapi.testclient import TestClient as TC
    c = TC(main.app)
    for method, path in (("post", "/api/motor"), ("post", "/api/ingest"), ("get", "/api/device/commands"), ("post", "/api/device/command-ack"), ("post", "/api/baseline/start"),
                         ("post", "/api/baseline/result"), ("get", "/api/status"), ("get", "/api/sensors/latest")):
        assert getattr(c, method)(path).status_code in (404, 405), path                   # nothing unauthenticated can reach a motor or ingest data any more
    assert c.get("/api/health").json() == {"status": "ok"}


def test_me_and_evaluation_endpoints(service):
    c = client(service, ENTRIES)
    assert c.get("/api/torqva/me", headers=H("o-tok")).json() == {"user": "olga", "role": "operator"}
    r = c.get("/api/torqva/evaluation/latest", headers=H("v-tok"))
    assert r.status_code == 200 and r.json()["run"]["data_provenance"] == "SIMULATED"
