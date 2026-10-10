import React from 'react';
import { Card, Empty, ProvBadge, fmt } from './components.jsx';
import { C2C4Validation } from './c2c4.jsx';

/* ------------------------------------------------------------------ Evaluation / Learning */
export function Evaluation({ evalRun, evalError, c2c4, c2c4Error }) {
  const r = evalRun?.run;
  return (
    <div className="tq-grid tq-grid-wide">
      <Card title="Evaluation run" id="c-eval" right={<ProvBadge kind="SIMULATED" />}>
        {evalError && !r && <Empty>No evaluation run available ({String(evalError.message)}).</Empty>}
        {r && (
          <>
            <p role="note" className="tq-warnbox">{r.WARNING}</p>
            <p className="tq-muted">File {evalRun.file} · git {r.git_sha} · config {r.config_hash}. Measured hardware data: <strong>{r.measured.status}</strong>.</p>
            <table className="tq-table"><caption className="tq-sr">Headline simulation results</caption><tbody>
              <tr><th scope="row">C1 healthy window false-alarm rate</th><td className="tq-num">{fmt(r.c1.healthy.c1.window_false_alarm_rate * 100, 2)}%</td></tr>
              <tr><th scope="row">Hypothesis top-1 accuracy (random {fmt(r.hypotheses.random_baseline * 100, 0)}%)</th><td className="tq-num">{fmt(r.hypotheses.top1_accuracy * 100, 1)}%</td></tr>
              <tr><th scope="row">False-confident hypothesis rate</th><td className="tq-num">{fmt(r.hypotheses.false_confident_rate * 100, 1)}%</td></tr>
              <tr><th scope="row">C2 coverage as measured in this run (target {fmt(r.c2.coverage_target * 100, 0)}%) mean / worst</th><td className="tq-num">{fmt(r.c2.coverage_mean * 100, 0)}% / {fmt(r.c2.coverage_min * 100, 0)}%</td></tr>
              <tr><th scope="row">C2 validated by intervention experiments</th><td>{r.c2.validated_by_intervention_experiments ? 'yes' : 'no'}</td></tr>
              <tr><th scope="row">False recovery declarations</th><td className="tq-num">{r.c5.FALSE_RECOVERY_DECLARATIONS} of {r.c5.cases} cases</td></tr>
            </tbody></table>
            <p className="tq-muted">This run measured the conformal quantile only. The Phase 10 table measures the intervals the predictor actually returns, which cover less.</p>
          </>)}
      </Card>
      <C2C4Validation data={c2c4} error={c2c4Error} />
    </div>
  );
}
