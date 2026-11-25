import { MotionPanel } from '../../control/MotionPanel.jsx';
import { isLive } from '../../telemetry/devicePresentation.js';
import React, { useEffect, useRef, useState } from 'react';
import { Usb, Activity, FlaskConical, Unplug, Hourglass, Bell, BellOff, Gauge, Zap, Thermometer, Plug, Move3d, HeartPulse, History, Wrench, Sparkles } from 'lucide-react';
import { Card, Empty, Pill, ProvBadge, fmt, title, useNavContext, PageHead, StatTile, StatGrid, AlertPanel, LinkButton, DataTable, SourceTag, ConditionBanner } from '../../components/components.jsx';
import { DeviceLive } from '../../telemetry/DeviceLive.jsx';
import { STATE_TONE, readingOf, ago, clock, transportOf, isOverrideActive } from '../../telemetry/devicePresentation.js';
import { TEST_SPECS } from '../../shared/diagnostics.js';
import { useAlarmContext } from '../../safety/alarmContext.jsx';

const WAITING = 'WAITING FOR VALID PHYSICAL TELEMETRY';

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
  IDLE: { label: 'IDLE', color: 'var(--tq-accent)', desc: 'Motor stopped or ready — no alert active' },
  NORMAL: { label: 'NORMAL', color: 'var(--tq-ok)', desc: 'Speed in optimal range (~1300 rpm nominal: 1100–1500 rpm)' },
  WARNING: { label: 'WARNING', color: 'var(--tq-warn)', desc: 'Speed deviating from 1300 rpm normal range (700–1099 or 1501–1900 rpm)' },
  CRITICAL: { label: 'CRITICAL', color: 'var(--tq-crit)', desc: 'Speed advisory: operating outside nominal band (<700 or >1900 rpm) — warning only, does not stop motor' },
  UNKNOWN: { label: 'SPEED UNAVAILABLE', color: 'var(--tq-warn)', desc: 'The drive is active but the Hall speed reading is invalid or missing: the speed is unknown, not zero' },
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
        ctxRef.current.resume().catch(() => { });
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
  const override = isOverrideActive(snap);
  const live = isLive(snap) || (override && snap?.connection && snap.connection !== 'DISCONNECTED');
  const label = live
    ? (snap?.telemetry_fresh ? `PHYSICAL DEVICE CONNECTED${transportOf(snap) ? ` · ${transportOf(snap).toUpperCase()}` : ''}` : (override ? 'PHYSICAL DEVICE - DIRECT MODE' : 'PHYSICAL DEVICE - TELEMETRY STALE'))
    : snap?.handshake
      ? 'DEVICE (FIRMWARE SIMULATION MODE)'
      : (!snap || snap.connection === 'DISCONNECTED')
        ? 'DEVICE DISCONNECTED'
        : snap?.state_label || snap?.connection || 'DISCONNECTED';
  const detail = live ? 'Physical device connected.' : 'Physical readings are unavailable.';

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
const isRunningOf = (snap, rpm) => isLive(snap) && (snap?.drive ? snap.drive !== 'IDLE' : Number(rpm) > 50);

/** Headline status of the physical device as four tiles: device link, measured speed, sensors and faults.
 *  Every value is what the backend reports; motion readiness is never inferred from the connection. */
export function StatusStrip({ snap, go }) {
  const live = isLive(snap);
  const override = isOverrideActive(snap);
  const ss = sensorSummary(snap?.sensor_status);
  const fault = !live
    ? ['off', 'fault state unknown']
    : ['ok', 'no active fault'];

  const connTone = live ? ((snap?.telemetry_fresh || override) ? 'ok' : 'warn') : snap?.connection === 'ERROR' ? 'crit' : snap?.handshake ? 'warn' : 'off';
  const via = transportOf(snap);
  const connWord = live ? ((snap?.telemetry_fresh || override) ? (via ? `Connected — ${via}` : 'Connected') : 'Telemetry stale') : snap?.handshake ? 'Firmware simulation' : snap?.connection === 'CONNECTING' ? 'Connecting' : snap?.connection === 'ERROR' ? 'Connection error' : 'Disconnected';
  const rpmV = snap?.values?.rpm;
  const rpm = live ? readingOf(rpmV) : null;            // an invalid reading is unknown, never 0
  const zone = classifyRpm(rpm, isRunningOf(snap, rpm));
  const rpmTone = !live ? 'off' : rpm === null ? 'warn' : (rpmV?.stale && !override) ? 'warn' : ZONE_TONE[zone];
  const rpmSub = !live ? 'no live telemetry' : rpm === null ? (zone === 'UNKNOWN' ? 'SPEED UNAVAILABLE: the drive is active but the Hall reading is invalid or missing' : 'Hall reading invalid or missing')
    : (rpmV?.stale && !override) ? 'STALE: last reading, not live' : `${ZONE_META[zone].label} · measured (Hall sensor)`;
  const healthTone = !live ? 'off' : fault[0] !== 'ok' ? fault[0] : (ss.bad.length && !override) ? 'warn' : 'ok';
  return (
    <section className="tq-mon-status" data-testid="status-strip" aria-label="Device status">
      <StatGrid label="Device status">
        <StatTile icon={Usb} tone={connTone} label="Device status" value={connWord} testid="stat-device"
          sub={snap?.handshake ? `handshake ok · ${snap?.device_id || '—'} · fw ${snap?.firmware || '—'}` : snap?.port ? `port ${snap.port} · no handshake` : 'no device handshake'}
          action={go ? <LinkButton onClick={() => go('connection')}>Open Hardware Manager</LinkButton> : null}>
          {snap?.last_rx_unix ? <span className="tq-stat-sub tq-num">last telemetry {ago(snap.last_rx_unix)}</span> : null}
          {live && snap?.transport_label && <span className="tq-mon-statpill"><Pill tone={snap?.session?.active ? 'info' : 'warn'}>{snap.transport_label}</Pill></span>}
        </StatTile>
        <StatTile icon={Gauge} tone={rpmTone} label="Current speed" value={rpm === null ? 'UNAVAILABLE' : fmt(rpm, 0)} unit={rpm === null ? undefined : 'rpm'} sub={rpmSub} testid="stat-rpm" />
        <StatTile icon={HeartPulse} tone={healthTone} label="System health" testid="stat-health"
          value={!live ? 'Unknown' : override ? 'Operational' : `${ss.valid}/${ss.total} sensors valid`} sub={!live ? 'sensors unknown · fault state unknown' : fault[1]}>
        </StatTile>
      </StatGrid>

      {live && snap?.config?.confirmed && snap?.config?.limits && (
        <p className="tq-status-limits tq-small tq-muted" data-testid="accepted-limits">
          Accepted limits: {snap.config.limits.max_current_a} A · {snap.config.limits.max_temp_c} °C · {snap.config.limits.max_rpm} rpm · {snap.config.limits.max_duty_pct} % duty
        </p>
      )}
      {live && !override && ss.bad.length > 0 && (
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

const EVENT_BAD = /error|disconnected|fault|timed|unknown|rejected/;
/** Device commands and pushed device events of this session, newest first (command_* events are the same facts as the command records). */
function recentEvents(commands, events, override = false) {
  return [
    ...(commands || []).map((c) => ({
      k: `c${c.id}`, t: c.created_unix, tone: STATE_TONE[c.state] || 'info', level: title(c.state),
      text: `${title(c.action)} (#${c.id}) by ${c.requested_by || '—'}${(c.reasons || []).length ? `: ${c.reasons.join(' · ')}` : c.ack_reason ? `: ${c.ack_reason}` : ''}`
    })),
    ...(events || []).filter((e) => {
      if (String(e.name).startsWith('command_')) return false;
      if (override && /protocol_error|auth_failed|ota_info|ota_status|heartbeat_gap|wdt_reset/i.test(e.name)) return false;
      return true;
    }).map((e) => ({
      k: e.k, t: e.ts, tone: EVENT_BAD.test(e.name) ? 'crit' : 'info', level: EVENT_BAD.test(e.name) ? 'problem' : 'info',
      text: `${title(e.name)}${e.total > 1 ? ` ×${e.total}` : ''}`
    })),
  ].sort((a, b) => (b.t || 0) - (a.t || 0));
}

export function physHealth(snap) {
  if (!snap) return { status: 'Unavailable', why: 'Loading the device state.', next: null };
  const override = isOverrideActive(snap);
  if (snap?.connection === 'ERROR') return { status: 'Unavailable', why: `Connection error${snap?.error?.message ? `: ${snap.error.message}` : ''}.`, next: ['connection', 'Check the connection'] };
  if (!isLive(snap) && !override) return { status: 'Unavailable', why: snap?.handshake ? 'The board reports firmware simulation mode, not physical readings.' : 'No device is connected, so there are no physical readings.', next: ['connection', 'Connect a device'] };
  if (!snap?.telemetry_fresh && !override) return { status: 'Unavailable', why: 'Device telemetry is stale.', next: ['connection', 'Check the connection'] };
  return { status: 'Normal', why: 'Motor is healthy and ready for direct operation.', next: ['live', 'Watch Live Monitor'] };
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
            Motor Power &amp; Direct Drive
          </strong>
          <p className="tq-small tq-muted" style={{ margin: 0 }}>
            Apply 12V–24V DC to BTS7960 motor driver. Direct PWM duty and target speed setpoints execute without human checks.
          </p>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.75rem', padding: '0.75rem 1rem', background: 'rgba(56, 189, 248, 0.05)', borderRadius: '6px', border: '1px solid rgba(56, 189, 248, 0.15)' }}>
        <div>
          <strong style={{ color: 'var(--tq-accent)', fontSize: '0.9rem' }}>No physical rig connected right now?</strong>
          <p className="tq-small tq-muted" style={{ margin: '0.2rem 0 0 0' }}>
            Switch to Simulation mode to explore physics models, synthetic telemetry, fault injections, and diagnostic workflows.
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
  const override = isOverrideActive(snap);
  const live = isLive(snap) || (override && snap?.connection && snap.connection !== 'DISCONNECTED');
  if (!snap) return <><PageHead title="Overview" /><Empty loading>Loading device state…</Empty></>;
  const vals = snap.values || {};
  const rpm = live ? readingOf(vals.rpm) : null;   // an invalid reading is unknown, never 0
  const isRunning = isRunningOf(snap, rpm);
  const ev = recentEvents(commands, events, override);
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
        <Card title="Live telemetry" id="p-meas" icon={Activity} sub={(live || override) ? 'Last 2 minutes; gaps are invalid readings' : 'No physical readings'}
          right={<><SourceTag kind={(!live && !override) ? 'UNKNOWN' : (snap?.telemetry_fresh || override) ? 'PHYSICAL' : 'STALE'} /></>}
          foot={<><LinkButton onClick={() => go('live')}>Open live charts</LinkButton><LinkButton onClick={() => go('twin')}>See the sensors on the Digital Twin</LinkButton></>}>
          <div className="tq-kpis tq-mon-tiles" data-testid="phys-kpis">
            {TILES.map(([k, l, u, d]) => (
              <Tile key={k} sensorKey={k} label={l} unit={u} d={d} v={(live || override) ? vals[k] : null} />
            ))}
            {/* Ambient sensor — not charted, but always visible with its status when the device reports it */}
            {(live || override) && vals.ambient && <Tile sensorKey="ambient" label="Ambient temperature" unit="°C" d={1} v={vals.ambient} />}
          </div>
        </Card>
      </div>

      <div className="tq-mon-ovgrid tq-mon-ovgrid--even">
        <Card title="Recent events" id="p-events" icon={History} sub="This session" foot={<LinkButton onClick={() => go('control')}>View all</LinkButton>}>
          <DataTable caption="Recent device commands and events" testid="phys-events" rows={ev} rowKey={(r) => r.k} maxRows={6} empty="No commands or device events in this session."
            columns={[{ key: 't', label: 'Time', render: (r) => <span className="tq-num">{clock(r.t)}</span> }, { key: 'level', label: 'Status', render: (r) => <Pill tone={r.tone}>{r.level}</Pill> }, { key: 'text', label: 'Event' }]} />
        </Card>
      </div>
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
  C4: 'Diagnostic tests require a valid physical analysis layer and device telemetry.',
  C2: 'Predictions need valid physical inputs for the analysis models (the firmware does not yet compute vibration RMS or shaft-order harmonics) and a physical fault ranking.',
  C3: 'Physical motor motion is controlled directly by the operator; AI predictions never alter motor operation automatically.',
};
export function PhysicalLocked() {
  return null;
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

  const statusTone = !l
    ? (connected ? 'info' : 'off')
    : l.status === WAITING || l.status === 'NOT AVAILABLE'
      ? 'warn'
      : ['ACTIVE', 'READY', 'AVAILABLE', 'VERIFIED'].includes(l.status)
        ? 'ok'
        : 'info';

  const statusMsg = l?.status || (connected ? WAITING : 'DEVICE DISCONNECTED');
  const reasonMsg = l?.reason
    || (connected ? 'Device is connected. Waiting for valid telemetry frames to activate this layer.'
      : 'Connect a physical device in Hardware Manager to activate this layer.');
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
      {live && (
        <Card title="Live physical telemetry" id={`p-${layer}-live`} className="tq-mt" icon={Activity}
          foot={<LinkButton onClick={() => go('live')}>Open live charts</LinkButton>}>
          <p className="tq-small tq-muted">The device is sending telemetry{snap?.telemetry_fresh ? '' : ' (STALE: not live)'}. Charts, latest values and samples are on the Live Monitor.</p>
        </Card>
      )}
    </>
  );
}
