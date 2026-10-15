import React, { useEffect, useRef, useState } from 'react';
import { Usb, Octagon, Play, StopCircle, Sliders, AlertTriangle, CheckCircle2, ShieldCheck, Activity, FlaskConical, Unplug, Hourglass, Bell, BellOff, Gauge, Zap, Thermometer, Plug, Move3d, Lock, Unlock } from 'lucide-react';
import { api } from '../api.js';
import { Card, Empty, ErrorBox, Pill, ProvBadge, fmt, useNavContext, PageHead } from '../shared/components.jsx';
import { DeviceLive, CommissioningCard, canOperate, STATE_TONE } from './device.jsx';

const WAITING = 'WAITING FOR VALID PHYSICAL TELEMETRY';
const ago = (unix) => (unix ? `${fmt(Math.max(0, Date.now() / 1000 - unix), 1)} s ago` : 'never');
const title = (s) => String(s ?? '').replaceAll('_', ' ');
const isLive = (snap) => !!(snap?.handshake && snap?.origin === 'physical_device');

// ── Speed classification ─────────────────────────────────────────────────────
// Nominal operating point: 1300 rpm
//   IDLE     : motor stopped / ready (drive === 'IDLE' and rpm < 50) → silence
//   NORMAL   : 1100 – 1500 rpm (~1300 rpm nominal)                  → optimal, silence
//   WARNING  : 700–1099 rpm or 1501–1900 rpm                        → 1 beep every 3 s
//   CRITICAL : < 700 rpm (stall/overload) or > 1900 rpm (overspeed) → 3 rapid beeps every 1.5 s
//   UNKNOWN  : the drive is active but the Hall reading is invalid or missing → the speed is unknown, never 0 (1 beep every 3 s)
export function classifyRpm(rpm, isRunning) {
  if (!isRunning) return 'IDLE';
  if (rpm === null || rpm === undefined || !Number.isFinite(Number(rpm))) return 'UNKNOWN';
  const r = Number(rpm);
  if (r >= 1100 && r <= 1500) return 'NORMAL';
  if ((r >= 700 && r < 1100) || (r > 1500 && r <= 1900)) return 'WARNING';
  return 'CRITICAL';
}

export const ZONE_META = {
  IDLE:     { label: 'IDLE',     color: 'var(--tq-accent)', desc: 'Motor stopped or ready — no alert active' },
  NORMAL:   { label: 'NORMAL',   color: 'var(--tq-ok)',    desc: 'Speed in optimal range (~1300 rpm nominal: 1100–1500 rpm)' },
  WARNING:  { label: 'WARNING',  color: 'var(--tq-warn)',  desc: 'Speed deviating from 1300 rpm normal range (700–1099 or 1501–1900 rpm)' },
  CRITICAL: { label: 'CRITICAL', color: 'var(--tq-crit)',  desc: 'Speed critically out of range (<700 rpm stall or >1900 rpm overspeed)' },
  UNKNOWN:  { label: 'SPEED UNAVAILABLE', color: 'var(--tq-warn)', desc: 'The drive is active but the Hall speed reading is invalid or missing: the speed is unknown, not zero' },
};

// ── Web Audio beeper ─────────────────────────────────────────────────────────
function playBeep(ctx, freq, durationMs, gainVal) {
  if (!ctx) return;
  try {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = freq;
    osc.type = 'sine';
    gain.gain.setValueAtTime(gainVal, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + durationMs / 1000);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + durationMs / 1000 + 0.05);
  } catch (_) { /* audio unavailable in environment */ }
}

function useAlarm(zone) {
  const ctxRef = useRef(null);
  const timerRef = useRef(null);
  const zoneRef = useRef(zone);
  zoneRef.current = zone;

  useEffect(() => {
    const getCtx = () => {
      if (!ctxRef.current) {
        try {
          const AudioCtx = window.AudioContext || window.webkitAudioContext;
          if (AudioCtx) ctxRef.current = new AudioCtx();
        } catch (_) { /**/ }
      }
      if (ctxRef.current && ctxRef.current.state === 'suspended') {
        ctxRef.current.resume().catch(() => {});
      }
      return ctxRef.current;
    };
    const clear = () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };

    if (zone === 'WARNING' || zone === 'UNKNOWN') {
      clear();
      // Single warning beep every 3 seconds (660 Hz)
      timerRef.current = setInterval(() => {
        if (zoneRef.current !== zone) { clear(); return; }
        playBeep(getCtx(), 660, 160, 0.15);
      }, 3000);
    } else if (zone === 'CRITICAL') {
      clear();
      // Triple urgent beep every 1.5 seconds (1200 Hz)
      timerRef.current = setInterval(() => {
        if (zoneRef.current !== 'CRITICAL') { clear(); return; }
        const ctx = getCtx();
        playBeep(ctx, 1200, 90, 0.25);
        setTimeout(() => playBeep(ctx, 1200, 90, 0.25), 150);
        setTimeout(() => playBeep(ctx, 1200, 90, 0.25), 300);
      }, 1500);
    } else {
      clear();
    }

    return clear;
  }, [zone]);
}

// ── Speed Status banner ───────────────────────────────────────────────────────
export function SpeedStatus({ rpm, isRunning, muted, onToggleMute }) {
  const zone = classifyRpm(rpm, isRunning);
  useAlarm(muted ? 'IDLE' : zone);
  const meta = ZONE_META[zone];
  const known = zone !== 'UNKNOWN' && rpm !== null && rpm !== undefined;

  return (
    <div data-testid="speed-status" role="status" aria-live="polite" className={`tq-speed tq-speed--${zone}`}>
      <span className="tq-speed-dot" aria-hidden="true" />
      <strong className="tq-speed-zone">{meta.label}</strong>
      <span className="tq-speed-rpm tq-num">{known ? <>{Number(rpm).toFixed(0)}<small>rpm</small></> : 'UNAVAILABLE'}</span>
      <span className="tq-speed-desc">{meta.desc}</span>
      <span className="tq-speed-bands">{'Normal 1100–1500 · Warn 700–1099/1501–1900 · Crit <700/>1900'}</span>
      <button type="button" className="tq-btn tq-ghost" onClick={onToggleMute} aria-pressed={muted} title={muted ? 'Unmute alarms' : 'Mute alarms'}>
        {muted ? <><BellOff size={14} aria-hidden="true" /> Muted</> : <><Bell size={14} aria-hidden="true" /> Alarm on</>}
      </button>
    </div>
  );
}


/** Explicit, operator-selected application mode. Physical is the default; simulation is never entered automatically. */
export function ModeSwitch({ mode, onChange }) {
  return (
    <div className="tq-seg" role="group" aria-label="Application mode" data-testid="mode-switch">
      <button type="button" className="tq-btn" aria-pressed={mode === 'PHYSICAL'} onClick={() => onChange('PHYSICAL')}><Usb size={14} aria-hidden="true" />Physical mode</button>
      <button type="button" className="tq-btn" aria-pressed={mode === 'SIMULATION'} onClick={() => onChange('SIMULATION')}><FlaskConical size={14} aria-hidden="true" />Simulation mode (demo)</button>
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
    <div className={`tq-banner tq-banner--${live ? (snap.telemetry_fresh ? 'ok' : 'warn') : snap?.handshake ? 'warn' : snap?.connection === 'ERROR' ? 'crit' : 'off'}`} role="status" aria-live="polite" data-testid="phys-banner">
      <span className="tq-banner-dot" aria-hidden="true" />
      <strong>{label}</strong>
      <span className="tq-banner-sep" aria-hidden="true">·</span>
      <span>{detail}</span>
    </div>
  );
}

// Map raw backend sensor_status strings to user-facing labels
const SENSOR_FAULT_LABEL = {
  invalid: 'SENSOR FAULT',
  unavailable: 'NOT CONNECTED',
  stale: 'STALE — NO UPDATES',
  missing: 'NO READING',
};
const SENSOR_DISPLAY_NAME = {
  rpm: 'Speed (Hall sensor)',
  current: 'Current',
  housing: 'Motor temperature',
  acceleration: 'Accelerometer',
  ambient: 'Ambient temperature',
  vibration_rms: 'Vibration RMS',
  duty: 'Drive duty',
  setpoint: 'Setpoint',
};
// All sensors — nothing is silently excluded from the fault count
function sensorSummary(sens) {
  const e = Object.entries(sens || {});
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

  const connTone = live ? (snap.telemetry_fresh ? 'ok' : 'warn') : snap?.connection === 'ERROR' ? 'crit' : 'off';
  const sensTone = !live ? 'off' : ss.bad.length ? 'warn' : 'ok';
  const MotionIcon = blockers.length ? Lock : Unlock;
  return (
    <div className="tq-status-strip tq-status-v2" data-testid="status-strip">
      <div className="tq-summary" aria-label="Device status">
        <div className="tq-summary-cell">
          <span className={`tq-kpi-icon tq-${connTone}`} aria-hidden="true"><Usb size={15} /></span>
          <span className="tq-summary-label">Connection</span>
          <div className="tq-row tq-wrap-pills">
            <Pill tone={connTone}>{snap?.state_label || (live ? 'Connected' : 'DEVICE DISCONNECTED')}</Pill>
            {snap?.handshake && <Pill tone="ok">{`handshake ok · ${snap.device_id || '—'} · fw ${snap.firmware || '—'}`}</Pill>}
          </div>
          {snap?.last_rx_unix ? <span className="tq-summary-meta tq-num">last telemetry {ago(snap.last_rx_unix)}</span> : null}
        </div>
        <div className="tq-summary-cell">
          <span className={`tq-kpi-icon tq-${sensTone}`} aria-hidden="true"><Activity size={15} /></span>
          <span className="tq-summary-label">Sensors</span>
          <div className="tq-row tq-wrap-pills"><Pill tone={sensTone}>{!live ? 'sensors unknown' : `sensors ${ss.valid}/${ss.total} valid`}</Pill></div>
        </div>
        <div className="tq-summary-cell">
          <span className={`tq-kpi-icon tq-${fault[0]}`} aria-hidden="true"><ShieldCheck size={15} /></span>
          <span className="tq-summary-label">Safety</span>
          <div className="tq-row tq-wrap-pills">
            <Pill tone={fault[0]}>{fault[1]}</Pill>
            {live && snap.estop_input && (
              <Pill tone={snap.estop_input.state === 2 ? 'ok' : snap.estop_input.state === 1 ? 'stop' : 'warn'}>
                {`E-stop input: ${String(snap.estop_input.label || 'unknown').split(' (')[0].toLowerCase()}`}
              </Pill>
            )}
          </div>
        </div>
        <div className="tq-summary-cell">
          <span className={`tq-kpi-icon tq-${blockers.length ? 'stop' : 'info'}`} aria-hidden="true"><MotionIcon size={15} /></span>
          <span className="tq-summary-label">Motion</span>
          <div className="tq-row tq-wrap-pills">
            <Pill tone={blockers.length ? 'stop' : 'info'}>{blockers.length ? `motion locked: ${blockers[0]}` : 'motion permitted'}</Pill>
            {live && snap.transport_label && <Pill tone={snap.session?.active ? 'info' : 'warn'}>{snap.transport_label}</Pill>}
            {live && snap.config && (
              <Pill tone={snap.config.confirmed ? 'ok' : 'warn'}>
                {snap.config.confirmed ? `limits v${snap.config.device_version} confirmed by the device` : snap.config.approved_version ? `limits v${snap.config.approved_version} awaiting the device` : 'no limits approved'}
              </Pill>
            )}
          </div>
        </div>
      </div>

      {live && snap.config?.confirmed && snap.config.limits && (
        <p className="tq-status-limits" data-testid="accepted-limits">
          Accepted limits: {snap.config.limits.max_current_a} A · {snap.config.limits.max_temp_c} °C · {snap.config.limits.max_rpm} rpm · {snap.config.limits.max_duty_pct} % duty
        </p>
      )}
      {live && ss.bad.length > 0 && (
        <div className="tq-callout warn" role="alert" data-testid="sensor-gaps">
          <strong>⚠ {ss.bad.length} sensor{ss.bad.length > 1 ? 's' : ''} not working</strong>
          <ul>
            {ss.bad.map(([k, s]) => (
              <li key={k}>
                <strong>{SENSOR_DISPLAY_NAME[k] || k.replaceAll('_', ' ')}</strong>
                {' — '}
                <span className="tq-fault-label">
                  {SENSOR_FAULT_LABEL[s] || s.toUpperCase()}
                </span>
              </li>
            ))}
          </ul>
        </div>
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

const TILE_ICON = { rpm: Gauge, current: Zap, housing: Thermometer, ambient: Thermometer, voltage: Plug, power: Zap, acceleration: Move3d };

function Tile({ label, unit, d, v, sensorKey }) {
  const I = TILE_ICON[sensorKey] || Activity;
  const has = v && v.valid && v.value != null;
  // Specific fault label when reading is not available
  const faultLabel = !v
    ? 'UNAVAILABLE'
    : v.origin === 'unavailable'
    ? 'NOT CONNECTED'
    : !v.valid
    ? 'SENSOR FAULT'
    : v.stale
    ? 'STALE'
    : 'UNAVAILABLE';

  return (
    <div className={`tq-kpi ${has ? '' : 'tq-unavailable'}`} data-testid={`tile-${label}`}>
      <div className="tq-kpi-label">
        <span className="tq-kpi-head"><span className="tq-kpi-icon" aria-hidden="true"><I size={15} /></span><span>{label}</span></span>
        {has && <ProvBadge kind={sensorKey === 'power' ? 'DERIVED' : 'MEASURED'} />}{/* power is computed by the firmware from V x I; a missing reading has no provenance */}
      </div>
      <div className={`tq-kpi-value tq-num ${has ? '' : 'tq-na'}`}>
        {has ? `${fmt(v.value, d)} ` : faultLabel}
        {has && <span className="tq-kpi-unit">{unit}</span>}
      </div>
      <div className="tq-kpi-freshness">
        {!has ? (
          <span
            className={`tq-kpi-status-tag ${!v ? 'off' : v.origin === 'unavailable' ? 'off' : 'invalid'}`}
            title={v?.note || ''}
          >
            {!v ? 'No Reading' : faultLabel}
          </span>
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
      {!connected && <p className="tq-stop-note">STOP cannot be delivered: device is disconnected.</p>}

      {/* 2. OPERATIONAL CONTROLS SECOND */}
      <div className="tq-motion-controls-grid">
        {/* Closed-loop Speed Setpoint */}
        <div className="tq-control-card">
          <div className="tq-control-card-header">
            <strong>Speed Control (Closed Loop)</strong>
            <span className="tq-muted">0 – {maxRpm} rpm</span>
          </div>
          <div className="tq-control-card-inputs">
            <label>
              <span className="tq-muted">Target Speed (rpm)</span>
              <div className="tq-input-pair">
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
            <label>
              <span className="tq-muted">Duty Percentage (%)</span>
              <div className="tq-input-pair">
                <input
                  type="number"
                  min="0"
                  max={maxDuty}
                  step="1"
                  value={duty}
                  disabled={blocked || !operator}
                  onChange={(e) => { setDuty(e.target.value); setConfirm(false); }}
                  aria-label="Duty percent"
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
                />
              </div>
            </label>
            <div className="tq-row">
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
        <div className="tq-row">
          <Pill tone={blocked ? 'warn' : 'ok'}>
            {blocked ? 'START / speed unavailable' : 'START / speed available'}
          </Pill>
          {blocked ? (
            <strong data-testid="why-disabled">
              {blockers[0]}
            </strong>
          ) : (
            <span className="tq-muted">
              Verified against Safety Supervisor limits and firmware sequence checks.
            </span>
          )}
        </div>
        {blocked && blockers.length > 1 && (
          <details>
            <summary className="tq-muted">{blockers.length - 1} additional condition(s)</summary>
            <ul className="tq-list" data-testid="phys-blockers">
              {blockers.map((b) => <li key={b}>{b}</li>)}
            </ul>
          </details>
        )}
        {blocked && blockers.length === 1 && (
          <ul className="tq-sr" data-testid="phys-blockers"><li>{blockers[0]}</li></ul>
        )}
      </div>

      {!operator && <p className="tq-muted">Your role ({role}) can request STOP only.</p>}
      <ErrorBox error={err} />
      {rec && (
        <div className="tq-callout" data-testid="last-command">
          <strong>Command #{rec.id} {rec.action}:</strong> <Pill tone={STATE_TONE[rec.state] || 'info'}>{rec.state}</Pill>
          {' '}{(rec.reasons || []).join(' · ') || rec.ack_reason || ''}
        </div>
      )}
    </Card>
  );
}

export function PhysicalOverview({ stream, go, role }) {
  const { snap } = stream;
  const [alarmMuted, setAlarmMuted] = useState(false);
  if (!snap) return <><PageHead title="Motor" /><Empty loading>Loading device state…</Empty></>;
  const live = isLive(snap);
  const vals = snap.values || {};
  const rpm = live && vals.rpm?.valid && Number.isFinite(vals.rpm.value) ? vals.rpm.value : null;   // an invalid reading is unknown, never 0
  const isRunning = live && (snap.drive !== 'IDLE' || Number(rpm) > 50);

  return (
    <>
      <PageHead title="Motor Control Dashboard" sub="Real-time physical device monitoring &amp; supervision on ESP32-S3 hardware." />
      <StatusStrip snap={snap} />

      {/* Speed status — shows zone and sounds alarm when motor is running */}
      {live && (
        <SpeedStatus
          rpm={rpm}
          isRunning={isRunning}
          muted={alarmMuted}
          onToggleMute={() => setAlarmMuted((m) => !m)}
        />
      )}

      {!live && (
        <div className={`tq-callout tq-alert ${snap.connection === 'ERROR' ? 'crit' : 'warn'}`} role="alert" data-testid="phys-disconnected">
          <span className="tq-alert-icon" aria-hidden="true"><Unplug size={18} /></span>
          <strong>{snap.connection === 'DISCONNECTED' ? 'DEVICE DISCONNECTED' : (snap.state_label || snap.connection)}</strong>
          <p>
            Physical readings are unavailable. {snap.error?.message || ''} {snap.connection === 'DISCONNECTED' ? (snap.autoconnect?.note || '') : ''}
            {snap.autoconnect?.last_error ? ` Last automatic attempt failed: ${snap.autoconnect.last_error}` : ''}
          </p>
          <button className="tq-btn tq-primary" onClick={() => go('device')}>
            <Usb size={14} aria-hidden="true" />Connect a device
          </button>
        </div>
      )}

      <div className="tq-split">
        <MotionPanel stream={stream} role={role} />
        <Card title="Live Sensor Telemetry" id="p-meas">
          <div className="tq-kpis" data-testid="phys-kpis">
            {TILES.map(([k, l, u, d]) => (
              <Tile key={k} sensorKey={k} label={l} unit={u} d={d} v={live ? vals[k] : null} />
            ))}
          </div>
          {/* Ambient sensor — not in TILES but should always be visible with its status */}
          {live && vals.ambient && (
            <div className="tq-kpi-extra">
              <Tile
                sensorKey="ambient"
                label="Ambient temperature"
                unit="°C"
                d={1}
                v={vals.ambient}
              />
            </div>
          )}
        </Card>
      </div>

      {live && (
        <div className="tq-mt">
          <details data-testid="live-trends" className="tq-disclosure">
            <summary>
              Telemetry Trend History
            </summary>
            <div className="tq-disclosure-body">
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
      <details className="tq-disclosure"><summary>Commissioning record</summary><div className="tq-disclosure-body"><CommissioningCard role={role} /></div></details>
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
      {!live ? <div className="tq-callout tq-alert warn" role="alert" data-testid="phys-live-empty"><span className="tq-alert-icon" aria-hidden="true"><Unplug size={18} /></span><strong>DEVICE DISCONNECTED</strong><p>Physical readings are unavailable, so there is nothing to chart.</p></div>
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
  const LayerIcon = useNavContext()?.icon || Hourglass;

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
        <div className="tq-layer">
          <span className="tq-layer-icon" aria-hidden="true"><LayerIcon size={20} /></span>
          <div className={`tq-callout ${statusTone}`} data-testid={`layer-${layer}`}>
            <strong>{statusMsg}</strong>
            <p>{reasonMsg}</p>
          </div>
          {a?.missing_inputs?.length > 0 && (
            <p className="tq-muted">
              Inputs the physical device cannot supply: {a.missing_inputs.join(', ')}.
            </p>
          )}
          {!connected && (
            <div>
              <button className="tq-btn tq-primary" onClick={() => go('device')}>
                <Usb size={14} aria-hidden="true" />Connect a device
              </button>
            </div>
          )}
          {layer === 'C3' && connected && (
            <div>
              <button className="tq-btn" onClick={() => go('overview')}>
                Open the motor controls
              </button>
            </div>
          )}
        </div>
      </Card>
      {live && (
        <Card title="Live physical telemetry streaming" id={`p-${layer}-live`} className="tq-mt">
          <DeviceLive stream={stream} />
        </Card>
      )}
    </>
  );
}
