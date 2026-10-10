import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import TorqvaApp from '../torqva/TorqvaApp.jsx';
import { setToken } from '../torqva/api.js';

const ok = (j) => ({ ok: true, status: 200, json: async () => j });
const window60 = { t: 60, rpm: 1795, duty: 0.5, voltage: 12, current: 1.3, housing: 24.5, vib_rms: 0.08, valid: true };
function server({ down = false } = {}) {
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    if (down) throw new TypeError('Failed to fetch');
    const path = String(url).replace('/api/torqva', '').split('?')[0];
    if (path === '/me') return ok({ user: 'tester', role: 'operator' });
    if (path === '/status') return ok({ mode: 'SIMULATION', t: 60, device: { estop: false, setpoint_rpm: 1800 }, last_window: window60, models: { c2_label: 'Intervention Outcome Prediction (unvalidated)' }, scenario: { fault: null } });
    if (path === '/telemetry') return ok({ samples: [{ t: 59, rpm: 1796, setpoint: 1800, housing: 24.4, vib_rms: 0.07, current: 1.3, score: 0.4 }, { t: 60, rpm: 1795, setpoint: 1800, housing: 24.5, vib_rms: 0.08, current: 1.3, score: 0.5 }] });
    if (path === '/attestation/references') return ok({ versions: [], active_version: null });
    if (path === '/attestation/warmup') return ok({ active: false });
    return ok([]);
  }));
}
beforeEach(() => { vi.unstubAllGlobals(); setToken(''); });

describe('redesigned application shell', () => {
  it('overview shows simulated telemetry with SIM provenance and the software-simulator environment', async () => {
    server(); setToken('t'); render(<TorqvaApp pollMs={100000} />);
    await screen.findByText(/tester · /);
    expect(await screen.findByText('1795')).toBeInTheDocument();
    expect(screen.getAllByText('SIM').length).toBeGreaterThanOrEqual(4);
    expect(screen.getByText(/software simulator \(no hardware\)/)).toBeInTheDocument();
    expect(screen.queryByTestId('conn-warning')).toBeNull();
  });

  it('a missing sensor reads UNAVAILABLE, never zero', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const path = String(url).replace('/api/torqva', '').split('?')[0];
      if (path === '/me') return ok({ user: 'tester', role: 'viewer' });
      if (path === '/status') return ok({ mode: 'SIMULATION', t: 5, device: {}, last_window: { ...window60, vib_rms: null }, models: {} });
      return ok(path === '/telemetry' ? { samples: [] } : []);
    }));
    setToken('t'); render(<TorqvaApp pollMs={100000} />);
    await screen.findByText(/tester · /);
    expect(await screen.findByText('UNAVAILABLE')).toBeInTheDocument();
  });

  it('shows a stale-data warning when the backend becomes unreachable', async () => {
    server(); setToken('t'); render(<TorqvaApp pollMs={50} />);
    await screen.findByText(/tester · /);
    await screen.findByText('1795');
    server({ down: true });
    expect(await screen.findByTestId('conn-warning', {}, { timeout: 3000 })).toHaveTextContent(/STALE/);
  });

  it('every page is reachable from the navigation and the physical device is shown as not connected', async () => {
    server(); setToken('t'); render(<TorqvaApp pollMs={100000} />);
    await screen.findByText(/tester · /);
    for (const n of ['Live Monitor', 'AI Diagnostics', 'Predictions', 'Diagnostic Tests', 'Interventions', 'Recovery', 'Learning', 'Evaluation', 'Devices & Settings']) {
      fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${n}`) }));
      await waitFor(() => expect(screen.getByRole('button', { name: new RegExp(`^${n}`) })).toHaveAttribute('aria-current', 'page'));
    }
    expect(await screen.findByText('not connected')).toBeInTheDocument();
  });

  it('evaluation page tolerates an older run without regime sections and lists the available runs', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const path = String(url).replace('/api/torqva', '').split('?')[0];
      if (path === '/me') return ok({ user: 'tester', role: 'viewer' });
      if (path === '/status') return ok({ mode: 'SIMULATION', device: {}, models: {} });
      if (path === '/evaluation/latest') return ok({ file: 'eval_sim_run1.json', selection: 'highest run number in the file name', run: { schema: 'EvaluationRun/1', WARNING: 'Simulation only.', git_sha: 'abc', c1: {}, hypotheses: {}, c2: {}, c5: {} },
        available_runs: [{ file: 'eval_sim_run1.json', git_sha: 'abc', runtime_s: 4.5, has_regimes: false }, { file: 'eval_sim_run2.json', git_sha: 'def', runtime_s: 16.8, has_regimes: true }] });
      if (path === '/evaluation/c2c4') return { ok: false, status: 404, json: async () => ({ detail: 'none' }) };
      return ok(path === '/telemetry' ? { samples: [] } : []);
    }));
    setToken('t'); render(<TorqvaApp pollMs={100000} />);
    await screen.findByText(/tester · /);
    fireEvent.click(screen.getByRole('button', { name: /^Evaluation/ }));
    expect(await screen.findByRole('table', { name: 'Available evaluation runs' })).toBeInTheDocument();
    expect(screen.getAllByText('unavailable').length).toBeGreaterThan(3);      // missing metrics are labelled, never blank or zero
    expect(screen.getByText(/there is no longer history/)).toBeInTheDocument();
  });
});
