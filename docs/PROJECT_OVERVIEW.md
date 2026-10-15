# TORQVA — Project Overview (context brief)

> Written so the whole project can be understood from this one file, for example by pasting it into an AI assistant before discussing or planning work.
> State as of 14 Oct 2026, branch `torqva/phase-0-audit` (GitHub `PrasadBant/TORQVA`). Facts below come from the code and tests in the repository.

---

## 1. What TORQVA is

TORQVA is a **"physical AI" platform for an electric DC motor test rig**. It reads sensors on a real motor through an ESP32-S3 board, shows the readings live in a web app, detects anomalies, ranks likely faults, predicts what a corrective action would do, recommends actions through a safety layer, and verifies whether the motor actually recovered.

Its guiding principles (enforced by tests):
- **Physical-device first.** The website opens in *Physical mode* and shows the real board. *Simulation mode* is a separate, explicitly chosen demo mode.
- **Never invent data.** A missing or invalid sensor reads `UNAVAILABLE`, never 0. Simulated values are labelled `SIM`, measured `HW`/`MEASURED`, model outputs `PRED`/`DERIVED`.
- **Safety before convenience.** Every motor command goes through authentication → role check → deterministic Safety Supervisor → commissioning and interlocks → firmware validation → device acknowledgement. An AI result can never authorise motion by itself.
- **Honest status.** "Sent" is not "executed"; only a device acknowledgement counts. Hardware checks are never marked VERIFIED by software.

**Current reality:** the hardware is **not ready for physical motor operation**. The AI layers (C1–C6) are developed and evaluated **in simulation only**; nothing has been validated on the physical motor yet.

It began on 10 Oct 2026 as a rework of an older prototype called *Smart Motor Monitor* (Arduino sketch + TCP `MOTOR_ON/OFF` + simple dashboard), which is now **retired** and removed from the tree.

---

## 2. Hardware (the rig)

| Part | Role | ESP32-S3 GPIO |
|---|---|---|
| ESP32-S3 N16R8 | Controller, runs `esp32/torqva_fw` | — |
| BTS7960 / IBT-2 | Motor driver (forward only: firmware never drives LPWM) | R_EN 18, L_EN 21, RPWM 38, LPWM 39 |
| Hall sensor | Speed (rpm) | 9 |
| INA219 | Current / voltage (separate I²C bus) | SDA 7, SCL 8 |
| DS18B20 | Housing temperature (2nd sensor = ambient) | 6 |
| ADXL345 | Raw acceleration (total incl. gravity — **not** vibration RMS) | SDA 16, SCL 17 |
| SH1106 OLED | Display, annunciation only | SDA 4, SCL 5 |
| LEDs, buzzer | Status annunciators (not safety functions) | 10–13, 14 |
| E-stop monitor input | Normally-closed contact, monitoring only | 15 |

Not present / not configured: motor power relay, local reset button. The wiring is **unconfirmed** by a person (status frames report the wiring id as unverified). An independent hardware E-stop that removes driver power is designed but **not installed or verified**.

Connection: **USB serial** (CH340/CH343, CP210x, FTDI or native USB), TORQVA device protocol version 1 (JSON lines: `status`, `fast` telemetry, commands with acknowledgements). The backend owns the serial port; the browser never touches it.

---

## 3. Architecture

```
sensors -> ESP32-S3 firmware (esp32/torqva_fw) -> USB serial (TORQVA protocol 1) -> Python backend (FastAPI) -> REST + WebSocket -> React website
website -> authenticated API -> role check -> Safety Supervisor -> command dispatcher -> USB -> firmware validation -> acknowledgement -> observed state
```

Two separate data paths in the backend:
1. **Physical path** — `serial_bridge.py` reads the board, keeps a device snapshot, runs interlocks and the command lifecycle; served at `/api/torqva/device/*` and the WebSocket `/api/torqva/ws`.
2. **Simulation path** — `service.py` runs a deterministic motor simulator (`sim.py`) through the full AI pipeline (`pipeline.py`); served at `/api/torqva/status`, `/telemetry`, `/incidents`, `/predictions`, … Everything here is labelled `SIMULATED`.

### The AI layers (C1–C6)
| Layer | Module | What it does |
|---|---|---|
| **C1** Anomaly detection | `detection.py` | Self-learning baseline per operating-speed bin; anomaly score ÷ learned threshold |
| Hypotheses | `hypotheses.py` | Ranks fault hypotheses (imbalance, looseness, overload, cooling failure, supply voltage, sensor fault) |
| **C2** Predictions | `prediction.py` | Predicts the outcome of candidate actions at 30/60/120 s with 90 % conformal intervals; *unvalidated against physical experiments* |
| **C3** Decision gate | `gate.py` | Deterministic, confidence-aware rules decide ACT / REQUEST_MORE_DATA / RUN_DIAGNOSTIC_TEST / SAFE_STOP / ESCALATE_HUMAN / SENSOR_UNRELIABLE; every decision logs its inputs |
| **C4** Diagnostic tests | `diagnostics.py` | Tests T1 (speed step to 70 %), T3 (thermal observation), T4 (coast-down) chosen by information gain to separate hypotheses |
| **C5** Recovery verification | `recovery.py` | Declares recovery only from fresh telemetry after the device acknowledged an action |
| **C6** Learning | `learning.py`, `attestation.py` | Gated, versioned learning; operator-attested healthy reference for adaptive C1 |
| Safety Supervisor | `supervisor.py` | Deterministic (no ML), mints the only actions the dispatcher accepts |

For **physical** data, the backend currently reports every analysis layer as **NOT AVAILABLE** (C1 was trained on simulated data and needs vibration RMS and harmonics the firmware doesn't measure). The UI shows "WAITING FOR VALID PHYSICAL TELEMETRY" instead of results.

### Firmware safety model (`esp32/torqva_fw`)
Safety monitor with trips: over-current (sustained/instant), temperature stop/rise, vibration, rpm loss, voltage low/high, heartbeat lost, sensor invalid → latched EMERGENCY_STOP. Start interlocks require approved limits, E-stop circuit, authenticated session, and the explicit `TORQVA_CONTROL_ENABLED` build flag. Default limits: max duty 70 %, max rpm 3000, max voltage 28 V. PlatformIO environments: `native` (host unit tests), `fitl` (firmware-in-the-loop CLI used by backend tests), `esp32s3` (native USB), `esp32s3_uart` (UART0).

### Users and roles
Token-based auth (`TORQVA_TOKENS`, sha256 hashes; the API refuses everything if unset). Roles: **viewer** (read only, can request STOP), **operator** (start simulations, approve/reject proposed actions), **admin** (also physical START / speed, commissioning record, audit log). STOP is open to every signed-in role.

### Commissioning
A human record (`commissioning.py`): checklist items attested with written evidence, approved limits (versioned, history kept, confirm phrase required) and an explicit enable. It is audited and **never overrides the firmware interlocks**.

---

## 4. Tech stack

- **Frontend:** React 18, Vite 5, Recharts 2 (charts, lazy-loaded), lucide-react icons, Vitest + Testing Library. Light/dark theme design system in one CSS file.
- **Backend:** Python, FastAPI + uvicorn, pydantic 2, numpy, pyserial, SQLite document store, pytest.
- **Firmware:** C++ (Arduino framework) via PlatformIO, host-tested core library `lib/torqva_core`.
- **E2E:** playwright-core driving Google Chrome (opt-in scripts, not a project dependency).

---

## 5. Repository layout

```
README.md                      run / test / layout
backend/
  main.py                      FastAPI entry point (mounts /api/torqva)
  README.md                    module map by responsibility
  torqva/                      one flat Python package (42 modules):
                               API & wiring · physical device & safety · AI pipeline C1–C6 · simulation · research studies
  tests/                       pytest (≈650 tests; files numbered by phase p11…p29); never opens a real port
  tools/provision_device_key.py   per-device session key (offline)
  data/                        local runtime data (git-ignored): commissioning.json, device_keys.json
frontend/
  scripts/dev.mjs              starts backend + website together
  src/torqva/TorqvaApp.jsx     app shell: sign-in, mode switch, navigation, polling
  src/torqva/api.js            REST client (reads time out after 20 s; commands never do)
  src/torqva/torqva.css        design system (tokens, light/dark)
  src/torqva/shared/           UI primitives (components.jsx), charts (charts.jsx via lazyCharts.jsx), Digital Twin workspace (twin.jsx) and rig drawing (twinModel.jsx)
  src/torqva/physical/         pages fed by the USB device stream: physical.jsx (dashboard), device.jsx (connection, motor control, commissioning), twin.jsx (Digital Twin data, read-only)
  src/torqva/simulation/       pages fed by the simulator API: pages.jsx (C1–C6 pages), c2c4.jsx, evaluation.jsx, lab.jsx, attestation.jsx, twin.jsx (Digital Twin data)
  src/tests/                   Vitest suites (125 tests), incl. a layout guard
  e2e/                         browser E2E scripts
esp32/torqva_fw/               supported firmware (platformio.ini, src/main.cpp, lib/torqva_core, tests)
docs/
  README.md                    index of current docs
  TORQVA_*.md                  gap audit, hardware readiness, progress, architecture, security, wiring, E-stop, bring-up checklist, simulation evaluation
  eval/                        committed evaluation artifacts (read by the backend at runtime)
  history/                     retired Smart Motor Monitor reports (record only)
```

Rule kept by a test: `physical/` and `simulation/` never import each other (only `shared/` and `api.js`), so simulated data cannot leak into a physical-device page.

---

## 6. How to run and test (Windows, PowerShell)

```powershell
cd frontend
npm install
npm run dev:sim     # SAFE, software only: backend + website, no USB port scanned or opened
npm run dev         # with hardware: connects when exactly one board is plugged in; never unlocks interlocks or assumes a port
# website: http://localhost:5173 (signs in automatically in development as local-dev / admin)
# backend: http://127.0.0.1:8000/api/torqva

npx vitest run      # frontend tests (100)
npm run build       # production build
node e2e/torqva-app.e2e.mjs        # browser E2E against a running dev server (63 checks)

cd ../backend
pip install -r requirements.txt
python -m pytest -q                # backend tests

cd ../esp32/torqva_fw
python -m platformio test -e native      # firmware host tests (uploading is always a deliberate manual step)
```

---

## 7. The website

Navigation groups: **Dashboard** (Overview, Live Monitor, Digital Twin) · **Diagnostics** (AI Diagnostics C1, Diagnostic Tests C4) · **Predictions** (Predictions C2, Interventions C3) · **Recovery and History** (Recovery C5, Learning C6, Evaluation) · **Device Setup and Commissioning** (Device, Motor Control / Safety & Commissioning, Lab, Devices & Settings).

- **Physical mode (default):** status strip (connection, sensors, safety, motion), live measurement tiles, motor control panel (STOP always prominent; START/speed locked by named blockers), speed status with alarm, device history charts. AI pages show the honest waiting state.
- **Simulation mode (demo):** start a scenario with an injected fault (severity, optional human approval), run/pause, and watch the full C1→C6 pipeline: anomaly scores, hypotheses, gate decisions, predictions, diagnostic tests, approvals, device acknowledgements, recovery verdicts. Everything is labelled SIMULATION.
- Evaluation shows the committed simulation evaluation runs, always labelled as simulation evidence.
- **Digital Twin:** an illustrative (not CAD-accurate) 2.5D drawing of the rig with a selectable hotspot per part (Hall speed, DS18B20, INA219, ADXL345, BTS7960, ESP32-S3), a detail panel with each reading's value, provenance (SIM / HW / DERIVED / CMD), freshness and trend, and the key readings. It shows only what the simulator API or the device stream reports (missing = UNAVAILABLE, never 0), animates the shaft only from a valid, current, non-zero speed (at 1/40 rate, presentation only), and sends no commands. Loaded on demand.
- Responsive (desktop to phone, drawer navigation below 860 px), light and dark themes, collapsible sidebar.

---

## 8. Main API routes (`/api/torqva`, bearer token required)

- **Identity & audit:** `GET /me`, `GET /audit` (admin)
- **Simulation pipeline:** `GET /status /telemetry /incidents /decisions /predictions /prediction-checks /commands /outcomes /cases /log`; `POST /simulation/start`, `/simulation/step`, `/approvals/approve`, `/approvals/reject`, `/commands/stop`, `/commands/reset-estop`
- **Evaluation:** `GET /evaluation/latest`, `/evaluation/c2c4`
- **Lab:** `/lab/regimes`, `/lab/checklist`, `/lab/sessions…` (create, checklist, run, reveal, reproduce), `/lab/experiments`
- **Attestation (C6):** `/attestation/candidates…`, `/attestation/references…`, `/attestation/warmup…`
- **Physical device:** `GET /device/status /device/history /device/ports /device/commands`; `POST /device/connect /device/disconnect /device/commands` (STOP / START / SET_SPEED); commissioning `GET /device/commissioning`, `POST /device/commissioning/items/{id}`, `PUT /device/commissioning/limits`, `POST /device/commissioning/enable`; WebSocket `/ws`

---

## 9. What was done recently (Oct 2026)

1. **UI/UX redesign** (committed and pushed, `7459daf`): new design system with refined light and dark themes, new shell/navigation (collapsible, mobile drawer), dashboards, charts, sign-in page.
2. **Engineering pass (uncommitted):** removed fabricated behaviour introduced by earlier commits:
   - Diagnostic Tests page showed canned results and sent real START/SET_SPEED/STOP commands → now read-only, shows only backend results.
   - Predictions page invented "hardware-verified" candidates with execute buttons → now backend predictions only, no motor buttons.
   - Backend fed invented readings (fixed 24 V, default temperatures, made-up vibration) into the AI as MEASURED and marked all layers ACTIVE → restored honest behaviour.
   - Evaluation relabelled simulation as hardware-validated → fixed; hard-coded "COM7" claims removed; a fake hardware "Emergency Coast Stop" (it only stopped the simulator) removed.
   - Restored the missing speed input on Motor Control; commissioning form no longer submits hidden voltage limits or blank-as-zero values.
   - Added a 20 s read timeout, fixed header overflow at tablet widths, and lazy-loaded charts (initial JavaScript 750 kB → 322 kB).
   - Added `npm run dev:sim` (safe software-only development).
3. **Repository restructure (uncommitted):** frontend grouped into `shared/`, `physical/`, `simulation/`; retired docs moved to `docs/history/`; READMEs and a docs index added. Backend package kept flat on purpose.

Test status: frontend 100/100, E2E 63/63, backend 642 passed / 5 failed (the 5 are firmware checks, see below).

---

## 10. Known issues and open decisions

1. **Fixed (14 Oct):** `npm run dev` no longer sets `TORQVA_FORCE_UNLOCK=1` or opens COM7. The backend still honours the flag if someone sets it by hand (it bypasses commissioning, the session check and Supervisor refusals), so never set it.
2. **Firmware protections were relaxed in an earlier commit** (`319fb7b`): over-current/voltage/stall/heartbeat protections loosened, E-stop auto-resets on command, authentication skipped, brown-out detection off, instant "COMPLETED" acks. The 5 failing backend tests are exactly these firmware safety checks. Needs a decision before any physical run.
3. Backend commissioning API silently defaults voltage limits to 0–26 V when omitted; device autoconnect retries every 1 s (was 5 s).
4. The speed status bands (normal 1100–1500 rpm around 1300) are a display choice, not approved limits.
5. Physical AI is not possible yet: C1 needs vibration RMS and shaft-order harmonics the firmware doesn't compute; no physical baseline or held-out evaluation exists.
6. Hardware readiness gaps: wiring unconfirmed, independent E-stop not installed, no secure (encrypted) device transport, no relay or reset button.
7. Cleanup candidates (not deleted): empty `assets/` folder, legacy `backend/data/motor_monitor.db`, stale `frontend/e2e/torqva.e2e.mjs`, legacy package name `smart-motor-monitor-frontend`.
8. Uncommitted work: the engineering pass and restructure are not committed yet.

## 11. Likely next steps

- Decide on items 1–2 (restore firmware protections; make `npm run dev` safe by default), then commit the pending work.
- Hardware bring-up following `docs/TORQVA_HARDWARE_BRINGUP_CHECKLIST.md`: confirm wiring, install and verify the E-stop, commission limits, authenticated session.
- Physical data path for AI: compute vibration RMS / harmonics in firmware, record labelled physical sessions, fit and evaluate C1 on real data, then C2/C4 matched-condition experiments.
- Optional: CI workflow (tests + build), TypeScript migration of the frontend API layer.

## 12. Glossary

- **Provenance badges:** `SIM` simulated · `HW`/`MEASURED` from the device · `PRED` prediction · `DERIVED` computed from other values.
- **Incident:** an anomaly episode tracked by a state machine from detection to recovery or closure.
- **FITL:** firmware-in-the-loop — the real firmware core compiled for the host and driven by backend tests.
- **Interlock / blocker:** a named condition that keeps physical START/speed refused (e.g. DEVICE NOT CONNECTED, SAFETY LIMITS NOT APPROVED).
- **Commissioning:** the human, evidence-backed record that approves limits and enables physical control.
