# Detailed System Communication Protocol & Command Workflow

This document provides complete protocol details for data serialization, telemetry ingestion, baseline calibration, and command execution across all layers of the system.

---

## 1. Multi-Tier Protocol Architecture

```
[ ESP32-S3 Firmware ]
         │
         │ TCP Socket (Port 5001) - Raw JSON Telemetry & ASCII Commands
         ▼
[ FastAPI Backend ]
         │
         ├─► SQLite Storage (`motor_monitor.db`)
         ├─► Predictive Health Engine (Rule-based anomaly scoring)
         │
         │ WebSockets (Port 8000 /ws) - Real-time Dashboard Events
         ▼
[ React Industrial Dashboard ]
```

---

## 2. Telemetry Ingestion Contract

### TCP Ingestion Format (Port 5001)
- **Transport**: Persistent TCP Socket Connection
- **Framing**: Line-delimited JSON (`\n`)
- **Frequency**: 1.0 Hz
- **Timeout Window**: 3.0s before `STALE`, 5.0s before `OFFLINE`

### Validation & Fallback Rules
1. **Numeric Range Bounds**:
   - Temperature: $-50^\circ\text{C}$ to $150^\circ\text{C}$
   - Voltage: $0\text{V}$ to $30\text{V}$
   - Current: $0\text{A}$ to $10\text{A}$
   - RPM: $0$ to $5000\text{ RPM}$
   - Vibration RMS: $0\text{g}$ to $16\text{g}$
2. **Missing/Invalid Sensors**:
   - If a sensor fails, the `sensor_health` map flags the specific sensor false (`adxl345: false`, `ds18b20: false`, `ina219: false`, or `a3144: false`).
   - The condition transitions to `"SENSOR FAULT"` and triggers the hardware buzzer alert.

---

## 3. Motor Command Control Flow

```
+------------------+          HTTP POST /api/motor/control          +------------------+
| React Dashboard  |  ------------------------------------------->  |  FastAPI Backend |
| (ON/OFF Toggle)  |  Payload: {"command": "MOTOR_ON"}              |                  |
+------------------+                                                +------------------+
                                                                             │
                                                                             │ Dispatch string over active TCP socket
                                                                             ▼
+------------------+             `MOTOR_ON_ACK\n`                   +------------------+
|  ESP32-S3 Node   |  ------------------------------------------->  |  Backend Server  |
|  (BTS7960 Driver)|  <-------------------------------------------  |  (TCP Socket)    |
+------------------+               `MOTOR_ON\n`                     +------------------+
```

### Motor Command States & Responses:
- **`MOTOR_ON`**: Backend sends `MOTOR_ON\n`. ESP32 sets `RPWM=200`, `R_EN=HIGH`, `L_EN=HIGH`. ESP32 responds with `MOTOR_ON_ACK\n`. Backend updates WebSocket clients.
- **`MOTOR_OFF`**: Backend sends `MOTOR_OFF\n`. ESP32 sets `RPWM=0`, `R_EN=LOW`, `L_EN=LOW`. ESP32 responds with `MOTOR_OFF_ACK\n`. Backend updates WebSocket clients.

---

## 4. Live RPM Time-Series Stream Protocol

1. **Hardware Capture**:
   - A3144 Hall-Effect sensor on GPIO 9 detects shaft magnetic pulses via hardware interrupt (`countPulse()`).
   - Pulse count is evaluated every 1000ms:
     $$\text{RPM} = \text{pulses} \times 60.0$$
2. **TCP Serialization**:
   - `rpm` value embedded in JSON telemetry frame and sent over TCP.
3. **Backend Processing & WebSocket Broadcast**:
   - Backend receives TCP telemetry frame, updates health engine, writes to database, and broadcasts JSON event over `/ws` channel:
     ```json
     {
       "event": "telemetry",
       "data": {
         "rpm": 1450.0,
         "timestamp": 1245.82,
         "motor_running": true
       }
     }
     ```
4. **Dashboard Visualization**:
   - React Dashboard receives WebSocket payload in `src/services/websocket.js`.
   - App state appends real-time data point to dynamic Recharts time-series array in `src/charts/TrendChart.jsx` and `ChartPanel.jsx`.
