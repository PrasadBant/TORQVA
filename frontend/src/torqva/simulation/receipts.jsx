// Decision Receipts (C3, simulation): every analyst request (accepted or refused) and every action the pipeline dispatched, with the evidence
// it was decided on, the gate and Safety Supervisor results, the approval state and a lifecycle read from later records
// (GET /simulation/workbench/receipts…). The digest detects a changed snapshot; it is not a signature. Export downloads the receipt as JSON.
import React, { useEffect, useRef, useState } from 'react';
import { Download, FileCheck2 } from 'lucide-react';
import { api } from '../api.js';
import { Card, Empty, Pill, ProvBadge, fmt } from '../shared/components.jsx';
import { title, fmtRpm, pct } from './workbench.js';

const STATE_TONE = { PROPOSED: 'info', AWAITING_APPROVAL: 'wait', REJECTED: 'crit', REFUSED_BY_SAFETY: 'crit', ACCEPTED: 'ok', ACKNOWLEDGED: 'ok',
  EXECUTED: 'ok', VERIFICATION_PENDING: 'wait', RECOVERED: 'ok', RECOVERY_FAILED: 'crit', OUTCOME_UNKNOWN: 'warn' };

export function exportReceipt(r) {
  try {
    const blob = new Blob([JSON.stringify(r, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = `torqva-decision-receipt-${r.id}.json`;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    return true;
  } catch { return false; }
}

function Snapshot({ s }) {
  if (!s) return null;
  if (s.gate !== undefined && s.supervisor_decisions) {                     // derived receipt (pipeline action)
    return (
      <dl className="tq-kv tq-small">
        <dt>Gate record</dt><dd>{s.gate ? `${s.gate.verdict}: ${s.gate.reason}` : 'none recorded'}</dd>
        <dt>Supervisor decisions</dt><dd>{s.supervisor_decisions.map((x) => `${x.verdict} (${(x.reasons || []).map(title).join(', ')})`).join(' · ') || 'none'}</dd>
        <dt>C2 predictions recorded</dt><dd>{s.predictions.length ? s.predictions.map((p) => `${title(p.action)}${p.action === 'REDUCE_SPEED' ? ` ${fmtRpm(p.target_rpm)} rpm` : ''}: risk ${pct(p.risk, 0)} (${p.status})`).join(' · ') : 'none'}</dd>
      </dl>);
  }
  const t = s.telemetry; const g = s.gate; const sup = s.supervisor; const p = s.prediction;
  return (
    <dl className="tq-kv tq-small" data-testid="receipt-snapshot">
      <dt>Investigation</dt><dd>{s.investigation || 'no incident'} · simulation t = {fmt(s.sim_t, 0)} s · session {s.session}</dd>
      <dt>Telemetry (SIM)</dt><dd className="tq-num">{t ? `${fmtRpm(t.rpm)} rpm (setpoint ${fmtRpm(t.setpoint)}) · ${fmt(t.current, 2)} A · ${fmt(t.voltage, 2)} V · ${fmt(t.housing, 1)} °C · ${fmt(t.vib_rms, 3)} g · ${t.valid ? 'valid' : 'INVALID'} · ${fmt(t.age_s, 0)} s old` : 'none'}</dd>
      <dt>C1</dt><dd>{s.c1 ? `${title(s.c1.status)}${s.c1.score_over_threshold !== null ? `, ${fmt(s.c1.score_over_threshold, 2)} × threshold` : ''}` : '—'}</dd>
      <dt>Hypotheses</dt><dd>{s.hypotheses ? `${s.hypotheses.ranked.slice(0, 3).map(([h, v]) => `${title(h)} ${pct(v, 0)}`).join(' · ')} (${s.hypotheses.label}, ${s.hypotheses.n_windows} windows)` : 'no ranking'}</dd>
      <dt>Evidence features</dt><dd>{s.evidence_features?.length ? s.evidence_features.slice(0, 4).map((f) => `${f.feature} ${f.mean_z > 0 ? '+' : ''}${fmt(f.mean_z, 1)}σ`).join(' · ') : 'none'}</dd>
      <dt>C4 evidence</dt><dd>{[...(s.c4_tests_in_incident || []).map((x) => `${x.test} at t = ${fmt(x.t, 0)} s`), ...(s.diagnostic_runs || []), ...(s.counterfactual_experiments || [])].join(' · ') || 'none'}</dd>
      <dt>C2 prediction for this target</dt><dd className="tq-num">{p ? `${p.candidate_id} · ${p.status} · risk ${pct(p.risk, 0)} · housing +120 s ${fmt(p.mean?.housing?.[2], 1)} °C [${fmt(p.lo?.housing?.[2], 1)}–${fmt(p.hi?.housing?.[2], 1)}]` : 'none'}</dd>
      <dt>Gate</dt><dd>{g ? <><Pill tone={g.verdict === 'ACT' ? 'ok' : 'warn'}>{title(g.verdict)}</Pill> {g.reason}</> : 'not evaluated'}</dd>
      <dt>Safety Supervisor</dt><dd>{sup ? <><Pill tone={sup.verdict === 'REJECT' ? 'crit' : 'ok'}>{sup.verdict}</Pill> {(sup.reasons || []).map(title).join(', ')}</> : '—'}</dd>
      <dt>Human approval</dt><dd>{s.awaiting_human_decision ? `required: the pipeline was holding ${title(s.pending_proposal?.action)}${s.pending_proposal?.params?.rpm ? ` to ${fmtRpm(s.pending_proposal.params.rpm)} rpm` : ''}` : 'no action was held for a human decision'}</dd>
      <dt>Freshness</dt><dd>{s.stale?.length ? `stale: ${s.stale.join('; ')}` : 'current'}</dd>
      {s.blockers?.length > 0 && <><dt>Blockers</dt><dd>{s.blockers.join('; ')}</dd></>}
      <dt>Versions</dt><dd className="tq-num">hypotheses v{s.versions?.hypothesis_model} · C4 v{s.versions?.c4_signatures} · C2 v{s.versions?.c2_predictor} · C1 v{s.versions?.c1_detector ?? '—'}</dd>
    </dl>);
}

export function ReceiptsPanel({ d, focusId }) {
  const [list, setList] = useState(null);
  const [sel, setSel] = useState(null);
  const [rec, setRec] = useState(null);
  const [err, setErr] = useState(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const n = (d.log || []).length + (d.commands || []).length;
  const hasSim = d.status?.t !== undefined && d.status?.t !== null;
  useEffect(() => {
    if (!hasSim) return undefined;
    const id = setTimeout(() => api.wbReceipts().then((r) => { if (alive.current) { setList(r); setErr(null); } }).catch((e) => { if (alive.current) setErr(e.message || String(e)); }), 300);
    return () => clearTimeout(id);
  }, [n, hasSim]);
  useEffect(() => { if (focusId) setSel(focusId); }, [focusId]);
  useEffect(() => {
    if (!sel) { setRec(null); return; }
    api.wbReceipt(sel).then((r) => { if (alive.current) setRec(r); }).catch((e) => { if (alive.current) setErr(e.message || String(e)); });
  }, [sel, n]);
  const rows = list?.receipts || [];
  return (
    <Card title="Decision receipts" id="c-receipts" right={<ProvBadge kind="SIMULATED" />}>
      {!hasSim ? <Empty>No simulation is running.</Empty> : err ? <p className="tq-muted">Receipts could not be loaded: {err}</p> : !list ? <Empty loading>Loading receipts…</Empty> : (
        <>
          {list.pending && (
            <div className={`tq-callout ${list.pending.still_valid ? 'info' : 'warn'}`} data-testid="receipt-pending">
              <strong>Held for approval: {title(list.pending.action)}{list.pending.params?.rpm ? ` to ${fmtRpm(list.pending.params.rpm)} rpm` : ''}</strong>
              <p>Proposed at t = {fmt(list.pending.proposed_at, 0)} s with gate {list.pending.gate_then}; the gate now says {list.pending.gate_now.verdict}. {list.pending.still_valid ? 'Its basis is still current.' : `No longer current: ${list.pending.issues.join('; ')}.`}</p>
              <p className="tq-small">{list.pending.note}</p>
            </div>)}
          {!rows.length ? <Empty>No action has been requested or dispatched in this run yet.</Empty> : (
            <ul className="tq-list" data-testid="receipt-list">
              {rows.map((r) => (
                <li key={r.id}>
                  <button type="button" className="tq-link" aria-pressed={sel === r.id} onClick={() => setSel(r.id)}><FileCheck2 size={14} aria-hidden="true" />{r.id}</button>{' '}
                  <Pill tone={r.decision === 'REFUSED' ? 'crit' : 'ok'}>{r.decision}</Pill>{' '}
                  {title(r.action)}{r.target_rpm ? ` to ${fmtRpm(r.target_rpm)} rpm` : ''} <span className="tq-muted">· {r.kind === 'analyst' ? 'analyst request' : 'pipeline action (derived)'}{r.investigation ? ` · ${r.investigation}` : ''}</span>
                </li>))}
            </ul>)}
          {rec && (
            <article className="tq-receipt" data-testid="receipt">
              <header className="tq-cand-head"><strong>Receipt {rec.id}</strong>
                <span className="tq-row"><Pill tone={rec.decision === 'REFUSED' ? 'crit' : 'ok'}>{rec.decision}</Pill>
                  <Pill tone={rec.digest_valid ? 'ok' : 'crit'}>{rec.digest_valid ? 'snapshot digest matches' : 'SNAPSHOT CHANGED'}</Pill>
                  <button type="button" className="tq-btn" onClick={() => exportReceipt(rec)} data-testid="receipt-export"><Download size={14} aria-hidden="true" /> Export JSON</button></span></header>
              <p className="tq-small">{title(rec.request.action)}{rec.request.target_rpm ? ` to ${fmtRpm(rec.request.target_rpm)} rpm` : ''} · requested by {rec.request.requested_by || '—'}{rec.request.candidate_id ? ` · candidate ${rec.request.candidate_id}` : ''}{rec.command ? ` · command #${rec.command.id} (${rec.command.status})` : ' · no command dispatched'}</p>
              <span className="tq-section-title">Lifecycle (from records)</span>
              <ol className="tq-life" data-testid="receipt-lifecycle">
                {rec.lifecycle.map((x, i) => (
                  <li key={`${x.state}-${i}`} className={`tq-life-step is-${['REJECTED', 'REFUSED_BY_SAFETY', 'RECOVERY_FAILED'].includes(x.state) ? 'no' : ['AWAITING_APPROVAL', 'VERIFICATION_PENDING'].includes(x.state) ? 'now' : 'done'}`} data-state={x.state}>
                    <span className="tq-life-dot" aria-hidden="true" />
                    <div><Pill tone={STATE_TONE[x.state] || 'info'}>{title(x.state)}</Pill>{x.t !== null && x.t !== undefined && <span className="tq-muted tq-small tq-num"> t = {fmt(x.t, 0)} s</span>}<p className="tq-muted tq-small">{x.detail}</p></div>
                  </li>))}
              </ol>
              {rec.unresolved?.length > 0 && <div className="tq-callout warn" data-testid="receipt-unresolved"><strong>Unresolved</strong><ul className="tq-list">{rec.unresolved.map((u) => <li key={u}>{u}</li>)}</ul></div>}
              <span className="tq-section-title">Evidence at decision time{rec.derived ? ' (rebuilt from the pipeline\'s records)' : ''}</span>
              <Snapshot s={rec.snapshot} />
              <p className="tq-chart-note">SHA-256 {rec.snapshot_sha256?.slice(0, 16)}… — {rec.digest_note}.</p>
            </article>)}
        </>)}
    </Card>
  );
}
