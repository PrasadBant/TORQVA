# TORQVA — Complete Project Overview

> **Last updated:** 16 Nov 2026 · Branch `torqva/phase-0-audit` · Commit `8b4ac16` · GitHub `PrasadBant/TORQVA`
>
> This single file captures everything about the project: what it is, how it works, the full tech stack, hardware, firmware, backend, frontend, AI pipeline, test suite, API surface, and development status. Use it as the canonical briefing document.

---

## 1. What TORQVA Is

TORQVA is a **physical-AI platform for a DC motor test rig**. It reads live sensors on a real RS-775 motor through an ESP32-S3 board, streams the data to a React web app, runs a full AI diagnostic pipeline (anomaly detection → fault hypothesis ranking → outcome prediction → decision gate → diagnostic tests → recovery verification → continuous learning), and allows an authenticated operator to issue motor commands through a multi-layer safety stack.

### Core Design Principles

| Principle | What it means in practice |
|---|---|
| **Physical-device first** | App opens in Physical mode; Simulation is an explicit, labelled opt-in |
| **Never invent data** | Missing/invalid sensors show `UNAVAILABLE`, never `0`; every value carries a provenance badge (`MEASURED`, `DERIVED`, `SIM`, `CMD`, `PRED`) |
| **Safety before convenience** | Every motor command: auth → role check → Safety Supervisor → commissioning → firmware validation → ack. AI never authorises motion alone |
| **Honest status** | "Sent" ≠ "Executed". Only a device ack counts. Hardware items are never marked VERIFIED by software |
| **Architectural isolation** | `physical/` and `simulation/` frontend pages never import each other; only `shared/` and `api.js` are shared |

### What Works Today (Nov 2026)

- **Physical mode**: live USB telemetry, full motor control (duty cycle + RPM setpoint), Hall-sensor tachometer (measurement only, never throttles motor), speed zone alarm, digital twin 3D view, firmware OTA manager
- **Simulation mode**: full C1–C6 AI pipeline, analyst workspaces, scenario studio, counterfactual lab, decision receipts, attestation
- **Both modes**: Diagnostic Workflow (one-click test → evidence → diagnosis → recommendation → authorize → verify), Recovery Verification (C5), Continuous Intelligence (C6), Performance Evaluation

### What Is NOT Ready

- Hardware E-stop circuit (designed but not installed or verified)
- Physical C1 anomaly detection (trained on sim data; needs vibration RMS/harmonics the firmware doesn't yet measure)
- Physical motor operation on the real rig beyond basic duty/speed commands (commissioning record must be completed by a human first)

---

## 2. Hardware

### Motor Rig Components

| Part | Role | ESP32-S3 GPIO |
|---|---|---|
| **ESP32-S3 N16R8** | Main controller | — |
| **BTS7960 / IBT-2** | Motor driver (43 A, forward only; LPWM never driven) | R_EN 18, L_EN 21, RPWM 38, LPWM 39 |
| **A3144 Hall sensor** | Shaft speed (rpm) via pulse timing — tachometer only, does not throttle motor | GPIO 9 |
| **INA219** | DC bus voltage, current, power (W = V × I, labelled DERIVED) | SDA 7, SCL 8 (I²C bus 1) |
| **DS18B20** | Motor housing temperature; second sensor = ambient (optional) | GPIO 6 (OneWire, 4.7 kΩ pull-up) |
| **ADXL345** | Raw 3-axis acceleration (total incl. gravity — not vibration RMS) | SDA 16, SCL 17 (I²C bus 0) |
| **SH1106 OLED** | Local 128×64 status display | SDA 4, SCL 5 (I²C bus 0) |
| **LEDs (×4), Buzzer** | Sensor health annunciators (not safety functions) | GPIO 10–13, 14 |
| **E-stop monitor input** | Normally-closed contact, monitoring only (not installed) | GPIO 15 |

> [!IMPORTANT]
> The authoritative GPIO map is `esp32/torqva_fw/lib/torqva_core/pinmap.h`. The file `docs/hardware.md` shows an older revision and can disagree with `pinmap.h`. Where they differ, **`pinmap.h` wins**.

### Connection

USB serial (CH340/CH343, CP210x, FTDI, or native USB-CDC). The backend owns the serial port; the browser never touches it. Auto-connect activates when exactly one supported USB-serial device is present.

---

## 3. System Architecture

```
sensors → ESP32-S3 firmware (esp32/torqva_fw)
        → USB serial (TORQVA protocol v1, JSON lines)
        → Python backend (FastAPI, serial_bridge.py)
        → REST + WebSocket (/api/torqva/*)
        → React website (Vite, http://localhost:5173)

website → authenticated API → role check → Safety Supervisor
        → command dispatcher → USB → firmware validation
        → ACK → observed state
```

### Two Completely Separate Data Paths

| Path | Source | Key module | Served at |
|---|---|---|---|
| **Physical** | Real ESP32-S3 board | `serial_bridge.py` | `/api/torqva/device/*`, WebSocket `/api/torqva/ws` |
| **Simulation** | Deterministic motor simulator | `service.py`, `sim.py`, `pipeline.py` | `/api/torqva/status`, `/telemetry`, `/incidents`, … |

A third path handles **firmware updates** (OTA): `firmware.py` stores signed images; the ESP32 downloads over HTTPS, verifies ECDSA + SHA-256, restarts, confirms after self-tests or rolls back automatically.

### AI Layers (C1–C6)

| Layer | Module | What it does |
|---|---|---|
| **C1** Anomaly detection | `detection.py` | Per-speed-bin self-learning baseline; Mahalanobis anomaly score ÷ learned threshold |
| **C1 Robust** (opt-in) | `c1_robust.py` | Adaptive baseline with trusted warm-up attestation; `UNFAMILIAR` verdict; default off |
| **Hypotheses** | `hypotheses.py` | Bayesian ranking of 6 fault types: imbalance, looseness, overload, cooling failure, supply voltage, sensor fault |
| **C2** Outcome prediction | `prediction.py` | Grey-box action-conditioned predictors; split-conformal 90% intervals; risk score |
| **C2 Noise-aware** (opt-in) | `c2_robust.py` | Same point predictions; noise-aware intervals; explicit supported/unsupported/insufficiently-validated |
| **C3** Decision gate | `gate.py` | Deterministic confidence-aware rules: ACT / REQUEST_MORE_DATA / RUN_DIAGNOSTIC_TEST / SAFE_STOP / ESCALATE_HUMAN / SENSOR_UNRELIABLE |
| **C4** Diagnostic tests | `diagnostics.py` | T1 (speed step to 70%), T3 (thermal observation), T4 (coast-down); selected by information gain |
| **C5** Recovery verification | `recovery.py` | Declares recovery only from fresh telemetry after device acknowledged an action |
| **C6** Learning / attestation | `learning.py`, `attestation.py` | Gated versioned learning; operator-attested healthy references for adaptive C1 |
| **Safety Supervisor** | `supervisor.py` | Deterministic, no ML; mints the only actions the dispatcher accepts |
| **Unified workflow** | `workflow.py` | Chains C4→C1→C2→C3→C5 in one request; physical mode blocked at validation |

> [!NOTE]
> C1–C6 are developed and evaluated **in simulation only**. Physical AI analysis shows "WAITING FOR VALID PHYSICAL TELEMETRY" because C1 was trained on simulated data with vibration RMS, which the firmware doesn't yet measure.

### Persistence

`store.py` — in-memory SQLite, created fresh at every backend start (no migration history). Tables: `docs` (primary key `(kind, id)`, every row tagged SIMULATED/MEASURED/PREDICTED), `audit` (append-only, enforced by DB triggers), `ref_versions` (immutable C6 reference versions). Simulation records keyed by session `S1/…`, physical records by `PHYSICAL/…` — the two namespaces never collide.

### Speed Classification & Alarm System

```
IDLE    : drive is off / rpm < 50 rpm                  → silent
NORMAL  : 1100–1500 rpm (nominal 1300 rpm)             → silent
WARNING : 700–1099 rpm or 1501–1900 rpm               → 1 beep / 3 s (660 Hz)
CRITICAL: < 700 rpm (stall) or > 1900 rpm (overspeed)  → 3 rapid beeps / 1.5 s (1200 Hz)
UNKNOWN : drive active, Hall reading invalid/missing    → "SPEED UNAVAILABLE" banner (not "0 rpm CRITICAL")
```

The Hall sensor is a **pure tachometer** — it measures and displays speed but never throttles or stops the motor. The duty cycle slider and RPM setpoint are independent open-loop and closed-loop controls.

---

## 4. Firmware (`esp32/torqva_fw`)

Built with PlatformIO (C++, Arduino framework). Host-tested core library at `lib/torqva_core/`.

### Key Firmware Modules

| Module | File | Role |
|---|---|---|
| Limits (versioned) | `torqva_limits.h` | Default safety limits; `max_rpm=0` = not commissioned |
| Safety monitor | `safety.*` | Latching EMERGENCY_STOP trips |
| Ramp / PI / drive | `control.*` | 30%/s slew, 70% duty cap, anti-windup, coast-only stop |
| Command validator | `commands.*` | Type / range / TTL / sequence / auth; STOP never refused |
| Test executor | `testexec.*` | T1/T3/T4 on-device; aborts on trip/link loss |
| Protocol | `protocol.*` | JSON lines, allocation-free |
| Device | `device.*` | Composes the above; hardware-agnostic `HalIn`/`HalOut` |
| Simulated plant | `simplant.*` | Deterministic sim plant for firmware-in-the-loop tests |
| Hardware HAL | `src/main.cpp`, `src/config_pins.h` | Compile-only; control disabled without `-DTORQVA_CONTROL_ENABLED=1` |

### Safety Trips

Over-current (sustained/instant) · temperature stop/rise · vibration · RPM loss · voltage low/high · heartbeat lost (2 s) · sensor invalid (500 ms) → latched EMERGENCY_STOP. Reset requires authorized command **and** local button.

### Default Limits (restored 3 Nov 2026)

| Limit | Value |
|---|---|
| Max duty | 70% |
| Current stop | 4 A (instant 5 A) |
| Temperature stop | 60 °C |
| Supply voltage | 20.0–25.5 V |
| Max RPM | 0 (not commissioned — must be set via commissioning record) |

### PlatformIO Environments

| Env | Use |
|---|---|
| `native` | Host unit tests (no hardware) |
| `fitl` | Firmware-in-the-loop CLI for backend tests |
| `esp32s3` | Native USB connector |
| `esp32s3_uart` | UART0 / CH343 "UART" connector |

### Wire Protocol (v1)

**Host → Device** (one JSON object per line):
```json
{"id":7,"type":"SET_SPEED","p":1500,"p2":0,"p3":0,"ttl":5000,"age":0,"seq":12,"k":"<hmac-key>"}
```

**Device → Host**: `ack` (ACCEPTED|REJECTED|COMPLETED|ABORTED + reason), `fast` (10 Hz telemetry), `slow` (1 Hz), `status` (1 Hz + on change).

Quality bitmask `q` per `fast` frame: bit 0 current, 1 voltage, 2 housing, 3 ambient, 4 rpm, 5 vibration. Clear bit = INVALID — the value is never displayed as a number.

---

## 5. Backend

### Tech Stack

- **Python 3.13**, FastAPI + Uvicorn, Pydantic v2, NumPy, PySerial
- **In-memory SQLite** (no migrations, no deployed database)
- **pytest** (800 tests in 37 files), `cryptography` (transport tests only)

### Module Map (`backend/torqva/`, 42 modules)

| Module | Responsibility |
|---|---|
| `api.py` | Main router; simulation pipeline endpoints; physical synthesis when bridge is connected |
| `serial_bridge.py` | USB serial bridge; device snapshot; command lifecycle; Safety Supervisor integration; authenticated sessions |
| `device_routes.py` | Physical device REST endpoints: status, history, commands, commissioning, OTA; physical C5/C6 endpoints |
| `auth.py` | Bearer token auth (SHA-256 hashes); roles: viewer / operator / admin |
| `schemas.py` | Pydantic models: Telemetry, Command, Ack, Hypothesis, Prediction, SafetyDecision, RecoveryAssessment, etc. |
| `supervisor.py` | Deterministic Safety Supervisor |
| `commissioning.py` | Human commissioning record: checklist items, versioned limits, enable |
| `workflow.py` | Unified Diagnostic Workflow: C4→C1→C2→C3→C5 in one request |
| `workbench.py` | Analyst workbench: multi-step test sequences on a simulator copy; trace, receipts, counterfactual |
| `investigation.py` | Investigation trace, evidence sufficiency, adaptive testing, Decision Receipts |
| `detection.py` | C1 anomaly detection (shipped baseline) |
| `c1_robust.py` | C1 adaptive baseline with attestation (opt-in) |
| `hypotheses.py` | Fault hypothesis Bayesian ranking |
| `prediction.py` | C2 outcome prediction + conformal intervals |
| `c2_robust.py` | C2 noise-aware variant (opt-in) |
| `gate.py` | C3 decision gate |
| `diagnostics.py` | C4 diagnostic test library |
| `recovery.py` | C5 recovery verification |
| `learning.py` | C6 learning case selection |
| `attestation.py` | C6 operator-attested healthy reference versions |
| `service.py` | Simulation orchestrator |
| `sim.py` | Deterministic motor simulator |
| `simdevice.py` | Simulated device state |
| `store.py` | In-memory SQLite document store |
| `pipeline.py` | Simulation pipeline coordinator |
| `dispatch.py` | Command dispatcher (TTL, retries, ack tracking, idempotency) |
| `evaluation.py` | Simulation evaluation run reader |
| `firmware.py` | OTA firmware validation, signing, deployment |
| `firmware_routes.py` | Firmware Manager REST endpoints |
| `device_link.py` | Device connection state machine |
| `device_transport.py` | Serial transport layer |
| `device_protocol.py` | TORQVA protocol parser |
| `device_keys.py` | Per-device session key management |
| `autoconnect.py` | Auto-connect USB port scanner |
| `physical_adapter.py` | Physical telemetry adapter for AI layers |
| `incident.py` | Incident tracking |
| `prediction.py` | C2 predictor |
| `lab.py` | Research lab sessions |
| `scenarios.py` | Simulation scenario definitions |
| `c1_study.py`, `c2c4_study.py`, `c2cov_study.py`, `c4cal_study.py` | Research study harnesses (eval artifacts) |
| `c1_robust.py`, `c2_robust.py`, `c4_robust.py` | Opt-in improved variants |
| `generalization_study.py`, `c2_conditional.py` | Research modules |
| `gate.py` | C3 decision gate |

### Users & Roles

| Role | Permissions |
|---|---|
| **viewer** | Read-only; can request STOP |
| **operator** | Start simulations; approve/reject proposed actions |
| **admin** | Physical START/speed; commissioning record; audit log |

STOP is available to **every signed-in role** while the device is connected.

### Authentication

Token-based (`TORQVA_TOKENS` env var, SHA-256 hashes). The API **fails closed** without tokens — returns 401 to all requests. Local dev token auto-signs in as `local-dev / admin`.

---

## 6. Frontend

### Tech Stack

- **React 18**, Vite 5, Recharts 2 (lazy-loaded charts), Three.js 0.186 (3D Digital Twin, lazy-loaded)
- **Lucide-react** icons, Vitest + Testing Library
- Light/dark theme design system in CSS tokens (`torqva.css` → `styles/` split)

### App Structure

```
frontend/src/torqva/
├── TorqvaApp.jsx          # App shell: sign-in, mode switch, navigation, polling
├── api.js                 # REST client (reads timeout 20s; commands never do)
├── torqva.css / styles/   # Design tokens (system, monitoring, analysis, assurance, twin-sim)
├── physical/              # Pages fed by USB device stream
│   ├── physical.jsx       # Dashboard: status strip, speed alarm, motor control
│   ├── device.jsx         # Connection, commissioning, interlocks
│   ├── twin.jsx           # Physical digital twin data mapping
│   ├── recovery.jsx       # C5 Recovery Verification (physical)
│   ├── learning.jsx       # C6 Continuous Intelligence (physical)
│   ├── evaluation.jsx     # Performance Evaluation (physical)
│   ├── diagnostics.jsx    # Diagnostic pages (physical)
│   └── firmware.jsx       # Firmware Manager
├── simulation/            # Pages fed by simulator API
│   ├── overview.jsx       # Simulation overview + scenario studio
│   ├── scenario.jsx       # Scenario Studio
│   ├── diagnose.jsx       # C1 Anomaly Detection analyst workspace
│   ├── tests.jsx          # C4 Diagnostic Tests analyst workspace
│   ├── predict.jsx        # C2 Failure Prediction analyst workspace
│   ├── intervene.jsx      # C3 Action Recommendations analyst workspace
│   ├── pages.jsx          # Pipeline records, C5/C6 pages
│   ├── evaluation.jsx     # Simulation Performance Evaluation
│   ├── lab.jsx            # Research Lab
│   ├── attestation.jsx    # C6 Attestation
│   ├── c2c4.jsx           # C2/C4 combined analyst view
│   ├── trace.jsx          # Investigation trace
│   ├── counterfactual.jsx # What-if analysis
│   ├── receipts.jsx       # Decision receipts
│   ├── adaptive.jsx       # Adaptive investigation
│   └── twin.jsx           # Simulation digital twin data mapping
├── workflow/
│   └── workflow.jsx       # Diagnostic Workflow (both modes, one component)
└── shared/
    ├── components.jsx     # UI primitives, badges, banners, cards
    ├── alerts.jsx         # Device/sim alert derivation
    ├── diagnostics.js     # Diagnostic vocabulary
    ├── charts.jsx         # Recharts wrappers (lazy via lazyCharts.jsx)
    ├── twin.jsx           # Shared Digital Twin workspace
    ├── twinModel.jsx      # 2D rig drawing (SVG/canvas fallback)
    ├── twinParts.js       # Component metadata
    ├── plain.js           # Rewrites internal layer IDs in backend prose
    └── twin3d/            # Three.js 3D engine (loaded only on twin page)
        ├── engine.js      # Render loop, camera, orbit controls
        ├── assembly.js    # Procedural rig geometry
        ├── quality.js     # Adaptive pixel ratio governor
        ├── viewport.jsx   # React wrapper
        └── overlay.js     # Marker/label DOM overlay
```

### Navigation Structure

```
Monitor
  ├── Overview
  ├── Live Monitor
  └── Digital Twin

Diagnose
  ├── Diagnostic Workflow  ← (both modes, one click)
  ├── Anomaly Detection
  ├── Failure Prediction
  ├── Action Recommendations
  └── Diagnostic Investigation

Intelligence
  ├── Recovery Verification  (C5)
  ├── Continuous Intelligence (C6)
  └── Performance Evaluation

Engineering
  ├── Scenario Studio
  └── Lab

Device & Safety
  ├── Device tab
  ├── Connection & Readiness tab
  ├── Safety & Commissioning tab  (physical mode only)
  └── Firmware Manager  (#/firmware)
```

---

## 7. Key Features In Detail

### Physical Mode (Default)

- **Status strip**: 4 tiles — device connection, safety/blockers, measured speed (Hall), system health
- **Speed alarm**: zone-based with Web Audio API beeps (WARNING: 660 Hz / 3s; CRITICAL: 1200 Hz × 3 / 1.5s); mutable
- **Motor Control panel**:
  - Duty cycle (open loop) — direct PWM control, 0–100% with presets
  - RPM setpoint (closed loop via Hall feedback) — nominal 0–3,000 rpm scale, extended 0–20,000 rpm toggle
  - Auto-stop timer (5s / 10s / 30s / continuous)
  - STOP always prominent, available to all signed-in roles
  - Continuous Run Mode — dynamic speed changes without stopping
- **Hall sensor** — tachometer only: measures and displays speed, never throttles or stops motor
- **Live telemetry tiles**: RPM, current, housing temp, voltage, power, acceleration
- **Device & Safety**: commissioning checklist, versioned limits, interlock groups (device connection, firmware/faults, E-stop, authorization, electrical limits, commissioning)

### Simulation Mode (Demo)

- Scenario Studio: 5 presets (healthy baseline, recoverable imbalance, analyst review, persistent overload) + custom
- Full C1→C6 pipeline visible: anomaly scores, hypothesis bars, gate decisions, predictions with 90% intervals, test sequences, approval flow, C5 recovery verdict
- Event timeline with numbered markers on live charts
- Decision Receipts (SHA-256 digest, JSON export)
- Counterfactual lab: run Continue/Reduce/STOP on separate simulator snapshots and compare with C2 predictions

### Diagnostic Workflow (Both Modes)

One-click workflow:
1. Pick test pattern (T1 speed step / T3 thermal / T4 coast-down / speed-response sweep / adaptive)
2. Choose policy: *ask me to authorize* (default) or *auto-execute when gate permits*
3. Press **Run Diagnostic Workflow**
4. Backend runs: test sequence → evidence → C1 diagnosis → C2 predictions → C3 routing → C5 verification
5. UI shows 10 stages with real status/timestamps, evidence cards, recommended action, authorization, and verification

Idempotency key prevents double-submit. Latest workflow restored after browser refresh.

### Digital Twin

- Interactive 3D model (Three.js, WebGL 2) with 2D SVG fallback
- Components: RS-775 motor can/end-bell/bracket, shaft, hub/disc with magnet, Hall post, DS18B20 probe, ADXL345, INA219, BTS7960 with heatsink, ESP32-S3, OLED, 24V PSU, wiring, motor internals (magnets, armature, windings, commutator, brushes)
- Tools: orbit/pan/zoom, isometric/front/side/top presets, orthographic, fit, focus, isolate, exploded view, section cut, technical edges, measurement callouts
- Inspection panel: component name, sensor readings with provenance/freshness/status, links to Live Monitor
- Shaft animates only from valid non-zero speed (1/40 rate, presentation only)
- Part highlighted as alert only when source names it (invalid reading, firmware trip, or simulated fault)
- Render-on-demand scheduler; lazy-loaded (only on twin page); adaptive pixel ratio during motion; recovered lost graphics context

### Firmware Manager

- Upload signed firmware images (admin only)
- View release history and deployment status
- Deploy over OTA: ESP32 downloads over HTTPS, verifies ECDSA + SHA-256, restarts, confirms after self-tests
- OTA image URL carries a one-time token (`?t=`), answers 403 to all else

---

## 8. API Reference (`/api/torqva`, bearer token required)

### Identity & Audit
- `GET /me` — current token identity and role
- `GET /audit` — append-only audit log (admin)

### Physical Device
- `GET /device/status` — full device snapshot
- `GET /device/history` — telemetry history (last 2 min)
- `GET /device/ports` — available USB ports
- `GET /device/commands` — command log (this session)
- `POST /device/connect` / `/disconnect`
- `POST /device/commands` — STOP / START (duty%) / SET_SPEED (rpm) / RESET_ESTOP
- `GET /device/commissioning` — commissioning record
- `POST /device/commissioning/items/{id}` — attest a checklist item
- `PUT /device/commissioning/limits` — set approved limits (versioned)
- `POST /device/commissioning/enable` — enable physical operation
- `WebSocket /ws` — live device stream (snap, commands, events)

### Physical Intelligence (C5/C6)
- `GET /recovery/physical` — live recovery status, 5 verification criteria, before/after telemetry
- `POST /recovery/verify-physical` — operator trigger for re-verification
- `GET /attestation/physical/candidates` — list physical C6 candidates
- `GET /attestation/physical/candidates/{cid}` — full detail with 10 deterministic checks
- `POST /attestation/physical/capture` — capture live telemetry snapshot as new candidate
- `POST /attestation/physical/candidates/{cid}/attest|reject|revoke`
- `GET /attestation/physical/references` — reference version registry
- `POST /attestation/physical/references/{v}/activate|rollback`
- `GET /attestation/physical/warmup` / `POST /warmup/start` / `POST /warmup/end`

### Simulation Pipeline
- `GET /status /telemetry /incidents /decisions /predictions /prediction-checks /commands /outcomes /cases /log`
- `POST /simulation/start` / `/simulation/step`
- `POST /approvals/approve` / `/approvals/reject`
- `POST /commands/stop` / `/commands/reset-estop`

### Diagnostic Workflow
- `GET /workflow/patterns?mode=` — available test patterns
- `GET /workflow/runs?mode=` — workflow run list
- `GET /workflow/runs/{id}` — single run detail
- `POST /workflow/runs` — start workflow (idempotency key)
- `POST /workflow/runs/{id}/authorize` / `/cancel`

### Analyst Workbench (simulation only)
- `GET /simulation/workbench/plan` / `/predict?targets=` / `/trace` / `/receipts` / `/receipts/{id}` / `/counterfactual/{id}`
- `POST /simulation/workbench/sequence` / `/adaptive` / `/counterfactual` / `/counterfactual/{id}/rerun` / `/request` / `/check`

### Evaluation & Lab
- `GET /evaluation/latest` / `/evaluation/c2c4`
- `GET /lab/regimes` / `/lab/checklist` / `/lab/sessions*` / `/lab/experiments`

### Attestation (C6, simulation)
- `GET|POST /attestation/candidates*` / `/references*` / `/warmup*`

### Firmware Manager
- `GET /firmware/status /releases /releases/{rid} /deployments /deployments/{id}` (viewer)
- `POST /firmware/releases` (upload, admin) / `POST /firmware/deployments` (deploy, admin)
- `GET /firmware/ota/{rid}/manifest` / `/image` (device-facing, one-time token auth)

---

## 9. Test Suite

| Suite | Count | Command |
|---|---|---|
| **Backend pytest** | **800 tests** (37 files) | `cd backend; python -m pytest -q` |
| **Frontend Vitest** | **264 tests** (24 files) | `cd frontend; npx vitest run` |
| **Firmware host tests** | **~130 tests** | `cd esp32/torqva_fw; python -m platformio test -e native` |

### Backend Test Files (37 files)

`test_torqva_api.py` · `test_torqva_attestation.py` · `test_torqva_c1.py` · `test_torqva_c1_robust.py` · `test_torqva_c2.py` · `test_torqva_c2c4.py` · `test_torqva_c3_c4.py` · `test_torqva_c5.py` · `test_torqva_c6.py` · `test_torqva_conformance.py` · `test_torqva_device_link.py` · `test_torqva_e2e.py` · `test_torqva_eval.py` · `test_torqva_feature_audit.py` · `test_torqva_firmware.py` · `test_torqva_incident.py` · `test_torqva_investigation.py` · `test_torqva_lab.py` · `test_direct_operator_control.py` · `test_torqva_physical_evaluation.py` · `test_torqva_physical_intelligence.py` · `test_torqva_safety.py` · `test_torqva_safety_restoration.py` · `test_torqva_workbench.py` · `test_torqva_workflow.py` · `test_torqva_p11.py` through `test_torqva_p29_physical_first.py` (phase series)

### Key Test Invariants

- `torqva_structure.test.js` — `physical/` ↔ `simulation/` isolation (no cross-imports)
- `test_torqva_feature_audit.py` — no C1–C6 labels visible in any page or backend prose
- `test_direct_operator_control.py` — Hall sensor never throttles motor; duty and RPM controls are independent

---

## 10. How to Run

### Quick Start (Windows, PowerShell)

```powershell
# Install
cd frontend
npm install
cd ../backend
pip install -r requirements.txt

# Start (software only — safe, no hardware needed)
cd frontend
npm run dev:sim
# → Backend: http://127.0.0.1:8000  (API docs: /docs)
# → Frontend: http://localhost:5173  (auto-signed-in as admin in dev)

# Start (with hardware — connects to one plugged-in ESP32-S3)
npm run dev
```

### Environment Variables (backend)

| Variable | Default | Description |
|---|---|---|
| `TORQVA_TOKENS` | (required) | Comma-separated SHA-256 hashes of bearer tokens |
| `TORQVA_DEVICE_PORT` | auto | Pin a specific COM port |
| `TORQVA_AUTOCONNECT` | `1` | Set `0` to disable auto-connect |
| `TORQVA_C2_VARIANT` | `default` | Set `noise_aware` for opt-in C2 |

> [!CAUTION]
> `TORQVA_FORCE_UNLOCK` has been **removed**. Setting it changes nothing. Never set it.

### Run Tests

```powershell
# Backend
cd backend
python -m pytest -q

# Frontend
cd frontend
npx vitest run
npm run build

# Firmware
cd esp32/torqva_fw
python -m platformio test -e native

# Browser E2E (needs Chrome + servers running)
cd frontend
node e2e/torqva-app.e2e.mjs
node e2e/torqva-workflow.e2e.mjs
node e2e/torqva-twin.e2e.mjs
node e2e/torqva-workbench.e2e.mjs
```

### Firmware Upload (manual, deliberate)

```powershell
# Stop backend first (it holds the serial port)
cd esp32/torqva_fw
python -m platformio run -e esp32s3_uart -t upload --upload-port COM10
```

---

## 11. Git History (Recent Commits)

| Commit | Description |
|---|---|
| `8b4ac16` | feat(intelligence): add live physical Recovery Verification and Continuous Intelligence workspaces |
| `2508603` | feat(evaluation): add physical hardware performance evaluation with live streaming telemetry |
| `2a0aa40` | feat(intelligence): enable continuous intelligence attestation and recovery verification for physical workflows |
| `ad5955f` | fix(workflow): execute physical motor tests and enable live hardware workflow updates |
| `2888673` | fix(control): prioritize direct duty control, restore 3k nominal UI with 20k ceiling, and debounce Hall sensor against noise |
| `3e7682e` | fix(control): switch to pure feedforward drive so Hall sensor measures speed without slowing motor |
| `d384090` | feat(limits): increase speed limit from 3000 to 20000 rpm across firmware, backend, and UI |
| `2190daa` | fix(hall): debounce pulse drop, update minimum duty floor, and tone down zero-pulse alarm |
| `8c62741` | fix(control): prevent motor stall on Hall sensor reading and auto-clear transient trips |
| `3a6451a` | fix(safety): debounce sensor invalid trips against EMI and auto-reset cleared trips on motion command |

**Branch:** `torqva/phase-0-audit`  
**Remote:** `origin/torqva/phase-0-audit` and `origin/main` (both up to date)

---

## 12. Project Phase Status

| Phase | Status |
|---|---|
| 1 — Firmware foundation | ✅ Done (host-tested; upload is a manual step) |
| 2 — Software architecture | ✅ Done |
| 3 — C1–C6 AI pipeline (simulation) | ✅ Done and evaluated |
| 4 — Backend + data layer | ✅ Done for simulation; physical endpoint set added |
| 5 — UI/UX | ✅ Done (physical + simulation, all 15 pages) |
| 6 — Simulation research validation | ✅ Done (`docs/TORQVA_EVAL_SIM.md`) |
| 7 — End-to-end software acceptance | ✅ Done in simulation |
| 8 — C1 robustness (opt-in) | ✅ Done in simulation; not claimed for hardware |
| 9 — C6 attestation | ✅ Done in simulation |
| 10 — C2/C4 quality (opt-in) | ✅ Done in simulation |
| Physical C5 Recovery Verification | ✅ Live physical endpoints and UI |
| Physical C6 Continuous Intelligence | ✅ Live physical endpoints and UI |
| Physical Performance Evaluation | ✅ Live streaming telemetry and UI |
| Firmware OTA Manager | ✅ Done (upload, verify, deploy, rollback) |
| **Hardware integration (physical motor operation)** | ⏳ Not started — requires commissioning record completion by a human |

---

## 13. Known Gaps & Open Work

| Item | Status |
|---|---|
| Hardware E-stop circuit | Designed, not installed or wired |
| Commissioning record | Checklist items need human attestation before physical motor operation |
| Physical C1 anomaly detection | Blocked: needs vibration RMS + harmonics from firmware (not currently measured) |
| Wiring verification | `pinmap.h` lists GPIO map; a human must verify physical connections match |
| HTTPS / CORS tightening | Dev uses `*` CORS; production deployment needs proper origin config |
| Token rotation / expiry | Static SHA-256 hashes; no expiry mechanism |
| Rate limiting | No rate limiting on the API |
| Physical motor power relay | Not installed (manual disconnect only) |
| E2E test selector maintenance | Some E2E selectors go stale when UI text changes |

---

## 14. Repository Layout

```
TORQVA/
├── README.md                        Quick-start and layout overview
├── backend/
│   ├── main.py                      FastAPI entry point
│   ├── requirements.txt
│   ├── README.md                    Backend module map by responsibility
│   ├── torqva/                      42-module Python package (flat, no sub-packages)
│   ├── tests/                       37 pytest files (800 tests)
│   ├── tools/
│   │   ├── provision_device_key.py  Per-device offline key provisioning
│   │   ├── provision_ota.py         OTA certificate provisioning
│   │   └── sign_firmware.py         Firmware ECDSA signing tool
│   └── data/
│       ├── commissioning.json       Live commissioning record (git-ignored)
│       ├── device_keys.json         Per-device session keys (git-ignored)
│       └── firmware/                OTA images and release registry
├── frontend/
│   ├── package.json
│   ├── scripts/dev.mjs              Starts backend + frontend together (process tree managed)
│   └── src/torqva/                  (see structure above)
│       ├── physical/                8 files — physical device pages
│       ├── simulation/              20 files — simulation AI pages
│       ├── workflow/                1 file — Diagnostic Workflow (both modes)
│       ├── shared/                  11 files + twin3d/ — shared UI primitives and Digital Twin
│       ├── TorqvaApp.jsx            App shell
│       └── api.js                   REST client (60 endpoints)
├── esp32/torqva_fw/
│   ├── platformio.ini               4 environments (native, fitl, esp32s3, esp32s3_uart)
│   ├── src/main.cpp                 Hardware HAL entry point
│   ├── lib/torqva_core/             Portable firmware core (C++)
│   └── tests/                       Firmware host tests
└── docs/
    ├── README.md                    Docs index
    ├── PROJECT_OVERVIEW.md          ← This file
    ├── TORQVA_ARCHITECTURE.md       Architecture detail
    ├── TORQVA_PROGRESS.md           Phase-by-phase session notes
    ├── TORQVA_GAP_AUDIT.md          Outstanding gaps audit
    ├── TORQVA_HARDWARE_READINESS.md Hardware readiness checklist
    ├── TORQVA_HARDWARE_BRINGUP_CHECKLIST.md  Step-by-step bringup
    ├── TORQVA_WIRING.md             Wiring reference
    ├── TORQVA_ESTOP.md              E-stop circuit design
    ├── TORQVA_OTA_FIRMWARE_MANAGER.md  OTA design and operation
    ├── TORQVA_SECURITY_AUDIT.md     Security audit
    ├── TORQVA_UI_CONTENT_AUDIT.md   Page-by-page UI content audit
    ├── TORQVA_EVAL_SIM.md           Simulation evaluation methodology and results
    ├── software.md                  Software detail reference
    ├── hardware.md                  Hardware pin reference (see note in §2)
    └── eval/                        Committed evaluation artifacts (read by backend at runtime)
        ├── c1_phase8_*.json/gz      C1 robustness evaluation
        ├── c2c4_phase10_*.json/gz   C2/C4 quality evaluation
        └── c2cov_phase11_*.json     C2 coverage evaluation
```
