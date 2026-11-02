// C6 reference attestation (simulation): capture a warm-up session as a candidate, review its evidence and automatic eligibility checks, and
// let an operator attest, reject or revoke it; attested candidates become immutable reference versions that can be activated or rolled back.
// Every transition is the backend's (/attestation/…): it re-checks role, revision (stale decisions are refused with 409) and eligibility.
import React, { useCallback, useEffect, useState } from 'react';
import { BadgeCheck, Layers, Inbox, Timer, FileSearch, Camera } from 'lucide-react';
import { Card, Empty, ErrorBox, Pill, ProvBadge, fmt, canControl, Disclosure, StatGrid, StatTile, StepTracker, DataTable } from '../shared/components.jsx';
import { api } from '../api.js';

const TONE = { PENDING: 'wait', ELIGIBLE: 'info', ATTESTED: 'ok', REJECTED: 'crit', EXPIRED: 'off', REVOKED: 'warn' };
const MEANING = {
  PENDING: 'evidence incomplete — nothing can be decided yet',
  ELIGIBLE: 'all automatic checks passed — awaiting an operator decision',
  ATTESTED: 'an operator approved the recorded evidence',
  REJECTED: 'not usable as a reference',
  EXPIRED: 'evidence went stale before a decision',
  REVOKED: 'attestation withdrawn',
};
const MIN_REASON = 10;
const NOTICE = 'Attestation is an operator judgment about a recorded simulated session. It is not proof that the motor is fault-free, and it carries no physical validation.';
const REF_EVENTS = ['attested', 'reference_activated', 'reference_rolled_back', 'revoked'];

export function StateLabel({ state }) {
  return <Pill tone={TONE[state] || 'info'}>{state}</Pill>;
}

function useAsync() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const run = useCallback(async (fn) => {
    setBusy(true); setError(null);
    try { return await fn(); } catch (e) { setError(e); return undefined; } finally { setBusy(false); }
  }, []);
  return { busy, error, run };
}

const when = (ts) => (typeof ts === 'number' && ts > 1e9 ? new Date(ts * 1000).toLocaleString() : null);

/** Where one candidate stands, step by step, from its own record and the reference registry only. */
function lifecycleSteps(detail, refs) {
  const st = detail.state;
  const failed = (detail.checks || []).filter((c) => !c.passed);
  const decided = [...(detail.history || [])].reverse().find((h) => ['attested', 'rejected', 'revoked'].includes(h.event));
  const v = detail.reference_version;
  return [
    { key: 'cap', label: 'Captured', state: 'done', sub: `by ${detail.created_by}` },
    { key: 'chk', label: 'Automatic checks', ...(failed.length ? { state: 'failed', sub: `${failed.length} failed` } : st === 'PENDING' ? { state: 'active', sub: 'evidence incomplete' } : st === 'EXPIRED' ? { state: 'failed', sub: 'evidence expired' } : { state: 'done', sub: 'all passed' }) },
    { key: 'dec', label: 'Operator decision', ...(st === 'ATTESTED' ? { state: 'done', sub: `attested by ${decided?.by || '—'}` } : st === 'REJECTED' ? { state: 'failed', sub: `rejected${decided ? ` by ${decided.by}` : ''}` }
      : st === 'REVOKED' ? { state: 'failed', sub: `revoked${decided ? ` by ${decided.by}` : ''}` } : st === 'ELIGIBLE' ? { state: 'waiting', sub: 'awaiting an operator' } : { state: 'pending', sub: 'not possible yet' }) },
    { key: 'ver', label: 'Reference version', ...(v ? { state: 'done', sub: `v${v} (immutable)` } : { state: 'pending', sub: 'created on attestation' }) },
    { key: 'use', label: 'In use by Anomaly Detection', ...(v && refs.active_version === v ? { state: 'done', sub: 'the current reference' } : { state: 'pending', sub: v ? 'not activated' : 'not applicable yet' }) },
  ];
}

/** What blocks the candidate's next step, in plain words, from its state and the backend's own reasons. */
function nextFor(detail, ctl) {
  switch (detail.state) {
    case 'PENDING': return 'Blocked: the evidence is incomplete. Re-evaluate once more windows have been recorded, or reject it.';
    case 'ELIGIBLE': return ctl ? 'Ready for your decision: attest it (creates a reference version) or reject it.' : 'Waiting for an operator or admin to attest or reject it.';
    case 'ATTESTED': return 'Attested: its reference version can be activated below. Revoking withdraws the attestation.';
    case 'REJECTED': return 'Rejected: it can never become a reference. Capture a new candidate instead.';
    case 'EXPIRED': return 'Expired before a decision: capture a new candidate.';
    case 'REVOKED': return 'Revoked: the attestation was withdrawn.';
    default: return '';
  }
}

export default function Attestation({ role }) {
  const ctl = canControl(role);
  const [list, setList] = useState([]);
  const [refs, setRefs] = useState({ versions: [], active_version: null });
  const [events, setEvents] = useState([]);
  const [hold, setHold] = useState({ active: false });
  const [sel, setSel] = useState(null);
  const [detail, setDetail] = useState(null);
  const [mode, setMode] = useState(null);                 // null | 'attest' | 'reject' | 'revoke'
  const [reason, setReason] = useState('');
  const [ack, setAck] = useState(false);
  const [holdForm, setHoldForm] = useState({ seconds: 90, reason: '' });
  const [refReason, setRefReason] = useState('');
  const a = useAsync();

  const load = useCallback(async () => {
    const [l, r, e, h] = await Promise.all([api.attList(), api.attRefs(), api.attEvents(), api.attHold()]);
    setList(l); setRefs(r); setEvents(e); setHold(h);
  }, []);
  const open = useCallback(async (id) => { setSel(id); setMode(null); setReason(''); setAck(false); setDetail(await api.attOne(id)); }, []);
  useEffect(() => { a.run(load); }, [load]); // eslint-disable-line react-hooks/exhaustive-deps

  const reload = async (id) => { await load(); if (id) await open(id); };
  const capture = () => a.run(async () => { const c = await api.attCapture(); await reload(c.id); });
  const refresh = () => a.run(async () => { await api.attRefresh(detail.id, detail.rev); await reload(detail.id); });
  const decide = async () => {
    const ok = await a.run(async () => {
      const body = { reason, expected_rev: detail.rev, acknowledge: ack };
      if (mode === 'attest') await api.attAttest(detail.id, body);
      else if (mode === 'reject') await api.attReject(detail.id, body);
      else await api.attRevoke(detail.id, body);
      await reload(detail.id);
      return true;
    });
    if (!ok) { try { await reload(detail.id); } catch { /* keep the error message; the view re-syncs when the server is reachable */ } }   // a refused decision: show what the server now says
  };
  const startHold = () => a.run(async () => { await api.attHoldStart({ seconds: Number(holdForm.seconds), reason: holdForm.reason }); await load(); });
  const endHold = () => a.run(async () => { await api.attHoldEnd(); await load(); });
  const activate = (v) => a.run(async () => { await api.attActivate(v, refReason); await load(); });
  const rollback = () => a.run(async () => { await api.attRollback(refReason); await load(); });

  const reasonOk = reason.trim().length >= MIN_REASON;
  const canConfirm = reasonOk && (mode !== 'attest' || ack) && !a.busy;
  const s = detail?.summary;
  const refOk = refReason.trim().length >= MIN_REASON;
  const activeV = (refs.versions || []).find((v) => v.version === refs.active_version);
  const lastRefEvent = [...events].reverse().find((e) => REF_EVENTS.includes(e.detail?.event));
  const counts = list.reduce((m, c) => ({ ...m, [c.state]: (m[c.state] || 0) + 1 }), {});
  const awaiting = counts.ELIGIBLE || 0;

  return (
    <div className="tq-as-att">
      <div data-testid="att-summary">
        <StatGrid label="Reference lifecycle summary">
          <StatTile icon={BadgeCheck} tone={refs.active_version ? 'ok' : 'off'} label="Active reference" value={refs.active_version ? `v${refs.active_version}` : 'None'}
            sub={activeV ? `from ${activeV.candidate}, attested by ${activeV.created_by || '—'}` : 'shipped detector, unadapted'} />
          <StatTile icon={Inbox} tone={awaiting ? 'wait' : 'info'} label="Awaiting an operator decision" value={String(awaiting)}
            sub={list.length ? Object.entries(counts).map(([k, n]) => `${n} ${k.toLowerCase()}`).join(' · ') : 'no candidates yet'} />
          <StatTile icon={Layers} tone="info" label="Reference versions" value={String(refs.versions?.length || 0)}
            sub={lastRefEvent ? `last change: ${String(lastRefEvent.detail.event).replace(/_/g, ' ')}${when(lastRefEvent.ts) ? `, ${when(lastRefEvent.ts)}` : ''}` : 'immutable once created'} />
          <StatTile icon={Timer} tone={hold.active ? 'wait' : 'info'} label="Supervised warm-up" value={hold.active ? 'Hold on' : 'No hold'} sub="optional, before capturing" />
        </StatGrid>
      </div>

      <div className="tq-as-notice">
        <p className="tq-warnbox" role="note" data-testid="att-notice">{NOTICE}</p>
        {!ctl && <Empty>Your role ({role}) can review candidates but cannot capture, attest, reject, revoke or activate.</Empty>}
        <Disclosure summary="What attestation means" meta="provenance, scope and what it never changes" testid="att-explain">
          <p className="tq-muted">Telemetry and checks are <ProvBadge kind="SIMULATED" /> values; a decision recorded here is <ProvBadge kind="HUMAN_CONFIRMED" /> — a named
          operator's judgment, recorded with the evidence hash and model versions. Attestation only affects the experimental adaptive anomaly detector, which is off by default.
          It never changes the deterministic Safety Supervisor or any command path.</p>
          <p className="tq-muted tq-small">Lifecycle: capture a warm-up session → automatic eligibility checks → an operator attests or rejects → an attested candidate becomes an
          immutable reference version → an operator activates it (or rolls back) for the running session.</p>
        </Disclosure>
      </div>

      <Card title="Candidate warm-up sessions" id="c-att-list" icon={Camera} sub="Open one to review its evidence" right={<ProvBadge kind="SIMULATED" />}>
        <div className="tq-row tq-as-toolbar"><button type="button" className="tq-btn tq-primary" onClick={capture} disabled={!ctl || a.busy}>Capture candidate from current simulation</button></div>
        <ErrorBox error={a.error} />
        <DataTable caption="Candidate warm-up sessions" rows={list} rowKey={(c) => c.id} rowClass={(c) => (c.id === sel ? 'tq-selected' : undefined)}
          empty="No candidates yet. Start a simulation, let it warm up, then capture a candidate."
          columns={[
            { key: 'id', label: 'ID', render: (c) => <button type="button" className="tq-link" onClick={() => a.run(() => open(c.id))} aria-label={`Open candidate ${c.id}`}>{c.id}</button> },
            { key: 'state', label: 'State', render: (c) => <StateLabel state={c.state} /> },
            { key: 'session', label: 'Session' },
            { key: 'rpm', label: 'rpm', align: 'num', render: (c) => fmt(c.setpoint_rpm, 0) },
            { key: 'n', label: 'Windows', align: 'num' },
            { key: 'failed', label: 'Failed checks', render: (c) => (c.failed_checks.length ? c.failed_checks.join(', ') : '—') },
          ]} />
      </Card>

      {detail && (
        <Card title={`Evidence — ${detail.id}`} id="c-att-detail" icon={FileSearch} sub={MEANING[detail.state]} right={<StateLabel state={detail.state} />}>
          <StepTracker label={`Lifecycle of ${detail.id}`} steps={lifecycleSteps(detail, refs)} testid="att-lifecycle" />
          <p className="tq-as-next-step" data-testid="att-next">{nextFor(detail, ctl)}</p>
          {detail.warnings?.length > 0 && <div className="tq-warnbox" role="alert">{detail.warnings.map((w) => <p key={w}>{w}</p>)}</div>}
          {detail.reasons?.length > 0 && <p className="tq-error tq-as-why">Why not eligible: {detail.reasons.join('; ')}</p>}
          <p className="tq-muted tq-small">Captured by {detail.created_by} · session {detail.session} · rev <span className="tq-num">{detail.rev}</span> ·
            evidence hash <span className="tq-num tq-as-hash">{detail.evidence_hash}</span></p>
          <div className="tq-as-cols">
            <section aria-label="Telemetry summary">
              <h4 className="tq-as-h4">Telemetry summary <ProvBadge kind="SIMULATED" /></h4>
              <dl className="tq-kv" aria-label="Telemetry summary">
                <dt>Windows</dt><dd className="tq-num">{s.n} ({fmt(s.t_start, 0)}–{fmt(s.t_end, 0)} s)</dd>
                <dt>Setpoint / speed</dt><dd className="tq-num">{fmt(s.setpoint_rpm_mean, 0)} / {fmt(s.rpm_mean, 0)} rpm (CV {fmt(s.rpm_cv * 100, 1)}%)</dd>
                <dt>Ambient</dt><dd className="tq-num">{fmt(s.ambient_c_mean, 1)} ± {fmt(s.ambient_c_std, 2)} °C</dd>
                <dt>Current / housing / vibration</dt><dd className="tq-num">{fmt(s.current_a_mean, 2)} A · {fmt(s.housing_c_mean, 1)} °C · {fmt(s.vib_rms_g_mean, 3)} g</dd>
              </dl>
            </section>
            <section aria-label="Eligibility checks">
              <h4 className="tq-as-h4">Eligibility checks</h4>
              <table className="tq-table"><caption className="tq-sr">Eligibility checks</caption>
                <thead><tr><th scope="col">Check</th><th scope="col">Result</th><th scope="col">Detail</th></tr></thead>
                <tbody>{detail.checks.map((c) => (
                  <tr key={c.name}><td>{c.name.replace(/_/g, ' ')}</td>
                    <td>{c.passed ? <Pill tone="ok">pass</Pill> : <Pill tone="crit">fail</Pill>}</td>
                    <td>{c.detail}</td></tr>))}</tbody></table>
            </section>
          </div>
          <p className="tq-muted tq-small">Model / configuration: detector {detail.versions?.detector_class} v{detail.versions?.detector_version} · attestation config {detail.versions?.attestation_config}</p>

          {ctl && (
            <div className="tq-as-decide">
              <div className="tq-row">
                {detail.state === 'PENDING' && <button type="button" className="tq-btn" onClick={refresh} disabled={a.busy}>Re-evaluate with latest windows</button>}
                {detail.state === 'ELIGIBLE' && <button type="button" className="tq-btn tq-primary" onClick={() => setMode('attest')} disabled={a.busy}>Attest…</button>}
                {['ELIGIBLE', 'PENDING'].includes(detail.state) && <button type="button" className="tq-btn tq-danger" onClick={() => setMode('reject')} disabled={a.busy}>Reject…</button>}
                {detail.state === 'ATTESTED' && <button type="button" className="tq-btn tq-danger" onClick={() => setMode('revoke')} disabled={a.busy}>Revoke…</button>}
              </div>
              {mode && (
                <form className="tq-form tq-as-form" onSubmit={(e) => { e.preventDefault(); if (canConfirm) decide(); }} aria-label={`Confirm ${mode}`}>
                  <fieldset className="tq-fieldset"><legend>Confirm: {mode} {detail.id} (revision {detail.rev})</legend>
                  {mode === 'attest' && <p className="tq-warnbox" role="note">{NOTICE} By confirming you accept responsibility for this judgment; it is recorded under your name with the reason below.</p>}
                  <label>Reason (at least {MIN_REASON} characters)
                    <textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Decision reason" /></label>
                  {mode === 'attest' && (
                    <label className="tq-check"><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
                      I understand this is an operator judgment, not proof that the motor is healthy.</label>)}
                  <p className="tq-muted tq-small">If the candidate changed since you opened it, the server refuses the decision and this view reloads what it now says.</p>
                  <div className="tq-row">
                    <button type="submit" className={`tq-btn ${mode === 'attest' ? 'tq-primary' : 'tq-danger'}`} disabled={!canConfirm}>Confirm {mode}</button>
                    <button type="button" className="tq-btn tq-ghost" onClick={() => setMode(null)}>Cancel</button>
                  </div>
                  </fieldset>
                </form>)}
            </div>)}

          <Disclosure summary="Decision history" meta={`${detail.history.length} recorded event(s)`} testid="att-history" open className="tq-mt">
            <h4 className="tq-as-h4">History <ProvBadge kind="HUMAN_CONFIRMED" /></h4>
            <table className="tq-table"><caption className="tq-sr">Decision history</caption>
              <thead><tr><th scope="col">Event</th><th scope="col">Transition</th><th scope="col">By</th><th scope="col">Reason</th></tr></thead>
              <tbody>{detail.history.map((h, i) => (
                <tr key={i}><td>{h.event.replace(/_/g, ' ')}</td><td>{h.from} → {h.to}</td><td>{h.by} ({h.role})</td><td>{h.reason || '—'}</td></tr>))}</tbody></table>
          </Disclosure>
        </Card>)}

      <Card title="Reference versions" id="c-att-refs" icon={Layers} sub="Activation changes the running reference only" right={<ProvBadge kind="DERIVED" />}>
        <p className="tq-muted">Active: <strong>{refs.active_version ? `v${refs.active_version}` : 'none (shipped detector, unadapted)'}</strong></p>
        {ctl && (
          <label className="tq-as-reason">Reason for activate / roll back (at least {MIN_REASON} characters)
            <input type="text" value={refReason} onChange={(e) => setRefReason(e.target.value)} aria-label="Reference change reason" /></label>)}
        {!(refs?.versions?.length) ? <Empty>No reference versions yet. A version is created only when an operator attests an eligible candidate.</Empty> : (
          <div className="tq-table-wrap"><table className="tq-table"><caption className="tq-sr">Reference versions</caption>
            <thead><tr><th scope="col">Version</th><th scope="col">Candidate</th><th scope="col">Attested by</th><th scope="col">Gain</th><th scope="col">Hold-out check</th><th scope="col">Status</th><th scope="col"><span className="tq-sr">Actions</span></th></tr></thead>
            <tbody>{(refs.versions || []).map((v) => (
              <tr key={v.version} className={v.version === refs.active_version ? 'tq-as-active-row' : undefined}><td className="tq-num">v{v.version}</td><td>{v.candidate}</td><td>{v.created_by || '—'}</td><td className="tq-num">{fmt(v.gain, 2)}</td>
                <td>{v.validation?.ok ? <Pill tone="ok">passed</Pill> : <Pill tone="crit">failed</Pill>}</td>
                <td>{v.version === refs.active_version ? <Pill tone="ok">active</Pill> : v.status}</td>
                <td>{ctl && v.version !== refs.active_version && (
                  <button type="button" className="tq-btn" onClick={() => activate(v.version)} disabled={!refOk || a.busy} aria-label={`Activate v${v.version}`}>Activate</button>)}</td></tr>))}</tbody></table></div>)}
        {ctl && <div className="tq-row tq-mt"><button type="button" className="tq-btn tq-danger" onClick={rollback} disabled={!refOk || !refs.active_version || a.busy}>Roll back active reference</button></div>}
      </Card>

      <Disclosure summary="Supervised warm-up" meta={hold.active ? 'hold active' : 'optional: hold score-triggered incidents briefly before capturing a candidate'} testid="att-hold"
        open={!!(hold.active || hold.info?.regime_escalation)}>
        <div id="c-att-hold">
        <p className="tq-muted">Anomaly detection keeps running during a hold. Only anomalies explainable as a healthy gain/noise shift are deferred (and counted below);
          any channel-selective or protected-channel deviation — every ordinary fault — ends the hold and opens an incident as usual. Mandatory-stop conditions and device
          e-stops are never deferred. Maximum 300 s; it ends by itself.</p>
        {hold.info?.regime_escalation && (
          <div className="tq-warnbox" role="alert" data-testid="regime-escalation">
            <strong>Unfamiliar regime — human review required.</strong> Anomalous scores are being deferred because they are explained by a coherent gain/noise shift.
            This is <strong>not</strong> confirmed healthy: a coherent shift can also be a real fault (for example a sensor fault). Deferral is capped and ends at
            once on any fault evidence.
          </div>)}
        {hold.info && (
          <p role="status" data-testid="hold-status">
            {hold.active ? 'Hold active' : 'Hold ended'} · deferred anomaly windows: <strong className="tq-num">{hold.info.deferred_windows ?? 0}</strong>
            {hold.info.released ? <> · released: <strong>{hold.info.released}</strong></> : null}
          </p>)}
        <form className="tq-form tq-as-holdform" onSubmit={(e) => { e.preventDefault(); startHold(); }} aria-label="Start supervised warm-up">
          <label className="tq-inline">Seconds<input type="number" min="1" max="300" value={holdForm.seconds} onChange={(e) => setHoldForm({ ...holdForm, seconds: e.target.value })} disabled={!ctl} /></label>
          <label>Reason<input type="text" value={holdForm.reason} onChange={(e) => setHoldForm({ ...holdForm, reason: e.target.value })} disabled={!ctl} /></label>
          <div className="tq-row">
            <button type="submit" className="tq-btn" disabled={!ctl || a.busy || holdForm.reason.trim().length < MIN_REASON}>Start hold</button>
            <button type="button" className="tq-btn tq-ghost" onClick={endHold} disabled={!ctl || !hold.active || a.busy}>End hold</button>
          </div>
        </form>
        </div>
      </Disclosure>
      <Disclosure summary="View attestation log" meta={`${events.length} recorded event(s)`} testid="att-log">
      <div id="c-att-log">
        {!events.length ? <Empty>No attestation activity yet.</Empty> : (
          <div className="tq-table-wrap"><table className="tq-table"><caption className="tq-sr">Attestation log</caption>
            <thead><tr><th scope="col">#</th><th scope="col">When</th><th scope="col">Event</th><th scope="col">Candidate / version</th><th scope="col">By</th><th scope="col">Reason</th></tr></thead>
            <tbody>{events.slice().reverse().slice(0, 25).map((e) => (
              <tr key={e.n}><td className="tq-num">{e.n}</td><td className="tq-num">{when(e.ts) || '—'}</td><td>{String(e.detail.event || '').replace(/_/g, ' ')}</td>
                <td>{e.detail.candidate || '—'}{e.detail.reference_version ? ` · v${e.detail.reference_version}` : ''}</td><td>{e.actor}</td><td>{e.detail.reason || '—'}</td></tr>))}</tbody></table></div>)}
      </div>
      </Disclosure>
    </div>
  );
}
