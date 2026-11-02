// Shell v3 and shared primitives: alerts are derived only from real state, simulation-only tools are refused in physical mode,
// and the shared primitives keep their safety-relevant behaviour (two-step confirm, missing values sort last, accessible tabs).
import React, { useState } from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import TorqvaApp from '../torqva/TorqvaApp.jsx';
import { setToken } from '../torqva/api.js';
import { AlertsMenu, deviceAlerts, simAlerts } from '../torqva/shared/alerts.jsx';
import { ScenarioPage } from '../torqva/simulation/scenario.jsx';
import { ConfirmButton, DataTable, StepTracker, Tabs, TabPanel, MetricList, ChartPanel } from '../torqva/shared/components.jsx';

const ok = (j) => ({ ok: true, status: 200, json: async () => j });
function server() {
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const path = String(url).replace('/api/torqva', '').split('?')[0];
    if (path === '/me') return ok({ user: 'tester', role: 'operator' });
    if (path === '/status') return ok({ mode: 'SIMULATION', t: 10, device: { estop: false }, last_window: { t: 10, rpm: 1800, valid: true }, models: {}, scenario: { fault: null } });
    if (path === '/telemetry') return ok({ samples: [] });
    if (path === '/device/status') return ok({ connection: 'DISCONNECTED', handshake: false, control_blockers: ['DEVICE NOT CONNECTED'] });
    return ok([]);
  }));
}
beforeEach(() => { vi.unstubAllGlobals(); setToken(''); });

describe('alerts come only from current state', () => {
  it('a disconnected device yields one alert that opens the Device page, and nothing claims readiness', () => {
    const a = deviceAlerts({ snap: { connection: 'DISCONNECTED' } });
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ title: 'Device disconnected', to: 'device' });
    expect(JSON.stringify(a)).not.toMatch(/ready/i);
  });

  it('backend motion blockers, a latched E-stop and invalid sensors each become an alert with the backend wording', () => {
    const snap = { connection: 'CONNECTED', handshake: true, origin: 'physical_device', telemetry_fresh: true, safety_state: 'EMERGENCY_STOP', trip_reason: 'OVER_CURRENT',
      control_blockers: ['Commissioning not complete', 'Session not authenticated'], sensor_status: { rpm: 'valid', current: 'invalid' } };
    const a = deviceAlerts({ snap });
    expect(a.find((x) => x.key === 'blk')).toMatchObject({ tone: 'crit', title: 'Motor operation blocked (2)', text: 'Commissioning not complete', to: 'control' });
    expect(a.find((x) => x.key === 'estop')).toMatchObject({ tone: 'stop', text: 'OVER CURRENT' });
    expect(a.find((x) => x.key === 'sens').text).toMatch(/current: invalid/);
  });

  it('a healthy connected device with no blockers has no alerts (and no invented "ready" entry)', () => {
    expect(deviceAlerts({ snap: { connection: 'CONNECTED', handshake: true, origin: 'physical_device', telemetry_fresh: true, safety_state: 'OK', control_blockers: [], sensor_status: { rpm: 'valid' } } })).toEqual([]);
  });

  it('simulation alerts: stale data, a pending approval and an open incident', () => {
    const a = simAlerts({ status: { pending_approval: { action: 'REDUCE_SPEED' }, incident: { id: 'INC-1', state: 'AWAITING_APPROVAL' } } }, true);
    expect(a.map((x) => x.key)).toEqual(['backend', 'appr', 'inc']);
    expect(a.find((x) => x.key === 'appr').to).toBe('interventions');
  });

  it('the menu announces the count, lists entries and navigates; Escape closes it', () => {
    const go = vi.fn();
    render(<AlertsMenu alerts={[{ key: 'k', tone: 'crit', title: 'Motor operation blocked (1)', text: 'X', to: 'control' }]} go={go} />);
    const btn = screen.getByRole('button', { name: 'Alerts: 1 active' });
    fireEvent.click(btn);
    expect(btn).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(within(screen.getByTestId('alerts-pop')).getByRole('button', { name: /Motor operation blocked/ }));
    expect(go).toHaveBeenCalledWith('control');
    fireEvent.click(btn);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('alerts-pop')).toBeNull();
  });

  it('with nothing active the menu says so', () => {
    render(<AlertsMenu alerts={[]} go={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Alerts: none active' }));
    expect(screen.getByText('Nothing needs attention right now.')).toBeInTheDocument();
  });
});

describe('shell routes', () => {
  it('Scenario Studio is a page in simulation mode and refused in physical mode, with an explicit switch that sends no device command', async () => {
    window.localStorage.setItem('torqva.mode', 'PHYSICAL');
    server(); setToken('t'); render(<TorqvaApp pollMs={100000} />);
    await screen.findByText(/tester · /);
    fireEvent.click(screen.getByRole('button', { name: /^Scenario Studio/ }));
    expect(await screen.findByTestId('scenario-sim-note')).toHaveTextContent('SIMULATION ONLY');
    expect(screen.getByTestId('top-mode')).toHaveTextContent('Physical Mode');
    fireEvent.click(screen.getByRole('button', { name: /Switch to Simulation mode/ }));
    await waitFor(() => expect(screen.getByTestId('top-mode')).toHaveTextContent('Simulation Mode'));
    expect((await screen.findAllByRole('heading', { name: 'Scenario Studio' })).length).toBeGreaterThan(0);
    const posts = fetch.mock.calls.filter(([u, o]) => o?.method === 'POST' && /\/device\//.test(String(u)));
    expect(posts).toEqual([]);
  });

  it('the physical top bar reports the device as disconnected, never as ready', async () => {
    window.localStorage.setItem('torqva.mode', 'PHYSICAL');
    server(); setToken('t'); render(<TorqvaApp pollMs={100000} />);
    await screen.findByText(/tester · /);
    await waitFor(() => expect(screen.getByTestId('top-device')).toHaveTextContent(/Device disconnected|Device connecting/));
    expect(screen.getByTestId('top-device')).not.toHaveTextContent(/ready/i);
  });

  it('the settings button opens the inventory, session and audit section of Device & Safety', async () => {
    window.localStorage.setItem('torqva.mode', 'SIMULATION');
    server(); setToken('t'); render(<TorqvaApp pollMs={100000} />);
    await screen.findByText(/tester · /);
    fireEvent.click(screen.getByRole('button', { name: 'Inventory, session and audit log' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /^Device & Safety$/ })).toHaveAttribute('aria-current', 'page'));
    expect(screen.getByRole('tab', { name: /^Device$/ })).toHaveAttribute('aria-selected', 'true');
  });
});

describe('Scenario Studio start confirmation', () => {
  const d = { status: { mode: 'SIMULATION', t: 30, scenario: { fault: 'imbalance', severity: 0.5, seed: 1, setpoint_rpm: 1800, inject_after_s: 40 }, device: {} }, telemetry: { samples: [] }, log: [] };
  const page = (start) => render(<ScenarioPage d={d} role="operator" actions={{ start, step: vi.fn(), stop: vi.fn() }} running={false} setRunning={() => {}} busy={false} error={null} stale={false} go={() => {}} />);
  const startBtn = () => screen.getByRole('button', { name: /Start (new )?simulation/i });

  it('restarting with identical settings is marked started once the backend accepts it (a new run), not before', async () => {
    let accept;
    const start = vi.fn(() => new Promise((r) => { accept = r; }));
    page(start);
    fireEvent.click(startBtn());
    expect(start).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/^Started\./)).toBeNull();                 // the request is in flight: nothing is claimed yet
    accept(true);
    expect(await screen.findByText(/^Started\./)).toBeInTheDocument();
    fireEvent.click(startBtn());                                          // the same settings again: a second, separate start
    expect(start).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(/^Started\./)).toBeNull();                 // the earlier run's confirmation does not count for this one
    accept(true);
    expect(await screen.findByText(/^Started\./)).toBeInTheDocument();
  });

  it('a start the backend refuses is never shown as started', async () => {
    page(vi.fn(async () => false));
    fireEvent.click(startBtn());
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText(/^Started\./)).toBeNull();
  });
});

describe('shared primitives', () => {
  it('ConfirmButton acts only on the second press, and Cancel disarms it', () => {
    const fn = vi.fn();
    render(<ConfirmButton onConfirm={fn}>Approve</ConfirmButton>);
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(fn).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Approve' }));
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('ConfirmButton cannot be pressed while busy', () => {
    render(<ConfirmButton onConfirm={() => {}} busy>Approve</ConfirmButton>);
    expect(screen.getByRole('button')).toBeDisabled();
  });

  it('DataTable sorts by a column in both directions and keeps missing values last', () => {
    const rows = [{ id: 'a', v: 2 }, { id: 'b', v: null }, { id: 'c', v: 1 }];
    render(<DataTable caption="t" rowKey={(r) => r.id} rows={rows} columns={[{ key: 'id', label: 'Id' }, { key: 'v', label: 'Value', align: 'num', sort: (r) => r.v, render: (r) => (r.v ?? '—') }]} />);
    const order = () => screen.getAllByRole('row').slice(1).map((r) => r.cells[0].textContent);
    fireEvent.click(screen.getByRole('button', { name: /Value/ }));
    expect(order()).toEqual(['c', 'a', 'b']);
    fireEvent.click(screen.getByRole('button', { name: /Value/ }));
    expect(order()).toEqual(['a', 'c', 'b']);
    expect(screen.getByRole('columnheader', { name: /Value/ })).toHaveAttribute('aria-sort', 'descending');
  });

  it('StepTracker marks only the active step as current and states each step in words', () => {
    render(<StepTracker label="Commissioning" steps={[{ key: 'a', label: 'Device connection', state: 'done' }, { key: 'b', label: 'Safety checks', state: 'active' }, { key: 'c', label: 'Ready for operation', state: 'pending' }]} />);
    const items = screen.getAllByRole('listitem');
    expect(items[1]).toHaveAttribute('aria-current', 'step');
    expect(items[0]).not.toHaveAttribute('aria-current');
    expect(items[2]).toHaveTextContent('not started');
  });

  it('Tabs move with the arrow keys and expose the selected tab', () => {
    function T() { const [v, setV] = useState('a'); return <><Tabs label="Views" value={v} onChange={setV} tabs={[{ key: 'a', label: 'Overview' }, { key: 'b', label: 'Evidence' }]} /><TabPanel tab={v}>{v}</TabPanel></>; }
    render(<T />);
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Overview' }), { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: 'Evidence' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('b');
  });

  it('a missing value is shown as missing, never as zero (MetricList, ChartPanel)', () => {
    render(<><MetricList items={[{ key: 'r', label: 'RPM', value: null, missingText: 'No reading' }, { key: 'z', label: 'Current', value: 0, unit: 'A' }]} /><ChartPanel title="Vibration" id="v" value={null} /></>);
    expect(screen.getByText('No reading')).toBeInTheDocument();
    expect(screen.getByText('0')).toBeInTheDocument();                    // a real zero stays zero
    expect(screen.getByText('UNAVAILABLE')).toBeInTheDocument();
  });
});
