# Software Architecture & Flashing Guide

## 1. System Overview

The system consists of three main software tiers:
1. **ESP32-S3 Firmware** (`esp32/torqva_fw/`, PlatformIO; the sole supported firmware)
2. **FastAPI Backend Server** (`backend/`)
3. **React + Vite Industrial Dashboard** (`frontend/`)

---

## 2. Firmware Prerequisites & PlatformIO Setup

> **Firmware status.** `esp32/torqva_fw/` (PlatformIO) is the **sole supported firmware**. The old `smart_motor_monitor` Arduino sketch was retired from the current tree (it accepted an unauthenticated TCP `MOTOR_ON` and had no interlocks or watchdog); it exists only in Git history and must not be recovered, built or uploaded. Old serial text such as `STATUS: MOTOR OFF` is **not** valid TORQVA telemetry: the supported firmware must implement the current TORQVA device protocol. **The hardware is not ready for physical motor operation** until the remaining safety requirements in `docs/TORQVA_HARDWARE_READINESS.md` are met.


### Libraries
PlatformIO fetches the libraries declared in `esp32/torqva_fw/platformio.ini` (Adafruit INA219, OneWire, DallasTemperature, U8g2). Nothing is installed by hand.

### Build and test (no upload):
```powershell
cd esp32/torqva_fw
python -m platformio test -e native          # host unit tests
python -m platformio run -e esp32s3_uart     # Serial on UART0, reached through the USB-to-serial (CH343) connector
python -m platformio run -e esp32s3          # Serial on the native USB CDC connector
python -m platformio run -e fitl             # firmware-in-the-loop CLI used by the backend contract tests
```
The two device environments differ only in which port carries `Serial`; they are deliberately not merged. Uploading is a separate, explicitly authorised step (pre-flash checks in `docs/TORQVA_HARDWARE_READINESS.md`); there is no Wi-Fi configuration in the firmware, and the device talks to the backend over USB serial (Device page).

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
