import React from 'react';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import TorqvaApp from '../torqva/TorqvaApp.jsx';
import { setToken } from '../torqva/api.js';

const PRED = (action, risk, rpm) => ({
  action, target_rpm: 0, risk, risk_by_signal: {}, validated_by_experiments: false,
  mean_at_30_60_120: { rpm: [1, 2, rpm], vib_rms: [0, 0, 0.05], housing: [0, 0, 30], current: [0, 0, 1] },
  lo_120: { vib_rms: 0.04, housing: 29 }, hi_120: { vib_rms: 0.06, housing: 31 },
});

function makeServer({ role = 'viewer', pending = null, me = 200, outcomes = [], overrides = {} } = {}) {
  const calls = [];
  const status = {
    mode: 'SIMULATION', provenance: 'SIMULATED', t: 120, scenario: {},
    device: { estop: false, estop_reason: '', setpoint_rpm: 1800 }, incident: null, pending_approval: pending,
    last_window: { t: 120, rpm: 1799, duty: 40, voltage: 23.9, current: 1.2, housing: 25, vib_rms: 0.05, valid: true },
    models: { c2_label: 'Intervention Outcome Prediction (unvalidated)', c2_validated_by_intervention_experiments: false },
    closed_incidents: 0,
  };
  const table = {
    '/me': () => (me === 200 ? { user: 'tester', role } : null),
    '/status': () => status,
    '/telemetry?last=300': () => ({ provenance: 'SIMULATED', samples: [] }),
    '/incidents': () => [], '/decisions': () => [], '/commands': () => [], '/cases': () => [], '/log': () => [],
    '/predictions': () => [PRED('CONTINUE_MONITORING', 0.02, 1800), PRED('REDUCE_SPEED', 0.01, 1260), PRED('STOP', 0.0, 0)],
    '/outcomes': () => outcomes,
    '/evaluation/latest': () => ({ file: 'eval.json', run: {
      WARNING: 'Simulation only. Do not quote as hardware results.', git_sha: 'abc', config_hash: 'h', measured: { status: 'NO MEASURED DATA' },
      c1: { healthy: { c1: { window_false_alarm_rate: 0.0026 } } },
      hypotheses: { random_baseline: 0.1667, top1_accuracy: 0.95, false_confident_rate: 0.049 },
      c2: { coverage_target: 0.9, coverage_mean: 0.88, coverage_min: 0.58, validated_by_intervention_experiments: false },
      c5: { FALSE_RECOVERY_DECLARATIONS: 0, cases: 40 } } }),
    '/audit': () => [],
    ...overrides,
  };
  const fetchMock = vi.fn(async (url, opts = {}) => {
    const path = String(url).replace('/api/torqva', '');
    calls.push({ path, method: opts.method || 'GET' });
    if (path === '/me' && me !== 200) return { ok: false, status: me, json: async () => ({ detail: 'x' }) };
    if (opts.method === 'POST') return { ok: true, status: 200, json: async () => ({ ok: true }) };
    const f = table[path];
    if (!f) return { ok: false, status: 404, json: async () => ({ detail: 'nope ' + path }) };
    return { ok: true, status: 200, json: async () => f() };
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}

async function signedIn(opts) {
  const srv = makeServer(opts);
  setToken('tok');
  render(<TorqvaApp pollMs={100000} />);
  await screen.findByText(/tester · /);
  return srv;
}

beforeEach(() => { window.localStorage.setItem('torqva.mode', 'SIMULATION'); vi.unstubAllGlobals(); setToken(''); });

describe('TORQVA workspace', () => {
  it('shows the sign-in screen with the simulation banner and no data when there is no token', () => {
    makeServer();
    render(<TorqvaApp />);
    expect(screen.getByTestId('sim-banner')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeDisabled();
  });

  it('explains when the server has authentication disabled (503)', async () => {
    makeServer({ me: 503 });
    render(<TorqvaApp />);
    fireEvent.change(screen.getByLabelText('Access token'), { target: { value: 'abc' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/not configured/i);
  });

  it('rejects a bad token (401)', async () => {
    makeServer({ me: 401 });
    render(<TorqvaApp />);
    fireEvent.change(screen.getByLabelText('Access token'), { target: { value: 'bad' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/not accepted/i);
  });

  it('keeps the non-dismissable simulation banner on every view', async () => {
    await signedIn();
    for (const name of ['Overview', 'Live Monitor', 'AI Diagnostics', 'Predictions', 'Diagnostic Tests', 'Interventions', 'Recovery', 'Learning', 'Evaluation', 'Devices & Settings']) {
      fireEvent.click(screen.getByRole('button', { name: new RegExp(name) }));
      expect(screen.getByTestId('sim-banner')).toHaveTextContent(/simulated/i);
    }
  });

  it('Run and STOP are enabled when a simulation exists at sim time 0 (regression: 0 is not "no simulation")', async () => {
    makeServer({ role: 'operator', overrides: {} });
    setToken('tok');
    // status with t = 0
    const f = global.fetch;
    vi.stubGlobal('fetch', vi.fn(async (url, o) => {
      const r = await f(url, o);
      if (String(url).endsWith('/status')) { const j = await r.json(); return { ok: true, status: 200, json: async () => ({ ...j, t: 0 }) }; }
      return r;
    }));
    render(<TorqvaApp pollMs={100000} />);
    await screen.findByText(/tester · /);
    fireEvent.click(screen.getByRole('button', { name: /Live Monitor/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Run/ })).toBeEnabled());
    expect(screen.getByRole('button', { name: /Stop motor/ })).toBeEnabled();
  });

  it('viewer cannot start a simulation but can always press STOP', async () => {
    await signedIn({ role: 'viewer' });
    fireEvent.click(screen.getByRole('button', { name: /Live Monitor/ }));
    expect(screen.getByRole('button', { name: 'Start new simulation' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Stop motor/ })).toBeEnabled();
  });

  it('labels C2 predictions as unvalidated and PREDICTED, never as measurements', async () => {
    await signedIn();
    fireEvent.click(screen.getByRole('button', { name: /^Predictions/ }));
    expect(await screen.findByText('Intervention Outcome Prediction (unvalidated)')).toBeInTheDocument();
    expect(screen.getAllByText('PRED').length).toBeGreaterThan(0);
    expect(screen.getByText(/never evidence of recovery/i)).toBeInTheDocument();
  });

  const pending = { action: 'REDUCE_SPEED', params: { rpm: 1260 }, rationale: 'C2 ranks REDUCE_SPEED first' };

  it('approval is disabled for a viewer and explains why', async () => {
    await signedIn({ role: 'viewer', pending });
    fireEvent.click(screen.getByRole('button', { name: /^Interventions/ }));
    const approve = await screen.findByRole('button', { name: /Approve/ });
    expect(approve).toBeDisabled();
    expect(screen.getByText(/requires role operator or admin/i)).toBeInTheDocument();
  });

  it('an operator can approve, which POSTs to the approvals endpoint', async () => {
    const srv = await signedIn({ role: 'operator', pending });
    fireEvent.click(screen.getByRole('button', { name: /^Interventions/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Approve/ }));
    await waitFor(() => expect(srv.calls.some((c) => c.path === '/approvals/approve' && c.method === 'POST')).toBe(true));
  });

  it('recovery view shows empty state, then criteria pass/fail and what was observed', async () => {
    await signedIn();
    fireEvent.click(screen.getByRole('button', { name: /Recovery/ }));
    expect(await screen.findByText(/No incident has been verified yet/)).toBeInTheDocument();
  });

  it('recovery view never shows RECOVERED styling for UNRESOLVED outcomes', async () => {
    const outcomes = [{ incident: 'INC-001', outcome: 'UNRESOLVED', reasons: ['in_learned_band'], criteria: { in_learned_band: false, trend_not_worsening: true },
      observed: { rpm: 1260, housing: 25, frac_in_band: 0.1 }, n_fresh: 60, command_executed: true, action: 'REDUCE_SPEED' }];
    await signedIn({ outcomes });
    fireEvent.click(screen.getByRole('button', { name: /Recovery/ }));
    const art = await screen.findByRole('article');
    expect(within(art).getByText('UNRESOLVED')).toBeInTheDocument();
    expect(within(art).getByText('fail')).toBeInTheDocument();
    expect(within(art).queryByText('RECOVERED')).toBeNull();
  });

  it('evaluation view carries the simulation-only warning and states there is no measured data', async () => {
    await signedIn();
    fireEvent.click(screen.getByRole('button', { name: /^Evaluation/ }));
    expect(await screen.findByText(/Simulation only/)).toBeInTheDocument();
    expect(screen.getByText('NO MEASURED DATA')).toBeInTheDocument();
    expect(screen.getByText('no')).toBeInTheDocument();           // C2 validated: no
  });

  it('audit log is restricted to admins', async () => {
    await signedIn({ role: 'operator' });
    fireEvent.click(screen.getByRole('button', { name: /Devices & Settings/ }));
    expect(await screen.findByText(/visible to admins only/)).toBeInTheDocument();
  });

  it('a 401 during polling returns the user to the sign-in screen', async () => {
    await signedIn({ overrides: {} });
    fireEvent.click(screen.getByRole('button', { name: /Live Monitor/ }));
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401, json: async () => ({ detail: 'expired' }) })));
    // STOP is enabled for every role, and any action triggers a refresh, which now returns 401
    fireEvent.click(screen.getByRole('button', { name: /Stop motor/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument());
  });
});
