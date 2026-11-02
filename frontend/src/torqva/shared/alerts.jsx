// Top-bar alerts: a count of the conditions that need attention right now, each opening the page that explains it.
// Every entry is derived from current state the shell already holds (the device stream in physical mode, the simulator records in
// simulation mode). Nothing is stored, invented or marked "read": when the condition clears, the entry disappears.
import React, { useEffect, useRef, useState } from 'react';
import { Bell, AlertTriangle, XOctagon, Clock, XCircle, Info, WifiOff, Unplug } from 'lucide-react';

const ICON = { crit: XCircle, stop: XOctagon, warn: AlertTriangle, wait: Clock, info: Info, off: Unplug, net: WifiOff };
const title = (s) => String(s ?? '').replaceAll('_', ' ');

/** Physical mode: what the device path reports. `stream` is the shell's useDeviceStream() result. */
export function deviceAlerts(stream) {
  const out = [];
  const snap = stream?.snap;
  if (stream?.unreachable) out.push({ key: 'backend', tone: 'crit', icon: 'net', title: 'Backend unreachable', text: 'Device readings shown are the last received and are not live.', to: 'device' });
  if (!snap || snap.connection === 'DISCONNECTED') { out.push({ key: 'disc', tone: 'off', title: 'Device disconnected', text: 'Physical readings are unavailable. Connect the rig on Device & Safety.', to: 'device' }); return out; }
  if (snap.connection === 'ERROR') out.push({ key: 'err', tone: 'crit', title: 'Device connection error', text: snap.error?.message || snap.state_label || 'The device link reported an error.', to: 'device' });
  if (snap.handshake && snap.origin !== 'physical_device') out.push({ key: 'fwsim', tone: 'warn', title: 'Firmware simulation mode', text: 'The board reports simulated values; they are not physical measurements.', to: 'device' });
  const live = !!(snap.handshake && snap.origin === 'physical_device');
  if (live && !snap.telemetry_fresh) out.push({ key: 'stale', tone: 'warn', title: 'Telemetry stale', text: 'No fresh readings from the device. Values are not live.', to: 'live' });
  if (snap.safety_state === 'EMERGENCY_STOP') out.push({ key: 'estop', tone: 'stop', title: 'Emergency stop latched', text: title(snap.trip_reason) || 'The firmware latched an emergency stop.', to: 'control' });
  const blockers = snap.control_blockers || [];
  if (blockers.length) out.push({ key: 'blk', tone: 'crit', title: `Motor operation blocked (${blockers.length})`, text: blockers[0], to: 'control' });
  const bad = Object.entries(snap.sensor_status || {}).filter(([, s]) => s !== 'valid');
  if (live && bad.length) out.push({ key: 'sens', tone: 'warn', title: `${bad.length} sensor${bad.length > 1 ? 's' : ''} not reporting valid data`, text: bad.map(([k, s]) => `${title(k)}: ${s}`).join(', '), to: 'device' });
  return out;
}

/** Simulation mode: what the simulator records say. `d` is the shell's polled data; `stale` the shell's staleness flag. */
export function simAlerts(d, stale) {
  const out = [];
  const s = d?.status || {};
  if (stale) out.push({ key: 'backend', tone: 'crit', icon: 'net', title: 'Backend unreachable', text: 'Values shown are stale and not live.', to: 'overview' });
  if (s.device?.estop) out.push({ key: 'estop', tone: 'stop', title: 'Simulated E-stop latched', text: title(s.device.estop_reason) || 'The simulated motor is stopped.', to: 'overview' });
  if (s.pending_approval) out.push({ key: 'appr', tone: 'wait', title: 'Action awaiting your decision', text: `${title(s.pending_approval.action)}: review it in Action Recommendations.`, to: 'interventions' });
  if (s.incident) out.push({ key: 'inc', tone: 'warn', title: `Incident ${s.incident.id} open`, text: `State: ${title(s.incident.state)}.`, to: 'diagnostics' });
  if (s.last_window && s.last_window.valid === false) out.push({ key: 'inv', tone: 'warn', title: 'Latest simulated window invalid', text: 'Its values are shown as unavailable.', to: 'live' });
  return out;
}

/** Bell button with a count and a popover list. Escape or a click outside closes it; each entry navigates with the shell's `go`. */
export function AlertsMenu({ alerts = [], go }) {
  const [open, setOpen] = useState(false);
  const root = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    root.current?.querySelector('.tq-alerts-item')?.focus();
    const key = (e) => { if (e.key === 'Escape') { setOpen(false); root.current?.querySelector('.tq-iconbtn')?.focus(); } };
    const click = (e) => { if (root.current && !root.current.contains(e.target)) setOpen(false); };
    window.addEventListener('keydown', key); document.addEventListener('mousedown', click);
    return () => { window.removeEventListener('keydown', key); document.removeEventListener('mousedown', click); };
  }, [open]);
  const n = alerts.length;
  const urgent = alerts.some((a) => a.tone === 'crit' || a.tone === 'stop');
  return (
    <div className="tq-alerts" ref={root}>
      <button type="button" className="tq-iconbtn" aria-haspopup="true" aria-expanded={open} aria-controls="tq-alerts-pop" data-testid="alerts-btn"
        aria-label={n ? `Alerts: ${n} active` : 'Alerts: none active'} title={n ? `${n} active alert${n > 1 ? 's' : ''}` : 'No active alerts'} onClick={() => setOpen((o) => !o)}>
        <Bell size={16} aria-hidden="true" />
        {n > 0 && <span className={`tq-alerts-count ${urgent ? '' : 'is-warn'}`} aria-hidden="true">{n}</span>}
      </button>
      {open && (
        <div className="tq-alerts-pop" id="tq-alerts-pop" role="region" aria-labelledby="tq-alerts-title" data-testid="alerts-pop">
          <p className="tq-alerts-title" id="tq-alerts-title">Active alerts</p>
          {!n ? <p className="tq-alerts-empty">Nothing needs attention right now.</p> : (
            <ul>{alerts.map((a) => {
              const I = ICON[a.icon] || ICON[a.tone] || Info;
              return (
                <li key={a.key}>
                  <button type="button" className={`tq-alerts-item tq-${a.tone}`} onClick={() => { setOpen(false); go(a.to); }}>
                    <I size={16} aria-hidden="true" /><strong>{a.title}</strong><span>{a.text}</span>
                  </button>
                </li>);
            })}</ul>)}
        </div>)}
    </div>
  );
}
