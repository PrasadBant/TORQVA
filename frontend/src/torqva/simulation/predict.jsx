// Predictions (C2), simulation mode: compare up to three REDUCE_SPEED targets (Action A, B, C) against the CONTINUE_MONITORING and STOP
// references. Every number shown for a candidate is the backend predictor's output for exactly that target (POST /simulation/workbench/predict);
// changing a target marks its card pending until a prediction computed for the new value arrives. Selecting an action is a proposal for
// review on Interventions: nothing is sent from this page.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, RefreshCw, CheckCircle2 } from 'lucide-react';
import { api } from '../api.js';
import { Card, Empty, ErrorBox, Pill, ProvBadge, fmt, PageHead } from '../shared/components.jsx';
import { ResponseChart } from '../shared/lazyCharts.jsx';
import { PredictionsPage } from './pages.jsx';
import { StatusPill } from './c2c4.jsx';
import { usePlan, title, pct, fmtRpm } from './workbench.js';
import { CounterfactualLab } from './counterfactual.jsx';
import { InvestigationTrace } from './trace.jsx';

const LABELS = ['A', 'B', 'C'];
const SIG = { housing: ['Housing temperature', '°C', 1], rpm: ['Speed', 'rpm', 0], vib_rms: ['Vibration RMS (simulator model)', 'g', 3], current: ['Current', 'A', 2] };
const key = (ts) => ts.map((t) => Number(t)).join('|');
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
// The backend reports targets to 0.1 rpm; requests and matching use the same resolution, so a typed 1400.04 is the 1400.0 that was predicted.
const tenth = (v) => Math.round(Number(v) * 10) / 10;

/** Target-RPM chooser for one candidate: suggested targets from the backend plus a validated custom value. */
export function TargetRPMSelector({ label, value, onChange, suggestions, envelope, currentRpm, disabled }) {
  const n = Number(value);
  const set = value !== '' && Number.isFinite(n);
  const inEnv = set && envelope && n >= envelope[0] && n < envelope[1];
  const red = set && finite(currentRpm) ? currentRpm - n : null;
  return (
    <div className="tq-tgt" data-testid={`target-${label}`}>
      <div className="tq-prof-quick" role="group" aria-label={`Suggested targets for action ${label}`}>
        {suggestions.map((sg) => <button key={sg.target_rpm} type="button" className="tq-qbtn" aria-pressed={n === sg.target_rpm} title={sg.why} disabled={disabled} onClick={() => onChange(String(sg.target_rpm))}>{fmtRpm(sg.target_rpm)}</button>)}
      </div>
      <label>Target rpm for action {label}<input type="number" step="any" min={envelope ? Math.ceil(envelope[0]) : 1} max={envelope ? envelope[1] : 3000} value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} aria-invalid={set && !inEnv} placeholder="not compared" /></label>
      {set && (
        <p className="tq-small tq-num">
          {fmtRpm(currentRpm)} → <strong>{fmtRpm(n)}</strong> rpm{red !== null ? ` · ${red >= 0 ? '−' : '+'}${fmtRpm(Math.abs(red))} rpm${currentRpm > 0 ? ` (${pct(Math.abs(red) / currentRpm, 0)})` : ''}` : ''}
        </p>)}
      {set && !inEnv && envelope && <p className="tq-small tq-warn-text">Outside the Safety Supervisor's reduce envelope ({fmtRpm(envelope[0])}–{fmtRpm(envelope[1])} rpm, below the setpoint): it can be predicted but not executed.</p>}
    </div>
  );
}

const at = (p, s, i) => p?.mean?.[s]?.[i];
const band = (p, s, i) => (finite(p?.lo?.[s]?.[i]) && finite(p?.hi?.[s]?.[i]) ? [p.lo[s][i], p.hi[s][i]] : null);

/** Plain-language reading of one prediction, built only from the returned numbers. */
export function explainPrediction(p, cont, cur) {
  if (!p) return [];
  const out = [];
  if (p.action === 'REDUCE_SPEED') out.push(`Evaluates reducing the setpoint to ${fmtRpm(p.target_rpm)} rpm; speed is predicted at ${fmtRpm(at(p, 'rpm', 0))} rpm after 30 s.`);
  if (p.action === 'STOP') out.push(`Evaluates a coast stop; speed is predicted at ${fmtRpm(at(p, 'rpm', 0))} rpm after 30 s.`);
  if (p.action === 'CONTINUE_MONITORING') out.push('Reference: no change to the setpoint.');
  const h = at(p, 'housing', 2), hc = at(cont, 'housing', 2), b = band(p, 'housing', 2);
  if (finite(h)) out.push(`Housing at +120 s: ${fmt(h, 1)} °C${b ? ` (90 % interval ${fmt(b[0], 1)}–${fmt(b[1], 1)})` : ''}${finite(hc) && p.action !== 'CONTINUE_MONITORING' ? `, ${h <= hc ? `${fmt(hc - h, 1)} °C below` : `${fmt(h - hc, 1)} °C above`} continuing` : ''}; now ${fmt(cur?.housing, 1)} °C.`);
  const v = at(p, 'vib_rms', 2), vc = at(cont, 'vib_rms', 2);
  if (finite(v)) out.push(`Vibration at +120 s: ${fmt(v, 3)} g${finite(vc) && p.action !== 'CONTINUE_MONITORING' ? ` vs ${fmt(vc, 3)} g continuing` : ''}.`);
  if (finite(p.risk)) out.push(`Predicted risk of crossing a warning limit within 120 s: ${pct(p.risk, 0)}${cont && p.action !== 'CONTINUE_MONITORING' && finite(cont.risk) ? ` (continuing: ${pct(cont.risk, 0)})` : ''}.`);
  if (p.status !== 'supported') out.push(`The predictor marks this prediction ${title(p.status)}${p.status_reasons?.length ? ` (${p.status_reasons.map(title).join(', ')})` : ''}: it cannot drive a decision.`);
  return out;
}

function MiniResponse({ p, signal, cur, domain }) {
  const data = [{ h: 0, mean: cur?.[signal] ?? null }, ...[30, 60, 120].map((h, i) => ({ h, mean: at(p, signal, i) ?? null, band: band(p, signal, i) }))];
  return <div role="img" aria-label={`Predicted ${SIG[signal][0]} with 90 percent interval`} className="tq-chart"><ResponseChart data={data} height={170} yDomain={domain} /></div>;
}

export function SimPredictionsPage({ d, go, wb, setWb, stale, role }) {
  const { plan } = usePlan(d);
  const s = d.status || {};
  const hasSim = s.t !== undefined && s.t !== null;
  const post = plan?.posterior;
  const env = plan?.limits?.reduce_envelope_rpm;
  const sugg = plan?.suggested_targets || [];
  const [targets, setTargets] = useState(['', '', '']);
  const [res, setRes] = useState(null);
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState(null);
  const [signal, setSignal] = useState('housing');
  const seeded = useRef(false); const reqKey = useRef('');
  useEffect(() => {                                        // first time a plan with suggestions arrives: one suggestion per slot
    if (!seeded.current && sugg.length) { seeded.current = true; setTargets(LABELS.map((_, i) => (sugg[i] ? String(sugg[i].target_rpm) : ''))); }
  }, [sugg]);
  const valid = useMemo(() => targets.filter((t) => t !== '' && Number(t) > 0 && Number(t) <= 3000).map(tenth).filter((t, i, a) => a.indexOf(t) === i), [targets]);
  const request = async (ts) => {
    if (!ts.length) return;
    const k = key(ts); reqKey.current = k;
    setPending(true); setErr(null);
    try { const r = await api.wbPredict(ts); if (reqKey.current === k) setRes({ ...r, _key: k }); }
    catch (e) { if (reqKey.current === k) setErr(e); }
    finally { if (reqKey.current === k) setPending(false); }
  };
  useEffect(() => {                                        // a changed target is re-predicted after a short pause in typing
    if (!post || !valid.length || (res && res._key === key(valid))) return undefined;
    const id = setTimeout(() => request(valid), 450);
    return () => clearTimeout(id);
  }, [post, key(valid)]); // eslint-disable-line react-hooks/exhaustive-deps

  const age = res && hasSim ? s.t - res.basis.t : null;
  const isStale = !!(res && (age > res.max_age_s || Math.abs((s.device?.setpoint_rpm ?? -1) - res.basis.setpoint_rpm) > 0.5 || (post && post.top !== res.basis.posterior_top) || (post && post.label !== res.basis.posterior_label)));
  const cont = res?.references?.find((r) => r.action === 'CONTINUE_MONITORING');
  const stop = res?.references?.find((r) => r.action === 'STOP');
  const forTarget = (t) => (t === '' ? undefined : res?.candidates?.find((c) => c.target_rpm === tenth(t)));
  const shown = [...LABELS.map((l, i) => [l, targets[i], forTarget(targets[i])]).filter(([, t]) => t !== '')];
  const all = [...(res?.candidates || []), ...(res?.references || [])];
  const lo = Math.min(...all.flatMap((p) => p.lo?.[signal] || []).filter(finite), res?.current?.[signal] ?? Infinity);
  const hi = Math.max(...all.flatMap((p) => p.hi?.[signal] || []).filter(finite), res?.current?.[signal] ?? -Infinity);
  const domain = finite(lo) && finite(hi) && hi > lo ? [Math.floor(lo * 100) / 100, Math.ceil(hi * 100) / 100] : undefined;
  const sel = wb?.selection;
  const select = (label, p) => setWb((x) => ({ ...x, selection: { label, candidate_id: p.candidate_id, action: p.action, target_rpm: p.target_rpm, prediction: p, basis: p.basis, request_id: res.request_id, selected_at: s.t } }));
  const canSelect = (p) => p && !isStale && !pending && p.status === 'supported' && p.within_supervisor_envelope;
  const why = (p) => (!p ? 'no prediction for this target yet' : isStale ? 'the prediction is stale' : p.status !== 'supported' ? `prediction ${title(p.status)}` : !p.within_supervisor_envelope ? 'outside the Safety Supervisor envelope' : '');

  return (
    <>
      <PageHead title="Predictions (C2)" sub="Compare what the predictor expects for different target speeds, then select one action for review."
        right={<><ProvBadge kind="PREDICTED" />{sel && <Pill tone="info">{`selected: ${sel.action === 'STOP' ? 'STOP' : `Action ${sel.label} · ${fmtRpm(sel.target_rpm)} rpm`}`}</Pill>}</>} />

      <Card title="Prediction context" id="c-ctx" right={<ProvBadge kind="SIMULATED" />}>
        <dl className="tq-kv">
          <dt>Current speed (simulated)</dt><dd className="tq-num">{hasSim && s.last_window ? `${fmtRpm(s.last_window.rpm)} rpm at setpoint ${fmtRpm(s.device?.setpoint_rpm)} rpm` : '—'}</dd>
          <dt>Housing · current · vibration</dt><dd className="tq-num">{hasSim && s.last_window ? `${fmt(s.last_window.housing, 1)} °C · ${fmt(s.last_window.current, 2)} A · ${fmt(s.last_window.vib_rms, 3)} g` : '—'}</dd>
          <dt>Incident</dt><dd>{s.incident ? `${s.incident.id}: ${title(s.incident.state)}` : 'none open'}</dd>
          <dt>Conditioned on</dt><dd>{post ? <>{title(post.top)} {pct(post.top_p, 0)} <Pill tone={post.label === 'confident' ? 'ok' : 'warn'}>{post.label}</Pill> <span className="tq-muted">({post.n_windows} evidence windows)</span></> : 'no hypothesis ranking yet'}</dd>
          <dt>Model trust</dt><dd>{res ? (res.trust.trusted ? <Pill tone="ok">trusted by the predictor's own checks</Pill> : <Pill tone="warn">{`not trusted: ${res.trust.reasons.map(title).join(', ')}`}</Pill>) : '—'}</dd>
          <dt>Validated by experiments</dt><dd>{res ? (res.validated_by_experiments ? 'yes (simulation experiments)' : 'no — not validated against physical experiments') : '—'}</dd>
          <dt>Reduce envelope</dt><dd className="tq-num">{env ? `${fmtRpm(env[0])} – below ${fmtRpm(env[1])} rpm` : '—'}</dd>
        </dl>
      </Card>

      {!hasSim ? <Card title="Action comparison" id="c-cmp" className="tq-mt"><Empty>No simulation is running.</Empty></Card>
        : !post ? <Card title="Action comparison" id="c-cmp" className="tq-mt"><Empty>C2 predictions are conditional on a fault-hypothesis ranking, and there is none yet in this run. They become available once an anomaly has persisted.</Empty></Card> : (
          <Card title="Action comparison" id="c-cmp" className="tq-mt" right={<>{pending ? <Pill tone="wait">calculating…</Pill> : isStale ? <Pill tone="warn">stale</Pill> : res ? <Pill tone="ok">{`computed at t = ${fmt(res.basis.t, 0)} s`}</Pill> : null}<ProvBadge kind="PREDICTED" /></>}>
            {isStale && <div className="tq-callout warn" role="status" data-testid="pred-stale">These predictions were computed for an earlier state ({age > res.max_age_s ? `${fmt(age, 0)} s ago` : 'the state changed'}). Recalculate before selecting.
              <button type="button" className="tq-btn" onClick={() => request(valid)}><RefreshCw size={14} aria-hidden="true" /> Recalculate</button></div>}
            <div className="tq-toolbar"><span className="tq-toolbar-label">Signal</span>
              <div className="tq-seg" role="group" aria-label="Signal to compare">{Object.entries(SIG).map(([k, [n]]) => <button key={k} type="button" className="tq-btn" aria-pressed={signal === k} onClick={() => setSignal(k)}>{n.split(' (')[0]}</button>)}</div></div>
            <div className="tq-cands" data-testid="candidates">
              {LABELS.map((l, i) => {
                const t = targets[i]; const p = forTarget(t);
                const waiting = t !== '' && !p;
                return (
                  <article key={l} className={`tq-cand ${sel?.candidate_id && p && sel.candidate_id === p.candidate_id ? 'is-selected' : ''}`} data-testid={`cand-${l}`}>
                    <header className="tq-cand-head"><strong>Action {l}</strong><span className="tq-row">{p && <StatusPill status={p.status} />}{p && <span className="tq-muted tq-small tq-num">{p.candidate_id}</span>}</span></header>
                    <TargetRPMSelector label={l} value={t} onChange={(v) => setTargets((x) => x.map((y, j) => (j === i ? v : y)))} suggestions={sugg} envelope={env} currentRpm={res?.current?.rpm ?? s.last_window?.rpm} />
                    {t === '' ? <Empty>Not compared. Choose a target to add this action.</Empty> : waiting ? <p className="tq-empty" data-testid={`pending-${l}`}>{pending ? `Calculating the prediction for ${fmtRpm(t)} rpm…` : `Not yet predicted for ${fmtRpm(t)} rpm.`}</p> : (
                      <>
                        <MiniResponse p={p} signal={signal} cur={res.current} domain={domain} />
                        <ul className="tq-list tq-small tq-explain">{explainPrediction(p, cont, res.current).map((x) => <li key={x}>{x}</li>)}</ul>
                      </>)}
                    <button type="button" className="tq-btn tq-primary" disabled={!canSelect(p) || !t} onClick={() => select(l, p)} title={why(p)}>
                      <CheckCircle2 size={14} aria-hidden="true" /> {`Select Action ${l}${t ? ` — target ${fmtRpm(t)} rpm` : ''}`}</button>
                    {t !== '' && !canSelect(p) && <p className="tq-muted tq-small">{why(p)}</p>}
                  </article>);
              })}
            </div>

            {res && (
              <div className="tq-table-wrap tq-mt"><table className="tq-table" data-testid="cmp-table"><caption>Predicted {SIG[signal][0].toLowerCase()} ({SIG[signal][1]}): mean and 90 % interval for one future 1 s simulated measurement</caption>
                <thead><tr><th scope="col">Action</th><th scope="col">Target</th><th scope="col">+30 s</th><th scope="col">+60 s</th><th scope="col">+120 s</th><th scope="col">Risk (120 s)</th><th scope="col">Status</th></tr></thead>
                <tbody>
                  <tr><th scope="row">Now <ProvBadge kind="SIMULATED" /></th><td className="tq-num">{fmtRpm(res.current.setpoint_rpm)}</td><td colSpan={3} className="tq-num">{fmt(res.current[signal], SIG[signal][2])} (mean of the last {res.current.averaged_windows} windows)</td><td>—</td><td>measured in simulation</td></tr>
                  {[...shown.filter(([, , p]) => p).map(([l, , p]) => [`Action ${l}`, p]), ['Continue monitoring', cont], ['STOP (coast)', stop]].map(([n, p]) => p && (
                    <tr key={n}><th scope="row">{n}</th><td className="tq-num">{p.action === 'REDUCE_SPEED' ? `${fmtRpm(p.target_rpm)} rpm` : p.action === 'STOP' ? '0 rpm' : 'unchanged'}</td>
                      {[0, 1, 2].map((i) => <td key={i} className="tq-num">{fmt(at(p, signal, i), SIG[signal][2])}{band(p, signal, i) ? <span className="tq-muted"> [{fmt(band(p, signal, i)[0], SIG[signal][2])}–{fmt(band(p, signal, i)[1], SIG[signal][2])}]</span> : ''}</td>)}
                      <td className="tq-num">{pct(p.risk, 0)}</td><td><StatusPill status={p.status} /></td></tr>))}
                </tbody></table></div>)}
            <p className="tq-chart-note">Intervals are {res?.candidates?.[0]?.interval_method ? title(res.candidates[0].interval_method) : 'conformal'} 90 % intervals for a single future simulated measurement. They are not a probability that an action succeeds, and the predictor's interval widths are calibrated per action, not per target speed. Risk limits: housing {res?.risk_limits?.housing ?? '—'} °C, vibration {res?.risk_limits?.vib_rms ?? '—'} g, current {res?.risk_limits?.current ?? '—'} A.</p>
            {stop && <div className="tq-row"><button type="button" className="tq-btn" disabled={isStale || pending} onClick={() => select('STOP', stop)}>Select STOP (coast) for review</button></div>}
            <ErrorBox error={err} />
          </Card>)}

      <CounterfactualLab targets={valid} role={role} stale={stale} hasRanking={!!post} hasSim={hasSim} />

      {sel && (
        <div className="tq-callout info tq-mt" role="status" data-testid="selection">
          <strong>{sel.action === 'STOP' ? 'Selected: STOP (coast)' : `Selected: Action ${sel.label} — target ${fmtRpm(sel.target_rpm)} rpm`}</strong>
          <p>Candidate {sel.candidate_id}, predicted at t = {fmt(sel.basis.t, 0)} s. Selecting is a proposal for review: nothing has been sent. The decision gate and the Safety Supervisor decide on Interventions.</p>
          <button type="button" className="tq-btn tq-primary" onClick={() => go('interventions')}>Review on Interventions <ArrowRight size={14} aria-hidden="true" /></button>
        </div>)}

      <div className="tq-mt"><InvestigationTrace d={d} focus={['prediction']} /></div>
      <h3 className="tq-section-head tq-mt">The pipeline's own comparison</h3>
      <PredictionsPage d={d} go={go} head={false} />
    </>
  );
}
