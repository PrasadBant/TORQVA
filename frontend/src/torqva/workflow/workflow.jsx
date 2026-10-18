// Diagnostic Workflow: one connected experience for C4 → C1 → C2 → C3 → C5, identical in both modes.
// The operator picks a test pattern and presses one button; the backend (POST /workflow/runs) runs the test, analyses the evidence, diagnoses,
// predicts every candidate, recommends an action with its RPM, carries it into the existing C3 path under the chosen execution policy and
// tracks C5 verification. This page only displays the backend's authoritative record: every stage, value and outcome below comes from it.
// Physical mode uses the same layout; its adapter validates only and the backend blocks it with the actual reasons.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Play, Check, X, ShieldCheck, Ban, RefreshCw, ChevronRight } from 'lucide-react';
import { api, ApiError } from '../api.js';
import { Card, Empty, ErrorBox, Pill, PageHead, PosteriorBars, ProvBadge, fmt, title, pct, fmtRpm as rpm, canControl } from '../shared/components.jsx';
import { TrendLines } from '../shared/lazyCharts.jsx';

const MIN_GAP_MS = 2500;

export const STAGES = [
  ['VALIDATING', 'Validate'], ['RUNNING_DIAGNOSTIC_TEST', 'Run test'], ['COLLECTING_EVIDENCE', 'Collect evidence'], ['ANALYSING_EVIDENCE', 'Analyse'],
  ['GENERATING_DIAGNOSIS', 'Diagnose'], ['CALCULATING_PREDICTIONS', 'Predict'], ['GENERATING_RECOMMENDATION', 'Recommend'],
  ['AWAITING_AUTHORIZATION', 'Authorize'], ['EXECUTING_ACTION', 'Execute'], ['VERIFYING_OUTCOME', 'Verify'],
];
const STAGE_TONE = { completed: 'ok', active: 'info', waiting: 'wait', blocked: 'crit', failed: 'crit', cancelled: 'off', expired: 'warn' };
const STATUS_TONE = { COMPLETED: 'ok', PARTIAL: 'warn', BLOCKED: 'crit', FAILED: 'crit', CANCELLED: 'off', AWAITING_AUTHORIZATION: 'wait', VERIFYING_OUTCOME: 'wait' };
export const OUTCOME = {
  NO_INTERVENTION_NEEDED: ['ok', 'No intervention needed'],
  RECOVERY_VERIFIED: ['ok', 'Recovery verified'],
  MOTOR_STOPPED_OBSERVED: ['ok', 'Motor stop observed'],
  IMPROVEMENT_OBSERVED_NOT_VERIFIED: ['wait', 'Improvement observed, recovery not yet verified'],
  AWAITING_VERIFICATION: ['wait', 'Executed, awaiting verification'],
  AWAITING_AUTHORIZATION: ['wait', 'Awaiting authorization'],
  CONDITION_PERSISTS: ['crit', 'Condition persists'],
  OUTCOME_INCONCLUSIVE: ['warn', 'Outcome inconclusive'],
  INSPECTION_REQUIRED: ['warn', 'Inspection required'],
  MORE_EVIDENCE_REQUIRED: ['wait', 'More evidence required'],
  RECOMMENDATION_NOT_EXECUTABLE: ['warn', 'Recommendation not executable now'],
  INTERVENTION_REJECTED: ['crit', 'Intervention rejected'],
  INTERVENTION_FAILED: ['crit', 'Intervention failed'],
  INTERVENTION_DECLINED: ['off', 'Declined by the operator'],
  AUTHORIZATION_EXPIRED: ['warn', 'Authorization expired'],
  SUPERSEDED: ['off', 'Superseded'],
  SIMULATION_RESTARTED: ['off', 'Simulation restarted'],
  BLOCKED_PREREQUISITES: ['crit', 'Blocked: prerequisites'],
  BLOCKED_PHYSICAL_PREREQUISITES: ['crit', 'Blocked: physical prerequisites'],
  WORKFLOW_FAILED: ['crit', 'Workflow failed'],
};
const COND_TONE = { FAULT_HYPOTHESIS_SUPPORTED: 'ok', NO_ANOMALY_DETECTED: 'ok', CAUSE_UNCERTAIN: 'wait', ANOMALY_UNRANKED: 'wait', UNFAMILIAR_EVIDENCE: 'warn',
  INCONCLUSIVE: 'warn', TEST_ABORTED: 'crit', EVIDENCE_INVALID: 'crit' };
const SIGNAL = { rpm: ['Speed', 'rpm', 0], vib_rms: ['Vibration RMS', 'g', 3], current: ['Current', 'A', 2], housing: ['Housing temperature', '°C', 1] };
const newKey = () => `wf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
const errText = (e) => (e instanceof ApiError ? e.message : String(e?.message || e));

function OutcomePill({ outcome }) {
  if (!outcome) return null;
  const [tone, label] = OUTCOME[outcome] || ['info', title(outcome)];
  return <Pill tone={tone}>{label}</Pill>;
}

/** Re-runs `fn` when simulation time advances (at most every MIN_GAP_MS) while `active`; adds no timer of its own. */
function useOnSimTime(t, active, fn) {
  const last = useRef(0);
  useEffect(() => {
    if (!active || t === undefined || t === null) return undefined;
    const id = setTimeout(() => { last.current = Date.now(); fn(); }, Math.max(0, MIN_GAP_MS - (Date.now() - last.current)));
    return () => clearTimeout(id);
  }, [t, active, fn]);
}

export function WorkflowPage({ mode = 'SIMULATION', d, role, stale, go }) {
  const physical = mode === 'PHYSICAL';
  const prov = physical ? 'MEASURED' : 'SIMULATED';
  const ctl = canControl(role);
  const simT = physical ? null : d?.status?.t;
  const [pat, setPat] = useState({ data: null, error: null });
  const [sel, setSel] = useState(null);
  const [policy, setPolicy] = useState('require_confirmation');
  const [wf, setWf] = useState(null);
  const [busy, setBusy] = useState(null);
  const [err, setErr] = useState(null);
  const inFlight = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const loadPatterns = useCallback(async () => {
    try { const p = await api.wfPatterns(mode); if (alive.current) setPat({ data: p, error: null }); }
    catch (e) { if (alive.current) setPat((s) => ({ data: s.data, error: errText(e) })); }
  }, [mode]);
  const refresh = useCallback(async (id) => {
    if (!id) return;
    try { const w = await api.wfGet(id); if (alive.current) setWf(w); } catch (e) { if (alive.current) setErr(e); }
  }, []);

  // On entry (and after a browser refresh) restore the latest workflow of THIS mode; the other mode's records are never listed here.
  useEffect(() => {
    setWf(null); setSel(null); setErr(null);
    loadPatterns();
    api.wfRuns(mode).then((rs) => { if (alive.current && rs?.length) refresh(rs[0].id); }).catch(() => {});
  }, [mode, loadPatterns, refresh]);
  useOnSimTime(simT, !physical, loadPatterns);
  const live = wf && ['AWAITING_AUTHORIZATION', 'VERIFYING_OUTCOME'].includes(wf.status);
  const refreshCurrent = useCallback(() => refresh(wf?.id), [refresh, wf?.id]);
  useOnSimTime(simT, !physical && live, refreshCurrent);

  const patterns = pat.data?.patterns || [];
  const chosen = patterns.find((p) => p.id === sel) || patterns.find((p) => p.available) || patterns[0] || null;
  const running = busy === 'run';

  const runWorkflow = async () => {
    if (!chosen || inFlight.current) return;                        // a second click while one request is in flight does nothing
    inFlight.current = true; setBusy('run'); setErr(null); setWf(null);   // never show the previous record as if it were this run
    try {
      const w = await api.wfStart({ mode, pattern: chosen.id, execution_policy: policy, idempotency_key: newKey() });
      if (alive.current) setWf(w);
      loadPatterns();
    } catch (e) { if (alive.current) setErr(e); } finally { inFlight.current = false; if (alive.current) setBusy(null); }
  };
  const decide = async (kind) => {
    if (!wf || inFlight.current) return;
    inFlight.current = true; setBusy(kind); setErr(null);
    try { const w = kind === 'authorize' ? await api.wfAuthorize(wf.id) : await api.wfCancel(wf.id, 'declined on the workflow page'); if (alive.current) setWf(w); }
    catch (e) { if (alive.current) { setErr(e); refresh(wf.id); } } finally { inFlight.current = false; if (alive.current) setBusy(null); }
  };

  const ctx = pat.data?.context;
  return (
    <>
      <PageHead title="Diagnostic Workflow" sub="Choose a test pattern and run it once: TORQVA runs the test, analyses the evidence, diagnoses, predicts, recommends an RPM and action, carries it through the control pipeline and verifies the result."
        right={<><Pill tone={physical ? 'ok' : 'info'}>{physical ? 'PHYSICAL MODE' : 'SIMULATION MODE'}</Pill><ProvBadge kind={prov} /></>} />
      <div className="tq-wf">
        <Configuration physical={physical} ctx={ctx} patterns={patterns} chosen={chosen} setSel={setSel} policy={policy} setPolicy={setPolicy}
          ctl={ctl} stale={stale} running={running} busy={!!busy} onRun={runWorkflow} error={pat.error} onRefresh={loadPatterns} />
        <ErrorBox error={err} />
        {running && <div className="tq-narrate tone-info" role="status" data-testid="wf-running"><strong>Running…</strong><span>The backend is executing {chosen?.name}; the stages below appear when it answers.</span></div>}
        {!wf ? (!running && <Card title="Workflow" id="wf-empty"><Empty>No workflow has run in this mode yet. Select a pattern above and press Run Diagnostic Workflow.</Empty></Card>) : (
          <WorkflowRecord wf={wf} ctl={ctl} busy={busy} onAuthorize={() => decide('authorize')} onDecline={() => decide('decline')} go={go} physical={physical} />)}
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ A. configuration */
function Configuration({ physical, ctx, patterns, chosen, setSel, policy, setPolicy, ctl, stale, running, busy, onRun, error, onRefresh }) {
  const blocked = chosen ? chosen.prerequisites.filter((p) => !p.ok) : [];
  return (
    <Card title="1 · Test pattern" id="wf-config" right={<button type="button" className="tq-btn" onClick={onRefresh} aria-label="Refresh prerequisites"><RefreshCw size={14} aria-hidden="true" /></button>}>
      {error && <p className="tq-callout crit" role="alert">Patterns unavailable: {error}</p>}
      <div className="tq-wf-status" data-testid="wf-motor">
        {physical ? <span className="tq-muted tq-small">Physical device: prerequisites are read from the device's own status; no simulator data is shown here.</span> : !ctx ? (
          <span className="tq-muted tq-small">No simulation is running. Start a scenario on the Overview or Live Monitor page.</span>) : (<>
          <span>Setpoint <strong className="tq-num">{rpm(ctx.setpoint_rpm)} rpm</strong></span>
          <span>Incident <strong>{ctx.incident ? `${ctx.incident.id} · ${title(ctx.incident.state)}` : 'none'}</strong></span>
          <span>Held for approval <strong>{ctx.pending_approval ? `${title(ctx.pending_approval.action)}${ctx.pending_approval.params?.rpm ? ` ${rpm(ctx.pending_approval.params.rpm)} rpm` : ''}` : 'nothing'}</strong></span>
          {ctx.estop && <Pill tone="stop">E-STOP</Pill>}
          <p className="tq-muted tq-small tq-wf-note">{ctx.execution_note}</p></>)}
      </div>
      {!patterns.length ? <Empty loading={!error}>Loading the test patterns…</Empty> : (
        <fieldset className="tq-wf-patterns" disabled={busy}>
          <legend className="tq-sr">Diagnostic test pattern</legend>
          {patterns.map((p) => (
            <label key={p.id} className={`tq-wf-pattern ${chosen?.id === p.id ? 'is-on' : ''} ${p.available ? '' : 'is-off'}`} data-testid={`wf-pattern-${p.id}`}>
              <input type="radio" name="wf-pattern" value={p.id} checked={chosen?.id === p.id} onChange={() => setSel(p.id)} />
              <span className="tq-wf-pattern-name">{p.name}</span>
              <span className="tq-muted tq-small">{p.investigates}</span>
              <span>{p.available ? <Pill tone="ok">ready</Pill> : <Pill tone="off">not available</Pill>}{p.duration_s ? <span className="tq-muted tq-small tq-num"> {p.duration_s} s</span> : null}</span>
            </label>))}
        </fieldset>)}
      {chosen && (
        <div className="tq-wf-detail" data-testid="wf-pattern-detail">
          <p>{chosen.purpose}</p>
          <div className="tq-grid tq-grid-2">
            <div>
              <h4>Sequence</h4>
              {chosen.sequence.length ? (
                <table className="tq-table"><caption className="tq-sr">Test sequence</caption>
                  <thead><tr><th scope="col">Step</th><th scope="col">Target</th><th scope="col">Dwell</th></tr></thead>
                  <tbody>{chosen.sequence.map((s, i) => <tr key={i}><td>{s.what}</td><td className="tq-num">{s.rpm ? `${rpm(s.rpm)} rpm` : 'driver off'}</td><td className="tq-num">{s.hold_s} s</td></tr>)}</tbody></table>
              ) : <p className="tq-muted tq-small">{chosen.id === 'ADAPTIVE' ? 'Chosen at run time by expected information gain (T1, T3 or T4).' : 'No sequence: the pattern cannot run in this mode.'}</p>}
              <p className="tq-small"><span className="tq-muted">Signals: </span>{chosen.signals.join(', ')}</p>
              <p className="tq-small"><span className="tq-muted">Expected observations: </span>{chosen.expected_observations.join('; ')}</p>
              {chosen.ends_with_motor_stopped && <p className="tq-small tq-muted">Ends with the (copy of the) motor coasting to a stop.</p>}
            </div>
            <div>
              <h4>Prerequisites now</h4>
              <ul className="tq-prereq" data-testid="wf-prereqs">{chosen.prerequisites.map((p) => (
                <li key={p.check} className={p.ok ? 'ok' : 'no'}>{p.ok ? <Check size={12} aria-hidden="true" /> : <X size={12} aria-hidden="true" />} {p.check}{p.detail ? <span className="tq-muted"> — {p.detail}</span> : null}</li>))}</ul>
              <p className="tq-small"><span className="tq-muted">Simulation: </span>{chosen.availability.SIMULATION}</p>
              <p className="tq-small"><span className="tq-muted">Physical: </span>{chosen.availability.PHYSICAL}</p>
            </div>
          </div>
        </div>)}
      <div className="tq-wf-run">
        <div className="tq-seg" role="group" aria-label="Execution policy">
          <button type="button" className="tq-btn" aria-pressed={policy === 'require_confirmation'} onClick={() => setPolicy('require_confirmation')} disabled={busy}>Ask me to authorize the action</button>
          <button type="button" className="tq-btn" aria-pressed={policy === 'auto_when_permitted'} onClick={() => setPolicy('auto_when_permitted')} disabled={busy}>Execute automatically when every gate permits</button>
        </div>
        <button type="button" className="tq-btn tq-primary tq-wf-go" onClick={onRun} data-testid="wf-run"
          disabled={!chosen || !chosen.available || !ctl || stale || busy}>
          <Play size={15} aria-hidden="true" /> {running ? 'Running diagnostic workflow…' : 'Run Diagnostic Workflow'}</button>
      </div>
      <p className="tq-muted tq-small">
        {policy === 'auto_when_permitted' ? 'Pre-authorizes only the recommended REDUCE SPEED or STOP; the backend still applies freshness, the decision gate, C2 support and the Safety Supervisor, and sends nothing if any refuses.'
          : 'TORQVA stops before any command and shows exactly which action, RPM and evidence you are authorizing.'}
        {!ctl && ' Running a workflow requires the operator or admin role.'}
        {chosen && !chosen.available && blocked.length > 0 && ` Not available now: ${blocked.map((p) => p.check).join('; ')}.`}
      </p>
    </Card>
  );
}

/* ------------------------------------------------------------------ B–F. the workflow record */
function WorkflowRecord({ wf, ctl, busy, onAuthorize, onDecline, go, physical }) {
  const c = wf.context || {};
  return (
    <div className="tq-stack" data-testid="wf-record" data-status={wf.status}>
      <Card title={`2 · Execution · ${wf.id}`} id="wf-exec" right={<><Pill tone={STATUS_TONE[wf.status] || 'info'}>{title(wf.status)}</Pill>{wf.outcome !== wf.status && <OutcomePill outcome={wf.outcome} />}</>}>
        <div className={`tq-narrate tone-${(OUTCOME[wf.outcome] || ['info'])[0]}`} data-testid="wf-headline"><strong>{wf.headline || title(wf.status)}</strong>{wf.next_step && <span>{wf.next_step}</span>}</div>
        <StageList wf={wf} />
        {wf.blockers?.length > 0 && (
          <div className="tq-callout warn" role="alert" data-testid="wf-blockers"><strong>{wf.status === 'BLOCKED' ? 'Blocked' : 'Not carried through'}</strong>
            <ul>{wf.blockers.map((b) => <li key={b}>{b}</li>)}</ul></div>)}
        {wf.error && <p className="tq-callout crit" role="alert">{wf.error}</p>}
        <p className="tq-muted tq-small">{wf.pattern?.name} · policy {title(wf.execution_policy)} · requested by {wf.requested_by} ({wf.role}){wf.session ? ` · simulation session ${wf.session}` : ''}{c.test ? ` · test run ${c.test.run_id}: ${c.test.executed_on}` : ''}</p>
      </Card>
      {(c.diagnosis || c.evidence) && <EvidenceAndDiagnosis c={c} />}
      {c.recommendation && <Recommendation wf={wf} ctl={ctl} busy={busy} onAuthorize={onAuthorize} onDecline={onDecline} />}
      {(c.recommendation || c.intervention) && <Verification wf={wf} go={go} />}
      {!physical && <Details wf={wf} />}
    </div>
  );
}

function StageList({ wf }) {
  const byName = Object.fromEntries((wf.stages || []).map((s) => [s.stage, s]));
  const terminal = ['COMPLETED', 'PARTIAL', 'BLOCKED', 'FAILED', 'CANCELLED'].includes(wf.status);
  return (
    <ol className="tq-wf-stages" data-testid="wf-stages">
      {STAGES.map(([k, label], i) => {
        const s = byName[k];
        const state = s ? s.status : terminal ? 'skipped' : 'todo';
        return (
          <li key={k} className={`tq-wf-stage is-${state}`} data-stage={k} data-state={state}>
            <span className="tq-wf-stage-n" aria-hidden="true">{s?.status === 'completed' ? <Check size={12} /> : i + 1}</span>
            <span className="tq-wf-stage-body"><strong>{label}</strong>
              <span className="tq-small">{s ? <Pill tone={STAGE_TONE[s.status] || 'info'}>{s.status}</Pill> : <span className="tq-muted">{terminal ? 'not reached' : 'pending'}</span>}
                {s?.started_sim_t != null && <span className="tq-muted tq-num"> t = {fmt(s.started_sim_t, 0)} s</span>}</span>
              {s?.summary && <span className="tq-muted tq-small tq-wf-stage-sum">{s.summary}</span>}</span>
          </li>);
      })}
    </ol>
  );
}

/* ------------------------------------------------------------------ C. evidence and diagnosis */
function EvidenceAndDiagnosis({ c }) {
  const dx = c.diagnosis; const ev = c.evidence; const an = c.analysis; const t = c.test;
  const top = dx?.hypotheses?.[0];
  return (
    <Card title="3 · Evidence and diagnosis" id="wf-dx" right={<><ProvBadge kind="DERIVED" />{dx && <Pill tone={COND_TONE[dx.condition] || 'info'}>{title(dx.condition)}</Pill>}</>}>
      {dx && <div className={`tq-narrate tone-${COND_TONE[dx.condition] || 'info'}`} data-testid="wf-diagnosis"><strong>{dx.headline}</strong><span>{dx.detail}</span></div>}
      <div className="tq-grid tq-grid-2">
        <div>
          <h4>Fault hypotheses <span className="tq-muted tq-small">(suspected explanations)</span></h4>
          {dx?.ranked?.length ? <PosteriorBars ranked={dx.ranked.slice(0, 4)} label={dx.posterior?.label} />
            : <Empty>{dx?.condition === 'NO_ANOMALY_DETECTED' ? 'No ranking: the hypothesis model ranks faults, and C1 found no anomaly to explain.' : 'No ranking from this evidence.'}</Empty>}
          {dx?.test_changed_leading_hypothesis != null && <p className="tq-small">{dx.test_changed_leading_hypothesis ? <Pill tone="warn">the test changed the leading hypothesis</Pill> : <span className="tq-muted">The test kept the leading hypothesis of the live run ({title(dx.live_ranking_top)}).</span>}</p>}
          <p className="tq-small"><span className="tq-muted">Evidence sufficiency: </span>{an?.sufficiency ? title(an.sufficiency) : 'not applicable'} <span className="tq-muted">({an?.sufficiency_rule})</span></p>
        </div>
        <div>
          <h4>Measured and derived evidence</h4>
          {ev && (
            <dl className="tq-kv tq-small" data-testid="wf-evidence">
              <dt>Windows (simulated 1 s)</dt><dd className="tq-num">{ev.windows} · {pct(ev.valid_fraction)} valid</dd>
              <dt>C1 scored / flagged</dt><dd className="tq-num">{ev.scored_windows} · {pct(ev.c1_flagged_fraction)} above threshold</dd>
              <dt>Tested setpoints</dt><dd className="tq-num">{ev.tested_setpoints_rpm.map(rpm).join(', ') || '—'} rpm</dd>
              <dt>Signals present</dt><dd>{ev.signals_present.join(', ') || 'none'}</dd>
              <dt>Missing signals</dt><dd>{ev.signals_missing.length ? ev.signals_missing.join(', ') : 'none'}</dd>
              {ev.unscored_statuses.length > 0 && <><dt>Unscored windows</dt><dd>{ev.unscored_statuses.map(title).join(', ')}</dd></>}
            </dl>)}
        </div>
      </div>
      {t?.stages?.length > 0 && (
        <div className="tq-table-wrap tq-mt"><table className="tq-table" data-testid="wf-test-stages"><caption className="tq-sr">Test stage results</caption>
          <thead><tr><th scope="col">Stage</th><th scope="col">Status</th><th scope="col">Observation (derived)</th><th scope="col">Ranking before → after</th></tr></thead>
          <tbody>{t.stages.map((s) => (
            <tr key={s.index}><th scope="row">{s.test === 'profile' ? 'Speed profile' : s.test}{s.simulated_seconds ? <span className="tq-muted tq-small tq-num"> {s.simulated_seconds} s</span> : null}</th>
              <td><Pill tone={s.status === 'completed' ? 'ok' : 'crit'}>{s.status}</Pill>{s.reason && <div className="tq-small">{s.reason}</div>}</td>
              <td className="tq-small">{s.observation ? s.observation_meaning.map((m, i) => `${m} ${fmt(s.observation[i], 3)}`).join(' · ')
                : s.steps ? s.steps.map((x) => `${rpm(x.target_rpm)} rpm: ${rpm(x.mean_rpm_settled)} settled, ${fmt(x.mean_current, 2)} A, ${fmt(x.mean_vib_rms, 3)} g, ${pct(x.flagged_fraction)} flagged`).join(' · ') : '—'}
                {s.signature_note && <div className="tq-muted">{s.signature_note}</div>}</td>
              <td className="tq-small">{rankText(s.posterior_before)} → {rankText(s.posterior_after)}</td></tr>))}</tbody></table></div>)}
      {top && (top.supporting?.length > 0 || top.contradicting?.length > 0) && (
        <div className="tq-mt" data-testid="wf-features">
          <h4>Why {title(top.hypothesis)}{top.compared_with ? ` rather than ${title(top.compared_with)}` : ''}</h4>
          <ul className="tq-list tq-small">
            {top.supporting.map((f) => <li key={`s${f.feature}`}><Pill tone="ok">supports</Pill> {f.feature}: observed {fmt(f.observed_z, 1)}σ vs signature {fmt(f.signature_z, 1)}σ</li>)}
            {top.contradicting.map((f) => <li key={`c${f.feature}`}><Pill tone="warn">contradicts</Pill> {f.feature}: observed {fmt(f.observed_z, 1)}σ vs signature {fmt(f.signature_z, 1)}σ</li>)}
          </ul>
          <p className="tq-muted tq-small">{dx.feature_evidence_source}.</p>
        </div>)}
      {dx?.missing?.length > 0 && <p className="tq-callout warn">Limits on this conclusion: {dx.missing.join('; ')}.</p>}
      {dx?.scenario_note && <p className="tq-muted tq-small">Scenario ground truth: {dx.scenario_truth ? title(dx.scenario_truth) : 'no active fault'} — {dx.scenario_note}</p>}
    </Card>
  );
}

const rankText = (p) => (p ? p.ranked.slice(0, 2).map(([h, v]) => `${title(h)} ${pct(v, 0)}`).join(' · ') : 'no ranking');

/* ------------------------------------------------------------------ D. recommendation */
function Recommendation({ wf, ctl, busy, onAuthorize, onDecline }) {
  const rec = wf.context.recommendation; const pr = wf.context.predictions; const chk = wf.context.execution_check;
  const awaiting = wf.status === 'AWAITING_AUTHORIZATION';
  const change = rec.change_rpm;
  const po = rec.predicted_outcome;
  const rows = useMemo(() => (po?.rows || []).filter((r) => r.horizon_s === 120 || r.horizon_s === 30), [po]);
  return (
    <Card title="4 · Recommended action" id="wf-rec" right={<><ProvBadge kind="DERIVED" />{rec.actionable ? <Pill tone="info">command</Pill> : <Pill tone="off">no command</Pill>}</>}>
      <div className={`tq-wf-rec kind-${rec.kind}`} data-testid="wf-recommendation" data-action={rec.action}>
        <div className="tq-wf-rec-label">RECOMMENDED ACTION</div>
        <div className="tq-wf-rec-head">{rec.headline}</div>
        <div className="tq-wf-rec-kpis">
          <div><span>Current speed</span><strong className="tq-num">{rpm(rec.current_rpm)} rpm</strong></div>
          <div><span>Current setpoint</span><strong className="tq-num">{rpm(rec.current_setpoint_rpm)} rpm</strong></div>
          <div data-testid="wf-target"><span>Recommended target</span><strong className="tq-num">{rec.action === 'STOP' ? 'stop' : rec.target_rpm != null ? `${rpm(rec.target_rpm)} rpm` : `${rpm(rec.current_setpoint_rpm)} rpm (no change)`}</strong></div>
          <div><span>Change</span><strong className="tq-num">{change == null ? '0 rpm' : `${change > 0 ? '+' : ''}${rpm(change)} rpm`}</strong></div>
        </div>
      </div>
      <div className="tq-grid tq-grid-2 tq-mt">
        <div>
          <h4>Adjustments</h4>
          <ul className="tq-list tq-small" data-testid="wf-adjustments">{rec.adjustments.map((a, i) => (
            <li key={i}><strong>{a.parameter}</strong>{a.from_rpm != null ? `: ${rpm(a.from_rpm)} → ${rpm(a.to_rpm)} rpm` : a.to ? `: ${a.from ? `${a.from} → ` : ''}${a.to}` : ''}{a.why ? ` — ${a.why}` : ''}
              {a.constraint && <div className="tq-muted">{a.constraint}</div>}{a.expected && <div className="tq-muted">{a.expected} (predicted)</div>}</li>))}</ul>
          <h4>Why this is the best-supported choice</h4>
          <ul className="tq-list tq-small" data-testid="wf-why">{rec.why.map((w, i) => <li key={i}>{w}</li>)}</ul>
          <p className="tq-muted tq-small">Decision rule: {rec.decision_rule}.</p>
        </div>
        <div>
          <h4>Predicted outcome <span className="tq-muted tq-small">(C2 prediction, not an observation)</span></h4>
          {!pr?.available ? <p className="tq-small tq-muted" data-testid="wf-pred-unavailable">Prediction unavailable: {pr?.reason}.</p> : !po ? <p className="tq-small tq-muted">No command, so no outcome is predicted for it. Candidate predictions are listed below.</p> : (
            <table className="tq-table tq-small" data-testid="wf-predicted"><caption className="tq-sr">Predicted outcome of the recommended action</caption>
              <thead><tr><th scope="col">Signal</th><th scope="col">Now</th><th scope="col">At</th><th scope="col">Predicted (90 % interval)</th></tr></thead>
              <tbody>{rows.map((r) => { const [n, u, dg] = SIGNAL[r.signal] || [r.signal, '', 2]; return (
                <tr key={`${r.signal}${r.horizon_s}`}><th scope="row">{n}</th><td className="tq-num">{fmt(r.now, dg)} {u}</td><td className="tq-num">{r.horizon_s} s</td>
                  <td className="tq-num">{fmt(r.predicted_mean, dg)} ({fmt(r.lo, dg)}–{fmt(r.hi, dg)}) {u}</td></tr>); })}</tbody></table>)}
          {po && <p className="tq-muted tq-small">Risk {fmt(po.risk, 2)}{po.continue_risk != null ? ` vs ${fmt(po.continue_risk, 2)} if nothing changes` : ''} · {po.interval_meaning}.</p>}
          {rec.limitations?.length > 0 && <><h4>Limitations</h4><ul className="tq-list tq-small">{rec.limitations.map((l) => <li key={l}>{l}</li>)}</ul></>}
          <p className="tq-muted tq-small">{rec.constraints.join('; ')} · {rec.control_resolution}.</p>
        </div>
      </div>
      {rec.ranking?.length > 0 && (
        <div className="tq-table-wrap tq-mt"><table className="tq-table tq-small" data-testid="wf-candidates"><caption className="tq-sr">Candidate actions compared by C2</caption>
          <thead><tr><th scope="col">Rank</th><th scope="col">Candidate</th><th scope="col">Action</th><th scope="col">Target</th><th scope="col">Risk</th><th scope="col">C2 status</th><th scope="col">Selection</th></tr></thead>
          <tbody>{rec.ranking.map((r) => (
            <tr key={r.candidate_id} className={r.candidate_id === rec.candidate_id ? 'is-on' : ''}><td className="tq-num">{r.rank}</td><td>{r.label}{r.pipeline_default ? <span className="tq-muted"> (pipeline default)</span> : ''}</td><td>{title(r.action)}</td>
              <td className="tq-num">{r.action === 'REDUCE_SPEED' ? `${rpm(r.target_rpm)} rpm` : r.action === 'STOP' ? 'stop' : '—'}</td><td className="tq-num">{fmt(r.risk, 2)}</td><td>{title(r.status)}</td>
              <td>{r.candidate_id === rec.candidate_id ? <Pill tone="ok">recommended</Pill> : r.eligible ? 'eligible' : <span className="tq-muted">{r.excluded_because}</span>}</td></tr>))}</tbody></table></div>)}
      {awaiting && (
        <div className="tq-callout info tq-wf-auth" data-testid="wf-authorize-box">
          <strong>Authorization required: {rec.headline}</strong>
          <p>Candidate {rec.candidate_id} · evidence basis at simulation t = {fmt(rec.basis?.t, 0)} s. The backend re-checks freshness, the decision gate, C2 support and the Safety Supervisor at the moment you authorize; {wf.context.authorization?.expires && `the recommendation expires ${wf.context.authorization.expires}`}.</p>
          <div className="tq-row">
            <button type="button" className="tq-btn tq-primary" onClick={onAuthorize} disabled={!ctl || !!busy} data-testid="wf-authorize"><ShieldCheck size={14} aria-hidden="true" /> {busy === 'authorize' ? 'Sending…' : 'Authorize and execute'}</button>
            <button type="button" className="tq-btn" onClick={onDecline} disabled={!ctl || !!busy} data-testid="wf-decline"><Ban size={14} aria-hidden="true" /> Decline</button>
          </div>
        </div>)}
      {chk && !awaiting && !wf.context.intervention && rec.actionable && (
        <p className="tq-muted tq-small" data-testid="wf-exec-check">Control pipeline check: gate {chk.gate ? title(chk.gate.verdict) : '—'} · Safety Supervisor {title(chk.supervisor?.verdict)} · {chk.awaiting_decision ? 'an action is held for a human decision' : 'no action is held for a human decision'}.</p>)}
    </Card>
  );
}

/* ------------------------------------------------------------------ E. verification */
function Verification({ wf, go }) {
  const iv = wf.context.intervention; const v = wf.context.verification;
  if (!iv) {
    return (
      <Card title="5 · Verification" id="wf-verify" right={<ProvBadge kind="SIMULATED" />}>
        <p className="tq-muted" data-testid="wf-verify-none">{wf.status === 'AWAITING_AUTHORIZATION' ? 'Nothing has been sent yet. Verification starts after an authorized command is acknowledged.' : 'No command was executed by this workflow, so there is no outcome to verify.'}</p>
      </Card>);
  }
  const cmd = v?.command || iv.command || {};
  const steps = [
    ['Command requested', iv.command_id != null, iv.command_id != null ? `#${iv.command_id} ${title(cmd.action)}${iv.command?.params?.rpm ? ` ${rpm(iv.command.params.rpm)} rpm` : ''}` : 'not dispatched'],
    ['Accepted by the simulated device', !!cmd.accepted, cmd.status || '—'],
    ['Execution confirmed', !!cmd.executed, cmd.executed ? 'the device reports it took effect' : 'not confirmed'],
    ['Improvement observed', v?.c1_score_after != null && v?.c1_score_before != null && v.c1_score_after < v.c1_score_before, v ? `C1 score ÷ threshold ${fmt(v.c1_score_before, 2)} before → ${fmt(v.c1_score_after, 2)} after (${v.post_ack_windows} windows)` : '—'],
    ['Recovery verified (C5)', wf.outcome === 'RECOVERY_VERIFIED', v?.assessment ? `${title(v.assessment.outcome)}: ${(v.assessment.reasons || []).map(title).join(', ')}` : 'waiting'],
  ];
  return (
    <Card title="5 · Verification" id="wf-verify" right={<><OutcomePill outcome={wf.outcome} /><ProvBadge kind="SIMULATED" /></>}>
      <ol className="tq-life" data-testid="wf-verify-steps">
        {steps.map(([label, ok, detail]) => (
          <li key={label} className={`tq-life-step is-${ok ? 'done' : 'todo'}`} data-state={ok ? 'done' : 'todo'}>
            <span className="tq-life-dot" aria-hidden="true" /><div><strong>{label}</strong> <Pill tone={ok ? 'ok' : 'off'}>{ok ? 'yes' : 'not yet'}</Pill><p className="tq-muted tq-small">{detail}</p></div>
          </li>))}
      </ol>
      {wf.status === 'VERIFYING_OUTCOME' && <p className="tq-callout info">C5 decides from fresh simulated windows after the acknowledgement. The simulation must advance (Run, or Step on the Live Monitor) for verification to finish.</p>}
      {v?.predicted_vs_observed?.length > 0 && (
        <div className="tq-table-wrap"><table className="tq-table tq-small" data-testid="wf-pvo"><caption className="tq-sr">Predicted versus observed</caption>
          <thead><tr><th scope="col">Signal</th><th scope="col">At</th><th scope="col">Predicted (interval)</th><th scope="col">Observed (SIM)</th><th scope="col">Inside</th></tr></thead>
          <tbody>{v.predicted_vs_observed.map((r) => { const [n, u, dg] = SIGNAL[r.signal] || [r.signal, '', 2]; return (
            <tr key={`${r.signal}${r.horizon_s}`}><th scope="row">{n}</th><td className="tq-num">{r.horizon_s} s</td><td className="tq-num">{fmt(r.predicted_mean, dg)} ({fmt(r.lo, dg)}–{fmt(r.hi, dg)}) {u}</td>
              <td className="tq-num">{fmt(r.observed, dg)} {u}</td><td>{r.inside_interval ? <Pill tone="ok">yes</Pill> : <Pill tone="warn">no</Pill>}</td></tr>); })}</tbody></table>
          <p className="tq-muted tq-small">Single samples at each horizon; a predicted improvement is not an observed one, and neither is a recovery verdict.</p></div>)}
      <p className="tq-small">{iv.receipt_id && <>Decision receipt <strong>{iv.receipt_id}</strong> · </>}<button type="button" className="tq-linkbtn" onClick={() => go?.('interventions')}>Open Interventions <ChevronRight size={12} aria-hidden="true" /></button></p>
    </Card>
  );
}

/* ------------------------------------------------------------------ F. evidence details */
function Details({ wf }) {
  const c = wf.context || {};
  const series = c.test?.series || [];
  return (
    <Card title="Evidence details" id="wf-details">
      <details className="tq-wf-more">
        <summary>Test time series ({series.length} points{c.test?.series_step > 1 ? `, every ${c.test.series_step}th window` : ''})</summary>
        {series.length > 1 ? (<div className="tq-grid tq-grid-2">
          <div role="img" aria-label="Speed during the test" className="tq-chart"><TrendLines data={series} height={180} digits={0} unit="rpm" lines={[{ key: 'rpm', name: 'observed rpm', color: 'var(--tq-chart-ink)' }, { key: 'setpoint', name: 'setpoint', color: 'var(--tq-chart-1)', dash: '4 3' }]} /></div>
          <div role="img" aria-label="Vibration during the test" className="tq-chart"><TrendLines data={series} height={180} digits={3} unit="g" lines={[{ key: 'vib_rms', name: 'vibration RMS', color: 'var(--tq-chart-3)' }]} /></div>
          <div role="img" aria-label="Current during the test" className="tq-chart"><TrendLines data={series} height={180} digits={2} unit="A" lines={[{ key: 'current', name: 'current', color: 'var(--tq-chart-4)' }]} /></div>
          <div role="img" aria-label="C1 score during the test" className="tq-chart"><TrendLines data={series} height={180} digits={2} unit="" lines={[{ key: 'score', name: 'C1 score ÷ threshold', color: 'var(--tq-chart-2)' }]} /></div>
        </div>) : <Empty>No test windows were recorded.</Empty>}
        <p className="tq-chart-note">Simulated windows of the copy the test ran on (simulation time, provenance SIMULATED).</p>
      </details>
      {c.initial_telemetry && (
        <details className="tq-wf-more"><summary>Initial telemetry snapshot</summary>
          <dl className="tq-kv tq-small">{['t', 'rpm', 'setpoint', 'current', 'voltage', 'power', 'housing', 'vib_rms', 'valid', 'age_s'].filter((k) => k in c.initial_telemetry).map((k) => (
            <React.Fragment key={k}><dt>{k}</dt><dd className="tq-num">{String(c.initial_telemetry[k] ?? 'unavailable')}</dd></React.Fragment>))}</dl></details>)}
      {c.predictions?.available && (
        <details className="tq-wf-more"><summary>Model details</summary>
          <dl className="tq-kv tq-small">
            <dt>C2 conditioned on</dt><dd>{rankText(c.predictions.conditioned_on)}</dd>
            <dt>C2 trusted</dt><dd>{c.predictions.trust.trusted ? 'yes' : `no (${c.predictions.trust.reasons.map(title).join(', ')})`}</dd>
            <dt>Validated by intervention experiments</dt><dd>{c.predictions.validated_by_experiments ? 'yes' : 'no'}</dd>
            <dt>Target grid</dt><dd>{c.predictions.target_grid}</dd>
            {c.recommendation?.gate && <><dt>Gate</dt><dd>{title(c.recommendation.gate.verdict)}: {c.recommendation.gate.reason}</dd></>}
          </dl></details>)}
      <details className="tq-wf-more"><summary>Workflow events ({wf.events?.length || 0})</summary>
        <ol className="tq-list tq-small" data-testid="wf-events">{(wf.events || []).map((e, i) => <li key={i}><span className="tq-num tq-muted">{e.sim_t != null ? `t = ${fmt(e.sim_t, 0)} s` : new Date(e.unix * 1000).toLocaleTimeString()}</span> {title(e.from)} → <strong>{title(e.to)}</strong>{e.summary ? ` — ${e.summary}` : ''}</li>)}</ol></details>
    </Card>
  );
}

