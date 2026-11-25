import { ago, clock, originOf, transportOf, isOverrideActive } from '../telemetry/devicePresentation.js';
import React, { useEffect, useState } from 'react';
import { Usb, Unplug, Cpu, HeartPulse, Gauge, Zap, Thermometer, Plug, Move3d, Activity, Waves, Radio, Wifi } from 'lucide-react';
import { api } from '../shared/api.js';
import { Card, Empty, ErrorBox, Pill, fmt, title, PageHead, CardLink, Disclosure, MetricList } from '../components/components.jsx';
import { WirelessControlCard, WirelessSerialMonitor } from './wirelessWorkspace.jsx';

function ConnPill({ snap }) {
  const c = snap?.connection || 'DISCONNECTED';
  const tone = c === 'CONNECTED' ? 'ok' : c === 'STALE' || c === 'CONNECTING' ? 'warn' : c === 'ERROR' ? 'crit' : 'off';
  return <Pill tone={tone}>{c}</Pill>;
}

/** Sensor names and status words used by the device pages (the backend's sensor_status keys and values). */
export const SENSOR_NAME = {
  rpm: 'Speed (Hall sensor)', current: 'Current', voltage: 'DC bus voltage', power: 'Motor power', housing: 'Motor temperature', ambient: 'Ambient temperature',
  acceleration: 'Accelerometer', vibration_rms: 'Vibration RMS', duty: 'Drive duty', setpoint: 'Setpoint'
};
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
  const admin = role === 'admin';
  const override = isOverrideActive();
  // In Physical mode a missing handshake is a disconnected device, not simulation (the app mode is chosen explicitly in the shell).
  const o = (!snap?.handshake && !override && !simMode) ? { label: 'NO DEVICE HANDSHAKE', tone: 'off', physical: false } : originOf(snap);
  useEffect(() => { api.devicePorts().then((r) => setPorts(Array.isArray(r?.ports) ? r.ports : [])).catch(() => setPorts([])); }, []);
  const act = (fn) => async () => { setBusy(true); setErr(null); try { await fn(); } catch (e) { setErr(e); } finally { setBusy(false); stream.refresh(); } };
  const connected = snap && snap.connection && snap.connection !== 'DISCONNECTED' && snap.connection !== 'ERROR';
  const c = snap?.counters || {};
  const headTone = snap?.connection === 'ERROR' ? 'crit' : !connected ? 'off' : o.physical ? (snap.telemetry_fresh ? 'ok' : 'warn') : 'warn';
  const via = transportOf(snap);
  const baseWord = snap?.connection === 'ERROR' ? 'Connection error' : !connected ? 'Disconnected' : snap?.connection === 'CONNECTING' ? (override ? 'Connected (direct mode)' : 'Connecting') : !snap.handshake && !override ? 'No handshake' : !o.physical && !override ? 'Connected (firmware simulation)' : snap.telemetry_fresh ? 'Connected' : 'Connected · telemetry stale';
  const headWord = via && connected ? `${baseWord} — ${via}` : baseWord;
  const wl = snap?.wifi_link;
  const sensors = Object.entries(snap?.sensor_status || {});
  return (
    <>
      {!embedded && <PageHead title="Device" sub="Connection status and device information. The backend owns the USB serial link to the ESP32-S3; the browser never touches the port."
        right={<><Pill tone={o.tone}>{o.label}</Pill><ConnPill snap={snap} /></>} />}

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
          {!snap?.handshake && !override && <p className="tq-callout">No device handshake. {simMode ? <>The application is in <strong>SIMULATION</strong>; physical</> : 'Physical'}-device telemetry is unavailable and physical motor controls are disabled.</p>}
          {snap?.connection === 'CONNECTING' && !snap?.error && !override && <p className="tq-callout" data-testid="device-connecting">Port opened, waiting for the device handshake (a valid TORQVA status frame). Until then nothing is shown as a physical device.</p>}
          {snap?.error && !override && (
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
                <button type="button" className="tq-btn" disabled={busy || (!connected && snap?.connection === 'DISCONNECTED')} onClick={act(() => api.deviceDisconnect())}>Disconnect</button>
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
            {sensors.map(([k, v]) => {
              const I = SENSOR_ICON[k] || Activity; return (
                <li key={k} className={`tq-mon-sensor tq-${sensorTone(v)}`}>
                  <span className="tq-mon-sensor-icon" aria-hidden="true"><I size={16} /></span>
                  <span className="tq-mon-sensor-name">{SENSOR_NAME[k] || title(k)}</span>
                  <Pill tone={sensorTone(v)}>{v}</Pill>
                  <span className="tq-mon-sensor-words">{SENSOR_WORDS[v] || title(v)}</span>
                </li>);
            })}
          </ul>)}
      </Card>

      <Card title="Recent device events" id="c-devev" icon={Radio} className="tq-mt" sub="This session">
        {!events.length ? <Empty>No events yet.</Empty> : (
          <ul className="tq-feed">{events.slice(0, 12).map((e) => (<li key={e.k}><Pill tone={/error|disconnected|fault|timed|unknown|rejected/.test(e.name) ? 'crit' : 'info'}>{title(e.name)}{e.total > 1 ? ` ×${e.total}` : ''}</Pill><span className="tq-muted">{clock(e.ts)} · {JSON.stringify(e.data).slice(0, 90)}</span></li>))}</ul>)}
      </Card>
      <div className="tq-mt"><WirelessControlCard admin={admin} operator={role === 'operator' || role === 'admin'} snap={snap} onRefreshed={stream.refresh} /></div>
      <div className="tq-mt"><WirelessSerialMonitor /></div>
      <p className="tq-small tq-muted tq-mt">Trust boundary: {snap?.usb_trust_boundary || 'USB serial is unauthenticated; it is treated as inside the host computer\'s physical trust boundary.'}</p>
    </>
  );
}

export function DeviceCard({ stream, go }) {
  const { snap } = stream;
  const o = originOf(snap);
  return (
    <Card title="Device (USB)" id="c-devcard" right={<Pill tone={o.tone}>{o.label}</Pill>}>
      <dl className="tq-kv">
        <dt>USB connection</dt><dd><ConnPill snap={snap} /></dd>
        <dt>Last telemetry</dt><dd className="tq-num">{snap?.handshake ? (snap.telemetry_fresh ? `live · ${ago(snap.last_rx_unix)}` : `STALE · ${ago(snap.last_rx_unix)}`) : 'none (no device)'}</dd>
        <dt>Device state</dt><dd>{snap?.safety_state || '—'}</dd>
      </dl>
      <CardLink onClick={() => go('connection')}>Open the connection section</CardLink>
    </Card>
  );
}
