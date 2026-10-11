import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer } from 'recharts';
import { Octagon } from 'lucide-react';
import { api, getToken } from './api.js';
import { Card, Empty, ErrorBox, Pill, ProvBadge, fmt } from './components.jsx';
import { PageHead, Tabs } from './pages.jsx';

const title = (s) => String(s ?? '').replaceAll('_', ' ');
const defaultWs = (import.meta.env && import.meta.env.MODE === 'test') ? null : (url) => new WebSocket(url);
export const canOperate = (role) => role === 'admin';        // starting the motor and changing speed are admin-only; STOP is open to every signed-in role
const SIGNALS = [['rpm', 'Speed', 'rpm', 0], ['acceleration', 'Total acceleration (incl. gravity)', 'g', 3], ['current', 'Current', 'A', 2], ['housing', 'Housing temperature', '°C', 1], ['duty', 'Drive duty (command)', '%', 1]];
const RANGES = [[60, 'Last 60 s'], [180, 'Last 3 min'], [360, 'Last 6 min']];
const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);

/** Live device state: REST snapshot + read-only WebSocket with reconnection. Telemetry is only ever "live" while the server says it is fresh AND frames keep arriving. */
export function useDeviceStream(enabled, wsFactory = defaultWs, pollMs = 3000) {
  const [snap, setSnap] = useState(null);
  const [commands, setCommands] = useState([]);
  const [events, setEvents] = useState([]);
  const [ws, setWs] = useState('idle');                 // idle | connecting | open | closed
  const [lastMsg, setLastMsg] = useState(null);
  const [error, setError] = useState(null);
  const alive = useRef(true);

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
      if (isObj(s)) { setSnap(s); setError(null); }
      if (isObj(c) && Array.isArray(c.commands)) setCommands(c.commands);
    } catch (e) { if (alive.current) setError(e); }
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
        let m; try { m = JSON.parse(ev.data); } catch { return; }          // malformed frames are ignored, never trusted
        if (!isObj(m)) return;
        setLastMsg(Date.now());
        if (m.type === 'snapshot' && isObj(m.data)) { retry = 0; setWs('open'); setSnap(m.data); if (Array.isArray(m.commands)) setCommands(m.commands); }
        else if (m.type === 'event' && typeof m.name === 'string') {
          if (m.name === 'telemetry' && isObj(m.data)) setSnap((s) => ({ ...(s || {}), ...m.data }));
          else {
            pushEvent(m);
            if (['device_disconnected', 'device_restarted', 'command_sent', 'command_rejected', 'command_acknowledged', 'command_executed', 'command_timed_out', 'command_unknown_outcome', 'telemetry_stale', 'safety_fault_latched', 'device_state_changed'].includes(m.name)) refresh();
          }
        }
      };
      const lost = () => {
        if (!alive.current) return;
        setWs('closed');
        retry += 1; timer = setTimeout(open, Math.min(15000, 1000 * 2 ** Math.min(retry, 4)));   // exponential backoff, capped
      };
      sock.onclose = lost;
      sock.onerror = () => { try { sock.close(); } catch { /* already closed */ } };
    };
    open();
    return () => { alive.current = false; clearInterval(poll); if (timer) clearTimeout(timer); if (sock) { sock.onclose = null; try { sock.close(); } catch { /* closing */ } } };
  }, [enabled, refresh, wsFactory, pollMs, pushEvent]);

  return { snap, commands, events, ws, lastMsg, error, refresh };
}

export function originOf(snap) {
  if (!snap || !snap.handshake) return { label: 'SIMULATION', tone: 'info', physical: false };
  if (snap.origin === 'physical_device') return { label: 'PHYSICAL DEVICE', tone: 'ok', physical: true };
  return { label: 'DEVICE (FIRMWARE SIMULATION MODE)', tone: 'warn', physical: false };
}

const ago = (unix) => (unix ? `${fmt(Math.max(0, Date.now() / 1000 - unix), 1)} s ago` : 'never');

function ConnPill({ snap }) {
  const c = snap?.connection || 'DISCONNECTED';
  const tone = c === 'CONNECTED' ? 'ok' : c === 'STALE' || c === 'CONNECTING' ? 'warn' : c === 'ERROR' ? 'crit' : 'off';
  return <Pill tone={tone}>{c}</Pill>;
}

/* ------------------------------------------------------------------ Device connection */
export function DevicePage({ stream, role }) {
  const { snap, events, ws, error } = stream;
  const [ports, setPorts] = useState([]);
  const [form, setForm] = useState({ port: '', baud: 115200, expected: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const admin = role === 'admin';
  const o = originOf(snap);
  useEffect(() => { if (admin) api.devicePorts().then((r) => setPorts(Array.isArray(r?.ports) ? r.ports : [])).catch(() => setPorts([])); }, [admin]);
  const act = (fn) => async () => { setBusy(true); setErr(null); try { await fn(); } catch (e) { setErr(e); } finally { setBusy(false); stream.refresh(); } };
  const connected = snap && snap.connection && snap.connection !== 'DISCONNECTED' && snap.connection !== 'ERROR';
  return (
    <>
      <PageHead title="Device Connection" sub="USB serial link to the ESP32-S3, owned by the backend. The browser never touches the port."
        right={<><Pill tone={o.tone}>{o.label}</Pill><ConnPill snap={snap} /></>} />
      <div className="tq-split">
        <div className="tq-stack">
          <Card title="Connection" id="c-devconn">
            <dl className="tq-kv">
              <dt>State</dt><dd data-testid="state-label"><strong>{snap?.state_label || 'DISCONNECTED'}</strong></dd>
              <dt>Mode</dt><dd>{o.label}</dd>
              <dt>Port</dt><dd>{snap?.port || '—'}</dd>
              <dt>USB state</dt><dd><ConnPill snap={snap} /></dd>
              <dt>Live updates (WebSocket only; says nothing about USB)</dt><dd>{ws === 'open' ? <Pill tone="ok">connected</Pill> : <Pill tone="warn">{ws === 'idle' ? 'off' : ws}</Pill>}</dd>
              <dt>Last message</dt><dd className="tq-num">{ago(snap?.last_rx_unix)}</dd>
              <dt>Device id</dt><dd>{snap?.device_id || '—'} {snap?.identity && snap.identity !== 'unknown' && <span className="tq-chip">{snap.identity}</span>}</dd>
              <dt>Firmware / protocol</dt><dd>{snap?.firmware || '—'} · wire protocol {snap?.wire_protocol ?? '—'}</dd>
              <dt>Firmware mode</dt><dd>{snap?.firmware_mode || '—'}</dd>
            </dl>
            {!snap?.handshake && <p className="tq-callout">No device handshake. The application is in <strong>SIMULATION</strong>; physical-device telemetry is unavailable and physical motor controls are disabled.</p>}
            {snap?.connection === 'CONNECTING' && !snap?.error && <p className="tq-callout" data-testid="device-connecting">Port opened, waiting for the device handshake (a valid TORQVA status frame). Until then nothing is shown as a physical device.</p>}
            {snap?.error && (
              <div className="tq-callout crit" role="alert" data-testid="device-error">
                <strong>{snap.error.message}</strong> <span className="tq-chip">{snap.error.code}</span>
                <p className="tq-muted">Technical detail: {snap.error.detail}</p>
                {Array.isArray(snap.error.recovery) && snap.error.recovery.length > 0 && <ol>{snap.error.recovery.map((r) => <li key={r}>{r}</li>)}</ol>}
                {Array.isArray(snap.rejected_samples) && snap.rejected_samples.length > 0 && (
                  <><p className="tq-muted">Last lines received that are not valid TORQVA frames (diagnostic, admin only):</p>
                    <pre className="tq-num" style={{ whiteSpace: 'pre-wrap', margin: 0 }} data-testid="rejected-samples">{snap.rejected_samples.join('\n')}</pre></>)}
              </div>)}
            <ErrorBox error={error} />
            <p className="tq-muted">Trust boundary: {snap?.usb_trust_boundary || 'USB serial is unauthenticated; it is treated as inside the host computer\'s physical trust boundary.'}</p>
          </Card>
          <Card title="Sensors" id="c-devsens">
            {!snap?.sensor_status ? <Empty>No device data.</Empty> : (
              <table className="tq-table"><caption className="tq-sr">Sensor availability</caption><thead><tr><th scope="col">Sensor</th><th scope="col">Status</th></tr></thead>
                <tbody>{Object.entries(snap.sensor_status).map(([k, v]) => (<tr key={k}><td>{title(k)}</td><td><Pill tone={v === 'valid' ? 'ok' : v === 'unavailable' ? 'off' : 'warn'}>{v}</Pill></td></tr>))}</tbody></table>)}
            <p className="tq-muted">unavailable = this firmware does not report it or no frame has arrived; invalid/stale readings are never shown as numbers.</p>
          </Card>
          <Card title="Counters" id="c-devcnt">
            {!snap?.counters ? <Empty>No data.</Empty> : (
              <dl className="tq-kv">{Object.entries(snap.counters).map(([k, v]) => (<React.Fragment key={k}><dt>{title(k)}</dt><dd className="tq-num">{v}</dd></React.Fragment>))}</dl>)}
          </Card>
        </div>
        <div className="tq-stack">
          <Card title="Serial port" id="c-devport">
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
            <p className="tq-muted">If the device disappears the backend closes the port and shows DISCONNECTED; reconnect by selecting the port again. Nothing is replayed after a reconnect.</p>
          </Card>
          <Card title="Recent device events" id="c-devev">
            {!events.length ? <Empty>No events yet.</Empty> : (
              <ul className="tq-feed">{events.slice(0, 12).map((e) => (<li key={e.k}><Pill tone={/error|disconnected|fault|timed|unknown|rejected/.test(e.name) ? 'crit' : 'info'}>{title(e.name)}{e.total > 1 ? ` ×${e.total}` : ''}</Pill><span className="tq-muted">{JSON.stringify(e.data).slice(0, 90)}</span></li>))}</ul>)}
          </Card>
        </div>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ Live device charts (used by Live Monitor and the Device page) */
export function DeviceLive({ stream }) {
  const { snap } = stream;
  const [signal, setSignal] = useState('rpm');
  const [seconds, setSeconds] = useState(60);
  const [points, setPoints] = useState([]);
  const [err, setErr] = useState(null);
  const o = originOf(snap);
  const load = useCallback(() => api.deviceHistory(signal, seconds).then((r) => { setPoints(Array.isArray(r?.points) ? r.points : []); setErr(null); }).catch(setErr), [signal, seconds]);
  useEffect(() => { load(); const id = setInterval(load, 2000); return () => clearInterval(id); }, [load]);
  const data = useMemo(() => points.map(([t, v]) => ({ t, v })), [points]);
  const meta = SIGNALS.find((s) => s[0] === signal);
  const stale = snap && !snap.telemetry_fresh;
  return (
    <div className="tq-stack">
      <p className={`tq-callout ${o.physical ? '' : 'warn'}`} role="note">
        {o.physical ? 'Values below are measurements reported by the connected ESP32-S3.' : snap?.handshake ? 'The connected firmware reports SIMULATION mode: these are not physical measurements.' : 'No device is connected. There is no physical-device telemetry; nothing here is simulated or invented.'}
        {stale && snap?.handshake && <strong> Telemetry is STALE: last frame {fmt(snap.telemetry_age_s, 1)} s ago. Showing the last readings, not live data.</strong>}
      </p>
      <div className="tq-kpis">
        {SIGNALS.map(([k, name, unit, d]) => {
          const v = snap?.values?.[k];
          const missing = !v || v.value === null || v.value === undefined;
          return (
            <div key={k} className={`tq-kpi ${missing || v?.stale ? 'tq-unavailable' : ''}`}>
              <div className="tq-kpi-label"><span>{name}</span>{v && !missing ? <ProvBadge kind={o.physical ? 'MEASURED' : 'SIMULATED'} /> : null}</div>
              <div className="tq-kpi-value tq-num">{missing ? 'UNAVAILABLE' : fmt(v.value, d)}{!missing && <span className="tq-kpi-unit">{unit}</span>}</div>
              {v && !missing && v.stale && <div className="tq-muted" style={{ fontSize: 12 }}>stale</div>}
              {v && missing && <div className="tq-muted" style={{ fontSize: 12 }}>invalid sensor reading</div>}
            </div>);
        })}
        {(() => { const a = snap?.values?.acceleration; const ok = a && a.valid && a.value != null; return (
          <div className={`tq-kpi ${!ok || a.stale ? 'tq-unavailable' : ''}`}><div className="tq-kpi-label"><span>Total acceleration</span>{ok ? <ProvBadge kind={o.physical ? 'MEASURED' : 'SIMULATED'} /> : null}</div>
            <div className="tq-kpi-value tq-num">{ok ? fmt(a.value, 3) : 'UNAVAILABLE'}{ok && <span className="tq-kpi-unit">g</span>}</div>
            <div className="tq-muted" style={{ fontSize: 12 }}>{ok ? 'includes gravity; raw per-axis values; NOT vibration RMS' : (a && a.origin !== 'unavailable' ? 'invalid sensor reading' : 'no accelerometer data')}</div></div>); })()}
        <div className="tq-kpi tq-unavailable"><div className="tq-kpi-label"><span>Vibration RMS</span></div><div className="tq-kpi-value tq-num">UNAVAILABLE</div>
          <div className="tq-muted" style={{ fontSize: 12 }}>the firmware does not compute it</div></div>
      </div>
      <Card title="History" id="c-devhist" right={<><label className="tq-inline">Signal <select value={signal} onChange={(e) => setSignal(e.target.value)}>{SIGNALS.map(([k, n]) => <option key={k} value={k}>{n}</option>)}</select></label>
        <label className="tq-inline">Range <select value={seconds} onChange={(e) => setSeconds(Number(e.target.value))}>{RANGES.map(([s, n]) => <option key={s} value={s}>{n}</option>)}</select></label></>}>
        <ErrorBox error={err} />
        {!data.length ? <Empty>No device history for this range. History exists only while a device is sending telemetry.</Empty> : (
          <div role="img" aria-label={`${meta[1]} history`}><ResponsiveContainer width="100%" height={220}>
            <LineChart data={data}><CartesianGrid stroke="var(--tq-border)" />
              <XAxis dataKey="t" type="number" domain={['dataMin', 'dataMax']} tickFormatter={(x) => new Date(x * 1000).toLocaleTimeString()} minTickGap={40} />
              <YAxis width={54} domain={['auto', 'auto']} /><Tooltip labelFormatter={(x) => new Date(x * 1000).toLocaleTimeString()} />
              <Line dataKey="v" name={`${meta[1]} (${meta[2]})`} stroke="var(--tq-accent)" dot={false} isAnimationActive={false} connectNulls={false} />
            </LineChart></ResponsiveContainer></div>)}
        <p className="tq-muted">Gaps mean invalid readings or a disconnect; they are never drawn as zero.</p>
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ Motor control (physical actuation stays blocked) */
export const STATE_TONE = { REQUESTED: 'info', REJECTED: 'crit', AUTHORIZED: 'wait', SENT: 'wait', ACKNOWLEDGED: 'info', EXECUTED: 'ok', FAILED: 'crit', TIMED_OUT: 'warn', UNKNOWN_OUTCOME: 'warn' };

const LIMIT_FIELDS = [['max_current_a', 'Max current (A)'], ['max_temp_c', 'Max housing temperature (°C)'], ['max_rpm', 'Max speed (rpm)'], ['max_duty_pct', 'Max duty (%)']];

/** Commissioning record: human attestations with written evidence, approved limits and the explicit enable. A record, not a measurement; it never overrides the firmware. */
export function CommissioningCard({ role }) {
  const [c, setC] = useState(null);
  const [err, setErr] = useState(null);
  const [ev, setEv] = useState({});
  const [lim, setLim] = useState({});
  const [limEv, setLimEv] = useState('');
  const [limConfirm, setLimConfirm] = useState('');
  const [phrase, setPhrase] = useState('');
  const admin = role === 'admin';
  useEffect(() => { let on = true; api.commissioning().then((x) => on && setC(x)).catch(() => on && setC(false)); return () => { on = false; }; }, []);
  const run = (fn) => async () => { setErr(null); try { setC(await fn()); } catch (e) { setErr(e); } };
  if (c === null) return null;
  if (c === false || !Array.isArray(c.items)) return <Card title="Commissioning" id="c-comm"><Empty>The commissioning record is unavailable.</Empty></Card>;
  return (
    <Card title="Commissioning (human record)" id="c-comm" right={<Pill tone={c.physical_control_enabled ? 'warn' : 'stop'}>{c.physical_control_enabled ? 'RECORD ENABLED' : 'NOT ENABLED'}</Pill>}>
      <p className="tq-muted">{c.note} Only an admin can change it; every change needs written evidence and is audited.</p>
      {c.load_error && <div className="tq-callout crit" role="alert">{c.load_error}</div>}
      <table className="tq-table" data-testid="commissioning"><caption className="tq-sr">Commissioning checklist</caption>
        <thead><tr><th scope="col">Requirement</th><th scope="col">Status</th><th scope="col">Evidence</th>{admin && <th scope="col">Action</th>}</tr></thead>
        <tbody>{c.items.map((i) => (
          <tr key={i.id}><td>{i.label}</td>
            <td><Pill tone={i.status === 'VERIFIED' ? 'ok' : i.status === 'BLOCKED' ? 'stop' : 'warn'}>{i.status}</Pill></td>
            <td className="tq-muted">{i.evidence ? `${i.evidence} (${i.by})` : '—'}</td>
            {admin && <td><input aria-label={`Evidence for ${i.label}`} value={ev[i.id] || ''} onChange={(e) => setEv({ ...ev, [i.id]: e.target.value })} placeholder="written evidence" />
              <button type="button" className="tq-btn" onClick={run(() => api.commissioningItem(i.id, { status: 'VERIFIED', evidence: ev[i.id] || '' }))}>Attest</button>
              <button type="button" className="tq-btn" onClick={run(() => api.commissioningItem(i.id, { status: 'BLOCKED', evidence: ev[i.id] || '' }))}>Block</button>
              <button type="button" className="tq-btn" onClick={run(() => api.commissioningItem(i.id, { status: 'NOT VERIFIED', evidence: '' }))}>Clear</button></td>}
          </tr>))}</tbody></table>
      <h4>Approved limits</h4>
      {c.limits ? <p className="tq-muted" data-testid="limits-approved">Version {c.limits.version}, approved by {c.limits.by}: {LIMIT_FIELDS.map(([k, l]) => `${l} ${c.limits[k]}`).join(' · ')}</p> : <p className="tq-muted">No limits are approved. Nothing is assumed.</p>}
      {c.limits_history?.length > 0 && (
        <details><summary>Limit change history ({c.limits_history.length})</summary>
          <ul className="tq-list" data-testid="limits-history">{c.limits_history.slice().reverse().map((h) => (
            <li key={h.version}>v{h.version} · {h.by} · {new Date(h.at * 1000).toLocaleString()} · {h.previous ? LIMIT_FIELDS.filter(([k]) => h.previous[k] !== h.new[k]).map(([k, l]) => `${l}: ${h.previous[k]} → ${h.new[k]}`).join(', ') || 'unchanged' : 'first approval'}</li>))}</ul>
        </details>)}
      {admin && (
        <form className="tq-form" onSubmit={(e) => e.preventDefault()}>
          {LIMIT_FIELDS.map(([k, l]) => <label key={k}>{l} <input type="number" min="0" value={lim[k] ?? ''} onChange={(e) => setLim({ ...lim, [k]: e.target.value })} /></label>)}
          <label>Evidence for these limits <input value={limEv} onChange={(e) => setLimEv(e.target.value)} /></label>
          <label>Type {c.limits_confirm_phrase} to confirm <input value={limConfirm} onChange={(e) => setLimConfirm(e.target.value)} /></label>
          <button type="button" className="tq-btn" onClick={run(() => api.commissioningLimits({ min_voltage_v: 0.0, max_voltage_v: 26.0, ...Object.fromEntries(LIMIT_FIELDS.map(([k]) => [k, Number(lim[k])])), evidence: limEv, confirm: limConfirm }))}>Approve limits</button>
          <label>Type {c.enable_phrase} to enable <input value={phrase} onChange={(e) => setPhrase(e.target.value)} /></label>
          <button type="button" className="tq-btn tq-danger" disabled={!c.enable_allowed} onClick={run(() => api.commissioningEnable({ enabled: true, confirm: phrase }))}>Enable in the record</button>
          <button type="button" className="tq-btn" onClick={run(() => api.commissioningEnable({ enabled: false }))}>Disable</button>
        </form>)}
      <ErrorBox error={err} />
      <p className="tq-muted">Approved limits are sent to the board over the authenticated session and must be confirmed by it. Enabling the record does not enable motion: the firmware interlocks (E-stop input, secure session) are checked separately and still refuse START and speed.</p>
    </Card>
  );
}

export function MotorControlPage({ stream, role }) {
  const { snap, commands } = stream;
  const [duty, setDuty] = useState('');
  const [rpm, setRpm] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [last, setLast] = useState(null);
  const [confirm, setConfirm] = useState(false);
  const o = originOf(snap);
  const blockers = snap?.control_blockers || ['DEVICE NOT CONNECTED'];
  const send = (body) => async () => { setBusy(true); setErr(null); try { setLast(await api.deviceCommand(body)); } catch (e) { setErr(e); } finally { setBusy(false); stream.refresh(); } };
  const connected = snap && ['CONNECTED', 'STALE'].includes(snap.connection);
  const blocked = blockers.length > 0;
  return (
    <>
      <PageHead title="Motor Control" sub="Every request goes: authenticated backend → role check → Safety Supervisor → commissioning and interlocks → dispatcher → device validation → acknowledgement."
        right={<><Pill tone={o.tone}>{o.label}</Pill><Pill tone={blockers.length ? 'stop' : 'info'}>{blockers.length ? blockers[0] : 'no blocker reported'}</Pill></>} />
      <div className="tq-split">
        <div className="tq-stack">
          <Card title="Motor state" id="c-mstate">
            {!snap?.handshake ? <Empty>No device is connected. Simulation controls are on the Live Monitor page.</Empty> : (
              <dl className="tq-kv">
                <dt>Drive</dt><dd>{snap.drive || '—'}</dd>
                <dt>Device identity</dt><dd>{snap.device_id || '—'} <span className="tq-muted">({snap.identity})</span></dd>
                <dt>Requested duty (command, not a measurement)</dt><dd className="tq-num">{snap.values?.duty?.value == null ? '—' : `${fmt(snap.values.duty.value, 1)} %`}</dd>
                <dt>Measured speed (Hall sensor)</dt><dd className="tq-num">{snap.values?.rpm?.value == null ? 'UNAVAILABLE' : `${fmt(snap.values.rpm.value, 0)} rpm`}</dd>
                <dt>Safety state</dt><dd>{snap.safety_state === 'EMERGENCY_STOP' ? <Pill tone="stop">LATCHED: {title(snap.trip_reason)}</Pill> : <Pill tone={snap.safety_state === 'OK' ? 'ok' : 'warn'}>{snap.safety_state || '—'}</Pill>}</dd>
                <dt>Firmware motion permission</dt><dd>{snap.start_blocked_reason ? <Pill tone="warn">refused: {snap.start_blocked_reason}</Pill> : <Pill tone="info">no interlock refusal reported</Pill>}</dd>
                <dt>Motor current</dt><dd className="tq-num">{snap.values?.current?.valid ? `${fmt(snap.values.current.value, 2)} A` : 'UNAVAILABLE'}</dd>
                <dt>Housing temperature</dt><dd className="tq-num">{snap.values?.housing?.valid ? `${fmt(snap.values.housing.value, 1)} °C` : 'UNAVAILABLE'}</dd>
                <dt>Vibration RMS</dt><dd>UNAVAILABLE <span className="tq-muted">(not implemented; raw acceleration is a different quantity)</span></dd>
                <dt>Telemetry</dt><dd>{snap.telemetry_fresh ? <Pill tone="ok">live</Pill> : <Pill tone="crit">STALE</Pill>}</dd>
              </dl>)}
          </Card>
          <Card title="Safety interlocks" id="c-interlocks">
            {!snap?.interlocks ? <Empty>No interlock data.</Empty> : (
              <table className="tq-table" data-testid="interlocks"><caption className="tq-sr">Physical motion interlocks</caption>
                <thead><tr><th scope="col">Interlock</th><th scope="col">Status</th><th scope="col">Evidence</th></tr></thead>
                <tbody>{snap.interlocks.map((r) => (<tr key={r.id}><td>{r.label}</td><td><Pill tone={r.status === 'VERIFIED' ? 'ok' : r.status === 'BLOCKED' ? 'stop' : r.status === 'NOT VERIFIED' ? 'warn' : 'info'}>{r.status}</Pill></td><td className="tq-muted">{r.detail}</td></tr>))}</tbody></table>)}
            <p className="tq-muted">Hardware checks are never VERIFIED by software: no reported failure is not a verification.</p>
          </Card>
          <CommissioningCard role={role} />
          <Card title="Request motion" id="c-mctl" right={<ProvBadge kind="MEASURED" />}>
            {blocked && (
              <div className="tq-callout crit" role="alert" data-testid="control-blockers">
                <strong>Physical motion is unavailable:</strong>
                <ul className="tq-list">{blockers.map((b) => <li key={b}>{b}</li>)}</ul>
              </div>)}
            <form className="tq-form" onSubmit={(e) => e.preventDefault()}>
              <label>Open-loop start duty (%) <input type="number" min="0" max={snap?.control_limits?.max_duty_pct ?? 100} value={duty} onChange={(e) => { setDuty(e.target.value); setConfirm(false); }} disabled={blocked || !canOperate(role)} /></label>
              <label>Duty slider <input type="range" min="0" max={snap?.control_limits?.max_duty_pct ?? 100} step="1" value={duty === '' ? 0 : duty} onChange={(e) => { setDuty(e.target.value); setConfirm(false); }} disabled={blocked || !canOperate(role)} aria-label="Duty slider (nothing is sent until you press a request button)" /></label>
              <div className="tq-row">
                <button type="button" className="tq-btn tq-primary" disabled={blocked || busy || !canOperate(role) || duty === ''} onClick={() => (confirm ? (setConfirm(false), send({ action: 'START', duty_pct: Number(duty) })()) : setConfirm(true))}>{confirm ? 'Confirm START request' : 'Request START'}</button>
                {confirm && <button type="button" className="tq-btn" onClick={() => setConfirm(false)}>Cancel</button>}
                <button type="button" className="tq-btn" disabled={blocked || busy || !canOperate(role) || rpm === ''} onClick={send({ action: 'SET_SPEED', rpm: Number(rpm) })}>Request speed</button>
              </div>
            </form>
            {!canOperate(role) && <p className="tq-muted">Your role ({role}) can request STOP only.</p>}
            <h4>Protective stop request</h4>
            <button type="button" className="tq-btn tq-danger" disabled={busy || !connected} onClick={send({ action: 'STOP' })}><Octagon size={14} aria-hidden="true" /> Send STOP to device</button>
            <p className="tq-muted">This is a software request, not an independent physical emergency stop. The firmware's own protections run locally and do not depend on this website, the network or any model.</p>
            <ErrorBox error={err} />
            {last && <p className="tq-callout">Last request #{last.id}: <Pill tone={STATE_TONE[last.state] || 'info'}>{last.state}</Pill> {(last.reasons || []).join(' · ')}</p>}
          </Card>
        </div>
        <Card title="Command history" id="c-mhist">
          {!commands.length ? <Empty>No commands requested in this session.</Empty> : (
            <table className="tq-table"><caption className="tq-sr">Device command history</caption>
              <thead><tr><th scope="col">#</th><th scope="col">Action</th><th scope="col">By</th><th scope="col">State</th><th scope="col">Detail</th></tr></thead>
              <tbody>{commands.slice(0, 20).map((c) => (<tr key={c.id}><td className="tq-num">{c.id}</td><td>{title(c.action)}</td><td>{c.requested_by}</td>
                <td><Pill tone={STATE_TONE[c.state] || 'info'}>{title(c.state)}</Pill></td><td className="tq-muted">{(c.reasons || []).join(' · ') || c.ack_reason}</td></tr>))}</tbody></table>)}
          <p className="tq-muted">SENT and ACKNOWLEDGED are not EXECUTED. Nothing is retried or replayed automatically; after a disconnect or device restart an unfinished command is shown as UNKNOWN OUTCOME and the operator must act again.</p>
        </Card>
      </div>
    </>
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
      <button className="tq-link" onClick={() => go('device')}>Open Device</button>
    </Card>
  );
}
