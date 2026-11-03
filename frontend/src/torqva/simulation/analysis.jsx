// Simulation analysis pages: C1 diagnostics, C2 predictions and C4 tests (the building blocks the C1/C2/C4 workspaces embed).
import React, { useState } from 'react';
import { Card, Empty, Pill, PosteriorBars, ProvBadge, fmt, title, PageHead, CardLink, Disclosure } from '../shared/components.jsx';
import { ScoreChart, ResponseChart } from '../shared/lazyCharts.jsx';
import { DiagnosticTests, PredictionChecks, StatusPill } from './c2c4.jsx';
import { TEST_SPECS } from '../shared/diagnostics.js';
import { isPhysOf, lastOf, samplesOf } from './simdata.js';

/* ------------------------------------------------------------------ 3. AI diagnostics (C1) */
function c1Records(d) {
  const t = samplesOf(d); const hyp = lastOf(d.log, 'hypotheses');
  const gate = [...(d.decisions || [])].reverse().find((x) => x.inputs);
  const inc = (d.incidents || []).slice(-1)[0];
  const data = t.map((x) => ({ ...x, score: x.score == null || x.score <= 0 ? null : Number(x.score.toFixed(3)) }));
  return { t, hyp, gate, inc, data };
}

/** C1 score ÷ learned threshold over the recorded windows (log scale); gaps are windows that were not scored. */
export function C1ScoreCard({ d }) {
  const { data } = c1Records(d);
  const above = data.filter((x) => x.score != null && x.score > 1).length;
  return (
    <Card title="Anomaly severity (× learned threshold, log scale)" id="c-score" right={<ProvBadge kind="DERIVED" />}>
      {!data.length ? <Empty>No telemetry yet.</Empty> : (
        <div role="img" aria-label="Anomaly severity over time" className="tq-chart"><ScoreChart data={data} height={240} /></div>)}
      <p className="tq-chart-note">1 = the threshold learned for this speed range. Gaps = windows excluded (speed changing) or operating point not learned. {above} of {data.length} windows above threshold.</p>
    </Card>);
}
/** The incident's state transitions as the backend recorded them. */
export function C1TimelineCard({ d }) {
  const { inc } = c1Records(d);
  return (
    <Card title="Incident timeline" id="c-hist">
      {!inc ? <Empty>No incident yet.</Empty> : (
        <ol className="tq-timeline">{inc.history.map((h, i) => (<li key={i}><span className="tq-muted">{title(h[0])}</span> → <strong>{title(h[2])}</strong> <span className="tq-muted">({h[1]})</span></li>))}</ol>)}
    </Card>);
}
/** The decision gate's latest verdict with every input it used. */
export function C1GateCard({ d, heading = 'Gate inputs behind the latest verdict' }) {
  const { hyp, gate } = c1Records(d);
  return (
    <Card title={heading} id="c-why">
      {!hyp ? <Empty>No explanation yet; hypotheses appear once an anomaly has persisted.</Empty> : (
        <><p>Top hypothesis <strong>{title(hyp.ranked?.[0]?.[0])}</strong> is <strong>{hyp.label}</strong>.</p>
          {gate ? <p>Decision gate: <Pill tone={gate.verdict === 'ACT' ? 'ok' : 'warn'}>{title(gate.verdict)}</Pill> {gate.reason}</p> : null}
          {gate && <div className="tq-table-wrap"><table className="tq-table"><caption className="tq-sr">Gate inputs</caption><tbody>{Object.entries(gate.inputs).map(([k, v]) => (<tr key={k}><th scope="row">{title(k)}</th><td className="tq-num">{String(v)}</td></tr>))}</tbody></table></div>}</>)}
    </Card>);
}

export function DiagnosticsPage({ d, isPhys: isPhysProp, head = true }) {
  const isPhys = isPhysProp ?? isPhysOf(d);
  const provKind = 'DERIVED';
  const { t, hyp, gate } = c1Records(d); const s = d.status || {}; const w = s.last_window;
  const last = t[t.length - 1];
  const regime = !last ? ['off', 'No data'] : last.score == null ? ['info', `Not scored: ${title(last.score_status)}`] : last.score > 1 ? ['crit', 'Abnormal (above learned threshold)'] : ['ok', 'Normal (within learned band)'];
  const unfamiliar = hyp?.label === 'unfamiliar' || (d.log || []).some((l) => l.kind === 'c1_unfamiliar_regime');
  if (!head) {                       // embedded: the score is evidence; the timeline and raw gate inputs are detail
    return (
      <>
        <C1ScoreCard d={d} />
        <Disclosure summary="Inspect gate inputs and incident timeline" meta={gate ? `latest verdict ${title(gate.verdict)}` : 'no gate decision yet'} testid="c1-gate-inputs">
          <div className="tq-split"><C1TimelineCard d={d} /><C1GateCard d={d} /></div>
        </Disclosure>
      </>);
  }
  return (
    <>
      <PageHead title="Anomaly Detection" sub="Anomaly detection and fault hypotheses with the evidence behind them." right={<ProvBadge kind={provKind} />} />
      <div className="tq-split">
        <div className="tq-stack"><C1ScoreCard d={d} /><C1TimelineCard d={d} /></div>
        <div className="tq-stack">
          <Card title="Operating regime" id="c-regime">
            <p><Pill tone={regime[0]}>{regime[1]}</Pill></p>
            {unfamiliar && <p className="tq-callout warn">An unfamiliar operating regime was seen. It is not confirmed healthy and cannot authorise an action.</p>}
            <dl className="tq-kv"><dt>Sensor validity</dt><dd>{!w ? '—' : w.valid === false ? <Pill tone="crit">invalid</Pill> : <Pill tone="ok">valid</Pill>}</dd>
              <dt>Data origin</dt><dd>{isPhys ? 'Physical device' : 'Simulation'}</dd></dl>
          </Card>
          <Card title="Fault hypotheses" id="c-hyp" right={<ProvBadge kind={provKind} />}>
            <PosteriorBars ranked={hyp?.ranked} label={hyp?.label} />
            <p className="tq-muted">Probabilities are produced by the backend from learned class signatures. Bearing faults are not diagnosable with this sensor set.</p>
          </Card>
          <C1GateCard d={d} heading="Why this hypothesis" />
        </div>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ 4. Predictions (C2) */
export function PredictionsPage({ d, go, head = true }) {
  const s = d.status || {}; const w = s.last_window;
  const all = d.predictions || [];
  const latestAt = all.length ? all[all.length - 1].predicted_at : null;
  const preds = all.filter((p) => p.predicted_at === latestAt);
  const [sel, setSel] = useState(null);
  const [signal, setSignal] = useState('housing');
  const p = preds.find((x) => x.action === sel) || preds[0];
  const rank = lastOf(d.log, 'c2_ranking');
  const chosen = rank && latestAt != null && Math.abs(rank.t - latestAt) < 1 ? rank.chosen : null;   // the C2 choice logged with this set of predictions
  const cur = { rpm: w?.rpm, housing: w?.housing, vib_rms: w?.vib_rms };
  const dg = signal === 'vib_rms' ? 3 : 1;
  const chart = p ? [{ h: 0, mean: cur[signal] ?? null }, ...[30, 60, 120].map((h, i) => {
    const lo = p.lo_at_30_60_120?.[signal]?.[i]; const hi = p.hi_at_30_60_120?.[signal]?.[i];
    return { h, mean: p.mean_at_30_60_120?.[signal]?.[i] ?? null, band: lo != null && hi != null ? [lo, hi] : null };   // no interval from the model = no band, never a band to zero
  })] : [];
  return (
    <>
      {head && <PageHead title="Failure Prediction" sub="Expected outcome of each candidate action under matched simulated conditions."
        right={<><ProvBadge kind="PREDICTED" />{p && <StatusPill status={p.status} />}</>} />}
      {head && <p className="tq-callout warn" role="note"><strong>{s.models?.c2_label || 'Intervention Outcome Prediction (unvalidated)'}</strong> — not validated against physical experiments. A prediction is never evidence of recovery, and an unsupported prediction never authorises an action.
        {s.models?.c2_variant && s.models.c2_variant !== 'control' ? ` Experimental variant in use (opt-in): ${s.models.c2_variant}.` : ' The shipped predictor is in use; experimental variants are opt-in.'}</p>}
      {!preds.length ? (<div className="tq-stack"><Card title="Predictions" id="c-pred"><Empty>No predictions yet. This list holds only the pipeline's own comparisons, made when an incident reaches action evaluation.</Empty></Card>
        <PredictionChecks checks={d.predictionChecks || []} /></div>) : (
        <div className="tq-split">
          <div className="tq-stack">
            <Card title="Candidate interventions" id="c-pred" right={<ProvBadge kind="PREDICTED" />}>
              <div className="tq-stack" role="group" aria-label="Select intervention">
                {preds.map((x) => (
                  <button type="button" key={x.action} className="tq-select-card" aria-pressed={p?.action === x.action} onClick={() => setSel(x.action)}>
                    <div className="tq-option-title"><strong>{title(x.action)}</strong><span className="tq-row">{chosen === x.action && <Pill tone="info">Lowest predicted risk</Pill>}<StatusPill status={x.status} /></span></div>
                    <div className="tq-option-meta">risk of crossing a limit {fmt(x.risk * 100, 0)}% · speed @120 s <span className="tq-num">{fmt(x.mean_at_30_60_120?.rpm?.[2], 0)} rpm</span></div>
                    {x.status_reasons?.length > 0 && <div className="tq-option-meta">{x.status_reasons.map(title).join(', ')}</div>}
                  </button>))}
              </div>
            </Card>
            <Card title="Predicted response" id="c-resp" right={<label className="tq-inline">Signal <select value={signal} onChange={(e) => setSignal(e.target.value)}><option value="housing">Housing °C</option><option value="rpm">Speed rpm</option><option value="vib_rms">Vibration g</option></select></label>}>
              <div role="img" aria-label="Predicted response with 90 percent interval" className="tq-chart"><ResponseChart data={chart} height={240} digits={signal === 'rpm' ? 0 : dg} unit={signal === 'rpm' ? 'rpm' : signal === 'vib_rms' ? 'g' : signal === 'current' ? 'A' : '°C'} /></div>
              <p className="tq-chart-note">The interval covers a single future 1 s simulated measurement. It is not a guarantee and not a measurement.</p>
            </Card>
          </div>
          <div className="tq-stack">
            <Card title="Prediction summary" id="c-sum">
              {p && (
                <dl className="tq-kv"><dt>Action</dt><dd>{title(p.action)}</dd><dt>Status</dt><dd><StatusPill status={p.status} /></dd>
                  <dt>Current {title(signal)}</dt><dd className="tq-num">{fmt(cur[signal], dg)}</dd>
                  <dt>Predicted @120 s</dt><dd className="tq-num">{fmt(p.mean_at_30_60_120?.[signal]?.[2], dg)}</dd>
                  <dt>90% interval @120 s</dt><dd className="tq-num">{fmt(p.lo_120?.[signal], dg)}–{fmt(p.hi_120?.[signal], dg)}</dd>
                </dl>)}
              {p && (
                <table className="tq-table" data-testid="pred-horizons"><caption className="tq-sr">Predicted {title(signal)} by horizon</caption>
                  <thead><tr><th scope="col">Horizon</th><th scope="col">Predicted mean</th><th scope="col">90% interval</th></tr></thead>
                  <tbody>
                    <tr><th scope="row">now <ProvBadge kind="SIMULATED" /></th><td className="tq-num">{fmt(cur[signal], dg)}</td><td className="tq-muted">simulated reading, not a prediction</td></tr>
                    {[30, 60, 120].map((h, i) => { const lo = p.lo_at_30_60_120?.[signal]?.[i]; const hi = p.hi_at_30_60_120?.[signal]?.[i]; return (
                      <tr key={h}><th scope="row">+{h} s <ProvBadge kind="PREDICTED" /></th><td className="tq-num">{fmt(p.mean_at_30_60_120?.[signal]?.[i], dg)}</td><td className="tq-num">{lo != null && hi != null ? `${fmt(lo, dg)}–${fmt(hi, dg)}` : 'no interval'}</td></tr>); })}
                  </tbody></table>)}
              {p && (
                <dl className="tq-kv">
                  <dt>Interval method</dt><dd>{p.interval_method || '—'}</dd><dt>Validated by experiments</dt><dd>{p.validated_by_experiments ? 'yes' : 'no'}</dd></dl>)}
              <p className="tq-muted">A prediction never commands the motor. Actions are proposed by the decision gate and checked by the Safety Supervisor.</p>
              {go && <CardLink onClick={() => go('interventions')}>Open Action Recommendations</CardLink>}
            </Card>
            <PredictionChecks checks={d.predictionChecks || []} />
          </div>
        </div>)}
    </>
  );
}

/* ------------------------------------------------------------------ 5. Diagnostic tests (C4) */
export function TestsPage({ d, c2c4, head = true }) {
  const [sel, setSel] = useState('T1');
  const spec = TEST_SPECS[sel] || TEST_SPECS.T1;
  const res = lastOf(d.log, 'test_result');
  const inc = d.status?.incident;
  const phase11 = c2c4?.phase11?.c4_calibration;
  const real = c2c4?.c4_realistic_v2 || c2c4?.c4_realistic_v1;
  return (
    <>
      {head && <PageHead title="Diagnostic Investigation" sub="Tests that separate competing fault hypotheses. Run only through the safety supervisor." right={<ProvBadge kind="SIMULATED" />} />}
      <div className="tq-split">
        <div className="tq-stack">
          <Card title="Available tests" id="c-avail">
            <div className="tq-stack" role="group" aria-label="Available diagnostic tests">
              {Object.entries(TEST_SPECS).map(([k, x]) => (
                <button type="button" key={k} className="tq-select-card" aria-pressed={sel === k} onClick={() => setSel(k)}>
                  <div className="tq-option-title"><strong>{x.name}</strong><Pill tone="info">{x.duration_s} s</Pill></div>
                  <div className="tq-muted">{x.target}</div>
                </button>))}
            </div>
            <p className="tq-muted">Tests are proposed by the decision gate and run by the pipeline in the simulator after the Safety Supervisor allows them. There is no manual run button, by design.</p>
          </Card>
          <DiagnosticTests log={d.log || []} />
        </div>
        <div className="tq-stack">
          <Card title={`Selected test ${spec.code}`} id="c-sel" right={<Pill tone="info">{spec.short}</Pill>}>
            <p><strong>{spec.name}</strong></p>
            <p className="tq-muted">{spec.target}</p>
            <div className="tq-subpanel"><span className="tq-subpanel-title">How the test works</span><p>{spec.method}</p></div>
            <p className="tq-small"><span className="tq-muted">Observed signals: </span><strong>{spec.signals.join(' · ')}</strong></p>
            <p className="tq-muted">Expected diagnostic value is not shown per test because the backend does not publish a per-test value; measured value is in Performance Evaluation.</p>
          </Card>
          <Card title="Latest result and competing hypotheses" id="c-result" right={<ProvBadge kind="SIMULATED" />}>
            {!res ? <Empty>No diagnostic test has been run in this incident.</Empty> : (
              <><p><strong>{res.test}</strong> observation <span className="tq-num">{(res.obs || []).map((x) => fmt(x, 2)).join(', ')}</span></p><PosteriorBars ranked={res.posterior} label="after test" /></>)}
            {inc && <p className="tq-muted">Tests run in incident {inc.id}: <span className="tq-num">{inc.tests_run ?? '—'}</span></p>}
          </Card>
          <Card title="Test calibration status" id="c-cal">
            <p><Pill tone="warn">{phase11 && !phase11.adopted ? 'Test calibration NOT adopted' : 'calibration status unavailable'}</Pill></p>
            <p className="tq-muted">The experimental Test calibration failed its pre-registered validation bar (it regressed on an unseen sensor style), so the shipped test model behaviour is unchanged. Only a rule that blocks action on uncorroborated evidence ships.</p>
            {real && <p className="tq-muted">Held-out confidently-wrong rates by regime are in Performance Evaluation.</p>}
          </Card>
        </div>
      </div>
    </>
  );
}
