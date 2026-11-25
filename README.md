# TORQVA

Motor monitoring, diagnostics and protected motor control for an ESP32-S3 + BTS7960/IBT-2 rig.

**Physical-device first.** The website opens in physical mode and presents the board connection, telemetry, diagnostics, and direct operator controls. Simulation (the C1-C6 research stack) is a separate mode chosen explicitly in the header. Physical commands remain subject to backend and firmware validation; removing commissioning and blocker screens does not remove device-side protections.

```
React Direct Manual Control -> authenticated FastAPI -> DeviceBridge -> USB serial or TLS WebSocket -> ESP32-S3 -> BTS7960
Sensors and firmware state -> ESP32-S3 -> same device link -> FastAPI -> website WebSocket
```

> **Firmware status.** `firmware/` (PlatformIO) is the **sole supported firmware**. The old `smart_motor_monitor` sketch was retired from the current tree, together with its backend (unauthenticated `/api/motor`, `/api/ingest`, TCP port 5001); they exist only in Git history and must not be recovered, built or uploaded. Old serial text such as `STATUS: MOTOR OFF` is **not** valid TORQVA telemetry; the supported firmware must implement the current TORQVA device protocol.
> **Hardware readiness is unverified; the hardware is not ready for physical motor operation.** Software builds and simulated tests do not prove physical motor operation. Confirm board revision, wiring, driver reset behavior, and firmware protections before applying motor power. See `docs/reports/TORQVA_GAP_AUDIT.md` and `docs/hardware/TORQVA_HARDWARE_READINESS.md`.

## Current project overview

TORQVA combines ESP32-S3 firmware, a Python/FastAPI service, and a React/Vite cockpit. The frontend separates physical-device pages from simulation pages; the app shell owns mode selection and routing. Physical dashboards show device telemetry, command history, diagnostics, and connection tools. Commissioning checklist and blocker panels have been removed from the physical UI and their commissioning API/module has been retired. Device and firmware protections remain independently enforced.

The frontend loads analysis pages, charts, and the 3D Digital Twin on demand. Device state streams over WebSocket with REST reconciliation. The Digital Twin includes a Three.js view and a 2D fallback. Simulation research tools cover detection, prediction, diagnosis, recovery, learning, experiments, workflows, and evaluation.

See [docs/reports/DIRECT_CONTROL_REPORT.md](docs/reports/DIRECT_CONTROL_REPORT.md) for the manual command trace, verification results, and remaining hardware checks.

## Run

```powershell
python -m pip install -r backend/requirements.txt
python -m pip install platformio
cd frontend
npm ci
npm run dev          # starts the backend (127.0.0.1:8000, development token) and the website (http://localhost:5173)
npm run dev:sim      # the same, software only: no port is scanned or opened and no interlock is relaxed
```

> `npm run dev` enables the backend's outbound Wi-Fi device link as well as USB auto-connect. The board also needs the separately configured device-facing TLS gateway and provisioned network settings; see `docs/hardware/WIFI_SETUP_GUIDE.md`. A board must report its real TORQVA handshake and establish an authenticated session before motor commands can be sent. `TORQVA_FORCE_UNLOCK`, `TORQVA_DIRECT_MODE`, and `TORQVA_REMOVE_BLOCKERS` do not enable a bypass.

Plug the board in: the backend connects by itself when exactly one USB-serial board (CH340/CH343, CP210x, FTDI, Espressif) is present. `TORQVA_AUTOCONNECT=0` turns this off and `TORQVA_DEVICE_PORT=COMx` pins one port; otherwise use the Device page.

Backend only: `cd backend && pip install -r requirements.txt && python -m uvicorn main:app --host 127.0.0.1 --port 8000` (set `TORQVA_TOKENS` first; the API fails closed without tokens).

## Direct manual operation

1. Follow the hardware bring-up checklist in [TORQVA_HARDWARE_READINESS.md](docs/hardware/TORQVA_HARDWARE_READINESS.md) with motor power isolated. Provision the device key and load operating limits appropriate for the rig. Only add the firmware build flag `-DTORQVA_ESTOP_INPUT_WIRED=1` to a site-specific profile after verifying the independent cut-off circuit and its separate monitoring input. The stock profiles retain the safe default.
2. Connect the board over the USB connector matching the firmware profile, or provision the Wi-Fi profile using [WIFI_SETUP_GUIDE.md](docs/hardware/WIFI_SETUP_GUIDE.md). For manual USB setup, an administrator can select the port in **Hardware Manager / Connection & Readiness**. After the board handshake and authenticated session, verify that the ESP32 has confirmed the operating limits.
3. Sign in as an operator or administrator and open **Physical / Overview / Direct Manual Control**. Enter a duty percentage and press **START**. While drive is active, apply PWM, set requested RPM, or set the independent ramp-up and ramp-down rates. Ramp settings are in PWM percentage points per second and apply within the firmware's configured cap.
4. Read the command result and device telemetry. **SENT** means the transport accepted the write. **ACKNOWLEDGED** means the ESP32 accepted the request. **EXECUTED** means the ESP32 sent its completion response. Compare device-reported PWM and measured Hall RPM to assess physical motion.
5. Use **STOP MOTOR** to disable the output and coast. The independent emergency-stop circuit remains the physical emergency control. Loss of device telemetry, a device fault, and operator STOP are shown separately.

The existing motor wiring and firmware drive forward only. The RPM request uses the production feedforward duty map. The Hall channel independently reports measured RPM when pulse timing is available.

## Firmware (build and test; uploading is your explicit action)

```powershell
cd firmware
python -m platformio test -e native          # host unit tests
python -m platformio run -e esp32s3_uart     # Serial on UART0 (CH343 / "UART" USB connector)
python -m platformio run -e esp32s3_wireless # production firmware with outbound Wi-Fi link and HTTPS OTA
python -m platformio run -e esp32s3          # Serial on the native USB connector
python -m platformio run -e fitl             # firmware-in-the-loop CLI used by the backend tests
```
Upload: `python -m platformio run -e esp32s3_uart -t upload --upload-port COMx` (stop the backend and close serial monitors first, because the backend holds the port). GPIO map: `firmware/lib/torqva_core/drivers/pinmap.h` (wiring unverified). Details: `firmware/README.md`.

## Tests

```powershell
cd backend  ; python -m pytest -q
cd frontend ; npx vitest run ; npm run build
cd frontend ; node e2e/torqva-app.e2e.mjs      # needs the servers running and Chrome
```

## Layout

- `frontend/` contains the React dashboard, access, device, telemetry and control modules.
- `backend/` contains FastAPI and the direct command, transport, telemetry, safety and access packages.
- `firmware/` builds the ESP32 profiles and host-side firmware tests.
- `config/` holds defaults and explains where runtime configuration is applied.
- `scripts/` contains provisioning, build, development and test utilities.
- `tests/` indexes system verification and hardware acceptance.
- `docs/` contains the architecture, hardware guide, testing, reports and history.

See the [repository map](docs/architecture/REPOSITORY_STRUCTURE.md), [direct control trace](docs/architecture/CONTROL_ARCHITECTURE.md), and [safety inventory](docs/SAFETY_INVENTORY.md). The [reorganization report](REORGANIZATION_REPORT.md) records the file moves and verification results.
