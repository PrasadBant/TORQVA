import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import TorqvaApp from '../torqva/TorqvaApp.jsx';
import { C2C4Validation, DiagnosticTests, PredictionChecks, StatusPill } from '../torqva/c2c4.jsx';
import { setToken } from '../torqva/api.js';

const row = (o = {}) => ({ signal: 'housing', horizon_s: 60, observed: 25.4, predicted: 25.1, lo: 24.8, hi: 25.4, covered: true, ...o });
const check = (o = {}) => ({ comparison: 'available', action: 'REDUCE_SPEED', interval_method: 'noise_aware_conformal', status: 'supported',
  horizons_reached: [30, 60], covered_fraction: 0.5, rows: [row(), row({ signal: 'rpm', observed: 1300, predicted: 1260, lo: 1255, hi: 1265, covered: false })], ...o });

describe('C2/C4 components', () => {
  it('labels status explicitly and never shows an unsupported prediction as usable', () => {
    render(<><StatusPill status="supported" /><StatusPill status="unsupported" /><StatusPill status="insufficiently_validated" /></>);
    expect(screen.getByText('supported')).toBeInTheDocument();
    expect(screen.getByText(/unsupported — not used for decisions/)).toBeInTheDocument();
    expect(screen.getByText('insufficiently validated')).toBeInTheDocument();
  });

  it('shows predicted vs observed with provenance, interval membership and the "not a recovery verdict" note', () => {
    render(<PredictionChecks checks={[check()]} />);
    expect(screen.getByRole('note')).toHaveTextContent('not measurements');
    expect(screen.getByRole('note')).toHaveTextContent('not a recovery verdict');
    const t = screen.getByRole('table', { name: 'Predicted versus observed' });
    expect(within(t).getAllByText('yes').length).toBe(1);
    expect(within(t).getAllByText('no').length).toBe(1);
    expect(screen.getByText('PRED')).toBeInTheDocument();
    expect(screen.getByText('SIM')).toBeInTheDocument();
  });

  it('says plainly that nothing is compared when the action was not executed', () => {
    render(<PredictionChecks checks={[check({ comparison: 'none', rows: [] })]} />);
    expect(screen.getByTestId('pc-none')).toHaveTextContent('was not executed');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('lists recommended, completed, inconclusive and aborted diagnostic tests distinctly', () => {
    const log = [
      { kind: 'gate', t: 100, test: 'T1', reason: "Not acting: 'looseness' cannot be told from its look-alike without a speed-step test." },
      { kind: 'test_result', t: 160, test: 'T1', posterior: [['sensor_fault', 0.93], ['looseness', 0.05]] },
      { kind: 'test_result', t: 400, test: 'T3', posterior: [['overload', 0.55], ['cooling_failure', 0.4]] },
      { kind: 'test_aborted', t: 460, status: 'TIMEOUT', reason: 'NO_ACK' },
    ];
    render(<DiagnosticTests log={log} />);
    const t = screen.getByRole('table', { name: 'Diagnostic test history' });
    for (const w of ['recommended', 'result', 'inconclusive', 'aborted']) expect(within(t).getByText(w)).toBeInTheDocument();
    expect(within(t).getByText(/sensor fault at 93 %/)).toBeInTheDocument();
    expect(within(t).getByText(/TIMEOUT — NO_ACK/)).toBeInTheDocument();
    expect(screen.getByText(/never forces a diagnosis|ambiguous result stays/)).toBeInTheDocument();
  });

  it('shows the validation status with CIs, abstention, the limitations and an "unvalidated against hardware" label', () => {
    const e = (cov, w = 1.8) => ({ n: 100, coverage: cov, coverage_ci95: [cov - 0.01, cov + 0.01], mean_width_norm: w, trusted_frac: 0.9 });
    const data = { WARNING: 'Simulation only; no physical motor was operated.', c2: { control: { baseline: e(0.863), noisy: e(0.746) }, noise_aware: { baseline: e(0.914, 1.9), noisy: e(0.893, 2.5) } },
      c4_realistic_v1: { hard: { control: { n: 48, no_test_top1: 0, accuracy_after: 0.23, inconclusive: 0.9, confident_wrong: 0.02 }, style_aware: { n: 48, no_test_top1: 0, accuracy_after: 0.31, inconclusive: 0.35, confident_wrong: 0.354 } } },
      c4_realistic_v2: null, limitations: ['No C2 variant is validated by Intervention Outcome Experiments on hardware.'] };
    render(<C2C4Validation data={data} />);
    expect(screen.getByText('unvalidated against hardware')).toBeInTheDocument();
    const t = screen.getByRole('table', { name: 'C2 interval coverage by regime' });
    expect(within(t).getByText(/86\.3%/)).toBeInTheDocument();
    expect(within(t).getByText(/89\.3%/)).toBeInTheDocument();
    expect(within(t).getAllByText(/abstains/).length).toBeGreaterThan(0);
    const c4 = screen.getByRole('table', { name: 'C4 diagnostic value' });
    expect(within(c4).getByText('35.4%')).toBeInTheDocument();                       // the confidently-wrong rate is shown, not hidden
    expect(screen.getByText(/validated by Intervention Outcome Experiments on hardware/)).toBeInTheDocument();
  });

  it('degrades to an explanatory message when no study result exists', () => {
    render(<C2C4Validation data={null} error={new Error('no C2/C4 study result found')} />);
    expect(screen.getByText(/No C2\/C4 study result available/)).toBeInTheDocument();
  });
});

describe('Predictions and Evaluation views', () => {
  beforeEach(() => { window.localStorage.setItem('torqva.mode', 'SIMULATION'); vi.unstubAllGlobals(); setToken(''); });

  function server(extra = {}) {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const path = String(url).replace('/api/torqva', '');
      const ok = (j) => ({ ok: true, status: 200, json: async () => j });
      if (path === '/me') return ok({ user: 'tester', role: 'viewer' });
      if (path === '/status') return ok({ mode: 'SIMULATION', device: {}, models: {} });
      if (path in extra) return typeof extra[path] === 'function' ? extra[path]() : ok(extra[path]);
      return ok(path.startsWith('/telemetry') ? { samples: [] } : []);
    }));
  }
  const pred = (o = {}) => ({ action: 'STOP', risk: 0.1, mean_at_30_60_120: { rpm: [1, 0, 0], vib_rms: [0.01, 0, 0], housing: [25, 25, 25] }, lo_120: { vib_rms: 0, housing: 24 },
    hi_120: { vib_rms: 0.02, housing: 26 }, status: 'supported', status_reasons: [], ...o });

  it('shows each prediction status and the reasons for an unsupported one on the Predictions page', async () => {
    server({ '/predictions': [pred(), pred({ action: 'REDUCE_SPEED', status: 'unsupported', status_reasons: ['measurement_noise_5.0x_calibration_level'] })] });
    setToken('t'); render(<TorqvaApp pollMs={100000} />);
    await screen.findByText(/tester · /);
    fireEvent.click(screen.getByRole('button', { name: /^Predictions/ }));
    expect(await screen.findByText('unsupported — not used for decisions')).toBeInTheDocument();
    expect(screen.getByText(/measurement noise 5.0x calibration level/)).toBeInTheDocument();
    expect(screen.getByText('Predicted vs observed (simulated)')).toBeInTheDocument();
  });

  it('keeps polling when the prediction-check route is unavailable', async () => {
    server({ '/prediction-checks': () => ({ ok: false, status: 404, json: async () => ({ detail: 'x' }) }) });
    setToken('t'); render(<TorqvaApp pollMs={100000} />);
    await screen.findByText(/tester · /);
    fireEvent.click(screen.getByRole('button', { name: /^Predictions/ }));
    expect(await screen.findByText('Predicted vs observed (simulated)')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
