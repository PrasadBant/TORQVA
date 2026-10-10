# TORQVA security, reliability and safety audit (Phase 13)

Scope: the software in this repository, in simulation. No hardware was operated and no firmware flashed. "Fixed" means a regression test fails without the change (mutation-checked for the dispatcher, supervisor and service changes).
Tests: `backend/tests/test_torqva_p13.py` (55 tests) and `frontend/src/tests/torqva_app.test.jsx` (out-of-order polling).

## Findings fixed in this phase

| # | Area | Finding (confirmed by reproduction) | Fix |
|---|---|---|---|
| 1 | Input validation | `POST /simulation/start` with a huge, negative or NaN `seed` raised a 500; raw `NaN`/`Infinity` JSON (accepted by Python's parser) made FastAPI's own 422 body unserialisable, so *any* validation error on a float field could become a 500. | Seeds bounded to `0..2^32-1`; non-finite floats refused (`allow_inf_nan=False`); `install_error_handlers()` returns location/message/type only. |
| 2 | Input validation | Lab payloads were unbounded: a 5 MB `settings` object, a 3 MB `notes` string, thousand-step profiles and 10^30 seeds were accepted and persisted. | Length and size limits (notes 4 000 chars, settings 40 keys / 8 KB, profile 50 steps, seeds bounded). |
| 3 | Concurrency | HTTP handlers run in a thread pool, but nothing serialised `start()`, `step()`, approve/reject/STOP/reset and the reads of the live orchestrator. | `SimulationService.lock` (re-entrant). `step()` takes it **per simulated second**, never for a whole run, so STOP is never queued behind a long step (test: a 300 s step with STOP hammered in parallel; worst STOP wait asserted < 1.5 s). |
| 4 | Dispatcher | A malformed ack id (`"abc"`, `null`, a list, 10^400) raised inside the control loop. | Malformed acks are ignored. |
| 5 | Dispatcher | A device ack of `PENDING` after `ACCEPTED` re-opened the command, so the next poll **re-sent** it; `TIMEOUT`/`EXPIRED` acks could force dispatcher-side states. | Dispatcher-side states cannot be set by an ack; duplicate acks are idempotent; an `ACCEPTED` command is never re-sent. |
| 6 | Supervisor | A NaN/infinite housing, current, voltage or vibration value compares False against every limit, i.e. read as "no limit crossed". | New mandatory-stop reason `measurement_not_finite`; no non-stop action is allowed while a reading is garbage; STOP is still always allowed. NaN speed/duty/fraction parameters were already rejected (now tested). |
| 7 | Legacy HTTP surface | `/api/baseline/start|cancel|reset` had no authorisation even when `TORQVA_TOKENS` was configured; `/api/ingest`, `/api/device/commands`, `/api/device/command-ack`, `/api/baseline/result` (which overwrites the saved baseline) had no credential. Validation ran before authentication, so unauthenticated callers received schema errors. | Baseline mutations require an operator once bearer auth is configured. New opt-in `TORQVA_DEVICE_KEY` (header `X-Device-Key`, constant-time compare) for device-originated routes. Both are FastAPI dependencies, so they run **before** body validation. A startup warning is logged when the device key is unset. |
| 8 | CORS | `allow_origins=["*"]` with `allow_credentials=True`. | Default origins are the local Vite dev server; `TORQVA_CORS_ORIGINS` overrides; wildcard ignored; credentials off; methods/headers restricted. |
| 9 | Frontend polling | Responses could arrive out of order (an older, slower response overwrote a newer one) and a slow simulation step let ticks pile up. | Request sequence guard (only the newest response is applied) and a single in-flight tick. Test mutation-checked. |
| 10 | Test environment | `@pytest.mark.anyio` parametrised the TCP-server tests over `asyncio` and `trio`; `trio` is not a dependency and the server is asyncio-only (`asyncio.get_running_loop`, `start_server`, `StreamWriter`). | `anyio_backend` fixture in `conftest.py` restricts those tests to `asyncio`. Not a suppressed failure: a trio run of asyncio-only code tests nothing real. Previously-failing tests now run and pass. |

## Verified, no change needed (covered by existing or new tests)

* Authentication fails closed (no tokens configured -> 503; malformed/forged headers -> 401); role matrix for operator/admin routes (403 and no state change); constant-time token comparison over SHA-256 digests; audit rows are append-only (SQL triggers) and baseline reference versions are immutable.
* STOP is allowed to every authenticated role and can only make the system safer; RESET_ESTOP needs admin and is refused while a physical limit is still crossed.
* Gate: untrusted C2, conflicted, uncorroborated and unfamiliar (OOD) evidence never yields ACT. C4 aborted tests produce no diagnosis (Phase 10/11 tests). C5 recovery needs fresh valid post-ack samples; prediction is never recovery. Attestation: immutable versions, compare-and-set revisions, audited atomic writes. LLM-sourced proposals are rejected by the supervisor.
* No secrets or `.env` files are tracked (`git ls-files` shows only `frontend/.env.example`; the firmware contains the placeholder `YOUR_WIFI_PASSWORD`).

## Residual risks (documented, not fixed here)

* **Legacy open mode.** With `TORQVA_TOKENS` / `TORQVA_DEVICE_KEY` unset the legacy routes keep their original open behaviour (the local legacy dashboard depends on it), including `/api/motor`. The TCP server listens on `0.0.0.0:5001` with no authentication. Both must be closed before any supervised hardware use (see `docs/TORQVA_HARDWARE_READINESS.md`).
* With `npm run dev` the backend is started with a token, so the **legacy dashboard's** baseline buttons return 401 there; use the TORQVA app (`/`) or run the backend without tokens for the legacy dashboard.
* The simulation passes `telemetry_age_s = 0` to the supervisor, so the staleness gate is exercised by unit tests only, not by the simulated pipeline.
* `/api/torqva/commands/stop` can be called repeatedly by any authenticated user (no rate limit); `/ws` is unauthenticated (legacy).
* The `SimulationService` is a single global simulation shared by all users; two operators will see and affect the same run.
* Operator attestation is a human judgement, not proof of physical health (unchanged).
