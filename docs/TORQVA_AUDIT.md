# TORQVA — Phase 0 Audit

Audited: 2026-10-10. Source: the repo as found (snapshot commit `855f282`). Nothing was changed in code during the audit.

## 1. What exists

| Layer | Stack found | Size |
|---|---|---|
| Firmware | Arduino IDE sketch, single file `esp32/firmware/smart_motor_monitor/smart_motor_monitor.ino`, fw `2.0.0`. Libraries: Adafruit ADXL345/INA219/Unified Sensor, OneWire, DallasTemperature, U8g2 (SH1106), ArduinoJson, Preferences (NVS), WiFi | 614 lines |
| Backend | Python, FastAPI, Pydantic v2, raw `sqlite3`, asyncio TCP server (port 5001), WebSocket `/ws` | ~2,100 lines + 4 test files |
| Frontend | React 18 + Vite 5 (**JavaScript, not TypeScript**), Recharts, lucide-react, Vitest + Testing Library | ~3,300 lines |
| Transport | ESP32 Wi-Fi → TCP client → backend, 1 Hz newline-delimited JSON; backend → ESP32 plain-text `MOTOR_ON` / `MOTOR_OFF`, replies `*_ACK` | |
| Git | Not a repo when found. `git init` done locally in this session (branch `main` = snapshot, work on `torqva/*`) | |

## 2. Baseline check results (verbatim summaries)

| Check | Command | Result |
|---|---|---|
| Backend tests | `cd backend && python -m pytest -q` | **2 failed, 36 passed in 1.44s.** Failures: `tests/test_tcp_server.py::test_send_motor_command_disconnected[trio]` and `::test_send_motor_command_invalid[trio]` → `ModuleNotFoundError: No module named 'trio'`. Cause: the anyio pytest plugin parametrises over the `trio` backend and `trio` is not installed. Environment gap, not a logic failure. Not fixed (Phase 0 rule). |
| Frontend install | `cd frontend && npm ci` | Succeeded; `npm audit` reports vulnerabilities (not triaged). |
| Frontend tests | `npm test` | **24 passed (1 file).** Many React `act(...)` warnings from `BaselinePanel`. |
| Frontend build | `npm run build` | Built OK in 10.9 s. Warning: JS chunk 619.56 kB (> 500 kB). |
| Firmware build | — | **Not run.** No `arduino-cli` / PlatformIO on PATH. Arduino IDE 2 and the `esp32` core 3.3.8 are installed, but the sketchbook library folder (`~/Documents/Arduino/libraries`) does not exist, so the Adafruit / U8g2 / ArduinoJson / DallasTemperature libraries are not installed where this session can see them. Human task H-01 covers a compile in the IDE. |
| Lint / typecheck | — | No linter or typechecker is configured in either backend or frontend. |

## 3. Capability Matrix

Status: `exists` / `partial` / `missing` / `needs-hardware-work`.

| Capability | Status | Where | Plan |
|---|---|---|---|
| ADXL345 vibration | partial / needs-hardware-work | I2C (GPIO 4/5), `getEvent()` called once per `loop()`, rate not controlled or measured; "vibration" = mean of ‖a‖ − 9.81 per second (a magnitude offset, **not** RMS, no per-axis RMS/FFT) | Target is SPI, 3200 Hz FIFO bursts, per-axis features. Needs rewiring (Human task) + `vib_acq`/`features` tasks. Hardware-validate before trusting the numbers |
| DS18B20 housing temp | partial | GPIO 6, `getTempCByIndex(0)` is read *before* `requestTemperatures()` each loop (returns previous conversion; works but the loop spins far faster than the ~750 ms conversion, so samples are repeated and the 1 s "average" is mostly duplicates). Range check −50..150 only | Rework to timed 1 Hz conversion with CRC/bus-error checks |
| Ambient temperature | missing / needs-hardware-work | Second DS18B20 not bought/fitted | Human task; needed for temp-rise-over-ambient features |
| INA219 shunt range | partial | `Adafruit_INA219::begin()` defaults to the 32 V / 2 A calibration (0.1 Ω shunt, about ±3.2 A). Firmware reads `getCurrent_mA()` and `getBusVoltage_V()`; INA219 bus limit is 26 V | Swap to 0.05 Ω shunt + custom calibration (Human task + firmware). Current limit logic must account for the 3.2 A clip until then |
| BTS7960 control | partial | `setMotorState(bool)`: R_EN/L_EN HIGH, `analogWrite(RPWM, 200)` (78 % duty) **instantly**; LPWM LOW. No ramp, no variable speed, no duty cap, PWM frequency is the Arduino default (not 20 kHz) | Rewrite as PI speed controller behind a safety task, 20 kHz LEDC, soft-start, 70 % cap |
| BTS7960 IS current sense | missing | Not wired, not read | Human task (verify ≤ 3.3 V) + firmware read on ADC1 |
| Relay / E-stop path | missing / needs-hardware-work | No relay, no E-stop | Human task (Section 2.1 of the master prompt); highest-priority hardware item |
| EN pull-downs (motor off at boot) | missing / needs-hardware-work | No external pull-downs mentioned anywhere. Firmware sets pin modes only at `setup()` after USB/boot delay (`delay(1000)` first), so EN lines float until then | Human task: 10 kΩ pull-downs on R_EN/L_EN |
| Hall RPM | partial | GPIO 9, `INPUT_PULLUP`, FALLING ISR with 5 ms debounce, RPM from pulse **count over ~1 s** (1 pulse/rev assumed). Coarse at low RPM; `docs/HARDWARE_WIRING.md` says 3.3 V supply, the spec says A3144 needs ≥ 4.5 V | Move to pulse-period timing, 5 V supply + 10 kΩ pull-up (Human task) |
| PI speed control | missing | — | Build in `control` task |
| Telemetry transport & format | partial | TCP 1 Hz JSON, ~25 fields incl. duplicated names (`vibration`, `vibration_rms`, `status`/`hardware_condition`…). **No `seq`, no firmware-side quality flags, no `wiring_id`, no provenance** | New frame protocol (fast/vib/slow/status). USB-CDC JSON lines for P0 via serial bridge |
| Command / ack | partial | Plain text `MOTOR_ON` / `MOTOR_OFF`, ack strings. No id, TTL, sequence, idempotency, params; backend awaits ack with a 5 s timeout | Replace with typed command set `{id,type,params,ttl_ms,seq}` |
| Heartbeat / watchdog | partial | Only side effect: motor is turned off when Wi-Fi or TCP drops (good). No explicit heartbeat, no timing contract. Backend marks device STALE at 3 s / OFFLINE at 5 s | Heartbeat watchdog on device, 2 s in Hardware-control mode |
| Device hard limits | missing | Firmware has no current/temp/RPM/voltage/vibration trip. Existing thresholds live only in the backend (`config.py`) and only produce alerts, they do not stop the motor | Safety task + versioned limits in NVS |
| NVS usage | partial | Namespace `motor`: baseline temp/volt/curr/power/rpm/vib (read-only in the sketch; nothing writes it. The backend `/api/baseline/start` queues `START_BASELINE`, but the firmware never polls `/api/device/commands`, so the device-side baseline flow is **dead**) | Keep as fallback; add versioned limits + wiring ID |
| Backend | exists | FastAPI, SQLite tables `telemetry`, `baseline`, `alerts`; retention cleanup 24 h; connection state machine CONNECTED/STALE/OFFLINE; health engine = single-point baseline deviation → weighted 0–100 score | Extend. Keep health engine as the "existing thresholds" ablation baseline |
| Frontend | exists | Single-page dashboard (no router), Recharts, WebSocket client | Extend; see Decisions D-02 |
| C1 self-learning anomaly | missing | Health engine compares to **one** global baseline, ignores RPM | Phase 4 |
| C2 intervention prediction | missing | — | Phase 9 |
| C3 decision gate | missing | — | Phase 7 |
| C4 active diagnosis | missing | — | Phase 8 |
| C5 verified recovery | missing | — | Phase 10 |
| C6 outcome learning | missing | — | Phase 13 |
| Simulator | partial | `backend/demo_engine.py` (81 lines) posts synthetic telemetry tagged `source:"demo"`; no ground truth, no fault scenarios, no command/ack emulation | Replace/extend in Phase 6 (calibrated to real data) |
| Provenance | partial | `source` ∈ {`live`,`demo`} on telemetry and alerts. No MEASURED/DERIVED/PREDICTED/HUMAN_CONFIRMED | Add field-level provenance in new ingestion |
| Auth | missing | **No authentication anywhere.** `POST /api/motor` can start the motor for any client that can reach port 8000; CORS is `allow_origins=["*"]` with credentials; TCP port 5001 accepts any peer and any peer's text is trusted | Safety Supervisor + auth in Phase 2 (and see risk R-1) |
| Audit | missing | Alerts table is not an audit log; commands are not persisted (in-memory `command_queue`) | Append-only `AuditEvent` table |
| Tests | partial | Backend 38 tests (36 pass), frontend 24; no firmware tests; no safety, state-machine or replay tests | Per Section 15 |

## 4. Findings that matter before touching the motor

Ordered by consequence.

**R-1 — The current motor path has no safety layer.** `MOTOR_ON` from any TCP/HTTP client sets duty 200/255 (78 %) in one step, with no ramp, no current limit, no temperature or RPM trip, no authentication, and no hardware E-stop. The RS-775's inrush on a 3–5 A PSU can brown out or trip the supply. The master prompt's default cap is 70 %. **Recommendation: do not run the motor with firmware 2.0.0 beyond brief supervised tests until Phase 1 hardware (E-stop + EN pull-downs) is in place.** I have not changed this firmware and will not flash anything without your say-so.

**R-2 — Docs contradict the firmware.**
- `docs/HARDWARE_WIRING.md` states "the ESP32 does NOT drive PWM, relays, MOSFETs", uses a single I2C bus on GPIO 8/9, DS18B20 on GPIO 4, Hall on GPIO 5, HTTP ingestion, and Windows paths from another machine. The firmware has BTS7960 control, two I2C buses (GPIO 4/5 and 7/8), DS18B20 on GPIO 6, Hall on GPIO 9, and TCP.
- The README says "pin assignments strictly preserved from firmware" and matches the firmware. It also lists `backend/serial_bridge.py`, which **does not exist**.
- The wiring doc is therefore not safe to wire from. It is superseded by `docs/TORQVA_WIRING.md` (draft, awaiting your confirmation of what is physically connected). I have not deleted or edited the old file.

**R-3 — Dead code path.** Baseline start/cancel/reset commands are queued by the backend, but the firmware never fetches them (no HTTP poll in `loop()`; `HTTPClient` is included but unused). `/api/baseline/result` is only reachable by an external caller.

**R-4 — Vibration quantity is not RMS.** Firmware sends `mean(|‖a‖ − 9.81|)`, labelled `vibration_rms` and divided by 9.81 in one field and not the other (`vibration` is m/s², `vibration_rms` is g). Gravity-orientation errors and the ADXL345's offset bias leak straight in. Existing "baseline deviation %" values built on it are not comparable to proper RMS features.

**R-5 — Loop timing is unmanaged.** The main loop does I2C reads for three sensors as fast as it can, with Wi-Fi/TCP polling and OLED redraw once a second in the same thread. A blocking `tcpClient.connect()` can stall the loop, and with it the only code that could turn the motor off.

**R-6 — Pin plan compatibility (ESP32-S3 N16R8).** The existing map (GPIO 4–18) avoids the strapping pins (0, 3, 45, 46), USB pins (19/20) and the octal-PSRAM pins (35–37), so it is *valid* on this board. The master prompt's suggested map (SPI ADXL on 10–14, etc.) would require rewiring. See `docs/TORQVA_WIRING.md` §4 for the proposal.

## 5. Capability-gap rule applied

| Gap | Treatment |
|---|---|
| Backend/safety/learning software | Build minimal real versions (Phases 2–10) |
| E-stop/relay, pull-downs, shunt swap, ambient DS18B20, SPI rewire, IS wiring, 5 V Hall supply | Human tasks (progress file); software developed against a simulator meanwhile; related controls hidden in Hardware mode |
| Mega watchdog, Wi-Fi transport, LLM | Feature-flagged off / P1–P2 |
