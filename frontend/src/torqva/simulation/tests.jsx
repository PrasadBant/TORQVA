// Diagnostic Tests (C4), simulation mode: build an ordered sequence of supported tests (a multi-step speed profile, T1, T3, T4), review it,
// run it on a copy of the live simulated motor, and read the per-step observations and the updated hypothesis ranking. The backend validates
// every step again and executes it (POST /simulation/workbench/sequence); this page computes nothing it then presents as a measurement.
import React, { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2, ArrowUp, ArrowDown, Play, Gauge, Info } from 'lucide-react';
import { api } from '../api.js';
import { Card, Empty, ErrorBox, Pill, ProvBadge, fmt, PageHead } from '../shared/components.jsx';
import { TrendLines } from '../shared/lazyCharts.jsx';
import { TEST_SPECS, TEST_OUTCOMES, ASSESSMENT } from '../shared/diagnostics.js';
import { TestsPage } from './pages.jsx';
import { canControl } from './scenario.jsx';
import { usePlan, title, pct, fmtRpm } from './workbench.js';

// Fixed simulated durations of the backend tests (workbench.validate_sequence / diagnostics.run_test_on_sim).
const FIXED_S = { T1: 60, T3: 300, T4: 50 };
const PROFILE_SPEC = {
  code: 'P', name: 'Multi-step speed profile', short: 'Your RPM steps',
  target: 'Shows how speed tracking, current, temperature, vibration and the C1 score respond at each speed you choose.',
  method: 'Each step sets the simulated setpoint and holds it for the dwell you set. Step pairs report the same speed-scaling exponents T1 uses; the learned T1 signature is applied only to a pair that matches the conditions it was learned at.',
};
const HOLD = [5, 900];

function holdOk(h) { return h !== '' && Number.isFinite(Number(h)) && Number(h) >= HOLD[0] && Number(h) <= HOLD[1]; }

/** One speed profile: ordered RPM steps with a dwell each, quick-select speeds and presets derived from the live setpoint. */
export function ProfileEditor({ steps, onChange, limits, quick, disabled }) {
  const max = limits?.max_rpm ?? 0;
  const set = (i, k, v) => onChange(steps.map((s, j) => (j === i ? { ...s, [k]: v } : s)));
  const move = (i, d) => { const n = [...steps]; const [x] = n.splice(i, 1); n.splice(i + d, 0, x); onChange(n); };
  const presets = quick?.length ? [
    ['Step down', [...quick].sort((a, b) => b - a)],
    ['Step up', [...quick].sort((a, b) => a - b)],
    ['Setpoint → 70 %', quick.filter((v, i, a) => i === 0 || Math.abs(v - a[0] * 0.7) < 6).slice(0, 2)],
  ].filter(([, v]) => v.length > 1) : [];
  return (
    <div className="tq-prof" data-testid="profile-editor">
      {presets.length > 0 && (
        <div className="tq-row tq-wrap-pills"><span className="tq-muted tq-small">Presets from the current setpoint:</span>
          {presets.map(([n, v]) => <button key={n} type="button" className="tq-btn tq-ghost" disabled={disabled} onClick={() => onChange(v.map((rpm) => ({ rpm: String(rpm), hold_s: '60' })))}>{n}</button>)}
        </div>)}
      <ol className="tq-prof-steps">
        {steps.map((s, i) => {
          const bad = !(Number(s.rpm) > 0 && Number(s.rpm) <= max);
          return (
            <li key={i} className="tq-prof-step">
              <span className="tq-prof-n tq-num">{i + 1}</span>
              <label>Target rpm<input type="number" min="1" max={max} step="any" value={s.rpm} onChange={(e) => set(i, 'rpm', e.target.value)} disabled={disabled} aria-invalid={bad} /></label>
              <label>Dwell (s)<input type="number" min={HOLD[0]} max={HOLD[1]} step="any" value={s.hold_s} onChange={(e) => set(i, 'hold_s', e.target.value)} disabled={disabled} aria-invalid={!holdOk(s.hold_s)} /></label>
              <div className="tq-prof-quick" role="group" aria-label={`Quick speeds for step ${i + 1}`}>
                {(quick || []).map((q) => <button key={q} type="button" className="tq-qbtn" aria-pressed={Number(s.rpm) === q} onClick={() => set(i, 'rpm', String(q))} disabled={disabled}>{fmtRpm(q)}</button>)}
              </div>
              <div className="tq-prof-act">
                <button type="button" className="tq-iconbtn" aria-label={`Move step ${i + 1} up`} disabled={disabled || i === 0} onClick={() => move(i, -1)}><ArrowUp size={14} aria-hidden="true" /></button>
                <button type="button" className="tq-iconbtn" aria-label={`Move step ${i + 1} down`} disabled={disabled || i === steps.length - 1} onClick={() => move(i, 1)}><ArrowDown size={14} aria-hidden="true" /></button>
                <button type="button" className="tq-iconbtn" aria-label={`Remove step ${i + 1}`} disabled={disabled || steps.length === 1} onClick={() => onChange(steps.filter((_, j) => j !== i))}><Trash2 size={14} aria-hidden="true" /></button>
              </div>
            </li>);
        })}
      </ol>
      <button type="button" className="tq-btn" disabled={disabled || steps.length >= 50} onClick={() => onChange([...steps, { rpm: steps[steps.length - 1]?.rpm || String(quick?.[0] || ''), hold_s: '60' }])}><Plus size={14} aria-hidden="true" /> Add speed step</button>
      <p className="tq-muted tq-small">Allowed: 1–{fmtRpm(max)} rpm (simulator limit), dwell {HOLD[0]}–{HOLD[1]} s, profile ≤ {limits?.profile_max_s ?? 1800} s. Quick speeds are fractions of the current setpoint ({fmtRpm(limits?.setpoint_rpm)} rpm).</p>
    </div>
  );
}

export function validateSequence(seq, limits) {
  const errs = []; let total = 0;
  if (!seq.length) errs.push('add at least one test');
  seq.forEach((x, k) => {
    if (x.type === 'profile') {
      if (!x.steps.length) errs.push(`test ${k + 1}: the profile has no steps`);
      x.steps.forEach((s, i) => {
        if (!(Number(s.rpm) > 0 && Number(s.rpm) <= (limits?.max_rpm ?? 0))) errs.push(`test ${k + 1}, step ${i + 1}: rpm must be 1–${limits?.max_rpm ?? '—'}`);
        if (!holdOk(s.hold_s)) errs.push(`test ${k + 1}, step ${i + 1}: dwell must be ${HOLD[0]}–${HOLD[1]} s`);
        else total += Number(s.hold_s);
      });
      const p = x.steps.reduce((a, s) => a + (holdOk(s.hold_s) ? Number(s.hold_s) : 0), 0);
      if (p > (limits?.profile_max_s ?? 1800)) errs.push(`test ${k + 1}: the profile lasts ${p} s (limit ${limits?.profile_max_s ?? 1800} s)`);
    } else total += FIXED_S[x.type] || 0;
  });
  if (seq.length > (limits?.max_steps ?? 6)) errs.push(`at most ${limits?.max_steps ?? 6} tests per sequence`);
  if (total > (limits?.sequence_max_s ?? 2400)) errs.push(`the sequence lasts ${total} s (limit ${limits?.sequence_max_s ?? 2400} s)`);
  return { errs, total };
}

function PosteriorLine({ p, label }) {
  if (!p) return <span className="tq-muted">{label}: no ranking</span>;
  return <span>{label}: {p.ranked.slice(0, 3).map(([h, v]) => `${title(h)} ${pct(v, 0)}`).join(' · ')} <Pill tone={p.label === 'confident' ? 'ok' : 'warn'}>{p.label}</Pill></span>;
}

const SIGNALS = [
  ['speed', 'Speed', 'rpm', 0, [{ key: 'rpm', name: 'observed rpm', color: 'var(--tq-chart-ink)' }, { key: 'setpoint', name: 'target (setpoint)', color: 'var(--tq-chart-1)', dash: '4 3' }]],
  ['current', 'Current', 'A', 3, [{ key: 'current', name: 'current A', color: 'var(--tq-chart-4)' }]],
  ['voltage', 'Voltage', 'V', 2, [{ key: 'voltage', name: 'voltage V', color: 'var(--tq-chart-3)' }]],
  ['power', 'Power', 'W', 1, [{ key: 'power', name: 'power W (simulator)', color: 'var(--tq-chart-1)' }]],
  ['housing', 'Housing temperature', '°C', 2, [{ key: 'housing', name: 'housing °C', color: 'var(--tq-chart-2)' }]],
  ['vib', 'Vibration RMS (simulator model)', 'g', 4, [{ key: 'vib_rms', name: 'vibration g', color: 'var(--tq-chart-3)' }]],
  ['score', 'C1 score ÷ threshold', '', 2, [{ key: 'score', name: 'score ratio', color: 'var(--tq-crit)' }]],
];

export function SequenceResult({ run, onAddTest }) {
  const [sig, setSig] = useState('speed');
  const a = ASSESSMENT[run.assessment.category] || ['info', title(run.assessment.category)];
  const def = SIGNALS.find((x) => x[0] === sig) || SIGNALS[0];
  return (
    <Card title={`Result ${run.id}`} id="c-run" right={<><Pill tone={a[0]}>{a[1]}</Pill><ProvBadge kind="SIMULATED" /></>}>
      <div className={`tq-narrate tone-${a[0]}`} data-testid="run-assessment"><strong>{a[1]}</strong><span>{run.assessment.detail}. Tested setpoints: {run.assessment.tested_setpoints_rpm.map(fmtRpm).join(', ') || '—'} rpm.</span></div>
      <p className="tq-muted tq-small">Executed on {run.executed_on}. {run.assessment.baseline_note}. One run covers only the speeds and conditions tested; it does not show the whole motor is healthy.</p>
      <div className="tq-story-cols tq-story-cols-3">
        <section className="tq-story-col is-truth" aria-label="Scenario ground truth"><span className="tq-section-title">Scenario ground truth</span><strong>{run.scenario_truth ? title(run.scenario_truth) : 'no active fault'}</strong><span className="tq-muted tq-small">{run.scenario_note}</span></section>
        <section className="tq-story-col is-ai" aria-label="TORQVA ranking after the tests"><span className="tq-section-title">TORQVA ranking after the tests <ProvBadge kind="DERIVED" /></span>
          <strong>{run.posterior_final ? `${title(run.posterior_final.top)} ${pct(run.posterior_final.top_p, 0)}` : 'no ranking'}</strong>
          <span className="tq-muted tq-small">{run.posterior_final ? `${run.posterior_final.label}${run.posterior_final.ood ? ', unlike any learned signature' : ''}` : ''}. {run.fused.note}.</span></section>
        <section className="tq-story-col is-pred" aria-label="Recommended next test"><span className="tq-section-title">Next test</span>
          {run.recommended_next?.worth_running ? <><strong>{run.recommended_next.test}</strong><span className="tq-muted tq-small">expected to remove {fmt(run.recommended_next.expected_info_gain_nats, 2)} nats</span>
            {onAddTest && <button type="button" className="tq-btn tq-ghost" onClick={() => onAddTest(run.recommended_next.test)}><Plus size={14} aria-hidden="true" /> Add {run.recommended_next.test} to a new sequence</button>}</>
            : <><strong>none needed</strong><span className="tq-muted tq-small">{run.recommended_next ? `the best remaining test (${run.recommended_next.test}) would remove only ${fmt(run.recommended_next.expected_info_gain_nats, 2)} nats` : 'every learned test has run'}</span></>}
        </section>
      </div>

      <ol className="tq-runsteps">
        {run.results.map((r) => (
          <li key={r.index} className={`tq-runstep is-${r.status}`} data-testid={`run-step-${r.index}`}>
            <div className="tq-runstep-head"><strong>{r.index + 1}. {r.type === 'profile' ? PROFILE_SPEC.name : TEST_SPECS[r.type]?.name || r.type}</strong>
              <Pill tone={r.status === 'completed' ? 'ok' : r.status === 'skipped' ? 'off' : 'crit'}>{r.status}</Pill></div>
            {r.reason && <p className={r.status === 'skipped' ? 'tq-muted' : 'tq-callout warn'}>{r.reason}</p>}
            {r.status !== 'skipped' && <p className="tq-small"><PosteriorLine p={r.posterior_before} label="before" /> → <PosteriorLine p={r.posterior_after} label="after" /></p>}
            {r.observation && <p className="tq-small">Observation: {r.observation_meaning.map((m, i) => <span key={m}>{m} <strong className="tq-num">{fmt(r.observation[i], 3)}</strong>{i < r.observation.length - 1 ? ' · ' : ''}</span>)} <span className="tq-muted">({r.fixed_parameters}{r.signature_applied ? '; learned signature applied' : ''})</span></p>}
            {r.steps && (
              <div className="tq-table-wrap"><table className="tq-table" data-testid="profile-table"><caption className="tq-sr">Per-step observations</caption>
                <thead><tr><th scope="col">Step</th><th scope="col">Target rpm</th><th scope="col">Observed rpm (settled)</th><th scope="col">Tracking error</th><th scope="col">Current A</th><th scope="col">Voltage V</th><th scope="col">Power W</th><th scope="col">Housing °C</th><th scope="col">Vibration g</th><th scope="col">C1 flagged</th></tr></thead>
                <tbody>{r.steps.map((s) => (<tr key={s.step}><td className="tq-num">{s.step + 1}</td><td className="tq-num">{fmtRpm(s.target_rpm)}</td><td className="tq-num">{fmtRpm(s.mean_rpm_settled)}</td>
                  <td className="tq-num">{s.tracking_error_rpm === null ? '—' : Math.abs(s.tracking_error_rpm) < 0.5 ? '0' : `${s.tracking_error_rpm > 0 ? '+' : '−'}${fmt(Math.abs(s.tracking_error_rpm), 0)}`}</td><td className="tq-num">{fmt(s.mean_current, 3)}</td><td className="tq-num">{fmt(s.mean_voltage, 2)}</td>
                  <td className="tq-num">{fmt(s.mean_power, 1)}</td><td className="tq-num">{fmt(s.housing_start, 1)} → {fmt(s.housing_end, 1)}</td><td className="tq-num">{fmt(s.mean_vib_rms, 4)}</td>
                  <td className="tq-num">{s.flagged_fraction === null ? `not scored${s.unscored_statuses.length ? ` (${s.unscored_statuses.map(title).join(', ')})` : ''}` : pct(s.flagged_fraction, 0)}</td></tr>))}</tbody></table></div>)}
            {r.speed_scaling?.length > 0 && (
              <div className="tq-subpanel"><span className="tq-subpanel-title">Speed scaling between steps</span>
                <ul className="tq-list tq-small">{r.speed_scaling.map((p) => <li key={`${p.from_step}-${p.to_step}`}>Step {p.from_step + 1} → {p.to_step + 1} (ratio {fmt(p.speed_ratio, 2)}): 1x exponent <strong className="tq-num">{fmt(p.vib_1x_speed_exponent, 2)}</strong>, harmonics exponent <strong className="tq-num">{fmt(p.harmonics_speed_exponent, 2)}</strong>{p.t1_signature_applied ? <> · <Pill tone="info">T1 signature applied</Pill></> : ''}</li>)}</ul>
                <p className="tq-muted tq-small">{r.t1_signature_note}</p></div>)}
          </li>))}
      </ol>

      <div className="tq-toolbar tq-mt"><span className="tq-toolbar-label">Signal</span>
        <div className="tq-seg" role="group" aria-label="Signal to chart">{SIGNALS.map(([k, n]) => <button key={k} type="button" className="tq-btn" aria-pressed={sig === k} onClick={() => setSig(k)}>{n.split(' (')[0]}</button>)}</div></div>
      {run.series.length < 2 ? <Empty>No windows were recorded.</Empty> : (
        <div role="img" aria-label={`${def[1]} during the test sequence`} className="tq-chart"><TrendLines data={run.series} lines={def[4]} height={240} digits={def[3]} unit={def[2]} /></div>)}
      <p className="tq-chart-note">Every point is one simulated 1 s window recorded during the run (simulation time on the axis). Target speed is dashed; observed speed is solid.</p>
    </Card>
  );
}

export function SimTestsPage({ d, role, c2c4, wb, setWb, stale }) {
  const { plan, error: planErr, reload } = usePlan(d);
  const ctl = canControl(role);
  const s = d.status || {};
  const hasSim = s.t !== undefined && s.t !== null;
  const [seq, setSeq] = useState([]);
  const [stopConfident, setStopConfident] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const quick = plan?.quick_rpm || [];
  const limits = plan?.limits;
  const add = (type) => setSeq((q) => [...q, type === 'profile' ? { type, steps: (quick.length > 1 ? quick.slice(0, 3) : [s.device?.setpoint_rpm || '']).map((rpm) => ({ rpm: String(rpm), hold_s: '60' })) } : { type }]);
  useEffect(() => {                                          // "Configure in Diagnostic Tests" from C1 pre-adds the recommended test once
    if (wb?.prefill && plan) { add(wb.prefill); setWb((x) => ({ ...x, prefill: null })); }
  }, [wb?.prefill, plan]); // eslint-disable-line react-hooks/exhaustive-deps
  const { errs, total } = useMemo(() => validateSequence(seq, limits), [seq, limits]);
  const blockers = [!hasSim && 'no simulation is running', stale && 'the backend is not answering', s.device?.estop && 'the simulated device has latched an emergency stop',
    hasSim && (s.device?.setpoint_rpm ?? 0) <= 0 && 'the simulated motor is stopped', !ctl && `your role (${role}) cannot run tests`].filter(Boolean);
  const run = async () => {
    setBusy(true); setErr(null);
    try {
      const body = { steps: seq.map((x) => (x.type === 'profile' ? { type: 'profile', profile: x.steps.map((st) => ({ rpm: Number(st.rpm), hold_s: Number(st.hold_s) })) } : { type: x.type })), stop_when_confident: stopConfident };
      const r = await api.wbSequence(body);
      setWb((x) => ({ ...x, run: r })); reload();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  const testsInfo = Object.fromEntries((plan?.tests || []).map((t) => [t.test, t]));
  const cards = [['profile', PROFILE_SPEC], ...Object.entries(TEST_SPECS)];
  return (
    <>
      <PageHead title="Diagnostic Tests (C4)" sub="Build a sequence of supported tests, review it, run it on a copy of the simulated motor and see how it responded."
        right={<><ProvBadge kind="SIMULATED" />{plan?.recommended_test?.worth_running && <Pill tone="info">{`recommended: ${plan.recommended_test.test}`}</Pill>}</>} />
      <p className="tq-callout info" role="note"><Info size={14} aria-hidden="true" /> Tests run on a copy of the live simulated motor (same state and injected fault). The live run, its incident and its commands are not changed, and no device is involved.</p>
      {planErr && planErr !== 'unavailable' && hasSim && <p className="tq-callout warn">The workbench plan could not be loaded: {planErr}</p>}

      <Card title="Available tests" id="c-catalog" right={<ProvBadge kind="SIMULATED" />}>
        <div className="tq-catalog" data-testid="test-catalog">
          {cards.map(([k, x]) => {
            const info = testsInfo[k];
            return (
              <article key={k} className="tq-cat-card">
                <div className="tq-option-title"><strong>{x.name}</strong>{k === 'profile' ? <Pill tone="info">configurable</Pill> : <Pill tone="info">{`${FIXED_S[k]} s`}</Pill>}</div>
                <p className="tq-muted tq-small">{x.target}</p>
                <p className="tq-small"><span className="tq-muted">Parameters: </span>{k === 'profile' ? 'target rpm and dwell per step' : `fixed (the outcome signature was learned at these settings): ${info?.fixed_parameters || x.short}`}</p>
                {k !== 'profile' && <p className="tq-small"><span className="tq-muted">Signals: </span>{x.signals.join(' · ')}</p>}
                {info?.expected_info_gain_nats !== undefined && info?.expected_info_gain_nats !== null && <p className="tq-small"><span className="tq-muted">Expected information gain now: </span><strong className="tq-num">{fmt(info.expected_info_gain_nats, 2)} nats</strong></p>}
                {k === 'T4' && <p className="tq-muted tq-small">Ends with the simulated motor coasting, so any test after it is skipped. The live pipeline does not use T4.</p>}
                <button type="button" className="tq-btn" onClick={() => add(k)} disabled={!hasSim || seq.length >= (limits?.max_steps ?? 6)}><Plus size={14} aria-hidden="true" /> Add to sequence</button>
              </article>);
          })}
        </div>
      </Card>

      <Card title="Sequence" id="c-seq" className="tq-mt" right={<span className="tq-muted tq-small tq-num">{seq.length} test(s) · {total} simulated s</span>}>
        {!seq.length ? <Empty>Add one or more tests above. They run in order; a later test is skipped if an earlier one is aborted, invalid or leaves the motor stopped.</Empty> : (
          <ol className="tq-seq" data-testid="sequence">
            {seq.map((x, k) => (
              <li key={k} className="tq-seq-item">
                <div className="tq-seq-head"><strong>{k + 1}. {x.type === 'profile' ? PROFILE_SPEC.name : TEST_SPECS[x.type].name}</strong>
                  <span className="tq-row">
                    <button type="button" className="tq-iconbtn" aria-label={`Move test ${k + 1} up`} disabled={k === 0} onClick={() => setSeq((q) => { const n = [...q]; [n[k - 1], n[k]] = [n[k], n[k - 1]]; return n; })}><ArrowUp size={14} aria-hidden="true" /></button>
                    <button type="button" className="tq-iconbtn" aria-label={`Move test ${k + 1} down`} disabled={k === seq.length - 1} onClick={() => setSeq((q) => { const n = [...q]; [n[k + 1], n[k]] = [n[k], n[k + 1]]; return n; })}><ArrowDown size={14} aria-hidden="true" /></button>
                    <button type="button" className="tq-iconbtn" aria-label={`Remove test ${k + 1}`} onClick={() => setSeq((q) => q.filter((_, j) => j !== k))}><Trash2 size={14} aria-hidden="true" /></button>
                  </span></div>
                {x.type === 'profile' ? <ProfileEditor steps={x.steps} limits={limits} quick={quick} disabled={busy} onChange={(steps) => setSeq((q) => q.map((y, j) => (j === k ? { ...y, steps } : y)))} />
                  : <p className="tq-muted tq-small">{testsInfo[x.type]?.fixed_parameters || TEST_SPECS[x.type].short}. {(TEST_OUTCOMES[x.type] || [])[0]}</p>}
              </li>))}
          </ol>)}
        <label className="tq-check"><input type="checkbox" checked={stopConfident} onChange={(e) => setStopConfident(e.target.checked)} /> Skip the remaining tests once the ranking becomes confident</label>
        {seq.length > 0 && errs.length > 0 && <p className="tq-callout warn" role="alert">Cannot run yet: {errs.join('; ')}.</p>}
        {blockers.length > 0 && <p className="tq-callout warn" data-testid="seq-blockers">Not available: {blockers.join('; ')}.</p>}
        <div className="tq-row tq-mt">
          <button type="button" className="tq-btn tq-primary" disabled={busy || !seq.length || errs.length > 0 || blockers.length > 0} onClick={run} data-testid="run-sequence">
            <Play size={14} aria-hidden="true" /> {busy ? 'Running on the simulator copy…' : 'Run sequence on a simulator copy'}</button>
          <span className="tq-muted tq-small"><Gauge size={13} aria-hidden="true" /> Review the order, speeds and dwell times above before starting. The backend checks every value again.</span>
        </div>
        <ErrorBox error={err} />
      </Card>

      {wb?.run && <div className="tq-mt"><SequenceResult run={wb.run} onAddTest={(t) => setSeq([{ type: t }])} /></div>}

      <h3 className="tq-section-head tq-mt">Tests run by the pipeline itself</h3>
      <TestsPage d={d} c2c4={c2c4} head={false} />
    </>
  );
}
