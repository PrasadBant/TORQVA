# REST & WebSocket API Documentation (Phase 2)

## Summary Table

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/status` | System health, device connection state machine (`CONNECTED`, `STALE`, `OFFLINE`), and IP address |
| `GET` | `/api/sensors/latest` | Most recent telemetry sample (supports `?source=live` or `?source=demo`) |
| `GET` | `/api/history` | Chronological time-series lookback (`?minutes=5`, `?source=live`, `?limit=5000`) |
| `GET` | `/api/baseline` | Current baseline calibration parameters and state |
| `GET` | `/api/health` | Evaluated health score, condition factors, explainable anomalies, and sensor availability |
| `GET` | `/api/alerts` | Logged anomaly alerts with optional active and source filtering (`?active_only=true`, `?source=live`) |
| `GET` | `/api/config` | System operational thresholds, baseline deviation thresholds, timeouts, and health weights |
| `POST` | `/api/ingest` | Telemetry ingestion endpoint for ESP32 & Demo Engine |
| `GET` | `/api/device/commands` | Polled by ESP32 to retrieve pending non-control commands |
| `POST` | `/api/device/command-ack` | ESP32 acknowledges execution of a dispatched command |
| `POST` | `/api/baseline/start` | Initiates a 30-second baseline data collection run |
| `POST` | `/api/baseline/cancel` | Aborts ongoing baseline collection |
| `POST` | `/api/baseline/reset` | Resets stored baseline calibration |
| `POST` | `/api/baseline/result` | Receives and stores aggregated baseline results |
| `WS` | `/ws` | Real-time WebSocket streaming channel for UI subscribers |

---

## Endpoint Specifications

### 1. `GET /api/status`
- **Purpose**: Query backend availability, heartbeat status, and ESP32 connection state machine.
- **Request**: None.
- **Response (200 OK)**:
```json
{
  "status": "ONLINE",
  "timestamp": 1727260000.0,
  "device": {
    "device_id": "ESP32-MOTOR-01",
    "firmware": "1.0.0",
    "ip_address": "192.168.1.150",
    "first_seen": 1727259000.0,
    "last_seen": 1727260000.0,
    "connection_state": "CONNECTED",
    "sensor_health": {
      "adxl345": true,
      "ds18b20": true,
      "ina219": true,
      "a3144": true
    },
    "uptime_seconds": 0.0
  },
  "is_device_connected": true,
  "connection_state": "CONNECTED",
  "websocket_subscribers": 1,
  "demo_mode": false
}
```

---

### 2. `GET /api/sensors/latest`
- **Purpose**: Fetch the single most recent sensor telemetry reading.
- **Query Parameters**: `source` (string, optional: `"live"` or `"demo"`).
- **Response (200 OK)**:
```json
{
  "device_id": "ESP32-MOTOR-01",
  "firmware": "1.0.0",
  "timestamp": 1727260000.0,
  "server_received_at": 1727260000.025,
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

---

### 3. `GET /api/history`
- **Purpose**: High-performance chronological query for charting and historical trend analysis.
- **Query Parameters**:
  - `minutes` (float, default: `5.0`, min: `0.1`, max: `1440.0`)
  - `source` (string, optional: `"live"` or `"demo"`)
  - `limit` (int, default: `5000`, min: `1`, max: `10000`)
- **Response (200 OK)**: Array of `HistoryRecord` objects in chronological order (`ORDER BY timestamp ASC`).
```json
[
  {
    "id": 101,
    "timestamp": 1727259900.0,
    "server_received_at": 1727259900.012,
    "source": "live",
    "device_id": "ESP32-MOTOR-01",
    "temperature": 42.1,
    "vibration_x": 0.11,
    "vibration_y": 0.14,
    "vibration_z": 0.19,
    "vibration_rms": 0.16,
    "rpm": 1450.0,
    "voltage": 23.9,
    "current": 1.40,
    "power": 33.46,
    "motor_running": true,
    "health_score": 98.0,
    "status": "HEALTHY"
  }
]
```

---

### 4. `POST /api/ingest`
- **Purpose**: Real-time telemetry ingestion from ESP32 or Demo Simulator.
- **Request Body**: `TelemetryPayload` JSON.
- **Validation**: Strict physical boundaries, non-NaN/Inf checking, automatic power calculation ($V \times I$).
- **Response (200 OK)**:
```json
{
  "accepted": true,
  "device_id": "ESP32-MOTOR-01",
  "server_time": 1727260000.025,
  "pending_commands": 0,
  "message": "Telemetry accepted"
}
```
- **Error Responses**: `422 Unprocessable Entity` on boundary failure or missing fields.

---

---

### 5. `GET /api/health`
- **Purpose**: Evaluates current motor health score, condition factors, explainable anomalies, and sensor availability status based on baseline-relative analysis.
- **Response (200 OK)**:
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

### 6. `GET /api/alerts`
- **Purpose**: Retrieve historical and active anomaly records with deduplicated lifecycle status (`ACTIVE` vs `RESOLVED`).
- **Query Parameters**:
  - `active_only` (bool, default: `false`): Filter only active alerts.
  - `source` (string, optional: `"live"` or `"demo"`).
  - `limit` (int, default: `100`, max: `1000`).
- **Response (200 OK)**: Array of `AlertRecord` objects.

---

### 7. `GET /api/config`
- **Purpose**: Retrieve system operational thresholds, baseline deviation thresholds, health weights, heartbeat timeouts, and retention settings.
- **Response (200 OK)**: `AppConfig` JSON object.

---

### 8. `WS /ws`
- **Purpose**: Full-duplex WebSocket channel for streaming real-time events to frontend clients.
- **Initial Sync**: Automatically delivers `connection`, `baseline`, and latest `telemetry` frames upon handshake.
- **Broadcast Events**: `connection` (state transitions), `telemetry` (live sensor data), `health` (health scores), `baseline` (calibration state), `command_ack` (device command acks).
- **Heartbeat**: Responds to client text `"ping"` with `"pong"`.

