# TORQVA — Project Overview (context brief)

> Written so the whole project can be understood from this one file, for example by pasting it into an AI assistant before discussing or planning work.
> State as of 19 Oct 2026, branch `torqva/phase-0-audit` at commit `150e12d` (GitHub `PrasadBant/TORQVA`; not merged to `main`), with the work in section 9, items 14 and 15, committed on top. Facts below come from the code and tests in the repository.

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
| Unified workflow | `workflow.py` | One request chains C4 → C1 → C2 → C3 → C5 using the modules above (no model, gate or command path of its own); physical mode is blocked at validation |

For **physical** data, the backend currently reports every analysis layer as **NOT AVAILABLE** (C1 was trained on simulated data and needs vibration RMS and harmonics the firmware doesn't measure). The UI shows "WAITING FOR VALID PHYSICAL TELEMETRY" instead of results.

### Persistence
`store.py` is a small typed document store on **SQLite held in memory**: it is created fresh at every backend start, so there is no migration history, seed data or deployed database. Tables: `docs` (primary key `(kind, id)`, every row tagged SIMULATED / MEASURED / PREDICTED, kinds limited to the `KINDS` whitelist), `audit` (append-only, enforced by triggers) and `ref_versions` (immutable C6 reference versions). Simulation records are keyed by their simulation session (`S1/…`), physical workflow records by `PHYSICAL/…`, so the two never share a key. The file `backend/data/motor_monitor.db` belongs to the retired prototype and is not opened by any current code (section 10, item 7).

### Firmware safety model (`esp32/torqva_fw`)
Safety monitor with trips: over-current (sustained/instant), temperature stop/rise, vibration, rpm loss, voltage low/high, heartbeat lost, sensor invalid → latched EMERGENCY_STOP. Start interlocks require approved limits, E-stop circuit, authenticated session, and the explicit `TORQVA_CONTROL_ENABLED` build flag. Default limits: max duty 70 %, max rpm 3000, max voltage 28 V. PlatformIO environments: `native` (host unit tests), `fitl` (firmware-in-the-loop CLI used by backend tests), `esp32s3` (native USB), `esp32s3_uart` (UART0).

### Users and roles
Token-based auth (`TORQVA_TOKENS`, sha256 hashes; the API refuses everything if unset). Roles: **viewer** (read only, can request STOP), **operator** (start simulations, approve/reject proposed actions), **admin** (also physical START / speed, commissioning record, audit log). STOP is open to every signed-in role.

### Commissioning
A human record (`commissioning.py`): checklist items attested with written evidence, approved limits (versioned, history kept, confirm phrase required) and an explicit enable. It is audited and **never overrides the firmware interlocks**.

---

## 4. Tech stack

- **Frontend:** React 18, Vite 5, Recharts 2 (charts, lazy-loaded), Three.js 0.186 (Digital Twin 3D view, lazy-loaded, used directly without React Three Fiber), lucide-react icons, Vitest + Testing Library. Light/dark theme design system in one CSS file.
- **Backend:** Python, FastAPI + uvicorn, pydantic 2, numpy, pyserial, an in-memory SQLite document store, pytest (cryptography for the secure-transport tests only).
- **Firmware:** C++ (Arduino framework) via PlatformIO, host-tested core library `lib/torqva_core`.
- **E2E:** playwright-core driving Google Chrome (opt-in scripts, not a project dependency; install with `npm install --no-save playwright-core`).

---

## 5. Repository layout

```
README.md                      run / test / layout
backend/
  main.py                      FastAPI entry point (mounts /api/torqva)
  README.md                    module map by responsibility
  torqva/                      one flat Python package (42 modules):
                               API & wiring · physical device & safety · AI pipeline C1–C6 · simulation · research studies
  tests/                       pytest (708 tests in 37 files; numbered by phase p11…p29, plus the workbench, investigation, workflow and feature-audit suites); never opens a real port
  tools/provision_device_key.py   per-device session key (offline)
  data/                        local runtime data (git-ignored): commissioning.json, device_keys.json; legacy motor_monitor.db (retired prototype, unused)
frontend/
  scripts/dev.mjs              starts backend + website together; says which half stopped and why, and ends the whole process tree
  src/torqva/TorqvaApp.jsx     app shell: sign-in, mode switch, navigation, polling
  src/torqva/api.js            REST client (reads time out after 20 s; commands never do)
  src/torqva/torqva.css        design system (tokens, light/dark)
  src/torqva/shared/           UI primitives, the shared Disclosure (progressive disclosure) and the text helpers title / pct / fmtRpm / canControl (components.jsx), diagnostic vocabulary (diagnostics.js), charts (charts.jsx via lazyCharts.jsx), Digital Twin workspace (twin.jsx), component metadata (twinParts.js), 3D viewport (twin3d/: assembly, engine, quality governor, viewport, overlay layout) and the 2D fallback drawing (twinModel.jsx)
  src/torqva/physical/         pages fed by the USB device stream: physical.jsx (dashboard), device.jsx (connection, motor control, commissioning), twin.jsx (Digital Twin data, read-only)
  src/torqva/simulation/       pages fed by the simulator API: overview.jsx (Simulation Overview), scenario.jsx (Scenario Studio), pipeline.js, events.jsx, story.jsx,
                               analyst workspaces diagnose.jsx (C1), tests.jsx (C4), predict.jsx (C2), intervene.jsx (C3) and workbench.js (their plan loader),
                               pages.jsx (pipeline records and C5/C6 pages), c2c4.jsx, evaluation.jsx, lab.jsx, attestation.jsx, twin.jsx (Digital Twin data),
                               adaptive.jsx, counterfactual.jsx, receipts.jsx, trace.jsx (investigation tools)
  src/torqva/workflow/         workflow.jsx: the Diagnostic Workflow page, one component for both modes
  src/tests/                   Vitest suites (203 tests in 16 files), incl. a layout guard; fixtures/ holds responses recorded from the real backend
  e2e/                         browser E2E scripts (app, twin, workflow, workbench, lab, c2c4, attestation, and the original torqva.e2e.mjs); not part of npm test
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

npx vitest run      # frontend tests (203)
npm run build       # production build (initial JavaScript ≈ 368 kB; the 3D twin chunk, ≈ 648 kB, the analyst workspaces and the workflow page, ≈ 34 kB, load only when opened)
node e2e/torqva-app.e2e.mjs        # browser E2E against `npm run dev:sim` (67 checks)
node e2e/torqva-workflow.e2e.mjs   # one-click Diagnostic Workflow: pattern → diagnosis → RPM recommendation → authorize → C5 verified; physical blocked (30 checks)
node e2e/torqva-workbench.e2e.mjs  # analyst workflow C1 → C4 → C2 → C3 and physical-mode locks, against `npm run dev:sim` (47 checks; includes following the trace link to Interventions)
node e2e/torqva-twin.e2e.mjs       # Digital Twin E2E incl. the 3D viewport, against `npm run dev:sim` (44 checks)
# lab (11), c2c4 (23), attestation (32) and the original torqva.e2e.mjs (30, needs a fresh backend) sign in with a typed token; see frontend/e2e/README.md

cd ../backend
pip install -r requirements.txt
python -m pytest -q                # backend tests (707: 701 pass, 5 fail as described in section 10 item 2, 1 skipped)

cd ../esp32/torqva_fw
python -m platformio test -e native      # firmware host tests (uploading is always a deliberate manual step)
```

E2E scripts need `playwright-core` and Google Chrome. Never set `TORQVA_FORCE_UNLOCK` when running anything.

---

## 7. The website

Navigation groups: **Dashboard** (Overview, Live Monitor, Digital Twin) · **Diagnostics** (Diagnostic Workflow, AI Diagnostics C1, Diagnostic Tests C4) · **Predictions** (Predictions C2, Interventions C3) · **Operations** (Recovery C5) · **Intelligence** (Learning C6, Evaluation) · **Device & Safety** (Device, Safety & Commissioning — physical mode only — and Devices & Settings) · **Engineering** (Lab). Page ids and in-app navigation are unchanged (there is still no URL routing).

Every page leads with its main result or decision; advanced detail (traces, raw gate inputs, receipts, per-regime tables, audit trails, the pipeline's own records, connection counters) sits in labelled, keyboard-operable disclosures. A disclosure opens by itself when its content becomes relevant (a hold starts, a receipt is written) and never closes by itself. Safety blockers, STOP, approvals and simulation labels are never inside one.

- **Physical mode (default):** status strip (connection, sensors, safety, motion), live measurement tiles, motor control panel (STOP always prominent; START/speed locked by named blockers), speed status with alarm, device history charts. An invalid Hall reading while the motor is driven shows **SPEED UNAVAILABLE** (with a warning tone), not "0 rpm CRITICAL"; power is labelled DERIVED (V × I), and a missing reading carries no provenance badge. AI pages show the honest waiting state.
- **Simulation mode (demo):** start a scenario with an injected fault (severity, optional human approval), run/pause, and watch the full C1→C6 pipeline: anomaly scores, hypotheses, gate decisions, predictions, diagnostic tests, approvals, device acknowledgements, recovery verdicts. Everything is labelled SIMULATION.
- **Diagnostic Workflow (both modes, one click):** pick a test pattern (T1 speed step, T3 thermal, T4 coast-down, a 100/70/85 % speed-response sweep, or adaptive), each shown with its sequence, dwell times, signals, expected observations and live prerequisites; choose the execution policy (*ask me to authorize*, the default, or *execute automatically when every gate permits*) and press **Run Diagnostic Workflow**. The page then shows ten stages with their real status and timestamps, the evidence (measured, derived and suspected kept apart), the diagnosis, a **Recommended action** card (target RPM against the current setpoint, the adjustment, why, the predicted outcome with its 90 % intervals, and every candidate with the reason it was or was not chosen), the authorization step, and verification that separates *accepted*, *executed*, *improvement observed* and *recovery verified (C5)*. A double click sends one request (idempotency key) and the latest workflow is restored after a browser refresh. In simulation a recommendation can be executed only when the scenario holds the pipeline's action for human approval; in an auto-approve scenario the pipeline acts by itself and the workflow says so instead of sending a second command. In physical mode the same page lists the real blockers and nothing can run.
- **Analyst workflow (simulation mode, C1 → C4 → C2 → C3):** *AI Diagnostics* shows the operating condition, the C1 score in plain language (never turned into a probability), the ranked hypotheses with the features that favour or count against each one against its nearest rival (the hypothesis model's own per-feature log-likelihood), and the test with the highest expected information gain. *Diagnostic Tests* builds an ordered sequence (a multi-step RPM profile with dwell times, T1, T3, T4), runs it on a copy of the live simulated motor (the live run is untouched) and shows per-step target vs observed speed, current, voltage, power, temperature, vibration and C1 flags, speed-scaling exponents, the updated ranking and an outcome category (consistent with baseline, anomalous, hypothesis supported, inconclusive, invalid, aborted). *Predictions* compares Action A/B/C reduce-speed targets (suggested from the Safety Supervisor's envelope or typed) against continue and stop; every number is the predictor's output for exactly that target, and a changed or stale target cannot be selected. *Interventions* re-checks the selected action with the deterministic gate and the Supervisor and, only when both allow it and the pipeline is holding an action for human approval, sends it after an explicit confirmation; the lifecycle then shows acknowledgement and C5 separately. In physical mode the same pages show the device's analysis status, the tests as not runnable and the real motion blockers.
- **Investigation tools (simulation mode):** an *investigation trace* on all four pages (Observation → Hypothesis → Diagnostic test → Prediction → Safety decision → Outcome), built from the run's own log and stored records, each event naming its source record; an *evidence-sufficiency* status (SUFFICIENT EVIDENCE, MORE EVIDENCE REQUIRED, INVALID INPUT, TEST NOT SUPPORTED, INCONCLUSIVE, defined by the gate's own confidence rule) and an *adaptive investigation* on C4 that picks the eligible test with the highest expected information gain, explains the alternatives and stops by stated rules; a *counterfactual experiment lab* on C2 that runs Continue, reduce targets and STOP on separate copies of one simulator snapshot for the same horizon, compares observed branch trajectories with the C2 predictions and re-runs exactly; and *Decision Receipts* on C3 for every analyst request (accepted or refused, with a frozen evidence snapshot and a SHA-256 digest) and every pipeline action (derived from its records), with a lifecycle read only from later records and a JSON export.
- Evaluation shows the committed simulation evaluation runs, always labelled as simulation evidence.
- **Digital Twin:** an interactive 3D model of the rig (Three.js, WebGL 2), with the 2D drawing as the fallback and as a choice. The procedural assembly has the RS-775 can, end bell, bracket, shaft, hub and disc with magnet, the Hall post, DS18B20 probe and clamp, ADXL345, INA219, BTS7960 with heat sink, ESP32-S3 board, OLED, 24 V supply and wiring, plus generic motor internals (magnets, armature, windings, commutator, brushes). Tools: orbit / pan / Ctrl + scroll zoom, isometric / front / side / top presets, orthographic projection, fit, focus, isolate, exploded view, a section through the motor axis and technical edges, plus markers, labels and measurement callouts that are DOM buttons (keyboard and screen-reader reachable). The inspection panel shows each reading with value, unit, provenance (SIM / HW / DERIVED / CMD), freshness and trend, plus the component's id, function and how certain its placement is. Values come only from the mode's existing data mapping (missing = UNAVAILABLE, never 0). The shaft turns only from a valid, current, non-zero speed (1/40 rate, presentation only). A part is highlighted as an alert only when the source names it: an invalid reading, a firmware trip attributed to that sensor's reading, or (simulation only) the scenario's injected fault, labelled as ground truth. Rendering is on demand, the 3D code loads only on the twin page, a lost graphics context is recovered, and the page sends no commands. The geometry is illustrative, not CAD-accurate.
- **Operations and device workspaces:** *Recovery* opens with the current recovery status and the next step (from the incident state and the latest C5 outcome only). *Learning* opens with the reference lifecycle (active reference, candidates by state, versions, warm-up hold), then candidates → attestation → versions. *Safety & Commissioning* (physical) opens with operating readiness and every blocker the backend reports, then the interlocks and the commissioning checklist (admin limit / enable forms in their own section). *Device* shows a one-line readiness summary linking there, with frame counters under Connection diagnostics. Simulation mode lists no physical control page: the simulated motor is run, stepped and stopped from Scenario Studio (Overview), and the Device page links there. Physical START, speed and STOP live on the physical Overview.
- **Analyst experience (item 15):** a dark navy sidebar beside a light workspace (light is the default theme; dark stays one click away). On the simulation analyst pages (AI Diagnostics, Diagnostic Tests, Predictions, Interventions, Recovery) an *Investigation progress* bar shows the five steps in working order (C1 Detect & diagnose → C4 Test the hypothesis → C2 Predict outcomes → C3 Decide & authorize → C5 Verify recovery) with the backend's own stage state (complete, in progress, waiting, refused, failed, not reached, unavailable), the current step highlighted and its backend summary as visible text. Sidebar layer tags explain themselves (e.g. "C2 (outcome prediction)"). *Safety & Commissioning* shows the interlocks as a grouped checklist (device connection, firmware and faults, emergency stop, authorization, electrical limits, commissioning; unknown ids under "Other checks") with a pass count and next step per group; it stacks on phones. *AI Diagnostics* leads with the hypotheses, then assessment and next test, what is unknown and the readings; *Predictions* leads with the action comparison; *Recovery* puts verdicts and their criteria before the incident story. *Scenario Studio* has presets that only fill the form (healthy baseline, recoverable imbalance, analyst review, persistent overload) and one-line field explanations. *Live Monitor* has a signal filter and optional numbered event marks (logged pipeline events and the scenario's injection time, listed with their times).
- Responsive (desktop to phone, drawer navigation below 860 px; wide tables scroll inside their card), light and dark themes, collapsible sidebar; text tokens meet WCAG 4.5:1 in both themes.

---

## 8. Main API routes (`/api/torqva`, bearer token required)

- **Identity & audit:** `GET /me`, `GET /audit` (admin)
- **Simulation pipeline:** `GET /status /telemetry /incidents /decisions /predictions /prediction-checks /commands /outcomes /cases /log`; `POST /simulation/start`, `/simulation/step`, `/approvals/approve`, `/approvals/reject`, `/commands/stop`, `/commands/reset-estop`
- **Unified diagnostic workflow (both modes, `backend/torqva/workflow.py`):** `GET /workflow/patterns?mode=`, `GET /workflow/runs?mode=`, `GET /workflow/runs/{id}` (viewer); `POST /workflow/runs` (one request: test → evidence → diagnosis → C2 → recommendation → C3 routing; `idempotency_key` makes a retried click return the same run), `POST /workflow/runs/{id}/authorize` and `/cancel` (operator). Physical workflows are blocked at validation and send nothing.
- **Analyst workbench (simulation only):** `GET /simulation/workbench/plan`, `GET /simulation/workbench/predict?targets=…` (a pure read), `POST /simulation/workbench/check` (no side effect), `GET /simulation/workbench/trace`, `/receipts`, `/receipts/{id}`, `/counterfactual/{id}`; `POST /simulation/workbench/sequence`, `/adaptive`, `/counterfactual`, `/counterfactual/{id}/rerun` and `/request` (operator)
- **Evaluation:** `GET /evaluation/latest`, `/evaluation/c2c4`
- **Lab:** `/lab/regimes`, `/lab/checklist`, `/lab/sessions…` (create, checklist, run, reveal, reproduce), `/lab/experiments`
- **Attestation (C6):** `/attestation/candidates…`, `/attestation/references…`, `/attestation/warmup…`
- **Physical device:** `GET /device/status /device/history /device/ports /device/commands`; `POST /device/connect /device/disconnect /device/commands` (STOP / START / SET_SPEED); commissioning `GET /device/commissioning`, `POST /device/commissioning/items/{id}`, `PUT /device/commissioning/limits`, `POST /device/commissioning/enable`; WebSocket `/ws`

---

## 9. What was done recently (Oct 2026)

Items 1–13 are committed and pushed to `torqva/phase-0-audit`; item 14 is in the working tree only (not committed).

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
9. **Analyst workflow** (`0e61ce3`): the C1 → C4 → C2 → C3 workspaces above, backed by `backend/torqva/workbench.py` (additive; simulation only). Multi-step tests run on a deep copy of the live simulated motor; evidence is fused only by the existing hypothesis model and learned C4 signatures (the T1 signature is applied only to a profile step pair that matches the conditions it was learned at); an analyst action can only replace the action the pipeline is holding for approval, is refused when C2 marks the prediction for that target unsupported or its predicted risk reaches the gate's stop threshold (the same rules the pipeline applies to itself), and then goes through `Orchestrator.approve()` → Safety Supervisor → dispatcher. `npm run dev:sim` now says which half stopped and why, never reports a killed dev server as success, and ends the whole Vite process tree on Windows. No firmware, physical command path or dependency change.
10. **Investigation tools** (`0928f5e`): trace, evidence sufficiency and adaptive testing, counterfactual lab and Decision Receipts (`backend/torqva/investigation.py`, additions to `workbench.py`; simulation only). The acknowledgement of a speed command is never shown as execution: the simulated device reports completion only for STOP and tests.
11. **Unified Diagnostic Workflow** (`4ef2383`): a new "Diagnostic Workflow" page (first item under Diagnostics, same layout in both modes) and `backend/torqva/workflow.py`. The operator picks a test pattern (T1, T3, T4, speed-response sweep, or adaptive) and presses **Run Diagnostic Workflow** once; the backend runs it on a copy of the live simulated motor (`workbench.run_sequence` / `run_adaptive`), assembles the evidence, diagnoses with the test-updated ranking (no ranking is used unless C1 has evidence of an anomaly), predicts every candidate with C2 (each with its own target, conditioned on that ranking and the live state), decides with `gate.decide` on `Orchestrator.gate_inputs(post=…)` and the pipeline's own C2 ranking (ties keep the pipeline's configured 70 % reduction; a lower speed is never preferred for its own sake), and routes the exact recommendation into the existing C3 path (`check_action` / `request_action`, or the always-available STOP path) under the chosen policy: *ask me to authorize* (default) or *execute automatically when every gate permits*. Verification reads the pipeline's own C5 outcome for that command. Explicit outcomes: no intervention needed, awaiting authorization/verification, improvement observed (not verified), recovery verified, condition persists, inconclusive, rejected, failed, expired, declined, superseded, not executable (e.g. the pipeline already acted in an auto-approve scenario: the workflow never sends a second command). Physical mode: blocked at VALIDATING because the firmware accepts only STOP/START/SET_SPEED (no test command) and C1 cannot consume its telemetry. Small supporting changes: `Orchestrator.gate_inputs` takes an optional ranking, `run_sequence`/`run_adaptive` take an optional `capture`, `Store.KINDS` gains `workflow`. No firmware, physical command path or dependency change.
12. **Codebase and database cleanup** (`4ef2383`, 18 Oct): removed confirmed dead code only. Backend: 46 unused imports and 4 dead local values (pyflakes, each checked for re-exports); identical `_r` helper reused from `workbench.py`; the never-used `session` and `model_version` store kinds dropped from `Store.KINDS` (no code wrote or read them); unused `pydantic-settings` dropped from `requirements.txt`. Frontend: 10 unused imports, the unused `Tabs` component, 19 CSS classes with no reference (about 3 KB); `title`, `pct`, `fmtRpm` and `canControl` defined once in `shared/components.jsx` (the simulation modules re-export them, so imports did not change); package renamed `torqva-frontend`. `frontend/e2e/torqva.e2e.mjs` repaired (simulation mode, current STOP label, narrow-width nav), not deleted. The empty legacy `assets/` placeholder removed; `.tmp/`, `graphify-out/`, `.graphify_python` and `frontend/e2e-shots/` are now git-ignored (left on disk). The store is in-memory SQLite (no migrations, no deployed database); an integrity check on a store populated through the real API found no duplicates, no orphaned references, no fabricated recovery and working append-only triggers. No firmware, safety, auth or API behaviour change.

13. **Page decluttering** (`150e12d`): progressive disclosure across the analyst pages. Interventions shows the held action (Approve / Reject) first; AI Diagnostics replaces the duplicated telemetry tiles with one readings line; Predictions, Diagnostic Tests, Evaluation, Recovery, Motor Control and Devices & Settings keep their key result visible and collapse the pipeline's own duplicate records, counterfactual lab, traces, per-regime tables and audit trail; Overview folds the new-scenario form once a run exists and Live Monitor keeps only the run controls and STOP. Shared `Disclosure` component; visible words fell 13–70 % per page with nothing removed. Vite no longer watches `e2e-shots/`.
14. **Operations and engineering workspaces** (18–19 Oct): sidebar regrouped (Operations, Intelligence, Device & Safety, Engineering; the Device "USB" badge removed); Safety & Commissioning rebuilt around readiness and blockers (it previously hid everything and showed no interlocks); shared `ReadinessCard` / `InterlocksCard` used by it and Motor Control; Device readiness summary and Connection diagnostics; Learning ordered as the reference lifecycle; Recovery status line with the next step; Lab optional injection-record fields labelled with units (they are recorded only, never used by the simulator); `Disclosure` made open-only (a hold ending no longer folds the warm-up away); wide device tables scroll instead of clipping. Evaluation and Devices & Settings were reviewed and left unchanged (Devices & Settings has no editable settings to offer). The lab, c2c4 and attestation E2E scripts were updated only to open the sections they use. Follow-up cleanup: the backend `TORQVA_FORCE_UNLOCK` bypass removed (item 1 of section 10); the investigation trace now has one home, Interventions (with the receipts and pipeline records), and AI Diagnostics, Diagnostic Tests and Predictions link to it focused on their stage; Overview no longer embeds the trend charts Live Monitor owns; Live Monitor's raw last-8-windows table is a disclosure; Devices & Settings dropped its copy of the simulated device details (kept: the device inventory with links to Device and Overview, the session/application details and the admin audit trail); the Lab metadata fields are labelled as recorded metadata, not simulation controls; about 47 MB of regenerable logs and screenshots were deleted from `.tmp/` (credentials, `legacy_bench` and scripts kept). Feature removal (19 Oct): the simulation-mode *Motor Control* page (`MotorControlPage`, a second set of physical START / speed / STOP controls reachable only from simulation mode, where it could command a connected board) is deleted; simulation mode no longer lists the `control` page and a stale selection falls back to Overview, while physical mode keeps the same id as Safety & Commissioning; the Lab's imbalance mass and radius inputs (a physical-rig record in a simulation-only lab) are removed, Notes kept as recorded metadata and now shown in the session record; its commissioning, limits and interlock unit tests now run in physical mode, the five tests of controls that existed only on that page were removed with it;

15. **Analyst experience redesign** (19 Oct): navy sidebar and light default theme; the shared `JourneyBar` (`simulation/journey.jsx`, states from `pipelineStages` only); grouped `InterlocksCard`; evidence-first ordering of AI Diagnostics, Predictions and Recovery; Scenario Studio presets and field hints (outside the labels, via `aria-describedby`); Live Monitor signal filter and numbered event marks (`eventMarks`, `TrendLines` `marks`); the trend axis keeps the chart's precision (vibration no longer repeats 0.07); three text tokens raised to WCAG 4.5:1 (`--tq-faint` in both themes, the dark sidebar headings). New tests cover the Physical Overview controls the deleted Motor Control page used to test (exact rejection reasons, a single SET_SPEED, operators and viewers limited to STOP), the journey bar, the interlock grouping, the presets and the Live Monitor filter and marks. Two E2E lessons: Playwright `has-text` is case-insensitive, so new visible or screen-reader text can capture an existing selector (the tag text "in one run" captured `button:has-text("Run")`), and a second `<nav>` element is matched by `nav button:has-text(...)`, so the bar uses `role="navigation"` on a `div`. No backend, API, firmware or safety change. Reviewed and left as they were: Interventions and Diagnostic Tests (already key step first) and the confirmations (every consequential action already has a two-step confirm; STOP stays one click). Not reworked yet: Digital Twin, Learning, Evaluation, Device and Devices & Settings beyond the shared styling.

Test status (19 Oct, after item 15): frontend 209/209; build passes (initial JavaScript ≈ 368 kB; the workflow page is a chunk loaded on demand); browser E2E all seven suites pass: workflow 30/30, workbench 47/47, app 66/66, twin 44/44 against the software-only backend (re-run after the last change), and lab 12/12 (second attempt; Vite crashed in the first), c2c4 23/23 (noise-aware C2), attestation 32/32 (fresh backend) against a token backend (operator / viewer / admin, no device access) with Vite on 127.0.0.1:5173; the original torqva.e2e.mjs was 30/30 after item 13 and not re-run for item 14; no horizontal overflow at 1440 px (light) and 390 px (dark, every disclosure open) on the item-14 pages in both modes; backend 702 passed / 5 failed / 1 skipped (the same 5 firmware source checks; 22 of the passes are the workflow tests, 1 the force-unlock regression test); firmware host tests 105 passed / 25 failed (see section 10, item 2); store integrity check on an API-populated store: clean. Identical to the baseline taken before the cleanup.

---

## 10. Known issues and open decisions

1. **Fixed (14 and 18 Oct):** `npm run dev` no longer sets `TORQVA_FORCE_UNLOCK=1` or opens COM7, and the backend bypass itself is removed: the flag used to report the session as active, the limits as confirmed and the E-stop input as released, clear every blocker and even mint a Safety Supervisor approval after a refusal. It now has no effect (a regression test sets it and checks that every blocker, refusal and status is unchanged).
2. **Firmware protections were relaxed in an earlier commit** (`319fb7b`): over-current/voltage/stall/heartbeat protections loosened, E-stop auto-resets on command, authentication skipped, brown-out detection off, instant "COMPLETED" acks. The 5 failing backend tests are exactly these firmware safety checks, and 25 firmware host tests fail, including `test_stop_is_never_blocked_by_the_interlocks`, `test_wrong_key_cannot_start_motor` and the over-current, voltage, sensor-loss, rpm-loss, heartbeat and session trips. The firmware is unchanged since that commit. **This blocks any physical run** until a person decides to restore the protections.
3. Backend commissioning API silently defaults voltage limits to 0–26 V when omitted; device autoconnect retries every 1 s (was 5 s).
4. The speed status bands (normal 1100–1500 rpm around 1300) are a display choice, not approved limits.
5. Physical AI is not possible yet: C1 needs vibration RMS and shaft-order harmonics the firmware doesn't compute; no physical baseline or held-out evaluation exists.
6. Hardware readiness gaps: wiring unconfirmed, independent E-stop not installed, no secure (encrypted) device transport, no relay or reset button.
7. Legacy data kept on purpose: `backend/data/motor_monitor.db` (untracked, ignored) is the retired prototype's SQLite file: 696 telemetry rows (including `live` hardware readings), 465 alerts and 58 baselines, integrity OK, no exact duplicates. No current code opens it; deleting or archiving it needs an explicit decision because it holds historical measurements. (The empty `assets/` placeholder was removed, `torqva.e2e.mjs` was repaired, and the package is now `torqva-frontend`.)
8. The website has no URL routing: pages are switched in app state, so a page cannot be bookmarked or reloaded in place.
9. The simulator's in-memory history (`orch.buf`, `orch.scores`, `orch.log`) grows by one entry per simulated second without a limit. It is not capped yet because other records point into it by position (a running test's start index, the trace's and Decision Receipts' log entry numbers); a cap needs those references re-based first.
10. The branch `torqva/phase-0-audit` is pushed but not merged into `main` (no pull request yet).
11. The 3D twin is illustrative: no CAD model or measurement of the real rig exists, so sensor positions, the disc size, wiring routes and the motor internals are typical, not this unit's. The rotation direction depends on unverified motor polarity. The twin shows no C2 prediction overlay because predictions are system-level, not tied to a component. Performance was measured in headless Chrome only; real-display frame rate and GPU time are unmeasured, and the first selection of a mechanical part still costs one ~12 ms frame.
12. The analyst workflow's limits: C2 interval widths are calibrated per action, not per target speed; the outcome signatures and the predictor are learned in simulation; a test sequence runs on a copy, so a fault the scenario schedules for later is not applied in it (the result says so); an analyst can only execute when the scenario requires human approval and the pipeline holds an action. Physical diagnostics stay locked (no vibration RMS or harmonics from the firmware, no torque sensor).
13. The Diagnostic Workflow's limits: its test runs on a copy of the live simulated motor, so the live decision gate (evaluated on the live run's ranking) can disagree with the test-informed recommendation, and execution is then blocked with that reason; a run on the copy takes about 0.03 s, so the page shows real stage timestamps rather than progress inside a test; workflow records are held in memory for the backend process; C2 risk is often 0.00 for every reduction target in the test scenarios, so targets A, B and C usually differ only in their predicted values and the pipeline's own 70 % target is kept.
14. Repository hygiene left for a decision: `.tmp/` (about 151 MB after the regenerable logs and screenshots were deleted, git-ignored) holds agent scratch files, including what look like a token (`op.tok`), key-provisioning material (`provision_rig1`) and a 134 MB `legacy_bench`; review it by hand rather than bulk-deleting. 103 tracked files have CRLF line endings in the working tree and the rest LF (Git stores LF either way); a `.gitattributes` would make this consistent.
15. **Resolved (19 Oct):** Physical Overview's START / speed / STOP controls now have their own tests (two-step START, exact rejection reasons, a single SET_SPEED, STOP-only for operators and viewers).
16. `torqva_twin3d_engine.test.js` is timing-sensitive: it failed twice in full runs while the machine was busy and passes alone and in every other full run.
17. Claude Code may stop a long-running `npm run dev:sim` when the machine is low on memory; restart it with `npm run dev:sim` from `frontend/` when needed.
18. If the process that started `npm run dev:sim` is killed from outside (for example a terminal or tool that ends only the npm wrapper), the launcher and its two servers keep running and hold ports 8000/5173; stop them before starting another. Separately, the Vite dev server crashes natively (Windows exit code 0xC0000409 / 3221226505) during browser E2E runs, repeatedly on 19 Oct (running the backend and Vite as separate processes let the suites finish); the launcher now reports it, the trigger is not identified (rapid screenshot writes into the watched folder did not reproduce it).

## 11. Likely next steps

- Decide on item 2 (restore the firmware protections so the 25 firmware and 5 backend safety tests pass).
- Open a pull request from `torqva/phase-0-audit` into `main`.
- Continue the redesign on Digital Twin, Learning, Evaluation, Device and Devices & Settings.
- Decide what happens to `backend/data/motor_monitor.db` (keep, archive or delete; it holds historical live readings) and review `.tmp/` (section 10, item 14).
- Hardware bring-up following `docs/TORQVA_HARDWARE_BRINGUP_CHECKLIST.md`: confirm wiring, install and verify the E-stop, commission limits, authenticated session.
- Physical data path for AI: compute vibration RMS / harmonics in firmware, record labelled physical sessions, fit and evaluate C1 on real data, then C2/C4 matched-condition experiments.
- Optional: CI workflow (tests + build), TypeScript migration of the frontend API layer.

## 12. Glossary

- **Provenance badges:** `SIM` simulated · `HW`/`MEASURED` from the device · `PRED` prediction · `DERIVED` computed from other values · `CMD` a commanded value (e.g. setpoint), not a measurement.
- **Incident:** an anomaly episode tracked by a state machine from detection to recovery or closure.
- **FITL:** firmware-in-the-loop — the real firmware core compiled for the host and driven by backend tests.
- **Interlock / blocker:** a named condition that keeps physical START/speed refused (e.g. DEVICE NOT CONNECTED, SAFETY LIMITS NOT APPROVED).
- **Commissioning:** the human, evidence-backed record that approves limits and enables physical control.
