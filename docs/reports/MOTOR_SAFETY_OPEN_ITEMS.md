# Motor safety: open items that block powered motor testing

Status, 27 Nov 2026: **unresolved.** None of these were changed by the Wi-Fi reliability work, and none of them were exercised: motor power stayed physically disconnected for the whole bench run and no motor command was sent. They must be resolved before any powered motor test.

## 1. Direct mode disables the communication-loss stop

`firmware/src/main.cpp`, `setup()`: when `cfg.direct_mode` is true (every non-bench build), the runtime limits are replaced with:

| Limit | Direct-mode value | Effect |
|---|---|---|
| `heartbeat_timeout_ms` | **0** | Losing the host heartbeat does **not** stop the drive. A dropped Wi-Fi or USB link alone does not bring the motor to a safe stop. |
| `rpm_loss_ms` | 0 | Loss of the Hall RPM signal is not a trip. |
| `current_stop_a` / `current_inst_a` | 100 A / 100 A | Far above the INA219 32 V / 2 A calibration. |
| `temp_stop_c` | 150 °C | |
| `max_duty_pct`, `ramp_pct_per_s` | 100 %, 1000 %/s | |

What still stops the drive: a new or ended authenticated session (`SESSION_REPLACED` / `SESSION_LOST` in `device.cpp`), operator STOP, the task watchdog and the independent emergency-stop circuit. Communication loss **without** a session change does not.

## 2. Backend interlock tests that fail before and after this work

Run on 27 Nov with the firmware-in-the-loop CLI built (`pio run -e fitl`):

- `tests/test_torqva_p14_contract.py::test_strict_firmware_refuses_motor_commands_until_both_commissioning_decisions_are_declared`: the command is ACCEPTED where REJECTED is expected.
- `tests/test_torqva_p14_contract.py::test_strict_firmware_start_requires_an_active_watchdog_and_then_runs_with_every_interlock_verified`: the block reason is `OK` where `WATCHDOG_NOT_ACTIVE` is expected.
- `tests/test_torqva_p14_contract.py::test_strict_firmware_refuses_motion_without_a_live_authenticated_session_even_when_everything_else_is_declared`: `OK` where `TRANSPORT_NOT_SECURED` is expected.
- `tests/test_torqva_p18_firmware_bringup.py::test_every_frame_the_firmware_emits_passes_the_real_backend_validator_and_the_handshake_fields_are_present`: the block reason is empty where `LIMITS_NOT_APPROVED` is expected.

These match `docs/reports/FIVE_INTERLOCK_TEST_FAILURES.md`. The fifth test listed there (`test_built_artifact_is_torqva_firmware_not_the_legacy_sketch`) passes or fails depending on which firmware build artifact is on disk, not on the code.

## Required before powered testing

1. Decide the direct-mode heartbeat policy. A non-zero `heartbeat_timeout_ms` would make link loss stop the drive.
2. Reconcile the strict-mode interlock contract with the firmware, so the four tests pass. Don't weaken the tests.
3. Re-run the full backend suite with the FITL CLI built, then a supervised low-power first spin with the e-stop verified.
