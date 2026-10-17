// Analyst workflow (simulation): sequence validation, honest condition and lifecycle read-outs, predictions tied to their exact target,
// stale results never selectable, and a request that only happens after the backend's check allows it and the analyst confirms.
import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { validateSequence } from '../torqva/simulation/tests.jsx';
import { explainPrediction, SimPredictionsPage } from '../torqva/simulation/predict.jsx';
import { lifecycleOf, SimInterventionsPage } from '../torqva/simulation/intervene.jsx';
import { conditionOf } from '../torqva/simulation/diagnose.jsx';
import { PhysicalAiPage } from '../torqva/physical/physical.jsx';
import { setToken } from '../torqva/api.js';

const LIMITS = { max_rpm: 3000, profile_max_s: 1800, sequence_max_s: 2400, max_steps: 6, setpoint_rpm: 1800, reduce_envelope_rpm: [540, 1800] };
const W = { t: 100, rpm: 1799, voltage: 23.6, current: 1.35, housing: 23, vib_rms: 0.3, valid: true };
const STATUS = { mode: 'SIMULATION', t: 100, scenario: { fault: 'imbalance', severity: 0.5, inject_after_s: 10 }, device: { estop: false, setpoint_rpm: 1800 },
  incident: { id: 'INC-001', state: 'AWAITING_APPROVAL' }, pending_approval: { action: 'REDUCE_SPEED', params: { rpm: 1260 }, rationale: 'x' }, last_window: W, models: {} };
const POST = { ranked: [['imbalance', 0.97], ['looseness', 0.03]], label: 'confident', top: 'imbalance', top_p: 0.97, margin: 0.94, ood: false, n_windows: 11 };
const PLAN = { provenance: 'SIMULATED', posterior: POST, limits: LIMITS, quick_rpm: [1800, 1530, 1260, 900],
  suggested_targets: [{ target_rpm: 1260, why: 'a' }, { target_rpm: 1530, why: 'b' }, { target_rpm: 900, why: 'c' }], tests: [], hypotheses: [] };
const pred = (action, target, id, basis, extra = {}) => ({ candidate_id: id, action, target_rpm: target, horizons_s: [30, 60, 120], basis,
  mean: { rpm: [target || 1800, target || 1800, target || 1800], housing: [23, 23.5, 24 - (target ? 0.5 : 0)], vib_rms: [0.2, 0.2, 0.2], current: [1.2, 1.2, 1.2] },
  lo: { housing: [22.8, 23.3, 23.6] }, hi: { housing: [23.2, 23.7, 24.2] }, risk: 0.01, status: 'supported', status_reasons: [], interval_method: 'split_conformal_floor',
  within_supervisor_envelope: !target || (target >= 540 && target < 1800), ...extra });
const BASIS = { t: 100, setpoint_rpm: 1800, incident: 'INC-001', posterior_top: 'imbalance', posterior_label: 'confident', posterior_windows: 11 };

function server(handlers) {
  const calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url, o = {}) => {
    const [path, qs] = String(url).replace('/api/torqva', '').split('?');
    const body = o.body ? JSON.parse(o.body) : qs ? { targets: new URLSearchParams(qs).getAll('targets').map(Number) } : undefined;
    calls.push({ path, method: o.method || 'GET', body });
    const h = handlers[path];
    const r = h ? await h(body) : { status: 404, json: { detail: 'nope' } };
    return { ok: (r.status || 200) < 400, status: r.status || 200, json: async () => (r.json !== undefined ? r.json : r) };
  }));
  return calls;
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('sequence validation (mirrors the backend limits)', () => {
  it('rejects out-of-range speeds and dwells and counts fixed test durations', () => {
    expect(validateSequence([], LIMITS).errs).toContain('add at least one test');
    const bad = validateSequence([{ type: 'profile', steps: [{ rpm: '5000', hold_s: '60' }, { rpm: '1200', hold_s: '2' }] }], LIMITS).errs.join(' ');
    expect(bad).toMatch(/rpm must be 1–3000/); expect(bad).toMatch(/dwell must be 5–900/);
    expect(validateSequence([{ type: 'profile', steps: [{ rpm: '1500', hold_s: '900' }, { rpm: '1200', hold_s: '901' }] }], LIMITS).errs.join(' ')).toMatch(/dwell/);
    const ok = validateSequence([{ type: 'profile', steps: [{ rpm: '1800', hold_s: '60' }, { rpm: '1260', hold_s: '60' }] }, { type: 'T3' }, { type: 'T4' }], LIMITS);
    expect(ok.errs).toEqual([]); expect(ok.total).toBe(120 + 300 + 50);
  });
});

describe('Diagnostic Tests: the edited sequence is exactly what is submitted', () => {
  it('adding, editing, reordering and removing steps changes the request body', async () => {
    setToken('t');
    const { SimTestsPage } = await import('../torqva/simulation/tests.jsx');
    const calls = server({
      '/simulation/workbench/plan': () => ({ ...PLAN, tests: [{ test: 'T3', fixed_parameters: 'hold speed and observe 300 s' }] }),
      '/simulation/workbench/sequence': () => ({ id: 'D-1', results: [], series: [], assessment: { category: 'inconclusive', detail: 'x', tested_setpoints_rpm: [], baseline_note: 'b' },
        fused: { note: 'n' }, scenario_note: 's', posterior_final: null, recommended_next: null, executed_on: 'a copy' }),
    });
    const setWb = vi.fn();
    render(<SimTestsPage d={{ status: STATUS, log: [] }} role="operator" wb={{}} setWb={setWb} />);
    await waitFor(() => expect(calls.some((c) => c.path === '/simulation/workbench/plan')).toBe(true));
    const addButtons = await screen.findAllByRole('button', { name: /Add to sequence/ });
    fireEvent.click(addButtons[0]);                                                     // the speed profile: 3 quick steps 1800, 1530, 1260
    fireEvent.click(addButtons[2]);                                                     // T3
    const rpm = () => screen.getAllByLabelText('Target rpm');
    fireEvent.change(rpm()[1], { target: { value: '1400' } });                          // edit step 2
    fireEvent.change(screen.getAllByLabelText('Dwell (s)')[0], { target: { value: '45' } });
    fireEvent.click(screen.getByRole('button', { name: 'Move step 3 up' }));          // 1800, 1260, 1400
    fireEvent.click(screen.getByRole('button', { name: 'Remove step 1' }));           // 1260, 1400
    fireEvent.click(screen.getByRole('button', { name: 'Move test 2 up' }));          // T3 before the profile
    fireEvent.click(screen.getByTestId('run-sequence'));
    await waitFor(() => expect(calls.some((c) => c.path === '/simulation/workbench/sequence')).toBe(true));
    expect(calls.find((c) => c.path === '/simulation/workbench/sequence').body).toEqual({
      steps: [{ type: 'T3' }, { type: 'profile', profile: [{ rpm: 1260, hold_s: 60 }, { rpm: 1400, hold_s: 60 }] }], stop_when_confident: true });
  });
  it('an invalid step disables the run with the reason', async () => {
    setToken('t');
    const { SimTestsPage } = await import('../torqva/simulation/tests.jsx');
    server({ '/simulation/workbench/plan': () => PLAN });
    render(<SimTestsPage d={{ status: STATUS, log: [] }} role="operator" wb={{}} setWb={() => {}} />);
    fireEvent.click((await screen.findAllByRole('button', { name: /Add to sequence/ }))[0]);
    fireEvent.change(screen.getAllByLabelText('Target rpm')[0], { target: { value: '3500' } });
    expect(screen.getByTestId('run-sequence')).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent(/rpm must be 1–3000/);
  });
});

describe('condition and lifecycle read-outs', () => {
  it('never turns missing or invalid data into a healthy reading', () => {
    expect(conditionOf({ status: { ...STATUS, incident: null, last_window: { ...W, valid: false } } }, null, false)[1]).toMatch(/Uncertain/);
    expect(conditionOf({ status: { ...STATUS, incident: null } }, { c1: { score_over_threshold: null, status: 'UNLEARNED_BIN' } }, false)[1]).toMatch(/not scored/);
    expect(conditionOf({ status: { ...STATUS, device: { estop: true, estop_reason: 'TEMP_STOP' } } }, null, false)[1]).toMatch(/Unsafe/);
    expect(conditionOf({ status: STATUS }, null, true)[1]).toMatch(/Uncertain/);
  });
  it('an acknowledged command is not a verified recovery', () => {
    const log = [{ t: 20, kind: 'incident_opened', incident: 'INC-001' }, { t: 22, kind: 'gate', incident: 'INC-001', verdict: 'ACT', reason: 'ok' },
      { t: 23, kind: 'transition', incident: 'INC-001', event: 'ACTION_PROPOSED' }, { t: 23, kind: 'supervisor', incident: 'INC-001', action: 'REDUCE_SPEED', verdict: 'DEFER' },
      { t: 25, kind: 'analyst_action', incident: 'INC-001', action: 'REDUCE_SPEED', target_rpm: 1400 }, { t: 25, kind: 'transition', incident: 'INC-001', event: 'APPROVED' }];
    const d = { status: { ...STATUS, incident: { id: 'INC-001', state: 'VERIFYING_RECOVERY' }, pending_approval: null }, log,
      commands: [{ id: 3, action: 'REDUCE_SPEED', params: { rpm: 1400 }, status: 'ACCEPTED', incident: 'INC-001' }], outcomes: [] };
    const st = Object.fromEntries(lifecycleOf(d).steps.map(([k, , s, detail]) => [k, [s, detail]]));
    expect(st.decision[1]).toMatch(/analyst's selection: REDUCE SPEED to 1,400 rpm/);
    expect(st.ack[0]).toBe('done'); expect(st.post[0]).toBe('now');
    expect(st.verified[0]).toBe('todo'); expect(st.verified[1]).toMatch(/never recovery/);
  });
});

describe('prediction explanations use only returned numbers', () => {
  it('describes target, housing interval and risk, and flags an unsupported prediction', () => {
    const cont = pred('CONTINUE_MONITORING', null, 'P1-C', BASIS);
    const t = explainPrediction(pred('REDUCE_SPEED', 1260, 'P1-A', BASIS), cont, { housing: 23 }).join(' ');
    expect(t).toMatch(/1,260 rpm/); expect(t).toMatch(/90 % interval 23\.6–24\.2/); expect(t).toMatch(/0\.5 °C below continuing/); expect(t).toMatch(/risk .* 1%/);
    expect(explainPrediction(pred('REDUCE_SPEED', 900, 'x', BASIS, { status: 'unsupported', status_reasons: ['out_of_range'] }), cont, {}).join(' ')).toMatch(/cannot drive a decision/);
  });
});

describe('Predictions: a changed target is re-predicted and stale results cannot be selected', () => {
  it('requests a fresh prediction for a custom target and only then allows selecting it', async () => {
    setToken('t');
    const calls = server({
      '/simulation/workbench/plan': () => PLAN,
      '/simulation/workbench/predict': (b) => ({ request_id: 'P1', basis: BASIS, max_age_s: 30, current: { rpm: 1799, setpoint_rpm: 1800, housing: 23, averaged_windows: 10 },
        candidates: b.targets.map((t, i) => pred('REDUCE_SPEED', t, `P1-${'ABC'[i]}`, BASIS)), references: [pred('CONTINUE_MONITORING', null, 'P1-C', BASIS), pred('STOP', 0, 'P1-S', BASIS)],
        trust: { trusted: true, reasons: [] }, risk_limits: {}, validated_by_experiments: false }),
    });
    const setWb = vi.fn();
    render(<SimPredictionsPage d={{ status: STATUS, predictions: [], log: [] }} go={() => {}} wb={{}} setWb={setWb} />);
    await waitFor(() => expect(calls.some((c) => c.path === '/simulation/workbench/predict')).toBe(true));
    expect(calls.find((c) => c.path === '/simulation/workbench/predict').body.targets).toEqual([1260, 1530, 900]);   // the backend's suggestions
    await screen.findByRole('button', { name: /Select Action A — target 1,260 rpm/ });
    fireEvent.change(screen.getByLabelText('Target rpm for action A'), { target: { value: '1400' } });
    const btn = screen.getByRole('button', { name: /Select Action A — target 1,400 rpm/ });
    expect(btn).toBeDisabled();                                                          // the 1,260 result is not shown as 1,400
    expect(screen.getByTestId('pending-A')).toHaveTextContent(/1,400/);
    await waitFor(() => expect(calls.filter((c) => c.path === '/simulation/workbench/predict').pop().body.targets).toEqual([1400, 1530, 900]), { timeout: 3000 });
    await waitFor(() => expect(screen.getByRole('button', { name: /Select Action A — target 1,400 rpm/ })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /Select Action A — target 1,400 rpm/ }));
    const sel = setWb.mock.calls.pop()[0]({}).selection;
    expect(sel).toMatchObject({ label: 'A', candidate_id: 'P1-A', action: 'REDUCE_SPEED', target_rpm: 1400, basis: BASIS });
    expect(calls.some((c) => c.method === 'POST' && /request|approve|device/.test(c.path))).toBe(false);     // selecting sends nothing
  });

  it('a fractional target is requested and matched at the backend resolution, so it does not stay pending forever', async () => {
    setToken('t');
    const calls = server({
      '/simulation/workbench/plan': () => PLAN,
      '/simulation/workbench/predict': (b) => ({ request_id: 'P3', basis: BASIS, max_age_s: 30, current: { rpm: 1799, setpoint_rpm: 1800, housing: 23, averaged_windows: 10 },
        candidates: b.targets.map((t, i) => pred('REDUCE_SPEED', Math.round(t * 10) / 10, `P3-${'ABC'[i]}`, BASIS)), references: [], trust: { trusted: true, reasons: [] }, risk_limits: {} }),
    });
    render(<SimPredictionsPage d={{ status: STATUS, predictions: [], log: [] }} go={() => {}} wb={{}} setWb={() => {}} />);
    await screen.findByRole('button', { name: /Select Action A — target 1,260 rpm/ });
    fireEvent.change(screen.getByLabelText('Target rpm for action A'), { target: { value: '1400.04' } });
    await waitFor(() => expect(calls.filter((c) => c.path === '/simulation/workbench/predict').pop().body.targets[0]).toBe(1400), { timeout: 3000 });
    await waitFor(() => expect(screen.queryByTestId('pending-A')).toBeNull());
    expect(screen.getByRole('button', { name: /Select Action A — target 1,400 rpm/ })).toBeEnabled();
  });

  it('marks results stale when simulation time has moved on and blocks selection', async () => {
    setToken('t');
    server({
      '/simulation/workbench/plan': () => PLAN,
      '/simulation/workbench/predict': (b) => ({ request_id: 'P2', basis: BASIS, max_age_s: 30, current: { rpm: 1799, setpoint_rpm: 1800, housing: 23, averaged_windows: 10 },
        candidates: b.targets.map((t, i) => pred('REDUCE_SPEED', t, `P2-${'ABC'[i]}`, BASIS)), references: [], trust: { trusted: true, reasons: [] }, risk_limits: {} }),
    });
    const { rerender } = render(<SimPredictionsPage d={{ status: STATUS, predictions: [], log: [] }} go={() => {}} wb={{}} setWb={() => {}} />);
    await screen.findByRole('button', { name: /Select Action A — target 1,260 rpm/ });
    rerender(<SimPredictionsPage d={{ status: { ...STATUS, t: 160 }, predictions: [], log: [] }} go={() => {}} wb={{}} setWb={() => {}} />);
    expect(await screen.findByTestId('pred-stale')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Select Action A — target 1,260 rpm/ })).toBeDisabled();
  });
});

describe('Interventions: check first, then an explicit confirmation', () => {
  const sel = { label: 'A', candidate_id: 'P1-A', action: 'REDUCE_SPEED', target_rpm: 1400, basis: BASIS, prediction: pred('REDUCE_SPEED', 1400, 'P1-A', BASIS) };
  const d = { status: STATUS, log: [], commands: [], outcomes: [], decisions: [] };
  it('a refused check shows the backend reason and offers no request', async () => {
    setToken('t');
    const calls = server({ '/simulation/workbench/check': () => ({ executable: false, blockers: ['the decision gate does not allow acting now (RUN_DIAGNOSTIC_TEST: x)'],
      gate: { verdict: 'RUN_DIAGNOSTIC_TEST', reason: 'x', test: 'T1' }, supervisor: { verdict: 'ALLOW', reasons: [] }, awaiting_decision: true, pending: STATUS.pending_approval, stale: [] }) });
    render(<SimInterventionsPage d={d} role="operator" actions={{}} go={() => {}} wb={{ selection: sel }} setWb={() => {}} />);
    expect(await screen.findByTestId('dcheck-blockers')).toHaveTextContent(/RUN_DIAGNOSTIC_TEST/);
    expect(screen.getByTestId('req-start')).toBeDisabled();
    expect(screen.getByText(/Run T1 on Diagnostic Tests first/)).toBeInTheDocument();
    expect(calls.some((c) => c.path === '/simulation/workbench/request')).toBe(false);
  });
  it('an allowed check needs a second, explicit confirmation before the request carries the exact target and basis', async () => {
    setToken('t');
    const calls = server({
      '/simulation/workbench/check': () => ({ executable: true, blockers: [], gate: { verdict: 'ACT', reason: 'ok' }, supervisor: { verdict: 'ALLOW', reasons: ['checks_passed'] }, awaiting_decision: true, pending: STATUS.pending_approval, stale: [] }),
      '/simulation/workbench/request': () => ({ requested: { action: 'REDUCE_SPEED', target_rpm: 1400 }, command: { id: 9, status: 'PENDING' }, note: 'n' }),
    });
    const setWb = vi.fn();
    render(<SimInterventionsPage d={d} role="operator" actions={{}} go={() => {}} wb={{ selection: sel }} setWb={setWb} />);
    fireEvent.click(await screen.findByTestId('req-start'));
    expect(calls.some((c) => c.path === '/simulation/workbench/request')).toBe(false);
    fireEvent.click(screen.getByTestId('req-confirm'));
    await waitFor(() => expect(calls.some((c) => c.path === '/simulation/workbench/request')).toBe(true));
    expect(calls.find((c) => c.path === '/simulation/workbench/request').body).toEqual({ action: 'REDUCE_SPEED', target_rpm: 1400, basis: BASIS, candidate_id: 'P1-A' });
  });
  it('a viewer cannot request', async () => {
    setToken('t');
    server({ '/simulation/workbench/check': () => ({ executable: true, blockers: [], gate: { verdict: 'ACT', reason: 'ok' }, supervisor: { verdict: 'ALLOW', reasons: [] }, awaiting_decision: true, pending: STATUS.pending_approval, stale: [] }) });
    render(<SimInterventionsPage d={d} role="viewer" actions={{}} go={() => {}} wb={{ selection: sel }} setWb={() => {}} />);
    expect(await screen.findByTestId('req-start')).toBeDisabled();
  });
});

describe('physical mode keeps tests and actions locked', () => {
  it('lists the tests as not runnable, shows the device blockers and calls no simulator route', () => {
    const fetchSpy = vi.fn(); vi.stubGlobal('fetch', fetchSpy);
    render(<PhysicalAiPage stream={{ snap: { connection: 'DISCONNECTED', control_blockers: ['DEVICE NOT CONNECTED'] } }} layer="C4" go={() => {}} />);
    expect(screen.getByTestId('phys-test-catalog')).toHaveTextContent(/Speed-Step Dynamic Response/);
    expect(screen.getByTestId('phys-C4-blockers')).toHaveTextContent('DEVICE NOT CONNECTED');
    expect(screen.queryByRole('button', { name: /run|execute|request|start/i })).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
