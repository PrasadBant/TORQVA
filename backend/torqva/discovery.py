"""Automatic ESP32 LAN Discovery (mDNS) and Manual IP Connection Probing.

Real network discovery only — never fabricates or simulates discovered hardware.
"""
from __future__ import annotations

import ipaddress
import socket
import struct
import threading
import time
import urllib.error
import urllib.request
from typing import Any, Dict, List, Optional, Tuple


MDNS_ADDR = "224.0.0.251"
MDNS_PORT = 5353


def _encode_dns_name(name: str) -> bytes:
    out = bytearray()
    for part in name.rstrip(".").split("."):
        b = part.encode("utf-8")
        out.append(len(b))
        out.extend(b)
    out.append(0)
    return bytes(out)


def _decode_dns_name(pkt: bytes, off: int) -> Tuple[str, int]:
    labels: List[str] = []
    jumped = False
    end_off = off
    seen = 0
    while off < len(pkt) and seen < 64:
        seen += 1
        ln = pkt[off]
        if ln == 0:
            if not jumped:
                end_off = off + 1
            break
        if (ln & 0xC0) == 0xC0:
            if off + 1 >= len(pkt):
                break
            ptr = ((ln & 0x3F) << 8) | pkt[off + 1]
            if not jumped:
                end_off = off + 2
            off = ptr
            jumped = True
            continue
        off += 1
        labels.append(pkt[off:off + ln].decode("utf-8", "replace"))
        off += ln
        if not jumped:
            end_off = off
    return ".".join(labels), end_off


def _build_ptr_query(service: str = "_torqva._tcp.local") -> bytes:
    header = struct.pack(">HHHHHH", 0, 0, 1, 0, 0, 0)
    question = _encode_dns_name(service) + struct.pack(">HH", 12, 1)  # QTYPE=PTR (12), QCLASS=IN (1)
    return header + question


def _parse_mdns_response(pkt: bytes, src_ip: str) -> Optional[Dict[str, Any]]:
    if len(pkt) < 12:
        return None
    _, flags, qdcount, ancount, nscount, arcount = struct.unpack(">HHHHHH", pkt[:12])
    if not (flags & 0x8000):  # Response bit must be set
        return None
    off = 12
    for _ in range(qdcount):
        _, off = _decode_dns_name(pkt, off)
        off += 4
    total_rr = ancount + nscount + arcount
    txt_meta: Dict[str, str] = {}
    hostname = ""
    port = 80
    ip_addr = src_ip
    matched_torqva = False
    for _ in range(total_rr):
        if off >= len(pkt):
            break
        name, off = _decode_dns_name(pkt, off)
        if off + 10 > len(pkt):
            break
        rtype, _, _, rdlen = struct.unpack(">HHIH", pkt[off:off + 10])
        off += 10
        if off + rdlen > len(pkt):
            break
        rdata = pkt[off:off + rdlen]
        off += rdlen
        if "torqva" in name.lower():
            matched_torqva = True
        if rtype == 12:  # PTR
            target, _ = _decode_dns_name(pkt, off - rdlen)
            if "torqva" in target.lower():
                matched_torqva = True
        elif rtype == 33 and rdlen >= 6:  # SRV
            _, _, srv_port = struct.unpack(">HHH", rdata[:6])
            srv_host, _ = _decode_dns_name(pkt, off - rdlen + 6)
            port = srv_port
            if srv_host:
                hostname = srv_host
        elif rtype == 16:  # TXT
            p = 0
            while p < len(rdata):
                ln = rdata[p]
                p += 1
                item = rdata[p:p + ln].decode("utf-8", "replace")
                p += ln
                if "=" in item:
                    k, v = item.split("=", 1)
                    txt_meta[k.strip()] = v.strip()
        elif rtype == 1 and rdlen == 4:  # A
            ip_addr = socket.inet_ntoa(rdata)
            if name and "torqva" in name.lower():
                hostname = name
                matched_torqva = True
    if not matched_torqva:
        return None
    return {
        "device_id": txt_meta.get("dev") or (hostname.split(".")[0].replace("torqva-", "").upper() if hostname else f"TORQVA-{ip_addr}"),
        "ip": ip_addr,
        "port": port,
        "hostname": hostname or f"{ip_addr}",
        "firmware": txt_meta.get("fw"),
        "profile": txt_meta.get("prof", ""),
        "protocol": txt_meta.get("proto", "1"),
        "source": "mdns",
        "connected": False,
        "last_seen": time.time(),
    }


def query_mdns(timeout_s: float = 1.2) -> List[Dict[str, Any]]:
    """Broadcast a real mDNS PTR query for `_torqva._tcp.local` and gather any answering boards."""
    found: Dict[str, Dict[str, Any]] = {}
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
    try:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.settimeout(0.25)
        try:
            sock.bind(("", 0))
        except OSError:
            return []
        pkt = _build_ptr_query("_torqva._tcp.local")
        try:
            sock.sendto(pkt, (MDNS_ADDR, MDNS_PORT))
        except OSError:
            return []
        deadline = time.monotonic() + max(0.2, min(timeout_s, 3.0))
        while time.monotonic() < deadline:
            try:
                data, (src_ip, _) = sock.recvfrom(2048)
                rec = _parse_mdns_response(data, src_ip)
                if rec:
                    found[rec["ip"]] = rec
            except socket.timeout:
                continue
            except OSError:
                break
    finally:
        sock.close()
    return list(found.values())


class DeviceDiscoveryManager:
    """Combines live bridge links, USB port hints, mDNS discovery, and manual IP fallbacks."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.manual_targets: Dict[str, Dict[str, Any]] = {}

    def discover(self, bridge: Any = None, timeout_s: float = 1.2) -> Dict[str, Any]:
        devices: Dict[str, Dict[str, Any]] = {}
        # 1. Include currently connected bridge device if over Wi-Fi or USB
        if bridge is not None:
            snap = bridge.snapshot()
            tr = snap.get("transport") or {}
            if snap.get("connection") in ("CONNECTED", "STALE"):
                key = tr.get("remote") or tr.get("port") or snap.get("device_id") or "connected"
                devices[str(key)] = {
                    "device_id": snap.get("device_id") or "TORQVA",
                    "ip": tr.get("remote"),
                    "port": tr.get("port"),
                    "hostname": tr.get("remote") or tr.get("port"),
                    "firmware": snap.get("firmware"),
                    "profile": snap.get("device_profile", ""),
                    "source": tr.get("kind", "usb"),
                    "connected": True,
                    "session_active": bool((snap.get("session") or {}).get("active")),
                    "last_seen": time.time(),
                }
        # 2. Query mDNS on LAN
        for d in query_mdns(timeout_s=timeout_s):
            k = d["ip"]
            if k not in devices:
                devices[k] = d
        # 3. Include any manually probed IP targets
        with self._lock:
            for k, m in self.manual_targets.items():
                if k not in devices:
                    devices[k] = dict(m)
        return {
            "devices": list(devices.values()),
            "mdns_service": "_torqva._tcp.local",
            "queried_at": time.time(),
        }

    def probe_ip(self, host: str, port: int = 80, bridge: Any = None, timeout_s: float = 2.0) -> Dict[str, Any]:
        host = host.strip()
        try:
            ip_obj = ipaddress.ip_address(host)
            if ip_obj.is_multicast or ip_obj.is_unspecified:
                raise ValueError("invalid device IP address")
        except ValueError:
            # Allow LAN hostnames like torqva-rig-1.local
            if not host or "/" in host or ":" in host or " " in host:
                raise ValueError("invalid host or IP address")

        t0 = time.monotonic()
        reachable = False
        info: Dict[str, Any] = {}
        error = ""
        # Check if already connected over Wi-Fi WebSocket link from this IP
        if bridge is not None:
            snap = bridge.snapshot()
            tr = snap.get("transport") or {}
            if tr.get("kind") == "wifi" and tr.get("remote") == host and snap.get("connection") in ("CONNECTED", "STALE"):
                rec = {
                    "ip": host,
                    "port": port,
                    "reachable": True,
                    "connected": True,
                    "latency_ms": 0.5,
                    "device_id": snap.get("device_id"),
                    "firmware": snap.get("firmware"),
                    "source": "wifi_link",
                    "last_seen": time.time(),
                }
                with self._lock:
                    self.manual_targets[host] = rec
                return rec

        # Probe HTTP /torqva/info or TCP socket
        try:
            req = urllib.request.Request(f"http://{host}:{port}/torqva/info", method="GET")
            with urllib.request.urlopen(req, timeout=timeout_s) as resp:
                raw = resp.read(2048).decode("utf-8", "replace")
                reachable = True
                try:
                    import json
                    info = json.loads(raw)
                except Exception:
                    info = {"raw": raw[:200]}
        except urllib.error.HTTPError as he:
            reachable = True
            info = {"http_status": he.code}
        except Exception as exc:
            # Fallback raw TCP connect check
            try:
                with socket.create_connection((host, port), timeout=timeout_s):
                    reachable = True
            except OSError as sock_err:
                error = str(sock_err) or str(exc)

        latency = round((time.monotonic() - t0) * 1000.0, 1)
        rec = {
            "ip": host,
            "port": port,
            "reachable": reachable,
            "connected": False,
            "latency_ms": latency,
            "device_id": info.get("dev") or info.get("device_id"),
            "firmware": info.get("fw") or info.get("firmware"),
            "source": "manual_ip",
            "error": error or None,
            "last_seen": time.time(),
        }
        with self._lock:
            self.manual_targets[host] = rec
        return rec
