// Simulation Overview, Scenario Studio, C1–C6 pipeline and incident story: states come only from the simulator's records,
// scenario controls map onto the existing StartSimulation / step / stop routes, and ground truth is kept apart from TORQVA's diagnosis.
import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { lifecycle, pipelineStages } from '../torqva/simulation/pipeline.js';
import { ScenarioStudio } from '../torqva/simulation/scenario.jsx';
import { SimOverview } from '../torqva/simulation/overview.jsx';
import { IncidentStory } from '../torqva/simulation/story.jsx';

const W = { t: 120, rpm: 1799, duty: 40, voltage: 24, current: 1.5, housing: 31, vib_rms: 0.05, valid: true };
const STATUS = { mode: 'SIMULATION', provenance: 'SIMULATED', t: 120, scenario: { fault: 'imbalance', severity: 0.6, seed: 3, setpoint_rpm: 1800, inject_after_s: 40, human_approval_required: false, clears_below_rpm: null },
  device: { estop: false, estop_reason: '', setpoint_rpm: 1800 }, incident: null, pending_approval: null, last_window: W, models: {}, closed_incidents: 0 };
const SAMPLES = [{ t: 119, rpm: 1798, setpoint: 1800, housing: 31, vib_rms: 0.05, current: 1.5, voltage: 24, score: 0.4, score_status: 'OK' }, { t: 120, rpm: 1799, setpoint: 1800, housing: 31, vib_rms: 0.05, current: 1.5, voltage: 24, score: 0.5, score_status: 'OK' }];
const base = (o = {}) => ({ status: STATUS, telemetry: { samples: SAMPLES }, log: [], outcomes: [], cases: [], decisions: [], incidents: [], ...o });
const LOG = [
  { t: 60, kind: 'incident_opened', incident: 'INC-1' },
  { t: 70, kind: 'hypotheses', incident: 'INC-1', ranked: [['imbalance', 0.82], ['looseness', 0.1]], label: 'confident' },
  { t: 71, kind: 'c2_ranking', incident: 'INC-1', ranking: [['REDUCE_SPEED', 0.01], ['STOP', 0.0]], chosen: 'REDUCE_SPEED' },
  { t: 71, kind: 'gate', incident: 'INC-1', verdict: 'ACT', reason: 'confident and supported', test: null },
];
const noop = () => {};
// Clicking the real submit button, so the browser's own constraint validation is part of the test (a step/min mismatch once blocked every start).
const submit = () => fireEvent.click(screen.getByRole('button', { name: 'Start new simulation' }));
const forceSubmit = () => fireEvent.submit(screen.getByRole('form', { name: 'Configure a new scenario' }));
const actions = (o = {}) => ({ start: vi.fn(), stop: vi.fn(), step: vi.fn(), approve: noop, reject: noop, ...o });

describe('simulation lifecycle', () => {
  it('reports only states the backend and the stepping loop substantiate', () => {
    expect(lifecycle({ status: { mode: 'SIMULATION', simulation: null } }, false, false).key).toBe('idle');
    expect(lifecycle(base({ status: { ...STATUS, t: 0 } }), false, false).key).toBe('ready');
    expect(lifecycle(base(), true, false).key).toBe('running');
    expect(lifecycle(base(), false, false).key).toBe('paused');
    expect(lifecycle(base({ status: { ...STATUS, pending_approval: { action: 'REDUCE_SPEED' } } }), true, false).key).toBe('approval');
    expect(lifecycle(base({ status: { ...STATUS, device: { estop: true, estop_reason: 'TEMP_STOP' } } }), true, false)).toMatchObject({ key: 'estop', label: 'Simulated E-stop latched' });
    expect(lifecycle(base(), true, true).key).toBe('unknown');                       // stale never reads as running
  });
});

describe('pipeline stages', () => {
  it('a started scenario without an incident does not mark later stages as done', () => {
    const { stages } = pipelineStages(base());
    expect(stages[0]).toMatchObject({ code: 'C1', state: 'ok' });                     // monitoring, score below threshold
    expect(stages.slice(1).map((x) => x.state)).toEqual(['idle', 'idle', 'idle', 'idle', 'idle', 'idle']);
  });
  it('no simulation: C1 is unavailable', () => {
    expect(pipelineStages({ status: { mode: 'SIMULATION', simulation: null } }).stages[0].state).toBe('na');
  });
  it('follows the incident log, waits for a human approval, and only C5 declares recovery', () => {
    const open = { ...STATUS, incident: { id: 'INC-1', state: 'AWAITING_APPROVAL', tests_run: 0 }, pending_approval: { action: 'REDUCE_SPEED', params: {}, rationale: 'x' } };
    const s = pipelineStages(base({ status: open, log: LOG })).stages;
    expect(s.map((x) => x.state)).toEqual(['ok', 'ok', 'ok', 'wait', 'idle', 'idle', 'idle']);
    expect(s[3].summary).toMatch(/Awaiting human approval/);
    const done = pipelineStages(base({ log: [...LOG, { t: 90, kind: 'incident_closed', incident: 'INC-1', final: 'RECOVERED' }],
      outcomes: [{ incident: 'INC-1', outcome: 'RECOVERED', n_fresh: 30, command_executed: true }], cases: [{ label: 'imbalance' }] })).stages;
    expect(done[5]).toMatchObject({ code: 'C5', state: 'ok' });
    expect(done[6]).toMatchObject({ code: 'C6', state: 'ok' });
    const human = pipelineStages(base({ log: LOG, outcomes: [{ incident: 'INC-1', outcome: 'HUMAN_INSPECTION_REQUIRED', n_fresh: 0, command_executed: false }] })).stages;
    expect(human[5].state).toBe('stop'); expect(human[6].state).toBe('stop');
  });
  it('an unsupported C2 prediction and an aborted test are shown as such', () => {
    const s = pipelineStages(base({ status: { ...STATUS, incident: { id: 'INC-1', state: 'INVESTIGATING' } },
      log: [LOG[0], { t: 65, kind: 'c2_unsupported', incident: 'INC-1', reasons: ['out_of_range'] }, { t: 66, kind: 'test_aborted', incident: 'INC-1', status: 'REFUSED' }] })).stages;
    expect(s[2].state).toBe('stop'); expect(s[4].state).toBe('fail');
  });
});

describe('Scenario Studio', () => {
  it('the default form is valid for the browser, so Start actually submits', () => {
    const a = actions();
    render(<ScenarioStudio d={base()} role="operator" actions={a} running={false} setRunning={noop} busy={false} />);
    expect(screen.getByRole('form', { name: 'Configure a new scenario' }).checkValidity()).toBe(true);
    submit();
    expect(a.start).toHaveBeenCalledTimes(1);
  });
  it('starts a run with the existing StartSimulation fields', () => {
    const a = actions();
    render(<ScenarioStudio d={base()} role="operator" actions={a} running={false} setRunning={noop} busy={false} />);
    fireEvent.change(screen.getByLabelText('Setpoint (rpm)'), { target: { value: '1500' } });
    fireEvent.change(screen.getByLabelText('Inject fault at (s)'), { target: { value: '20' } });
    expect(screen.getByRole('button', { name: 'Start new simulation' })).toBeEnabled();
    submit();
    expect(a.start).toHaveBeenCalledWith({ fault: 'imbalance', severity: 0.5, seed: 1, clears_below_rpm: 1500, require_human_approval: false, setpoint_rpm: 1500, inject_after_s: 20 });
  });
  it('a healthy run sends no fault and no injection time; an invalid setpoint blocks the start', () => {
    const a = actions();
    render(<ScenarioStudio d={base()} role="operator" actions={a} running={false} setRunning={noop} busy={false} />);
    fireEvent.change(screen.getByLabelText('Injected fault'), { target: { value: 'none' } });
    expect(screen.getByLabelText('Inject fault at (s)')).toBeDisabled();
    submit();
    expect(a.start.mock.calls[0][0]).toMatchObject({ fault: null, clears_below_rpm: null });
    expect(a.start.mock.calls[0][0]).not.toHaveProperty('inject_after_s');
    fireEvent.change(screen.getByLabelText('Setpoint (rpm)'), { target: { value: '5000' } });
    expect(screen.getByRole('button', { name: 'Start new simulation' })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent(/setpoint/);
    forceSubmit();
    expect(a.start).toHaveBeenCalledTimes(1);                                        // an invalid form is never sent
  });
  it('Step is available only while paused, and STOP is labelled as the simulated motor', () => {
    const a = actions();
    const { rerender } = render(<ScenarioStudio d={base()} role="operator" actions={a} running={false} setRunning={noop} busy={false} />);
    fireEvent.click(screen.getByRole('button', { name: /Step 5 s/ }));
    expect(a.step).toHaveBeenCalledTimes(1);
    rerender(<ScenarioStudio d={base()} role="operator" actions={a} running setRunning={noop} busy={false} />);
    expect(screen.getByRole('button', { name: /Step 5 s/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Stop motor \(coast\) in the simulator/ })).toHaveTextContent('STOP SIMULATED MOTOR');
  });
  it('a viewer can press STOP but cannot start, step or run', () => {
    render(<ScenarioStudio d={base()} role="viewer" actions={actions()} running={false} setRunning={noop} busy={false} />);
    expect(screen.getByRole('button', { name: 'Start new simulation' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Step/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^Run/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Stop motor/ })).toBeEnabled();
  });
});

describe('Simulation Overview', () => {
  const view = (d, o = {}) => render(<SimOverview d={d} role="operator" go={o.go || noop} actions={actions()} running={false} setRunning={noop} busy={false} stale={!!o.stale} stepSeconds={5} />);
  it('mirrors the physical layout with simulation fields and no hardware status', () => {
    view(base());
    const strip = screen.getByTestId('sim-status-strip');
    expect(strip).toHaveTextContent(/Paused/); expect(strip).toHaveTextContent(/imbalance · severity 0.60/); expect(strip).toHaveTextContent(/simulated E-stop clear/);
    expect(strip).not.toHaveTextContent(/firmware|handshake|board|commission/i);
    const kpis = screen.getByTestId('sim-kpis');
    expect(within(kpis).getAllByText('SIM')).toHaveLength(5);
    expect(within(kpis).getByText('DERIVED')).toBeInTheDocument();
    expect(kpis).toHaveTextContent('36.0');                                         // 24 V × 1.5 A of the same window
  });
  it('an invalid simulated window is unavailable, never a number or zero', () => {
    view(base({ status: { ...STATUS, last_window: { ...W, valid: false } } }));
    expect(within(screen.getByTestId('sim-kpis')).getAllByText('UNAVAILABLE')).toHaveLength(6);
  });
  it('pipeline stages open their detailed pages', () => {
    const go = vi.fn();
    view(base(), { go });
    fireEvent.click(within(screen.getByTestId('stage-c5')).getByRole('button'));
    expect(go).toHaveBeenCalledWith('recovery');
  });
});

describe('incident story', () => {
  it('keeps the scenario ground truth apart from TORQVA\'s diagnosis, the prediction and the observed verdict', () => {
    render(<IncidentStory d={base({ log: LOG, outcomes: [{ incident: 'INC-1', outcome: 'UNRESOLVED', reasons: ['still_above_band'], criteria: { in_band: false }, n_fresh: 30, command_executed: true, action: 'REDUCE_SPEED' }] })} />);
    const cols = screen.getByTestId('story-cols');
    expect(within(cols).getByLabelText('Scenario ground truth')).toHaveTextContent('imbalance');
    expect(within(cols).getByLabelText('TORQVA diagnosis')).toHaveTextContent('imbalance 82%');
    expect(within(cols).getByLabelText('Predicted outcome')).toHaveTextContent('REDUCE SPEED');
    expect(within(cols).getByLabelText('Observed outcome')).toHaveTextContent('UNRESOLVED');
    expect(screen.getByTestId('story-match')).toHaveTextContent('matches the injected fault');
    expect(screen.getByText('still above band')).toBeInTheDocument();
  });
  it('says so when no incident exists', () => {
    render(<IncidentStory d={base()} />);
    expect(screen.getByText(/No incident in this run's log yet/)).toBeInTheDocument();
  });
});
