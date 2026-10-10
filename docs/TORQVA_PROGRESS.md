# TORQVA — Progress

Direction (latest human instruction): **software first, hardware last.** Do not flash or run the motor. Hardware integration (Phase 8) starts only after software acceptance and needs explicit human authorization.

## Phase status (software-first plan)
| Phase | Status |
|---|---|
| 1 Firmware foundation | **Done except the ESP32 compile result** (see below). Core logic, device layer, protocol, deterministic sim plant, 65 host tests. `src/main.cpp` written; `pio run -e esp32s3` was still downloading the toolchain when this was written |
| 2 Software architecture | **Done** (`docs/TORQVA_ARCHITECTURE.md`; modules under `backend/torqva/`) |
| 3 Intelligence pipeline C1–C6 | **Done in simulation.** C1, C2, C3, C4 (T1/T3/T4), C5, C6 implemented and tested. C2 is *unvalidated*; C6 never run on real data |
| 4 Backend + data layer | **Mostly done for simulation.** Done: typed schemas, SQLite document store (records scoped per simulation session), append-only audit (DB triggers block update/delete), dispatcher with ack/timeout/TTL/resend/idempotency, Safety Supervisor, **token auth with roles (fail closed)**, `/api/torqva/*` routes (status, telemetry, incidents, decisions, predictions, commands, outcomes, cases, approve/reject, stop, reset-estop, audit, simulation start/step), mounted in `main.py`. Legacy `POST /api/motor` now requires an operator token **once `TORQVA_TOKENS` is set** (unchanged otherwise). **Not done:** WebSocket push, serial bridge for a real device, rate limiting, token rotation/expiry, HTTPS/CORS tightening (CORS is still `*`), learning/model-registry endpoints |
| 5 UI/UX | **Not started** |
| 6 Research validation | **Done for simulation** (`docs/TORQVA_EVAL_SIM.md`); real/measured section empty by design |
| 7 End-to-end software acceptance | **Done in simulation** (`tests/test_torqva_e2e.py`, 11 tests incl. failure paths). Gaps listed below |
| 8 Hardware integration | **Not started, deliberately last** |

## Test / build results (actually run, this session)
| Check | Command | Result |
|---|---|---|
| Firmware host tests | `cd esp32/torqva_fw && pio test -e native` | **65 / 65 passed** (41 core logic, 24 protocol + device-with-sim-plant) |
| Backend | `cd backend && python -m pytest -q` | **227 passed, 2 failed** (includes 4 firmware-in-the-loop conformance tests and 14 API/auth tests). The 2 failures are the pre-existing `[trio]` parametrisations (`ModuleNotFoundError: No module named 'trio'`); unrelated to TORQVA |
| Frontend | `cd frontend && npm test` | 24 / 24 passed (unchanged legacy UI) |
| Simulation evaluation | `cd backend && python -m torqva.evaluation` | runs in ~5 s; results in `docs/TORQVA_EVAL_SIM.md` |
| ESP32-S3 compile | `pio run -e esp32s3` | **NOT YET CONFIRMED** (see "ESP32 compile" below) |
| Lint / typecheck | – | none configured (not run) |

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
1. Confirm `pio run -e esp32s3` compiles; fix any errors (compile-only, no flashing). **First attempt failed: the Xtensa toolchain download broke mid-transfer (`IncompleteRead`, flaky network). A retry was started; result not yet known.**
2. Extend conformance to test execution (T1/T3/T4 timelines) and telemetry frames.
3. Phase 4 remainder: WebSocket push, serial bridge, token expiry, learning/model-registry endpoints.
4. Phase 5: UI per `TORQVA_ARCHITECTURE.md` (provenance badges on every value; simulation banner; unvalidated-C2 label).
5. Re-run the evaluation after improving the false-confident rate (e.g. an explicit "none of the above / sensor" check); add harder simulator regimes.
