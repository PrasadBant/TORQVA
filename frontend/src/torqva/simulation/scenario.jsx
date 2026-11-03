// Scenario Studio: configure, start and advance a run of the backend's software simulator. Every control maps to an existing route
// (POST /simulation/start with the StartSimulation fields, /simulation/step, /commands/stop) through the shell's `actions`; nothing here reaches
// hardware, and the simulated motor's STOP is labelled as such.
// Two presentations share the same form, run controls and status: `ScenarioStudio` (a card embedded on the Overview and, `compact`, on Live
// Monitor) and `ScenarioPage` (the guided page: select, configure, parameters, review, run, inspect).
import React, { useEffect, useRef, useState } from 'react';
import { Play, Pause, StopCircle, RotateCcw, StepForward, Clock, FlaskConical, Activity, Workflow, Box, ListChecks, Gauge } from 'lucide-react';
import { Card, Empty, ErrorBox, ProvBadge, fmt, canControl, PageHead, StepTracker, SourceTag, LinkButton, Pill, Disclosure, MetricList } from '../shared/components.jsx';
import { lifecycle, scenarioText, hasSimOf, title, pipelineStages, STAGE_TONE, STAGE_WORD } from './pipeline.js';

// The faults the backend accepts (schemas.Hypothesis; POST /simulation/start rejects anything else).
export const FAULTS = ['imbalance', 'looseness', 'overload', 'cooling_failure', 'supply_voltage', 'sensor_fault'];
export { canControl };
// What the simulator changes for each fault (backend sim.py, Simulator.step), in plain words.
const FAULT_INFO = {
  imbalance: 'Mass imbalance on the rotating disc: the 1× vibration component rises, and grows with the square of the speed.',
  looseness: 'Loose mounting: vibration harmonics (2×, 3×) and broadband vibration appear.',
  overload: 'Extra load on the output: more current and drive duty, a faster coast-down and a little broadband vibration.',
  cooling_failure: 'Reduced cooling of the motor: the housing temperature climbs above its normal level.',
  supply_voltage: 'A supply-voltage fault: the bus voltage drops and the drive duty rises to hold the speed.',
  sensor_fault: 'A faulty vibration sensor: the vibration channel stops tracking the shaft speed.',
};
// StartSimulation limits and defaults (backend api.py: setpoint 0 < rpm <= 3000, inject_after_s 0..3600, seed 0..2^32 - 1).
const LIMITS = { setpoint: [1, 3000], inject: [0, 3600], seed: [0, 4294967295] };
const CLEARS_BELOW = 1500;
const DEFAULTS = { fault: 'imbalance', severity: 0.5, transient: true, approval: false, seed: 1, setpoint: 1800, inject: 40 };
// Starting points for the form. A preset only fills in the fields below; nothing starts until Start new simulation is pressed.
const PRESETS = [
  ['healthy', 'Healthy baseline', 'no fault, to see normal behaviour', { ...DEFAULTS, fault: 'none' },
    'A healthy motor at the setpoint with no injected fault. It shows the normal behaviour the anomaly detector compares against; any incident it opens is a false alarm.'],
  ['recoverable', 'Recoverable imbalance', 'the default: clears when speed is reduced', DEFAULTS,
    `Imbalance injected after a healthy start. The simulator clears it once the setpoint drops below ${CLEARS_BELOW} rpm, so a speed reduction can recover it.`],
  ['review', 'Analyst review', 'the pipeline holds its action for your approval', { ...DEFAULTS, approval: true },
    'The same recoverable imbalance, but the pipeline holds its proposed action until an analyst approves or rejects it on the Action Recommendations page.'],
  ['persistent', 'Persistent overload', 'does not clear with a speed reduction', { ...DEFAULTS, fault: 'overload', severity: 0.6, transient: false },
    'An overload that a speed reduction does not clear: recovery cannot be verified by slowing down, so the pipeline must escalate or stop.'],
];

const intIn = (v, [lo, hi]) => v !== '' && Number.isInteger(Number(v)) && Number(v) >= lo && Number(v) <= hi;
const numIn = (v, [lo, hi]) => v !== '' && Number.isFinite(Number(v)) && Number(v) >= lo && Number(v) <= hi;
const presetOf = (form) => PRESETS.find((p) => JSON.stringify(p[3]) === JSON.stringify(form)) || null;

/** The new-scenario form: values, validation and the StartSimulation body. Validation mirrors the backend limits; the backend still decides. */
function useScenarioForm() {
  const [form, setForm] = useState(DEFAULTS);
  const touched = useRef(false);            // the user has edited the new-scenario form
  const submitted = useRef(false);          // the user pressed Start new simulation
  const set = (k) => (e) => { touched.current = true; setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value })); };
  const apply = (v) => { touched.current = true; setForm(v); };
  const healthy = form.fault === 'none';
  const errors = {
    setpoint: !numIn(form.setpoint, LIMITS.setpoint) ? `Enter a speed from ${LIMITS.setpoint[0]} to ${LIMITS.setpoint[1]} rpm.` : null,
    inject: !healthy && !intIn(form.inject, LIMITS.inject) ? `Enter a whole number of seconds from 0 to ${LIMITS.inject[1]}.` : null,
    seed: !intIn(form.seed, LIMITS.seed) ? 'Enter a whole number from 0 to 4294967295.' : null,
  };
  const bad = [
    errors.setpoint && `setpoint must be 1–${LIMITS.setpoint[1]} rpm`,
    errors.inject && `injection time must be a whole number of seconds, 0–${LIMITS.inject[1]}`,
    errors.seed && 'seed must be a whole number from 0 to 4294967295',
  ].filter(Boolean);
  const body = () => ({
    fault: healthy ? null : form.fault, severity: Number(form.severity), seed: Number(form.seed),
    clears_below_rpm: !healthy && form.transient ? CLEARS_BELOW : null, require_human_approval: form.approval,
    setpoint_rpm: Number(form.setpoint), ...(healthy ? {} : { inject_after_s: Number(form.inject) }),
  });
  const summary = healthy
    ? `Healthy run at ${form.setpoint || '—'} rpm, seed ${form.seed === '' ? '—' : form.seed}.`
    : `${title(form.fault)} at severity ${Number(form.severity).toFixed(2)}, injected at t = ${form.inject === '' ? '—' : form.inject} s, ${form.transient ? `clears below ${CLEARS_BELOW} rpm` : 'persists'}; ${form.setpoint || '—'} rpm, seed ${form.seed === '' ? '—' : form.seed}.`;
  return { form, set, apply, healthy, errors, bad, body, summary, touched, submitted, preset: presetOf(form) };
}

/** Step 1: the presets. */
function PresetPicker({ f, ctl, cards = false }) {
  return (
    <fieldset className={`tq-scn-presets${cards ? ' is-cards' : ''}`} data-testid="scn-presets" disabled={!ctl}>
      <legend>Start from a preset <span className="tq-muted">(fills the form; nothing starts yet)</span></legend>
      {PRESETS.map(([k, name, hint, v]) => (
        <button key={k} type="button" className="tq-btn tq-scn-preset" data-testid={`preset-${k}`} aria-pressed={f.preset?.[0] === k}
          onClick={() => f.apply(v)}><strong>{name}</strong><span className="tq-muted">{hint}</span></button>))}
    </fieldset>
  );
}

/** Step 2: which fault (if any) the simulator injects, and how strongly. */
function FaultFields({ f, ctl }) {
  const { form, set, healthy } = f;
  return (
    <div className="tq-scn-grid">
      <div className="tq-scn-field"><label>Injected fault
        <select value={form.fault} onChange={set('fault')} disabled={!ctl} aria-describedby="scn-hint-fault">
          <option value="none">none (healthy run)</option>
          {FAULTS.map((x) => <option key={x} value={x}>{title(x)}</option>)}
        </select>
      </label><small className="tq-muted" id="scn-hint-fault">{healthy ? 'No fault: the simulator runs a healthy motor.' : FAULT_INFO[form.fault]}</small></div>
      <div className="tq-scn-field"><label>Severity ({Number(form.severity).toFixed(2)})
        <input type="range" min="0.05" max="1" step="0.05" value={form.severity} onChange={set('severity')} disabled={!ctl || healthy} aria-describedby="scn-hint-sev" />
      </label><small className="tq-muted" id="scn-hint-sev">{healthy ? 'Not used for a healthy run.' : '0.05 slight – 1.00 strongest the fault model produces'}</small></div>
    </div>
  );
}

const FieldError = ({ id, msg }) => (msg ? <small className="tq-scn-err" id={id}>{msg}</small> : null);

/** Step 3: run parameters. Only fields the backend uses; each says what it does. */
function ParamFields({ f, ctl }) {
  const { form, set, healthy, errors } = f;
  return (
    <>
      <div className="tq-scn-grid">
        <div className="tq-scn-field"><label>Setpoint (rpm)
          <input type="number" min="1" max={LIMITS.setpoint[1]} step="any" value={form.setpoint} onChange={set('setpoint')} disabled={!ctl}
            aria-invalid={!!errors.setpoint} aria-describedby={errors.setpoint ? 'scn-err-sp scn-hint-sp' : 'scn-hint-sp'} />
        </label><FieldError id="scn-err-sp" msg={errors.setpoint} /><small className="tq-muted" id="scn-hint-sp">target speed the simulated controller holds (1–3000)</small></div>
        <div className="tq-scn-field"><label>Inject fault at (s)
          <input type="number" min="0" max={LIMITS.inject[1]} step="1" value={form.inject} onChange={set('inject')} disabled={!ctl || healthy}
            aria-invalid={!!errors.inject} aria-describedby={errors.inject ? 'scn-err-inj scn-hint-inj' : 'scn-hint-inj'} />
        </label><FieldError id="scn-err-inj" msg={errors.inject} /><small className="tq-muted" id="scn-hint-inj">{healthy ? 'Not used for a healthy run.' : 'simulation time before the fault starts, so Anomaly Detection sees healthy windows first'}</small></div>
        <div className="tq-scn-field"><label>Seed
          <input type="number" min="0" step="1" value={form.seed} onChange={set('seed')} disabled={!ctl}
            aria-invalid={!!errors.seed} aria-describedby={errors.seed ? 'scn-err-seed scn-hint-seed' : 'scn-hint-seed'} />
        </label><FieldError id="scn-err-seed" msg={errors.seed} /><small className="tq-muted" id="scn-hint-seed">the same seed and settings reproduce the same run</small></div>
      </div>
      <label className="tq-check"><input type="checkbox" checked={form.transient} onChange={set('transient')} disabled={!ctl || healthy} />
        <span>Condition clears when speed is reduced (simulated transient)<small className="tq-muted tq-scn-checkhint">The simulator removes the fault once the setpoint drops below {CLEARS_BELOW} rpm.</small></span></label>
      <label className="tq-check"><input type="checkbox" checked={form.approval} onChange={set('approval')} disabled={!ctl} />
        <span>Require human approval (as in hardware mode)<small className="tq-muted tq-scn-checkhint">The pipeline holds its proposed action until an analyst approves or rejects it.</small></span></label>
    </>
  );
}

/** The current simulation as the backend reports it. */
function SimState({ d, life, compact }) {
  const s = d.status || {};
  const hasSim = hasSimOf(s);
  const sc = s.scenario || {};
  const injected = sc.fault && Number.isFinite(s.t) && Number.isFinite(sc.inject_after_s) ? s.t >= sc.inject_after_s : null;
  return (
    <div className="tq-motor-state-box" data-testid="sim-state">
      <div className="tq-motor-state-header">
        <span className="tq-motor-state-label">Current simulation</span>
        <strong className={`tq-motor-state-value ${life.key === 'running' ? 'running' : life.key === 'paused' || life.key === 'ready' ? 'stopped' : ''}`}>{life.label}</strong>
      </div>
      {!hasSim ? <Empty>No simulation has been started. {compact ? 'Start one in Scenario Studio.' : 'Configure a scenario and start it.'}</Empty> : (
        <div className="tq-motor-state-grid">
          <div className="tq-motor-state-item"><span className="tq-muted">Simulation time</span><strong className="tq-num">{fmt(s.t, 0)} s</strong></div>
          <div className="tq-motor-state-item"><span className="tq-muted">Scenario</span><strong>{scenarioText(sc)}</strong></div>
          <div className="tq-motor-state-item"><span className="tq-muted">Fault injection</span>
            <span>{!sc.fault ? 'none scheduled' : injected ? `injected from t = ${sc.inject_after_s} s` : `scheduled at t = ${sc.inject_after_s} s`}</span></div>
          <div className="tq-motor-state-item"><span className="tq-muted">Setpoint (simulated)</span><strong className="tq-num">{fmt(s.device?.setpoint_rpm, 0)} rpm</strong></div>
          <div className="tq-motor-state-item"><span className="tq-muted">Seed</span><span className="tq-num">{sc.seed ?? '—'}</span></div>
          <div className="tq-motor-state-item"><span className="tq-muted">Human approval</span><span>{sc.human_approval_required ? 'required' : 'automatic in simulation'}</span></div>
        </div>)}
    </div>
  );
}

/** Advance or pause simulation time, step it, and the simulated motor's STOP (available to every role, like every STOP). */
function RunControls({ d, role, actions, running, setRunning, busy, stale, stepSeconds, life }) {
  const hasSim = hasSimOf(d.status || {});
  const ctl = canControl(role);
  return (
    <>
      <div className="tq-row tq-scn-run" role="group" aria-label="Simulation time">
        <button type="button" className="tq-btn" onClick={() => setRunning(!running)} disabled={!ctl || !hasSim || stale}>
          {running ? <><Pause size={14} aria-hidden="true" /> Pause</> : <><Play size={14} aria-hidden="true" /> Run</>}
        </button>
        <button type="button" className="tq-btn" onClick={actions.step} disabled={!ctl || !hasSim || running || busy || stale || !actions.step} title={running ? 'Pause first: time is already advancing' : undefined}>
          <StepForward size={14} aria-hidden="true" /> Step {stepSeconds} s
        </button>
        <button type="button" className="tq-btn tq-danger" onClick={actions.stop} disabled={!hasSim || busy} aria-label="Stop motor (coast) in the simulator"><StopCircle size={14} aria-hidden="true" /> STOP SIMULATED MOTOR</button>
      </div>
      <p className="tq-muted tq-small">{life.detail} STOP stops the simulated motor only.{!ctl ? ` Your role (${role}) can press STOP only.` : ''}</p>
    </>
  );
}

/** Fold the new-scenario disclosure once a NEW scenario actually starts (the user's own start, or the development auto-start of an untouched
 *  form); never while the user is editing. Returns { launched, start }: launched is true only after the backend accepted this form's start. */
function useLaunch(f, d, onLaunch) {
  const s = d.status || {};
  const scenarioKey = hasSimOf(s) ? JSON.stringify(s.scenario || {}) : '';
  const [launched, setLaunched] = useState(false);
  useEffect(() => {
    if (scenarioKey && !f.submitted.current && !f.touched.current) onLaunch?.();
  }, [scenarioKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (f.touched.current) setLaunched(false); }, [f.form]); // eslint-disable-line react-hooks/exhaustive-deps
  // `pending` is the shell action's promise: it resolves true only when the backend accepted POST /simulation/start, and every accepted start
  // creates a new simulator session even with identical settings. A refused start leaves the form open with the backend's error.
  const start = async (pending) => {
    f.submitted.current = true;
    setLaunched(false);
    const ok = await pending;
    f.submitted.current = false;
    if (ok === true) { setLaunched(true); f.touched.current = false; onLaunch?.(); }
  };
  return { launched, start };
}

export function ScenarioStudio({ d, role, actions, running, setRunning, busy, error, stale, stepSeconds = 5, compact = false, go }) {
  const f = useScenarioForm();
  const s = d.status || {};
  const hasSim = hasSimOf(s);
  const ctl = canControl(role);
  const life = lifecycle(d, running, stale);
  // Open at first render when no run exists; folds when a new scenario starts (see useLaunch); a failed start leaves it open with the error below.
  const [newOpen] = useState(() => !hasSim);
  const newRef = useRef(null);
  const launch = useLaunch(f, d, () => { if (newRef.current) newRef.current.open = false; });
  const submit = (e) => { e.preventDefault(); if (!f.bad.length) launch.start(actions.start(f.body())); };
  return (
    <Card title="Scenario Studio" id="c-scn" right={<ProvBadge kind="SIMULATED" />}>
      <SimState d={d} life={life} compact={compact} />
      <RunControls d={d} role={role} actions={actions} running={running} setRunning={setRunning} busy={busy} stale={stale} stepSeconds={stepSeconds} life={life} />

      {compact ? (
        <p className="tq-small tq-muted" data-testid="scn-compact">New scenarios are configured in Scenario Studio{go ? <> · <button type="button" className="tq-linkbtn" onClick={() => go('scenario')}>Open Scenario Studio</button></> : ''}.</p>
      ) : (
      <details ref={newRef} className="tq-disclosure tq-scn-new" data-testid="scn-new" open={newOpen || undefined}>
      <summary><span className="tq-disclosure-title">Configure a new scenario</span><span className="tq-disclosure-meta">{hasSim ? 'replaces the current run' : 'no simulation is running yet'}</span></summary>
      <form className="tq-form tq-scn-form tq-disclosure-body" onSubmit={submit} aria-label="Configure a new scenario">
        {!ctl && <Empty>Your role ({role}) can view but not start simulations.</Empty>}
        <PresetPicker f={f} ctl={ctl} />
        <FaultFields f={f} ctl={ctl} />
        <ParamFields f={f} ctl={ctl} />
        <p className="tq-scn-summary" data-testid="scn-summary"><Clock size={14} aria-hidden="true" /> {f.summary}</p>
        {f.bad.length > 0 && <p className="tq-callout warn" role="alert">Cannot start: {f.bad.join('; ')}.</p>}
        <div className="tq-row">
          <button type="submit" className="tq-btn tq-primary" disabled={!ctl || busy || f.bad.length > 0}><RotateCcw size={14} aria-hidden="true" /> Start new simulation</button>
          {hasSim && <span className="tq-muted tq-small">Replaces the current run; its records stay in the store but leave these pages.</span>}
          {go && <LinkButton onClick={() => go('scenario')}>Guided setup in Scenario Studio</LinkButton>}
        </div>
      </form>
      </details>)}
      <ErrorBox error={error} />
    </Card>
  );
}

// ------------------------------------------------------------------------------------------------ Scenario Studio page (guided workflow)

const cap = (x) => (x ? x[0].toUpperCase() + x.slice(1) : x);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
// The run's result in the order an analyst asks about it, each line the pipeline's own stage summary (pipelineStages); trends live in Live Monitor.
const RESULT_ROWS = [['c1', 'Detected anomaly'], ['hyp', 'Likely cause'], ['c2', 'Predicted outcome'], ['c3', 'Recommended action'], ['c5', 'After the action']];

/** What happened in this run: latest simulated readings, then detection → cause → prediction → recommendation → outcome. */
function RunResults({ d, stale, go }) {
  const s = d.status || {}; const w = s.last_window;
  const ok = hasSimOf(s) && w && w.valid !== false && !stale;
  const v = (x, dg) => (ok && finite(x) ? fmt(x, dg) : null);
  const { stages } = pipelineStages(d);
  const by = Object.fromEntries(stages.map((x) => [x.key, x]));
  return (
    <Card title="Run results" id="scn-res-h" icon={ListChecks} testid="scn-results" right={<ProvBadge kind="SIMULATED" />}
      foot={go ? <LinkButton onClick={() => go('live')} testid="scn-go-live">Trends in Live Monitor</LinkButton> : null}>
      <MetricList label="Latest simulated readings" testid="scn-readings" items={[
        { key: 'rpm', label: 'Speed', value: v(w?.rpm, 0), unit: 'rpm' },
        { key: 'cur', label: 'Current', value: v(w?.current, 2), unit: 'A' },
        { key: 'hous', label: 'Housing temperature', value: v(w?.housing, 1), unit: '°C' },
        { key: 'vib', label: 'Vibration RMS', value: v(w?.vib_rms, 3), unit: 'g' },
      ].map((m) => ({ ...m, prov: 'SIMULATED', missingText: 'UNAVAILABLE' }))} />
      <dl className="tq-scn-review tq-mt" data-testid="scn-outcome">
        {RESULT_ROWS.map(([k, label]) => by[k] && (
          <div key={k}><dt>{label}</dt><dd><Pill tone={STAGE_TONE[by[k].state]}>{STAGE_WORD[by[k].state]}</Pill> {by[k].summary}</dd></div>))}
      </dl>
    </Card>
  );
}

/** Plain-language description of the run the backend reports, and where to follow it. */
function RunDescription({ d, go }) {
  const s = d.status || {};
  const sc = s.scenario || {};
  if (!hasSimOf(s)) return <Empty>No simulation has been started yet. Configure one on the left; step 4 describes it before you start it.</Empty>;
  const injected = sc.fault && finite(s.t) && finite(sc.inject_after_s) ? s.t >= sc.inject_after_s : null;
  return (
    <div className="tq-scn-desc" data-testid="scn-description">
      <p>{!sc.fault ? 'Healthy run: no fault is scheduled. The simulator runs a healthy motor at the setpoint.'
        : <>{cap(title(sc.fault))} at severity {fmt(sc.severity, 2)}, {injected ? 'injected' : 'scheduled'} at t = {sc.inject_after_s} s. {FAULT_INFO[sc.fault] || ''}</>}</p>
      <ul className="tq-scn-facts">
        {sc.fault && <li>{sc.clears_below_rpm ? `Clears once the setpoint drops below ${sc.clears_below_rpm} rpm (simulated transient).` : 'Persists: a speed reduction does not clear it.'}</li>}
        <li>{sc.human_approval_required ? 'Proposed actions wait for an analyst decision on the Action Recommendations page.' : 'Proposed actions are applied without an approval step (simulation only).'}</li>
        <li>Seed {sc.seed ?? '—'}: the same seed and settings reproduce this run.</li>
      </ul>
      {go && (
        <div className="tq-scn-links">
          <LinkButton onClick={() => go('workflow')} testid="scn-go-workflow">Follow it in the Diagnostic Workflow</LinkButton>
          <LinkButton onClick={() => go('twin')} testid="scn-go-twin">See it on the Digital Twin</LinkButton>
        </div>)}
    </div>
  );
}

const StepHead = ({ n, id, children, sub }) => (
  <div className="tq-scn-stephead"><span className="tq-scn-num" aria-hidden="true">{n}</span><div><h4 id={id}><span className="tq-sr">Step {n}: </span>{children}</h4>{sub && <p className="tq-muted">{sub}</p>}</div></div>
);

/** The Scenario Studio page (simulation mode): a guided workflow over the same form, routes and controls as the card. */
export function ScenarioPage({ d, role, actions, running, setRunning, busy, error, stale, stepSeconds = 5, go }) {
  const f = useScenarioForm();
  const s = d.status || {};
  const hasSim = hasSimOf(s);
  const ctl = canControl(role);
  const life = lifecycle(d, running, stale);
  const { launched, start: launchStart } = useLaunch(f, d);
  const submit = (e) => { e.preventDefault(); if (!f.bad.length && ctl && !busy) launchStart(actions.start(f.body())); };
  const nErr = Object.values(f.errors).filter(Boolean).length;
  const steps = [
    { key: 'scn-s1', label: 'Select a scenario', state: f.preset ? 'done' : 'skipped', sub: f.preset ? f.preset[1] : 'custom settings' },
    { key: 'scn-s2', label: 'Fault injection', state: 'done', sub: f.healthy ? 'no fault' : `${title(f.form.fault)} · ${Number(f.form.severity).toFixed(2)}` },
    { key: 'scn-s3', label: 'Parameters', state: nErr ? 'failed' : 'done', sub: nErr ? `${nErr} field${nErr > 1 ? 's' : ''} to fix` : `${f.form.setpoint} rpm · seed ${f.form.seed}` },
    { key: 'scn-s4', label: 'Review', state: f.bad.length ? 'blocked' : 'done', sub: f.bad.length ? 'cannot start yet' : 'configuration valid' },
    { key: 'scn-s5', label: 'Run', state: !ctl ? 'blocked' : busy ? 'active' : launched ? 'done' : 'waiting', sub: !ctl ? `role ${role} cannot start` : busy ? 'starting…' : launched ? 'started' : 'ready to start' },
    { key: 'scn-s6', label: 'Inspect results', state: hasSim ? (life.key === 'running' ? 'active' : 'waiting') : 'pending', sub: hasSim ? life.label : 'no run yet' },
  ];
  const jump = (id) => { try { document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch { /* not supported */ } };
  const desc = f.preset && JSON.stringify(f.preset[3]) === JSON.stringify(f.form) ? f.preset[4]
    : f.healthy ? 'A healthy run at the chosen setpoint with no injected fault.' : `${title(f.form.fault)}: ${FAULT_INFO[f.form.fault]}`;
  return (
    <div className="tq-scn-page" data-testid="scenario-page">
      <PageHead title="Scenario Studio" sub="Configure, run and review simulated fault scenarios."
        right={<SourceTag kind="SIMULATED" />} />
      <p className="tq-scn-simnote" role="note"><FlaskConical size={15} aria-hidden="true" /><span><strong>SIMULATED.</strong> Every control and value here belongs to the software simulator. No physical motor is connected or commanded.</span></p>
      <StepTracker steps={steps} label="Scenario workflow" onSelect={jump} testid="scn-steps" />
      <div className="tq-scn-layout">
        <Card title="Scenario configuration" id="scn-cfg-h" icon={ListChecks} className="tq-scn-config" sub={hasSim ? 'Starting a new scenario replaces the current run.' : 'No simulation is running yet.'}>
          <form className="tq-form tq-scn-form" onSubmit={submit} aria-label="Configure a new scenario">
            {!ctl && <p className="tq-callout info" role="note">Your role ({role}) can view but not start simulations. STOP stays available.</p>}
            <section className="tq-scn-step" id="scn-s1" aria-labelledby="scn-s1-h">
              <StepHead n={1} id="scn-s1-h" sub="A preset fills in the next steps.">Select a scenario</StepHead>
              <PresetPicker f={f} ctl={ctl} cards />
            </section>
            <section className="tq-scn-step" id="scn-s2" aria-labelledby="scn-s2-h">
              <StepHead n={2} id="scn-s2-h" sub="Optional. Only faults the simulator accepts are listed.">Configure fault injection</StepHead>
              <FaultFields f={f} ctl={ctl} />
            </section>
            <section className="tq-scn-step" id="scn-s3" aria-labelledby="scn-s3-h">
              <StepHead n={3} id="scn-s3-h" sub={null}>Parameters</StepHead>
              <ParamFields f={f} ctl={ctl} />
            </section>
            <section className="tq-scn-step" id="scn-s4" aria-labelledby="scn-s4-h">
              <StepHead n={4} id="scn-s4-h">Review the configuration</StepHead>
              <dl className="tq-scn-review" data-testid="scn-review">
                <div><dt>Scenario</dt><dd>{f.preset ? f.preset[1] : 'Custom'}</dd></div>
                <div><dt>Fault</dt><dd>{f.healthy ? 'none (healthy run)' : `${title(f.form.fault)}, severity ${Number(f.form.severity).toFixed(2)}`}</dd></div>
                <div><dt>Injected at</dt><dd className="tq-num">{f.healthy ? '—' : `t = ${f.form.inject === '' ? '—' : f.form.inject} s`}</dd></div>
                <div><dt>Clears</dt><dd>{f.healthy ? '—' : f.form.transient ? `below ${CLEARS_BELOW} rpm` : 'never (persists)'}</dd></div>
                <div><dt>Setpoint</dt><dd className="tq-num">{f.form.setpoint === '' ? '—' : `${f.form.setpoint} rpm`}</dd></div>
                <div><dt>Seed</dt><dd className="tq-num">{f.form.seed === '' ? '—' : f.form.seed}</dd></div>
                <div><dt>Approval</dt><dd>{f.form.approval ? 'required before each action' : 'automatic (simulation)'}</dd></div>
              </dl>
              <p className="tq-scn-summary" data-testid="scn-summary"><Clock size={14} aria-hidden="true" /> {desc}</p>
              {f.bad.length > 0 && <p className="tq-callout warn" role="alert">Cannot start: {f.bad.join('; ')}.</p>}
            </section>
            <section className="tq-scn-step tq-scn-step-run" id="scn-s5" aria-labelledby="scn-s5-h">
              <StepHead n={5} id="scn-s5-h" sub="The new run starts paused at t = 0 s.">Run</StepHead>
              <div className="tq-row">
                <button type="submit" className="tq-btn tq-primary tq-scn-start" disabled={!ctl || busy || f.bad.length > 0}><RotateCcw size={14} aria-hidden="true" /> Start new simulation</button>
                {launched && !busy && <Pill tone="ok">Started. Press Run under Simulation status to advance time.</Pill>}
              </div>
              {hasSim && <p className="tq-muted tq-small">Replaces the current run; its records stay in the store but leave these pages.</p>}
              <ErrorBox error={error} />
            </section>
          </form>
        </Card>
        <div className="tq-scn-results" id="scn-s6">
          <Card title="Simulation status" id="scn-status-h" icon={Gauge} right={<ProvBadge kind="SIMULATED" />} testid="scn-status" sub={<><span className="tq-sr">Step 6: inspect results. </span>As the backend reports it</>}>
            <SimState d={d} life={life} />
            <RunControls d={d} role={role} actions={actions} running={running} setRunning={setRunning} busy={busy} stale={stale} stepSeconds={stepSeconds} life={life} />
          </Card>
          <RunResults d={d} stale={stale} go={go} />
          <Card title="Scenario description" id="scn-desc-h" icon={Activity}>
            <RunDescription d={d} go={go} />
          </Card>
          <Disclosure summary="What happens next" meta="how a run moves through the pipeline">
            <ul className="tq-scn-facts">
              <li><Workflow size={13} aria-hidden="true" /> Anomaly Detection scores each simulated window; a persistent anomaly opens an incident that the Diagnostic Workflow follows through tests, prediction and decision.</li>
              <li><Box size={13} aria-hidden="true" /> The Digital Twin shows the simulated readings on the rig model and, after injection, the part the scenario&apos;s fault applies to.</li>
              <li><FlaskConical size={13} aria-hidden="true" /> For blind, recorded and repeatable runs, use the Lab.</li>
            </ul>
          </Disclosure>
        </div>
      </div>
    </div>
  );
}
