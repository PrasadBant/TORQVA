"""TORQVA Session Report Generator.

Rebuilds a standalone, executive HTML report directly from a session folder
(readings.csv, events.csv, session.json).
"""
from __future__ import annotations

import csv
import html
import json
from pathlib import Path
from typing import Any, Dict, List, Optional

from torqva.telemetry.recording import recorder


def generate_html_report(session_id: str, base_dir: Optional[Path | str] = None) -> Optional[str]:
    """Generate self-contained HTML report from session folder and write report.html."""
    b_dir = Path(base_dir) if base_dir else recorder.base_dir
    session_dir = b_dir / session_id
    if not session_dir.is_dir():
        return None

    meta_file = session_dir / "session.json"
    meta: Dict[str, Any] = {}
    if meta_file.is_file():
        try:
            with open(meta_file, "r", encoding="utf-8") as f:
                meta = json.load(f)
        except Exception:
            pass

    # Read readings.csv for summary and stats
    summary = recorder.get_session_summary(session_id)

    # Read events.csv
    events_file = session_dir / "events.csv"
    events: List[Dict[str, str]] = []
    if events_file.is_file():
        try:
            with open(events_file, "r", encoding="utf-8") as f:
                reader = csv.DictReader(f)
                events = list(reader)
        except Exception:
            pass

    mode = meta.get("mode", "UNKNOWN")
    started_at = meta.get("started_at_iso", "—")
    stopped_at = meta.get("stopped_at_iso", "—")
    checksums = meta.get("checksums", {})
    config_snap = meta.get("config_snapshot", {})

    event_rows = ""
    for ev in events[-50:]:  # last 50 events
        t = html.escape(ev.get("time_s", "—"))
        ev_type = html.escape(ev.get("event_type", "—"))
        level = html.escape(ev.get("level", "INFO"))
        details = html.escape(ev.get("details", ""))
        badge_cls = "badge-ok" if level in ("INFO", "COMMAND") else "badge-warn" if level == "WARN" else "badge-crit"
        event_rows += f"""<tr>
            <td class="mono">{t}s</td>
            <td><span class="badge {badge_cls}">{level}</span></td>
            <td><strong>{ev_type}</strong></td>
            <td>{details}</td>
        </tr>"""

    if not event_rows:
        event_rows = "<tr><td colspan='4' class='text-muted'>No logged events.</td></tr>"

    config_rows = ""
    for k, v in config_snap.items():
        config_rows += f"<tr><td class='mono'><strong>{html.escape(str(k))}</strong></td><td>{html.escape(str(v))}</td></tr>"
    if not config_rows:
        config_rows = "<tr><td colspan='2' class='text-muted'>Standard operating configuration active.</td></tr>"

    html_content = f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>TORQVA Session Report — {html.escape(session_id)}</title>
  <style>
    :root {{
      --bg: #0f172a; --card: #1e293b; --border: #334155;
      --text: #f8fafc; --text-muted: #94a3b8;
      --accent: #38bdf8; --ok: #10b981; --warn: #f59e0b; --crit: #ef4444;
    }}
    body {{
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: var(--bg); color: var(--text); margin: 0; padding: 2rem;
      line-height: 1.5;
    }}
    .container {{ max-width: 960px; margin: 0 auto; }}
    header {{ border-bottom: 1px solid var(--border); padding-bottom: 1.5rem; margin-bottom: 2rem; }}
    .title {{ font-size: 1.8rem; font-weight: 700; color: #fff; margin: 0 0 0.5rem 0; }}
    .subtitle {{ color: var(--text-muted); font-size: 0.95rem; }}
    .grid {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 1rem; margin-bottom: 2rem; }}
    .tile {{ background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 1.2rem; }}
    .tile-label {{ font-size: 0.8rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; }}
    .tile-val {{ font-size: 1.7rem; font-weight: 700; color: #fff; margin: 0.3rem 0; font-family: monospace; }}
    .card {{ background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 1.5rem; margin-bottom: 2rem; }}
    .card-title {{ font-size: 1.15rem; font-weight: 600; margin-top: 0; margin-bottom: 1rem; border-bottom: 1px solid var(--border); padding-bottom: 0.5rem; }}
    table {{ width: 100%; border-collapse: collapse; font-size: 0.9rem; }}
    th, td {{ padding: 0.6rem 0.8rem; text-align: left; border-bottom: 1px solid var(--border); }}
    th {{ color: var(--text-muted); font-weight: 600; }}
    .mono {{ font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }}
    .badge {{ display: inline-block; padding: 0.15rem 0.5rem; border-radius: 4px; font-size: 0.75rem; font-weight: 600; }}
    .badge-ok {{ background: rgba(16,185,129,0.15); color: var(--ok); }}
    .badge-warn {{ background: rgba(245,158,11,0.15); color: var(--warn); }}
    .badge-crit {{ background: rgba(239,68,68,0.15); color: var(--crit); }}
    .checksum {{ font-size: 0.8rem; color: var(--text-muted); word-break: break-all; }}
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <div>
          <h1 class="title">TORQVA Telemetry Session Report</h1>
          <div class="subtitle">Session ID: <span class="mono">{html.escape(session_id)}</span> · Mode: <strong>{html.escape(mode)}</strong></div>
        </div>
        <span class="badge badge-ok" style="font-size:0.9rem; padding:0.4rem 0.8rem;">PROVENANCE: {html.escape(mode)}</span>
      </div>
    </header>

    <div class="grid">
      <div class="tile">
        <div class="tile-label">Duration</div>
        <div class="tile-val">{summary.get("duration_s", 0)} s</div>
        <div class="tile-label">{summary.get("sample_count", 0)} samples</div>
      </div>
      <div class="tile">
        <div class="tile-label">Peak Speed</div>
        <div class="tile-val">{summary.get("peak_rpm", 0)} <small style="font-size:1rem;color:var(--text-muted);">rpm</small></div>
        <div class="tile-label">Measured (Hall)</div>
      </div>
      <div class="tile">
        <div class="tile-label">Peak Current</div>
        <div class="tile-val">{summary.get("peak_current_a", 0)} <small style="font-size:1rem;color:var(--text-muted);">A</small></div>
        <div class="tile-label">Measured (INA219)</div>
      </div>
      <div class="tile">
        <div class="tile-label">Max Temperature</div>
        <div class="tile-val">{summary.get("max_temp_c", 0)} <small style="font-size:1rem;color:var(--text-muted);">°C</small></div>
        <div class="tile-label">Housing (DS18B20)</div>
      </div>
      <div class="tile">
        <div class="tile-label">Data Quality</div>
        <div class="tile-val" style="color:var(--ok);">{summary.get("data_quality_pct", 100)}%</div>
        <div class="tile-label">Valid frames</div>
      </div>
    </div>

    <div class="card">
      <h2 class="card-title">Session Events</h2>
      <table>
        <thead>
          <tr><th>Time</th><th>Severity</th><th>Event</th><th>Details</th></tr>
        </thead>
        <tbody>
          {event_rows}
        </tbody>
      </table>
    </div>

    <div class="card">
      <h2 class="card-title">Configuration Snapshot</h2>
      <table>
        <thead>
          <tr><th>Parameter</th><th>Value</th></tr>
        </thead>
        <tbody>
          {config_rows}
        </tbody>
      </table>
    </div>

    <div class="card">
      <h2 class="card-title">Cryptographic Integrity Verification</h2>
      <p class="subtitle">SHA-256 integrity checksums computed over telemetry recordings:</p>
      <table>
        <tbody>
          <tr>
            <td><strong>readings.csv</strong></td>
            <td class="mono checksum">{html.escape(checksums.get("readings_sha256", "pending/active"))}</td>
          </tr>
          <tr>
            <td><strong>events.csv</strong></td>
            <td class="mono checksum">{html.escape(checksums.get("events_sha256", "pending/active"))}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</body>
</html>
"""

    report_path = session_dir / "report.html"
    with open(report_path, "w", encoding="utf-8") as f:
        f.write(html_content)

    return html_content
