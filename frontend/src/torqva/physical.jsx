import React, { useState } from 'react';
import { Usb, Octagon } from 'lucide-react';
import { api } from './api.js';
import { Card, Empty, ErrorBox, Pill, ProvBadge, fmt } from './components.jsx';
import { PageHead } from './pages.jsx';
import { DeviceLive, CommissioningCard, canOperate, STATE_TONE } from './device.jsx';

const WAITING = 'WAITING FOR VALID PHYSICAL TELEMETRY';
const ago = (unix) => (unix ? `${fmt(Math.max(0, Date.now() / 1000 - unix), 1)} s ago` : 'never');
const title = (s) => String(s ?? '').replaceAll('_', ' ');
const isLive = (snap) => !!(snap?.handshake && snap?.origin === 'physical_device');

/** Explicit, operator-selected application mode. Physical is the default; simulation is never entered automatically and never mixed with physical data. */
export function ModeSwitch({ mode, onChange }) {
  return (
    <div className="tq-row" role="group" aria-label="Application mode" data-testid="mode-switch">
      <button className="tq-btn" aria-pressed={mode === 'PHYSICAL'} onClick={() => onChange('PHYSICAL')}>Physical mode</button>
      <button className="tq-btn" aria-pressed={mode === 'SIMULATION'} onClick={() => onChange('SIMULATION')}>Simulation mode (demo)</button>
    </div>
  );
}

/** Compact, dynamic: the actual connection state and, when there is one, the specific reason motion is unavailable. */
export function PhysicalBanner({ snap }) {
  const live = isLive(snap);
  const label = live ? (snap.telemetry_fresh ? 'PHYSICAL DEVICE CONNECTED' : 'PHYSICAL DEVICE - TELEMETRY STALE') : snap?.handshake ? 'DEVICE (FIRMWARE SIMULATION MODE)' : (!snap || snap.connection === 'DISCONNECTED') ? 'DEVICE DISCONNECTED' : snap.state_label || snap.connection;
  const blockers = snap?.control_blockers || [];
  const detail = !live ? 'Physical readings are unavailable.' : blockers.length ? `Motion unavailable: ${blockers[0]}${blockers.length > 1 ? ` (+${blockers.length - 1} more)` : ''}` : 'No motion blocker reported.';
  return (
    <div className="tq-banner" role="status" aria-live="polite" data-testid="phys-banner">
      <Usb size={16} aria-hidden="true" />
      <strong>{label}</strong>
      <span>{detail}</span>
    </div>
  );
}

function sensorSummary(sens) {
  const e = Object.entries(sens || {}).filter(([k]) => k !== 'vibration_rms' && k !== 'ambient');       // vibration RMS is not implemented, and the ambient DS18B20 is optional hardware: neither counts as a sensor fault
  const bad = e.filter(([, s]) => s !== 'valid');
  return { total: e.length, valid: e.length - bad.length, bad };
}

export function StatusStrip({ snap }) {
  const live = isLive(snap);
  const ss = sensorSummary(snap?.sensor_status);
  const blockers = snap?.control_blockers || [];
  const fault = !live ? ['off', 'fault state unknown'] : snap.safety_state === 'OK' ? ['ok', 'no active fault'] : snap.safety_state === 'EMERGENCY_STOP' ? ['stop', `LATCHED: ${title(snap.trip_reason)}`] : ['warn', snap.safety_state || 'unknown'];
  return (
    <div className="tq-status-strip" data-testid="status-strip">
      <div className="tq-row" style={{ flexWrap: 'wrap', gap: 8 }}>
        <Pill tone={live ? (snap.telemetry_fresh ? 'ok' : 'warn') : snap?.connection === 'ERROR' ? 'crit' : 'off'}>{snap?.state_label || 'DEVICE DISCONNECTED'}</Pill>
        {snap?.handshake && <Pill tone="ok">{`handshake ok · ${snap.device_id || '—'} · fw ${snap.firmware || '—'}`}</Pill>}
        <Pill tone={!live ? 'off' : ss.bad.length ? 'warn' : 'ok'}>{!live ? 'sensors unknown' : `sensors ${ss.valid}/${ss.total} valid`}</Pill>
        <Pill tone={fault[0]}>{fault[1]}</Pill>
        {live && snap.estop_input && <Pill tone={snap.estop_input.state === 2 ? 'ok' : snap.estop_input.state === 1 ? 'stop' : 'warn'}>{`E-stop input: ${String(snap.estop_input.label || 'unknown').split(' (')[0].toLowerCase()}`}</Pill>}
        {live && snap.transport_label && <Pill tone={snap.session?.active ? 'info' : 'warn'}>{snap.transport_label}</Pill>}
        {live && snap.config && <Pill tone={snap.config.confirmed ? 'ok' : 'warn'}>{snap.config.confirmed ? `limits v${snap.config.device_version} confirmed by the device` : snap.config.approved_version ? `limits v${snap.config.approved_version} awaiting the device` : 'no limits approved'}</Pill>}
        <Pill tone={blockers.length ? 'stop' : 'info'}>{blockers.length ? `motion locked: ${blockers[0]}` : 'motion permitted'}</Pill>
        {snap?.last_rx_unix ? <span className="tq-muted tq-num">last telemetry {ago(snap.last_rx_unix)}</span> : null}
      </div>
      {live && snap.config?.confirmed && snap.config.limits && <p className="tq-muted" data-testid="accepted-limits">Accepted limits: {snap.config.limits.max_current_a} A · {snap.config.limits.min_voltage_v}–{snap.config.limits.max_voltage_v} V · {snap.config.limits.max_temp_c} °C · {snap.config.limits.max_rpm} rpm · {snap.config.limits.max_duty_pct} % duty</p>}
      {live && ss.bad.length > 0 && <p className="tq-muted" data-testid="sensor-gaps">{ss.bad.map(([k, s]) => `${k.replaceAll('_', ' ')}: ${s}`).join(' · ')}</p>}
    </div>
  );
}

const TILES = [['rpm', 'Measured speed (Hall)', 'rpm', 0], ['current', 'Current', 'A', 3], ['voltage', 'Voltage', 'V', 2], ['housing', 'Motor temperature', '°C', 1], ['power', 'Power', 'W', 2], ['acceleration', 'Total acceleration (incl. gravity)', 'g', 3]];

function Tile({ label, unit, d, v }) {
  const has = v && v.valid && v.value != null;
  return (
    <div className="tq-kpi" data-testid={`tile-${label}`}>
      <span className="tq-kpi-label">{label} <ProvBadge kind="MEASURED" /></span>
      <span className={`tq-kpi-value tq-num ${has ? '' : 'tq-na'}`}>{has ? `${fmt(v.value, d)} ${unit}` : 'UNAVAILABLE'}</span>
      <span className="tq-muted">{!v ? 'no reading' : !v.valid ? 'sensor invalid' : v.stale ? `STALE · ${ago(v.received_unix)}` : `live · ${ago(v.received_unix)}`}</span>
    </div>
  );
}

/** START / STOP / duty / speed through the genuine authorised path. Nothing here decides anything: the backend, supervisor and firmware do. */
export function MotionPanel({ stream, role }) {
  const { snap, commands } = stream;
  const [duty, setDuty] = useState('');
  const [rpm, setRpm] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [err, setErr] = useState(null);
  const [last, setLast] = useState(null);
  const live = isLive(snap);
  const blockers = snap?.control_blockers || ['DEVICE NOT CONNECTED'];
  const blocked = blockers.length > 0;
  const operator = canOperate(role);
  const connected = snap && ['CONNECTED', 'STALE'].includes(snap.connection) && snap.handshake;
  const maxDuty = snap?.control_limits?.max_duty_pct ?? 100;
  const send = (body) => async () => { setBusy(true); setErr(null); try { setLast(await api.deviceCommand(body)); } catch (e) { setErr(e); } finally { setBusy(false); stream.refresh(); } };
  const rec = (last && (commands || []).find((c) => c.id === last.id)) || last;
  const vals = snap?.values || {};
  const motor = !live || !snap.telemetry_fresh ? 'UNKNOWN' : snap.drive === 'IDLE' ? 'STOPPED' : snap.drive ? 'RUNNING' : 'UNKNOWN';
  const dutyBad = duty === '' || !(Number(duty) > 0 && Number(duty) <= maxDuty);
  return (
    <Card title="Motor control" id="p-motion" right={<Pill tone={motor === 'RUNNING' ? 'ok' : motor === 'STOPPED' ? 'info' : 'off'}>{motor}</Pill>}>
      <dl className="tq-kv" data-testid="motor-state">
        <dt>Motor state (reported by firmware)</dt><dd>{motor}{!live ? ' - no live telemetry' : ''}</dd>
        <dt>Commanded duty</dt><dd className="tq-num">{live && vals.duty?.value != null ? `${fmt(vals.duty.value, 1)} %` : '—'}</dd>
        <dt>Measured speed (Hall)</dt><dd className="tq-num">{live && vals.rpm?.valid && vals.rpm.value != null ? `${fmt(vals.rpm.value, 0)} rpm` : 'UNAVAILABLE'}</dd>
      </dl>
      <button type="button" className="tq-btn tq-danger tq-stop-big" disabled={!connected} onClick={send({ action: 'STOP' })} data-testid="btn-stop">
        <Octagon size={18} aria-hidden="true" /> STOP
      </button>
      {!connected && <p className="tq-muted">STOP cannot be delivered: the device is not connected.</p>}
      <form className="tq-form" onSubmit={(e) => e.preventDefault()}>
        <label>Duty (%) <input type="number" min="0" max={maxDuty} step="1" value={duty} disabled={blocked || !operator} onChange={(e) => { setDuty(e.target.value); setConfirm(false); }} aria-label="Duty percent" /></label>
        <input type="range" min="0" max={maxDuty} step="1" value={duty === '' ? 0 : duty} disabled={blocked || !operator} onChange={(e) => { setDuty(e.target.value); setConfirm(false); }} aria-label="Duty slider (nothing is sent until you press START)" />
        <div className="tq-row">
          <button type="button" className="tq-btn tq-primary" data-testid="btn-start" disabled={blocked || busy || !operator || dutyBad}
            onClick={() => (confirm ? (setConfirm(false), send({ action: 'START', duty_pct: Number(duty) })()) : setConfirm(true))}>{confirm ? 'Confirm START' : 'START'}</button>
          {confirm && <button type="button" className="tq-btn" onClick={() => setConfirm(false)}>Cancel</button>}
        </div>
        <label>Speed setpoint (rpm) <input type="number" min="0" value={rpm} disabled={blocked || !operator} onChange={(e) => setRpm(e.target.value)} aria-label="Speed setpoint rpm" /></label>
        <button type="button" className="tq-btn" data-testid="btn-speed" disabled={blocked || busy || !operator || rpm === ''} onClick={send({ action: 'SET_SPEED', rpm: Number(rpm) })}>Apply speed</button>
      </form>
      <p className="tq-muted">Forward only: the firmware never drives the reverse output.</p>
      <div className={`tq-avail ${blocked ? 'locked' : 'open'}`} role="status" data-testid="availability">
        <Pill tone={blocked ? 'warn' : 'ok'}>{blocked ? 'START / speed unavailable' : 'START / speed available'}</Pill>
        {blocked
          ? <span data-testid="why-disabled">{blockers[0]}</span>
          : <span className="tq-muted">Requests still pass the Safety Supervisor and the firmware's own checks.</span>}
        {blocked && blockers.length > 1 && <details><summary>{blockers.length - 1} more</summary><ul className="tq-list" data-testid="phys-blockers">{blockers.map((b) => <li key={b}>{b}</li>)}</ul></details>}
        {blocked && blockers.length === 1 && <ul className="tq-sr" data-testid="phys-blockers"><li>{blockers[0]}</li></ul>}
      </div>
      {!operator && <p className="tq-muted">Your role ({role}) can request STOP only.</p>}
      <ErrorBox error={err} />
      {rec && <p className="tq-callout" data-testid="last-command">#{rec.id} {rec.action}: <Pill tone={STATE_TONE[rec.state] || 'info'}>{rec.state}</Pill> {(rec.reasons || []).join(' · ') || rec.ack_reason || ''}</p>}
    </Card>
  );
}

export function PhysicalOverview({ stream, go, role }) {
  const { snap } = stream;
  if (!snap) return <><PageHead title="Motor" /><Empty>Loading the device state…</Empty></>;
  const live = isLive(snap);
  const vals = snap.values || {};
  return (
    <>
      <PageHead title="Motor" sub="Real-time physical device" />
      <StatusStrip snap={snap} />
      {!live && (
        <div className="tq-callout crit" role="alert" data-testid="phys-disconnected">
          <strong>{snap.connection === 'DISCONNECTED' ? 'DEVICE DISCONNECTED' : (snap.state_label || snap.connection)}</strong>
          <p>Physical readings are unavailable. {snap.error?.message || ''} {snap.connection === 'DISCONNECTED' ? (snap.autoconnect?.note || '') : ''}
            {snap.autoconnect?.last_error ? ` Last automatic attempt failed: ${snap.autoconnect.last_error}` : ''}</p>
          <button className="tq-btn tq-primary" onClick={() => go('device')}>Connect a device</button>
        </div>)}
      <div className="tq-split">
        <MotionPanel stream={stream} role={role} />
        <Card title="Live measurements" id="p-meas">
          <div className="tq-kpis" data-testid="phys-kpis">
            {TILES.map(([k, l, u, d]) => <Tile key={k} label={l} unit={u} d={d} v={live ? vals[k] : null} />)}
          </div>
        </Card>
      </div>
      {live && <details data-testid="live-trends"><summary>Live trends</summary><DeviceLive stream={stream} /></details>}
    </>
  );
}

export function PhysicalSafetyPage({ stream, role }) {
  const { snap, commands } = stream;
  return (
    <>
      <PageHead title="Safety & Commissioning" sub="The commissioning record and command history. Operating controls are on the Overview page." />
      <details><summary>Commissioning record</summary><CommissioningCard role={role} /></details>
      <Card title="Command history" id="p-hist">
        {!(commands || []).length ? <Empty>No commands requested in this session.</Empty> : (
          <table className="tq-table"><caption className="tq-sr">Device command history</caption>
            <thead><tr><th scope="col">#</th><th scope="col">Action</th><th scope="col">By</th><th scope="col">State</th><th scope="col">Detail</th></tr></thead>
            <tbody>{commands.slice(0, 20).map((c) => (<tr key={c.id}><td className="tq-num">{c.id}</td><td>{title(c.action)}</td><td>{c.requested_by}</td><td><Pill tone={STATE_TONE[c.state] || 'info'}>{title(c.state)}</Pill></td><td className="tq-muted">{(c.reasons || []).join(' · ') || c.ack_reason}</td></tr>))}</tbody></table>)}
      </Card>
    </>
  );
}

export function PhysicalLive({ stream }) {
  const { snap } = stream;
  const live = isLive(snap);
  return (
    <>
      <PageHead title="Live Monitor" sub="Charts of real device measurements; gaps are shown, nothing is interpolated or simulated."
        right={<Pill tone={live ? (snap.telemetry_fresh ? 'ok' : 'warn') : 'off'}>{live ? (snap.telemetry_fresh ? 'LIVE' : 'STALE') : 'DEVICE DISCONNECTED'}</Pill>} />
      {!live ? <div className="tq-callout crit" role="alert" data-testid="phys-live-empty"><strong>DEVICE DISCONNECTED</strong><p>Physical readings are unavailable, so there is nothing to chart.</p></div>
        : <DeviceLive stream={stream} />}
    </>
  );
}

const LAYER_TEXT = {
  C1: ['AI Diagnostics (C1)', 'Anomaly detection on real measurements.'],
  HYPOTHESES: ['Fault hypotheses', 'Competing fault explanations from real evidence.'],
  C2: ['Predictions (C2)', 'Predictions from valid physical inputs, with uncertainty.'],
  C3: ['Interventions (C3)', 'Every physical intervention is decided by the deterministic Safety Supervisor; an AI result can never authorise motion.'],
  C4: ['Diagnostic Tests (C4)', 'Diagnostic tests based on real evidence.'],
  C5: ['Recovery (C5)', 'Recovery verified from observed telemetry after an intervention.'],
  C6: ['Learning (C6)', 'Outcome records with provenance; no learning from unverified data, no model change without approval.'],
};

export function PhysicalAiPage({ stream, layer, go }) {
  const { snap } = stream;
  const [t, sub] = LAYER_TEXT[layer];
  const a = snap?.analysis;
  const l = a?.layers?.[layer];
  return (
    <>
      <PageHead title={t} sub={sub} right={<Pill tone="off">physical data basis: {l?.basis || 'none'}</Pill>} />
      <Card title="Status" id={`p-${layer}`}>
        <div className="tq-callout" data-testid={`layer-${layer}`}><strong>{l?.status || WAITING}</strong><p>{l?.reason || 'No device state is available yet.'}</p></div>
        {a?.missing_inputs?.length > 0 && <p className="tq-muted">Inputs the physical device cannot supply: {a.missing_inputs.join(', ')}.</p>}
        {layer === 'C3' && <button className="tq-btn" onClick={() => go('overview')}>Open the motor controls</button>}
      </Card>
    </>
  );
}
