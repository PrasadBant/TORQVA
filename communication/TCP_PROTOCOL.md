# TCP Communication Protocol Specification

This document details the TCP socket protocol used for bidirectional communication between the **ESP32-S3 Motor Telemetry Node** and the **Laptop/Server Backend**.

---

## 1. Architectural Flow

```
+-------------------+           Wi-Fi LAN           +-------------------+
|                   |   TCP Stream (Port 5001)      |                   |
|     ESP32-S3      |  -------------------------->  |  Python Backend   |
|   (TCP Client)    |  Telemetry (JSON, 1 Hz)       |   (TCP Server)    |
|                   |  <--------------------------  |                   |
+-------------------+      Commands (\n terminated)  +-------------------+
                                                              │
                                                              │ Internal Event Bridge
                                                              ▼
                                                    +-------------------+
                                                    |  React Dashboard  |
                                                    | (WebSocket / REST)|
                                                    +-------------------+
```

---

## 2. Connection Parameters

- **Protocol**: Raw TCP Sockets over IP
- **Role**:
  - **ESP32-S3**: TCP Client
  - **Backend Server**: TCP Server (Listening on `0.0.0.0:5001`)
- **Telemetry Frequency**: 1 Hz (1-second intervals)
- **Delimiters**: Newline (`\n`) terminated string payloads for both telemetry frames and command messages.

---

## 3. Telemetry Data Frame (ESP32-S3 -> Backend)

The ESP32-S3 sends newline-terminated JSON telemetry objects every 1 second over the active TCP connection.

### Example JSON Telemetry Frame:
```json
{
  "device_id": "ESP32-MOTOR-01",
  "firmware": "2.0.0",
  "timestamp": 1245.82,
  "motor_running": true,
  "motor": "RUNNING",
  "temperature": 34.50,
  "vibration_x": 0.02,
  "vibration_y": 0.04,
  "vibration_z": 0.99,
  "vibration_rms": 0.08,
  "vibration": 0.78,
  "rpm": 1450.00,
  "voltage": 24.10,
  "current": 1.25,
  "power": 30.12,
  "hardware_condition": "NORMAL",
  "hardware_reason": "All parameters within normal baseline range",
  "status": "NORMAL",
  "reason": "All parameters within normal baseline range",
  "condition": 98.50,
  "sensor_health": {
    "adxl345": true,
    "ds18b20": true,
    "ina219": true,
    "a3144": true
  }
}
```

### Field Definitions:
| Field | Type | Description |
|---|---|---|
| `device_id` | String | Unique hardware node identification tag |
| `firmware` | String | Active ESP32 firmware semantic version |
| `timestamp` | Float | Device uptime in seconds (`millis() / 1000.0`) |
| `motor_running` | Boolean | True if motor is actively spinning or energized |
| `motor` | String | Motor state representation (`"RUNNING"` / `"OFF"`) |
| `temperature` | Float | Casing temperature from DS18B20 (°C) |
| `vibration_x`, `y`, `z` | Float | Acceleration values normalized in $g$ |
| `vibration_rms` | Float | Dynamic vibration RMS ($g$) from ADXL345 |
| `rpm` | Float | Rotational shaft speed in RPM calculated from A3144 interrupts |
| `voltage` | Float | Bus voltage ($V$) from INA219 |
| `current` | Float | Current draw ($A$) from INA219 |
| `power` | Float | Calculated power consumption ($W$) |
| `hardware_condition` | String | On-device condition state (`NORMAL`, `WARNING`, `CRITICAL`, `SENSOR FAULT`, `MOTOR OFF`) |
| `sensor_health` | Object | Boolean health check map for individual sensors |

---

## 4. Control Commands (Backend -> ESP32-S3)

The TCP server dispatches newline-terminated UTF-8 string commands to the ESP32-S3 to actuate the BTS7960 motor driver.

### 4.1 `MOTOR_ON`
- **Command String**: `MOTOR_ON\n`
- **Action**: ESP32 enables BTS7960 driver pins (`R_EN=HIGH`, `L_EN=HIGH`, `RPWM=200`).
- **Expected ACK Response**: `MOTOR_ON_ACK\n`

### 4.2 `MOTOR_OFF`
- **Command String**: `MOTOR_OFF\n`
- **Action**: ESP32 disables BTS7960 driver pins (`R_EN=LOW`, `L_EN=LOW`, `RPWM=0`).
- **Expected ACK Response**: `MOTOR_OFF_ACK\n`

---

## 5. Connection Safety & Fail-Safe Mechanisms

1. **Wi-Fi Watchdog**: If Wi-Fi disconnects, ESP32 safely deactivates the motor driver (`MOTOR_OFF`) and attempts automatic reconnection every 5 seconds.
2. **TCP Socket Heartbeat**: If the TCP socket drops for more than 2 seconds while the motor is active, ESP32 immediately turns the motor OFF to prevent unmonitored runaway operation.
3. **Keep-Alive**: Backend TCP server maintains TCP keep-alive packets and auto-cleans stale connections.
