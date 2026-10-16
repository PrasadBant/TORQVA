// Digital Twin, physical mode: maps the device stream (useDeviceStream: /device/status + the read-only WebSocket) onto the shared twin workspace.
// Read-only by construction: this module imports no command API and renders no control. A reading is shown only as the device reported it; a missing,
// invalid or stale reading stays marked as such. The shaft is animated only from a fresh, valid, physically measured speed.
import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { DigitalTwin } from '../shared/twin.jsx';
import { HistoryChart } from '../shared/lazyCharts.jsx';
import { Empty, ErrorBox, fmt } from '../shared/components.jsx';

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const title = (s) => String(s ?? '').replaceAll('_', ' ');
const ago = (unix) => (unix ? `${fmt(Math.max(0, Date.now() / 1000 - unix), 1)} s ago` : 'never');
// Signals the backend keeps history for (serial_bridge.history_series); anything else has no trend.
const HISTORY = new Set(['rpm', 'current', 'voltage', 'power', 'duty', 'housing', 'acceleration']);
// Firmware trip reasons (torqva_core/safety.h TripReason) and the component whose reading or state the firmware tripped on. EXTERNAL_ESTOP and
// SENSOR_INVALID name no single drawn part (the latter shows up as the invalid reading itself).
const TRIP_PART = {
  OVER_CURRENT_SUSTAINED: ['ina', 'the INA219 current reading'], OVER_CURRENT_INSTANT: ['ina', 'the INA219 current reading'],
  VOLTAGE_LOW: ['ina', 'the INA219 bus-voltage reading'], VOLTAGE_HIGH: ['ina', 'the INA219 bus-voltage reading'],
  TEMP_STOP: ['temp', 'the housing temperature'], TEMP_RISE: ['temp', 'the housing temperature rise'], VIBRATION: ['accel', 'the accelerometer reading'],
  RPM_LOSS: ['hall', 'the measured speed'], HEARTBEAT_LOST: ['controller', 'the missing host heartbeat'], RESET_FAULT: ['controller', 'a controller restart'],
  OUTPUT_INIT_FAULT: ['driver', 'the motor-driver output stage'],
};

/** Pure mapping, exported for tests. */
export function physTwin(snap, { unreachable = false } = {}) {
  if (!snap && !unreachable) return { source: 'PHYSICAL', loading: true };
  if (!snap) snap = { connection: 'UNKNOWN', handshake: false, values: {} };        // the backend never answered: nothing is known about the device
  const handshake = !!snap.handshake;
  const physical = handshake && snap.origin === 'physical_device';
  const fresh = handshake && !!snap.telemetry_fresh && !unreachable;
  const vals = snap.values || {};
  const prov = physical ? 'MEASURED' : 'SIMULATED';            // a handshaken board in firmware-simulation mode reports simulated values
  const read = (key, label, unit, digits, extra = {}) => {
    const v = vals[key];
    let status, note = v?.note || null;
    if (!handshake) { status = 'unavailable'; note = unreachable ? 'Backend unreachable: no reading.' : 'Hardware not connected: no reading.'; }
    else if (!v) { status = 'unavailable'; note = 'The device has not reported this value.'; }
    else if (v.origin === 'unavailable') status = 'unavailable';
    else if (!v.valid || (v.value !== null && !finite(v.value))) { status = 'invalid'; note = note || 'The device marked this reading invalid.'; }
    else if (v.value === null || v.value === undefined) { status = 'unavailable'; note = note || 'No value in the last frame.'; }
    else if (v.stale || !fresh) { status = 'stale'; note = 'Telemetry is stale: this is the last value received, not a live one.'; }
    else status = 'ok';
    return { key, label, unit, digits, value: handshake && v && finite(v.value) ? v.value : null, status, prov: v?.origin === 'device_command_state' ? 'COMMAND' : prov,
      observed: v?.received_unix ? `received ${ago(v.received_unix)}` : handshake ? 'not received' : '—', trend: handshake && HISTORY.has(key), note, ...extra };
  };

  const acc = vals.acceleration;
  const axes = acc && acc.valid && handshake ? [['x', acc.x_g], ['y', acc.y_g], ['z', acc.z_g]].filter(([, v]) => finite(v)) : [];
  const parts = [
    { id: 'hall', name: 'Speed sensor', short: 'Speed · Hall', part: 'A3144 Hall-effect sensor', iface: 'Digital interrupt (GPIO 9, unverified wiring)',
      readings: [read('rpm', 'Measured speed', 'rpm', 0), read('setpoint', 'Setpoint (device command state)', 'rpm', 0, { trend: false })],
      notes: ['The setpoint is what the firmware reports as commanded, not a measurement.'] },
    { id: 'temp', name: 'Temperature', short: 'Temp · DS18B20', part: 'DS18B20 one-wire probes', iface: '1-Wire (GPIO 6, unverified wiring)',
      readings: [read('housing', 'Housing temperature', '°C', 1), read('ambient', 'Ambient temperature', '°C', 1, { trend: false })],
      notes: ['Ambient is reported only if a second probe is fitted; the backend keeps no ambient history.'] },
    { id: 'ina', name: 'Voltage and current', short: 'Power · INA219', part: 'INA219 current / voltage monitor', iface: 'I²C bus 1 (SDA 7, SCL 8), 0x40',
      readings: [read('voltage', 'DC bus voltage', 'V', 2), read('current', 'Current', 'A', 3), { ...read('power', 'Power (V × I, computed by the firmware)', 'W', 1), ...(vals.power && handshake ? { prov: 'DERIVED' } : {}) }],
      notes: ['Power is computed by the firmware from the INA219 voltage and current; it is valid only when both are.'] },
    { id: 'accel', name: 'Accelerometer', short: 'Accel · ADXL345', part: 'ADXL345 accelerometer', iface: 'I²C bus 0 (SDA 16, SCL 17), 0x53',
      readings: [read('acceleration', 'Total acceleration (incl. gravity)', 'g', 3)],
      notes: [axes.length ? `Raw axes: ${axes.map(([a, v]) => `${a} ${fmt(v, 3)} g`).join(' · ')}` : 'No raw axis values in the last accelerometer frame.',
        'About 1 g at rest because gravity is included. This is not vibration RMS; the firmware does not compute one.'] },
    { id: 'driver', name: 'Motor driver', short: 'Drive · BTS7960', part: 'BTS7960 / IBT-2 driver', iface: 'RPWM 38, LPWM 39, R_EN 18, L_EN 21 (unverified wiring)',
      readings: [read('duty', 'Drive duty (device command state)', '%', 1)],
      notes: [`Drive state reported by the firmware: ${handshake ? title(snap.drive) || 'unknown' : 'unknown (not connected)'}.`, 'Commands are not available on this page.'] },
    { id: 'controller', name: 'Controller', short: 'Controller · ESP32-S3', part: 'ESP32-S3 with SH1106 OLED', iface: `USB serial${snap.port ? ` (${snap.port})` : ''}`,
      tone: !handshake ? (snap.connection === 'ERROR' ? 'crit' : 'off') : fresh ? 'ok' : 'warn',
      summary: unreachable ? 'state unknown' : !handshake ? 'not connected' : fresh ? 'telemetry live' : 'telemetry stale', readings: [],
      notes: [handshake ? `Device ${snap.device_id || '—'}, firmware ${snap.firmware || '—'}, last frame ${ago(snap.last_rx_unix)}.` : (snap.autoconnect?.note || 'No TORQVA board has completed the handshake.'),
        physical ? 'The board reports physical measurements.' : handshake ? 'The firmware reports SIMULATION mode: its values are not physical measurements.' : 'No board, so no physical readings exist.'] },
  ];

  const rpm = vals.rpm;
  const spinning = !!(physical && fresh && rpm && rpm.valid && !rpm.stale && finite(rpm.value) && rpm.value > 50);
  const motion = {
    spinning, rpm: spinning ? rpm.value : null,
    note: unreachable ? 'The shaft is drawn still: the backend is not answering, so the motion is unknown.' : !handshake ? 'The shaft is drawn still: no hardware is connected, so its motion is unknown.' : !physical ? 'The shaft is drawn still: the firmware reports simulation mode, not physical motion.'
      : !fresh ? 'The shaft is drawn still: telemetry is stale, so the current motion is unknown.' : spinning ? 'The shaft turns because the device reports a fresh, valid speed above 50 rpm.'
      : 'The shaft is drawn still: the measured speed is invalid, unavailable or below 50 rpm.',
  };

  const state = unreachable ? { tone: 'crit', label: 'BACKEND UNREACHABLE', detail: handshake ? `Device state unknown. The values shown are the last ones received (${ago(snap.last_rx_unix)}), not live.` : 'Device state unknown: the backend is not answering.' }
    : !handshake ? { tone: snap.connection === 'ERROR' ? 'crit' : 'off', label: 'HARDWARE NOT CONNECTED', detail: snap.error?.message || 'Physical readings are unavailable.' }
    : !physical ? { tone: 'warn', label: 'FIRMWARE SIMULATION MODE', detail: 'The board reports simulated values, not physical measurements.' }
    : !fresh ? { tone: 'warn', label: 'TELEMETRY STALE', detail: `Last frame ${ago(snap.last_rx_unix)}. Shown values are not live.` }
    : snap.safety_state === 'EMERGENCY_STOP' ? { tone: 'stop', label: 'SAFETY TRIP LATCHED', detail: title(snap.trip_reason) }
    : { tone: snap.safety_state === 'OK' ? 'ok' : 'warn', label: `DRIVE ${title(snap.drive) || 'UNKNOWN'}`, detail: `Drive state as reported by the firmware (not measured motion); safety state ${title(snap.safety_state) || 'unknown'}` };

  const layers = snap.analysis?.layers || {};
  // AI layers that report the same status and reason are listed once ("C1, C2, C4, C5: WAITING ...").
  const groups = [];
  Object.entries(layers).filter(([k]) => ['C1', 'C2', 'C4', 'C5'].includes(k)).forEach(([k, l]) => {
    const g = groups.find((x) => x.status === l.status && x.reason === l.reason);
    if (g) g.keys.push(k); else groups.push({ keys: [k], status: l.status, reason: l.reason });
  });
  const findings = [
    ...groups.map((g) => ({ tone: ['ACTIVE', 'AVAILABLE', 'READY', 'VERIFIED'].includes(g.status) ? 'ok' : 'off', label: `${g.keys.join(', ')}: ${title(g.status)}`, detail: g.reason })),
    { tone: (snap.control_blockers || []).length ? 'stop' : 'info', label: (snap.control_blockers || []).length ? `Motion locked: ${snap.control_blockers[0]}` : 'No motion blocker reported', detail: 'Read-only here; the Safety Supervisor decides.' },
  ];
  if (!handshake) findings.push({ tone: 'info', label: 'Connect a board', detail: 'Connection is managed on the Device page.', go: ['device', 'Device'] });
  const facts = [
    ['Origin', physical ? 'Physical device measurements (USB serial)' : handshake ? 'Board in firmware simulation mode' : 'None: no board connected'],
    ['Connection', snap.state_label || snap.connection || 'unknown'],
    ['Device', handshake ? `${snap.device_id || '—'} · firmware ${snap.firmware || '—'}` : '—'],
    ['Last frame', ago(snap.last_rx_unix)],
    ['Wiring', 'Intended pin map only (pinmap.h); not verified on the real rig'],
  ];
  // Component-level evidence only, and only while the device state is known: a reading the device itself marked invalid, and a latched safety trip
  // attributed to the reading it tripped on. Neither is a diagnosis of the part.
  const alerts = [];
  if (handshake && !unreachable) {
    for (const p of parts) for (const r of p.readings) if (r.status === 'invalid') alerts.push({ part: p.id, tone: 'crit', kind: 'observation', label: `${r.label}: invalid`,
      detail: 'The device marked this reading invalid. The sensor, its wiring or its interface may be at fault; this is not a diagnosis.' });
    const trip = snap.safety_state === 'EMERGENCY_STOP' ? TRIP_PART[snap.trip_reason] : null;
    if (trip) alerts.push({ part: trip[0], tone: 'stop', kind: 'trip', label: `Safety trip latched: ${title(snap.trip_reason)}`,
      detail: `The firmware latched this trip from ${trip[1]}. It records what tripped, not which part failed.` });
  }
  return {
    source: 'PHYSICAL', loading: false, state, clock: null,
    connection: unreachable ? { tone: 'crit', label: 'backend unreachable' } : !handshake ? { tone: 'off', label: 'hardware not connected' } : fresh ? { tone: 'ok', label: 'telemetry live' } : { tone: 'warn', label: 'telemetry stale' },
    freshness: !handshake ? 'none' : fresh ? 'live' : 'stale',
    updated: handshake ? ago(snap.last_rx_unix) : 'never', motion, parts, findings, facts, alerts,
    kpis: [['hall', 'rpm'], ['temp', 'housing'], ['ina', 'voltage'], ['ina', 'current'], ['ina', 'power'], ['accel', 'acceleration'], ['driver', 'duty']],
  };
}

/** Device history for one signal (GET /device/history, read-only), refreshed while the trend is on screen. */
function PhysTrend({ reading }) {
  const [points, setPoints] = useState(null);
  const [err, setErr] = useState(null);
  const load = useCallback(() => api.deviceHistory(reading.key, 120).then((r) => { setPoints(Array.isArray(r?.points) ? r.points : []); setErr(null); }).catch(setErr), [reading.key]);
  useEffect(() => { setPoints(null); load(); const id = setInterval(load, 2000); return () => clearInterval(id); }, [load]);
  if (err) return <ErrorBox error={err} />;
  if (points === null) return <Empty loading>Loading device history…</Empty>;
  if (!points.length) return <Empty>No device history for the last 2 minutes. History exists only while a board is sending telemetry.</Empty>;
  return (
    <div role="img" aria-label={`${reading.label} history`} className="tq-chart">
      <HistoryChart data={points.map(([t, v]) => ({ t, v }))} name={`${reading.label} (${reading.unit})`} height={190} />
      <p className="tq-chart-note">Wall-clock time, last 2 minutes. Gaps mean invalid readings or a disconnect; they are never drawn as zero.</p>
    </div>
  );
}

export function PhysTwinPage({ stream, go }) {
  const model = physTwin(stream.snap, { unreachable: stream.unreachable });
  return <DigitalTwin model={model} go={go} renderTrend={(part, reading) => <PhysTrend reading={reading} />}
    aside={<p className="tq-muted tq-tw-aside">This page is read-only. It sends no command to the device.</p>} />;
}
