// Digital Twin: the mappings show only what the source reports (never a zero for a missing reading), the shaft animates only from a valid, current,
// non-zero speed, and neither twin page can send anything to the backend except reads.
import React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { vi, describe, it, expect, afterEach } from 'vitest';
import { simTwin, SimTwinPage } from '../torqva/simulation/twin.jsx';
import { physTwin, PhysTwinPage } from '../torqva/physical/twin.jsx';
import { spinPeriod } from '../torqva/shared/twinModel.jsx';

const now = Date.now() / 1000;
const W = { t: 120, rpm: 1500.4, duty: 34.2, voltage: 23.6, current: 1.25, housing: 31.4, vib_rms: 0.071, valid: true };
const STATUS = { mode: 'SIMULATION', provenance: 'SIMULATED', t: 120, scenario: { fault: 'imbalance', severity: 0.6, clears_below_rpm: null, seed: 7, setpoint_rpm: 1500, inject_after_s: 60 },
  device: { estop: false, estop_reason: '', setpoint_rpm: 1500 }, incident: null, pending_approval: null, last_window: W, models: { c2_label: 'Intervention Outcome Prediction (unvalidated)' }, closed_incidents: 0 };
const SAMPLES = Array.from({ length: 5 }, (_, i) => ({ t: 116 + i, rpm: 1500 + i, setpoint: 1500, duty: 34, voltage: 23.6, current: 1.25, housing: 31.4, vib_rms: 0.07, score: 0.3, score_status: 'OK' }));
const D = { status: STATUS, telemetry: { samples: SAMPLES } };
const reading = (m, part, key) => m.parts.find((p) => p.id === part).readings.find((r) => r.key === key);

const val = (v, extra = {}) => ({ value: v, valid: v !== null, stale: false, origin: 'device_measurement', received_unix: now, ...extra });
const CONNECTED = { connection: 'CONNECTED', handshake: true, origin: 'physical_device', device_id: 'RIG-1', firmware: '3.0.1', port: 'COM7', telemetry_fresh: true, last_rx_unix: now,
  safety_state: 'OK', drive: 'RUNNING', control_blockers: ['PHYSICAL CONTROL DISABLED'],
  values: { rpm: val(1210), current: val(0.8), voltage: val(23.9), power: val(19.1), housing: val(29.5), ambient: null, duty: val(30, { origin: 'device_command_state' }), setpoint: val(1200, { origin: 'device_command_state' }),
    acceleration: { value: 1.01, x_g: 0.02, y_g: -0.01, z_g: 1.0, valid: true, stale: false, origin: 'device_measurement', received_unix: now } },
  analysis: { layers: { C1: { status: 'NOT AVAILABLE', reason: 'needs vibration RMS' }, C2: { status: 'NOT AVAILABLE', reason: 'needs vibration RMS' } } } };
const DISCONNECTED = { connection: 'DISCONNECTED', handshake: false, origin: 'none', telemetry_fresh: false, values: {}, control_blockers: ['DEVICE NOT CONNECTED'],
  analysis: { layers: { C1: { status: 'WAITING FOR VALID PHYSICAL TELEMETRY', reason: 'no device handshake' } } }, autoconnect: { note: 'no device port is configured' } };

afterEach(() => { vi.unstubAllGlobals(); });

describe('simulation twin mapping', () => {
  it('waits for the first status instead of showing values', () => {
    expect(simTwin({}).loading).toBe(true);
  });

  it('with no simulation run every reading is unavailable and the shaft is still', () => {
    const m = simTwin({ status: { mode: 'SIMULATION', simulation: null } }, { running: true });
    expect(m.state.label).toBe('NO SIMULATION RUNNING');
    for (const p of m.parts) for (const r of p.readings) { expect(r.status).toBe('unavailable'); expect(r.value).toBeNull(); }
    expect(m.motion.spinning).toBe(false);
  });

  it('shows the simulator values, tagged SIMULATED, and spins only while simulation time advances', () => {
    const run = simTwin(D, { running: true });
    expect(reading(run, 'hall', 'rpm')).toMatchObject({ value: 1500.4, status: 'ok', prov: 'SIMULATED' });
    expect(run.motion).toMatchObject({ spinning: true, rpm: 1500.4 });
    expect(run.state.label).toBe('RUNNING');
    const paused = simTwin(D, { running: false });
    expect(paused.motion.spinning).toBe(false);
    expect(paused.clock.label).toBe('paused');
  });

  it('power is V x I of the same window, labelled DERIVED, and unavailable when either input is missing', () => {
    expect(reading(simTwin(D), 'ina', 'power')).toMatchObject({ prov: 'DERIVED', status: 'ok' });
    expect(reading(simTwin(D), 'ina', 'power').value).toBeCloseTo(23.6 * 1.25, 9);
    const m = simTwin({ ...D, status: { ...STATUS, last_window: { ...W, current: null } } });
    expect(reading(m, 'ina', 'current')).toMatchObject({ value: null, status: 'unavailable' });
    expect(reading(m, 'ina', 'power')).toMatchObject({ value: null, status: 'unavailable' });
  });

  it('a backend that stopped answering marks values stale and stops the shaft', () => {
    const m = simTwin(D, { running: true, stale: true });
    expect(reading(m, 'temp', 'housing').status).toBe('stale');
    expect(m.motion.spinning).toBe(false);
    expect(m.connection.tone).toBe('crit');
    expect(m.state.label).toBe('BACKEND UNREACHABLE');
  });

  it('an invalid simulated window is shown as invalid, not as numbers', () => {
    const m = simTwin({ ...D, status: { ...STATUS, last_window: { ...W, valid: false } } }, { running: true });
    expect(reading(m, 'hall', 'rpm').status).toBe('invalid');
    expect(m.motion.spinning).toBe(false);
  });

  it('a simulated e-stop is the operating state', () => {
    expect(simTwin({ ...D, status: { ...STATUS, device: { estop: true, estop_reason: 'VIB_HIGH', setpoint_rpm: 0 } } }).state).toMatchObject({ tone: 'stop', label: 'E-STOP (SIMULATED)' });
  });
});

describe('physical twin mapping', () => {
  it('without a board everything is unavailable, nothing spins and the state says so', () => {
    const m = physTwin(DISCONNECTED);
    expect(m.state.label).toBe('HARDWARE NOT CONNECTED');
    for (const p of m.parts) for (const r of p.readings) { expect(r.status).toBe('unavailable'); expect(r.value).toBeNull(); }
    expect(m.motion.spinning).toBe(false);
  });

  it('fresh physical readings are MEASURED, commanded values are CMD, and the shaft follows a valid measured speed', () => {
    const m = physTwin(CONNECTED);
    expect(reading(m, 'hall', 'rpm')).toMatchObject({ value: 1210, status: 'ok', prov: 'MEASURED' });
    expect(reading(m, 'driver', 'duty').prov).toBe('COMMAND');
    expect(reading(m, 'ina', 'power')).toMatchObject({ value: 19.1, prov: 'DERIVED' });            // the firmware computes P = V x I
    expect(reading(m, 'temp', 'ambient')).toMatchObject({ value: null, status: 'unavailable' });
    expect(m.motion).toMatchObject({ spinning: true, rpm: 1210 });
    expect(m.parts.find((p) => p.id === 'accel').notes[0]).toMatch(/x 0\.020 g/);
  });

  it('stale telemetry keeps the last values but marks them stale and stops the shaft', () => {
    for (const m of [physTwin({ ...CONNECTED, telemetry_fresh: false }), physTwin(CONNECTED, { unreachable: true })]) {
      expect(reading(m, 'hall', 'rpm')).toMatchObject({ value: 1210, status: 'stale' });
      expect(m.motion.spinning).toBe(false);
    }
  });

  it('an invalid reading never becomes a number, and an invalid speed never animates', () => {
    const m = physTwin({ ...CONNECTED, values: { ...CONNECTED.values, rpm: { value: null, valid: false, stale: false, origin: 'device_measurement' } } });
    expect(reading(m, 'hall', 'rpm')).toMatchObject({ value: null, status: 'invalid' });
    expect(m.motion.spinning).toBe(false);
  });

  it('a board in firmware simulation mode is labelled SIMULATED and never animates', () => {
    const m = physTwin({ ...CONNECTED, origin: 'device_firmware_simulation' });
    expect(m.state.label).toBe('FIRMWARE SIMULATION MODE');
    expect(reading(m, 'hall', 'rpm').prov).toBe('SIMULATED');
    expect(m.motion.spinning).toBe(false);
  });

  it('a backend that never answered is not "loading" forever, and an unreachable backend makes the device state unknown', () => {
    const none = physTwin(null, { unreachable: true });
    expect(none.loading).toBe(false);
    expect(none.state.label).toBe('BACKEND UNREACHABLE');
    for (const snap of [DISCONNECTED, CONNECTED]) {
      const m = physTwin(snap, { unreachable: true });
      expect(m.state.label).toBe('BACKEND UNREACHABLE');
      expect(m.motion.spinning).toBe(false);
    }
  });

  it('identical AI-layer statuses are listed once', () => {
    const labels = physTwin(CONNECTED).findings.map((f) => f.label);
    expect(labels.filter((l) => l.includes('NOT AVAILABLE'))).toEqual(['C1, C2: NOT AVAILABLE']);
  });
});

describe('twin pages', () => {
  const ok = (j) => ({ ok: true, status: 200, json: async () => j });
  const record = () => {
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, o = {}) => { calls.push([o.method || 'GET', String(url)]); return ok({ points: [[now - 2, 1200], [now - 1, null], [now, 1210]] }); }));
    return calls;
  };

  it('selecting a part by click or keyboard opens its readings; Escape and the close button return to the full view', async () => {
    record();
    render(<SimTwinPage d={D} running={false} stale={false} go={() => {}} />);
    expect(screen.getByTestId('twin-overview')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('twin-hot-hall'));
    const detail = await screen.findByTestId('twin-detail');
    expect(within(detail).getByText('Speed sensor')).toBeInTheDocument();
    expect(within(screen.getByTestId('twin-reading-rpm')).getByText('1500')).toBeInTheDocument();
    expect(screen.getByTestId('twin-model')).toHaveAttribute('data-selected', 'hall');
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('twin-detail')).toBeNull());
    fireEvent.keyDown(screen.getByTestId('twin-hot-temp'), { key: 'Enter' });
    expect(await screen.findByTestId('twin-reading-housing')).toHaveTextContent('31.4');
    fireEvent.click(screen.getByTestId('twin-close'));
    await waitFor(() => expect(screen.getByTestId('twin-overview')).toBeInTheDocument());
  });

  it('a disconnected board shows UNAVAILABLE, never a zero', () => {
    record();
    render(<PhysTwinPage stream={{ snap: DISCONNECTED, unreachable: false }} go={() => {}} />);
    expect(screen.getByTestId('twin-state')).toHaveTextContent('HARDWARE NOT CONNECTED');
    expect(screen.getByTestId('twin-kpi-rpm')).toHaveTextContent('UNAVAILABLE');
    expect(screen.getByTestId('twin-kpi-rpm')).not.toHaveTextContent(/\b0\b/);
    expect(screen.getByTestId('twin-model')).toHaveAttribute('data-spinning', 'no');
  });

  it('while the page is open: fresh -> stale -> disconnected updates every reading and stops the shaft', () => {
    record();
    const { rerender } = render(<PhysTwinPage stream={{ snap: CONNECTED, unreachable: false }} go={() => {}} />);
    expect(screen.getByTestId('twin-model')).toHaveAttribute('data-spinning', 'yes');
    expect(screen.getByTestId('twin-kpi-rpm')).toHaveTextContent('1210');
    expect(screen.getByTestId('twin-kpi-rpm')).toHaveTextContent('LIVE');
    rerender(<PhysTwinPage stream={{ snap: { ...CONNECTED, telemetry_fresh: false }, unreachable: false }} go={() => {}} />);
    expect(screen.getByTestId('twin-model')).toHaveAttribute('data-spinning', 'no');
    expect(screen.getByTestId('twin-kpi-rpm')).toHaveTextContent('STALE');
    expect(screen.getByTestId('twin-state')).toHaveTextContent('TELEMETRY STALE');
    rerender(<PhysTwinPage stream={{ snap: DISCONNECTED, unreachable: false }} go={() => {}} />);
    expect(screen.getByTestId('twin-state')).toHaveTextContent('HARDWARE NOT CONNECTED');
    expect(screen.getByTestId('twin-kpi-rpm')).toHaveTextContent('UNAVAILABLE');
    expect(screen.getByTestId('twin-kpi-rpm')).not.toHaveTextContent('1210');
  });

  it('a failing history request shows the error in the trend, not an empty or invented chart', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({ detail: 'history store unavailable' }) })));
    render(<PhysTwinPage stream={{ snap: CONNECTED, unreachable: false }} go={() => {}} />);
    fireEvent.click(screen.getByTestId('twin-hot-hall'));
    const trend = await screen.findByTestId('twin-trend');
    await waitFor(() => expect(within(trend).getByRole('alert')).toBeInTheDocument());
    expect(trend.querySelector('.tq-chart')).toBeNull();
  });

  it('the device-history poll runs only while a trend is shown and stops on deselection and unmount', async () => {
    const calls = record();
    const hist = () => calls.filter(([, u]) => u.includes('/device/history')).length;
    const { unmount } = render(<PhysTwinPage stream={{ snap: CONNECTED, unreachable: false }} go={() => {}} />);
    expect(hist()).toBe(0);                                                       // nothing selected: no history request
    fireEvent.click(screen.getByTestId('twin-hot-hall'));
    await waitFor(() => expect(hist()).toBe(1));
    fireEvent.click(screen.getByTestId('twin-close'));
    const afterClose = hist();
    await new Promise((r) => { setTimeout(r, 2300); });
    expect(hist()).toBe(afterClose);                                              // deselected: the 2 s poll stopped
    fireEvent.click(screen.getByTestId('twin-hot-temp'));
    await waitFor(() => expect(hist()).toBe(afterClose + 1));
    unmount();
    const afterUnmount = hist();
    await new Promise((r) => { setTimeout(r, 2300); });
    expect(hist()).toBe(afterUnmount);                                            // unmounted: no timer left behind
  }, 10000);

  it('exploring every part in both modes only ever reads from the backend', async () => {
    const calls = record();
    const { unmount } = render(<PhysTwinPage stream={{ snap: CONNECTED, unreachable: false }} go={() => {}} />);
    for (const id of ['hall', 'temp', 'ina', 'accel', 'driver', 'controller']) { fireEvent.click(screen.getByTestId(`twin-hot-${id}`)); await screen.findByTestId('twin-detail'); }
    await waitFor(() => expect(calls.some(([, u]) => u.includes('/device/history'))).toBe(true));
    unmount();
    render(<SimTwinPage d={D} running stale={false} go={() => {}} />);
    for (const id of ['hall', 'temp', 'ina', 'accel', 'driver', 'controller']) { fireEvent.click(screen.getByTestId(`twin-hot-${id}`)); await screen.findByTestId('twin-detail'); }
    expect(calls.filter(([m]) => m !== 'GET')).toEqual([]);
  });

  it('the twin modules reference no command, start, step or commissioning API', () => {
    const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'torqva');
    for (const f of ['shared/twin.jsx', 'shared/twinModel.jsx', 'simulation/twin.jsx', 'physical/twin.jsx']) {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      expect(src, f).not.toMatch(/api\.(deviceCommand|start|step|stop|approve|reject|resetEstop|deviceConnect|deviceDisconnect|commissioning\w*)\b/);
      expect(src, f).not.toMatch(/method:\s*['"](POST|PUT|DELETE)/);
    }
  });

  it('the animation rate is a scaled, clamped presentation value', () => {
    expect(spinPeriod(1500)).toBeCloseTo(1.6, 9);
    expect(spinPeriod(1)).toBe(12);
    expect(spinPeriod(100000)).toBe(0.6);
  });
});
