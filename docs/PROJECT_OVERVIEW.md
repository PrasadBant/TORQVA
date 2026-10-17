# TORQVA — Project Overview (context brief)

> Written so the whole project can be understood from this one file, for example by pasting it into an AI assistant before discussing or planning work.
> State as of 17 Oct 2026, branch `torqva/phase-0-audit` at commit `0e61ce3` (GitHub `PrasadBant/TORQVA`; not merged to `main`). Facts below come from the code and tests in the repository.

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

- **Frontend:** React 18, Vite 5, Recharts 2 (charts, lazy-loaded), Three.js 0.186 (Digital Twin 3D view, lazy-loaded, used directly without React Three Fiber), lucide-react icons, Vitest + Testing Library. Light/dark theme design system in one CSS file.
- **Backend:** Python, FastAPI + uvicorn, pydantic 2, numpy, pyserial, SQLite document store, pytest.
- **Firmware:** C++ (Arduino framework) via PlatformIO, host-tested core library `lib/torqva_core`.
- **E2E:** playwright-core driving Google Chrome (opt-in scripts, not a project dependency; install with `npm install --no-save playwright-core`).

---

## 5. Repository layout

```
README.md                      run / test / layout
backend/
  main.py                      FastAPI entry point (mounts /api/torqva)
  README.md                    module map by responsibility
  torqva/                      one flat Python package (40 .py files):
                               API & wiring · physical device & safety · AI pipeline C1–C6 · simulation · research studies
  tests/                       pytest (≈670 tests; files numbered by phase p11…p29, plus test_torqva_workbench.py); never opens a real port
  tools/provision_device_key.py   per-device session key (offline)
  data/                        local runtime data (git-ignored): commissioning.json, device_keys.json
frontend/
  scripts/dev.mjs              starts backend + website together; says which half stopped and why, and ends the whole process tree
  src/torqva/TorqvaApp.jsx     app shell: sign-in, mode switch, navigation, polling
  src/torqva/api.js            REST client (reads time out after 20 s; commands never do)
  src/torqva/torqva.css        design system (tokens, light/dark)
  src/torqva/shared/           UI primitives (components.jsx), diagnostic vocabulary (diagnostics.js), charts (charts.jsx via lazyCharts.jsx), Digital Twin workspace (twin.jsx), component metadata (twinParts.js), 3D viewport (twin3d/: assembly, engine, quality governor, viewport, overlay layout) and the 2D fallback drawing (twinModel.jsx)
  src/torqva/physical/         pages fed by the USB device stream: physical.jsx (dashboard), device.jsx (connection, motor control, commissioning), twin.jsx (Digital Twin data, read-only)
  src/torqva/simulation/       pages fed by the simulator API: overview.jsx (Simulation Overview), scenario.jsx (Scenario Studio), pipeline.js, events.jsx, story.jsx,
                               analyst workspaces diagnose.jsx (C1), tests.jsx (C4), predict.jsx (C2), intervene.jsx (C3) and workbench.js (their plan loader),
                               pages.jsx (pipeline records and C5/C6 pages), c2c4.jsx, evaluation.jsx, lab.jsx, attestation.jsx, twin.jsx (Digital Twin data)
  src/tests/                   Vitest suites (189 tests), incl. a layout guard
  e2e/                         browser E2E scripts (app, twin, workbench, lab, c2c4, attestation; torqva.e2e.mjs is stale)
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

The npm scripts live in `frontend/package.json`; there is no `package.json` at the repository root, so run them from `frontend/`.

```powershell
cd frontend
npm install
npm run dev:sim     # SAFE, software only: backend + website, no USB port scanned or opened
npm run dev         # with hardware: connects when exactly one board is plugged in; never unlocks interlocks or assumes a port
# website: http://localhost:5173 (signs in automatically in development as local-dev / admin)
# backend: http://127.0.0.1:8000/api/torqva   (API docs: http://127.0.0.1:8000/docs)

npx vitest run      # frontend tests (197)
npm run build       # production build (initial JavaScript ≈ 356 kB; the 3D twin chunk, ≈ 648 kB, and the four analyst workspaces load only when opened)
node e2e/torqva-app.e2e.mjs        # browser E2E against `npm run dev:sim` (67 checks)
node e2e/torqva-workbench.e2e.mjs  # analyst workflow C1 → C4 → C2 → C3 and physical-mode locks, against `npm run dev:sim` (45 checks)
node e2e/torqva-twin.e2e.mjs       # Digital Twin E2E incl. the 3D viewport, against `npm run dev:sim` (44 checks)
# lab (11), c2c4 (23) and attestation (32) need a backend started with role tokens; see frontend/e2e/README.md

cd ../backend
pip install -r requirements.txt
python -m pytest -q                # backend tests

cd ../esp32/torqva_fw
python -m platformio test -e native      # firmware host tests (uploading is always a deliberate manual step)
```

E2E scripts need `playwright-core` and Google Chrome. Never set `TORQVA_FORCE_UNLOCK` when running anything.

---

## 7. The website

Navigation groups: **Dashboard** (Overview, Live Monitor, Digital Twin) · **Diagnostics** (AI Diagnostics C1, Diagnostic Tests C4) · **Predictions** (Predictions C2, Interventions C3) · **Recovery and History** (Recovery C5, Learning C6, Evaluation) · **Device Setup and Commissioning** (Device, Motor Control / Safety & Commissioning, Lab, Devices & Settings).

- **Physical mode (default):** status strip (connection, sensors, safety, motion), live measurement tiles, motor control panel (STOP always prominent; START/speed locked by named blockers), speed status with alarm, device history charts. An invalid Hall reading while the motor is driven shows **SPEED UNAVAILABLE** (with a warning tone), not "0 rpm CRITICAL"; power is labelled DERIVED (V × I), and a missing reading carries no provenance badge. AI pages show the honest waiting state.
- **Simulation mode (demo):** start a scenario with an injected fault (severity, optional human approval), run/pause, and watch the full C1→C6 pipeline: anomaly scores, hypotheses, gate decisions, predictions, diagnostic tests, approvals, device acknowledgements, recovery verdicts. Everything is labelled SIMULATION.
- **Analyst workflow (simulation mode, C1 → C4 → C2 → C3):** *AI Diagnostics* shows the operating condition, the C1 score in plain language (never turned into a probability), the ranked hypotheses with the features that favour or count against each one against its nearest rival (the hypothesis model's own per-feature log-likelihood), and the test with the highest expected information gain. *Diagnostic Tests* builds an ordered sequence (a multi-step RPM profile with dwell times, T1, T3, T4), runs it on a copy of the live simulated motor (the live run is untouched) and shows per-step target vs observed speed, current, voltage, power, temperature, vibration and C1 flags, speed-scaling exponents, the updated ranking and an outcome category (consistent with baseline, anomalous, hypothesis supported, inconclusive, invalid, aborted). *Predictions* compares Action A/B/C reduce-speed targets (suggested from the Safety Supervisor's envelope or typed) against continue and stop; every number is the predictor's output for exactly that target, and a changed or stale target cannot be selected. *Interventions* re-checks the selected action with the deterministic gate and the Supervisor and, only when both allow it and the pipeline is holding an action for human approval, sends it after an explicit confirmation; the lifecycle then shows acknowledgement and C5 separately. In physical mode the same pages show the device's analysis status, the tests as not runnable and the real motion blockers.
- **Investigation tools (simulation mode):** an *investigation trace* on all four pages (Observation → Hypothesis → Diagnostic test → Prediction → Safety decision → Outcome), built from the run's own log and stored records, each event naming its source record; an *evidence-sufficiency* status (SUFFICIENT EVIDENCE, MORE EVIDENCE REQUIRED, INVALID INPUT, TEST NOT SUPPORTED, INCONCLUSIVE, defined by the gate's own confidence rule) and an *adaptive investigation* on C4 that picks the eligible test with the highest expected information gain, explains the alternatives and stops by stated rules; a *counterfactual experiment lab* on C2 that runs Continue, reduce targets and STOP on separate copies of one simulator snapshot for the same horizon, compares observed branch trajectories with the C2 predictions and re-runs exactly; and *Decision Receipts* on C3 for every analyst request (accepted or refused, with a frozen evidence snapshot and a SHA-256 digest) and every pipeline action (derived from its records), with a lifecycle read only from later records and a JSON export.
- Evaluation shows the committed simulation evaluation runs, always labelled as simulation evidence.
- **Digital Twin:** an interactive 3D model of the rig (Three.js, WebGL 2), with the 2D drawing as the fallback and as a choice. The procedural assembly has the RS-775 can, end bell, bracket, shaft, hub and disc with magnet, the Hall post, DS18B20 probe and clamp, ADXL345, INA219, BTS7960 with heat sink, ESP32-S3 board, OLED, 24 V supply and wiring, plus generic motor internals (magnets, armature, windings, commutator, brushes). Tools: orbit / pan / Ctrl + scroll zoom, isometric / front / side / top presets, orthographic projection, fit, focus, isolate, exploded view, a section through the motor axis and technical edges, plus markers, labels and measurement callouts that are DOM buttons (keyboard and screen-reader reachable). The inspection panel shows each reading with value, unit, provenance (SIM / HW / DERIVED / CMD), freshness and trend, plus the component's id, function and how certain its placement is. Values come only from the mode's existing data mapping (missing = UNAVAILABLE, never 0). The shaft turns only from a valid, current, non-zero speed (1/40 rate, presentation only). A part is highlighted as an alert only when the source names it: an invalid reading, a firmware trip attributed to that sensor's reading, or (simulation only) the scenario's injected fault, labelled as ground truth. Rendering is on demand, the 3D code loads only on the twin page, a lost graphics context is recovered, and the page sends no commands. The geometry is illustrative, not CAD-accurate.
- Responsive (desktop to phone, drawer navigation below 860 px), light and dark themes, collapsible sidebar.

---

## 8. Main API routes (`/api/torqva`, bearer token required)

- **Identity & audit:** `GET /me`, `GET /audit` (admin)
- **Simulation pipeline:** `GET /status /telemetry /incidents /decisions /predictions /prediction-checks /commands /outcomes /cases /log`; `POST /simulation/start`, `/simulation/step`, `/approvals/approve`, `/approvals/reject`, `/commands/stop`, `/commands/reset-estop`
- **Analyst workbench (simulation only):** `GET /simulation/workbench/plan`, `GET /simulation/workbench/predict?targets=…` (a pure read), `POST /simulation/workbench/check` (no side effect), `GET /simulation/workbench/trace`, `/receipts`, `/receipts/{id}`, `/counterfactual/{id}`; `POST /simulation/workbench/sequence`, `/adaptive`, `/counterfactual`, `/counterfactual/{id}/rerun` and `/request` (operator)
- **Evaluation:** `GET /evaluation/latest`, `/evaluation/c2c4`
- **Lab:** `/lab/regimes`, `/lab/checklist`, `/lab/sessions…` (create, checklist, run, reveal, reproduce), `/lab/experiments`
- **Attestation (C6):** `/attestation/candidates…`, `/attestation/references…`, `/attestation/warmup…`
- **Physical device:** `GET /device/status /device/history /device/ports /device/commands`; `POST /device/connect /device/disconnect /device/commands` (STOP / START / SET_SPEED); commissioning `GET /device/commissioning`, `POST /device/commissioning/items/{id}`, `PUT /device/commissioning/limits`, `POST /device/commissioning/enable`; WebSocket `/ws`

---

## 9. What was done recently (Oct 2026)

Items 1–5 are committed and pushed to `torqva/phase-0-audit`; item 6 is in the working tree only.

1. **UI/UX redesign** (`7459daf`): new design system with refined light and dark themes, new shell/navigation (collapsible, mobile drawer), dashboards, charts, sign-in page.
2. **Engineering pass** (`0473df3`): removed fabricated behaviour introduced by earlier commits:
   - Diagnostic Tests page showed canned results and sent real START/SET_SPEED/STOP commands → now read-only, shows only backend results.
   - Predictions page invented "hardware-verified" candidates with execute buttons → now backend predictions only, no motor buttons.
   - Backend fed invented readings (fixed 24 V, default temperatures, made-up vibration) into the AI as MEASURED and marked all layers ACTIVE → restored honest behaviour.
   - Evaluation relabelled simulation as hardware-validated → fixed; hard-coded "COM7" claims removed; a fake hardware "Emergency Coast Stop" (it only stopped the simulator) removed.
   - Restored the missing speed input on Motor Control; commissioning form no longer submits hidden voltage limits or blank-as-zero values.
   - Added a 20 s read timeout, fixed header overflow at tablet widths, and lazy-loaded charts (initial JavaScript 750 kB → 322 kB).
   - Added `npm run dev:sim` (safe software-only development).
3. **Repository restructure** (`0473df3`): frontend grouped into `shared/`, `physical/`, `simulation/`; retired docs moved to `docs/history/`; READMEs and a docs index added. Backend package kept flat on purpose.
4. **Performance** (`975f47a`): faster model build and no per-second re-render of the whole app.
5. **Digital Twin and honest labels** (`04c2c67`): the read-only Digital Twin page (section 7) for both modes; the physical dashboard's SPEED UNAVAILABLE state and DERIVED power label; a CMD provenance badge for commanded values; the older E2E scripts brought up to date (they start in simulation mode); a 390 px overflow fix on Attestation.

6. **3D Digital Twin** (`80b027b`): the twin page renders the rig in 3D with Three.js (added to `package.json` by the user); the 2D drawing stays as the fallback (no WebGL 2, render error or lost context). Data mappings gained `freshness` and evidence-only `alerts`; no backend, firmware or API change.
7. **3D twin smoothness** (`60eabbc`): fixed a render-loop explosion (camera damping queued extra frames inside a frame; a 2 s orbit took 279 s, now 4 s, longest task 3.8 s → 0) with a single-flight render-on-demand scheduler; fixed a memory leak on remount (one shared WebGL renderer, explicit OrbitControls listener removal; heap now plateaus around 11 MB); adaptive pixel ratio during motion (`twin3d/quality.js`); marker updates write the DOM only on change; new engine tests (`torqva_twin3d_engine.test.js`, 10 tests).

8. **Simulation Mode redesign** (`6ce140f`): Simulation Overview laid out like the physical dashboard, Scenario Studio, the C1–C6 pipeline view, event timeline and incident story.
10. **Investigation tools** (uncommitted): trace, evidence sufficiency and adaptive testing, counterfactual lab and Decision Receipts (`backend/torqva/investigation.py`, additions to `workbench.py`; simulation only). The acknowledgement of a speed command is never shown as execution: the simulated device reports completion only for STOP and tests.
9. **Analyst workflow** (`0e61ce3`): the C1 → C4 → C2 → C3 workspaces above, backed by `backend/torqva/workbench.py` (additive; simulation only). Multi-step tests run on a deep copy of the live simulated motor; evidence is fused only by the existing hypothesis model and learned C4 signatures (the T1 signature is applied only to a profile step pair that matches the conditions it was learned at); an analyst action can only replace the action the pipeline is holding for approval, is refused when C2 marks the prediction for that target unsupported or its predicted risk reaches the gate's stop threshold (the same rules the pipeline applies to itself), and then goes through `Orchestrator.approve()` → Safety Supervisor → dispatcher. `npm run dev:sim` now says which half stopped and why, never reports a killed dev server as success, and ends the whole Vite process tree on Windows. No firmware, physical command path or dependency change.

Test status (18 Oct): frontend 197/197; build passes (initial JavaScript ≈ 356 kB; the four workspaces load on demand); browser E2E workbench 45/45, app 67/67, twin 44/44, lab 11/11, c2c4 23/23, attestation 32/32; backend 679 passed / 5 failed / 1 skipped (the same 5 firmware source checks); firmware host tests 105 passed / 25 failed (see section 10, item 2).

---

## 10. Known issues and open decisions

1. **Fixed (14 Oct):** `npm run dev` no longer sets `TORQVA_FORCE_UNLOCK=1` or opens COM7. The backend still honours the flag if someone sets it by hand (it bypasses commissioning, the session check and Supervisor refusals), so never set it.
2. **Firmware protections were relaxed in an earlier commit** (`319fb7b`): over-current/voltage/stall/heartbeat protections loosened, E-stop auto-resets on command, authentication skipped, brown-out detection off, instant "COMPLETED" acks. The 5 failing backend tests are exactly these firmware safety checks, and 25 firmware host tests fail, including `test_stop_is_never_blocked_by_the_interlocks`, `test_wrong_key_cannot_start_motor` and the over-current, voltage, sensor-loss, rpm-loss, heartbeat and session trips. The firmware is unchanged since that commit. **This blocks any physical run** until a person decides to restore the protections.
3. Backend commissioning API silently defaults voltage limits to 0–26 V when omitted; device autoconnect retries every 1 s (was 5 s).
4. The speed status bands (normal 1100–1500 rpm around 1300) are a display choice, not approved limits.
5. Physical AI is not possible yet: C1 needs vibration RMS and shaft-order harmonics the firmware doesn't compute; no physical baseline or held-out evaluation exists.
6. Hardware readiness gaps: wiring unconfirmed, independent E-stop not installed, no secure (encrypted) device transport, no relay or reset button.
7. Cleanup candidates (not deleted): empty `assets/` folder, legacy `backend/data/motor_monitor.db`, stale `frontend/e2e/torqva.e2e.mjs`, legacy package name `smart-motor-monitor-frontend`.
8. The website has no URL routing: pages are switched in app state, so a page cannot be bookmarked or reloaded in place.
9. The simulator's in-memory history grows without a limit during a long run.
10. The branch `torqva/phase-0-audit` is pushed but not merged into `main` (no pull request yet).
11. The 3D twin is illustrative: no CAD model or measurement of the real rig exists, so sensor positions, the disc size, wiring routes and the motor internals are typical, not this unit's. The rotation direction depends on unverified motor polarity. The twin shows no C2 prediction overlay because predictions are system-level, not tied to a component. Performance was measured in headless Chrome only; real-display frame rate and GPU time are unmeasured, and the first selection of a mechanical part still costs one ~12 ms frame.
12. The analyst workflow's limits: C2 interval widths are calibrated per action, not per target speed; the outcome signatures and the predictor are learned in simulation; a test sequence runs on a copy, so a fault the scenario schedules for later is not applied in it (the result says so); an analyst can only execute when the scenario requires human approval and the pipeline holds an action. Physical diagnostics stay locked (no vibration RMS or harmonics from the firmware, no torque sensor).
13. If the process that started `npm run dev:sim` is killed from outside (for example a terminal or tool that ends only the npm wrapper), the launcher and its two servers keep running and hold ports 8000/5173; stop them before starting another. Separately, the Vite dev server has crashed natively (Windows exit code 0xC0000409) a few times during browser E2E runs; the launcher now reports it, the trigger is not identified (rapid screenshot writes into the watched folder did not reproduce it).

## 11. Likely next steps

- Decide on item 2 (restore the firmware protections so the 25 firmware and 5 backend safety tests pass) and remove the backend's `TORQVA_FORCE_UNLOCK` path (item 1).
- Open a pull request from `torqva/phase-0-audit` into `main`.
- Hardware bring-up following `docs/TORQVA_HARDWARE_BRINGUP_CHECKLIST.md`: confirm wiring, install and verify the E-stop, commission limits, authenticated session.
- Physical data path for AI: compute vibration RMS / harmonics in firmware, record labelled physical sessions, fit and evaluate C1 on real data, then C2/C4 matched-condition experiments.
- Optional: CI workflow (tests + build), TypeScript migration of the frontend API layer.

## 12. Glossary

- **Provenance badges:** `SIM` simulated · `HW`/`MEASURED` from the device · `PRED` prediction · `DERIVED` computed from other values · `CMD` a commanded value (e.g. setpoint), not a measurement.
- **Incident:** an anomaly episode tracked by a state machine from detection to recovery or closure.
- **FITL:** firmware-in-the-loop — the real firmware core compiled for the host and driven by backend tests.
- **Interlock / blocker:** a named condition that keeps physical START/speed refused (e.g. DEVICE NOT CONNECTED, SAFETY LIMITS NOT APPROVED).
- **Commissioning:** the human, evidence-backed record that approves limits and enables physical control.
