# TORQVA — Architecture (software-first)

Status: firmware layer implemented and host-tested; backend modules below are the target structure (not yet built unless marked ✅).

## 1. Layers and the safety boundary

```
 Simulated motor / real ESP32                       (provenance: SIMULATED | MEASURED)
        │  JSON lines (USB-CDC / TCP)   fast · slow · status · ack
        ▼
 [1 Ingestion + validation] → [2 Motor state / operating point] → [3 C1 anomaly detection]
                                                                         │
                                                                         ▼
 [10 Cases · model versions · evaluation · rollback] ◄─ [9 C5 recovery] ◄ [4 hypotheses] → [5 confidence] → [C3 gate]
                                                                                         │          │
                                                  [8 command dispatch + ack tracking] ◄──┴─ [6 C2 predictions]
                                                                 ▲
                                                  [7 SAFETY SUPERVISOR  (deterministic, no ML, no LLM)]
                                                                 │
                                                       device firmware safety (final authority)
```

**Rule:** nothing downstream of the gate can reach the device except through the Safety Supervisor, and the device firmware re-validates everything. ML/LLM modules emit *proposals* (typed `ProposedAction`); they have no import path to the command dispatcher.

Safety layers (independent): hardware E-stop/relay (Phase 8) → device firmware (`torqva_core::SafetyMonitor`, ✅) → backend Safety Supervisor → UI (display only).

## 2. Firmware (✅ `esp32/torqva_fw`)

| Piece | File | Notes |
|---|---|---|
| Limits (versioned) | `lib/torqva_core/torqva_limits.h` | Defaults per master prompt; `max_rpm` / `vib_rms_stop_g` = 0 means "not commissioned" |
| Safety monitor | `safety.*` | Latching trips; reset needs authorized command **and** local button |
| Ramp / PI / drive | `control.*` | 30 %/s slew, 70 % cap, anti-windup, coast-only stop |
| Command validator | `commands.*` | Type/range/TTL/sequence/auth, idempotent, STOP never refused |
| Test executor | `testexec.*` | T1/T3/T4, on-device, aborts on trip/link loss, never goes faster |
| Protocol | `protocol.*` | JSON lines, allocation-free |
| Device | `device.*` | Composes the above; hardware-agnostic `HalIn`/`HalOut` |
| Simulated plant | `simplant.*` | Deterministic; **not calibrated**; fault knobs for tests |
| Hardware layer | `src/main.cpp`, `src/config_pins.h` | Compile-only; control disabled unless `-DTORQVA_CONTROL_ENABLED=1` |

### Wire protocol (v1)
Commands (host → device), one JSON object per line:
`{"id":7,"type":"SET_SPEED","p":1500,"p2":0,"p3":0,"ttl":5000,"age":0,"seq":12,"k":"<key>"}`

| type | p | p2 | p3 |
|---|---|---|---|
| HEARTBEAT, STOP, ABORT_TEST, REQUEST_RAW_BURST, RESET_ESTOP | – | – | – |
| SET_SPEED | rpm | | |
| START | open-loop duty % | | |
| RUN_TEST | test id (1,3,4) | T1 fraction / T3 duration_ms | T1 hold_ms |

Device → host: `ack` (`ACCEPTED|REJECTED|COMPLETED|ABORTED` + reason), `fast` (10 Hz), `slow` (1 Hz), `status` (1 Hz + on change). Frame fields: `seq`, `ts` (device ms), quality bitmask `q` (bit0 current, 1 voltage, 2 housing, 3 ambient, 4 rpm, 5 vibration; set = valid). `status` carries `fw`, `wiring`, `limits_v`, `state`, `reason`, `mode` (`SIM`/`HW`), `drive`, `ctl`, `hb_age`, `test`.

Semantics: duplicate `id` → original ack, never re-executed; `age` is stamped by the bridge (queue/transit time); STOP ignores key/TTL/seq.

Known protocol gap: authentication is a shared key field. Adequate for a USB-attached bench; a real MAC/nonce is needed before any network transport.

## 3. Backend modules (target)

New package `backend/torqva/`, alongside (not replacing) the existing `main.py`, `health_engine.py`, etc.

| Module | Responsibility |
|---|---|
| `schemas` | Pydantic models: Telemetry (with per-field provenance), Command, Ack, Hypothesis, Prediction, SafetyDecision, RecoveryAssessment, OutcomeLabel, ModelVersion |
| `provenance` | `MEASURED | DERIVED | PREDICTED | SIMULATED | HUMAN_CONFIRMED` enum; sim/real separation enforced at ingestion |
| `ingestion` | Parse frames, dedupe by `seq`, staleness, quality flags |
| `opstate` | Operating-point bins, steady-state detection, device-state mirror |
| `detection` (C1) | Per-bin robust Gaussian baselines (Mahalanobis, percentile thresholds), drift guard, versioned. **The control; unchanged.** |
| `c1_robust` (C1, Phase 8, opt-in) | `AdaptiveBaselineDetector` (bit-identical to `detection` unless a session reference is set), a validated / versioned / reversible `ReferenceRegistry` (per-session vibration gain + noise from a *human-attested* healthy warm-up; trained bins are never modified), and `assess_session` → HEALTHY / FAULT / **UNFAMILIAR**. Enabled by `PipelineConfig.adaptive_warmup_s > 0` plus `Orchestrator.attest_healthy_warmup()`; default off. The Safety Supervisor is untouched and a mandatory-stop condition still opens an incident while a warm-up is pending |
| `c1_study` | Phase 8 experiment harness (`python -m torqva.c1_study validate` / `final`): session-level splits, held-out regimes, per-session records |
| `hypotheses` | Prior × likelihood posterior over {imbalance, looseness, overload, cooling, supply, sensor fault} |
| `gate` (C3) | Ordered verdict rules; logs inputs |
| `diagnostics` (C4) | Test library + information-gain selection; execution through supervisor |
| `prediction` (C2) | Grey-box action-conditioned predictors, split-conformal intervals, risk |
| `supervisor` | Deterministic allow/reject/defer; mandatory-stop rules |
| `commands` | Dispatch, TTL, retries, ack tracking, idempotency, loss handling |
| `recovery` (C5) | Settle time + fresh-window criteria → RECOVERED / INCONCLUSIVE / UNRESOLVED / HUMAN_INSPECTION |
| `learning` (C6) | Eligible-case selection, candidate fit, promotion gate, rollback |
| `evaluation` | Reproducible scenario suite → `EvaluationRun` JSON |
| `audit` | Append-only events |
| `sim` | Python simulator with ground truth (mirrors firmware protocol) |

Persistence: SQLite (existing `data_storage.py` kept for legacy telemetry); new tables for sessions, incidents, decisions, commands/acks, predictions, outcomes, model versions, audit.

## 4. Invariants (each has/gets a test)
1. A proposal from C2/C3/LLM can only become a command through `supervisor.check()`.
2. Mandatory-stop conditions are evaluated before, and independent of, any model output.
3. A blocked, rejected, expired or aborted command is never recorded as an intervention outcome, and never counts toward C6.
4. `RECOVERED` requires a fresh post-ack window of VALID samples inside the learned band.
5. Simulated and measured data are never mixed in training or evaluation without separate reporting.
6. Learning cannot modify limits, envelopes or supervisor rules.
