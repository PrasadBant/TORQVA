# Data Contract & Telemetry Schema Specification (Phase 3)

## 1. Telemetry Ingestion Contract (`POST /api/ingest`)

### Request Payload (Transmitted by ESP32-S3 Firmware)
```json
{
  "device_id": "ESP32-MOTOR-01",
  "firmware": "1.0.0",
  "timestamp": 1727260000.5,
  "motor_running": true,
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
    "adxl345": true,
    "ds18b20": true,
    "ina219": true,
    "a3144": true
  },
  "source": "live"
}
```

### Physical Boundary Validation Rules
- **Temperature**: $-50.0^\circ\text{C} \le T \le 200.0^\circ\text{C}$
- **Vibration RMS**: $0.0\text{g} \le \text{RMS} \le 50.0\text{g}$
- **RPM**: $0.0 \le \text{RPM} \le 30,000.0$
- **Voltage**: $0.0\text{V} \le V \le 100.0\text{V}$
- **Current**: $-5.0\text{A} \le I \le 50.0\text{A}$
- **Power**: Automatically calculated as $V \times I$ if omitted.
- **NaN / Infinity**: Strictly rejected (`422 Unprocessable Entity`).

### Ingestion Response (`200 OK`)
```json
{
  "accepted": true,
  "device_id": "ESP32-MOTOR-01",
  "server_time": 1727260000.525,
  "pending_commands": 0,
  "message": "Telemetry accepted"
}
```

---

## 2. Command Protocol Contracts

### Command Polling (`GET /api/device/commands?device_id=ESP32-MOTOR-01`)
Response:
```json
[
  {
    "command_id": "b3e944fb-2a54-4742-8859-994b150cb2e8",
    "command": "START_BASELINE",
    "parameters": { "duration_seconds": 30.0 },
    "created_at": 1727260010.0,
    "status": "SENT"
  }
]
```

### Command Acknowledgment (`POST /api/device/command-ack`)
Request Body:
```json
{
  "command_id": "b3e944fb-2a54-4742-8859-994b150cb2e8",
  "device_id": "ESP32-MOTOR-01",
  "status": "ACKNOWLEDGED",
  "message": "Baseline collection started"
}
```

---

## 3. Baseline Calibration Result Contract (`POST /api/baseline/result`)

### Request Payload (Sent by ESP32 upon completing 30s calibration)
```json
{
  "status": "SAVED",
  "temperature": 40.8,
  "vibration_rms": 0.21,
  "voltage": 23.9,
  "current": 1.18,
  "power": 28.2,
  "rpm": 1448.0,
  "samples": 60,
  "duration_seconds": 30.0
}
```

---

## 4. Connection State Machine Contract

```
[Telemetry Received]
         │
         ▼
    CONNECTED (0 to 3.0s)
         │
         │ (elapsed > stale_timeout: 3.0s)
         ▼
       STALE   (3.0s to 5.0s)
         │
         │ (elapsed > offline_timeout: 5.0s)
         ▼
     OFFLINE  (> 5.0s)
```

### Connection Event Broadcast over WebSocket:
```json
{
  "type": "connection",
  "data": {
    "device_id": "ESP32-MOTOR-01",
    "status": "CONNECTED",
    "last_seen": 1727260000.525
  }
}
```

---

## 5. Health Engine Contract (`GET /api/health` & WebSocket `"health"` Event)

```json
{
  "score": 82.5,
  "status": "WARNING",
  "factors": {
    "temperature": 100.0,
    "vibration": 60.0,
    "rpm": 100.0,
    "current": 100.0,
    "power": 100.0
  },
  "alerts": [
    {
      "severity": "WARNING",
      "parameter": "vibration",
      "title": "Elevated Vibration",
      "message": "Vibration RMS 0.270g is +35.0% above baseline (0.200g).",
      "current_value": 0.27,
      "baseline_value": 0.20,
      "suggested_inspection": "Inspect motor mounting bolts, shaft alignment, coupling balance, and bearing wear."
    }
  ],
  "anomalies": [
    {
      "sensor": "vibration_rms",
      "type": "ABOVE_BASELINE",
      "severity": "WARNING",
      "current": 0.27,
      "baseline": 0.20,
      "deviation_percent": 35.0,
      "message": "Vibration RMS 0.270g is +35.0% above baseline (0.200g).",
      "suggested_inspection": "Inspect motor mounting bolts, shaft alignment, coupling balance, and bearing wear."
    }
  ],
  "explanations": [
    "Temperature (41.0°C) is within nominal baseline range.",
    "Vibration RMS 0.270g is +35.0% above baseline (0.200g).",
    "Shaft speed (1500 RPM) is within nominal baseline range.",
    "Current draw (1.50A) is within nominal baseline range.",
    "Active power (36.0W) is within nominal baseline range."
  ],
  "evaluated_sensors": ["temperature", "vibration_rms", "rpm", "voltage", "current", "power"],
  "unavailable_sensors": [],
  "baseline_age_seconds": 3600.0,
  "diagnostic_explanation": "Operating parameters show noticeable deviation from baseline conditions. Continued monitoring recommended."
}
```

---

## 6. Alert Record Schema (`GET /api/alerts`)

```json
[
  {
    "id": 1,
    "timestamp": 1727260000.0,
    "severity": "WARNING",
    "parameter": "vibration",
    "title": "Elevated Vibration",
    "message": "Vibration RMS 0.270g is +35.0% above baseline (0.200g).",
    "current_value": 0.27,
    "baseline_value": 0.20,
    "suggested_inspection": "Inspect motor mounting bolts, shaft alignment, coupling balance, and bearing wear.",
    "source": "live",
    "status": "ACTIVE",
    "resolved_at": null
  }
]
```

