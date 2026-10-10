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
