"""JSON-lines protocol shared by USB and Wi-Fi."""

import json
import math
import re
from typing import Any, Dict

MAX_LINE = 512
WIRE_PROTOCOL = 1
OTA_STATES = {"IDLE", "REFUSED", "AUTHORIZED", "PREPARING", "WIFI", "MANIFEST", "DOWNLOADING", "VERIFYING", "READY", "REBOOTING", "SELF_TEST", "CONFIRMED", "ROLLBACK", "FAILED"}
Q_BITS = {"current": 1, "voltage": 2, "housing": 4, "ambient": 8, "rpm": 16, "vibration": 32}
UINT32 = 2 ** 32 - 1

def escape_sample(raw: bytes, limit: int = 120) -> str:
    """Printable, truncated rendering of a rejected line so an operator can recognise what the device is actually sending. Never parsed, never trusted."""
    return "".join(chr(b) if 32 <= b < 127 else "." for b in bytes(raw)[:limit]) + ("…" if len(raw) > limit else "")


class FrameError(Exception):
    def __init__(self, code: str, detail: str = ""):
        super().__init__(f"{code}: {detail}" if detail else code)
        self.code = code


# --------------------------------------------------------------------------------------------------------------- parsing and validation
def _const(name):
    raise FrameError("NON_FINITE_NUMBER", name)


def _num(o: Dict[str, Any], k: str, lo: float, hi: float) -> float:
    v = o.get(k)
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        raise FrameError("BAD_FIELD", k)
    if not math.isfinite(v):
        raise FrameError("NON_FINITE_NUMBER", k)
    if not (lo <= v <= hi):
        raise FrameError("OUT_OF_RANGE", k)
    return float(v)


def _uint(o: Dict[str, Any], k: str, hi: int = UINT32) -> int:
    v = o.get(k)
    if isinstance(v, bool) or not isinstance(v, int) or not (0 <= v <= hi):
        raise FrameError("BAD_FIELD", k)
    return v


def _str(o: Dict[str, Any], k: str, maxlen: int = 64, allow_empty: bool = True) -> str:
    v = o.get(k)
    if not isinstance(v, str) or len(v) > maxlen or (not allow_empty and not v):
        raise FrameError("BAD_FIELD", k)
    return v


def _hex(o: Dict[str, Any], k: str, n: int) -> str:
    v = o.get(k)
    if not isinstance(v, str) or len(v) != n or not re.fullmatch(r"[0-9a-f]+", v):
        raise FrameError("BAD_FIELD", k)
    return v


def parse_frame(line: "bytes | str") -> Dict[str, Any]:
    """Validate ONE line from the device. Raises FrameError; never returns a partially valid frame."""
    raw = line if isinstance(line, (bytes, bytearray)) else line.encode("utf-8")
    if len(raw) > MAX_LINE:
        raise FrameError("OVERSIZE")
    try:
        o = json.loads(raw.decode("utf-8"), parse_constant=_const)
    except FrameError:
        raise
    except (UnicodeDecodeError, ValueError):
        raise FrameError("MALFORMED")
    if not isinstance(o, dict):
        raise FrameError("MALFORMED", "not an object")
    t = o.get("t")
    if t == "fast":
        base = {"t": t, "seq": _uint(o, "seq"), "ts": _uint(o, "ts"), "rpm": _num(o, "rpm", 0, 70000), "sp": _num(o, "sp", 0, 70000), "duty": _num(o, "duty", 0, 100),
                "v": _num(o, "v", -1, 60), "i": _num(o, "i", -50, 50), "p": _num(o, "p", -3000, 3000), "q": _uint(o, "q", 63)}
        for key in ("pwm_req", "ramp_up", "ramp_down"):
            if key in o:
                base[key] = _num(o, key, 0, 1000)
        if "stop_reason" in o:
            base["stop_reason"] = _str(o, "stop_reason", 32)
        return base
    if t == "slow":
        base = {"t": t, "seq": _uint(o, "seq"), "ts": _uint(o, "ts"), "housing": _num(o, "housing", -60, 200), "ambient": _num(o, "ambient", -60, 200), "q": _uint(o, "q", 63)}
        for k in ("rom0", "rom1", "rom_housing", "rom_ambient"):
            if k in o and isinstance(o[k], str):
                base[k] = o[k]
        return base
    if t == "accel":
        ok = o.get("ok")
        if ok not in (0, 1) or isinstance(ok, bool):
            raise FrameError("BAD_FIELD", "ok")
        base = {"t": t, "seq": _uint(o, "seq"), "ts": _uint(o, "ts"), "ok": ok}
        if ok == 1:
            base.update({"ax": _num(o, "ax", -20, 20), "ay": _num(o, "ay", -20, 20), "az": _num(o, "az", -20, 20), "mag": _num(o, "mag", 0, 35)})
        elif any(k in o for k in ("ax", "ay", "az", "mag")):
            raise FrameError("BAD_FIELD", "numbers on an invalid accel frame")      # an invalid reading carries no numbers
        return base
    if t == "status":
        if o.get("proto") != WIRE_PROTOCOL:
            raise FrameError("UNSUPPORTED_PROTOCOL", str(o.get("proto"))[:12])
        st = _str(o, "state", 16, False)
        if st not in ("OK", "WARN", "EMERGENCY_STOP"):
            raise FrameError("BAD_FIELD", "state")
        mode = _str(o, "mode", 8, False)
        if mode not in ("SIM", "HW"):
            raise FrameError("BAD_FIELD", "mode")
        return {"t": t, "seq": _uint(o, "seq"), "ts": _uint(o, "ts"), "fw": _str(o, "fw", 32, False), "wiring": _str(o, "wiring", 32), "limits_v": _uint(o, "limits_v", 65535),
                "state": st, "reason": _str(o, "reason", 32, False), "mode": mode, "drive": _str(o, "drive", 16, False), "ctl": _uint(o, "ctl", 1), "hb_age": _uint(o, "hb_age"),
                "test": _uint(o, "test", 255), "proto": WIRE_PROTOCOL, "dev": _str(o, "dev", 64), "blk": _str(o, "blk", 48), "fm": _uint(o, "fm"),
                "cfg": _uint(o, "cfg", 65535) if "cfg" in o else 0, "es": _uint(o, "es", 3) if "es" in o else 0}
    if t == "ack":
        s = o.get("status")
        if s not in ("ACCEPTED", "REJECTED", "COMPLETED", "ABORTED"):
            raise FrameError("BAD_ACK_STATUS", str(s)[:16])
        out = {"t": t, "id": _uint(o, "id"), "status": s, "reason": _str(o, "reason", 48)}
        if "dev" in o:
            out["dev"] = _str(o, "dev", 64)
        if "sid" in o:
            out["sid"] = _str(o, "sid", 33)
        return out
    if t == "cfg_ack":
        ok = o.get("ok")
        if ok not in (0, 1) or isinstance(ok, bool):
            raise FrameError("BAD_FIELD", "ok")
        return {"t": t, "ver": _uint(o, "ver", 65535), "ok": ok, "reason": _str(o, "reason", 32)}
    if t == "auth_ch":                                           # device challenge response (authenticated session)
        return {"t": t, "dn": _hex(o, "dn", 32), "proof": _hex(o, "proof", 64)}
    if t == "auth_ok":
        return {"t": t, "sid": _hex(o, "sid", 16), "ttl": _uint(o, "ttl", 600000)}
    if t == "id_ok":                                             # standby-link identity proof (no session effect; firmware auth.cpp "id_ch")
        return {"t": t, "dn": _hex(o, "dn", 32), "proof": _hex(o, "proof", 64), "dev": _str(o, "dev", 64, False)}
    if t == "auth_err":
        return {"t": t, "reason": _str(o, "reason", 24)}
    if t == "ota":                                               # over-the-air update progress (additive to protocol 1; lib/torqva_core/ota.h)
        st = _str(o, "st", 16)
        if st not in OTA_STATES:
            raise FrameError("BAD_FIELD", "st")
        return {"t": t, "seq": _uint(o, "seq"), "ts": _uint(o, "ts"), "id": _uint(o, "id"), "st": st, "rel": _str(o, "rel", 12), "ver": _str(o, "ver", 23), "b": _uint(o, "b"), "n": _uint(o, "n"), "why": _str(o, "why", 32)}
    if t == "log":
        return {"t": t, "seq": _uint(o, "seq"), "ts": _uint(o, "ts"), "lvl": _str(o, "lvl", 12) if "lvl" in o else "INFO", "msg": _str(o, "msg", 256)}
    if t == "net_info":
        return {"t": t, "seq": _uint(o, "seq"), "ts": _uint(o, "ts"), "ip": _str(o, "ip", 48), "ssid": _str(o, "ssid", 64), "rssi": _num(o, "rssi", -127, 20), "mac": _str(o, "mac", 24), "heap": _uint(o, "heap"), "up_s": _uint(o, "up_s"),
                **({"rr": _uint(o, "rr", 20), "lc": _uint(o, "lc", 20), "le": _num(o, "le", -2147483648, 2147483647), "lu": _uint(o, "lu"), "ln": _uint(o, "ln"), "lr": _num(o, "lr", -127, 20), "sm": _uint(o, "sm")} if "rr" in o else {})}
    if t == "link_diag":                                         # the board's own Wi-Fi link measurements (additive; firmware src/communication/wifi_link.cpp)
        sh = o.get("sh")
        if not isinstance(sh, list) or len(sh) != 5 or any(isinstance(v, bool) or not isinstance(v, int) or not 0 <= v <= UINT32 for v in sh):
            raise FrameError("BAD_FIELD", "sh")
        out = {"t": t, "seq": _uint(o, "seq"), "ts": _uint(o, "ts"), "sh": list(sh)}
        for k, hi in (("ps", 2), ("nd", 16), ("wdr", 255), ("wdn", UINT32), ("mh", UINT32), ("pq", 64), ("tq", 64), ("td", UINT32), ("pd", UINT32), ("rd", UINT32),
                      ("fr", UINT32), ("sa", UINT32), ("rx", UINT32), ("cc", 65535), ("lu", UINT32), ("sl", 65535), ("so", 65535)):
            out[k] = _uint(o, k, hi)
        for k, hi in (("ph", 16), ("pa", UINT32), ("st", UINT32), ("sx", UINT32), ("lw", UINT32), ("dr", UINT32), ("as", UINT32)):    # additive in 3.2.1: link-task phase / phase age, TCP stalls / longest stall
            if k in o:
                out[k] = _uint(o, k, hi)
        return out
    if t == "wifi_state":                                      # staged Wi-Fi support and trial state (additive; firmware lib/torqva_core/communication/wifi_trial.h)
        wst, trial = o.get("wst"), o.get("trial")
        if any(v not in (0, 1) or isinstance(v, bool) for v in (wst, trial)):
            raise FrameError("BAD_FIELD", "wst")
        return {"t": t, "seq": _uint(o, "seq"), "ts": _uint(o, "ts"), "wst": wst, "trial": trial, "left": _uint(o, "left", 600), "act": _str(o, "act", 64)}
    if t == "wifi_net":                                          # one network of a scan (seq 0: not part of the telemetry sequence)
        return {"t": t, "seq": _uint(o, "seq"), "ts": _uint(o, "ts"), "i": _uint(o, "i", 63), "n": _uint(o, "n", 64), "ssid": _str(o, "ssid", 64, False),
                "rssi": _num(o, "rssi", -127, 0), "ch": _uint(o, "ch", 14), "auth": _str(o, "auth", 16, False)}
    if t == "wifi_scan_end":
        ok = o.get("ok")
        if ok not in (0, 1) or isinstance(ok, bool):
            raise FrameError("BAD_FIELD", "ok")
        return {"t": t, "seq": _uint(o, "seq"), "ts": _uint(o, "ts"), "n": _uint(o, "n", 64), "ok": ok, "why": _str(o, "why", 24)}
    if t == "ota_info":                                          # this boot's OTA capability and the device's own eligibility verdict
        cap, pend, busy = o.get("cap"), o.get("pend"), o.get("busy")
        if any(v not in (0, 1) or isinstance(v, bool) for v in (cap, pend, busy)):
            raise FrameError("BAD_FIELD", "cap")
        return {"t": t, "seq": _uint(o, "seq"), "ts": _uint(o, "ts"), "cap": cap, "why": _str(o, "why", 32), "run": _str(o, "run", 8), "psz": _uint(o, "psz"), "pend": pend, "last": _str(o, "last", 16),
                "lver": _str(o, "lver", 23), "blk": _str(o, "blk", 32), "busy": busy, "prof": _str(o, "prof", 24) if "prof" in o else ""}   # prof: additive (LED bench firmware only)
    raise FrameError("UNKNOWN_TYPE", str(t)[:16])


# --------------------------------------------------------------------------------------------------------------- device model
