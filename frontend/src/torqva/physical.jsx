import React, { useState } from 'react';
import { Usb, Octagon, Play, StopCircle, Sliders, AlertTriangle, CheckCircle2, ShieldCheck, Activity } from 'lucide-react';
import { api } from './api.js';
import { Card, Empty, ErrorBox, Pill, ProvBadge, fmt } from './components.jsx';
import { PageHead } from './pages.jsx';
import { DeviceLive, CommissioningCard, canOperate, STATE_TONE } from './device.jsx';

const WAITING = 'WAITING FOR VALID PHYSICAL TELEMETRY';
const ago = (unix) => (unix ? `${fmt(Math.max(0, Date.now() / 1000 - unix), 1)} s ago` : 'never');
const title = (s) => String(s ?? '').replaceAll('_', ' ');
const isLive = (snap) => !!(snap?.handshake && snap?.origin === 'physical_device');

/** Explicit, operator-selected application mode. Physical is the default; simulation is never entered automatically. */
export function ModeSwitch({ mode, onChange }) {
  return (
    <div className="tq-mode-switch tq-row" role="group" aria-label="Application mode" data-testid="mode-switch">
      <button
        type="button"
        className={`tq-btn tq-mode-btn ${mode === 'PHYSICAL' ? 'active' : ''}`}
        aria-pressed={mode === 'PHYSICAL'}
        onClick={() => onChange('PHYSICAL')}
      >
        Physical mode
      </button>
      <button
        type="button"
        className={`tq-btn tq-mode-btn ${mode === 'SIMULATION' ? 'active' : ''}`}
        aria-pressed={mode === 'SIMULATION'}
        onClick={() => onChange('SIMULATION')}
      >
        Simulation mode (demo)
      </button>
    </div>
  );
}

/** Compact, dynamic: connection state and motion availability status. */
export function PhysicalBanner({ snap }) {
  const live = isLive(snap);
  const label = live
    ? (snap.telemetry_fresh ? 'PHYSICAL DEVICE CONNECTED' : 'PHYSICAL DEVICE - TELEMETRY STALE')
    : snap?.handshake
    ? 'DEVICE (FIRMWARE SIMULATION MODE)'
    : (!snap || snap.connection === 'DISCONNECTED')
    ? 'DEVICE DISCONNECTED'
    : snap.state_label || snap.connection;
  const blockers = snap?.control_blockers || [];
  const detail = !live
    ? 'Physical readings are unavailable.'
    : blockers.length
    ? `Motion unavailable: ${blockers[0]}${blockers.length > 1 ? ` (+${blockers.length - 1} more)` : ''}`
    : 'Motion permitted through deterministic supervisor.';

  return (
    <div className={`tq-banner ${live ? 'live' : 'offline'}`} role="status" aria-live="polite" data-testid="phys-banner">
      <div className="tq-banner-content">
        <span className={`tq-dot ${live ? (snap.telemetry_fresh ? 'ok' : 'warn') : 'crit'}`} />
        <strong>{label}</strong>
        <span className="tq-banner-sep">·</span>
        <span className="tq-banner-detail">{detail}</span>
      </div>
    </div>
  );
}

function sensorSummary(sens) {
  const e = Object.entries(sens || {}).filter(([k]) => k !== 'vibration_rms' && k !== 'ambient' && k !== 'voltage' && k !== 'power');
  const bad = e.filter(([, s]) => s !== 'valid');
  return { total: e.length, valid: e.length - bad.length, bad };
}

/** Concise single status area for active faults, connection health, and physical blockers. */
export function StatusStrip({ snap }) {
  const live = isLive(snap);
  const ss = sensorSummary(snap?.sensor_status);
  const blockers = snap?.control_blockers || [];
  const fault = !live
    ? ['off', 'fault state unknown']
    : snap.safety_state === 'OK'
    ? ['ok', 'no active fault']
    : snap.safety_state === 'EMERGENCY_STOP'
    ? ['stop', `LATCHED: ${title(snap.trip_reason)}`]
    : ['warn', snap.safety_state || 'unknown'];

  return (
    <div className="tq-status-strip" data-testid="status-strip">
      <div className="tq-status-row">
        <Pill tone={live ? (snap.telemetry_fresh ? 'ok' : 'warn') : snap?.connection === 'ERROR' ? 'crit' : 'off'}>
          {snap?.state_label || (live ? 'Connected' : 'DEVICE DISCONNECTED')}
        </Pill>
        {snap?.handshake && (
          <Pill tone="ok">
            {`handshake ok · ${snap.device_id || '—'} · fw ${snap.firmware || '—'}`}
          </Pill>
        )}
        <Pill tone={!live ? 'off' : ss.bad.length ? 'warn' : 'ok'}>
          {!live ? 'sensors unknown' : `sensors ${ss.valid}/${ss.total} valid`}
        </Pill>
        <Pill tone={fault[0]}>{fault[1]}</Pill>
        {live && snap.estop_input && (
          <Pill tone={snap.estop_input.state === 2 ? 'ok' : snap.estop_input.state === 1 ? 'stop' : 'warn'}>
            {`E-stop input: ${String(snap.estop_input.label || 'unknown').split(' (')[0].toLowerCase()}`}
          </Pill>
        )}
        {live && snap.transport_label && (
          <Pill tone={snap.session?.active ? 'info' : 'warn'}>{snap.transport_label}</Pill>
        )}
        {live && snap.config && (
          <Pill tone={snap.config.confirmed ? 'ok' : 'warn'}>
            {snap.config.confirmed ? `limits v${snap.config.device_version} confirmed by the device` : snap.config.approved_version ? `limits v${snap.config.approved_version} awaiting the device` : 'no limits approved'}
          </Pill>
        )}
        <Pill tone={blockers.length ? 'stop' : 'info'}>
          {blockers.length ? `motion locked: ${blockers[0]}` : 'motion permitted'}
        </Pill>
        {snap?.last_rx_unix ? (
          <span className="tq-status-time tq-num">
            last telemetry {ago(snap.last_rx_unix)}
          </span>
        ) : null}
      </div>

      {live && snap.config?.confirmed && snap.config.limits && (
        <p className="tq-status-limits" data-testid="accepted-limits">
          Accepted limits: {snap.config.limits.max_current_a} A · {snap.config.limits.max_temp_c} °C · {snap.config.limits.max_rpm} rpm · {snap.config.limits.max_duty_pct} % duty
        </p>
      )}
      {live && ss.bad.length > 0 && (
        <p className="tq-status-limits" data-testid="sensor-gaps">
          {ss.bad.map(([k, s]) => `${k.replaceAll('_', ' ')}: ${s}`).join(' · ')}
        </p>
      )}
    </div>
  );
}

const TILES = [
  ['rpm', 'Measured speed (Hall)', 'rpm', 0],
  ['current', 'Current', 'A', 3],
  ['housing', 'Motor temperature', '°C', 1],
  ['voltage', 'DC Bus Voltage', 'V', 1],
  ['power', 'Motor Power', 'W', 1],
  ['acceleration', 'Total acceleration (incl. gravity)', 'g', 3],
];

function Tile({ label, unit, d, v }) {
  const has = v && v.valid && v.value != null;
  return (
    <div className={`tq-kpi ${has ? '' : 'tq-unavailable'}`} data-testid={`tile-${label}`}>
      <div className="tq-kpi-label">
        <span>{label}</span>
        <ProvBadge kind={has ? "MEASURED" : "DERIVED"} />
      </div>
      <div className={`tq-kpi-value tq-num ${has ? '' : 'tq-na'}`}>
        {has ? `${fmt(v.value, d)} ` : 'UNAVAILABLE'}
        {has && <span className="tq-kpi-unit">{unit}</span>}
      </div>
      <div className="tq-kpi-freshness">
        {!v ? (
          <span className="tq-kpi-status-tag off">No Reading</span>
        ) : !v.valid ? (
          <span className="tq-kpi-status-tag invalid">Sensor Invalid</span>
        ) : v.stale ? (
          <span className="tq-kpi-status-tag stale">STALE · {ago(v.received_unix)}</span>
        ) : (
          <span className="tq-kpi-status-tag live">Live · {ago(v.received_unix)}</span>
        )}
      </div>
    </div>
  );
}

/** Unified Motor Control Section: State First, Operational Controls Second, Condition/Blocker Third. */
export function MotionPanel({ stream, role }) {
  const { snap, commands } = stream;
  const [duty, setDuty] = useState('0');
  const [rpm, setRpm] = useState('1200');
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
  const maxRpm = snap?.control_limits?.max_rpm ?? 3000;

  const send = (body) => async () => {
    setBusy(true);
    setErr(null);
    try {
      setLast(await api.deviceCommand(body));
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
      stream.refresh();
    }
  };

  const rec = (last && (commands || []).find((c) => c.id === last.id)) || last;
  const vals = snap?.values || {};
  const motor = !live || !snap.telemetry_fresh ? 'UNKNOWN' : snap.drive === 'IDLE' ? 'STOPPED' : snap.drive ? 'RUNNING' : 'UNKNOWN';
  const dutyBad = duty === '' || !(Number(duty) > 0 && Number(duty) <= maxDuty);

  return (
    <Card title="Motor Control & Operating Panel" id="p-motion" right={<Pill tone={motor === 'RUNNING' ? 'ok' : motor === 'STOPPED' ? 'info' : 'off'}>{motor}</Pill>}>
      {/* 1. MOTOR STATE FIRST */}
      <div className="tq-motor-state-box" data-testid="motor-state">
        <div className="tq-motor-state-header">
          <span className="tq-motor-state-label">Motor State</span>
          <strong className={`tq-motor-state-value ${motor.toLowerCase()}`}>
            {motor}{!live ? ' - no live telemetry' : ''}
          </strong>
        </div>
        <div className="tq-motor-state-grid">
          <div className="tq-motor-state-item">
            <span className="tq-muted">Commanded Duty</span>
            <strong className="tq-num">{live && vals.duty?.value != null ? `${fmt(vals.duty.value, 1)} %` : '—'}</strong>
          </div>
          <div className="tq-motor-state-item">
            <span className="tq-muted">Measured Speed (Hall)</span>
            <strong className="tq-num">{live && vals.rpm?.valid && vals.rpm.value != null ? `${fmt(vals.rpm.value, 0)} rpm` : 'UNAVAILABLE'}</strong>
          </div>
          <div className="tq-motor-state-item">
            <span className="tq-muted">Drive Direction</span>
            <span>Forward Only (Unidirectional)</span>
          </div>
        </div>
      </div>

      {/* Prominent Emergency STOP button */}
      <div className="tq-motion-stop-bar">
        <button
          type="button"
          className="tq-btn tq-danger tq-stop-prominent"
          disabled={!connected || busy}
          onClick={send({ action: 'STOP' })}
          data-testid="btn-stop"
          aria-label="Emergency Stop"
        >
          <Octagon size={18} aria-hidden="true" />
          <span>STOP MOTOR</span>
        </button>
      </div>
      {!connected && <p className="tq-muted" style={{ fontSize: 12 }}>STOP cannot be delivered: device is disconnected.</p>}

      {/* 2. OPERATIONAL CONTROLS SECOND */}
      <div className="tq-motion-controls-grid">
        {/* Closed-loop Speed Setpoint */}
        <div className="tq-control-card">
          <div className="tq-control-card-header">
            <strong>Speed Control (Closed Loop)</strong>
            <span className="tq-muted">0 – {maxRpm} rpm</span>
          </div>
          <div className="tq-control-card-inputs">
            <label className="tq-inline" style={{ width: '100%' }}>
              <span className="tq-muted" style={{ fontSize: 12 }}>Target Speed (rpm)</span>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input
                  type="number"
                  min="0"
                  max={maxRpm}
                  step="10"
                  value={rpm}
                  disabled={blocked || !operator}
                  onChange={(e) => setRpm(e.target.value)}
                  aria-label="Speed setpoint rpm"
                  placeholder="e.g. 1200"
                  style={{ width: '100px' }}
                />
                <input
                  type="range"
                  min="0"
                  max={maxRpm}
                  step="25"
                  value={rpm === '' ? 0 : rpm}
                  disabled={blocked || !operator}
                  onChange={(e) => setRpm(e.target.value)}
                  aria-label="Speed slider"
                  style={{ flex: 1 }}
                />
              </div>
            </label>
            <button
              type="button"
              className="tq-btn tq-primary"
              data-testid="btn-speed"
              disabled={blocked || busy || !operator || rpm === '' || Number(rpm) <= 0}
              onClick={send({ action: 'SET_SPEED', rpm: Number(rpm) })}
            >
              <Play size={14} aria-hidden="true" />
              Apply Speed {rpm ? `(${rpm} rpm)` : ''}
            </button>
          </div>
        </div>

        {/* Open-loop Duty Control */}
        <div className="tq-control-card">
          <div className="tq-control-card-header">
            <strong>Duty Cycle (Open Loop)</strong>
            <span className="tq-muted">0 – {maxDuty}%</span>
          </div>
          <div className="tq-control-card-inputs">
            <label className="tq-inline" style={{ width: '100%' }}>
              <span className="tq-muted" style={{ fontSize: 12 }}>Duty Percentage (%)</span>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input
                  type="number"
                  min="0"
                  max={maxDuty}
                  step="1"
                  value={duty}
                  disabled={blocked || !operator}
                  onChange={(e) => { setDuty(e.target.value); setConfirm(false); }}
                  aria-label="Duty percent"
                  style={{ width: '100px' }}
                />
                <input
                  type="range"
                  min="0"
                  max={maxDuty}
                  step="1"
                  value={duty === '' ? 0 : duty}
                  disabled={blocked || !operator}
                  onChange={(e) => { setDuty(e.target.value); setConfirm(false); }}
                  aria-label="Duty slider (nothing is sent until you press START)"
                  style={{ flex: 1 }}
                />
              </div>
            </label>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                type="button"
                className="tq-btn tq-primary"
                data-testid="btn-start"
                disabled={blocked || busy || !operator || dutyBad}
                onClick={() => (confirm ? (setConfirm(false), send({ action: 'START', duty_pct: Number(duty) })()) : setConfirm(true))}
              >
                <Play size={14} aria-hidden="true" />
                {confirm ? 'Confirm START' : `START (${duty || 0}%)`}
              </button>
              {confirm && (
                <button type="button" className="tq-btn" onClick={() => setConfirm(false)}>
                  Cancel
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* 3. AVAILABILITY, CONDITION AND SAFETY BLOCKERS */}
      <div className={`tq-avail ${blocked ? 'locked' : 'open'}`} role="status" data-testid="availability">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <Pill tone={blocked ? 'warn' : 'ok'}>
            {blocked ? 'START / speed unavailable' : 'START / speed available'}
          </Pill>
          {blocked ? (
            <strong data-testid="why-disabled" style={{ fontSize: 13, color: 'var(--tq-warn)' }}>
              {blockers[0]}
            </strong>
          ) : (
            <span className="tq-muted" style={{ fontSize: 12 }}>
              Verified against Safety Supervisor limits and firmware sequence checks.
            </span>
          )}
        </div>
        {blocked && blockers.length > 1 && (
          <details style={{ marginTop: 6, fontSize: 12 }}>
            <summary className="tq-muted">{blockers.length - 1} additional condition(s)</summary>
            <ul className="tq-list" data-testid="phys-blockers" style={{ marginTop: 4 }}>
              {blockers.map((b) => <li key={b}>{b}</li>)}
            </ul>
          </details>
        )}
        {blocked && blockers.length === 1 && (
          <ul className="tq-sr" data-testid="phys-blockers"><li>{blockers[0]}</li></ul>
        )}
      </div>

      {!operator && <p className="tq-muted" style={{ fontSize: 12, marginTop: 8 }}>Your role ({role}) can request STOP only.</p>}
      <ErrorBox error={err} />
      {rec && (
        <div className="tq-callout ok" data-testid="last-command" style={{ marginTop: 10 }}>
          <strong>Command #{rec.id} {rec.action}:</strong> <Pill tone={STATE_TONE[rec.state] || 'info'}>{rec.state}</Pill>
          {' '}{(rec.reasons || []).join(' · ') || rec.ack_reason || ''}
        </div>
      )}
    </Card>
  );
}

export function PhysicalOverview({ stream, go, role }) {
  const { snap } = stream;
  if (!snap) return <><PageHead title="Motor" /><Empty>Loading device state…</Empty></>;
  const live = isLive(snap);
  const vals = snap.values || {};

  return (
    <>
      <PageHead title="Motor Control Dashboard" sub="Real-time physical device monitoring & supervision on ESP32-S3 hardware." />
      <StatusStrip snap={snap} />

      {!live && (
        <div className="tq-callout crit" role="alert" data-testid="phys-disconnected">
          <strong>{snap.connection === 'DISCONNECTED' ? 'DEVICE DISCONNECTED' : (snap.state_label || snap.connection)}</strong>
          <p>
            Physical readings are unavailable. {snap.error?.message || ''} {snap.connection === 'DISCONNECTED' ? (snap.autoconnect?.note || '') : ''}
            {snap.autoconnect?.last_error ? ` Last automatic attempt failed: ${snap.autoconnect.last_error}` : ''}
          </p>
          <button className="tq-btn tq-primary" onClick={() => go('device')} style={{ marginTop: 8 }}>
            Connect a device
          </button>
        </div>
      )}

      <div className="tq-split">
        <MotionPanel stream={stream} role={role} />
        <Card title="Live Sensor Telemetry" id="p-meas">
          <div className="tq-kpis" data-testid="phys-kpis">
            {TILES.map(([k, l, u, d]) => <Tile key={k} label={l} unit={u} d={d} v={live ? vals[k] : null} />)}
          </div>
        </Card>
      </div>

      {live && (
        <div style={{ marginTop: 16 }}>
          <details data-testid="live-trends">
            <summary style={{ cursor: 'pointer', fontWeight: 600, fontSize: 13, color: 'var(--tq-muted)' }}>
              Telemetry Trend History
            </summary>
            <div style={{ marginTop: 10 }}>
              <DeviceLive stream={stream} />
            </div>
          </details>
        </div>
      )}
    </>
  );
}

export function PhysicalSafetyPage({ stream, role }) {
  const { snap, commands } = stream;
  return (
    <>
      <PageHead title="Safety & Commissioning" sub="The commissioning record and command history. Operating controls are on the Dashboard." />
      <details><summary style={{ cursor: 'pointer', fontWeight: 600, fontSize: 13, marginBottom: 12 }}>Commissioning record</summary><CommissioningCard role={role} /></details>
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
  HYPOTHESES: ['Fault Hypotheses', 'Competing fault explanations from real evidence.'],
  C2: ['Predictions (C2)', 'Predictions from valid physical inputs, with uncertainty.'],
  C3: ['Interventions (C3)', 'Every physical intervention is decided by the deterministic Safety Supervisor; an AI result can never authorise motion.'],
  C4: ['Diagnostic Tests (C4)', 'Diagnostic tests based on real evidence.'],
  C5: ['Recovery (C5)', 'Recovery verified from observed telemetry after an intervention.'],
  C6: ['Learning (C6)', 'Outcome records with provenance; no learning from unverified data, no model change without approval.'],
};

export function PhysicalAiPage({ stream, layer, go }) {
  const { snap } = stream;
  const layerInfo = LAYER_TEXT[layer] || [layer, ''];
  const [t, sub] = layerInfo;
  const a = snap?.analysis;
  const l = a?.layers?.[layer];
  const live = isLive(snap);
  const connected = snap && snap.connection && snap.connection !== 'DISCONNECTED';

  // Determine the correct callout tone from backend layer status
  const statusTone = !l
    ? (connected ? 'info' : 'off')
    : l.status === WAITING || l.status === 'NOT AVAILABLE' || l.status === 'physical motion BLOCKED'
    ? 'warn'
    : ['ACTIVE', 'READY', 'AVAILABLE', 'VERIFIED'].includes(l.status)
    ? 'ok'
    : 'info';

  const statusMsg = l?.status || (connected ? WAITING : 'DEVICE DISCONNECTED');
  const reasonMsg = l?.reason
    || (connected ? 'Device is connected. Waiting for valid telemetry frames to activate this layer.'
        : 'Connect a physical device on the Device page to activate this layer.');

  return (
    <>
      <PageHead
        title={t}
        sub={sub}
        right={<Pill tone={live ? 'ok' : 'off'}>physical data basis: {l?.basis || 'none'}</Pill>}
      />
      <Card title="Layer Status" id={`p-${layer}`}>
        <div className={`tq-callout ${statusTone}`} data-testid={`layer-${layer}`}>
          <strong>{statusMsg}</strong>
          <p>{reasonMsg}</p>
        </div>
        {a?.missing_inputs?.length > 0 && (
          <p className="tq-muted" style={{ marginTop: 8 }}>
            Inputs the physical device cannot supply: {a.missing_inputs.join(', ')}.
          </p>
        )}
        {!connected && (
          <button className="tq-btn tq-primary" onClick={() => go('device')} style={{ marginTop: 10 }}>
            Connect a device
          </button>
        )}
        {layer === 'C3' && connected && (
          <button className="tq-btn" onClick={() => go('overview')} style={{ marginTop: 10 }}>
            Open the motor controls
          </button>
        )}
      </Card>
      {live && (
        <Card title="Live physical telemetry streaming" id={`p-${layer}-live`} style={{ marginTop: 14 }}>
          <DeviceLive stream={stream} />
        </Card>
      )}
    </>
  );
}
