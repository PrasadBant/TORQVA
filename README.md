# Smart ESP32-S3 Motor Condition Monitoring & Predictive Maintenance System

A multi-parameter IoT condition monitoring, predictive maintenance, and remote motor control system built for RS-775 24V DC motors using **ESP32-S3**, **FastAPI**, and **React + Vite**.

---

## 1. Project Overview

The Smart Motor Condition Monitoring System continuously measures motor health across thermal, electrical, mechanical vibration, and rotational velocity metrics. It detects baseline anomalies, estimates motor condition percentage, provides explainable diagnostic feedback, enables remote motor ON/OFF control via a BTS7960 motor driver, and streams real-time RPM trends to an industrial dashboard.

---

## 2. Hardware Used & ESP32-S3 Details

### Core Processing Unit
- **Microcontroller**: ESP32-S3 (Dual-core 32-bit Xtensa LX7, 240 MHz, 3.3V logic, Wi-Fi 802.11 b/g/n)

### Sensors & Peripherals
1. **ADXL345**: 3-Axis Accelerometer for vibration RMS evaluation ($g$).
2. **DS18B20**: OneWire Digital Thermometer for motor casing temperature (°C).
3. **INA219**: High-Side DC Voltage ($V$), Current ($A$), and Power ($W$) Monitor.
4. **A3144**: Hall-Effect Sensor for shaft rotational speed (RPM) pulse counting via hardware interrupt.
5. **SH1106 OLED**: 1.3" 128x64 I2C display for local status reporting.
6. **BTS7960**: 43A High-Power DC Motor Driver Module (Controlled via logic GPIO pins).
7. **Peripherals**: Status LEDs for individual sensor health verification, active piezoelectric buzzer for fault alerts.

---

## 3. ESP32-S3 GPIO & Pin Configuration

> [!IMPORTANT]
> **Existing hardware pin assignments are strictly preserved from firmware (`smart_motor_monitor.ino`).**

| Module / Sensor | Signal / Pin | ESP32-S3 GPIO | Protocol / Mode | Notes |
|---|---|---|---|---|
| **ADXL345 (Vibration)** | SDA | `GPIO 4` | I2C Bus 0 | Shared bus with OLED (Address `0x53`) |
| | SCL | `GPIO 5` | I2C Bus 0 | Shared bus with OLED |
| **DS18B20 (Temp)** | DATA | `GPIO 6` | OneWire | **Requires 4.7kΩ pull-up resistor** to 3.3V |
| **INA219 (Power)** | SDA | `GPIO 7` | I2C Bus 1 | Dedicated I2C Bus (Address `0x40`) |
| | SCL | `GPIO 8` | I2C Bus 1 | Dedicated I2C Bus |
| **A3144 (Hall RPM)** | OUT | `GPIO 9` | Digital Interrupt | `FALLING` edge trigger, `INPUT_PULLUP` |
| **ADXL Status LED** | Anode | `GPIO 10` | Digital Output | Active HIGH when ADXL345 healthy |
| **TEMP Status LED** | Anode | `GPIO 11` | Digital Output | Active HIGH when DS18B20 healthy |
| **INA Status LED** | Anode | `GPIO 12` | Digital Output | Active HIGH when INA219 healthy |
| **HALL Status LED** | Anode | `GPIO 13` | Digital Output | Active HIGH when A3144 healthy |
| **Buzzer** | Signal | `GPIO 14` | Digital Output | Active HIGH on sensor fault |
| **BTS7960 Driver** | RPWM | `GPIO 15` | PWM Output | Forward Speed PWM (Default 200/255) |
| | LPWM | `GPIO 16` | Digital Output | Reverse Speed PWM (Set to 0) |
| | R_EN | `GPIO 17` | Digital Output | Forward Enable (HIGH = ON, LOW = OFF) |
| | L_EN | `GPIO 18` | Digital Output | Reverse Enable (HIGH = ON, LOW = OFF) |

---

## 4. Current Features vs Planned Stages

### CURRENTLY IMPLEMENTED
- [x] **Multi-Parameter Sensor Acquisition**: Real-time reading of Temperature, Current, Voltage, Power, RPM, and Vibration RMS.
- [x] **Local Display & Diagnostics**: SH1106 OLED rendering, status LEDs, and buzzer alert triggers.
- [x] **On-Device Baseline Calibration**: NVS Preferences storage for baseline metric comparison.
- [x] **Non-Blocking Network Architecture**: ESP32-S3 Wi-Fi auto-reconnect watchdog & raw TCP socket telemetry client (`smart_motor_monitor.ino`).
- [x] **FastAPI Backend Server**: Asynchronous TCP socket server (Port 5001), REST API endpoints (`/api/*`), SQLite storage, and WebSocket distribution channel (`/ws`).
- [x] **Predictive Health Engine**: Baseline-relative deviation scoring, weighted multi-factor health index (0–100%), and explainable diagnostic advisories.
- [x] **React Industrial Dashboard**: Dark-mode UI with live metric gauges, alert panel, device state indicator, dynamic time-series charts, and motor toggle controls.
- [x] **BTS7960 Motor Actuation Layer**: Non-blocking TCP command parsing (`MOTOR_ON`, `MOTOR_OFF`) with ACK string replies (`MOTOR_ON_ACK`, `MOTOR_OFF_ACK`).

### PLANNED / NEXT DEVELOPMENT
- [ ] **Advanced Motor Control**: Variable PWM speed slider on the frontend dashboard to adjust motor RPM dynamically via TCP.
- [ ] **FFT Vibration Frequency Spectrum Analysis**: Fast Fourier Transform on ESP32 to isolate bearing defects vs unbalance.
- [ ] **Cloud Telemetry Backup & MQTT Protocol Option**: Alternative MQTT broker gateway option for cloud deployments.

---

## 5. Software Requirements & System Setup

### Prerequisites
- **Embedded**: Arduino IDE (v2.0+) with ESP32 board support package (v2.0+ or v3.0+).
- **Backend**: Python 3.10+
- **Frontend**: Node.js v18+ and npm

---

## 6. How to Build & Install

### Step A: Flash ESP32-S3 Firmware
1. Open `esp32/firmware/smart_motor_monitor/smart_motor_monitor.ino` in Arduino IDE.
2. Install required libraries:
   - `ArduinoJson`
   - `Adafruit ADXL345` & `Adafruit Unified Sensor`
   - `Adafruit INA219`
   - `DallasTemperature` & `OneWire`
   - `U8g2`
3. Update Wi-Fi SSID, Password, and Backend Laptop IP in `smart_motor_monitor.ino`:
   ```cpp
   const char* WIFI_SSID    = "YOUR_WIFI_SSID";
   const char* WIFI_PASS    = "YOUR_WIFI_PASSWORD";
   const char* BACKEND_HOST = "192.168.X.X"; // Host laptop IP
   ```
4. Select **ESP32S3 Dev Module** and click **Upload**.

### Step B: Run FastAPI Backend
```powershell
cd backend
pip install -r requirements.txt
python -m uvicorn main:app --reload --host 0.0.0.0 --port 8000
```
- Interactive API Documentation: `http://localhost:8000/docs`
- TCP Telemetry Server automatically runs on Port `5001`.

### Step C: Run React Frontend Dashboard
```powershell
cd frontend
npm install
npm run dev
```
- Open browser at `http://localhost:5173`.

---

## 7. System Architecture & Communication Protocol

### Communication Pipeline
```
ESP32-S3 (TCP Client)
      │
      │ Wi-Fi LAN (TCP Socket, Port 5001) - 1Hz JSON Telemetry & ACK Commands
      ▼
Laptop / Python Backend (FastAPI + TCP Server)
      │
      ├─► SQLite Storage (`data/motor_monitor.db`)
      ├─► Predictive Health Engine
      │
      │ WebSockets (`ws://localhost:8000/ws`)
      ▼
React Dashboard (Browser)
```

### Motor Command Architecture
```
React Dashboard  ──(HTTP POST /api/motor/control)──>  FastAPI Backend
                                                              │
                                                              │ TCP String (`MOTOR_ON\n` / `MOTOR_OFF\n`)
                                                              ▼
RS-775 Motor  <──(24V DC Rail)──  BTS7960 Driver  <──(3.3V GPIO 15,16,17,18)──  ESP32-S3
                                                              │
                                                              │ TCP Reply (`MOTOR_ON_ACK\n`)
                                                              ▼
                                                        Backend & Dashboard Update
```

### Live RPM Graph Architecture
```
A3144 Hall Sensor (GPIO 9 Interrupt) ──> ESP32-S3 (Pulse Counter)
                                                │
                                                │ TCP JSON Telemetry (`"rpm": 1450.0`)
                                                ▼
Recharts Live Time-Series Chart <──(WebSocket /ws)── Backend Server
```

---

## 8. Project Folder Structure

```
smart-motor-monitor/
├── .gitignore                      # Git ignore rules for build, credentials, databases
├── README.md                       # Main project overview & quickstart
├── assets/                         # Architecture diagrams & media assets
│   └── README.md
├── backend/                        # FastAPI Backend & TCP Server
│   ├── config.py                   # Centralized threshold & health configuration
│   ├── data_storage.py             # SQLite persistence layer
│   ├── demo_engine.py             # Telemetry simulation engine
│   ├── health_engine.py           # Anomaly detection & condition calculation
│   ├── main.py                     # FastAPI REST API routes & WS server
│   ├── models.py                   # Pydantic telemetry & response schemas
│   ├── requirements.txt            # Python dependencies
│   ├── serial_bridge.py            # Optional UART serial backup bridge
│   ├── tcp_server.py               # Async raw TCP socket telemetry server
│   ├── websocket_manager.py        # Real-time WebSocket event broadcaster
│   └── tests/                      # Pytest backend test suite
├── communication/                  # Communication & TCP protocol documentation
│   ├── README.md
│   ├── PROTOCOL_DOCS.md
│   └── TCP_PROTOCOL.md
├── docs/                           # Hardware, software, & system architecture docs
│   ├── API.md
│   ├── ARCHITECTURE.md
│   ├── DATA_CONTRACT.md
│   ├── DEVELOPMENT_PHASES.md
│   ├── HARDWARE_WIRING.md
│   ├── architecture.md
│   ├── hardware.md
│   └── software.md
├── esp32/                          # Microcontroller firmware
│   ├── README.md
│   └── firmware/
│       └── smart_motor_monitor/
│           └── smart_motor_monitor.ino
└── frontend/                       # React + Vite Industrial Dashboard
    ├── .env.example
    ├── index.html
    ├── package.json
    ├── vite.config.js
    └── src/                        # React components, charts, services, & Vitest tests
```

---

## 9. Troubleshooting

| Issue | Potential Cause | Recommended Fix |
|---|---|---|
| **ESP32 failed to connect to TCP server** | Laptop IP address changed or Firewall blocking Port 5001 | Check `ipconfig` on laptop, update `BACKEND_HOST` in `smart_motor_monitor.ino`, and allow Port 5001 in Windows Firewall. |
| **DS18B20 reading -127.00°C** | Missing pull-up resistor or faulty wiring | Connect a 4.7kΩ resistor between DS18B20 `DATA` (GPIO 6) and `3.3V`. |
| **INA219 failed to initialize** | Incorrect I2C bus wiring | Verify INA219 SDA is on GPIO 7 and SCL is on GPIO 8. |
| **OLED display blank** | I2C address or bus wiring issue | Ensure OLED SDA is on GPIO 4 and SCL is on GPIO 5. |
| **Motor does not run on `MOTOR_ON` command** | BTS7960 enable pins disabled or 24V power off | Check 24V DC motor power supply, and verify GPIO 17 (R_EN) and GPIO 18 (L_EN) are receiving 3.3V logic HIGH. |
| **RPM reads 0 while motor is spinning** | Magnet gap too large or Hall pin unpulled | Ensure neodymium magnet is within 1–3 mm of A3144 face and GPIO 9 interrupt is configured (`INPUT_PULLUP`). |
