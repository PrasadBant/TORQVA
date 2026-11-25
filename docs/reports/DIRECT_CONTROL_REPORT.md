# TORQVA direct manual control report

## Original architecture and findings

The React physical overview and diagnostics called FastAPI, which sent JSON commands through `DeviceBridge`. USB used `SerialTransport`. Wi-Fi used the device-initiated TLS WebSocket and `WsTransport`. Both fed the same firmware parser, per-device session, validator and motor loop. Status, sensor frames and acknowledgements came back through the bridge. Simulation and the C1–C6 workflows use a separate service path.

Normal motion was restricted to administrators in both the API and bridge. The bridge ran manual commands through the proposal supervisor. The physical dashboard substituted zeros on STOP, treated a submitted STOP as proof of stopped motion, and displayed an auto-stop countdown for a duration the device protocol did not enforce. Dormant bridge branches could synthesize readings. The worktree lacked two interlock sources still required by firmware and tests. An on-device diagnostic abort could also issue one more speed setpoint after STOP.

## Direct command trace

Every normal motion command uses `MotionPanel → api.deviceCommand → POST /api/torqva/device/commands → DeviceBridge → selected transport → Device::on_line → CommandValidator → Device::execute`. The firmware control loop passes the resulting duty and enable state to the ESP32 board driver code. The driver code writes RPWM with LEDC, holds LPWM low, and controls the enable and relay outputs. The bridge correlates the returned acknowledgement with the original command ID.

| Website control | API and wire command | Firmware effect | Device evidence presented |
| --- | --- | --- | --- |
| START | `START` with duty percentage in `p` | Start open-loop drive and slew toward duty | Acceptance, drive mode, requested and applied PWM |
| STOP MOTOR | `STOP` | Cancel firmware diagnostic, reset duty, disable drive and coast | Acceptance/completion and reported stop cause or separately reported fault |
| Set requested RPM | `SET_SPEED` with RPM in `p` | Change speed target, or exit drive on zero | Acceptance, requested RPM and independent Hall RPM |
| Apply PWM | `SET_PWM` with duty percentage in `p` | Change an active drive to the requested open-loop duty | Completion of setpoint update, requested and ramped PWM |
| Apply ramp rates | `SET_RAMP` with up/down values in `p` and `p2` | Update both slew rates used in the motor loop within the configured cap | Completion of settings update and active rates |
| Direction | Forward-only indicator | LPWM remains low in the current profile | Hardware profile direction |

The physical overview is the direct control entry point. An authenticated operator can submit normal motion commands immediately once the device prerequisites are met. The per-command administrator check and proposal supervisor are removed from that path. Viewers retain STOP access. Serial port setup and emergency fault reset remain administrative operations. Optional backend diagnostic steps are invalidated when a manual command intervenes or the device session changes. On-device diagnostics give way to manual motion and STOP. Fault reset requires the existing authorized request and local reset input. The bridge no longer sends a reset request automatically on a heartbeat fault.

## Communication and telemetry

The bridge orders motion writes with its authenticated heartbeat and records missing transports or write errors. The Wi-Fi transport reserves space before accepting the write so queue saturation reports a failure. Commands are never replayed after reconnect. WebSocket command events update the browser's command history, with REST fallback. Shaft motion is established through valid Hall data or physical observation. Requested setpoints, output duty reported by firmware, and Hall readings are displayed independently.

The physical dashboard distinguishes the browser's backend stream, ESP32 handshake/transport, telemetry staleness, drive state and fault reason. Legacy frames without the new optional fields show unavailable values. A Hall input with no usable pulse timing reports RPM feedback unavailable. Voltage, current and temperature remain subject to the firmware's validity flags and freshness. Diagnostic test output in the device endpoint now preserves missing observations and returns the actual command state.

## Hardware protections and limitations

The ESP32 start interlocks and safety monitor remain in the control path. They enforce initialization, operating limits, secured sessions, the installed E-stop circuit, watchdog, critical sensor and supply checks, heartbeat freshness, current and temperature trips, and latched fault handling. Operator STOP and fault shutdown immediately disable the driver and coast. Ramp down slews PWM during an ordinary setpoint reduction. It does not impose active braking or a guaranteed shaft deceleration. Runtime ramp settings reset on a new firmware operating configuration or reboot.

The production profiles use a feedforward RPM map with Hall feedback for measurement. Verified closed-loop regulation requires tuning and validation with the real motor. Reverse is unavailable with the current unidirectional wiring and firmware. The configured RPM ceiling constrains requests. An independent overspeed shutdown and a driver hardware fault signal have not been verified for this rig. Applied PWM represents the firmware output setting. A pin-level measurement is required to verify BTS7960 switching. Some legacy physical workflow analysis still uses estimated values outside the manual control dashboard.

## Changed files

- Frontend - `physical.jsx` for controls and state, `device.jsx` for events and stream rate, and `torqva_physical.test.jsx` for operator and stale-telemetry coverage.
- Backend - `device_routes.py`, `serial_bridge.py`, `device_link.py`, and `workflow.py` for API authorization, transport, acknowledgement, telemetry and diagnostic priority.
- Firmware - `commands.*`, `control.*`, `device.*`, `protocol.*`, and `testexec.h`, plus Hall acquisition in `src/main.cpp`. Restored the original `interlock.h` and `interlock.cpp` from the repository revision.
- Tests - updated backend access, supply validity and wire-contract assertions, native device tests that check PWM ramp output and STOP during an on-device test, and browser test selectors for Hardware Manager.
- Documentation - `README.md` and this report.

## Verification and physical acceptance

| Verification level | Result |
| --- | --- |
| Code | Traced each command to the firmware handler, output calculation and returning telemetry. |
| Frontend build | Vite production build passed. Vite reported its large-chunk warning for the 3D viewport. |
| Firmware build | USB CDC, UART, wireless ESP32-S3, and native firmware-in-the-loop profiles all built. |
| Automated frontend tests | 285 passed. |
| Automated backend and integration tests | 795 passed. The final transport-focused rerun passed 63. |
| Native firmware tests | 168 passed, including asymmetric PWM ramping, STOP priority and protection cases. |
| Browser and simulation | All ten Playwright scripts passed against software-only servers. Coverage includes the app, routing, Digital Twin, workbench, workflow, Lab, C2/C4, sign-in and simulator flow, attestation, and firmware upload validation with an ephemeral test signature. |
| Physical ESP32 and motor | Pending. The serial inventory did not identify a TORQVA board. Firmware flashing, electrical measurements, and powered motor tests remain pending. |

Before commissioning, verify both transports, driver enable and disable behavior, live RPM and PWM changes, asymmetric ramps, Hall agreement against a tachometer, independent E-stop, supply/sensor faults, and communication-loss shutdown with no automatic restart.
