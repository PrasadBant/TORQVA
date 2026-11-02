// Lab (simulation mode): reproducible recording sessions on the software simulator (create -> checklist -> run -> reveal -> reproduce) and
// matched-condition intervention experiments. Every action is an existing /lab route; the page shows only what those records say.
import React, { useCallback, useEffect, useState } from 'react';
import { Beaker, ClipboardList, FlaskConical, ListChecks, Repeat } from 'lucide-react';
import { Card, Empty, ErrorBox, Pill, ProvBadge, PosteriorBars, fmt, canControl, Disclosure, StepTracker, StatGrid, StatTile, DataTable } from '../shared/components.jsx';
import { api } from '../api.js';

const FAULTS = ['imbalance', 'looseness', 'overload', 'cooling_failure', 'supply_voltage', 'sensor_fault'];
const PURPOSES = ['commissioning', 'fault_run', 'experiment', 'evaluation'];
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
    notes: '', profile: [{ rpm: 1500, hold_s: 90 }],
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
    const s = await api.labCreate({
      purpose: form.purpose, notes: form.notes, blind: form.blind, regime: form.regime, seed: Number(form.seed),
      profile: form.profile.map((p) => ({ rpm: Number(p.rpm), hold_s: Number(p.hold_s) })),
      fault: form.fault === 'none' ? null : form.fault, severity: Number(form.severity), inject_at_s: Number(form.inject_at_s),
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

  // Progress of the selected session, read from its record (and the reproduce reply this page received); nothing is marked done otherwise.
  const done = selected?.status === 'completed';
  const steps = selected ? [
    { key: 'created', label: 'Session recorded', state: 'done', sub: selected.id },
    { key: 'checklist', label: 'Checklist', state: selected.checklist.complete ? 'done' : 'active', sub: selected.checklist.complete ? 'all items confirmed' : 'confirm each item' },
    { key: 'run', label: 'Run', state: done ? 'done' : selected.checklist.complete ? 'waiting' : 'pending', sub: done ? 'completed' : selected.checklist.complete ? 'ready to run' : 'needs the checklist' },
    selected.blind
      ? { key: 'reveal', label: 'Reveal fault', state: selected.revealed ? 'done' : done ? 'waiting' : 'pending', sub: selected.revealed ? 'revealed' : done ? 'ready to reveal' : 'after the run' }
      : { key: 'reveal', label: 'Reveal fault', state: 'skipped', sub: 'not a blind session' },
    { key: 'repro', label: 'Reproduce', state: repro ? (repro.identical ? 'done' : 'failed') : done ? 'waiting' : 'pending', sub: repro ? (repro.identical ? 'identical' : 'NOT identical') : done ? 'optional check' : 'after the run' },
  ] : [];
  const completed = sessions.filter((x) => x.status === 'completed').length;
  const toReveal = sessions.filter((x) => x.blind && !x.revealed && x.status === 'completed').length;

  return (
    <div className="tq-lab" data-testid="lab-page">
      {isPhys && (
        <p className="tq-callout warn" role="note" data-testid="lab-sim-note">
          <strong>SIMULATION ONLY</strong> — Lab synthetic experiments operate on matched software simulation models.
        </p>
      )}
      <p className="tq-scn-simnote" role="note"><FlaskConical size={15} aria-hidden="true" /><span><strong>SIMULATED.</strong> Sessions and experiments run on the backend&apos;s software simulator. Nothing here reaches hardware.</span></p>
      <StatGrid label="Lab summary">
        <StatTile icon={ClipboardList} tone="info" label="Recording sessions" value={sessions.length} sub={`${completed} completed`} testid="lab-stat-sessions" />
        <StatTile icon={Beaker} tone={toReveal ? 'warn' : 'info'} label="Blind sessions to reveal" value={toReveal} sub="completed, injected fault still hidden" />
        <StatTile icon={Repeat} tone="info" label="Matched experiments" value={experiments.length} sub="same seed, every action compared" />
      </StatGrid>
      <div className="tq-lab-top">
        <Card title="New recording session" id="c-lab-new" icon={ListChecks} right={<ProvBadge kind="SIMULATED" />} sub="A reproducible simulated run">
          {!ctl && <Empty>Your role ({role}) can view the Lab but not create sessions.</Empty>}
          <form className="tq-form tq-lab-form" onSubmit={(e) => { e.preventDefault(); create(); }} aria-label="New session">
            <div className="tq-lab-grid">
              <label>Purpose
                <select value={form.purpose} onChange={(e) => setForm({ ...form, purpose: e.target.value })} disabled={!ctl}>
                  {PURPOSES.map((p) => <option key={p} value={p}>{p.replace('_', ' ')}</option>)}</select></label>
              <label>Simulation regime
                <select value={form.regime} onChange={(e) => setForm({ ...form, regime: e.target.value })} disabled={!ctl}>
                  {regimes.map((r) => <option key={r.name} value={r.name}>{r.name}</option>)}</select></label>
            </div>
            {regime && <p className="tq-muted tq-lab-hint" data-testid="regime-desc">{regime.description}</p>}
            <div className="tq-lab-grid">
              <label>Injected fault (ground truth)
                <select value={form.fault} onChange={(e) => setForm({ ...form, fault: e.target.value })} disabled={!ctl}>
                  <option value="none">none (healthy run)</option>{FAULTS.map((f) => <option key={f} value={f}>{f.replace('_', ' ')}</option>)}</select></label>
              <label>Severity ({Number(form.severity).toFixed(2)})
                <input type="range" min="0.05" max="1" step="0.05" value={form.severity} onChange={(e) => setForm({ ...form, severity: e.target.value })} disabled={!ctl || form.fault === 'none'} /></label>
              <label>Injected at (s)<input type="number" min="0" value={form.inject_at_s} onChange={(e) => setForm({ ...form, inject_at_s: e.target.value })} disabled={!ctl || form.fault === 'none'} /></label>
              <label>Seed (reproducibility)<input type="number" value={form.seed} onChange={(e) => setForm({ ...form, seed: e.target.value })} disabled={!ctl} /></label>
            </div>
            <fieldset className="tq-fieldset"><legend>Speed profile</legend>
              {form.profile.map((p, i) => (
                <div className="tq-row tq-lab-step" key={i}>
                  <span className="tq-scn-num" aria-hidden="true">{i + 1}</span>
                  <label className="tq-inline">rpm<input type="number" aria-label={`step ${i + 1} rpm`} value={p.rpm} onChange={(e) => patchProfile(i, 'rpm', e.target.value)} disabled={!ctl} /></label>
                  <label className="tq-inline">hold s<input type="number" aria-label={`step ${i + 1} hold seconds`} value={p.hold_s} onChange={(e) => patchProfile(i, 'hold_s', e.target.value)} disabled={!ctl} /></label>
                  <button type="button" className="tq-btn tq-ghost" onClick={() => setForm({ ...form, profile: form.profile.filter((_, j) => j !== i) })} disabled={!ctl || form.profile.length < 2}>Remove</button>
                </div>))}
              <div><button type="button" className="tq-btn tq-btn-sm" onClick={() => setForm({ ...form, profile: [...form.profile, { rpm: 1200, hold_s: 60 }] })} disabled={!ctl}>Add step</button></div>
            </fieldset>
            <label className="tq-check"><input type="checkbox" checked={form.blind} onChange={(e) => setForm({ ...form, blind: e.target.checked })} disabled={!ctl} />
              Blind session (hide the injected fault until the model output is frozen and you reveal it)</label>
            <Disclosure summary="Notes (optional)" meta="stored with the session; not a simulation control" testid="lab-optional">
              <label>Notes<input type="text" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} disabled={!ctl} /></label>
            </Disclosure>
            <div><button type="submit" className="tq-btn tq-primary" disabled={!ctl || a.busy}>Create session</button></div>
          </form>
          <ErrorBox error={a.error} />
        </Card>

        <Card title="Sessions" id="c-lab-list" icon={ClipboardList} sub="Open a session to run, reveal or reproduce it">
          <DataTable rows={sessions} rowKey={(x) => x.id} caption="Recording sessions" empty="No sessions yet. Create one to record a reproducible simulated run."
            rowClass={(x) => (x.id === sel ? 'tq-selected' : '')} testid="lab-sessions"
            columns={[
              { key: 'id', label: 'ID', render: (x) => <button type="button" className="tq-link" onClick={() => { setSel(x.id); setRepro(null); }} aria-label={`Open session ${x.id}`}>{x.id}</button> },
              { key: 'purpose', label: 'Purpose', render: (x) => String(x.purpose || '').replace('_', ' ') },
              { key: 'regime', label: 'Regime', render: (x) => x.config.regime },
              { key: 'fault', label: 'Fault', render: (x) => (HIDDEN(x.config.fault) ? <Pill tone="info">hidden (blind)</Pill> : (x.config.fault ? x.config.fault.fault.replace('_', ' ') : 'none')) },
              { key: 'status', label: 'Status', render: (x) => <Pill tone={x.status === 'completed' ? 'ok' : 'wait'}>{x.status}</Pill> },
            ]} />
        </Card>
      </div>

      {selected && (
        <Card title={`Session ${selected.id}`} id="c-lab-detail" icon={Beaker} right={<ProvBadge kind="SIMULATED" />}
          sub={<>Operator {selected.operator} · seed {selected.config.seed} · config hash <span className="tq-num">{selected.config_hash}</span>{selected.blind && <> · <Pill tone="info">blind{selected.revealed ? ' (revealed)' : ''}</Pill></>}</>}>
          <StepTracker steps={steps} label={`Session ${selected.id} progress`} testid="lab-steps" />
          {!HIDDEN(selected.fault_settings) && Object.keys(selected.fault_settings || {}).length > 0 && (
            <p className="tq-muted tq-small">Injection record: <code>{JSON.stringify(selected.fault_settings)}</code></p>)}
          {selected.notes && <p className="tq-muted" data-testid="lab-notes">Notes (recorded metadata): {selected.notes}</p>}
          <div className="tq-lab-detail">
            <section aria-labelledby="lab-check-h">
              <h4 id="lab-check-h">Pre-run checklist <span className="tq-muted">(a logged procedure, not a safety mechanism)</span></h4>
              <ul className="tq-lab-checks" aria-label="Pre-run checklist">
                {checklist?.items.map((it) => {
                  const on = optimistic[it.key] ?? !!selected.checklist.items[it.key];
                  return (
                    <li key={it.key} className={on ? 'is-on' : ''}><label className="tq-check">
                      <input type="checkbox" checked={on} disabled={!ctl || done} onChange={(e) => confirmItem(it.key, e.target.checked)} />{it.text}</label></li>);
                })}
              </ul>
              <div className="tq-row tq-lab-actions">
                <button type="button" className="tq-btn tq-primary" onClick={run} disabled={!ctl || !selected.checklist.complete || done || a.busy}>Run session</button>
                <button type="button" className="tq-btn" onClick={reveal} disabled={!ctl || !selected.blind || selected.revealed || !done || a.busy}>Reveal injected fault</button>
                <button type="button" className="tq-btn" onClick={reproduce} disabled={!ctl || !done || a.busy}>Reproduce</button>
              </div>
              {!selected.checklist.complete && <p className="tq-muted tq-small">Confirm every item to enable the run.</p>}
              {repro && <p role="status" className="tq-lab-repro"><Pill tone={repro.identical ? 'ok' : 'crit'}>{repro.identical ? 'reproduced identically' : 'NOT identical'}</Pill>
                <span className="tq-num"> {repro.original_hash} / {repro.rerun_hash}</span></p>}
            </section>
            <section aria-labelledby="lab-res-h">
              <h4 id="lab-res-h">Result</h4>
              {!selected.result ? <Empty>No result yet. It appears when the session has run.</Empty> : (
                <>
                  <p className="tq-small">Windows <span className="tq-num">{selected.result.n_windows}</span> · hash <span className="tq-num">{selected.result.window_hash}</span> ·
                    first flag after injection: <strong>{selected.result.first_flag_after_injection_s == null ? 'none' : `${selected.result.first_flag_after_injection_s} s`}</strong></p>
                  <div className="tq-table-wrap"><table className="tq-table"><caption className="tq-sr">Per-step summary</caption>
                    <thead><tr><th scope="col">rpm</th><th scope="col">hold s</th><th scope="col">flagged</th><th scope="col">score ÷ thr</th></tr></thead>
                    <tbody>{selected.result.steps.map((x, i) => (<tr key={i}><td className="tq-num">{x.rpm}</td><td className="tq-num">{x.hold_s}</td>
                      <td className="tq-num">{x.flagged_fraction == null ? '—' : `${fmt(x.flagged_fraction * 100, 0)}%`}</td>
                      <td className="tq-num">{fmt(x.mean_score_over_threshold, 2)}</td></tr>))}</tbody></table></div>
                  <h4>Model output (frozen before any reveal)</h4>
                  {selected.result.model_output_frozen.abstained
                    ? <p><Pill tone="info">abstained</Pill> {selected.result.model_output_frozen.reason}</p>
                    : <PosteriorBars ranked={selected.result.model_output_frozen.ranked} label={selected.result.model_output_frozen.label} />}
                  {selected.result.truth_match && (
                    <p role="status">Truth: <strong>{selected.result.truth_match.truth || 'none'}</strong> · model: <strong>{selected.result.truth_match.model || 'abstained'}</strong>{' '}
                      <Pill tone={selected.result.truth_match.correct ? 'ok' : selected.result.truth_match.abstained ? 'info' : 'crit'}>
                        {selected.result.truth_match.correct ? 'match' : selected.result.truth_match.abstained ? 'abstained' : 'mismatch'}</Pill></p>)}
                </>)}
            </section>
          </div>
        </Card>)}

      <Card title="Intervention experiments (matched conditions)" id="c-lab-exp" icon={Repeat} right={<ProvBadge kind="SIMULATED" />}
        sub="Every action from identical starting conditions">
        <p className="tq-muted tq-small">This is a simulation experiment: it does <strong>not</strong> validate the predictions on hardware.</p>
        <form className="tq-form" onSubmit={(e) => { e.preventDefault(); runExperiment(); }} aria-label="New experiment">
          <div className="tq-row tq-lab-exp-row">
            <label className="tq-inline">Fault<select value={xf.fault} onChange={(e) => setXf({ ...xf, fault: e.target.value })} disabled={!ctl}>{FAULTS.map((f) => <option key={f}>{f}</option>)}</select></label>
            <label className="tq-inline">Regime<select value={xf.regime} onChange={(e) => setXf({ ...xf, regime: e.target.value })} disabled={!ctl}>{regimes.map((r) => <option key={r.name}>{r.name}</option>)}</select></label>
            <label className="tq-inline">Repeats<input type="number" min="1" max="10" value={xf.repeats} onChange={(e) => setXf({ ...xf, repeats: e.target.value })} disabled={!ctl} /></label>
            <button type="submit" className="tq-btn" disabled={!ctl || ex.busy}>{ex.busy ? 'Running…' : 'Run experiment'}</button>
          </div>
        </form>
        <ErrorBox error={ex.error} />
        {!experiments.length ? <Empty>No experiments yet.</Empty> : experiments.slice().reverse().slice(0, 3).map((x) => (
          <article key={x.id} className="tq-outcome tq-lab-exp">
            <h4>{x.id} · {x.fault} @ {x.severity} · {x.regime} <ProvBadge kind="SIMULATED" /></h4>
            <p className="tq-small">Starting conditions matched: <Pill tone={x.matched_starting_conditions ? 'ok' : 'crit'}>{x.matched_starting_conditions ? 'yes' : 'NO'}</Pill> ·
              ranking matched measured best: <strong>{x.ranking_agreement}</strong> ({x.ranking_ties} tied on limits) · risk Brier <span className="tq-num">{fmt(x.risk_brier_score, 3)}</span></p>
            <div className="tq-table-wrap"><table className="tq-table"><thead><tr><th scope="col">Action / signal</th><th scope="col">MAE (model)</th><th scope="col">MAE (persistence)</th><th scope="col">90% interval coverage</th></tr></thead>
              <tbody>{Object.entries(x.per_action_signal).filter(([k]) => /\/(housing|vib_rms)$/.test(k)).map(([k, v]) => (
                <tr key={k}><td>{k.replace('_', ' ')}</td><td className="tq-num">{fmt(v.mae, 3)}</td><td className="tq-num">{fmt(v.persistence_mae, 3)}</td>
                  <td className="tq-num">{fmt(v.interval_coverage * 100, 0)}%</td></tr>))}</tbody></table></div>
          </article>))}
      </Card>
    </div>
  );
}
