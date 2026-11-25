import hashlib
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from torqva.api.routes import create_router
from torqva.access.auth import TokenAuth
from torqva.models.schemas import Role
from torqva.service import SimulationService


def entry(token, user, role):
    return {"sha256": hashlib.sha256(token.encode()).hexdigest(), "user": user, "role": role}


@pytest.fixture
def client(tmp_path):
    svc = SimulationService(str(tmp_path / "store.db"))
    app = FastAPI()
    app.include_router(create_router(svc, TokenAuth([entry("viewer-token", "tester", Role.VIEWER)])))
    return TestClient(app)


def test_physical_evaluation_endpoint_returns_measured_provenance_and_schema(client):
    res = client.get("/api/torqva/evaluation/physical", headers={"Authorization": "Bearer viewer-token"})
    assert res.status_code == 200
    data = res.json()
    assert data["provenance"] == "MEASURED"
    assert "device_id" in data
    assert "speed" in data
    assert "electrical" in data
    assert "thermal" in data
    assert "vibration" in data
    assert "anomaly_detection" in data
    assert "verification" in data
    assert "signal_integrity" in data

    # Schema checks
    assert "tracking_error_pct" in data["speed"]
    assert "mean_current_a" in data["electrical"]
    assert "housing_c" in data["thermal"]
    assert "vibration_rms_g" in data["vibration"]
    assert "score" in data["anomaly_detection"]
    assert "threshold" in data["anomaly_detection"]
    assert "packet_delivery_rate_pct" in data["signal_integrity"]


def test_physical_evaluation_requires_viewer_auth(client):
    res = client.get("/api/torqva/evaluation/physical")
    assert res.status_code in (401, 403)
