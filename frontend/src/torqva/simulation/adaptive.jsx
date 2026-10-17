// Adaptive diagnostic testing with evidence sufficiency (C4, simulation). The status and every prerequisite come from the backend
// (plan.sufficiency, POST /simulation/workbench/adaptive); this module only displays them. Measured expected information gain is shown as a
// number in nats; the explanations next to it are the backend's stated reasons, not a second scoring.
import React, { useState } from 'react';
import { Compass, Play, Check, X } from 'lucide-react';
import { api } from '../api.js';
import { Card, Empty, ErrorBox, Pill, ProvBadge, fmt } from '../shared/components.jsx';
import { TrendLines } from '../shared/lazyCharts.jsx';
import { canControl } from './scenario.jsx';
import { title, pct } from './workbench.js';

export const SUFF = {
  SUFFICIENT_EVIDENCE: ['ok', 'SUFFICIENT EVIDENCE'],
  MORE_EVIDENCE_REQUIRED: ['wait', 'MORE EVIDENCE REQUIRED'],
  INVALID_INPUT: ['crit', 'INVALID INPUT'],
  TEST_NOT_SUPPORTED: ['off', 'TEST NOT SUPPORTED'],
  INCONCLUSIVE: ['warn', 'INCONCLUSIVE'],
};
const rank = (p) => (p ? p.ranked.slice(0, 2).map(([h, v]) => `${title(h)} ${pct(v, 0)}`).join(' · ') : 'no ranking');

export function SufficiencyBadge({ s }) {
  const [tone, label] = SUFF[s?.status] || ['off', 'UNKNOWN'];
  return <Pill tone={tone}>{label}</Pill>;
}

export function AdaptivePanel({ plan, role, stale, d, onDone }) {
  const s = plan?.sufficiency;
  const [budget, setBudget] = useState(3);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [run, setRun] = useState(null);
  const ctl = canControl(role);
  const hasSim = d.status?.t !== undefined && d.status?.t !== null;
  const go = async () => {
    setBusy(true); setErr(null);
    try { const r = await api.wbAdaptive(budget); setRun(r); onDone?.(); } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  return (
    <Card title="Adaptive investigation" id="c-adaptive" right={<>{s && <SufficiencyBadge s={s} />}<ProvBadge kind="SIMULATED" /></>}>
      {!s ? <Empty>{hasSim ? 'Waiting for the workbench plan.' : 'No simulation is running.'}</Empty> : (
        <>
          <p data-testid="suff-reason"><strong>Evidence now:</strong> {s.reason}.</p>
          <p className="tq-muted tq-small">{s.rule}. C1 baseline for the current speed: {s.c1_baseline_for_current_speed ? 'learned' : `not available (${title(s.c1_window_status) || 'no window'})`}.</p>
          <div className="tq-table-wrap"><table className="tq-table" data-testid="suff-tests"><caption className="tq-sr">Test prerequisites</caption>
            <thead><tr><th scope="col">Test</th><th scope="col">Distinguishes</th><th scope="col">Prerequisites</th><th scope="col">Expected gain</th></tr></thead>
            <tbody>{s.tests.map((t) => (
              <tr key={t.test}><th scope="row">{t.test} {t.eligible ? <Pill tone="ok">eligible</Pill> : <Pill tone="off">not eligible</Pill>}</th><td>{t.distinguishes}</td>
                <td><ul className="tq-prereq">{t.prerequisites.map((p) => <li key={p.check} className={p.ok ? 'ok' : 'no'}>{p.ok ? <Check size={12} aria-hidden="true" /> : <X size={12} aria-hidden="true" />} {p.check}{p.detail && !p.ok ? ` — ${p.detail}` : ''}</li>)}</ul></td>
                <td className="tq-num">{t.expected_info_gain_nats === null ? '—' : `${fmt(t.expected_info_gain_nats, 2)} nats`}</td></tr>))}</tbody></table></div>
          <div className="tq-row tq-mt">
            <label className="tq-inline">Test budget <select value={budget} onChange={(e) => setBudget(Number(e.target.value))} disabled={busy}>{[1, 2, 3].map((n) => <option key={n} value={n}>{n}</option>)}</select></label>
            <button type="button" className="tq-btn tq-primary" disabled={busy || !ctl || stale || !hasSim} onClick={go} data-testid="run-adaptive">
              <Compass size={14} aria-hidden="true" /> {busy ? 'Investigating on the simulator copy…' : 'Run adaptive investigation'}</button>
            {!ctl && <span className="tq-muted tq-small">Requires role operator or admin.</span>}
          </div>
          <p className="tq-muted tq-small">Each step picks the eligible test with the largest expected information gain, runs it on a copy of the simulated motor, updates the ranking and decides again. It stops when the gate's confidence rule is met, nothing worth running remains (less than {fmt(s.min_info_gain_nats, 2)} nats), an input fails, an outcome is unlike any learned signature, or the budget is used.</p>
        </>)}
      <ErrorBox error={err} />
      {run && <AdaptiveResult run={run} />}
    </Card>
  );
}

export function AdaptiveResult({ run }) {
  const [tone, label] = SUFF[run.status] || ['off', run.status];
  return (
    <div className="tq-mt" data-testid="adaptive-result">
      <div className={`tq-narrate tone-${tone}`}><strong>{label}</strong><span>{run.reason}.</span></div>
      <p className="tq-muted tq-small">Run {run.id}: {run.executed_on}. Ranking {rank(run.posterior_start)} → {rank(run.posterior_final)}. {run.scenario_note}.</p>
      {!run.stages.length ? <Empty>No test was run: {run.reason}.</Empty> : (
        <ol className="tq-runsteps">
          {run.stages.map((st) => (
            <li key={st.index} className={`tq-runstep is-${st.status}`} data-testid={`adaptive-stage-${st.index}`}>
              <div className="tq-runstep-head"><strong>Step {st.index + 1}: {st.selected}</strong><Pill tone={st.status === 'completed' ? 'ok' : 'crit'}>{st.status}</Pill></div>
              <p className="tq-small"><span className="tq-muted">Leading hypotheses: </span>{st.leading_hypotheses.map(([h, p]) => `${title(h)} ${pct(p, 0)}`).join(' vs ')} <span className="tq-muted">· {st.selected} distinguishes {st.distinguishes}</span></p>
              <p className="tq-small"><span className="tq-muted">Why more evidence: </span>{st.why_more_evidence}</p>
              <p className="tq-small"><span className="tq-muted">Selected: </span>{st.selection_reason} <span className="tq-muted">· needs {st.required_signals.join(', ')}</span></p>
              <ul className="tq-list tq-small">{st.alternatives.map((a) => <li key={a.test}>{a.test} not selected: {a.not_selected_because}</li>)}</ul>
              {st.observation && <p className="tq-small"><span className="tq-muted">Observed: </span>{st.observation_meaning.map((m, i) => `${m} ${fmt(st.observation[i], 3)}`).join(' · ')}</p>}
              {st.reason && <p className="tq-callout warn">{st.reason}</p>}
              <p className="tq-small"><span className="tq-muted">Ranking: </span>{rank(st.posterior_before)} → {rank(st.posterior_after)}{st.ranking_changed ? <> <Pill tone="info">top hypothesis changed</Pill></> : ''}</p>
            </li>))}
        </ol>)}
      {run.series?.length > 1 && (
        <div role="img" aria-label="Speed during the adaptive investigation" className="tq-chart">
          <TrendLines data={run.series} lines={[{ key: 'rpm', name: 'observed rpm', color: 'var(--tq-chart-ink)' }, { key: 'setpoint', name: 'target (setpoint)', color: 'var(--tq-chart-1)', dash: '4 3' }]} height={200} digits={0} unit="rpm" />
        </div>)}
      <p className="tq-chart-note">Recorded simulated windows of the copy (simulation time). Scenario ground truth: {run.scenario_truth ? title(run.scenario_truth) : 'no active fault'} — not a TORQVA diagnosis.</p>
    </div>
  );
}
