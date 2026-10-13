# TORQVA backend

FastAPI service mounted at `/api/torqva` (`main.py`). Every route needs a bearer token; with `TORQVA_TOKENS` unset the API refuses everything.

```powershell
pip install -r requirements.txt
python -m uvicorn main:app --host 127.0.0.1 --port 8000     # set TORQVA_TOKENS first; prefer `npm run dev:sim` from frontend/
python -m pytest -q                                          # never opens a serial port (conftest sets TORQVA_AUTOCONNECT=0)
```

## Module map

`torqva/` is a single flat Python package: modules import each other as `torqva.<module>` / `from .<module>`, the tests import them the same way, and the
study modules locate `docs/eval/` relative to this folder. It is kept flat on purpose so that none of those paths (in particular the safety-critical
ones) change. Find a module by its responsibility:

| Responsibility | Modules |
|---|---|
| **HTTP API and app wiring** | `api.py` (routes), `device_routes.py` (USB device routes + WebSocket), `auth.py` (tokens and roles), `service.py` (owns the simulator, orchestrator and device bridge), `schemas.py` (shared enums and records), `store.py` (SQLite document store) |
| **Physical device and safety** ⚠ | `serial_bridge.py` (USB serial link, command lifecycle, interlocks), `supervisor.py` (deterministic Safety Supervisor), `dispatch.py` (only supervisor-minted actions are sent), `commissioning.py` (human commissioning record and approved limits), `autoconnect.py`, `device_keys.py`, `device_protocol.py`, `device_transport.py`, `physical_adapter.py` (what analysis may say about physical data) |
| **AI pipeline (C1–C6)** | `pipeline.py` (orchestrator), `detection.py` (C1), `hypotheses.py`, `gate.py` (C3), `diagnostics.py` (C4), `prediction.py` (C2), `recovery.py` (C5), `learning.py` (C6), `incident.py` (incident state machine), `attestation.py` (healthy-reference attestation) |
| **Simulation** | `sim.py` (motor simulator with ground truth), `simdevice.py` (simulator behind the device protocol), `scenarios.py`, `lab.py` (recording sessions and experiments) |
| **Research and evaluation (simulation only)** | `evaluation.py` (`python -m torqva.evaluation`), `c1_robust.py`, `c1_study.py`, `c2_robust.py`, `c2_conditional.py`, `c2c4_study.py`, `c2cov_study.py`, `c4_robust.py`, `c4cal_study.py`, `generalization_study.py` — some are also imported at runtime (`api.py` serves `c2c4_study` results, `pipeline.py` uses `c1_robust`) |

⚠ Changes to the physical-device and safety modules need the corresponding `tests/test_torqva_p1*`–`p29*` and `test_torqva_safety.py` suites; never test them against a connected board.

## Other folders

| Path | Purpose |
|---|---|
| `tests/` | pytest suite (`conftest.py` builds the shared simulation stack). Test files are numbered by project phase (`p11`…`p29`) |
| `tools/provision_device_key.py` | Provisions the per-device session key (writes `data/device_keys.json`) |
| `data/` | Local runtime data, not committed: `commissioning.json`, `device_keys.json` (git-ignored) |
