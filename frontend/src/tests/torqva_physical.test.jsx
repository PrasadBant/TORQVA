import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import TorqvaApp from '../torqva/TorqvaApp.jsx';
import { setToken } from '../torqva/api.js';

// Mocked backend responses (frontend behaviour only: NOT physical-device verification).
const ok = (j) => ({ ok: true, status: 200, json: async () => j });
const now = Date.now() / 1000;
const val = (v, unit, extra = {}) => ({ value: v, valid: v !== null, stale: false, origin: 'device_measurement', unit, device_id: 'RIG-1', received_unix: now, ...extra });
const CONNECTED = {
  connection: 'CONNECTED', handshake: true, identity: 'unverified', device_id: 'RIG-1', origin: 'physical_device', state_label: 'PHYSICAL DEVICE CONNECTED', port: 'COM7', firmware: '3.0.1', wire_protocol: 1, firmware_mode: 'HW',
  safety_state: 'OK', trip_reason: 'NONE', drive: 'IDLE', telemetry_fresh: true, last_rx_unix: now, counters: { frames: 5 }, last_error: '',
  values: { rpm: val(0, 'rpm'), current: val(0.12, 'A'), voltage: val(null, 'V'), power: val(null, 'W'), housing: val(25.6, '°C'), duty: val(0, '%', { origin: 'device_command_state' }),
    acceleration: val(0.96, 'g'), vibration: { value: null, valid: false, stale: false, origin: 'unavailable' } },
  sensor_status: { rpm: 'valid', current: 'valid', voltage: 'invalid', housing: 'valid', acceleration: 'valid', vibration_rms: 'unavailable' },
  control_blockers: ['PHYSICAL CONTROL DISABLED', 'NO APPROVED DUTY LIMIT'], physical_control_enabled: false, session: { active: false, key_provisioned: false, state: 'none' },
  analysis: { basis: 'physical_device', state: 'TELEMETRY VALID, ANALYSIS NOT AVAILABLE', reason: 'valid measurements are arriving, but the analysis models cannot consume them yet', missing_inputs: ['vib_rms'],
    layers: { C1: { status: 'NOT AVAILABLE', basis: 'physical_device', reason: 'C1 needs vibration RMS; missing: vib_rms' }, C3: { status: 'physical motion BLOCKED', basis: 'physical_device', reason: 'Safety Supervisor decides' },
      C2: { status: 'NOT AVAILABLE', basis: 'physical_device', reason: 'no validated model' }, C4: { status: 'NOT AVAILABLE', basis: 'physical_device', reason: 'x' }, C5: { status: 'NOT AVAILABLE', basis: 'physical_device', reason: 'x' },
      C6: { status: 'NOT AVAILABLE', basis: 'physical_device', reason: 'x' }, HYPOTHESES: { status: 'NOT AVAILABLE', basis: 'physical_device', reason: 'x' } } },
  autoconnect: { configured: false, note: 'no device port is configured' },
};
const DISCONNECTED = {
  connection: 'DISCONNECTED', handshake: false, identity: 'unknown', origin: 'none', state_label: 'DISCONNECTED', telemetry_fresh: false, values: {}, counters: { frames: 0 }, last_error: '',
  control_blockers: ['PHYSICAL CONTROL DISABLED', 'DEVICE NOT CONNECTED'], physical_control_enabled: false, session: { active: false, key_provisioned: false, state: 'none' },
  analysis: { basis: 'none', state: 'WAITING FOR VALID PHYSICAL TELEMETRY', reason: 'no device handshake (DEVICE DISCONNECTED or not a TORQVA device)',
    layers: Object.fromEntries(['C1', 'HYPOTHESES', 'C2', 'C4', 'C5', 'C6'].map((k) => [k, { status: 'WAITING FOR VALID PHYSICAL TELEMETRY', basis: 'none', reason: 'no device handshake' }])) },
  autoconnect: { configured: false, note: 'no device port is configured (set TORQVA_DEVICE_PORT); connect from the Device page' },
};

function server(snap) {
  const calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url, o = {}) => {
    const path = String(url).replace('/api/torqva', '').split('?')[0];
    calls.push(path);
    if (path === '/me') return ok({ user: 'tester', role: 'admin' });
    if (path === '/device/status') return ok(snap);
    if (path === '/device/commands') return ok({ commands: [] });
    if (path === '/device/commissioning') return ok({ items: [], limits: null, enable: null, enable_allowed: false, enable_phrase: 'X', note: '' });
    if (path === '/device/ports') return ok({ ports: [] });
    if (path === '/device/history') return ok({ points: [], origin: 'physical_device' });
    if (path === '/status') return ok({ mode: 'SIMULATION', device: {}, models: {}, t: 5, last_window: { rpm: 1500, current: 1.0, voltage: 24, housing: 40, vib_rms: 0.2 } });
    return ok(path === '/telemetry' ? { samples: [] } : []);
  }));
  return calls;
}
const FakeWs = class { constructor() { setTimeout(() => this.onopen && this.onopen(), 0); } send() {} close() {} };

async function open(snap, page) {
  const calls = server(snap);
  setToken('t');
  render(<TorqvaApp pollMs={100000} wsFactory={(u) => new FakeWs(u)} />);
  await screen.findByText(/tester · /);
  if (page) fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${page}`) }));
  return calls;
}

beforeEach(() => { vi.unstubAllGlobals(); setToken(''); window.localStorage.removeItem('torqva.mode'); });

describe('physical-device-first application', () => {
  it('defaults to physical mode: disconnected shows DEVICE DISCONNECTED, no simulated numbers and no simulator calls', async () => {
    const calls = await open(DISCONNECTED);
    expect(await screen.findByTestId('phys-banner')).toHaveTextContent('DEVICE DISCONNECTED');
    expect(await screen.findByTestId('phys-disconnected')).toHaveTextContent('Physical readings are unavailable');
    expect(screen.queryByTestId('sim-banner')).toBeNull();
    const kpis = screen.getByTestId('phys-kpis');
    expect(kpis).toHaveTextContent('UNAVAILABLE'); expect(kpis).not.toHaveTextContent(/1500|24\.0|40\.0/);
    expect(calls.filter((c) => ['/status', '/telemetry', '/incidents', '/simulation/start', '/simulation/step'].includes(c))).toEqual([]);        // the simulator is never touched
    expect(screen.queryByText(/NORMAL/)).toBeNull();
  });

  it('shows real readings with units and freshness, marks the invalid sensor, and explains why commands are blocked', async () => {
    await open(CONNECTED);
    expect(await screen.findByTestId('phys-banner')).toHaveTextContent('PHYSICAL DEVICE CONNECTED');
    const kpis = await screen.findByTestId('phys-kpis');
    expect(kpis).toHaveTextContent('0.120 A'); expect(kpis).toHaveTextContent('25.6 °C'); expect(kpis).toHaveTextContent('0.960 g');
    expect(within(screen.getByTestId('tile-Voltage')).getByText('UNAVAILABLE')).toBeInTheDocument();                                              // invalid voltage is not zero
    expect(screen.getByTestId('sensor-gaps')).toHaveTextContent('voltage: invalid'); expect(screen.getByTestId('sensor-gaps')).not.toHaveTextContent('vibration');      // unimplemented vibration RMS is not a sensor fault
    expect(screen.getByTestId('phys-blockers')).toHaveTextContent('NO APPROVED DUTY LIMIT');
    expect(screen.getByTestId('motor-state')).toHaveTextContent('STOPPED');
    expect(screen.getByTestId('status-strip')).toHaveTextContent('sensors 4/5 valid');
  });

  it('a stale device is never shown as live and the motor state is UNKNOWN', async () => {
    await open({ ...CONNECTED, telemetry_fresh: false, values: { ...CONNECTED.values, rpm: val(1200, 'rpm', { stale: true }) } });
    expect(await screen.findByTestId('phys-banner')).toHaveTextContent('TELEMETRY STALE');
    expect(screen.getByTestId('motor-state')).toHaveTextContent('UNKNOWN');
    expect(within(screen.getByTestId('tile-Measured speed (Hall)')).getByText(/STALE/)).toBeInTheDocument();
  });

  it.each([['AI Diagnostics', 'C1'], ['Predictions', 'C2'], ['Diagnostic Tests', 'C4'], ['Recovery', 'C5'], ['Learning', 'C6']])('%s waits for valid physical telemetry and shows no simulated result', async (page, layer) => {
    await open(DISCONNECTED, page);
    const box = await screen.findByTestId(`layer-${layer}`);
    expect(box).toHaveTextContent('WAITING FOR VALID PHYSICAL TELEMETRY');
    expect(screen.queryByText(/SIM$/)).toBeNull(); expect(screen.queryByText(/%/)).toBeNull();
  });

  it('with a valid device the AI pages say exactly why they cannot run and never show a green status', async () => {
    await open(CONNECTED, 'AI Diagnostics');
    const box = await screen.findByTestId('layer-C1');
    expect(box).toHaveTextContent('NOT AVAILABLE'); expect(box).toHaveTextContent('vib_rms'); expect(box).not.toHaveTextContent(/NORMAL|HEALTHY/i);
  });

  it('Live Monitor and Lab never use simulated data in physical mode', async () => {
    const calls = await open(DISCONNECTED, 'Live Monitor');
    expect(await screen.findByTestId('phys-live-empty')).toHaveTextContent('DEVICE DISCONNECTED');
    fireEvent.click(screen.getByRole('button', { name: /^Lab/ }));
    expect(await screen.findByTestId('lab-sim-note')).toHaveTextContent('SIMULATION ONLY');
    fireEvent.click(screen.getByRole('button', { name: /^Evaluation/ }));
    expect(await screen.findByTestId('eval-sim-note')).toHaveTextContent('SIMULATION EVIDENCE');
    expect(calls).not.toContain('/simulation/start');
  });

  it('simulation is entered only by an explicit choice, is labelled, is remembered, and can be left again', async () => {
    const calls = await open(DISCONNECTED);
    await screen.findByTestId('phys-banner');
    expect(window.localStorage.getItem('torqva.mode')).toBeNull();                                                                               // nothing was selected automatically
    fireEvent.click(screen.getByRole('button', { name: 'Simulation mode (demo)' }));
    expect(await screen.findByTestId('sim-banner')).toHaveTextContent('SIMULATION');
    expect(window.localStorage.getItem('torqva.mode')).toBe('SIMULATION');
    await waitFor(() => expect(calls).toContain('/status'));
    fireEvent.click(screen.getByRole('button', { name: 'Physical mode' }));
    expect(await screen.findByTestId('phys-banner')).toBeInTheDocument();
  });

  it('a connection failure is shown, never replaced by simulation', async () => {
    await open({ ...DISCONNECTED, connection: 'ERROR', state_label: 'CONNECTION ERROR', autoconnect: { configured: true, port: 'COM7', last_error: 'cannot open COM7' } });
    expect(await screen.findByTestId('phys-disconnected')).toHaveTextContent('cannot open COM7');
    expect(screen.queryByTestId('sim-banner')).toBeNull();
  });

  it('has no permanent "disabled by default" banner: the status names the actual blocker and only the affected operations are disabled', async () => {
    await open(CONNECTED);
    await screen.findByTestId('motor-state');
    expect(screen.queryByText(/DISABLED BY DEFAULT/)).toBeNull();
    expect(screen.getByTestId('phys-banner')).toHaveTextContent('Motion unavailable: PHYSICAL CONTROL DISABLED (+1 more)');
    expect(screen.getByTestId('status-strip')).toHaveTextContent('motion locked: PHYSICAL CONTROL DISABLED');
    expect(screen.getByTestId('btn-start')).toBeDisabled(); expect(screen.getByTestId('btn-speed')).toBeDisabled();
    expect(screen.getByTestId('btn-stop')).not.toBeDisabled();                                                          // STOP stays available while connected
    expect(screen.getByTestId('why-disabled')).toHaveTextContent('PHYSICAL CONTROL DISABLED');
  });

  it('STOP goes through the real command path and the result shows the backend state, not "stopped"', async () => {
    const calls = []; server(CONNECTED);
    const f = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (url, o = {}) => { if (String(url).endsWith('/device/commands') && o.method === 'POST') { calls.push(JSON.parse(o.body)); return ok({ id: 7, action: 'STOP', state: 'SENT', reasons: [], requested_by: 'tester' }); } return f(url, o); }));
    setToken('t'); render(<TorqvaApp pollMs={100000} wsFactory={(u) => new FakeWs(u)} />);
    await screen.findByTestId('btn-stop');
    fireEvent.click(screen.getByTestId('btn-stop'));
    const line = await screen.findByTestId('last-command');
    expect(calls).toEqual([{ action: 'STOP' }]); expect(line).toHaveTextContent('SENT'); expect(line).not.toHaveTextContent(/EXECUTED|stopped/i);
  });

  it('when the device is disconnected STOP is disabled with an explanation', async () => {
    await open(DISCONNECTED);
    await screen.findByTestId('btn-stop');
    expect(screen.getByTestId('btn-stop')).toBeDisabled(); expect(screen.getByText(/STOP cannot be delivered/)).toBeInTheDocument();
  });

  it('START is a two-step request bounded by the approved limit and posts only after confirmation', async () => {
    const posted = [];
    server({ ...CONNECTED, control_blockers: [], control_limits: { max_duty_pct: 30, max_rpm: 2000 } });
    const base = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (url, o = {}) => { if (String(url).endsWith('/device/commands') && o.method === 'POST') { posted.push(JSON.parse(o.body)); return ok({ id: 8, action: 'START', state: 'REJECTED', reasons: ['hardware_control_not_enabled'], requested_by: 'tester' }); } return base(url, o); }));
    setToken('t'); render(<TorqvaApp pollMs={100000} wsFactory={(u) => new FakeWs(u)} />);
    const duty = await screen.findByLabelText('Duty percent');
    expect(duty).toHaveAttribute('max', '30');                                                                           // the ceiling comes from the approved limit, not a hard-coded range
    fireEvent.change(duty, { target: { value: '20' } });
    fireEvent.click(screen.getByTestId('btn-start')); expect(posted).toEqual([]);
    fireEvent.click(screen.getByTestId('btn-start'));
    await waitFor(() => expect(posted).toEqual([{ action: 'START', duty_pct: 20 }]));
    expect(await screen.findByTestId('last-command')).toHaveTextContent('REJECTED');
  });

  it('the Safety & Commissioning page holds the commissioning record and history, not the controls', async () => {
    await open(CONNECTED, 'Safety');
    expect(await screen.findByText('Commissioning record')).toBeInTheDocument();
    expect(screen.getByText('Command history')).toBeInTheDocument();
    expect(screen.queryByTestId('btn-start')).toBeNull();
  });

  it('shows live availability instead of a generic banner: available only when the backend reports no blocker', async () => {
    await open({ ...CONNECTED, control_blockers: [], control_limits: { max_duty_pct: 30, max_rpm: 2000 } });
    expect(await screen.findByTestId('availability')).toHaveTextContent('START / speed available');
    expect(screen.queryByTestId('why-disabled')).toBeNull();
    expect(screen.getByTestId('btn-start')).toBeDisabled();                                                               // still needs a duty value
  });

  it('shows the specific first reason when locked', async () => {
    await open({ ...CONNECTED, control_blockers: ['SAFETY FAULT LATCHED: SENSOR_INVALID', 'PHYSICAL CONTROL DISABLED'] });
    expect(await screen.findByTestId('availability')).toHaveTextContent('START / speed unavailable');
    expect(screen.getByTestId('why-disabled')).toHaveTextContent('SAFETY FAULT LATCHED: SENSOR_INVALID');
  });

  it('shows the E-stop input state and the exact transport label, never calling the link encrypted', async () => {
    await open({ ...CONNECTED, estop_input: { state: 1, label: 'ASSERTED (pressed, open circuit or broken wire)' }, transport_label: 'AUTHENTICATED USB - UNENCRYPTED', session: { active: true, key_provisioned: true, state: 'active' } });
    const strip = await screen.findByTestId('status-strip');
    expect(strip).toHaveTextContent('E-stop input: asserted'); expect(strip).toHaveTextContent('AUTHENTICATED USB - UNENCRYPTED');
    expect(strip).not.toHaveTextContent(/encrypted USB|secure link/i);
  });
});

