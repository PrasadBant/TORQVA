// Counterfactual Experiment Lab (C2, simulation): run the chosen candidates on separate copies of ONE snapshot of the live simulated motor
// (POST /simulation/workbench/counterfactual) and compare what each branch's simulator produced, next to the C2 prediction made at the start.
// Observed branch trajectories and predictions are labelled separately; metrics are the backend's, each with its stated definition.
import React, { useState } from 'react';
import { FlaskConical, RefreshCw } from 'lucide-react';
import { api } from '../api.js';
import { Card, Empty, ErrorBox, Pill, ProvBadge, fmt } from '../shared/components.jsx';
import { TrendLines } from '../shared/lazyCharts.jsx';
import { canControl } from './scenario.jsx';
import { title, fmtRpm } from './workbench.js';

const HORIZONS = [30, 60, 120, 180, 300];
const SIGNALS = [['rpm', 'Speed', 'rpm', 0], ['current', 'Current', 'A', 3], ['voltage', 'Voltage', 'V', 2], ['power', 'Power (simulator)', 'W', 1],
  ['housing', 'Housing temperature', '°C', 2], ['vib_rms', 'Vibration RMS (simulator model)', 'g', 4], ['score', 'C1 score ÷ threshold', '', 2]];
const COLORS = ['var(--tq-chart-ink)', 'var(--tq-chart-1)', 'var(--tq-chart-2)', 'var(--tq-chart-3)', 'var(--tq-chart-4)'];

/** Rows {t: seconds after the branch point, <label>: value} for one signal across all completed branches. */
export function mergeBranches(branches, key) {
  const done = branches.filter((b) => b.status === 'completed');
  const n = Math.max(0, ...done.map((b) => b.observed.length));
  return Array.from({ length: n }, (_, i) => ({ t: done[0]?.observed[i]?.dt ?? i + 1, ...Object.fromEntries(done.map((b) => [b.label, b.observed[i]?.[key] ?? null])) }));
}

export function CounterfactualLab({ targets, role, stale, hasRanking, hasSim }) {
  const [inc, setInc] = useState({ cont: true, stop: false });
  const [horizon, setHorizon] = useState(120);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [res, setRes] = useState(null);
  const [rerun, setRerun] = useState(null);
  const [sig, setSig] = useState('rpm');
  const ctl = canControl(role);
  const n = targets.length + (inc.cont ? 1 : 0) + (inc.stop ? 1 : 0);
  const run = async () => {
    setBusy(true); setErr(null); setRerun(null);
    try { setRes(await api.wbCounterfactual({ targets, include_continue: inc.cont, include_stop: inc.stop, horizon_s: horizon })); } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  const again = async () => { setErr(null); try { setRerun(await api.wbCounterfactualRerun(res.id)); } catch (e) { setErr(e); } };
  const def = SIGNALS.find((x) => x[0] === sig);
  const data = res ? mergeBranches(res.branches, sig) : [];
  const done = res ? res.branches.filter((b) => b.status === 'completed') : [];
  return (
    <Card title="Counterfactual experiment lab" id="c-cf" className="tq-mt" right={<ProvBadge kind="SIMULATED" />}>
      <p className="tq-muted">Runs each candidate on its own copy of one snapshot of the simulated motor (same state, injected fault and random stream) for the same horizon, so the outcomes can be compared fairly. The live run is not changed and no device is involved.</p>
      <div className="tq-row tq-wrap-pills">
        <span className="tq-muted tq-small">Candidates:</span>
        {targets.map((t, i) => <Pill key={t} tone="info">{`Action ${'ABC'[i]}: reduce to ${fmtRpm(t)} rpm`}</Pill>)}
        <label className="tq-check"><input type="checkbox" checked={inc.cont} onChange={(e) => setInc({ ...inc, cont: e.target.checked })} /> Continue</label>
        <label className="tq-check"><input type="checkbox" checked={inc.stop} onChange={(e) => setInc({ ...inc, stop: e.target.checked })} /> STOP (coast)</label>
        <label className="tq-inline">Horizon <select value={horizon} onChange={(e) => setHorizon(Number(e.target.value))}>{HORIZONS.map((h) => <option key={h} value={h}>{h} s</option>)}</select></label>
        <button type="button" className="tq-btn tq-primary" disabled={busy || !ctl || stale || !hasSim || n < 2} onClick={run} data-testid="run-cf">
          <FlaskConical size={14} aria-hidden="true" /> {busy ? 'Running branches…' : `Compare ${n} candidates`}</button>
      </div>
      {n < 2 && <p className="tq-muted tq-small">Choose at least two candidates (targets above, Continue or STOP).</p>}
      {!ctl && <p className="tq-muted tq-small">Running an experiment requires role operator or admin.</p>}
      <ErrorBox error={err} />
      {res && (
        <div className="tq-mt" data-testid="cf-result">
          <p className="tq-small"><strong>Experiment {res.id}</strong> <span className="tq-muted">· from t = {fmt(res.inputs.start_sim_t, 0)} s · seed {res.inputs.seed ?? '—'} · setpoint {fmtRpm(res.inputs.setpoint_rpm)} rpm · horizon {res.inputs.horizon_s} s · state digest {res.inputs.state_digest} · models: hypotheses v{res.inputs.model_versions.hypothesis_model}, C4 v{res.inputs.model_versions.c4_signatures}, C2 v{res.inputs.model_versions.c2_predictor}</span></p>
          <p className="tq-small"><span className="tq-muted">Start (SIM): </span>{fmtRpm(res.start.rpm)} rpm · {fmt(res.start.current, 2)} A · {fmt(res.start.voltage, 2)} V · {fmt(res.start.housing, 1)} °C · {fmt(res.start.vib_rms, 3)} g · injected fault: {res.start.injected_fault ? title(res.start.injected_fault) : 'none'} (ground truth){res.inputs.scheduled_injection_in_branches ? ` · the scheduled ${res.inputs.scheduled_injection_in_branches.fault} injection at t = ${res.inputs.scheduled_injection_in_branches.at} s is applied in every branch` : ''}</p>
          <div className="tq-cands">
            {res.branches.map((b) => (
              <article key={b.label} className="tq-cand" data-testid={`cf-${b.action}`}>
                <header className="tq-cand-head"><strong>{b.label}</strong><Pill tone={b.status === 'completed' ? 'ok' : 'crit'}>{b.status}</Pill></header>
                {!b.within_supervisor_envelope && <p className="tq-small tq-warn-text">Outside the Safety Supervisor's reduce envelope: an experiment only, it could not be requested.</p>}
                {b.status !== 'completed' ? <p className="tq-callout warn">{b.error}</p> : (
                  <dl className="tq-kv tq-small">
                    <dt>Final (mean of last 10 s)</dt><dd className="tq-num">{fmtRpm(b.metrics.final_mean_last_10s.rpm)} rpm · {fmt(b.metrics.final_mean_last_10s.housing, 1)} °C · {fmt(b.metrics.final_mean_last_10s.current, 2)} A</dd>
                    <dt>Maximum</dt><dd className="tq-num">{fmt(b.metrics.max.housing, 1)} °C · {fmt(b.metrics.max.current, 2)} A · {fmt(b.metrics.max.vib_rms, 3)} g</dd>
                    <dt>Seconds above a warn limit</dt><dd className="tq-num">{Object.entries(b.metrics.seconds_above_warn_limit).map(([k, v]) => `${title(k)} ${v}`).join(' · ') || '—'}</dd>
                    <dt>C1 flagged</dt><dd className="tq-num">{b.metrics.c1_flagged_fraction === null ? 'not scored' : `${fmt(b.metrics.c1_flagged_fraction * 100, 0)}% of ${b.metrics.c1_scored_windows}`}</dd>
                    <dt>Valid windows</dt><dd className="tq-num">{b.metrics.valid_windows} of {b.observed.length}</dd>
                  </dl>)}
              </article>))}
          </div>
          <div className="tq-toolbar tq-mt"><span className="tq-toolbar-label">Signal</span>
            <div className="tq-seg" role="group" aria-label="Signal to compare">{SIGNALS.map(([k, n2]) => <button key={k} type="button" className="tq-btn" aria-pressed={sig === k} onClick={() => setSig(k)}>{n2.split(' (')[0]}</button>)}</div></div>
          {data.length < 2 ? <Empty>No completed branch to chart.</Empty> : (
            <div role="img" aria-label={`${def[1]} in each branch`} className="tq-chart" data-testid="cf-chart">
              <TrendLines data={data} lines={done.map((b, i) => ({ key: b.label, name: `${b.label} (observed, SIM)`, color: COLORS[i % COLORS.length] }))} height={240} digits={def[3]} unit={def[2]} />
            </div>)}
          <p className="tq-chart-note">Seconds after the branch point. Every line is the simulator's own trajectory for that branch, recorded once per simulated second.</p>
          {sig !== 'score' && sig !== 'voltage' && sig !== 'power' && done.some((b) => b.prediction?.rows) && (
            <div className="tq-table-wrap"><table className="tq-table" data-testid="cf-pred"><caption>{def[1]}: C2 prediction made at the start vs the branch's observed simulated value</caption>
              <thead><tr><th scope="col">Branch</th><th scope="col">Horizon</th><th scope="col">Predicted (90 % interval) <ProvBadge kind="PREDICTED" /></th><th scope="col">Observed <ProvBadge kind="SIMULATED" /></th><th scope="col">Inside interval</th></tr></thead>
              <tbody>{done.flatMap((b) => (b.prediction?.rows || []).filter((r) => r.signal === sig).map((r) => (
                <tr key={`${b.label}-${r.horizon_s}`}><th scope="row">{b.label}</th><td className="tq-num">+{r.horizon_s} s</td>
                  <td className="tq-num">{fmt(r.predicted_mean, def[3])} [{fmt(r.lo, def[3])}–{fmt(r.hi, def[3])}]</td><td className="tq-num">{fmt(r.observed, def[3])}</td>
                  <td>{r.observed === null ? '—' : r.inside_interval ? 'yes' : 'no'}</td></tr>)))}</tbody></table></div>)}
          {!hasRanking && <p className="tq-muted tq-small">No C2 prediction was made: predictions need a hypothesis ranking. The observed branches are still comparable.</p>}
          <details className="tq-disclosure tq-mt"><summary>Metric definitions</summary><div className="tq-disclosure-body"><dl className="tq-kv tq-small">{Object.entries(res.metric_definitions).map(([k, v]) => <React.Fragment key={k}><dt>{title(k)}</dt><dd>{v}</dd></React.Fragment>)}
            <dt>Warn limits</dt><dd className="tq-num">{Object.entries(res.risk_limits).map(([k, v]) => `${title(k)} ${v}`).join(' · ')}</dd></dl></div></details>
          <div className="tq-row tq-mt">
            <button type="button" className="tq-btn" onClick={again} disabled={!ctl} data-testid="cf-rerun"><RefreshCw size={14} aria-hidden="true" /> Re-run from the same starting state</button>
            {rerun && <Pill tone={rerun.identical ? 'ok' : 'crit'}>{rerun.identical ? 'reproduced: every branch identical' : 'NOT identical'}</Pill>}
          </div>
          <p className="tq-muted tq-small">{res.note}</p>
        </div>)}
    </Card>
  );
}
