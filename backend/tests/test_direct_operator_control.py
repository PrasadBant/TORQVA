"""Authenticated operator control via validated OperatingConfigManager; no unauthenticated bypass."""
import hashlib

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from torqva.api import create_router
from torqva.auth import TokenAuth
from torqva.service import SimulationService


def test_direct_mode_bypass_disabled_and_operating_config_loaded(tmp_path, monkeypatch):
    from torqva.device_config import OperatingConfigManager
    monkeypatch.setenv("TORQVA_DEVICE_CONFIG_FILE", str(tmp_path / "device_config.json"))
    svc = SimulationService()
    bridge = svc.bridge
    assert bridge.direct_mode is False
    assert bridge.universal_mode is False
    with pytest.raises(ValueError):
        bridge.direct_mode = True
    with pytest.raises(ValueError):
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
    assert "DEVICE NOT CONNECTED" in snap["control_blockers"]
    assert "PHYSICAL CONTROL DISABLED" not in snap["control_blockers"]
    rec = client.post("/api/torqva/device/commands", headers=headers, json={"action": "START", "duty_pct": 25}).json()
    assert rec["state"] == "REJECTED"
    assert rec["reasons"]
