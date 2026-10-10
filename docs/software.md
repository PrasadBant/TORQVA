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

> **Firmware status:** the supported firmware is `esp32/torqva_fw`; motor commands are refused by default (commissioning interlocks, no secured transport yet). See `docs/TORQVA_HARDWARE_READINESS.md` for the current blockers. Physical operation is prohibited until they are closed.

> **Device transport:** a secure transport foundation exists in the backend (`backend/torqva/device_transport.py`, protocol `tqv1`) and is tested with a Python device stand-in. No firmware network client exists and nothing is wired into live dispatch; see `docs/TORQVA_HARDWARE_READINESS.md` (Phase 15B).

> **USB device bridge:** an admin can connect an ESP32 from the Device page; the backend owns the serial port and streams telemetry over a read-only WebSocket. Only STOP can be sent; START and speed commands are blocked (see `docs/TORQVA_HARDWARE_READINESS.md`, Phase 16). Without a device the app stays in SIMULATION.

## Troubleshooting: "Access is denied" when connecting a serial port (Windows)

`PermissionError(13, 'Access is denied.', None, 5)` means **Windows refused to open the port**: another program already has it open, or the account lacks permission. It does not say which program. Observed case (COM7, USB-Enhanced-SERIAL CH343): with TORQVA fully stopped, a standalone `serial.Serial("COM7")` failed identically, and a read-only handle scan found the Arduino IDE helper `serial-monitor.exe` holding `\Device\Serial2`, which `HKLM\HARDWARE\DEVICEMAP\SERIALCOMM` maps to COM7. Closing the Serial Monitor panel is often not enough: **quit the Arduino IDE** (or disconnect its monitor), then press Connect again. The same applies to PlatformIO/VS Code monitors, PuTTY and Tera Term. TORQVA never kills processes; the Device page shows the exact error, recovery steps and "possible holders" (a hint, not proof).
Opening a port can reset an ESP32 board through the USB control lines; a board that has just reset needs a few seconds before it sends frames. "Port opened, waiting for the device handshake" means the port opened but no valid TORQVA status frame (wire protocol 1) has arrived yet; a connected WebSocket says nothing about USB.
