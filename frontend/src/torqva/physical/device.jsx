import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, getToken, ApiError } from '../api.js';
import { Card, Empty, ErrorBox, Pill, ProvBadge, fmt, title, PageHead, CardLink, Disclosure } from '../shared/components.jsx';
import { HistoryChart } from '../shared/lazyCharts.jsx';

const defaultWs = (import.meta.env && import.meta.env.MODE === 'test') ? null : (url) => new WebSocket(url);
export const canOperate = (role) => role === 'admin';        // starting the motor and changing speed are admin-only; STOP is open to every signed-in role
const SIGNALS = [['rpm', 'Speed', 'rpm', 0], ['acceleration', 'Total acceleration (incl. gravity)', 'g', 3], ['current', 'Current', 'A', 2], ['housing', 'Housing temperature', '°C', 1], ['duty', 'Drive duty (command)', '%', 1]];
const RANGES = [[60, 'Last 60 s'], [180, 'Last 3 min'], [360, 'Last 6 min']];
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
        let m; try { m = JSON.parse(ev.data); } catch { return; }          // malformed frames are ignored, never trusted
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

const ago = (unix) => (unix ? `${fmt(Math.max(0, Date.now() / 1000 - unix), 1)} s ago` : 'never');

function ConnPill({ snap }) {
  const c = snap?.connection || 'DISCONNECTED';
  const tone = c === 'CONNECTED' ? 'ok' : c === 'STALE' || c === 'CONNECTING' ? 'warn' : c === 'ERROR' ? 'crit' : 'off';
  return <Pill tone={tone}>{c}</Pill>;
}

/* ------------------------------------------------------------------ Device connection */
export function DevicePage({ stream, role, go, simMode = false }) {
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
      {(() => { const bl = snap?.control_blockers || ['DEVICE NOT CONNECTED']; return (
        <p className={`tq-callout ${bl.length ? 'warn' : ''}`} role="status" data-testid="dev-readiness">
          <strong>{bl.length ? `Physical motion blocked (${bl.length})` : 'No motion blocker reported'}</strong>{bl.length ? ` — ${bl[0]}${bl.length > 1 ? ` and ${bl.length - 1} more` : ''}.` : '.'}{' '}
          {go && !simMode && <button type="button" className="tq-linkbtn" onClick={() => go('control')}>Review readiness and commissioning</button>}
          {go && simMode && <>Physical Motor Control is available in Physical mode. To run the simulated motor, use <button type="button" className="tq-linkbtn" data-testid="dev-to-scenario" onClick={() => go('overview')}>Scenario Studio on Overview</button>.</>}
        </p>); })()}
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
                    <pre className="tq-num" data-testid="rejected-samples">{snap.rejected_samples.join('\n')}</pre></>)}
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
          <Disclosure summary="Connection diagnostics" meta={snap?.counters ? `frame counters · ${Object.values(snap.counters).reduce((x, y) => x + (Number(y) || 0), 0)} events counted` : 'no data'} testid="dev-counters">
            {!snap?.counters ? <Empty>No data.</Empty> : (
              <dl className="tq-kv">{Object.entries(snap.counters).map(([k, v]) => (<React.Fragment key={k}><dt>{title(k)}</dt><dd className="tq-num">{v}</dd></React.Fragment>))}</dl>)}
          </Disclosure>
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
              {v && !missing && v.stale && <div className="tq-kpi-note">stale</div>}
              {v && missing && <div className="tq-kpi-note">invalid sensor reading</div>}
            </div>);
        })}
        {(() => { const a = snap?.values?.acceleration; const ok = a && a.valid && a.value != null; return (
          <div className={`tq-kpi ${!ok || a.stale ? 'tq-unavailable' : ''}`}><div className="tq-kpi-label"><span>Total acceleration</span>{ok ? <ProvBadge kind={o.physical ? 'MEASURED' : 'SIMULATED'} /> : null}</div>
            <div className="tq-kpi-value tq-num">{ok ? fmt(a.value, 3) : 'UNAVAILABLE'}{ok && <span className="tq-kpi-unit">g</span>}</div>
            <div className="tq-kpi-note">{ok ? 'includes gravity; raw per-axis values; NOT vibration RMS' : (a && a.origin !== 'unavailable' ? 'invalid sensor reading' : 'no accelerometer data')}</div></div>); })()}
        <div className="tq-kpi tq-unavailable"><div className="tq-kpi-label"><span>Vibration RMS</span></div><div className="tq-kpi-value tq-num">UNAVAILABLE</div>
          <div className="tq-kpi-note">the firmware does not compute it</div></div>
      </div>
      <Card title="History" id="c-devhist" right={<><label className="tq-inline">Signal <select value={signal} onChange={(e) => setSignal(e.target.value)}>{SIGNALS.map(([k, n]) => <option key={k} value={k}>{n}</option>)}</select></label>
        <label className="tq-inline">Range <select value={seconds} onChange={(e) => setSeconds(Number(e.target.value))}>{RANGES.map(([s, n]) => <option key={s} value={s}>{n}</option>)}</select></label></>}>
        <ErrorBox error={err} />
        {!data.length ? <Empty>No device history for this range. History exists only while a device is sending telemetry.</Empty> : (
          <div role="img" aria-label={`${meta[1]} history`} className="tq-chart"><HistoryChart data={data} name={`${meta[1]} (${meta[2]})`} height={240} /></div>)}
        <p className="tq-chart-note">Gaps mean invalid readings or a disconnect; they are never drawn as zero.</p>
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
  const admin = role === 'admin';
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
const toComm = () => { try { document.getElementById('c-comm')?.scrollIntoView({ block: 'start' }); } catch { /* not supported */ } };

/** The backend's interlock report for physical motion as a grouped checklist (read-only). Hardware checks are never VERIFIED by software. */
export function InterlocksCard({ snap, go }) {
  const rows = snap?.interlocks;
  const known = new Set(INTERLOCK_GROUPS.flatMap((g) => g[2]));
  const groups = rows ? [...INTERLOCK_GROUPS, ['other', 'Other checks', rows.filter((r) => !known.has(r.id)).map((r) => r.id), null]]
    .map(([key, name, ids, next]) => ({ key, name, next, items: ids.map((i) => rows.find((r) => r.id === i)).filter(Boolean) })).filter((g) => g.items.length) : [];
  return (
    <Card title="Safety interlocks" id="c-interlocks">
      {!rows ? <Empty>No interlock data.</Empty> : (
        <div className="tq-table-wrap"><table className="tq-table tq-ilk" data-testid="interlocks"><caption className="tq-sr">Physical motion interlocks, grouped</caption>
          <thead><tr><th scope="col">Check</th><th scope="col">Status</th><th scope="col">Evidence or reason</th></tr></thead>
          {groups.map((g) => {
            const open = g.items.filter((r) => r.status !== 'VERIFIED');
            return (
              <tbody key={g.key} data-testid={`ilk-${g.key}`}>
                <tr className="tq-ilk-group"><th scope="rowgroup" colSpan={3}>
                  <span>{g.name}</span> <span className="tq-muted">{open.length ? `${g.items.length - open.length} of ${g.items.length} passed` : 'all passed'}</span>
                  {open.length > 0 && g.next === 'device' && go && <> · <button type="button" className="tq-linkbtn" onClick={() => go('device')}>Check the connection on the Device page</button></>}
                  {open.length > 0 && g.next === 'record' && <> · <button type="button" className="tq-linkbtn" onClick={toComm}>Go to the commissioning record</button></>}
                </th></tr>
                {g.items.map((r) => { const [tone, word] = ILK[r.status] || ['info', r.status]; return (
                  <tr key={r.id}><td>{r.label}</td><td><Pill tone={tone}>{r.status}</Pill><span className="tq-sr"> ({word})</span></td><td className="tq-muted">{r.detail}</td></tr>); })}
              </tbody>);
          })}
        </table></div>)}
      <p className="tq-muted">VERIFIED means the backend has evidence; NOT VERIFIED means no evidence yet, which is not a pass. Hardware checks (E-stop circuit, driver, watchdog) are never VERIFIED by software: no reported failure is not a verification.</p>
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
        <p className="tq-callout warn" role="note">No blocker is reported. Every command is still checked by the Safety Supervisor, the commissioning record and the firmware interlocks; this is not a hardware verification.</p>)}
      {snap?.interlocks?.length > 0 && <p className="tq-small tq-muted" data-testid="ready-counts">Interlocks: {Object.entries(counts).map(([k, n]) => `${n} ${k.toLowerCase()}`).join(' · ')}.</p>}
      {go && blockers.some((b) => /NOT CONNECTED|HANDSHAKE|TELEMETRY/i.test(b)) && <p className="tq-small"><button type="button" className="tq-linkbtn" onClick={() => go('device')}>Connect the device on the Device page</button></p>}
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
      <CardLink onClick={() => go('device')}>Open Device</CardLink>
    </Card>
  );
}
