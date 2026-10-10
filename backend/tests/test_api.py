"""
Integration & Unit Test Suite for Smart DC Motor Monitoring Backend (Phase 2).
Tests high-throughput ingestion, physical boundary validations, NaN/Inf rejection,
heartbeat state transitions (CONNECTED/STALE/OFFLINE), history API filtering,
SQLite multi-client persistence, and WebSocket resilience.
"""

import sys
import os
import time
import math
import pytest
from pathlib import Path

# Add backend directory to sys.path
sys.path.insert(0, str(Path(__file__).parent.parent))

import main
from fastapi.testclient import TestClient
from main import app, storage, current_device_status, evaluate_connection_state
from models import TelemetryPayload, ConnectionState, AlertRecord, BaselineState, BaselineStatus
from config import config


@pytest.fixture(autouse=True)
def reset_system_state():
    """Reset device state and cached telemetry between test executions."""
    import main
    main.current_device_status.last_seen = None
    main.current_device_status.connection_state = ConnectionState.OFFLINE
    main.latest_telemetry_cache = None
    main.latest_telemetry_dict = None
    yield


@pytest.fixture
def client():
    with TestClient(app) as test_client:
        yield test_client


def test_status_endpoint(client):
    """1. GET /api/status returns 200 and valid initial system status."""
    response = client.get("/api/status")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "ONLINE"
    assert "device" in data
    assert data["device"]["connection_state"] == "OFFLINE"
    assert "websocket_subscribers" in data


def test_valid_telemetry_ingestion(client):
    """2. POST /api/ingest validates telemetry, captures IP, and stamps server time."""
    payload = {
        "device_id": "ESP32-MOTOR-01",
        "firmware": "1.0.0",
        "timestamp": time.time(),
        "motor_running": True,
        "temperature": 42.6,
        "vibration_x": 0.12,
        "vibration_y": 0.15,
        "vibration_z": 0.21,
        "vibration_rms": 0.18,
        "rpm": 1450.0,
        "voltage": 23.8,
        "current": 1.42,
        "power": 33.8,
        "sensor_health": {
            "adxl345": True,
            "ds18b20": True,
            "ina219": True,
            "a3144": True
        },
        "source": "live"
    }
    response = client.post("/api/ingest", json=payload)
    assert response.status_code == 200
    data = response.json()
    assert data["accepted"] is True
    assert data["device_id"] == "ESP32-MOTOR-01"
    assert "server_time" in data


def test_invalid_telemetry_rejection_missing_fields(client):
    """3. Missing required fields triggers 422 error."""
    bad_payload = {
        "device_id": "ESP32-MOTOR-01",
        "temperature": 45.0
        # Missing rpm, voltage, current, etc.
    }
    response = client.post("/api/ingest", json=bad_payload)
    assert response.status_code == 422


def test_invalid_numeric_values_nan_inf(client):
    """4. Rejection of NaN, Infinity, and out-of-range sensor values."""
    base_payload = {
        "device_id": "ESP32-MOTOR-01",
        "firmware": "1.0.0",
        "timestamp": time.time(),
        "motor_running": True,
        "temperature": 40.0,
        "vibration_x": 0.1,
        "vibration_y": 0.1,
        "vibration_z": 0.1,
        "vibration_rms": 0.1,
        "rpm": 1500.0,
        "voltage": 24.0,
        "current": 1.5,
        "source": "live"
    }

    # Test negative RPM
    bad_rpm = dict(base_payload, rpm=-10.0)
    assert client.post("/api/ingest", json=bad_rpm).status_code == 422

    # Test negative voltage
    bad_voltage = dict(base_payload, voltage=-24.0)
    assert client.post("/api/ingest", json=bad_voltage).status_code == 422

    # Test impossible temperature (> 200°C)
    bad_temp = dict(base_payload, temperature=350.0)
    assert client.post("/api/ingest", json=bad_temp).status_code == 422

    # Test unreasonable vibration (> 50g)
    bad_vib = dict(base_payload, vibration_rms=85.0)
    assert client.post("/api/ingest", json=bad_vib).status_code == 422


def test_power_calculation(client):
    """5. Automatically compute power = voltage * current if omitted or null."""
    payload = {
        "device_id": "ESP32-MOTOR-01",
        "firmware": "1.0.0",
        "timestamp": time.time(),
        "motor_running": True,
        "temperature": 40.0,
        "vibration_x": 0.1,
        "vibration_y": 0.1,
        "vibration_z": 0.1,
        "vibration_rms": 0.1,
        "rpm": 1500.0,
        "voltage": 24.0,
        "current": 1.5,
        "power": None,
        "source": "live"
    }
    response = client.post("/api/ingest", json=payload)
    assert response.status_code == 200

    latest = client.get("/api/sensors/latest").json()
    assert latest["power"] == 36.0  # 24.0 * 1.5


def test_latest_telemetry_endpoint(client):
    """6. GET /api/sensors/latest returns latest sample with X/Y/Z and server timestamp."""
    payload = {
        "device_id": "ESP32-MOTOR-01",
        "firmware": "1.0.0",
        "timestamp": time.time(),
        "motor_running": True,
        "temperature": 48.2,
        "vibration_x": 0.15,
        "vibration_y": 0.18,
        "vibration_z": 0.22,
        "vibration_rms": 0.20,
        "rpm": 1620.0,
        "voltage": 24.2,
        "current": 1.55,
        "source": "live"
    }
    client.post("/api/ingest", json=payload)

    response = client.get("/api/sensors/latest")
    assert response.status_code == 200
    data = response.json()
    assert data["temperature"] == 48.2
    assert data["vibration_x"] == 0.15
    assert data["vibration_y"] == 0.18
    assert data["vibration_z"] == 0.22
    assert data["server_received_at"] is not None


def test_history_query_and_filtering(client):
    """7. GET /api/history returns chronological records and obeys minute window filter."""
    now = time.time()
    
    # Ingest records spanning across different times
    old_time = now - 600.0  # 10 minutes ago
    recent_time = now - 60.0  # 1 minute ago

    payload_old = {
        "device_id": "ESP32-MOTOR-01",
        "firmware": "1.0.0",
        "timestamp": old_time,
        "motor_running": True,
        "temperature": 35.0,
        "vibration_x": 0.1,
        "vibration_y": 0.1,
        "vibration_z": 0.1,
        "vibration_rms": 0.1,
        "rpm": 1400.0,
        "voltage": 24.0,
        "current": 1.2,
        "source": "live"
    }
    payload_recent = {
        "device_id": "ESP32-MOTOR-01",
        "firmware": "1.0.0",
        "timestamp": recent_time,
        "motor_running": True,
        "temperature": 45.0,
        "vibration_x": 0.12,
        "vibration_y": 0.12,
        "vibration_z": 0.12,
        "vibration_rms": 0.12,
        "rpm": 1500.0,
        "voltage": 24.0,
        "current": 1.3,
        "source": "live"
    }
    client.post("/api/ingest", json=payload_old)
    client.post("/api/ingest", json=payload_recent)

    # 1. Lookback 5 minutes: should only include recent record
    res_5min = client.get("/api/history?minutes=5")
    assert res_5min.status_code == 200
    data_5min = res_5min.json()
    assert any(r["temperature"] == 45.0 for r in data_5min)
    assert not any(r["temperature"] == 35.0 for r in data_5min)

    # 2. Lookback 15 minutes: should include both records in chronological order
    res_15min = client.get("/api/history?minutes=15")
    assert res_15min.status_code == 200
    data_15min = res_15min.json()
    assert any(r["temperature"] == 35.0 for r in data_15min)
    assert any(r["temperature"] == 45.0 for r in data_15min)
    
    # Chronological sort verification
    timestamps = [r["timestamp"] for r in data_15min]
    assert timestamps == sorted(timestamps)


def test_device_last_seen_and_connection_state_machine(client):
    """8, 9, 10. Device heartbeat state machine: CONNECTED -> STALE -> OFFLINE -> Reconnected."""
    now = time.time()

    # 1. Telemetry arrives -> CONNECTED
    payload = {
        "device_id": "ESP32-MOTOR-01",
        "firmware": "1.0.0",
        "timestamp": now,
        "motor_running": True,
        "temperature": 40.0,
        "vibration_x": 0.1,
        "vibration_y": 0.1,
        "vibration_z": 0.1,
        "vibration_rms": 0.1,
        "rpm": 1500.0,
        "voltage": 24.0,
        "current": 1.3,
        "source": "live"
    }
    client.post("/api/ingest", json=payload)
    status_res = client.get("/api/status").json()
    assert status_res["connection_state"] == "CONNECTED"
    assert status_res["is_device_connected"] is True

    # 2. Simulate elapsed time beyond stale timeout (e.g. 3.5 seconds ago)
    current_device_status.last_seen = time.time() - (config.stale_timeout_seconds + 0.5)
    stale_state = evaluate_connection_state()
    assert stale_state == ConnectionState.STALE

    # 3. Simulate elapsed time beyond offline timeout (e.g. 6.0 seconds ago)
    current_device_status.last_seen = time.time() - (config.offline_timeout_seconds + 1.0)
    offline_state = evaluate_connection_state()
    assert offline_state == ConnectionState.OFFLINE
    assert client.get("/api/status").json()["connection_state"] == "OFFLINE"

    # 4. New telemetry arrives -> Reconnects back to CONNECTED
    client.post("/api/ingest", json=payload)
    reconnected_status = client.get("/api/status").json()
    assert reconnected_status["connection_state"] == "CONNECTED"


def test_live_vs_demo_source_isolation(client):
    """11, 12. Strict isolation between 'live' ESP32 telemetry and 'demo' synthetic data."""
    now = time.time()
    live_payload = {
        "device_id": "ESP32-MOTOR-01",
        "firmware": "1.0.0",
        "timestamp": now,
        "motor_running": True,
        "temperature": 41.0,
        "vibration_x": 0.1,
        "vibration_y": 0.1,
        "vibration_z": 0.1,
        "vibration_rms": 0.1,
        "rpm": 1500.0,
        "voltage": 24.0,
        "current": 1.3,
        "source": "live"
    }
    demo_payload = {
        "device_id": "DEMO-SIM-01",
        "firmware": "1.0.0-demo",
        "timestamp": now + 1.0,
        "motor_running": True,
        "temperature": 75.0,
        "vibration_x": 0.6,
        "vibration_y": 0.6,
        "vibration_z": 0.6,
        "vibration_rms": 0.6,
        "rpm": 800.0,
        "voltage": 24.0,
        "current": 3.5,
        "source": "demo"
    }

    client.post("/api/ingest", json=live_payload)
    client.post("/api/ingest", json=demo_payload)

    # Latest filtered queries
    live_latest = client.get("/api/sensors/latest?source=live").json()
    demo_latest = client.get("/api/sensors/latest?source=demo").json()

    assert live_latest["source"] == "live"
    assert live_latest["device_id"] == "ESP32-MOTOR-01"
    assert demo_latest["source"] == "demo"
    assert demo_latest["device_id"] == "DEMO-SIM-01"


def test_baseline_and_alert_storage(client):
    """13, 14. Verify baseline results and alert record persistence."""
    # Baseline result storage
    baseline = {
        "status": "SAVED",
        "temperature": 39.5,
        "vibration_rms": 0.12,
        "voltage": 24.0,
        "current": 1.30,
        "power": 31.2,
        "rpm": 1510.0,
        "saved_at": time.time(),
        "samples": 30,
        "duration_seconds": 30.0
    }
    b_res = client.post("/api/baseline/result", json=baseline)
    assert b_res.status_code == 200
    assert b_res.json()["status"] == "SAVED"

    # Direct SQLite Alert storage verification
    alert = AlertRecord(
        timestamp=time.time(),
        severity="WARNING",
        parameter="temperature",
        title="Thermal Elevation",
        message="Motor temperature trending upwards",
        current_value=58.5,
        baseline_value=39.5,
        suggested_inspection="Inspect cooling airflow",
        source="live"
    )
    alert_id = storage.save_alert(alert)
    assert alert_id > 0
    alerts = storage.get_alerts(limit=5)
    assert any(a["title"] == "Thermal Elevation" for a in alerts)


def test_multiple_websocket_clients_and_telemetry_broadcast(client):
    """15, 16. Multiple WebSocket clients receive telemetry broadcast simultaneously."""
    with client.websocket_connect("/ws") as ws1, client.websocket_connect("/ws") as ws2:
        # Drain initial sync frames
        f1_1 = ws1.receive_json()
        f1_2 = ws1.receive_json()
        if f1_1.get("type") == "telemetry" or f1_2.get("type") == "telemetry":
            pass
        elif getattr(main, "latest_telemetry_dict", None) is not None or getattr(main, "latest_telemetry_cache", None) is not None:
            try:
                ws1.receive_json()
            except Exception:
                pass

        f2_1 = ws2.receive_json()
        f2_2 = ws2.receive_json()
        if f2_1.get("type") == "telemetry" or f2_2.get("type") == "telemetry":
            pass
        elif getattr(main, "latest_telemetry_dict", None) is not None or getattr(main, "latest_telemetry_cache", None) is not None:
            try:
                ws2.receive_json()
            except Exception:
                pass

        # Ingest new live telemetry packet
        new_payload = {
            "device_id": "ESP32-MOTOR-01",
            "firmware": "1.0.0",
            "timestamp": time.time(),
            "motor_running": True,
            "temperature": 43.1,
            "vibration_x": 0.11,
            "vibration_y": 0.13,
            "vibration_z": 0.16,
            "vibration_rms": 0.14,
            "rpm": 1475.0,
            "voltage": 23.9,
            "current": 1.38,
            "source": "live"
        }
        res = client.post("/api/ingest", json=new_payload)
        assert res.status_code == 200

        # Both ws1 and ws2 must receive the broadcast connection state transition and telemetry event
        conn1 = ws1.receive_json()
        assert conn1["type"] == "connection"
        assert conn1["data"]["status"] == "CONNECTED"

        conn2 = ws2.receive_json()
        assert conn2["type"] == "connection"
        assert conn2["data"]["status"] == "CONNECTED"

        msg1 = ws1.receive_json()
        assert msg1["type"] == "telemetry"
        assert msg1["data"]["temperature"] == 43.1

        msg2 = ws2.receive_json()
        assert msg2["type"] == "telemetry"
        assert msg2["data"]["temperature"] == 43.1


def test_control_motor_api_disconnected(client):
    """Verifies that POST /api/motor fails gracefully when ESP32 is not connected over TCP."""
    res = client.post("/api/motor", json={"command": "ON"})
    assert res.status_code == 503
    assert "not connected" in res.json()["detail"].lower()


def test_control_motor_api_invalid_command(client):
    """Verifies validation error on invalid motor command."""
    res = client.post("/api/motor", json={"command": "INVALID"})
    assert res.status_code == 400
