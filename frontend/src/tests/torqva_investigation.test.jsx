// Trace, adaptive testing, counterfactual lab and Decision Receipts in the browser. The backend is replaced by a stubbed fetch returning
// fixed responses (marked STUB below); what is tested is that the pages show exactly what the backend returned, send the right requests,
// and never present a refusal, a failed branch or a changed snapshot as a success.
import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { InvestigationTrace } from '../torqva/simulation/trace.jsx';
import { AdaptivePanel } from '../torqva/simulation/adaptive.jsx';
import { CounterfactualLab, mergeBranches } from '../torqva/simulation/counterfactual.jsx';
import { ReceiptsPanel, exportReceipt } from '../torqva/simulation/receipts.jsx';
import { setToken } from '../torqva/api.js';

const D = { status: { t: 100, device: {} }, log: [{ t: 1, kind: 'x' }], commands: [] };
function server(h) {
  const calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url, o = {}) => {
    const [path, qs] = String(url).replace('/api/torqva', '').split('?');
    calls.push({ path, qs, method: o.method || 'GET', body: o.body ? JSON.parse(o.body) : undefined });
    const r = h[path] ? await h[path](o.body ? JSON.parse(o.body) : undefined) : { status: 404, json: { detail: 'nope' } };   // STUB
    const code = r && r.json !== undefined && typeof r.status === 'number' ? r.status : 200;   // only a {status, json} wrapper sets an HTTP code
    return { ok: code < 400, status: code, json: async () => (r.json !== undefined ? r.json : r) };
  }));
  return calls;
}
afterEach(() => vi.unstubAllGlobals());

// STUB: a trace with three stages reached and three not
const TRACE = { incident: 'INC-001', incidents: ['INC-001'], open: true, note: 'records only', stages: [
  { stage: 'observation', reached: true, events: [{ t: 11, kind: 'incident_opened', label: 'incident opened', source: { record: 'log', index: 4 },
    data: { window: { rpm: 1799, current: 1.3, housing: 23, vib_rms: 0.3, valid: true, c1_status: 'OK', c1_score_over_threshold: 190 } } }] },
  { stage: 'hypothesis', reached: true, events: [{ t: 21, kind: 'hypotheses', label: 'hypotheses ranked: imbalance 1.00 (confident)', source: { record: 'log', index: 9 }, data: { ranked: [['imbalance', 1]], label: 'confident' } }] },
  { stage: 'test', reached: false, events: [] }, { stage: 'prediction', reached: false, events: [] },
  { stage: 'decision', reached: true, events: [{ t: 22, kind: 'gate', label: 'decision gate: ACT', source: { record: 'log', index: 12 }, data: { verdict: 'ACT' } }] },
  { stage: 'outcome', reached: false, events: [] }] };

describe('investigation trace', () => {
  it('shows each stage from the backend, names the source record, and never fills an unreached stage', async () => {
    setToken('t');
    server({ '/simulation/workbench/trace': () => TRACE });
    render(<InvestigationTrace d={D} focus={['observation']} />);
    expect(await screen.findByTestId('trace')).toBeInTheDocument();
    expect(screen.getByTestId('trace-test')).toHaveAttribute('data-reached', 'no');
    fireEvent.click(screen.getByTestId('trace-test'));
    expect(screen.getByText('No diagnostic test record in this incident yet.')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('trace-observation'));
    fireEvent.click(screen.getByRole('button', { name: /incident opened/ }));
    const det = screen.getByTestId('trace-detail');
    expect(det).toHaveTextContent('log entry #4'); expect(det).toHaveTextContent(/1799 rpm .* \(SIM\)/);
  });
});

// STUB: sufficiency from the plan, and one adaptive run
const SUFF = { status: 'MORE_EVIDENCE_REQUIRED', reason: "top probability 0.50 < 0.70; T1 is expected to remove 0.69 nats", rule: 'gate rule', min_info_gain_nats: 0.15,
  c1_baseline_for_current_speed: true, c1_window_status: 'OK', tests: [
    { test: 'T1', distinguishes: 'imbalance vs looseness', eligible: true, expected_info_gain_nats: 0.69, prerequisites: [{ check: 'motor driven', ok: true, detail: '' }] },
    { test: 'T3', distinguishes: 'cooling vs overload', eligible: false, expected_info_gain_nats: null, prerequisites: [{ check: 'thermal model fitted', ok: false, detail: '' }] }] };
const RUN = { id: 'A-0001', status: 'SUFFICIENT_EVIDENCE', reason: "'imbalance' at 1.00 meets the gate's confidence rule", executed_on: 'a copy', scenario_note: 'n', scenario_truth: 'imbalance',
  posterior_start: { ranked: [['imbalance', 0.5], ['looseness', 0.5]] }, posterior_final: { ranked: [['imbalance', 1], ['looseness', 0]] }, series: [],
  stages: [{ index: 0, selected: 'T1', status: 'completed', distinguishes: 'imbalance vs looseness', leading_hypotheses: [['imbalance', 0.5], ['looseness', 0.5]],
    why_more_evidence: 'top probability 0.50 < 0.70', selection_reason: 'largest expected information gain among the eligible tests (0.69 nats)', required_signals: ['rpm', 'v1x'],
    alternatives: [{ test: 'T3', not_selected_because: 'prerequisite failed: thermal model fitted' }], observation: [2, 1.9, 0], observation_meaning: ['a', 'b', 'c'],
    posterior_before: { ranked: [['imbalance', 0.5], ['looseness', 0.5]] }, posterior_after: { ranked: [['imbalance', 1], ['looseness', 0]] }, ranking_changed: false }] };

describe('adaptive investigation', () => {
  it('shows the sufficiency status and prerequisites, runs with the chosen budget and explains each step', async () => {
    setToken('t');
    const calls = server({ '/simulation/workbench/adaptive': () => RUN });
    render(<AdaptivePanel plan={{ sufficiency: SUFF }} role="operator" d={D} />);
    expect(screen.getByText('MORE EVIDENCE REQUIRED')).toBeInTheDocument();
    expect(screen.getByTestId('suff-tests')).toHaveTextContent(/T3\s*not eligible/);
    fireEvent.change(screen.getByLabelText('Test budget'), { target: { value: '2' } });
    fireEvent.click(screen.getByTestId('run-adaptive'));
    await screen.findByTestId('adaptive-result');
    expect(calls.find((c) => c.path === '/simulation/workbench/adaptive').body).toEqual({ budget: 2 });
    const st = screen.getByTestId('adaptive-stage-0');
    expect(st).toHaveTextContent(/largest expected information gain/); expect(st).toHaveTextContent(/T3 not selected: prerequisite failed/);
    expect(screen.getByText('SUFFICIENT EVIDENCE')).toBeInTheDocument();
  });
  it('a viewer cannot run it', () => {
    render(<AdaptivePanel plan={{ sufficiency: SUFF }} role="viewer" d={D} />);
    expect(screen.getByTestId('run-adaptive')).toBeDisabled();
  });
});

// STUB: one completed and one failed branch
const obs = (rpm) => Array.from({ length: 30 }, (_, i) => ({ dt: i + 1, rpm, current: 1, voltage: 24, power: 24, housing: 23, vib_rms: 0.1, score: 0.5 }));
const M = { final_mean_last_10s: { rpm: 1400, housing: 23, current: 1 }, max: { housing: 23, current: 1, vib_rms: 0.1 }, seconds_above_warn_limit: { housing: 0 }, c1_flagged_fraction: 0, c1_scored_windows: 30, valid_windows: 30 };
const CF = { id: 'CF-0001', note: 'copies only', risk_limits: { housing: 50 }, metric_definitions: { max: 'largest value' },
  inputs: { start_sim_t: 100, seed: 4, setpoint_rpm: 1800, horizon_s: 30, state_digest: 'abc', model_versions: { hypothesis_model: 1, c4_signatures: 1, c2_predictor: 1 } },
  start: { rpm: 1800, current: 1.3, voltage: 23.6, housing: 23, vib_rms: 0.3, injected_fault: 'imbalance' },
  branches: [{ action: 'CONTINUE_MONITORING', label: 'Continue', status: 'completed', within_supervisor_envelope: true, observed: obs(1800), metrics: { ...M, final_mean_last_10s: { rpm: 1800, housing: 24, current: 1.3 } },
    prediction: { rows: [{ horizon_s: 30, signal: 'rpm', predicted_mean: 1800, lo: 1790, hi: 1810, observed: 1800, inside_interval: true }] } },
    { action: 'REDUCE_SPEED', target_rpm: 1400, label: 'Reduce to 1400 rpm', status: 'failed', error: 'RuntimeError: boom', within_supervisor_envelope: true }] };

describe('counterfactual lab', () => {
  it('merges branches on the same clock', () => {
    const rows = mergeBranches([{ label: 'A', status: 'completed', observed: obs(1) }, { label: 'B', status: 'completed', observed: obs(2) }, { label: 'C', status: 'failed' }], 'rpm');
    expect(rows).toHaveLength(30); expect(rows[0]).toEqual({ t: 1, A: 1, B: 2 });
  });
  it('sends the chosen candidates and horizon, shows a failed branch as failed and re-runs from the same state', async () => {
    setToken('t');
    const calls = server({ '/simulation/workbench/counterfactual': () => CF, '/simulation/workbench/counterfactual/CF-0001/rerun': () => ({ identical: true, branches: [] }) });
    render(<CounterfactualLab targets={[1400]} role="operator" hasRanking hasSim />);
    fireEvent.change(screen.getByLabelText('Horizon'), { target: { value: '30' } });
    fireEvent.click(screen.getByTestId('run-cf'));
    await screen.findByTestId('cf-result');
    expect(calls.find((c) => c.path === '/simulation/workbench/counterfactual').body).toEqual({ targets: [1400], include_continue: true, include_stop: false, horizon_s: 30 });
    expect(within(screen.getByTestId('cf-REDUCE_SPEED')).getByText('failed')).toBeInTheDocument();
    expect(screen.getByTestId('cf-REDUCE_SPEED')).toHaveTextContent('RuntimeError: boom');
    expect(screen.getByTestId('cf-pred')).toHaveTextContent(/1800 \[1790–1810\]/);
    fireEvent.click(screen.getByTestId('cf-rerun'));
    expect(await screen.findByText(/reproduced: every branch identical/)).toBeInTheDocument();
  });
  it('needs at least two candidates', () => {
    render(<CounterfactualLab targets={[]} role="operator" hasRanking hasSim />);
    fireEvent.click(screen.getByLabelText(/Continue/));
    expect(screen.getByTestId('run-cf')).toBeDisabled();
  });
});

// STUB: a refused analyst receipt and a pipeline one
const REFUSED = { id: 'R-0001', decision: 'REFUSED', digest_valid: true, snapshot_sha256: 'f'.repeat(64), digest_note: 'detects a change',
  request: { action: 'REDUCE_SPEED', target_rpm: 1400, requested_by: 'olga', candidate_id: 'P1-A' }, command: null,
  lifecycle: [{ state: 'PROPOSED', t: 100, detail: 'submitted' }, { state: 'REJECTED', t: 100, detail: 'refused before dispatch' }],
  unresolved: ['the request was refused; no action was dispatched'],
  snapshot: { sim_t: 100, session: 'S1', investigation: 'INC-001', telemetry: { rpm: 1799, setpoint: 1800, current: 1.3, voltage: 23.6, housing: 23, vib_rms: 0.3, valid: true, age_s: 0 },
    c1: { status: 'OK', score_over_threshold: 190 }, hypotheses: { ranked: [['imbalance', 1]], label: 'confident', n_windows: 11 }, evidence_features: [],
    gate: { verdict: 'ACT', reason: 'ok' }, supervisor: { verdict: 'ALLOW', reasons: [] }, stale: ['computed 100 s ago'], blockers: ['the prediction is stale'], versions: {} } };

describe('decision receipts', () => {
  it('lists receipts, shows a refusal with its lifecycle and unresolved issue, and flags a changed snapshot', async () => {
    setToken('t');
    let changed = false;
    server({ '/simulation/workbench/receipts': () => ({ receipts: [{ id: 'R-0001', kind: 'analyst', decision: 'REFUSED', action: 'REDUCE_SPEED', target_rpm: 1400 }], pending: null }),
      '/simulation/workbench/receipts/R-0001': () => ({ ...REFUSED, digest_valid: !changed }) });
    const { rerender } = render(<ReceiptsPanel d={D} focusId="R-0001" />);
    const rec = await screen.findByTestId('receipt');
    expect(within(rec).getAllByText('REFUSED').length).toBeGreaterThan(0);
    expect(screen.getByTestId('receipt-lifecycle')).toHaveTextContent(/REJECTED/);
    expect(screen.getByTestId('receipt-unresolved')).toHaveTextContent('no action was dispatched');
    expect(screen.getByTestId('receipt-snapshot')).toHaveTextContent(/stale: computed 100 s ago/);
    expect(screen.queryByText(/EXECUTED|RECOVERED/)).toBeNull();
    changed = true;
    rerender(<ReceiptsPanel d={{ ...D, log: [...D.log, { t: 2 }] }} focusId="R-0001" />);
    expect(await screen.findByText('SNAPSHOT CHANGED')).toBeInTheDocument();
  });
  it('exports the receipt as a JSON download', () => {
    const create = vi.fn(() => 'blob:x'); const revoke = vi.fn();
    vi.stubGlobal('URL', { createObjectURL: create, revokeObjectURL: revoke });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});   // jsdom has no download navigation
    expect(exportReceipt(REFUSED)).toBe(true);
    const blob = create.mock.calls[0][0];
    expect(blob.type).toBe('application/json'); expect(click).toHaveBeenCalledTimes(1);
    click.mockRestore();
  });
});
