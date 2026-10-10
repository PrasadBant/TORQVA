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
