"""
End-to-End Real Telemetry Ingestion Verification Script.
Simulates realistic ESP32 telemetry packet ingestion and verifies:
1. HTTP Ingestion Response
2. SQLite Database Persistence
3. Latest Sensor API (/api/sensors/latest)
4. Historical Query API (/api/history)
5. Device State Machine & IP Capture (/api/status)
6. Real-time WebSocket Multi-Event Broadcast (/ws)
"""

import sys
import os
import json
import time
from pathlib import Path

# Add backend directory to sys.path
sys.path.insert(0, str(Path(__file__).parent.parent))

from fastapi.testclient import TestClient
from main import app, storage, current_device_status


def verify_packet_pipeline():
    client = TestClient(app)
    
    with client.websocket_connect("/ws") as ws:
        # Drain initial synchronization frames
        ws.receive_json()  # connection
        ws.receive_json()  # baseline

        # Realistic RS-775 Motor Telemetry Packet
        packet = {
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

        # 1. Post to /api/ingest
        res = client.post("/api/ingest", json=packet)
        print("\n--- 1. HTTP Ingestion Response ---")
        print(f"Status Code: {res.status_code}")
        print(f"Response: {res.json()}")
        assert res.status_code == 200
        assert res.json()["accepted"] is True
        assert res.json()["device_id"] == "ESP32-MOTOR-01"

        # 2. Verify WebSocket events
        print("\n--- 2. WebSocket Broadcast Events ---")
        conn_event = ws.receive_json()
        print(f"Connection Event: {conn_event}")
        assert conn_event["type"] == "connection"
        assert conn_event["data"]["status"] == "CONNECTED"

        telemetry_event = ws.receive_json()
        print(f"Telemetry Event: {telemetry_event}")
        assert telemetry_event["type"] == "telemetry"
        assert telemetry_event["data"]["temperature"] == 42.6

        health_event = ws.receive_json()
        print(f"Health Event: {health_event}")
        assert health_event["type"] == "health"

        # 3. Verify Latest API
        print("\n--- 3. Latest Sensor API ---")
        latest = client.get("/api/sensors/latest").json()
        print(f"GET /api/sensors/latest: temp={latest['temperature']}°C, rpm={latest['rpm']}, vib_rms={latest['vibration_rms']}g, server_received_at={latest['server_received_at']}")
        assert latest["temperature"] == 42.6
        assert latest["vibration_x"] == 0.12

        # 4. Verify History API
        print("\n--- 4. History API ---")
        history = client.get("/api/history?minutes=5").json()
        print(f"GET /api/history count: {len(history)}, newest record temp: {history[-1]['temperature']}°C")
        assert len(history) > 0

        # 5. Verify Device Status & IP Capture
        print("\n--- 5. Device Status ---")
        status_res = client.get("/api/status").json()
        print(f"Status: state={status_res['connection_state']}, is_connected={status_res['is_device_connected']}, IP={status_res['device']['ip_address']}")
        assert status_res["connection_state"] == "CONNECTED"
        assert status_res["is_device_connected"] is True

        # 6. Verify SQLite storage
        print("\n--- 6. SQLite Database Storage ---")
        row = storage.get_latest_telemetry()
        print(f"Stored row in SQLite: id={row['id']}, device_id={row['device_id']}, vib_x={row['vibration_x']}, server_received_at={row['server_received_at']}")
        assert row["temperature"] == 42.6
        assert row["vibration_z"] == 0.21

        print("\n[SUCCESS] All pipeline checks verified successfully!")


if __name__ == "__main__":
    verify_packet_pipeline()
