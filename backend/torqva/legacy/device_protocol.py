"""TORQVA device protocol "tqv1": versioned, typed, strictly validated messages between a device and the backend. Transport-independent (pure logic).

One JSON object per message, UTF-8, at most MAX_MSG_BYTES. Every field below is validated; nothing decorative.

  device -> server   hello    {v, t:"hello", dev, fw}                                  first message after the secure handshake; binds the connection to a device identity
  server -> device   session  {v, t:"session", dev, sid}                               a FRESH random session id, issued only after the identity checks passed
  device -> server   tel      {v, t:"tel", dev, sid, n, ts, rpm, duty, v_bus, i_a, housing_c, q}
  device -> server   fault    {v, t:"fault", dev, sid, n, code}
  server -> device   cmd      {v, t:"cmd", dev, sid, cid, n, ty, p, p2, p3, ttl_ms}    an actionable command, bound to ONE session and ONE device
  device -> server   ack      {v, t:"ack", dev, sid, cid, st, reason}                  st: received | executed | rejected | aborted   (receipt is NOT execution, execution is NOT recovery)
  either             bye      {v, t:"bye", dev, sid}

`n` is a strictly increasing counter per direction INSIDE one session; `cid` is unique per command within a session; `sid` is random per session, so nothing captured in an earlier
session (or before a reboot) is valid in a later one. Authenticity and confidentiality come from the secured transport (mutual TLS), not from these fields.
Unknown version, unknown type, malformed JSON, oversize, non-finite numbers and invalid identifiers all raise ProtocolError: the caller must close the connection (fail closed).
"""
from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass
from typing import Any, Dict, Optional

PROTOCOL = "tqv1"
MAX_MSG_BYTES = 2048
_ID = re.compile(r"^[A-Za-z0-9_.-]{1,64}$")
_SID = re.compile(r"^[0-9a-f]{32}$")
CMD_TYPES = ("HEARTBEAT", "SET_SPEED", "STOP", "START", "RUN_TEST", "ABORT_TEST", "RESET_ESTOP")
ACK_STATES = ("received", "executed", "rejected", "aborted")
TERMINAL_ACK_STATES = ("executed", "rejected", "aborted")


class ProtocolError(Exception):
    def __init__(self, code: str, detail: str = ""):
        super().__init__(f"{code}: {detail}" if detail else code)
        self.code = code


def _reject_constant(name):                       # json.loads would accept NaN / Infinity / -Infinity
    raise ProtocolError("NON_FINITE_NUMBER", name)


def _num(m: Dict[str, Any], k: str, lo: float, hi: float) -> float:
    v = m.get(k)
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        raise ProtocolError("BAD_FIELD", k)
    if not math.isfinite(v) or not (lo <= v <= hi):
        raise ProtocolError("OUT_OF_RANGE", k)
    return float(v)


def _int(m: Dict[str, Any], k: str, lo: int = 0, hi: int = 2 ** 32 - 1) -> int:
    v = m.get(k)
    if isinstance(v, bool) or not isinstance(v, int) or not (lo <= v <= hi):
        raise ProtocolError("BAD_FIELD", k)
    return v


def _ident(m: Dict[str, Any], k: str) -> str:
    v = m.get(k)
    if not isinstance(v, str) or not _ID.match(v):
        raise ProtocolError("BAD_IDENTIFIER", k)
    return v


def _sid(m: Dict[str, Any]) -> str:
    v = m.get("sid")
    if not isinstance(v, str) or not _SID.match(v):
        raise ProtocolError("BAD_SESSION_ID")
    return v


@dataclass(frozen=True)
class Message:
    t: str
    dev: str
    sid: Optional[str]
    body: Dict[str, Any]


def parse_message(raw: "bytes | str") -> Message:
    """Parse and validate ONE message. Raises ProtocolError; never returns a partially valid message."""
    data = raw.encode("utf-8") if isinstance(raw, str) else raw
    if len(data) > MAX_MSG_BYTES:
        raise ProtocolError("OVERSIZE", str(len(data)))
    try:
        obj = json.loads(data.decode("utf-8"), parse_constant=_reject_constant)
    except ProtocolError:
        raise
    except (UnicodeDecodeError, ValueError):
        raise ProtocolError("MALFORMED")
    if not isinstance(obj, dict):
        raise ProtocolError("MALFORMED", "not an object")
    if obj.get("v") != PROTOCOL:
        raise ProtocolError("UNSUPPORTED_VERSION", str(obj.get("v"))[:20])
    t = obj.get("t")
    dev = _ident(obj, "dev")
    if t == "hello":
        _ident(obj, "fw")
        return Message(t, dev, None, {"fw": obj["fw"]})
    if t == "session":
        return Message(t, dev, _sid(obj), {})
    sid = _sid(obj)
    if t == "tel":
        body = {"n": _int(obj, "n"), "ts": _int(obj, "ts"), "rpm": _num(obj, "rpm", 0, 20000), "duty": _num(obj, "duty", 0, 100), "v_bus": _num(obj, "v_bus", 0, 60),
                "i_a": _num(obj, "i_a", -50, 50), "housing_c": _num(obj, "housing_c", -60, 200), "q": _int(obj, "q", 0, 63)}
        return Message(t, dev, sid, body)
    if t == "fault":
        return Message(t, dev, sid, {"n": _int(obj, "n"), "code": _ident(obj, "code")})
    if t == "cmd":
        ty = obj.get("ty")
        if ty not in CMD_TYPES:
            raise ProtocolError("UNSUPPORTED_COMMAND", str(ty)[:20])
        body = {"cid": _ident(obj, "cid"), "n": _int(obj, "n"), "ty": ty, "p": _num(obj, "p", -1e6, 1e6), "p2": _num(obj, "p2", -1e6, 1e6),
                "p3": _num(obj, "p3", -1e6, 1e6), "ttl_ms": _int(obj, "ttl_ms", 1, 30000)}
        return Message(t, dev, sid, body)
    if t == "ack":
        st = obj.get("st")
        if st not in ACK_STATES:
            raise ProtocolError("BAD_ACK_STATE", str(st)[:20])
        reason = obj.get("reason", "")
        if not isinstance(reason, str) or len(reason) > 64:
            raise ProtocolError("BAD_FIELD", "reason")
        return Message(t, dev, sid, {"cid": _ident(obj, "cid"), "st": st, "reason": reason})
    if t == "bye":
        return Message(t, dev, sid, {})
    raise ProtocolError("UNKNOWN_TYPE", str(t)[:20])


def encode(msg: Dict[str, Any]) -> bytes:
    """Serialise one outgoing message (adds the version, enforces the size limit and finite numbers)."""
    out = {"v": PROTOCOL, **msg}
    data = json.dumps(out, separators=(",", ":"), allow_nan=False).encode("utf-8")
    if len(data) > MAX_MSG_BYTES:
        raise ProtocolError("OVERSIZE")
    return data + b"\n"
