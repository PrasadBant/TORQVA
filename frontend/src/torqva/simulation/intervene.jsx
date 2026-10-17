// Interventions (C3), simulation mode: review the action selected on Predictions, check it with the deterministic decision gate and the
// Safety Supervisor (POST /simulation/workbench/check, no side effect), and, only when both allow it and the pipeline is holding an action for
// a human decision, request it (POST /simulation/workbench/request). The backend repeats every check; the browser cannot authorise anything.
// The lifecycle below is read from the run's own log, commands and outcomes: a selection is not an action, an acknowledgement is not recovery.
import React, { useCallback, useEffect, useState } from 'react';
import { ShieldCheck, Send, X, ArrowLeft, RefreshCw } from 'lucide-react';
import { api } from '../api.js';
import { Card, Empty, ErrorBox, Pill, ProvBadge, fmt, PageHead } from '../shared/components.jsx';
import { InterventionsPage } from './pages.jsx';
import { canControl } from './scenario.jsx';
import { currentIncident } from './pipeline.js';
import { title, pct, fmtRpm } from './workbench.js';
import { ReceiptsPanel } from './receipts.jsx';
import { InvestigationTrace } from './trace.jsx';

const GATE_TONE = { ACT: 'ok', RUN_DIAGNOSTIC_TEST: 'info', REQUEST_MORE_DATA: 'wait', ESCALATE_HUMAN: 'wait', SAFE_STOP: 'stop', SENSOR_UNRELIABLE: 'crit' };
const ACKED = ['ACCEPTED', 'COMPLETED'];
const REFUSED = ['REJECTED', 'ABORTED', 'TIMEOUT', 'EXPIRED'];

/** The incident's action lifecycle from genuine records. Each step: [key, label, state(done|now|no|todo), detail, t]. */
export function lifecycleOf(d) {
  const inc = currentIncident(d);
  if (!inc) return { inc: null, steps: [] };
  const L = (d.log || []).filter((l) => l.incident === inc.id);
  const last = (f) => { for (let i = L.length - 1; i >= 0; i--) if (f(L[i])) return L[i]; return null; };
  const tr = (ev) => last((l) => l.kind === 'transition' && l.event === ev);
  const gate = last((l) => l.kind === 'gate');
  const deferred = last((l) => l.kind === 'supervisor' && l.verdict === 'DEFER' && ['REDUCE_SPEED', 'STOP'].includes(l.action));
  const proposed = tr('ACTION_PROPOSED');
  const approved = tr('APPROVED'); const rejected = tr('REJECTED_OR_EXPIRED');
  const analyst = last((l) => l.kind === 'analyst_action');
  const cmd = [...(d.commands || [])].reverse().find((c) => c.incident === inc.id && ['REDUCE_SPEED', 'STOP', 'SET_SPEED'].includes(c.action));
  const assess = last((l) => l.kind === 'recovery_assessment');
  const out = [...(d.outcomes || [])].reverse().find((o) => o.incident === inc.id);
  const state = d.status?.incident?.id === inc.id ? d.status.incident.state : inc.state;
  const st = (k, label, s, detail = '', t = null) => [k, label, s, detail, t];
  const steps = [
    st('gate', 'Decision reviewed (C3 gate)', gate ? (gate.verdict === 'ACT' ? 'done' : 'no') : 'todo', gate ? `${title(gate.verdict)}: ${gate.reason}` : '', gate?.t),
    st('proposed', 'Proposed', proposed ? 'done' : 'todo', proposed ? 'C2 ranked the candidates and the pipeline proposed an action' : 'no action proposed yet', proposed?.t),
    st('approval', 'Awaiting approval', deferred ? 'done' : proposed ? 'no' : 'todo', deferred ? 'the Safety Supervisor deferred it for a human decision' : proposed ? 'not required (simulation auto-approval)' : '', deferred?.t),
    st('decision', 'Approved or rejected', approved ? 'done' : rejected ? 'no' : state === 'AWAITING_APPROVAL' ? 'now' : 'todo',
      approved ? (analyst ? `approved with the analyst's selection: ${title(analyst.action)}${analyst.target_rpm ? ` to ${fmtRpm(analyst.target_rpm)} rpm` : ''}` : 'approved as proposed') : rejected ? 'rejected or expired' : state === 'AWAITING_APPROVAL' ? 'waiting for a decision' : '', (approved || rejected)?.t),
    st('requested', 'Action requested', cmd ? 'done' : 'todo', cmd ? `command #${cmd.id} ${title(cmd.action)}${cmd.params?.rpm ? ` ${fmtRpm(cmd.params.rpm)} rpm` : ''}` : ''),
    st('ack', 'Acknowledged by the simulated device', !cmd ? 'todo' : ACKED.includes(cmd.status) ? 'done' : REFUSED.includes(cmd.status) ? 'no' : 'now', cmd ? `${cmd.status}${cmd.reason ? ` (${cmd.reason})` : ''}` : ''),
    st('post', 'Fresh post-action telemetry', state === 'VERIFYING_RECOVERY' ? 'now' : assess || out ? 'done' : 'todo', state === 'VERIFYING_RECOVERY' ? 'collecting windows after the acknowledgement' : ''),
    st('evaluated', 'Outcome evaluated (C5)', assess ? 'done' : 'todo', assess ? title(assess.outcome) : '', assess?.t),
    st('verified', 'Recovery verified', !out ? 'todo' : out.outcome === 'RECOVERED' ? 'done' : 'no', out ? `${title(out.outcome)} from ${out.n_fresh} fresh window(s)` : 'an acknowledgement alone is never recovery'),
  ];
  return { inc, steps };
}

const STEP_TONE = { done: 'ok', now: 'wait', no: 'crit', todo: 'off' };
const STEP_WORD = { done: 'done', now: 'in progress', no: 'no', todo: 'not yet' };

export function ActionLifecycle({ d }) {
  const { inc, steps } = lifecycleOf(d);
  return (
    <Card title="Action lifecycle" id="c-life" right={<>{inc && <Pill tone="info">{inc.id}</Pill>}<ProvBadge kind="SIMULATED" /></>}>
      {!inc ? <Empty>No incident in this run yet, so no action has been proposed.</Empty> : (
        <ol className="tq-life" data-testid="lifecycle">
          {steps.map(([k, label, s, detail, t]) => (
            <li key={k} className={`tq-life-step is-${s}`} data-testid={`life-${k}`} data-state={s}>
              <span className="tq-life-dot" aria-hidden="true" />
              <div><strong>{label}</strong> <Pill tone={STEP_TONE[s]}>{STEP_WORD[s]}</Pill>{t != null && <span className="tq-muted tq-small tq-num"> t = {fmt(t, 0)} s</span>}
                {detail && <p className="tq-muted tq-small">{detail}</p>}</div>
            </li>))}
        </ol>)}
    </Card>
  );
}

export function SimInterventionsPage({ d, role, actions, error, go, wb, setWb, stale }) {
  const sel = wb?.selection;
  const s = d.status || {};
  const ctl = canControl(role);
  const [chk, setChk] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [confirm, setConfirm] = useState(false);
  const [refused, setRefused] = useState(null);          // the receipt the backend wrote for a refused request
  const pendKey = s.pending_approval ? `${s.pending_approval.action}-${JSON.stringify(s.pending_approval.params)}` : 'none';
  const body = sel ? { action: sel.action, target_rpm: sel.action === 'REDUCE_SPEED' ? sel.target_rpm : null, basis: sel.basis, candidate_id: sel.candidate_id } : null;
  const check = useCallback(async () => {
    if (!body) return;
    try { setChk(await api.wbCheck(body)); setErr(null); } catch (e) { setChk(null); setErr(e); }
  }, [sel?.candidate_id, pendKey, s.incident?.state, Math.floor((s.t ?? 0) / 10)]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { check(); setConfirm(false); }, [check]);
  const request = async () => {
    setBusy(true); setErr(null);
    try { const r = await api.wbRequest(body); setWb((x) => ({ ...x, selection: null, lastRequest: r })); setChk(null); setConfirm(false); }
    catch (e) { setErr(e); setRefused((String(e.message || '').match(/decision receipt (R-\d+)/) || [])[1] || null); check(); } finally { setBusy(false); }
  };
  const age = sel && s.t !== undefined ? s.t - sel.basis.t : null;
  const p = sel?.prediction;
  const last = wb?.lastRequest;
  const cur = s.last_window?.rpm;
  return (
    <>
      <PageHead title="Interventions (C3)" sub="Review the selected action, see what the decision gate and the Safety Supervisor say, and request it only when they allow it."
        right={<><ProvBadge kind="SIMULATED" />{sel ? <Pill tone="info">{sel.action === 'STOP' ? 'STOP selected' : `Action ${sel.label} · ${fmtRpm(sel.target_rpm)} rpm`}</Pill> : <Pill tone="off">nothing selected</Pill>}</>} />
      <p className="tq-callout" role="note">Every action passes the decision gate and the deterministic Safety Supervisor on the backend, then goes to the simulated device. A prediction never authorises an action, and nothing on this page reaches a physical motor.</p>

      <div className="tq-split">
        <Card title="Selected action" id="c-selrev" right={<ProvBadge kind="PREDICTED" />}>
          {!sel ? <Empty>No action selected. Compare candidates on Predictions and select one.</Empty> : (
            <>
              <dl className="tq-kv" data-testid="sel-review">
                <dt>Action</dt><dd><strong>{sel.action === 'STOP' ? 'STOP (coast)' : `Action ${sel.label}: reduce speed`}</strong> <span className="tq-muted tq-num">{sel.candidate_id}</span></dd>
                <dt>Requested target</dt><dd className="tq-num">{sel.action === 'STOP' ? '0 rpm (coast)' : `${fmtRpm(sel.target_rpm)} rpm`}</dd>
                <dt>Current operating point</dt><dd className="tq-num">{fmtRpm(cur)} rpm at setpoint {fmtRpm(s.device?.setpoint_rpm)} rpm</dd>
                {sel.action === 'REDUCE_SPEED' && <><dt>Speed reduction</dt><dd className="tq-num">{Number.isFinite(cur) ? `${fmtRpm(cur - sel.target_rpm)} rpm (${pct((cur - sel.target_rpm) / cur, 0)})` : '—'}</dd></>}
                <dt>Predicted housing +30 / +60 / +120 s</dt><dd className="tq-num">{p?.mean?.housing?.map((v) => fmt(v, 1)).join(' / ') || '—'} °C</dd>
                <dt>90 % interval at +120 s</dt><dd className="tq-num">{p?.lo?.housing ? `${fmt(p.lo.housing[2], 1)}–${fmt(p.hi.housing[2], 1)} °C` : '—'}</dd>
                <dt>Predicted risk (120 s)</dt><dd className="tq-num">{pct(p?.risk, 0)}</dd>
                <dt>Predicted at</dt><dd className="tq-num">t = {fmt(sel.basis.t, 0)} s ({age !== null ? `${fmt(age, 0)} s ago` : '—'})</dd>
              </dl>
              <div className="tq-row tq-mt">
                <button type="button" className="tq-btn" onClick={() => go('predictions')}><ArrowLeft size={14} aria-hidden="true" /> Change on Predictions</button>
                <button type="button" className="tq-btn tq-ghost" onClick={() => setWb((x) => ({ ...x, selection: null }))}><X size={14} aria-hidden="true" /> Clear selection</button>
              </div>
            </>)}
        </Card>

        <Card title="Decision check" id="c-dcheck" right={chk ? <Pill tone={chk.executable ? 'ok' : 'warn'}>{chk.executable ? 'allowed' : 'not allowed now'}</Pill> : null}>
          {!sel ? <Empty>Select an action to check it.</Empty> : !chk ? <Empty loading>Checking with the gate and the Safety Supervisor…</Empty> : (
            <div data-testid="dcheck">
              <dl className="tq-kv">
                <dt>Decision gate (C3)</dt><dd>{chk.gate ? <><Pill tone={GATE_TONE[chk.gate.verdict] || 'info'}>{title(chk.gate.verdict)}</Pill> <span className="tq-muted">{chk.gate.reason}</span></> : 'cannot evaluate without an incident and a ranking'}</dd>
                <dt>Safety Supervisor</dt><dd><Pill tone={chk.supervisor.verdict === 'REJECT' ? 'crit' : chk.supervisor.verdict === 'DEFER' ? 'wait' : 'ok'}>{chk.supervisor.verdict}</Pill> <span className="tq-muted">{chk.supervisor.reasons.map(title).join(', ')}</span></dd>
                <dt>Held for a human decision</dt><dd>{chk.awaiting_decision ? `yes: ${title(chk.pending.action)}${chk.pending.params?.rpm ? ` to ${fmtRpm(chk.pending.params.rpm)} rpm` : ''} (as proposed by the pipeline)` : 'no'}</dd>
                <dt>Prediction freshness</dt><dd>{chk.stale.length ? <Pill tone="warn">{`stale: ${chk.stale.join('; ')}`}</Pill> : <Pill tone="ok">current</Pill>}</dd>
                {chk.prediction_now && <><dt>Prediction now (same target)</dt><dd className="tq-num">housing +120 s {fmt(chk.prediction_now.mean?.housing?.[2], 1)} °C, risk {pct(chk.prediction_now.risk, 0)}</dd></>}
              </dl>
              {chk.blockers.length > 0 && (
                <div className="tq-callout warn" role="status" data-testid="dcheck-blockers"><strong>Why it cannot be requested now</strong>
                  <ul className="tq-list">{chk.blockers.map((b) => <li key={b}>{b}</li>)}</ul>
                  <p className="tq-small">{chk.stale.length ? 'Recalculate on Predictions.' : chk.gate && chk.gate.verdict === 'RUN_DIAGNOSTIC_TEST' ? `Run ${chk.gate.test} on Diagnostic Tests first.` : !chk.awaiting_decision ? 'Start a scenario with "Require human approval" so the pipeline holds its action for you.' : 'Follow the gate\'s verdict.'}</p>
                </div>)}
              <div className="tq-row tq-mt">
                <button type="button" className="tq-btn" onClick={check}><RefreshCw size={14} aria-hidden="true" /> Check again</button>
                {!confirm ? (
                  <button type="button" className="tq-btn tq-primary" disabled={!chk.executable || !ctl || busy || stale} onClick={() => setConfirm(true)} data-testid="req-start">
                    <ShieldCheck size={14} aria-hidden="true" /> Request this action in the simulator</button>
                ) : (
                  <>
                    <button type="button" className="tq-btn tq-primary" disabled={!chk.executable || busy} onClick={request} data-testid="req-confirm">
                      <Send size={14} aria-hidden="true" /> {busy ? 'Sending…' : `Confirm: ${sel.action === 'STOP' ? 'STOP (coast)' : `reduce to ${fmtRpm(sel.target_rpm)} rpm`}`}</button>
                    <button type="button" className="tq-btn" onClick={() => setConfirm(false)}>Cancel</button>
                  </>)}
              </div>
              {!ctl && <p className="tq-muted">Requesting requires role operator or admin.</p>}
            </div>)}
          <ErrorBox error={err} />
        </Card>
      </div>

      {last && (
        <div className="tq-callout info tq-mt" role="status" data-testid="req-result">
          <strong>Requested: {title(last.requested.action)}{last.requested.target_rpm ? ` to ${fmtRpm(last.requested.target_rpm)} rpm` : ''}</strong>
          <p>{last.command ? `Command #${last.command.id} is ${last.command.status} on the simulated device.` : 'No command was dispatched.'} {last.note}</p>
        </div>)}

      <div className="tq-mt"><ActionLifecycle d={d} /></div>
      <div className="tq-mt"><ReceiptsPanel d={d} focusId={refused || last?.receipt_id} /></div>
      <div className="tq-mt"><InvestigationTrace d={d} focus={['decision', 'outcome']} /></div>
      <h3 className="tq-section-head tq-mt">Proposals, decisions and commands recorded by the pipeline</h3>
      <InterventionsPage d={d} role={role} actions={actions} error={error} head={false} />
    </>
  );
}
