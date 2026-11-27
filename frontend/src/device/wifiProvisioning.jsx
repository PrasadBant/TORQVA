// Configure Wi-Fi (Firmware Manager -> Device Management). Plug the ESP32-S3 in over USB, pick or type your network, click Configure & Connect.
// Every state, percentage and check shown here is what the backend job reports (GET /provisioning/jobs/{id}, polled); the page advances nothing itself.
// The Wi-Fi password lives only in this component's state until submit, is cleared on submit and is never logged, stored in the browser or put in a URL.
import React, { useCallback, useEffect, useState } from 'react';
import { Wifi, Eye, EyeOff, RefreshCw, Usb, ShieldAlert } from 'lucide-react';
import { api } from '../shared/api.js';
import { Card, Empty, ErrorBox, Pill, StepTracker, CheckList, DataTable } from '../components/components.jsx';
import '../app/styles/wifi.css';

const USB_STEPS = [
  ['RELEASING_PORT', 'Preparing USB port'], ['READING_NVS', 'Reading device configuration'], ['WRITING_NVS', 'Writing network settings'],
  ['VERIFYING_NVS', 'Verifying what was written'], ['RESTARTING', 'Restarting the board'], ['RECONNECTING', 'Reconnecting over USB'],
  ['VERIFYING_DEVICE', 'Authenticating device and telemetry'], ['WIRELESS_WAIT', 'Waiting for the Wi-Fi link'],
];
const COMMIT_STEP = ['COMMITTING', 'Making the new network permanent'];
const SWITCH_STEPS = [
  ['STAGING', 'Asking the board to try the network'], ['SWITCHING', 'Joining the new network'],
  ['VERIFYING_PAIRING', 'Verifying identity and telemetry'], ['COMMITTING', 'Making the new network permanent'],
];
const ROLLBACK_STEP = ['ROLLBACK', 'Restoring the previous network'];
const DONE = new Set(['PAIRED_WIRELESS', 'WIRELESS_PENDING', 'COMMITTED', 'ROLLED_BACK', 'FAILED', 'INTERRUPTED']);
const LIKELY_ESP32 = /CH34|CH910|CP210|USB JTAG|Espressif|FTDI|USB Serial/i;
// Which step a failure belongs to (the backend reports the failure code, not the step).
const FAIL_AT = { WRONG_CHIP: 'READING_NVS', NVS_UNREADABLE: 'READING_NVS', PARTITION_LAYOUT_MISMATCH: 'READING_NVS', PARTITION_TABLE_INVALID: 'READING_NVS', KEY_MISMATCH: 'READING_NVS',
  IDENTITY_UNKNOWN: 'READING_NVS', NVS_FULL: 'READING_NVS', NVS_VERIFY_FAILED: 'VERIFYING_NVS', RESTART_FAILED: 'RECONNECTING', AUTH_FAILED: 'VERIFYING_DEVICE', IDENTITY_MISMATCH: 'VERIFYING_DEVICE',
  TELEMETRY_STALE: 'VERIFYING_DEVICE', STAGE_NOT_SENT: 'STAGING', STAGE_REJECTED: 'STAGING', PAIRING_TIMEOUT: 'SWITCHING', COMMIT_NOT_SENT: 'COMMITTING', COMMIT_REJECTED: 'COMMITTING', COMMIT_UNCONFIRMED: 'COMMITTING' };

/** Steps of a job (USB provisioning or a staged network change) with their state, derived only from what the job reports. */
export function jobSteps(job) {
  const isSwitch = job?.kind === 'network_switch';
  let steps = isSwitch ? [...SWITCH_STEPS] : (job?.staged ? [...USB_STEPS, COMMIT_STEP] : [...USB_STEPS]);
  const rollbackShown = isSwitch && job && (['WAITING_ROLLBACK', 'ROLLED_BACK'].includes(job.state) || job.error_code === 'DEVICE_LOST');
  if (rollbackShown) steps = [...steps, ROLLBACK_STEP];
  const keys = steps.map(([k]) => k);
  if (!job) return steps.map(([key, label]) => ({ key, label, state: 'pending' }));
  const idx = (k) => keys.indexOf(k);
  const failKey = FAIL_AT[job.error_code] || (isSwitch ? 'SWITCHING' : null);
  const active = job.state === 'WIRELESS_PENDING' ? 'WIRELESS_WAIT' : job.state;
  return steps.map(([key, label], i) => {
    let state = 'pending';
    if (job.state === 'PAIRED_WIRELESS' || job.state === 'COMMITTED') state = 'done';
    else if (job.state === 'WIRELESS_PENDING') state = i < idx('WIRELESS_WAIT') ? 'done' : (key === 'WIRELESS_WAIT' ? 'failed' : 'pending');
    else if (job.state === 'ROLLED_BACK') state = key === 'ROLLBACK' ? 'done' : (key === (failKey || 'SWITCHING') ? 'failed' : (i < idx(failKey || 'SWITCHING') ? 'done' : 'pending'));
    else if (job.state === 'WAITING_ROLLBACK') state = key === 'ROLLBACK' ? 'active' : (key === (failKey || 'SWITCHING') ? 'failed' : (i < idx(failKey || 'SWITCHING') ? 'done' : 'pending'));
    else if (job.state === 'FAILED' || job.state === 'INTERRUPTED') {
      const at = job.error_code === 'DEVICE_LOST' ? 'ROLLBACK' : failKey;
      const fi = at ? idx(at) : 0;
      state = i < fi ? 'done' : (i === Math.max(fi, 0) ? 'failed' : 'pending');
    } else if (idx(active) >= 0) state = i < idx(active) ? 'done' : i === idx(active) ? 'active' : 'pending';
    return { key, label, state };
  });
}

/** Four-bar signal indicator. The dBm value is always written next to it: colour is never the only cue. */
export function SignalBars({ bars = 0, rssi }) {
  const label = rssi == null ? 'Signal unavailable' : `Signal ${bars} of 4 bars (${rssi} dBm)`;
  return <span className="wifi-bars" data-bars={bars} role="img" aria-label={label} title={label}><i /><i /><i /><i /></span>;
}

const TONE = { PAIRED_WIRELESS: 'ok', COMMITTED: 'ok', WIRELESS_PENDING: 'warn', ROLLED_BACK: 'warn', INTERRUPTED: 'warn', FAILED: 'crit' };
const when = (s) => (s ? new Date(s * 1000).toLocaleString() : '—');
// Levenshtein distance, for "did you mean" on a mistyped network name ("OnePuls 12" -> "OnePlus 12").
const editDistance = (a, b) => {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
};
const label = (s) => String(s || '').replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase());

function NowCard({ cur, trialLeft }) {
  const on = cur?.connected;
  const item = (name, value, extra) => (
    <div><dt>{name}</dt><dd>{value ? <>{value}{extra}</> : <span className="is-missing">UNAVAILABLE</span>}</dd></div>);
  return (
    <dl className="wifi-now" aria-label="Current network" data-testid="wifi-now">
      {item('Device', on ? `${cur.device_id || 'unknown'} · ${cur.transport === 'wifi' ? 'Wi-Fi' : cur.transport === 'usb' ? 'USB' : '—'}` : null)}
      {item('Network', cur?.ssid || null)}
      {item('Signal', cur?.ssid && cur.rssi != null ? `${cur.rssi} dBm` : null, <SignalBars bars={cur?.bars || 0} rssi={cur?.rssi} />)}
      {item('Band', cur?.band || null)}
      {item('Board address', cur?.ip || null)}
      {item('Saved network', cur?.configured_ssid || null)}
      {item('Authenticated', on ? (cur.session_active ? 'yes' : 'no') : null)}
      {item('Staged changes', on ? (cur.staging_supported ? 'supported' : 'not supported by this firmware') : null)}
      {cur?.trial && <div><dt>Network on trial</dt><dd><Pill tone="warn">{trialLeft} s left</Pill></dd></div>}
    </dl>
  );
}

export function WifiProvisioningCard({ admin, snap, onDone }) {
  const [status, setStatus] = useState(null);
  const [ports, setPorts] = useState([]);
  const [form, setForm] = useState({ device_id: '', port: '', ssid: '', password: '', base_url: '', erase_damaged_nvs: false });
  const [showPw, setShowPw] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [job, setJob] = useState(null);
  const [history, setHistory] = useState([]);
  const [scan, setScan] = useState(null);                 // { networks, note, current_ssid, configured_ssid }
  const [scanMsg, setScanMsg] = useState(null);
  const [scanning, setScanning] = useState(false);
  const [choice, setChoice] = useState('');               // '' = none yet, '@manual' = typed name, otherwise a scanned SSID
  const [err, setErr] = useState(null);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now() / 1000);

  const cur = status?.current_network;
  const onWifi = (snap?.connection && snap?.transport?.kind === 'wifi') || cur?.transport === 'wifi';
  const running = !!job && !DONE.has(job.state);
  const networks = scan?.networks || [];
  const manual = choice === '@manual' || networks.length === 0;
  const ssid = manual ? form.ssid : choice;
  const picked = networks.find((n) => n.ssid === choice);

  const refresh = useCallback(async () => {
    try {
      const [st, pl, hist] = await Promise.all([api.provStatus(), admin ? api.devicePorts() : Promise.resolve({ ports: [] }), api.provHistory().catch(() => ({ jobs: [] }))]);
      setStatus(st);
      setPorts(pl.ports || []);
      setHistory(hist.jobs || []);
      setForm((f) => ({ ...f, device_id: f.device_id || snap?.device_id || st?.current_network?.device_id || 'RIG-1', port: f.port || (pl.ports || []).find((p) => LIKELY_ESP32.test(p.description || ''))?.device || '' }));
      return hist.jobs || [];
    } catch (e) { setErr(e); return []; }
  }, [admin, snap?.device_id]);

  // First load: also pick up a job that is still running (page reload mid-provisioning), so progress stays accurate.
  useEffect(() => {
    refresh().then((jobs) => {
      const live = jobs.find((j) => !DONE.has(j.state) && !j.stalled);
      if (live) api.provJob(live.id).then(setJob).catch(() => {});
    });
  }, [refresh]);
  useEffect(() => { const t = setInterval(() => api.provStatus().then(setStatus).catch(() => {}), 5000); return () => clearInterval(t); }, []);
  useEffect(() => {
    if (!job || DONE.has(job.state)) return undefined;
    const t = setInterval(() => api.provJob(job.id).then(setJob).catch(setErr), 1000);
    return () => clearInterval(t);
  }, [job?.id, job?.state]);
  useEffect(() => { if (job && DONE.has(job.state)) { refresh(); if (onDone) onDone(); } }, [job?.state]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!running) return undefined; const t = setInterval(() => setNow(Date.now() / 1000), 1000); return () => clearInterval(t); }, [running]);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  const pwOk = form.password.length >= 8;
  const usbReady = !!status?.available_for_usb;
  const canStart = admin && !running && !busy && usbReady && !onWifi && form.port && ssid && pwOk && confirm;
  const canSwitch = admin && !running && !busy && onWifi && !!cur?.staging_supported && !cur?.trial && !status?.busy_operation && ssid && pwOk;

  const canGo = canSwitch || canStart;
  // One action: a board that is already on Wi-Fi gets the safe staged switch (automatic return to the old network on failure); otherwise the USB setup runs.
  const connect = (e) => { if (e && e.preventDefault) e.preventDefault(); return canSwitch ? changeNetwork() : configure(e); };
  const known = [...networks.map((n) => n.ssid), cur?.configured_ssid, cur?.ssid].filter(Boolean);
  // Network names are case sensitive: "Oneplus 12" is not "OnePlus 12". Point at the real name instead of letting the board fail on a typo.
  const lookalike = ssid && !known.includes(ssid) ? (known.find((k) => k.toLowerCase() === ssid.trim().toLowerCase()) || known.find((k) => editDistance(k.toLowerCase(), ssid.trim().toLowerCase()) <= 2)) : null;
  const why = canGo ? null : (running || status?.busy_operation) ? (running ? `${label(job.state)}: wait for the current Wi-Fi job to finish (the board restores its previous network by itself).` : `Another device operation is running (${status.busy_operation}). Connect is available when it finishes.`) : !ssid ? 'Choose or type a network name.' : !pwOk ? 'Enter the Wi-Fi password (at least 8 characters).' : running ? 'A Wi-Fi job is running.'
    : onWifi ? (cur?.staging_supported ? (cur?.trial ? 'A trial network is already active.' : 'Another device operation is running.') : 'This firmware cannot stage a change: plug the board in over USB.')
    : !usbReady ? 'The board is not ready for USB setup (see the notice above).' : !form.port ? 'No USB port found: plug the board in, or pick the port under More options.' : !confirm ? 'Tick the motor-power confirmation.' : null;

  const doScan = async () => {
    setScanning(true); setScanMsg(null); setErr(null);
    try {
      const r = await api.provScan();
      setScan(r);
      setChoice((c) => c || (r.networks?.length ? '' : '@manual'));
    } catch (e) { setScan(null); setScanMsg(e.message || String(e)); setChoice('@manual'); }
    finally { setScanning(false); }
  };

  const configure = async (e) => {
    e.preventDefault();
    setErr(null); setMsg(null); setBusy(true);
    const body = { device_id: form.device_id, port: form.port, ssid, password: form.password, base_url: form.base_url, confirm_physical: confirm, erase_damaged_nvs: form.erase_damaged_nvs };
    setForm((f) => ({ ...f, password: '' }));                       // the secret leaves the page state as soon as it is sent
    setShowPw(false);
    try { setJob(await api.provStart(body)); } catch (e2) { setErr(e2); } finally { setBusy(false); }
  };

  // Board already on Wi-Fi: a STAGED change. The working network is kept until the new one is verified; the board restores it by itself if the new one fails.
  const changeNetwork = async () => {
    setErr(null); setMsg(null); setBusy(true);
    const body = { device_id: form.device_id || cur?.device_id || '', ssid, password: form.password, base_url: form.base_url };
    setForm((f) => ({ ...f, password: '' }));
    setShowPw(false);
    try { setJob(await api.provSwitch(body)); } catch (e2) { setErr(e2); } finally { setBusy(false); }
  };

  const reconnect = async () => {
    setErr(null); setMsg(null); setBusy(true);
    try { await api.deviceConnect({ port: form.port }); setMsg(`Reconnecting over ${form.port}…`); if (onDone) onDone(); } catch (e2) { setErr(e2); } finally { setBusy(false); }
  };
  const clearRecovery = async () => { setErr(null); try { await api.provRecoveryClear(); await refresh(); setMsg('Recovery block cleared.'); } catch (e2) { setErr(e2); } };
  const reissueCert = async () => { setErr(null); try { const r = await api.provGatewayCert(); setMsg(r.detail || 'Gateway certificate reissued; restart the HTTPS gateway.'); await refresh(); } catch (e2) { setErr(e2); } };

  const isSwitch = job?.kind === 'network_switch';
  const checks = job ? [
    { key: 'a', label: 'Authenticated session (existing device key reused)', state: job.checks?.authenticated_session || job.checks?.identity ? 'ok' : 'pending' },
    ...(isSwitch ? [] : [{ key: 'n', label: 'Network settings verified in device memory', state: job.checks?.nvs_verified ? 'ok' : 'pending' }]),
    { key: 't', label: 'Fresh telemetry', state: job.checks?.telemetry_fresh || job.checks?.wireless_telemetry ? 'ok' : 'pending' },
    { key: 'w', label: 'Wireless link with the same device identity', state: job.wireless ? 'ok' : job.checks?.wireless_session ? 'ok' : (['WIRELESS_PENDING', 'ROLLED_BACK'].includes(job.state) ? 'warn' : 'pending') },
    { key: 'c', label: 'Device console over Wi-Fi', state: job.checks?.console === undefined ? 'pending' : job.checks.console === 'ok' ? 'ok' : 'warn' },
    { key: 'o', label: 'OTA update capability reported', state: job.checks?.ota_ready === undefined ? 'pending' : job.checks.ota_ready === 'ok' ? 'ok' : 'warn' },
  ] : [];
  const waitLeft = job?.wait_until && running ? Math.max(0, Math.round(job.wait_until - now)) : null;
  const tone = job?.state === 'FAILED' ? 'crit' : (job?.state === 'PAIRED_WIRELESS' || job?.state === 'COMMITTED') ? 'ok' : (['WIRELESS_PENDING', 'ROLLED_BACK', 'INTERRUPTED'].includes(job?.state)) ? 'warn' : 'info';

  return (
    <Card title="Configure Wi-Fi" icon={Wifi} sub="Choose your network, enter the password and click Connect" testid="wifi-provisioning"
      right={<Pill tone={usbReady ? 'ok' : 'off'}>{usbReady ? 'Ready' : status ? 'Not ready' : 'Checking…'}</Pill>}>
      {!admin ? <Empty>Admin authorization is required to configure Wi-Fi.</Empty> : <div className="wifi-prov">
        <NowCard cur={cur} trialLeft={cur?.trial_left_s ?? 0} />

        {status?.recovery_required && (
          <div className="tq-callout crit tq-small" role="alert" data-testid="wifi-recovery-required">
            <ShieldAlert size={14} aria-hidden="true" /> <strong>Recovery required.</strong> {status.recovery_required.reason}. Firmware updates and other device operations are blocked until the board
            is provisioned again over USB (this re-reads and verifies it). If you checked the board by hand you can clear the block.{' '}
            <button type="button" className="tq-btn tq-small" onClick={clearRecovery} data-testid="wifi-recovery-clear">Clear recovery block</button>
          </div>)}
        {status && !usbReady && !status.recovery_required && (
          <p className="tq-callout warn tq-small" role="note" data-testid="wifi-prov-unavailable">
            {status.busy_operation ? `Another device operation is running (${status.busy_operation}).` : !status.esptool ? 'esptool is not installed in the backend (pip install -r backend/requirements.txt).' : status.trust_anchor_detail}
          </p>)}
        {status && status.gateway_cert_ok === false && (
          <p className="tq-callout warn tq-small" role="note" data-testid="wifi-cert-warning">
            {status.gateway_cert_detail}. The board would reject the gateway on this network.{' '}
            <button type="button" className="tq-btn tq-small" onClick={reissueCert} data-testid="wifi-cert-reissue">Reissue certificate</button> then restart the HTTPS gateway (<code>npm run dev:lan</code>).
          </p>)}

        <form className="tq-form" onSubmit={connect} autoComplete="off">
          <div className="wifi-grid">
            <label className="wifi-span">Wi-Fi network
              <span className="wifi-inline">
                <select value={manual && networks.length ? '@manual' : choice} onChange={(e) => setChoice(e.target.value)} data-testid="wifi-prov-network" aria-label="Available networks" disabled={!networks.length}>
                  {!networks.length ? <option value="">{scanning ? 'Scanning…' : 'No scan yet — scan, or type the name below'}</option>
                    : <option value="">Choose a network…</option>}
                  {networks.map((n) => (
                    <option key={n.ssid} value={n.ssid}>{n.ssid} · {'▂▄▆█'.slice(0, n.bars || 1)} {n.rssi} dBm · {n.security} · ch {n.channel}{n.current ? ' · current' : ''}{n.configured ? ' · saved' : ''}</option>))}
                  {networks.length > 0 && <option value="@manual">Other / hidden network (type the name)…</option>}
                </select>
                <button type="button" className="tq-btn tq-small" onClick={doScan} disabled={scanning || running} data-testid="wifi-prov-scan" aria-label="Scan for networks">
                  <RefreshCw size={13} aria-hidden="true" /> {scanning ? 'Scanning…' : 'Scan'}
                </button>
              </span>
            </label>
            {picked && (
              <p className="wifi-netinfo wifi-span" data-testid="wifi-prov-picked">
                <SignalBars bars={picked.bars} rssi={picked.rssi} /> <span>{picked.rssi} dBm</span><span>{picked.security}</span><span>channel {picked.channel} · {picked.frequency_mhz} MHz · {picked.band}</span>
                {picked.current && <span className="wifi-chip is-current">current</span>}{picked.configured && <span className="wifi-chip is-saved">saved on board</span>}
              </p>)}
            {manual && (
              <label className="wifi-span">Network name (SSID)
                <input type="text" value={form.ssid} onChange={set('ssid')} maxLength={32} placeholder="Enter your network name" data-testid="wifi-prov-ssid" autoComplete="off" />
              </label>)}
            <p className="tq-small tq-muted wifi-span" data-testid="wifi-prov-note">
              {scanMsg ? `Scanning is unavailable: ${scanMsg} ` : ''}{scan?.note || 'The ESP32-S3 supports 2.4 GHz Wi-Fi only; 5 GHz networks cannot be seen or used. Hidden networks are not listed: type their name.'}
            </p>
            <label className="wifi-span">Wi-Fi password
              <span className="wifi-inline">
                <input type={showPw ? 'text' : 'password'} value={form.password} onChange={set('password')} maxLength={63} autoComplete="new-password" data-testid="wifi-prov-password" />
                <button type="button" className="tq-btn tq-small" onClick={() => setShowPw((v) => !v)} aria-label={showPw ? 'Hide password' : 'Show password'} aria-pressed={showPw}>
                  {showPw ? <EyeOff size={13} aria-hidden="true" /> : <Eye size={13} aria-hidden="true" />}
                </button>
              </span>
            </label>
          </div>
          <details>
            <summary className="tq-small">Advanced</summary>
            <div className="wifi-grid">
            <label>Device
              <input type="text" value={form.device_id} onChange={set('device_id')} maxLength={32} data-testid="wifi-prov-device" />
            </label>
            <label>USB port
              <span className="wifi-inline">
                <select value={form.port} onChange={set('port')} data-testid="wifi-prov-port" aria-label="USB port">
                  <option value="">Select a port…</option>
                  {ports.map((p) => <option key={p.device} value={p.device}>{p.device} — {p.description}{LIKELY_ESP32.test(p.description || '') ? ' (likely ESP32)' : ''}</option>)}
                </select>
                <button type="button" className="tq-btn tq-small" onClick={refresh} aria-label="Rescan ports"><RefreshCw size={13} aria-hidden="true" /></button>
              </span>
            </label>
            </div>
            <label>Backend HTTPS address (leave empty to detect automatically)
              <input type="text" value={form.base_url} onChange={set('base_url')} maxLength={128} placeholder={status?.default_backend_url || 'https://192.168.1.10:8443'} data-testid="wifi-prov-base" />
            </label>
            <p className="tq-small tq-muted">Detected: {status?.default_backend_url || 'unavailable'}</p>
            <label className="tq-check"><input type="checkbox" checked={form.erase_damaged_nvs} onChange={set('erase_damaged_nvs')} data-testid="wifi-prov-rebuild" /> If the board's saved settings are unreadable, rebuild them (unreadable saved settings are lost)</label>
          </details>
          {!onWifi && <label className="tq-check"><input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} data-testid="wifi-prov-confirm" /> Motor power is disconnected; I authorize TORQVA to restart this board (USB setup)</label>}
          <div className="wifi-actions">
            <button type="submit" className="tq-btn tq-primary" disabled={!canGo} data-testid="wifi-prov-connect">
              <Wifi size={14} aria-hidden="true" /> {busy ? 'Connecting…' : 'Connect'}
            </button>
          </div>
          {lookalike && <p className="tq-callout warn tq-small" role="alert" data-testid="wifi-prov-lookalike">Network names must match exactly (including capitals). Did you mean <button type="button" className="tq-linkbtn" onClick={() => { setForm((f) => ({ ...f, ssid: lookalike })); setChoice('@manual'); }}>{lookalike}</button>?</p>}
          {why && <p className="tq-small tq-muted" data-testid="wifi-prov-why">{why}</p>}
          <details>
            <summary className="tq-small">More options</summary>
            <div className="wifi-actions">
              <button type="button" className="tq-btn" disabled={!canStart} onClick={configure} data-testid="wifi-prov-start" title="Write the network over USB">
                <Usb size={14} aria-hidden="true" /> Configure &amp; Connect (USB)
              </button>
              <button type="button" className="tq-btn" disabled={!canSwitch} onClick={changeNetwork} data-testid="wifi-prov-change"
                title={!onWifi ? 'Available when the board is connected over Wi-Fi' : !cur?.staging_supported ? 'This firmware cannot stage a network change; use USB' : 'Try a new network; the current one is kept until it is verified'}>
                Change Network
              </button>
              <button type="button" className="tq-btn" disabled={busy || running || !form.port} onClick={reconnect} data-testid="wifi-prov-reconnect">Reconnect USB</button>
            </div>
          </details>
          {onWifi && cur?.staging_supported && <p className="tq-small tq-muted" role="note">Change Network keeps your working network until the new one is verified, and the board restores it by itself if the new one fails.</p>}
          {onWifi && cur && !cur.staging_supported && <p className="tq-callout warn tq-small" role="note">This firmware cannot stage a network change. Connect the board by USB and use Configure &amp; Connect.</p>}
        </form>
        {msg && <p className="tq-callout ok tq-small" role="status">{msg}</p>}
        <ErrorBox error={err} />

        {job && <div className="wifi-result" data-testid="wifi-prov-progress">
          <StepTracker steps={jobSteps(job)} label="Wi-Fi progress" testid="wifi-prov-steps" />
          <p className={`tq-callout tq-small ${tone}`} role="status" data-testid="wifi-prov-detail">
            <strong>{label(job.state)}</strong> · {job.detail}{job.error_code ? ` (${job.error_code})` : ''}
            {waitLeft != null && <> <span className="wifi-countdown">· {waitLeft} s left</span></>}
            {job.stalled && <> · <strong>no progress for a while</strong></>}
          </p>
          {job.state === 'ROLLED_BACK' && <p className="tq-callout ok tq-small" data-testid="wifi-prov-restored">Your previous network {job.previous_ssid ? `“${job.previous_ssid}” ` : ''}is working again. Nothing was changed.</p>}
          {job.staged && job.state === 'WIRELESS_PENDING' && job.previous_ssid && <p className="tq-callout info tq-small">The board will return to “{job.previous_ssid}” by itself when its trial ends; you do not need to do anything for the old network.</p>}
          {job.error_code === 'NVS_UNREADABLE' && <p className="tq-callout warn tq-small">The board's saved settings could not be read. Tick “rebuild” under Advanced to replace them, then try again.</p>}
          <CheckList items={checks} label="Pairing checks" dense />
          {job.recovery?.length > 0 && <ul className="tq-list tq-small" data-testid="wifi-prov-recovery">{job.recovery.map((r) => <li key={r}>{r}</li>)}</ul>}
          <details><summary className="tq-small">Job log</summary><pre className="wifi-log" data-testid="wifi-prov-log">{(job.logs || []).join('\n')}</pre></details>
        </div>}

        <div className="wifi-history" data-testid="wifi-history">
          <h4 className="tq-mon-subhead">Provisioning history</h4>
          <DataTable caption="Wi-Fi provisioning history" empty="No Wi-Fi changes yet." rows={history} rowKey={(r) => r.id} stack
            columns={[
              { key: 'at', label: 'When', render: (r) => when(r.created_at), sort: (r) => r.created_at },
              { key: 'kind', label: 'Type', render: (r) => (r.kind === 'network_switch' ? 'Network change' : 'USB setup') },
              { key: 'ssid', label: 'Network', render: (r) => r.ssid || '—' },
              { key: 'state', label: 'Result', render: (r) => <Pill tone={TONE[r.state] || 'off'}>{label(r.state)}</Pill> },
              { key: 'detail', label: 'Detail', render: (r) => (r.detail || '').slice(0, 140) },
            ]} />
        </div>
      </div>}
    </Card>
  );
}
