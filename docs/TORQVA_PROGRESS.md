# TORQVA — Progress

Direction (latest human instruction): **software first, hardware last.** Do not flash or run the motor. Hardware integration (Phase 8) starts only after software acceptance and needs explicit human authorization.

## Phase status (software-first plan)
| Phase | Status |
|---|---|
| 1 Firmware foundation | **Done except the ESP32 compile result: NOT CONFIRMED (toolchain download failing/slow, see Session 3 §1)**; was:  (see below). Core logic, device layer, protocol, deterministic sim plant, 65 host tests. `src/main.cpp` written; `pio run -e esp32s3` was still downloading the toolchain when this was written |
| 2 Software architecture | **Done** (`docs/TORQVA_ARCHITECTURE.md`; modules under `backend/torqva/`) |
| 3 Intelligence pipeline C1–C6 | **Done in simulation.** C1, C2, C3, C4 (T1/T3/T4), C5, C6 implemented and tested. C2 is *unvalidated*; C6 never run on real data |
| 4 Backend + data layer | **Mostly done for simulation.** Done: typed schemas, SQLite document store (records scoped per simulation session), append-only audit (DB triggers block update/delete), dispatcher with ack/timeout/TTL/resend/idempotency, Safety Supervisor, **token auth with roles (fail closed)**, `/api/torqva/*` routes (status, telemetry, incidents, decisions, predictions, commands, outcomes, cases, approve/reject, stop, reset-estop, audit, simulation start/step), mounted in `main.py`. Legacy `POST /api/motor` now requires an operator token **once `TORQVA_TOKENS` is set** (unchanged otherwise). **Not done:** WebSocket push, serial bridge for a real device, rate limiting, token rotation/expiry, HTTPS/CORS tightening (CORS is still `*`), learning/model-registry endpoints |
| 5 UI/UX | **Browser-inspected, defects fixed, Lab added.** First slice done at `/#/torqva` (legacy dashboard remains the default): sign-in, persistent SIMULATION banner on every view, provenance badges, Overview (scenario control, STOP, device state), Live (speed, anomaly score ÷ threshold with gaps, thermal/vibration), Investigation (posterior bars, gate verdict + inputs, test result, state history), Decisions (C2 table labelled *Intervention Outcome Prediction (unvalidated)*, supervisor decisions, approve/reject gated by role, commands with device-ack status), Recovery (criteria pass/fail, observed vs predicted), Learning & Evaluation (reads the latest EvaluationRun), Audit (admin). Lab screen built (Session 3 §3). **Not built:** Motors list, commissioning wizard, Cases/Timeline, model registry/promotion/rollback screen, System Health, Settings, WebSocket push (UI polls), light theme, mobile/keyboard/contrast audit beyond basics, Playwright e2e |
| 6 Research validation | **Done for simulation, now including six held-out regimes** (`docs/TORQVA_EVAL_SIM.md`, runs 1 and 2); real/measured section empty by design |
| 7 End-to-end software acceptance | **Done in simulation** (`tests/test_torqva_e2e.py`, 11 tests incl. failure paths). Gaps listed below |
| 8 (per the latest instruction) C1 robustness under distribution shift | **Done in simulation, opt-in, not claimed for hardware** — see "Session 4 — Phase 8" below. Selected candidate B+C (trusted-warm-up session reference + explicit UNFAMILIAR verdict); `hard_shift` 36 % and `session_shift` 14 % false FAULT remain |
| 9 Trusted healthy-session attestation | **Done in simulation** — see "Session 5 — Phase 9". Operator-authorised, audited, reversible workflow (API + UI) for the experimental adaptive C1; adaptive C1 stays opt-in and the shipped detector stays the default |
| Hardware integration (formerly numbered 8) | **Not started, deliberately last**; the human decides its number now that Phase 8 was reassigned |

## Test / build results (actually run, this session)
| Check | Command | Result |
|---|---|---|
| Firmware host tests | `cd esp32/torqva_fw && pio test -e native` | **65 / 65 passed** (41 core logic, 24 protocol + device-with-sim-plant) |
| Backend | `cd backend && python -m pytest -q` | **314 passed, 2 failed** after Phase 9 (254 → 282 in Phase 8: +28 `test_torqva_c1_robust.py`; 282 → 314 in Phase 9: +32 `test_torqva_attestation.py`). The 2 failures are the same pre-existing `[trio]` ones in `test_tcp_server.py` (`ModuleNotFoundError: No module named 'trio'`, i.e. an uninstalled optional anyio backend, not application logic); they failed identically before my changes |
| Frontend | `cd frontend && npm test` and `npm run build` | **50 / 50 passed** (24 legacy + 14 TORQVA + 5 Lab + 7 Attestation); production build succeeds |
| Live server smoke | uvicorn `main:app` with `TORQVA_TOKENS` set, curl | no token 401; viewer start 403; legacy `/api/motor` without token 401; operator-started simulation ended `RECOVERED` (SIMULATED); status reports the unvalidated-C2 label |
| Simulation evaluation | `cd backend && python -m torqva.evaluation` | runs in ~5 s; results in `docs/TORQVA_EVAL_SIM.md` |
| ESP32-S3 compile | `pio run -e esp32s3` | **NOT YET CONFIRMED** (see "ESP32 compile" below) |
| Lint / typecheck | – | none configured (not run) |


## Session 3 — browser inspection, Lab, harder evaluation

### 1. ESP32-S3 compile status — NOT CONFIRMED (do not treat the S3 firmware as compiling)
- `pio run -e esp32s3` has **not** completed. The first attempt failed while downloading the Xtensa toolchain: `Tool Manager: Error ... IncompleteRead(62954426 bytes read, 21814873 more expected)`. Later attempts stalled at 0 bytes (several concurrent PlatformIO processes also contended for the package lock; they were killed).
- Measured network: the registry API is reachable and GitHub gives ~430 KB/s, but the registry CDN download averages ~55 KB/s. A manual resumable download of `toolchain-xtensa-esp32s3` (81 MB) was started with `curl.exe -C - --retry` into `%TEMP%\pio_dl\` and was at ~33 MB when last checked; the Arduino framework package (hundreds of MB) is still needed after that. At this speed it is hours.
- What **is** verified for this firmware: the same logic compiles and passes 65 host tests and the firmware-in-the-loop CLI (`pio test -e native`, `pio run -e fitl`). `src/main.cpp` (the Arduino/ESP32 hardware layer) has never been compiled.
- Next step for this item: let the download finish (or use a faster network), then `cd esp32/torqva_fw && python -m platformio run -e esp32s3`. Compile only. Nothing was flashed.

### 2. Real-browser UI inspection (done, with Google Chrome)
- The Chrome-extension tools were not available in this session, so I drove the installed **Google Chrome (headless)** with `playwright-core`, installed in a scratch folder and not added to the project. Servers: backend `uvicorn main:app` on :8000 with `TORQVA_TOKENS` set, frontend `npm run dev` on :5173. I looked at the screenshots (login, Overview, Live, Investigation, Decisions, Recovery, Lab, and the 390 px layouts).
- Exercised: wrong-token sign-in, scenario start, Run, the whole incident → approval → device acknowledgement → RECOVERED path (reached in the browser), every view, keyboard navigation (Tab/Enter, visible focus outline), widths 1440/1024/768/390, and a simulated network failure.
- **Defects found and fixed:**
  1. Run and STOP stayed disabled right after starting a simulation, because sim time 0 was treated as "no simulation" (regression test added).
  2. At 390 px the page was 383 px wider than the viewport (tables).
  3. The anomaly-score chart was unreadable because one ~200× spike flattened the threshold line; now log scale with a labelled threshold.
  4. Charts had no legend and crowded x-axis labels.
  5. The STOP prediction interval went negative (−0.086 g); clipped at 0 in the predictor.
  6. The commands table "#" column showed history length instead of the command id.
  7. The Lab checklist ticks only appeared after the server round trip; now optimistic.
- After the fixes: no horizontal overflow at 1024/768/390 on any view; no console errors except the one deliberate aborted request in the failure test; no HTTP ≥ 400 apart from my deliberate wrong-token attempt.
- **Not covered:** Firefox/Safari, a physical phone, screen readers, measured colour contrast, reduced-motion behaviour, the Audit view with many rows, polling for more than ~10 minutes.
- Opt-in E2E scripts are in `frontend/e2e/` (`torqva.e2e.mjs`, `torqva-lab.e2e.mjs`, README). They need `npm i --no-save playwright-core`. Playwright is **not** a project dependency (adding one needs sign-off) and they are not part of `npm test`.

### 3. Lab (`backend/torqva/lab.py`, `/api/torqva/lab/*`, "Lab" screen)
- **Reproducible sessions:** a session is fully defined by regime + seed + speed profile + fault injection. Re-running gives the same window hash (`POST …/reproduce` compares them; tested bit-for-bit; a different seed gives a different hash).
- **Fault-injection records:** ground truth (fault, severity, injection time, clears-below-rpm) plus physical settings (mass g, radius mm, …), operator, purpose, notes and config hash are stored with the session.
- **Configurable regimes:** six regimes selectable per session and per experiment. The default reproduces the previous simulator exactly (tested).
- **Pre-run checklist:** guard, masses secured, e-stop tested, area clear, limits reviewed. All items are required before a run, logged to the audit trail with the user, and labelled a procedure, not a safety mechanism.
- **Blind sessions:** the injected fault and config hash are redacted from every read until a human reveals them after the run. The model output is stored (frozen) at run time; a test checks the reveal does not change it. Healthy sessions abstain instead of guessing.
- **Experiment comparison:** each action (continue / reduce / stop) runs from identical starting conditions (same seed ⇒ identical pre-action history, checked by hash) for 1–10 repeats. Reports per-action/signal MAE vs persistence, 90 % interval coverage, risk Brier score, and whether C2's ranking matched the measured best action (ties counted). Marked `validated_c2: false`; it validates nothing on hardware.
- Roles: viewer reads; operator creates/runs/reveals/reproduces; admin reads the audit log. Every Lab action is audited.
- Verified in the real browser: regime description updates, step add, checklist gating, blind hiding before and after the run, "reproduced identically", reveal ("Truth: looseness · model: looseness · match"), the experiment table, and no overflow at 768/390.

### 4. Harder, held-out evaluation (`docs/TORQVA_EVAL_SIM.md`, run 2)
- Simulator regimes: more noise, healthy session-to-session shifts, a sensor fault that mimics looseness at one speed (speed-independent noise on the harmonic channels), intermittent faults.
- New deterministic safeguards: an out-of-distribution ("unfamiliar evidence") guard on the hypothesis posterior and on C4 test outcomes; likelihood-temperature calibration on a disjoint validation set; and a **gate rule that looseness and sensor-fault diagnoses are never "confident" until a speed-step test has run**. The Safety Supervisor was not changed.
- Headline (simulation only): in the look-alike regime the uncalibrated model turned **27/27 sensor faults into confident "looseness"**; with the safeguards there are **0 false-confident decisions**, at 33 % abstention. In the combined `hard` regime false-confident decisions drop from 63/171 to 0 at 77 % abstention. After the follow-up T1 test, 4 decisions in the look-alike and hard regimes are still confidently wrong and 23–37 are escalated as an unfamiliar test outcome.
- **Limitations the study exposed (not fixed):** C1 flags 100 % of healthy runs in the noisy and hard regimes (56 % under session shift); C2 interval coverage falls to 74–76 % mean / 17 % worst cell in those regimes and the C2 trust check correctly refuses; temperature calibration had no effect (T = 1) because the validation set had no look-alike fault; T1 signatures fitted on one sensor-fault style do not transfer to another.
- Autonomy: **none enabled.** Hardware mode still requires explicit human approval for every motion command; simulation auto-approval is a simulation-only setting.

## Session 5 — Phase 9: trusted healthy-session attestation (simulation only)
Nothing was flashed, the motor was never operated, wiring/firmware untouched, no history rewritten (Phase 8 is `7047821`; Phase 9 is a new commit). Design, state machine, authorisation, audit schema, promotion/rollback and limitations: `docs/TORQVA_ARCHITECTURE.md` section 5. Evaluation methodology did **not** change (`TORQVA_EVAL_SIM.md` notes this).

- **Built:** `backend/torqva/attestation.py` (6-state candidate machine PENDING/ELIGIBLE/ATTESTED/REJECTED/EXPIRED/REVOKED; 14 deterministic eligibility checks that fail closed; held-out validation of the candidate on the last 25 % of the same recording; immutable reference versions; activation/rollback/revocation), `/api/torqva/attestation/*` routes (reads: viewer; every mutation: operator/admin, enforced in the route and again in the service), `Store.put_audited` (record + audit row in one transaction, compare-and-set revisions) and an immutable `ref_versions` table, an "Attestation" tab in the TORQVA workspace (candidate list with state labels, evidence view, pass/fail checks, confirmation with reason + acknowledgement, history, reference versions, log, a permanent "operator judgment, not proof of health" notice; SIM / HUMAN / DERIVED badges), and an operator-declared, audited, bounded **supervised warm-up hold** (`Orchestrator.begin_supervised_warmup`) that defers only score-triggered incident opening.
- **Why the hold exists (found while testing):** with a gain-shifted but healthy motor the live pipeline opens an incident within seconds, so the strict "no incident" rule would have excluded exactly the sessions the feature is for. The hold is the explicit, audited, time-limited answer; mandatory-stop conditions are never deferred (tested). Cost: a real fault is flagged up to the hold length later.
- **Tests (adversarial, through the real router + auth):** 32 backend tests — unauthenticated / wrong role (also at the service layer), repeated and stale decisions, missing/stale/gappy/invalid/NaN telemetry, active incident, mandatory stop during warm-up and after capture, sensor faults, mixed operating conditions, gradual drift, unseen speed, common-mode shift (eligible only with a warning), contaminated warm-up under a hold, concurrent attestation (exactly one winner) and attest-vs-reject race, trained bins unchanged and `ref_versions` UPDATE/DELETE refused, revocation + rollback, one audit row per state change, audit-write failure rolls everything back (500, nothing changed), tampered evidence detected, STOP and mandatory stop still effective with an active reference, default detector untouched, and a UI field-contract test. 7 frontend tests.
- **Live check:** `uvicorn main:app` with `TORQVA_TOKENS`: no token 401, viewer GET 200, viewer capture 403, operator capture without a simulation 409, with a simulation an ELIGIBLE candidate. The UI was verified by component tests and a production build; **not** inspected in a real browser this phase.
- **Unresolved risks:** (1) a wrongly attested warm-up that is coherent across channels and inside the envelope can still be absorbed — attestation is one operator's judgment; (2) the hold delays score-based detection by up to its length; (3) a healthy common-mode shift is indistinguishable from a sensor gain fault (shown as a warning); (4) references apply to one session only; (5) no two-person rule, no token expiry; (6) lazy expiry (on read/decision); (7) everything is simulated, nothing is hardware evidence; (8) Phase 8 limits stand (hard_shift 36 %, session_shift 14 % false FAULT; ESP32-S3 compile unverified).

### Commands run (Phase 9)
| Purpose | Command | Result |
|---|---|---|
| Phase 9 backend tests | `cd backend && python -m pytest tests/test_torqva_attestation.py -q` | 32 passed |
| Full backend | `cd backend && python -m pytest -q` | 314 passed, 2 failed (`[trio]`, `No module named 'trio'`: environmental, same two as before) |
| Frontend | `cd frontend && npm test` · `npm run build` | 50/50 · build ok |
| Firmware host tests | `cd esp32/torqva_fw && python -m platformio test -e native` · `python -m platformio run -e fitl` | 65/65 · fitl built (host only) |
| Baseline unchanged | `cd backend && python -m torqva.evaluation` diffed against the pre-Phase-8 run | identical |
| Lint / type check | none configured | not run |

## Session 4 — Phase 8: robust C1 under distribution shift (simulation only)
Nothing was flashed, the motor was never operated, wiring and firmware are untouched (`git diff` shows no `esp32/` change). Full methodology, per-regime tables and limitations: `docs/TORQVA_EVAL_SIM.md` (Phase 8 section).

- **Root cause:** the C1 baseline is fitted on a single healthy session whose per-feature scales equal that session's own noise; common-mode vibration-gain shifts (±10 %) and noise (×1.5–×2) are multiple σ on five correlated channels. Not speed bins, temperature or supply. A secondary finding (not fixed): the "steady" gate admits the end of the speed-up ramp, inflating the trained duty/voltage/power scales, which hides supply-voltage faults ≤ 0.1 severity.
- **What was built:** `backend/torqva/c1_robust.py` (candidates A/B/C, versioned & reversible reference registry), `backend/torqva/c1_study.py` (reproducible experiments: 3+2 validation and 16 test regimes, session-level splits, per-session records), 28 new tests, opt-in pipeline hooks (`PipelineConfig.adaptive_warmup_s`, `Orchestrator.attest_healthy_warmup / rollback_reference / regime_assessment`). `evaluation.build_models` now builds the bit-identical `AdaptiveBaselineDetector` (output of `torqva.evaluation` is byte-identical before/after).
- **Result (held-out, simulation):** control false FAULT 100 % at noise ×2 / gain ×1.25 / ×0.8 → **0 %** with B+C; session_shift 69 % → **14 %**; hard_shift 100 % → **36 %**; drift / step → 0 % false FAULT (escalated); unseen speeds (control silently healthy) → explicit UNFAMILIAR. Recall at severity ≥ 0.3 unchanged (1.00; 0.83 under gradual drift, remainder escalated); severity 0.1 costs up to ~0.15. Robust statistics (A) and 4-session training did not help.
- **Safety:** Safety Supervisor unchanged; with an attested warm-up pending, score-based incident opening is deferred but a mandatory-stop condition still opens an incident immediately (tested). Default configuration is exactly the old behaviour.
- **Unresolved risks:** (1) residual false FAULT from healthy current offsets ≳ 0.06 A (deliberately not adapted — overload shares the channel; human decision); (2) noise ×3 outside the envelope; (3) the common-mode-vs-channel-selective assumption and the whole result are simulator-only; (4) escalation burden (11–36 of 36 healthy sessions in noisy/drift regimes); (5) attestation is a human act — the UI/API workflow now exists (Phase 9), and a wrongly attested, channel-coherent faulty warm-up remains an unresolved contamination risk (a pending warm-up is capped at 3x its length, then scoring resumes unadapted); (6) mild-fault recall cost; (7) ESP32-S3 compile still unverified.

### Commands run this session
| Purpose | Command |
|---|---|
| Phase 8 validation / final | `cd backend && python -m torqva.c1_study validate` · `python -m torqva.c1_study final` |
| Phase 8 tests | `cd backend && python -m pytest tests/test_torqva_c1_robust.py -q` (28 passed) |
| Regression | `cd backend && python -m pytest -q` (282 passed, 2 pre-existing `trio` failures) · `cd frontend && npm test` (43/43) · `npm run build` (ok) · `cd esp32/torqva_fw && python -m platformio test -e native` (65/65) · `python -m torqva.evaluation` (unchanged output) |
| Lint / type check | none configured in the repository (not run) |

### Commands run (session 3)
| Purpose | Command |
|---|---|
| Backend tests | `cd backend && python -m pytest -q` |
| Frontend tests / build | `cd frontend && npm test` · `npm run build` |
| Firmware host tests | `cd esp32/torqva_fw && python -m platformio test -e native` |
| Firmware-in-the-loop CLI | `python -m platformio run -e fitl` (used by `tests/test_torqva_conformance.py`) |
| Simulation evaluation | `cd backend && python -m torqva.evaluation --out run.json` |
| Run the app | backend: set `TORQVA_TOKENS` (sha256 of a token; `python -m torqva.auth` prints one), then `python -m uvicorn main:app --host 127.0.0.1 --port 8000`; frontend: `npm run dev`; open `http://127.0.0.1:5173/#/torqva` |
| Browser E2E (opt-in) | `npm i --no-save playwright-core` then `TORQVA_TOKEN=<token> node e2e/torqva.e2e.mjs` |

## What was built
- **Firmware** (`esp32/torqva_fw`): versioned limits, latching safety monitor, soft-start/ramp/PI/drive, command validator (idempotent; STOP never refused), on-device test executor (T1/T3/T4), JSON-lines protocol, `Device` (hardware-agnostic), `SimPlant`, Arduino hardware layer. **Motor commands are rejected unless built with `-DTORQVA_CONTROL_ENABLED=1`** (not set anywhere). Outputs forced OFF first thing in `setup()`.
- **Backend** (`backend/torqva`): `supervisor` (deterministic; mints the only executable type `ApprovedAction`), `dispatch`, `incident` (table-driven state machine, 46 tests), `detection` (C1 + drift guard + thermal tracker), `hypotheses`, `gate` (C3), `diagnostics` (C4), `prediction` (C2), `recovery` (C5), `learning` (C6 registry), `sim`, `simdevice`, `pipeline` (orchestrator), `store`, `evaluation`.

## Bugs the tests caught (kept so they are not repeated)
1. Firmware: duplicate command id returned the original ack but **re-executed the command**. Fixed (`last_was_duplicate`), regression test added.
2. Supervisor: a mandatory stop blocked even the admin RESET_ESTOP, so a latched e-stop could never be reset. Fixed; reset still blocked while a physical limit (temp/current/voltage/vibration) is exceeded.
3. C1: healthy motor at a speed between training points scored as anomalous (single-speed bins). Fixed with anchor-based interpolation + per-feature scale floors. **Implication for commissioning: sweep speeds *inside* each bin.**
4. Hypotheses: healthy pre-onset windows were used as evidence and flipped a correct imbalance diagnosis to sensor-fault. Fixed (only anomalous windows are evidence).
5. T1 could not tell imbalance from looseness (both have the same 1× exponent). Added the 2×/3× harmonic exponent as an observation.
6. C2 trust check initially required every signal×action cell ≥ 80 % coverage, which blocked all autonomous action on small test sets; relaxed to mean ≥ 80 % and worst cell ≥ 50 % (a judgement call: see Decisions).

## Decisions
| ID | Decision |
|---|---|
| D-01 | PlatformIO approved by the human; project in `esp32/torqva_fw/`, legacy Arduino sketch untouched |
| D-02 | Existing backend/frontend stacks kept; TORQVA added beside them (`backend/torqva/`) |
| D-03 | Pin map Option B chosen by the human (`config_pins.h`, wiring ID reported as `W0-optionB-UNVERIFIED`) |
| D-04 | Legacy `health_engine` kept as the "fixed thresholds" baseline |
| D-05 | Old `docs/HARDWARE_WIRING.md` left in place, marked unreliable (Audit R-2) |
| D-06 | Local git repo; branch `torqva/phase-0-audit` carries all work so far; no remote |
| D-07/08 | Fail-safe defaults: `max_rpm` and vibration stop limit = 0 ⇒ SET_SPEED and all diagnostic tests refused until a human commissions them; STOP bypasses auth/TTL/seq; test abort holds the lower speed |
| D-09 | numpy only (no new heavy deps; scikit-learn unused). `numpy>=1.26` added to `backend/requirements.txt` (it was in the original default stack) |
| D-10 | Python `SimDevice` re-implements firmware rules for the e2e simulation; ack-level conformance with the C++ core is tested (gap 5). The C++ firmware now sends a single final ack when execution refuses a validated command (previously ACCEPTED then REJECTED) |
| D-11 | Lost ack ≠ not executed on the device. The pipeline conservatively records an un-acked command as EXPIRED/TIMEOUT (not executed) and re-decides from fresh telemetry |
| D-12 | In simulation, supervisor auto-approves (configurable `auto_approve_in_simulation`); in HARDWARE mode every motion command needs `human_approved` |

## Known gaps / risks (honest list)
0. **Session 3:** ESP32-S3 compile unconfirmed; C1 not robust to noise/session shift; sensor-fault style generalisation; C2 coverage collapses under noise; the Lab runs on the simulator only and records nothing from real hardware.
1. **ESP32 compile unverified.** Device code (`src/main.cpp`) has never been compiled for the S3; may need small API fixes.
2. **Authentication exists for TORQVA routes and (opt-in) the legacy motor route**; but default (no `TORQVA_TOKENS`) leaves the legacy `/api/motor` open exactly as before, CORS is `*`, tokens do not expire. The shared `k` key on the serial protocol is a placeholder.
3. **Sim-only evidence.** Simulator uncalibrated and too easy (faults detected at 2–5 % severity). False-confident hypothesis rate 4.9 % is too high for autonomous action on a real rig.
4. **C2 not validated** (no Intervention Outcome Experiments); intervals under-cover slightly (mean 88 % vs 90 %, worst cell 58 %). UI must say "Intervention Outcome Prediction (unvalidated)".
5. **Python SimDevice vs C++ firmware conformance**: now tested for the command/ack protocol (`tests/test_torqva_conformance.py`, built from `pio run -e fitl`; skipped if the CLI is not built). It found and fixed one divergence (tests need closed-loop running). Coverage is the validation matrix + e-stop/reset flow only, not telemetry or timing of test execution.
6. Legacy dashboard still presents "health %" values from single-point baselines; not changed.
7. Accelerometer: current firmware layer reports vibration as invalid (no ADXL345 task yet) — vibration limit and all tests stay disabled on hardware until implemented and commissioned.
8. Wiring doc, pin map and hardware ratings are unverified drafts (by design, Phase 8).
9. No FFT/raw-burst path, no Wi-Fi transport, no OLED in the new firmware.

## Human tasks (all deferred to Phase 8, none blocks software work)
Unchanged from the earlier list (E-stop + relay, EN pull-downs, 0.05 Ω shunt, IS wiring, 2nd DS18B20, Hall 5 V supply, guard, PSU model/limits). **Do not run the motor with legacy firmware unattended** until the hardware safety items are done.

## Next steps (in order)
1. Finish the ESP32-S3 compile (toolchain + framework download on a working connection; `python -m platformio run -e esp32s3`; fix any errors; compile only).
2. ~~Make C1 robust to noise and session shift~~ **Partly done (Phase 8, simulation):** noise ×2 and gain shifts now 0 % false FAULT; session_shift 14 % and hard_shift 36 % still above the 5 % target (cause: healthy current offsets, see Session 4). Next for C1: decide whether to adapt the current/duty offset (needs a rule that keeps mild overload detectable), fix the ramp-tail scale inflation in training ("steady" gate), and re-validate with measured data.
3. Broaden the C4 signature library across sensor-fault styles and re-measure the looseness-vs-sensor pair; add a multi-speed (T2 sweep) test.
4. Lab: commissioning wizard (speed-bin coverage, sweeping inside each bin), session-comparison view, export of session records.
5. WebSocket push + serial bridge; token expiry; model-registry/rollback screen; System Health.
6. Hardware integration stays last, after your review: verify wiring, PSU and sensor ratings, E-stop/relay; explicit authorization before any flash or energised test.
