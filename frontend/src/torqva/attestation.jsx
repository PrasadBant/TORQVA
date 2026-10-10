import React, { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, XCircle } from 'lucide-react';
import { Card, Empty, ErrorBox, Pill, ProvBadge, fmt } from './components.jsx';
import { api } from './api.js';

const canControl = (role) => role === 'operator' || role === 'admin';
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
  const decide = () => a.run(async () => {
    const body = { reason, expected_rev: detail.rev, acknowledge: ack };
    if (mode === 'attest') await api.attAttest(detail.id, body);
    else if (mode === 'reject') await api.attReject(detail.id, body);
    else await api.attRevoke(detail.id, body);
    await reload(detail.id);
  });
  const startHold = () => a.run(async () => { await api.attHoldStart({ seconds: Number(holdForm.seconds), reason: holdForm.reason }); await load(); });
  const endHold = () => a.run(async () => { await api.attHoldEnd(); await load(); });
  const activate = (v) => a.run(async () => { await api.attActivate(v, refReason); await load(); });
  const rollback = () => a.run(async () => { await api.attRollback(refReason); await load(); });

  const reasonOk = reason.trim().length >= MIN_REASON;
  const canConfirm = reasonOk && (mode !== 'attest' || ack) && !a.busy;
  const s = detail?.summary;
  const refOk = refReason.trim().length >= MIN_REASON;

  return (
    <div className="tq-grid">
      <Card title="What attestation means" id="c-att-notice">
        <p className="tq-warnbox" role="note" data-testid="att-notice">{NOTICE}</p>
        <p className="tq-muted">Telemetry and checks are <ProvBadge kind="SIMULATED" /> values; a decision recorded here is <ProvBadge kind="HUMAN_CONFIRMED" /> — a named
          operator's judgment, recorded with the evidence hash and model versions. Attestation only affects the experimental adaptive C1 detector, which is off by default.
          It never changes the deterministic Safety Supervisor or any command path.</p>
        {!ctl && <Empty>Your role ({role}) can review candidates but cannot capture, attest, reject, revoke or activate.</Empty>}
      </Card>

      <Card title="Supervised warm-up" id="c-att-hold" right={<Pill tone={hold.active ? 'warn' : 'off'}>{hold.active ? 'hold active' : 'no hold'}</Pill>}>
        <p className="tq-muted">While a hold is active, anomaly <em>scores</em> do not open incidents (so a healthy but shifted motor can be observed). Mandatory-stop
          conditions are never deferred. Maximum 300 s; it ends by itself. A real fault would be flagged late by at most the hold length.</p>
        <form className="tq-form" onSubmit={(e) => { e.preventDefault(); startHold(); }} aria-label="Start supervised warm-up">
          <label className="tq-inline">Seconds<input type="number" min="1" max="300" value={holdForm.seconds} onChange={(e) => setHoldForm({ ...holdForm, seconds: e.target.value })} disabled={!ctl} /></label>
          <label>Reason<input type="text" value={holdForm.reason} onChange={(e) => setHoldForm({ ...holdForm, reason: e.target.value })} disabled={!ctl} /></label>
          <div className="tq-row">
            <button type="submit" className="tq-btn" disabled={!ctl || a.busy || holdForm.reason.trim().length < MIN_REASON}>Start hold</button>
            <button type="button" className="tq-btn tq-ghost" onClick={endHold} disabled={!ctl || !hold.active || a.busy}>End hold</button>
          </div>
        </form>
      </Card>

      <Card title="Candidate warm-up sessions" id="c-att-list" right={<ProvBadge kind="SIMULATED" />}>
        <div className="tq-row"><button className="tq-btn" onClick={capture} disabled={!ctl || a.busy}>Capture candidate from current simulation</button></div>
        <ErrorBox error={a.error} />
        {!list.length ? <Empty>No candidates yet. Start a simulation, let it warm up, then capture a candidate.</Empty> : (
          <table className="tq-table"><caption className="tq-sr">Candidate warm-up sessions</caption>
            <thead><tr><th scope="col">ID</th><th scope="col">State</th><th scope="col">Session</th><th scope="col">Speed rpm</th><th scope="col">Windows</th><th scope="col">Failed checks</th></tr></thead>
            <tbody>{list.map((c) => (
              <tr key={c.id} className={c.id === sel ? 'tq-selected' : ''}>
                <td><button className="tq-link" onClick={() => a.run(() => open(c.id))} aria-label={`Open candidate ${c.id}`}>{c.id}</button></td>
                <td><StateLabel state={c.state} /></td><td>{c.session}</td>
                <td className="tq-num">{fmt(c.setpoint_rpm, 0)}</td><td className="tq-num">{c.n}</td>
                <td>{c.failed_checks.length ? c.failed_checks.join(', ') : '—'}</td></tr>))}</tbody></table>)}
      </Card>

      {detail && (
        <Card title={`Evidence — ${detail.id}`} id="c-att-detail" right={<StateLabel state={detail.state} />}>
          <p className="tq-muted">{MEANING[detail.state]} · captured by {detail.created_by} · session {detail.session} · rev <span className="tq-num">{detail.rev}</span> ·
            evidence hash <span className="tq-num">{detail.evidence_hash}</span></p>
          {detail.warnings?.length > 0 && <div className="tq-warnbox" role="alert">{detail.warnings.map((w) => <p key={w}>{w}</p>)}</div>}
          {detail.reasons?.length > 0 && <p className="tq-error">Why not eligible: {detail.reasons.join('; ')}</p>}
          <h4>Telemetry summary <ProvBadge kind="SIMULATED" /></h4>
          <dl className="tq-kv" aria-label="Telemetry summary">
            <dt>Windows</dt><dd className="tq-num">{s.n} ({fmt(s.t_start, 0)}–{fmt(s.t_end, 0)} s)</dd>
            <dt>Setpoint / speed</dt><dd className="tq-num">{fmt(s.setpoint_rpm_mean, 0)} / {fmt(s.rpm_mean, 0)} rpm (CV {fmt(s.rpm_cv * 100, 1)}%)</dd>
            <dt>Ambient</dt><dd className="tq-num">{fmt(s.ambient_c_mean, 1)} ± {fmt(s.ambient_c_std, 2)} °C</dd>
            <dt>Supply</dt><dd className="tq-num">{fmt(s.voltage_v_mean, 2)} ± {fmt(s.voltage_v_std, 2)} V</dd>
            <dt>Current / housing / vibration</dt><dd className="tq-num">{fmt(s.current_a_mean, 2)} A · {fmt(s.housing_c_mean, 1)} °C · {fmt(s.vib_rms_g_mean, 3)} g</dd>
          </dl>
          <h4>Eligibility checks</h4>
          <table className="tq-table"><caption className="tq-sr">Eligibility checks</caption>
            <thead><tr><th scope="col">Check</th><th scope="col">Result</th><th scope="col">Detail</th></tr></thead>
            <tbody>{detail.checks.map((c) => (
              <tr key={c.name}><td>{c.name.replace(/_/g, ' ')}</td>
                <td>{c.passed ? <Pill tone="ok"><CheckCircle2 size={12} aria-hidden="true" />pass</Pill> : <Pill tone="crit"><XCircle size={12} aria-hidden="true" />fail</Pill>}</td>
                <td>{c.detail}</td></tr>))}</tbody></table>
          <p className="tq-muted">Model / configuration: detector {detail.versions?.detector_class} v{detail.versions?.detector_version} · attestation config {detail.versions?.attestation_config}</p>

          <h4>History <ProvBadge kind="HUMAN_CONFIRMED" /></h4>
          <table className="tq-table"><caption className="tq-sr">Decision history</caption>
            <thead><tr><th scope="col">Event</th><th scope="col">Transition</th><th scope="col">By</th><th scope="col">Reason</th></tr></thead>
            <tbody>{detail.history.map((h, i) => (
              <tr key={i}><td>{h.event.replace(/_/g, ' ')}</td><td>{h.from} → {h.to}</td><td>{h.by} ({h.role})</td><td>{h.reason || '—'}</td></tr>))}</tbody></table>

          {ctl && (
            <>
              <div className="tq-row">
                {detail.state === 'PENDING' && <button className="tq-btn" onClick={refresh} disabled={a.busy}>Re-evaluate with latest windows</button>}
                {detail.state === 'ELIGIBLE' && <button className="tq-btn" onClick={() => setMode('attest')} disabled={a.busy}>Attest…</button>}
                {['ELIGIBLE', 'PENDING'].includes(detail.state) && <button className="tq-btn tq-danger" onClick={() => setMode('reject')} disabled={a.busy}>Reject…</button>}
                {detail.state === 'ATTESTED' && <button className="tq-btn tq-danger" onClick={() => setMode('revoke')} disabled={a.busy}>Revoke…</button>}
              </div>
              {mode && (
                <form className="tq-form" onSubmit={(e) => { e.preventDefault(); if (canConfirm) decide(); }} aria-label={`Confirm ${mode}`}>
                  <fieldset className="tq-fieldset"><legend>Confirm: {mode} {detail.id}</legend>
                  {mode === 'attest' && <p className="tq-warnbox" role="note">{NOTICE} By confirming you accept responsibility for this judgment; it is recorded under your name with the reason below.</p>}
                  <label>Reason (at least {MIN_REASON} characters)
                    <textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Decision reason" /></label>
                  {mode === 'attest' && (
                    <label className="tq-check"><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
                      I understand this is an operator judgment, not proof that the motor is healthy.</label>)}
                  <div className="tq-row">
                    <button type="submit" className={`tq-btn ${mode === 'attest' ? '' : 'tq-danger'}`} disabled={!canConfirm}>Confirm {mode}</button>
                    <button type="button" className="tq-btn tq-ghost" onClick={() => setMode(null)}>Cancel</button>
                  </div>
                  </fieldset>
                </form>)}
            </>)}
        </Card>)}

      <Card title="Reference versions" id="c-att-refs" right={<ProvBadge kind="DERIVED" />}>
        <p className="tq-muted">Versions are immutable. Activation swaps the active reference of the running session only; the trained baseline is never edited.
          Active: <strong>{refs.active_version ? `v${refs.active_version}` : 'none (shipped detector, unadapted)'}</strong></p>
        {ctl && (
          <label>Reason for activate / roll back (at least {MIN_REASON} characters)
            <input type="text" value={refReason} onChange={(e) => setRefReason(e.target.value)} aria-label="Reference change reason" /></label>)}
        {!refs.versions.length ? <Empty>No reference versions yet. A version is created only when an operator attests an eligible candidate.</Empty> : (
          <table className="tq-table"><caption className="tq-sr">Reference versions</caption>
            <thead><tr><th scope="col">Version</th><th scope="col">Candidate</th><th scope="col">Gain</th><th scope="col">Hold-out check</th><th scope="col">Status</th><th scope="col"><span className="tq-sr">Actions</span></th></tr></thead>
            <tbody>{refs.versions.map((v) => (
              <tr key={v.version}><td className="tq-num">v{v.version}</td><td>{v.candidate}</td><td className="tq-num">{fmt(v.gain, 2)}</td>
                <td>{v.validation?.ok ? <Pill tone="ok">passed</Pill> : <Pill tone="crit">failed</Pill>}</td>
                <td>{v.version === refs.active_version ? <Pill tone="ok">active</Pill> : v.status}</td>
                <td>{ctl && v.version !== refs.active_version && (
                  <button className="tq-btn" onClick={() => activate(v.version)} disabled={!refOk || a.busy} aria-label={`Activate v${v.version}`}>Activate</button>)}</td></tr>))}</tbody></table>)}
        {ctl && <div className="tq-row"><button className="tq-btn tq-danger" onClick={rollback} disabled={!refOk || !refs.active_version || a.busy}>Roll back active reference</button></div>}
      </Card>

      <Card title="Attestation log" id="c-att-log">
        {!events.length ? <Empty>No attestation activity yet.</Empty> : (
          <table className="tq-table"><caption className="tq-sr">Attestation log</caption>
            <thead><tr><th scope="col">#</th><th scope="col">Event</th><th scope="col">Candidate / version</th><th scope="col">By</th><th scope="col">Reason</th></tr></thead>
            <tbody>{events.slice().reverse().slice(0, 25).map((e) => (
              <tr key={e.n}><td className="tq-num">{e.n}</td><td>{String(e.detail.event || '').replace(/_/g, ' ')}</td>
                <td>{e.detail.candidate || '—'}{e.detail.reference_version ? ` · v${e.detail.reference_version}` : ''}</td><td>{e.actor}</td><td>{e.detail.reason || '—'}</td></tr>))}</tbody></table>)}
      </Card>
    </div>
  );
}
