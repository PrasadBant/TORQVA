# Legacy sketch - quarantined, not supported

`smart_motor_monitor/smart_motor_monitor.ino` is the original Arduino-IDE monitoring sketch. **Do not upload it to a rig with motor or driver power connected.**

Why (verified in the source):
* `MOTOR_ON` received on the TCP socket calls `setMotorState(true)` with no authentication: it sets BTS7960 `R_EN`/`L_EN` high and `analogWrite(PIN_RPWM, 200)` (200/255) immediately, with no ramp.
* No task watchdog, no finite-value (NaN/Inf) checks, no start interlocks, no latching fault state, no emergency-stop input, no command freshness or replay protection.
* The backend's legacy `/api/motor` route reaches it with no credential unless `TORQVA_TOKENS` is configured.

What protects against accidental use:
* Even when the compile override is defined, `setMotorState(true)` refuses to energise the driver unless `TORQVA_LEGACY_ENABLE_MOTOR` is **also** defined (two separate, deliberate macros; nothing in the repository defines either). `MOTOR_OFF` always works. The `MOTOR_ON` TCP command is still *accepted and acknowledged* by this sketch's old code path but no longer energises anything by default.
* The sketch starts with a preprocessor `#error` unless `TORQVA_LEGACY_UNSAFE_ACKNOWLEDGED` is defined, so a plain Arduino-IDE compile/upload fails.
* No PlatformIO environment builds it (`esp32/torqva_fw/platformio.ini`); `backend/tests/test_torqva_p15_quarantine.py` checks both properties.
* This is a build-time speed bump, **not** a physical safeguard: anyone can define the macro. Retire the sketch or port its monitoring features to `esp32/torqva_fw`.

Supported firmware: `esp32/torqva_fw` (PlatformIO, `pio run -e esp32s3`). Status: `docs/TORQVA_HARDWARE_READINESS.md`.
