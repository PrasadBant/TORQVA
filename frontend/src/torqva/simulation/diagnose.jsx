// AI Diagnostics (C1), simulation mode: the analyst's investigation workspace. Overview (current status, top hypotheses, evidence summary,
// recommended next step) → Hypotheses → Evidence → Explainability. Everything shown comes from the simulator's records or the workbench plan;
// a hypothesis is a ranking (an AI interpretation), never a confirmed fault, and the scenario's injected fault is shown apart as ground truth.
import React, { useState } from 'react';
import { FlaskConical, ArrowRight, Activity, Gauge, Microscope, ListChecks, Compass, Workflow } from 'lucide-react';
import {
  Card, Empty, Pill, ProvBadge, fmt, stateTone, PageHead, CardLink, AlertPanel, StatTile, StatGrid, Tabs, TabPanel, LinkButton, SourceTag, CheckList,
} from '../shared/components.jsx';
import { TEST_SPECS, TEST_OUTCOMES, FEATURE_LABEL, SCORE_STATUS } from '../shared/diagnostics.js';
import { C1ScoreCard, C1GateCard, C1TimelineCard } from './analysis.jsx';
import { usePlan, title, pct } from './workbench.js';
import { TraceLink } from './trace.jsx';
import { SufficiencyBadge, SUFF } from './adaptive.jsx';

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
  return ['info', 'Reading the Anomaly Detection state…', ''];
}

function explain(plan) {
  const c1 = plan?.c1; if (!c1) return null;
  const parts = [];
  if (c1.score_over_threshold !== null) parts.push(`The latest window scores ${fmt(c1.score_over_threshold, 2)} × the threshold learned for this operating-speed range (1 = threshold).`);
  else parts.push(`The latest window was ${SCORE_STATUS[c1.status] || title(c1.status)}.`);
  if (plan.top_features?.length) parts.push(`Across the ${plan.evidence_windows} anomalous evidence window(s), the features furthest from the healthy baseline are ${plan.top_features.slice(0, 3).map((f) => `${FEATURE_LABEL[f.feature] || f.feature} (${z(f.mean_z)})`).join(', ')}.`);
  return parts.join(' ');
}

function Bar({ p }) {
  return <span className="tq-bar-track"><span className="tq-bar-fill" style={{ width: `${Math.max(0, Math.min(1, p ?? 0)) * 100}%` }} /></span>;
}

/** One ranked hypothesis. `compact` = the Overview row; otherwise the full row with the model's own per-feature evidence. */
function HypothesisRow({ h, top, compact, rank }) {
  return (
    <li className={`tq-hyp ${top ? 'is-top' : ''}`} data-testid={`hyp-${h.hypothesis}`}>
      <div className="tq-hyp-head">
        <strong><span className="tq-an-rank tq-num">{rank}</span>{title(h.hypothesis)}</strong>
        <Bar p={h.probability} />
        <span className="tq-num">{h.probability == null ? '—' : pct(h.probability, 1)}</span>
      </div>
      {!compact && (
        <details className="tq-hyp-more" open={top}>
          <summary>Evidence{h.compared_with ? ` compared with ${title(h.compared_with)}` : ''}</summary>
          <div className="tq-hyp-grid">
            <div><span className="tq-section-title">Supports it</span>
              {h.supporting?.length ? <ul className="tq-list">{h.supporting.map((x) => <li key={x.feature}>{FEATURE_LABEL[x.feature] || x.feature}: observed {z(x.observed_z)}, signature {z(x.signature_z)}</li>)}</ul> : <p className="tq-muted">none</p>}</div>
            <div><span className="tq-section-title">Contradicts it</span>
              {h.contradicting?.length ? <ul className="tq-list">{h.contradicting.map((x) => <li key={x.feature}>{FEATURE_LABEL[x.feature] || x.feature}: observed {z(x.observed_z)}, signature {z(x.signature_z)}</li>)}</ul> : <p className="tq-muted">none</p>}</div>
            <div><span className="tq-section-title">Best separating test</span>
              {h.best_separating_test ? <p>{h.best_separating_test.test} against {title(h.best_separating_test.versus)} <span className="tq-muted">(signature separation {fmt(h.best_separating_test.separation, 1)} σ)</span></p> : <p className="tq-muted">none learned</p>}</div>
          </div>
        </details>)}
    </li>
  );
}

const postTone = (post) => (post?.label === 'confident' ? 'ok' : post?.label === 'ambiguous' ? 'warn' : 'info');

export function SimDiagnosticsPage({ d, go, stale, setWb }) {
  const { plan, error } = usePlan(d);
  const [tab, setTab] = useState('overview');
  const s = d.status || {}; const w = s.last_window; const sc = s.scenario || {};
  const hasSim = s.t !== undefined && s.t !== null;
  const [tone, head, detail] = conditionOf(d, plan, stale);
  const val = (v) => (hasSim && w && w.valid !== false ? v : null);
  const injected = sc.fault && finite(s.t) && finite(sc.inject_after_s) && s.t >= sc.inject_after_s;
  const rec = plan?.recommended_test;
  const spec = rec && TEST_SPECS[rec.test];
  const post = plan?.posterior;
  const c1 = plan?.c1;
  const suff = plan?.sufficiency;
  const ranked = post && plan?.hypotheses?.length ? plan.hypotheses : [];
  const score = c1?.score_over_threshold;
  const status = !c1 ? ['off', hasSim ? 'Waiting' : 'No data', hasSim ? 'no scored window yet' : 'no simulation running']
    : score === null ? ['info', 'Not scored', SCORE_STATUS[c1.status] || title(c1.status)]
      : c1.anomalous || score > 1 ? ['warn', 'Above threshold', `abnormal for this speed: ${c1.anomalous_run} window(s) in a row`] : ['ok', 'Within learned band', 'normal for this speed range'];
  const configure = () => { setWb?.((x) => ({ ...x, prefill: rec?.worth_running ? rec.test : 'profile' })); go('tests'); };

  const recommendation = (
    <Card title="Recommendation" id="c-next-test" icon={Compass} sub="The most informative next test" right={<ProvBadge kind="DERIVED" />}>
      {!post ? <Empty>No hypothesis ranking yet, so no test can be chosen. Hypotheses appear after an anomaly has persisted for {plan?.min_evidence_windows ?? 8} windows. Until then, keep monitoring.</Empty>
        : !rec ? <Empty>No test is currently allowed for this run (see the Safety Supervisor reasons on Diagnostic Investigation).</Empty>
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
      <div className="tq-row tq-mt tq-an-actions">
        <button type="button" className="tq-btn tq-primary" onClick={configure} disabled={!hasSim}>
          <FlaskConical size={14} aria-hidden="true" /> Configure in Diagnostic Investigation <ArrowRight size={14} aria-hidden="true" />
        </button>
        <LinkButton onClick={() => go('workflow')}>Open the guided Diagnostic Workflow</LinkButton>
      </div>
    </Card>);

  return (
    <>
      <PageHead title="Anomaly Detection" sub="Unusual behaviour, its likely causes and the evidence."
        right={<><ProvBadge kind="SIMULATED" /><Pill tone={tone}>{head}</Pill></>} />
      <div className="tq-an-page">
        <AlertPanel tone={tone} title={head} testid="c1-condition">{detail || null}</AlertPanel>
        {error && error !== 'unavailable' && hasSim && <p className="tq-callout warn">The workbench plan could not be loaded: {error}</p>}

        <StatGrid label="Anomaly Detection summary">
          <StatTile icon={Gauge} tone={status[0]} label="Current status" value={status[1]} sub={status[2]} testid="c1-tile-status" />
          <StatTile icon={Activity} tone={!c1 || score === null ? 'off' : score > 1 ? 'warn' : 'ok'} label="Anomaly severity" value={c1 && score !== null ? fmt(score, 2) : '—'} unit={c1 && score !== null ? '× threshold' : undefined}
            sub={c1 ? `threshold = 1 · incident after ${c1.confirm_windows} windows in a row` : 'distance from the learned healthy baseline'} />
          <StatTile icon={Microscope} tone={post ? postTone(post) : 'off'} label="Top hypothesis (AI interpretation)" value={post ? title(post.top) : 'None yet'} unit={post ? pct(post.top_p, 0) : undefined}
            sub={post ? `${post.label}${post.ood ? ', unlike any learned signature' : ''} · not a confirmed fault` : 'ranked only after an anomaly persists'} />
          <StatTile icon={ListChecks} tone={suff ? (SUFF[suff.status]?.[0] || 'off') : 'off'} label="Evidence" value={suff ? title(SUFF[suff.status]?.[1] || suff.status).toLowerCase().replace(/^\w/, (x) => x.toUpperCase()) : '—'}
            sub={post ? `${post.n_windows} evidence window(s)` : hasSim ? `${plan?.evidence_windows ?? 0} anomalous window(s) so far` : 'no simulation running'} />
        </StatGrid>

        <Tabs label="Anomaly Detection views" idBase="c1-tab" value={tab} onChange={setTab}
          tabs={[{ key: 'overview', label: 'Overview' }, { key: 'hypotheses', label: 'Hypotheses', count: ranked.length || undefined }, { key: 'evidence', label: 'Evidence' }, { key: 'explain', label: 'Explainability' }]} />

        {tab === 'overview' && (
          <TabPanel tab="overview" idBase="c1-tab">
            <div className="tq-an-grid tq-an-grid-3">
              <Card title="Current status" id="c-assess" icon={Gauge} right={<SourceTag kind="SIMULATED" />}>
                {!c1 ? <Empty>{hasSim ? 'Waiting for the first scored window.' : 'No simulation running.'}</Empty> : <p data-testid="c1-explain">{explain(plan)}</p>}
                {/* One compact list of the current readings (trends live on Live Monitor); a missing value reads UNAVAILABLE, never 0. */}
                <dl className="tq-readings" data-testid="c1-kpis">
                  {[['Speed', w?.rpm, 'rpm', 0], ['Current', w?.current, 'A', 2], ['Supply voltage', w?.voltage, 'V', 2], ['Housing', w?.housing, '°C', 1], ['Vibration RMS', w?.vib_rms, 'g', 3]].map(([l, v, u, dg]) => (
                    <div key={l}><dt>{l}</dt><dd className="tq-num">{val(v) == null ? 'UNAVAILABLE' : `${fmt(v, dg)} ${u}`}</dd><ProvBadge kind="SIMULATED" /></div>))}
                  {hasSim && <div><dt>Setpoint</dt><dd className="tq-num">{fmt(s.device?.setpoint_rpm, 0)} rpm</dd></div>}
                </dl>
                <p className="tq-muted tq-small">Data quality: {!w ? 'no window yet' : w.valid === false ? 'the latest window is invalid' : 'the latest window is valid'}. Severity is a distance from the healthy baseline, not a fault probability.</p>
              </Card>
              <Card title="Top hypotheses" id="c-hyps" icon={Microscope} sub="AI interpretation, not proof"
                right={<span className="tq-an-right">{post && <Pill tone={postTone(post)}>{post.label}{post.ood ? ' · unlike any learned signature' : ''}</Pill>}<ProvBadge kind="DERIVED" /></span>}
                foot={ranked.length > 0 ? <LinkButton onClick={() => setTab('hypotheses')}>All hypotheses and their evidence</LinkButton> : null}>
                {!ranked.length ? <Empty>No ranking yet. The hypothesis model ranks faults only from anomalous windows; healthy windows are not evidence for any fault.</Empty> : (
                  <ol className="tq-hyps" aria-label="Top fault hypotheses">{ranked.slice(0, 4).map((h, i) => <HypothesisRow key={h.hypothesis} h={h} top={i === 0} rank={i + 1} compact />)}</ol>)}
                <p className="tq-muted tq-small">A ranking, not a confirmed fault.{post ? ` Ranked from ${post.n_windows} evidence window(s).` : ''}</p>
              </Card>
              <Card title="Evidence summary" id="c-ev-sum" icon={ListChecks} right={suff ? <SufficiencyBadge s={suff} /> : null}>
                <h4 className="tq-an-h">Measured deviations <SourceTag kind="DERIVED" /></h4>
                {plan?.top_features?.length ? (
                  <ul className="tq-an-feats">{plan.top_features.slice(0, 4).map((f) => <li key={f.feature}><span>{FEATURE_LABEL[f.feature] || f.feature}</span><strong className="tq-num">{z(f.mean_z)}</strong></li>)}</ul>
                ) : <p className="tq-muted tq-small">{hasSim ? 'No anomalous evidence windows yet: nothing deviates enough to analyse.' : 'No simulation running.'}</p>}
                {ranked[0] && (ranked[0].supporting?.length > 0 || ranked[0].contradicting?.length > 0) && (
                  <CheckList dense label={`Evidence for and against ${title(ranked[0].hypothesis)}`} items={[
                    ...ranked[0].supporting.slice(0, 2).map((x) => ({ key: `s${x.feature}`, label: FEATURE_LABEL[x.feature] || x.feature, state: 'ok', status: 'supports', detail: `observed ${z(x.observed_z)}, signature ${z(x.signature_z)}` })),
                    ...ranked[0].contradicting.slice(0, 2).map((x) => ({ key: `c${x.feature}`, label: FEATURE_LABEL[x.feature] || x.feature, state: 'warn', status: 'contradicts', detail: `observed ${z(x.observed_z)}, signature ${z(x.signature_z)}` }))]} />)}
                {suff && <p className="tq-small" data-testid="c1-sufficiency"><span className="tq-muted">Sufficiency: </span>{suff.reason}.</p>}
              </Card>
            </div>
            <div className="tq-mt">{recommendation}</div>
          </TabPanel>)}

        {tab === 'hypotheses' && (
          <TabPanel tab="hypotheses" idBase="c1-tab">
            <Card title="Fault hypotheses" id="c-hyps-all" icon={Microscope} sub="Each with the evidence for and against it"
              right={<span className="tq-an-right">{post && <Pill tone={postTone(post)}>{post.label}{post.ood ? ' · unlike any learned signature' : ''}</Pill>}<ProvBadge kind="DERIVED" /></span>}>
              {!ranked.length ? <Empty>No ranking yet. The hypothesis model ranks faults only from anomalous windows; healthy windows are not evidence for any fault.</Empty> : (
                <ol className="tq-hyps" aria-label="Ranked fault hypotheses">{ranked.map((h, i) => <HypothesisRow key={h.hypothesis} h={h} top={i === 0} rank={i + 1} />)}</ol>)}
              <p className="tq-muted">Bearing faults cannot be diagnosed with this sensor set.{post ? ` Ranked from ${post.n_windows} evidence window(s); margin ${fmt(post.margin, 2)} between the top two.` : ''}</p>
            </Card>
          </TabPanel>)}

        {tab === 'evidence' && (
          <TabPanel tab="evidence" idBase="c1-tab">
            <C1ScoreCard d={d} />
            <div className="tq-an-grid tq-mt">
              <Card title="Operating condition" id="c-cond" right={<ProvBadge kind="SIMULATED" />}>
                <dl className="tq-kv">
                  <dt>Anomaly window status</dt><dd>{c1 ? <Pill tone={c1.score_over_threshold === null ? 'info' : c1.anomalous ? 'warn' : 'ok'}>{title(c1.status)}</Pill> : '—'}</dd>
                  <dt>Score ÷ learned threshold</dt><dd className="tq-num">{c1 ? fmt(c1.score_over_threshold, 2) : '—'}</dd>
                  <dt>Anomalous windows in a row</dt><dd className="tq-num">{c1 ? `${c1.anomalous_run} (incident at ${c1.confirm_windows})` : '—'}</dd>
                  <dt>Incident</dt><dd>{s.incident ? <Pill tone={stateTone(s.incident.state)}>{`${s.incident.id}: ${title(s.incident.state)}`}</Pill> : 'none open'}</dd>
                  <dt>Scenario ground truth</dt><dd>{!hasSim ? '—' : !sc.fault ? 'no fault scheduled' : injected ? <><Pill tone="info">{`${title(sc.fault)} injected`}</Pill> <span className="tq-muted">known only because this is a simulation; not a diagnosis</span></> : `${title(sc.fault)} scheduled at t = ${sc.inject_after_s} s`}</dd>
                </dl>
                <CardLink onClick={() => go('live')}>See the readings as trends on Live Monitor</CardLink>
              </Card>
              <Card title="Evidence quality and what is still unknown" id="c-unknown" right={suff ? <SufficiencyBadge s={suff} /> : null}>
                {!suff ? <Empty>{hasSim ? 'Waiting for the workbench plan.' : 'No simulation running.'}</Empty> : (
                  <>
                    <p>{suff.reason}.</p>
                    <ul className="tq-list tq-small">
                      {!suff.c1_baseline_for_current_speed && <li>No healthy baseline is learned for the current speed ({title(suff.c1_window_status) || 'no window'}): this speed cannot be judged against a baseline.</li>}
                      {suff.tests.filter((t) => !t.eligible).map((t) => <li key={t.test}>{t.test} cannot run now: {t.prerequisites.filter((p) => !p.ok).map((p) => p.detail || p.check).join('; ')}.</li>)}
                      <li>Bearing faults are not diagnosable with this sensor set; torque is not measured.</li>
                    </ul>
                  </>)}
              </Card>
            </div>
          </TabPanel>)}

        {tab === 'explain' && (
          <TabPanel tab="explain" idBase="c1-tab">
            <Card title="How Anomaly Detection reaches this reading" id="c-how" icon={Workflow}>
              <ol className="tq-list tq-small">
                <li>Each 1 s simulated window is turned into features (vibration orders, current per rpm, thermal residual …) and compared with the healthy baseline learned for its speed range. The score ÷ threshold is that distance; 1 is the learned threshold.</li>
                <li>{c1 ? `An incident opens after ${c1.confirm_windows} consecutive windows above the threshold.` : 'An incident opens after several consecutive windows above the threshold.'} Windows taken while speed changes, or at an unlearned speed, are not scored.</li>
                <li>Only the anomalous windows are passed to the hypothesis model, which ranks fault classes by their learned signatures (z-scores per feature). The ranking is labelled confident, ambiguous or unfamiliar by the backend.</li>
                <li>The decision gate uses the ranking, the prediction trust and the evidence count to choose: act, test, wait for data or escalate. Its inputs are listed below.</li>
              </ol>
              {plan?.top_features?.length > 0 && (
                <div className="tq-table-wrap"><table className="tq-table tq-small"><caption>Features furthest from the healthy baseline (mean over the evidence windows)</caption>
                  <thead><tr><th scope="col">Feature</th><th scope="col">Mean z</th></tr></thead>
                  <tbody>{plan.top_features.map((f) => <tr key={f.feature}><th scope="row">{FEATURE_LABEL[f.feature] || f.feature}</th><td className="tq-num">{z(f.mean_z)}</td></tr>)}</tbody></table></div>)}
            </Card>
            <div className="tq-split tq-mt"><C1GateCard d={d} /><C1TimelineCard d={d} /></div>
          </TabPanel>)}

        <TraceLink go={go} setWb={setWb} stages={['observation', 'hypothesis']} testid="c1-trace" />
      </div>
    </>
  );
}
