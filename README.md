# TORQVA

Motor monitoring, diagnostics and protected motor control for an ESP32-S3 + BTS7960/IBT-2 rig.

**Physical-device first.** The website opens in physical mode: it shows the real board's connection, handshake, sensors and faults, and it controls the motor only through the authorised command path. Simulation (the C1-C6 research stack) is a separate mode chosen explicitly in the header.

```
sensors -> ESP32-S3 firmware (esp32/torqva_fw) -> USB serial (TORQVA protocol 1) -> Python backend -> REST + WebSocket -> React website
website -> authenticated API -> role check -> Safety Supervisor -> command dispatcher -> USB -> firmware validation -> acknowledgement -> observed state
```

> **Firmware status.** `esp32/torqva_fw/` (PlatformIO) is the **sole supported firmware**. The old `smart_motor_monitor` sketch was retired from the current tree, together with its backend (unauthenticated `/api/motor`, `/api/ingest`, TCP port 5001); they exist only in Git history and must not be recovered, built or uploaded. Old serial text such as `STATUS: MOTOR OFF` is **not** valid TORQVA telemetry; the supported firmware must implement the current TORQVA device protocol.
> **The hardware is not ready for physical motor operation.** START and speed stay locked until the firmware's own protections are satisfied (approved limits, an E-stop, an authenticated session, reset-safe driver). STOP and live readings work whenever a TORQVA board is connected. The exact remaining work is in `docs/TORQVA_GAP_AUDIT.md` and `docs/TORQVA_HARDWARE_READINESS.md`.

## Run

```powershell
cd frontend
npm install
npm run dev          # starts the backend (127.0.0.1:8000, development token) and the website (http://localhost:5173)
npm run dev:sim      # the same, software only: no port is scanned or opened and no interlock is relaxed
```

> Neither command sets `TORQVA_FORCE_UNLOCK` or assumes a COM port. `npm run dev` connects only when exactly one TORQVA board is plugged in (or to `TORQVA_DEVICE_PORT` if you set it), and START / speed stay refused until the firmware interlocks, the commissioning record and the Safety Supervisor allow them. If you have set `TORQVA_FORCE_UNLOCK=1` in your own shell, the script warns: it bypasses those checks.

Plug the board in: the backend connects by itself when exactly one USB-serial board (CH340/CH343, CP210x, FTDI, Espressif) is present. `TORQVA_AUTOCONNECT=0` turns this off and `TORQVA_DEVICE_PORT=COMx` pins one port; otherwise use the Device page.

Backend only: `cd backend && pip install -r requirements.txt && python -m uvicorn main:app --host 127.0.0.1 --port 8000` (set `TORQVA_TOKENS` first; the API fails closed without tokens).

## Firmware (build and test; uploading is your explicit action)

```powershell
cd esp32/torqva_fw
python -m platformio test -e native          # host unit tests
python -m platformio run -e esp32s3_uart     # Serial on UART0 (CH343 / "UART" USB connector)
python -m platformio run -e esp32s3          # Serial on the native USB connector
python -m platformio run -e fitl             # firmware-in-the-loop CLI used by the backend tests
```
Upload: `python -m platformio run -e esp32s3_uart -t upload --upload-port COMx` (stop the backend and close serial monitors first, because the backend holds the port). GPIO map: `esp32/torqva_fw/lib/torqva_core/pinmap.h` (wiring unverified). Details: `esp32/README.md`.

## Tests

```powershell
cd backend  ; python -m pytest -q
cd frontend ; npx vitest run ; npm run build
cd frontend ; node e2e/torqva-app.e2e.mjs      # needs the servers running and Chrome
```

## Layout

| Path | Purpose |
|---|---|
| `esp32/torqva_fw/` | Supported firmware: sensors, protocol, safety monitor, start interlocks, authenticated sessions |
| `backend/main.py` | Entry point (TORQVA API only) |
| `backend/torqva/` | API, USB serial bridge, Safety Supervisor, commissioning record, C1-C6 simulation stack. Module map: [`backend/README.md`](backend/README.md) |
| `frontend/src/torqva/TorqvaApp.jsx` | App shell: sign-in, mode switch, navigation, polling. `api.js` is the REST client, `torqva.css` the design system |
| `frontend/src/torqva/physical/` | Physical-device pages fed by the USB device stream (`physical.jsx` dashboard, `device.jsx` connection, motor control, commissioning) |
| `frontend/src/torqva/simulation/` | Pages fed by the simulator API (`pages.jsx` C1-C6 pages, `c2c4.jsx`, `evaluation.jsx`, `lab.jsx`, `attestation.jsx`) |
| `frontend/src/torqva/shared/` | UI primitives (`components.jsx`) and charts (`charts.jsx`, loaded on demand through `lazyCharts.jsx`) |
| `frontend/src/tests/`, `frontend/e2e/` | Unit/component tests (Vitest) and opt-in browser E2E scripts |
| `docs/` | Current documentation, indexed in [`docs/README.md`](docs/README.md); `docs/eval/` holds evaluation artifacts read by the backend; `docs/history/` holds retired reports |

`physical/` and `simulation/` never import each other: both depend only on `shared/` and `api.js`, and `TorqvaApp.jsx` is the one place that combines them. Keep it that way so simulated data cannot leak into a physical-device page.
