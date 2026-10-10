import React, { useMemo, useState } from 'react';
import { LineChart, Line, ComposedChart, Area, XAxis, YAxis, Tooltip, Legend, ReferenceLine, ResponsiveContainer, CartesianGrid } from 'recharts';
import { Play, Pause, StopCircle, Check, X, RotateCcw } from 'lucide-react';
import { Card, Empty, ErrorBox, Pill, PosteriorBars, ProvBadge, fmt, stateTone } from './components.jsx';
import { C2C4Validation, DiagnosticTests, PredictionChecks, StatusPill, TEST_INFO } from './c2c4.jsx';

export const FAULTS = ['imbalance', 'looseness', 'overload', 'cooling_failure', 'supply_voltage', 'sensor_fault'];
const lastOf = (log, kind) => [...(log || [])].reverse().find((l) => l.kind === kind);
export const canControl = (role) => role === 'operator' || role === 'admin';
const title = (s) => String(s ?? '').replaceAll('_', ' ');
const samplesOf = (d) => d.telemetry?.samples || [];

export function PageHead({ title: t, sub, right }) {
  return <div className="tq-page-head"><div><h2>{t}</h2>{sub && <p>{sub}</p>}</div><div className="tq-row">{right}</div></div>;
}

export function Tabs({ tabs, value, onChange, label }) {
  return (
    <div className="tq-tabs" role="tablist" aria-label={label}>
      {tabs.map(([k, name]) => (
        <button key={k} role="tab" className="tq-tab" aria-selected={value === k} onClick={() => onChange(k)}>{name}</button>))}
    </div>
  );
}

/** A latest-value tile. A missing or invalid sensor reads UNAVAILABLE, never zero. */
export function Kpi({ label, value, unit, digits = 1, data, dataKey, color = 'var(--tq-accent)', note }) {
  const missing = value === null || value === undefined || Number.isNaN(value);
  return (
    <div className={`tq-kpi ${missing ? 'tq-unavailable' : ''}`}>
      <div className="tq-kpi-label"><span>{label}</span><ProvBadge kind="SIMULATED" /></div>
      <div className="tq-kpi-value tq-num">{missing ? 'UNAVAILABLE' : fmt(value, digits)}{!missing && <span className="tq-kpi-unit">{unit}</span>}</div>
      {data?.length > 1 && (
        <ResponsiveContainer width="100%" height={34}>
          <LineChart data={data}><Line dataKey={dataKey} stroke={color} dot={false} strokeWidth={1.6} isAnimationActive={false} /></LineChart>
        </ResponsiveContainer>)}
      {note && <div className="tq-muted" style={{ fontSize: 12 }}>{note}</div>}
    </div>
  );
}

function TrendChart({ data, lines, height = 190, yDomain, label }) {
  return (
    <div role="img" aria-label={label}>
      <ResponsiveContainer width="100%" height={height}>
        <LineChart data={data}><CartesianGrid stroke="var(--tq-border)" /><XAxis dataKey="t" minTickGap={28} tickFormatter={(x) => `${Math.round(x)}s`} /><YAxis domain={yDomain || ['auto', 'auto']} width={54} tickFormatter={(v) => (Math.abs(v) >= 100 ? Number(v).toFixed(0) : Number(v).toFixed(2))} />
          <Tooltip /><Legend />{lines.map((l) => <Line key={l.key} dataKey={l.key} name={l.name} stroke={l.color} strokeDasharray={l.dash} dot={false} isAnimationActive={false} />)}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Controls that act on the software simulator only. Nothing here reaches hardware. */
export function SimControls({ d, role, actions, running, setRunning, busy, error }) {
  const [form, setForm] = useState({ fault: 'imbalance', severity: 0.5, transient: true, approval: false, seed: 1 });
  const s = d.status || {};
  const hasSim = s.t !== undefined && s.t !== null;
  const ctl = canControl(role);
  const start = () => actions.start({
    fault: form.fault === 'none' ? null : form.fault, severity: Number(form.severity), seed: Number(form.seed),
    clears_below_rpm: form.transient ? 1500 : null, require_human_approval: form.approval,
  });
  return (
    <Card title="Simulation scenario" id="c-scn" right={<ProvBadge kind="SIMULATED" />}>
      {!ctl && <Empty>Your role ({role}) can view but not start simulations.</Empty>}
      <form className="tq-form" onSubmit={(e) => { e.preventDefault(); start(); }}>
        <label>Injected fault
          <select value={form.fault} onChange={(e) => setForm({ ...form, fault: e.target.value })} disabled={!ctl}>
            <option value="none">none (healthy run)</option>
            {FAULTS.map((f) => <option key={f} value={f}>{title(f)}</option>)}
          </select>
        </label>
        <label>Severity ({form.severity})
          <input type="range" min="0.05" max="1" step="0.05" value={form.severity} onChange={(e) => setForm({ ...form, severity: e.target.value })} disabled={!ctl} />
        </label>
        <label className="tq-check"><input type="checkbox" checked={form.transient} onChange={(e) => setForm({ ...form, transient: e.target.checked })} disabled={!ctl} />
          Condition clears when speed is reduced (simulated transient)</label>
        <label className="tq-check"><input type="checkbox" checked={form.approval} onChange={(e) => setForm({ ...form, approval: e.target.checked })} disabled={!ctl} />
          Require human approval (as in hardware mode)</label>
        <button type="submit" className="tq-btn tq-primary" disabled={!ctl || busy}><RotateCcw size={14} aria-hidden="true" /> Start new simulation</button>
      </form>
      <div className="tq-row">
        <button className="tq-btn" onClick={() => setRunning(!running)} disabled={!ctl || !hasSim}>
          {running ? <><Pause size={14} aria-hidden="true" /> Pause</> : <><Play size={14} aria-hidden="true" /> Run</>}
        </button>
        <button className="tq-btn tq-danger" onClick={actions.stop} disabled={!hasSim} aria-label="Stop motor (coast)"><StopCircle size={14} aria-hidden="true" /> STOP</button>
      </div>
      <p className="tq-muted">Simulator only. STOP coasts the simulated motor; it goes through the same safety path as every other command.</p>
      <ErrorBox error={error} />
    </Card>
  );
}

function describeLog(l) {
  switch (l.kind) {
    case 'hypotheses': return `Hypotheses ranked: ${title(l.ranked?.[0]?.[0])} (${l.label})`;
    case 'gate': return `Decision gate: ${title(l.verdict)}${l.test ? ` → test ${l.test}` : ''}`;
    case 'supervisor': return `Supervisor ${l.verdict}: ${title(l.action)}`;
    case 'test_result': return `Test ${l.test} returned`;
    case 'test_aborted': return `Test aborted: ${l.status}`;
    case 'transition': return `Incident ${title(l.frm)} → ${title(l.to)}`;
    case 'incident_opened': return 'Incident opened';
    case 'incident_closed': return `Incident closed: ${title(l.final)}`;
    case 'recovery_assessment': return `Recovery assessment: ${title(l.outcome)}`;
    case 'c2_unsupported': return `C2 unsupported: ${(l.reasons || []).map(title).join(', ')}`;
    default: return title(l.kind);
  }
}
const logTone = (l) => (['mandatory_stop', 'command_failed', 'test_aborted', 'c2_unsupported'].includes(l.kind) ? 'crit' : ['gate', 'supervisor'].includes(l.kind) ? 'wait' : 'info');

function warnings(d) {
  const s = d.status || {}; const out = [];
  if (s.device?.estop) out.push(['stop', `Device emergency stop (${s.device.estop_reason})`]);
  if (s.pending_approval) out.push(['wait', `Awaiting human approval: ${title(s.pending_approval.action)}`]);
  if (s.incident) out.push([stateTone(s.incident.state), `Incident ${s.incident.id}: ${title(s.incident.state)}`]);
  const p = (d.predictions || []).slice(-1)[0];
  if (p && p.status && p.status !== 'supported') out.push(['warn', `Latest C2 prediction is ${title(p.status)} and will not be used for decisions`]);
  if (s.last_window && s.last_window.valid === false) out.push(['crit', 'Latest window is flagged invalid (sensor data not trusted)']);
  return out;
}

/* ------------------------------------------------------------------ 1. Overview */
export function OverviewPage({ d, role, user, go, stale, ctl }) {
  const s = d.status || {}; const w = s.last_window; const t = samplesOf(d);
  const tail = t.slice(-60);
  const hyp = lastOf(d.log, 'hypotheses'); const gate = [...(d.decisions || [])].reverse().find((x) => x.inputs);
  const pred = (d.predictions || []).slice(-1)[0];
  const hasSim = s.t !== undefined && s.t !== null;
  const warn = warnings(d);
  const events = (d.log || []).slice(-8).reverse();
  const above = t.filter((x) => x.score != null && x.score > 1).length;
  const state = s.incident ? title(s.incident.state) : hasSim ? 'Normal operation (no open incident)' : 'No simulation running';
  return (
    <>
      <PageHead title={`Overview — ${user.user}`} sub="Simulated motor: state, trends, diagnosis and next steps in one place." right={<><ProvBadge kind="SIMULATED" /><Pill tone={s.incident ? stateTone(s.incident.state) : hasSim ? 'ok' : 'off'}>{state}</Pill></>} />
      <div className="tq-kpis" aria-label="Latest simulated telemetry">
        <Kpi label="Speed" value={w?.rpm} unit="rpm" digits={0} data={tail} dataKey="rpm" note={hasSim ? `setpoint ${fmt(s.device?.setpoint_rpm, 0)} rpm` : undefined} />
        <Kpi label="Housing temperature" value={w?.housing} unit="°C" data={tail} dataKey="housing" color="var(--tq-warn)" />
        <Kpi label="Vibration RMS" value={w?.vib_rms} unit="g" digits={3} data={tail} dataKey="vib_rms" color="var(--tq-teal)" />
        <Kpi label="Motor current" value={w?.current} unit="A" digits={2} data={tail} dataKey="current" color="var(--tq-sim)" />
      </div>
      <div className="tq-split">
        <div className="tq-stack">
          <Card title="Motor status" id="c-dev" right={<ProvBadge kind="SIMULATED" />}>
            {!hasSim ? <Empty>No simulation is running. Start one from Live Monitor.</Empty> : (
              <dl className="tq-kv">
                <dt>Environment</dt><dd>Software simulator (no physical device)</dd>
                <dt>Operating state</dt><dd>{state}</dd>
                <dt>Sim time</dt><dd className="tq-num">{fmt(s.t, 0)} s</dd>
                <dt>Telemetry freshness</dt><dd>{stale ? <Pill tone="crit">STALE — backend unreachable</Pill> : <Pill tone="ok">live</Pill>}</dd>
                <dt>Device safety state</dt><dd>{s.device?.estop ? <Pill tone="stop">EMERGENCY STOP</Pill> : <Pill tone="ok">OK</Pill>}</dd>
                <dt>Anomaly windows</dt><dd className="tq-num">{above} of {t.length} above learned threshold</dd>
              </dl>)}
          </Card>
          <Card title="Recent events" id="c-events">
            {!events.length ? <Empty>No events yet.</Empty> : (
              <ul className="tq-feed">{events.map((l, i) => (<li key={i}><Pill tone={logTone(l)}>{fmt(l.t, 0)} s</Pill><span>{describeLog(l)}</span></li>))}</ul>)}
          </Card>
        </div>
        <div className="tq-stack">
          <Card title="Active warnings" id="c-warn">
            {!warn.length ? <Empty>No active warnings or unresolved incidents.</Empty> : (
              <ul className="tq-list">{warn.map(([tone, text], i) => <li key={i}><Pill tone={tone}>{text}</Pill></li>)}</ul>)}
          </Card>
          <Card title="AI diagnosis (C1)" id="c-c1" right={<ProvBadge kind="DERIVED" />}>
            <PosteriorBars ranked={(hyp?.ranked || []).slice(0, 3)} label={hyp?.label} />
            <button className="tq-link" onClick={() => go('diagnostics')}>Open AI Diagnostics</button>
          </Card>
          <Card title="Prediction summary (C2)" id="c-c2" right={<ProvBadge kind="PREDICTED" />}>
            {!pred ? <Empty>No prediction yet. Predictions are produced while an anomaly is being investigated.</Empty> : (
              <p><StatusPill status={pred.status} /> <span className="tq-muted">{title(pred.action)}: risk {fmt(pred.risk * 100, 0)}%, housing @120 s {fmt(pred.lo_120.housing, 1)}–{fmt(pred.hi_120.housing, 1)} °C</span></p>)}
            <p className="tq-muted">{s.models?.c2_label}</p>
            <button className="tq-link" onClick={() => go('predictions')}>Open Predictions</button>
          </Card>
          <Card title="Recommendation" id="c-next">
            {!gate ? <Empty>The decision gate has not produced a recommendation yet.</Empty> : (
              <><p><Pill tone={gate.verdict === 'ACT' ? 'ok' : gate.verdict === 'SAFE_STOP' ? 'stop' : 'warn'}>{title(gate.verdict)}</Pill></p><p>{gate.reason}</p></>)}
            <p className="tq-muted">A recommendation is never an executed action. {ctl ? '' : 'Your role is read-only.'}</p>
            <button className="tq-link" onClick={() => go('interventions')}>Open Interventions</button>
          </Card>
        </div>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ 2. Live monitoring */
const RANGES = [['60', 'Last 60 s'], ['180', 'Last 3 min'], ['all', 'All (≤300 windows)']];
export function LivePage({ d, role, actions, running, setRunning, busy, error, stale }) {
  const [range, setRange] = useState('all');
  const all = samplesOf(d);
  const s = d.status || {};
  const data = useMemo(() => {
    const base = all.map((x) => ({ ...x, score: x.score == null || x.score <= 0 ? null : Number(x.score.toFixed(3)) }));
    if (range === 'all' || !base.length) return base;
    const cut = base[base.length - 1].t - Number(range);
    return base.filter((x) => x.t >= cut);
  }, [all, range]);
  const last = data[data.length - 1]; const w = s.last_window;
  const missing = ['rpm', 'housing', 'vib_rms', 'current'].filter((k) => w && (w[k] === null || w[k] === undefined));
  return (
    <>
      <PageHead title="Live Motor Monitoring" sub="Telemetry from the software simulator, refreshed every few seconds while it runs."
        right={<><ProvBadge kind="SIMULATED" />{stale ? <Pill tone="crit">stale</Pill> : <Pill tone={running ? 'ok' : 'off'}>{running ? 'running' : 'paused'}</Pill>}</>} />
      <div className="tq-kpis">
        <Kpi label="Speed" value={w?.rpm} unit="rpm" digits={0} />
        <Kpi label="Housing temperature" value={w?.housing} unit="°C" />
        <Kpi label="Vibration RMS" value={w?.vib_rms} unit="g" digits={3} />
        <Kpi label="Motor current" value={w?.current} unit="A" digits={2} />
      </div>
      {missing.length > 0 && <p className="tq-callout crit" role="alert">Missing sensor values: {missing.map(title).join(', ')}. They are shown as unavailable, not as zero.</p>}
      {s.t !== undefined && last && s.t - last.t > 30 && <p className="tq-callout warn">Latest telemetry window is {fmt(s.t - last.t, 0)} s older than simulation time.</p>}
      <div className="tq-row" role="group" aria-label="Time range" style={{ marginBottom: 12 }}>
        {RANGES.map(([k, name]) => <button key={k} className="tq-btn" aria-pressed={range === k} style={range === k ? { borderColor: 'var(--tq-accent)', color: 'var(--tq-accent)' } : undefined} onClick={() => setRange(k)}>{name}</button>)}
      </div>
      {!data.length ? <Card title="Live telemetry" id="c-live"><Empty>No telemetry yet. Press Run (or start a simulation) to generate simulated telemetry.</Empty></Card> : (
        <div className="tq-grid">
          <Card title="Speed" id="c-rpm" right={<ProvBadge kind="SIMULATED" />}>
            <TrendChart data={data} label="Speed over time" lines={[{ key: 'rpm', name: 'rpm (sim)', color: 'var(--tq-text)' }, { key: 'setpoint', name: 'setpoint', color: 'var(--tq-accent)', dash: '4 3' }]} />
          </Card>
          <Card title="Housing temperature" id="c-th" right={<ProvBadge kind="SIMULATED" />}>
            <TrendChart data={data} label="Housing temperature over time" lines={[{ key: 'housing', name: 'housing °C', color: 'var(--tq-warn)' }]} />
          </Card>
          <Card title="Vibration" id="c-vib" right={<ProvBadge kind="SIMULATED" />}>
            <TrendChart data={data} label="Vibration over time" lines={[{ key: 'vib_rms', name: 'vibration g', color: 'var(--tq-teal)' }]} />
          </Card>
          <Card title="Motor current" id="c-cur" right={<ProvBadge kind="SIMULATED" />}>
            <TrendChart data={data} label="Current over time" lines={[{ key: 'current', name: 'current A', color: 'var(--tq-sim)' }]} />
          </Card>
        </div>)}
      <div className="tq-split" style={{ marginTop: 14 }}>
        <Card title="Latest telemetry" id="c-tele" right={<ProvBadge kind="SIMULATED" />}>
          {!data.length ? <Empty>No samples.</Empty> : (
            <table className="tq-table"><caption className="tq-sr">Latest simulated telemetry windows</caption>
              <thead><tr><th scope="col">t (s)</th><th scope="col">Speed (rpm)</th><th scope="col">Housing (°C)</th><th scope="col">Vibration (g)</th><th scope="col">Current (A)</th><th scope="col">Score ÷ threshold</th></tr></thead>
              <tbody>{data.slice(-8).reverse().map((x) => (<tr key={x.t}><td className="tq-num">{fmt(x.t, 0)}</td><td className="tq-num">{fmt(x.rpm, 0)}</td><td className="tq-num">{fmt(x.housing, 1)}</td>
                <td className="tq-num">{fmt(x.vib_rms, 3)}</td><td className="tq-num">{fmt(x.current, 2)}</td><td className="tq-num">{x.score == null ? '—' : fmt(x.score, 2)}</td></tr>))}</tbody></table>)}
        </Card>
        <SimControls d={d} role={role} actions={actions} running={running} setRunning={setRunning} busy={busy} error={error} />
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ 3. AI diagnostics (C1) */
export function DiagnosticsPage({ d }) {
  const t = samplesOf(d); const hyp = lastOf(d.log, 'hypotheses'); const s = d.status || {}; const w = s.last_window;
  const gate = [...(d.decisions || [])].reverse().find((x) => x.inputs);
  const inc = (d.incidents || []).slice(-1)[0];
  const data = t.map((x) => ({ ...x, score: x.score == null || x.score <= 0 ? null : Number(x.score.toFixed(3)) }));
  const last = t[t.length - 1];
  const above = data.filter((x) => x.score != null && x.score > 1).length;
  const regime = !last ? ['off', 'No data'] : last.score == null ? ['info', `Not scored: ${title(last.score_status)}`] : last.score > 1 ? ['crit', 'Abnormal (above learned threshold)'] : ['ok', 'Normal (within learned band)'];
  const unfamiliar = hyp?.label === 'unfamiliar' || (d.log || []).some((l) => l.kind === 'c1_unfamiliar_regime');
  return (
    <>
      <PageHead title="AI Diagnostics (C1)" sub="Anomaly detection and fault hypotheses with the evidence behind them." right={<ProvBadge kind="DERIVED" />} />
      <div className="tq-split">
        <div className="tq-stack">
          <Card title="Anomaly score ÷ learned threshold (log scale)" id="c-score" right={<ProvBadge kind="DERIVED" />}>
            {!data.length ? <Empty>No telemetry yet.</Empty> : (
              <div role="img" aria-label="Anomaly score over time"><ResponsiveContainer width="100%" height={220}>
                <LineChart data={data}><CartesianGrid stroke="var(--tq-border)" /><XAxis dataKey="t" minTickGap={28} tickFormatter={(x) => `${Math.round(x)}s`} />
                  <YAxis scale="log" domain={[0.05, 'auto']} allowDataOverflow width={46} tickFormatter={(x) => (x >= 1 ? x.toFixed(0) : x.toFixed(2))} /><Tooltip /><Legend />
                  <ReferenceLine y={1} stroke="var(--tq-crit)" strokeDasharray="4 3" label={{ value: 'threshold = 1', position: 'insideTopRight', fill: 'var(--tq-crit)', fontSize: 11 }} />
                  <Line dataKey="score" stroke="var(--tq-learning)" dot={false} isAnimationActive={false} name="score ratio" /></LineChart></ResponsiveContainer></div>)}
            <p className="tq-muted">Gaps = windows excluded (speed changing) or operating point not learned. {above} of {data.length} windows above threshold.</p>
          </Card>
          <Card title="Incident timeline" id="c-hist">
            {!inc ? <Empty>No incident yet.</Empty> : (
              <ol className="tq-timeline">{inc.history.map((h, i) => (<li key={i}><span className="tq-muted">{title(h[0])}</span> → <strong>{title(h[2])}</strong> <span className="tq-muted">({h[1]})</span></li>))}</ol>)}
          </Card>
        </div>
        <div className="tq-stack">
          <Card title="Operating regime" id="c-regime">
            <p><Pill tone={regime[0]}>{regime[1]}</Pill></p>
            {unfamiliar && <p className="tq-callout warn">An unfamiliar operating regime was seen. It is not confirmed healthy and cannot authorise an action.</p>}
            <dl className="tq-kv"><dt>Sensor validity</dt><dd>{!w ? '—' : w.valid === false ? <Pill tone="crit">invalid</Pill> : <Pill tone="ok">valid</Pill>}</dd></dl>
          </Card>
          <Card title="Fault hypotheses" id="c-hyp" right={<ProvBadge kind="DERIVED" />}>
            <PosteriorBars ranked={hyp?.ranked} label={hyp?.label} />
            <p className="tq-muted">Probabilities are produced by the backend from learned class signatures. Bearing faults are not diagnosable with this sensor set.</p>
          </Card>
          <Card title="Why this hypothesis" id="c-why">
            {!hyp ? <Empty>No explanation yet; hypotheses appear once an anomaly has persisted.</Empty> : (
              <><p>Top hypothesis <strong>{title(hyp.ranked?.[0]?.[0])}</strong> is <strong>{hyp.label}</strong>.</p>
                {gate ? <p>Decision gate: <Pill tone={gate.verdict === 'ACT' ? 'ok' : 'warn'}>{title(gate.verdict)}</Pill> {gate.reason}</p> : null}
                {gate && <table className="tq-table"><caption className="tq-sr">Gate inputs</caption><tbody>{Object.entries(gate.inputs).map(([k, v]) => (<tr key={k}><th scope="row">{title(k)}</th><td className="tq-num">{String(v)}</td></tr>))}</tbody></table>}</>)}
          </Card>
        </div>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ 4. Predictions (C2) */
export function PredictionsPage({ d }) {
  const s = d.status || {}; const w = s.last_window;
  const all = d.predictions || [];
  const latestAt = all.length ? all[all.length - 1].predicted_at : null;
  const preds = all.filter((p) => p.predicted_at === latestAt);
  const [sel, setSel] = useState(null);
  const [signal, setSignal] = useState('housing');
  const p = preds.find((x) => x.action === sel) || preds[0];
  const cur = { rpm: w?.rpm, housing: w?.housing, vib_rms: w?.vib_rms };
  const chart = p ? [{ h: 0, mean: cur[signal] ?? null }, ...[30, 60, 120].map((h, i) => ({ h, mean: p.mean_at_30_60_120[signal]?.[i], band: [p.lo_at_30_60_120?.[signal]?.[i], p.hi_at_30_60_120?.[signal]?.[i]] }))] : [];
  return (
    <>
      <PageHead title="Counterfactual Predictions (C2)" sub="Expected outcome of each candidate action under matched simulated conditions."
        right={<><ProvBadge kind="PREDICTED" />{p && <StatusPill status={p.status} />}</>} />
      <p className="tq-callout warn" role="note"><strong>{s.models?.c2_label || 'Intervention Outcome Prediction (unvalidated)'}</strong> — not validated against physical experiments. A prediction is never evidence of recovery, and an unsupported prediction never authorises an action.
        {s.models?.c2_variant && s.models.c2_variant !== 'control' ? ` Experimental variant in use (opt-in): ${s.models.c2_variant}.` : ' The shipped predictor is in use; experimental variants are opt-in.'}</p>
      {!preds.length ? (<div className="tq-stack"><Card title="Predictions" id="c-pred"><Empty>No predictions yet. They are generated when the incident pipeline compares candidate actions; there is no manual prediction run.</Empty></Card>
        <PredictionChecks checks={d.predictionChecks || []} /></div>) : (
        <div className="tq-split">
          <div className="tq-stack">
            <Card title="Candidate interventions" id="c-pred" right={<ProvBadge kind="PREDICTED" />}>
              <div className="tq-stack" role="group" aria-label="Select intervention">
                {preds.map((x) => (
                  <button key={x.action} className="tq-select-card" aria-pressed={p?.action === x.action} onClick={() => setSel(x.action)}>
                    <strong>{title(x.action)}</strong> <StatusPill status={x.status} />
                    <div className="tq-muted">risk of crossing a limit {fmt(x.risk * 100, 0)}% · speed @120 s {fmt(x.mean_at_30_60_120.rpm[2], 0)} rpm</div>
                    {x.status_reasons?.length > 0 && <div className="tq-muted">{x.status_reasons.map(title).join(', ')}</div>}
                  </button>))}
              </div>
            </Card>
            <Card title="Predicted response" id="c-resp" right={<label className="tq-inline">Signal <select value={signal} onChange={(e) => setSignal(e.target.value)}><option value="housing">Housing °C</option><option value="rpm">Speed rpm</option><option value="vib_rms">Vibration g</option></select></label>}>
              <div role="img" aria-label="Predicted response with 90 percent interval"><ResponsiveContainer width="100%" height={220}>
                <ComposedChart data={chart}><CartesianGrid stroke="var(--tq-border)" /><XAxis dataKey="h" type="number" domain={[0, 120]} ticks={[0, 30, 60, 120]} tickFormatter={(x) => `${x}s`} /><YAxis width={50} domain={['auto', 'auto']} /><Tooltip /><Legend />
                  <Area dataKey="band" name="90% interval" stroke="none" fill="var(--tq-accent)" fillOpacity={0.15} isAnimationActive={false} />
                  <Line dataKey="mean" name="predicted (point 0 = current simulated value)" stroke="var(--tq-accent)" strokeDasharray="5 3" isAnimationActive={false} /></ComposedChart></ResponsiveContainer></div>
              <p className="tq-muted">The interval covers a single future 1 s simulated measurement. It is not a guarantee and not a measurement.</p>
            </Card>
          </div>
          <div className="tq-stack">
            <Card title="Prediction summary" id="c-sum">
              {p && (
                <dl className="tq-kv"><dt>Action</dt><dd>{title(p.action)}</dd><dt>Status</dt><dd><StatusPill status={p.status} /></dd>
                  <dt>Current {title(signal)}</dt><dd className="tq-num">{fmt(cur[signal], signal === 'vib_rms' ? 3 : 1)}</dd>
                  <dt>Predicted @120 s</dt><dd className="tq-num">{fmt(p.mean_at_30_60_120[signal]?.[2], signal === 'vib_rms' ? 3 : 1)}</dd>
                  <dt>90% interval @120 s</dt><dd className="tq-num">{fmt(p.lo_120[signal], signal === 'vib_rms' ? 3 : 1)}–{fmt(p.hi_120[signal], signal === 'vib_rms' ? 3 : 1)}</dd>
                  <dt>Interval method</dt><dd>{p.interval_method}</dd><dt>Validated by experiments</dt><dd>{p.validated_by_experiments ? 'yes' : 'no'}</dd></dl>)}
            </Card>
            <PredictionChecks checks={d.predictionChecks || []} />
          </div>
        </div>)}
    </>
  );
}

/* ------------------------------------------------------------------ 5. Diagnostic tests (C4) */
export function TestsPage({ d, c2c4 }) {
  const [sel, setSel] = useState('T1');
  const res = lastOf(d.log, 'test_result');
  const phase11 = c2c4?.phase11?.c4_calibration;
  const real = c2c4?.c4_realistic_v2 || c2c4?.c4_realistic_v1;
  return (
    <>
      <PageHead title="Diagnostic Tests (C4)" sub="Tests that separate competing fault hypotheses. Run only through the safety supervisor." right={<ProvBadge kind="SIMULATED" />} />
      <div className="tq-split">
        <div className="tq-stack">
          <Card title="Available tests" id="c-avail">
            <div className="tq-stack" role="group" aria-label="Available diagnostic tests">
              {Object.entries(TEST_INFO).map(([k, text]) => (
                <button key={k} className="tq-select-card" aria-pressed={sel === k} onClick={() => setSel(k)}><strong>{k}</strong><div className="tq-muted">{text}</div></button>))}
            </div>
            <p className="tq-muted">Tests are proposed by the decision gate and run by the pipeline in the simulator after the Safety Supervisor allows them. There is no manual run button, by design.</p>
          </Card>
          <DiagnosticTests log={d.log || []} />
        </div>
        <div className="tq-stack">
          <Card title={`Selected test ${sel}`} id="c-sel"><p>{TEST_INFO[sel]}</p>
            <p className="tq-muted">Expected diagnostic value is not shown per test because the backend does not publish a per-test value; measured value is in the evaluation table below.</p></Card>
          <Card title="Latest result and competing hypotheses" id="c-result">
            {!res ? <Empty>No diagnostic test has been run in this incident.</Empty> : (
              <><p><strong>{res.test}</strong> observation <span className="tq-num">{res.obs.map((x) => x.toFixed(2)).join(', ')}</span></p><PosteriorBars ranked={res.posterior} label="after test" /></>)}
          </Card>
          <Card title="C4 calibration status" id="c-cal">
            <p><Pill tone="warn">{phase11 && !phase11.adopted ? 'Phase 11 calibration NOT adopted' : 'calibration status unavailable'}</Pill></p>
            <p className="tq-muted">The experimental C4 calibration failed its pre-registered validation bar (it regressed on an unseen sensor style), so the shipped C4 behaviour is unchanged. Only a rule that blocks action on uncorroborated evidence ships.</p>
            {real && <p className="tq-muted">Held-out confidently-wrong rates by regime are in Evaluation.</p>}
          </Card>
        </div>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ 6. Interventions (C3) */
export function InterventionsPage({ d, role, actions, error }) {
  const s = d.status || {}; const pend = s.pending_approval; const ctl = canControl(role);
  const gate = [...(d.decisions || [])].reverse().find((x) => x.inputs);
  const sup = (d.log || []).filter((l) => l.kind === 'supervisor').slice(-8).reverse();
  const cmds = (d.commands || []).filter((c) => c.action !== 'HEARTBEAT').slice(-8).reverse();
  return (
    <>
      <PageHead title="Interventions (C3)" sub="What the system proposes, what the gate and Safety Supervisor decided, and what the device acknowledged." right={<ProvBadge kind="SIMULATED" />} />
      <p className="tq-callout" role="note">This page never commands a motor directly. Every action passes the decision gate and the deterministic Safety Supervisor on the backend; the frontend can only approve or reject what the backend proposes.</p>
      <div className="tq-split">
        <div className="tq-stack">
          <Card title="Decision gate" id="c-gate">
            {!gate ? <Empty>The gate has not evaluated yet.</Empty> : (
              <><p><Pill tone={gate.verdict === 'ACT' ? 'ok' : gate.verdict === 'SAFE_STOP' ? 'stop' : 'warn'}>{title(gate.verdict)}</Pill></p><p>{gate.reason}</p>
                <table className="tq-table"><caption className="tq-sr">Gate preconditions</caption><tbody>{Object.entries(gate.inputs).map(([k, v]) => (<tr key={k}><th scope="row">{title(k)}</th><td className="tq-num">{String(v)}</td></tr>))}</tbody></table></>)}
          </Card>
          <Card title="Awaiting your decision" id="c-appr">
            {!pend ? <Empty>No action is waiting for approval.</Empty> : (
              <>
                <p><Pill tone="wait">{title(pend.action)}</Pill> <span className="tq-num">{JSON.stringify(pend.params)}</span></p><p>{pend.rationale}</p>
                <div className="tq-row">
                  <button className="tq-btn tq-primary" onClick={actions.approve} disabled={!ctl}><Check size={14} aria-hidden="true" /> Approve</button>
                  <button className="tq-btn" onClick={actions.reject} disabled={!ctl}><X size={14} aria-hidden="true" /> Reject</button>
                </div>
                {!ctl && <p className="tq-muted">Approving requires role operator or admin.</p>}
              </>)}
            <ErrorBox error={error} />
          </Card>
        </div>
        <div className="tq-stack">
          <Card title="Safety supervisor decisions" id="c-sup">
            {!sup.length ? <Empty>No decisions yet.</Empty> : (
              <ul className="tq-list">{sup.map((x, i) => (<li key={i}><Pill tone={x.verdict === 'ALLOW' ? 'ok' : x.verdict === 'DEFER' ? 'wait' : 'crit'}>{x.verdict}</Pill> {title(x.action)}<span className="tq-muted"> — {x.reasons.map(title).join(', ')}</span></li>))}</ul>)}
          </Card>
          <Card title="Action history: commands and device acknowledgements" id="c-cmd">
            {!cmds.length ? <Empty>No commands sent.</Empty> : (
              <table className="tq-table"><thead><tr><th scope="col">#</th><th scope="col">Action</th><th scope="col">Device status</th><th scope="col">Took effect</th></tr></thead>
                <tbody>{cmds.map((c) => (<tr key={c.session + c.id}><td className="tq-num">{c.id}</td><td>{c.action}</td>
                  <td><Pill tone={['ACCEPTED', 'COMPLETED'].includes(c.status) ? 'ok' : c.status === 'PENDING' ? 'wait' : 'crit'}>{c.status}</Pill> {c.reason && <span className="tq-muted">{c.reason}</span>}</td>
                  <td>{c.counts_as_executed ? 'yes (acknowledged by device)' : 'no'}</td></tr>))}</tbody></table>)}
            <p className="tq-muted">An HTTP 200 only means a command was dispatched. Only a device acknowledgement counts.</p>
          </Card>
        </div>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ 7. Recovery verification (C5) */
export function RecoveryPage({ d }) {
  const outs = (d.outcomes || []).slice().reverse(); const s = d.status || {};
  const verifying = s.incident?.state === 'VERIFYING_RECOVERY';
  return (
    <>
      <PageHead title="Recovery Verification (C5)" sub="Recovery is declared only from fresh, valid samples observed after the device acknowledged an action." right={<ProvBadge kind="SIMULATED" />} />
      <p className="tq-callout warn" role="note">A prediction of improvement is not a verified recovery. Records below are simulator observations, not hardware evidence.</p>
      <div className="tq-grid">
        {verifying && <Card title="Verifying recovery" id="c-ver"><Pill tone="wait">collecting fresh samples</Pill><p className="tq-muted">Verification is still in progress; nothing is declared recovered yet.</p></Card>}
        <Card title="Outcomes" id="c-out" className="tq-span">
          {!outs.length ? <Empty>No incident has been verified yet. Verified outcomes appear here after an acknowledged action and a fresh observation window.</Empty> : outs.map((o) => (
            <article key={o.incident} className="tq-outcome">
              <h4>{o.incident}{' '}<Pill tone={o.outcome === 'RECOVERED' ? 'ok' : o.outcome === 'UNRESOLVED' ? 'crit' : 'warn'}>{title(o.outcome)}</Pill>{' '}<ProvBadge kind="SIMULATED" /></h4>
              <p>Action: <strong>{o.action || '—'}</strong> · device confirmed: {o.command_executed ? 'yes' : 'no'} · fresh samples: <span className="tq-num">{o.n_fresh}</span></p>
              <p className="tq-muted">Reason: {o.reasons.map(title).join(', ')}</p>
              {Object.keys(o.criteria || {}).length > 0 && (<><h4>Verification checklist</h4><ul className="tq-list">{Object.entries(o.criteria).map(([k, v]) => (<li key={k}><Pill tone={v ? 'ok' : 'crit'}>{v ? 'pass' : 'fail'}</Pill> {title(k)}</li>))}</ul></>)}
              {o.observed && o.observed.rpm !== undefined && (<p className="tq-muted">Observed after the action (not predicted): {fmt(o.observed.rpm, 0)} rpm, {fmt(o.observed.housing, 1)} °C, {fmt(o.observed.frac_in_band * 100, 0)}% of windows in learned band.</p>)}
            </article>))}
        </Card>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ 9. Learning and model management (C6) */
export function LearningPage({ d, children }) {
  const cases = d.cases || [];
  return (
    <>
      <PageHead title="Learning and Model Management (C6)" sub="Learning dataset and the operator-attested healthy reference used by adaptive C1." right={<ProvBadge kind="SIMULATED" />} />
      <Card title="Learning dataset" id="c-learn">
        {!cases.length ? <Empty>No eligible cases recorded in this run. Blocked, rejected or aborted actions never count.</Empty> : (
          <ul className="tq-list">{cases.map((c) => (<li key={c.label + c.outcome + c.session}><strong>{c.label}</strong> · {c.outcome} · label source {c.label_source} · executed {String(c.executed)} <ProvBadge kind="SIMULATED" /></li>))}</ul>)}
        <p className="tq-muted">No model training, promotion or rollback of C2/C4 models is exposed: those are not implemented as operator actions. The attestation workflow below is the only model-management feature that exists.</p>
      </Card>
      <div style={{ marginTop: 14 }}>{children}</div>
    </>
  );
}

/* ------------------------------------------------------------------ 10. Devices and settings */
export function DevicesPage({ d, user, role, rows, auditError, apiBase }) {
  const s = d.status || {}; const hasSim = s.t !== undefined && s.t !== null; const sc = s.scenario;
  return (
    <>
      <PageHead title="Devices and Settings" sub="Connected devices, operating mode and application settings." right={<Pill tone="info">SIMULATION mode</Pill>} />
      <div className="tq-split">
        <div className="tq-stack">
          <Card title="Devices" id="c-devices">
            <table className="tq-table"><caption className="tq-sr">Devices</caption><thead><tr><th scope="col">Device</th><th scope="col">Type</th><th scope="col">Connection</th></tr></thead>
              <tbody>
                <tr><td>Simulated motor 01</td><td><ProvBadge kind="SIMULATED" /> software simulator</td><td>{hasSim ? <Pill tone="ok">simulator running</Pill> : <Pill tone="off">idle</Pill>}</td></tr>
                <tr><td>Physical ESP32 motor controller</td><td>physical device</td><td><Pill tone="off">not connected</Pill> <span className="tq-muted">UNAVAILABLE — this build serves simulated data only</span></td></tr>
              </tbody></table>
          </Card>
          <Card title="Simulated device details" id="c-devd" right={<ProvBadge kind="SIMULATED" />}>
            {!hasSim ? <Empty>No simulation has been started.</Empty> : (
              <dl className="tq-kv"><dt>Setpoint</dt><dd className="tq-num">{fmt(s.device?.setpoint_rpm, 0)} rpm</dd><dt>Emergency stop</dt><dd>{s.device?.estop ? `engaged (${s.device.estop_reason})` : 'clear'}</dd>
                <dt>Injected fault</dt><dd>{sc?.fault ? `${title(sc.fault)} (severity ${sc.severity})` : 'none'}</dd><dt>Seed</dt><dd className="tq-num">{sc?.seed}</dd>
                <dt>Human approval required</dt><dd>{sc?.human_approval_required ? 'yes' : 'no'}</dd></dl>)}
            <h4>Sensor availability</h4>
            <ul className="tq-list">{['rpm', 'current', 'housing', 'vib_rms'].map((k) => (<li key={k}>{title(k)} {s.last_window?.[k] == null ? <Pill tone="off">unavailable</Pill> : <Pill tone="ok">reporting (simulated)</Pill>}</li>))}</ul>
          </Card>
        </div>
        <div className="tq-stack">
          <Card title="Application settings" id="c-settings">
            <dl className="tq-kv"><dt>Signed in as</dt><dd>{user.user} ({role})</dd><dt>Operating mode</dt><dd>{s.mode || 'SIMULATION'}</dd><dt>API</dt><dd className="tq-num">{apiBase || 'same origin (/api/torqva)'}</dd>
              <dt>C2 predictor</dt><dd>{s.models?.c2_variant || '—'} (experimental variants are opt-in via server environment)</dd></dl>
            <p className="tq-muted">Permission-aware: operator or admin may start simulations and approve actions; viewers are read-only. Safety limits are enforced by the backend and cannot be changed here.</p>
          </Card>
          <Card title="Audit history (append-only)" id="c-aud">
            {role !== 'admin' ? <Empty>The audit log is visible to admins only.</Empty> : (<>
              <ErrorBox error={auditError} />
              {!rows?.length ? <Empty>No audit events yet.</Empty> : (
                <table className="tq-table"><thead><tr><th scope="col">#</th><th scope="col">Kind</th><th scope="col">Actor</th><th scope="col">Detail</th></tr></thead>
                  <tbody>{rows.slice(-30).reverse().map((r) => (<tr key={r.n}><td className="tq-num">{r.n}</td><td>{r.kind}</td><td>{r.actor}</td><td className="tq-muted">{JSON.stringify(r.detail).slice(0, 120)}</td></tr>))}</tbody></table>)}</>)}
          </Card>
        </div>
      </div>
    </>
  );
}

export { C2C4Validation };
