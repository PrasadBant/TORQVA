import React from 'react';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import TorqvaApp from '../torqva/TorqvaApp.jsx';
import { setToken } from '../torqva/api.js';

const ok = (j) => ({ ok: true, status: 200, json: async () => j });
const val = (v, extra = {}) => ({ value: v, valid: v !== null, stale: false, origin: 'device_measurement', ...extra });
const VALUES = { rpm: val(1200), current: val(1.5), voltage: val(24), power: val(36), housing: val(31.5), duty: val(30, { origin: 'device_command_state' }), setpoint: val(0),
  vibration: { value: null, valid: false, stale: false, origin: 'unavailable' } };
const SNAP = { connection: 'CONNECTED', handshake: true, identity: 'unverified', device_id: 'RIG-1', origin: 'physical_device', label: 'PHYSICAL DEVICE', firmware: '3.0.0', wire_protocol: 1,
  firmware_mode: 'HW', safety_state: 'OK', trip_reason: 'NONE', fault_mask: 0, drive: 'IDLE', start_blocked_reason: 'LIMITS_NOT_APPROVED', telemetry_fresh: true, telemetry_age_s: 0.2,
  last_rx_unix: Date.now() / 1000, values: VALUES, counters: { frames: 10, malformed: 0, gaps: 0 }, last_error: '',
  control_blockers: ['PHYSICAL CONTROL DISABLED', 'SECURE DEVICE TRANSPORT NOT CONFIGURED', 'SAFETY LIMITS NOT APPROVED'], physical_control_enabled: false,
  usb_trust_boundary: 'USB serial is unauthenticated' };
const DISCONNECTED = { connection: 'DISCONNECTED', handshake: false, identity: 'unknown', origin: 'none', label: 'SIMULATION', telemetry_fresh: false, values: { rpm: null }, counters: { frames: 0 },
  control_blockers: ['PHYSICAL CONTROL DISABLED', 'DEVICE NOT CONNECTED', 'SECURE DEVICE TRANSPORT NOT CONFIGURED'], physical_control_enabled: false, last_error: '' };

class FakeSocket {
  static last = null;
  constructor(url) { this.url = url; this.sent = []; FakeSocket.last = this; setTimeout(() => this.onopen && this.onopen(), 0); }
  send(m) { this.sent.push(m); }
  close() { this.onclose && this.onclose(); }
  emit(obj) { this.onmessage({ data: typeof obj === 'string' ? obj : JSON.stringify(obj) }); }
}
const wsFactory = (url) => new FakeSocket(url);

const COMM = { items: [{ id: 'estop', label: 'Independent hardware emergency stop installed and tested', status: 'NOT VERIFIED', evidence: '', by: null }, { id: 'wiring', label: 'Wiring confirmed', status: 'VERIFIED', evidence: 'bench check', by: 'adam' }], limits: null, enable: null, physical_control_enabled: false, enable_allowed: false, enable_phrase: 'ENABLE PHYSICAL CONTROL', note: 'A human record, not a measurement.' };

function server({ snap = DISCONNECTED, role = 'operator', commandResponse, commands = [], onCommand } = {}) {
  const calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url, o = {}) => {
    const path = String(url).replace('/api/torqva', '').split('?')[0];
    calls.push({ path, method: o.method || 'GET', body: o.body });
    if (path === '/me') return ok({ user: 'tester', role });
    if (path === '/status') return ok({ mode: 'SIMULATION', device: {}, models: {} });
    if (path === '/device/status') return ok(snap);
    if (path === '/device/commands' && (o.method || 'GET') === 'GET') return ok({ commands });
    if (path === '/device/commands') { onCommand && onCommand(JSON.parse(o.body)); return ok(commandResponse || { id: 11, action: 'STOP', state: 'SENT', reasons: [], requested_by: 'tester' }); }
    if (path === '/device/commissioning') return ok(COMM);
    if (path === '/device/ports') return ok({ ports: [{ device: 'COM7', description: 'USB Serial' }] });
    if (path === '/device/history') return ok({ points: [[Date.now() / 1000 - 2, 1100], [Date.now() / 1000 - 1, null], [Date.now() / 1000, 1200]], origin: 'physical_device' });
    if (path === '/attestation/references') return ok({ versions: [], active_version: null });
    if (path === '/attestation/warmup') return ok({ active: false });
    return ok(path === '/telemetry' ? { samples: [] } : []);
  }));
  return calls;
}

async function open(page, opts = {}) {
  const calls = server(opts);
  setToken('t');
  render(<TorqvaApp pollMs={100000} wsFactory={wsFactory} />);
  await screen.findByText(/tester · /);
  fireEvent.click(screen.getByRole('button', { name: page === 'Device' ? /^Device\s?USB$/ : new RegExp(`^${page}`) }));
  return calls;
}

beforeEach(() => { window.localStorage.setItem('torqva.mode', 'SIMULATION'); vi.unstubAllGlobals(); setToken(''); FakeSocket.last = null; });

describe('device pages', () => {
  it('without a device the app is in SIMULATION, says so, and offers no physical telemetry or controls', async () => {
    await open('Device');
    expect(await screen.findByText(/No device handshake/)).toBeInTheDocument();
    expect(screen.getAllByText('SIMULATION').length).toBeGreaterThan(0);
    expect(screen.queryByText('PHYSICAL DEVICE')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^Motor Control/ }));
    const box = await screen.findByTestId('control-blockers');
    expect(within(box).getByText('DEVICE NOT CONNECTED')).toBeInTheDocument();
    expect(within(box).getByText('PHYSICAL CONTROL DISABLED')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Request START/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Send STOP to device/ })).toBeDisabled();
  });

  it('after a verified handshake the device is labelled PHYSICAL, invalid sensors read UNAVAILABLE and vibration is unavailable', async () => {
    const snap = { ...SNAP, values: { ...VALUES, voltage: val(null), power: val(null) } };
    await open('Device', { snap });
    expect(await screen.findByText('RIG-1', { exact: false })).toBeInTheDocument();
    expect(screen.getAllByText('PHYSICAL DEVICE').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: /^Live Monitor/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Physical device' }));
    expect(await screen.findByText(/measurements reported by the connected ESP32-S3/)).toBeInTheDocument();
    expect(screen.getByText('1200')).toBeInTheDocument();
    expect(screen.getAllByText('UNAVAILABLE').length).toBeGreaterThanOrEqual(3);          // voltage, power, vibration
    expect(screen.getByText(/does not compute it/)).toBeInTheDocument();
  });

  it('stale telemetry is flagged and never presented as live', async () => {
    await open('Live Monitor', { snap: { ...SNAP, telemetry_fresh: false, telemetry_age_s: 7.4, connection: 'STALE' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Physical device' }));
    expect(await screen.findByText(/Telemetry is STALE/)).toBeInTheDocument();
  });

  it('a device whose firmware reports simulation mode is not labelled physical', async () => {
    await open('Device', { snap: { ...SNAP, origin: 'device_firmware_simulation', label: 'DEVICE (FIRMWARE SIMULATION MODE)', firmware_mode: 'SIM' } });
    expect((await screen.findAllByText('DEVICE (FIRMWARE SIMULATION MODE)')).length).toBeGreaterThan(0);
    expect(screen.queryByText('PHYSICAL DEVICE')).toBeNull();
  });

  it('authenticates the WebSocket with the token, applies snapshots and telemetry events, and ignores malformed messages', async () => {
    await open('Device', { snap: DISCONNECTED });
    await waitFor(() => expect(FakeSocket.last).not.toBeNull());
    await waitFor(() => expect(FakeSocket.last.sent.length).toBe(1));
    expect(JSON.parse(FakeSocket.last.sent[0])).toEqual({ type: 'auth', token: 't' });
    act(() => { FakeSocket.last.emit('not json'); FakeSocket.last.emit('[1,2]'); FakeSocket.last.emit({ type: 'weird' }); });
    expect(screen.getAllByText('SIMULATION').length).toBeGreaterThan(0);                  // nothing changed
    act(() => FakeSocket.last.emit({ type: 'snapshot', data: SNAP, commands: [] }));
    expect((await screen.findAllByText('PHYSICAL DEVICE')).length).toBeGreaterThan(0);
    act(() => FakeSocket.last.emit({ type: 'event', name: 'telemetry', ts: 1, data: { ...SNAP, values: { ...VALUES, rpm: val(1777) } } }));
    fireEvent.click(screen.getByRole('button', { name: /^Live Monitor/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Physical device' }));
    expect(await screen.findByText('1777')).toBeInTheDocument();
  });

  it('a disconnect event returns the page to SIMULATION instead of keeping fabricated live values', async () => {
    await open('Device', { snap: SNAP });
    await waitFor(() => expect(FakeSocket.last).not.toBeNull());
    expect((await screen.findAllByText('PHYSICAL DEVICE')).length).toBeGreaterThan(0);
    act(() => FakeSocket.last.emit({ type: 'event', name: 'telemetry', ts: 1, data: { ...DISCONNECTED } }));
    await waitFor(() => expect(screen.queryByText('PHYSICAL DEVICE')).toBeNull());
    expect(screen.getAllByText('SIMULATION').length).toBeGreaterThan(0);
  });

  it('motion stays blocked with the applicable reasons; STOP posts a request and its lifecycle state is shown (SENT is not EXECUTED)', async () => {
    const sent = [];
    await open('Motor Control', { snap: SNAP, onCommand: (b) => sent.push(b), commands: [{ id: 9, action: 'STOP', requested_by: 'tester', state: 'SENT', reasons: [] }] });
    const box = await screen.findByTestId('control-blockers');
    expect(within(box).getByText('SAFETY LIMITS NOT APPROVED')).toBeInTheDocument();
    expect(within(box).getByText('SECURE DEVICE TRANSPORT NOT CONFIGURED')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Request START/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Request speed/ })).toBeDisabled();
    expect(screen.getByText(/not an independent physical emergency stop/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Send STOP to device/ }));
    await waitFor(() => expect(sent).toEqual([{ action: 'STOP' }]));
    expect(await screen.findByText(/Last request #11/)).toBeInTheDocument();
    const table = screen.getByRole('table', { name: 'Device command history' });
    expect(within(table).getByText('SENT')).toBeInTheDocument();
    expect(screen.queryByText('EXECUTED')).toBeNull();
  });

  it('a rejected command shows the reasons it was refused', async () => {
    await open('Motor Control', { role: 'admin', snap: { ...SNAP, control_blockers: [] }, commandResponse: { id: 12, action: 'START', state: 'REJECTED', reasons: ['hardware_control_not_enabled'], requested_by: 'tester' }, commands: [] });
    await screen.findByText('Motor state');
    fireEvent.change(screen.getByLabelText(/Open-loop start duty/), { target: { value: '20' } });
    fireEvent.click(screen.getByRole('button', { name: /Request START/ }));
    expect(screen.queryByText(/hardware_control_not_enabled/)).toBeNull();                       // the first click only asks for confirmation: nothing is sent
    fireEvent.click(screen.getByRole('button', { name: /Confirm START request/ }));
    expect(await screen.findByText(/hardware_control_not_enabled/)).toBeInTheDocument();
  });

  it('a speed request needs an entered value, sends exactly that SET_SPEED once, and nothing is sent while typing', async () => {
    const sent = [];
    await open('Motor Control', { role: 'admin', snap: { ...SNAP, control_blockers: [] }, onCommand: (b) => sent.push(b), commandResponse: { id: 13, action: 'SET_SPEED', state: 'SENT', reasons: [], requested_by: 'tester' }, commands: [] });
    await screen.findByText('Motor state');
    expect(screen.getByRole('button', { name: /Request speed/ })).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Speed setting \(rpm\)/), { target: { value: '900' } });
    expect(sent).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: /Request speed/ }));
    await waitFor(() => expect(sent).toEqual([{ action: 'SET_SPEED', rpm: 900 }]));
    expect(screen.getByTestId('limits-note')).toHaveTextContent(/No approved duty or speed limit exists/);
  });

  it('limits are approved only with every value typed by the admin; nothing is filled in or sent as 0', async () => {
    const calls = await open('Motor Control', { role: 'admin', commands: [] });
    await screen.findByTestId('commissioning');
    const approve = screen.getByRole('button', { name: 'Approve limits' });
    expect(approve).toBeDisabled();
    expect(screen.getByTestId('limits-missing')).toHaveTextContent('Min supply voltage (V)');
    const typed = { 'Max current (A)': '2.5', 'Min supply voltage (V)': '18', 'Max supply voltage (V)': '24', 'Max housing temperature (°C)': '60', 'Max speed (rpm)': '3000' };
    for (const [l, v] of Object.entries(typed)) fireEvent.change(screen.getByLabelText(l), { target: { value: v } });
    expect(approve).toBeDisabled();                                                               // max duty still blank
    fireEvent.change(screen.getByLabelText('Max duty (%)'), { target: { value: '30' } });
    expect(approve).not.toBeDisabled();
    fireEvent.click(approve);
    await waitFor(() => expect(calls.some((c) => c.path === '/device/commissioning/limits')).toBe(true));
    expect(JSON.parse(calls.find((c) => c.path === '/device/commissioning/limits').body)).toMatchObject({ max_current_a: 2.5, min_voltage_v: 18, max_voltage_v: 24, max_temp_c: 60, max_rpm: 3000, max_duty_pct: 30 });
  });

  it('lists every interlock and never marks hardware checks verified', async () => {
    await open('Motor Control', { snap: { ...SNAP, interlocks: [{ id: 'estop', label: 'Emergency-stop circuit verified', status: 'NOT VERIFIED', detail: 'no E-stop input' }, { id: 'session', label: 'Secure session established', status: 'BLOCKED', detail: 'USB' }] }, commands: [] });
    const t = await screen.findByTestId('interlocks');
    expect(t).toHaveTextContent('NOT VERIFIED');
    expect(t).toHaveTextContent('BLOCKED');
    expect(t).not.toHaveTextContent(/^VERIFIED$/);
  });

  it('shows the commissioning record, offers edits to admins only, and never claims the record enables motion', async () => {
    await open('Motor Control', { role: 'admin', commands: [] });
    const t = await screen.findByTestId('commissioning');
    expect(t).toHaveTextContent('NOT VERIFIED'); expect(t).toHaveTextContent('bench check (adam)');
    expect(screen.getByText(/No limits are approved/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enable in the record' })).toBeDisabled();
    expect(screen.getByText(/does not enable motion/)).toBeInTheDocument();
  });

  it('shows the approved limit version and change history and asks for the confirmation phrase', async () => {
    const withLimits = { ...COMM, limits: { version: 2, by: 'adam', max_current_a: 2.5, min_voltage_v: 18, max_voltage_v: 24, max_temp_c: 60, max_rpm: 3000, max_duty_pct: 30 }, limits_confirm_phrase: 'APPROVE THESE LIMITS',
      limits_history: [{ version: 1, by: 'olga', at: 1700000000, previous: null, new: {} }, { version: 2, by: 'adam', at: 1700000100, previous: { max_current_a: 3, max_duty_pct: 30 }, new: { max_current_a: 2.5, max_duty_pct: 30 } }] };
    server({ role: 'admin' });
    const f = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (url, o) => (String(url).endsWith('/device/commissioning') ? ok(withLimits) : f(url, o))));
    setToken('t'); render(<TorqvaApp pollMs={100000} wsFactory={wsFactory} />);
    fireEvent.click(await screen.findByRole('button', { name: /^Device\s?USB$/ }));
    fireEvent.click(await screen.findByRole('button', { name: /^Motor Control/ }));
    expect(await screen.findByTestId('limits-approved')).toHaveTextContent('Version 2, approved by adam');
    expect(screen.getByTestId('limits-history')).toHaveTextContent('Max current (A): 3 → 2.5');
    expect(screen.getByText(/Type APPROVE THESE LIMITS to confirm/)).toBeInTheDocument();
  });

  it('a non-admin sees the record but no edit controls', async () => {
    await open('Motor Control', { role: 'operator', commands: [] });
    await screen.findByTestId('commissioning');
    expect(screen.queryByRole('button', { name: 'Attest' })).toBeNull();
  });

  it('a viewer can request STOP only and the safety fault is explained', async () => {
    await open('Motor Control', { role: 'viewer', snap: { ...SNAP, safety_state: 'EMERGENCY_STOP', trip_reason: 'OVER_CURRENT_INSTANT', control_blockers: ['SAFETY FAULT LATCHED: OVER_CURRENT_INSTANT'] } });
    expect(await screen.findByText(/LATCHED: OVER CURRENT INSTANT/)).toBeInTheDocument();
    expect(screen.getByText(/can request STOP only/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Send STOP to device/ })).toBeEnabled();
    expect(screen.getByRole('button', { name: /Request START/ })).toBeDisabled();
  });

  it('only admins see the connection form and it posts the chosen port', async () => {
    const calls = await open('Device', { role: 'admin' });
    const sel = await screen.findByLabelText(/^Port/);
    await waitFor(() => expect(within(sel).getByText(/COM7/)).toBeInTheDocument());
    fireEvent.change(sel, { target: { value: 'COM7' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(calls.some((c) => c.path === '/device/connect' && c.method === 'POST')).toBe(true));
    expect(JSON.parse(calls.find((c) => c.path === '/device/connect').body)).toMatchObject({ port: 'COM7', baud: 115200 });
  });

  it('operators cannot see the connection form', async () => {
    await open('Device', { role: 'operator' });
    expect(await screen.findByText(/requires the admin role/)).toBeInTheDocument();
  });

  it('shows the exact classified serial error with recovery steps, and a connected WebSocket never implies a USB connection', async () => {
    const err = { code: 'ACCESS_DENIED', message: 'Windows refused to open the port (access denied).', detail: "could not open port 'COM7': PermissionError(13, 'Access is denied.', None, 5)",
      recovery: ['Close the Arduino IDE Serial Monitor (or quit the Arduino IDE), then press Connect again.', 'Re-plug the USB cable.'] };
    await open('Device', { snap: { ...DISCONNECTED, connection: 'ERROR', error: err, last_error: err.message } });
    await waitFor(() => expect(FakeSocket.last).not.toBeNull());
    act(() => FakeSocket.last.emit({ type: 'snapshot', data: { ...DISCONNECTED, connection: 'ERROR', error: err }, commands: [] }));   // the socket is up
    const box = await screen.findByTestId('device-error');
    expect(within(box).getByText(/Windows refused to open the port/)).toBeInTheDocument();
    expect(within(box).getByText('ACCESS_DENIED')).toBeInTheDocument();
    expect(within(box).getByText(/PermissionError\(13/)).toBeInTheDocument();
    expect(within(box).getByText(/Close the Arduino IDE Serial Monitor/)).toBeInTheDocument();
    expect(screen.getAllByText('ERROR').length).toBeGreaterThan(0);
    expect(screen.getByText(/WebSocket only; says nothing about USB/)).toBeInTheDocument();
    expect(screen.queryByText('PHYSICAL DEVICE')).toBeNull();
    expect(screen.getAllByText('SIMULATION').length).toBeGreaterThan(0);
  });

  it('while the port is open but the handshake is pending the page says so and shows no physical device', async () => {
    await open('Device', { snap: { ...DISCONNECTED, connection: 'CONNECTING' } });
    expect(await screen.findByTestId('device-connecting')).toHaveTextContent(/waiting for the device handshake/);
    expect(screen.queryByText('PHYSICAL DEVICE')).toBeNull();
  });

  it('shows the explicit state label, the selected port, per-sensor availability and total acceleration that is not called vibration', async () => {
    const snap = { ...SNAP, state_label: 'PHYSICAL DEVICE CONNECTED', port: 'COM7',
      sensor_status: { rpm: 'valid', current: 'valid', voltage: 'invalid', power: 'invalid', housing: 'valid', ambient: 'unavailable', acceleration: 'valid', vibration_rms: 'unavailable' },
      values: { ...VALUES, acceleration: { value: 0.99, valid: true, stale: false, origin: 'device_measurement', x_g: 0, y_g: 0, z_g: 0.99 } } };
    await open('Device', { snap });
    expect(await screen.findByTestId('state-label')).toHaveTextContent('PHYSICAL DEVICE CONNECTED');
    expect(screen.getByText('COM7')).toBeInTheDocument();
    const table = screen.getByRole('table', { name: 'Sensor availability' });
    expect(within(table).getAllByText('unavailable').length).toBe(2);                    // ambient and vibration RMS
    expect(within(table).getAllByText('invalid').length).toBe(2);                         // voltage and power
    fireEvent.click(screen.getByRole('button', { name: /^Live Monitor/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Physical device' }));
    expect((await screen.findAllByText('0.990')).length).toBeGreaterThan(0);
    expect(screen.getByText(/NOT vibration RMS/)).toBeInTheDocument();
  });

  it('merges repeated identical device events into one row with a count', async () => {
    await open('Device', { snap: DISCONNECTED });
    await waitFor(() => expect(FakeSocket.last).not.toBeNull());
    act(() => { for (let i = 0; i < 30; i++) FakeSocket.last.emit({ type: 'event', name: 'protocol_error', ts: i, data: { code: 'MALFORMED', count: 1 } }); });
    expect(await screen.findByText(/Protocol error ×30/i)).toBeInTheDocument();
  });

  it('an operator cannot start or change speed: the controls are disabled and say why, while STOP remains available', async () => {
    await open('Motor Control', { role: 'operator', snap: { ...SNAP, control_blockers: [] }, commands: [] });
    await screen.findByText('Motor state');
    expect(screen.getByRole('button', { name: /Request START/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Send STOP to device/ })).not.toBeDisabled();
    expect(screen.getByText(/can request STOP only/)).toBeInTheDocument();
  });
});
