// AI Diagnostics (C1), simulation mode: the analyst's investigation workspace. Current condition → C1 assessment → ranked hypotheses with the
// model's own evidence → recommended next test. Everything shown comes from the simulator's records or the workbench plan; a hypothesis is a
// ranking, never a confirmed fault, and the scenario's injected fault is shown apart as ground truth.
import React from 'react';
import { Gauge, Thermometer, Waves, Zap, Plug, FlaskConical, ArrowRight } from 'lucide-react';
import { Card, Empty, Pill, ProvBadge, fmt, stateTone, PageHead } from '../shared/components.jsx';
import { TEST_SPECS, TEST_OUTCOMES, FEATURE_LABEL, SCORE_STATUS } from '../shared/diagnostics.js';
import { Kpi, DiagnosticsPage } from './pages.jsx';
import { usePlan, title, pct } from './workbench.js';
import { InvestigationTrace } from './trace.jsx';
import { SufficiencyBadge } from './adaptive.jsx';

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const z = (v) => (finite(v) ? `${v > 0 ? '+' : ''}${v.toFixed(1)}σ` : '—');

/** The one-line reading of the current state, from C1 and the simulated device only. Never a binary healthy/faulty verdict. */
export function conditionOf(d, plan, stale) {
  const s = d.status || {}; const w = s.last_window;
  if (stale) return ['crit', 'Uncertain: the backend is not answering', 'The values shown are the last received.'];
  if (s.t === undefined || s.t === null) return ['off', 'No simulation running', 'Start a scenario from the Simulation Overview.'];
  if (s.device?.estop) return ['stop', 'Unsafe to continue: the simulated device latched a stop', title(s.device.estop_reason)];
  if (!w) return ['off', 'Uncertain: no telemetry window yet', ''];
  if (w.valid === false) return ['crit', 'Uncertain: the latest window is invalid', 'Sensor data is not trusted, so nothing is concluded from it.'];
  const c1 = plan?.c1;
  if (s.incident) return [stateTone(s.incident.state), 'Anomaly under investigation', `Incident ${s.incident.id}: ${title(s.incident.state)}.`];
  if (c1 && c1.score_over_threshold === null) return ['info', 'Uncertain: this window was not scored', SCORE_STATUS[c1.status] || title(c1.status)];
  if (c1?.anomalous) return ['warn', 'Anomaly suspected', `Above the learned threshold for ${c1.anomalous_run} consecutive window(s); an incident opens after ${c1.confirm_windows}.`];
  if (c1) return ['ok', 'Consistent with the learned baseline at this speed', `Score ${fmt(c1.score_over_threshold, 2)} × threshold (${SCORE_STATUS[c1.status] || title(c1.status)}).`];
  return ['info', 'Reading the C1 state…', ''];
}

function explain(plan) {
  const c1 = plan?.c1; if (!c1) return null;
  const parts = [];
  if (c1.score_over_threshold !== null) parts.push(`The latest window scores ${fmt(c1.score_over_threshold, 2)} × the threshold learned for this operating-speed range (1 = threshold).`);
  else parts.push(`The latest window was ${SCORE_STATUS[c1.status] || title(c1.status)}.`);
  if (plan.top_features?.length) parts.push(`Across the ${plan.evidence_windows} anomalous evidence window(s), the features furthest from the healthy baseline are ${plan.top_features.slice(0, 3).map((f) => `${FEATURE_LABEL[f.feature] || f.feature} (${z(f.mean_z)})`).join(', ')}.`);
  return parts.join(' ');
}

function HypothesisRow({ h, top }) {
  return (
    <li className={`tq-hyp ${top ? 'is-top' : ''}`} data-testid={`hyp-${h.hypothesis}`}>
      <div className="tq-hyp-head">
        <strong>{title(h.hypothesis)}</strong>
        <span className="tq-bar-track"><span className="tq-bar-fill" style={{ width: `${Math.max(0, Math.min(1, h.probability ?? 0)) * 100}%` }} /></span>
        <span className="tq-num">{pct(h.probability, 1)}</span>
      </div>
      <details className="tq-hyp-more">
        <summary>Evidence{h.compared_with ? ` compared with ${title(h.compared_with)}` : ''}</summary>
        <div className="tq-hyp-grid">
          <div><span className="tq-section-title">Favours it</span>
            {h.supporting?.length ? <ul className="tq-list">{h.supporting.map((x) => <li key={x.feature}>{FEATURE_LABEL[x.feature] || x.feature}: observed {z(x.observed_z)}, signature {z(x.signature_z)}</li>)}</ul> : <p className="tq-muted">none</p>}</div>
          <div><span className="tq-section-title">Counts against it</span>
            {h.contradicting?.length ? <ul className="tq-list">{h.contradicting.map((x) => <li key={x.feature}>{FEATURE_LABEL[x.feature] || x.feature}: observed {z(x.observed_z)}, signature {z(x.signature_z)}</li>)}</ul> : <p className="tq-muted">none</p>}</div>
          <div><span className="tq-section-title">Best separating test</span>
            {h.best_separating_test ? <p>{h.best_separating_test.test} against {title(h.best_separating_test.versus)} <span className="tq-muted">(signature separation {fmt(h.best_separating_test.separation, 1)} σ)</span></p> : <p className="tq-muted">none learned</p>}</div>
        </div>
        <p className="tq-chart-note">From the hypothesis model's own per-feature log-likelihood over the evidence windows. Signatures are learned in simulation.</p>
      </details>
    </li>
  );
}

export function SimDiagnosticsPage({ d, go, stale, setWb }) {
  const { plan, error } = usePlan(d);
  const s = d.status || {}; const w = s.last_window; const sc = s.scenario || {};
  const hasSim = s.t !== undefined && s.t !== null;
  const [tone, head, detail] = conditionOf(d, plan, stale);
  const val = (v) => (hasSim && w && w.valid !== false ? v : null);
  const tail = (d.telemetry?.samples || []).slice(-60);
  const injected = sc.fault && finite(s.t) && finite(sc.inject_after_s) && s.t >= sc.inject_after_s;
  const rec = plan?.recommended_test;
  const spec = rec && TEST_SPECS[rec.test];
  const post = plan?.posterior;
  return (
    <>
      <PageHead title="AI Diagnostics (C1)" sub="What the motor is doing now, what C1 makes of it, which faults could explain it and which test would tell them apart."
        right={<><ProvBadge kind="SIMULATED" /><Pill tone={tone}>{head}</Pill></>} />
      <div className={`tq-narrate tone-${tone}`} data-testid="c1-condition">
        <strong>{head}</strong>{detail && <span>{detail}</span>}
      </div>
      {error && error !== 'unavailable' && hasSim && <p className="tq-callout warn">The workbench plan could not be loaded: {error}</p>}

      <Card title="Operating condition" id="c-cond" right={<ProvBadge kind="SIMULATED" />}>
        <div className="tq-kpis" data-testid="c1-kpis">
          <Kpi label="Speed" icon={Gauge} value={val(w?.rpm)} unit="rpm" digits={0} data={tail} dataKey="rpm" prov="SIMULATED" note={hasSim ? `setpoint ${fmt(s.device?.setpoint_rpm, 0)} rpm` : undefined} />
          <Kpi label="Current" icon={Zap} value={val(w?.current)} unit="A" digits={2} data={tail} dataKey="current" prov="SIMULATED" color="var(--tq-chart-4)" />
          <Kpi label="Supply voltage" icon={Plug} value={val(w?.voltage)} unit="V" digits={2} data={tail} dataKey="voltage" prov="SIMULATED" color="var(--tq-chart-3)" />
          <Kpi label="Housing temperature" icon={Thermometer} value={val(w?.housing)} unit="°C" data={tail} dataKey="housing" prov="SIMULATED" color="var(--tq-chart-2)" />
          <Kpi label="Vibration RMS (simulator model)" icon={Waves} value={val(w?.vib_rms)} unit="g" digits={3} data={tail} dataKey="vib_rms" prov="SIMULATED" color="var(--tq-chart-3)" />
        </div>
        <dl className="tq-kv tq-mt">
          <dt>C1 window status</dt><dd>{plan?.c1 ? <Pill tone={plan.c1.score_over_threshold === null ? 'info' : plan.c1.anomalous ? 'warn' : 'ok'}>{title(plan.c1.status)}</Pill> : '—'}</dd>
          <dt>Score ÷ learned threshold</dt><dd className="tq-num">{plan?.c1 ? fmt(plan.c1.score_over_threshold, 2) : '—'}</dd>
          <dt>Anomalous windows in a row</dt><dd className="tq-num">{plan?.c1 ? `${plan.c1.anomalous_run} (incident at ${plan.c1.confirm_windows})` : '—'}</dd>
          <dt>Incident</dt><dd>{s.incident ? <Pill tone={stateTone(s.incident.state)}>{`${s.incident.id}: ${title(s.incident.state)}`}</Pill> : 'none open'}</dd>
          <dt>Scenario ground truth</dt><dd>{!hasSim ? '—' : !sc.fault ? 'no fault scheduled' : injected ? <><Pill tone="info">{`${title(sc.fault)} injected`}</Pill> <span className="tq-muted">known only because this is a simulation; not a diagnosis</span></> : `${title(sc.fault)} scheduled at t = ${sc.inject_after_s} s`}</dd>
        </dl>
      </Card>

      <div className="tq-split tq-mt">
        <Card title="C1 assessment" id="c-assess" right={<ProvBadge kind="DERIVED" />}>
          {!plan?.c1 ? <Empty>{hasSim ? 'Waiting for the first scored window.' : 'No simulation running.'}</Empty> : <p data-testid="c1-explain">{explain(plan)}</p>}
          <p className="tq-muted">The score is a distance from the learned healthy baseline, not a probability of a fault.</p>
        </Card>
        <Card title="Recommended next step" id="c-next-test" right={<ProvBadge kind="DERIVED" />}>
          {!post ? <Empty>No hypothesis ranking yet, so no test can be chosen. Hypotheses appear after an anomaly has persisted for {plan?.min_evidence_windows ?? 8} windows.</Empty>
            : !rec ? <Empty>No test is currently allowed for this run (see the Safety Supervisor reasons on Diagnostic Tests).</Empty>
              : !rec.worth_running ? (
                <p data-testid="next-none">No test is expected to remove at least {fmt(rec.gate_min_info_gain_nats, 2)} nats of uncertainty: the best, {rec.test}, would remove {fmt(rec.expected_info_gain_nats, 2)} nats. {post.label === 'confident' ? 'The ranking is already confident.' : 'Observing longer is the gate\'s alternative.'}</p>
              ) : (
                <div data-testid="next-test">
                  <p><strong>{spec?.name || rec.test}</strong> is expected to remove <strong className="tq-num">{fmt(rec.expected_info_gain_nats, 2)}</strong> nats of uncertainty (the gate needs ≥ {fmt(rec.gate_min_info_gain_nats, 2)}).</p>
                  <p className="tq-muted">{spec?.target}</p>
                  <p className="tq-small"><span className="tq-muted">Signals examined: </span>{spec?.signals.join(' · ')}</p>
                  <ul className="tq-list tq-small">{(TEST_OUTCOMES[rec.test] || []).map((x) => <li key={x}>{x}</li>)}</ul>
                </div>)}
          {plan?.gate && <p className="tq-small"><span className="tq-muted">Latest gate verdict: </span><Pill tone={plan.gate.verdict === 'ACT' ? 'ok' : plan.gate.verdict === 'SAFE_STOP' ? 'stop' : 'warn'}>{title(plan.gate.verdict)}</Pill> <span className="tq-muted">{plan.gate.reason}</span></p>}
          <div className="tq-row tq-mt">
            <button type="button" className="tq-btn tq-primary" onClick={() => { setWb?.((x) => ({ ...x, prefill: rec?.worth_running ? rec.test : 'profile' })); go('tests'); }} disabled={!hasSim}>
              <FlaskConical size={14} aria-hidden="true" /> Configure in Diagnostic Tests <ArrowRight size={14} aria-hidden="true" />
            </button>
          </div>
          <p className="tq-muted tq-small">Nothing runs from this page. Tests are configured and started on Diagnostic Tests.</p>
        </Card>
      </div>

      <Card title="Fault hypotheses" id="c-hyps" className="tq-mt" right={<>{post && <Pill tone={post.label === 'confident' ? 'ok' : post.label === 'ambiguous' ? 'warn' : 'info'}>{post.label}{post.ood ? ' · unlike any learned signature' : ''}</Pill>}<ProvBadge kind="DERIVED" /></>}>
        {!plan?.hypotheses?.length || !post ? <Empty>No ranking yet. The hypothesis model ranks faults only from anomalous windows; healthy windows are not evidence for any fault.</Empty> : (
          <ol className="tq-hyps" aria-label="Ranked fault hypotheses">{plan.hypotheses.map((h, i) => <HypothesisRow key={h.hypothesis} h={h} top={i === 0} />)}</ol>)}
        <p className="tq-muted">A ranking is not a confirmed fault. Bearing faults are not diagnosable with this sensor set.{post ? ` Ranked from ${post.n_windows} evidence window(s).` : ''}</p>
      </Card>

      <Card title="Evidence sufficiency and what is still unknown" id="c-unknown" className="tq-mt" right={plan?.sufficiency ? <SufficiencyBadge s={plan.sufficiency} /> : null}>
        {!plan?.sufficiency ? <Empty>{hasSim ? 'Waiting for the workbench plan.' : 'No simulation running.'}</Empty> : (
          <>
            <p data-testid="c1-sufficiency">{plan.sufficiency.reason}.</p>
            <ul className="tq-list tq-small">
              {!plan.sufficiency.c1_baseline_for_current_speed && <li>No healthy C1 baseline is learned for the current speed ({title(plan.sufficiency.c1_window_status) || 'no window'}): this speed cannot be judged against a baseline.</li>}
              {plan.sufficiency.tests.filter((t) => !t.eligible).map((t) => <li key={t.test}>{t.test} cannot run now: {t.prerequisites.filter((p) => !p.ok).map((p) => p.detail || p.check).join('; ')}.</li>)}
              <li>Bearing faults are not diagnosable with this sensor set; torque is not measured.</li>
            </ul>
          </>)}
      </Card>

      <div className="tq-mt"><InvestigationTrace d={d} focus={['observation', 'hypothesis']} /></div>
      <div className="tq-mt"><DiagnosticsPage d={d} head={false} /></div>
    </>
  );
}
