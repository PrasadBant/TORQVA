"""Legacy direct-control settings cannot bypass device identity or authentication."""
import hashlib

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from torqva.api import create_router
from torqva.auth import TokenAuth
from torqva.service import SimulationService


def test_direct_mode_cannot_be_enabled_or_used_for_motion(monkeypatch):
    monkeypatch.setenv("TORQVA_DIRECT_MODE", "1")
    monkeypatch.setenv("TORQVA_REMOVE_BLOCKERS", "1")
    svc = SimulationService()
    bridge = svc.bridge
    assert bridge.direct_mode is False
    assert bridge.universal_mode is False
    with pytest.raises(ValueError):
        bridge.direct_mode = True
    with pytest.raises(ValueError):
        bridge.universal_mode = True

    token = "admin-token"
    auth = TokenAuth([{"sha256": hashlib.sha256(token.encode()).hexdigest(), "user": "admin", "role": "admin"}])
    app = FastAPI()
    app.include_router(create_router(svc, auth))
    client = TestClient(app)
    headers = {"Authorization": f"Bearer {token}"}

    assert client.post("/api/torqva/device/direct_mode", headers=headers, json={"enabled": True}).status_code == 404
    snap = client.get("/api/torqva/device/status", headers=headers).json()
    assert snap["connection"] == "DISCONNECTED"
    assert snap["session"]["active"] is False
    rec = client.post("/api/torqva/device/commands", headers=headers, json={"action": "START", "duty_pct": 25}).json()
    assert rec["state"] == "REJECTED"
    assert rec["reasons"]
