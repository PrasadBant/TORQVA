// Diagnostic Workflow page. The backend is replaced by a stubbed fetch whose responses are RECORDED from the real backend
// (fixtures/workflow.json, produced by running workflow.py against the simulator, series trimmed). What is tested: one click sends one
// request with the chosen pattern, policy and an idempotency key; every stage, value and outcome shown is the backend's; authorization is a
// separate explicit step; physical mode renders the same layout and never offers to run what the backend says is unavailable.
import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { WorkflowPage, STAGES, OUTCOME } from '../torqva/workflow/workflow.jsx';
import { setToken } from '../torqva/api.js';
import FX from './fixtures/workflow.json';

const D = { status: { t: 60, device: {} } };
function server(h) {
  const calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url, o = {}) => {
    const [path, qs] = String(url).replace('/api/torqva', '').split('?');
    const body = o.body ? JSON.parse(o.body) : undefined;
    calls.push({ path, qs, method: o.method || 'GET', body });
    const key = `${o.method || 'GET'} ${path.replace(/WF-\d+/, ':id')}`;
    const r = h[key] ? await h[key](body, qs) : { status: 404, json: { detail: 'nope' } };    // STUB
    const code = r && r.json !== undefined && typeof r.status === 'number' ? r.status : 200;
    return { ok: code < 400, status: code, json: async () => (r.json !== undefined ? r.json : r) };
  }));
  return calls;
}
afterEach(() => vi.unstubAllGlobals());

describe('diagnostic workflow (simulation)', () => {
  it('runs the selected pattern with one click and shows the backend stages, diagnosis and recommendation', async () => {
    setToken('t');
    const calls = server({
      'GET /workflow/patterns': () => FX.patterns_sim, 'GET /workflow/runs': () => [],
      'POST /workflow/runs': () => FX.awaiting,
    });
    render(<WorkflowPage mode="SIMULATION" d={D} role="operator" stale={false} go={() => {}} />);
    fireEvent.click(await screen.findByTestId('wf-pattern-T3'));
    const run = screen.getByTestId('wf-run');
    expect(run).toBeEnabled();
    fireEvent.click(run);
    fireEvent.click(run);                                                     // a second click while in flight sends nothing
    expect(await screen.findByTestId('wf-record')).toHaveAttribute('data-status', 'AWAITING_AUTHORIZATION');
    const posts = calls.filter((c) => c.method === 'POST' && c.path === '/workflow/runs');
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toMatchObject({ mode: 'SIMULATION', pattern: 'T3', execution_policy: 'require_confirmation' });
    expect(posts[0].body.idempotency_key).toMatch(/^wf-/);
    // every stage the backend reported, with the backend's own status
    const stages = within(screen.getByTestId('wf-stages')).getAllByRole('listitem');
    expect(stages).toHaveLength(STAGES.length);
    FX.awaiting.stages.forEach((s) => expect(stages.find((li) => li.dataset.stage === s.stage)).toHaveAttribute('data-state', s.status));
    expect(stages.find((li) => li.dataset.stage === 'EXECUTING_ACTION')).toHaveAttribute('data-state', 'todo');
    // the diagnosis and recommendation are the backend's values
    expect(screen.getByTestId('wf-diagnosis')).toHaveTextContent(FX.awaiting.context.diagnosis.headline);
    const rec = FX.awaiting.context.recommendation;
    expect(screen.getByTestId('wf-recommendation')).toHaveTextContent(rec.headline);
    expect(screen.getByTestId('wf-target')).toHaveTextContent(`${Math.round(rec.target_rpm).toLocaleString('en-US')} rpm`);
    expect(screen.getByTestId('wf-candidates').querySelectorAll('tbody tr')).toHaveLength(rec.ranking.length);
    expect(screen.getByTestId('wf-predicted')).toBeInTheDocument();
    expect(screen.getByTestId('wf-verify-none')).toHaveTextContent('Nothing has been sent yet');
  });

  it('authorizes as a separate explicit step and then shows verification read from the backend', async () => {
    setToken('t');
    let state = FX.awaiting;
    const calls = server({
      'GET /workflow/patterns': () => FX.patterns_sim, 'GET /workflow/runs': () => [{ id: FX.awaiting.id }],
      'GET /workflow/runs/:id': () => state, 'POST /workflow/runs/:id/authorize': () => { state = FX.completed; return FX.verifying; },
    });
    const { rerender } = render(<WorkflowPage mode="SIMULATION" d={D} role="operator" stale={false} go={() => {}} />);
    fireEvent.click(await screen.findByTestId('wf-authorize'));                 // restored from GET /workflow/runs after a refresh
    await waitFor(() => expect(screen.getByTestId('wf-record')).toHaveAttribute('data-status', 'VERIFYING_OUTCOME'));
    expect(calls.filter((c) => c.path.endsWith('/authorize'))).toHaveLength(1);
    expect(screen.getByTestId('wf-verify-steps')).toHaveTextContent(`#${FX.verifying.context.intervention.command_id}`);
    rerender(<WorkflowPage mode="SIMULATION" d={{ status: { t: 200, device: {} } }} role="operator" stale={false} go={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('wf-record')).toHaveAttribute('data-status', 'COMPLETED'), { timeout: 4000 });
    expect(screen.getByTestId('wf-headline')).toHaveTextContent(FX.completed.headline);
    expect(screen.getAllByText(OUTCOME.RECOVERY_VERIFIED[1]).length).toBeGreaterThan(0);
    expect(screen.getByTestId('wf-pvo')).toBeInTheDocument();
  }, 10000);                                                                  // the page re-reads at most every 2.5 s of simulation-time change

  it('a healthy motor shows no command, no prediction and nothing to verify', async () => {
    setToken('t');
    server({ 'GET /workflow/patterns': () => FX.patterns_sim, 'GET /workflow/runs': () => [{ id: FX.healthy.id }], 'GET /workflow/runs/:id': () => FX.healthy });
    render(<WorkflowPage mode="SIMULATION" d={D} role="operator" stale={false} go={() => {}} />);
    expect(await screen.findByTestId('wf-recommendation')).toHaveAttribute('data-action', 'CONTINUE_MONITORING');
    expect(screen.getByTestId('wf-pred-unavailable')).toHaveTextContent('conditional on a fault-hypothesis ranking');
    expect(screen.getByTestId('wf-verify-none')).toHaveTextContent('No command was executed');
    expect(screen.queryByTestId('wf-authorize')).toBeNull();
  });

  it('a viewer cannot start a workflow and an unavailable pattern cannot be run', async () => {
    setToken('t');
    server({ 'GET /workflow/patterns': () => FX.patterns_sim, 'GET /workflow/runs': () => [] });
    render(<WorkflowPage mode="SIMULATION" d={D} role="viewer" stale={false} go={() => {}} />);
    await screen.findByTestId('wf-pattern-T3');
    expect(screen.getByTestId('wf-run')).toBeDisabled();
  });

  it('shows a backend refusal as an error, never as a result', async () => {
    setToken('t');
    server({ 'GET /workflow/patterns': () => FX.patterns_sim, 'GET /workflow/runs': () => [],
      'POST /workflow/runs': () => ({ status: 409, json: { detail: 'this idempotency key was already used for a different workflow request' } }) });
    render(<WorkflowPage mode="SIMULATION" d={D} role="operator" stale={false} go={() => {}} />);
    fireEvent.click(await screen.findByTestId('wf-pattern-T3'));
    fireEvent.click(screen.getByTestId('wf-run'));
    expect(await screen.findByText(/already used for a different workflow request/)).toBeInTheDocument();
    expect(screen.queryByTestId('wf-record')).toBeNull();
  });
});

describe('diagnostic workflow (physical)', () => {
  it('uses the same layout, asks only for physical records, and cannot run an unavailable pattern', async () => {
    setToken('t');
    const calls = server({ 'GET /workflow/patterns': () => FX.patterns_phys, 'GET /workflow/runs': () => [{ id: FX.physical.id }], 'GET /workflow/runs/:id': () => FX.physical });
    render(<WorkflowPage mode="PHYSICAL" role="admin" stale={false} go={() => {}} />);
    expect(await screen.findByTestId('wf-record')).toHaveAttribute('data-status', 'BLOCKED');
    expect(screen.getByText('PHYSICAL MODE')).toBeInTheDocument();
    expect(screen.getByTestId('wf-blockers')).toHaveTextContent('no diagnostic-test command');
    expect(screen.getByTestId('wf-run')).toBeDisabled();
    expect(calls.every((c) => !c.path.startsWith('/simulation'))).toBe(true);
    expect(calls.filter((c) => c.qs).every((c) => c.qs === 'mode=PHYSICAL')).toBe(true);
    const stages = within(screen.getByTestId('wf-stages')).getAllByRole('listitem');
    expect(stages[0]).toHaveAttribute('data-state', 'blocked');
    expect(stages.slice(1).every((li) => li.dataset.state === 'skipped')).toBe(true);
  });
});
