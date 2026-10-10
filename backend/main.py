"""
FastAPI Backend for Smart DC Motor Monitoring and Predictive Maintenance System (Phase 2).
Provides high-throughput telemetry ingestion, SQLite persistence, history time-series queries,
heartbeat state machine (CONNECTED -> STALE -> OFFLINE), and real-time WebSocket distribution.
"""

import asyncio
import time
import uuid
import logging
from typing import Dict, Any, List, Optional
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, status, Request, Query
from fastapi.middleware.cors import CORSMiddleware

from config import config, AppConfig
from models import (
    TelemetryPayload,
    DeviceStatus,
    ConnectionState,
    BaselineState,
    BaselineStatus,
    DeviceCommand,
    CommandType,
    CommandAck,
    HealthResult,
    HealthStatus,
    AlertRecord,
    IngestResponse,
    HistoryRecord,
    MotorControlRequest,
)
import json
from data_storage import DataStorage
from websocket_manager import ws_manager
from health_engine import health_engine
from demo_engine import demo_engine
from tcp_server import tcp_server

logger = logging.getLogger("motor_backend")

# System State Singletons
storage = DataStorage(db_path=config.db_path)

current_device_status = DeviceStatus(
    device_id=config.device_id_expected,
    firmware="1.0.0",
    connection_state=ConnectionState.OFFLINE
)

current_baseline_state = BaselineState(status=BaselineStatus.NOT_CONFIGURED)
latest_telemetry_cache: Optional[TelemetryPayload] = None
latest_live_telemetry_cache: Optional[TelemetryPayload] = None
latest_telemetry_dict: Optional[Dict[str, Any]] = None
command_queue: List[DeviceCommand] = []


def evaluate_connection_state() -> ConnectionState:
    """
    Evaluates current device heartbeat against configured stale and offline timeouts.
    State transitions: CONNECTED -> STALE -> OFFLINE.
    Broadcasts WebSocket events upon transition.
    """
    global current_device_status
    if current_device_status.last_seen is None:
        if current_device_status.connection_state != ConnectionState.OFFLINE:
            current_device_status.connection_state = ConnectionState.OFFLINE
        return ConnectionState.OFFLINE
    
    elapsed = time.time() - current_device_status.last_seen
    prev_state = current_device_status.connection_state

    if elapsed >= config.offline_timeout_seconds:
        new_state = ConnectionState.OFFLINE
    elif elapsed >= config.stale_timeout_seconds:
        new_state = ConnectionState.STALE
    else:
        new_state = ConnectionState.CONNECTED

    if new_state != prev_state:
        current_device_status.connection_state = new_state
        try:
            loop = asyncio.get_running_loop()
            loop.create_task(
                ws_manager.broadcast("connection", {
                    "device_id": current_device_status.device_id,
                    "status": new_state.value,
                    "last_seen": current_device_status.last_seen
                })
            )
        except RuntimeError:
            pass

    return new_state


async def connection_monitor_loop():
    """Background watchdog evaluating device freshness every 500ms."""
    while True:
        try:
            evaluate_connection_state()
        except Exception as e:
            logger.error(f"Error in connection monitor loop: {e}")
        await asyncio.sleep(0.5)


async def retention_cleanup_loop():
    """Periodic task cleaning up records exceeding the retention window."""
    while True:
        try:
            deleted_count = storage.cleanup_old_telemetry(config.history_retention_seconds)
            if deleted_count > 0:
                logger.info(f"Cleaned up {deleted_count} expired telemetry rows.")
        except Exception as e:
            logger.error(f"Error during telemetry retention cleanup: {e}")
        await asyncio.sleep(3600.0)  # Run hourly


async def handle_tcp_telemetry(payload_dict: Dict[str, Any], client_ip: str):
    """
    Ingests live TCP telemetry from ESP32-S3 over port 5001.
    Updates in-memory cache, evaluates health/alerts, saves to SQLite, and broadcasts over WebSocket.
    """
    global latest_telemetry_cache, latest_live_telemetry_cache, current_device_status

    server_now = time.time()
    payload_dict["server_received_at"] = server_now

    try:
        payload = TelemetryPayload(**payload_dict)
    except Exception as err:
        logger.warning(f"[TCP] TelemetryPayload validation warning: {err}")
        payload = TelemetryPayload(
            device_id=payload_dict.get("device_id", "ESP32-MOTOR-01"),
            timestamp=payload_dict.get("timestamp", server_now),
            motor_running=payload_dict.get("motor_running", False),
            temperature=payload_dict.get("temperature", 0.0),
            vibration_x=payload_dict.get("vibration_x", 0.0),
            vibration_y=payload_dict.get("vibration_y", 0.0),
            vibration_z=payload_dict.get("vibration_z", 0.0),
            vibration_rms=payload_dict.get("vibration_rms", payload_dict.get("vibration", 0.0)),
            rpm=payload_dict.get("rpm", 0.0),
            voltage=payload_dict.get("voltage", 0.0),
            current=payload_dict.get("current", 0.0),
            power=payload_dict.get("power", 0.0),
            source="live",
            hardware_condition=payload_dict.get("hardware_condition", payload_dict.get("status", "NORMAL")),
            hardware_reason=payload_dict.get("hardware_reason", payload_dict.get("reason", "")),
        )

    latest_telemetry_cache = payload
    latest_live_telemetry_cache = payload

    prev_state = current_device_status.connection_state
    if current_device_status.first_seen is None:
        current_device_status.first_seen = server_now

    current_device_status.device_id = payload.device_id
    current_device_status.ip_address = client_ip
    current_device_status.last_seen = server_now
    current_device_status.sensor_health = payload.sensor_health
    current_device_status.connection_state = ConnectionState.CONNECTED

    if prev_state != ConnectionState.CONNECTED:
        await ws_manager.broadcast("connection", {
            "device_id": current_device_status.device_id,
            "status": ConnectionState.CONNECTED.value,
            "last_seen": server_now
        })

    # Evaluate Health Engine Condition Assessment
    health = health_engine.evaluate(
        telemetry=payload,
        baseline=current_baseline_state,
        is_connected=True,
        config=config
    )

    # Persist to SQLite
    storage.save_telemetry(
        telemetry=payload,
        server_received_at=server_now,
        health_score=health.score,
        status=health.status.value
    )

    # Persist Active Alerts
    active_params = []
    for anom in health.anomalies:
        active_params.append(anom.sensor)
        alert_record = AlertRecord(
            timestamp=server_now,
            severity=anom.severity.value,
            parameter=anom.sensor,
            title=anom.sensor.replace("_", " ").title(),
            message=anom.message,
            current_value=anom.current,
            baseline_value=anom.baseline,
            suggested_inspection=anom.suggested_inspection,
            source=payload.source,
            status="ACTIVE"
        )
        storage.save_alert_with_deduplication(alert_record)

    storage.resolve_cleared_alerts(active_params, server_now, source=payload.source)

    # Terminal Log Output as specified in project prompt
    print("\nReceived:")
    print(json.dumps({
        "temperature": payload_dict.get("temperature"),
        "voltage": payload_dict.get("voltage"),
        "current": payload_dict.get("current"),
        "power": payload_dict.get("power"),
        "rpm": payload_dict.get("rpm"),
        "vibration": payload_dict.get("vibration", payload_dict.get("vibration_rms")),
        "condition": payload_dict.get("condition"),
        "status": payload_dict.get("status", payload_dict.get("hardware_condition")),
        "motor": payload_dict.get("motor"),
        "reason": payload_dict.get("reason", payload_dict.get("hardware_reason"))
    }, indent=2))
    print("Broadcasting sensor data to dashboard clients")

    # Combine model_dump with exact raw TCP fields for WebSocket clients
    broadcast_data = payload.model_dump()
    broadcast_data.update({
        "vibration": payload_dict.get("vibration", payload.vibration_rms),
        "condition": payload_dict.get("condition", 100.0 if payload.hardware_condition in ["NORMAL", "MOTOR OFF"] else 70.0),
        "status": payload_dict.get("status", payload.hardware_condition),
        "motor": payload_dict.get("motor", "RUNNING" if payload.motor_running else "OFF"),
        "reason": payload_dict.get("reason", payload.hardware_reason)
    })

    global latest_telemetry_dict
    latest_telemetry_dict = broadcast_data

    # Broadcast real-time events over WebSocket
    await ws_manager.broadcast("telemetry", broadcast_data)
    await ws_manager.broadcast("health", health.model_dump())


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Initializes persistent baseline calibration, TCP server, and background watchdogs."""
    saved_baseline = storage.get_latest_baseline()
    if saved_baseline:
        global current_baseline_state
        current_baseline_state = BaselineState(
            status=BaselineStatus.SAVED,
            temperature=saved_baseline["temperature"],
            vibration_rms=saved_baseline["vibration_rms"],
            voltage=saved_baseline["voltage"],
            current=saved_baseline["current"],
            power=saved_baseline["power"],
            rpm=saved_baseline["rpm"],
            saved_at=saved_baseline["saved_at"],
            samples=saved_baseline["samples"],
            duration_seconds=saved_baseline["duration_seconds"]
        )

    # Start ESP32 TCP Server on 0.0.0.0:5001
    tcp_task = asyncio.create_task(tcp_server.start(handle_tcp_telemetry))
    monitor_task = asyncio.create_task(connection_monitor_loop())
    cleanup_task = asyncio.create_task(retention_cleanup_loop())
    yield
    tcp_task.cancel()
    monitor_task.cancel()
    cleanup_task.cancel()


app = FastAPI(
    title="Smart DC Motor Monitoring & Predictive Maintenance API",
    description="High-Throughput Telemetry Ingestion, Anomaly Estimation, and WebSocket Diagnostic Streaming",
    version="2.0.0",
    lifespan=lifespan
)

# Enable CORS for React/Vite frontend development server
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ==========================================
# TORQVA (simulation-first intelligence layer). Fail closed: disabled until TORQVA_TOKENS is configured.
# ==========================================
try:
    from torqva.api import create_router as _torqva_router
    from torqva.auth import TokenAuth as _TokenAuth
    from torqva.service import SimulationService as _SimService
    try:
        _torqva_auth = _TokenAuth.from_env()
    except Exception as _e:          # malformed config must never open the API
        logger.error(f"TORQVA_TOKENS invalid ({_e}); TORQVA API stays disabled")
        _torqva_auth = _TokenAuth([])
    app.include_router(_torqva_router(_SimService(), _torqva_auth))
except ImportError as _e:             # numpy etc. missing: legacy monitor keeps working
    logger.warning(f"TORQVA layer not loaded: {_e}")
    _torqva_auth = None


def _require_operator_if_auth_configured(request: Request) -> None:
    """Opt-in hardening of the legacy motor endpoint: once TORQVA_TOKENS is set, motor control needs an operator token.
    With no tokens configured the legacy (unauthenticated) behaviour is unchanged."""
    if _torqva_auth is None or not _torqva_auth.configured:
        return
    h = request.headers.get("authorization", "")
    p = _torqva_auth.authenticate(h[7:].strip() if h.lower().startswith("bearer ") else None)
    if p is None:
        raise HTTPException(status_code=401, detail="motor control requires a bearer token", headers={"WWW-Authenticate": "Bearer"})
    if not p.at_least(__import__("torqva.schemas", fromlist=["Role"]).Role.OPERATOR):
        raise HTTPException(status_code=403, detail="motor control requires role operator")


# ==========================================
# REST API ENDPOINTS
# ==========================================

@app.get("/api/status", response_model=Dict[str, Any])
async def get_system_status():
    """Returns general backend status, device connection state, and active client count."""
    conn_state = evaluate_connection_state()
    return {
        "status": "ONLINE",
        "timestamp": time.time(),
        "device": current_device_status.model_dump(),
        "is_device_connected": (conn_state == ConnectionState.CONNECTED),
        "connection_state": conn_state.value,
        "websocket_subscribers": ws_manager.get_active_count(),
        "demo_mode": demo_engine.is_running
    }


@app.get("/api/sensors/latest", response_model=Optional[TelemetryPayload])
async def get_latest_sensors(source: Optional[str] = None):
    """
    Returns the newest validated sensor telemetry payload.
    Optionally filter by source ('live' or 'demo').
    """
    global latest_telemetry_cache, latest_live_telemetry_cache
    if source == "live":
        if latest_live_telemetry_cache is not None:
            return latest_live_telemetry_cache
        stored = storage.get_latest_telemetry(source="live")
        if stored and "payload" in stored:
            return TelemetryPayload(**stored["payload"])
        return None

    if latest_telemetry_cache is not None:
        if source is None or latest_telemetry_cache.source == source:
            return latest_telemetry_cache
    
    stored = storage.get_latest_telemetry(source=source)
    if stored and "payload" in stored:
        return TelemetryPayload(**stored["payload"])
    return None


@app.get("/api/history", response_model=List[HistoryRecord])
async def get_history(
    minutes: float = Query(default=5.0, ge=0.1, le=1440.0, description="Lookback window in minutes"),
    source: Optional[str] = Query(default=None, description="Optional filter by source ('live' or 'demo')"),
    limit: int = Query(default=5000, ge=1, le=10000, description="Maximum number of historical records to return")
):
    """
    Retrieves chronological historical telemetry records within the requested time range.
    Data is indexed and sorted chronologically (oldest to newest) for charting.
    """
    records = storage.get_history(minutes=minutes, source=source, limit=limit)
    return [HistoryRecord(**r) for r in records]


@app.get("/api/baseline", response_model=BaselineState)
async def get_baseline():
    """Returns the current motor baseline calibration state and reference metrics."""
    return current_baseline_state


@app.get("/api/health", response_model=HealthResult)
async def get_health():
    """Evaluates and returns the motor health score, condition factors, and non-definitive diagnostics."""
    is_connected = (evaluate_connection_state() == ConnectionState.CONNECTED)
    target_telemetry = latest_live_telemetry_cache if latest_live_telemetry_cache is not None else latest_telemetry_cache
    return health_engine.evaluate(
        telemetry=target_telemetry,
        baseline=current_baseline_state,
        is_connected=is_connected,
        config=config
    )


@app.get("/api/alerts", response_model=List[AlertRecord])
async def get_alerts(
    active_only: bool = Query(default=False, description="Filter for ACTIVE alerts only"),
    source: Optional[str] = Query(default=None, description="Filter by source ('live' or 'demo')"),
    limit: int = Query(default=100, ge=1, le=1000, description="Maximum alerts to return")
):
    """Retrieves logged anomaly alerts with optional active and source filtering."""
    alerts = storage.get_alerts(limit=limit, active_only=active_only, source=source)
    return [AlertRecord(**a) for a in alerts]


@app.get("/api/config", response_model=AppConfig)
async def get_config():
    """Returns current operational thresholds, health weights, and timeout configurations."""
    return config


@app.post("/api/ingest", response_model=IngestResponse)
async def ingest_telemetry(payload: TelemetryPayload, request: Request):
    """
    Ingests live telemetry from the ESP32-S3 or synthetic telemetry from Demo Simulator.
    Validates data, stamps server reception time, updates device state machine, computes health,
    stores to SQLite, and streams over WebSocket.
    """
    global latest_telemetry_cache, latest_live_telemetry_cache, current_device_status
    
    server_now = time.time()
    payload.server_received_at = server_now
    latest_telemetry_cache = payload
    if payload.source == "live" and payload.device_id == config.device_id_expected:
        latest_live_telemetry_cache = payload

    # Client IP capture
    client_ip = request.client.host if request.client else "unknown"

    # Evaluate Connection State Transition
    prev_state = current_device_status.connection_state
    if current_device_status.first_seen is None:
        current_device_status.first_seen = server_now

    current_device_status.device_id = payload.device_id
    current_device_status.firmware = payload.firmware
    current_device_status.ip_address = client_ip
    current_device_status.last_seen = server_now
    current_device_status.sensor_health = payload.sensor_health
    current_device_status.connection_state = ConnectionState.CONNECTED

    if prev_state != ConnectionState.CONNECTED:
        await ws_manager.broadcast("connection", {
            "device_id": current_device_status.device_id,
            "status": ConnectionState.CONNECTED.value,
            "last_seen": server_now
        })

    # Evaluate Health Engine Condition Assessment
    health = health_engine.evaluate(
        telemetry=payload,
        baseline=current_baseline_state,
        is_connected=True,
        config=config
    )
    
    # Persist to SQLite
    storage.save_telemetry(
        telemetry=payload,
        server_received_at=server_now,
        health_score=health.score,
        status=health.status.value
    )
    
    # Persist Deduplicated Active Alerts & Resolve Cleared Conditions
    active_params = []
    for anom in health.anomalies:
        active_params.append(anom.sensor)
        alert_record = AlertRecord(
            timestamp=server_now,
            severity=anom.severity.value,
            parameter=anom.sensor,
            title=anom.sensor.replace("_", " ").title(),
            message=anom.message,
            current_value=anom.current,
            baseline_value=anom.baseline,
            suggested_inspection=anom.suggested_inspection,
            source=payload.source,
            status="ACTIVE"
        )
        storage.save_alert_with_deduplication(alert_record)

    storage.resolve_cleared_alerts(active_params, server_now, source=payload.source)
    
    # Construct full telemetry dictionary for WebSocket clients
    broadcast_data = payload.model_dump()
    status_str = payload.hardware_condition or ("NORMAL" if payload.motor_running else "MOTOR OFF")
    reason_str = payload.hardware_reason or ("All parameters normal" if payload.motor_running else "Motor is not running")
    condition_val = 100.0 if status_str in ["NORMAL", "MOTOR OFF"] else 70.0

    broadcast_data.update({
        "vibration": payload.vibration_rms,
        "condition": condition_val,
        "status": status_str,
        "motor": "RUNNING" if payload.motor_running else "OFF",
        "reason": reason_str,
    })

    global latest_telemetry_dict
    latest_telemetry_dict = broadcast_data

    # Broadcast real-time events over WebSocket
    await ws_manager.broadcast("telemetry", broadcast_data)
    await ws_manager.broadcast("health", health.model_dump())

    # Count pending commands for device
    pending_count = len([cmd for cmd in command_queue if cmd.status == "PENDING"])

    return IngestResponse(
        accepted=True,
        device_id=payload.device_id,
        server_time=server_now,
        pending_commands=pending_count,
        message="Telemetry accepted"
    )


# ==========================================
# DEVICE COMMAND PROTOCOL & MOTOR CONTROL
# ==========================================

@app.post("/api/motor", response_model=Dict[str, Any])
async def control_motor(req: MotorControlRequest, request: Request):
    """
    Dispatches motor ON/OFF command to ESP32 over the existing TCP 5001 socket stream.
    Validates command, verifies active TCP connection, sends 'MOTOR_ON\n' or 'MOTOR_OFF\n',
    awaits ESP32 ACK, and broadcasts result over WebSocket.
    """
    _require_operator_if_auth_configured(request)
    cmd_clean = req.command.strip().upper()
    if cmd_clean in ["ON", "MOTOR_ON", "1"]:
        tcp_cmd = "MOTOR_ON"
    elif cmd_clean in ["OFF", "MOTOR_OFF", "0"]:
        tcp_cmd = "MOTOR_OFF"
    else:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid motor command '{req.command}'. Must be 'ON' or 'OFF'."
        )

    if current_device_status.connection_state != ConnectionState.CONNECTED or tcp_server.active_writer is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Motor command failed — ESP32 is not connected over TCP."
        )

    result = await tcp_server.send_motor_command(tcp_cmd, timeout=5.0)

    if not result.get("success"):
        await ws_manager.broadcast("motor_command", {
            "command": tcp_cmd,
            "success": False,
            "error": result.get("message", "Command failed")
        })
        raise HTTPException(
            status_code=status.HTTP_504_GATEWAY_TIMEOUT,
            detail=result.get("message", "Command execution failed or timed out")
        )

    await ws_manager.broadcast("motor_command", {
        "command": tcp_cmd,
        "success": True,
        "ack": result.get("ack"),
        "message": result.get("message")
    })

    return result

@app.get("/api/device/commands", response_model=List[DeviceCommand])
async def get_pending_commands(device_id: str = "ESP32-MOTOR-01"):
    """
    Polled by ESP32 to retrieve pending non-control commands (e.g. baseline triggers).
    Note: Motor ON/OFF control commands are strictly forbidden in this architecture.
    """
    pending = [cmd for cmd in command_queue if cmd.status == "PENDING"]
    for cmd in pending:
        cmd.status = "SENT"
    return pending


@app.post("/api/device/command-ack", response_model=Dict[str, Any])
async def acknowledge_command(ack: CommandAck):
    """Received from ESP32 to acknowledge execution of a previously dispatched command."""
    for cmd in command_queue:
        if cmd.command_id == ack.command_id:
            cmd.status = "ACKNOWLEDGED"
            break
    
    await ws_manager.broadcast("command_ack", ack.model_dump())
    return {"status": "SUCCESS", "command_id": ack.command_id}


# ==========================================
# BASELINE CALIBRATION ENDPOINTS
# ==========================================

@app.post("/api/baseline/start", response_model=Dict[str, Any])
async def start_baseline():
    """Initiates baseline data collection procedure by queuing a START_BASELINE command for the ESP32."""
    global current_baseline_state
    current_baseline_state.status = BaselineStatus.COLLECTING
    
    cmd = DeviceCommand(
        command_id=str(uuid.uuid4()),
        command=CommandType.START_BASELINE,
        parameters={"duration_seconds": 30.0},
        created_at=time.time(),
        status="PENDING"
    )
    command_queue.append(cmd)
    
    await ws_manager.broadcast("baseline", current_baseline_state.model_dump())
    return {"status": "STARTED", "command_id": cmd.command_id}


@app.post("/api/baseline/cancel", response_model=Dict[str, Any])
async def cancel_baseline():
    """Cancels active baseline calibration session."""
    global current_baseline_state
    current_baseline_state.status = BaselineStatus.NOT_CONFIGURED
    
    cmd = DeviceCommand(
        command_id=str(uuid.uuid4()),
        command=CommandType.CANCEL_BASELINE,
        created_at=time.time(),
        status="PENDING"
    )
    command_queue.append(cmd)
    
    await ws_manager.broadcast("baseline", current_baseline_state.model_dump())
    return {"status": "CANCELLED"}


@app.post("/api/baseline/reset", response_model=Dict[str, Any])
async def reset_baseline():
    """Resets saved baseline calibration back to default NOT_CONFIGURED state."""
    global current_baseline_state
    current_baseline_state = BaselineState(status=BaselineStatus.NOT_CONFIGURED)
    
    cmd = DeviceCommand(
        command_id=str(uuid.uuid4()),
        command=CommandType.RESET_BASELINE,
        created_at=time.time(),
        status="PENDING"
    )
    command_queue.append(cmd)
    
    await ws_manager.broadcast("baseline", current_baseline_state.model_dump())
    return {"status": "RESET"}


@app.post("/api/baseline/result", response_model=Dict[str, Any])
async def save_baseline_result(result: BaselineState):
    """
    Receives calculated baseline reference parameters from ESP32 or calibration runner,
    persists to SQLite, and updates baseline state to SAVED.
    """
    global current_baseline_state
    result.status = BaselineStatus.SAVED
    result.saved_at = time.time()
    current_baseline_state = result
    
    row_id = storage.save_baseline(result)
    await ws_manager.broadcast("baseline", current_baseline_state.model_dump())
    return {"status": "SAVED", "baseline_id": row_id}


# ==========================================
# WEBSOCKET REAL-TIME STREAMING
# ==========================================

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    """
    WebSocket endpoint for front-end real-time telemetry streaming and state change subscriptions.
    Broadcasts telemetry, health, baseline, and connection events.
    """
    await ws_manager.connect(websocket)
    try:
        # Send initial state synchronization snapshot to newly connected client
        conn_state = evaluate_connection_state()
        await websocket.send_json({
            "type": "connection",
            "data": {
                "device_id": current_device_status.device_id,
                "status": conn_state.value,
                "last_seen": current_device_status.last_seen
            }
        })
        await websocket.send_json({
            "type": "baseline",
            "data": current_baseline_state.model_dump()
        })
        if latest_telemetry_dict:
            await websocket.send_json({
                "type": "telemetry",
                "data": latest_telemetry_dict
            })
        elif latest_telemetry_cache:
            await websocket.send_json({
                "type": "telemetry",
                "data": latest_telemetry_cache.model_dump()
            })

        # Keep alive loop
        while True:
            data = await websocket.receive_text()
            if data == "ping":
                await websocket.send_text("pong")
    except WebSocketDisconnect:
        ws_manager.disconnect(websocket)
    except Exception as e:
        logger.warning(f"WebSocket client error ({e}), disconnecting.")
        ws_manager.disconnect(websocket)
