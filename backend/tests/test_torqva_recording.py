import hashlib
import io
import json
import zipfile
from pathlib import Path
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from torqva.api.routes import create_router
from torqva.access.auth import TokenAuth
from torqva.telemetry.recording import SessionRecorder, READINGS_HEADER, EVENTS_HEADER
from torqva.models.schemas import Role
from torqva.service import SimulationService


@pytest.fixture
def temp_recorder(tmp_path):
    rec = SessionRecorder(base_dir=tmp_path / "sessions")
    return rec


def test_session_lifecycle_and_csv_formatting(temp_recorder, tmp_path):
    # Start session
    sid = temp_recorder.start_session("PHYSICAL", config={"max_rpm": 3000}, trigger="test")
    assert temp_recorder.is_active()
    assert sid.endswith("_physical")

    # Record normal reading
    temp_recorder.record_reading({
        "t": 1.0,
        "rpm": 1500.5,
        "rpm_valid": True,
        "current": 1.25,
        "current_valid": True,
        "voltage": 24.1,
        "voltage_valid": True,
        "power": 30.125,
        "housing": 45.2,
        "duty": 50.0,
    })

    # Record reading with invalid / missing values (must be blank, never 0)
    temp_recorder.record_reading({
        "t": 2.0,
        "rpm": None,
        "rpm_valid": False,
        "current": 1.5,
        "current_valid": True,
        "voltage": 24.0,
        "voltage_valid": True,
        "power": None,
        "housing": None,
        "housing_valid": False,
        "duty": 50.0,
    })

    # Record event
    temp_recorder.record_event("TEST_EVENT", "WARN", "Warning detail test")

    # Stop session
    meta = temp_recorder.stop_session()
    assert not temp_recorder.is_active()
    assert meta["sample_count"] == 2
    assert meta["event_count"] >= 2  # start, test_event, stop
    assert "checksums" in meta
    assert len(meta["checksums"]["readings_sha256"]) == 64
    assert len(meta["checksums"]["events_sha256"]) == 64

    # Verify readings.csv file content
    session_dir = temp_recorder.base_dir / sid
    readings_file = session_dir / "readings.csv"
    assert readings_file.is_file()
    lines = readings_file.read_text(encoding="utf-8").strip().splitlines()
    assert lines[0] == ",".join(READINGS_HEADER)
    # Row 1: valid rpm
    row1 = lines[1].split(",")
    assert row1[0] == "1.000"
    assert row1[1] == "1500.5"
    assert row1[2] == "1"
    # Row 2: invalid rpm must be empty string, not "0"
    row2 = lines[2].split(",")
    assert row2[0] == "2.000"
    assert row2[1] == ""
    assert row2[2] == "0"

    # Verify session summary
    summary = temp_recorder.get_session_summary(sid)
    assert summary["session_id"] == sid
    assert summary["peak_rpm"] == 1500.5
    assert summary["peak_current_a"] == 1.5
    assert summary["max_temp_c"] == 45.2
    assert summary["sample_count"] == 2
    assert 0 <= summary["data_quality_pct"] <= 100


def test_auto_start_on_drive_command(temp_recorder):
    assert not temp_recorder.is_active()

    # Zero duty should not auto-start
    temp_recorder.notify_drive_command("PHYSICAL", "START", {"duty_pct": 0})
    assert not temp_recorder.is_active()

    # Non-zero duty triggers auto-start
    temp_recorder.notify_drive_command("PHYSICAL", "START", {"duty_pct": 25})
    assert temp_recorder.is_active()
    sid = temp_recorder.active_session_id
    assert sid.endswith("_physical")

    temp_recorder.stop_session()
    assert not temp_recorder.is_active()


def test_zip_export(temp_recorder):
    sid = temp_recorder.start_session("SIMULATION")
    temp_recorder.record_reading({"t": 0.5, "rpm": 1200, "current": 1.0, "voltage": 24.0, "duty": 40})
    temp_recorder.stop_session()

    zip_bytes = temp_recorder.export_session_zip(sid)
    assert zip_bytes is not None

    with zipfile.ZipFile(io.BytesIO(zip_bytes), "r") as z:
        names = z.namelist()
        assert "readings.csv" in names
        assert "events.csv" in names
        assert "session.json" in names
        assert "checksums.sha256" in names

        chk = z.read("checksums.sha256").decode("utf-8")
        assert "readings.csv" in chk
        assert "events.csv" in chk


def test_recording_api_endpoints(tmp_path, monkeypatch):
    from torqva.telemetry.recording import recorder
    monkeypatch.setattr(recorder, "base_dir", tmp_path / "sessions")
    if recorder.is_active():
        recorder.stop_session()

    h = hashlib.sha256(b"tok-rec").hexdigest()
    auth = TokenAuth([{"sha256": h, "user": "op", "role": "operator"}])

    app = FastAPI()
    svc = SimulationService()
    app.include_router(create_router(svc, auth))
    client = TestClient(app)
    headers = {"Authorization": "Bearer tok-rec"}

    # Status when idle
    r = client.get("/api/torqva/recording/status", headers=headers)
    assert r.status_code == 200
    assert r.json()["active"] is False

    # Start manual
    r = client.post("/api/torqva/recording/start?mode=PHYSICAL", headers=headers)
    assert r.status_code == 200
    sid = r.json()["session_id"]
    assert sid is not None

    # Status when active
    r = client.get("/api/torqva/recording/status", headers=headers)
    assert r.status_code == 200
    assert r.json()["active"] is True
    assert r.json()["session_id"] == sid

    # Stop
    r = client.post("/api/torqva/recording/stop", headers=headers)
    assert r.status_code == 200

    # List sessions
    r = client.get("/api/torqva/recording/sessions", headers=headers)
    assert r.status_code == 200
    sessions = r.json()
    assert len(sessions) >= 1
    assert any(s["session_id"] == sid for s in sessions)

    # Get single session & summary
    r = client.get(f"/api/torqva/recording/sessions/{sid}", headers=headers)
    assert r.status_code == 200
    assert r.json()["session_id"] == sid

    r = client.get(f"/api/torqva/recording/sessions/{sid}/summary", headers=headers)
    assert r.status_code == 200
    assert "data_quality_pct" in r.json()

    # Export ZIP
    r = client.get(f"/api/torqva/recording/sessions/{sid}/export", headers=headers)
    assert r.status_code == 200
    assert r.headers["content-type"] == "application/zip"
    assert len(r.content) > 100

    # Report HTML
    r = client.get(f"/api/torqva/recording/sessions/{sid}/report", headers=headers)
    assert r.status_code == 200
    assert "text/html" in r.headers["content-type"]
    assert "TORQVA Session Report" in r.text
    assert sid in r.text

    # Limits Panel API (Feature 1)
    r = client.get("/api/torqva/limits", headers=headers)
    assert r.status_code == 200
    limits_data = r.json()
    assert "duty" in limits_data["limits"]
    assert "rpm" in limits_data["limits"]
    assert "current" in limits_data["limits"]

    # Update limit
    r = client.put("/api/torqva/limits", json={"key": "rpm", "value": 2500, "enabled": True}, headers=headers)
    assert r.status_code == 200
    assert r.json()["limit"]["value"] == 2500

    # Reset limits
    r = client.post("/api/torqva/limits/reset", headers=headers)
    assert r.status_code == 200
    assert r.json()["limits"]["rpm"]["value"] == 3000.0
