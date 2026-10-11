"""TORQVA backend entry point.

Serves only the TORQVA API (`/api/torqva/*`, including the read-only device WebSocket `/api/torqva/ws`). The earlier monitoring backend (unauthenticated `/api/ingest`,
`/api/motor`, device-command polling, the TCP 5001 telemetry server and its WebSocket) belonged to the retired standalone firmware and was removed.

Run:  python -m uvicorn main:app --host 127.0.0.1 --port 8000   (set TORQVA_TOKENS first: the API fails closed without tokens)
"""
import logging
import os
from contextlib import asynccontextmanager
from typing import Dict

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from torqva.api import create_router, install_error_handlers
from torqva.auth import TokenAuth
from torqva.service import SimulationService

logging.basicConfig(level=logging.INFO, format="%(levelname)s:%(name)s:%(message)s")
logger = logging.getLogger("torqva.main")

try:
    _auth = TokenAuth.from_env()
except Exception as _e:                      # malformed configuration must never open the API
    logger.error(f"TORQVA_TOKENS invalid ({_e}); the TORQVA API stays disabled")
    _auth = TokenAuth([])

_torqva_service = SimulationService()


def shutdown_torqva_bridge(reason: str = "backend shutdown") -> None:
    """Close the USB serial port (if one is open) so the OS releases it when the backend stops."""
    svc = _torqva_service
    if svc is None:
        return
    try:
        svc.bridge.disconnect(reason)
        ac = getattr(svc.bridge, "autoconnect", None)
        if ac is not None:
            ac.stop()
        if hasattr(svc, "stop_bg"):
            svc.stop_bg()
    except Exception as e:                   # shutdown must never raise
        logger.warning(f"serial bridge shutdown: {e}")


@asynccontextmanager
async def lifespan(app: FastAPI):
    yield
    shutdown_torqva_bridge()


app = FastAPI(title="TORQVA API", description="Motor monitoring, diagnostics and intervention platform", version="3.0.0", lifespan=lifespan)

# CORS: only the listed origins (default: the local Vite dev server). The API uses bearer tokens, not cookies, so credentials are not allowed cross-origin.
# Set TORQVA_CORS_ORIGINS="https://a.example,https://b.example" to change it; a wildcard is ignored on purpose.
_cors_origins = [o.strip() for o in os.environ.get("TORQVA_CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173").split(",") if o.strip() and o.strip() != "*"]
app.add_middleware(CORSMiddleware, allow_origins=_cors_origins, allow_credentials=False, allow_methods=["GET", "POST", "PUT"], allow_headers=["Authorization", "Content-Type"])

app.include_router(create_router(_torqva_service, _auth))
install_error_handlers(app)


@app.get("/api/health")
def health() -> Dict[str, str]:
    """Liveness only (no data, no device state)."""
    return {"status": "ok"}
