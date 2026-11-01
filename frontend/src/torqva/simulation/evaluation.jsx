// Evaluation (simulation artifacts only): the latest committed evaluation run (GET /evaluation/latest) and the C2/C4 study
// (GET /evaluation/c2c4). Every number is read from those files; a metric a run does not contain reads "unavailable", never blank or zero.
import React, { useState } from 'react';
import { FlaskConical, Activity, Brain, LineChart, ShieldCheck, Target, GitCompare, AlertTriangle, FileText, Layers, Sigma } from 'lucide-react';
import { Card, Empty, Pill, ProvBadge, fmt, Disclosure, AlertPanel, StatGrid, StatTile, Tabs, TabPanel, MetricList } from '../shared/components.jsx';
import { C2C4Validation } from './c2c4.jsx';

const pct = (v, d = 1) => (v === null || v === undefined || Number.isNaN(v) ? 'unavailable' : `${fmt(v * 100, d)}%`);
const get = (o, path) => path.split('.').reduce((a, k) => (a === null || a === undefined ? undefined : a[k]), o);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const label = (k) => String(k).replaceAll('_', ' ');

/** Headline metrics of the run, each with what it means. A metric the run does not contain reads "unavailable" (older runs predate some sections). */
function Headline({ r }) {
  const cov = (k) => num(get(r, `c2.${k}`));
  const far = num(get(r, 'c1.healthy.c1.window_false_alarm_rate'));
  const top1 = num(get(r, 'hypotheses.top1_accuracy'));
  const fc = num(get(r, 'hypotheses.false_confident_rate'));
  const val = get(r, 'c2.validated_by_intervention_experiments');
  const c5n = get(r, 'c5.cases');
  const fr = get(r, 'c5.FALSE_RECOVERY_DECLARATIONS');
  return (
    <div data-testid="eval-headline"><StatGrid label="Headline simulation results">
      <StatTile icon={Activity} tone={far === undefined ? 'off' : 'info'} label="C1 false-alarm rate (healthy windows)" value={pct(far, 2)}
        sub="Share of healthy simulated windows C1 wrongly flagged as anomalous. Lower is better." />
      <StatTile icon={Brain} tone={top1 === undefined ? 'off' : 'info'} label="Hypothesis top-1 accuracy" value={pct(top1)}
        sub={`How often the top-ranked fault was the injected one. Random guessing: ${pct(num(get(r, 'hypotheses.random_baseline')), 0)}.`} />
      <StatTile icon={AlertTriangle} tone={fc === undefined ? 'off' : 'info'} label="False-confident hypothesis rate" value={pct(fc)}
        sub="Share of confident diagnoses that named the wrong fault. Lower is better." />
      <StatTile icon={LineChart} tone={cov('coverage_mean') === undefined ? 'off' : 'info'} label="C2 interval coverage, mean / worst" value={`${pct(cov('coverage_mean'), 0)} / ${pct(cov('coverage_min'), 0)}`}
        sub={`Share of later values inside the 90 % prediction interval (target ${pct(cov('coverage_target'), 0)}), as measured in this run.`} />
      <StatTile icon={Target} tone={val === undefined ? 'off' : val ? 'ok' : 'warn'} label="C2 validated by intervention experiments" value={val === undefined ? 'unavailable' : val ? 'yes' : 'no'}
        sub="Whether C2 predictions were checked against the outcomes of real interventions." />
      <StatTile icon={ShieldCheck} tone={c5n === undefined ? 'off' : 'info'} label="False recovery declarations (C5)" value={c5n === undefined ? 'unavailable' : `${fr} of ${c5n} cases`}
        sub="Times C5 declared recovery while the fault was still present." />
    </StatGrid></div>
  );
}

/** Baselines versus the shipped components, only where the run recorded both sides. */
function Comparisons({ r }) {
  const healthy = Object.entries(get(r, 'c1.healthy') || {});
  const mae = Object.entries(get(r, 'c2.mae') || {});
  const c5 = get(r, 'c5');
  const conf = get(r, 'hypotheses.confusion');
  const det = Object.entries(get(r, 'c1.detection') || {});
  const detNames = det.length ? Object.keys(det[0][1]) : [];
  return (
    <div className="tq-grid tq-grid-wide tq-mt">
      <Card title="C1 detector versus baselines" id="c-ev-c1" icon={GitCompare} sub="Healthy simulated windows; c1 is the shipped detector" right={<ProvBadge kind="SIMULATED" />}>
        {!healthy.length ? <Empty>This run has no C1 healthy-window comparison.</Empty> : (
          <div className="tq-table-wrap"><table className="tq-table"><caption className="tq-sr">C1 false alarms on healthy windows</caption>
            <thead><tr><th scope="col">Detector</th><th scope="col" className="tq-th-num">False alarms</th><th scope="col" className="tq-th-num">False incidents</th><th scope="col" className="tq-th-num">Windows</th></tr></thead>
            <tbody>{healthy.map(([k, v]) => (<tr key={k} className={k === 'c1' ? 'tq-as-active-row' : undefined}><th scope="row">{k}{k === 'c1' && <> <Pill tone="info">shipped</Pill></>}</th>
              <td className="tq-num tq-td-num">{pct(num(v?.window_false_alarm_rate), 3)}</td><td className="tq-num tq-td-num">{v?.confirmed_false_incidents ?? 'unavailable'}</td><td className="tq-num tq-td-num">{v?.windows ?? 'unavailable'}</td></tr>))}</tbody></table></div>)}
        {det.length > 0 && (
          <Disclosure summary="Detection by fault and severity" meta={`${det.length} fault × severity cells`} testid="eval-detection" className="tq-mt">
            <div className="tq-table-wrap"><table className="tq-table"><caption className="tq-sr">Detected fraction and median delay by fault and severity</caption>
              <thead><tr><th scope="col">Fault @ severity</th>{detNames.map((n) => <th key={n} scope="col" className="tq-th-num">{n}: detected · delay</th>)}</tr></thead>
              <tbody>{det.map(([cell, v]) => (<tr key={cell}><th scope="row">{label(cell)}</th>{detNames.map((n) => (
                <td key={n} className="tq-num tq-td-num">{pct(num(v?.[n]?.detected_fraction), 0)} · {num(v?.[n]?.median_delay_s) === undefined ? '—' : `${fmt(v[n].median_delay_s, 0)} s`}</td>))}</tr>))}</tbody></table></div>
          </Disclosure>)}
      </Card>

      <Card title="C2 model versus persistence" id="c-ev-c2" icon={Sigma} sub="Mean absolute error over the first 120 s; persistence assumes nothing changes" right={<ProvBadge kind="SIMULATED" />}>
        {!mae.length ? <Empty>This run has no C2 error comparison.</Empty> : (
          <div className="tq-table-wrap"><table className="tq-table"><caption className="tq-sr">C2 mean absolute error, model versus persistence baseline</caption>
            <thead><tr><th scope="col">Action / signal</th><th scope="col" className="tq-th-num">C2 model</th><th scope="col" className="tq-th-num">Persistence</th><th scope="col">Lower error</th></tr></thead>
            <tbody>{mae.map(([k, v]) => { const m = num(v?.model); const p = num(v?.persistence); const tie = m !== undefined && p !== undefined && Math.abs(m - p) <= 1e-9 * Math.max(1, Math.abs(p)); return (
              <tr key={k}><th scope="row">{label(k).replace('/', ' · ')}</th><td className="tq-num tq-td-num">{m === undefined ? 'unavailable' : fmt(m, 3)}</td><td className="tq-num tq-td-num">{p === undefined ? 'unavailable' : fmt(p, 3)}</td>
                <td>{m === undefined || p === undefined ? '—' : tie ? 'equal' : m < p ? 'model' : 'persistence'}</td></tr>); })}</tbody></table></div>)}
      </Card>

      <Card title="C5 recovery verdicts" id="c-ev-c5" icon={ShieldCheck} sub="Simulated cases with a known ground truth" right={<ProvBadge kind="SIMULATED" />}>
        {!c5 || c5.cases === undefined ? <Empty>This run has no C5 section.</Empty> : (
          <MetricList label="C5 recovery verdicts" items={[
            { key: 'cases', label: 'Cases', value: c5.cases },
            { key: 'true', label: 'Recoveries correctly declared', value: c5.true_recoveries_declared, missingText: 'unavailable' },
            { key: 'nonrec', label: 'Non-recoveries correctly withheld', value: c5.correct_non_recoveries, missingText: 'unavailable' },
            { key: 'missed', label: 'Recoveries missed', value: c5.missed_recoveries, missingText: 'unavailable' },
            { key: 'false', label: 'False recovery declarations', value: c5.FALSE_RECOVERY_DECLARATIONS, missingText: 'unavailable' },
          ]} />)}
      </Card>

      <Card title="Hypothesis confusion" id="c-ev-conf" icon={Brain} sub="Rows: injected fault · columns: top-ranked hypothesis" right={<ProvBadge kind="SIMULATED" />}>
        {!conf?.order || !conf?.matrix ? <Empty>This run has no confusion matrix.</Empty> : (
          <div className="tq-table-wrap"><table className="tq-table tq-as-matrix"><caption className="tq-sr">Hypothesis confusion matrix</caption>
            <thead><tr><th scope="col">Injected</th>{conf.order.map((h) => <th key={h} scope="col" className="tq-th-num" title={label(h)}>{label(h)}</th>)}</tr></thead>
            <tbody>{conf.matrix.map((row, i) => (<tr key={conf.order[i]}><th scope="row">{label(conf.order[i])}</th>{row.map((n, j) => (
              <td key={j} className={`tq-num tq-td-num ${i === j ? 'is-diag' : n ? 'is-off' : ''}`.trim()}>{n}</td>))}</tr>))}</tbody></table></div>)}
      </Card>
    </div>
  );
}

function Limitations({ r }) {
  return (
    <Card title="Limitations" id="c-ev-lim" icon={AlertTriangle} className="tq-mt" right={<ProvBadge kind="SIMULATED" />}>
      <ul className="tq-as-bullets">
        <li>Measured hardware data: <strong>{get(r, 'measured.status') ?? 'unavailable'}</strong></li>
        {r.test_protocol && <li>Test protocol: {r.test_protocol}.</li>}
        <li>This run measured the conformal quantile only. The Phase 10 table (C2 / C4 validation) measures the intervals the predictor actually returns, which cover less.</li>
      </ul>
    </Card>
  );
}

const V_LABEL = { shipped: 'shipped C2', phase10_noise_aware: 'Phase 10 noise-aware', class_conditional: 'class-conditional (Phase 11, opt-in)', 'regime_gated(trend+class, fallback=phase10)': 'regime-gated (opt-in)' };
const C4_LABEL = { shipped: 'shipped C4', style_aware: 'style-aware (Phase 10)', 'style_aware+guard(Phase10)': 'conflict-guarded (Phase 10)' };

/** Phase 12 fresh-seed confirmation of the frozen Phase 11 decisions. Shows worst subgroups and abstention, not just averages. */
function Phase12Card({ p }) {
  if (!p) return <Card title="Phase 12 generalization check (fresh seeds)" id="c-p12" right={<ProvBadge kind="SIMULATED" />}><Empty>The C2/C4 study file has no Phase 12 result.</Empty></Card>;
  const regs = Object.keys(p.c2.shipped?.by_regime || {});
  const c2v = Object.keys(V_LABEL).filter((k) => p.c2[k]);
  const c4n = Object.keys(p.c4);
  return (
    <Card title="Phase 12 generalization check (fresh seeds)" id="c-p12" icon={Layers} right={<ProvBadge kind="SIMULATED" />}>
      <p className="tq-warnbox" role="note">{p.WARNING}</p>
      <MetricList label="Phase 12 summary" items={[
        { key: 'adopt', label: 'C4 calibration adopted', value: p.c4_adopt ? 'yes' : 'no' },
        { key: 'n2', label: 'C2 cases', value: p.n_c2_cases },
        { key: 'n4', label: 'C4 sessions', value: p.n_c4_sessions },
      ]} />
      <p className="tq-muted">No variant satisfies the pre-registered bar, including the shipped one on the decision-worse criterion.</p>
      <Disclosure summary="View per-regime results" meta={`${p.n_c2_cases} C2 cases · ${p.n_c4_sessions} C4 sessions`} testid="eval-p12-tables">
      <h4>C2: coverage and abstention by regime ({p.n_c2_cases} cases; 90 % target)</h4>
      <div className="tq-table-wrap"><table className="tq-table"><caption className="tq-sr">Phase 12 C2 coverage by regime</caption>
        <thead><tr><th scope="col">Regime</th>{c2v.map((k) => <th scope="col" key={k}>{V_LABEL[k]}</th>)}</tr></thead>
        <tbody>{regs.map((rg) => (<tr key={rg}><td>{rg.replaceAll('_', ' ')}</td>{c2v.map((k) => { const e = p.c2[k].by_regime[rg]; return (
          <td key={k} className="tq-num">{pct(e.coverage)} <span className="tq-muted">n={e.n_cases} · abstains {pct(e.abstention, 0)}</span></td>); })}</tr>))}
          <tr><th scope="row">Worst fault × regime cell</th>{c2v.map((k) => { const w = p.c2[k].worst_subgroup || {}; return (
            <td key={k} className="tq-num">{pct(w.coverage)} <span className="tq-muted">{String(w.fault || '').replaceAll('_', ' ')} / {String(w.regime || '').replaceAll('_', ' ')}</span></td>); })}</tr></tbody></table></div>
      <p className="tq-muted">Abstention = share of cases whose prediction is not trusted (it cannot authorise an action). Intervals were not widened to hide shortfalls.</p>
      <h4>C4: diagnostic test outcomes ({p.n_c4_sessions} sessions in all regimes; pooled over flagged looseness / sensor-fault sessions)</h4>
      <div className="tq-table-wrap"><table className="tq-table"><caption className="tq-sr">Phase 12 C4 pooled results</caption>
        <thead><tr><th scope="col">Model</th><th scope="col">n</th><th scope="col">Accuracy after test</th><th scope="col">Confidently wrong</th><th scope="col">Inconclusive</th><th scope="col">Decision worse than prior</th><th scope="col">Meets acceptance bar</th></tr></thead>
        <tbody>{c4n.map((k) => { const v = p.c4[k]; return (
          <tr key={k}><td>{C4_LABEL[k] || 'Phase 11 calibration candidate (NOT adopted)'}</td><td className="tq-num">{v.n}</td><td className="tq-num">{pct(v.accuracy_after)}</td>
            <td className="tq-num">{pct(v.confident_wrong)} <span className="tq-muted">[{pct(v.confident_wrong_ci95?.[0])}–{pct(v.confident_wrong_ci95?.[1])}]</span></td>
            <td className="tq-num">{pct(v.inconclusive)}</td><td className="tq-num">{pct(v.decision_worse_than_prior)}</td>
            <td>{v.meets_acceptance_bar ? <Pill tone="ok">yes</Pill> : <Pill tone="warn">no (worst regime {v.worst_regime}: {pct(v.worst_regime_confident_wrong)})</Pill>}</td></tr>); })}</tbody></table></div>
      </Disclosure>
    </Card>
  );
}

/** Run history and provenance: which committed run is shown and what else exists. Always on the page (not inside a tab). */
function Provenance({ evalRun }) {
  const r = evalRun?.run;
  const runs = Array.isArray(evalRun?.available_runs) ? evalRun.available_runs : [];
  if (!r || typeof r !== 'object') return null;
  const mv = r.model_versions ? Object.entries(r.model_versions).map(([k, v]) => `${label(k)} v${v}`).join(' · ') : null;
  return (
    <Card title="Runs and provenance" id="c-ev-prov" icon={FileText} className="tq-mt" right={<ProvBadge kind="SIMULATED" />}>
      <MetricList label="Run provenance" items={[
        { key: 'file', label: 'Run file', value: evalRun.file },
        { key: 'git', label: 'git commit', value: r.git_sha ?? 'unknown' },
        { key: 'cfg', label: 'Configuration hash', value: r.config_hash ?? 'unknown' },
        { key: 'rt', label: 'Runtime', value: num(r.runtime_s) === undefined ? null : `${r.runtime_s} s`, missingText: 'unavailable' },
        { key: 'mv', label: 'Model versions', value: mv, missingText: 'unavailable' },
      ]} />
      <Disclosure summary="Run history" meta={`${runs.length} committed run(s)`} testid="eval-runs" className="tq-mt">
        <p className="tq-muted">Only the committed evaluation runs below exist; there is no longer history. The newest is chosen by run number: {evalRun.selection || 'newest run'}.</p>
        {runs.length > 0 && (
          <div className="tq-table-wrap"><table className="tq-table"><caption className="tq-sr">Available evaluation runs</caption>
            <thead><tr><th scope="col">File</th><th scope="col">git</th><th scope="col">Config</th><th scope="col">Runtime</th><th scope="col">Regime sections</th></tr></thead>
            <tbody>{runs.map((x) => (<tr key={x.file}><td>{x.file}{x.file === evalRun.file && <> <Pill tone="info">shown</Pill></>}</td><td>{x.git_sha ?? '—'}</td><td>{x.config_hash ?? '—'}</td>
              <td className="tq-num">{x.runtime_s != null ? `${x.runtime_s} s` : '—'}</td><td>{x.has_regimes ? 'yes' : 'no'}</td></tr>))}</tbody></table></div>)}
      </Disclosure>
    </Card>
  );
}

export function Evaluation({ evalRun, evalError, c2c4, c2c4Error, loading }) {
  const [tab, setTab] = useState('system');
  const r = evalRun?.run && typeof evalRun.run === 'object' ? evalRun.run : null;
  return (
    <div className="tq-as-eval">
      <AlertPanel tone="info" icon={FlaskConical} title="Simulation results only" testid="eval-banner">
        <p>{r ? (r.WARNING || 'Simulation only.') : 'These results come from the software simulator and are not hardware evidence.'}</p>
      </AlertPanel>
      <Tabs label="Evaluation views" idBase="tq-ev" value={tab} onChange={setTab} tabs={[
        { key: 'system', label: 'System evaluation', icon: Activity },
        { key: 'models', label: 'C2 / C4 validation', icon: LineChart },
        { key: 'general', label: 'Generalization check', icon: Layers },
      ]} />
      {tab === 'system' && (
        <TabPanel tab="system" idBase="tq-ev">
          {!r ? (
            <Card title="Evaluation run" id="c-eval" right={<ProvBadge kind="SIMULATED" />}>
              {loading ? <Empty loading>Loading the latest evaluation run…</Empty>
                : <Empty>{evalError ? `No evaluation run available (${String(evalError.message)}).` : 'No evaluation run available.'}</Empty>}
            </Card>) : (
            <div id="c-eval">
              <Headline r={r} />
              <Comparisons r={r} />
              <Limitations r={r} />
            </div>)}
        </TabPanel>)}
      {tab === 'models' && <TabPanel tab="models" idBase="tq-ev"><div className="tq-grid tq-grid-wide"><C2C4Validation data={c2c4} error={c2c4Error} /></div></TabPanel>}
      {tab === 'general' && <TabPanel tab="general" idBase="tq-ev"><Phase12Card p={c2c4?.phase12} /></TabPanel>}
      <Provenance evalRun={evalRun} />
    </div>
  );
}
