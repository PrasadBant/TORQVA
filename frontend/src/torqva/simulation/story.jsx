// Incident story: one simulated incident from injection to resolution, built only from this run's records (/log, /outcomes, /status).
// Scenario ground truth, TORQVA's diagnosis, the C2 prediction and the observed outcome are shown side by side and never merged.
import React, { useState } from 'react';
import { Card, Empty, Pill, ProvBadge, fmt } from '../shared/components.jsx';
import { incidentIds, title, outcomeTone } from './pipeline.js';
import { EventTimeline } from './events.jsx';

const lastWhere = (xs, f) => { for (let i = (xs || []).length - 1; i >= 0; i--) if (f(xs[i])) return xs[i]; return null; };

export function IncidentStory({ d }) {
  const ids = incidentIds(d.log);
  const [pick, setPick] = useState(null);
  const id = pick && ids.includes(pick) ? pick : ids[ids.length - 1];
  const s = d.status || {}; const sc = s.scenario || {};
  if (!id) return (
    <Card title="Incident story" id="c-story" right={<ProvBadge kind="SIMULATED" />}>
      <Empty>No incident in this run's log yet. When C1 opens one, its path from injection to resolution appears here.</Empty>
    </Card>);
  const L = (d.log || []).filter((l) => l.incident === id);
  const of = (k) => lastWhere(L, (l) => l.kind === k);
  const opened = of('incident_opened'); const closed = of('incident_closed');
  const hyp = of('hypotheses'); const test = of('test_result'); const rank = of('c2_ranking');
  const out = lastWhere(d.outcomes, (o) => o.incident === id);
  const post = test?.posterior || hyp?.ranked;
  const top = post?.[0]?.[0];
  const truth = sc.fault || null;
  const match = !top ? 'no diagnosis yet' : !truth ? `diagnosed ${title(top)}; the scenario injected no fault` : top === truth ? 'top hypothesis matches the injected fault' : `top hypothesis differs from the injected fault`;
  const open = s.incident?.id === id;
  return (
    <Card title="Incident story" id="c-story" right={<><Pill tone={open ? 'wait' : closed ? 'off' : 'info'}>{open ? `open: ${title(s.incident.state)}` : closed ? `closed: ${title(closed.final)}` : 'record incomplete'}</Pill><ProvBadge kind="SIMULATED" /></>}>
      {ids.length > 1 && (
        <label className="tq-inline">Incident <select value={id} onChange={(e) => setPick(e.target.value)}>{ids.map((x) => <option key={x} value={x}>{x}</option>)}</select></label>)}
      <div className="tq-story-cols" data-testid="story-cols">
        <section className="tq-story-col is-truth" aria-label="Scenario ground truth">
          <span className="tq-section-title">Scenario ground truth</span>
          <strong>{truth ? title(truth) : 'no fault injected'}</strong>
          <span className="tq-muted">{truth ? `severity ${fmt(sc.severity, 2)}, from t = ${sc.inject_after_s} s` : `seed ${sc.seed ?? '—'}`}</span>
          <span className="tq-muted tq-small">Defined by the scenario, known only because this is a simulation.</span>
        </section>
        <section className="tq-story-col is-ai" aria-label="TORQVA diagnosis">
          <span className="tq-section-title">TORQVA diagnosis <ProvBadge kind="DERIVED" /></span>
          <strong>{top ? `${title(top)} ${fmt(post[0][1] * 100, 0)}%` : 'none yet'}</strong>
          <span className="tq-muted">{test ? `after test ${test.test}` : hyp ? `${hyp.label} ranking at t = ${fmt(hyp.t, 0)} s` : 'no ranking logged'}</span>
          <span className="tq-muted tq-small" data-testid="story-match">{match}</span>
        </section>
        <section className="tq-story-col is-pred" aria-label="Predicted outcome">
          <span className="tq-section-title">Predicted (C2) <ProvBadge kind="PREDICTED" /></span>
          <strong>{rank?.chosen ? title(rank.chosen) : out?.predicted_top ? title(out.predicted_top) : 'no prediction'}</strong>
          <span className="tq-muted">{rank ? `lowest predicted risk of ${(rank.ranking || []).length} action(s)` : 'C2 did not rank actions for this incident'}</span>
          <span className="tq-muted tq-small">A prediction is never evidence of recovery.</span>
        </section>
        <section className="tq-story-col is-obs" aria-label="Observed outcome">
          <span className="tq-section-title">Observed (C5) <ProvBadge kind="SIMULATED" /></span>
          <strong>{out ? <Pill tone={outcomeTone(out.outcome)}>{title(out.outcome)}</Pill> : 'not verified'}</strong>
          <span className="tq-muted">{out ? `action ${out.action || '—'} · acknowledged ${out.command_executed ? 'yes' : 'no'} · ${out.n_fresh ?? 0} fresh sample(s)` : open ? 'verification has not finished' : 'no verdict recorded'}</span>
          {out?.observed?.rpm !== undefined && <span className="tq-muted tq-small tq-num">after the action: {fmt(out.observed.rpm, 0)} rpm, {fmt(out.observed.housing, 1)} °C, {fmt((out.observed.frac_in_band ?? NaN) * 100, 0)}% in band</span>}
        </section>
      </div>
      {out && (
        <div className="tq-subpanel">
          <span className="tq-subpanel-title">Why: {title(out.outcome)}</span>
          <p className="tq-muted">{(out.reasons || []).map(title).join(', ') || 'no reason recorded'}</p>
          {Object.keys(out.criteria || {}).length > 0 && <ul className="tq-list">{Object.entries(out.criteria).map(([k, v]) => <li key={k}><Pill tone={v ? 'ok' : 'crit'}>{v ? 'pass' : 'fail'}</Pill> {title(k)}</li>)}</ul>}
        </div>)}
      <p className="tq-section-title tq-mt">Sequence {opened ? `(opened at t = ${fmt(opened.t, 0)} s)` : ''}</p>
      <EventTimeline log={d.log} incident={id} limit={40} />
    </Card>
  );
}
