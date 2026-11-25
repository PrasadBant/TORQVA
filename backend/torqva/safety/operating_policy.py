"""Operating envelope and device-reported readiness for physical motion."""

from dataclasses import dataclass
from typing import Dict, List, Optional

from torqva.telemetry.device_state import DeviceModel

@dataclass
class PhysicalControlPolicy:
    """Physical START / speed commands require validated operating configuration and authenticated device session."""
    physical_control_enabled: bool = False
    max_duty_pct: Optional[float] = None
    max_rpm: Optional[float] = None


def describe_interlocks(bridge) -> List[Dict[str, str]]:
    """Every interlock for physical motion with an honest status: VERIFIED | BLOCKED | NOT VERIFIED | UNAVAILABLE.
    Hardware facts (E-stop circuit, reset-safe driver, watchdog on target) are NEVER 'VERIFIED' here: no software evidence can establish them, and not knowing of a failure is not verification."""
    m = bridge.model
    now = bridge._clock()
    snap = m.snapshot(now)
    hs = bool(snap["handshake"])
    st = m.status or {}
    blk = st.get("blk", "")
    V, B, N, U = "VERIFIED", "BLOCKED", "NOT VERIFIED", "UNAVAILABLE"
    sens = snap["sensor_status"]
    es = int((m.status or {}).get("es", 0))
    core = [sens.get(k, "unavailable") for k in ("current", "voltage", "housing", "rpm")]
    if not hs:
        sensors = (U, "no device handshake")
    elif all(x == "valid" for x in core):
        sensors = (V, "current, voltage, housing temperature and rpm are valid and fresh")
    else:
        sensors = (B, ", ".join(f"{k}: {sens.get(k, 'unavailable')}" for k in ("current", "voltage", "housing", "rpm") if sens.get(k) != "valid"))
    fault_ok = hs and st.get("state") != "EMERGENCY_STOP" and not st.get("fm")
    if bridge.commissioning is not None and not hasattr(bridge.commissioning, "status_of"):
        c_row = (V, "operating limits loaded") if bridge.policy.physical_control_enabled else (B, "operating configuration not active")
    elif bridge.commissioning is not None and bridge.commissioning.physical_control_enabled():
        c_row = (V, "validated operating configuration loaded automatically")
    else:
        c_row = (B, "operating configuration not enabled or invalid")
    sup_ok = bridge._hardware_control_enabled() and bridge.session_active() and bridge.limits_confirmed()
    rows = [
        ("identity", "Device identity verified", (U, "no device handshake") if not hs else (B, "identity mismatch") if m.identity == "mismatch" else (V, "device id matches the expected id") if m.identity == "verified" else (N, f"device id {st.get('dev')!r} is not provisioned/checked against an expected id")),
        ("handshake", "Handshake valid", (V, f"protocol {st.get('proto')}, firmware {st.get('fw')}") if hs else (U, "no valid status frame received")),
        ("telemetry", "Telemetry fresh", (V, "fast frames are arriving") if hs and snap["telemetry_fresh"] else (B if hs else U, "telemetry is stale" if hs else "no device")),
        ("sensors", "Sensors valid", sensors),
        ("limits", "Approved operating limits present", (U, "no device handshake") if not hs else (V, f"limits v{bridge.device_cfg_version()} validated and confirmed by the device over the authenticated session") if bridge.limits_confirmed() else (B, "operating limits queued for device confirmation" if (bridge.commissioning is not None and getattr(bridge.commissioning, "limits", None) is not None) else "no validated operating limits loaded")),
        ("session", "Authenticated session established", (V, f"mutual challenge-response with the per-device key; session {bridge._auth.get('sid')}, expires in {max(0, int(bridge._auth.get('expires', 0) - now))} s") if bridge.session_active() else (B, f"no authenticated session ({bridge._auth.get('state')}{': ' + bridge._auth['error'] if bridge._auth.get('error') else ''})" if bridge._device_key() is not None else "no provisioned key for this device")),
        ("supervisor", "Device operating envelope confirmed", (V, "operating envelope and interlocks satisfied") if sup_ok else (B, "waiting for validated device session and confirmed limits")),
        ("commissioning", "Operating configuration active", c_row),
        ("estop", "Emergency-stop circuit", (B, "emergency stop asserted") if blk == "ESTOP_ACTIVE" else (B, f"GPIO 15 monitoring reads {DeviceModel.ESTOP_LABELS[1]}") if es == 1 else (N, "no emergency stop currently reported; hardware E-stop wiring requires physical inspection")),
        ("driver", "Hardware driver reset-safe", (N, "output stage behavior during reset cannot be verified by software")),
        ("watchdog", "Hardware watchdog on target", (N, "on-chip watchdog trip recovery requires physical verification")),
        ("fault", "No active blocking fault", (U, "no device handshake") if not hs else (V, "no latched fault") if fault_ok else (B, f"latched: {st.get('reason')} (fault mask {st.get('fm')})")),
    ]
    return [{"id": i, "label": l, "status": v[0], "detail": v[1]} for i, l, v in rows]
