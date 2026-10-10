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
