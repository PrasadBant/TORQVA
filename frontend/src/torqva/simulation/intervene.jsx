// Interventions (C3), simulation mode: review the action selected on Predictions, check it with the deterministic decision gate and the
// Safety Supervisor (POST /simulation/workbench/check, no side effect), and, only when both allow it and the pipeline is holding an action for
// a human decision, request it (POST /simulation/workbench/request). The backend repeats every check; the browser cannot authorise anything.
// The lifecycle below is read from the run's own log, commands and outcomes: a selection is not an action, an acknowledgement is not recovery.
import React, { useCallback, useEffect, useState } from 'react';
import { ShieldCheck, Send, X, ArrowLeft, RefreshCw, Crosshair, ClipboardCheck, Lock, Hand, Cpu, Flag, ListChecks, Route, FileCheck2 } from 'lucide-react';
import { api } from '../api.js';
import { Card, Empty, ErrorBox, Pill, ProvBadge, fmt, PageHead, CheckList, StatGrid, StatTile, Tabs, TabPanel, LinkButton, canControl, title, pct, fmtRpm } from '../shared/components.jsx';
import { InterventionsPage, ApprovalCard } from './assurance.jsx';
import { currentIncident } from './pipeline.js';
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
    st('gate', 'Decision reviewed (decision gate)', gate ? (gate.verdict === 'ACT' ? 'done' : 'no') : 'todo', gate ? `${title(gate.verdict)}: ${gate.reason}` : '', gate?.t),
    st('proposed', 'Proposed', proposed ? 'done' : 'todo', proposed ? 'Failure Prediction ranked the candidates and the pipeline proposed an action' : 'no action proposed yet', proposed?.t),
    st('approval', 'Awaiting approval', deferred ? 'done' : proposed ? 'no' : 'todo', deferred ? 'the Safety Supervisor deferred it for a human decision' : proposed ? 'not required (simulation auto-approval)' : '', deferred?.t),
    st('decision', 'Approved or rejected', approved ? 'done' : rejected ? 'no' : state === 'AWAITING_APPROVAL' ? 'now' : 'todo',
      approved ? (analyst ? `approved with the analyst's selection: ${title(analyst.action)}${analyst.target_rpm ? ` to ${fmtRpm(analyst.target_rpm)} rpm` : ''}` : 'approved as proposed') : rejected ? 'rejected or expired' : state === 'AWAITING_APPROVAL' ? 'waiting for a decision' : '', (approved || rejected)?.t),
    st('requested', 'Action requested', cmd ? 'done' : 'todo', cmd ? `command #${cmd.id} ${title(cmd.action)}${cmd.params?.rpm ? ` ${fmtRpm(cmd.params.rpm)} rpm` : ''}` : ''),
    st('ack', 'Acknowledged by the simulated device', !cmd ? 'todo' : ACKED.includes(cmd.status) ? 'done' : REFUSED.includes(cmd.status) ? 'no' : 'now', cmd ? `${cmd.status}${cmd.reason ? ` (${cmd.reason})` : ''}` : ''),
    st('post', 'Fresh post-action telemetry', state === 'VERIFYING_RECOVERY' ? 'now' : assess || out ? 'done' : 'todo', state === 'VERIFYING_RECOVERY' ? 'collecting windows after the acknowledgement' : ''),
    st('evaluated', 'Outcome evaluated', assess ? 'done' : 'todo', assess ? title(assess.outcome) : '', assess?.t),
    st('verified', 'Recovery verified', !out ? 'todo' : out.outcome === 'RECOVERED' ? 'done' : 'no', out ? `${title(out.outcome)} from ${out.n_fresh} fresh window(s)` : 'an acknowledgement alone is never recovery'),
  ];
  return { inc, steps, cmd, out };
}

const STEP_TONE = { done: 'ok', now: 'wait', no: 'crit', todo: 'off' };
const STEP_WORD = { done: 'done', now: 'in progress', no: 'no', todo: 'not yet' };

export function ActionLifecycle({ d }) {
  const { inc, steps } = lifecycleOf(d);
  return (
    <Card title="Action lifecycle" id="c-life" icon={Route} sub="A selection is not an action; an acknowledgement is not recovery"
      right={<>{inc && <Pill tone="info">{inc.id}</Pill>}<ProvBadge kind="SIMULATED" /></>}>
      {!inc ? <Empty>No incident in this run yet, so no action has been proposed.</Empty> : (
        <ol className="tq-life tq-as-life" data-testid="lifecycle">
          {steps.map(([k, label, s, detail, t], i) => (
            <li key={k} className={`tq-life-step is-${s}`} data-testid={`life-${k}`} data-state={s}>
              <span className="tq-life-dot" aria-hidden="true">{i + 1}</span>
              <div><strong>{label}</strong> <Pill tone={STEP_TONE[s]}>{STEP_WORD[s]}</Pill>{t != null && <span className="tq-muted tq-small tq-num"> t = {fmt(t, 0)} s</span>}
                {detail && <p className="tq-muted tq-small">{detail}</p>}</div>
            </li>))}
        </ol>)}
    </Card>
  );
}

/** Headline status of the current incident's action, from the same records as the lifecycle: proposed, approval, execution, result. */
function DecisionTiles({ d, go }) {
  const { inc, steps, cmd, out } = lifecycleOf(d);
  const S = Object.fromEntries(steps.map(([k, , s, detail]) => [k, { s, detail }]));
  const pend = d.status?.pending_approval;
  const proposed = pend
    ? { tone: 'wait', value: title(pend.action), sub: `${pend.params?.rpm ? `to ${fmtRpm(pend.params.rpm)} rpm · ` : ''}held for a human decision` }
    : cmd ? { tone: 'info', value: title(cmd.action), sub: S.requested?.detail || '' }
      : { tone: 'off', value: 'None', sub: inc ? `${inc.id}: ${S.gate?.s !== 'todo' ? S.gate.detail : 'no action proposed yet'}` : 'No incident in this run' };
  const dec = S.decision?.s;
  const approval = dec === 'now' ? { tone: 'wait', value: 'Waiting', sub: 'an operator must approve or reject' }
    : dec === 'done' ? { tone: 'ok', value: 'Approved', sub: S.decision.detail }
      : dec === 'no' ? { tone: 'crit', value: 'Rejected or expired', sub: 'nothing was sent' }
        : S.approval?.s === 'no' ? { tone: 'info', value: 'Not required', sub: 'simulation auto-approval' }
          : { tone: 'off', value: 'Nothing to approve', sub: 'no action is held for a decision' };
  const ack = S.ack?.s;
  const exec = ack === 'done' ? { tone: 'ok', value: 'Acknowledged', sub: `${S.requested.detail} · ${S.ack.detail}` }
    : ack === 'no' ? { tone: 'crit', value: 'Refused by the device', sub: `${S.requested.detail} · ${S.ack.detail}` }
      : ack === 'now' ? { tone: 'wait', value: 'Awaiting acknowledgement', sub: S.requested.detail }
        : { tone: 'off', value: 'Not dispatched', sub: 'nothing is sent before approval' };
  const result = S.verified?.s === 'done' ? { tone: 'ok', value: 'Recovery verified', sub: S.verified.detail }
    : S.verified?.s === 'no' ? { tone: out?.outcome === 'UNRESOLVED' ? 'crit' : 'warn', value: title(out?.outcome), sub: S.verified.detail }
      : S.post?.s === 'now' ? { tone: 'wait', value: 'Verifying', sub: 'Recovery Verification is collecting fresh windows' }
        : { tone: 'off', value: 'Not verified', sub: 'Recovery Verification has recorded no verdict for this incident' };
  const showC5 = go && (out || S.post?.s === 'now');
  return (
    <div data-testid="c3-status"><StatGrid label="Current action status">
      <StatTile icon={Crosshair} label="Proposed action" {...proposed} />
      <StatTile icon={Hand} label="Approval" {...approval} />
      <StatTile icon={Cpu} label="Execution (simulated device)" {...exec} />
      <StatTile icon={Flag} label="Result" {...result} action={showC5 ? <LinkButton onClick={() => go('recovery')}>View Recovery Verification</LinkButton> : null} />
    </StatGrid></div>
  );
}

const NEXT_STEP = (chk) => (chk.stale.length ? ['Recalculate on Failure Prediction.', 'predictions', 'Open Failure Prediction']
  : chk.gate && chk.gate.verdict === 'RUN_DIAGNOSTIC_TEST' ? [`Run ${chk.gate.test} on Diagnostic Investigation first.`, 'tests', 'Open Diagnostic Investigation']
    : !chk.awaiting_decision ? ['Start a scenario with "Require human approval" so the pipeline holds its action for you.', 'scenario', 'Open Scenario Studio']
      : ['Follow the gate\'s verdict.', null, null]);

export function SimInterventionsPage({ d, role, actions, error, go, wb, setWb, stale, busy: shellBusy }) {
  const sel = wb?.selection;
  const s = d.status || {};
  const ctl = canControl(role);
  const [chk, setChk] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [confirm, setConfirm] = useState(false);
  const [refused, setRefused] = useState(null);          // the receipt the backend wrote for a refused request
  const [tab, setTab] = useState(wb?.traceFocus?.length ? 'trace' : 'decision');
  const pendKey = s.pending_approval ? `${s.pending_approval.action}-${JSON.stringify(s.pending_approval.params)}` : 'none';
  const body = sel ? { action: sel.action, target_rpm: sel.action === 'REDUCE_SPEED' ? sel.target_rpm : null, basis: sel.basis, candidate_id: sel.candidate_id } : null;
  const check = useCallback(async () => {
    if (!body) return;
    try { setChk(await api.wbCheck(body)); setErr(null); } catch (e) { setChk(null); setErr(e); }
  }, [sel?.candidate_id, pendKey, s.incident?.state, Math.floor((s.t ?? 0) / 10)]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { check(); setConfirm(false); }, [check]);
  // A trace focus requested from another analyst page applies to this visit only.
  useEffect(() => () => setWb?.((x) => (x?.traceFocus ? { ...x, traceFocus: null } : x)), []);   // eslint-disable-line react-hooks/exhaustive-deps
  const request = async () => {
    if (busy) return;                                    // one press, one request
    setBusy(true); setErr(null);
    try { const r = await api.wbRequest(body); setWb((x) => ({ ...x, selection: null, lastRequest: r })); setChk(null); setConfirm(false); }
    catch (e) { setErr(e); setRefused((String(e.message || '').match(/decision receipt (R-\d+)/) || [])[1] || null); check(); } finally { setBusy(false); }
  };
  const age = sel && s.t !== undefined ? s.t - sel.basis.t : null;
  const p = sel?.prediction;
  const last = wb?.lastRequest;
  const cur = s.last_window?.rpm;
  const nCmd = (d.commands || []).filter((c) => c.action !== 'HEARTBEAT').length;
  const receiptFocus = refused || last?.receipt_id;
  const openReceipt = () => setTab('receipts');
  const next = chk ? NEXT_STEP(chk) : null;
  const checks = chk ? [
    { key: 'gate', label: 'Decision gate', state: !chk.gate ? 'unknown' : chk.gate.verdict === 'ACT' ? 'ok' : ['SAFE_STOP', 'SENSOR_UNRELIABLE'].includes(chk.gate.verdict) ? 'fail' : 'warn',
      status: chk.gate ? title(chk.gate.verdict) : 'not evaluated', detail: chk.gate ? chk.gate.reason : 'cannot evaluate without an incident and a ranking' },
    { key: 'sup', label: 'Safety Supervisor', state: chk.supervisor.verdict === 'REJECT' ? 'fail' : chk.supervisor.verdict === 'DEFER' ? 'pending' : 'ok',
      status: chk.supervisor.verdict, detail: chk.supervisor.reasons.map(title).join(', ') || undefined },
    { key: 'held', label: 'Held for a human decision', state: chk.awaiting_decision ? 'ok' : 'warn', status: chk.awaiting_decision ? 'yes' : 'no',
      detail: chk.awaiting_decision ? `${title(chk.pending.action)}${chk.pending.params?.rpm ? ` to ${fmtRpm(chk.pending.params.rpm)} rpm` : ''} (as proposed by the pipeline)` : 'the pipeline is not holding an action' },
    { key: 'fresh', label: 'Prediction freshness', state: chk.stale.length ? 'warn' : 'ok', status: chk.stale.length ? 'stale' : 'current',
      detail: chk.stale.length ? chk.stale.join('; ') : chk.prediction_now ? `now: housing +120 s ${fmt(chk.prediction_now.mean?.housing?.[2], 1)} °C, risk ${pct(chk.prediction_now.risk, 0)}` : undefined },
  ] : [];
  return (
    <>
      <PageHead title="Action Recommendations" sub="What TORQVA recommends, why, and the approval status."
        right={<><ProvBadge kind="SIMULATED" />{sel ? <Pill tone="info">{sel.action === 'STOP' ? 'STOP selected' : `Action ${sel.label} · ${fmtRpm(sel.target_rpm)} rpm`}</Pill> : <Pill tone="off">nothing selected</Pill>}</>} />
      <DecisionTiles d={d} go={go} />
      <Tabs label="Action Recommendations views" idBase="tq-c3" value={tab} onChange={setTab} tabs={[
        { key: 'decision', label: 'Current decision', icon: ShieldCheck },
        { key: 'history', label: 'Action history', icon: ListChecks, count: nCmd },
        { key: 'trace', label: 'Investigation history', icon: Route },
        { key: 'receipts', label: 'Decision summaries', icon: FileCheck2 },
      ]} />

      {tab === 'decision' && (
        <TabPanel tab="decision" idBase="tq-c3">
          <p className="tq-as-lede" role="note">A prediction never authorises an action, and nothing on this page reaches a physical motor: actions go to the simulated device only after the backend's checks.</p>
          <ApprovalCard d={d} role={role} actions={actions} error={error} busy={shellBusy} />
          <div className="tq-split tq-mt">
            <Card title="Your selected action" id="c-selrev" icon={Crosshair} sub="Chosen on Failure Prediction" right={<ProvBadge kind="PREDICTED" />}>
              {!sel ? <Empty action={go ? <LinkButton onClick={() => go('predictions')}>Compare on Failure Prediction</LinkButton> : null}>No action selected. Compare candidates on Failure Prediction and select one.</Empty> : (
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
                    <button type="button" className="tq-btn" onClick={() => go('predictions')}><ArrowLeft size={14} aria-hidden="true" /> Change on Failure Prediction</button>
                    <button type="button" className="tq-btn tq-ghost" onClick={() => setWb((x) => ({ ...x, selection: null }))}><X size={14} aria-hidden="true" /> Clear selection</button>
                  </div>
                </>)}
            </Card>

            <Card title="Decision check" id="c-dcheck" icon={ClipboardCheck} sub="Decision gate and Safety Supervisor (no side effects)"
              right={chk ? <Pill tone={chk.executable ? 'ok' : 'warn'}>{chk.executable ? 'allowed' : 'not allowed now'}</Pill> : null}>
              {!sel ? <Empty>Select an action to check it.</Empty> : !chk ? <Empty loading>Checking with the gate and the Safety Supervisor…</Empty> : (
                <div data-testid="dcheck">
                  <CheckList dense label="Decision check" items={checks} />
                  {chk.blockers.length > 0 && (
                    <div className="tq-blocked tq-mt" role="status" data-testid="dcheck-blockers">
                      <span className="tq-blocked-icon" aria-hidden="true"><Lock size={15} /></span>
                      <div className="tq-blocked-body"><strong>Why it cannot be requested now</strong>
                        <ul className="tq-as-reasons">{chk.blockers.map((b) => <li key={b}>{b}</li>)}</ul>
                        <p className="tq-small tq-as-next">{next[0]}</p></div>
                      {next[1] && go && <div className="tq-blocked-action"><LinkButton onClick={() => go(next[1])}>{next[2]}</LinkButton></div>}
                    </div>)}
                  <div className="tq-row tq-mt">
                    <button type="button" className="tq-btn" onClick={check}><RefreshCw size={14} aria-hidden="true" /> Check again</button>
                    {!confirm ? (
                      <button type="button" className="tq-btn tq-primary" disabled={!chk.executable || !ctl || busy || stale} onClick={() => setConfirm(true)} data-testid="req-start">
                        <ShieldCheck size={14} aria-hidden="true" /> Request this action in the simulator</button>
                    ) : (
                      <>
                        <button type="button" className="tq-btn tq-primary" disabled={!chk.executable || !ctl || busy || stale} onClick={request} data-testid="req-confirm">
                          <Send size={14} aria-hidden="true" /> {busy ? 'Sending…' : `Confirm: ${sel.action === 'STOP' ? 'STOP (coast)' : `reduce to ${fmtRpm(sel.target_rpm)} rpm`}`}</button>
                        <button type="button" className="tq-btn" onClick={() => setConfirm(false)}>Cancel</button>
                      </>)}
                  </div>
                  {!ctl && <p className="tq-muted">Requesting requires role operator or admin.</p>}
                </div>)}
              <ErrorBox error={err} />
              {refused && <p className="tq-small"><button type="button" className="tq-linkbtn" onClick={openReceipt}>Open decision summary {refused}</button> <span className="tq-muted">(the refusal and the evidence it was decided on)</span></p>}
            </Card>
          </div>

          {last && (
            <div className="tq-callout info tq-mt" role="status" data-testid="req-result">
              <strong>Requested: {title(last.requested.action)}{last.requested.target_rpm ? ` to ${fmtRpm(last.requested.target_rpm)} rpm` : ''}</strong>
              <p>{last.command ? `Command #${last.command.id} is ${last.command.status} on the simulated device.` : 'No command was dispatched.'} {last.note}</p>
              {last.receipt_id && <p className="tq-small"><button type="button" className="tq-linkbtn" onClick={openReceipt}>Open decision summary {last.receipt_id}</button></p>}
            </div>)}

          <div className="tq-mt"><ActionLifecycle d={d} /></div>
        </TabPanel>)}

      {tab === 'history' && (
        <TabPanel tab="history" idBase="tq-c3">
          <div data-testid="c3-records"><InterventionsPage d={d} role={role} actions={actions} error={error} head={false} /></div>
        </TabPanel>)}

      {tab === 'trace' && (
        <TabPanel tab="trace" idBase="tq-c3">
          <div data-testid="c3-trace"><InvestigationTrace d={d} focus={wb?.traceFocus?.length ? wb.traceFocus : ['decision', 'outcome']} /></div>
        </TabPanel>)}

      {tab === 'receipts' && (
        <TabPanel tab="receipts" idBase="tq-c3">
          <div data-testid="c3-receipts"><ReceiptsPanel d={d} focusId={receiptFocus} /></div>
        </TabPanel>)}
    </>
  );
}
