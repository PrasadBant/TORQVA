// Scenario Studio: configure, start and advance a run of the backend's software simulator. Every control maps to an existing route
// (POST /simulation/start with the StartSimulation fields, /simulation/step, /commands/stop); nothing here reaches hardware, and the
// simulated motor's STOP is labelled as such.
import React, { useEffect, useRef, useState } from 'react';
import { Play, Pause, StopCircle, RotateCcw, StepForward, Clock } from 'lucide-react';
import { Card, Empty, ErrorBox, ProvBadge, fmt, canControl } from '../shared/components.jsx';
import { lifecycle, scenarioText, hasSimOf, title } from './pipeline.js';

// The faults the backend accepts (schemas.Hypothesis; POST /simulation/start rejects anything else).
export const FAULTS = ['imbalance', 'looseness', 'overload', 'cooling_failure', 'supply_voltage', 'sensor_fault'];
export { canControl };
// StartSimulation limits and defaults (backend api.py).
const LIMITS = { setpoint: [1, 3000], inject: [0, 3600] };
const DEFAULTS = { fault: 'imbalance', severity: 0.5, transient: true, approval: false, seed: 1, setpoint: 1800, inject: 40 };
// Starting points for the form. A preset only fills in the fields below; nothing starts until Start new simulation is pressed.
const PRESETS = [
  ['healthy', 'Healthy baseline', 'no fault, to see normal behaviour', { ...DEFAULTS, fault: 'none' }],
  ['recoverable', 'Recoverable imbalance', 'the default: clears when speed is reduced', DEFAULTS],
  ['review', 'Analyst review', 'the pipeline holds its action for your approval', { ...DEFAULTS, approval: true }],
  ['persistent', 'Persistent overload', 'does not clear with a speed reduction', { ...DEFAULTS, fault: 'overload', severity: 0.6, transient: false }],
];

const intIn = (v, [lo, hi]) => v !== '' && Number.isInteger(Number(v)) && Number(v) >= lo && Number(v) <= hi;
const numIn = (v, [lo, hi]) => v !== '' && Number.isFinite(Number(v)) && Number(v) >= lo && Number(v) <= hi;

export function ScenarioStudio({ d, role, actions, running, setRunning, busy, error, stale, stepSeconds = 5, compact = false, go }) {
  const [form, setForm] = useState(DEFAULTS);
  const touched = useRef(false);            // the user has edited the new-scenario form
  const submitted = useRef(false);          // the user pressed Start new simulation
  const set = (k) => (e) => { touched.current = true; setForm({ ...form, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }); };
  const s = d.status || {};
  const hasSim = hasSimOf(s);
  const ctl = canControl(role);
  const life = lifecycle(d, running, stale);
  const healthy = form.fault === 'none';
  const bad = [
    !numIn(form.setpoint, LIMITS.setpoint) && `setpoint must be 1–${LIMITS.setpoint[1]} rpm`,
    !healthy && !intIn(form.inject, LIMITS.inject) && `injection time must be a whole number of seconds, 0–${LIMITS.inject[1]}`,
    !Number.isInteger(Number(form.seed)) || form.seed === '' ? 'seed must be a whole number' : null,
  ].filter(Boolean);
  const start = () => actions.start({
    fault: healthy ? null : form.fault, severity: Number(form.severity), seed: Number(form.seed),
    clears_below_rpm: !healthy && form.transient ? 1500 : null, require_human_approval: form.approval,
    setpoint_rpm: Number(form.setpoint), ...(healthy ? {} : { inject_after_s: Number(form.inject) }),
  });
  const summary = healthy
    ? `Healthy run at ${form.setpoint || '—'} rpm, seed ${form.seed || '—'}.`
    : `${title(form.fault)} at severity ${Number(form.severity).toFixed(2)}, injected at t = ${form.inject || '—'} s, ${form.transient ? 'clears below 1500 rpm' : 'persists'}; ${form.setpoint || '—'} rpm, seed ${form.seed || '—'}.`;
  const sc = s.scenario || {};
  const injected = sc.fault && Number.isFinite(s.t) && Number.isFinite(sc.inject_after_s) ? s.t >= sc.inject_after_s : null;

  // Open at first render when no run exists. When a NEW scenario actually starts (the user's own start, or the development auto-start of an
  // untouched form) it folds away; it never closes while the user is editing, and a failed start leaves it open with the error below.
  const [newOpen] = useState(() => !hasSim);
  const newRef = useRef(null);
  const scenarioKey = hasSim ? JSON.stringify(sc) : '';
  useEffect(() => {
    if (!scenarioKey || !newRef.current) return;
    if (submitted.current || !touched.current) { newRef.current.open = false; submitted.current = false; touched.current = false; }
  }, [scenarioKey]);
  return (
    <Card title="Scenario Studio" id="c-scn" right={<ProvBadge kind="SIMULATED" />}>
      <div className="tq-motor-state-box" data-testid="sim-state">
        <div className="tq-motor-state-header">
          <span className="tq-motor-state-label">Current simulation</span>
          <strong className={`tq-motor-state-value ${life.key === 'running' ? 'running' : life.key === 'paused' || life.key === 'ready' ? 'stopped' : ''}`}>{life.label}</strong>
        </div>
        {!hasSim ? <Empty>No simulation has been started. {compact ? 'Start one from Scenario Studio on the Overview.' : 'Configure a scenario below.'}</Empty> : (
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

      <div className="tq-row tq-scn-run" role="group" aria-label="Simulation time">
        <button className="tq-btn" onClick={() => setRunning(!running)} disabled={!ctl || !hasSim || stale}>
          {running ? <><Pause size={14} aria-hidden="true" /> Pause</> : <><Play size={14} aria-hidden="true" /> Run</>}
        </button>
        <button className="tq-btn" onClick={actions.step} disabled={!ctl || !hasSim || running || busy || stale || !actions.step} title={running ? 'Pause first: time is already advancing' : undefined}>
          <StepForward size={14} aria-hidden="true" /> Step {stepSeconds} s
        </button>
        <button className="tq-btn tq-danger" onClick={actions.stop} disabled={!hasSim || busy} aria-label="Stop motor (coast) in the simulator"><StopCircle size={14} aria-hidden="true" /> STOP SIMULATED MOTOR</button>
      </div>
      <p className="tq-muted tq-small">{life.detail} STOP coasts the simulated motor through the same Safety Supervisor path as every other command; it does not stop a real motor.{!ctl ? ` Your role (${role}) can press STOP only.` : ''}</p>

      {compact ? (
        <p className="tq-small tq-muted" data-testid="scn-compact">New scenarios are configured in Scenario Studio on the Overview{go ? <> · <button type="button" className="tq-linkbtn" onClick={() => go('overview')}>Open Overview</button></> : ''}.</p>
      ) : (
      <details ref={newRef} className="tq-disclosure tq-scn-new" data-testid="scn-new" open={newOpen || undefined}>
      <summary><span className="tq-disclosure-title">Configure a new scenario</span><span className="tq-disclosure-meta">{hasSim ? 'replaces the current run' : 'no simulation is running yet'}</span></summary>
      <form className="tq-form tq-scn-form tq-disclosure-body" onSubmit={(e) => { e.preventDefault(); if (!bad.length) { submitted.current = true; start(); } }} aria-label="Configure a new scenario">
        {!ctl && <Empty>Your role ({role}) can view but not start simulations.</Empty>}
        <fieldset className="tq-scn-presets" data-testid="scn-presets" disabled={!ctl}><legend>Start from a preset <span className="tq-muted">(fills the form; nothing starts yet)</span></legend>
          {PRESETS.map(([k, name, hint, v]) => (
            <button key={k} type="button" className="tq-btn tq-scn-preset" data-testid={`preset-${k}`} aria-pressed={JSON.stringify(form) === JSON.stringify(v)}
              onClick={() => { touched.current = true; setForm(v); }}><strong>{name}</strong><span className="tq-muted">{hint}</span></button>))}
        </fieldset>
        <div className="tq-scn-grid">
          <label>Injected fault
            <select value={form.fault} onChange={set('fault')} disabled={!ctl}>
              <option value="none">none (healthy run)</option>
              {FAULTS.map((f) => <option key={f} value={f}>{title(f)}</option>)}
            </select>
          </label>
          <div className="tq-scn-field"><label>Severity ({Number(form.severity).toFixed(2)})
            <input type="range" min="0.05" max="1" step="0.05" value={form.severity} onChange={set('severity')} disabled={!ctl || healthy} aria-describedby="scn-hint-sev" />
          </label><small className="tq-muted" id="scn-hint-sev">0.05 slight – 1.00 strongest the fault model produces</small></div>
          <label>Setpoint (rpm)
            <input type="number" min="1" max={LIMITS.setpoint[1]} step="any" value={form.setpoint} onChange={set('setpoint')} disabled={!ctl} />
          </label>
          <div className="tq-scn-field"><label>Inject fault at (s)
            <input type="number" min="0" max={LIMITS.inject[1]} step="1" value={form.inject} onChange={set('inject')} disabled={!ctl || healthy} aria-describedby="scn-hint-inj" />
          </label><small className="tq-muted" id="scn-hint-inj">simulation time before the fault starts, so C1 sees healthy windows first</small></div>
          <div className="tq-scn-field"><label>Seed
            <input type="number" step="1" value={form.seed} onChange={set('seed')} disabled={!ctl} aria-describedby="scn-hint-seed" />
          </label><small className="tq-muted" id="scn-hint-seed">the same seed and settings reproduce the same run</small></div>
        </div>
        <label className="tq-check"><input type="checkbox" checked={form.transient} onChange={set('transient')} disabled={!ctl || healthy} />
          Condition clears when speed is reduced (simulated transient)</label>
        <label className="tq-check"><input type="checkbox" checked={form.approval} onChange={set('approval')} disabled={!ctl} />
          Require human approval (as in hardware mode)</label>
        <p className="tq-scn-summary" data-testid="scn-summary"><Clock size={14} aria-hidden="true" /> {summary}</p>
        {bad.length > 0 && <p className="tq-callout warn" role="alert">Cannot start: {bad.join('; ')}.</p>}
        <div className="tq-row">
          <button type="submit" className="tq-btn tq-primary" disabled={!ctl || busy || bad.length > 0}><RotateCcw size={14} aria-hidden="true" /> Start new simulation</button>
          {hasSim && <span className="tq-muted tq-small">Replaces the current run; its records stay in the store but leave these pages.</span>}
        </div>
      </form>
      </details>)}
      <ErrorBox error={error} />
    </Card>
  );
}
