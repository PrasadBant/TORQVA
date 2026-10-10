# System Architecture & Development Stages Roadmap

## 1. Multi-Stage Development Strategy

The Smart Motor Condition Monitoring & Control System is structured into three clear stages:

```
                                SYSTEM STAGES
┌─────────────────────────────────────────────────────────────────────────────┐
│ STAGE 1: TCP COMMUNICATION                                                  │
│ - ESP32-S3 connects to Wi-Fi LAN & Backend TCP Socket (Port 5001)           │
│ - Streams 1Hz telemetry (Temperature, Current, Voltage, Power, Vibration,    │
│   RPM, Sensor Health, Motor Condition)                                      │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ STAGE 2: DASHBOARD MOTOR ON/OFF CONTROL                                     │
│ - Dashboard sends MOTOR_ON / MOTOR_OFF commands                             │
│ - Backend dispatches commands over TCP to ESP32-S3                          │
│ - ESP32 actuates BTS7960 Motor Driver via GPIO 15, 16, 17, 18 & returns ACK  │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ STAGE 3: LIVE RPM GRAPH                                                     │
│ - A3144 Hall-effect interrupt tracks shaft rotational speed                  │
│ - ESP32 streams exact RPM over TCP -> Backend -> WebSocket -> Dashboard      │
│ - Dashboard renders live time-series RPM trend line                         │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Telemetry & Data Ingestion Flow

```
+----------------+      TCP (Port 5001)      +------------------+
|    ESP32-S3    | ------------------------> |  FastAPI Backend |
+----------------+                           +------------------+
        │                                             │
        │ Sensor Read                                 ├─► SQLite DB (`data/motor_monitor.db`)
        ▼                                             ├─► Predictive Health Engine
  [ADXL345, INA219,                                   │
   DS18B20, A3144]                                    │ WebSocket Broadcast (/ws)
                                                      ▼
                                             +------------------+
                                             | React Dashboard  |
                                             +------------------+
```

---

## 3. Motor Driver Command Flow

```
[ React Dashboard Toggle ]
           │
           │ HTTP POST /api/motor/control
           ▼
[ FastAPI Backend Server ]
           │
           │ TCP Socket ASCII String: `MOTOR_ON\n` or `MOTOR_OFF\n`
           ▼
[ ESP32-S3 Microcontroller ]
           │
           │ Logic Control (3.3V)
           ├─► GPIO 15 (RPWM)
           ├─► GPIO 16 (LPWM)
           ├─► GPIO 17 (R_EN)
           └─► GPIO 18 (L_EN)
           │
           ▼
[ BTS7960 High-Power Motor Driver ]
           │
           │ High Current (24V DC Rail)
           ▼
[ RS-775 DC Motor ]
```

---

## 4. Live RPM Time-Series Stream

```
[ A3144 Hall Sensor ] --(GPIO 9 Interrupt)--> [ ESP32-S3 RPM Counter ]
                                                      │
                                                      │ TCP Payload (JSON)
                                                      ▼
[ React Recharts Dashboard ] <--(WebSocket /ws)-- [ Backend Server ]
```
