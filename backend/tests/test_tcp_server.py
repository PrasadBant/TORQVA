"""
Unit tests for ESP32 asyncio TCP Server (Stage 1 Architecture).
Tests TCP JSON payload normalization, boundary safety, and error handling.
"""

import json
import pytest
from tcp_server import ESP32TCPServer


def test_tcp_server_parse_stopped_payload():
    server = ESP32TCPServer()
    raw_json = json.dumps({
        "temperature": 27.08,
        "voltage": 5.90,
        "current": -0.000,
        "power": -0.00,
        "rpm": 0,
        "vibration": 6.28,
        "condition": 100.00,
        "status": "MOTOR OFF",
        "motor": "OFF",
        "reason": "Motor is not running"
    })
    parsed = server.parse_and_normalize_raw_json(raw_json)
    assert parsed is not None
    assert parsed["temperature"] == 27.08
    assert parsed["voltage"] == 5.90
    assert parsed["current"] == 0.0
    assert parsed["rpm"] == 0.0
    assert parsed["vibration"] == 6.28
    assert parsed["vibration_rms"] == 6.28
    assert parsed["condition"] == 100.00
    assert parsed["status"] == "MOTOR OFF"
    assert parsed["motor"] == "OFF"
    assert parsed["motor_running"] is False
    assert parsed["reason"] == "Motor is not running"


def test_tcp_server_parse_running_payload():
    server = ESP32TCPServer()
    raw_json = json.dumps({
        "temperature": 96.50,
        "voltage": 62.00,
        "current": 0.765,
        "power": 47.43,
        "rpm": 1200,
        "vibration": 6.60,
        "condition": 72.00,
        "status": "NORMAL",
        "motor": "RUNNING",
        "reason": "All parameters normal"
    })
    parsed = server.parse_and_normalize_raw_json(raw_json)
    assert parsed is not None
    assert parsed["temperature"] == 96.50
    assert parsed["voltage"] == 62.00
    assert parsed["current"] == 0.765
    assert parsed["power"] == 47.43
    assert parsed["rpm"] == 1200.0
    assert parsed["vibration"] == 6.60
    assert parsed["status"] == "NORMAL"
    assert parsed["motor"] == "RUNNING"
    assert parsed["motor_running"] is True
    assert parsed["reason"] == "All parameters normal"


def test_tcp_server_malformed_json_resilience():
    server = ESP32TCPServer()
    assert server.parse_and_normalize_raw_json("") is None
    assert server.parse_and_normalize_raw_json("not a json string") is None
    assert server.parse_and_normalize_raw_json("{invalid:json}") is None
    assert server.parse_and_normalize_raw_json("[]") is None


def test_tcp_server_missing_required_numeric_fields():
    server = ESP32TCPServer()
    incomplete = json.dumps({"rpm": 1200})
    assert server.parse_and_normalize_raw_json(incomplete) is None


@pytest.mark.anyio
async def test_send_motor_command_disconnected():
    server = ESP32TCPServer()
    res = await server.send_motor_command("MOTOR_ON")
    assert res["success"] is False
    assert "not connected" in res["message"].lower()


@pytest.mark.anyio
async def test_send_motor_command_invalid():
    server = ESP32TCPServer()
    res = await server.send_motor_command("INVALID_CMD")
    assert res["success"] is False
    assert "invalid" in res["message"].lower()
