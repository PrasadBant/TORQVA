"""Summarise the backend's Wi-Fi link log (.tmp/link_log/link-YYYYMMDD.jsonl, written by torqva/device/device_link.py while TORQVA_DEVICE_LINK=1).

Only recorded, measured values are reported: nothing is estimated. Used for the physical acceptance runs (cold boots, handover, 60-minute stability).

    python scripts/development/link_report.py                       # today's log
    python scripts/development/link_report.py --since 14:05         # only events after 14:05 today
    python scripts/development/link_report.py --file path/to/log.jsonl --json
"""
from __future__ import annotations

import argparse
import datetime
import json
import sys
import time
from pathlib import Path
from typing import Any, Dict, List

REPO = Path(__file__).resolve().parents[2]


def load(path: Path, since: float) -> List[Dict[str, Any]]:
    rows = []
    for line in path.read_text(encoding="utf-8").splitlines():
        try:
            r = json.loads(line)
        except ValueError:
            continue
        if float(r.get("at", 0)) >= since:
            rows.append(r)
    return rows


def summarise(rows: List[Dict[str, Any]]) -> Dict[str, Any]:
    boots, last_up = [], None
    for r in rows:
        if r["kind"] != "net_info":
            continue
        up = r.get("uptime_s")
        if up is None:
            continue
        if last_up is None or up < last_up:                     # the board's uptime went back: a new boot
            boots.append({"seen_at": r["at"], "uptime_at_first_report_s": up, "reset_reason": r.get("reset_reason"), "session_s_after_boot": None,
                          "session_transport": None})
        last_up = up
    sessions = [r for r in rows if r["kind"] == "session_active"]
    for b in boots:                                             # the first authenticated session after each boot, measured from the board's own boot
        nxt = next((s for s in sessions if s["at"] >= b["seen_at"] - b["uptime_at_first_report_s"]), None)
        if nxt is not None:
            b["session_s_after_boot"] = round(nxt["at"] - (b["seen_at"] - b["uptime_at_first_report_s"]), 1)
            b["session_transport"] = nxt.get("transport")
    drops = [{"at": r["at"], "reason": r.get("reason"), "lasted_s": r.get("lasted_s")} for r in rows if r["kind"] == "link_disconnected"]
    diags = [r for r in rows if r["kind"] == "link_diag"]
    nets = [r for r in rows if r["kind"] == "net_info"]
    hist: Dict[str, int] = {}
    per_link: Dict[Any, Dict[str, Any]] = {}                    # the board resets its counters on every link: the last report of each link is its total
    for d in diags:
        key = round((d["at"] - (d.get("link_uptime_s") or 0)) / 5)  # a link is identified by its start time (report time - link uptime), to 5 s
        per_link[key] = d
    for d in per_link.values():
        for k, v in (d.get("send_histogram") or {}).items():
            hist[k] = hist.get(k, 0) + v
    return {
        "events": len(rows),
        "boots": boots,
        "sessions": [{"at": s["at"], "transport": s.get("transport"), "s_since_connect": s.get("s_since_connect")} for s in sessions],
        "wifi_link_drops": drops,
        "standby_admissions": sum(1 for r in rows if r["kind"] == "link_standby"),
        "promotions": [{"at": r["at"], "reason": r.get("reason")} for r in rows if r["kind"] == "link_handover"],
        "refusals": [{"at": r["at"], "reason": r.get("reason")} for r in rows if r["kind"] == "link_refused"],
        "transport_ends": [{"at": r["at"], "transport": r.get("transport"), "reason": r.get("reason")} for r in rows if r["kind"] == "transport_ended"],
        "send_ms_max": max((n.get("max_send_ms") or 0 for n in nets), default=None),
        "send_ms_avg_last": diags[-1].get("avg_send_ms") if diags else None,
        "send_histogram_total": hist,
        "telemetry_dropped_max": max((d.get("telemetry_dropped") or 0 for d in diags), default=None),
        "priority_dropped_max": max((d.get("priority_dropped") or 0 for d in diags), default=None),
        "rx_dropped_max": max((d.get("rx_dropped") or 0 for d in diags), default=None),
        "wifi_disconnects_max": max((d.get("wifi_disconnects") or 0 for d in diags), default=None),
        "power_save": sorted({d.get("power_save") for d in diags if d.get("power_save")}),
        "tcp_nodelay_applied": sorted({d.get("tcp_nodelay_sockets") for d in diags}) if diags else [],
        "min_free_heap": min((d.get("min_free_heap") or 0 for d in diags), default=None),
        "rssi_range": [min(n["rssi"] for n in nets), max(n["rssi"] for n in nets)] if nets else None,
        "link_close_causes": sorted({n.get("link_close_cause") for n in nets if n.get("link_close_cause")}),
    }


def ts(t: float) -> str:
    return datetime.datetime.fromtimestamp(t).strftime("%H:%M:%S")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--file", type=Path, default=None)
    ap.add_argument("--since", default=None, help="HH:MM[:SS] today")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()
    path = a.file or REPO / ".tmp" / "link_log" / time.strftime("link-%Y%m%d.jsonl")
    if not path.exists():
        print(f"no link log at {path} (the backend records it while TORQVA_DEVICE_LINK=1)", file=sys.stderr)
        return 2
    since = 0.0
    if a.since:
        hms = [int(x) for x in a.since.split(":")] + [0, 0]
        since = datetime.datetime.combine(datetime.date.today(), datetime.time(hms[0], hms[1], hms[2])).timestamp()
    s = summarise(load(path, since))
    if a.json:
        print(json.dumps(s, indent=2, default=str))
        return 0
    print(f"{path}  ({s['events']} events)")
    print(f"boots seen: {len(s['boots'])}")
    for b in s["boots"]:
        print(f"  {ts(b['seen_at'])}  reset: {b['reset_reason']}  first authenticated session {b['session_s_after_boot']} s after boot over {b['session_transport']}")
    print(f"authenticated sessions: {len(s['sessions'])}  ({', '.join(f'{x['transport']} {x['s_since_connect']} s' for x in s['sessions'][-10:])})")
    print(f"Wi-Fi link drops: {len(s['wifi_link_drops'])}")
    for d in s["wifi_link_drops"][-10:]:
        print(f"  {ts(d['at'])}  lasted {d['lasted_s']} s  {d['reason']}")
    print(f"standby admissions: {s['standby_admissions']}  promotions: {len(s['promotions'])}  refusals: {len(s['refusals'])}")
    print(f"send ms: max {s['send_ms_max']}  avg (latest link) {s['send_ms_avg_last']}  histogram {s['send_histogram_total']}")
    print(f"dropped max: telemetry {s['telemetry_dropped_max']}  priority {s['priority_dropped_max']}  inbound {s['rx_dropped_max']}  Wi-Fi disconnects {s['wifi_disconnects_max']}")
    print(f"power save {s['power_save']}  TCP no-delay sockets {s['tcp_nodelay_applied']}  min free heap {s['min_free_heap']}  RSSI {s['rssi_range']}")
    print(f"board-reported link end causes: {s['link_close_causes']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
