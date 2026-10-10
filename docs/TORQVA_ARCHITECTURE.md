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
| `attestation` (Phase 9) | Operator-authorised, audited healthy-warm-up attestation for the experimental adaptive C1: candidate state machine, deterministic eligibility checks, immutable reference versions, activation/rollback (section 5). No command path |
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

## 5. Phase 9 — trusted healthy-session attestation (experimental adaptive C1; simulation only)
Code: `backend/torqva/attestation.py` (logic), routes in `backend/torqva/api.py` (`/api/torqva/attestation/*`), UI `frontend/src/torqva/attestation.jsx` (tab "Attestation"), store primitives in `store.py` (`put_audited`, immutable `ref_versions`).

**What it is.** An operator-authorised, auditable way to approve a *recorded* warm-up of the running simulation as the source of a per-session reference for the opt-in adaptive C1 detector. Attestation records a named operator's judgment about recorded evidence. It is **not** proof that the motor is fault-free; the API, the stored records and the UI all say so, and a session never becomes trusted merely because it looks statistically normal. The shipped detector stays the default; the deterministic Safety Supervisor, the dispatcher and every command path are untouched (the module has no command path; a test asserts it does not reference them).

### 5.1 Candidate state machine
| State | Meaning | Entered by |
|---|---|---|
| `PENDING` | evidence captured but incomplete (fewer than 48 windows, warm-up still short) | system, at capture / refresh |
| `ELIGIBLE` | every deterministic check passed | system |
| `ATTESTED` | an operator approved the recorded evidence | **operator only**, with a reason and an explicit acknowledgement |
| `REJECTED` | not usable as a reference | system (a check failed, or the reference failed validation at attest time) or operator (reason required) |
| `EXPIRED` | evidence went stale before a decision | system: older than 300 simulated s, source session ended, or an incident / e-stop / mandatory-stop condition since capture |
| `REVOKED` | an attested candidate was withdrawn | operator (reason required) |

Allowed transitions: `PENDING → {ELIGIBLE, REJECTED, EXPIRED}`, `ELIGIBLE → {ATTESTED, REJECTED, EXPIRED}`, `ATTESTED → REVOKED`. `REJECTED`, `EXPIRED`, `REVOKED` are terminal (a new capture is a new candidate). `ATTESTED` is reachable only from `ELIGIBLE`.

### 5.2 Eligibility checks (fail closed: missing or unreadable evidence fails)
telemetry complete (≥ 48 windows) · valid and finite · contiguous (gap ≤ 1.5 s) · fresh (last window ≤ 3 s old) · steady operating point (≥ 90 % steady) · consistent speed (setpoint spread ≤ 1 %, RPM CV ≤ 3 %) · consistent environment (ambient σ ≤ 1 °C and in range, supply σ ≤ 0.25 V) · source session / model versions / live safety context recorded · no incident open or opened since the window started · no e-stop, mandatory-stop condition or mandatory stop in the interval · operating region inside the learned speed bins · **no suspected fault** (protected channels — current, duty, voltage, power, thermal residual — within 3σ, vibration channels coherent rather than channel-selective) · sensor envelope (gain 0.70–1.40, noise ≤ 3.5×, stationary: gradual drift fails here) · the candidate reference validates on a **held-out final 25 % of the same recording** (not used to fit it) and still flags a synthetic 1.6× 1x-amplitude fault. Checks can only remove eligibility. A common-mode shift (e.g. gain ×1.25) *is* eligible but carries an explicit warning that a sensor gain fault is indistinguishable from a healthy gain shift. The Phase 8 final test seeds are not importable here; no evaluation data is used.

### 5.3 Supervised warm-up hold (selective deferral; revised in the pre-push review)
**What can open an incident from NORMAL, and what the hold touches.** (1) the score trigger (`anom_run >= 1`) — *the only path the hold can affect*; (2) device e-stop, including heartbeat loss (`HEARTBEAT_LOST` latches the device, then `DEVICE_ESTOP`) — never deferred; (3) mandatory-stop conditions — never deferred (the hold path calls `mandatory_stop_reasons` and opens the incident at once); (4) invalid/missing sensor data does not open an incident from NORMAL in either case (unchanged). Communication loss reaches the pipeline as (2).

**Why a hold exists.** The live pipeline opens an incident within seconds on a healthy but gain-shifted motor, which would make exactly those sessions ineligible. An operator may start a hold (`POST /attestation/warmup/start`, reason required, <= 300 s, auto-expires, audited).

**What is deferred — and only that.** Anomaly detection keeps running during a hold (`Orchestrator._defer_or_release`). An anomalous window may be deferred in exactly two cases: (1) *too little evidence yet* — fewer than **8 steady scored windows** (`DEFER_MIN_SCORED`, enforced exactly and tested at 7 vs 8) or fewer than 3 anomalies in the 20-window lookback; (2) the deviation is fully explained by a bounded, stationary common-mode vibration gain and/or noise estimate from the session itself (`explained_by_session_gain_or_noise`: gain 0.70-1.40, noise <= 3.5x, protected channels clean). **Everything else releases the hold at once** and the score opens the incident exactly as without a hold: any fault verdict (channel-selective or protected-channel deviation — every ordinary fault) and every *uncertain* verdict (gain or noise outside the envelope, non-stationary, unknown operating region).

**A coherent shift is not assumed healthy.** A deferral under case (2) is an **escalation**: the first one records `c1_unfamiliar_regime` ("NOT confirmed healthy; human review required"), `hold_info.regime_escalation` is set (`GET /attestation/warmup`), and the UI shows a standing "Unfamiliar regime — human review required" alert. Deferral is **capped at 180 deferred windows per hold** (`DEFER_MAX_WINDOWS`, below the 300 s hold maximum); at the cap the hold is released with `deferral_limit_reached` and normal (control) incident reporting resumes. A hold also ends by itself at its own limit. Because sim time advances only when stepped, an operator can pause the run while reviewing evidence.

Measured in simulation: imbalance, looseness, overload and sensor-fault at severity 0.5 open an incident **3 s** after injection (also with a +20 % gain shift on top; imbalance at severity 0.1 included); a +25 % gain shift is deferred and escalated and releases at the cap; gain 1.6 or 0.55 (outside the envelope) opens an incident at once; a gradual drift 1.0→1.35 is escalated and capped; heartbeat loss and mandatory stops open an incident immediately; a timed-out hold restores normal detection. Every deferral is counted, logged (`c1_hold_deferred`, at most every 10 s) and visible; none is silent.

**Residual risk (documented, not removed).** (a) A real fault that is itself coherent across all vibration channels and indistinguishable from a bounded gain/noise shift is deferred, and escalated, for up to 180 windows; (b) fewer than 8 steady windows (hold started during start-up) defers the first anomalies for that long; (c) the lookback stationarity tolerance is looser (0.12) than the full-warm-up attestation check (0.06), so a slow drift is escalated and capped rather than released early (the attestation checks reject it); (d) a hold cannot start while an incident is open. The Safety Supervisor, dispatcher and every command path are unchanged; the hold only changes whether an *anomaly score* alone opens an incident.

### 5.4 Authorisation (server-side, no second auth system)
Existing bearer-token roles. Reads (`GET …/candidates`, `…/references`, `…/events`, `…/warmup`): viewer. Every mutation (capture, refresh, attest, reject, revoke, activate, roll back, hold start/end): **operator or admin** — enforced by the route dependency *and again inside `AttestationService`* (defence in depth). No token → 401, no tokens configured → 503, insufficient role → 403 and a `denied` audit row. STOP remains available to any authenticated user. A decision needs `expected_rev` (compare-and-set): a stale or concurrent decision gets 409; repeated attest/reject/revoke gets 409.

### 5.5 Audit schema
Every state change is committed in **one transaction** with its audit row (`Store.put_audited`); if the audit write fails the change is rolled back and the API answers 500 "no change was made" (tested). Audit `kind = "attestation"`, `actor` = authenticated user, `detail` = `{event, candidate, from_state, to_state, reason, role, session, evidence_hash, versions{detector_class, detector_version, hypothesis_model, attestation_config, scenario}, sim_t, reference_version, operator_judgment_only: true, …}`. Events: `candidate_captured`, `candidate_evaluated`, `candidate_refreshed`, `expired`, `attested`, `rejected`, `revoked`, `attest_blocked_by_validation`, `reference_activated`, `reference_rolled_back`, `warmup_hold_started/ended`. The candidate document also keeps its own revisioned history; the evidence (windows) is stored with a SHA-256 hash that is re-verified at attestation.

### 5.6 Baseline integrity, promotion and rollback
* A reference version is an **immutable** row (`ref_versions`; DB triggers abort UPDATE/DELETE) created only at attestation, with the fitted gain/noise, the hold-out validation, the detector version and the evidence hash. There is no edit route.
* The trained bins are never modified. Activation (`POST …/references/{v}/activate`, reason required) only swaps `det.reference` of the **running session that recorded the evidence**; it requires status `VALIDATED` and an `ATTESTED` candidate. Activation and rollback are audited and persisted as an active stack (`reference_state`).
* `POST …/references/rollback` pops to the previous known-good reference, or to the unadapted trained baseline. Revoking an attested candidate removes its reference from the stack (deactivating it if active); a revoked candidate can never be activated again.

### 5.7 Limitations
Simulation only; no hardware evidence. A reference applies to one session (no cross-session reuse). A wrongly attested warm-up that is coherent across channels and inside the envelope can still be absorbed — the checks cannot see a fault that looks like a healthy shift. The hold can defer a fault that mimics a healthy gain/noise shift by up to its length (section 5.3). Attestation is a single-operator decision (no two-person rule). Expiry is lazy (evaluated on read/decision). The UI was verified by component tests and a production build, not by a real-browser inspection in this phase.
