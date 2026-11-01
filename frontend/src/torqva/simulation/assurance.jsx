// Simulation decision and assurance pages: the approval card, C3 action history, C5 recovery verification and C6 learning.
// Everything shown here is read from the backend's records (status, log, decisions, predictions, commands, outcomes, cases); nothing is
// inferred from a command's HTTP success, and a missing value reads "—", never zero.
import React from 'react';
import { Check, X, ShieldCheck, ListChecks, Gauge, Database, ArrowLeftRight, History } from 'lucide-react';
import { Card, Empty, ErrorBox, Pill, ProvBadge, fmt, fmtRpm, title, pct, PageHead, Disclosure, canControl, AlertPanel, CheckList, DataTable, MetricList, LinkButton } from '../shared/components.jsx';
import { IncidentStory } from './story.jsx';
import { isPhysOf } from './simdata.js';

const lastOf = (xs, f) => { for (let i = (xs || []).length - 1; i >= 0; i--) if (f(xs[i])) return xs[i]; return null; };
const SUP_TONE = (v) => (v === 'ALLOW' ? 'ok' : v === 'DEFER' ? 'wait' : 'crit');
const GATE_TONE = (v) => (v === 'ACT' ? 'ok' : v === 'SAFE_STOP' ? 'stop' : v === 'SENSOR_UNRELIABLE' ? 'crit' : 'warn');
const CMD_TONE = (s) => (['ACCEPTED', 'COMPLETED'].includes(s) ? 'ok' : s === 'PENDING' ? 'wait' : 'crit');

/** The C2 prediction recorded for exactly this proposal: the same action and, for a speed change, the same target. Null when none matches,
 *  so a prediction for a different target is never shown as the expected outcome of this one. */
export function predictionFor(d, action, rpm) {
  const ps = (d.predictions || []).filter((p) => p.action === action);
  if (action !== 'REDUCE_SPEED' && action !== 'SET_SPEED') return ps[ps.length - 1] || null;
  return lastOf(ps, (p) => Number.isFinite(rpm) && Math.abs(Number(p.target_rpm) - rpm) < 0.5);
}

// The decision gate's own recorded preconditions (GET /decisions → inputs), shown as recorded: [key, label, value that is favourable].
const GATE_CHECKS = [
  ['mandatory_stop', 'Mandatory-stop condition present', false], ['data_ok', 'Data quality sufficient', true], ['sensor_unreliable', 'Sensors flagged unreliable', false],
  ['ood', 'Operating data outside the training range', false], ['conflict', 'Conflicting evidence', false], ['c2_trusted', 'C2 prediction trusted', true],
  ['op_point_familiar', 'Operating point learned by C1', true],
];
const PRED_SIGNALS = [['rpm', 'Speed', 'rpm', 0], ['housing', 'Housing temperature', '°C', 1], ['vib_rms', 'Vibration RMS', 'g', 3], ['current', 'Current', 'A', 2]];

/** Expected outcome of one action, exactly as C2 returned it (mean at +30/+60/+120 s and the 90 % interval at +120 s). PREDICTED, never observed. */
function ExpectedOutcome({ p }) {
  const m = p.mean_at_30_60_120 || {};
  const rows = PRED_SIGNALS.filter(([k]) => Array.isArray(m[k]));
  return (
    <div className="tq-as-expect">
      <div className="tq-as-subhead"><span className="tq-section-title">Expected outcome <ProvBadge kind="PREDICTED" /></span>
        <Pill tone={p.status === 'supported' ? 'ok' : 'warn'}>{p.status === 'supported' ? 'supported' : `${title(p.status)}: cannot drive a decision`}</Pill></div>
      {!rows.length ? <p className="tq-muted tq-small">C2 returned no trajectory for this action.</p> : (
        <div className="tq-table-wrap"><table className="tq-table tq-as-compact"><caption className="tq-sr">C2 predicted outcome of the proposed action</caption>
          <thead><tr><th scope="col">Signal</th><th scope="col" className="tq-th-num">+30 s</th><th scope="col" className="tq-th-num">+60 s</th><th scope="col" className="tq-th-num">+120 s</th><th scope="col" className="tq-th-num">90 % interval at +120 s</th></tr></thead>
          <tbody>{rows.map(([k, n, u, dg]) => (
            <tr key={k}><th scope="row">{n} <span className="tq-muted">({u})</span></th>{m[k].slice(0, 3).map((v, i) => <td key={i} className="tq-num tq-td-num">{fmt(v, dg)}</td>)}
              <td className="tq-num tq-td-num">{p.lo_120?.[k] !== undefined && p.hi_120?.[k] !== undefined ? `${fmt(p.lo_120[k], dg)}–${fmt(p.hi_120[k], dg)}` : '—'}</td></tr>))}</tbody></table></div>)}
      <p className="tq-chart-note">Predicted at t = {fmt(p.predicted_at, 0)} s. A prediction is not a measurement and never authorises an action{p.validated_by_experiments === false ? '; C2 is not validated by intervention experiments' : ''}.
        {p.status_reasons?.length ? ` Reasons: ${p.status_reasons.map(title).join(', ')}.` : ''}</p>
    </div>
  );
}

/* ------------------------------------------------------------------ 6. Interventions (C3) */
/** The pipeline's action held for a human decision: what is proposed, why (gate and Safety Supervisor records), the risk fields the backend
 *  recorded, the C2 expected outcome for exactly this action, and Approve / Reject. Approving re-runs the Safety Supervisor on the backend. */
export function ApprovalCard({ d, role, actions, error, busy = false }) {
  const pend = d.status?.pending_approval; const ctl = canControl(role);
  const incId = d.status?.incident?.id;
  const log = d.log || [];
  const mine = (l) => !incId || l.incident === incId;
  const sup = pend ? lastOf(log, (l) => l.kind === 'supervisor' && l.action === pend.action && mine(l)) : null;
  const gate = lastOf(log, (l) => l.kind === 'gate' && mine(l));
  const inputs = lastOf(d.decisions, (x) => x.inputs)?.inputs || {};
  const rpm = Number(pend?.params?.rpm);
  const p = pend ? predictionFor(d, pend.action, rpm) : null;
  const checks = GATE_CHECKS.filter(([k]) => typeof inputs[k] === 'boolean')
    .map(([k, label, good]) => ({ key: k, label, state: inputs[k] === good ? 'ok' : 'fail', status: inputs[k] ? 'yes' : 'no' }));
  const bySignal = Object.entries(p?.risk_by_signal || {});
  return (
    <Card title="Proposed action" id="c-appr" icon={ShieldCheck} className="tq-as-appr" sub={pend ? 'Held by the pipeline for a human decision' : undefined}
      right={pend ? <Pill tone="wait">decision required</Pill> : null}>
      {!pend ? <Empty>No action is waiting for approval.</Empty> : (
        <div data-testid="approval">
          <div className="tq-as-proposal">
            <div className="tq-as-proposal-main">
              <span className="tq-as-kicker">Proposed by the pipeline{incId ? ` · ${incId}` : ''}</span>
              <strong className="tq-as-action">{title(pend.action)}{' '}
                <span className="tq-num">{pend.params?.rpm ? `to ${fmtRpm(pend.params.rpm)} rpm` : Object.keys(pend.params || {}).length ? JSON.stringify(pend.params) : ''}</span></strong>
            </div>
            <div className="tq-row">
              {gate && <Pill tone={GATE_TONE(gate.verdict)}>{`Gate: ${title(gate.verdict)}`}</Pill>}
              {sup && <Pill tone={SUP_TONE(sup.verdict)}>{`Supervisor: ${sup.verdict}`}</Pill>}
            </div>
          </div>
          <div className="tq-as-cols">
            <section aria-label="Rationale">
              <span className="tq-section-title">Rationale</span>
              <ul className="tq-as-bullets">
                <li><span className="tq-muted">Pipeline:</span> {pend.rationale || '—'}</li>
                {gate && <li><span className="tq-muted">Decision gate:</span> {gate.reason}</li>}
                {sup && <li><span className="tq-muted">Safety Supervisor:</span> {sup.verdict}{sup.reasons?.length ? ` (${sup.reasons.map(title).join(', ')})` : ''}</li>}
              </ul>
            </section>
            <section aria-label="Risk assessment">
              <span className="tq-section-title">Risk assessment</span>
              {p ? (
                <MetricList label="C2 predicted risk" items={[
                  { key: 'risk', label: 'Predicted risk within 120 s', value: pct(p.risk, 0) === '—' ? null : pct(p.risk, 0), prov: 'PREDICTED' },
                  ...bySignal.map(([k, v]) => ({ key: k, label: `… from ${title(k)}`, value: pct(v, 0) === '—' ? null : pct(v, 0) }))]} />
              ) : <p className="tq-muted tq-small">No C2 prediction is recorded for this exact action and target, so no predicted risk is shown.</p>}
              {checks.length > 0 && <><span className="tq-as-minor">Gate preconditions (as recorded)</span><CheckList dense label="Gate preconditions" items={checks} /></>}
            </section>
          </div>
          {p && <ExpectedOutcome p={p} />}
          <div className="tq-as-decide">
            <div className="tq-row">
              <button type="button" className="tq-btn tq-primary" onClick={actions.approve} disabled={!ctl || busy}><Check size={14} aria-hidden="true" /> Approve</button>
              <button type="button" className="tq-btn tq-danger" onClick={actions.reject} disabled={!ctl || busy}><X size={14} aria-hidden="true" /> Reject</button>
            </div>
            <p className="tq-muted tq-small">Approving re-runs the Safety Supervisor on the current state before anything is sent. Only a simulated-device acknowledgement counts as executed, and only C5 declares recovery.</p>
          </div>
          {!ctl && <p className="tq-muted">Approving requires role operator or admin.</p>}
        </div>)}
      <ErrorBox error={error} />
    </Card>
  );
}

/** Action history (C3): the gate's latest verdict, the Safety Supervisor's decisions and every command with the device's acknowledgement. */
export function InterventionsPage({ d, role, actions, error, isPhys: isPhysProp, head = true, busy }) {
  const isPhys = isPhysProp ?? isPhysOf(d);
  const provKind = isPhys ? 'MEASURED' : 'SIMULATED';
  const gate = lastOf(d.decisions, (x) => x.inputs);
  const sup = (d.log || []).map((l, i) => ({ ...l, _i: i })).filter((l) => l.kind === 'supervisor').slice(-12).reverse();
  const cmds = (d.commands || []).filter((c) => c.action !== 'HEARTBEAT').slice(-20).reverse();
  return (
    <>
      {head && <PageHead title="Interventions (C3)" sub="What the system proposes, what the gate and Safety Supervisor decided, and what the device acknowledged." right={<ProvBadge kind={provKind} />} />}
      {head && <p className="tq-callout" role="note">This page never commands a motor directly. Every action passes the decision gate and the deterministic Safety Supervisor on the backend; the frontend can only approve or reject what the backend proposes.</p>}
      {head && <div className="tq-mb"><ApprovalCard d={d} role={role} actions={actions} error={error} busy={busy} /></div>}
      <div className="tq-stack">
        <Card title="Commands and device acknowledgements" id="c-cmd" icon={ListChecks} sub="An HTTP 200 only means a command was dispatched; only a device acknowledgement counts." right={<ProvBadge kind={provKind} />}>
          <DataTable caption="Commands and device acknowledgements" rows={cmds} rowKey={(c) => `${c.session ?? ''}-${c.id}`} empty="No commands sent in this run."
            columns={[
              { key: 'id', label: '#', align: 'num', sort: (c) => c.id },
              { key: 'action', label: 'Action', render: (c) => title(c.action) },
              { key: 'target', label: 'Target', align: 'num', render: (c) => (c.params?.rpm !== undefined ? `${fmtRpm(c.params.rpm)} rpm` : '—') },
              { key: 'incident', label: 'Incident', render: (c) => c.incident || '—' },
              { key: 'status', label: 'Device status', render: (c) => <><Pill tone={CMD_TONE(c.status)}>{c.status}</Pill>{c.reason && <span className="tq-muted"> {c.reason}</span>}</> },
              { key: 'eff', label: 'Took effect', render: (c) => (c.counts_as_executed ? 'yes (acknowledged by device)' : 'no') },
            ]} />
        </Card>
        <div className="tq-split">
          <Card title="Safety Supervisor decisions" id="c-sup" icon={ShieldCheck} sub="Most recent first" right={<ProvBadge kind={provKind} />}>
            <DataTable caption="Safety Supervisor decisions" rows={sup} rowKey={(x) => x._i} empty="No Safety Supervisor decisions yet."
              columns={[
                { key: 't', label: 't (s)', align: 'num', render: (x) => fmt(x.t, 0) },
                { key: 'action', label: 'Action', render: (x) => title(x.action) },
                { key: 'verdict', label: 'Verdict', render: (x) => <Pill tone={SUP_TONE(x.verdict)}>{x.verdict}</Pill> },
                { key: 'reasons', label: 'Reasons', render: (x) => <span className="tq-muted">{(x.reasons || []).map(title).join(', ') || '—'}</span> },
              ]} />
          </Card>
          <Card title="Decision gate" id="c-gate" icon={Gauge} sub="Latest verdict" right={<ProvBadge kind={provKind} />}>
            {!gate ? <Empty>The gate has not evaluated yet.</Empty> : (
              <><p className="tq-as-verdict"><Pill tone={GATE_TONE(gate.verdict)}>{title(gate.verdict)}</Pill></p><p>{gate.reason}</p>
                <Disclosure summary="Inspect gate inputs" meta={`${Object.keys(gate.inputs).length} recorded inputs`} testid="gate-inputs">
                  <table className="tq-table"><caption className="tq-sr">Gate preconditions</caption><tbody>{Object.entries(gate.inputs).map(([k, v]) => (<tr key={k}><th scope="row">{title(k)}</th><td className="tq-num">{String(v)}</td></tr>))}</tbody></table>
                </Disclosure></>)}
          </Card>
        </div>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ 7. Recovery verification (C5) */
/** The current recovery state, from the incident state and the latest C5 outcome only. A command's success is never read as recovery. */
export function recoveryStatus(d) {
  const s = d.status || {}; const inc = s.incident;
  const outs = d.outcomes || []; const last = outs[outs.length - 1] || null;
  if (inc?.state === 'VERIFYING_RECOVERY') return { tone: 'wait', head: 'Verifying recovery', text: `C5 is collecting fresh samples for ${inc.id} after the device acknowledged the action; the simulation must keep running.`, to: ['interventions', 'View the action on Interventions'] };
  if (inc && (!last || last.incident !== inc.id)) return { tone: 'info', head: 'Not in recovery', text: `Incident ${inc.id} is open (${title(inc.state)}). No action for it has been verified yet.`, to: ['interventions', 'Open Interventions'] };
  if (!last) return { tone: 'off', head: 'Not in recovery', text: 'No action has been verified in this run. Recovery is assessed only after the device acknowledges an action.', to: null };
  if (last.outcome === 'RECOVERED') return { tone: 'ok', head: 'Recovery verified', text: `${last.incident}: from ${last.n_fresh} fresh window(s) after the acknowledged ${title(last.action)}. Keep monitoring.`, to: ['live', 'Open Live Monitor'], last };
  if (last.outcome === 'UNRESOLVED') return { tone: 'crit', head: 'Condition persists', text: `${last.incident}: the action did not resolve it. Re-run the diagnosis.`, to: ['workflow', 'Run the Diagnostic Workflow'], last };
  if (last.outcome === 'HUMAN_INSPECTION_REQUIRED') return { tone: 'warn', head: 'Human inspection required', text: `${last.incident}: C5 cannot decide from the data; a person must inspect the motor.`, to: null, last };
  return { tone: 'warn', head: `Recovery not verified: ${title(last.outcome)}`, text: `${last.incident}: ${(last.reasons || []).map(title).join(', ') || 'no reason recorded'}.`, to: ['workflow', 'Run the Diagnostic Workflow'], last };
}

/** Observed values just before the action (the last telemetry sample at or before the decision) and in C5's fresh window after it, with the
 *  C2 prediction for the same incident. Values outside the recent telemetry buffer read "—". */
function BeforeAfter({ d, o, provKind }) {
  const L = (d.log || []).filter((l) => l.incident === o.incident);
  const tAct = lastOf(L, (l) => l.kind === 'transition' && ['APPROVED', 'ACTION_PROPOSED'].includes(l.event))?.t;
  const samples = d.telemetry?.samples || [];
  const pre = Number.isFinite(tAct) ? lastOf(samples, (w) => w.t <= tAct) : null;
  const pc = lastOf(d.predictionChecks, (x) => x.incident === o.incident && Array.isArray(x.rows) && x.rows.length);
  const predAt = (sig) => { const rs = (pc?.rows || []).filter((r) => r.signal === sig); return rs.length ? rs.reduce((a, b) => (b.horizon_s > a.horizon_s ? b : a)) : null; };
  const ob = o.observed || {};
  const rows = [
    ['Speed', 'rpm', 0, pre?.rpm, ob.rpm, predAt('rpm')],
    ['Housing temperature', '°C', 1, pre?.housing, ob.housing, predAt('housing')],
    ['Windows inside the learned band', '%', 0, undefined, Number.isFinite(ob.frac_in_band) ? ob.frac_in_band * 100 : undefined, null],
    ['Anomaly score ÷ threshold (mean)', '', 2, undefined, ob.score_over_threshold_mean, null],
    ['Score trend per minute', '', 2, undefined, ob.trend_per_min, null],
  ].filter((r) => r[3] !== undefined || r[4] !== undefined || r[5]);
  const v = (x, dg) => (x === null || x === undefined || !Number.isFinite(Number(x)) ? '—' : fmt(x, dg));
  return (
    <Card title="Before and after the action" id="c-prepost" icon={ArrowLeftRight} sub={`${o.incident} · observed values; the prediction is shown separately`} right={<ProvBadge kind={provKind} />}>
      {!rows.length ? <Empty>C5 recorded no observed values for this outcome.</Empty> : (
        <div className="tq-table-wrap"><table className="tq-table" data-testid="rec-prepost"><caption className="tq-sr">Observed before and after the action, and the C2 prediction</caption>
          <thead><tr><th scope="col">Signal</th><th scope="col" className="tq-th-num">Before (observed)</th><th scope="col" className="tq-th-num">After (observed)</th><th scope="col" className="tq-th-num">C2 predicted <ProvBadge kind="PREDICTED" /></th></tr></thead>
          <tbody>{rows.map(([n, u, dg, a, b, p]) => (
            <tr key={n}><th scope="row">{n}{u && <span className="tq-muted"> ({u})</span>}</th><td className="tq-num tq-td-num">{v(a, dg)}</td><td className="tq-num tq-td-num">{v(b, dg)}</td>
              <td className="tq-num tq-td-num">{p ? `${fmt(p.predicted, dg)} at +${p.horizon_s} s` : '—'}</td></tr>))}</tbody></table></div>)}
      <p className="tq-chart-note">Before: the last {provKind === 'MEASURED' ? 'measured' : 'simulated'} sample at the decision{Number.isFinite(tAct) ? ` (t = ${fmt(tAct, 0)} s)` : ''}{pre ? '' : ', not in the recent telemetry buffer'}. After: C5's fresh window after the acknowledgement. A prediction is never evidence of recovery.</p>
    </Card>
  );
}

export function RecoveryPage({ d, isPhys: isPhysProp, go }) {
  const isPhys = isPhysProp ?? isPhysOf(d);
  const provKind = isPhys ? 'MEASURED' : 'SIMULATED';
  const outs = (d.outcomes || []).slice().reverse();
  const st = recoveryStatus(d);
  const last = outs[0];
  const crit = last ? Object.entries(last.criteria || {}) : [];
  const items = last ? [
    { key: 'ack', label: 'Device acknowledged the action', detail: last.action ? `${title(last.action)}${last.command ? ` · command #${last.command}` : ''}` : 'no action recorded', state: last.command_executed ? 'ok' : 'fail', status: last.command_executed ? 'yes' : 'no' },
    { key: 'fresh', label: 'Fresh valid samples after the acknowledgement', detail: 'counted by C5 after the settle time', state: 'info', status: <span className="tq-num">{last.n_fresh ?? '—'}</span> },
    ...crit.map(([k, v]) => ({ key: k, label: title(k), state: v ? 'ok' : 'fail', status: v ? 'met' : 'not met' })),
  ] : [];
  return (
    <>
      <PageHead title="Recovery Verification (C5)" sub="Recovery is declared only from fresh, valid samples observed after the device acknowledged an action." right={<ProvBadge kind={provKind} />} />
      <AlertPanel tone={st.tone} title={st.head} testid="rec-status" action={st.to && go ? <LinkButton onClick={() => go(st.to[0])}>{st.to[1]}</LinkButton> : null}>
        <p>{st.text}</p>
      </AlertPanel>
      <p className="tq-muted tq-small tq-as-note" role="note">A prediction of improvement is not a verified recovery, and an acknowledgement is not recovery.{isPhys ? '' : ' Records below are simulator observations, not hardware evidence.'}</p>
      <div className="tq-split tq-as-rec">
        <Card title="Verification criteria" id="c-ver" icon={ListChecks} sub={last ? `Latest C5 verdict · ${last.incident}` : 'Shown once C5 has assessed an acknowledged action'}
          right={last ? <Pill tone={last.outcome === 'RECOVERED' ? 'ok' : last.outcome === 'UNRESOLVED' ? 'crit' : 'warn'}>{title(last.outcome)}</Pill> : null}>
          {!last ? <Empty>{st.tone === 'wait' ? 'Verification is still in progress: criteria appear when C5 records its verdict.' : 'No verdict yet. C5 checks the device acknowledgement, a fresh window of valid samples, the learned band and the trend.'}</Empty> : (
            <><CheckList label="C5 verification criteria" items={items} testid="rec-criteria" />
              <p className="tq-muted tq-small">Reason: {(last.reasons || []).map(title).join(', ') || '—'}</p></>)}
        </Card>
        {last ? <BeforeAfter d={d} o={last} provKind={provKind} /> : (
          <Card title="Before and after the action" id="c-prepost" icon={ArrowLeftRight} right={<ProvBadge kind={provKind} />}>
            <Empty>Observed values before and after an action appear once C5 has verified one.</Empty>
          </Card>)}
      </div>
      <Card title="Outcomes" id="c-out" icon={History} className="tq-mt" sub="Every C5 verdict in this run, newest first" right={<ProvBadge kind={provKind} />}>
        {!outs.length ? <Empty>No incident has been verified yet. Verified outcomes appear here after an acknowledged action and a fresh observation window.</Empty> : (
          <div className="tq-as-outcomes">{outs.map((o) => (
            <article key={o.incident} className="tq-outcome tq-as-outcome">
              <h4>{o.incident}{' '}<Pill tone={o.outcome === 'RECOVERED' ? 'ok' : o.outcome === 'UNRESOLVED' ? 'crit' : 'warn'}>{title(o.outcome)}</Pill>{' '}<ProvBadge kind={provKind} /></h4>
              <p>Action: <strong>{o.action ? title(o.action) : '—'}</strong> · device confirmed: {o.command_executed ? 'yes' : 'no'} · fresh samples: <span className="tq-num">{o.n_fresh}</span></p>
              <p className="tq-muted">Reason: {(o.reasons || []).map(title).join(', ')}</p>
              {Object.keys(o.criteria || {}).length > 0 && (
                <CheckList dense label={`Verification checklist for ${o.incident}`} items={Object.entries(o.criteria).map(([k, v]) => ({ key: k, label: title(k), state: v ? 'ok' : 'fail', status: v ? 'pass' : 'fail' }))} />)}
              {o.observed && o.observed.rpm !== undefined && (<p className="tq-muted tq-small">Observed after the action (not predicted): {fmt(o.observed.rpm, 0)} rpm{o.observed.housing !== undefined ? `, ${fmt(o.observed.housing, 1)} °C` : ''}{o.observed.frac_in_band !== undefined ? `, ${fmt(o.observed.frac_in_band * 100, 0)}% of windows in learned band` : ''}.</p>)}
            </article>))}</div>)}
      </Card>
      {/* The verdict and its criteria come first; the full incident narrative follows as supporting detail. */}
      {!isPhys && <div className="tq-mt"><IncidentStory d={d} /></div>}
    </>
  );
}

/* ------------------------------------------------------------------ 9. Learning and model management (C6) */
export function LearningPage({ d, children, isPhys: isPhysProp }) {
  const isPhys = isPhysProp ?? isPhysOf(d);
  const provKind = isPhys ? 'MEASURED' : 'SIMULATED';
  const cases = d.cases || [];
  return (
    <>
      <PageHead title="Learning (C6)" sub="The operator-attested healthy reference used by adaptive C1, and the cases eligible for learning." right={<ProvBadge kind={provKind} />} />
      {children}
      <Card title="Learning dataset" id="c-learn" icon={Database} className="tq-mt" sub="Cases recorded from verified outcomes in this run" right={<ProvBadge kind={provKind} />}>
        <DataTable caption="Learning dataset" rows={cases} rowKey={(c) => `${c.label}-${c.outcome}-${c.session}-${c.executed}`}
          empty="No eligible cases recorded in this run. Blocked, rejected or aborted actions never count."
          columns={[
            { key: 'label', label: 'Label', render: (c) => <strong>{title(c.label)}</strong> },
            { key: 'outcome', label: 'C5 outcome', render: (c) => title(c.outcome) },
            { key: 'src', label: 'Label source', render: (c) => title(c.label_source) },
            { key: 'exec', label: 'Executed', render: (c) => String(c.executed) },
            { key: 'prov', label: 'Source', render: () => <ProvBadge kind={provKind} /> },
          ]} />
        <p className="tq-muted tq-small tq-mt">No model training, promotion or rollback of C2/C4 models is exposed: those are not implemented as operator actions. The reference lifecycle above is the only model-management feature that exists.</p>
      </Card>
    </>
  );
}

