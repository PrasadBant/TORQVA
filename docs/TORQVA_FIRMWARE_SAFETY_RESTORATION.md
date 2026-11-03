# TORQVA — Firmware Safety Protection Restoration (3 Nov 2026)

> **Physical-operation status: BLOCKED.** This work restores the firmware and backend source to the reviewed, tested safety design and proves it with host (software) tests only. Nothing was flashed, no board was connected, and no START / SET_SPEED was sent. Passing host tests is **not** hardware validation.

## 1. What was weakened, and where the intended behaviour comes from

Commit `319fb7b` (11 Oct 2026, "industrial UI/UX refinement, live physical data streaming…") changed eight firmware files and the serial bridge. No firmware file changed after it, and **no firmware test changed in it**: the 130 host tests, the backend firmware-source checks and the code comments of the parent commit (`319fb7b^`, itself the result of the reviewed phases up to `da6c281`) state the intended behaviour. Values below are the parent's; none were invented.

| # | Protection | After `319fb7b` (weakened) | Intended / restored | Evidence (test that encodes it) |
|---|---|---|---|---|
| 1 | Hardware interlock mode | `cfg.relaxed_interlocks = true` on the hardware build ("allow motor motion!") | `false`: hardware builds never relax the start interlocks; only host simulation (SimPlant / fitl / tests) sets it | `test_every_commissioning_flag_defaults_to_zero_and_hardware_never_relaxes_interlocks` |
| 2 | Scope of `relaxed_interlocks` | also disabled the sensor-invalid, over-current, voltage, RPM-loss and heartbeat **trips** | relaxes start interlocks only; every trip is always evaluated | `test_critical_sensor_invalid_trips_after_500ms`, `test_sustained_overcurrent_from_friction_trips`, `test_voltage_window`, `test_dead_hall_trips_rpm_loss`, `test_heartbeat_loss_trips_and_latches` |
| 3 | Authentication | relaxed mode marked every command authorized | plaintext key or, with a provisioned device key, a MAC bound to the live session and a fresh counter; STOP is never refused | `test_wrong_key_cannot_start_motor`, `test_authenticated_session_gates_every_command_and_never_blocks_stop`, `test_commands_must_carry_the_live_session_id_and_old_session_ids_are_rejected` |
| 4 | Emergency-stop latch | any command auto-reset a latched EMERGENCY_STOP | stays latched; reset needs an authorized RESET_ESTOP **and** the local button (not fitted, so a latch is cleared only by the intentional reset procedure / power cycle) | `test_trip_latches_and_keeps_first_cause`, `test_reset_requires_authorization_and_local_button`, `test_reset_needs_command_and_local_button` |
| 5 | Replay protection | relaxed mode reset the sequence for `seq <= 10`; a new session reset it too | counters only increase; old counters are refused | `test_replayed_commands_are_not_executed_twice_and_old_sequence_numbers_are_refused` (passed throughout) |
| 6 | Acknowledgements | instant `COMPLETED` for START ("STARTED") and SET_SPEED ("APPLIED") | `ACCEPTED` only: an acknowledgement is not execution | `test_strict_start_permitted_only_when_every_interlock_passes_and_then_ramps` |
| 7 | Voltage limits | `volt_min_v` 20 → 0 V, `volt_max_v` 25.5 → 28 V; low-voltage trip skipped when min is 0; restored runtime limits forced min to 0 | 20.0 V / 25.5 V; low supply while driving, or present but low, trips | `test_default_limits_match_master_prompt`, `test_voltage_window`, `test_absent_supply_while_idle_is_not_a_latched_fault_but_blocks_motion_and_trips_while_driving` |
| 8 | Heartbeat dead-man | timeout 2 s → 5 s, and off in relaxed mode | 2000 ms while driving in hardware mode | `test_heartbeat_dead_man_applies_while_driving_not_while_idle`, `test_link_loss_mid_test_ends_safely_on_device` |
| 9 | Sensor-invalid time | 500 ms → 2000 ms | 500 ms | `test_critical_sensor_invalid_trips_after_500ms`, `test_sensor_loss_trips_fail_safe` |
| 10 | Speed limit | `max_rpm` 0 → 3000 (as if commissioned) | 0 = not commissioned: SET_SPEED refused until a human approves a limit | `test_set_speed_rejected_until_commissioned`, `test_cmd_not_commissioned_and_sim_mode` |
| 11 | RPM-loss detection | Hall "recent pulse" window 1 s → 4 s; Hall pulses faster than 12 ms ignored (speed capped at 5000 rpm, hiding over-speed) | 1 s window; 2 ms debounce (30 000 rpm) | `test_dead_hall_trips_rpm_loss` |
| 12 | Brown-out | detector disabled in `setup()` | enabled; a brown-out reset latches `RESET_FAULT` until the intentional reset | `test_motor_outputs_are_forced_off_before_anything_else_in_setup` (outputs first), `test_a_boot_fault_latches_until_an_intentional_reset_and_never_restarts_the_motor` |
| 13 | Boot-fault latching | skipped in relaxed mode (PWM init failure, watchdog / panic / brown-out resets) | always latched | same as 12, `test_an_output_initialisation_fault_latches_blocks_start_and_is_reported` |
| 14 | Control compile-in, limits approval | `control_enabled = true` and `limits_approved = true` unconditionally; stored runtime limits erased at boot | `#ifdef TORQVA_CONTROL_ENABLED`; `TORQVA_LIMITS_APPROVED` build declaration; stored limits restored (they set trip numbers, never approve motion) | `test_supported_firmware_default_build_keeps_motor_control_compiled_out`, `test_a_restored_configuration_sets_the_trip_numbers_but_never_approves_motion…` |
| 15 | Secure session | (backend check) | firmware never declares a secured transport by itself | `test_firmware_never_establishes_a_secure_session_because_no_secured_transport_is_implemented` |

### Backend leftovers of the same commit (fixed here)

| Item | Weakened | Restored |
|---|---|---|
| Safety Supervisor context (`serial_bridge._ctx`) | `voltage_v` was a fixed **24.0 V** (a fabricated reading), and voltage was left out of `sensors_valid` | the measured voltage (missing = `None`); voltage counts as a critical sensor |
| "Sensors valid" interlock | ignored voltage | current, voltage, housing temperature and rpm |
| Command key | the build sentinel `"authenticated-session-only"` was sent as the plaintext key when `TORQVA_FW_COMMAND_KEY` is unset | empty: non-STOP commands carry no key; an authenticated session's MAC is the only way |

Already fixed earlier and verified unchanged: the `TORQVA_FORCE_UNLOCK` bypass (removed 18 Oct), the "all layers ACTIVE" physical analysis status, and the commissioning API's silent 0–26 V voltage defaults (both fields are required; the form has them).

## 2. Code changes

- `esp32/torqva_fw/lib/torqva_core/{commands.h, control.cpp, device.cpp, safety.cpp, safety.h, torqva_limits.h}`, `esp32/torqva_fw/src/{config_pins.h, main.cpp}`: restored byte-for-byte to `319fb7b^` (`git checkout 319fb7b^ -- <the eight files>`). Nothing else in the firmware changed; `platformio.ini` (from `da6c281`, the authenticated-session design) is unchanged.
- `backend/torqva/serial_bridge.py`: the three backend items above.
- `backend/tests/test_torqva_safety_restoration.py` (new, 4 tests): measured voltage reaches the Supervisor; an invalid voltage blocks the Supervisor context and the sensor interlock; a valid set verifies it; no placeholder key. All four fail on the code before this change.
- `backend/tests/test_torqva_p27_auth_session.py`: the Python/C++ MAC interoperability test used a fixed counter (900001). The bridge seeds its counter from the clock (`319fb7b`, kept: counters still only increase and every command still needs a MAC), so its heartbeats had already moved the device past 900001 and the "fresh" command was correctly refused as REPLAY. The test now takes a counter above the bridge's own; its four assertions (authentic accepted, tampered → BAD_MAC, old counter → REPLAY, STOP executes) are unchanged.

### Reverted with the protections, needing an engineering decision before they return

These were in `319fb7b` but are control tuning, not protections, and were never reviewed or tested; they were reverted with their files so that the firmware is exactly the tested design:

- Speed loop: integrator lower bound −15 %, a feed-forward term (`12 % + 30 % × rpm / max_rpm`), and a 10 % breakaway duty floor (a requested 1–9 % duty became 10 %). Gains `kp = 0.06, ki = 0.10` replaced the placeholders `0.01 / 0.03` ("tune during commissioning").
- Hall input: a 60 µs `delayMicroseconds` noise check inside the interrupt and the 12 ms debounce.

If PWM noise on the Hall input is real on the rig, it needs a fix that keeps over-speed and RPM-loss detection intact (for example hardware filtering or a debounce derived from the approved maximum speed), reviewed and tested; tuning belongs to commissioning.

## 3. Tests executed (all on the host; no hardware)

| Suite | Before (baseline, this session) | After |
|---|---|---|
| Firmware host tests, `python -m platformio test -e native` | 105 passed, **25 failed** (130 tests; both suites reported ERRORED) | **130 / 130 passed** |
| Firmware-in-the-loop binary, `pio run -e fitl` (clean rebuild) | built 11 Oct 03:58 (before `319fb7b`) | rebuilt 3 Nov from the restored source |
| Backend, `python -m pytest -q` | 702 passed, **5 failed**, 1 skipped (the five firmware-source safety checks) | 726 passed, 0 failed, 1 skipped (+4 restoration tests, +15 serial-error tests from the separate serial fix) |

The 25 firmware failures fixed: the voltage, sensor-invalid (×3), heartbeat (×3), latch and reset (×4), commissioning (×2), default-limits, wrong-key, RPM-loss, over-current, sensor-loss, link-loss, strict-start, STOP-never-blocked and session tests listed in section 1.

## 4. Remaining limitations

- Host tests exercise `lib/torqva_core` and the FITL build; the Arduino glue in `src/main.cpp` (ISR, PWM, brown-out register, NVS) compiles only for the ESP32 targets and is checked by source inspection tests, not executed.
- `current_inst_a = 5.0 A` is still marked "ASSUMPTION: PSU limit unknown (human task H-10)".
- No local reset button is fitted, so a latched trip needs the documented intentional reset.
- The control-loop tuning and Hall filtering above are open engineering decisions.

## 5. Hardware validation still required (`docs/TORQVA_HARDWARE_BRINGUP_CHECKLIST.md`)

A qualified person must: confirm the wiring, install and verify the independent hardware E-stop that removes driver power, provision the per-device key, approve the operating limits through commissioning (with the PSU current limit), verify each trip on the bench (over-current, voltage, temperature, RPM loss, sensor loss, heartbeat, brown-out), and only then enable physical control. Flashing is a deliberate manual step.

## 6. Readiness

- Firmware protections restored in source: **yes**.
- Firmware host tests: **130 / 130 pass**.
- Backend safety tests: **pass** (726 passed, 0 failed).
- Hardware commissioning complete: **no**.
- Physical motor operation permitted: **no**. It stays blocked until section 5 is done.
