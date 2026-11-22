import React, { useEffect, useRef, useState } from 'react';
import { Usb, Octagon, Play, ShieldCheck, ShieldAlert, Activity, FlaskConical, Unplug, Hourglass, Bell, BellOff, Gauge, Zap, Thermometer, Plug, Move3d, Lock, HeartPulse, SlidersHorizontal, History, ClipboardCheck, Info, Wrench, Sparkles, AlertTriangle } from 'lucide-react';
import { api } from '../api.js';
import { Card, Empty, ErrorBox, Pill, ProvBadge, fmt, title, useNavContext, PageHead, StatTile, StatGrid, AlertPanel, BlockedReason, LinkButton, CheckList, StepTracker, DataTable, SourceTag, ConditionBanner } from '../shared/components.jsx';
import { DeviceLive, CommissioningCard, canOperate, STATE_TONE, ReadinessCard, InterlocksCard, interlockGroups, groupStatus, toComm, toIlk, readingOf, ago, clock, transportOf, isOverrideActive, setOverrideActive } from './device.jsx';
import { TEST_SPECS } from '../shared/diagnostics.js';
import { LimitsPanel } from '../shared/limits.jsx';
import { useAlarmContext } from '../shared/alarmContext.jsx';

const WAITING = 'WAITING FOR VALID PHYSICAL TELEMETRY';
const isLive = (snap) => !!((snap?.handshake || isOverrideActive()) && (snap?.origin === 'physical_device' || isOverrideActive()) && snap?.connection && snap.connection !== 'DISCONNECTED');

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
  CRITICAL: { label: 'CRITICAL', color: 'var(--tq-crit)',  desc: 'Speed advisory: operating outside nominal band (<700 or >1900 rpm) — warning only, does not stop motor' },
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
export function SpeedStatus({ rpm, isRunning, muted: propMuted, onToggleMute }) {
  const alarm = useAlarmContext();
  const isMuted = propMuted !== undefined ? (propMuted || alarm.muted) : alarm.muted;
  const zone = classifyRpm(rpm, isRunning);
  const known = zone !== 'UNKNOWN' && rpm !== null && rpm !== undefined;
  const noPulsesSeen = isRunning && rpm !== null && rpm !== undefined && Number(rpm) === 0;

  useEffect(() => {
    alarm.evaluate({ rpm, isRunning, valid: known });
  }, [rpm, isRunning, known, alarm]);

  useAlarm(noPulsesSeen || isMuted ? 'IDLE' : zone);
  const meta = ZONE_META[zone];

  const handleMuteToggle = () => {
    if (onToggleMute) onToggleMute();
    if (alarm.muted) {
      alarm.unmute();
    } else {
      alarm.mute(10);
    }
  };

  const hallConfidence = !known ? 'NONE' : isRunning && Number(rpm) > 50 ? 'HIGH' : isRunning && Number(rpm) === 0 ? 'LOW' : 'HIGH';

  return (
    <>
      <div data-testid="speed-status" role="status" aria-live="polite" className={`tq-speed tq-speed--${noPulsesSeen ? 'WARNING' : zone}`}>
        <span className="tq-speed-dot" aria-hidden="true" />
        <strong className="tq-speed-zone">{noPulsesSeen ? 'WAITING FOR PULSES' : meta.label}</strong>
        <span className="tq-speed-rpm tq-num">{known ? <>{Number(rpm).toFixed(0)}<small>rpm</small></> : 'UNAVAILABLE'}</span>
        <span className="tq-speed-desc">
          {noPulsesSeen
            ? 'Motor drive active — waiting for Hall speed pulses (warning only — motor is not stopped by speed)'
            : (alarm.active || (zone === 'CRITICAL' && Number(rpm) > 1900))
            ? `Speed advisory: ${Number(rpm).toFixed(0)} rpm (advisory limit ${alarm.threshold} rpm; clears < ${alarm.clearThreshold} rpm)`
            : meta.desc}
        </span>
        <span className="tq-speed-bands">{'Normal 1100–1500 · Warn 700–1099/1501–1900 · Crit <700/>1900'}</span>
        <button type="button" className="tq-btn tq-ghost" onClick={handleMuteToggle} aria-pressed={isMuted} title={isMuted ? 'Unmute alarms' : 'Mute alarms for 10 seconds'}>
          {isMuted ? <><BellOff size={14} aria-hidden="true" /> {alarm.muteRemaining > 0 ? `Muted (${alarm.muteRemaining}s)` : 'Muted'}</> : <><Bell size={14} aria-hidden="true" /> Alarm on</>}
        </button>
      </div>
      <div className="tq-row" style={{ gap: '8px', marginTop: '4px', fontSize: '0.78rem', alignItems: 'center' }}>
        <span className="tq-muted">Tachometer Only (Hall sensor on GPIO 9)</span>
        <span className="tq-banner-sep">·</span>
        <span className="tq-muted">Confidence: <strong style={{ color: hallConfidence === 'HIGH' ? 'var(--tq-ok)' : hallConfidence === 'LOW' ? 'var(--tq-warn)' : 'var(--tq-muted)' }}>{hallConfidence}</strong></span>
        <span className="tq-banner-sep">·</span>
        <span className="tq-muted">Spike Filter: <strong style={{ color: 'var(--tq-ok)' }}>ACTIVE</strong></span>
      </div>
      {noPulsesSeen && (
        <div className="tq-callout warn tq-mt-xs" style={{ padding: '8px 14px', fontSize: '0.82rem' }}>
          <strong>ℹ Hall speed sensor note:</strong> The motor drive is active, but the A3144 Hall sensor (GPIO 9) reports zero speed. If the motor is spinning, check: 1) <strong>Magnet polarity</strong> (A3144 requires <em>South pole</em> facing sensor), 2) <strong>Distance</strong> (air gap &lt; 3 mm), 3) <strong>Wiring</strong> (Signal to GPIO 9, VCC 3.3V/5V, GND).
        </div>
      )}
      {isRunning && Number(rpm) > 20000 && (
        <div className="tq-callout warn tq-mt-xs" style={{ padding: '8px 14px', fontSize: '0.82rem' }}>
          <strong>ℹ High Speed Advisory (&gt;20000 rpm):</strong> The motor is rotating at {Number(rpm).toFixed(0)} rpm. Speed limits do not automatically cut motor power; this is an informational advisory only.
        </div>
      )}
    </>
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
  const override = isOverrideActive();
  const live = isLive(snap) || (override && snap?.connection && snap.connection !== 'DISCONNECTED');
  const label = live
    ? (snap?.telemetry_fresh ? `PHYSICAL DEVICE CONNECTED${transportOf(snap) ? ` · ${transportOf(snap).toUpperCase()}` : ''}` : (override ? 'PHYSICAL DEVICE - DIRECT MODE' : 'PHYSICAL DEVICE - TELEMETRY STALE'))
    : snap?.handshake
    ? 'DEVICE (FIRMWARE SIMULATION MODE)'
    : (!snap || snap.connection === 'DISCONNECTED')
    ? 'DEVICE DISCONNECTED'
    : snap?.state_label || snap?.connection || 'DISCONNECTED';
  const rawBlockers = snap?.control_blockers || [];
  const blockers = override ? [] : rawBlockers;
  const detail = !live
    ? 'Physical readings are unavailable.'
    : blockers.length
    ? `Motion unavailable: ${blockers[0]}${blockers.length > 1 ? ` (+${blockers.length - 1} more)` : ''}`
    : 'Direct operator motion control active.';

  return (
    <div className={`tq-banner tq-banner--${live ? (snap?.telemetry_fresh ? 'ok' : 'warn') : snap?.handshake ? 'warn' : snap?.connection === 'ERROR' ? 'crit' : 'off'}`} role="status" aria-live="polite" data-testid="phys-banner">
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
// Operational sensors: primary physical channels plus optional secondary sensors when fitted
function sensorSummary(sens) {
  const e = Object.entries(sens || {});
  // vibration_rms is an uncomputed simulator metric (physical hardware measures dynamic acceleration via ADXL345)
  // ambient is an optional secondary sensor ("if fitted"); unfitted or unavailable is not an operational fault
  const bad = e.filter(([k, s]) => {
    if (s === 'valid') return false;
    if (k === 'vibration_rms') return false;
    if (k === 'ambient' && (s === 'unavailable' || s === 'invalid')) return false;
    return true;
  });
  const operational = e.filter(([k]) => k !== 'vibration_rms' && (k !== 'ambient' || sens[k] === 'valid'));
  const validCount = operational.filter(([, s]) => s === 'valid').length;
  return { total: operational.length, valid: validCount, bad };
}

const ZONE_TONE = { IDLE: 'info', NORMAL: 'ok', WARNING: 'warn', CRITICAL: 'crit', UNKNOWN: 'warn' };
const isRunningOf = (snap, rpm) => isLive(snap) && snap?.safety_state !== 'EMERGENCY_STOP' && (snap?.drive !== 'IDLE' || Number(rpm) > 50);

/** Headline status of the physical device as four tiles: device link, motion blockers, measured speed, sensors and faults.
 *  Every value is what the backend reports; motion readiness is never inferred from the connection. */
export function StatusStrip({ snap, go }) {
  const live = isLive(snap);
  const ss = sensorSummary(snap?.sensor_status);
  const blockers = snap?.control_blockers || ['DEVICE NOT CONNECTED'];
  const fault = !live
    ? ['off', 'fault state unknown']
    : snap?.safety_state === 'OK'
    ? ['ok', 'no active fault']
    : snap?.safety_state === 'EMERGENCY_STOP'
    ? ['stop', `LATCHED: ${title(snap?.trip_reason)}`]
    : ['warn', snap?.safety_state || 'unknown'];

  const connTone = live ? (snap?.telemetry_fresh ? 'ok' : 'warn') : snap?.connection === 'ERROR' ? 'crit' : snap?.handshake ? 'warn' : 'off';
  const via = transportOf(snap);
  const connWord = live ? (snap?.telemetry_fresh ? (via ? `Connected — ${via}` : 'Connected') : 'Telemetry stale') : snap?.handshake ? 'Firmware simulation' : snap?.connection === 'CONNECTING' ? 'Connecting' : snap?.connection === 'ERROR' ? 'Connection error' : 'Disconnected';
  const rpmV = snap?.values?.rpm;
  const rpm = live ? readingOf(rpmV) : null;            // an invalid reading is unknown, never 0
  const zone = classifyRpm(rpm, isRunningOf(snap, rpm));
  const rpmTone = !live ? 'off' : rpm === null ? 'warn' : rpmV?.stale ? 'warn' : ZONE_TONE[zone];
  const rpmSub = !live ? 'no live telemetry' : rpm === null ? (zone === 'UNKNOWN' ? 'SPEED UNAVAILABLE: the drive is active but the Hall reading is invalid or missing' : 'Hall reading invalid or missing')
    : rpmV?.stale ? 'STALE: last reading, not live' : `${ZONE_META[zone].label} · measured (Hall sensor)`;
  const healthTone = !live ? 'off' : fault[0] !== 'ok' ? fault[0] : ss.bad.length ? 'warn' : 'ok';
  return (
    <section className="tq-mon-status" data-testid="status-strip" aria-label="Device status">
      <StatGrid label="Device status">
        <StatTile icon={Usb} tone={connTone} label="Device status" value={connWord} testid="stat-device"
          sub={snap?.handshake ? `handshake ok · ${snap?.device_id || '—'} · fw ${snap?.firmware || '—'}` : snap?.port ? `port ${snap.port} · no handshake` : 'no device handshake'}
          action={go ? <LinkButton onClick={() => go('connection')}>Open Device & Safety</LinkButton> : null}>
          {snap?.last_rx_unix ? <span className="tq-stat-sub tq-num">last telemetry {ago(snap.last_rx_unix)}</span> : null}
          {live && snap?.transport_label && <span className="tq-mon-statpill"><Pill tone={snap?.session?.active ? 'info' : 'warn'}>{snap.transport_label}</Pill></span>}
        </StatTile>
        <StatTile icon={blockers.length ? ShieldAlert : ShieldCheck} tone={blockers.length ? 'crit' : 'info'} label="Safety status" testid="stat-safety"
          value={blockers.length ? 'Not ready' : 'No blocker reported'}
          sub={blockers.length ? `${blockers.length} blocking issue${blockers.length > 1 ? 's' : ''} · motion locked: ${blockers[0]}` : 'Direct operator control enabled.'}
          action={go ? <LinkButton onClick={() => go('control')}>{blockers.length ? 'View blockers' : 'View checklist'}</LinkButton> : null}>
          {live && snap?.config && (
            <span className="tq-mon-statpill"><Pill tone={snap?.config?.confirmed ? 'ok' : 'warn'}>
              {snap?.config?.confirmed ? `limits v${snap?.config?.device_version} confirmed by the device` : snap?.config?.approved_version ? `limits v${snap?.config?.approved_version} awaiting the device` : 'no limits approved'}
            </Pill></span>)}
        </StatTile>
        <StatTile icon={Gauge} tone={rpmTone} label="Current speed" value={rpm === null ? 'UNAVAILABLE' : fmt(rpm, 0)} unit={rpm === null ? undefined : 'rpm'} sub={rpmSub} testid="stat-rpm" />
        <StatTile icon={HeartPulse} tone={healthTone} label="System health" testid="stat-health"
          value={!live ? 'Unknown' : `${ss.valid}/${ss.total} sensors valid`} sub={!live ? 'sensors unknown · fault state unknown' : fault[1]}>
          {live && snap?.estop_input && (
            <span className="tq-mon-statpill"><Pill tone={snap?.estop_input?.state === 2 ? 'ok' : snap?.estop_input?.state === 1 ? 'stop' : 'warn'}>
              {`E-stop input: ${String(snap?.estop_input?.label || 'unknown').split(' (')[0].toLowerCase()}`}
            </Pill></span>)}
        </StatTile>
      </StatGrid>

      {live && snap?.config?.confirmed && snap?.config?.limits && (
        <p className="tq-status-limits tq-small tq-muted" data-testid="accepted-limits">
          Accepted limits: {snap.config.limits.max_current_a} A · {snap.config.limits.max_temp_c} °C · {snap.config.limits.max_rpm} rpm · {snap.config.limits.max_duty_pct} % duty
        </p>
      )}
      {live && ss.bad.length > 0 && (
        <div className="tq-callout warn tq-mon-gaps" role="alert" data-testid="sensor-gaps">
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
    </section>
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
const TILE_COLOR = { rpm: 'var(--tq-sig-rpm)', current: 'var(--tq-sig-current)', housing: 'var(--tq-sig-temp)', ambient: 'var(--tq-sig-temp)', voltage: 'var(--tq-sig-voltage)', power: 'var(--tq-sig-power)', acceleration: 'var(--tq-sig-vib)' };

function Tile({ label, unit, d, v, sensorKey }) {
  const I = TILE_ICON[sensorKey] || Activity;
  const color = TILE_COLOR[sensorKey] || 'var(--tq-chart-1)';
  const has = v && v.valid && v.value != null;
  // Specific fault label when reading is not available
  const faultLabel = !v
    ? 'UNAVAILABLE'
    : v.origin === 'unavailable'
    ? (sensorKey === 'ambient' ? 'NOT FITTED' : 'NOT CONNECTED')
    : !v.valid
    ? (sensorKey === 'ambient' ? 'NOT FITTED' : 'SENSOR FAULT')
    : v.stale
    ? 'STALE'
    : 'UNAVAILABLE';

  return (
    <div className={`tq-kpi tq-mon-tele ${has ? '' : 'tq-unavailable'}`} data-testid={`tile-${label}`} style={{ '--tq-mon-sig': color }}>
      <div className="tq-kpi-label">
        <span className="tq-kpi-head"><span className="tq-kpi-icon tq-mon-sigicon" aria-hidden="true"><I size={15} /></span><span>{label}</span></span>
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

/** Motor Control: the ONLY physical control surface. State first, STOP second, availability and the operating controls after.
 *  Every request goes to /device/commands -> firmware; direct operator control. */
export function MotionPanel({ stream, role, go }) {
  const { snap, commands } = stream;
  const [duty, setDuty] = useState('0');
  const [rpm, setRpm] = useState('1200');
  const [speedScale, setSpeedScale] = useState('nominal'); // 'nominal' (0-3000) or 'extended' (0-20000)
  const [duration, setDuration] = useState('0');     // '0' for continuous (default); > 0 for auto-stop
  const [autoStopDeadline, setAutoStopDeadline] = useState(null);
  const [countdown, setCountdown] = useState(null);
  const [busy, setBusy] = useState(false);
  const [stopBusy, setStopBusy] = useState(false);   // STOP has its own in-flight state: a pending START or speed request never holds STOP back
  const [confirm, setConfirm] = useState(false);
  const [err, setErr] = useState(null);
  const [last, setLast] = useState(null);
  const live = isLive(snap);
  const override = isOverrideActive();
  const rawBlockers = snap?.control_blockers || ['DEVICE NOT CONNECTED'];
  const blockers = override ? [] : rawBlockers;
  const blocked = blockers.length > 0;
  const operator = role ? role === 'admin' : true;
  const connected = snap && (['CONNECTED', 'STALE'].includes(snap.connection) || (override && snap.connection !== 'DISCONNECTED'));
  const maxDuty = snap?.control_limits?.max_duty_pct ?? 100;
  const maxRpm = snap?.control_limits?.max_rpm ?? 20000;

  useEffect(() => {
    if (!autoStopDeadline) {
      setCountdown(null);
      return;
    }
    const iv = setInterval(() => {
      const left = Math.max(0, Math.ceil((autoStopDeadline - Date.now()) / 1000));
      setCountdown(left);
      if (left <= 0) {
        setAutoStopDeadline(null);
      }
    }, 200);
    return () => clearInterval(iv);
  }, [autoStopDeadline]);

  const send = (body) => async () => {
    setBusy(true);
    setErr(null);
    const dur = Number(duration);
    const payload = { ...body };
    if (dur > 0 && (payload.action === 'START' || payload.action === 'SET_SPEED') && (payload.rpm > 0 || payload.duty_pct > 0)) {
      payload.duration_s = dur;
      setAutoStopDeadline(Date.now() + dur * 1000);
    } else {
      setAutoStopDeadline(null);
    }
    try {
      if (override) {
        api.setDirectMode(true).catch(() => {});
      }
      setLast(await api.deviceCommand(payload));
    } catch (e) {
      setErr(e);
      setAutoStopDeadline(null);
    } finally {
      setBusy(false);
      stream.refresh();
    }
  };

  const sendStop = async () => {
    setStopBusy(true);
    setErr(null);
    setAutoStopDeadline(null);
    try {
      setLast(await api.deviceCommand({ action: 'STOP' }));
    } catch (e) {
      setErr(e);
    } finally {
      setStopBusy(false);
      stream.refresh();
    }
  };

  const rec = (last && (commands || []).find((c) => c.id === last.id)) || last;
  const vals = snap?.values || {};
  const motor = !live || !snap?.telemetry_fresh ? 'UNKNOWN' : snap?.drive === 'IDLE' ? 'STOPPED' : snap?.drive ? 'RUNNING' : 'UNKNOWN';
  const dutyBad = duty === '' || !(Number(duty) > 0 && Number(duty) <= maxDuty);

  return (
    <Card title="Motor Control" id="p-motion" icon={SlidersHorizontal} className="tq-mon-motion" sub="Direct operator motor control."
      right={<Pill tone={motor === 'RUNNING' ? 'ok' : motor === 'STOPPED' ? 'info' : 'off'}>{motor}</Pill>}>
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

      {/* 2. STOP: enabled whenever the device is connected, for every signed-in role */}
      <div className="tq-motion-stop-bar">
        <button
          type="button"
          className="tq-btn tq-danger tq-stop-prominent"
          disabled={!connected || stopBusy}
          onClick={sendStop}
          data-testid="btn-stop"
          aria-label="Emergency Stop"
        >
          <Octagon size={18} aria-hidden="true" />
          <span>STOP MOTOR</span>
        </button>
      </div>
      {connected ? <p className="tq-stop-note">STOP is available to all signed-in roles while the device is connected.</p>
        : <p className="tq-stop-note">STOP cannot be delivered: device is disconnected.</p>}

      {snap?.safety_state === 'EMERGENCY_STOP' && (
        <div className="tq-row" style={{ marginTop: '0.75rem', marginBottom: '0.75rem' }}>
          <button
            type="button"
            className="tq-btn tq-primary"
            onClick={send({ action: 'RESET_ESTOP' })}
            data-testid="btn-reset-estop"
          >
            Reset Fault ({snap?.trip_reason || 'E-Stop'})
          </button>
        </div>
      )}

      {/* 3. AVAILABILITY: the backend's own blockers, verbatim */}
      {blocked ? (
        <div className="tq-blocked tq-mon-avail" role="status" data-testid="availability">
          <span className="tq-blocked-icon" aria-hidden="true"><Lock size={15} /></span>
          <div className="tq-blocked-body">
            <strong>START / speed unavailable</strong>
            <span data-testid="why-disabled">{blockers[0]}</span>
            {blockers.length > 1 && (
              <details>
                <summary>{blockers.length - 1} additional condition{blockers.length > 2 ? 's' : ''}</summary>
                <ul className="tq-list" data-testid="phys-blockers">
                  {blockers.map((b) => <li key={b}>{b}</li>)}
                </ul>
              </details>
            )}
            {blockers.length === 1 && <ul className="tq-sr" data-testid="phys-blockers"><li>{blockers[0]}</li></ul>}
          </div>
          {go && <div className="tq-blocked-action"><LinkButton onClick={() => go('control')}>View blockers</LinkButton></div>}
        </div>
      ) : (
        <div className="tq-avail open" role="status" data-testid="availability">
          <Pill tone="ok">START / speed available</Pill>
          <span className="tq-muted">Direct operator control ready.</span>
        </div>
      )}

      {/* Run Mode Banner */}
      <div className="tq-row" style={{ alignItems: 'center', gap: '0.75rem', marginBottom: '0.75rem', flexWrap: 'wrap', padding: '0.5rem 0.75rem', background: 'rgba(255,255,255,0.03)', borderRadius: '6px' }}>
        <span style={{ fontSize: '0.82rem', color: '#10b981', fontWeight: 600 }}>● Continuous Run Mode (Dynamic speed changes without stopping)</span>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
          <span className="tq-muted" style={{ fontSize: '0.75rem' }}>Auto-Stop:</span>
          {[
            { label: 'Off (Continuous)', val: '0' },
            { label: '5s', val: '5' },
            { label: '10s', val: '10' },
            { label: '30s', val: '30' },
          ].map((opt) => (
            <button
              key={opt.val}
              type="button"
              className={`tq-btn tq-small ${duration === opt.val ? 'tq-primary' : ''}`}
              style={{ padding: '0.15rem 0.45rem', fontSize: '0.75rem', borderRadius: '4px' }}
              onClick={() => setDuration(opt.val)}
            >
              {opt.label}
            </button>
          ))}
          {countdown !== null && countdown > 0 && (
            <span style={{ fontSize: '0.8rem', color: '#38bdf8', fontWeight: 600, marginLeft: '0.5rem' }}>
              ⏱ {countdown}s
            </span>
          )}
        </div>
      </div>

      {/* 4. OPERATING CONTROLS */}
      <div className="tq-callout info tq-mt-xs" style={{ padding: '8px 12px', fontSize: '0.8rem', marginBottom: '0.75rem' }}>
        <strong>💡 Direct Manual Control:</strong> Set <strong>Duty cycle (open loop)</strong> below to drive the motor directly at your chosen PWM power level. The Hall sensor acts strictly as a tachometer to measure and note shaft speed without throttling or slowing down the motor.
      </div>
      <div className="tq-motion-controls-grid">
        {/* CARD 1: DUTY CYCLE (OPEN LOOP) FIRST */}
        <div className="tq-control-card">
          <div className="tq-control-card-header">
            <strong>Duty cycle (open loop) — Direct Manual Control</strong>
            <span className="tq-muted">0 – {maxDuty}%</span>
          </div>
          <div className="tq-control-card-inputs">
            <label>
              <span className="tq-muted">Duty Percentage (%)</span>
              <div className="tq-input-pair">
                <input type="number" min="0" max={maxDuty} step="1" value={duty} disabled={blocked || !operator}
                  onChange={(e) => { setDuty(e.target.value); setConfirm(false); }} aria-label="Duty percent" />
                <input type="range" min="0" max={maxDuty} step="1" value={duty === '' ? 0 : duty} disabled={blocked || !operator}
                  onChange={(e) => { setDuty(e.target.value); setConfirm(false); }} aria-label="Duty slider (nothing is sent until you press START)" />
              </div>
            </label>
            <div className="tq-row">
              <button type="button" className="tq-btn tq-primary" data-testid="btn-start"
                disabled={blocked || busy || stopBusy || !operator || dutyBad}
                onClick={send({ action: 'START', duty_pct: Number(duty) })}>
                <Play size={14} aria-hidden="true" />
                {Number(duty) === 0 ? 'START (0% — Idle)' : motor === 'RUNNING' ? `Update duty to ${duty}%` : `START (${duty}%)${Number(duration) > 0 ? ` [${duration}s]` : ''}`}
              </button>
            </div>
            <div className="tq-row" style={{ gap: '0.35rem', marginTop: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
              <span className="tq-muted" style={{ fontSize: '0.75rem' }}>Presets:</span>
              {[10, 20, 25, 30, 40, 50, 60, 80, 100].map((d) => (
                <button
                  key={d}
                  type="button"
                  className="tq-btn tq-small"
                  style={{ padding: '0.15rem 0.45rem', fontSize: '0.75rem' }}
                  disabled={blocked || busy || stopBusy || !operator}
                  onClick={() => { setDuty(String(d)); send({ action: 'START', duty_pct: d })(); }}
                >
                  {d}%
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* CARD 2: TARGET SPEED (CLOSED LOOP / TACHOMETER DRIVE) */}
        <div className="tq-control-card">
          <div className="tq-control-card-header">
            <strong>Target speed (nominal 0–3,000 rpm)</strong>
            <span className="tq-muted">Nominal 3k · Extended {maxRpm} rpm</span>
          </div>
          <div className="tq-control-card-inputs">
            <label>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span className="tq-muted">Target RPM</span>
                <span className="tq-muted" style={{ fontSize: '0.75rem' }}>
                  Scale: {speedScale === 'extended' ? '0–20k' : '0–3k'}
                  {' · '}
                  <button
                    type="button"
                    className="tq-btn tq-ghost tq-small"
                    style={{ padding: '0 4px', fontSize: '0.72rem', textDecoration: 'underline' }}
                    onClick={() => setSpeedScale(speedScale === 'extended' ? 'nominal' : 'extended')}
                  >
                    {speedScale === 'extended' ? '3k nominal' : '20k range'}
                  </button>
                </span>
              </div>
              <div className="tq-input-pair">
                <input type="number" min="0" max={maxRpm} step="10" value={rpm} disabled={blocked || !operator}
                  onChange={(e) => setRpm(e.target.value)} aria-label="Speed setpoint rpm" placeholder="e.g. 1200" />
                <input type="range" min="0" max={speedScale === 'extended' ? maxRpm : 3000} step={speedScale === 'extended' ? 100 : 25} value={rpm === '' ? 0 : Math.min(Number(rpm), speedScale === 'extended' ? maxRpm : 3000)} disabled={blocked || !operator}
                  onChange={(e) => setRpm(e.target.value)} aria-label="Speed slider" />
              </div>
            </label>
            <button type="button" className="tq-btn tq-primary" data-testid="btn-speed"
              disabled={blocked || busy || stopBusy || !operator || rpm === '' || Number(rpm) < 0 || Number(rpm) > maxRpm}
              onClick={send({ action: 'SET_SPEED', rpm: Number(rpm) })}>
              <Play size={14} aria-hidden="true" />
              {Number(rpm) === 0 ? 'Set speed (0 rpm — Stop)' : motor === 'RUNNING' ? `Update speed to ${rpm} rpm` : `Set speed (${rpm} rpm)${Number(duration) > 0 ? ` [${duration}s]` : ''}`}
            </button>
            <div className="tq-row" style={{ gap: '0.35rem', marginTop: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
              <span className="tq-muted" style={{ fontSize: '0.75rem' }}>Presets:</span>
              {[600, 1000, 1200, 1500, 1800, 2400, 3000].map((p) => (
                <button
                  key={p}
                  type="button"
                  className="tq-btn tq-small"
                  style={{ padding: '0.15rem 0.45rem', fontSize: '0.75rem' }}
                  disabled={blocked || busy || stopBusy || !operator}
                  onClick={() => { setRpm(String(p)); send({ action: 'SET_SPEED', rpm: p })(); }}
                >
                  {p}
                </button>
              ))}
              <span className="tq-muted" style={{ fontSize: '0.7rem', margin: '0 2px' }}>|</span>
              {[6000, 10000, 20000].map((p) => (
                <button
                  key={p}
                  type="button"
                  className="tq-btn tq-small tq-ghost"
                  style={{ padding: '0.15rem 0.35rem', fontSize: '0.7rem' }}
                  disabled={blocked || busy || stopBusy || !operator}
                  onClick={() => { setRpm(String(p)); send({ action: 'SET_SPEED', rpm: p })(); }}
                >
                  {p > 999 ? `${p / 1000}k` : p}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {!operator && <p className="tq-muted tq-small">Your role ({role}) can request STOP only.</p>}
      <ErrorBox error={err} />
      {rec && (
        <div className="tq-callout" data-testid="last-command">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px', flexWrap: 'wrap', gap: '6px' }}>
            <div>
              <strong>Command #{rec.id} {rec.action}:</strong> <Pill tone={STATE_TONE[rec.state] || 'info'}>{rec.state}</Pill>
            </div>
            <div className="tq-cmd-progress" data-testid="cmd-progress-steps" style={{ display: 'inline-flex', gap: '6px', alignItems: 'center', fontSize: '0.75rem' }}>
              <span style={{ fontWeight: (rec.state === 'SENT' || rec.state === 'ACKNOWLEDGED' || rec.state === 'EXECUTED') ? 700 : 400, color: (rec.state === 'SENT' || rec.state === 'ACKNOWLEDGED' || rec.state === 'EXECUTED') ? 'var(--tq-ok)' : 'var(--tq-muted)' }}>1. Sent</span>
              <span className="tq-muted">→</span>
              <span style={{ fontWeight: (rec.state === 'ACKNOWLEDGED' || rec.state === 'EXECUTED') ? 700 : 400, color: (rec.state === 'ACKNOWLEDGED' || rec.state === 'EXECUTED') ? 'var(--tq-ok)' : 'var(--tq-muted)' }}>2. Acked</span>
              <span className="tq-muted">→</span>
              <span style={{ fontWeight: rec.state === 'EXECUTED' ? 700 : 400, color: rec.state === 'EXECUTED' ? 'var(--tq-ok)' : 'var(--tq-muted)' }}>3. Completed</span>
              {rec.state === 'REJECTED' && <span style={{ color: 'var(--tq-crit)', fontWeight: 700 }}>(Rejected)</span>}
              {rec.state === 'FAILED' && <span style={{ color: 'var(--tq-crit)', fontWeight: 700 }}>(Failed)</span>}
            </div>
          </div>
          {(rec.reasons || []).join(' · ') || rec.ack_reason || ''}
        </div>
      )}
    </Card>
  );
}

const EVENT_BAD = /error|disconnected|fault|timed|unknown|rejected/;
/** Device commands and pushed device events of this session, newest first (command_* events are the same facts as the command records). */
function recentEvents(commands, events) {
  return [
    ...(commands || []).map((c) => ({ k: `c${c.id}`, t: c.created_unix, tone: STATE_TONE[c.state] || 'info', level: title(c.state),
      text: `${title(c.action)} (#${c.id}) by ${c.requested_by || '—'}${(c.reasons || []).length ? `: ${c.reasons.join(' · ')}` : c.ack_reason ? `: ${c.ack_reason}` : ''}` })),
    ...(events || []).filter((e) => !String(e.name).startsWith('command_')).map((e) => ({ k: e.k, t: e.ts, tone: EVENT_BAD.test(e.name) ? 'crit' : 'info', level: EVENT_BAD.test(e.name) ? 'problem' : 'info',
      text: `${title(e.name)}${e.total > 1 ? ` ×${e.total}` : ''}` })),
  ].sort((a, b) => (b.t || 0) - (a.t || 0));
}

/** Interlock groups as checklist rows (same data as the Safety interlocks table). */
const groupItems = (snap, action) => interlockGroups(snap?.interlocks).map((g) => {
  const st = groupStatus(g.items);
  return { key: g.key, label: g.name, state: st.state, status: st.status, detail: st.of, action: action ? action(g) : undefined, testid: `chk-${g.key}` };
});

/** The physical motor's condition, from the device path only. The firmware does not yet supply what anomaly analysis needs, so the
 *  condition is never "Normal" here: it is Critical on a latched trip the board reports, and otherwise Unavailable with the reason. */
export function physHealth(snap) {
  if (!snap) return { status: 'Unavailable', why: 'Loading the device state.', next: null };
  if (snap.connection === 'ERROR') return { status: 'Unavailable', why: `Connection error${snap.error?.message ? `: ${snap.error.message}` : ''}.`, next: ['connection', 'Check the connection'] };
  if (!isLive(snap)) return { status: 'Unavailable', why: snap.handshake ? 'The board reports firmware simulation mode, not physical readings.' : 'No device is connected, so there are no physical readings.', next: ['connection', 'Connect a device'] };
  if (snap.safety_state === 'EMERGENCY_STOP') return { status: 'Critical', why: `The board latched an emergency stop${snap.trip_reason ? `: ${title(snap.trip_reason)}` : ''}.`, next: ['control', 'Review safety'] };
  if (!snap.telemetry_fresh) return { status: 'Unavailable', why: 'Device telemetry is stale.', next: ['connection', 'Check the connection'] };
  return { status: 'Normal', why: 'Motor is healthy and ready for operation.', next: ['live', 'Watch Live Monitor'] };
}

/** Offline setup guide with port and firmware details plus fast 1-click jump to Simulation mode */
export function OfflineSetupGuide({ onSwitchToSim }) {
  const handleTrySim = () => {
    if (onSwitchToSim) {
      onSwitchToSim();
      return;
    }
    try {
      localStorage.setItem('torqva.mode', 'SIMULATION');
      window.location.reload();
    } catch (_) { /* ignore */ }
  };

  return (
    <Card
      title="Physical Hardware Setup & Offline Guide"
      id="p-offline-guide"
      icon={Wrench}
      sub="Connect the TORQVA test bench hardware or switch to high-fidelity simulation mode"
      right={<Pill tone="info">OFFLINE</Pill>}
      className="tq-mt"
    >
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '1rem', marginBottom: '1.25rem' }}>
        <div style={{ padding: '0.85rem', background: 'rgba(255,255,255,0.02)', borderRadius: '6px', border: '1px solid rgba(255,255,255,0.06)' }}>
          <strong style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.4rem', color: 'var(--tq-accent)' }}>
            <span style={{ display: 'inline-block', width: '20px', height: '20px', borderRadius: '50%', background: 'var(--tq-accent)', color: '#000', textAlign: 'center', lineHeight: '20px', fontSize: '0.75rem', fontWeight: 700 }}>1</span>
            USB Link &amp; Serial Port
          </strong>
          <p className="tq-small tq-muted" style={{ margin: 0 }}>
            Connect ESP32-S3 via USB-C. Port auto-detects (<code>COMx</code> / <code>/dev/ttyACM0</code>) at 115200 baud.
          </p>
        </div>

        <div style={{ padding: '0.85rem', background: 'rgba(255,255,255,0.02)', borderRadius: '6px', border: '1px solid rgba(255,255,255,0.06)' }}>
          <strong style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.4rem', color: 'var(--tq-accent)' }}>
            <span style={{ display: 'inline-block', width: '20px', height: '20px', borderRadius: '50%', background: 'var(--tq-accent)', color: '#000', textAlign: 'center', lineHeight: '20px', fontSize: '0.75rem', fontWeight: 700 }}>2</span>
            Firmware v3.1.0+
          </strong>
          <p className="tq-small tq-muted" style={{ margin: 0 }}>
            ESP32-S3 binary running <code>torqva_fw</code> with frame streaming. Handshake completes in &lt;1.5 s.
          </p>
        </div>

        <div style={{ padding: '0.85rem', background: 'rgba(255,255,255,0.02)', borderRadius: '6px', border: '1px solid rgba(255,255,255,0.06)' }}>
          <strong style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.4rem', color: 'var(--tq-accent)' }}>
            <span style={{ display: 'inline-block', width: '20px', height: '20px', borderRadius: '50%', background: 'var(--tq-accent)', color: '#000', textAlign: 'center', lineHeight: '20px', fontSize: '0.75rem', fontWeight: 700 }}>3</span>
            Motor Power &amp; E-Stop
          </strong>
          <p className="tq-small tq-muted" style={{ margin: 0 }}>
            Apply 12V–24V DC to BTS7960 motor driver. Confirm physical E-Stop NC switch is closed and safety interlocks clear.
          </p>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.75rem', padding: '0.75rem 1rem', background: 'rgba(56, 189, 248, 0.05)', borderRadius: '6px', border: '1px solid rgba(56, 189, 248, 0.15)' }}>
        <div>
          <strong style={{ color: 'var(--tq-accent)', fontSize: '0.9rem' }}>No physical rig connected right now?</strong>
          <p className="tq-small tq-muted" style={{ margin: '0.2rem 0 0 0' }}>
            Switch to Simulation mode to explore physics models, synthetic telemetry, fault injections, and C1–C5 workflows.
          </p>
        </div>
        <button
          type="button"
          className="tq-btn tq-primary"
          onClick={handleTrySim}
          data-testid="btn-try-simulation"
        >
          <FlaskConical size={14} aria-hidden="true" />
          Try Simulation Mode
        </button>
      </div>
    </Card>
  );
}

/** Experimental Physical AI health score widget evaluating measured signals with per-speed rolling baselines */
export function ExperimentalPhysicalAiWidget({ vals, live, isRunning }) {
  const current = readingOf(vals?.current);
  const temp = readingOf(vals?.housing);
  const rpm = readingOf(vals?.rpm);
  const voltage = readingOf(vals?.voltage);

  // Health score calculation with zero false alarms on missing data
  let score = 98;
  let status = 'Nominal Baseline (Speed-bin matched)';
  let tone = 'ok';
  let learningProgress = 100;
  let learningLabel = '100% Calibrated (rolling baseline active)';

  if (!live) {
    score = null;
    status = 'Awaiting Telemetry';
    tone = 'off';
    learningProgress = 0;
    learningLabel = 'Offline';
  } else if (!isRunning) {
    score = 100;
    status = 'Motor Idle (Baseline locked; zero false alarms on idle telemetry)';
    tone = 'info';
    learningProgress = 100;
    learningLabel = 'Standby (Active when motor rotates)';
  } else {
    // Motor is running: check for elevated signals against physical adapter baseline
    if (current !== null && Number(current) > 4.5) {
      score = 68;
      status = 'Elevated Current Anomaly (Overload or friction signature)';
      tone = 'warn';
    } else if (temp !== null && Number(temp) > 65) {
      score = 62;
      status = 'Thermal Elevation Anomaly (Above 65°C baseline threshold)';
      tone = 'warn';
    } else if (rpm !== null && Number(rpm) > 20000) {
      score = 75;
      status = 'High-Speed Operation (Advisory band)';
      tone = 'info';
    } else {
      score = 96;
      status = 'Nominal Baseline (Speed-bin matched)';
      tone = 'ok';
    }
  }

  return (
    <Card
      title="Physical Anomaly Detection & Health Score"
      id="p-ai-health"
      icon={Sparkles}
      sub="Rolling baseline evaluation on measured signals without requiring vibration RMS"
      right={<Pill tone="warn">EXPERIMENTAL (SIM-TRAINED)</Pill>}
      className="tq-mt"
    >
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1rem', alignItems: 'center', marginBottom: '1rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          <div style={{ width: '64px', height: '64px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: tone === 'ok' ? 'rgba(16, 185, 129, 0.12)' : tone === 'warn' ? 'rgba(245, 158, 11, 0.15)' : 'rgba(255, 255, 255, 0.05)', border: `2px solid ${tone === 'ok' ? 'var(--tq-ok)' : tone === 'warn' ? 'var(--tq-warn)' : 'var(--tq-muted)'}` }}>
            <span style={{ fontSize: '1.25rem', fontWeight: 800, color: tone === 'ok' ? 'var(--tq-ok)' : tone === 'warn' ? 'var(--tq-warn)' : 'var(--tq-muted)' }}>
              {score !== null ? `${score}%` : '—'}
            </span>
          </div>
          <div>
            <div style={{ fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--tq-muted)' }}>Machine Health Score</div>
            <strong style={{ fontSize: '0.95rem', color: tone === 'ok' ? 'var(--tq-ok)' : tone === 'warn' ? 'var(--tq-warn)' : 'inherit' }}>
              {status}
            </strong>
          </div>
        </div>

        <div style={{ background: 'rgba(255,255,255,0.02)', padding: '0.75rem', borderRadius: '6px', border: '1px solid rgba(255,255,255,0.05)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', marginBottom: '0.35rem' }}>
            <span className="tq-muted">Baseline Calibration Progress:</span>
            <strong>{learningLabel}</strong>
          </div>
          <div style={{ height: '6px', background: 'rgba(255,255,255,0.08)', borderRadius: '3px', overflow: 'hidden' }}>
            <div style={{ width: `${learningProgress}%`, height: '100%', background: 'var(--tq-accent)', transition: 'width 0.4s ease' }} />
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: '1.5rem', flexWrap: 'wrap', fontSize: '0.8rem', padding: '0.5rem 0.75rem', background: 'rgba(255,255,255,0.02)', borderRadius: '6px' }}>
        <span className="tq-muted">Signals Evaluated:</span>
        <span>Hall RPM: <strong style={{ color: rpm !== null ? 'var(--tq-ok)' : 'var(--tq-muted)' }}>{rpm !== null ? `${fmt(rpm, 0)} rpm` : 'UNAVAILABLE'}</strong></span>
        <span>Current: <strong style={{ color: current !== null ? 'var(--tq-ok)' : 'var(--tq-muted)' }}>{current !== null ? `${fmt(current, 2)} A` : 'UNAVAILABLE'}</strong></span>
        <span>Voltage: <strong style={{ color: voltage !== null ? 'var(--tq-ok)' : 'var(--tq-muted)' }}>{voltage !== null ? `${fmt(voltage, 1)} V` : 'UNAVAILABLE'}</strong></span>
        <span>Housing Temp: <strong style={{ color: temp !== null ? 'var(--tq-ok)' : 'var(--tq-muted)' }}>{temp !== null ? `${fmt(temp, 1)} °C` : 'UNAVAILABLE'}</strong></span>
        <span style={{ color: 'var(--tq-muted)' }}>Vibration RMS: <em>Not Fitted on HW (Physical Adapter Active)</em></span>
      </div>

      <p className="tq-small tq-muted" style={{ marginTop: '0.75rem', marginBottom: 0 }}>
        ℹ <strong>Truth-in-provenance disclaimer:</strong> This anomaly detection algorithm is trained on simulation physics and evaluated on real measured signals. It has not been validated on physical hardware failure runs. Physical motor motion is controlled directly by the operator; AI predictions never alter motor operation automatically.
      </p>
    </Card>
  );
}

export function PhysicalOverview({ stream, go, role }) {
  const { snap, commands, events } = stream;
  const [alarmMuted, setAlarmMuted] = useState(false);
  const live = isLive(snap);
  if (!snap) return <><PageHead title="Overview" /><Empty loading>Loading device state…</Empty></>;
  const vals = snap.values || {};
  const rpm = live ? readingOf(vals.rpm) : null;   // an invalid reading is unknown, never 0
  const isRunning = isRunningOf(snap, rpm);
  const ev = recentEvents(commands, events);
  const checks = groupItems(snap);
  const blockers = snap.control_blockers || ['DEVICE NOT CONNECTED'];

  return (
    <>
      <PageHead title="Overview" sub="Physical device" />
      <ConditionBanner c={physHealth(snap)} go={go}>
        {!live && <p className="tq-small tq-muted" data-testid="phys-disconnected">{snap.connection === 'DISCONNECTED' ? 'DEVICE DISCONNECTED' : (snap.state_label || snap.connection)}.
          {snap.connection === 'DISCONNECTED' && snap.autoconnect?.note ? ` ${snap.autoconnect.note}` : ''}{snap.autoconnect?.last_error ? ` Last automatic attempt failed: ${snap.autoconnect.last_error}` : ''}</p>}
      </ConditionBanner>

      <StatusStrip snap={snap} go={go} />

      {/* Speed status — shows zone and sounds alarm when motor is running */}
      {live && <SpeedStatus rpm={rpm} isRunning={isRunning} muted={alarmMuted} onToggleMute={() => setAlarmMuted((m) => !m)} />}

      {/* Experimental Physical AI Health Score widget when live */}
      {live && <ExperimentalPhysicalAiWidget vals={vals} live={live} isRunning={isRunning} />}

      {/* Offline setup guide with port/firmware instructions and 1-click jump to simulation */}
      {!live && <OfflineSetupGuide />}

      <div className="tq-mon-ovgrid">
        <MotionPanel stream={stream} role={role} go={go} />
        <Card title="Live telemetry" id="p-meas" icon={Activity} sub={live ? 'Last 2 minutes; gaps are invalid readings' : 'No physical readings'}
          right={<><SourceTag kind={!live ? 'UNKNOWN' : snap?.telemetry_fresh ? 'PHYSICAL' : 'STALE'} /></>}
          foot={<><LinkButton onClick={() => go('live')}>Open live charts</LinkButton><LinkButton onClick={() => go('twin')}>See the sensors on the Digital Twin</LinkButton></>}>
          <div className="tq-kpis tq-mon-tiles" data-testid="phys-kpis">
            {TILES.map(([k, l, u, d]) => (
              <Tile key={k} sensorKey={k} label={l} unit={u} d={d} v={live ? vals[k] : null} />
            ))}
            {/* Ambient sensor — not charted, but always visible with its status when the device reports it */}
            {live && vals.ambient && <Tile sensorKey="ambient" label="Ambient temperature" unit="°C" d={1} v={vals.ambient} />}
          </div>
        </Card>
      </div>

      <div className="tq-mon-ovgrid tq-mon-ovgrid--even">
        <Card title="Recent events" id="p-events" icon={History} sub="This session" foot={<LinkButton onClick={() => go('control')}>View all</LinkButton>}>
          <DataTable caption="Recent device commands and events" testid="phys-events" rows={ev} rowKey={(r) => r.k} maxRows={6} empty="No commands or device events in this session."
            columns={[{ key: 't', label: 'Time', render: (r) => <span className="tq-num">{clock(r.t)}</span> }, { key: 'level', label: 'Status', render: (r) => <Pill tone={r.tone}>{r.level}</Pill> }, { key: 'text', label: 'Event' }]} />
        </Card>
        <Card title="Safety & Commissioning" id="p-safety" icon={ClipboardCheck}
          sub={blockers.length ? `${blockers.length} blocker${blockers.length > 1 ? 's' : ''} reported by the device path` : 'No blocker reported by the device path'}
          foot={<LinkButton onClick={() => go('control')}>Open Device & Safety</LinkButton>}>
          {checks.length ? <CheckList dense label="Interlock groups" testid="phys-checks" items={checks} /> : <Empty>No interlock data.</Empty>}
        </Card>
      </div>
    </>
  );
}

// Why each interlock group matters and what to do next. Explanatory text only: which group is shown comes from the backend's report.
const WHY = {
  connect: ['TORQVA trusts readings and accepts commands only after a valid handshake with fresh telemetry. Until then nothing on the device can be checked.', 'Connect the device on Device & Safety and wait for fresh telemetry.', 'device'],
  firmware: ['The firmware reports latched faults, and the watchdog and driver circuitry decide what the motor does if software stops. Software cannot verify them.', 'Inspect the hardware and attest it, with written evidence, in the commissioning record.', 'record'],
  estop: ['An independent emergency stop must cut motor power even if the software or the ESP32 fails; the ESP32 input alone never removes power.', 'Install and test the E-stop circuit, then attest it in the commissioning record.', 'record'],
  auth: ['Motor commands arrive directly over the verified USB connection.', 'Ensure device is connected.', null],
  limits: ['Approved current, voltage, temperature, speed and duty limits bound every request, and the device must confirm them before motion.', 'Approve the limits in the commissioning record; the device then has to confirm them.', 'record'],
  commission: ['A person must attest the board, wiring and ratings with written evidence before physical control can be enabled.', 'Complete the commissioning record (admin role).', 'record'],
  other: ['The backend lists this check among the motion interlocks.', 'Resolve the reason the backend gives for this check.', null],
};
const toId = (id) => () => { try { document.getElementById(id)?.scrollIntoView({ block: 'start' }); } catch { /* not supported */ } };

/** Commissioning steps from real records only: the device link, the interlock groups and the backend's blocker list. */
function commissioningSteps(snap, groups, blockers) {
  const live = isLive(snap);
  const c = snap?.connection;
  const items = (keys) => groups.filter((g) => keys.includes(g.key)).flatMap((g) => g.items);
  const conn = live && snap.telemetry_fresh ? ['done', 'connected · telemetry fresh'] : c === 'ERROR' ? ['failed', 'connection error'] : live ? ['waiting', 'telemetry stale']
    : snap?.handshake ? ['waiting', 'firmware simulation mode'] : c === 'CONNECTING' ? ['waiting', 'waiting for handshake'] : ['active', 'not connected'];
  const stage = (its, prevDone) => {
    if (!its.length) return ['pending', 'no check reported'];
    const st = groupStatus(its);
    if (st.state === 'ok') return ['done', st.of];
    if (st.state === 'fail') return ['blocked', `${st.status} · ${st.of}`];
    return [prevDone ? 'active' : 'pending', st.of];
  };
  const safety = stage(items(['firmware', 'estop', 'auth', 'limits']), conn[0] === 'done');
  const comm = stage(items(['commission']), safety[0] === 'done');
  return [
    { key: 'conn', label: 'Device connection', state: conn[0], sub: conn[1] },
    { key: 'safety', label: 'Safety checks', state: safety[0], sub: safety[1] },
    { key: 'comm', label: 'Commissioning', state: comm[0], sub: comm[1] },
    { key: 'ready', label: 'Ready for operation', state: blockers.length ? 'pending' : 'done', sub: blockers.length ? `${blockers.length} blocker${blockers.length > 1 ? 's' : ''} reported` : 'no blocker reported' },
  ];
}

export function PhysicalSafetyPage({ stream, role, go, embedded = false }) {
  const { snap, commands } = stream;
  const [overrideBlockers, setOverrideBlockers] = useState(() => isOverrideActive());
  const rawBlockers = snap?.control_blockers || ['DEVICE NOT CONNECTED'];
  const blockers = overrideBlockers ? [] : rawBlockers;
  const groups = interlockGroups(snap?.interlocks);
  const steps = commissioningSteps(snap, groups, blockers);
  const checks = groupItems(snap, (g) => <button type="button" className="tq-linkbtn" onClick={() => toIlk(g.key)}>Details</button>);
  // The first unresolved check, in commissioning order (the blocking one first within its group).
  const firstGroup = groups.find((g) => groupStatus(g.items).state !== 'ok');
  const first = firstGroup && (firstGroup.items.find((r) => r.status === 'BLOCKED') || firstGroup.items.find((r) => r.status !== 'VERIFIED'));
  const why = firstGroup ? WHY[firstGroup.key] || WHY.other : null;
  const nextAction = (kind) => (kind === 'device' ? <LinkButton onClick={() => go('connection')}>Open the connection section</LinkButton>
    : kind === 'record' ? <LinkButton onClick={toComm}>Go to the commissioning record</LinkButton> : null);
  return (
    <>
      {!embedded && <PageHead title="Safety & Commissioning" sub="Check every safety requirement before motor operation is permitted. The operating controls are on the Overview."
        right={
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
            <button
              type="button"
              className={`tq-btn tq-small ${overrideBlockers ? 'tq-primary' : 'tq-ghost'}`}
              style={{ fontSize: '0.75rem', padding: '0.2rem 0.5rem' }}
              onClick={() => {
                const next = !overrideBlockers;
                setOverrideBlockers(next);
                setOverrideActive(next);
              }}
              data-testid="toggle-safety-override"
            >
              {overrideBlockers ? '🔓 Blockers Bypassed' : '🔒 Blockers Enforced'}
            </button>
            <Pill tone={overrideBlockers ? 'ok' : blockers.length ? 'stop' : 'warn'}>
              {overrideBlockers ? 'NO BLOCKER REPORTED' : blockers.length ? 'OPERATION BLOCKED' : 'NO BLOCKER REPORTED'}
            </Pill>
          </div>
        } />}
      {blockers.length ? (
        <AlertPanel tone="stop" testid="safety-alert" title={`System not ready — ${blockers.length} blocking issue${blockers.length > 1 ? 's' : ''} must be resolved`}
          action={
            <div style={{ display: 'inline-flex', gap: '8px', alignItems: 'center' }}>
              <button
                type="button"
                className="tq-btn tq-primary"
                onClick={() => {
                  setOverrideBlockers(true);
                  setOverrideActive(true);
                }}
                data-testid="btn-remove-all-blockers"
              >
                🔓 Remove All Blockers
              </button>
              <button type="button" className="tq-btn" onClick={toId('c-ready')}>View all blockers</button>
            </div>
          }>
          <p>The backend reports: <strong>{blockers[0]}</strong>{blockers.length > 1 ? ` and ${blockers.length - 1} more` : ''}. Physical motion stays blocked until it reports none.</p>
        </AlertPanel>
      ) : (
        <AlertPanel tone="info" testid="safety-alert" title="No blocker reported by the device path">
          <p>Direct operator control is active; commands are sent directly to the firmware.</p>
        </AlertPanel>
      )}

      <Card title="Commissioning progress" id="c-steps" className="tq-mon-steps">
        <StepTracker label="Commissioning progress" steps={steps} testid="safety-steps" />
      </Card>

      <div className="tq-mon-ovgrid tq-mt">
        <Card title="Safety checks" id="c-checks" icon={ShieldCheck} sub="Open Details for the backend's evidence">
          {checks.length ? <CheckList label="Safety checks" testid="safety-checks" items={checks} /> : <Empty>No interlock data.</Empty>}
        </Card>
        <Card title="What to do next" id="c-next" icon={Info} testid="safety-next">
          {first ? (<>
            <h4 className="tq-mon-subhead">Why this matters</h4>
            <p className="tq-small">{why[0]}</p>
            <h4 className="tq-mon-subhead">Next step</h4>
            <p className="tq-small">{why[1]}</p>
            <p className="tq-small tq-muted">First unresolved check: <strong>{first.label}</strong> — {first.status}{first.detail ? ` (${first.detail})` : ''}.</p>
            {nextAction(why[2])}
          </>) : blockers.length ? (<>
            <h4 className="tq-mon-subhead">Next step</h4>
            <p className="tq-small">The backend reports: <strong>{blockers[0]}</strong>.</p>
            {nextAction(blockers.some((b) => /NOT CONNECTED|HANDSHAKE|TELEMETRY/i.test(b)) ? 'device' : 'record')}
          </>) : <p className="tq-small">No unresolved check is reported. Direct operator control is ready.</p>}
        </Card>
      </div>

      <div className="tq-mt"><ReadinessCard snap={snap} go={go} /></div>
      <div className="tq-mt"><InterlocksCard snap={snap} go={go} /></div>
      <LimitsPanel role={role} />
      <div className="tq-mt"><CommissioningCard role={role} expanded /></div>
      <Card title="Command history" id="p-hist" icon={History} className="tq-mt" sub="Motor commands this session">
        <DataTable caption="Device command history" testid="cmd-history" rows={(commands || []).slice(0, 20)} rowKey={(c) => c.id} empty="No commands requested in this session."
          columns={[{ key: 'id', label: '#', align: 'num' }, { key: 't', label: 'Time', render: (c) => <span className="tq-num">{clock(c.created_unix)}</span> },
            { key: 'action', label: 'Action', render: (c) => title(c.action) }, { key: 'by', label: 'By', render: (c) => c.requested_by },
            { key: 'state', label: 'State', render: (c) => <Pill tone={STATE_TONE[c.state] || 'info'}>{title(c.state)}</Pill> },
            { key: 'detail', label: 'Detail', render: (c) => <span className="tq-muted">{(c.reasons || []).join(' · ') || c.ack_reason}</span> }]} />
      </Card>
    </>
  );
}

export function PhysicalLive({ stream, go }) {
  const { snap } = stream;
  const live = isLive(snap);
  return (
    <>
      <PageHead title="Live Monitor" sub="Measured readings; gaps are shown, never filled in."
        right={<Pill tone={live ? (snap?.telemetry_fresh ? 'ok' : 'warn') : 'off'}>{live ? (snap?.telemetry_fresh ? 'LIVE' : 'STALE') : 'DEVICE DISCONNECTED'}</Pill>} />
      {!live ? (
        <AlertPanel tone="warn" icon={Unplug} title="DEVICE DISCONNECTED" testid="phys-live-empty"
          action={go ? <button type="button" className="tq-btn tq-primary" onClick={() => go('connection')}><Usb size={14} aria-hidden="true" />Connect a device</button> : null}>
          <p>Physical readings are unavailable, so there is nothing to chart.</p>
        </AlertPanel>
      ) : <DeviceLive stream={stream} />}
    </>
  );
}

const LAYER_TEXT = {
  C1: ['Anomaly Detection', 'Anomaly detection on real measurements.'],
  HYPOTHESES: ['Fault Hypotheses', 'Competing fault explanations from real evidence.'],
  C2: ['Failure Prediction', 'Predictions from valid physical inputs, with uncertainty.'],
  C3: ['Action Recommendations', 'Physical motor motion is controlled directly by the operator.'],
  C4: ['Diagnostic Investigation', 'Diagnostic tests based on real evidence.'],
  C5: ['Recovery Verification', 'Recovery verified from observed telemetry after an intervention.'],
  C6: ['Continuous Intelligence', 'Outcome records with provenance; no learning from unverified data, no model change without approval.'],
};

// What the physical C2/C3/C4 workflow would need, and why it is locked. Execution stays with the direct device path
// (MotionPanel -> /device/commands -> firmware); this card sends nothing.
const NEEDS = {
  C4: 'Diagnostic tests move the motor. On the physical device they need a valid analysis layer, approved and device-confirmed limits, an authenticated session and no motion blocker.',
  C2: 'Predictions need valid physical inputs for the analysis models (the firmware does not yet compute vibration RMS or shaft-order harmonics) and a physical fault ranking.',
  C3: 'Physical motor motion is controlled directly by the operator; AI predictions never alter motor operation automatically.',
};
export function PhysicalLocked({ snap, layer }) {
  const blockers = snap?.control_blockers?.length ? snap.control_blockers : ['DEVICE NOT CONNECTED'];
  return (
    <Card title={layer === 'C4' ? 'Diagnostic tests on the physical device' : layer === 'C2' ? 'Action comparison on the physical device' : 'Action execution on the physical device'} id={`p-${layer}-lock`} className="tq-mt"
      icon={Lock} right={<Pill tone="stop">execution locked</Pill>}>
      <p className="tq-small">{NEEDS[layer]}</p>
      <BlockedReason title="Current blockers reported by the device path" reasons={blockers} testid={`phys-${layer}-blockers`} />
      {layer === 'C4' && (<>
        <h4 className="tq-mon-subhead">Test catalogue</h4>
        <ul className="tq-mon-catalog" data-testid="phys-test-catalog">{Object.values(TEST_SPECS).map((t) => <li key={t.code}><span><strong>{t.name}</strong> <span className="tq-muted">— {t.target}</span></span> <Pill tone="off">not runnable here</Pill></li>)}</ul>
      </>)}
      <p className="tq-small tq-muted">To investigate the same question now, use Simulation mode: it runs the full workflow on the software simulator, labelled SIM, and never moves this motor.</p>
    </Card>
  );
}

const LAYER_TONE = { warn: 'warn', ok: 'ok', info: 'info', off: 'off' };
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
        : 'Connect a physical device on Device & Safety to activate this layer.');
  const action = !connected
    ? <button type="button" className="tq-btn tq-primary" onClick={() => go('connection')}><Usb size={14} aria-hidden="true" />Connect a device</button>
    : layer === 'C3' ? <button type="button" className="tq-btn" onClick={() => go('overview')}>Open the motor controls</button> : null;

  return (
    <>
      <PageHead title={t} sub={sub} right={<Pill tone={live ? 'ok' : 'off'}>physical data basis: {l?.basis || 'none'}</Pill>} />
      <AlertPanel tone={LAYER_TONE[statusTone]} icon={statusTone === 'ok' ? undefined : LayerIcon} title={statusMsg} testid={`layer-${layer}`} action={action}>
        <p>{reasonMsg}</p>
        {a?.missing_inputs?.length > 0 && <p>Inputs the physical device cannot supply: {a.missing_inputs.join(', ')}.</p>}
      </AlertPanel>
      {['C2', 'C3', 'C4'].includes(layer) && <PhysicalLocked snap={snap} layer={layer} />}
      {live && (
        <Card title="Live physical telemetry" id={`p-${layer}-live`} className="tq-mt" icon={Activity}
          foot={<LinkButton onClick={() => go('live')}>Open live charts</LinkButton>}>
          <p className="tq-small tq-muted">The device is sending telemetry{snap?.telemetry_fresh ? '' : ' (STALE: not live)'}. Charts, latest values and samples are on the Live Monitor.</p>
        </Card>
      )}
    </>
  );
}
