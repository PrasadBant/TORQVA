"""Integration and unit tests for Phase 1-4 wireless OTA workspace, Docker compiler, discovery,
operating configuration manager, manual rollback, and authenticated system/Wi-Fi commands.
"""
import hashlib
import io
import json
import zipfile
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from torqva.api import create_router
from torqva.auth import TokenAuth
from torqva.compiler import (
    CompilerError,
    FirmwareCompiler,
    _extract_memory_usage,
    _parse_diagnostics,
    _safe_rel_path,
)
from torqva.device_config import OperatingConfigManager, validate_operating_limits
from torqva.discovery import DeviceDiscoveryManager, _build_ptr_query, _parse_mdns_response
from torqva.firmware import FirmwareManager
from torqva.schemas import Role
from torqva.serial_bridge import Conn, DeviceBridge, MemoryTransport
from torqva.service import SimulationService

from test_torqva_firmware import esp_image, keys as _keys_fixture, ota_info, sign
from test_torqva_p16_serial import status, wait

keys = _keys_fixture

TOKENS = {"a": "admin", "o": "operator", "v": "viewer"}
H = lambda tok: {"Authorization": f"Bearer {tok}"}


@pytest.fixture
def client_and_svc(tmp_path, monkeypatch):
    monkeypatch.setenv("TORQVA_DEVICE_CONFIG_FILE", str(tmp_path / "device_config.json"))
    monkeypatch.setenv("TORQVA_FIRMWARE_DIR", str(tmp_path / "fw"))
    svc = SimulationService(store=str(tmp_path / "torqva.db"))
    svc.bridge.commissioning = OperatingConfigManager(str(tmp_path / "device_config.json"), auto_init=True)
    svc.firmware = FirmwareManager(svc.bridge, root=str(tmp_path / "fw"))
    svc.compiler = FirmwareCompiler(svc.firmware, work_root=str(tmp_path / "jobs"), auto_run=False)
    auth = TokenAuth([{"sha256": hashlib.sha256(t.encode()).hexdigest(), "user": f"{r}-u", "role": r} for t, r in TOKENS.items()])
    app = FastAPI()
    app.include_router(create_router(svc, auth))
    return TestClient(app), svc


def test_operating_config_auto_loads_and_syncs_with_limits_manager(client_and_svc):
    c, svc = client_and_svc
    cfg = svc.bridge.commissioning
    assert cfg.physical_control_enabled() is True
    assert cfg.limits["version"] == 1
    assert cfg.limits["max_rpm"] == 3000.0

    # Updating via /limits validates against hardware ceilings and bumps config version
    r = c.put("/api/torqva/limits", headers=H("o"), json={"key": "rpm", "value": 2400.0, "enabled": True})
    assert r.status_code == 200
    assert cfg.limits["max_rpm"] == 2400.0
    assert cfg.limits["version"] == 2

    # Invalid extreme value rejected cleanly
    with pytest.raises(ValueError):
        validate_operating_limits({**cfg.limits, "max_current_a": 99.0})


def test_compiler_workspace_security_and_zip_validation(tmp_path):
    fm = FirmwareManager(None, root=str(tmp_path / "fw"))
    comp = FirmwareCompiler(fm, work_root=str(tmp_path / "jobs"), auto_run=False)

    # Path traversal blocked
    with pytest.raises(CompilerError) as exc:
        _safe_rel_path("../../etc/passwd")
    assert exc.value.code == "BAD_PATH"

    # Zip-slip blocked
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("../../evil.cpp", "void setup(){}")
    with pytest.raises(CompilerError):
        comp.start_compile(user="admin", profile="esp32s3_wireless", single_filename="bad.zip", single_bytes=buf.getvalue())

    # Valid .ino creates isolated workspace with no private key inside
    job = comp.start_compile(
        user="admin",
        version="1.2.0",
        profile="esp32s3_wireless",
        files={"src/blink.ino": "void setup() {}\nvoid loop() { delay(50); }\n"},
    )
    assert job["state"] == "QUEUED"
    assert job["version"] == "1.2.0"
    job_dir = Path(tmp_path / "jobs" / job["id"])
    assert (job_dir / "src" / "user_sketch.cpp").exists()
    assert not any("PRIVATE" in p.read_text(errors="ignore") for p in job_dir.rglob("*.h"))


def test_compiler_diagnostic_and_memory_parsers():
    logs = [
        "/workspace/src/main.cpp:42:13: error: 'foo' was not declared in this scope",
        "RAM:   [==        ]  17.4% (used 57048 bytes from 327680 bytes)",
        "Flash: [===       ]  30.6% (used 1021553 bytes from 3342336 bytes)",
    ]
    diags = _parse_diagnostics(logs)
    assert len(diags) == 1
    assert diags[0]["file"] == "src/main.cpp"
    assert diags[0]["line"] == 42
    assert diags[0]["severity"] == "error"
    mem = _extract_memory_usage("\n".join(logs))
    assert mem["ram_pct"] == 17.4
    assert mem["flash_used_bytes"] == 1021553


def test_wireless_logs_discovery_wifi_and_restart_endpoints(client_and_svc):
    c, svc = client_and_svc
    b = svc.bridge
    tr = MemoryTransport()
    b.connect(tr)
    try:
        tr.feed(json.dumps({**json.loads(status(1, dev="RIG-1")), "fw": "1.1.2"}))
        tr.feed(json.dumps({"t": "log", "seq": 2, "ts": 150, "lvl": "INFO", "msg": "Wi-Fi TLS link connected"}))
        tr.feed(json.dumps({"t": "net_info", "seq": 3, "ts": 200, "ip": "192.168.1.44", "ssid": "LabWiFi", "rssi": -54, "mac": "AA:BB:CC:DD:EE:FF", "heap": 184320, "up_s": 12}))

        assert wait(lambda: b.model.conn == Conn.CONNECTED and len(b.serial_logs) >= 1 and b.device_net_info is not None), b.model.last_error

        logs_res = c.get("/api/torqva/device/logs?search=TLS", headers=H("v"))
        assert logs_res.status_code == 200
        assert len(logs_res.json()["logs"]) == 1
        assert logs_res.json()["logs"][0]["msg"] == "Wi-Fi TLS link connected"

        dl = c.get("/api/torqva/device/logs/download?format=txt", headers=H("v"))
        assert dl.status_code == 200 and "Wi-Fi TLS link connected" in dl.text

        wifi_res = c.get("/api/torqva/device/wifi", headers=H("v"))
        assert wifi_res.status_code == 200
        assert wifi_res.json()["net_info"]["ip"] == "192.168.1.44"

        # Active authenticated session allows HMAC-signed restart and Wi-Fi update
        with b._lock:
            b._auth = {
                "state": "active",
                "sid": "0123456789abcdef",
                "sk": b"k" * 32,
                "expires": b._clock() + 300,
                "restarts": b.model.counters["restarts"],
                "dev": "RIG-1",
            }
        assert c.post("/api/torqva/device/wifi", headers=H("o"), json={"ssid": "X", "password": "Y"}).status_code == 403
        w_upd = c.post("/api/torqva/device/wifi", headers=H("a"), json={"ssid": "NewNet", "password": "secret", "base_url": "https://192.168.1.10:8443"})
        assert w_upd.status_code == 200, w_upd.text
        rst = c.post("/api/torqva/device/restart", headers=H("a"))
        assert rst.status_code == 200, rst.text
        written = [json.loads(x) for x in tr.written]
        assert any(w.get("t") == "wifi_cfg" and w.get("ssid") == "NewNet" and len(w.get("m", "")) == 32 for w in written)
        assert any(w.get("t") == "sys" and w.get("cmd") == "restart" and len(w.get("m", "")) == 32 for w in written)
    finally:
        b.disconnect()


def test_firmware_rollback_http_range_and_deployment_persistence(client_and_svc, tmp_path, keys, monkeypatch):
    monkeypatch.setenv("TORQVA_FW_PUBKEY", keys["pub"])
    monkeypatch.setenv("TORQVA_OTA_PUBLIC_BASE_URL", "https://192.168.1.10:8443")
    c, svc = client_and_svc
    # Reload FirmwareManager with test key and public HTTPS base URL pointing to the same bridge
    from torqva.firmware import FirmwareManager
    svc.firmware = FirmwareManager(svc.bridge, root=str(tmp_path / "fw_store"), public_key=keys["pub"], base_url="https://192.168.1.10:8443")
    auth = TokenAuth([{"sha256": hashlib.sha256(t.encode()).hexdigest(), "user": f"{r}-u", "role": r} for t, r in TOKENS.items()])
    app = FastAPI()
    app.include_router(create_router(svc, auth))
    c = TestClient(app)

    b = svc.bridge
    tr = MemoryTransport()
    b.connect(tr)
    try:
        tr.feed(json.dumps({**json.loads(status(1, dev="RIG-1")), "fw": "1.1.3"}))
        tr.feed(ota_info(seq=2))
        assert wait(lambda: b.model.conn == Conn.CONNECTED and b.ota_info is not None), b.model.last_error
        with b._lock:
            b._auth = {
                "state": "active",
                "sid": "0123456789abcdef",
                "sk": b"k" * 32,
                "expires": b._clock() + 300,
                "restarts": b.model.counters["restarts"],
                "dev": "RIG-1",
            }

        bin_v1 = esp_image(ver="1.1.2")
        bin_v2 = esp_image(ver="1.1.3")
        r1 = c.post(
            "/api/torqva/firmware/releases",
            headers=H("a"),
            files={"file": ("fw1.bin", bin_v1, "application/octet-stream")},
            data={"version": "1.1.2", "signature": sign(keys["good"], bin_v1), "notes": "baseline"},
        )
        assert r1.status_code == 200, r1.text
        rel1 = r1.json()["id"]

        r2 = c.post(
            "/api/torqva/firmware/releases",
            headers=H("a"),
            files={"file": ("fw2.bin", bin_v2, "application/octet-stream")},
            data={"version": "1.1.3", "signature": sign(keys["good"], bin_v2), "notes": "newer"},
        )
        assert r2.status_code == 200, r2.text

        # Manual rollback to 1.1.2 sends rb=1 OTA command and persists deployment state
        rb = c.post("/api/torqva/firmware/rollback", headers=H("a"), json={"release_id": rel1, "device_id": "RIG-1"})
        assert rb.status_code == 200, rb.text
        dep = rb.json()
        assert dep["release"] == rel1
        assert dep["rollback"] is True
        tok = svc.firmware.deployments[dep["id"]]["token"]
        written = [json.loads(x) for x in tr.written]
        assert any(w.get("t") == "ota" and w.get("rel") == rel1 and w.get("rb") == 1 for w in written)

        # HTTP Range partial download works for resumed OTA transfers
        partial = c.get(f"/api/torqva/firmware/ota/{rel1}/image?t={tok}", headers={"Range": "bytes=0-63"})
        assert partial.status_code == 206, partial.text
        assert len(partial.content) == 64
        assert partial.headers["content-range"].startswith("bytes 0-63/")

        # Deployment history persists across FirmwareManager reload
        fm_reloaded = FirmwareManager(None, root=str(tmp_path / "fw_store"), public_key=keys["pub"], base_url="https://192.168.1.10:8443")
        assert fm_reloaded.current() is not None
        assert fm_reloaded.current()["release"] == rel1
    finally:
        b.disconnect()


def test_mdns_query_builder_and_discovery_no_fake_devices():
    pkt = _build_ptr_query("_torqva._tcp.local")
    assert b"_torqva" in pkt and b"_tcp" in pkt
    assert _parse_mdns_response(b"\x00\x00", "192.168.1.2") is None
    dm = DeviceDiscoveryManager()
    res = dm.discover(bridge=None, timeout_s=0.2)
    assert res["mdns_service"] == "_torqva._tcp.local"
    assert isinstance(res["devices"], list)


def test_unified_provision_wireless_builds_nvs_tls_and_signing_keys(tmp_path):
    import importlib.util
    import subprocess
    import sys

    tool_path = Path(__file__).resolve().parents[1] / "tools" / "provision_wireless.py"
    spec = importlib.util.spec_from_file_location("provision_wireless", str(tool_path))
    pw_mod = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(pw_mod)

    sec_dir = tmp_path / "private_secrets"
    tls = pw_mod.ensure_tls_certs(sec_dir, "192.168.1.50")
    assert tls["ca"].exists() and tls["cert"].exists() and tls["key"].exists()
    sig = pw_mod.ensure_signing_keys(sec_dir, export_header=False)
    assert sig["pub"].exists() and sig["priv"].exists() and len(sig["fingerprint"]) == 16

    nvs_out = tmp_path / "nvs.bin"
    keys_file = tmp_path / "device_keys.json"
    pw_mod.build_nvs_image(
        device_id="RIG-1",
        ssid="TestBenchNet",
        password="bench-password-123",
        base_url="https://192.168.1.50:8443",
        ca_pem_path=tls["ca"],
        keys_file=keys_file,
        out_bin=nvs_out,
    )
    assert nvs_out.exists() and nvs_out.stat().st_size == 0x5000
    assert keys_file.exists()

    # Refuses --flash without --motor-power-disconnected
    rc = subprocess.run(
        [sys.executable, str(tool_path), "--secrets-dir", str(sec_dir), "--ip", "192.168.1.50", "--flash"],
        capture_output=True,
        text=True,
    )
    assert rc.returncode == 2 and "motor-power-disconnected" in (rc.stderr + rc.stdout)
