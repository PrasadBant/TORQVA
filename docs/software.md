# Software Architecture & Flashing Guide

## 1. System Overview

The system consists of three main software tiers:
1. **ESP32-S3 Firmware** (`esp32/firmware/smart_motor_monitor/smart_motor_monitor.ino`)
2. **FastAPI Backend Server** (`backend/`)
3. **React + Vite Industrial Dashboard** (`frontend/`)

---

## 2. Firmware Prerequisites & Arduino IDE Setup

> **WARNING - the legacy sketch is quarantined.** `smart_motor_monitor.ino` accepts an unauthenticated TCP `MOTOR_ON` and energises the motor with no interlocks or watchdog.
> It will not compile unless `TORQVA_LEGACY_UNSAFE_ACKNOWLEDGED` is defined, and must not be uploaded to a rig with motor power connected. The supported firmware is
> `esp32/torqva_fw` (PlatformIO). See `esp32/firmware/README_LEGACY_UNSAFE.md` and `docs/TORQVA_HARDWARE_READINESS.md`.


### Required Arduino Libraries:
- **`ArduinoJson`** (v6.x or v7.x)
- **`Adafruit ADXL345`**
- **`Adafruit Unified Sensor`**
- **`Adafruit INA219`**
- **`DallasTemperature`**
- **`OneWire`**
- **`U8g2`** (For SH1106 OLED display)

### Compilation & Upload Steps:
1. Open `esp32/firmware/smart_motor_monitor/smart_motor_monitor.ino` in Arduino IDE.
2. Set Board to **ESP32S3 Dev Module**.
3. Configure Wi-Fi Credentials & Host IP in `smart_motor_monitor.ino`:
   ```cpp
   const char* WIFI_SSID    = "YOUR_WIFI_SSID";
   const char* WIFI_PASS    = "YOUR_WIFI_PASSWORD";
   const char* BACKEND_HOST = "192.168.X.X"; // Host laptop IP
   ```
4. Upload firmware to ESP32-S3 (`Ctrl+U`).

---

## 3. Backend Prerequisites & Execution

### Prerequisites:
- Python 3.10+
- Install dependencies:
  ```powershell
  cd backend
  pip install -r requirements.txt
  ```

### Start Backend Server:
```powershell
cd backend
python -m uvicorn main:app --reload --host 0.0.0.0 --port 8000
```
- Swagger API Docs: `http://localhost:8000/docs`
- TCP Server automatically listens on Port `5001`.

### Run Pytest Test Suite:
```powershell
python -m pytest backend/tests -v
```

---

## 4. Frontend Dashboard Prerequisites & Execution

### Prerequisites:
- Node.js (v18+) & npm

### Start Frontend Dev Server:
```powershell
cd frontend
npm install
npm run dev
```
- Open browser at `http://localhost:5173`.

### Run Vitest Component & Unit Tests:
```powershell
cd frontend
npm test
```
