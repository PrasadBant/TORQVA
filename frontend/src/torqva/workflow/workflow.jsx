// Diagnostic Workflow: one guided analyst experience for C4 → C1 → C2 → C3 → C5, identical in both modes.
// The analyst picks a test pattern and presses one button; the backend (POST /workflow/runs) runs the test, analyses the evidence, diagnoses,
// predicts every candidate, recommends an action with its RPM, carries it into the existing C3 path under the chosen execution policy and
// tracks C5 verification. This page only displays the backend's authoritative record: every stage, value and outcome below comes from it,
// and a step is drawn complete only when the record holds its result.
// Physical mode uses the same layout; its adapter validates only and the backend blocks it with the actual reasons.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Play, ShieldCheck, Ban, RefreshCw, Gauge, Microscope, LineChart, Activity, FileText, FlaskConical, Usb, Loader2 } from 'lucide-react';
import { api, ApiError } from '../api.js';
import {
  Card, Empty, ErrorBox, Pill, PageHead, PosteriorBars, ProvBadge, fmt, title, pct, fmtRpm as rpm, canControl, Disclosure,
  StepTracker, CheckList, AlertPanel, MetricList, LinkButton, SourceTag, BlockedReason,
} from '../shared/components.jsx';
import { TrendLines } from '../shared/lazyCharts.jsx';

const MIN_GAP_MS = 2500;

export const STAGES = [
  ['VALIDATING', 'Validate'], ['RUNNING_DIAGNOSTIC_TEST', 'Run test'], ['COLLECTING_EVIDENCE', 'Collect evidence'], ['ANALYSING_EVIDENCE', 'Analyse'],
  ['GENERATING_DIAGNOSIS', 'Diagnose'], ['CALCULATING_PREDICTIONS', 'Predict'], ['GENERATING_RECOMMENDATION', 'Recommend'],
  ['AWAITING_AUTHORIZATION', 'Authorize'], ['EXECUTING_ACTION', 'Execute'], ['VERIFYING_OUTCOME', 'Verify'],
];
const STAGE_TONE = { completed: 'ok', active: 'info', waiting: 'wait', blocked: 'crit', failed: 'crit', cancelled: 'off', expired: 'warn' };
const STATUS_TONE = { COMPLETED: 'ok', PARTIAL: 'warn', BLOCKED: 'crit', FAILED: 'crit', CANCELLED: 'off', AWAITING_AUTHORIZATION: 'wait', VERIFYING_OUTCOME: 'wait' };
const TERMINAL = ['COMPLETED', 'PARTIAL', 'BLOCKED', 'FAILED', 'CANCELLED'];
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
const rankText = (p) => (p ? p.ranked.slice(0, 2).map(([h, v]) => `${title(h)} ${pct(v, 0)}`).join(' · ') : 'no ranking');
/** Scrolls a section into view (a real navigation within this page; a no-op where the browser cannot scroll). */
const reveal = (id, fallback) => {
  try {
    const el = document.getElementById(id) || (fallback && document.getElementById(fallback));
    const folded = el?.querySelector?.('details.tq-an-again');
    if (folded) folded.open = true;                     // "Start another workflow" unfolds the folded configuration
    el?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  } catch { /* not supported */ }
};

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

/* ------------------------------------------------------------------ the analyst's ten steps, derived only from the backend record */
// Each analyst step maps onto the backend stages that produce its result. `optional` stages may legitimately be absent (a healthy motor
// needs no authorization). Section ids say where the step's detail is shown on this page.
const FLOW = [
  { key: 'status', label: 'Motor status', stages: ['VALIDATING'], sec: 'wf-sec-start' },
  { key: 'select', label: 'Test selection', stages: ['VALIDATING'], sec: 'wf-sec-start' },
  { key: 'test', label: 'Test execution', stages: ['RUNNING_DIAGNOSTIC_TEST'], sec: 'wf-sec-start' },
  { key: 'evidence', label: 'Evidence', stages: ['COLLECTING_EVIDENCE', 'ANALYSING_EVIDENCE'], sec: 'wf-sec-dx' },
  { key: 'diagnosis', label: 'Diagnosis', stages: ['GENERATING_DIAGNOSIS'], sec: 'wf-sec-dx' },
  { key: 'prediction', label: 'Prediction', stages: ['CALCULATING_PREDICTIONS'], sec: 'wf-sec-rec' },
  { key: 'decision', label: 'Decision', stages: ['GENERATING_RECOMMENDATION'], optional: ['AWAITING_AUTHORIZATION'], sec: 'wf-sec-auth' },
  { key: 'intervention', label: 'Intervention', stages: ['EXECUTING_ACTION'], sec: 'wf-sec-verify' },
  { key: 'recovery', label: 'Recovery verification', stages: ['VERIFYING_OUTCOME'], sec: 'wf-sec-verify' },
  { key: 'report', label: 'Final report', stages: [], sec: 'wf-sec-report' },
];
const STEP_OF = { completed: 'done', active: 'active', waiting: 'waiting', blocked: 'blocked', failed: 'failed', cancelled: 'skipped', expired: 'blocked' };
const SEVERITY = ['failed', 'blocked', 'waiting', 'active', 'skipped', 'done'];

/** Tracker steps for a workflow record. A step is `done` only when every stage behind it is in the record and completed. */
export function flowSteps(wf) {
  const by = Object.fromEntries((wf.stages || []).map((s) => [s.stage, s]));
  const terminal = TERMINAL.includes(wf.status);
  const c = wf.context || {};
  const auth = c.authorization;
  return FLOW.map((f) => {
    if (f.key === 'report') {
      const st = !terminal ? 'pending' : wf.status === 'FAILED' ? 'failed' : wf.status === 'BLOCKED' ? 'blocked' : wf.status === 'PARTIAL' ? 'waiting' : wf.status === 'CANCELLED' ? 'skipped' : 'done';
      return { key: f.key, label: f.label, state: st, sub: terminal ? (OUTCOME[wf.outcome]?.[1] || title(wf.status)).toLowerCase() : 'when the run ends' };
    }
    const present = [...f.stages, ...(f.optional || [])].map((k) => by[k]).filter(Boolean);
    const required = f.stages.map((k) => by[k]);
    let state;
    if (!present.length) state = terminal ? 'skipped' : 'pending';
    else {
      const states = present.map((s) => STEP_OF[s.status] || 'active');
      state = SEVERITY.find((x) => states.includes(x)) || 'active';
      if (state === 'done' && required.some((s) => !s)) state = terminal ? 'skipped' : 'active';
    }
    // test selection is accepted once validation passes; when validation is blocked the selection was not taken further
    if (f.key === 'select' && (state === 'blocked' || state === 'failed')) state = 'skipped';
    let sub;
    if (state === 'skipped' && !present.length) sub = 'not reached';
    else if (f.key === 'select' && wf.pattern) sub = state === 'done' ? wf.pattern.id : 'not accepted';
    else if (f.key === 'test' && state === 'done' && c.test) sub = `run ${c.test.run_id}`;
    else if (f.key === 'evidence' && state === 'done' && c.evidence) sub = `${pct(c.evidence.valid_fraction)} valid`;
    else if (f.key === 'diagnosis' && state === 'done' && c.diagnosis) sub = c.diagnosis.condition === 'NO_ANOMALY_DETECTED' ? 'no anomaly' : c.diagnosis.condition === 'FAULT_HYPOTHESIS_SUPPORTED' && c.diagnosis.primary ? `suspected ${title(c.diagnosis.primary.hypothesis)}` : title(c.diagnosis.condition).toLowerCase();
    else if (f.key === 'prediction' && state === 'done' && c.predictions) {
      if (c.predictions.available === false) { state = 'skipped'; sub = 'not applicable'; } else sub = `${(c.predictions.candidates || []).length + (c.predictions.references || []).length} candidates`;
    } else if (f.key === 'decision') {
      if (auth?.decision === 'AUTHORIZED') sub = 'authorized';
      else if (auth?.decision === 'DECLINED') { state = 'skipped'; sub = 'declined'; }
      else if (auth?.decision === 'EXPIRED') { state = 'blocked'; sub = 'expired'; }
      else if (state === 'waiting') sub = 'awaiting authorization';
      else if (state === 'done' && c.recommendation && !c.recommendation.actionable) sub = 'no command';
    } else if (f.key === 'intervention' && state === 'done' && c.intervention?.command_id != null) sub = `command #${c.intervention.command_id}`;
    else if (f.key === 'recovery' && state === 'waiting') sub = 'verifying';
    return { key: f.key, label: f.label, state, sub };
  });
}

/** Tracker steps before any record exists: motor status and prerequisites come from the backend's pattern list (GET /workflow/patterns). */
function preRunSteps(chosen, loading, running) {
  const allOk = chosen && chosen.available && chosen.prerequisites.every((p) => p.ok);
  return FLOW.map((f) => {
    if (f.key === 'status') return { key: f.key, label: f.label, state: !chosen ? (loading ? 'active' : 'pending') : allOk ? 'done' : 'blocked', sub: !chosen ? (loading ? 'checking…' : 'unknown') : allOk ? 'prerequisites hold' : 'prerequisites fail' };
    if (f.key === 'select') return { key: f.key, label: f.label, state: running ? 'done' : 'active', sub: chosen ? chosen.id : 'choose a test' };
    if (f.key === 'test' && running) return { key: f.key, label: f.label, state: 'active', sub: 'request in progress' };
    return { key: f.key, label: f.label, state: 'pending' };
  });
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
    reveal('wf-flow');
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
  const steps = wf ? flowSteps(wf) : preRunSteps(chosen, !pat.data && !pat.error, running);
  const secOf = Object.fromEntries(FLOW.map((f) => [f.key, wf ? f.sec : 'wf-config']));
  return (
    <>
      <PageHead title="Diagnostic Workflow" sub="One guided investigation: test, diagnose, predict, decide and verify."
        right={<span className="tq-an-right"><Pill tone={physical ? 'ok' : 'info'}>{physical ? 'PHYSICAL MODE' : 'SIMULATION MODE'}</Pill><ProvBadge kind={prov} /></span>} />
      <div className="tq-wf tq-an-page">
        <section className="tq-card tq-an-flow" id="wf-flow" aria-labelledby="wf-flow-h" data-testid="wf-flow">
          <header>
            <div className="tq-card-title"><div><h3 id="wf-flow-h">{wf ? `Workflow ${wf.id}` : 'Workflow progress'}</h3>
              <p className="tq-card-sub">{wf ? `${wf.pattern?.name || 'Test'} · ${title(wf.execution_policy)} · requested by ${wf.requested_by} (${wf.role})` : 'Steps fill in from the backend record once a workflow runs. Select a step to jump to it.'}</p></div></div>
            {wf && <span className="tq-row"><Pill tone={STATUS_TONE[wf.status] || 'info'}>{title(wf.status)}</Pill></span>}
          </header>
          <StepTracker steps={steps} label="Diagnostic workflow steps" onSelect={(k) => reveal(secOf[k], k === 'decision' ? 'wf-sec-rec' : 'wf-sec-report')} testid="wf-tracker" />
          {wf && <NextStep wf={wf} ctl={ctl} go={go} physical={physical} />}
        </section>
        <ErrorBox error={err} />
        {running && <RunningPanel chosen={chosen} />}
        {wf && <WorkflowRecord wf={wf} ctl={ctl} busy={busy} onAuthorize={() => decide('authorize')} onDecline={() => decide('decline')} go={go} physical={physical} />}
        <Configuration physical={physical} ctx={ctx} patterns={patterns} chosen={chosen} setSel={setSel} policy={policy} setPolicy={setPolicy} hasRecord={!!wf}
          ctl={ctl} role={role} stale={stale} running={running} busy={!!busy} onRun={runWorkflow} error={pat.error} onRefresh={loadPatterns} />
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ while the request is in flight (the backend answers once) */
function RunningPanel({ chosen }) {
  const [t0] = useState(Date.now);
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);
  return (
    <div className="tq-alertpanel tq-info tq-an-running" role="status" data-testid="wf-running">
      <span className="tq-alertpanel-icon" aria-hidden="true"><Loader2 size={20} className="tq-spin" /></span>
      <div className="tq-alertpanel-body"><strong>Running…</strong>
        <div className="tq-alertpanel-text">The backend is executing {chosen?.name}: test, evidence, diagnosis, predictions and recommendation in one request. The steps appear when it answers
          {' '}<span className="tq-muted tq-num">(waiting {Math.round((now - t0) / 1000)} s)</span>.</div></div>
    </div>
  );
}

/* ------------------------------------------------------------------ the next action for the current state of the record */
function NextStep({ wf, ctl, go, physical }) {
  const tone = (OUTCOME[wf.outcome] || [STATUS_TONE[wf.status] || 'info'])[0];
  const c = wf.context || {};
  let action = null;
  if (wf.status === 'AWAITING_AUTHORIZATION') action = <button type="button" className="tq-btn tq-primary" onClick={() => reveal('wf-sec-auth')}><ShieldCheck size={14} aria-hidden="true" />{ctl ? 'Review and authorize' : 'Review the recommendation'}</button>;
  else if (wf.status === 'VERIFYING_OUTCOME') action = <button type="button" className="tq-btn" onClick={() => go?.('live')}><Activity size={14} aria-hidden="true" />Advance the simulation on Live Monitor</button>;
  else if (TERMINAL.includes(wf.status) && c.intervention) action = <button type="button" className="tq-btn" onClick={() => go?.('recovery')}><ShieldCheck size={14} aria-hidden="true" />Open Recovery Verification</button>;
  else if (TERMINAL.includes(wf.status)) action = <button type="button" className="tq-btn" onClick={() => reveal('wf-config')}><Play size={14} aria-hidden="true" />{wf.status === 'BLOCKED' || physical ? 'Review the prerequisites' : 'Start another workflow'}</button>;
  return (
    <AlertPanel tone={tone === 'wait' ? 'info' : tone} title={wf.headline || title(wf.status)} testid="wf-headline" action={action}>
      {wf.next_step && <p>{wf.next_step}</p>}
      {wf.outcome && wf.outcome !== wf.status && <p className="tq-an-outcome"><OutcomePill outcome={wf.outcome} /></p>}
    </AlertPanel>
  );
}

/* ------------------------------------------------------------------ configuration: motor status now, pattern, prerequisites, policy, run */
// While a record is on the page, the configuration for the NEXT run is folded: it repeated the whole form below the record and was the
// longest part of the page on a phone. It stays in the page, so nothing it checks changes; the next-step button unfolds it.
function AgainFold({ folded, children }) {
  if (!folded) return children;
  return <details className="tq-wf-more tq-an-again" data-testid="wf-config-fold"><summary>Show the motor status, test patterns and prerequisites for a new run</summary>{children}</details>;
}

function Configuration({ physical, ctx, patterns, chosen, setSel, policy, setPolicy, hasRecord, ctl, role, stale, running, busy, onRun, error, onRefresh }) {
  const failing = chosen ? chosen.prerequisites.filter((p) => !p.ok).map((p) => (p.detail ? `${p.check} — ${p.detail}` : p.check)) : [];
  const why = [!ctl && `Running a workflow requires the operator or admin role (you are ${role || 'signed in without a role'}).`, stale && 'The backend is not answering, so the motor state is not current.'].filter(Boolean);
  return (
    <Card title={hasRecord ? 'Start another workflow' : 'Motor status and test selection'} id="wf-config" icon={FlaskConical}
      sub={hasRecord ? 'Steps 1–2 for a new run. The record above stays until the new run answers.' : 'Steps 1–2: confirm the motor can be tested, then choose what to investigate.'}
      right={<button type="button" className="tq-btn" onClick={onRefresh} aria-label="Refresh prerequisites"><RefreshCw size={14} aria-hidden="true" /></button>}>
      <AgainFold folded={hasRecord}>
      {error &&<p className="tq-callout crit" role="alert">Patterns unavailable: {error}</p>}
      <div className="tq-an-context" data-testid="wf-motor">
        <span className="tq-an-ctx-item"><span>Mode</span><strong>{physical ? <><Usb size={13} aria-hidden="true" /> Physical</> : <><FlaskConical size={13} aria-hidden="true" /> Simulation</>}</strong></span>
        <span className="tq-an-ctx-item"><span>Data source</span><strong><SourceTag kind={physical ? 'PHYSICAL' : 'SIMULATED'} /></strong></span>
        {physical ? <span className="tq-muted tq-small tq-an-ctx-note">Physical device: prerequisites are read from the device's own status; no simulator data is shown here.</span> : !ctx ? (
          <span className="tq-muted tq-small tq-an-ctx-note">No simulation is running. Start a scenario on the Overview or Live Monitor page.</span>) : (<>
          {ctx.session && <span className="tq-an-ctx-item"><span>Session</span><strong className="tq-num">{ctx.session}</strong></span>}
          {ctx.t != null && <span className="tq-an-ctx-item"><span>Simulation time</span><strong className="tq-num">t = {fmt(ctx.t, 0)} s</strong></span>}
          <span className="tq-an-ctx-item"><span>Setpoint</span><strong className="tq-num">{rpm(ctx.setpoint_rpm)} rpm</strong></span>
          <span className="tq-an-ctx-item"><span>Incident</span><strong>{ctx.incident ? `${ctx.incident.id} · ${title(ctx.incident.state)}` : 'none'}</strong></span>
          <span className="tq-an-ctx-item"><span>Held for approval</span><strong>{ctx.pending_approval ? `${title(ctx.pending_approval.action)}${ctx.pending_approval.params?.rpm ? ` ${rpm(ctx.pending_approval.params.rpm)} rpm` : ''}` : 'nothing'}</strong></span>
          {ctx.estop && <Pill tone="stop">E-STOP</Pill>}
          {ctx.execution_note && <p className="tq-muted tq-small tq-an-ctx-note">{ctx.execution_note}</p>}</>)}
      </div>
      <h4 className="tq-an-h">Choose a test pattern</h4>
      {!patterns.length ? <Empty loading={!error}>Loading the test patterns…</Empty> : (
        <fieldset className="tq-wf-patterns" disabled={busy}>
          <legend className="tq-sr">Diagnostic test pattern</legend>
          {patterns.map((p) => (
            <label key={p.id} className={`tq-wf-pattern ${chosen?.id === p.id ? 'is-on' : ''} ${p.available ? '' : 'is-off'}`} data-testid={`wf-pattern-${p.id}`}>
              <input type="radio" name="wf-pattern" value={p.id} checked={chosen?.id === p.id} onChange={() => setSel(p.id)} />
              <span className="tq-wf-pattern-name">{p.name}</span>
              <span className="tq-muted tq-small">{p.investigates}</span>
              <span className="tq-an-pattern-foot">{p.available ? <Pill tone="ok">can run</Pill> : <Pill tone="off">not available</Pill>}{p.duration_s ? <span className="tq-muted tq-small tq-num">{p.duration_s} simulated s</span> : null}</span>
            </label>))}
        </fieldset>)}
      {chosen && (
        <div className="tq-wf-detail" data-testid="wf-pattern-detail">
          <p>{chosen.purpose}</p>
          <div className="tq-grid tq-grid-2">
            <div>
              <h4 className="tq-an-h">Sequence and parameters</h4>
              {chosen.sequence.length ? (
                <div className="tq-table-wrap"><table className="tq-table"><caption className="tq-sr">Test sequence</caption>
                  <thead><tr><th scope="col">Step</th><th scope="col">Target</th><th scope="col">Dwell</th></tr></thead>
                  <tbody>{chosen.sequence.map((s, i) => <tr key={i}><td>{s.what}</td><td className="tq-num">{s.rpm ? `${rpm(s.rpm)} rpm` : 'driver off'}</td><td className="tq-num">{s.hold_s} s</td></tr>)}</tbody></table></div>
              ) : <p className="tq-muted tq-small">{chosen.id === 'ADAPTIVE' ? 'Chosen at run time by expected information gain (T1, T3 or T4).' : 'No sequence: the pattern cannot run in this mode.'}</p>}
              <p className="tq-small"><span className="tq-muted">Signals: </span>{chosen.signals.join(', ')}</p>
              <p className="tq-small"><span className="tq-muted">Expected observations: </span>{chosen.expected_observations.join('; ')}</p>
              {chosen.ends_with_motor_stopped && <p className="tq-small tq-muted">Ends with the (copy of the) motor coasting to a stop.</p>}
            </div>
            <div>
              <h4 className="tq-an-h">Prerequisites now <span className="tq-muted tq-small">({chosen.prerequisites.filter((p) => p.ok).length} of {chosen.prerequisites.length} hold)</span></h4>
              <CheckList dense testid="wf-prereqs" label="Prerequisites for the selected pattern"
                items={chosen.prerequisites.map((p) => ({ key: p.check, label: p.check, detail: p.detail || undefined, state: p.ok ? 'ok' : 'fail', status: p.ok ? 'holds' : 'fails' }))} />
              <p className="tq-small tq-mt"><span className="tq-muted">Simulation: </span>{chosen.availability.SIMULATION}</p>
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
          {running ? <Loader2 size={15} className="tq-spin" aria-hidden="true" /> : <Play size={15} aria-hidden="true" />} {running ? 'Running diagnostic workflow…' : 'Run Diagnostic Workflow'}</button>
      </div>
      <p className="tq-muted tq-small">
        {policy === 'auto_when_permitted' ? 'Pre-authorizes only the recommended REDUCE SPEED or STOP; the backend still applies freshness, the decision gate, prediction support and the Safety Supervisor, and sends nothing if any refuses.'
          : 'TORQVA stops before any command and shows exactly which action, RPM and evidence you are authorizing.'}
      </p>
      {why.length > 0 && <p className="tq-callout warn tq-small">{why.join(' ')}</p>}
      {chosen && !chosen.available && failing.length > 0 && <BlockedReason title={`${chosen.name} cannot run now`} reasons={failing} testid="wf-run-blocked" />}
      </AgainFold>
    </Card>
  );
}

/* ------------------------------------------------------------------ the workflow record, section by section */
function WorkflowRecord({ wf, ctl, busy, onAuthorize, onDecline, go, physical }) {
  const c = wf.context || {};
  return (
    <div className="tq-stack" data-testid="wf-record" data-status={wf.status}>
      <StartAndExecution wf={wf} physical={physical} />
      {(c.diagnosis || c.evidence) && <EvidenceAndDiagnosis c={c} />}
      {c.recommendation && <Recommendation wf={wf} />}
      {c.recommendation && <Authorization wf={wf} ctl={ctl} busy={busy} onAuthorize={onAuthorize} onDecline={onDecline} />}
      {(c.recommendation || c.intervention) && <Verification wf={wf} go={go} />}
      <FinalReport wf={wf} go={go} physical={physical} />
      {!physical && <Details wf={wf} />}
    </div>
  );
}

/* Steps 1–3: the motor state the run started from, the test that ran and what each stage of it returned. */
function StartAndExecution({ wf, physical }) {
  const c = wf.context || {};
  const it = c.initial_telemetry || {};
  const v = it.values || it;
  const st = c.initial_state;
  const t = c.test;
  const prereqs = c.prerequisites || [];
  const kind = physical ? 'MEASURED' : 'SIMULATED';
  const reading = (k, d) => (v[k] === null || v[k] === undefined || !Number.isFinite(Number(v[k])) ? null : fmt(v[k], d));
  return (
    <Card title="Motor status, test and execution" id="wf-sec-start" icon={Gauge} sub="Steps 1–3"
      right={<span className="tq-an-right"><Pill tone={STATUS_TONE[wf.status] || 'info'}>{title(wf.status)}</Pill>{wf.outcome !== wf.status && <OutcomePill outcome={wf.outcome} />}</span>}>
      <h4 className="tq-an-h">Backend stages</h4>
      <StageList wf={wf} />
      {wf.blockers?.length > 0 && (
        <div className="tq-alertpanel tq-crit tq-an-blockers" role="alert" data-testid="wf-blockers">
          <span className="tq-alertpanel-icon" aria-hidden="true"><Ban size={20} /></span>
          <div className="tq-alertpanel-body"><strong>{wf.status === 'BLOCKED' ? 'Blocked' : 'Not carried through'}</strong>
            <ul className="tq-list tq-small">{wf.blockers.map((b) => <li key={b}>{b}</li>)}</ul></div>
        </div>)}
      {wf.error && <p className="tq-callout crit" role="alert">{wf.error}</p>}
      <div className="tq-grid tq-grid-2 tq-mt">
        <div>
          <h4 className="tq-an-h">1 · Motor status at the start <SourceTag kind={physical ? 'PHYSICAL' : 'SIMULATED'} /></h4>
          <MetricList label="Motor state when the workflow started" items={[
            { key: 'rpm', label: 'Speed', value: reading('rpm', 0), unit: 'rpm', prov: kind, missingText: 'No reading' },
            { key: 'sp', label: 'Setpoint', value: st ? rpm(st.setpoint_rpm) : reading('setpoint', 0), unit: 'rpm', missingText: 'No reading' },
            { key: 'cur', label: 'Current', value: reading('current', 2), unit: 'A', prov: kind, missingText: 'No reading' },
            { key: 'hous', label: 'Housing temperature', value: reading('housing', 1), unit: '°C', prov: kind, missingText: 'No reading' },
            { key: 'vib', label: 'Vibration RMS', value: reading('vib_rms', 3), unit: 'g', prov: kind, missingText: 'No reading' },
            { key: 'valid', label: 'Telemetry', value: it.fresh === false ? 'not fresh' : it.valid === false ? 'invalid' : it.valid === true ? 'valid and fresh' : null, missingText: 'unknown' },
          ]} />
          {it.note && <p className="tq-muted tq-small">{it.note}.</p>}
          {st && <p className="tq-small tq-muted">Session {st.session} · t = {fmt(st.t, 0)} s · incident {st.incident ? `${st.incident.id} (${title(st.incident.state)})` : 'none'}{st.estop ? ' · E-STOP latched' : ''}</p>}
        </div>
        <div>
          <h4 className="tq-an-h">2 · Test selected</h4>
          {wf.pattern ? (<>
            <p className="tq-an-lead"><strong>{wf.pattern.name}</strong> <span className="tq-muted">— investigates {wf.pattern.investigates}</span></p>
            <p className="tq-small">{wf.pattern.purpose}</p>
            <p className="tq-small tq-muted">Policy {title(wf.execution_policy)} · requested by {wf.requested_by} ({wf.role}){wf.session ? ` · simulation session ${wf.session}` : ''}</p>
          </>) : <Empty>No pattern is recorded for this run.</Empty>}
          {prereqs.length > 0 && (
            <Disclosure summary="Prerequisites checked at the start" meta={`${prereqs.filter((p) => p.ok).length} of ${prereqs.length} held`} testid="wf-start-prereqs">
              <CheckList dense items={prereqs.map((p) => ({ key: p.check, label: p.check, detail: p.detail || undefined, state: p.ok ? 'ok' : 'fail', status: p.ok ? 'held' : 'failed' }))} label="Prerequisites at the start" />
            </Disclosure>)}
        </div>
      </div>
      <h4 className="tq-an-h tq-mt">3 · Test execution {t && <span className="tq-muted tq-small">· run {t.run_id} · {t.executed_on}</span>}</h4>
      {!t ? <Empty>{TERMINAL.includes(wf.status) ? 'No test ran in this workflow.' : 'The test result appears here when the backend records it.'}</Empty> : (
        <div className="tq-table-wrap"><table className="tq-table tq-small" data-testid="wf-test-stages"><caption className="tq-sr">Test stage results</caption>
          <thead><tr><th scope="col">Stage</th><th scope="col">Status</th><th scope="col">Observation (derived)</th><th scope="col">Ranking before → after</th></tr></thead>
          <tbody>{t.stages.map((s) => (
            <tr key={s.index}><th scope="row">{s.test === 'profile' ? 'Speed profile' : s.test}{s.simulated_seconds ? <span className="tq-muted tq-small tq-num"> {s.simulated_seconds} s</span> : null}</th>
              <td><Pill tone={s.status === 'completed' ? 'ok' : 'crit'}>{s.status}</Pill>{s.reason && <div className="tq-small">{s.reason}</div>}</td>
              <td>{s.observation ? s.observation_meaning.map((m, i) => `${m} ${fmt(s.observation[i], 3)}`).join(' · ')
                : s.steps ? s.steps.map((x) => `${rpm(x.target_rpm)} rpm: ${rpm(x.mean_rpm_settled)} settled, ${fmt(x.mean_current, 2)} A, ${fmt(x.mean_vib_rms, 3)} g, ${pct(x.flagged_fraction)} flagged`).join(' · ') : '—'}
                {s.signature_note && <div className="tq-muted">{s.signature_note}</div>}</td>
              <td>{rankText(s.posterior_before)} → {rankText(s.posterior_after)}</td></tr>))}</tbody></table></div>)}
    </Card>
  );
}

function StageList({ wf }) {
  const byName = Object.fromEntries((wf.stages || []).map((s) => [s.stage, s]));
  const terminal = TERMINAL.includes(wf.status);
  return (
    <ol className="tq-wf-stages" data-testid="wf-stages">
      {STAGES.map(([k, label], i) => {
        const s = byName[k];
        const state = s ? s.status : terminal ? 'skipped' : 'todo';
        return (
          <li key={k} className={`tq-wf-stage is-${state}`} data-stage={k} data-state={state} title={s?.summary || undefined}>
            <span className="tq-wf-stage-n" aria-hidden="true">{i + 1}</span>
            <span className="tq-wf-stage-body"><strong>{label}</strong>
              <span className="tq-small">{s ? <Pill tone={STAGE_TONE[s.status] || 'info'}>{s.status}</Pill> : <span className="tq-muted">{terminal ? 'not reached' : 'pending'}</span>}
                {s?.started_sim_t != null && <span className="tq-muted tq-num"> t = {fmt(s.started_sim_t, 0)} s</span>}</span>
              {s?.summary && <span className="tq-muted tq-small tq-wf-stage-sum">{s.summary}</span>}</span>
          </li>);
      })}
    </ol>
  );
}

/* ------------------------------------------------------------------ Steps 4–5: evidence (facts) apart from the diagnosis (interpretation) */
function EvidenceAndDiagnosis({ c }) {
  const dx = c.diagnosis; const ev = c.evidence; const an = c.analysis;
  const top = dx?.hypotheses?.[0];
  const post = dx?.posterior;
  return (
    <Card title="Evidence and diagnosis" id="wf-sec-dx" icon={Microscope} sub="Steps 4–5 · observed evidence, then TORQVA's interpretation"
      right={<span className="tq-an-right">{dx && <Pill tone={COND_TONE[dx.condition] || 'info'}>{title(dx.condition)}</Pill>}</span>}>
      <div className="tq-an-cols">
        <section className="tq-an-col" aria-labelledby="wf-ev-h">
          <h4 className="tq-an-h" id="wf-ev-h">4 · Evidence <SourceTag kind="SIMULATED" /></h4>
          {ev ? (
            <dl className="tq-kv tq-small" data-testid="wf-evidence">
              <dt>Windows (simulated 1 s)</dt><dd className="tq-num">{ev.windows} · {pct(ev.valid_fraction)} valid</dd>
              <dt>Windows scored / flagged</dt><dd className="tq-num">{ev.scored_windows} · {pct(ev.c1_flagged_fraction)} above threshold</dd>
              <dt>Tested setpoints</dt><dd className="tq-num">{ev.tested_setpoints_rpm.map(rpm).join(', ') || '—'} rpm</dd>
              <dt>Signals present</dt><dd>{ev.signals_present.join(', ') || 'none'}</dd>
              <dt>Missing signals</dt><dd>{ev.signals_missing.length ? ev.signals_missing.join(', ') : 'none'}</dd>
              {ev.unscored_statuses.length > 0 && <><dt>Unscored windows</dt><dd>{ev.unscored_statuses.map(title).join(', ')}</dd></>}
              <dt>Evidence quality</dt><dd>{an?.sufficiency ? title(an.sufficiency) : 'not applicable'}</dd>
            </dl>) : <Empty>No evidence was recorded.</Empty>}
          {ev?.kinds && <p className="tq-muted tq-small">Measured: {ev.kinds.measured}. Derived: {ev.kinds.derived}.</p>}
          {an?.sufficiency_rule && <p className="tq-muted tq-small">Sufficiency rule: {an.sufficiency_rule}.</p>}
        </section>
        <section className="tq-an-col is-ai" aria-labelledby="wf-dx-h">
          <h4 className="tq-an-h" id="wf-dx-h">5 · Diagnosis <span className="tq-an-ai">AI interpretation, not proof</span></h4>
          {dx && <div className={`tq-narrate tone-${COND_TONE[dx.condition] || 'info'}`} data-testid="wf-diagnosis"><strong>{dx.headline}</strong><span>{dx.detail}</span></div>}
          {dx?.ranked?.length ? <PosteriorBars ranked={dx.ranked.slice(0, 4)} label={dx.posterior?.label} />
            : <Empty>{dx?.condition === 'NO_ANOMALY_DETECTED' ? 'No ranking: the hypothesis model ranks faults, and Anomaly Detection found no anomaly to explain.' : 'No ranking from this evidence.'}</Empty>}
          {post && (
            <p className="tq-small tq-an-uncert"><span className="tq-muted">Uncertainty: </span>margin {fmt(post.margin, 2)} between the top two · {post.n_windows} evidence windows
              {post.ood ? <> · <Pill tone="warn">unlike any learned signature</Pill></> : ''}</p>)}
          {dx?.test_changed_leading_hypothesis != null && <p className="tq-small">{dx.test_changed_leading_hypothesis ? <Pill tone="warn">the test changed the leading hypothesis</Pill> : <span className="tq-muted">The test kept the leading hypothesis of the live run ({title(dx.live_ranking_top)}).</span>}</p>}
          {dx?.recommended_next_test && <p className="tq-small"><span className="tq-muted">Next test: </span>{dx.recommended_next_test.worth_running ? `${dx.recommended_next_test.test} would remove ${fmt(dx.recommended_next_test.expected_info_gain_nats, 2)} nats` : 'none worth running'}</p>}
        </section>
      </div>
      {dx?.missing?.length > 0 && <p className="tq-callout warn">Limits on this conclusion: {dx.missing.join('; ')}.</p>}
      {top && (top.supporting?.length > 0 || top.contradicting?.length > 0) && (
        <Disclosure summary="Why this ranking" meta={`features supporting and contradicting ${title(top.hypothesis)}`} testid="wf-evidence-more" className="tq-mt">
          <div data-testid="wf-features">
            <h4 className="tq-an-h">Why {title(top.hypothesis)}{top.compared_with ? ` rather than ${title(top.compared_with)}` : ''}</h4>
            <ul className="tq-list tq-small">
              {top.supporting.map((f) => <li key={`s${f.feature}`}><Pill tone="ok">supports</Pill> {f.feature}: observed {fmt(f.observed_z, 1)}σ vs signature {fmt(f.signature_z, 1)}σ</li>)}
              {top.contradicting.map((f) => <li key={`c${f.feature}`}><Pill tone="warn">contradicts</Pill> {f.feature}: observed {fmt(f.observed_z, 1)}σ vs signature {fmt(f.signature_z, 1)}σ</li>)}
            </ul>
            <p className="tq-muted tq-small">{dx.feature_evidence_source}.</p>
          </div>
        </Disclosure>)}
      {dx?.scenario_note && <p className="tq-muted tq-small tq-an-truth"><strong>Scenario ground truth</strong> (simulation only, never used by TORQVA): {dx.scenario_truth ? title(dx.scenario_truth) : 'no active fault'} — {dx.scenario_note}</p>}
    </Card>
  );
}

/* ------------------------------------------------------------------ Steps 6–7: predicted outcomes and the recommended decision */
function Recommendation({ wf }) {
  const rec = wf.context.recommendation; const pr = wf.context.predictions; const chk = wf.context.execution_check;
  const awaiting = wf.status === 'AWAITING_AUTHORIZATION';
  const change = rec.change_rpm;
  const po = rec.predicted_outcome;
  const rows = useMemo(() => (po?.rows || []).filter((r) => r.horizon_s === 120 || r.horizon_s === 30), [po]);
  const predOf = useMemo(() => Object.fromEntries([...(pr?.candidates || []), ...(pr?.references || [])].map((p) => [p.candidate_id, p])), [pr]);
  const at120 = (p, s, d) => { const i = (p?.horizons_s || [30, 60, 120]).indexOf(120); const m = p?.mean?.[s]?.[i]; return m == null ? '—' : fmt(m, d); };
  return (
    <Card title="Prediction and decision" id="wf-sec-rec" icon={LineChart} sub="Steps 6–7"
      right={<span className="tq-an-right">{rec.actionable ? <Pill tone="info">command</Pill> : <Pill tone="off">no command</Pill>}</span>}>
      <div className={`tq-wf-rec kind-${rec.kind}`} data-testid="wf-recommendation" data-action={rec.action}>
        <div className="tq-wf-rec-label">RECOMMENDED ACTION <ProvBadge kind="DERIVED" /></div>
        <div className="tq-wf-rec-head">{rec.headline}</div>
        <div className="tq-wf-rec-kpis">
          <div><span>Current speed</span><strong className="tq-num">{rpm(rec.current_rpm)} rpm</strong></div>
          <div><span>Current setpoint</span><strong className="tq-num">{rpm(rec.current_setpoint_rpm)} rpm</strong></div>
          <div data-testid="wf-target"><span>Recommended target</span><strong className="tq-num">{rec.action === 'STOP' ? 'stop' : rec.target_rpm != null ? `${rpm(rec.target_rpm)} rpm` : `${rpm(rec.current_setpoint_rpm)} rpm (no change)`}</strong></div>
          <div><span>Change</span><strong className="tq-num">{change == null ? '0 rpm' : `${change > 0 ? '+' : ''}${rpm(change)} rpm`}</strong></div>
        </div>
      </div>
      <div className="tq-an-cols tq-mt">
        <section className="tq-an-col" aria-labelledby="wf-why-h">
          <h4 className="tq-an-h" id="wf-why-h">Rationale</h4>
          <ul className="tq-list tq-small" data-testid="wf-why">{rec.why.map((w, i) => <li key={i}>{w}</li>)}</ul>
          <h4 className="tq-an-h">Adjustments</h4>
          <ul className="tq-list tq-small" data-testid="wf-adjustments">{rec.adjustments.map((a, i) => (
            <li key={i}><strong>{a.parameter}</strong>{a.from_rpm != null ? `: ${rpm(a.from_rpm)} → ${rpm(a.to_rpm)} rpm` : a.to ? `: ${a.from ? `${a.from} → ` : ''}${a.to}` : ''}{a.why ? ` — ${a.why}` : ''}
              {a.constraint && <div className="tq-muted">{a.constraint}</div>}{a.expected && <div className="tq-muted">{a.expected} (predicted)</div>}</li>))}</ul>
          <p className="tq-muted tq-small">Decision rule: {rec.decision_rule}.</p>
        </section>
        <section className="tq-an-col is-pred" aria-labelledby="wf-po-h">
          <h4 className="tq-an-h" id="wf-po-h">6 · Predicted outcome <SourceTag kind="PREDICTED" /></h4>
          {!pr?.available ? <p className="tq-small tq-muted" data-testid="wf-pred-unavailable">Prediction unavailable: {pr?.reason}.</p> : !po ? <p className="tq-small tq-muted">No command, so no outcome is predicted for it. Candidate predictions are compared below.</p> : (
            <div className="tq-table-wrap"><table className="tq-table tq-small" data-testid="wf-predicted"><caption className="tq-sr">Predicted outcome of the recommended action</caption>
              <thead><tr><th scope="col">Signal</th><th scope="col">Now</th><th scope="col">At</th><th scope="col">Predicted (90 % interval)</th></tr></thead>
              <tbody>{rows.map((r) => { const [n, u, dg] = SIGNAL[r.signal] || [r.signal, '', 2]; return (
                <tr key={`${r.signal}${r.horizon_s}`}><th scope="row">{n}</th><td className="tq-num">{fmt(r.now, dg)} {u}</td><td className="tq-num">{r.horizon_s} s</td>
                  <td className="tq-num">{fmt(r.predicted_mean, dg)} ({fmt(r.lo, dg)}–{fmt(r.hi, dg)}) {u}</td></tr>); })}</tbody></table></div>)}
          {po && <p className="tq-muted tq-small">Risk {fmt(po.risk, 2)}{po.continue_risk != null ? ` vs ${fmt(po.continue_risk, 2)} if nothing changes` : ''} · {po.interval_meaning}.</p>}
          {rec.limitations?.length > 0 && <><h4 className="tq-an-h">Limitations</h4><ul className="tq-list tq-small">{rec.limitations.map((l) => <li key={l}>{l}</li>)}</ul></>}
          <h4 className="tq-an-h">Constraints</h4>
          <p className="tq-muted tq-small">{rec.constraints.join('; ')} · {rec.control_resolution}.</p>
        </section>
      </div>
      {rec.ranking?.length > 0 && (
        <div className="tq-mt" data-testid="wf-candidates-more">
          <h4 className="tq-an-h">Candidate comparison <span className="tq-muted tq-small">· {rec.ranking.length} candidates ranked by Failure Prediction · predicted values at 120 s</span></h4>
          <div className="tq-table-wrap"><table className="tq-table tq-small" data-testid="wf-candidates"><caption className="tq-sr">Candidate actions compared by Failure Prediction</caption>
            <thead><tr><th scope="col">Rank</th><th scope="col">Candidate</th><th scope="col">Action</th><th scope="col">Target</th><th scope="col">Vibration @120 s (PRED)</th><th scope="col">Housing @120 s (PRED)</th><th scope="col">Risk</th><th scope="col">Failure Prediction status</th><th scope="col">Selection</th></tr></thead>
            <tbody>{rec.ranking.map((r) => { const p = predOf[r.candidate_id]; return (
              <tr key={r.candidate_id} className={r.candidate_id === rec.candidate_id ? 'is-on' : ''}><td className="tq-num">{r.rank}</td><td>{r.label}{r.pipeline_default ? <span className="tq-muted"> (pipeline default)</span> : ''}</td><td>{title(r.action)}</td>
                <td className="tq-num">{r.action === 'REDUCE_SPEED' ? `${rpm(r.target_rpm)} rpm` : r.action === 'STOP' ? 'stop' : '—'}</td>
                <td className="tq-num">{at120(p, 'vib_rms', 3)}{p ? ' g' : ''}</td><td className="tq-num">{at120(p, 'housing', 1)}{p ? ' °C' : ''}</td>
                <td className="tq-num">{fmt(r.risk, 2)}</td><td>{title(r.status)}</td>
                <td>{r.candidate_id === rec.candidate_id ? <Pill tone="ok">recommended</Pill> : r.eligible ? 'eligible' : <span className="tq-muted">{r.excluded_because}</span>}</td></tr>); })}</tbody></table></div>
        </div>)}
      {chk && !awaiting && !wf.context.intervention && rec.actionable && (
        <p className="tq-muted tq-small" data-testid="wf-exec-check">Control pipeline check: gate {chk.gate ? title(chk.gate.verdict) : '—'} · Safety Supervisor {title(chk.supervisor?.verdict)} · {chk.awaiting_decision ? 'an action is held for a human decision' : 'no action is held for a human decision'}.</p>)}
    </Card>
  );
}

/* Step 7 (authorization): always its own explicit, role-gated action. Nothing is sent before it. */
function Authorization({ wf, ctl, busy, onAuthorize, onDecline }) {
  const rec = wf.context.recommendation;
  const auth = wf.context.authorization;
  const awaiting = wf.status === 'AWAITING_AUTHORIZATION';
  if (!awaiting && !auth?.decision) return null;
  return (
    <Card title="Authorization" id="wf-sec-auth" icon={ShieldCheck} sub="Step 7 · a person decides"
      right={auth?.decision ? <><Pill tone={auth.decision === 'AUTHORIZED' ? 'ok' : auth.decision === 'EXPIRED' ? 'warn' : 'off'}>{title(auth.decision).toLowerCase()}</Pill><ProvBadge kind="HUMAN_CONFIRMED" /></> : <Pill tone="wait">awaiting a decision</Pill>}>
      {awaiting ? (
        <div className="tq-an-auth" data-testid="wf-authorize-box">
          <strong className="tq-an-auth-head">Authorization required: {rec.headline}</strong>
          <dl className="tq-kv tq-small">
            <dt>Action</dt><dd>{title(rec.action)}{rec.target_rpm != null && rec.action !== 'STOP' ? ` to ${rpm(rec.target_rpm)} rpm` : ''}</dd>
            <dt>Candidate</dt><dd className="tq-num">{rec.candidate_id}</dd>
            <dt>Evidence basis</dt><dd className="tq-num">simulation t = {fmt(rec.basis?.t, 0)} s{rec.basis?.posterior_top ? ` · ${title(rec.basis.posterior_top)} (${rec.basis.posterior_label})` : ''}</dd>
            {auth?.expires && <><dt>Expires</dt><dd>{auth.expires}</dd></>}
          </dl>
          <p className="tq-small">Nothing has been sent. Authorizing re-runs every safety check first.</p>
          <div className="tq-row">
            <button type="button" className="tq-btn tq-primary" onClick={onAuthorize} disabled={!ctl || !!busy} data-testid="wf-authorize">
              {busy === 'authorize' ? <Loader2 size={14} className="tq-spin" aria-hidden="true" /> : <ShieldCheck size={14} aria-hidden="true" />} {busy === 'authorize' ? 'Sending…' : 'Authorize and execute'}</button>
            <button type="button" className="tq-btn" onClick={onDecline} disabled={!ctl || !!busy} data-testid="wf-decline"><Ban size={14} aria-hidden="true" /> {busy === 'decline' ? 'Declining…' : 'Decline'}</button>
          </div>
          {!ctl && <p className="tq-muted tq-small">Authorizing requires the operator or admin role.</p>}
        </div>
      ) : (
        <dl className="tq-kv tq-small" data-testid="wf-auth-record">
          <dt>Decision</dt><dd>{title(auth.decision)}</dd>
          {auth.by && <><dt>By</dt><dd>{auth.by}{auth.role ? ` (${auth.role})` : ''}</dd></>}
          {auth.sim_t != null && <><dt>At</dt><dd className="tq-num">simulation t = {fmt(auth.sim_t, 0)} s</dd></>}
          {auth.how && <><dt>How</dt><dd>{auth.how}</dd></>}
          {auth.reason && <><dt>Reason</dt><dd>{auth.reason}</dd></>}
          {auth.expired_because && <><dt>Expired because</dt><dd>{auth.expired_because}</dd></>}
        </dl>)}
    </Card>
  );
}

/* ------------------------------------------------------------------ Steps 8–9: intervention and recovery verification */
function Verification({ wf, go }) {
  const iv = wf.context.intervention; const v = wf.context.verification;
  if (!iv) {
    return (
      <Card title="Intervention and recovery" id="wf-sec-verify" icon={Activity} sub="Steps 8–9" right={<ProvBadge kind="SIMULATED" />}>
        <p className="tq-muted" data-testid="wf-verify-none">{wf.status === 'AWAITING_AUTHORIZATION' ? 'Nothing has been sent yet. Verification starts after an authorized command is acknowledged.' : 'No command was executed by this workflow, so there is no outcome to verify.'}</p>
      </Card>);
  }
  const cmd = v?.command || iv.command || {};
  const improved = v?.c1_score_after != null && v?.c1_score_before != null && v.c1_score_after < v.c1_score_before;
  const steps = [
    ['requested', 'Command requested', iv.command_id != null, iv.command_id != null ? `#${iv.command_id} ${title(cmd.action)}${iv.command?.params?.rpm ? ` ${rpm(iv.command.params.rpm)} rpm` : ''}` : 'not dispatched'],
    ['accepted', 'Accepted by the simulated device', !!cmd.accepted, cmd.status || '—'],
    ['executed', 'Execution confirmed', !!cmd.executed, cmd.executed ? 'the device reports it took effect' : 'not confirmed'],
    ['improved', 'Improvement observed', improved, v ? `Anomaly severity (× threshold) ${fmt(v.c1_score_before, 2)} before → ${fmt(v.c1_score_after, 2)} after (${v.post_ack_windows} windows)` : '—'],
    ['verified', 'Recovery verified', wf.outcome === 'RECOVERY_VERIFIED', v?.assessment ? `${title(v.assessment.outcome)}: ${(v.assessment.reasons || []).map(title).join(', ')}` : 'waiting'],
  ];
  return (
    <Card title="Intervention and recovery" id="wf-sec-verify" icon={Activity} sub="Steps 8–9" right={<span className="tq-an-right"><OutcomePill outcome={wf.outcome} /><ProvBadge kind="SIMULATED" /></span>}
      foot={<>{iv.receipt_id && <span className="tq-small">Decision summary <strong>{iv.receipt_id}</strong></span>}<LinkButton onClick={() => go?.('interventions')}>Open Action Recommendations</LinkButton><LinkButton onClick={() => go?.('recovery')}>Open Recovery Verification</LinkButton></>}>
      <CheckList testid="wf-verify-steps" label="Command and verification lifecycle"
        items={steps.map(([k, label, ok, detail]) => ({ key: k, label, detail, state: ok ? 'ok' : 'pending', status: ok ? 'yes' : 'not yet' }))} />
      {wf.status === 'VERIFYING_OUTCOME' && <p className="tq-callout info">Verification needs fresh simulated readings: run the simulation in Scenario Studio to finish it.</p>}
      {iv.note && <p className="tq-muted tq-small">{iv.note}.</p>}
      {v?.predicted_vs_observed?.length > 0 && (
        <Disclosure summary="Compare the prediction with what was observed" meta={`${v.predicted_vs_observed.filter((r) => r.inside_interval).length} of ${v.predicted_vs_observed.length} samples inside the 90 % interval`} testid="wf-pvo-more">
        <div className="tq-table-wrap"><table className="tq-table tq-small" data-testid="wf-pvo"><caption className="tq-sr">Predicted versus observed</caption>
          <thead><tr><th scope="col">Signal</th><th scope="col">At</th><th scope="col">Predicted (interval)</th><th scope="col">Observed (SIM)</th><th scope="col">Inside</th></tr></thead>
          <tbody>{v.predicted_vs_observed.map((r) => { const [n, u, dg] = SIGNAL[r.signal] || [r.signal, '', 2]; return (
            <tr key={`${r.signal}${r.horizon_s}`}><th scope="row">{n}</th><td className="tq-num">{r.horizon_s} s</td><td className="tq-num">{fmt(r.predicted_mean, dg)} ({fmt(r.lo, dg)}–{fmt(r.hi, dg)}) {u}</td>
              <td className="tq-num">{fmt(r.observed, dg)} {u}</td><td>{r.inside_interval ? <Pill tone="ok">yes</Pill> : <Pill tone="warn">no</Pill>}</td></tr>); })}</tbody></table>
          <p className="tq-muted tq-small">Single samples at each horizon.</p></div>
        </Disclosure>)}
    </Card>
  );
}

/* ------------------------------------------------------------------ Step 10: the traceable chain test → evidence → … → recovery */
function FinalReport({ wf, go, physical }) {
  const c = wf.context || {};
  const by = Object.fromEntries((wf.stages || []).map((s) => [s.stage, s]));
  const terminal = TERMINAL.includes(wf.status);
  const stateOf = (...ks) => { const ss = ks.map((k) => by[k]).filter(Boolean); if (!ss.length) return 'pending'; if (ss.some((s) => ['blocked', 'failed'].includes(s.status))) return 'fail';
    if (ss.some((s) => s.status === 'expired')) return 'warn'; if (ss.every((s) => s.status === 'completed') && ss.length === ks.length) return 'ok'; return 'info'; };
  const link = (view, text) => <LinkButton onClick={() => go?.(view)}>{text}</LinkButton>;
  const dx = c.diagnosis; const rec = c.recommendation; const iv = c.intervention; const auth = c.authorization;
  const items = [
    { key: 'test', label: 'Test', state: stateOf('RUNNING_DIAGNOSTIC_TEST'), status: c.test ? `run ${c.test.run_id}` : 'not run', detail: c.test ? `${wf.pattern?.name}: ${title(c.test.status)}` : by.VALIDATING?.summary, action: !physical && c.test ? link('tests', 'Diagnostic Investigation') : null },
    { key: 'evidence', label: 'Evidence', state: stateOf('COLLECTING_EVIDENCE', 'ANALYSING_EVIDENCE'), status: c.evidence ? `${c.evidence.windows} windows` : 'none', detail: by.COLLECTING_EVIDENCE?.summary },
    { key: 'diagnosis', label: 'Diagnosis (AI interpretation)', state: stateOf('GENERATING_DIAGNOSIS'), status: dx ? title(dx.condition).toLowerCase() : 'none', detail: dx?.headline, action: dx ? link('diagnostics', 'Anomaly Detection') : null },
    { key: 'prediction', label: 'Prediction', state: c.predictions?.available === false ? 'info' : stateOf('CALCULATING_PREDICTIONS'), status: c.predictions ? (c.predictions.available ? 'predicted' : 'not applicable') : 'none', detail: by.CALCULATING_PREDICTIONS?.summary, action: c.predictions?.available ? link('predictions', 'Failure Prediction') : null },
    { key: 'decision', label: 'Decision', state: auth?.decision === 'AUTHORIZED' ? 'ok' : auth?.decision === 'EXPIRED' ? 'warn' : auth?.decision === 'DECLINED' ? 'info' : stateOf('GENERATING_RECOMMENDATION'), status: auth?.decision ? title(auth.decision).toLowerCase() : rec ? (rec.actionable ? (wf.status === 'AWAITING_AUTHORIZATION' ? 'awaiting authorization' : 'recommended') : 'no command') : 'none', detail: rec?.headline },
    { key: 'intervention', label: 'Intervention', state: iv ? stateOf('EXECUTING_ACTION') : 'pending', status: iv?.command_id != null ? `command #${iv.command_id}` : 'none sent', detail: iv ? `${title(iv.command?.action)} via ${title(iv.path)}${iv.receipt_id ? ` · receipt ${iv.receipt_id}` : ''}` : 'nothing was sent to the motor', action: iv ? link('interventions', 'Action Recommendations') : null },
    { key: 'recovery', label: 'Recovery', state: wf.outcome === 'RECOVERY_VERIFIED' ? 'ok' : iv ? stateOf('VERIFYING_OUTCOME') : 'pending', status: iv ? (OUTCOME[wf.outcome]?.[1] || title(wf.outcome)).toLowerCase() : 'not applicable', detail: by.VERIFYING_OUTCOME?.summary, action: iv ? link('recovery', 'Recovery') : null },
  ];
  return (
    <Card title={terminal ? 'Final report' : 'Report so far'} id="wf-sec-report" icon={FileText} sub="Step 10"
      right={<OutcomePill outcome={wf.outcome} />}>
      <CheckList testid="wf-report" label="Workflow chain" items={items} />
      <p className="tq-muted tq-small">Workflow {wf.id} · {wf.mode === 'PHYSICAL' ? 'physical mode' : `simulation${wf.session ? ` session ${wf.session}` : ''}`} · {(wf.events || []).length} recorded events. A diagnosis is a ranked interpretation, a prediction is a model estimate, and only Recovery Verification verifies recovery.</p>
    </Card>
  );
}

/* ------------------------------------------------------------------ raw evidence: series, snapshot, model details, events */
function Details({ wf }) {
  const c = wf.context || {};
  const series = c.test?.series || [];
  return (
    <Card title="Evidence details" id="wf-details" sub="Advanced: raw records">
      <Disclosure summary="Test time series" meta={`${series.length} points${c.test?.series_step > 1 ? `, every ${c.test.series_step}th window` : ''}`} testid="wf-series">
        {series.length > 1 ? (<div className="tq-grid tq-grid-2">
          <div role="img" aria-label="Speed during the test" className="tq-chart"><TrendLines data={series} height={180} digits={0} unit="rpm" lines={[{ key: 'rpm', name: 'observed rpm', color: 'var(--tq-chart-ink)' }, { key: 'setpoint', name: 'setpoint', color: 'var(--tq-chart-1)', dash: '4 3' }]} /></div>
          <div role="img" aria-label="Vibration during the test" className="tq-chart"><TrendLines data={series} height={180} digits={3} unit="g" lines={[{ key: 'vib_rms', name: 'vibration RMS', color: 'var(--tq-chart-3)' }]} /></div>
          <div role="img" aria-label="Current during the test" className="tq-chart"><TrendLines data={series} height={180} digits={2} unit="A" lines={[{ key: 'current', name: 'current', color: 'var(--tq-chart-4)' }]} /></div>
          <div role="img" aria-label="anomaly severity during the test" className="tq-chart"><TrendLines data={series} height={180} digits={2} unit="" lines={[{ key: 'score', name: 'Anomaly severity (× threshold)', color: 'var(--tq-chart-2)' }]} /></div>
        </div>) : <Empty>No test windows were recorded.</Empty>}
      </Disclosure>
      {c.initial_telemetry && (
        <Disclosure summary="Initial telemetry snapshot" meta="as recorded when the workflow started">
          <dl className="tq-kv tq-small">{['t', 'rpm', 'setpoint', 'current', 'voltage', 'power', 'housing', 'vib_rms', 'valid', 'age_s'].filter((k) => k in c.initial_telemetry).map((k) => (
            <React.Fragment key={k}><dt>{k}</dt><dd className="tq-num">{String(c.initial_telemetry[k] ?? 'unavailable')}</dd></React.Fragment>))}</dl></Disclosure>)}
      {c.predictions?.available && (
        <Disclosure summary="Model details" meta="what the predictor was conditioned on and whether it is trusted">
          <dl className="tq-kv tq-small">
            <dt>Prediction conditioned on</dt><dd>{rankText(c.predictions.conditioned_on)}</dd>
            <dt>Prediction trusted</dt><dd>{c.predictions.trust.trusted ? 'yes' : `no (${c.predictions.trust.reasons.map(title).join(', ')})`}</dd>
            <dt>Validated by intervention experiments</dt><dd>{c.predictions.validated_by_experiments ? 'yes' : 'no'}</dd>
            <dt>Target grid</dt><dd>{c.predictions.target_grid}</dd>
            {c.recommendation?.gate && <><dt>Gate</dt><dd>{title(c.recommendation.gate.verdict)}: {c.recommendation.gate.reason}</dd></>}
          </dl></Disclosure>)}
      <Disclosure summary={`Workflow events (${wf.events?.length || 0})`} meta="every state change, in order" testid="wf-events-more">
        <ol className="tq-list tq-small" data-testid="wf-events">{(wf.events || []).map((e, i) => <li key={i}><span className="tq-num tq-muted">{e.sim_t != null ? `t = ${fmt(e.sim_t, 0)} s` : new Date(e.unix * 1000).toLocaleTimeString()}</span> {title(e.from)} → <strong>{title(e.to)}</strong>{e.summary ? ` — ${e.summary}` : ''}</li>)}</ol>
      </Disclosure>
    </Card>
  );
}
