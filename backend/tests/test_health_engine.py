"""
Unit & Integration Test Suite for Phase 5 Baseline-Relative Health Engine.
Covers deterministic deviation calculations, multi-parameter thresholds,
sensor health isolation, motor running state awareness, alert deduplication,
and REST/WebSocket delivery.
"""

import sys
import time
import math
import pytest
from pathlib import Path

# Add backend directory to sys.path
sys.path.insert(0, str(Path(__file__).parent.parent))

from fastapi.testclient import TestClient
from main import app, storage, current_device_status, evaluate_connection_state
from models import (
    TelemetryPayload,
    BaselineState,
    BaselineStatus,
    HealthStatus,
    AlertSeverity,
    AnomalyType,
    SensorHealthModel,
    AlertRecord,
)
from config import config
from health_engine import health_engine, RuleBasedHealthEngine


@pytest.fixture
def sample_baseline():
    return BaselineState(
        status=BaselineStatus.SAVED,
        temperature=40.0,
        vibration_rms=0.20,
        rpm=1500.0,
        voltage=24.0,
        current=1.50,
        power=36.0,
        saved_at=time.time() - 3600.0,
        samples=30,
        duration_seconds=30.0
    )


@pytest.fixture
def nominal_telemetry():
    return TelemetryPayload(
        device_id="ESP32-MOTOR-01",
        firmware="1.0.0",
        timestamp=time.time(),
        motor_running=True,
        temperature=40.5,
        vibration_x=0.12,
        vibration_y=0.14,
        vibration_z=0.18,
        vibration_rms=0.205,
        rpm=1505.0,
        voltage=24.0,
        current=1.52,
        power=36.48,
        sensor_health=SensorHealthModel(adxl345=True, ds18b20=True, ina219=True, a3144=True),
        source="live"
    )


@pytest.fixture
def client():
    with TestClient(app) as test_client:
        yield test_client


# ==========================================
# 17 REQUIRED HEALTH ENGINE TEST CASES
# ==========================================

def test_1_no_baseline(nominal_telemetry):
    """1. No baseline returns BASELINE_REQUIRED and does not produce false anomalies."""
    res = health_engine.evaluate(
        telemetry=nominal_telemetry,
        baseline=None,
        is_connected=True,
        config=config
    )
    assert res.status == HealthStatus.BASELINE_REQUIRED
    assert res.score == 100.0
    assert len(res.anomalies) == 0
    assert "Baseline calibration is required" in res.diagnostic_explanation


def test_2_valid_baseline_normal_telemetry(nominal_telemetry, sample_baseline):
    """2. Valid baseline + nominal telemetry produces 100 score and HEALTHY status."""
    res = health_engine.evaluate(
        telemetry=nominal_telemetry,
        baseline=sample_baseline,
        is_connected=True,
        config=config
    )
    assert res.status == HealthStatus.HEALTHY
    assert res.score >= 95.0
    assert len(res.anomalies) == 0
    assert len(res.alerts) == 0
    assert "baseline" in res.diagnostic_explanation.lower()


def test_3_temperature_above_warning_threshold(nominal_telemetry, sample_baseline):
    """3. Temperature rising 20% above baseline triggers WARNING anomaly."""
    # Baseline is 40°C, 48°C is +20.0% (warning threshold is 15%)
    telemetry = nominal_telemetry.model_copy(update={"temperature": 48.0})
    res = health_engine.evaluate(telemetry=telemetry, baseline=sample_baseline, is_connected=True, config=config)

    assert res.status == HealthStatus.WARNING
    assert res.factors["temperature"] == 60.0
    assert any(a.sensor == "temperature" and a.severity == AlertSeverity.WARNING for a in res.anomalies)
    assert any("above baseline" in a.message for a in res.anomalies)


def test_4_temperature_above_critical_threshold(nominal_telemetry, sample_baseline):
    """4. Temperature rising 40% above baseline triggers CRITICAL anomaly."""
    # Baseline is 40°C, 56°C is +40.0% (critical threshold is 35%)
    telemetry = nominal_telemetry.model_copy(update={"temperature": 56.0})
    res = health_engine.evaluate(telemetry=telemetry, baseline=sample_baseline, is_connected=True, config=config)

    assert res.status == HealthStatus.CRITICAL
    assert res.factors["temperature"] == 20.0
    assert any(a.sensor == "temperature" and a.severity == AlertSeverity.CRITICAL for a in res.anomalies)


def test_5_vibration_above_warning_threshold(nominal_telemetry, sample_baseline):
    """5. Vibration RMS rising 35% above baseline triggers WARNING anomaly."""
    # Baseline is 0.20g, 0.27g is +35.0% (warning threshold is 25%)
    telemetry = nominal_telemetry.model_copy(update={"vibration_rms": 0.27})
    res = health_engine.evaluate(telemetry=telemetry, baseline=sample_baseline, is_connected=True, config=config)

    assert res.status == HealthStatus.WARNING
    assert res.factors["vibration"] == 60.0
    assert any(a.sensor == "vibration_rms" and a.severity == AlertSeverity.WARNING for a in res.anomalies)


def test_6_vibration_above_critical_threshold(nominal_telemetry, sample_baseline):
    """6. Vibration RMS rising 75% above baseline triggers CRITICAL anomaly."""
    # Baseline is 0.20g, 0.35g is +75.0% (critical threshold is 60%)
    telemetry = nominal_telemetry.model_copy(update={"vibration_rms": 0.35})
    res = health_engine.evaluate(telemetry=telemetry, baseline=sample_baseline, is_connected=True, config=config)

    assert res.status == HealthStatus.CRITICAL
    assert res.factors["vibration"] == 20.0
    assert any(a.sensor == "vibration_rms" and a.severity == AlertSeverity.CRITICAL for a in res.anomalies)


def test_7_multiple_simultaneous_anomalies(nominal_telemetry, sample_baseline):
    """7. Multiple anomalies compound factor penalties deterministically."""
    # High vibration (+75%) + High current (+40%)
    telemetry = nominal_telemetry.model_copy(update={
        "vibration_rms": 0.35,
        "current": 2.10,
        "power": 50.4
    })
    res = health_engine.evaluate(telemetry=telemetry, baseline=sample_baseline, is_connected=True, config=config)

    assert res.status == HealthStatus.CRITICAL
    assert res.factors["vibration"] == 20.0
    assert res.factors["current"] == 60.0
    assert len(res.anomalies) >= 2
    assert res.score < 70.0


def test_8_sensor_unavailable_isolation(nominal_telemetry, sample_baseline):
    """8. Unavailable sensor is excluded from scoring and does not generate false alerts."""
    telemetry = nominal_telemetry.model_copy(update={
        "vibration_rms": 0.0,
        "sensor_health": SensorHealthModel(adxl345=False, ds18b20=True, ina219=True, a3144=True)
    })
    res = health_engine.evaluate(telemetry=telemetry, baseline=sample_baseline, is_connected=True, config=config)

    assert "adxl345" in res.unavailable_sensors
    assert "vibration_rms" not in res.evaluated_sensors
    # Should not generate a false vibration anomaly for 0.0 reading
    assert not any(a.sensor == "vibration_rms" for a in res.anomalies)
    assert res.status == HealthStatus.HEALTHY


def test_9_nan_inf_safety_and_rejection():
    """9. NaN/Inf inputs are strictly rejected at Pydantic boundary."""
    with pytest.raises(ValueError):
        TelemetryPayload(
            device_id="ESP32-MOTOR-01",
            timestamp=time.time(),
            motor_running=True,
            temperature=float("nan"),
            vibration_x=0.1,
            vibration_y=0.1,
            vibration_z=0.1,
            vibration_rms=0.1,
            rpm=1500.0,
            voltage=24.0,
            current=1.5
        )


def test_10_motor_stopped_behavior(nominal_telemetry, sample_baseline):
    """10. Motor stationary returns 100 score and no false speed/current anomalies."""
    telemetry = nominal_telemetry.model_copy(update={
        "motor_running": False,
        "rpm": 0.0,
        "current": 0.05,
        "power": 1.2
    })
    res = health_engine.evaluate(telemetry=telemetry, baseline=sample_baseline, is_connected=True, config=config)

    assert res.status == HealthStatus.HEALTHY
    assert res.score == 100.0
    assert len(res.anomalies) == 0
    assert "stationary" in res.diagnostic_explanation


def test_11_rpm_anomaly_while_motor_running(nominal_telemetry, sample_baseline):
    """11. RPM dropping 20% below baseline while running triggers WARNING anomaly."""
    # Baseline is 1500 RPM, 1200 RPM is -20.0% (warning threshold is 15%)
    telemetry = nominal_telemetry.model_copy(update={"rpm": 1200.0})
    res = health_engine.evaluate(telemetry=telemetry, baseline=sample_baseline, is_connected=True, config=config)

    assert res.status == HealthStatus.WARNING
    assert any(a.sensor == "rpm" and a.type == AnomalyType.BELOW_BASELINE for a in res.anomalies)
    assert any("below baseline" in a.message for a in res.anomalies)


def test_12_rpm_ignored_while_motor_stopped(nominal_telemetry, sample_baseline):
    """12. RPM = 0 while motor stopped does NOT trigger an anomaly."""
    telemetry = nominal_telemetry.model_copy(update={
        "motor_running": False,
        "rpm": 0.0
    })
    res = health_engine.evaluate(telemetry=telemetry, baseline=sample_baseline, is_connected=True, config=config)

    assert not any(a.sensor == "rpm" for a in res.anomalies)
    assert res.status == HealthStatus.HEALTHY


def test_13_health_score_clamping(nominal_telemetry, sample_baseline):
    """13. Health score is strictly bounded between 0.0 and 100.0."""
    # Extreme conditions on all metrics
    telemetry = nominal_telemetry.model_copy(update={
        "temperature": 180.0,
        "vibration_rms": 45.0,
        "current": 40.0,
        "power": 960.0,
        "rpm": 300.0
    })
    res = health_engine.evaluate(telemetry=telemetry, baseline=sample_baseline, is_connected=True, config=config)

    assert 0.0 <= res.score <= 100.0
    assert res.status == HealthStatus.CRITICAL


def test_14_alert_deduplication():
    """14. Consecutive alert occurrences update existing active alert rather than duplicating rows."""
    alert1 = AlertRecord(
        timestamp=time.time(),
        severity="WARNING",
        parameter="vibration",
        title="Elevated Vibration",
        message="Vibration is 30% above baseline",
        current_value=0.26,
        baseline_value=0.20,
        suggested_inspection="Check mounting",
        source="live",
        status="ACTIVE"
    )
    id1 = storage.save_alert_with_deduplication(alert1)

    # Second occurrence 1 second later
    alert2 = AlertRecord(
        timestamp=time.time() + 1.0,
        severity="WARNING",
        parameter="vibration",
        title="Elevated Vibration",
        message="Vibration is 31% above baseline",
        current_value=0.262,
        baseline_value=0.20,
        suggested_inspection="Check mounting",
        source="live",
        status="ACTIVE"
    )
    id2 = storage.save_alert_with_deduplication(alert2)

    assert id1 == id2  # Deduplicated to same row


def test_15_alert_resolution():
    """15. Cleared anomalies mark previously active alerts as RESOLVED."""
    alert = AlertRecord(
        timestamp=time.time(),
        severity="WARNING",
        parameter="temperature",
        title="Elevated Temperature",
        message="Temperature high",
        current_value=48.0,
        baseline_value=40.0,
        suggested_inspection="Check cooling",
        source="live",
        status="ACTIVE"
    )
    storage.save_alert_with_deduplication(alert)

    # Anomaly on temperature cleared (active_parameters = [])
    resolved_count = storage.resolve_cleared_alerts(active_parameters=[], resolved_at=time.time(), source="live")
    assert resolved_count >= 1

    active_alerts = storage.get_alerts(active_only=True, source="live")
    assert not any(a["parameter"] == "temperature" for a in active_alerts)


def test_16_health_rest_endpoint(client, sample_baseline):
    """16. GET /api/health returns structured HealthResult with factors, explanations, and anomalies."""
    import main
    main.current_baseline_state = sample_baseline
    main.current_device_status.connection_state = "CONNECTED"
    main.current_device_status.last_seen = time.time()
    
    # Ingest a sample with slight vibration elevation
    payload = {
        "device_id": "ESP32-MOTOR-01",
        "firmware": "1.0.0",
        "timestamp": time.time(),
        "motor_running": True,
        "temperature": 41.0,
        "vibration_x": 0.15,
        "vibration_y": 0.15,
        "vibration_z": 0.18,
        "vibration_rms": 0.27,  # +35% above 0.20g
        "rpm": 1500.0,
        "voltage": 24.0,
        "current": 1.5,
        "source": "live"
    }
    client.post("/api/ingest", json=payload)

    res = client.get("/api/health")
    assert res.status_code == 200
    data = res.json()
    assert "score" in data
    assert "status" in data
    assert "factors" in data
    assert "anomalies" in data
    assert "explanations" in data
    assert "evaluated_sensors" in data
    assert data["status"] == "WARNING"


def test_17_websocket_health_event_broadcast(client, sample_baseline):
    """17. Ingestion evaluates health and broadcasts HealthResult over WebSocket."""
    import main
    main.current_baseline_state = sample_baseline

    with client.websocket_connect("/ws") as ws:
        # Drain initial sync frames
        ws.receive_json()  # connection
        ws.receive_json()  # baseline

        payload = {
            "device_id": "ESP32-MOTOR-01",
            "firmware": "1.0.0",
            "timestamp": time.time(),
            "motor_running": True,
            "temperature": 40.0,
            "vibration_x": 0.1,
            "vibration_y": 0.1,
            "vibration_z": 0.1,
            "vibration_rms": 0.20,
            "rpm": 1500.0,
            "voltage": 24.0,
            "current": 1.5,
            "source": "live"
        }
        res = client.post("/api/ingest", json=payload)
        assert res.status_code == 200

        # Receive connection transition, telemetry, and health frames
        ws.receive_json()  # connection
        telemetry_frame = ws.receive_json()
        assert telemetry_frame["type"] == "telemetry"

        health_frame = ws.receive_json()
        assert health_frame["type"] == "health"
        assert health_frame["data"]["score"] == 100.0
        assert health_frame["data"]["status"] == "HEALTHY"
