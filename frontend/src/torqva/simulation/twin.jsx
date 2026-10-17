// Digital Twin, simulation mode: maps the simulator API (/status and /telemetry, already polled by TorqvaApp) onto the shared twin workspace.
// Nothing is generated here: every value is the simulator's own, tagged SIMULATED. The only number computed in the browser is power = V x I of the same
// simulated window, tagged DERIVED and used for display only. The page sends no command; scenarios are started on the existing Live Monitor / Lab pages.
import React from 'react';
import { DigitalTwin } from '../shared/twin.jsx';
import { TrendLines } from '../shared/lazyCharts.jsx';
import { Empty, fmt, stateTone } from '../shared/components.jsx';

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const title = (s) => String(s ?? '').replaceAll('_', ' ');
// The simulated device's e-stop reasons (simdevice._check_safety) and the sensor whose simulated reading tripped it.
const SIM_TRIP_PART = { TEMP_STOP: 'temp', OVER_CURRENT_INSTANT: 'ina', VOLTAGE: 'ina', HEARTBEAT_LOST: 'controller' };
// Where the simulator applies each injectable fault (sim.py): the component the scenario's ground truth refers to.
const FAULT_PART = { imbalance: ['shaft', 'mass imbalance on the rotating disc'], looseness: ['base', 'loose mounting'], overload: ['shaft', 'extra load on the output'],
  cooling_failure: ['motor', 'reduced cooling of the motor'], supply_voltage: ['psu', 'a supply-voltage fault'], sensor_fault: ['accel', 'noise on the vibration channels'] };

/** Pure mapping, exported for tests. `running` = the browser is auto-advancing simulation time; `stale` = the backend stopped answering. */
export function simTwin(d, { running = false, stale = false } = {}) {
  const st = d?.status;
  if (!st) return { source: 'SIMULATION', loading: !stale, ...(stale ? noData('Backend unreachable', 'No simulator state has been received.') : {}) };
  const hasRun = st.t !== undefined && st.t !== null;
  const w = hasRun ? st.last_window : null;
  const samples = d?.telemetry?.samples || [];
  const last = samples[samples.length - 1];
  const when = w ? `simulation t = ${fmt(w.t, 0)} s` : '—';
  const status = (v) => (!hasRun || !w ? 'unavailable' : w.valid === false ? 'invalid' : !finite(v) ? 'unavailable' : stale ? 'stale' : 'ok');
  const why = !hasRun ? 'No simulation has been started.' : !w ? 'The simulation has produced no window yet.' : w.valid === false ? 'The simulator marked this window invalid.' : stale ? 'The backend stopped answering: this is the last value received, not the current one.' : null;
  const rd = (key, label, unit, digits, value, extra = {}) => ({ key, label, unit, digits, value: finite(value) ? value : null, status: status(value), prov: 'SIMULATED', observed: when, trend: hasRun, note: why, ...extra });

  const V = w?.voltage, I = w?.current;
  const power = finite(V) && finite(I) ? V * I : null;
  const sp = st.device?.setpoint_rpm;
  const parts = [
    { id: 'hall', name: 'Speed sensor', short: 'Speed · Hall', part: 'A3144 Hall-effect sensor', iface: 'Simulated speed channel',
      readings: [rd('rpm', 'Shaft speed', 'rpm', 0, w?.rpm), rd('setpoint', 'Setpoint (command)', 'rpm', 0, sp, { trend: false, observed: 'commanded value, not a measurement' })],
      notes: ['The simulated speed includes measurement noise; the setpoint is what the simulated controller was asked for.'] },
    { id: 'temp', name: 'Housing temperature', short: 'Temp · DS18B20', part: 'DS18B20 one-wire probe', iface: 'Simulated temperature channel',
      readings: [rd('housing', 'Housing temperature', '°C', 1, w?.housing)],
      notes: ['The simulator does not report ambient temperature to this page, so none is shown.'] },
    { id: 'ina', name: 'Voltage and current', short: 'Power · INA219', part: 'INA219 current / voltage monitor', iface: 'Simulated electrical channels',
      readings: [rd('voltage', 'DC bus voltage', 'V', 2, V), rd('current', 'Current', 'A', 3, I),
        { ...rd('power', 'Power (V × I)', 'W', 1, power), prov: 'DERIVED', status: status(V) === 'ok' && status(I) === 'ok' ? 'ok' : status(power), note: why || 'Voltage × current of the same simulated window, computed for display only.' }] },
    { id: 'accel', name: 'Vibration', short: 'Vibration · ADXL345', part: 'ADXL345 accelerometer position', iface: 'Simulated vibration channel',
      readings: [rd('vib_rms', 'Vibration RMS (simulated)', 'g', 3, w?.vib_rms)],
      notes: ['This is the simulator\'s vibration model. The physical ADXL345 reports raw acceleration including gravity, and the firmware computes no vibration RMS.'] },
    { id: 'driver', name: 'Motor driver', short: 'Drive · BTS7960', part: 'BTS7960 / IBT-2 driver', iface: 'Simulated drive command',
      readings: [rd('duty', 'Drive duty', '%', 1, w?.duty)],
      notes: ['Duty is the simulated controller output, not a measurement.'] },
    { id: 'controller', name: 'Controller', short: 'Controller · ESP32-S3', part: 'ESP32-S3 with SH1106 OLED', iface: 'Not used: the software simulator replaces the board',
      tone: stale ? 'warn' : hasRun ? 'ok' : 'off', summary: stale ? 'backend unreachable' : hasRun ? 'software simulator' : 'no simulation', readings: [],
      notes: ['In simulation mode no board is involved; the backend\'s simulator produces every value.'] },
  ];

  const rpm = w?.rpm;
  const spinning = !!(hasRun && running && !stale && w && w.valid !== false && finite(rpm) && rpm > 5);
  const motion = {
    spinning, rpm: spinning ? rpm : null,
    note: !hasRun ? 'The shaft is still because no simulation is running.' : stale ? 'The shaft is still because the backend is not answering.' : !running ? 'The shaft is still because simulation time is paused.'
      : spinning ? 'The shaft turns because the simulator reports a valid, non-zero speed.' : 'The shaft is still because the simulated speed is zero or not valid.',
  };

  const inc = st.incident;
  const state = stale ? { tone: 'crit', label: 'BACKEND UNREACHABLE', detail: hasRun ? `Simulator state unknown. The values shown are the last ones received (${when}), not current.` : 'Simulator state unknown.' }
    : !hasRun ? { tone: 'off', label: 'NO SIMULATION RUNNING', detail: 'Start a scenario from the Simulation Overview or Live Monitor page.' }
    : st.device?.estop ? { tone: 'stop', label: 'E-STOP (SIMULATED)', detail: st.device.estop_reason || 'The simulated device latched a stop.' }
    : inc ? { tone: stateTone(inc.state), label: `INCIDENT ${inc.id}: ${title(inc.state)}`, detail: 'An open incident in the simulated pipeline.' }
    : !finite(rpm) ? { tone: 'off', label: 'SPEED UNAVAILABLE', detail: why }
    : (sp ?? 0) <= 0 ? (rpm > 5 ? { tone: 'info', label: 'COASTING DOWN', detail: `${fmt(rpm, 0)} rpm, setpoint 0` } : { tone: 'off', label: 'STOPPED', detail: 'Simulated motor at rest.' })
    : { tone: 'ok', label: 'RUNNING', detail: `${fmt(rpm, 0)} rpm at setpoint ${fmt(sp, 0)} rpm` };

  const sc = st.scenario || {};
  const findings = [];
  if (hasRun) {
    if (last) findings.push({ tone: last.score_status === 'OK' ? (last.score != null && last.score > 1 ? 'warn' : 'ok') : 'info', label: `C1 anomaly score: ${last.score == null ? title(last.score_status) : `${fmt(last.score, 2)} × threshold`}`,
      detail: last.score == null ? 'This window was not scored.' : 'Ratio to the learned threshold (1 = threshold).', go: ['diagnostics', 'AI Diagnostics'] });
    findings.push(inc ? { tone: stateTone(inc.state), label: `Incident ${inc.id}: ${title(inc.state)}`, detail: `${Number.isFinite(inc.tests_run) ? inc.tests_run : 0} diagnostic test(s) run`, go: ['diagnostics', 'AI Diagnostics'] }
      : { tone: 'ok', label: 'No open incident', detail: `${st.closed_incidents || 0} closed in this run` });
    if (st.pending_approval) findings.push({ tone: 'wait', label: `Awaiting approval: ${title(st.pending_approval.action)}`, detail: st.pending_approval.rationale, go: ['interventions', 'Interventions'] });
    // TORQVA's own diagnosis, kept apart from the scenario's ground truth: a system-level ranking, so it marks no part on the model.
    const hy = inc ? [...(d?.log || [])].reverse().find((l) => l.kind === 'hypotheses' && l.incident === inc.id) : null;
    if (hy?.ranked?.length) findings.push({ tone: hy.label === 'confident' ? 'warn' : 'info', label: `TORQVA diagnosis: ${title(hy.ranked[0][0])} ${fmt(hy.ranked[0][1] * 100, 0)}% (${hy.label})`,
      detail: 'Ranked by the hypothesis stage from the simulated evidence. It is the AI output, not the scenario ground truth.', go: ['diagnostics', 'AI Diagnostics'] });
    findings.push({ tone: 'info', label: `C2: ${st.models?.c2_label || 'unknown'}`, go: ['predictions', 'Predictions'] });
  }
  const facts = [
    ['Origin', 'Backend software simulator (deterministic; seeded)'],
    ['Scenario', !hasRun ? 'none' : sc.fault ? `${title(sc.fault)} at severity ${fmt(sc.severity, 2)}, scheduled from t = ${sc.inject_after_s} s${sc.clears_below_rpm ? ` (the simulator clears it below ${sc.clears_below_rpm} rpm)` : ''}` : 'healthy run (no fault scheduled)'],
    ['Seed', hasRun && sc.seed !== undefined ? String(sc.seed) : '—'],
    ['Scenario ground truth', 'Shown because this is a simulation; it is not a diagnosis.'],
    ['Telemetry window', `${samples.length} sample(s), 1 per simulated second`],
  ];

  // Component-level evidence only: a simulated trip names the sensor whose reading tripped it, and the scenario's injected fault is ground truth
  // the simulation itself defines. An invalid window is system-wide, so it marks no single part. Nothing is inferred from scores or hypotheses.
  const alerts = [];
  if (hasRun && !stale) {
    const reason = st.device?.estop ? st.device.estop_reason : null;
    if (reason && SIM_TRIP_PART[reason]) alerts.push({ part: SIM_TRIP_PART[reason], tone: 'stop', kind: 'trip', label: `Simulated safety trip: ${title(reason)}`,
      detail: 'The simulated device latched this stop from this sensor\'s simulated reading. It records what tripped, not which part failed.' });
    const fp = sc.fault && FAULT_PART[sc.fault];
    if (fp && finite(st.t) && finite(sc.inject_after_s) && st.t >= sc.inject_after_s) alerts.push({ part: fp[0], tone: 'sim', kind: 'truth', label: `Injected fault: ${title(sc.fault)}`,
      detail: `The scenario injects ${fp[1]} at severity ${fmt(sc.severity, 2)} from t = ${sc.inject_after_s} s${sc.clears_below_rpm ? ` (the simulator clears it below ${sc.clears_below_rpm} rpm)` : ''}. Shown because this is a simulation; TORQVA did not detect or diagnose it.` });
  }

  return {
    source: 'SIMULATION', loading: false, state,
    clock: !hasRun ? { tone: 'off', label: 'not started' } : running ? { tone: 'ok', label: 'advancing' } : { tone: 'wait', label: 'paused' },
    connection: stale ? { tone: 'crit', label: 'backend unreachable' } : { tone: 'ok', label: 'backend connected' },
    freshness: stale ? (hasRun && w ? 'stale' : 'none') : hasRun && w ? 'live' : 'none',
    updated: stale ? `${when} (stale)` : when,
    motion, parts, findings, facts, alerts,
    kpis: [['hall', 'rpm'], ['temp', 'housing'], ['ina', 'voltage'], ['ina', 'current'], ['ina', 'power'], ['accel', 'vib_rms'], ['driver', 'duty']],
  };
}

function noData(label, detail) {
  return { loading: false, state: { tone: 'crit', label: label.toUpperCase(), detail }, clock: null, connection: { tone: 'crit', label: 'backend unreachable' }, freshness: 'none', updated: 'never',
    motion: { spinning: false, rpm: null, note: 'The shaft is still because there is no data.' }, parts: [], findings: [], facts: [], kpis: [], alerts: [] };
}

const SERIES = { rpm: [['rpm', 'Speed (rpm)', 'var(--tq-chart-1)'], ['setpoint', 'Setpoint (rpm)', 'var(--tq-chart-ink)', '4 3']],
  housing: [['housing', 'Housing (°C)', 'var(--tq-chart-2)']], voltage: [['voltage', 'Voltage (V)', 'var(--tq-chart-3)']], current: [['current', 'Current (A)', 'var(--tq-chart-4)']],
  power: [['power', 'Power, V × I (W)', 'var(--tq-chart-1)']], vib_rms: [['vib_rms', 'Vibration RMS, simulated (g)', 'var(--tq-chart-2)']], duty: [['duty', 'Duty (%)', 'var(--tq-chart-3)']] };

/** Trend of one reading over the telemetry window the app already holds (no extra request). */
function SimTrend({ samples, reading }) {
  const series = SERIES[reading.key];
  if (!series) return <Empty>No history is kept for this value.</Empty>;
  const data = samples.map((s) => ({ t: s.t, ...Object.fromEntries(series.map(([k]) => [k, k === 'power' ? (finite(s.voltage) && finite(s.current) ? s.voltage * s.current : null) : (finite(s[k]) ? s[k] : null)])) }));
  if (data.length < 2) return <Empty>Not enough simulated history yet. History appears as the simulation advances.</Empty>;
  return (
    <div role="img" aria-label={`${reading.label} over simulation time`} className="tq-chart">
      <TrendLines data={data} lines={series.map(([key, name, color, dash]) => ({ key, name, color, dash }))} height={190} digits={reading.digits} unit={reading.unit} />
      <p className="tq-chart-note">Simulation time in seconds; last {data.length} simulated seconds. SIMULATED data.</p>
    </div>
  );
}

export function SimTwinPage({ d, running, stale, go }) {
  const model = simTwin(d, { running, stale });
  const samples = d?.telemetry?.samples || [];
  return <DigitalTwin model={model} go={go} renderTrend={(part, reading) => <SimTrend samples={samples} reading={reading} />}
    aside={<p className="tq-muted tq-tw-aside">Scenarios, fault injection and stepping stay in the Scenario Studio on the <button type="button" className="tq-linkbtn" onClick={() => go('overview')}>Simulation Overview</button>, <button type="button" className="tq-linkbtn" onClick={() => go('live')}>Live Monitor</button> and <button type="button" className="tq-linkbtn" onClick={() => go('lab')}>Lab</button> pages.</p>} />;
}
