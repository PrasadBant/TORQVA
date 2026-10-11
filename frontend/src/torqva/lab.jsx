import React, { useCallback, useEffect, useState } from 'react';
import { Card, Empty, ErrorBox, Pill, ProvBadge, PosteriorBars, fmt } from './components.jsx';
import { api } from './api.js';

const FAULTS = ['imbalance', 'looseness', 'overload', 'cooling_failure', 'supply_voltage', 'sensor_fault'];
const PURPOSES = ['commissioning', 'fault_run', 'experiment', 'evaluation'];
const canControl = (role) => role === 'operator' || role === 'admin';
const HIDDEN = (v) => typeof v === 'string' && v.startsWith('HIDDEN');

function useAsync() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const run = useCallback(async (fn) => {
    setBusy(true); setError(null);
    try { return await fn(); } catch (e) { setError(e); return undefined; } finally { setBusy(false); }
  }, []);
  return { busy, error, run };
}

export default function Lab({ role, isPhys = false }) {
  const [regimes, setRegimes] = useState([]);
  const [checklist, setChecklist] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [experiments, setExperiments] = useState([]);
  const [sel, setSel] = useState(null);
  const [repro, setRepro] = useState(null);
  const [optimistic, setOptimistic] = useState({});   // checklist ticks shown immediately, reconciled with the server reply
  const a = useAsync();
  const ex = useAsync();
  const [form, setForm] = useState({
    purpose: 'fault_run', regime: 'baseline', fault: 'imbalance', severity: 0.6, inject_at_s: 30, seed: 1, blind: false,
    notes: '', mass_g: '', radius_mm: '', profile: [{ rpm: 1500, hold_s: 90 }],
  });
  const [xf, setXf] = useState({ fault: 'imbalance', severity: 0.6, speed_rpm: 1800, regime: 'baseline', repeats: 3 });
  const ctl = canControl(role);

  const load = useCallback(async () => {
    const [rg, cl, ss, xs] = await Promise.all([api.labRegimes(), api.labChecklist(), api.labSessions(), api.labExperiments()]);
    setRegimes(rg); setChecklist(cl); setSessions(ss); setExperiments(xs);
  }, []);
  useEffect(() => { a.run(load); }, [load]); // eslint-disable-line react-hooks/exhaustive-deps

  const regime = regimes.find((r) => r.name === form.regime);
  const selected = sessions.find((s) => s.id === sel);

  const create = () => a.run(async () => {
    const settings = {};
    if (form.mass_g !== '') settings.mass_g = Number(form.mass_g);
    if (form.radius_mm !== '') settings.radius_mm = Number(form.radius_mm);
    const s = await api.labCreate({
      purpose: form.purpose, notes: form.notes, blind: form.blind, regime: form.regime, seed: Number(form.seed),
      profile: form.profile.map((p) => ({ rpm: Number(p.rpm), hold_s: Number(p.hold_s) })),
      fault: form.fault === 'none' ? null : form.fault, severity: Number(form.severity), inject_at_s: Number(form.inject_at_s), settings,
    });
    await load(); setSel(s.id); setRepro(null);
  });
  const patchProfile = (i, k, v) => setForm({ ...form, profile: form.profile.map((p, j) => (j === i ? { ...p, [k]: v } : p)) });

  const confirmItem = (key, val) => {
    setOptimistic((o) => ({ ...o, [key]: val }));
    return a.run(async () => { await api.labChecklistConfirm(selected.id, { [key]: val }); await load(); }).finally(() => setOptimistic((o) => { const n = { ...o }; delete n[key]; return n; }));
  };
  const run = () => a.run(async () => { await api.labRun(selected.id); await load(); });
  const reveal = () => a.run(async () => { await api.labReveal(selected.id); await load(); });
  const reproduce = () => a.run(async () => setRepro(await api.labReproduce(selected.id)));
  const runExperiment = () => ex.run(async () => { await api.labExperiment({ ...xf, severity: Number(xf.severity), speed_rpm: Number(xf.speed_rpm), repeats: Number(xf.repeats) }); await load(); });

  return (
    <div className="tq-grid">
      {isPhys && (
        <p className="tq-callout warn" role="note" data-testid="lab-sim-note">
          <strong>SIMULATION ONLY</strong> — Lab synthetic experiments operate on matched software simulation models.
        </p>
      )}
      <Card title="New recording session" id="c-lab-new" right={<ProvBadge kind="SIMULATED" />}>
        {!ctl && <Empty>Your role ({role}) can view the Lab but not create sessions.</Empty>}
        <form className="tq-form" onSubmit={(e) => { e.preventDefault(); create(); }} aria-label="New session">
          <label>Purpose
            <select value={form.purpose} onChange={(e) => setForm({ ...form, purpose: e.target.value })} disabled={!ctl}>
              {PURPOSES.map((p) => <option key={p}>{p}</option>)}</select></label>
          <label>Simulation regime
            <select value={form.regime} onChange={(e) => setForm({ ...form, regime: e.target.value })} disabled={!ctl}>
              {regimes.map((r) => <option key={r.name} value={r.name}>{r.name}</option>)}</select></label>
          {regime && <p className="tq-muted" data-testid="regime-desc">{regime.description}</p>}
          <label>Injected fault (ground truth)
            <select value={form.fault} onChange={(e) => setForm({ ...form, fault: e.target.value })} disabled={!ctl}>
              <option value="none">none (healthy run)</option>{FAULTS.map((f) => <option key={f} value={f}>{f.replace('_', ' ')}</option>)}</select></label>
          <label>Severity ({form.severity})
            <input type="range" min="0.05" max="1" step="0.05" value={form.severity} onChange={(e) => setForm({ ...form, severity: e.target.value })} disabled={!ctl} /></label>
          <label>Injected at (s)<input type="number" min="0" value={form.inject_at_s} onChange={(e) => setForm({ ...form, inject_at_s: e.target.value })} disabled={!ctl} /></label>
          <fieldset className="tq-fieldset"><legend>Speed profile</legend>
            {form.profile.map((p, i) => (
              <div className="tq-row" key={i}>
                <label className="tq-inline">rpm<input type="number" aria-label={`step ${i + 1} rpm`} value={p.rpm} onChange={(e) => patchProfile(i, 'rpm', e.target.value)} disabled={!ctl} /></label>
                <label className="tq-inline">hold s<input type="number" aria-label={`step ${i + 1} hold seconds`} value={p.hold_s} onChange={(e) => patchProfile(i, 'hold_s', e.target.value)} disabled={!ctl} /></label>
                <button type="button" className="tq-btn tq-ghost" onClick={() => setForm({ ...form, profile: form.profile.filter((_, j) => j !== i) })} disabled={!ctl || form.profile.length < 2}>Remove</button>
              </div>))}
            <button type="button" className="tq-btn" onClick={() => setForm({ ...form, profile: [...form.profile, { rpm: 1200, hold_s: 60 }] })} disabled={!ctl}>Add step</button>
          </fieldset>
          <div className="tq-row">
            <label className="tq-inline">Mass g<input type="number" value={form.mass_g} onChange={(e) => setForm({ ...form, mass_g: e.target.value })} disabled={!ctl} /></label>
            <label className="tq-inline">Radius mm<input type="number" value={form.radius_mm} onChange={(e) => setForm({ ...form, radius_mm: e.target.value })} disabled={!ctl} /></label>
            <label className="tq-inline">Seed<input type="number" value={form.seed} onChange={(e) => setForm({ ...form, seed: e.target.value })} disabled={!ctl} /></label>
          </div>
          <label>Notes<input type="text" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} disabled={!ctl} /></label>
          <label className="tq-check"><input type="checkbox" checked={form.blind} onChange={(e) => setForm({ ...form, blind: e.target.checked })} disabled={!ctl} />
            Blind session (hide the injected fault until the model output is frozen and you reveal it)</label>
          <button type="submit" className="tq-btn" disabled={!ctl || a.busy}>Create session</button>
        </form>
        <ErrorBox error={a.error} />
      </Card>

      <Card title="Sessions" id="c-lab-list">
        {!sessions.length ? <Empty>No sessions yet. Create one to record a reproducible simulated run.</Empty> : (
          <table className="tq-table"><thead><tr><th scope="col">ID</th><th scope="col">Purpose</th><th scope="col">Regime</th><th scope="col">Fault</th><th scope="col">Status</th></tr></thead>
            <tbody>{sessions.map((s) => (
              <tr key={s.id} className={s.id === sel ? 'tq-selected' : ''}>
                <td><button className="tq-link" onClick={() => { setSel(s.id); setRepro(null); }} aria-label={`Open session ${s.id}`}>{s.id}</button></td>
                <td>{s.purpose}</td><td>{s.config.regime}</td>
                <td>{HIDDEN(s.config.fault) ? <Pill tone="info">hidden (blind)</Pill> : (s.config.fault ? s.config.fault.fault.replace('_', ' ') : 'none')}</td>
                <td>{s.status}</td></tr>))}</tbody></table>)}
      </Card>

      {selected && (
        <Card title={`Session ${selected.id}`} id="c-lab-detail" right={<ProvBadge kind="SIMULATED" />}>
          <p className="tq-muted">Operator {selected.operator} · seed {selected.config.seed} · config hash <span className="tq-num">{selected.config_hash}</span>
            {selected.blind && <> · <Pill tone="info">blind{selected.revealed ? ' (revealed)' : ''}</Pill></>}</p>
          {!HIDDEN(selected.fault_settings) && Object.keys(selected.fault_settings || {}).length > 0 && (
            <p className="tq-muted">Injection record: {JSON.stringify(selected.fault_settings)}</p>)}
          <h4>Pre-run checklist <span className="tq-muted">(a logged procedure, not a safety mechanism)</span></h4>
          <ul className="tq-list" aria-label="Pre-run checklist">
            {checklist?.items.map((it) => (
              <li key={it.key}><label className="tq-check">
                <input type="checkbox" checked={optimistic[it.key] ?? !!selected.checklist.items[it.key]} disabled={!ctl || selected.status === 'completed'}
                  onChange={(e) => confirmItem(it.key, e.target.checked)} />{it.text}</label></li>))}
          </ul>
          <div className="tq-row">
            <button className="tq-btn" onClick={run} disabled={!ctl || !selected.checklist.complete || selected.status === 'completed' || a.busy}>Run session</button>
            <button className="tq-btn" onClick={reproduce} disabled={!ctl || selected.status !== 'completed' || a.busy}>Reproduce</button>
            <button className="tq-btn" onClick={reveal} disabled={!ctl || !selected.blind || selected.revealed || selected.status !== 'completed' || a.busy}>Reveal injected fault</button>
          </div>
          {!selected.checklist.complete && <p className="tq-muted">Confirm every item to enable the run.</p>}
          {repro && <p role="status"><Pill tone={repro.identical ? 'ok' : 'crit'}>{repro.identical ? 'reproduced identically' : 'NOT identical'}</Pill>
            <span className="tq-num"> {repro.original_hash} / {repro.rerun_hash}</span></p>}
          {selected.result && (
            <>
              <h4>Result</h4>
              <p>Windows <span className="tq-num">{selected.result.n_windows}</span> · hash <span className="tq-num">{selected.result.window_hash}</span> ·
                first flag after injection: <strong>{selected.result.first_flag_after_injection_s == null ? 'none' : `${selected.result.first_flag_after_injection_s} s`}</strong></p>
              <table className="tq-table"><caption className="tq-sr">Per-step summary</caption>
                <thead><tr><th scope="col">rpm</th><th scope="col">hold s</th><th scope="col">flagged</th><th scope="col">score ÷ thr</th></tr></thead>
                <tbody>{selected.result.steps.map((s, i) => (<tr key={i}><td className="tq-num">{s.rpm}</td><td className="tq-num">{s.hold_s}</td>
                  <td className="tq-num">{s.flagged_fraction == null ? '—' : `${fmt(s.flagged_fraction * 100, 0)}%`}</td>
                  <td className="tq-num">{fmt(s.mean_score_over_threshold, 2)}</td></tr>))}</tbody></table>
              <h4>Model output (frozen before any reveal)</h4>
              {selected.result.model_output_frozen.abstained
                ? <p><Pill tone="info">abstained</Pill> {selected.result.model_output_frozen.reason}</p>
                : <PosteriorBars ranked={selected.result.model_output_frozen.ranked} label={selected.result.model_output_frozen.label} />}
              {selected.result.truth_match && (
                <p role="status">Truth: <strong>{selected.result.truth_match.truth || 'none'}</strong> · model: <strong>{selected.result.truth_match.model || 'abstained'}</strong>{' '}
                  <Pill tone={selected.result.truth_match.correct ? 'ok' : selected.result.truth_match.abstained ? 'info' : 'crit'}>
                    {selected.result.truth_match.correct ? 'match' : selected.result.truth_match.abstained ? 'abstained' : 'mismatch'}</Pill></p>)}
            </>)}
        </Card>)}

      <Card title="Intervention experiments (matched conditions)" id="c-lab-exp" right={<ProvBadge kind="SIMULATED" />}>
        <p className="tq-muted">Every action runs from identical starting conditions (same seed), so measured outcomes exist for chosen and non-chosen actions.
          This is a simulation experiment: it does <strong>not</strong> validate the C2 predictions on hardware.</p>
        <form className="tq-form" onSubmit={(e) => { e.preventDefault(); runExperiment(); }} aria-label="New experiment">
          <div className="tq-row">
            <label className="tq-inline">Fault<select value={xf.fault} onChange={(e) => setXf({ ...xf, fault: e.target.value })} disabled={!ctl}>{FAULTS.map((f) => <option key={f}>{f}</option>)}</select></label>
            <label className="tq-inline">Regime<select value={xf.regime} onChange={(e) => setXf({ ...xf, regime: e.target.value })} disabled={!ctl}>{regimes.map((r) => <option key={r.name}>{r.name}</option>)}</select></label>
            <label className="tq-inline">Repeats<input type="number" min="1" max="10" value={xf.repeats} onChange={(e) => setXf({ ...xf, repeats: e.target.value })} disabled={!ctl} /></label>
          </div>
          <button type="submit" className="tq-btn" disabled={!ctl || ex.busy}>{ex.busy ? 'Running…' : 'Run experiment'}</button>
        </form>
        <ErrorBox error={ex.error} />
        {!experiments.length ? <Empty>No experiments yet.</Empty> : experiments.slice().reverse().slice(0, 3).map((x) => (
          <article key={x.id} className="tq-outcome">
            <h4>{x.id} · {x.fault} @ {x.severity} · {x.regime} <ProvBadge kind="SIMULATED" /></h4>
            <p>Starting conditions matched: <Pill tone={x.matched_starting_conditions ? 'ok' : 'crit'}>{x.matched_starting_conditions ? 'yes' : 'NO'}</Pill> ·
              ranking matched measured best: <strong>{x.ranking_agreement}</strong> ({x.ranking_ties} tied on limits) · risk Brier <span className="tq-num">{fmt(x.risk_brier_score, 3)}</span></p>
            <table className="tq-table"><thead><tr><th scope="col">Action / signal</th><th scope="col">MAE (model)</th><th scope="col">MAE (persistence)</th><th scope="col">90% interval coverage</th></tr></thead>
              <tbody>{Object.entries(x.per_action_signal).filter(([k]) => /\/(housing|vib_rms)$/.test(k)).map(([k, v]) => (
                <tr key={k}><td>{k.replace('_', ' ')}</td><td className="tq-num">{fmt(v.mae, 3)}</td><td className="tq-num">{fmt(v.persistence_mae, 3)}</td>
                  <td className="tq-num">{fmt(v.interval_coverage * 100, 0)}%</td></tr>))}</tbody></table>
          </article>))}
      </Card>
    </div>
  );
}
