import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Usb, Unplug, Cpu, HeartPulse, Gauge, Zap, Thermometer, Plug, Move3d, Activity, Waves, SlidersHorizontal, Radio, Wifi } from 'lucide-react';
import { plainify } from '../shared/plain.js';
import { api, getToken, ApiError } from '../api.js';
import { Card, Empty, ErrorBox, Pill, fmt, title, PageHead, CardLink, Disclosure, AlertPanel, LinkButton, MetricList, ChartPanel, DataTable, SourceTag } from '../shared/components.jsx';
import { HistoryChart } from '../shared/lazyCharts.jsx';

const defaultWs = (import.meta.env && import.meta.env.MODE === 'test') ? null : (url) => new WebSocket(url);
export const canOperate = () => true;
const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);

/** Live device state: REST snapshot + read-only WebSocket with reconnection. Telemetry is only ever "live" while the server says it is fresh AND frames keep arriving.
 * When the backend cannot be reached (and the socket is not delivering), the last snapshot is kept but reported as NOT fresh: its values are the last ones
 * received, never live. A rejected session (HTTP 401, or the socket closed with 4401) calls onAuthLost. */
export function useDeviceStream(enabled, wsFactory = defaultWs, pollMs = 3000, onAuthLost) {
  const [snap, setSnap] = useState(null);
  const [commands, setCommands] = useState([]);
  const [events, setEvents] = useState([]);
  const [ws, setWs] = useState('idle');                 // idle | connecting | open | closed
  const [lastMsg, setLastMsg] = useState(null);
  const [error, setError] = useState(null);
  const [unreachable, setUnreachable] = useState(false);
  const alive = useRef(true);
  const authLost = useRef(onAuthLost);
  authLost.current = onAuthLost;

  // Repeated identical events (for example protocol errors from a board that sends non-TORQVA text) are merged into one row with a count, never listed thousands of times.
  const pushEvent = useCallback((e) => setEvents((x) => {
    const n = typeof e.data?.count === 'number' ? e.data.count : 1;
    if (x.length && x[0].name === e.name && x[0].data?.code === e.data?.code) return [{ ...x[0], ts: e.ts, total: (x[0].total || 1) + n }, ...x.slice(1)];
    return [{ ...e, total: n, k: `${e.ts}-${Math.random()}` }, ...x].slice(0, 40);
  }), []);
  const refresh = useCallback(async () => {
    try {
      const [s, c] = await Promise.all([api.deviceStatus(), api.deviceCommands()]);
      if (!alive.current) return;
      if (isObj(s)) { setSnap(s); setError(null); setUnreachable(false); }
      if (isObj(c) && Array.isArray(c.commands)) setCommands(c.commands);
    } catch (e) {
      if (!alive.current) return;
      setError(e);
      if (e instanceof ApiError && e.status === 401) authLost.current?.();
      else if (!(e instanceof ApiError)) setUnreachable(true);          // network failure or timeout: the server is not answering (an HTTP error means it is)
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    if (!enabled) return undefined;
    refresh();
    const poll = setInterval(refresh, pollMs);          // fallback while the socket is down, and to refresh the command table
    let sock = null; let retry = 0; let timer = null;
    const open = () => {
      if (!wsFactory || !alive.current) return;
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      setWs('connecting');
      try { sock = wsFactory(`${proto}://${window.location.host}/api/torqva/ws`); } catch { setWs('closed'); return; }
      sock.onopen = () => { try { sock.send(JSON.stringify({ type: 'auth', token: getToken() })); } catch { /* socket closed before auth */ } };
      sock.onmessage = (ev) => {
        let m; try { m = plainify(JSON.parse(ev.data)); } catch { return; }          // malformed frames are ignored, never trusted; prose in product language
        if (!isObj(m)) return;
        setLastMsg(Date.now());
        setUnreachable(false);
        if (m.type === 'snapshot' && isObj(m.data)) { retry = 0; setWs('open'); setSnap(m.data); if (Array.isArray(m.commands)) setCommands(m.commands); }
        else if (m.type === 'event' && typeof m.name === 'string') {
          if (m.name === 'telemetry' && isObj(m.data)) setSnap((s) => ({ ...(s || {}), ...m.data }));
          else {
            pushEvent(m);
            if (['device_disconnected', 'device_restarted', 'command_sent', 'command_rejected', 'command_acknowledged', 'command_executed', 'command_timed_out', 'command_unknown_outcome', 'telemetry_stale', 'safety_fault_latched', 'device_state_changed'].includes(m.name)) refresh();
          }
        }
      };
      const lost = (ev) => {
        if (!alive.current) return;
        setWs('closed');
        if (ev?.code === 4401) { authLost.current?.(); return; }       // the server rejected the session: do not keep reconnecting with it
        retry += 1; timer = setTimeout(open, Math.min(15000, 1000 * 2 ** Math.min(retry, 4)));   // exponential backoff, capped
      };
      sock.onclose = lost;
      sock.onerror = () => { try { sock.close(); } catch { /* already closed */ } };
    };
    open();
    return () => { alive.current = false; clearInterval(poll); if (timer) clearTimeout(timer); if (sock) { sock.onclose = null; try { sock.close(); } catch { /* closing */ } } };
  }, [enabled, refresh, wsFactory, pollMs, pushEvent]);

  const shown = useMemo(() => (unreachable && snap ? { ...snap, telemetry_fresh: false } : snap), [unreachable, snap]);
  return { snap: shown, commands, events, ws, lastMsg, error, unreachable, refresh };
}

export function originOf(snap) {
  if (!snap || !snap.handshake) return { label: 'SIMULATION', tone: 'info', physical: false };
  if (snap.origin === 'physical_device') return { label: 'PHYSICAL DEVICE', tone: 'ok', physical: true };
  return { label: 'DEVICE (FIRMWARE SIMULATION MODE)', tone: 'warn', physical: false };
}

export const ago = (unix) => (unix ? `${fmt(Math.max(0, Date.now() / 1000 - unix), 1)} s ago` : 'never');
/** Wall-clock time of a unix timestamp (seconds), or '—'. */
export const clock = (unix) => (Number.isFinite(unix) && unix > 0 ? new Date(unix * 1000).toLocaleTimeString() : '—');

/** How the device is reached right now, from the backend's own record of the active transport (null = no link). A Wi-Fi link is "authenticating"
 *  until the device handshake (per-device key) has completed: an open socket alone is never shown as a working device link. */
export function transportOf(snap) {
  const t = snap?.transport?.kind;
  if (!t || !snap?.connection || snap.connection === 'DISCONNECTED' || snap.connection === 'ERROR') return null;
  if (t === 'wifi') return snap?.session?.active ? 'Wi-Fi' : 'Wi-Fi (authenticating)';
  if (t === 'usb') return 'USB';
  return null;
}

function ConnPill({ snap }) {
  const c = snap?.connection || 'DISCONNECTED';
  const tone = c === 'CONNECTED' ? 'ok' : c === 'STALE' || c === 'CONNECTING' ? 'warn' : c === 'ERROR' ? 'crit' : 'off';
  return <Pill tone={tone}>{c}</Pill>;
}

/** Sensor names and status words used by the device pages (the backend's sensor_status keys and values). */
export const SENSOR_NAME = { rpm: 'Speed (Hall sensor)', current: 'Current', voltage: 'DC bus voltage', power: 'Motor power', housing: 'Motor temperature', ambient: 'Ambient temperature',
  acceleration: 'Accelerometer', vibration_rms: 'Vibration RMS', duty: 'Drive duty', setpoint: 'Setpoint' };
const SENSOR_ICON = { rpm: Gauge, current: Zap, voltage: Plug, power: Zap, housing: Thermometer, ambient: Thermometer, acceleration: Move3d, vibration_rms: Waves };
const SENSOR_WORDS = { valid: 'Reading valid', unavailable: 'Not reported by this firmware, or no frame yet', invalid: 'Sensor fault: the reading is rejected', stale: 'No recent update', missing: 'No reading' };
const sensorTone = (v) => (v === 'valid' ? 'ok' : v === 'unavailable' ? 'off' : 'warn');

/* ------------------------------------------------------------------ Device connection */
export function DevicePage({ stream, role, go, simMode = false, embedded = false }) {
  const { snap, events, ws, error } = stream;
  const [ports, setPorts] = useState([]);
  const [form, setForm] = useState({ port: '', baud: 115200, expected: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const admin = true;
  // In Physical mode a missing handshake is a disconnected device, not simulation (the app mode is chosen explicitly in the shell).
  const o = !snap?.handshake && !simMode ? { label: 'NO DEVICE HANDSHAKE', tone: 'off', physical: false } : originOf(snap);
  useEffect(() => { api.devicePorts().then((r) => setPorts(Array.isArray(r?.ports) ? r.ports : [])).catch(() => setPorts([])); }, []);
  const act = (fn) => async () => { setBusy(true); setErr(null); try { await fn(); } catch (e) { setErr(e); } finally { setBusy(false); stream.refresh(); } };
  const connected = snap && snap.connection && snap.connection !== 'DISCONNECTED' && snap.connection !== 'ERROR';
  const bl = snap?.control_blockers || ['DEVICE NOT CONNECTED'];
  const c = snap?.counters || {};
  const headTone = snap?.connection === 'ERROR' ? 'crit' : !connected ? 'off' : o.physical ? (snap.telemetry_fresh ? 'ok' : 'warn') : 'warn';
  const via = transportOf(snap);
  const baseWord = snap?.connection === 'ERROR' ? 'Connection error' : !connected ? 'Disconnected' : snap?.connection === 'CONNECTING' ? 'Connecting' : !snap.handshake ? 'No handshake' : !o.physical ? 'Connected (firmware simulation)' : snap.telemetry_fresh ? 'Connected' : 'Connected · telemetry stale';
  const headWord = via && connected ? `${baseWord} — ${via}` : baseWord;
  const wl = snap?.wifi_link;
  const sensors = Object.entries(snap?.sensor_status || {});
  return (
    <>
      {!embedded && <PageHead title="Device" sub="Connection status and device information. The backend owns the USB serial link to the ESP32-S3; the browser never touches the port."
        right={<><Pill tone={o.tone}>{o.label}</Pill><ConnPill snap={snap} /></>} />}
      <AlertPanel tone={simMode ? 'info' : bl.length ? 'warn' : 'info'} testid="dev-readiness" icon={simMode ? Cpu : undefined}
        title={bl.length ? `Physical motion blocked (${bl.length})` : 'No motion blocker reported'}
        action={go && !simMode ? <LinkButton onClick={() => go('control')}>Review readiness and commissioning</LinkButton> : null}>
        {bl.length ? <p>{bl[0]}{bl.length > 1 ? ` and ${bl.length - 1} more.` : '.'}</p> : <p>Direct operator control is active on the connected device.</p>}
        {go && simMode && <p>Physical Motor Control is available in Physical mode. To run the simulated motor, use <button type="button" className="tq-linkbtn" data-testid="dev-to-scenario" onClick={() => go('scenario')}>Scenario Studio</button>.</p>}
      </AlertPanel>

      <div className="tq-mon-devgrid">
        <Card title="Device connection" id="c-devconn" icon={Usb} testid="dev-conn">
          <div className={`tq-mon-connhead tq-${headTone}`}>
            <span className="tq-mon-connicon" aria-hidden="true">{!connected ? <Unplug size={20} /> : snap?.transport?.kind === 'wifi' ? <Wifi size={20} /> : <Usb size={20} />}</span>
            <div>
              <strong data-testid="conn-head">{headWord}</strong>
              <span>{snap?.transport?.kind === 'wifi' ? `Wi-Fi link from ${snap.transport.remote}` : snap?.port ? `Port ${snap.port}` : 'No port open'}{snap?.firmware ? ` · firmware ${snap.firmware}` : ''}{snap?.device_profile ? ` · profile ${snap.device_profile}` : ''}</span>
            </div>
          </div>
          <dl className="tq-kv">
            <dt>State</dt><dd data-testid="state-label"><strong>{snap?.state_label || 'DISCONNECTED'}</strong></dd>
            <dt>Connection method</dt><dd data-testid="conn-method">{via || 'none'}</dd>
            <dt>Link state</dt><dd><ConnPill snap={snap} /></dd>
            <dt>Device authenticated (per-device key)</dt><dd data-testid="conn-auth">{snap?.session?.active ? <Pill tone="ok">yes</Pill> : <Pill tone="off">no</Pill>}</dd>
            <dt>Last device frame</dt><dd>{connected && snap?.last_rx_unix ? ago(snap.last_rx_unix) : 'none'}</dd>
            <dt>Live updates (WebSocket only; says nothing about USB)</dt><dd>{ws === 'open' ? <Pill tone="ok">connected</Pill> : <Pill tone="warn">{ws === 'idle' ? 'off' : ws}</Pill>}</dd>
          </dl>
          {wl && (wl.enabled || wl.events?.length > 0) && (
            <details className="tq-disclosure" data-testid="wifi-link-details">
              <summary>Advanced details: Wi-Fi device link</summary>
              <dl className="tq-kv">
                <dt>Wi-Fi device links</dt><dd>{wl.enabled ? 'accepted by this backend' : 'off (TORQVA_DEVICE_LINK is not set)'}</dd>
                <dt>Active link</dt><dd>{wl.active ? `from ${wl.remote}, since ${clock(wl.since)}` : 'none'}</dd>
                <dt>Connection attempts</dt><dd className="tq-num">{wl.attempts}</dd>
                {wl.usb_autoconnect_paused && <><dt>USB auto-connect</dt><dd>paused while the Wi-Fi link lasts</dd></>}
              </dl>
              {wl.events?.length > 0 && <ol className="tq-mon-events">{wl.events.slice().reverse().map((e, i) => <li key={i}>{clock(e.at)} · {e.kind}{e.remote ? ` · ${e.remote}` : ''}{e.reason ? ` · ${e.reason}` : ''}</li>)}</ol>}
            </details>)}
          {!snap?.handshake && <p className="tq-callout">No device handshake. {simMode ? <>The application is in <strong>SIMULATION</strong>; physical</> : 'Physical'}-device telemetry is unavailable and physical motor controls are disabled.</p>}
          {snap?.connection === 'CONNECTING' && !snap?.error && <p className="tq-callout" data-testid="device-connecting">Port opened, waiting for the device handshake (a valid TORQVA status frame). Until then nothing is shown as a physical device.</p>}
          {snap?.error && (
            <div className="tq-callout crit" role="alert" data-testid="device-error">
              <strong>{snap.error.message}</strong> <span className="tq-chip">{snap.error.code}</span>
              <p className="tq-muted">Technical detail: {snap.error.detail}</p>
              {Array.isArray(snap.error.recovery) && snap.error.recovery.length > 0 && <ol>{snap.error.recovery.map((r) => <li key={r}>{r}</li>)}</ol>}
              {Array.isArray(snap.rejected_samples) && snap.rejected_samples.length > 0 && (
                <><p className="tq-muted">Last lines received that are not valid TORQVA frames (diagnostic, admin only):</p>
                  <pre className="tq-num" data-testid="rejected-samples">{snap.rejected_samples.join('\n')}</pre></>)}
            </div>)}
          <ErrorBox error={error} />
          <h4 className="tq-mon-subhead">Serial port</h4>
          {!admin ? <Empty>Connecting a device requires the admin role.</Empty> : (
            <form className="tq-form" onSubmit={(e) => { e.preventDefault(); act(() => api.deviceConnect({ port: form.port, baud: Number(form.baud), expected_device_id: form.expected || null }))(); }}>
              <label>Port
                <select value={form.port} onChange={(e) => setForm({ ...form, port: e.target.value })} disabled={connected}>
                  <option value="">select a port…</option>
                  {ports.map((p) => <option key={p.device} value={p.device}>{p.device} — {p.description}</option>)}
                </select>
              </label>
              <label>Baud rate (USB-CDC ignores it)
                <input type="number" value={form.baud} onChange={(e) => setForm({ ...form, baud: e.target.value })} disabled={connected} />
              </label>
              <label>Expected device id (optional; a mismatch is refused)
                <input type="text" value={form.expected} onChange={(e) => setForm({ ...form, expected: e.target.value })} disabled={connected} />
              </label>
              <div className="tq-row">
                <button type="submit" className="tq-btn tq-primary" disabled={busy || connected || !form.port}>Connect</button>
                <button type="button" className="tq-btn" disabled={busy || !connected} onClick={act(() => api.deviceDisconnect())}>Disconnect</button>
              </div>
            </form>)}
          <ErrorBox error={err} />
          <p className="tq-small tq-muted">If the device disconnects, select the port again to reconnect. Nothing is replayed.</p>
        </Card>

        <Card title="Device information" id="c-devinfo" icon={Cpu} sub="Reported by the device in its handshake">
          <MetricList label="Device information" testid="dev-info" items={[
            { key: 'id', label: 'Device id', value: snap?.device_id || null },
            { key: 'identity', label: 'Identity check', value: snap?.identity && snap.identity !== 'unknown' ? snap.identity : null },
            { key: 'mode', label: 'Mode', value: o.label },
            { key: 'fw', label: 'Firmware', value: snap?.firmware || null },
            { key: 'fwmode', label: 'Firmware mode', value: snap?.firmware_mode || null },
            { key: 'proto', label: 'Wire protocol', value: snap?.wire_protocol ?? null },
            { key: 'port', label: 'Serial port', value: snap?.port || null },
            { key: 'transport', label: 'Transport', value: snap?.transport_label || null },
          ]} />
        </Card>

        <Card title="Connection health" id="c-devhealth" icon={HeartPulse} sub="Frame counters kept by the backend">
          <MetricList label="Connection health" testid="dev-health" items={[
            { key: 'last', label: 'Last message', value: snap?.last_rx_unix ? ago(snap.last_rx_unix) : null, missingText: 'never' },
            { key: 'age', label: 'Telemetry age', value: Number.isFinite(snap?.telemetry_age_s) ? fmt(snap.telemetry_age_s, 1) : null, unit: 's' },
            { key: 'frames', label: 'Frames received', value: c.frames ?? null },
            { key: 'malformed', label: 'Malformed frames', value: c.malformed ?? null },
            { key: 'gaps', label: 'Sequence gaps', value: c.gaps ?? null },
            { key: 'missing', label: 'Missed frames', value: c.missing ?? null },
            { key: 'restarts', label: 'Device restarts', value: c.restarts ?? null },
            { key: 'err', label: 'Last error', value: snap?.last_error || null, missingText: 'none' },
          ]} />
          <Disclosure summary="All frame counters" meta={snap?.counters ? `${Object.values(snap.counters).reduce((x, y) => x + (Number(y) || 0), 0)} events counted` : 'no data'} testid="dev-counters">
            {!snap?.counters ? <Empty>No data.</Empty> : (
              <dl className="tq-kv">{Object.entries(snap.counters).map(([k, v]) => (<React.Fragment key={k}><dt>{title(k)}</dt><dd className="tq-num">{v}</dd></React.Fragment>))}</dl>)}
          </Disclosure>
        </Card>
      </div>

      <Card title="Sensor status" id="c-devsens" icon={Activity} className="tq-mt" sub="Invalid or stale readings are never shown as numbers">
        {!sensors.length ? <Empty>No device data.</Empty> : (
          <ul className="tq-mon-sensors" aria-label="Sensor availability" data-testid="dev-sensors">
            {sensors.map(([k, v]) => { const I = SENSOR_ICON[k] || Activity; return (
              <li key={k} className={`tq-mon-sensor tq-${sensorTone(v)}`}>
                <span className="tq-mon-sensor-icon" aria-hidden="true"><I size={16} /></span>
                <span className="tq-mon-sensor-name">{SENSOR_NAME[k] || title(k)}</span>
                <Pill tone={sensorTone(v)}>{v}</Pill>
                <span className="tq-mon-sensor-words">{SENSOR_WORDS[v] || title(v)}</span>
              </li>); })}
          </ul>)}
      </Card>

      <Card title="Recent device events" id="c-devev" icon={Radio} className="tq-mt" sub="This session">
        {!events.length ? <Empty>No events yet.</Empty> : (
          <ul className="tq-feed">{events.slice(0, 12).map((e) => (<li key={e.k}><Pill tone={/error|disconnected|fault|timed|unknown|rejected/.test(e.name) ? 'crit' : 'info'}>{title(e.name)}{e.total > 1 ? ` ×${e.total}` : ''}</Pill><span className="tq-muted">{clock(e.ts)} · {JSON.stringify(e.data).slice(0, 90)}</span></li>))}</ul>)}
      </Card>
      <p className="tq-small tq-muted tq-mt">Trust boundary: {snap?.usb_trust_boundary || 'USB serial is unauthenticated; it is treated as inside the host computer\'s physical trust boundary.'}</p>
    </>
  );
}

/* ------------------------------------------------------------------ Device history (Live Monitor, Overview mini charts) */
/** Polls /device/history for several signals while `enabled`. Each series is [[unix, value|null]]; null is an invalid reading (a gap), never zero.
 *  Nothing is fetched without a device handshake, and the series are cleared when it is lost. */
export function useDeviceHistories(signals, seconds, enabled, everyMs = 2500) {
  const [series, setSeries] = useState({});
  const [err, setErr] = useState(null);
  const key = signals.join(',');
  useEffect(() => {
    if (!enabled) { setSeries({}); return undefined; }
    let on = true;
    const load = () => Promise.all(key.split(',').map((s) => api.deviceHistory(s, seconds).then((r) => [s, Array.isArray(r?.points) ? r.points : []], (e) => [s, null, e])))
      .then((rs) => {
        if (!on) return;
        const bad = rs.find((r) => r[2]);
        setErr(bad ? bad[2] : null);
        setSeries((prev) => Object.fromEntries(rs.map(([s, p]) => [s, p || prev[s] || []])));
      });
    load();
    const id = setInterval(load, everyMs);
    return () => { on = false; clearInterval(id); };
  }, [key, seconds, enabled, everyMs]);
  return { series, err };
}

// Signals the device history supports, with display metadata: [key, title, unit, digits, provenance when physical, sensor colour, note].
export const LIVE_SIGNALS = [
  ['rpm', 'Speed (Hall sensor)', 'rpm', 0, 'MEASURED', 'var(--tq-sig-rpm)', 'measured shaft speed'],
  ['current', 'Current', 'A', 2, 'MEASURED', 'var(--tq-sig-current)', 'motor current'],
  ['housing', 'Housing temperature', '°C', 1, 'MEASURED', 'var(--tq-sig-temp)', 'motor housing'],
  ['voltage', 'DC bus voltage', 'V', 1, 'MEASURED', 'var(--tq-sig-voltage)', 'supply'],
  ['power', 'Motor power', 'W', 1, 'DERIVED', 'var(--tq-sig-power)', 'computed by the firmware from V × I'],
  ['acceleration', 'Total acceleration', 'g', 3, 'MEASURED', 'var(--tq-sig-vib)', 'includes gravity; raw per-axis values; NOT vibration RMS'],
  ['duty', 'Drive duty (command)', '%', 1, 'COMMAND', 'var(--tq-chart-ink)', 'commanded, not measured'],
];
const SIG_ICON = { rpm: Gauge, current: Zap, housing: Thermometer, voltage: Plug, power: Zap, acceleration: Move3d, duty: SlidersHorizontal };
const RANGES = [[60, '60 s'], [180, '3 min'], [360, '6 min']];
const rangeName = (s) => (s < 120 ? `${s} s` : `${s / 60} min`);
const SAMPLE_KEYS = ['rpm', 'current', 'voltage', 'power', 'housing', 'duty'];        // one backend history record per frame: these share timestamps

/** A reading that may be shown as a number: present, valid and finite. Anything else is UNAVAILABLE, never zero. */
export const readingOf = (v) => (v && v.valid && v.value !== null && v.value !== undefined && Number.isFinite(Number(v.value)) ? Number(v.value) : null);

/* ------------------------------------------------------------------ Live device charts (Live Monitor in both modes) */
export function DeviceLive({ stream }) {
  const { snap } = stream;
  const [seconds, setSeconds] = useState(60);
  const o = originOf(snap);
  const { series, err } = useDeviceHistories(LIVE_SIGNALS.map((s) => s[0]), seconds, !!snap?.handshake);
  const stale = snap && !snap.telemetry_fresh;
  const vals = snap?.values || {};
  const provOf = (p) => (o.physical ? p : 'SIMULATED');
  const rows = useMemo(() => {
    const m = new Map();
    for (const k of SAMPLE_KEYS) for (const [t, v] of series[k] || []) { const r = m.get(t) || { t }; r[k] = v; m.set(t, r); }
    return [...m.values()].sort((a, b) => b.t - a.t).slice(0, 10);
  }, [series]);
  const n = (v, d) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? '—' : fmt(v, d));
  return (
    <div className="tq-stack tq-mon-live">
      <div className="tq-toolbar">
        <span className="tq-toolbar-label">Time range</span>
        <div className="tq-seg" role="group" aria-label="Time range">
          {RANGES.map(([s, name]) => <button key={s} type="button" className="tq-btn" aria-pressed={seconds === s} onClick={() => setSeconds(s)}>{name}</button>)}
        </div>
        <span className="tq-grow" />
        <SourceTag kind={stale && snap?.handshake ? 'STALE' : o.physical ? 'PHYSICAL' : snap?.handshake ? 'SIMULATED' : 'UNKNOWN'} />
      </div>
      <p className={`tq-callout ${o.physical ? '' : 'warn'}`} role="note">
        {o.physical ? 'Values below are measurements reported by the connected ESP32-S3.' : snap?.handshake ? 'The connected firmware reports SIMULATION mode: these are not physical measurements.' : 'No device is connected. There is no physical-device telemetry; nothing here is simulated or invented.'}
        {' '}Gaps mean invalid readings or a disconnect; they are never drawn as zero.
      </p>
      {stale && snap?.handshake && (
        <AlertPanel tone="warn" title={`Telemetry is STALE: last frame ${fmt(snap.telemetry_age_s, 1)} s ago. Showing the last readings, not live data.`} testid="dev-stale" />)}
      <ErrorBox error={err} />
      <div className="tq-mon-livegrid">
        <div className="tq-mon-charts">
          {LIVE_SIGNALS.map(([k, name, unit, d, prov, color, note]) => {
            const v = vals[k]; const x = readingOf(v); const pts = series[k] || [];
            const data = pts.map(([t, y]) => ({ t, v: y }));
            const I = SIG_ICON[k] || Activity;
            return (
              <ChartPanel key={k} id={`dev-ch-${k}`} testid={`dev-chart-${k}`} title={<><I size={15} aria-hidden="true" style={{ color }} /> {name}</>}
                value={x === null ? null : fmt(x, d)} unit={unit} prov={x === null ? undefined : provOf(prov)}
                right={x !== null && v.stale ? <SourceTag kind="STALE" /> : null}
                foot={`${note} · last ${rangeName(seconds)}${pts.length ? ` · ${pts.length} points` : ''}${x === null && v && !v.valid && v.origin !== 'unavailable' ? ' · invalid sensor reading' : ''}`}>
                {data.length ? (
                  <div role="img" aria-label={`${name} history, last ${rangeName(seconds)}`} className="tq-chart"><HistoryChart data={data} name={`${name} (${unit})`} height={150} color={color} digits={d} unit={unit} /></div>
                ) : <p className="tq-mon-nochart">No device history in this window. History exists only while a device is sending telemetry.</p>}
              </ChartPanel>);
          })}
          <ChartPanel id="dev-ch-vib" testid="dev-chart-vib" title={<><Waves size={15} aria-hidden="true" style={{ color: 'var(--tq-sig-vib)' }} /> Vibration RMS</>} value={null}
            foot="see total acceleration for the raw accelerometer">
            <p className="tq-mon-nochart">the firmware does not compute it</p>
          </ChartPanel>
        </div>
        <div className="tq-stack">
          <Card title="Telemetry details" id="c-devdetails" sub={snap?.last_rx_unix ? `last frame ${clock(snap.last_rx_unix)}` : 'no frame received'}>
            <MetricList label="Telemetry details" testid="dev-metrics" items={[
              ...LIVE_SIGNALS.map(([k, name, unit, d, prov, color]) => { const x = readingOf(vals[k]); return { key: k, label: name, icon: SIG_ICON[k], color, value: x === null ? null : fmt(x, d), unit, prov: x === null ? undefined : provOf(prov), missingText: 'UNAVAILABLE' }; }),
              ...(vals.ambient ? [{ key: 'ambient', label: 'Ambient temperature', icon: Thermometer, value: readingOf(vals.ambient) === null ? null : fmt(readingOf(vals.ambient), 1), unit: '°C', prov: readingOf(vals.ambient) === null ? undefined : provOf('MEASURED'), missingText: 'UNAVAILABLE' }] : []),
              { key: 'drive', label: 'Drive mode', value: snap?.handshake ? (snap.drive || null) : null },
              { key: 'src', label: 'Data source', value: o.label },
              { key: 'upd', label: 'Last updated', value: snap?.last_rx_unix ? ago(snap.last_rx_unix) : null, missingText: 'never' },
            ]} />
          </Card>
        </div>
      </div>
      <Card title="Latest telemetry samples" id="c-devsamples" sub="Newest first; — means invalid or missing, never zero">
        <DataTable testid="dev-samples" caption="Latest device telemetry samples" rowKey={(r) => r.t} rows={rows} empty="No samples in this window."
          columns={[{ key: 't', label: 'Time', render: (r) => clock(r.t) }, { key: 'rpm', label: 'Speed (rpm)', align: 'num', render: (r) => n(r.rpm, 0) },
            { key: 'current', label: 'Current (A)', align: 'num', render: (r) => n(r.current, 2) }, { key: 'voltage', label: 'Voltage (V)', align: 'num', render: (r) => n(r.voltage, 1) },
            { key: 'power', label: 'Power (W)', align: 'num', render: (r) => n(r.power, 1) }, { key: 'housing', label: 'Temp (°C)', align: 'num', render: (r) => n(r.housing, 1) },
            { key: 'duty', label: 'Duty (%)', align: 'num', render: (r) => n(r.duty, 1) }]} />
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ Motor control (physical actuation stays blocked) */
export const STATE_TONE = { REQUESTED: 'info', REJECTED: 'crit', AUTHORIZED: 'wait', SENT: 'wait', ACKNOWLEDGED: 'info', EXECUTED: 'ok', FAILED: 'crit', TIMED_OUT: 'warn', UNKNOWN_OUTCOME: 'warn' };

const LIMIT_FIELDS = [['max_current_a', 'Max current (A)'], ['min_voltage_v', 'Min supply voltage (V)'], ['max_voltage_v', 'Max supply voltage (V)'], ['max_temp_c', 'Max housing temperature (°C)'], ['max_rpm', 'Max speed (rpm)'], ['max_duty_pct', 'Max duty (%)']];

/** Commissioning record: human attestations with written evidence, approved limits and the explicit enable. A record, not a measurement; it never overrides the firmware. */
export function CommissioningCard({ role, expanded = false }) {
  const [c, setC] = useState(null);
  const [err, setErr] = useState(null);
  const [ev, setEv] = useState({});
  const [lim, setLim] = useState({});
  const [limEv, setLimEv] = useState('');
  const [limConfirm, setLimConfirm] = useState('');
  const [phrase, setPhrase] = useState('');
  const admin = true;
  // Every limit is typed by the admin: a blank field is never sent as 0 and no value is filled in on their behalf.
  const limMissing = LIMIT_FIELDS.filter(([k]) => lim[k] === undefined || String(lim[k]).trim() === '' || !Number.isFinite(Number(lim[k])));
  useEffect(() => { let on = true; api.commissioning().then((x) => on && setC(x)).catch(() => on && setC(false)); return () => { on = false; }; }, []);
  const run = (fn) => async () => { setErr(null); try { setC(await fn()); } catch (e) { setErr(e); } };
  if (c === null) return null;
  if (c === false || !Array.isArray(c.items)) return <Card title="Commissioning" id="c-comm"><Empty>The commissioning record is unavailable.</Empty></Card>;
  return (
    <Card title="Commissioning (human record)" id="c-comm" right={<Pill tone={c.physical_control_enabled ? 'warn' : 'stop'}>{c.physical_control_enabled ? 'RECORD ENABLED' : 'NOT ENABLED'}</Pill>}>
      <p className="tq-muted">{c.note} Only an admin can change it; every change needs written evidence and is audited.</p>
      {c.load_error && <div className="tq-callout crit" role="alert">{c.load_error}</div>}
      <p data-testid="commissioning-summary"><strong className="tq-num">{c.items.filter((i) => i.status === 'VERIFIED').length} of {c.items.length}</strong> requirements verified
        {c.items.some((i) => i.status === 'BLOCKED') && <> · <Pill tone="stop">{`${c.items.filter((i) => i.status === 'BLOCKED').length} blocked`}</Pill></>}
        {' '}· approved limits {c.limits ? `version ${c.limits.version}` : 'none'}</p>
      <Disclosure open={expanded} summary={admin ? 'Review and edit the commissioning record' : 'View the commissioning checklist'} meta={admin ? 'attest requirements with written evidence, approve limits, enable the record' : 'requirements, evidence and approved limits'} testid="commissioning-edit">
      <div className="tq-table-wrap"><table className="tq-table" data-testid="commissioning"><caption className="tq-sr">Commissioning checklist</caption>
        <thead><tr><th scope="col">Requirement</th><th scope="col">Status</th><th scope="col">Evidence</th>{admin && <th scope="col">Action</th>}</tr></thead>
        <tbody>{c.items.map((i) => (
          <tr key={i.id}><td>{i.label}</td>
            <td><Pill tone={i.status === 'VERIFIED' ? 'ok' : i.status === 'BLOCKED' ? 'stop' : 'warn'}>{i.status}</Pill></td>
            <td className="tq-muted">{i.evidence ? `${i.evidence} (${i.by})` : '—'}</td>
            {admin && <td className="tq-actions-cell"><input aria-label={`Evidence for ${i.label}`} value={ev[i.id] || ''} onChange={(e) => setEv({ ...ev, [i.id]: e.target.value })} placeholder="written evidence" />
              <div className="tq-row">
                <button type="button" className="tq-btn" onClick={run(() => api.commissioningItem(i.id, { status: 'VERIFIED', evidence: ev[i.id] || '' }))}>Attest</button>
                <button type="button" className="tq-btn" onClick={run(() => api.commissioningItem(i.id, { status: 'BLOCKED', evidence: ev[i.id] || '' }))}>Block</button>
                <button type="button" className="tq-btn tq-ghost" onClick={run(() => api.commissioningItem(i.id, { status: 'NOT VERIFIED', evidence: '' }))}>Clear</button>
              </div></td>}
          </tr>))}</tbody></table></div>
      <h4>Approved limits</h4>
      {c.limits ? <p className="tq-muted" data-testid="limits-approved">Version {c.limits.version}, approved by {c.limits.by}: {LIMIT_FIELDS.map(([k, l]) => `${l} ${c.limits[k]}`).join(' · ')}</p> : <p className="tq-muted">No limits are approved. Nothing is assumed.</p>}
      {c.limits_history?.length > 0 && (
        <details><summary>Limit change history ({c.limits_history.length})</summary>
          <ul className="tq-list" data-testid="limits-history">{c.limits_history.slice().reverse().map((h) => (
            <li key={h.version}>v{h.version} · {h.by} · {new Date(h.at * 1000).toLocaleString()} · {h.previous ? LIMIT_FIELDS.filter(([k]) => h.previous[k] !== h.new[k]).map(([k, l]) => `${l}: ${h.previous[k]} → ${h.new[k]}`).join(', ') || 'unchanged' : 'first approval'}</li>))}</ul>
        </details>)}
      {admin && (
        <Disclosure summary="Change approved limits or enable the record" meta="admin · written evidence and a confirmation phrase required" testid="commissioning-admin" className="tq-mt">
        <form className="tq-form" onSubmit={(e) => e.preventDefault()}>
          <fieldset className="tq-fieldset"><legend>Propose new limits</legend>
          <div className="tq-form-grid">{LIMIT_FIELDS.map(([k, l]) => <label key={k}>{l} <input type="number" min="0" value={lim[k] ?? ''} onChange={(e) => setLim({ ...lim, [k]: e.target.value })} /></label>)}</div>
          <label>Evidence for these limits <input value={limEv} onChange={(e) => setLimEv(e.target.value)} /></label>
          <label>Type {c.limits_confirm_phrase} to confirm <input value={limConfirm} onChange={(e) => setLimConfirm(e.target.value)} /></label>
          <div className="tq-row"><button type="button" className="tq-btn tq-primary" disabled={limMissing.length > 0} onClick={run(() => api.commissioningLimits({ ...Object.fromEntries(LIMIT_FIELDS.map(([k]) => [k, Number(lim[k])])), evidence: limEv, confirm: limConfirm }))}>Approve limits</button>
            {limMissing.length > 0 && <span className="tq-muted" data-testid="limits-missing">Enter every limit to approve: {limMissing.map(([, l]) => l).join(', ')}.</span>}</div>
          </fieldset>
          <fieldset className="tq-fieldset"><legend>Physical control in the record</legend>
          <label>Type {c.enable_phrase} to enable <input value={phrase} onChange={(e) => setPhrase(e.target.value)} /></label>
          <div className="tq-row">
            <button type="button" className="tq-btn tq-danger" disabled={!c.enable_allowed} onClick={run(() => api.commissioningEnable({ enabled: true, confirm: phrase }))}>Enable in the record</button>
            <button type="button" className="tq-btn" onClick={run(() => api.commissioningEnable({ enabled: false }))}>Disable</button>
          </div>
          </fieldset>
        </form>
        </Disclosure>)}
      </Disclosure>
      <ErrorBox error={err} />
      <p className="tq-muted">Approved limits are sent to the board over the authenticated session and must be confirmed by it. Enabling the record does not enable motion: the firmware interlocks (E-stop input, secure session) are checked separately and still refuse START and speed.</p>
    </Card>
  );
}

// The backend's interlock ids, grouped the way commissioning is done. An id the backend adds later lands under "Other checks", never hidden.
const INTERLOCK_GROUPS = [
  ['connect', 'Device connection', ['identity', 'handshake', 'telemetry', 'sensors'], 'device'],
  ['firmware', 'Firmware and faults', ['fault', 'watchdog', 'driver'], 'record'],
  ['estop', 'Emergency stop', ['estop'], 'record'],
  ['auth', 'Authorization', ['session', 'supervisor'], null],
  ['limits', 'Electrical limits', ['limits', 'psu'], 'record'],
  ['commission', 'Commissioning', ['commissioning', 'board', 'wiring'], 'record'],
];
// What each status means for the analyst (the backend's own words are in the Evidence column).
const ILK = { VERIFIED: ['ok', 'passed'], BLOCKED: ['stop', 'blocking'], 'NOT VERIFIED': ['warn', 'not verified'], UNAVAILABLE: ['off', 'unavailable'] };
/** Scroll to the commissioning record (on the Safety & Commissioning page). */
export const toComm = () => { try { document.getElementById('c-comm')?.scrollIntoView({ block: 'start' }); } catch { /* not supported */ } };
/** Scroll to one interlock group in the Safety interlocks table. */
export const toIlk = (key) => { try { document.getElementById(`ilk-g-${key}`)?.scrollIntoView({ block: 'center' }); } catch { /* not supported */ } };

/** The backend's interlocks (snap.interlocks) in commissioning groups: [{ key, name, next, items }]. Empty groups are dropped; unknown ids go to "Other checks". */
export function interlockGroups(rows) {
  if (!Array.isArray(rows)) return [];
  const known = new Set(INTERLOCK_GROUPS.flatMap((g) => g[2]));
  return [...INTERLOCK_GROUPS, ['other', 'Other checks', rows.filter((r) => !known.has(r.id)).map((r) => r.id), null]]
    .map(([key, name, ids, next]) => ({ key, name, next, items: ids.map((i) => rows.find((r) => r.id === i)).filter(Boolean) })).filter((g) => g.items.length);
}
/** A group's status in words, from its checks only: every check VERIFIED = all passed; any BLOCKED = blocking; otherwise not verified / unavailable.
 *  `state` is a CheckList state (ok | fail | warn | unknown). No reported failure is never a pass. */
export function groupStatus(items) {
  const n = items.length; const passed = items.filter((r) => r.status === 'VERIFIED').length;
  const blocked = items.filter((r) => r.status === 'BLOCKED').length; const nv = items.filter((r) => r.status === 'NOT VERIFIED').length;
  const of = `${passed} of ${n} passed`;
  if (n && passed === n) return { state: 'ok', status: 'All passed', of, passed, n };
  if (blocked) return { state: 'fail', status: `${blocked} blocking`, of, passed, n };
  if (nv) return { state: 'warn', status: 'Not verified', of, passed, n };
  return { state: 'unknown', status: 'Unavailable', of, passed, n };
}

/** The backend's interlock report for physical motion as a grouped checklist (read-only). Hardware checks are never VERIFIED by software. */
export function InterlocksCard({ snap, go }) {
  const rows = snap?.interlocks;
  const groups = interlockGroups(rows);
  return (
    <Card title="Safety interlocks" id="c-interlocks" sub="Every check the backend reports, grouped">
      {!rows ? <Empty>No interlock data.</Empty> : (
        <div className="tq-table-wrap"><table className="tq-table tq-ilk" data-testid="interlocks"><caption className="tq-sr">Physical motion interlocks, grouped</caption>
          <thead><tr><th scope="col">Check</th><th scope="col">Status</th><th scope="col">Evidence or reason</th></tr></thead>
          {groups.map((g) => {
            const open = g.items.filter((r) => r.status !== 'VERIFIED');
            return (
              <tbody key={g.key} data-testid={`ilk-${g.key}`} id={`ilk-g-${g.key}`}>
                <tr className="tq-ilk-group"><th scope="rowgroup" colSpan={3}>
                  <span>{g.name}</span> <span className="tq-muted">{open.length ? `${g.items.length - open.length} of ${g.items.length} passed` : 'all passed'}</span>
                  {open.length > 0 && g.next === 'device' && go && <> · <button type="button" className="tq-linkbtn" onClick={() => go('connection')}>Check the connection on Device & Safety</button></>}
                  {open.length > 0 && g.next === 'record' && <> · <button type="button" className="tq-linkbtn" onClick={toComm}>Go to the commissioning record</button></>}
                </th></tr>
                {g.items.map((r) => { const [tone, word] = ILK[r.status] || ['info', r.status]; return (
                  <tr key={r.id}><td>{r.label}</td><td><Pill tone={tone}>{r.status}</Pill><span className="tq-sr"> ({word})</span></td><td className="tq-muted">{r.detail}</td></tr>); })}
              </tbody>);
          })}
        </table></div>)}
      <p className="tq-small tq-muted">VERIFIED means the backend has evidence; NOT VERIFIED means no evidence yet, which is not a pass. Hardware checks (E-stop circuit, driver, watchdog) are never VERIFIED by software: no reported failure is not a verification.</p>
    </Card>
  );
}

/** Is physical operation permitted, and what blocks it? Every blocker the backend reports is listed; nothing here grants permission. */
export function ReadinessCard({ snap, go }) {
  const blockers = snap?.control_blockers || ['DEVICE NOT CONNECTED'];
  const counts = (snap?.interlocks || []).reduce((m, r) => ({ ...m, [r.status]: (m[r.status] || 0) + 1 }), {});
  return (
    <Card title="Operating readiness" id="c-ready" right={<Pill tone={blockers.length ? 'stop' : 'warn'}>{blockers.length ? `BLOCKED · ${blockers.length}` : 'no blocker reported'}</Pill>}>
      {blockers.length ? (
        <div className="tq-callout crit" role="alert" data-testid="ready-blockers">
          <strong>Physical motion is not permitted. The backend reports:</strong>
          <ul className="tq-list">{blockers.map((b) => <li key={b}>{b}</li>)}</ul>
        </div>
      ) : (
        <p className="tq-callout info" role="note">No blocker is reported. Direct operator motor control is active.</p>)}
      {snap?.interlocks?.length > 0 && <p className="tq-small tq-muted" data-testid="ready-counts">Interlocks: {Object.entries(counts).map(([k, n]) => `${n} ${k.toLowerCase()}`).join(' · ')}.</p>}
      {go && blockers.some((b) => /NOT CONNECTED|HANDSHAKE|TELEMETRY/i.test(b)) && <p className="tq-small"><button type="button" className="tq-linkbtn" onClick={() => go('connection')}>Connect the device on Device & Safety</button></p>}
    </Card>
  );
}

/** Compact device summary for the Overview page. */
export function DeviceCard({ stream, go }) {
  const { snap } = stream;
  const o = originOf(snap);
  const blockers = snap?.control_blockers || [];
  return (
    <Card title="Device (USB)" id="c-devcard" right={<Pill tone={o.tone}>{o.label}</Pill>}>
      <dl className="tq-kv">
        <dt>USB connection</dt><dd><ConnPill snap={snap} /></dd>
        <dt>Last telemetry</dt><dd className="tq-num">{snap?.handshake ? (snap.telemetry_fresh ? `live · ${ago(snap.last_rx_unix)}` : `STALE · ${ago(snap.last_rx_unix)}`) : 'none (no device)'}</dd>
        <dt>Safety state</dt><dd>{snap?.safety_state || '—'}</dd>
        <dt>Physical motion</dt><dd>{blockers.length ? <Pill tone="stop">blocked ({blockers.length})</Pill> : <Pill tone="info">no blocker reported</Pill>}</dd>
      </dl>
      <CardLink onClick={() => go('connection')}>Open the connection section</CardLink>
    </Card>
  );
}
