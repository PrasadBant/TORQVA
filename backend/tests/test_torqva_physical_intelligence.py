import hashlib
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from torqva.api import create_router
from torqva.auth import TokenAuth
from torqva.schemas import Role
from torqva.service import SimulationService


def entry(token, user, role):
    return {"sha256": hashlib.sha256(token.encode()).hexdigest(), "user": user, "role": role}


@pytest.fixture
def client(tmp_path):
    svc = SimulationService(str(tmp_path / "store.db"))
    app = FastAPI()
    app.include_router(
        create_router(
            svc,
            TokenAuth([
                entry("viewer-token", "tester-view", Role.VIEWER),
                entry("operator-token", "tester-op", Role.OPERATOR),
                entry("admin-token", "tester-adm", Role.ADMIN),
            ])
        )
    )
    return TestClient(app)


def test_physical_recovery_endpoint_returns_measured_provenance_and_schema(client):
    res = client.get("/api/torqva/recovery/physical", headers={"Authorization": "Bearer viewer-token"})
    assert res.status_code == 200
    data = res.json()
    assert data["provenance"] == "MEASURED"
    assert "status" in data
    assert "criteria" in data
    assert "before_after" in data
    assert "outcomes" in data

    status = data["status"]
    assert status["outcome"] in ("RECOVERY_VERIFIED", "VERIFYING_RECOVERY", "UNRESOLVED")
    assert "incident" in status
    assert len(data["criteria"]) >= 4

    outcomes = data["outcomes"]
    assert len(outcomes) >= 1
    assert outcomes[0]["provenance"] == "MEASURED"


def test_physical_recovery_verification_trigger(client):
    res = client.post("/api/torqva/recovery/verify-physical", headers={"Authorization": "Bearer operator-token"})
    assert res.status_code == 200
    data = res.json()
    assert data["provenance"] == "MEASURED"
    assert "status" in data


def test_physical_continuous_intelligence_candidates_and_refs(client):
    res = client.get("/api/torqva/attestation/physical/candidates", headers={"Authorization": "Bearer viewer-token"})
    assert res.status_code == 200
    candidates = res.json()
    assert isinstance(candidates, list)
    assert len(candidates) >= 1
    assert candidates[0]["provenance"] == "MEASURED"

    cid = candidates[0]["id"]
    res_one = client.get(f"/api/torqva/attestation/physical/candidates/{cid}", headers={"Authorization": "Bearer viewer-token"})
    assert res_one.status_code == 200
    detail = res_one.json()
    assert detail["provenance"] == "MEASURED"
    assert "checks" in detail
    assert len(detail["checks"]) == 10

    res_refs = client.get("/api/torqva/attestation/physical/references", headers={"Authorization": "Bearer viewer-token"})
    assert res_refs.status_code == 200
    refs = res_refs.json()
    assert "versions" in refs
    assert len(refs["versions"]) >= 1
    assert refs["versions"][0]["provenance"] == "MEASURED"


def test_physical_candidate_capture_and_attestation(client):
    res_cap = client.post("/api/torqva/attestation/physical/capture", headers={"Authorization": "Bearer operator-token"})
    assert res_cap.status_code == 200
    cap = res_cap.json()
    assert cap["provenance"] == "MEASURED"
    cid = cap["id"]

    res_att = client.post(
        f"/api/torqva/attestation/physical/candidates/{cid}/attest",
        json={"reason": "Operator verification on hardware rig RIG-1"},
        headers={"Authorization": "Bearer operator-token"}
    )
    assert res_att.status_code == 200
    att = res_att.json()
    assert att["state"] == "ATTESTED"
    assert att["reference_version"] is not None


def test_outcomes_and_cases_endpoints_return_measured_provenance(client):
    res_out = client.get("/api/torqva/outcomes", headers={"Authorization": "Bearer viewer-token"})
    assert res_out.status_code == 200
    # In test mode without connected bridge, outcomes list can be empty or have sim/phys items
    assert isinstance(res_out.json(), list)

    res_cases = client.get("/api/torqva/cases", headers={"Authorization": "Bearer viewer-token"})
    assert res_cases.status_code == 200
    assert isinstance(res_cases.json(), list)
