import React from 'react';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import TorqvaApp from '../torqva/TorqvaApp.jsx';
import { setToken } from '../torqva/api.js';

const CHECKS = [
  { name: 'telemetry_complete', passed: true, detail: '60 windows' },
  { name: 'no_incident', passed: true, detail: 'none' },
  { name: 'sensor_envelope', passed: false, detail: 'not explainable as a static nuisance: non_stationary_warmup' },
];
const brief = (o = {}) => ({ id: 'C-0001', state: 'ELIGIBLE', rev: 1, session: 'S1', created_by: 'olga', captured_sim_t: 70, n: 60,
  failed_checks: [], reasons: [], warnings: [], reference_version: null, setpoint_rpm: 1650, ...o });
const detail = (o = {}) => ({ ...brief(), evidence_hash: 'abc123', versions: { detector_class: 'AdaptiveBaselineDetector', detector_version: 1, attestation_config: 'cfg1' },
  summary: { n: 60, t_start: 11, t_end: 70, setpoint_rpm_mean: 1650, rpm_mean: 1648, rpm_cv: 0.004, ambient_c_mean: 22, ambient_c_std: 0.01,
    voltage_v_mean: 23.5, voltage_v_std: 0.03, current_a_mean: 1.2, housing_c_mean: 25, vib_rms_g_mean: 0.07 },
  checks: CHECKS.map((c) => ({ ...c, passed: true })), history: [{ event: 'candidate_captured', from: 'ELIGIBLE', to: 'ELIGIBLE', by: 'olga', role: 'operator', reason: '' }], ...o });

function server(role, { list, det, refs, hold } = {}) {
  const calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url, o = {}) => {
    const path = String(url).replace('/api/torqva', '');
    const method = o.method || 'GET';
    calls.push({ path, method, body: o.body ? JSON.parse(o.body) : undefined });
    const ok = (j) => ({ ok: true, status: 200, json: async () => j });
    if (path === '/me') return ok({ user: 'tester', role });
    if (path === '/status') return ok({ mode: 'SIMULATION', device: {}, models: {} });
    if (path === '/attestation/candidates' && method === 'GET') return ok(list ?? [brief()]);
    if (path.startsWith('/attestation/candidates/') && method === 'GET') return ok(det ?? detail());
    if (path === '/attestation/references') return ok(refs ?? { versions: [], active_version: null });
    if (path === '/attestation/events') return ok([]);
    if (path === '/attestation/warmup' && method === 'GET') return ok(hold ?? { active: false });
    if (method === 'POST' && path.endsWith('/attest')) return { ok: false, status: 409, json: async () => ({ detail: 'candidate changed (rev 2, you saw 1)' }) };
    if (method === 'POST') return ok(brief());
    return ok(path.startsWith('/telemetry') ? { samples: [] } : []);
  }));
  return calls;
}

async function openTab(role = 'operator', opts) {
  const calls = server(role, opts);
  setToken('t');
  render(<TorqvaApp pollMs={100000} />);
  await screen.findByText(/tester · /);
  fireEvent.click(screen.getByRole('button', { name: /^Attestation/ }));
  await screen.findByText('Candidate warm-up sessions');
  return calls;
}

beforeEach(() => { vi.unstubAllGlobals(); setToken(''); });

describe('TORQVA attestation workspace', () => {
  it('always shows that attestation is an operator judgment and keeps the simulation banner', async () => {
    await openTab();
    expect(screen.getByTestId('att-notice')).toHaveTextContent('not proof that the motor is fault-free');
    expect(screen.getByTestId('sim-banner')).toBeInTheDocument();
  });

  it('lists candidates with explicit state labels and failed checks', async () => {
    await openTab('operator', { list: [brief(), brief({ id: 'C-0002', state: 'REJECTED', failed_checks: ['no_incident'] }), brief({ id: 'C-0003', state: 'PENDING' })] });
    const table = await screen.findByRole('table', { name: 'Candidate warm-up sessions' });
    expect(within(table).getByText('ELIGIBLE')).toBeInTheDocument();
    expect(within(table).getByText('REJECTED')).toBeInTheDocument();
    expect(within(table).getByText('PENDING')).toBeInTheDocument();
    expect(within(table).getByText('no_incident')).toBeInTheDocument();
  });

  it('shows the evidence with pass/fail text (not colour alone) and rejection reasons', async () => {
    await openTab('operator', { det: detail({ state: 'REJECTED', checks: CHECKS, reasons: ['sensor_envelope: not explainable'] }) });
    fireEvent.click(await screen.findByRole('button', { name: 'Open candidate C-0001' }));
    const t = await screen.findByRole('table', { name: 'Eligibility checks' });
    expect(within(t).getAllByText('pass').length).toBe(2);
    expect(within(t).getByText('fail')).toBeInTheDocument();
    expect(screen.getByText(/Why not eligible: sensor_envelope/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Attest…' })).not.toBeInTheDocument();
  });

  it('viewers can review but see no capture, attest, reject, revoke or activate controls', async () => {
    await openTab('viewer', { refs: { versions: [{ version: 1, candidate: 'C-0001', gain: 1.1, validation: { ok: true }, status: 'VALIDATED' }], active_version: null } });
    fireEvent.click(await screen.findByRole('button', { name: 'Open candidate C-0001' }));
    await screen.findByRole('table', { name: 'Eligibility checks' });
    expect(screen.getByRole('button', { name: /Capture candidate/ })).toBeDisabled();
    for (const n of ['Attest…', 'Reject…', 'Revoke…', /^Activate v/]) expect(screen.queryByRole('button', { name: n })).not.toBeInTheDocument();
    expect(screen.getByText(/cannot capture, attest, reject, revoke or activate/)).toBeInTheDocument();
  });

  it('requires a reason and an explicit acknowledgement before attesting, sends the revision it saw, and shows a server refusal', async () => {
    const calls = await openTab('operator');
    fireEvent.click(await screen.findByRole('button', { name: 'Open candidate C-0001' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Attest…' }));
    const confirm = await screen.findByRole('button', { name: 'Confirm attest' });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Decision reason'), { target: { value: 'too short' } });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Decision reason'), { target: { value: 'Reviewed the summary; motor steady and quiet.' } });
    expect(confirm).toBeDisabled();
    fireEvent.click(screen.getByLabelText(/I understand this is an operator judgment/));
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    await waitFor(() => expect(calls.some((c) => c.path.endsWith('/attest'))).toBe(true));
    const post = calls.find((c) => c.path.endsWith('/attest'));
    expect(post.body).toEqual({ reason: 'Reviewed the summary; motor steady and quiet.', expected_rev: 1, acknowledge: true });
    expect(await screen.findByRole('alert')).toHaveTextContent('candidate changed');
  });

  it('cancelling a confirmation sends nothing', async () => {
    const calls = await openTab('operator');
    fireEvent.click(await screen.findByRole('button', { name: 'Open candidate C-0001' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Reject…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('shows reference versions, marks the active one, and enables rollback only with a reason', async () => {
    await openTab('operator', { refs: { versions: [{ version: 2, candidate: 'C-0002', gain: 1.2, validation: { ok: true }, status: 'VALIDATED' }], active_version: 2 } });
    expect(await screen.findByText('active')).toBeInTheDocument();
    const rb = screen.getByRole('button', { name: 'Roll back active reference' });
    expect(rb).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Reference change reason'), { target: { value: 'suspected contamination of v2' } });
    expect(rb).toBeEnabled();
  });

  it('reports deferred anomaly windows and why a hold was released (deferral is never silent)', async () => {
    await openTab('operator', { hold: { active: false, info: { deferred_windows: 42, released: 'fault_suspected:residual_anomaly_after_nuisance_model' } } });
    const st = await screen.findByTestId('hold-status');
    expect(st).toHaveTextContent('Hold ended');
    expect(st).toHaveTextContent('deferred anomaly windows: 42');
    expect(st).toHaveTextContent('fault_suspected');
  });

  it('escalates a deferred coherent shift as an unfamiliar regime that is not confirmed healthy', async () => {
    await openTab('operator', { hold: { active: true, info: { deferred_windows: 12, regime_escalation: true } } });
    const w = await screen.findByTestId('regime-escalation');
    expect(w).toHaveTextContent('human review required');
    expect(w).toHaveTextContent('not confirmed healthy');
    expect(screen.getByTestId('hold-status')).toHaveTextContent('deferred anomaly windows: 12');
  });
});
