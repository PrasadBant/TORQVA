# TORQVA — Progress

## Phase status
| Phase | Status |
|---|---|
| 0 Audit | **done** (2026-10-10): audit, wiring draft, baseline results written. Awaiting human review of Decisions + H-tasks |
| 1 Hardware safety & firmware core | **in progress**: host-tested core logic done (limits, safety monitor, ramp/PI/drive, command validator, test executor; 40/40 native tests pass). Not yet done: Arduino/hardware app layer (`src/main.cpp`), frames, NVS limits, device build. Nothing flashed |
| 2–15 | not started |

## Current checklist (Phase 1 prep)
- [x] Audit, capability matrix, baseline run
- [x] `git init`, snapshot commit `855f282`, branch `torqva/phase-0-audit`
- [ ] Human answers D-03 (pin map option) and confirms what is physically wired today
- [x] D-01 resolved: PlatformIO approved; D-03 resolved: Option B
- [x] Core logic as host-testable library `esp32/torqva_fw/lib/torqva_core` + 40 unit tests (`pio test -e native`)
- [ ] Device layer `src/main.cpp`: FreeRTOS tasks (safety/control/rpm/slow sensors/comms), EN/relay GPIO, 20 kHz LEDC PWM, NVS limits, JSON-lines frames over USB-CDC, command dispatch
- [ ] `pio run -e esp32s3` compile check (no flash)
- [ ] Human: H-01 is now replaced by the PlatformIO compile (I will run it); H-03..H-09 still needed before motor tests

## Human tasks
Never assume done until you confirm.

- [ ] **H-01 Compile check.** In Arduino IDE (ESP32S3 Dev Module, esp32 core 3.3.8) install: Adafruit ADXL345, Adafruit INA219, Adafruit Unified Sensor, OneWire, DallasTemperature, U8g2, ArduinoJson. Compile `smart_motor_monitor.ino` and paste the result (or error). *Verification:* "Done uploading"-free compile success message. (I only need a compile, not a flash.)
- [ ] **H-02 Treat firmware 2.0.0 as unsafe.** Until H-03..H-06 are done, do not run the motor from the dashboard unattended; keep a hand on the PSU switch. Reason: Audit R-1.
- [ ] **H-03 EN pull-downs.** 10 kΩ from BTS7960 R_EN and from L_EN to GND. *Verify:* unplug the ESP32 USB with PSU on → motor must stay off; multimeter reads ~0 V on EN pins.
- [ ] **H-04 Relay + latching E-stop** in series with motor +24 V; relay coil fed through E-stop; 1N4007 across coil. *Verify:* with motor spinning at low duty, pressing E-stop cuts power with the ESP32 running AND with the ESP32 unplugged. Check relay contact rating ≥ 6 A DC at 24 V.
- [ ] **H-05 INA219 shunt swap to 0.05 Ω** (≥ 1 W) and place after the bulk capacitor; add ≥ 470 µF / ≥ 35 V electrolytic at BTS7960 input; SS34 on the 24 V input. *Verify:* with a known load, compare INA219 reading to a clamp/multimeter reading.
- [ ] **H-06 BTS7960 IS pins.** Measure R_IS/L_IS voltage at the highest allowed duty with a multimeter: must be ≤ 3.3 V before connecting to GPIO 1/2; add a divider if not.
- [ ] **H-07 Buy/fit second DS18B20** (ambient) on the 1-wire bus; 4.7 kΩ pull-up.
- [ ] **H-08 Hall supply:** power A3144 from 5 V, 10 kΩ pull-up to 3.3 V on the output, 1 kΩ + 1 nF filter. *Verify:* output swings 0 ↔ 3.3 V (not 5 V) on a multimeter/scope.
- [ ] **H-09 Guard around the disc;** safety glasses; magnet epoxied.
- [ ] **H-10 Tell me the real PSU model/current limit and whether it has a voltage trim** (decides whether the supply-voltage fault is real or sim-only).

## Decisions
| ID | Decision | Rationale |
|---|---|---|
| D-01 | **PlatformIO approved** by the human. New project in `esp32/torqva_fw/`; legacy Arduino sketch in `esp32/firmware/` left untouched. | Headless build + host unit tests. |
| D-02 | **Keep the existing backend and frontend stack** (FastAPI/SQLite/pydantic; React+JS+Vite+Recharts). Add modules beside it. Not migrating to SQLModel/Alembic/TypeScript/uPlot/TanStack yet. | §0.3: replacing frameworks needs approval. Adding TypeScript/uPlot/TanStack Query later counts as heavy dependencies → will ask in Phase 3. |
| D-03 | **Option B** chosen by the human (keep legacy pins, change only what safety needs). | Avoids a full rewire. |
| D-07 | Header named `torqva_limits.h`, not `limits.h` (collided with the system header). Limit defaults: ramp 30 %/s, max duty 70 %, 4 A/2 s, 5 A instant (**assumed PSU limit, see H-10**), temp 50/60 °C, 20–25.5 V, heartbeat 2 s, RPM-loss 1 s. `max_rpm` and `vib_rms_stop_g` default to 0 = not commissioned: SET_SPEED and all RUN_TESTs are refused until you set them. | Fail-safe defaults. |
| D-08 | STOP bypasses auth/TTL/sequence checks and is never refused; RESET_ESTOP needs authorized command AND local button; abort of a test holds the current (lower) speed, never returns to the faster one. | Safety properties, covered by tests. |
| D-04 | Existing `health_engine` thresholds stay as the "(a) existing thresholds" arm of the ablation ladder and are not modified. | Needed for honest comparison. |
| D-05 | Old `docs/HARDWARE_WIRING.md` left untouched but marked superseded in the audit; I did not delete it. | §0.3: no deleting existing files without asking. |
| D-06 | Local git repo created (not a repo when found). No remote, no push. | Section 18. |

## Known gaps / risks
- No firmware build verified in this environment (no CLI toolchain / libraries).
- 2 backend tests fail only because `trio` isn't installed (anyio param). Fix = `pip install trio` or restrict anyio backend to asyncio; not touched yet.
- No auth on any endpoint; firmware 2.0.0 has no safety layer (Audit R-1).
- Old wiring doc is contradictory (Audit R-2).

## Open design gaps (core logic)
- `Command.authorized` is a flag set by the comms layer; the real auth mechanism (token/HMAC) is not designed yet (Phase 2).
- `age_ms` TTL relies on the serial bridge stamping queue age; the device cannot detect transit delay itself.
- No current-limit foldback; trip only. Over-current thresholds are tied to the INA219 range (H-05 shunt swap).

## Next step
1. Me: write `src/main.cpp` device layer + `docs/TORQVA_ARCHITECTURE.md` (frame/command schema), then `pio run -e esp32s3` (compile only). Will not flash.
2. You: H-10 (PSU model/current limit, voltage trim?) and which of H-03..H-09 are physically done; approve before any flash.
