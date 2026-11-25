# TORQVA backend

FastAPI service mounted at `/api/torqva` (`main.py`). Every route needs a bearer token; with `TORQVA_TOKENS` unset the API refuses everything.

```powershell
pip install -r requirements.txt
python -m uvicorn main:app --host 127.0.0.1 --port 8000     # set TORQVA_TOKENS first; prefer `npm run dev:sim` from frontend/
python -m pytest -q                                          # never opens a serial port (conftest sets TORQVA_AUTOCONNECT=0)
```

## Module map

- `torqva/api/` exposes HTTP and WebSocket routes.
- `torqva/control/` validates and submits direct motor commands.
- `torqva/device/` owns the bridge, transport, protocol and firmware tooling.
- `torqva/telemetry/` tracks sensor values, freshness, history and event delivery.
- `torqva/safety/` owns operating configuration and reports device readiness.
- `torqva/access/` contains user authentication, role policy and device keys.
- `torqva/legacy/` keeps supervisor, proposal and workflow contracts.
- `torqva/analysis/`, `research/` and `simulation/` contain the diagnostic and experimental systems.
- `torqva/models/` and `shared/` hold shared records and persistence. `torqva/service.py` composes these packages.

`data/` contains local runtime state. `tests/` contains pytest, including integration checks for both transports and the firmware-in-the-loop executable.

[Direct command and telemetry path](../docs/architecture/CONTROL_ARCHITECTURE.md)
