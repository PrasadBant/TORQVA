# TORQVA firmware and integration readiness (Phase 14)

**This is not hardware commissioning.** Nothing was flashed, no motor was operated, nothing was wired or measured. Everything below was checked in software: the C++ firmware core on the host, the ESP32-S3 target compile, and the Python backend.

## What was verified (and how)

| Check | Command | Result |
|---|---|---|
| Firmware core unit tests (host) | `cd esp32/torqva_fw && python -m platformio test -e native` | 67 / 67 pass (65 existing + 2 new non-finite-signal tests) |
| ESP32-S3 target compile, default build (control disabled) | `python -m platformio run -e esp32s3` | **SUCCESS** (toolchain xtensa-esp32s3 8.4.0, framework-arduinoespressif32 4.20017; RAM 6.2 %, flash 9.5 % of the 16 MB board profile). The toolchain/framework download that blocked earlier phases succeeded in this session. |
| Compile with motor control enabled and the placeholder key | `PLATFORMIO_BUILD_FLAGS="-DTORQVA_CONTROL_ENABLED=1" pio run -e esp32s3` | **Fails by design** (`#error`, see below) |
| Compile with control enabled and an explicit key | `... -DTORQVA_CONTROL_ENABLED=1 -DTORQVA_KEY=\"compile-check-key\"` | SUCCESS (compile check only; the artifact was not used) |
| C++ core vs Python `SimDevice` conformance | `pio run -e fitl` then `pytest backend/tests/test_torqva_conformance.py` | 4 / 4 identical acknowledgements |
| Telemetry / command contract on the real C++ frames | `pytest backend/tests/test_torqva_p14_contract.py` (9 tests, drives the fitl CLI) | pass |
| Safety invariants (software) | `pytest backend/tests/test_torqva_safety.py test_torqva_p13.py` | pass |

The default `esp32s3` environment builds firmware that **rejects every motor command** (`control_enabled = false`); telemetry only. Compile success says the code builds, not that it is correct on the target.

## Firmware changes in this phase (no thresholds changed)

1. `safety.cpp`: a NaN or infinite reading flagged valid is now treated as **invalid** (it previously compared false against every limit, i.e. read as "no limit crossed"). A critical signal (current, voltage, housing, rpm) that is non-finite trips `SENSOR_INVALID` after the existing 500 ms debounce; non-critical signals (ambient, vibration) cannot trip it; a NaN on one signal cannot mask a real over-limit on another. Tests were mutation-checked against the old `safety.cpp`. The hardware layer already rejected NaN through its plausibility ranges; this closes the same hole inside the pure safety logic. All `default_limits()` values are unchanged.
2. `main.cpp`: a compile-time guard: building with `-DTORQVA_CONTROL_ENABLED` without an explicit `-DTORQVA_KEY="..."` is a compile error, so a control-enabled image can never carry the built-in placeholder key `dev-key-change-me`.

## Telemetry contract (verified against the C++ frames)

* One JSON object per line. Frame types and fields (units): `fast` `{t, seq, ts, rpm [rpm], sp [rpm], duty [% of 100], v [V], i [A], p [W], q}`; `slow` `{t, seq, ts, housing [degC], ambient [degC], q}`; `status` `{t, seq, ts, fw, wiring, limits_v, state OK|WARN|EMERGENCY_STOP, reason, mode SIM|HW, drive, ctl, hb_age [ms], test}`; command acknowledgement `{t:"ack", id, status, reason}`.
* `seq` is one gapless counter shared by all frame types, so a consumer detects drops (gaps) and replays (repeats) from `seq` alone. `ts` is device milliseconds since boot, monotonic (not wall-clock).
* `q` is a bit mask (current 1, voltage 2, housing 4, ambient 8, rpm 16, vibration 32); a set bit means valid. All bits are set on the healthy simulated plant. Vibration is not implemented in the hardware layer (`vib_valid = false`).
* Commands carry `id, type, p, p2, p3, ttl, age, seq, k`; wrong key, expired ttl/age, out-of-sequence `seq`, unknown type and duty/rpm over the caps are rejected; `STOP` is never refused; a duplicate id returns the original ack.
* Heartbeat: control mode trips `HEARTBEAT_LOST` after 2 s without a heartbeat, drives duty and setpoint to zero and latches; a reset needs an authorised command **and** the local button (`EXTERNAL_ESTOP`, `RPM_LOSS` and heartbeat loss are all covered by the contract tests).

## NOT verified (and not claimed)

* **No backend consumer of firmware frames.** The TORQVA backend uses the in-process Python `SimDevice`; no code decodes the `fast`/`slow`/`status` frames from a serial or TCP link, maps `q` to a window's `valid`, tracks `seq` gaps, or computes telemetry age for the supervisor (the simulation passes `telemetry_age_s = 0`). The legacy TCP server on port 5001 speaks the older sketch's format. A serial/TCP adapter with `seq`/`ts` staleness handling is required before any hardware-in-the-loop run.
* **Wiring, electrical and sensor assumptions:** pin map (`config_pins.h`), shunt value (`TORQVA_SHUNT_OHM` 0.1 ohm, INA219 scaling), PSU current limit (`current_inst_a = 5 A` is an ASSUMPTION, human task H-10), DS18B20 index order (0 housing, 1 ambient), hall sensor 1 pulse/rev, relay and BTS7960 enable behaviour, the local button and the absence of any E-stop feedback input. Voltage window 20-25.5 V, 4 A / 2 s current stop and 60 C stop are unvalidated limits.
* **Not commissioned:** `max_rpm = 0` (speed commands rejected) and `vib_rms_stop_g = 0` (tests refused) until a human sets them; the ADXL345 vibration task is not implemented.
* Real-time behaviour on the target (100 Hz control task timing, mutex use between the control and serial tasks, brown-out and watchdog reset behaviour, USB-CDC reconnect) has never been run.
* The firmware watchdog (hardware task WDT) is not configured in `main.cpp`; fail-safety rests on the heartbeat timeout and `outputs_off()` at boot.
* All performance and prediction results in this repository come from the uncalibrated simulator.

## Required before any supervised commissioning

1. Close the open software surfaces listed in `docs/TORQVA_SECURITY_AUDIT.md`: set `TORQVA_TOKENS` and `TORQVA_DEVICE_KEY`; authenticate or remove the unauthenticated TCP port 5001 and legacy `/ws`.
2. Provision a real command key per device (NVS), never the placeholder; build control-enabled firmware only with an explicit `-DTORQVA_KEY`.
3. Write and test the frame adapter (decode, `q` -> validity, `seq` gaps/replays, staleness, heartbeat sender) against recorded real frames; make the UI badge follow data provenance (it is hard-wired to SIMULATED today; a unit test asserts no `HW` badge appears while the backend says SIMULATED).
4. Bench review of the wiring and safe-state behaviour with the motor **unpowered / load disconnected** and an independent hardware E-stop in the power path; confirm relay and driver enable fail to off on reset and brown-out.
5. Measure and set the human-owned limits (PSU limit, `max_rpm`, vibration limit) and record them with the firmware limits version.
6. Add a task watchdog on the control task; verify HEARTBEAT_LOST, RPM_LOSS, SENSOR_INVALID and local-button reset on the real board before enabling control.

## Phase 15 - firmware safety remediation (no hardware, nothing flashed)

**Scope finding.** The code quoted in the Phase 15 brief (`calculateStatuses()`, `SPEED_DEMO_MODE`, `motorStart()`, `readTemperature()` with `RPWM`/`LPWM`/`R_EN`/`L_EN`) does **not exist anywhere in this repository or its history** (`git grep` and `git log -S` find nothing). Issues A-E could therefore not be verified against that source; they were treated as requirements and checked against the code that does exist:

* `esp32/torqva_fw` (the PlatformIO target) already has a latching safety monitor, a command validator, a heartbeat timeout, a local-button reset and no demo mode. Issues A and D do not apply to it. Issues B, C and E had real gaps there, listed below.
* `esp32/firmware/smart_motor_monitor/smart_motor_monitor.ino` (the legacy sketch, not built by PlatformIO, untouched here) executes an **unauthenticated TCP `MOTOR_ON`** straight into `setMotorState(true)`, with no task watchdog, no finite-value checks and no emergency-stop input. It must not be used to drive a motor. It was not modified because it cannot be compiled or tested in this project's toolchain; retire it or port it to the `torqva_fw` architecture before any hardware phase.

### What changed in `esp32/torqva_fw`

| Requirement | Change |
|---|---|
| Start interlocks (B) | New pure-logic `interlock.{h,cpp}`. START, SET_SPEED and RUN_TEST are refused (ack `REJECTED` + reason) unless every condition is verified, checked in this order: initialised (`NOT_INITIALIZED`), limits approved by a human (`LIMITS_NOT_APPROVED`), independent E-stop input declared wired (`ESTOP_INPUT_NOT_VERIFIED`), E-stop not asserted (`ESTOP_ACTIVE`), task watchdog active (`WATCHDOG_NOT_ACTIVE`), safety state OK - WARN and latched both block (`SAFETY_NOT_OK`), current/voltage/housing/rpm valid **and finite** (`SENSOR_NOT_VALID`), snapshot younger than 250 ms, wrap-safe (`TELEMETRY_STALE`), authorised heartbeat within the timeout (`NO_HEARTBEAT`). STOP, HEARTBEAT, ABORT_TEST and RESET_ESTOP are never blocked. An all-zero input permits nothing. `DeviceConfig` is **strict when zero-initialised**; only host simulation (SimPlant, fitl, tests) sets `relaxed_interlocks`. |
| Commissioning inhibit (thresholds) | `TORQVA_LIMITS_APPROVED` and `TORQVA_ESTOP_INPUT_WIRED` build flags, both default 0, so a stock hardware build **cannot energise the motor**. `default_limits()` values were not changed and are still unapproved assumptions. |
| Latched faults (3.2, 4) | `SafetyMonitor::fault_mask()` keeps every distinct cause that tripped since the last reset (`reason()` still keeps the first). A latch does not clear when readings normalise; reset needs an authorised command **and** the local button, and never restarts the motor (drive returns to IDLE; a new START must pass the interlocks again). Tested natively. |
| Non-finite values | Shared `finite_f()`; NaN/infinite readings are invalid in the safety monitor (Phase 14) and in the start interlock. `main.cpp` also rejects non-finite INA219 values. |
| Sensor freshness (C) | DS18B20: per-sensor last-good timestamp; a reading older than 3 s (wrap-safe) is invalid. INA219: the driver cannot report a failed read, so the bus is probed every 100 ms and a missing device invalidates current and voltage. DS18B20 conversion was already non-blocking (`setWaitForConversion(false)`, request-then-read-next-second). |
| Watchdog (C) | `esp_task_wdt` with panic reset, 2 s (`TORQVA_WDT_TIMEOUT_S`, an **assumption** to be reviewed). The control task registers itself and feeds the watchdog **only after a complete read -> decide -> apply iteration**. The control task takes the shared lock with a 5 ms bound; on contention the outputs go OFF and the watchdog is not fed, so a stuck lock ends in a reset. If watchdog init or registration fails the device reports it and the interlocks keep refusing motor commands. |
| Serial robustness | An oversized line is discarded **including its remainder** (previously the tail was parsed as a new line). |
| Network/serial command security (9) | Unchanged mechanism, honestly limited: commands carry a shared key in plaintext, so anyone with access to the link can read it; replay is limited by monotonic `seq`, `ttl`/`age` and duplicate-id idempotency; there is no HMAC or confidentiality. Motor control stays disabled in the default build, and a control-enabled build needs an explicit `-DTORQVA_KEY` (compile-time guard from Phase 14). |

### Build and test results
* Native: 81 / 81 (67 previous + 14 new: 11 start-interlock/latch/wrap tests, 3 pure-logic/fault-mask tests). Removing the interlock enforcement makes 8 of them fail (mutation-checked).
* Firmware-in-the-loop contract tests: 16 / 16 (3 new strict-mode tests run the real C++ core: refusal until both decisions are declared, watchdog requirement, no restart after a latched fault, STOP never blocked). Python `SimDevice` conformance unchanged (4 / 4).
* ESP32-S3 default build: SUCCESS. Control-enabled with the placeholder key: fails by design. Control-enabled with an explicit key: compiles. **Compile only; nothing was flashed.**

### Still open (blocking for supervised hardware use)
1. **No independent emergency stop.** `main.cpp` reads no E-stop pin (`external_estop` is always false) and no GPIO or wiring contract exists, so none was invented. Needed: an E-stop in the motor power path that removes drive independently of the ESP32 (relay/contactor or driver-inhibit), with documented active level, pull resistors, cable-fault (open-circuit) behaviour, debounce and latching; then a firmware input and `TORQVA_ESTOP_INPUT_WIRED=1`. A native test cannot validate that circuit.
2. **Safe state when software fails.** After a watchdog or brown-out reset the GPIOs are high-impedance until `setup()` runs. The BTS7960 R_EN/L_EN and the motor relay nets need hardware pull-downs (or equivalent) so reset leaves the driver disabled. Not verifiable here.
3. **Watchdog behaviour on target is unverified.** Whether `esp_task_wdt_init()` succeeds with our timeout on the installed Arduino-ESP32 core (the core may already have started the watchdog) can only be seen on hardware; in that case the interlock stays closed by design. The 2 s timeout is an unreviewed engineering assumption. The Arduino loop (communications) task is not watched; its failure is covered only by the heartbeat timeout.
4. **Limits are not approved.** Current, temperature, voltage and heartbeat limits are defaults; `current_inst_a = 5 A` is an assumption (human task H-10). A 4 A / 2 s current stop and a 60 C stop are not a substitute for approved protection against stall or short-circuit current.
5. **Sensors:** vibration is not implemented (`vib_valid = false`); INA219 range/shunt/peak-current suitability, hall pulses-per-revolution and DS18B20 index order are unverified; a stopped shaft reads 0 rpm legitimately, so loss-of-pulses is only detected while driving.
6. **Transport:** serial plaintext shared key (see above); the legacy TCP/Wi-Fi path in the backend is unauthenticated. No firmware-to-backend frame adapter exists yet.
7. **Startup policy.** Motor-power-off sensor data (housing temperature, bus voltage, INA219 presence) is available before any start, so the interlocks require it; whether current and rpm can be validated without energising is a hardware-engineering decision and is not invented here (rpm validity is a flag, not a pulse check).

Nothing in this phase validates the electrical design, the driver, the motor or the wiring, and the project remains NOT READY for physical operation.

## Phase 15 follow-up - verification, legacy quarantine, transport and startup review

**Readiness classification: `SOFTWARE TESTED` / `TARGET COMPILE VERIFIED` / `HARDWARE NOT VALIDATED` / `PHYSICAL OPERATION PROHIBITED UNTIL BLOCKERS ARE CLOSED`.** Not a safety certification.

### Corrections to the earlier Phase 15 report
* "With the interlock check disabled, 8 tests fail" described a **temporary mutation** I applied to prove the tests have teeth (`if (false && ...)` in `Device::execute`, restored byte-for-byte before the commit; the committed tree contains no disabled check, `#if 0` or ignored test). There was no disabled test to repair. Mutation checks were repeated for this follow-up (transport check removed -> 3 tests fail).
* I wrote that the quoted code and pins "do not exist in the repository". More precisely: `calculateStatuses()`, `SPEED_DEMO_MODE` and `motorStart()` do not exist, but the **legacy sketch does contain** the BTS7960 pins (`PIN_RPWM` 15, `PIN_LPWM` 16, `PIN_R_EN` 17, `PIN_L_EN` 18) and `setMotorState()`.

### Supported production firmware
`esp32/torqva_fw` (PlatformIO; environments `native`, `fitl`, `esp32s3`). The legacy sketch is not the supported firmware.

### Traceability (production code -> test -> result)
Native = `python -m platformio test -e native` (88/88); FITL = real C++ core via `pytest backend/tests/test_torqva_p14_contract.py`; Static = `pytest backend/tests/test_torqva_p15_quarantine.py`.

| Safety property | Production implementation | Test | Result | Remaining limitation |
|---|---|---|---|---|
| Start is inhibited unless permitted | `Device::execute` -> `Device::start_blocked_reason` -> `start_interlock_reason` (`interlock.cpp`), for START / SET_SPEED / RUN_TEST; strict when `DeviceConfig` is zero-initialised | Native `test_interlock_*`, `test_strict_start_refused_*` (limits, e-stop wired, watchdog, initialised, heartbeat, stale, transport), `test_strict_start_permitted_only_when_every_interlock_passes_and_then_ramps`; FITL `test_strict_firmware_*` | Verified (software). Mutation-checked | Flags are declarations by the build; they do not prove wiring or limits. Host tests use the real logic with a simulated plant |
| Invalid sensor values cannot authorise start | `start_blocked_reason` (valid flag AND `finite_f`, current/voltage/housing/rpm); `SafetyMonitor::update` (`finite_f`) | Native `test_strict_start_refused_for_invalid_nan_or_infinite_required_sensors`, `test_non_finite_*` | Verified (software) | Validity flags come from `main.cpp` plausibility ranges; sensor behaviour on the real bus is unverified |
| Stale measurements refused (wrap-safe) | `start_blocked_reason` (250 ms, `uint32_t` subtraction); `main.cpp` per-sensor 3 s freshness and INA219 probe | Native `test_strict_start_refused_on_stale_telemetry_and_wrap_safe` | Verified for the interlock. `main.cpp` freshness/probe: **compiled only** | The 250 ms / 3 s values are assumptions; INA219 probe never ran on hardware |
| Faults latch safely; no auto-restart | `SafetyMonitor::trip/update/reset_trip`, `fault_mask()`; `Device::step` (reset needs authorised RESET_ESTOP + local button; drive returns to IDLE) | Native `test_trip_latches_and_keeps_first_cause`, `test_fault_mask_keeps_every_simultaneous_cause...`, `test_latched_trip_blocks_start_and_does_not_restart_after_reset`, `test_power_up_state_is_off_and_never_starts_by_itself`; FITL `test_strict_firmware_never_blocks_stop_and_never_restarts_after_a_fault` | Verified (software) | Causes arising while already latched are not added to the mask (only same-cycle causes are); no non-volatile fault memory across a reset |
| STOP bypasses normal command delays | `CommandValidator::validate` (STOP: no auth/ttl/seq checks) + `Device::execute` (not interlocked); control path independent of the output queue; `main.cpp` USB TX timeout 0 so a stalled host cannot block command parsing | Native `test_stop_is_never_blocked_by_the_interlocks`, `test_stop_takes_effect_even_when_the_telemetry_queue_is_full_and_never_drained`, `test_duplicate_stop_and_rejected_start_are_harmless` | Verified in the device logic. TX-timeout change: **compiled only** | Serial STOP still needs the comms task to run; the local safety monitor and the heartbeat timeout do not depend on it |
| Watchdog failure is handled safely | `main.cpp` `control_task` (registers itself; feeds `esp_task_wdt_reset()` only after read -> `Device::step` -> `apply`; 5 ms lock bound, outputs off and no feed on contention); interlock `WATCHDOG_NOT_ACTIVE` | Native `test_strict_start_refused_while_the_watchdog_is_not_active`; Static `test_watchdog_is_fed_only_after_a_complete_control_iteration_and_not_on_lock_contention` (source-order check) | **Unverified on target.** Logic and source ordering only | See "Watchdog and startup" below |
| E-stop state inhibits operation | `start_blocked_reason` (`ESTOP_INPUT_NOT_VERIFIED`, `ESTOP_ACTIVE`), `SafetyMonitor` `EXTERNAL_ESTOP` trip | Native `test_asserted_estop_input_inhibits_start`, `test_external_estop`, `test_strict_start_refused_until_an_estop_input_is_declared_wired` | Verified for the software logic; **no physical E-stop input exists** (`main.cpp` reads no pin) | Independent hardware E-stop still required |
| Commands reject missing/invalid auth, malformed, oversized, stale, duplicate, replayed | `parse_command`; `Device::on_line` (key compare); `CommandValidator::validate` (UNAUTHORIZED, BAD_TTL, EXPIRED, OUT_OF_SEQUENCE, duplicate-id cache of 16) | Native `test_unauthenticated_malformed_oversized_and_stale_commands_are_rejected`, `test_replayed_commands_are_not_executed_twice_and_old_sequence_numbers_are_refused`, `test_duplicate_command_id_is_idempotent`, parse tests; FITL conformance 4/4 | Verified within a boot | **A captured valid command can be replayed after a reboot** (sequence memory is volatile, `age` is sender-supplied, no nonce/MAC): `test_known_limitation_a_replay_after_a_reboot...` documents it. Mitigation: motor commands stay refused (`TRANSPORT_NOT_SECURED`) until a secured transport is declared |
| Fail-closed configuration | `main.cpp` flags default 0; `relaxed_interlocks = false`; `#error` for control without a key; `outputs_off()` first in `setup()` | Static `test_default_target_builds_with_no_control_commissioning_or_secret_flags`, `test_every_commissioning_flag_defaults_to_zero...`, `test_a_control_enabled_build_cannot_carry_the_placeholder_key`, `test_motor_outputs_are_forced_off_before_anything_else_in_setup` | Verified (static inspection of the source) | Static checks, not behaviour on a target |
| Legacy actuation path quarantined | `#error` guard before the includes of `smart_motor_monitor.ino`; no PlatformIO env builds it | Static `test_legacy_sketch_refuses_to_compile_...`, `test_preprocessor_stops_on_the_guard_...` (runs `g++ -E`), `test_no_platformio_environment_builds_the_legacy_sketch`, `test_user_facing_docs_...` | Verified: a plain compile fails | Speed bump only: anyone can define the macro, and the sketch was not otherwise changed. Not a physical safeguard |

### Legacy sketch (checked in the source, not assumed)
* References: `docs/software.md` and `README.md` instructed users to open and upload it in the Arduino IDE, so accidental use was a real path; `docs/hardware.md`, `docs/HARDWARE_WIRING.md` and report files cite its pin map. No PlatformIO environment, script or CI step builds it.
* A bare TCP `MOTOR_ON` reaches `setMotorState(true)`: R_EN/L_EN high, `analogWrite(RPWM, 200)`, no authentication, no ramp, no interlock, no watchdog, no finite check, no e-stop input.
* Done: `#error` guard (override macro for bench use with motor power disconnected), `esp32/firmware/README_LEGACY_UNSAFE.md`, warnings in `README.md` and `docs/software.md`, and the static tests above. The sketch's behaviour was **not** otherwise changed or deleted (a design decision for the owner). It stays excluded from any physical deployment.

### Command transport
Trace: backend `CommandDispatcher` -> approved `ProposedAction` only -> JSON line with `id, type, p..., ttl, age, seq, k` -> `parse_command` -> key compare -> `CommandValidator` -> interlocks -> `Device::execute` -> ack `{t:ack,id,status,reason}` -> `CommandDispatcher.on_ack` (id lookup; Phase 13 hardening against malformed/regressing acks). The Python Safety Supervisor/dispatcher remain the only path that mints an executable action; the firmware independently re-validates.
* Findings: the key `k` is a reusable shared secret sent in cleartext; there is no device identity in commands or acks (a single device is assumed); `age` is stamped by the sender; no boot nonce or MAC. Replay within a boot is rejected by `seq`/duplicate-id; replay across a reboot is not. No authenticated encryption exists and none was invented.
* Decision: **physical actuation stays disabled** until a secured transport is provided and declared (`TORQVA_TRANSPORT_SECURED`, default 0; the interlock refuses with `TRANSPORT_NOT_SECURED`). Required design (needs a responsible-engineer decision): a secured channel (for example TLS or an authenticated session over a point-to-point link), a per-boot challenge/nonce, per-device identity and per-device provisioned keys, and a firmware-to-backend frame adapter. Simulation (`SimDevice`, fitl relaxed mode) is unaffected.

### Watchdog and startup
* Monitored: only the control task (registered in `control_task`); the Arduino communications task is not watched, so its stall is covered only by the heartbeat timeout. Feeding reflects a completed read -> decide -> apply iteration; lock contention turns outputs off and stops feeding.
* Stalls: a stalled acquisition or serial/logging path cannot block the control task except through the shared lock (5 ms bound). A hung `Wire1` call inside the control task would stall it and end in a watchdog reset.
* Timeout: `TORQVA_WDT_TIMEOUT_S = 2` is an unreviewed engineering assumption; the responsible hardware engineer must approve it against the driver's behaviour and the mechanical stopping time. It is not a validated safety figure.
* Reset behaviour: after a watchdog, brown-out or power-on reset the ESP32 GPIOs are high-impedance until firmware runs; `setup()` calls `outputs_off()` first, but any window before that (ROM and bootloader) is uncontrolled in software. The BTS7960 R_EN/L_EN and the motor relay therefore need hardware pull-downs (or an equivalent default-off arrangement); this cannot be verified here. No code path restarts the motor after a reset: the device boots IDLE and every start needs a fresh, interlock-checked command (`test_power_up_state_is_off_and_never_starts_by_itself`).
* Not verified: whether `esp_task_wdt_init()` succeeds with this timeout on the installed Arduino-ESP32 core (the core may already own the task watchdog). If it fails the device reports it and the interlock keeps refusing motor commands. Nothing was flashed to check.

### Emergency stop and limits (information needed from the responsible hardware engineer)
No E-stop GPIO, polarity or wiring exists in `config_pins.h`, so none was invented and `external_estop` stays false. A software state or web button is not an independent E-stop. Needed: a power-path E-stop or driver-inhibit that works without the ESP32, its active level, pull resistors, open-circuit (cable-fault) behaviour, debounce and latching; then firmware input code and `TORQVA_ESTOP_INPUT_WIRED=1`. Approved limits (current trip, supply window, temperature, overspeed) must come from verified component ratings and an approved operating envelope; `default_limits()` values and the 5 A supply assumption (H-10) are unapproved.

### Commands run (this follow-up)
| Command | Result |
|---|---|
| `python -m platformio test -e native` (esp32/torqva_fw) | 88 / 88 pass |
| `python -m platformio run -e esp32s3` | SUCCESS (RAM 6.2 %, flash 9.6 %); compile only |
| control-enabled, placeholder key | fails by design (`#error`); with an explicit key it compiles (compile only) |
| `python -m platformio run -e fitl`, `pytest tests/test_torqva_p14_contract.py tests/test_torqva_conformance.py` | 16 / 16 pass |
| `python -m pytest -q` (backend, includes the 9 quarantine/config static tests) | 467 passed |
| `npx vitest run`, `npm run build` (frontend) | 67 passed; build succeeds |

Physical behaviour - wiring, driver, sensors, watchdog on target, reset-state of the outputs, E-stop - is **unverified**.

## Phase 15A - hardware-readiness closure (software only; nothing flashed, no hardware operated)

**Classification.** `SOFTWARE IMPLEMENTED` and `SOFTWARE TESTED` for the items marked so below; `TARGET COMPILE VERIFIED`; `ON-TARGET BEHAVIOR UNVERIFIED`; `HARDWARE NOT VALIDATED`; `PHYSICAL OPERATION PROHIBITED WHILE BLOCKERS REMAIN`. No certification is claimed.

### A. Command transport - actual lifecycle and attack surface (verified in the source)
1. Operator request -> `/api/torqva/*` (bearer token, roles) -> pipeline proposes -> **deterministic Safety Supervisor** mints the only executable `ApprovedAction` -> `CommandDispatcher.dispatch` -> one JSON line `{id,type,p,p2,p3,ttl,age,seq,k}` -> device transport -> firmware `parse_command` -> key compare -> `CommandValidator` -> start interlocks -> `Device::execute` -> ack `{t:"ack",id,status,reason[,dev]}` -> `CommandDispatcher.on_ack`.
2. **No physical transport exists in the backend.** Simulation uses an in-process `SimDevice`; the firmware speaks JSON lines over USB-CDC serial; no code connects the two; the legacy `main.py` TCP server speaks the old sketch's format. Connection direction, device identity and credentials for a real link are therefore undefined, and no TLS/DTLS library is wired into either side.
3. Confirmed weaknesses of the current application protocol: reusable shared key `k` in cleartext; no confidentiality; `age` is sender-supplied; duplicate tracking and `seq` memory are volatile (a captured command replays after a reboot); acknowledgements were unauthenticated and carried no device identity; one device is assumed.

**Design decision (no home-made cryptography).** The correct fix is an established authenticated, encrypted transport with mutual authentication, not changes to the JSON framing: **TLS 1.3 (mbedTLS, bundled with ESP-IDF/Arduino-ESP32 via `esp-tls`/`WiFiClientSecure`) with mutual authentication** - device client certificate and key per device (provisioned per unit, ideally in flash-encrypted storage with secure boot), the backend pinned by CA, the device identity taken from the certificate subject, revocation by short-lived certificates or a backend allow-list. Freshness without a trustworthy clock comes from the **session**: TLS session keys are fresh per connection, so a capture from an earlier session cannot be replayed into a new one, and no persistent counter (flash wear, interrupted writes, rollback) is needed. Within a session `id`/`seq` and the duplicate cache give idempotency. For a point-to-point USB link the equivalent requirement is a physically controlled link plus the same session gate. **This was not implemented here:** there is no transport to attach it to, a TLS integration cannot be verified without the target and a backend peer, and a partial one would be worse than none.

**What was implemented (software), so that physical control stays fail-closed until that transport exists:**
* **Session gate.** `Device::set_secure_session(bool)`; interlock reason `NO_SECURE_SESSION`. A fresh `Device` (every reboot) has no session; only the transport layer may set it, after a successful authenticated handshake. `main.cpp` never calls it (no transport exists), so motor commands are refused. `TRANSPORT_NOT_SECURED` (build declaration, default 0) and `NO_SECURE_SESSION` are independent requirements. Losing the session while the motor runs stops it (like STOP), and a new session does not resume the old motion. Result: a captured command replayed after a reboot cannot start the motor (the old "known limitation" test is replaced by one that asserts this). The protocol-level weakness (the replayed heartbeat is still accepted) remains and is documented, not hidden.
* **STOP policy preserved.** STOP is accepted with no key, no sequence and no session (`test_stop_works_without_a_session_and_without_authentication`); the local safety monitor (over-current, over-temperature, heartbeat loss, sensor invalid, E-stop input) does not depend on any network.
* **Acknowledgement binding.** Firmware echoes `"dev":"<device_id>"` in every ack (`DeviceConfig.device_id`, omitted when empty); `CommandDispatcher(device_id=...)` ignores any ack with a missing or different identity (counted in `rejected_acks`), unknown ids, unknown statuses and acks that try to re-open a command. The identity is an anti-confusion label, **not** authentication: authenticity must come from the secured channel.
* **Tests:** native (device/core), FITL (real C++ core), `backend/tests/test_torqva_p15a.py`. Covered: missing/invalid/another-device identity, tampered status, unknown id, duplicate/replayed acks, communication loss -> timeout (never "executed"), replay in-session (duplicate cache then `seq`), replay after reboot, stale/expired/oversized/malformed, STOP with and without auth, session loss, simulation without identity.
* **Not covered (needs the real transport):** invalid endpoint/certificate, certificate revocation, handshake timeout, tampered ciphertext. Their acceptance tests are listed under "Transport acceptance tests required".

**Credential provisioning requirements (open):** per-device key pair generated on or injected into the device without passing through source control; flash encryption and secure boot enabled for production; certificate lifetime/rotation policy; revocation procedure; backend device registry binding certificate subject -> device id -> allowed roles. No secret exists in the repository (the placeholder key is refused by a compile-time guard in control builds).

**Transport acceptance tests required before enabling physical control:** reject missing/invalid/expired/revoked client certificate; reject wrong server certificate; reject tampered records; reject replay of a captured session; session ends on link loss (motor stops); STOP works with the session down; authentication timeout leaves the motor off.

### B. Independent emergency stop (contract; no pin, polarity or circuit invented)
* **Status: NOT IMPLEMENTED in hardware or firmware I/O.** `main.cpp` reads no E-stop pin (`in.external_estop` is always false). A web button, serial command, backend endpoint or firmware flag is not an emergency stop.
* **Required independent mechanism** (hardware engineer to design and verify against the real driver, supply and motor): a device in the motor power path (for example a contactor/relay or driver-inhibit) that removes or inhibits drive without the ESP32, the network, AI models or the frontend, latching, with a manual intentional reset.
* **Firmware interface contract** (implemented as pure logic, `estop.{h,cpp}`, **not wired to a pin**): the approved design must supply `configured`, `active_low` and `release_debounce_ms` (> 0). Rules: unconfigured/invalid -> `UNKNOWN`; initial state `UNKNOWN`; asserted level or unreadable sample -> `ASSERTED` immediately; `RELEASED` only after the input has read released continuously for the debounce (wrap-safe, a glitch restarts it); `UNKNOWN` and `ASSERTED` both block operation. Floating-input and cable-fault detection depend on the circuit (for example a supervised/dual-channel loop) and must be specified by the design. Tests: `test_estop_input_*` (native). They prove the abstract state logic only, **not the electrical circuit**.
* Downstream: `external_estop` trips the existing latched `SafetyMonitor`; reset needs an authorised RESET_ESTOP **and** the local button; reset never restarts the motor; start is refused while `estop_input_wired` is false (`ESTOP_INPUT_NOT_VERIFIED`), asserted, or unknown.
* **Information needed from the hardware engineer:** pin, polarity, pull resistors, circuit topology (single/dual channel), cable-fault behaviour, debounce, reset arrangement, the relation to the BTS7960 inhibit and motor relay.

### C. Reset, brown-out and output safety
* Software done: `outputs_off()` is the first statement of `setup()` (static test); **any reset caused by a watchdog (task/interrupt/other), brown-out or panic now latches `TripReason::RESET_FAULT`** (`esp_reset_reason()` in `main.cpp`), so the motor cannot be started until a person performs the intentional reset; ordinary power-on/software/USB/external resets do not latch. After any reset the device boots IDLE with no session and every start re-checks all interlocks. Native test: `test_a_boot_fault_latches_until_an_intentional_reset_and_never_restarts_the_motor`; static test: `test_reset_reason_latches_a_fault_for_watchdog_brownout_and_panic_only`.
* Unverifiable here: GPIO state from reset until `setup()` runs (ROM/bootloader/early init) is high-impedance or pulled by the chip, depending on the pin and strapping; whether BTS7960 R_EN/L_EN and the relay stay off in that window depends on **external pull-down (or equivalent default-off) circuitry that must exist in hardware**; brown-out thresholds and driver behaviour during supply sag; behaviour on peripheral-init failure (the INA219 failing to start leaves current invalid -> start refused / `SENSOR_INVALID` trip, tested in logic only). Physical verification required: scope the enable and relay nets across power-up, brown-out and watchdog reset.

### D. Watchdog - what is and is not verified
* Monitored: the control task only; registered after `esp_task_wdt_init(TORQVA_WDT_TIMEOUT_S, true)` succeeded (otherwise the device is told "not active" and motor commands are refused). Fed only after a complete read -> `Device::step` -> `apply` iteration; a lock wait over 5 ms turns outputs off and does not feed. The Arduino communications task is not monitored; its stall is covered by the heartbeat timeout and by the fact that the control task never depends on the output queue.
* A stalled sensor (a hung `Wire1`/OneWire call) inside the control task stops the feed -> reset -> `RESET_FAULT` latch. Serial/logging cannot block the control task except through the lock; the USB TX timeout is set to 0 so a stalled host cannot block command parsing.
* **Timeout decision: `2 s` is an unreviewed assumption.** It must be chosen against the mechanical stopping time, the driver's behaviour and the heartbeat timeout (2 s) by the responsible engineer; do not treat it as a validated limit.
* **Unverified on target:** whether `esp_task_wdt_init()` succeeds with this timeout on Arduino-ESP32 2.x (the core may already own the watchdog); that a reset really occurs; output state during that reset.

**Supervised on-target test plan (not executed; needs written approval from the responsible hardware engineer, motor and driver power disconnected for steps 1-3):**
| # | Scenario | Instrumentation | Expected | Acceptance |
|---|---|---|---|---|
| 1 | Boot with a debug build that prints `esp_task_wdt_init` result | serial log | init returns OK with the configured timeout, `watchdog_active` true | else the interlock stays closed; record the result |
| 2 | Block the control task (debug-only infinite loop after N s) | scope on R_EN/L_EN, relay net, PWM; serial | reset within timeout + margin; enable/relay nets stay inactive throughout, including the reset window | outputs never active; status shows `RESET_FAULT` after boot |
| 3 | Hold the shared lock from the comms task (debug-only) | same | outputs off within 10 ms, then reset | same |
| 4 | Brown-out (bench supply sag) | same + supply trace | reset, outputs inactive, `RESET_FAULT` latched | no motion on recovery; reset needs command + button |
| 5 | Repeat 3 and 4 with the driver powered, motor **unloaded and mechanically restrained**, only after approval | same + current probe | as above | no unintended drive |
Each step needs an approved procedure, a named observer and an independent hardware E-stop in the power path before power is applied.

### E. Legacy firmware disposition
Verified: not part of any PlatformIO environment or script; `docs/software.md` and `README.md` previously instructed uploading it (now warned); hardware pages reuse its pin map (now marked "not a verified contract"). The `#error` guard can be overridden with one macro, so a **second layer** was added: with only the compile override, `setMotorState(true)` refuses to energise the driver unless `TORQVA_LEGACY_ENABLE_MOTOR` is also defined (preprocessor-verified by `test_with_only_the_compile_override_the_actuation_branch_is_preprocessed_out`). The sketch's remaining behaviour (unauthenticated TCP, no interlocks) is unchanged; it was not deleted. Deleting or porting it is a product decision; until then it is excluded from any physical deployment. These guards are build-time speed bumps, not hardware interlocks.

### F. Configuration and commissioning gates (all default closed)
`TORQVA_CONTROL_ENABLED` (+ explicit `TORQVA_KEY`), `TORQVA_LIMITS_APPROVED`, `TORQVA_ESTOP_INPUT_WIRED`, `TORQVA_TRANSPORT_SECURED` default 0/undefined; `relaxed_interlocks=false` on hardware; the session is never set by `main.cpp`; backend code never constructs hardware mode (`test_no_backend_code_path_constructs_the_hardware_mode`), so simulation cannot become physical control. Native/FITL use `relaxed_interlocks` only on the host.

### Traceability additions (owner / approval column)
| Safety property | Production implementation | Test | Result | Unverified hardware assumption | Owner / approval |
|---|---|---|---|---|---|
| Motion needs a live authenticated session; none after reboot | `Device::set_secure_session`, interlock `NO_SECURE_SESSION` | native `test_a_captured_command_replayed_after_a_reboot...`, `test_losing_the_secure_session...`, `test_a_session_cannot_be_inherited...`; FITL `..._without_a_live_authenticated_session...` | SOFTWARE TESTED (mutation-checked) | The session itself needs a real TLS (or equivalent) transport that does not exist | Firmware/security lead; transport design review |
| Acks bound to a device | `encode_ack(dev)`, `CommandDispatcher(device_id)` | native `test_acknowledgements_carry_the_device_id...`; `test_torqva_p15a.py`; FITL | SOFTWARE TESTED | Identity is a label, not authentication | Backend lead |
| Reset/brown-out/watchdog reset latches a fault | `main.cpp` `esp_reset_reason()` -> `latch_boot_fault` -> `SafetyMonitor::latch_external` | native `test_a_boot_fault_latches...`; static reset-reason test | SOFTWARE TESTED; reason mapping TARGET COMPILE VERIFIED; ON-TARGET BEHAVIOR UNVERIFIED | Real reset reasons and output state during reset | Hardware engineer (plan D) |
| E-stop input interpretation | `estop.{h,cpp}` (not wired) | native `test_estop_input_*` | SOFTWARE TESTED (abstract logic only) | Entire circuit, pin, polarity, wiring | Hardware engineer (section B) |
| Session loss stops motion; STOP independent of auth | `Device::set_secure_session`, `CommandValidator`/`Device::execute` | native tests above | SOFTWARE TESTED | Link behaviour on a real transport | Firmware lead |
| Legacy actuation disabled by default | `.ino` `setMotorState` gate + `#error` | `test_torqva_p15a.py`, `test_torqva_p15_quarantine.py` | SOFTWARE TESTED (preprocessor) | Not a hardware interlock; owner decision to retire | Product owner |

### Commands run (Phase 15A)
`python -m platformio test -e native` -> 97/97; `python -m platformio run -e esp32s3` -> SUCCESS (compile only); `pytest backend/tests/test_torqva_p14_contract.py test_torqva_conformance.py` -> 18/18 (real C++ core); backend `python -m pytest -q`, frontend `npx vitest run` and `npm run build`: backend 480 passed (includes `test_torqva_p15a.py`, 14 tests; `test_torqva_p15_quarantine.py`, 9), frontend 67 passed and `npm run build` succeeds. Mutation checks: removing `NO_SECURE_SESSION` fails 3 native tests; removing the stop-on-session-loss fails 1.

### Blockers that remain (all outside software)
1. A secured transport (TLS 1.3 mutual auth or equivalent) with per-device provisioning, rotation and revocation, plus a firmware-to-backend frame adapter. 2. An independent hardware E-stop and its wiring contract. 3. Default-off hardware on the driver-enable and relay nets across reset/brown-out. 4. Approved current/voltage/temperature/overspeed limits from verified ratings (the 5 A supply value is an assumption). 5. Approval of the watchdog timeout and an executed on-target test (plan D). 6. A decision to retire or port the legacy sketch. **Physical operation remains prohibited.**

## Phase 15B - secure device transport foundation (software only; nothing flashed, no hardware operated)

**Status: `SOFTWARE IMPLEMENTED` (backend transport, protocol, gateway, device-side session binding) and `SOFTWARE TESTED`. The firmware has NO network/TLS client: `ON-TARGET BEHAVIOR UNVERIFIED`, `HARDWARE NOT VALIDATED`, `PHYSICAL OPERATION PROHIBITED WHILE BLOCKERS REMAIN`.**

### Audit result (what exists)
* Backend: no device transport existed (simulation uses the in-process `SimDevice`). Firmware: JSON lines over USB-CDC serial only; no WiFi/TLS client code, no TLS library in `lib_deps`. The physical medium and topology (serial bridge vs WiFi/TCP) are **not selected by the responsible engineer**, so none is hard-wired: the implementation is a transport-independent protocol, a gateway, a real TLS server and a mock link.
* **TLS version check (verified in the installed framework):** `framework-arduinoespressif32 4.20017` (Arduino-ESP32 2.0.17) bundles **mbedTLS 2.28.7, which supports TLS 1.2 at most**. TLS 1.3 is therefore *not* available on the current device framework. Decision for review: the policy default is **TLS 1.2 with ECDHE + AEAD suites only** (forward secrecy, no CBC, no static RSA/DH key exchange), mutual authentication, CRL checking and a restricted cipher list; `TlsPolicy(require_tls13=True)` is the target once the device framework supports it (for example an ESP-IDF 5.x based core with mbedTLS 3.x). There is no silent downgrade: the minimum version is explicit configuration and a TLS 1.2-only client is refused when TLS 1.3 is required (tested).

### Protocol `tqv1` (`backend/torqva/device_protocol.py`, one JSON object per message, UTF-8, <= 2048 bytes)
| Type | Direction | Fields (all validated) |
|---|---|---|
| `hello` | device -> server | `v, t, dev, fw` (first message after the TLS handshake) |
| `session` | server -> device | `v, t, dev, sid` (`sid` = 128-bit random hex, issued only after identity checks pass) |
| `tel` | device -> server | `v, t, dev, sid, n, ts, rpm, duty, v_bus, i_a, housing_c, q` (finite, range-checked) |
| `fault` | device -> server | `v, t, dev, sid, n, code` |
| `cmd` | server -> device | `v, t, dev, sid, cid, n, ty, p, p2, p3, ttl_ms` (`ty` in HEARTBEAT, SET_SPEED, STOP, START, RUN_TEST, ABORT_TEST, RESET_ESTOP) |
| `ack` | device -> server | `v, t, dev, sid, cid, st, reason` (`st`: `received`, `executed`, `rejected`, `aborted`) |
| `bye` | either | `v, t, dev, sid` |
Rules: unknown/missing version, unknown type or command, malformed JSON, oversize, NaN/Infinity, out-of-range numbers and invalid identifiers all raise `ProtocolError` and the connection is closed (fail closed). `n` is strictly increasing per direction within a session (replay/out-of-order -> violation); `cid` is unique per session; `sid` changes every session.

### Authentication (real, tested with real handshakes)
`device_transport.build_server_context` + `TlsDeviceServer` (stdlib `ssl`/OpenSSL 3.0.18): `CERT_REQUIRED` (a client without a valid certificate cannot complete the handshake), CA-validated client certificates, CRL check (`VERIFY_CRL_CHECK_LEAF`), no compression/renegotiation. **Fail closed configuration:** missing certificate/key/CA, no CRL (`require_crl`), or a development CA presented to a production policy -> `SecurityConfigError`, the server does not start. **Identity binding:** after the handshake the device sends `hello`; the registry authorises only if the device is registered, not revoked, the certificate **CN equals the device id**, and the certificate's SHA-256 is **pinned** for that device. A handshake or `hello` that fails any check yields no session. Authentication timeout: a connection that does not introduce itself within `handshake_timeout_s` is dropped.

### Session freshness, replay and command semantics
* A fresh random `sid` per connection; a new connection **supersedes** the old session (its pending commands become `LINK_LOST`). Nothing from an earlier session or from before a reboot is valid later (a reboot is a new session; counters may restart at 1 because the `sid` differs). No persistent counters are used, so there is no flash-wear/interrupted-write/rollback exposure.
* Every actionable command is bound to one device and one session. The gateway never retries or re-sends: one write per dispatch, no automatic replay after reconnect (tested: after reconnect only the new command arrives).
* States: `SENT` (written, not known received) -> `RECEIVED` (device acknowledged receipt, **not** execution) -> `EXECUTED` / `REJECTED` / `ABORTED`; `LINK_LOST` (session ended, outcome unknown) and `EXPIRED` (ttl without ack) are final and never re-sent. Final states never change: duplicate or late acks are counted and ignored; an ack with the wrong device or session, or for a command the session never sent, is a protocol violation that closes the connection and cannot alter any record. `EXECUTED` is a device report, **not verified recovery** (C5 verifies from observed data).
* A disconnected or idle device (`idle_timeout_s`) has no fresh session; `device_state()` then reports `healthy: None`, never healthy. Telemetry carries provenance `DEVICE_TELEMETRY_TLS` or `DEVICE_TELEMETRY_MOCK`.
* **Device side (C++, native-tested):** `Device::begin_session(sid)`; in strict mode every non-STOP command must carry the live `sid` (`WRONG_SESSION`), and before any session every non-STOP command is refused (`NO_SECURE_SESSION`), so a captured heartbeat or start replayed after a reboot or into a new session is rejected. Beginning a new session stops any running motion. Acks echo `dev` and `sid`. STOP needs no session.

### Backend integration and authority chain
`DeviceGateway.dispatch()` accepts only supervisor-minted `ApprovedAction` objects (`PermissionError` otherwise); the AI, LLM, prediction code and frontend cannot reach it. It refuses unknown/revoked devices and devices without a fresh authenticated session. **Real TLS link + physical device additionally requires `PhysicalControlPolicy.commissioning_approved`** (default False; nothing in the repository sets it; STOP is exempt because it can only make things safer). A `MockLink` is never physical, even when it claims a physical device id, and simulated devices work without credentials. The supervisor's `hardware_control_enabled` stays untouched. `GET /api/torqva/devices` returns `physical_transport: "UNAVAILABLE"` today (no transport is configured) and, if a gateway is attached, per-device state with `link_kind`, `physical`, and `healthy: null` unless fresh telemetry exists.

### Credential lifecycle (design + what is tested)
Per-device client certificate (CN = device id) issued by an offline CA; pinned in the registry; rotation = pin the new certificate, connect with it, then retire the old pin (`rotate`, `retire_all_but`; tested); revocation = CRL entry plus `DeviceGateway.revoke()` which closes the live session immediately (tested); expired certificates fail the handshake (tested); revocation information unavailable -> server refuses to start. Test credentials are generated in memory per test run by `backend/tests/pki_helper.py`, carry the marker `TORQVA-TEST`, and a production policy refuses a CA with that marker; no key or certificate is stored in Git. **Open:** on-device key storage (flash encryption, secure boot), key injection/provisioning procedure, certificate lifetime and CRL distribution, and the device-side TLS client (see below).

### Implemented vs mock vs not implemented
| Component | Status |
|---|---|
| Protocol, validation, gateway, registry, mTLS server, CRL/pinning/identity binding | **Implemented, tested with real TLS handshakes** |
| Python device stand-in used by the tests (`PythonMockDevice`), `MockLink` | **Mock** (not firmware, not a physical transport) |
| Firmware session binding (`begin_session`, `sid` checks, ack binding) | Implemented and native-tested; **never called by `main.cpp`** (no transport) |
| Firmware TLS client / WiFi or serial bridge, device key storage, firmware-side frame decoder for `tqv1` | **Not implemented** (needs the transport/topology decision, a target and a peer) |
| Backend wiring of the gateway into the pipeline/dispatcher for live use | **Not implemented** (only the read-only `/devices` status and the gateway API); simulation still uses `SimDevice` |

### Tests and results (this phase)
`backend/tests/test_torqva_p15b_transport.py`: 41 tests (protocol validation 25; TLS: valid mutual handshake, no client certificate, certificate from another CA, expired certificate, CRL-revoked certificate, server certificate not trusted by the client, unknown/mismatched/unpinned identity, rotation, runtime revocation, TLS version and cipher policy, authentication timeout, command lifecycle, protocol violations (replayed counter, wrong session, wrong device, unknown command id, malformed, oversize, bad version), old-session traffic and no replay after reconnect, device reboot and server restart, idle expiry, STOP vs commissioning, mock-link rules, supervisor-only dispatch, expiry without resend, fail-closed security configuration, `/devices` honesty). Mutation checks: removing the CRL flag, the session check, the certificate pinning or `CERT_REQUIRED` each fails a test. Native firmware: 100/100 (3 new session-binding tests); real-core contract tests 19/19. Full regression: backend 522 passed, frontend 67 passed + build OK, firmware native 100/100, ESP32-S3 default build compiles (compile only), control-enabled build with the placeholder key still fails by design.

### Not covered by any test here (need the real device transport)
Tampered TLS records (handled by the TLS stack, not our code), device-side TLS client behaviour, on-device certificate storage, WiFi/serial link loss, real latency/timeouts.

### Commands run (Phase 15B)
`python -m pytest -q` (backend), `npx vitest run` and `npm run build` (frontend), `python -m platformio test -e native` (esp32/torqva_fw), `python -m platformio run -e esp32s3` (compile only), `pytest backend/tests/test_torqva_p14_contract.py test_torqva_conformance.py` - results in `docs/TORQVA_PROGRESS.md` Session 15.

### Blockers that remain (independent of this phase)
Independent hardware E-stop and wiring contract; default-off hardware on driver-enable/relay nets across reset; approved current/voltage/temperature/overspeed limits; approved watchdog timeout and an executed on-target test; the device TLS client, key provisioning and storage, and a decision on the transport medium; retiring or porting the legacy sketch. **Physical operation remains prohibited.**

## Phase 16 - USB serial bridge, WebSocket and live dashboard (software only; nothing flashed, no hardware operated)

**Status: `SOFTWARE IMPLEMENTED`, `SOFTWARE TESTED` against in-memory transports and the real C++ firmware core (host build); `TARGET COMPILE VERIFIED`; `ON-TARGET BEHAVIOR UNVERIFIED` - no real ESP32 was connected or opened; `PHYSICAL OPERATION PROHIBITED WHILE BLOCKERS REMAIN`.**

### Architecture (as built)
`ESP32-S3 firmware <-USB-CDC serial-> DeviceBridge (backend/torqva/serial_bridge.py) -> Safety Supervisor + dispatcher -> /api/torqva/device/* and read-only WebSocket /api/torqva/ws -> React (Device, Live Monitor, Motor Control, Overview)`. The backend owns the port: one reader thread (blocking read with a 0.2 s timeout, no busy loop), one lock-guarded writer, one owner at a time (`connect()` refuses a second owner; `disconnect()` joins the thread and closes/releases the port). The bridge never connects by itself: only an admin request (`POST /device/connect`) opens a port, and tests never open a real port.

### Wire protocol (existing firmware protocol, now "wire protocol 1")
115200 8N1 JSON lines, <= 512 bytes (`SerialTransport` assembles lines with a hard bound and discards oversized ones). Frames: `fast` (10 Hz: rpm, setpoint, duty, bus voltage, current, power, validity mask `q`), `slow` (1 Hz: housing and ambient temperature), `status` (1 Hz and on change), `ack`. `q` bits: current 1, voltage 2, housing 4, ambient 8, rpm 16, vibration 32; a clear bit means invalid and the backend stores `None` (never zero). **Firmware change (tested on both sides):** the status frame now also carries `proto` (1), `dev` (configured device id, default `UNPROVISIONED`), `blk` (the device's first failed start interlock, or empty) and `fm` (latched fault mask); `kLine` grew from 200 to 288 bytes. Acks echo `dev` and `sid` when known. Vibration/acceleration are **not measured** by the firmware: the API reports them as `unavailable` and the UI says so.
Validation (`parse_frame`): size, JSON object, known type, required fields, types, finite numbers (NaN/Infinity rejected), ranges, `proto == 1` for status (older/other firmware never completes the handshake), ack status set. Malformed frames are counted and never change state.
Model rules: `seq` is one shared counter: duplicates are dropped, gaps counted, a backwards jump means the device restarted (uint32 wrap handled); history is a bounded ring (3600 fast samples); telemetry older than 2 s is stale (never shown as live); an invalid value is a gap in charts. The device is `CONNECTED` only after a valid status frame (handshake); the label is `PHYSICAL DEVICE` only if that status reports `mode == "HW"`; a firmware in `SIM` mode is labelled "DEVICE (FIRMWARE SIMULATION MODE)", a mismatch with the configured expected device id closes the connection, and no device means `SIMULATION`.

### Trust boundary and security assumptions
USB serial provides **no authentication, encryption or session**. It is treated as inside the host computer's physical trust boundary (anyone with access to the host or the port can talk to the device). The Phase 15B TLS transport is not used here. Consequences: the firmware's own `NO_SECURE_SESSION` / `TRANSPORT_NOT_SECURED` / limits / E-stop interlocks remain and refuse START and speed commands; the bridge additionally refuses to send them. The device identity is a label (not authentication); acks with a wrong identity or an unknown command id are ignored and counted. `TORQVA_FW_COMMAND_KEY` (environment, never in the repository) would be the firmware key for non-STOP commands; it is not used because those commands are blocked.

### Commands
Flow: website -> bearer-authenticated API -> role check (STOP: any role; START/SET_SPEED: operator) -> **Safety Supervisor** (a hardware-mode context with `hardware_control_enabled=False` hard-wired, so non-STOP actions are always refused with `hardware_control_not_enabled`) -> commissioning/interlock blockers (`PHYSICAL CONTROL DISABLED`, `DEVICE NOT CONNECTED`, `SECURE DEVICE TRANSPORT NOT CONFIGURED`, `SAFETY LIMITS NOT APPROVED`, `EMERGENCY STOP NOT VERIFIED`, `INTERLOCK NOT SATISFIED: <device reason>`, `SAFETY FAULT LATCHED: <reason>`; only the applicable ones are listed) -> dispatcher (`ApprovedAction` only) -> device validation -> ack.
Lifecycle: REQUESTED -> REJECTED | AUTHORIZED -> SENT -> ACKNOWLEDGED (device accepted) -> EXECUTED (device reports completion; for STOP) | FAILED | TIMED_OUT (no ack in 2 s, never retried) | UNKNOWN_OUTCOME (link lost or device restarted first, never replayed; the operator must act again). SENT/ACKNOWLEDGED are not EXECUTED. **Implemented and sendable: STOP only** (needs no key or session; a software request, not an emergency stop). **Blocked: START and speed commands**, with the reasons shown in the UI. Nothing is replayed after a reconnect (tested).

### WebSocket (`/api/torqva/ws`, read-only)
Authentication by a first `{"type":"auth","token":...}` message within 5 s (browsers cannot set headers on a WebSocket); bad/missing token, timeout, oversize or non-object -> close 4401; cross-site origin not on the allow-list -> 4403; any client message other than `ping` (including a command) -> 4400 and close. Server pushes: an initial `snapshot`, then events `device_connecting`, `device_disconnected`, `device_restarted`, `telemetry` (coalesced, at most 5/s per client), `telemetry_stale`, `device_state_changed`, `safety_fault_latched`, `connection_error`, `protocol_error`, `command_submitted|sent|acknowledged|executed|rejected|timed_out|unknown_outcome`. Per-client queues are bounded (drop-oldest); clients are removed on disconnect. The frontend reconnects with capped exponential backoff, polls REST as a fallback, ignores malformed messages and returns to SIMULATION when the device disconnects.

### Dashboard
New **Device** page (connection state, handshake, identity, firmware/protocol, last message, counters, admin-only port selection/connect/disconnect, events, trust-boundary note) and **Motor Control** page (motor/safety state, blocker list, disabled START/speed inputs, STOP request, command history); Live Monitor gains a Simulation/Device source switch (physical readings with validity/staleness, unavailable vibration, history chart with gaps); Overview shows a device card; the banner changes only when a physical device is verified. Without a device the app is unchanged (SIMULATION).

### Tests (this work)
`backend/tests/test_torqva_p16_serial.py` (47): parser (valid, oversize, malformed, NaN/Infinity, ranges, unsupported protocol, bad ack), model (invalid -> None, power invalid if inputs invalid, vibration unavailable, gaps/duplicates/restart/wrap, bounded history, staleness), bridge (handshake, firmware-SIM not physical, unsupported protocol, identity mismatch, unplug/release/reconnect, one owner, open failure, stale event, malformed lines), command lifecycle (correlation, late/duplicate/wrong-device/unknown acks, timeout without retry, blocked START/speed, no replay after reconnect or restart, write failure, safety fault event), event hub bounds, **bridge against the real C++ core** (identity verified, `blk` interlock reason from the device, STOP round trip), REST roles and validation, WebSocket auth/read-only/cleanup/disconnect event. `frontend/src/tests/torqva_device.test.jsx` (11) with a fake socket. Native firmware: 101 (status-frame fields). Real-core contract tests updated. Chrome E2E (`torqva-app`): 53 checks including the Device and Motor Control pages in the disconnected state.

### Not verified (requires a real ESP32 and a human)
Opening a real COM port, USB-CDC reconnect behaviour, real frame rates and timing on the host, a real physical-mode status frame, device flashing with the new status fields, WebSocket behaviour under a real browser with a live device (the Chrome E2E covers only the disconnected state), and everything under the existing hardware blockers.

### Remaining blockers (unchanged)
Secure device transport/session (TLS client on the device), independent hardware E-stop and wiring contract, default-off driver/relay hardware across reset, approved current/voltage/temperature/overspeed limits, approved watchdog timeout and an executed on-target test, retiring or porting the legacy sketch. **Physical START and speed commands stay blocked.**

## Phase 18 - moving the board from the legacy sketch to the supported firmware (preparation only; NOTHING flashed, COM7 not opened)

**Status: `TARGET COMPILE VERIFIED`, `SOFTWARE TESTED` (frames from the real C++ core pass the real backend validator). `ON-TARGET BEHAVIOR UNVERIFIED`, board model UNCONFIRMED, `PHYSICAL OPERATION PROHIBITED`.**

### Which PlatformIO environment
| Env | Serial goes to | Use when |
|---|---|---|
| `esp32s3` | the ESP32-S3's **native USB** port (`ARDUINO_USB_CDC_ON_BOOT=1`) | you connect the board's native USB connector; it appears as a *different* COM port ("USB JTAG/serial" or similar), not the CH343 one |
| `esp32s3_uart` (new) | **UART0 = the CH343 bridge port** (`ARDUINO_USB_CDC_ON_BOOT=0`) | you connect through the "UART/COM" connector, i.e. the port Windows names `USB-Enhanced-SERIAL CH343 (COM7)`, which is where the legacy sketch's text appeared |
Reason for the new environment: with `esp32s3` the TORQVA frames would be sent to the native USB port and the CH343/COM7 line would stay **silent**. Everything else is identical (control disabled, interlocks strict, no secrets). Both environments declare `board = esp32-s3-devkitc-1`, 16 MB flash and `qio_opi` (octal PSRAM) memory: that matches an **N16R8** module only. The CH343 name identifies the USB-to-serial chip, not the ESP32 module, so **the board model is not confirmed**. A mismatch (for example an 8 MB / no-PSRAM module) can make the image fail to boot; do not change the target to make a build pass.

### Build results (this session; no upload)
`python -m platformio test -e native`: 101/101. `python -m platformio run -e esp32s3`: SUCCESS (flash 9.6 %). `python -m platformio run -e esp32s3_uart`: SUCCESS (RAM 6.2 %, flash 10.0 %). Artifact for COM7 (UART bridge): `esp32/torqva_fw/.pio/build/esp32s3_uart/firmware.bin`, 334 192 bytes, SHA-256 `136e81366d4e52d576477061a27bada1306ed10f44e2c014698893788186eefc` (also `bootloader.bin`, `partitions.bin` and `firmware.elf` in the same folder). Native-USB variant: `.pio/build/esp32s3/firmware.bin`, 320 256 bytes, SHA-256 `ebfa20011caa1b2b4ec5420ecb9560d1451c174f4dfce5d4629ae137435c6a74`. The `.pio` folder is git-ignored; re-run the hash after any rebuild. The ELF contains `"proto":%u`, `NO_SECURE_SESSION`, `LIMITS_NOT_APPROVED`, `RESET_FAULT` and the device id `UNPROVISIONED`, and contains no `MOTOR_ON`, `smart_motor` or `BTS7960` strings (test `test_built_artifact_is_torqva_firmware_not_the_legacy_sketch`). It does contain the placeholder key `dev-key-change-me` (default; control is disabled and a control-enabled build with it is a compile error).

### Protocol compatibility (verified in software)
Every `fast`, `slow` and `status` line emitted by the real firmware core (host build) passes `parse_frame`; the status frame carries `proto` 1, `dev`, `blk` and `fm`; the sequence is gapless; frames are <= 287 bytes. The legacy text (`--- OVERALL CONDITION ---`, `STATUS : MOTOR OFF`, `[MOTOR] ...`) and status frames without `proto` are rejected, and nothing was loosened. This is a **protocol test, not a USB connection**: the fitl host build runs the firmware logic, not the ESP32 image. Identity: the default id is `UNPROVISIONED`, so the backend reports the identity as *unverified* until a per-unit `-DTORQVA_DEVICE_ID=\"...\"` and a matching expected id are used.

### Expected behaviour right after a future flash (so it is not misread)
* The ROM boot log on UART0 appears first and is rejected as malformed lines: normal.
* Control is disabled and the interlocks refuse START/speed (`blk` shows `LIMITS_NOT_APPROVED`, then others); the motor outputs are off.
* **A bare board with no sensors wired will latch `SENSOR_INVALID`** after 500 ms (critical signals current/voltage/housing are invalid): that is the fail-safe working, not a bug. The Device page will show the latched fault and `PHYSICAL DEVICE` only because the status frame says `mode: HW`.
* A watchdog/brown-out reset latches `RESET_FAULT` until an intentional reset.

### Procedure (nothing below was executed)
1. **Confirm the module.** Read the label on the metal shield (for example `ESP32-S3-WROOM-1-N16R8`: 16 MB flash, 8 MB octal PSRAM). Note which USB connector you use (UART/COM versus native USB). Optional read-only check after step 2: `python -m esptool --port COM7 flash_id` and `chip_id` (these enter the bootloader and read; they do not write).
2. **Free the port.** Quit the Arduino IDE completely (its `serial-monitor.exe` holds COM7), close other serial programs, disconnect the TORQVA Device page (Disconnect) so the backend releases the port.
3. **Isolate the motor.** Motor-driver power supply physically disconnected (not just switched off); the BTS7960 and relay must not be powered. Prefer a bare ESP32 on the bench.
4. **Select the artifact.** UART bridge (COM7): `esp32s3_uart`. Re-run `python -m platformio run -e esp32s3_uart` and compare the SHA-256 above.
5. **Verify upload settings** for your module: board, 16 MB flash and `qio_opi` for an N16R8; if the module differs, stop and decide the correct settings first.
6. **Pre-flash checklist:** steps 1-5 done; motor power isolated; no other program owns COM7; you accept that the legacy sketch will be overwritten (optionally back it up first with `esptool read_flash`); an independent person or a written note records the authorisation.
7. **Authorisation gate:** the upload command is `python -m platformio run -e esp32s3_uart -t upload --upload-port COM7`. It is **not to be run until you explicitly authorise it in a separate message**.
8. **After an authorised upload:** open the Device page, Connect COM7, wait for the handshake; check that the identity, firmware 3.0.0, wire protocol 1, `blk` and the latched `SENSOR_INVALID` (bare board) are shown; confirm no command was sent.
9. **Only then** treat the device as `PHYSICAL DEVICE` (the website does this automatically after a valid status frame with `mode: HW`); physical START and speed commands stay blocked.

Remaining blockers are unchanged (secure transport/session, independent E-stop and reset-safe driver circuitry, approved limits, watchdog on-target verification, legacy sketch retirement, board model confirmation).

## Phase 18 addendum - the sketch currently on the board shows the real pin map, and it does NOT match `torqva_fw` (flash gate)

The operator supplied the sketch running on the board (header: "TORQVA - ESP32-S3 N16R8", Arduino-ESP32 core 3.x, `SPEED_DEMO_MODE`). Its pin map is the best available evidence of the real wiring (it is the operator's own sketch, not a verified wiring contract). `esp32/torqva_fw/src/config_pins.h` is explicitly a **DRAFT** ("W0-optionB-UNVERIFIED"). Comparison:

| Signal | Operator's sketch | `torqva_fw` draft | Effect if `torqva_fw` were flashed on this wiring |
|---|---|---|---|
| Hall RPM | GPIO 9 | 9 | same |
| DS18B20 | GPIO 6 (one sensor read: index 0) | 6 (index 0 housing, index 1 ambient) | same pin; ambient would be invalid (non-critical) |
| INA219 (I2C bus 1) | SDA 7 / SCL 8 | 7 / 8 | same |
| BTS7960 **RPWM** | **38** | 15 (not connected) | firmware PWM goes to an unconnected pin; **pin 38 is configured as a pulled-up button input, which pulls the real RPWM input HIGH** |
| BTS7960 LPWM | 39 | 16 | firmware drives **16 LOW = the sketch's ADXL345 SDA** |
| BTS7960 R_EN | 18 | 18 (as EN2) | enable line |
| BTS7960 L_EN | 21 | 21 (as motor relay) | drives L_EN |
| (draft R_EN) | - | 17 | drives **17 = the sketch's ADXL345 SCL** |
| ADXL345 | SDA 16 / SCL 17 | not implemented | firmware does not read it |
| OLED SH1106 (software I2C) | SDA 4 / SCL 5 | not implemented | - |
| Status LEDs / buzzer | 10-13 / 14 | not implemented | - |
| Motor relay, local reset button | **not present in the sketch** | relay 21, button 38 | the firmware's reset needs the local button: **none is wired**; latched faults could only be cleared by power-cycling |

Consequences: (1) with control disabled (the default) the shipped firmware only drives the enable lines LOW and leaves RPWM pulled up with the driver disabled, so it would not start the motor, but it would hold the ADXL345 I2C lines low; (2) if control were ever enabled before the map is reconciled, R_EN/L_EN would be enabled while RPWM is pulled HIGH by the button input pull-up, i.e. a full-duty forward drive command with no PWM control; (3) the latch/reset design assumes hardware that is not present. **Gate: do not flash `torqva_fw` onto this wired board until a person confirms the real wiring and `config_pins.h` is reconciled (including the missing relay/button decision).** Flashing it on a bare ESP32 with nothing connected remains harmless. The sketch also confirms an N16R8 module (unverified).

Hazards in the sketch itself (it remains quarantined for TORQVA): serial `START`/`SPEED` energise the driver with no interlocks; `readTemperature()` waits ~750 ms synchronously each second, so `STOP` can be delayed by that long; no automatic stop on over-temperature, over-current, invalid sensors or lost communication (status text and buzzer only); `SPEED_DEMO_MODE` classifies commanded PWM, not shaft speed; no watchdog; blocking `delay(50)` and software I2C OLED in the main loop.

## Phase 19 - firmware pin map reconciled with the legacy wiring reference (software only; nothing flashed)

**Status: `SOFTWARE IMPLEMENTED`, `SOFTWARE TESTED`, `TARGET COMPILE VERIFIED`; wiring `UNVERIFIED`; board model `UNVERIFIED`; `HARDWARE NOT VALIDATED`; `PHYSICAL OPERATION PROHIBITED WHILE BLOCKERS REMAIN`.** This supersedes the pin-conflict gate above for the *code*; the physical wiring still has to be confirmed by a person. The artifact hashes in the Phase 18 section are obsolete (the firmware changed); use the ones below.

### Authoritative pin map (`esp32/torqva_fw/lib/torqva_core/pinmap.h`, namespace `torqva_pins`; no other file defines a GPIO)
| GPIO | Signal | Peripheral | Firmware status |
|---|---|---|---|
| 4 / 5 | OLED SDA / SCL | SH1106, software I2C | **reserved, not driven** (no display support) |
| 16 / 17 | ADXL345 SDA / SCL | I2C bus 0 | **reserved, not driven or read** (no accelerometer support; total acceleration would not be vibration RMS) |
| 7 / 8 | INA219 SDA / SCL | I2C bus 1 (`Wire1`) | used: bus voltage, current, power; presence probe |
| 6 | DS18B20 data | one-wire | used: index 0 = housing (index 1 = ambient if fitted) |
| 9 | Hall RPM | interrupt, `INPUT_PULLUP` | used: pulse validation, rpm |
| 10 | motor LED | annunciator | used: driver enabled |
| 11 | temperature LED | annunciator | used: housing sensor valid |
| 12 | accelerometer LED | annunciator | held off (accelerometer unsupported) |
| 13 | INA219 LED | annunciator | used: current and voltage valid |
| 14 | buzzer | annunciator | beeps (300 ms) while a safety fault is latched; not a safety function |
| 18 | R_EN | BTS7960 | driver enable, LOW by default |
| 21 | L_EN | BTS7960 | driver enable, LOW by default (driven together with R_EN) |
| 38 | RPWM | BTS7960 | PWM (20 kHz, 10 bit), 0 by default |
| 39 | LPWM | BTS7960 | held LOW as a plain output (unidirectional) |
| - | motor relay | - | **UNCONFIGURED: no documented pin; no relay is driven** |
| - | local reset button | - | **UNCONFIGURED: no documented pin; a latched trip cannot be reset in software, only by a power cycle** |
| - | E-stop input | - | **UNCONFIGURED: `estop_input_wired` stays false, so motor-energising commands are refused** |

Serial transport is not on this map: `esp32s3_uart` uses UART0 (GPIO 43/44, the CH343 bridge), `esp32s3` uses native USB (GPIO 19/20); both are kept free of other assignments.

### Former conflicts and how each was resolved
| Conflict | Resolution |
|---|---|
| GPIO 38 was a pulled-up button input (would pull the real RPWM high) | 38 is RPWM; the button is unconfigured |
| GPIO 17 was a driver enable (ADXL345 SCL) | 17 is reserved for the ADXL345 and not driven; enables are 18 and 21 |
| GPIO 16 was LPWM (ADXL345 SDA) | 16 is reserved and not driven; LPWM is 39 |
| GPIOs 18 / 21 were enable 2 / relay | 18 = R_EN, 21 = L_EN; no relay is driven |
| PWM was on GPIO 15 (not connected) | RPWM = 38 |
| No buzzer/LED support | LEDs 10-13 and buzzer 14 are initialised LOW first and driven as annunciators |

### Checks
* Native (`pio test -e native`): 107/107 including `test_pinmap_*` (matches the documented reference, no duplicate GPIO, every required peripheral assigned, undocumented interfaces unconfigured, no strapping/USB/flash/PSRAM/UART0 pin used on the N16R8, sensor buses apart from the driver pins) and `OUTPUT_INIT_FAULT`. Mutation-checked (moving RPWM to 17 or R_EN to 38 fails tests). They run against the same `pinmap.h` the firmware compiles. The N16R8 reserved list (strapping 0/3/45/46, USB 19/20, flash 26-32, PSRAM 33-37, UART0 43/44) follows the ESP-IDF ESP32-S3 GPIO documentation as I know it; I did not browse it in this session, so confirm it against the module datasheet.
* `backend/tests/test_torqva_p19_pins.py`: static checks of the production files (no numeric GPIO literals in `main.cpp`, no other file defines a GPIO, reserved pins never configured, PWM failure keeps the driver disabled, wiring id stays UNVERIFIED).
* Initialisation: `outputs_off()` is still the first statement of `setup()` and now drives enables, PWM pins and annunciators low (unconfigured pins are never touched). If the PWM peripheral cannot be set up the driver is never enabled and `OUTPUT_INIT_FAULT` is latched (reported in the status frame). The INA219 bus uses pins 7/8 only; the ADXL345 and OLED buses are not started.
* Protocol: unchanged (`wire protocol 1`); the wiring id is now `W1-LEGACYMAP-UNVERIFIED`. Backend protocol/contract tests pass (608 backend tests).

### Builds (no upload) and artifacts
`esp32s3_uart` (CH343/COM7, serial on UART0): SUCCESS, RAM 6.3 %, flash 10.0 %; `esp32/torqva_fw/.pio/build/esp32s3_uart/firmware.bin`, 334 320 bytes, SHA-256 `a175db1149bbb48e3315943d92e8562ee7db2439c6f0f208bfb453199eb54f57`. `esp32s3` (native USB): SUCCESS; `.pio/build/esp32s3/firmware.bin`, 320 384 bytes, SHA-256 `0f53e45cde7efde68d1ebe0bfac8afc9917b0fe6b746c6e8d269cf93108ac2ca`. Board target: `esp32-s3-devkitc-1` with 16 MB flash and `qio_opi` PSRAM, i.e. an N16R8 module per the PlatformIO configuration and the operator's sketch header; the actual module is **not confirmed** (the CH343 chip is only the USB-serial bridge).

### Pre-flash report (nothing was uploaded)
* **Intended wiring (to confirm by a person, wire by wire):** the table above: BTS7960 R_EN/L_EN/RPWM/LPWM to GPIO 18/21/38/39; INA219 on 7/8; DS18B20 on 6 with its pull-up; Hall on 9; ADXL345 on 16/17 and OLED on 4/5 (connected but unused by this firmware); LEDs 10-13 and buzzer 14.
* **Required sensor connections for a sensible bring-up:** INA219 (current, voltage), DS18B20 (housing) and the Hall signal; missing critical signals latch `SENSOR_INVALID` after 500 ms (fail-safe). Ambient (second DS18B20), vibration and acceleration stay unavailable.
* **First communication test:** motor-driver power physically isolated (BTS7960 and motor supply disconnected), nothing connected to the driver outputs; preferably the driver board unplugged from GPIO 18/21/38/39 as well.
* **Outstanding wiring confirmations:** every pin above; whether the CH343 port or the native USB port is used; the actual module model; whether any relay or reset button exists (none is documented, so none is driven or read).
* **Remaining blockers (unchanged):** an independent hardware E-stop and its wiring contract; a reset arrangement (no documented button, so latched faults clear only by power cycle); default-off hardware (pull-downs on R_EN/L_EN/RPWM/LPWM) across reset and brown-out; approved current/voltage/temperature/overspeed limits; an approved watchdog timeout and an executed on-target test; a secured device transport; confirmation of the board model; retiring the legacy sketch. **Flashing still requires your separate explicit authorisation, and physical motion commands stay blocked.**

## Phase 20 - real sensor firmware (ADXL345, OLED, annunciators), Device-page states and the PRE-FLASH CHECKPOINT (nothing flashed, COM7 not opened)

**Status: `SOFTWARE IMPLEMENTED`, `SOFTWARE TESTED`, `TARGET COMPILE VERIFIED`; `ON-TARGET BEHAVIOR UNVERIFIED`; wiring `UNVERIFIED`; board model/revision `UNVERIFIED`; physical USB handshake `NOT YET ATTEMPTED` (the board still runs the legacy sketch); `PHYSICAL OPERATION PROHIBITED`.**

### What the supported firmware now does (sensors actually implemented in `esp32/torqva_fw`)
| Sensor / output | Pins | Implementation | What is reported |
|---|---|---|---|
| INA219 | 7 / 8 (bus 1) | Adafruit driver, presence probe every 100 ms | voltage, current, power; invalid -> flag clear, never zero |
| DS18B20 | 6 | non-blocking conversion, 3 s freshness | housing temperature (index 0); ambient (index 1) only if fitted |
| Hall | 9 | interrupt, pulse debounce, 1 pulse/rev | rpm; missing pulses are not treated as a sensor fault while idle |
| **ADXL345 (new)** | 16 / 17 (bus 0) | direct register driver (no library): device-id check, +-16 g full resolution, 10 Hz, 1 s freshness; decoding is host-tested (`adxl345.h`) | `accel` frames: raw ax/ay/az in g and the magnitude of the TOTAL acceleration vector (**includes gravity, about 1 g at rest; NOT vibration RMS**). `ok:0` with no numbers when absent/invalid. Vibration RMS stays unimplemented (`vib_valid=false`) |
| **OLED SH1106 (new)** | 4 / 5 (software I2C) | U8g2, 2 Hz, in the communications task only (never the control task); can be disabled with `-DTORQVA_OLED=0` | safety state, trip reason, drive, whether motion is locked, rpm/housing/I/V/|a| or `n/a`. Annunciation only; no decision depends on it |
| LEDs 10-13, buzzer 14 | 10, 11, 12, 13, 14 | outputs forced LOW first in `setup()`; LEDs = driver enabled / housing valid / accelerometer valid / INA219 valid; buzzer beeps while a fault is latched | annunciators, **not safety functions** |
| Motor driver | 18, 21, 38, 39 | unchanged from Phase 19: all LOW at boot; PWM failure keeps the driver disabled and latches `OUTPUT_INIT_FAULT` | physical START/speed remain refused by the interlocks |
Final GPIO table: Phase 19 section above (the ADXL345 and OLED pins are now in use rather than reserved). The wire protocol stays version 1: the new `accel` frame shares the one gapless sequence counter; `fast`/`slow`/`status`/`ack` are unchanged. The backend parser rejects an `accel` frame that is malformed, has numbers while `ok:0`, is out of range, or non-finite.

### Board and GPIO findings (no pin was changed)
* GPIO 4-14, 16-18, 21, 38 and 39 are not strapping, flash, PSRAM, USB or UART0 pins on an ESP32-S3 N16R8 as far as I know the module (the native tests encode this list; confirm against the module datasheet). **GPIO 38 needs a board-revision check:** on some ESP32-S3-DevKitC-1 revisions (v1.1) the on-board addressable RGB LED data line is wired to GPIO 38, while on v1.0 it is GPIO 48. If your board is such a revision, RPWM shares that net with the RGB LED (the LED would see the PWM, and the LED hardware may load the line). Check the board's schematic/silkscreen; this is an assumption I could not verify from here. GPIO 39 is also the JTAG TCK pin (irrelevant unless JTAG is used).
* The board identity is **not** established by COM7 (that only names the CH343 USB-serial chip). Your sketch header says N16R8; the PlatformIO target assumes 16 MB flash and `qio_opi` PSRAM; neither is confirmed on the physical module.

### Backend and website
* Parser/model: `accel` frames, per-sensor status (`valid`, `invalid`, `stale`, `unavailable`), `acceleration` value with an explicit "total, gravity included, not vibration RMS" note, history for `acceleration` (invalid = gap), the selected `port`, and a single `state_label`: `DISCONNECTED`, `PORT OPEN - WAITING FOR HANDSHAKE` (plus "receiving non-TORQVA data" when only legacy text arrives), `HANDSHAKE INVALID`, `PHYSICAL DEVICE CONNECTED`, `DEVICE CONNECTED (FIRMWARE SIMULATION MODE)`, `TELEMETRY STALE`, `CONNECTION ERROR`. Repeated protocol errors are aggregated: one event per code per 2 s with a count, and the Device page merges repeats into one row ("x N"); the counters stay exact.
* Device page: state label, port, firmware/protocol/id, last-message time, all counters, a sensor-availability table, the structured error with recovery steps, total acceleration tile, "Vibration RMS: UNAVAILABLE". Nothing reports `PHYSICAL DEVICE CONNECTED` from an open port or a WebSocket alone. Without a device the app stays in SIMULATION.

### Tests (this phase)
Native firmware 112/112 (ADXL345 decode incl. gravity and implausible data, accel frame content and `ok:0` rules, display snapshot, plus all earlier tests). Backend 617 passed (parser, model, sensor status, state labels, aggregated events, and accel frames from the **real firmware core** through the real parser). Frontend 82 passed, production build OK. These are software tests, **not a real USB connection**.

### Builds (no upload) and artifacts
`python -m platformio run -e esp32s3_uart` (CH343 / UART0, the candidate for COM7): SUCCESS, RAM 6.6 %, flash 10.3 %; `esp32/torqva_fw/.pio/build/esp32s3_uart/firmware.bin`, 343 920 bytes, SHA-256 `e184d2638ad2ae97c2a00f99c96c4547ded4b657c1d17a05ab4129576c656b35`. `python -m platformio run -e esp32s3` (native USB): SUCCESS, flash 9.9 %; `.pio/build/esp32s3/firmware.bin`, 330 000 bytes, SHA-256 `1d9a6343e9a9d84fd39bdaffd3410519b4e35dfee877511a9e172d09e5b4498e`. Earlier hashes are obsolete. The `esp32s3_uart` ELF contains no `MOTOR_ON` string and the default id `UNPROVISIONED`; it needs the U8g2 library (downloaded by PlatformIO).

### PRE-FLASH CHECKPOINT (STOP: authorisation required; nothing below was executed)
**Which environment and why:** `esp32s3_uart`, because the board is reached through the CH343 bridge (UART0), where the legacy text appeared. `esp32s3` would send frames to the native USB port and leave COM7 silent.
**Unresolved before an upload can be requested (please provide):**
1. **Board identity:** a clear photo of the module's metal shield (the printed module name, for example `ESP32-S3-WROOM-1-N16R8`) and of the development board's silkscreen/revision label, and which USB connector (UART/COM or USB) the cable uses. Optional but best: after quitting the Arduino IDE and disconnecting TORQVA, run the read-only `python -m esptool --port COM7 chip_id` and `flash_id` (they enter the bootloader and read; they do not write) and paste the output: it reports the chip, flash size and PSRAM. A mismatch with 16 MB / octal PSRAM must be resolved before flashing.
2. **GPIO 38 / board revision:** whether an on-board RGB LED is wired to GPIO 38 on your board.
3. **Wiring:** a person confirms each connection in the GPIO table (BTS7960 R_EN 18 / L_EN 21 / RPWM 38 / LPWM 39, INA219 7/8, DS18B20 6, Hall 9, ADXL345 16/17, OLED 4/5, LEDs 10-13, buzzer 14). Nothing has verified that the physical wires match.
4. **Motor-driver power physically isolated** (BTS7960 and motor supply disconnected, driver outputs unconnected; preferably the BTS7960 board unplugged from GPIO 18/21/38/39 as well).
5. **Port free:** Arduino IDE fully quit, no other serial program, TORQVA Device page disconnected.
**Upload command, NOT to be run until you authorise it in a separate message:** `python -m platformio run -e esp32s3_uart -t upload --upload-port COM7`. After an authorised upload: reconnect through the Device page (no motor commands) and verify the handshake: state `PHYSICAL DEVICE CONNECTED`, firmware 3.0.1-dev, wire protocol 1, id `UNPROVISIONED` (identity unverified), `blk` interlock reasons, and the sensor table. A bare or partially wired board will latch `SENSOR_INVALID` (fail-safe) and show missing sensors as invalid/unavailable.
**Remaining safety blockers (unchanged):** independent hardware E-stop and its wiring contract; no documented reset button or relay (latched faults clear only by power cycle); default-off hardware on the driver lines across reset and brown-out; approved current/voltage/temperature/overspeed limits; approved watchdog timeout and an on-target test; secured device transport; retiring the legacy sketch. Physical START and speed commands stay blocked.

## Phase 21 - legacy `smart_motor_monitor` firmware RETIRED from the current tree (software and repository change only; nothing flashed, COM7 not opened, no motor operated)

**Status: `esp32/torqva_fw/` is the sole supported firmware.** The legacy sketch (`esp32/firmware/smart_motor_monitor/smart_motor_monitor.ino`) and its quarantine README were removed with `git rm` in an ordinary reviewed commit; they remain in Git history only and must not be recovered, built or uploaded. The earlier sections of this document (Phases 14-20) are preserved as written and are marked retired where they discuss the quarantine: the compile guards (`TORQVA_LEGACY_UNSAFE_ACKNOWLEDGED`, `TORQVA_LEGACY_ENABLE_MOTOR`) existed only in that sketch and no longer exist.

* **Old serial text is not TORQVA telemetry.** `STATUS: MOTOR OFF`, `OVERALL CONDITION`, `[TCP ...]` and similar lines are rejected by the backend parser, counted as malformed, shown as `HANDSHAKE INVALID`, and can never switch the app into physical-device mode. The backend still recognises such text purely to explain why the handshake failed; it never accepts it. Tests: `backend/tests/test_torqva_p21_legacy_retired.py`.
* **The board is unchanged.** It may still physically run the retired sketch until a separate, explicit flash authorisation is given and the pre-flash checkpoint (Phase 20) is satisfied. Removing the source from the repository does not change what is on the board.
* **Environments kept, not merged:** `esp32s3_uart` (Serial on UART0 via the CH343 bridge) and `esp32s3` (Serial on native USB CDC); `native` and `fitl` for host tests. Purposes are documented in `esp32/README.md`. No GPIO mapping was changed.
* **Backend legacy TCP path (not removed here).** `backend/tcp_server.py` (TCP 5001) and `POST /api/motor` belong to the older monitoring backend and its legacy dashboard component; they were the counterpart of the retired sketch. No supported firmware connects to them. They are not a TORQVA device path and the TORQVA serial bridge never uses them. Removing them is a separate, reviewed change (it touches the older monitoring API and its tests).
* **Stale pin tables.** `README.md`, `docs/hardware.md` and `docs/HARDWARE_WIRING.md` still contain a historical pin table from an older sketch revision that disagrees with `pinmap.h` (BTS7960 and ADXL345 pins). They are labelled historical; `pinmap.h` is authoritative; none is a verified wiring contract.
* **Remaining blockers for physical motor operation (unchanged, the retirement item is now done):** independent hardware E-stop and wiring contract; reset-safe default-off driver circuitry; approved current/voltage/temperature/overspeed limits; approved watchdog timeout with an on-target test; secured device transport; board model/revision confirmation (including GPIO 38). **The hardware is not ready for physical motor operation.**

## Phase 22 - interlock display, Motor Control refinements and the operator bring-up checklist (software only; nothing flashed, COM7 not opened, no motor operated)

* Backend `DeviceBridge.interlocks()` (in every device snapshot): 12 interlocks with VERIFIED / BLOCKED / NOT VERIFIED / UNAVAILABLE. E-stop circuit, reset-safe driver and watchdog are never VERIFIED by software; secure session, supervisor and commissioning are BLOCKED.
* Motor Control page: interlock table, device identity, requested duty vs measured rpm/current/voltage/temperature, vibration RMS shown UNAVAILABLE, a duty slider (0-100 % input domain only, nothing sent while moving it) and a two-step START confirmation. Speed range is not shown: no limits are approved.
* Operator checklist: `docs/TORQVA_HARDWARE_BRINGUP_CHECKLIST.md` (all items unverified).
* Firmware unchanged. Artifacts (re-built this phase): `esp32s3_uart` 343 920 bytes, SHA-256 `e184d2638ad2ae97c2a00f99c96c4547ded4b657c1d17a05ab4129576c656b35`; `esp32s3` 330 000 bytes, SHA-256 `1d9a6343e9a9d84fd39bdaffd3410519b4e35dfee877511a9e172d09e5b4498e`. Board model/revision, GPIO 38 and all wiring remain UNVERIFIED. Upload is not authorised.

## Phase 24 - commissioning record (software only; nothing flashed, no port opened, no motor operated)

* `backend/torqva/commissioning.py`, `/api/torqva/device/commissioning*` and the Motor Control "Commissioning" card: eight hardware attestations (board identity, GPIO 38, wiring, logic levels, ratings, E-stop, driver default-off, watchdog), approved limits (current, voltage, temperature, rpm, duty) and an explicit enable that needs every item VERIFIED, limits, and a typed phrase. Admin-only, audited, written evidence required, atomic JSON file (`backend/data/commissioning.json`, git-ignored; override with `TORQVA_COMMISSIONING_FILE`). A damaged file is treated as empty.
* **It is a human record, not a measurement.** VERIFIED means a person attested it. It never overrides the firmware: START and speed are still refused by the firmware interlocks (limits compiled in, no E-stop input in the firmware, no secure session) and by the supervisor, which the serial bridge never enables.
* The backend request ceilings (duty, rpm) come from the approved limits; without them START and speed are refused (`NO APPROVED DUTY/SPEED LIMIT`).
* **Still not implemented (needs firmware work and decisions):** authenticated USB sessions with replay protection and expiry; a firmware E-stop input (needs a pin you choose and a wiring contract); direction (the firmware never drives LPWM by design); a firmware build that carries the approved limits (`TORQVA_LIMITS_APPROVED`).

## Phase 25 - SENSOR_INVALID root cause fixed in firmware (software only; nothing flashed)

See `docs/TORQVA_GAP_AUDIT.md`. 0 V from a responding INA219 is now a valid measurement; an absent supply while idle no longer latches a fault; new start interlock `SUPPLY_NOT_PRESENT`. New artifacts (NOT on the board): `esp32s3_uart` 344 032 bytes SHA-256 `d85a178857f1551f7d1a682eb22a47c297936682193cf95411602ee739c715a6`; `esp32s3` 330 096 bytes SHA-256 `c5304d24e289f67b3bcd21820ed46ae7c1bbcc4ed1042216840501627e58c2e9`. The earlier hashes are obsolete.

## Phase 27 - authenticated USB session, physical-data adapter (software only; nothing flashed, no port opened)

See `docs/TORQVA_GAP_AUDIT.md` (Phase 27 additions). Provisioning is offline and manual (`backend/tools/provision_device_key.py`); the shipped firmware has no key, so no session can exist until you provision one and separately authorise a flash. Even then motion stays refused by the remaining interlocks.
