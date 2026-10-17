// Scenario Studio: configure, start and advance a run of the backend's software simulator. Every control maps to an existing route
// (POST /simulation/start with the StartSimulation fields, /simulation/step, /commands/stop); nothing here reaches hardware, and the
// simulated motor's STOP is labelled as such.
import React, { useState } from 'react';
import { Play, Pause, StopCircle, RotateCcw, StepForward, Clock } from 'lucide-react';
import { Card, Empty, ErrorBox, ProvBadge, fmt } from '../shared/components.jsx';
import { lifecycle, scenarioText, hasSimOf, title } from './pipeline.js';

// The faults the backend accepts (schemas.Hypothesis; POST /simulation/start rejects anything else).
export const FAULTS = ['imbalance', 'looseness', 'overload', 'cooling_failure', 'supply_voltage', 'sensor_fault'];
export const canControl = (role) => role === 'operator' || role === 'admin';
// StartSimulation limits and defaults (backend api.py).
const LIMITS = { setpoint: [1, 3000], inject: [0, 3600] };
const DEFAULTS = { fault: 'imbalance', severity: 0.5, transient: true, approval: false, seed: 1, setpoint: 1800, inject: 40 };

const intIn = (v, [lo, hi]) => v !== '' && Number.isInteger(Number(v)) && Number(v) >= lo && Number(v) <= hi;
const numIn = (v, [lo, hi]) => v !== '' && Number.isFinite(Number(v)) && Number(v) >= lo && Number(v) <= hi;

export function ScenarioStudio({ d, role, actions, running, setRunning, busy, error, stale, stepSeconds = 5 }) {
  const [form, setForm] = useState(DEFAULTS);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
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

  return (
    <Card title="Scenario Studio" id="c-scn" right={<ProvBadge kind="SIMULATED" />}>
      <div className="tq-motor-state-box" data-testid="sim-state">
        <div className="tq-motor-state-header">
          <span className="tq-motor-state-label">Current simulation</span>
          <strong className={`tq-motor-state-value ${life.key === 'running' ? 'running' : life.key === 'paused' || life.key === 'ready' ? 'stopped' : ''}`}>{life.label}</strong>
        </div>
        {!hasSim ? <Empty>No simulation has been started. Configure a scenario below.</Empty> : (
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

      <form className="tq-form tq-scn-form" onSubmit={(e) => { e.preventDefault(); if (!bad.length) start(); }} aria-label="Configure a new scenario">
        <p className="tq-section-title">New scenario</p>
        {!ctl && <Empty>Your role ({role}) can view but not start simulations.</Empty>}
        <div className="tq-scn-grid">
          <label>Injected fault
            <select value={form.fault} onChange={set('fault')} disabled={!ctl}>
              <option value="none">none (healthy run)</option>
              {FAULTS.map((f) => <option key={f} value={f}>{title(f)}</option>)}
            </select>
          </label>
          <label>Severity ({Number(form.severity).toFixed(2)})
            <input type="range" min="0.05" max="1" step="0.05" value={form.severity} onChange={set('severity')} disabled={!ctl || healthy} />
          </label>
          <label>Setpoint (rpm)
            <input type="number" min="1" max={LIMITS.setpoint[1]} step="any" value={form.setpoint} onChange={set('setpoint')} disabled={!ctl} />
          </label>
          <label>Inject fault at (s)
            <input type="number" min="0" max={LIMITS.inject[1]} step="1" value={form.inject} onChange={set('inject')} disabled={!ctl || healthy} />
          </label>
          <label>Seed
            <input type="number" step="1" value={form.seed} onChange={set('seed')} disabled={!ctl} />
          </label>
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
      <ErrorBox error={error} />
    </Card>
  );
}
