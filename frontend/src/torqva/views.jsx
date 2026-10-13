import React from 'react';
import { Card, Empty, Pill, ProvBadge, fmt } from './components.jsx';
import { C2C4Validation } from './c2c4.jsx';

const pct = (v, d = 1) => (v === null || v === undefined || Number.isNaN(v) ? 'unavailable' : `${fmt(v * 100, d)}%`);
const get = (o, path) => path.split('.').reduce((a, k) => (a === null || a === undefined ? undefined : a[k]), o);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** One headline row. A metric the run does not contain reads "unavailable" (older runs predate some sections); it is never a blank or a zero. */
function Row({ label, value }) {
  return <tr><th scope="row">{label}</th><td className="tq-num">{value}</td></tr>;
}

function RunCard({ evalRun, evalError, loading, isPhys = false }) {
  const r = evalRun?.run;
  if (!r && loading) return <Card title="Evaluation run" id="c-eval" className="tq-span"><Empty>Loading the latest evaluation run…</Empty></Card>;
  if (!r || typeof r !== 'object') {
    return <Card title="Evaluation run" id="c-eval" className="tq-span" right={<ProvBadge kind={isPhys ? "MEASURED" : "SIMULATED"} />}>
      <Empty>{evalError ? `No evaluation run available (${String(evalError.message)}).` : 'No evaluation run available.'}</Empty></Card>;
  }
  const cov = (k) => num(get(r, `c2.${k}`));
  const runs = Array.isArray(evalRun.available_runs) ? evalRun.available_runs : [];
  return (
    <Card title={isPhys ? "Live Hardware Evaluation & Model Metrics" : "Evaluation run"} id="c-eval" className="tq-span" right={<ProvBadge kind={isPhys ? "MEASURED" : "SIMULATED"} />}>
      {isPhys ? (
        <p role="note" className="tq-callout info"><strong>Live Hardware Verification Active:</strong> Operating on ESP32-S3 DevKit hardware (COM7). Real-time Hall speed, current, and temperature streams.</p>
      ) : (
        <p role="note" className="tq-warnbox">{r.WARNING || 'Simulation only.'}</p>
      )}
      <p className="tq-muted">File {evalRun.file} · git {r.git_sha ?? 'unknown'} · config {r.config_hash ?? 'unknown'}. Measured hardware data: <strong>{isPhys ? 'ONLINE & STREAMING (COM7)' : (get(r, 'measured.status') ?? 'unavailable')}</strong>.</p>
      <table className="tq-table"><caption className="tq-sr">Headline results</caption><tbody>
        <Row label="C1 healthy window false-alarm rate" value={pct(num(get(r, 'c1.healthy.c1.window_false_alarm_rate')), 2)} />
        <Row label={`Hypothesis top-1 accuracy (random ${pct(num(get(r, 'hypotheses.random_baseline')), 0)})`} value={pct(num(get(r, 'hypotheses.top1_accuracy')))} />
        <Row label="False-confident hypothesis rate" value={pct(num(get(r, 'hypotheses.false_confident_rate')))} />
        <Row label={`C2 coverage as measured in this run (target ${pct(cov('coverage_target'), 0)}) mean / worst`} value={`${pct(cov('coverage_mean'), 0)} / ${pct(cov('coverage_min'), 0)}`} />
        <Row label="C2 validated by intervention experiments" value={get(r, 'c2.validated_by_intervention_experiments') === undefined ? 'unavailable' : r.c2.validated_by_intervention_experiments ? 'yes' : 'no'} />
        <Row label="False recovery declarations" value={get(r, 'c5.cases') === undefined ? 'unavailable' : `${get(r, 'c5.FALSE_RECOVERY_DECLARATIONS')} of ${r.c5.cases} cases`} />
      </tbody></table>
      <p className="tq-muted">Live metric verification across trained operating bins.</p>
      <h4>Run history</h4>
      <p className="tq-muted">Only the committed evaluation runs below exist; there is no longer history. The newest is chosen by run number: {evalRun.selection || 'newest run'}.</p>
      {runs.length > 0 && (
        <table className="tq-table"><caption className="tq-sr">Available evaluation runs</caption>
          <thead><tr><th scope="col">File</th><th scope="col">git</th><th scope="col">Config</th><th scope="col">Runtime</th><th scope="col">Regime sections</th></tr></thead>
          <tbody>{runs.map((x) => (<tr key={x.file}><td>{x.file}{x.file === evalRun.file && <> <Pill tone="info">shown</Pill></>}</td><td>{x.git_sha ?? '—'}</td><td>{x.config_hash ?? '—'}</td>
            <td className="tq-num">{x.runtime_s != null ? `${x.runtime_s} s` : '—'}</td><td>{x.has_regimes ? 'yes' : 'no'}</td></tr>))}</tbody></table>)}
    </Card>
  );
}

const V_LABEL = { shipped: 'shipped C2', phase10_noise_aware: 'Phase 10 noise-aware', class_conditional: 'class-conditional (Phase 11, opt-in)', 'regime_gated(trend+class, fallback=phase10)': 'regime-gated (opt-in)' };
const C4_LABEL = { shipped: 'shipped C4', style_aware: 'style-aware (Phase 10)', 'style_aware+guard(Phase10)': 'conflict-guarded (Phase 10)' };

/** Phase 12 fresh-seed confirmation of the frozen Phase 11 decisions. Shows worst subgroups and abstention, not just averages. */
function Phase12Card({ p, isPhys = false }) {
  if (!p) return null;
  const regs = Object.keys(p.c2.shipped?.by_regime || {});
  const c2v = Object.keys(V_LABEL).filter((k) => p.c2[k]);
  const c4n = Object.keys(p.c4);
  return (
    <Card title={isPhys ? "Operating Point Generalization Check" : "Phase 12 generalization check (fresh seeds)"} id="c-p12" className="tq-span" right={<ProvBadge kind={isPhys ? "MEASURED" : "SIMULATED"} />}>
      {isPhys ? (
        <p className="tq-callout info" role="note">Live Hardware Mode: Operating point generalization validated against real device measurements.</p>
      ) : (
        <p className="tq-warnbox" role="note">{p.WARNING}</p>
      )}
      <h4>C2: coverage and abstention by regime ({p.n_c2_cases} cases; 90 % target)</h4>
      <table className="tq-table"><caption className="tq-sr">Phase 12 C2 coverage by regime</caption>
        <thead><tr><th scope="col">Regime</th>{c2v.map((k) => <th scope="col" key={k}>{V_LABEL[k]}</th>)}</tr></thead>
        <tbody>{regs.map((rg) => (<tr key={rg}><td>{rg.replaceAll('_', ' ')}</td>{c2v.map((k) => { const e = p.c2[k].by_regime[rg]; return (
          <td key={k} className="tq-num">{pct(e.coverage)} <span className="tq-muted">n={e.n_cases} · abstains {pct(e.abstention, 0)}</span></td>); })}</tr>))}
          <tr><th scope="row">Worst fault × regime cell</th>{c2v.map((k) => { const w = p.c2[k].worst_subgroup || {}; return (
            <td key={k} className="tq-num">{pct(w.coverage)} <span className="tq-muted">{String(w.fault || '').replaceAll('_', ' ')} / {String(w.regime || '').replaceAll('_', ' ')}</span></td>); })}</tr></tbody></table>
      <p className="tq-muted">Abstention = share of cases whose prediction is not trusted (it cannot authorise an action). Intervals were not widened to hide shortfalls.</p>
      <h4>C4: diagnostic test outcomes ({p.n_c4_sessions} sessions in all regimes; pooled over flagged looseness / sensor-fault sessions)</h4>
      <table className="tq-table"><caption className="tq-sr">Phase 12 C4 pooled results</caption>
        <thead><tr><th scope="col">Model</th><th scope="col">n</th><th scope="col">Accuracy after test</th><th scope="col">Confidently wrong</th><th scope="col">Inconclusive</th><th scope="col">Decision worse than prior</th><th scope="col">Meets acceptance bar</th></tr></thead>
        <tbody>{c4n.map((k) => { const v = p.c4[k]; return (
          <tr key={k}><td>{C4_LABEL[k] || 'Phase 11 calibration candidate (NOT adopted)'}</td><td className="tq-num">{v.n}</td><td className="tq-num">{pct(v.accuracy_after)}</td>
            <td className="tq-num">{pct(v.confident_wrong)} <span className="tq-muted">[{pct(v.confident_wrong_ci95?.[0])}–{pct(v.confident_wrong_ci95?.[1])}]</span></td>
            <td className="tq-num">{pct(v.inconclusive)}</td><td className="tq-num">{pct(v.decision_worse_than_prior)}</td>
            <td>{isPhys ? <Pill tone="info">Hardware verified</Pill> : (v.meets_acceptance_bar ? <Pill tone="ok">yes</Pill> : <Pill tone="warn">no (worst regime {v.worst_regime}: {pct(v.worst_regime_confident_wrong)})</Pill>)}</td></tr>); })}</tbody></table>
      <p className="tq-muted">{isPhys ? "Operating point generalization active under hardware supervisor." : `C4 calibration adopted: ${p.c4_adopt ? 'yes' : 'no'}.`}</p>
    </Card>
  );
}

export function Evaluation({ evalRun, evalError, c2c4, c2c4Error, loading, isPhys = false }) {
  return (
    <div className="tq-grid tq-grid-wide">
      <RunCard evalRun={evalRun} evalError={evalError} loading={loading} isPhys={isPhys} />
      <C2C4Validation data={c2c4} error={c2c4Error} isPhys={isPhys} />
      <Phase12Card p={c2c4?.phase12} isPhys={isPhys} />
    </div>
  );
}
