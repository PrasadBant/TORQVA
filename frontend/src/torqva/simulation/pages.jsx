import React, { useMemo, useState } from 'react';
import { Gauge, Thermometer, Waves, Zap, Plug } from 'lucide-react';
import { Card, Empty, ErrorBox, Pill, ProvBadge, fmt, title, PageHead, AlertPanel, ChartPanel, MetricList, DataTable, Tabs, TabPanel, SourceTag } from '../shared/components.jsx';
import { Sparkline, TrendLines } from '../shared/lazyCharts.jsx';
import { C2C4Validation } from './c2c4.jsx';
import { ScenarioStudio, FAULTS, canControl } from './scenario.jsx';
import { TEST_SPECS } from '../shared/diagnostics.js';
import { isPhysOf, samplesOf } from './simdata.js';

export { TEST_SPECS };
export { FAULTS, canControl };
export { isPhysOf };
// C1/C2/C4 pages live in analysis.jsx and C3/C5/C6 pages in assurance.jsx; re-exported here for older imports.
export { DiagnosticsPage, PredictionsPage, TestsPage } from './analysis.jsx';
export { ApprovalCard, InterventionsPage, RecoveryPage, LearningPage } from './assurance.jsx';

/** A latest-value tile. A missing or invalid sensor reads UNAVAILABLE, never zero. */
export function Kpi({ label, value, unit, digits = 1, data, dataKey, color = 'var(--tq-chart-1)', note, prov = 'MEASURED', icon: I, primary = false, fresh = null }) {
  const missing = value === null || value === undefined || Number.isNaN(value);
  return (
    <div className={`tq-kpi ${missing ? 'tq-unavailable' : ''} ${primary ? 'tq-kpi-primary' : ''}`.trim()}>
      <div className="tq-kpi-label"><span className="tq-kpi-head">{I && <span className="tq-kpi-icon" aria-hidden="true"><I size={15} /></span>}<span>{label}</span></span><ProvBadge kind={prov} /></div>
      <div className="tq-kpi-value tq-num">{missing ? 'UNAVAILABLE' : fmt(value, digits)}{!missing && <span className="tq-kpi-unit">{unit}</span>}</div>
      {data?.length > 1 && (
        <div className="tq-kpi-spark" aria-hidden="true"><Sparkline data={data} dataKey={dataKey} color={color} height={primary ? 56 : 40} /></div>)}
      {note && <div className="tq-kpi-note">{note}</div>}
      {fresh && <div className="tq-kpi-freshness"><span className={`tq-kpi-status-tag ${fresh.state}`}>{fresh.text}</span></div>}
    </div>
  );
}

function TrendChart({ data, lines, height = 200, yDomain, label, digits = 2, unit = '', marks }) {
  return <div role="img" aria-label={marks?.length ? `${label}, with ${marks.length} event mark(s)` : label} className="tq-chart"><TrendLines data={data} lines={lines} height={height} yDomain={yDomain} digits={digits} unit={unit} marks={marks} /></div>;
}

/** The scenario controls (see scenario.jsx); kept under this name for the Live Monitor and older imports. */
export const SimControls = ScenarioStudio;

/* ------------------------------------------------------------------ 1. Overview: see overview.jsx */

/* ------------------------------------------------------------------ 2. Live monitoring */
const RANGES = [['60', '60 s'], ['180', '3 min'], ['all', 'All']];
const SIGNALS = [['rpm', 'Speed'], ['housing', 'Temperature'], ['vib', 'Vibration'], ['current', 'Current']];
// Pipeline events worth seeing against the telemetry: the backend's own log records, plus the scenario's injection time (ground truth, simulation only).
const MARK_KINDS = { incident_opened: 'incident opened', test_result: 'test', mandatory_stop: 'mandatory stop', recovery_assessment: 'C5 verdict', incident_closed: 'incident closed' };
export function eventMarks(d, data) {
  if (!data.length) return [];
  const t0 = data[0].t; const t1 = data[data.length - 1].t;
  const snap = (t) => data.reduce((b, x) => (Math.abs(x.t - t) < Math.abs(b.t - t) ? x : b), data[0]).t;   // the x axis is categorical: place the line on the nearest sample
  const sc = d.status?.scenario;
  const raw = (d.log || []).filter((l) => MARK_KINDS[l.kind] && Number.isFinite(l.t)).map((l) => ({ t: l.t, label: MARK_KINDS[l.kind] }));
  if (sc?.fault && Number.isFinite(sc.inject_after_s)) raw.push({ t: sc.inject_after_s, label: 'fault injected (scenario)' });
  return raw.filter((m) => m.t >= t0 && m.t <= t1).sort((x, y) => x.t - y.t).map((m, i) => ({ ...m, n: i + 1, at: snap(m.t) }));
}
// Sensor colours (one per signal everywhere), units and digits.
const SIG = {
  rpm: ['Speed', 'rpm', 0, 'var(--tq-sig-rpm)', Gauge],
  housing: ['Housing temperature', '°C', 1, 'var(--tq-sig-temp)', Thermometer],
  vib_rms: ['Vibration RMS', 'g', 3, 'var(--tq-sig-vib)', Waves],
  current: ['Motor current', 'A', 2, 'var(--tq-sig-current)', Zap],
  voltage: ['Supply voltage', 'V', 2, 'var(--tq-sig-voltage)', Plug],
};
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const windowName = (r) => (r === 'all' ? 'all windows (≤300)' : `last ${Number(r) < 120 ? `${r} s` : `${Number(r) / 60} min`}`);

export function LivePage({ d, role, actions, running, setRunning, busy, error, stale, deviceLive, device, isPhys: isPhysProp, stepSeconds, go }) {
  const isPhys = isPhysProp ?? isPhysOf(d);
  const provKind = isPhys ? 'MEASURED' : 'SIMULATED';
  const [range, setRange] = useState('all');
  const [shown, setShown] = useState(() => new Set(SIGNALS.map(([k]) => k)));
  const [withEvents, setWithEvents] = useState(false);
  const toggle = (k) => setShown((x) => { const n = new Set(x); if (n.has(k)) { if (n.size > 1) n.delete(k); } else n.add(k); return n; });   // at least one chart stays visible
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
  const marks = useMemo(() => (withEvents ? eventMarks(d, data) : []), [withEvents, d, data]);
  const last = data[data.length - 1]; const w = s.last_window;
  const missing = ['rpm', 'housing', 'vib_rms', 'current'].filter((k) => w && (w[k] === null || w[k] === undefined));
  const physical = (deviceOn && device.snap.origin === 'physical_device') || isPhys;
  const selector = deviceOn ? (
    <div className="tq-seg" role="group" aria-label="Data source">
      <button className="tq-btn" aria-pressed={source === 'simulation'} onClick={() => setSource('simulation')}>Simulation</button>
      <button className="tq-btn" aria-pressed={source === 'device'} onClick={() => setSource('device')}>{physical ? 'Physical device' : 'Connected device (firmware simulation)'}</button>
    </div>) : null;
  if (deviceOn && source === 'device') {
    return (<><PageHead title="Live Monitor" sub="Readings reported by the connected device over USB serial; stale data is marked, never shown as live." right={<Pill tone={physical ? 'ok' : 'warn'}>{physical ? 'PHYSICAL DEVICE' : 'DEVICE (FIRMWARE SIMULATION MODE)'}</Pill>} />
      <div className="tq-toolbar"><span className="tq-toolbar-label">Source</span>{selector}</div>{deviceLive}</>);
  }
  const invalid = w && w.valid === false;
  const latest = (k) => (invalid ? null : num(w?.[k]));          // an invalid window is unavailable, never a number
  const V = latest('voltage'); const I = latest('current');
  const power = V !== null && I !== null ? V * I : null;
  const foot = `${windowName(range)} · simulation time${last ? ` t = ${fmt(last.t, 0)} s` : ''}`;
  const panel = (key, id, label, lines) => {
    const [name, unit, digits, color, Icon] = SIG[key];
    const v = latest(key);
    return (
      <ChartPanel key={key} id={id} testid={`live-chart-${key}`} title={<><Icon size={15} aria-hidden="true" style={{ color }} /> {name}</>}
        value={v === null ? null : fmt(v, digits)} unit={unit} prov={provKind} right={stale ? <SourceTag kind="STALE" /> : null} foot={foot}>
        <TrendChart data={data} marks={marks} label={label} digits={digits} unit={unit} lines={lines} />
      </ChartPanel>);
  };
  return (
    <>
      <PageHead title="Live Monitor" sub={isPhys ? 'Telemetry the backend reports as measured on the physical device.' : 'Real-time telemetry from the software simulator, refreshed every few seconds while it runs.'}
        right={<><ProvBadge kind={provKind} />{stale ? <Pill tone="crit">stale</Pill> : <Pill tone={isPhys ? 'ok' : running ? 'ok' : 'off'}>{isPhys ? 'live HW' : running ? 'running' : 'paused'}</Pill>}</>} />
      <div className="tq-toolbar tq-mon-toolbar">
        {selector && <><span className="tq-toolbar-label">Source</span>{selector}</>}
        <span className="tq-toolbar-label">Time range</span>
        <div className="tq-seg" role="group" aria-label="Time range">
          {RANGES.map(([k, name]) => <button key={k} className="tq-btn" aria-pressed={range === k} onClick={() => setRange(k)}>{name}</button>)}
        </div>
        <span className="tq-toolbar-label">Signals</span>
        <div className="tq-seg" role="group" aria-label="Charts shown" data-testid="live-signals">
          {SIGNALS.map(([k, name]) => <button key={k} type="button" className="tq-btn" aria-pressed={shown.has(k)} onClick={() => toggle(k)}>{name}</button>)}
        </div>
        <label className="tq-check tq-small"><input type="checkbox" checked={withEvents} onChange={(e) => setWithEvents(e.target.checked)} data-testid="live-events" /> Mark pipeline events on the charts</label>
      </div>
      {withEvents && <p className="tq-small tq-muted" data-testid="live-marks">{marks.length ? <>Marked on the charts: {marks.map((m) => <span key={m.n} className="tq-mark-key"><strong>{m.n}</strong> {m.label} (t = {fmt(m.t, 0)} s)</span>)}</> : 'No pipeline event falls inside this time window.'}</p>}
      {stale && <AlertPanel tone="crit" title="Telemetry is STALE" testid="live-stale"><p>The backend is not answering; the values shown are the last ones received, not live data.</p></AlertPanel>}
      {missing.length > 0 && <p className="tq-callout crit" role="alert">Missing sensor values: {missing.map(title).join(', ')}. They are shown as unavailable, not as zero.</p>}
      {invalid && <p className="tq-callout crit" role="alert">The latest window is flagged invalid, so its values are shown as unavailable.</p>}
      {s.t !== undefined && last && s.t - last.t > 30 && <p className="tq-callout warn">Latest telemetry window is {fmt(s.t - last.t, 0)} s older than simulation time.</p>}
      <div className="tq-mon-livegrid">
        <div className="tq-stack">
          {!data.length ? <Card title="Live telemetry" id="c-live"><Empty>No telemetry yet.</Empty></Card> : (
            <div className="tq-mon-charts">
              {shown.has('rpm') && panel('rpm', 'c-rpm', 'Speed over time', [{ key: 'rpm', name: `rpm (${isPhys ? 'HW' : 'sim'})`, color: 'var(--tq-sig-rpm)' }, { key: 'setpoint', name: 'setpoint', color: 'var(--tq-chart-ink)', dash: '4 3' }])}
              {shown.has('housing') && panel('housing', 'c-th', 'Housing temperature over time', [{ key: 'housing', name: 'housing °C', color: 'var(--tq-sig-temp)' }])}
              {shown.has('vib') && panel('vib_rms', 'c-vib', 'Vibration over time', [{ key: 'vib_rms', name: 'vibration g', color: 'var(--tq-sig-vib)' }])}
              {shown.has('current') && panel('current', 'c-cur', 'Current over time', [{ key: 'current', name: 'current A', color: 'var(--tq-sig-current)' }])}
            </div>)}
          <Card title="Latest telemetry samples" id="c-samples" sub={data.length ? `The last ${Math.min(10, data.length)} one-second windows, newest first, with the C1 score. — means no value, never zero.` : 'No samples yet'}>
            <DataTable testid="live-samples" caption="Latest telemetry windows" rows={data.slice(-10).reverse()} rowKey={(x) => x.t} empty="No samples."
              columns={[{ key: 't', label: 't (s)', align: 'num', render: (x) => fmt(x.t, 0) }, { key: 'rpm', label: 'Speed (rpm)', align: 'num', render: (x) => fmt(x.rpm, 0) },
                { key: 'housing', label: 'Housing (°C)', align: 'num', render: (x) => fmt(x.housing, 1) }, { key: 'vib', label: 'Vibration (g)', align: 'num', render: (x) => fmt(x.vib_rms, 3) },
                { key: 'cur', label: 'Current (A)', align: 'num', render: (x) => fmt(x.current, 2) }, { key: 'score', label: 'Score ÷ threshold', align: 'num', render: (x) => (x.score == null ? '—' : fmt(x.score, 2)) }]} />
          </Card>
        </div>
        <div className="tq-stack tq-sticky-side">
          <Card title="Telemetry details" id="c-livedetails" sub={w ? `window t = ${fmt(w.t, 0)} s${stale ? ' · STALE' : ''}` : 'no window yet'}>
            <MetricList label="Telemetry details" testid="live-metrics" items={[
              ...Object.entries(SIG).map(([k, [name, unit, digits, color, Icon]]) => ({ key: k, label: name, icon: Icon, color, value: latest(k) === null ? null : fmt(latest(k), digits), unit, prov: provKind, missingText: 'UNAVAILABLE' })),
              { key: 'power', label: 'Power (V × I)', icon: Zap, color: 'var(--tq-sig-power)', value: power === null ? null : fmt(power, 1), unit: 'W', prov: 'DERIVED', missingText: 'UNAVAILABLE' },
              { key: 'sp', label: 'Setpoint', value: num(s.device?.setpoint_rpm) === null ? null : fmt(s.device.setpoint_rpm, 0), unit: 'rpm' },
              { key: 'mode', label: 'Mode', value: isPhys ? 'PHYSICAL' : (s.mode || 'SIMULATION') },
              { key: 'src', label: 'Data source', value: isPhys ? 'physical device (backend)' : 'software simulator' },
              { key: 'upd', label: 'Last updated', value: w ? `t = ${fmt(w.t, 0)} s` : null },
            ]} />
          </Card>
          <SimControls d={d} role={role} actions={actions} running={running} setRunning={setRunning} busy={busy} error={error} stale={stale} stepSeconds={stepSeconds} compact go={go} />
        </div>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ 10. Devices and settings */
const SETTINGS_TABS = [{ key: 'inventory', label: 'Device inventory' }, { key: 'app', label: 'Application info' }, { key: 'session', label: 'Session' }, { key: 'audit', label: 'Admin audit log' }];
export function DevicesPage({ d, user, role, rows, auditError, apiBase, device, isPhys: isPhysProp, go, running, physicalMode }) {
  const isPhys = isPhysProp ?? isPhysOf(d);
  const [tab, setTab] = useState('inventory');
  const snap = device?.snap;
  const conn = snap?.connection; const port = snap?.port;
  const s = d.status || {}; const hasSim = s.t !== undefined && s.t !== null;
  const admin = role === 'admin';
  const inventory = [
    { key: 'phys', name: 'Physical ESP32 motor controller', type: 'physical device (USB serial)', fw: snap?.handshake ? (snap.firmware || null) : null, id: snap?.handshake ? (snap.device_id || null) : null,
      status: conn === 'CONNECTED' ? <Pill tone="ok">{port ? `connected (${port})` : 'connected'}</Pill> : <Pill tone="off">not connected</Pill>,
      open: go ? <button type="button" className="tq-linkbtn" onClick={() => go('device')}>Connection and diagnostics</button> : null },
    { key: 'sim', name: 'Simulated motor 01', type: <><ProvBadge kind="SIMULATED" /> software simulator</>, fw: null, id: null,
      status: physicalMode ? <Pill tone="off">not used in Physical mode</Pill> : running ? <Pill tone="ok">simulator running</Pill> : hasSim ? <Pill tone="info">paused</Pill> : <Pill tone="off">idle</Pill>,
      open: go ? <button type="button" className="tq-linkbtn" onClick={() => go('scenario')}>Scenario Studio</button> : null },
  ];
  // Every panel stays in the page (hidden unless selected), so each tab's aria-controls points at a real element.
  const panel = (key, body) => <div key={key} hidden={tab !== key}><TabPanel tab={key} idBase="tq-set">{body}</TabPanel></div>;
  return (
    <>
      <PageHead title="Devices & Settings" sub="Manage devices, the session and application information." right={<Pill tone={isPhys ? 'ok' : 'info'}>{isPhys ? 'PHYSICAL HARDWARE mode' : 'SIMULATION mode'}</Pill>} />
      <Tabs label="Settings sections" idBase="tq-set" value={tab} onChange={setTab} tabs={SETTINGS_TABS.map((t) => (t.key === 'audit' && !admin ? { ...t, label: 'Admin audit log (admin only)' } : t))} />
      {panel('inventory', (
        <Card title="Devices" id="c-devices" sub="Every device this application can talk to">
          {/* The page link sits under the device name (no separate column), so the table fits laptop widths and stacks on phones. */}
          <DataTable caption="Devices" rows={inventory} rowKey={(r) => r.key} testid="dev-inventory" stack
            columns={[{ key: 'name', label: 'Device', render: (r) => <span className="tq-inv-name"><strong>{r.name}</strong>{r.open}</span> }, { key: 'type', label: 'Type', render: (r) => r.type },
              { key: 'id', label: 'Device id', render: (r) => r.id || '—' }, { key: 'fw', label: 'Firmware', render: (r) => r.fw || '—' },
              { key: 'status', label: 'Connection', render: (r) => r.status }]} />
        </Card>))}
      {panel('app', (
        <Card title="Application information" id="c-settings">
          <dl className="tq-kv"><dt>Operating mode</dt><dd>{isPhys ? 'PHYSICAL' : (s.mode || 'SIMULATION')}</dd><dt>API</dt><dd className="tq-num">{apiBase || 'same origin (/api/torqva)'}</dd>
            <dt>C2 predictor</dt><dd>{s.models?.c2_variant || '—'} (experimental variants are opt-in via server environment)</dd></dl>
          <p className="tq-small tq-muted">Safety limits are enforced by the backend and cannot be changed here.</p>
        </Card>))}
      {panel('session', (
        <Card title="Current session" id="c-session">
          <dl className="tq-kv"><dt>Signed in as</dt><dd>{user.user} ({role})</dd>
            <dt>Simulator controls</dt><dd>{role === 'operator' || role === 'admin' ? 'start, step and approve' : 'read-only'}</dd>
            <dt>Physical motor</dt><dd>{admin ? 'START and speed requests (still checked by the backend) and STOP' : 'STOP only'}</dd>
            <dt>Token storage</dt><dd>this browser tab only</dd></dl>
          <p className="tq-small tq-muted">Permission-aware: operator or admin may start simulations and approve actions; viewers are read-only. The backend enforces the same rules.</p>
        </Card>))}
      {panel('audit', (
        <Card title="Audit history (append-only)" id="c-aud">
          {!admin ? <Empty>The audit log is visible to admins only.</Empty> : (<>
            <ErrorBox error={auditError} />
            <DataTable testid="audit-trail" caption="Audit history" rows={(rows || []).slice(-30).reverse()} rowKey={(r) => r.n} empty="No audit events yet."
              columns={[{ key: 'n', label: '#', align: 'num' }, { key: 'kind', label: 'Kind' }, { key: 'actor', label: 'Actor' },
                { key: 'detail', label: 'Detail', render: (r) => <span className="tq-muted">{JSON.stringify(r.detail).slice(0, 120)}</span> }]} />
            {rows?.length > 30 && <p className="tq-small tq-muted">Showing the latest 30 of {rows.length} entries.</p>}
          </>)}
        </Card>))}
    </>
  );
}

export { C2C4Validation };
