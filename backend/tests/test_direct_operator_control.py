"""Authenticated operator control via validated OperatingConfigManager; no unauthenticated bypass."""
import hashlib

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from torqva.api.routes import create_router
from torqva.access.auth import TokenAuth
from torqva.service import SimulationService


def test_direct_mode_enabled_with_zero_blockers(tmp_path, monkeypatch):
    from torqva.safety.device_config import OperatingConfigManager
    monkeypatch.setenv("TORQVA_DEVICE_CONFIG_FILE", str(tmp_path / "device_config.json"))
    svc = SimulationService()
    bridge = svc.bridge
    assert bridge.direct_mode is True
    assert bridge.universal_mode is True
    bridge.direct_mode = True
    bridge.universal_mode = True
    cfg = OperatingConfigManager(str(tmp_path / "device_config.json"), auto_init=True)
    bridge.commissioning = cfg
    assert cfg.physical_control_enabled() is True
    assert bridge.policy.max_duty_pct == 70.0
    assert bridge.policy.max_rpm == 3000.0

    token = "admin-token"
    auth = TokenAuth([{"sha256": hashlib.sha256(token.encode()).hexdigest(), "user": "admin", "role": "admin"}])
    app = FastAPI()
    app.include_router(create_router(svc, auth))
    client = TestClient(app)
    headers = {"Authorization": f"Bearer {token}"}

    snap = client.get("/api/torqva/device/status", headers=headers).json()
    assert snap["connection"] == "DISCONNECTED"
    assert snap["control_blockers"] == []
    rec = client.post("/api/torqva/device/commands", headers=headers, json={"action": "START", "duty_pct": 25}).json()
    assert rec["state"] == "REJECTED"
    assert rec["reasons"] == ["DEVICE NOT CONNECTED"]
