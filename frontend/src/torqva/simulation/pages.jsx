import React, { useMemo, useState } from 'react';
import { Play, Pause, StopCircle, Check, X, RotateCcw, Gauge, Thermometer, Waves, Zap } from 'lucide-react';
import { Card, Empty, ErrorBox, Pill, PosteriorBars, ProvBadge, fmt, stateTone, PageHead, CardLink } from '../shared/components.jsx';
import { Sparkline, TrendLines, ScoreChart, ResponseChart } from '../shared/lazyCharts.jsx';
import { C2C4Validation, DiagnosticTests, PredictionChecks, StatusPill } from './c2c4.jsx';

export const FAULTS = ['imbalance', 'looseness', 'overload', 'cooling_failure', 'supply_voltage', 'sensor_fault'];
const lastOf = (log, kind) => [...(log || [])].reverse().find((l) => l.kind === kind);
export const canControl = (role) => role === 'operator' || role === 'admin';
export const isPhysOf = (d) => !!(
  d?.status?.mode === 'PHYSICAL' ||
  d?.status?.provenance === 'MEASURED' ||
  d?.telemetry?.provenance === 'MEASURED' ||
  d?.status?.origin === 'physical_device' ||
  (Array.isArray(d?.telemetry) && d?.telemetry[0]?.provenance === 'MEASURED')
);
const title = (s) => String(s ?? '').replaceAll('_', ' ');
const samplesOf = (d) => d.telemetry?.samples || [];

/** A latest-value tile. A missing or invalid sensor reads UNAVAILABLE, never zero. */
export function Kpi({ label, value, unit, digits = 1, data, dataKey, color = 'var(--tq-chart-1)', note, prov = 'MEASURED', icon: I, primary = false }) {
  const missing = value === null || value === undefined || Number.isNaN(value);
  return (
    <div className={`tq-kpi ${missing ? 'tq-unavailable' : ''} ${primary ? 'tq-kpi-primary' : ''}`.trim()}>
      <div className="tq-kpi-label"><span className="tq-kpi-head">{I && <span className="tq-kpi-icon" aria-hidden="true"><I size={15} /></span>}<span>{label}</span></span><ProvBadge kind={prov} /></div>
      <div className="tq-kpi-value tq-num">{missing ? 'UNAVAILABLE' : fmt(value, digits)}{!missing && <span className="tq-kpi-unit">{unit}</span>}</div>
      {data?.length > 1 && (
        <div className="tq-kpi-spark" aria-hidden="true"><Sparkline data={data} dataKey={dataKey} color={color} height={primary ? 56 : 40} /></div>)}
      {note && <div className="tq-kpi-note">{note}</div>}
    </div>
  );
}

function TrendChart({ data, lines, height = 200, yDomain, label, digits = 2, unit = '' }) {
  return <div role="img" aria-label={label} className="tq-chart"><TrendLines data={data} lines={lines} height={height} yDomain={yDomain} digits={digits} unit={unit} /></div>;
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
      <div className="tq-section">
        <p className="tq-section-title">Current simulation</p>
        <div className="tq-row">
          <button className="tq-btn" onClick={() => setRunning(!running)} disabled={!ctl || !hasSim}>
            {running ? <><Pause size={14} aria-hidden="true" /> Pause</> : <><Play size={14} aria-hidden="true" /> Run</>}
          </button>
          <button className="tq-btn tq-danger" onClick={actions.stop} disabled={!hasSim} aria-label="Stop motor (coast)"><StopCircle size={14} aria-hidden="true" /> STOP</button>
        </div>
        <p className="tq-muted">Simulator only. STOP coasts the simulated motor; it goes through the same safety path as every other command.</p>
      </div>
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
export function OverviewPage({ d, role, user, go, stale, ctl, deviceCard, isPhys: isPhysProp }) {
  const isPhys = isPhysProp ?? isPhysOf(d);
  const provKind = isPhys ? 'MEASURED' : 'SIMULATED';
  const s = d.status || {}; const w = s.last_window; const t = samplesOf(d);
  const tail = t.slice(-60);
  const hyp = lastOf(d.log, 'hypotheses'); const gate = [...(d.decisions || [])].reverse().find((x) => x.inputs);
  const pred = (d.predictions || []).slice(-1)[0];
  const hasSim = s.t !== undefined && s.t !== null;
  const hasData = isPhys || hasSim;
  const warn = warnings(d);
  const events = (d.log || []).slice(-8).reverse();
  const above = t.filter((x) => x.score != null && x.score > 1).length;
  const state = s.incident ? title(s.incident.state) : isPhys ? 'No open incident (physical data)' : hasSim ? 'Normal operation (no open incident)' : 'No simulation running';
  return (
    <>
      <PageHead title={`Overview — ${user.user}`} sub={isPhys ? "Physical motor: state, trends, diagnosis and next steps reported by the backend." : "Simulated motor: state, trends, diagnosis and next steps in one place."} right={<><ProvBadge kind={provKind} /><Pill tone={s.incident ? stateTone(s.incident.state) : hasData ? 'ok' : 'off'}>{state}</Pill></>} />
      <div className="tq-kpis tq-kpis-hero" aria-label="Latest telemetry">
        <Kpi label="Speed" icon={Gauge} primary value={w?.rpm} unit="rpm" digits={0} data={tail} dataKey="rpm" prov={provKind} note={hasData ? `setpoint ${fmt(s.device?.setpoint_rpm, 0)} rpm` : undefined} />
        <Kpi label="Housing temperature" icon={Thermometer} value={w?.housing} unit="°C" data={tail} dataKey="housing" prov={provKind} color="var(--tq-chart-2)" />
        <Kpi label="Vibration RMS" icon={Waves} value={w?.vib_rms} unit="g" digits={3} data={tail} dataKey="vib_rms" prov={provKind} color="var(--tq-chart-3)" />
        <Kpi label="Motor current" icon={Zap} value={w?.current} unit="A" digits={2} data={tail} dataKey="current" prov={provKind} color="var(--tq-chart-4)" />
      </div>
      <div className="tq-split">
        <div className="tq-stack">
          <Card title="Motor status" id="c-dev" right={<ProvBadge kind={provKind} />}>
            {!hasData ? <Empty>No motor telemetry available.</Empty> : (
              <dl className="tq-kv">
                <dt>Environment</dt><dd>{isPhys ? 'Physical device' : 'Software simulator (no physical device)'}</dd>
                <dt>Operating state</dt><dd>{state}</dd>
                <dt>{isPhys ? 'Data origin' : 'Sim time'}</dt><dd className="tq-num">{isPhys ? 'Physical device telemetry' : `${fmt(s.t, 0)} s`}</dd>
                <dt>Telemetry freshness</dt><dd>{stale ? <Pill tone="crit">STALE — backend unreachable</Pill> : <Pill tone="ok">{isPhys ? 'live HW' : 'live'}</Pill>}</dd>
                <dt>Device safety state</dt><dd>{s.device?.estop ? <Pill tone="stop">EMERGENCY STOP</Pill> : <Pill tone="ok">OK</Pill>}</dd>
                <dt>Anomaly windows</dt><dd className="tq-num">{above} of {t.length} scored</dd>
              </dl>)}
          </Card>
          {deviceCard}
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
            <CardLink onClick={() => go('diagnostics')}>Open AI Diagnostics</CardLink>
          </Card>
          <Card title="Prediction summary (C2)" id="c-c2" right={<ProvBadge kind="PREDICTED" />}>
            {!pred ? <Empty>No prediction yet. Predictions are produced while an anomaly is being investigated.</Empty> : (
              <p><StatusPill status={pred.status} /> <span className="tq-muted">{title(pred.action)}: risk {fmt(pred.risk * 100, 0)}%, housing @120 s {fmt(pred.lo_120.housing, 1)}–{fmt(pred.hi_120.housing, 1)} °C</span></p>)}
            <p className="tq-muted">{s.models?.c2_label}</p>
            <CardLink onClick={() => go('predictions')}>Open Predictions</CardLink>
          </Card>
          <Card title="Recommendation" id="c-next">
            {!gate ? <Empty>The decision gate has not produced a recommendation yet.</Empty> : (
              <><p><Pill tone={gate.verdict === 'ACT' ? 'ok' : gate.verdict === 'SAFE_STOP' ? 'stop' : 'warn'}>{title(gate.verdict)}</Pill></p><p>{gate.reason}</p></>)}
            <p className="tq-muted">A recommendation is never an executed action. {ctl ? '' : 'Your role is read-only.'}</p>
            <CardLink onClick={() => go('interventions')}>Open Interventions</CardLink>
          </Card>
        </div>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ 2. Live monitoring */
const RANGES = [['60', 'Last 60 s'], ['180', 'Last 3 min'], ['all', 'All (≤300 windows)']];
export function LivePage({ d, role, actions, running, setRunning, busy, error, stale, deviceLive, device, isPhys: isPhysProp }) {
  const isPhys = isPhysProp ?? isPhysOf(d);
  const provKind = isPhys ? 'MEASURED' : 'SIMULATED';
  const [range, setRange] = useState('all');
  const [source, setSource] = useState(isPhys ? 'device' : 'simulation');
  const deviceOn = !!(device && device.snap && device.snap.handshake);
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
  const physical = (deviceOn && device.snap.origin === 'physical_device') || isPhys;
  const selector = deviceOn ? (
    <div className="tq-seg" role="group" aria-label="Data source">
      <button className="tq-btn" aria-pressed={source === 'simulation'} onClick={() => setSource('simulation')}>Simulation</button>
      <button className="tq-btn" aria-pressed={source === 'device'} onClick={() => setSource('device')}>{physical ? 'Physical device' : 'Connected device (firmware simulation)'}</button>
    </div>) : null;
  if (deviceOn && source === 'device') {
    return (<><PageHead title="Live Motor Monitoring" sub="Readings reported by the connected device over USB serial; stale data is marked, never shown as live." right={<Pill tone={physical ? 'ok' : 'warn'}>{physical ? 'PHYSICAL DEVICE' : 'DEVICE (FIRMWARE SIMULATION MODE)'}</Pill>} />
      <div className="tq-toolbar"><span className="tq-toolbar-label">Source</span>{selector}</div>{deviceLive}</>);
  }
  return (
    <>
      <PageHead title="Live Motor Monitoring" sub={isPhys ? "Telemetry the backend reports as measured on the physical device." : "Telemetry from the software simulator, refreshed every few seconds while it runs."}
        right={<><ProvBadge kind={provKind} />{stale ? <Pill tone="crit">stale</Pill> : <Pill tone={isPhys ? 'ok' : running ? 'ok' : 'off'}>{isPhys ? 'live HW' : running ? 'running' : 'paused'}</Pill>}</>} />
      <div className="tq-toolbar">
        {selector && <><span className="tq-toolbar-label">Source</span>{selector}</>}
        <span className="tq-toolbar-label">Window</span>
        <div className="tq-seg" role="group" aria-label="Time range">
          {RANGES.map(([k, name]) => <button key={k} className="tq-btn" aria-pressed={range === k} onClick={() => setRange(k)}>{name}</button>)}
        </div>
      </div>
      <div className="tq-kpis">
        <Kpi label="Speed" icon={Gauge} value={w?.rpm} unit="rpm" digits={0} prov={provKind} />
        <Kpi label="Housing temperature" icon={Thermometer} value={w?.housing} unit="°C" prov={provKind} />
        <Kpi label="Vibration RMS" icon={Waves} value={w?.vib_rms} unit="g" digits={3} prov={provKind} />
        <Kpi label="Motor current" icon={Zap} value={w?.current} unit="A" digits={2} prov={provKind} />
      </div>
      {missing.length > 0 && <p className="tq-callout crit" role="alert">Missing sensor values: {missing.map(title).join(', ')}. They are shown as unavailable, not as zero.</p>}
      {s.t !== undefined && last && s.t - last.t > 30 && <p className="tq-callout warn">Latest telemetry window is {fmt(s.t - last.t, 0)} s older than simulation time.</p>}
      <div className="tq-split">
        <div className="tq-stack">
          {!data.length ? <Card title="Live telemetry" id="c-live"><Empty>No telemetry yet.</Empty></Card> : (
            <div className="tq-grid tq-grid-2">
              <Card title="Speed" id="c-rpm" right={<ProvBadge kind={provKind} />}>
                <TrendChart data={data} label="Speed over time" digits={0} unit="rpm" lines={[{ key: 'rpm', name: `rpm (${isPhys ? 'HW' : 'sim'})`, color: 'var(--tq-chart-ink)' }, { key: 'setpoint', name: 'setpoint', color: 'var(--tq-chart-1)', dash: '4 3' }]} />
              </Card>
              <Card title="Housing temperature" id="c-th" right={<ProvBadge kind={provKind} />}>
                <TrendChart data={data} label="Housing temperature over time" digits={1} unit="°C" lines={[{ key: 'housing', name: 'housing °C', color: 'var(--tq-chart-2)' }]} />
              </Card>
              <Card title="Vibration" id="c-vib" right={<ProvBadge kind={provKind} />}>
                <TrendChart data={data} label="Vibration over time" digits={3} unit="g" lines={[{ key: 'vib_rms', name: 'vibration g', color: 'var(--tq-chart-3)' }]} />
              </Card>
              <Card title="Motor current" id="c-cur" right={<ProvBadge kind={provKind} />}>
                <TrendChart data={data} label="Current over time" digits={2} unit="A" lines={[{ key: 'current', name: 'current A', color: 'var(--tq-chart-4)' }]} />
              </Card>
            </div>)}
          <Card title="Latest telemetry" id="c-tele" right={<ProvBadge kind={provKind} />}>
            {!data.length ? <Empty>No samples.</Empty> : (
              <table className="tq-table"><caption className="tq-sr">Latest telemetry windows</caption>
                <thead><tr><th scope="col">t (s)</th><th scope="col">Speed (rpm)</th><th scope="col">Housing (°C)</th><th scope="col">Vibration (g)</th><th scope="col">Current (A)</th><th scope="col">Score ÷ threshold</th></tr></thead>
                <tbody>{data.slice(-8).reverse().map((x) => (<tr key={x.t}><td className="tq-num">{fmt(x.t, 0)}</td><td className="tq-num">{fmt(x.rpm, 0)}</td><td className="tq-num">{fmt(x.housing, 1)}</td>
                  <td className="tq-num">{fmt(x.vib_rms, 3)}</td><td className="tq-num">{fmt(x.current, 2)}</td><td className="tq-num">{x.score == null ? '—' : fmt(x.score, 2)}</td></tr>))}</tbody></table>)}
          </Card>
        </div>
        <div className="tq-stack tq-sticky-side">
          <SimControls d={d} role={role} actions={actions} running={running} setRunning={setRunning} busy={busy} error={error} />
        </div>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ 3. AI diagnostics (C1) */
export function DiagnosticsPage({ d, isPhys: isPhysProp }) {
  const isPhys = isPhysProp ?? isPhysOf(d);
  const provKind = 'DERIVED';
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
      <PageHead title="AI Diagnostics (C1)" sub="Anomaly detection and fault hypotheses with the evidence behind them." right={<ProvBadge kind={provKind} />} />
      <div className="tq-split">
        <div className="tq-stack">
          <Card title="Anomaly score ÷ learned threshold (log scale)" id="c-score" right={<ProvBadge kind={provKind} />}>
            {!data.length ? <Empty>No telemetry yet.</Empty> : (
              <div role="img" aria-label="Anomaly score over time" className="tq-chart"><ScoreChart data={data} height={240} /></div>)}
            <p className="tq-chart-note">Gaps = windows excluded (speed changing) or operating point not learned. {above} of {data.length} windows above threshold.</p>
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
            <dl className="tq-kv"><dt>Sensor validity</dt><dd>{!w ? '—' : w.valid === false ? <Pill tone="crit">invalid</Pill> : <Pill tone="ok">valid</Pill>}</dd>
              <dt>Data origin</dt><dd>{isPhys ? 'Physical device' : 'Simulation'}</dd></dl>
          </Card>
          <Card title="Fault hypotheses" id="c-hyp" right={<ProvBadge kind={provKind} />}>
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
export function PredictionsPage({ d, go }) {
  const s = d.status || {}; const w = s.last_window;
  const all = d.predictions || [];
  const latestAt = all.length ? all[all.length - 1].predicted_at : null;
  const preds = all.filter((p) => p.predicted_at === latestAt);
  const [sel, setSel] = useState(null);
  const [signal, setSignal] = useState('housing');
  const p = preds.find((x) => x.action === sel) || preds[0];
  const cur = { rpm: w?.rpm, housing: w?.housing, vib_rms: w?.vib_rms };
  const dg = signal === 'vib_rms' ? 3 : 1;
  const chart = p ? [{ h: 0, mean: cur[signal] ?? null }, ...[30, 60, 120].map((h, i) => {
    const lo = p.lo_at_30_60_120?.[signal]?.[i]; const hi = p.hi_at_30_60_120?.[signal]?.[i];
    return { h, mean: p.mean_at_30_60_120?.[signal]?.[i] ?? null, band: lo != null && hi != null ? [lo, hi] : null };   // no interval from the model = no band, never a band to zero
  })] : [];
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
                  <button type="button" key={x.action} className="tq-select-card" aria-pressed={p?.action === x.action} onClick={() => setSel(x.action)}>
                    <div className="tq-option-title"><strong>{title(x.action)}</strong><StatusPill status={x.status} /></div>
                    <div className="tq-option-meta">risk of crossing a limit {fmt(x.risk * 100, 0)}% · speed @120 s <span className="tq-num">{fmt(x.mean_at_30_60_120?.rpm?.[2], 0)} rpm</span></div>
                    {x.status_reasons?.length > 0 && <div className="tq-option-meta">{x.status_reasons.map(title).join(', ')}</div>}
                  </button>))}
              </div>
            </Card>
            <Card title="Predicted response" id="c-resp" right={<label className="tq-inline">Signal <select value={signal} onChange={(e) => setSignal(e.target.value)}><option value="housing">Housing °C</option><option value="rpm">Speed rpm</option><option value="vib_rms">Vibration g</option></select></label>}>
              <div role="img" aria-label="Predicted response with 90 percent interval" className="tq-chart"><ResponseChart data={chart} height={240} /></div>
              <p className="tq-chart-note">The interval covers a single future 1 s simulated measurement. It is not a guarantee and not a measurement.</p>
            </Card>
          </div>
          <div className="tq-stack">
            <Card title="Prediction summary" id="c-sum">
              {p && (
                <dl className="tq-kv"><dt>Action</dt><dd>{title(p.action)}</dd><dt>Status</dt><dd><StatusPill status={p.status} /></dd>
                  <dt>Current {title(signal)}</dt><dd className="tq-num">{fmt(cur[signal], dg)}</dd>
                  <dt>Predicted @120 s</dt><dd className="tq-num">{fmt(p.mean_at_30_60_120?.[signal]?.[2], dg)}</dd>
                  <dt>90% interval @120 s</dt><dd className="tq-num">{fmt(p.lo_120?.[signal], dg)}–{fmt(p.hi_120?.[signal], dg)}</dd>
                  <dt>Interval method</dt><dd>{p.interval_method || '—'}</dd><dt>Validated by experiments</dt><dd>{p.validated_by_experiments ? 'yes' : 'no'}</dd></dl>)}
              <p className="tq-muted">A prediction never commands the motor. Actions are proposed by the decision gate and checked by the Safety Supervisor.</p>
              {go && <CardLink onClick={() => go('interventions')}>Open Interventions</CardLink>}
            </Card>
            <PredictionChecks checks={d.predictionChecks || []} />
          </div>
        </div>)}
    </>
  );
}

/* ------------------------------------------------------------------ 5. Diagnostic tests (C4) */
// Descriptions of the backend test library (backend/torqva/diagnostics.py). This page shows what the pipeline ran and logged;
// it never runs a test, invents a result or sends a motor command itself.
export const TEST_SPECS = {
  T1: {
    code: 'T1', name: 'Speed-Step Dynamic Response (T1)', short: 'Speed step to 70 %', duration_s: 40,
    target: 'Separates imbalance from looseness, and looseness from a faulty vibration channel.',
    method: 'The setpoint is stepped down to 70 % and held for 40 s. With imbalance, the 1x vibration and the 2x+3x harmonics both scale with roughly the square of speed; with looseness the harmonics scale far less steeply. The looseness exponent is a simulation modelling assumption and must be re-fitted on real fault data.',
    signals: ['1x Vibration Exponent', 'Harmonics (2x+3x) Exponent', 'Current-per-RPM Ratio'],
  },
  T3: {
    code: 'T3', name: 'Thermal Equilibrium Observation (T3)', short: 'Observe up to 300 s', duration_s: 300,
    target: 'Separates a cooling failure from an overload.',
    method: 'Speed is held while the housing temperature is compared with the learned thermal model for up to 300 s. The observation is the slope of the difference between the two.',
    signals: ['Housing Thermal Drift Slope (°C / 100 s)'],
  },
  T4: {
    code: 'T4', name: 'Inertial Coast-Down Deceleration (T4)', short: 'Driver disabled', duration_s: 40,
    target: 'Separates friction/overload from cooling or electrical faults.',
    method: 'The driver is disabled and a decay time constant tau is fitted to the speed over the following 40 s. The observation is ln tau.',
    signals: ['Deceleration Time Constant tau', 'ln(tau) Friction Metric'],
  },
};

export function TestsPage({ d, c2c4 }) {
  const [sel, setSel] = useState('T1');
  const spec = TEST_SPECS[sel] || TEST_SPECS.T1;
  const res = lastOf(d.log, 'test_result');
  const inc = d.status?.incident;
  const phase11 = c2c4?.phase11?.c4_calibration;
  const real = c2c4?.c4_realistic_v2 || c2c4?.c4_realistic_v1;
  return (
    <>
      <PageHead title="Diagnostic Tests (C4)" sub="Tests that separate competing fault hypotheses. Run only through the safety supervisor." right={<ProvBadge kind="SIMULATED" />} />
      <div className="tq-split">
        <div className="tq-stack">
          <Card title="Available tests" id="c-avail">
            <div className="tq-stack" role="group" aria-label="Available diagnostic tests">
              {Object.entries(TEST_SPECS).map(([k, x]) => (
                <button type="button" key={k} className="tq-select-card" aria-pressed={sel === k} onClick={() => setSel(k)}>
                  <div className="tq-option-title"><strong>{x.name}</strong><Pill tone="info">{x.duration_s} s</Pill></div>
                  <div className="tq-muted">{x.target}</div>
                </button>))}
            </div>
            <p className="tq-muted">Tests are proposed by the decision gate and run by the pipeline in the simulator after the Safety Supervisor allows them. There is no manual run button, by design.</p>
          </Card>
          <DiagnosticTests log={d.log || []} />
        </div>
        <div className="tq-stack">
          <Card title={`Selected test ${spec.code}`} id="c-sel" right={<Pill tone="info">{spec.short}</Pill>}>
            <p><strong>{spec.name}</strong></p>
            <p className="tq-muted">{spec.target}</p>
            <div className="tq-subpanel"><span className="tq-subpanel-title">How the test works</span><p>{spec.method}</p></div>
            <p className="tq-small"><span className="tq-muted">Observed signals: </span><strong>{spec.signals.join(' · ')}</strong></p>
            <p className="tq-muted">Expected diagnostic value is not shown per test because the backend does not publish a per-test value; measured value is in Evaluation.</p>
          </Card>
          <Card title="Latest result and competing hypotheses" id="c-result" right={<ProvBadge kind="SIMULATED" />}>
            {!res ? <Empty>No diagnostic test has been run in this incident.</Empty> : (
              <><p><strong>{res.test}</strong> observation <span className="tq-num">{(res.obs || []).map((x) => fmt(x, 2)).join(', ')}</span></p><PosteriorBars ranked={res.posterior} label="after test" /></>)}
            {inc && <p className="tq-muted">Tests run in incident {inc.id}: <span className="tq-num">{inc.tests_run ?? 0}</span></p>}
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
export function InterventionsPage({ d, role, actions, error, isPhys: isPhysProp }) {
  const isPhys = isPhysProp ?? isPhysOf(d);
  const provKind = isPhys ? 'MEASURED' : 'SIMULATED';
  const s = d.status || {}; const pend = s.pending_approval; const ctl = canControl(role);
  const gate = [...(d.decisions || [])].reverse().find((x) => x.inputs);
  const sup = (d.log || []).filter((l) => l.kind === 'supervisor').slice(-8).reverse();
  const cmds = (d.commands || []).filter((c) => c.action !== 'HEARTBEAT').slice(-8).reverse();
  return (
    <>
      <PageHead title="Interventions (C3)" sub="What the system proposes, what the gate and Safety Supervisor decided, and what the device acknowledged." right={<ProvBadge kind={provKind} />} />
      <p className="tq-callout" role="note">This page never commands a motor directly. Every action passes the decision gate and the deterministic Safety Supervisor on the backend; the frontend can only approve or reject what the backend proposes.</p>
      <div className="tq-split">
        <div className="tq-stack">
          <Card title="Decision gate" id="c-gate" right={<ProvBadge kind={provKind} />}>
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
          <Card title="Safety supervisor decisions" id="c-sup" right={<ProvBadge kind={provKind} />}>
            {!sup.length ? <Empty>No decisions yet.</Empty> : (
              <ul className="tq-list">{sup.map((x, i) => (<li key={i}><Pill tone={x.verdict === 'ALLOW' ? 'ok' : x.verdict === 'DEFER' ? 'wait' : 'crit'}>{x.verdict}</Pill> {title(x.action)}<span className="tq-muted"> — {x.reasons.map(title).join(', ')}</span></li>))}</ul>)}
          </Card>
          <Card title="Action history: commands and device acknowledgements" id="c-cmd" right={<ProvBadge kind={provKind} />}>
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
export function RecoveryPage({ d, isPhys: isPhysProp }) {
  const isPhys = isPhysProp ?? isPhysOf(d);
  const provKind = isPhys ? 'MEASURED' : 'SIMULATED';
  const outs = (d.outcomes || []).slice().reverse(); const s = d.status || {};
  const verifying = s.incident?.state === 'VERIFYING_RECOVERY';
  return (
    <>
      <PageHead title="Recovery Verification (C5)" sub="Recovery is declared only from fresh, valid samples observed after the device acknowledged an action." right={<ProvBadge kind={provKind} />} />
      <p className="tq-callout warn" role="note">A prediction of improvement is not a verified recovery.{isPhys ? '' : ' Records below are simulator observations, not hardware evidence.'}</p>
      <div className="tq-grid">
        {verifying && <Card title="Verifying recovery" id="c-ver"><Pill tone="wait">collecting fresh samples</Pill><p className="tq-muted">Verification is still in progress.</p></Card>}
        <Card title="Outcomes" id="c-out" className="tq-span" right={<ProvBadge kind={provKind} />}>
          {!outs.length ? <Empty>No incident has been verified yet. Verified outcomes appear here after an acknowledged action and a fresh observation window.</Empty> : outs.map((o) => (
            <article key={o.incident} className="tq-outcome">
              <h4>{o.incident}{' '}<Pill tone={o.outcome === 'RECOVERED' ? 'ok' : o.outcome === 'UNRESOLVED' ? 'crit' : 'warn'}>{title(o.outcome)}</Pill>{' '}<ProvBadge kind={provKind} /></h4>
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
export function LearningPage({ d, children, isPhys: isPhysProp }) {
  const isPhys = isPhysProp ?? isPhysOf(d);
  const provKind = isPhys ? 'MEASURED' : 'SIMULATED';
  const cases = d.cases || [];
  return (
    <>
      <PageHead title="Learning and Model Management (C6)" sub="Learning dataset and the operator-attested healthy reference used by adaptive C1." right={<ProvBadge kind={provKind} />} />
      <Card title="Learning dataset" id="c-learn" right={<ProvBadge kind={provKind} />}>
        {!cases.length ? <Empty>No eligible cases recorded in this run. Blocked, rejected or aborted actions never count.</Empty> : (
          <ul className="tq-list">{cases.map((c) => (<li key={c.label + c.outcome + c.session}><strong>{c.label}</strong> · {c.outcome} · label source {c.label_source} · executed {String(c.executed)} <ProvBadge kind={provKind} /></li>))}</ul>)}
        <p className="tq-muted">No model training, promotion or rollback of C2/C4 models is exposed: those are not implemented as operator actions. The attestation workflow below is the only model-management feature that exists.</p>
      </Card>
      <div className="tq-mt">{children}</div>
    </>
  );
}

/* ------------------------------------------------------------------ 10. Devices and settings */
export function DevicesPage({ d, user, role, rows, auditError, apiBase, device, isPhys: isPhysProp }) {
  const isPhys = isPhysProp ?? isPhysOf(d);
  const conn = device?.snap?.connection; const port = device?.snap?.port;
  const s = d.status || {}; const hasSim = s.t !== undefined && s.t !== null; const sc = s.scenario;
  return (
    <>
      <PageHead title="Devices and Settings" sub="Connected devices, operating mode and application settings." right={<Pill tone={isPhys ? "ok" : "info"}>{isPhys ? "PHYSICAL HARDWARE mode" : "SIMULATION mode"}</Pill>} />
      <div className="tq-split">
        <div className="tq-stack">
          <Card title="Devices" id="c-devices">
            <table className="tq-table"><caption className="tq-sr">Devices</caption><thead><tr><th scope="col">Device</th><th scope="col">Type</th><th scope="col">Connection</th></tr></thead>
              <tbody>
                <tr><td>Physical ESP32 motor controller</td><td>physical device</td><td>{conn === 'CONNECTED' ? <Pill tone="ok">{port ? `connected (${port})` : 'connected'}</Pill> : <Pill tone="off">not connected</Pill>}</td></tr>
                <tr><td>Simulated motor 01</td><td><ProvBadge kind="SIMULATED" /> software simulator</td><td>{hasSim ? <Pill tone="ok">simulator running</Pill> : <Pill tone="off">idle</Pill>}</td></tr>
              </tbody></table>
          </Card>
          <Card title={isPhys ? "Physical device details" : "Simulated device details"} id="c-devd" right={<ProvBadge kind={isPhys ? "MEASURED" : "SIMULATED"} />}>
            {!isPhys && !hasSim ? <Empty>No simulation has been started.</Empty> : (
              <dl className="tq-kv"><dt>Setpoint</dt><dd className="tq-num">{fmt(s.device?.setpoint_rpm, 0)} rpm</dd><dt>Emergency stop</dt><dd>{s.device?.estop ? `engaged (${s.device.estop_reason})` : 'clear'}</dd>
                <dt>{isPhys ? 'Origin' : 'Injected fault'}</dt><dd>{isPhys ? 'physical device' : sc?.fault ? `${title(sc.fault)} (severity ${sc.severity})` : 'none'}</dd>
                {!isPhys && <><dt>Seed</dt><dd className="tq-num">{sc?.seed}</dd></>}
                <dt>Human approval required</dt><dd>{sc?.human_approval_required ? 'yes' : 'no'}</dd></dl>)}
            <h4>Sensor availability</h4>
            <ul className="tq-list">{['rpm', 'current', 'housing', 'vib_rms'].map((k) => (<li key={k}>{title(k)} {s.last_window?.[k] == null ? <Pill tone="off">unavailable</Pill> : <Pill tone="ok">{isPhys ? 'reporting (live HW)' : 'reporting (simulated)'}</Pill>}</li>))}</ul>
          </Card>
        </div>
        <div className="tq-stack">
          <Card title="Application settings" id="c-settings">
            <dl className="tq-kv"><dt>Signed in as</dt><dd>{user.user} ({role})</dd><dt>Operating mode</dt><dd>{isPhys ? 'PHYSICAL' : (s.mode || 'SIMULATION')}</dd><dt>API</dt><dd className="tq-num">{apiBase || 'same origin (/api/torqva)'}</dd>
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
