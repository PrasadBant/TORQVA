// Firmware Manager (physical device): upload a compiled ESP32-S3 application image, see the backend's validation, deploy a signed release over Wi-Fi and follow
// the device's own reports to the end. Every stage, percentage and result here is what the backend or the device reported (GET /firmware/status, polled);
// nothing is advanced by the page. A firmware update never starts the motor; physical operation stays in Hardware Manager.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Cpu, Upload, ShieldCheck, ListChecks, Rocket, History, HardDrive, AlertTriangle, CheckCircle2, XCircle, RotateCcw, Clock, FileUp } from 'lucide-react';
import { api } from '../shared/api.js';
import { Card, Empty, ErrorBox, Pill, PageHead, AlertPanel, MetricList, CheckList, StepTracker, DataTable, Disclosure, LinkButton, Tabs, TabPanel, fmt } from '../components/components.jsx';
import { WifiProvisioningCard } from './wifiProvisioning.jsx';
import { FirmwareAssistantPanel, FirmwareRuntimeDiagnostics, SourceWorkspace, WirelessControlCard, WirelessSerialMonitor } from './wirelessWorkspace.jsx';

const kb = (n) => (n == null ? '—' : n >= 1048576 ? `${fmt(n / 1048576, 2)} MB` : `${fmt(n / 1024, 1)} KB`);
const when = (s) => (s ? new Date(s * 1000).toLocaleString() : '—');
const CHECK_STATE = { VERIFIED: 'ok', FAILED: 'fail', PENDING: 'pending', UNAVAILABLE: 'unknown' };
const CHECK_LABEL = { image: 'Image validity', chip: 'ESP32-S3 compatibility', partition: 'Partition compatibility', integrity: 'SHA-256 integrity', signature: 'Signature verification' };
const TERMINAL = new Set(['CONFIRMED', 'FAILED', 'REFUSED', 'ROLLED_BACK', 'VERIFICATION_PENDING']);
// The nine operator-facing stages and the device / backend states that belong to each.
const STAGES = [
  ['prep', 'Preparing', ['REQUESTED', 'AUTHORIZED', 'PREPARING']], ['wifi', 'Connecting to Wi-Fi', ['WIFI']], ['dl', 'Downloading firmware', ['MANIFEST', 'DOWNLOADING']],
  ['ver', 'Verifying image', ['VERIFYING']], ['inst', 'Installing', ['READY']], ['boot', 'Rebooting', ['REBOOTING']], ['recon', 'Reconnecting', ['WAITING_FOR_RECONNECTION']],
  ['test', 'Running self-tests', ['SELF_TEST', 'ROLLBACK']], ['conf', 'Confirming firmware', ['CONFIRMED']],
];
const stageIndex = (st) => STAGES.findIndex(([, , s]) => s.includes(st));

/** Stage states from the deployment's own state and event list: done only for stages the deployment actually passed. */
export function stageSteps(dep) {
  if (!dep) return STAGES.map(([key, label]) => ({ key, label, state: 'pending' }));
  const reached = new Set((dep.events || []).map((e) => stageIndex(e.state)).filter((i) => i >= 0));
  const cur = stageIndex(dep.state);                                   // -1 for a terminal state other than CONFIRMED
  const furthest = Math.max(-1, ...reached);
  const ended = ['FAILED', 'REFUSED', 'ROLLED_BACK', 'VERIFICATION_PENDING'].includes(dep.state);
  const edge = cur >= 0 ? cur : furthest;
  return STAGES.map(([key, label], i) => {
    let state = 'pending';
    let sub;
    if (dep.state === 'CONFIRMED') state = 'done';
    else if (i === cur) state = dep.state === 'ROLLBACK' ? 'failed' : dep.state === 'WAITING_FOR_RECONNECTION' ? 'waiting' : 'active';
    else if (ended && i === furthest) state = dep.state === 'VERIFICATION_PENDING' ? 'waiting' : 'failed';
    else if (i < edge && reached.has(i)) state = 'done';
    else if (i < edge) { state = 'skipped'; sub = 'not reported'; }  // never drawn done without a report
    if (key === 'dl' && dep.total && reached.has(i)) sub = `${kb(dep.bytes)} of ${kb(dep.total)}`;
    return { key, label, state, sub };
  });
}

/** The one-line result of a deployment, only from its terminal state. */
export function resultOf(dep, device) {
  if (!dep) return null;
  if (dep.state === 'CONFIRMED') return ['ok', 'Update successful', `Version ${dep.version} is running and confirmed by the device after its self-tests.${device?.firmware && device.firmware !== dep.version ? ` The device currently reports ${device.firmware}.` : ''}`, CheckCircle2];
  if (dep.state === 'ROLLED_BACK') return ['warn', 'Update rolled back', `${dep.reason} Running: ${device?.firmware || 'unknown'}.`, RotateCcw];
  if (dep.state === 'FAILED' || dep.state === 'REFUSED') return ['crit', 'Update failed', `${dep.reason || 'no reason given'}. The previous firmware remains installed.`, XCircle];
  if (dep.state === 'VERIFICATION_PENDING') return ['warn', 'Update verification pending', dep.reason, Clock];
  if (dep.state === 'WAITING_FOR_RECONNECTION') return ['info', 'WAITING FOR DEVICE RECONNECTION', 'The device restarted into the new image. The result is known only when it reconnects and reports its self-test.', Clock];
  return null;
}

function DeviceStatus({ s }) {
  const d = s?.device || {};
  const o = d.ota;
  const capable = !!(o && o.cap);
  return (
    <Card title="Device firmware status" id="fw-dev" icon={Cpu} testid="fw-device"
      right={!d.connected ? <Pill tone="off">device not connected</Pill> : capable ? <Pill tone="ok">OTA ready</Pill> : <Pill tone="warn">OTA NOT CONFIGURED</Pill>}>
      <MetricList label="Device firmware" items={[
        { key: 'dev', label: 'Device', value: d.device_id || null, missingText: 'not connected' },
        { key: 'link', label: 'Connection', value: d.connected ? (d.transport?.kind === 'wifi' ? 'Wi-Fi' : d.transport?.kind === 'usb' ? 'USB' : null) : null, missingText: 'UNAVAILABLE' },
        { key: 'address', label: 'Device address', value: d.connected && d.transport?.kind === 'wifi' ? d.transport.remote : null, missingText: 'UNAVAILABLE' },
        { key: 'chip', label: 'Chip', value: d.chip || null, missingText: 'UNAVAILABLE' },
        { key: 'fw', label: 'Installed firmware', value: d.firmware || null, missingText: 'UNAVAILABLE' },
        { key: 'prof', label: 'Firmware profile', value: d.profile_label || null, missingText: 'UNAVAILABLE' },
        { key: 'cap', label: 'Update capability', value: !d.connected ? null : capable ? 'OTA capable' : `not configured: ${o?.why || 'the device reports no OTA support'}`, missingText: 'UNAVAILABLE' },
        { key: 'slot', label: 'OTA partitions', value: capable ? `running ${o.run}; inactive slot ${kb(o.psz)}` : null, missingText: 'UNAVAILABLE' },
        { key: 'health', label: 'Firmware health', value: !o ? null : o.pend ? 'new image not yet confirmed (self-test pending)' : 'confirmed image', missingText: 'UNAVAILABLE' },
        { key: 'wifi', label: 'Wireless link', value: d.connected ? (d.transport?.kind === 'wifi' ? 'connected' : 'not connected') : null, missingText: 'UNAVAILABLE' },
        { key: 'last', label: 'Last update', value: o?.last ? `${o.last}${o.lver ? ` (${o.lver})` : ''}` : null, missingText: 'none reported' },
      ]} />
      {d.connected && !capable && (
        <p className="tq-callout warn" role="note" data-testid="fw-not-configured"><strong>OTA NOT CONFIGURED.</strong> This board's firmware cannot be updated over Wi-Fi. An initial USB installation of
          OTA-capable firmware (with the OTA partition table, the signing key and Wi-Fi provisioning) is required first; see docs/hardware/TORQVA_OTA_FIRMWARE_MANAGER.md. The website never flashes over USB.</p>)}
    </Card>
  );
}

/** Reads the first bytes in the browser for an early answer; the backend repeats every check and decides. */
async function preCheck(file, max) {
  if (!file) return [];
  const out = [];
  if (!/\.bin$/i.test(file.name)) out.push('Only a compiled application image (.bin) is accepted: not source code, a bootloader or a partition table.');
  if (file.size === 0) out.push('The file is empty.');
  if (max && file.size > max) out.push(`The file (${kb(file.size)}) is larger than the inactive OTA partition (${kb(max)}).`);
  if (file.size >= 24 && file.slice) {
    try {
      const head = file.slice(0, 24);
      const buf = typeof head.arrayBuffer === 'function' ? await head.arrayBuffer()
        : await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsArrayBuffer(head); });
      const b = new Uint8Array(buf);
      if (b[0] !== 0xE9) out.push('This is not an ESP application image (no 0xE9 header).');
      else if ((b[12] | (b[13] << 8)) !== 9) out.push('This image is not built for the ESP32-S3.');
    } catch { /* the backend checks anyway */ }
  }
  return out;
}

function UploadCard({ admin, max, onUploaded }) {
  const [file, setFile] = useState(null);
  const [problems, setProblems] = useState([]);
  const [sig, setSig] = useState('');
  const [version, setVersion] = useState('');
  const [notes, setNotes] = useState('');
  const [desc, setDesc] = useState('');
  const [prog, setProg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [notice, setNotice] = useState(null);
  const [over, setOver] = useState(false);
  const input = useRef(null);
  const pick = async (f) => { setErr(null); setProg(null); setFile(f || null); setProblems(await preCheck(f, max)); };
  const sigFile = async (f) => { if (f) setSig((await f.text()).trim()); };
  const submit = async () => {
    setBusy(true); setErr(null); setNotice(null); setProg({ sent: 0, total: file.size });
    try { const r = await api.fwUpload(file, { signature: sig, version, notes, description: desc }, (sent, total) => setProg({ sent, total })); setNotice(r.already_exists ? r.reuse_message : `Firmware ${r.version} was validated and saved.`); onUploaded(r); setFile(null); setSig(''); setVersion(''); setNotes(''); setDesc(''); }
    catch (e) { setErr(e); } finally { setBusy(false); }
  };
  if (!admin) return <Card title="Upload firmware" id="fw-up" icon={Upload}><Empty>Uploading firmware requires the admin role.</Empty></Card>;
  return (
    <Card title="Upload firmware" id="fw-up" icon={Upload} sub="Compiled ESP32-S3 application image built with PlatformIO (env esp32s3 or esp32s3_wireless)" testid="fw-upload">
      <div className={`tq-fw-drop${over ? ' is-over' : ''}`} data-testid="fw-drop" onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); pick(e.dataTransfer.files?.[0]); }}>
        <FileUp size={22} aria-hidden="true" />
        <p><strong>Drop firmware.bin here</strong> or <button type="button" className="tq-linkbtn" onClick={() => input.current?.click()}>browse</button></p>
        <p className="tq-muted tq-small">Accepted: .bin application image, at most {kb(max)}. (For .ino/.cpp/.zip source files, use the Docker Compiler workspace below.)</p>
        <input ref={input} type="file" accept=".bin,application/octet-stream" hidden data-testid="fw-file" onChange={(e) => pick(e.target.files?.[0])} />
      </div>
      {file && <p className="tq-small" data-testid="fw-picked"><strong>{file.name}</strong> · {kb(file.size)}</p>}
      {problems.length > 0 && <ul className="tq-callout warn tq-list" role="alert" data-testid="fw-precheck">{problems.map((p) => <li key={p}>{p}</li>)}</ul>}
      <div className="tq-form tq-fw-form">
        <label>Signature (base64, from tools/sign_firmware.py)<textarea rows={2} value={sig} onChange={(e) => setSig(e.target.value)} data-testid="fw-sig" spellCheck={false} /></label>
        <label className="tq-small">or the .sig file <input type="file" accept=".sig,text/plain" onChange={(e) => sigFile(e.target.files?.[0])} /></label>
        <label>Release version (optional; must equal the version compiled into the image)<input value={version} onChange={(e) => setVersion(e.target.value)} placeholder="read from the image" maxLength={24} /></label>
        <label>Release notes<textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} /></label>
        <label>Description (optional)<input value={desc} onChange={(e) => setDesc(e.target.value)} maxLength={500} /></label>
      </div>
      {prog && <div className="tq-fw-progress" data-testid="fw-upload-progress"><progress max={prog.total || 1} value={prog.sent} /> <span className="tq-small tq-num">{kb(prog.sent)} of {kb(prog.total)} sent{busy && prog.sent >= prog.total ? '; the backend is validating' : ''}</span></div>}
      <div className="tq-row tq-mt">
        <button type="button" className="tq-btn tq-primary" disabled={!file || busy || problems.length > 0} onClick={submit} data-testid="fw-upload-btn"><Upload size={14} aria-hidden="true" /> Upload and validate</button>
        <span className="tq-muted tq-small">An upload is not an update: it only stores and validates the release.</span>
      </div>
      <ErrorBox error={err} />
      {notice && <AlertPanel tone="info" title={notice} testid="fw-upload-result"><p>Select the saved release in the library to review validation, deployment history, or explicitly authorize redeployment.</p></AlertPanel>}
    </Card>
  );
}

function Validation({ rec }) {
  return (
    <Card title="Firmware validation" id="fw-val" icon={ShieldCheck} testid="fw-validation" sub={rec ? `Release ${rec.version} · ${rec.id}` : 'Upload or select a release'}
      right={rec ? <Pill tone={rec.deployable ? 'ok' : 'crit'}>{rec.deployable ? 'eligible for deployment' : 'not deployable'}</Pill> : null}>
      {!rec ? <Empty>No release selected.</Empty> : (
        <CheckList label="Validation results" items={[
          ...Object.entries(CHECK_LABEL).map(([k, label]) => {
            const c = rec.checks?.[k] || { status: 'UNAVAILABLE', detail: '' };
            return { key: k, label, state: CHECK_STATE[c.status] || 'unknown', status: c.status, detail: c.detail };
          }),
          { key: 'elig', label: 'Release eligibility', state: rec.deployable ? 'ok' : 'fail', status: rec.deployable ? 'VERIFIED' : 'FAILED', detail: rec.deployable ? 'every check verified' : 'a release must pass every check' },
        ]} />)}
    </Card>
  );
}

function Releases({ rows, selected, onSelect, admin, deviceId, onRolledBack }) {
  const [rbBusy, setRbBusy] = useState(null);
  const [rbErr, setRbErr] = useState(null);
  const [search, setSearch] = useState('');
  const [favorites, setFavorites] = useState(false);
  const shown = rows.filter((r) => !r.archived && (!favorites || r.favorite) && (!search.trim() || [r.name, r.version, r.original_filename, ...(r.tags || [])].join(' ').toLowerCase().includes(search.trim().toLowerCase())));
  const rollbackTo = async (r) => {
    setRbBusy(r.id); setRbErr(null);
    try { await api.fwRollback({ release_id: r.id, device_id: deviceId || '' }); if (onRolledBack) onRolledBack(); }
    catch (e) { setRbErr(e); } finally { setRbBusy(null); }
  };
  return (
    <Card title="Available firmware releases" id="fw-rel" icon={HardDrive} testid="fw-releases">
      <ErrorBox error={rbErr} />
      <div className="tq-row" style={{ gap: '0.5rem', flexWrap: 'wrap', marginBottom: '0.75rem' }}>
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name, version, filename or tag" aria-label="Search firmware library" style={{ flex: '1 1 260px' }} />
        <label className="tq-check"><input type="checkbox" checked={favorites} onChange={(e) => setFavorites(e.target.checked)} /> Favorites only</label>
      </div>
      <DataTable caption="Firmware releases" rows={shown} rowKey={(r) => r.id} empty="No matching firmware releases." stack
        rowClass={(r) => (r.id === selected ? 'tq-as-active-row' : undefined)}
        columns={[
          { key: 'v', label: 'Firmware', render: (r) => <button type="button" className="tq-linkbtn" onClick={() => onSelect(r.id)} aria-label={r.version} aria-pressed={r.id === selected}>{r.favorite ? '★ ' : ''}{r.name || r.version}<span className="tq-muted tq-small"> · {r.version}</span></button> },
          { key: 'tags', label: 'Tags', render: (r) => (r.tags || []).join(', ') || '—' },
          { key: 'up', label: 'Uploaded', render: (r) => `${when(r.uploaded_at)} · ${r.uploaded_by}` },
          { key: 'st', label: 'Release status', render: (r) => <Pill tone={r.deployable ? 'ok' : 'crit'}>{r.status}</Pill> },
          { key: 'chip', label: 'Compatibility', render: (r) => r.checks?.chip?.status || '—' },
          { key: 'sig', label: 'Signature', render: (r) => r.checks?.signature?.status || '—' },
          { key: 'dep', label: 'Deployment', render: (r) => r.deployments?.length ? r.deployments[r.deployments.length - 1].state : 'not deployed' },
          ...(admin ? [{
            key: 'act',
            label: 'Rollback',
            render: (r) => r.deployable ? (
              <button type="button" className="tq-btn tq-small" disabled={rbBusy === r.id} onClick={() => rollbackTo(r)} data-testid={`fw-rollback-${r.id}`}>
                <RotateCcw size={12} aria-hidden="true" /> Rollback
              </button>
            ) : '—',
          }] : []),
        ]} />
    </Card>
  );
}

function ReleaseMetadata({ rec, admin, onSaved }) {
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => { setForm(rec ? { name: rec.name || rec.version, description: rec.description || '', notes: rec.notes || '', tags: (rec.tags || []).join(', '), favorite: !!rec.favorite, archived: !!rec.archived } : null); setSaved(false); setErr(null); }, [rec?.id]);
  if (!rec || !form) return <Card title="Release metadata"><Empty>Select a firmware release to edit its library metadata.</Empty></Card>;
  const submit = async (e) => {
    e.preventDefault(); setBusy(true); setErr(null); setSaved(false);
    try { const out = await api.fwUpdateRelease(rec.id, { ...form, tags: form.tags.split(',').map((x) => x.trim()).filter(Boolean) }); setSaved(true); onSaved(out); }
    catch (error) { setErr(error); } finally { setBusy(false); }
  };
  return <Card title="Release metadata" sub={`Signed identity fields for ${rec.version} remain immutable`} testid="fw-release-metadata">
    {!admin ? <Empty>Admin access is required to edit release metadata.</Empty> : <form className="tq-form" onSubmit={submit}>
      <label>Custom firmware name<input value={form.name} maxLength={100} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></label>
      <label>Description<textarea rows={2} value={form.description} maxLength={500} onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>
      <label>Release notes<textarea rows={3} value={form.notes} maxLength={2000} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></label>
      <label>Tags (comma separated)<input value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} placeholder="production, stable, rig-1" /></label>
      <div className="tq-row"><label className="tq-check"><input type="checkbox" checked={form.favorite} onChange={(e) => setForm({ ...form, favorite: e.target.checked })} /> Favorite</label><label className="tq-check"><input type="checkbox" checked={form.archived} onChange={(e) => setForm({ ...form, archived: e.target.checked })} /> Archive</label></div>
      <button className="tq-btn tq-primary" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save metadata'}</button>
      {saved && <p className="tq-callout ok tq-small">Metadata saved. Firmware bytes, signature and version were not changed.</p>}<ErrorBox error={err} />
    </form>}
  </Card>;
}

function UpdateDevice({ rec, detail, s, admin, onDeployed }) {
  const d = s?.device || {};
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const why = detail?.eligibility || [];
  const active = s?.current && !TERMINAL.has(s.current.state);
  const ready = admin && rec && detail?.id === rec.id && d.connected && d.session_active && d.ota?.cap && !active && why.length === 0;
  useEffect(() => { setErr(null); }, [rec?.id]);
  const go = async () => { setBusy(true); setErr(null); try { onDeployed(await api.fwDeploy({ release_id: rec.id, device_id: d.device_id })); } catch (e) { setErr(e); } finally { setBusy(false); } };
  const reinstall = async () => { setBusy(true); setErr(null); try { onDeployed(await api.fwDeploy({ release_id: rec.id, device_id: d.device_id, reinstall: true })); } catch (e) { setErr(e); } finally { setBusy(false); } };
  const restoreLkg = async () => { setBusy(true); setErr(null); try { onDeployed(await api.fwRestoreLastKnownGood({ release_id: rec?.id || '000000000000', device_id: d.device_id || '' })); } catch (e) { setErr(e); } finally { setBusy(false); } };
  const slotRollback = async () => { setBusy(true); setErr(null); try { await api.fwRollback({ slot_rollback: true, device_id: d.device_id || '' }); onDeployed(); } catch (e) { setErr(e); } finally { setBusy(false); } };
  return (
    <Card title="Update device" id="fw-upd" icon={Rocket} testid="fw-update">
      {!rec ? (<>
        <Empty>Select a release to check it against the connected device.</Empty>
        {admin && d.connected && d.session_active && d.ota?.cap && (
          <div className="tq-row tq-mt">
            <button type="button" className="tq-btn tq-small" disabled={busy} onClick={slotRollback} data-testid="fw-slot-rollback">
              <RotateCcw size={13} aria-hidden="true" /> Switch to Previous OTA Slot
            </button>
          </div>
        )}
      </>) : (<>
        <MetricList label="Update" items={[
          { key: 'cur', label: 'Current version', value: d.firmware || null, missingText: 'UNAVAILABLE' },
          { key: 'tgt', label: 'Target version', value: rec.version },
          { key: 'tprof', label: 'Release profile', value: rec.profile === 'ota_led_bench' ? 'OTA LED bench (no motor control)' : 'production' },
          { key: 'el', label: 'Update eligibility', value: why.length ? 'not eligible' : 'eligible' },
          { key: 'sf', label: 'Device readiness', value: d.ota?.blk ? `device not ready: ${d.ota.blk}` : d.ota ? (d.profile === 'ota_led_bench' ? 'LED bench device: no motor hardware' : 'motor stopped and motor power absent, as measured by the device') : null, missingText: 'UNAVAILABLE' },
          { key: 'rs', label: 'Expected restart', value: 'yes: the device restarts into the new image and must reconnect' },
        ]} />
        {why.length > 0 && <ul className="tq-callout warn tq-list" data-testid="fw-readiness">{why.map((w) => <li key={w}>{w}</li>)}</ul>}
        <AlertPanel tone="warn" icon={AlertTriangle} title="Before updating" testid="fw-warning">
          <p>Disconnect the motor power stage. The update never starts the motor, and after the restart, verify the device state before operating the motor.
            If the new image fails its self-tests, the device rolls back to the current firmware.</p>
        </AlertPanel>
        {admin ? (<>
          <div className="tq-row tq-mt" style={{ gap: '0.5rem', flexWrap: 'wrap' }}>
            <button type="button" className="tq-btn tq-primary" onClick={go} disabled={!ready || busy} data-testid="fw-deploy"><Rocket size={14} aria-hidden="true" /> {busy ? 'Preparing update…' : 'Upload wirelessly'}</button>
            {rec.version === d.firmware && <button type="button" className="tq-btn" onClick={reinstall} disabled={busy || active || !d.connected || !d.session_active} data-testid="fw-reinstall"><RotateCcw size={14} aria-hidden="true" /> Reinstall Current</button>}
            <button type="button" className="tq-btn" onClick={restoreLkg} disabled={busy || active || !d.connected || !d.session_active} data-testid="fw-restore-lkg"><History size={14} aria-hidden="true" /> Restore Last Known Good</button>
            {d.connected && d.session_active && d.ota?.cap && (
              <button type="button" className="tq-btn" disabled={busy || active} onClick={slotRollback} data-testid="fw-slot-rollback">
                <RotateCcw size={14} aria-hidden="true" /> Rollback OTA Slot
              </button>
            )}
          </div>
        </>) : <p className="tq-muted tq-small">Deploying firmware requires the admin role.</p>}
        <ErrorBox error={err} />
      </>)}
    </Card>
  );
}

function UsbDeployment({ rec, s, admin }) {
  const [cap, setCap] = useState(null); const [confirm, setConfirm] = useState(false); const [rollback, setRollback] = useState(false);
  const [job, setJob] = useState(null); const [err, setErr] = useState(null); const d = s?.device || {}; const port = d.transport?.kind === 'usb' ? d.transport?.port : '';
  useEffect(() => { api.fwUsbStatus().then(setCap).catch(setErr); }, []);
  useEffect(() => { if (!job || ['VERIFIED', 'VERIFICATION_FAILED', 'FAILED'].includes(job.state)) return undefined; const timer = setInterval(() => api.fwUsbJob(job.id).then(setJob).catch(setErr), 1000); return () => clearInterval(timer); }, [job?.id, job?.state]);
  const start = async () => { setErr(null); try { setJob(await api.fwUsbStart({ release_id: rec.id, device_id: d.device_id || '', port, confirm_physical: confirm, allow_rollback: rollback })); } catch (e) { setErr(e); } };
  return <Card title="USB firmware recovery" icon={HardDrive} sub="Writes only a validated stored application image; transfer completion is not verification" testid="fw-usb-deploy" right={<Pill tone={cap?.available ? 'ok' : 'off'}>{cap?.available ? 'Available' : 'Infrastructure required'}</Pill>}>
    {!cap?.available ? <Empty>{cap?.detail || 'Checking USB flashing infrastructure…'}</Empty> : !admin ? <Empty>Admin authorization is required.</Empty> : <>
      <MetricList label="USB target" items={[{ key: 'port', label: 'Authenticated owned port', value: port || null, missingText: 'UNAVAILABLE' }, { key: 'dev', label: 'Device identity', value: d.device_id || null, missingText: 'UNAVAILABLE' }, { key: 'rel', label: 'Selected release', value: rec ? `${rec.name || rec.version} (${rec.version})` : null, missingText: 'UNAVAILABLE' }]} />
      <label className="tq-check"><input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} /> I confirm motor power is disconnected and authorize physical USB recovery</label>
      <label className="tq-check"><input type="checkbox" checked={rollback} onChange={(e) => setRollback(e.target.checked)} /> Explicitly authorize reinstall or older compatible firmware</label>
      <button type="button" className="tq-btn tq-primary" disabled={!rec || !port || !confirm || !!job && !['VERIFIED', 'VERIFICATION_FAILED', 'FAILED'].includes(job.state)} onClick={start}>Start USB Flash</button>
      {job && <div className="tq-mt"><Pill tone={job.state === 'VERIFIED' ? 'ok' : job.state.includes('FAILED') ? 'crit' : 'wait'}>{job.state}</Pill><progress max={100} value={job.progress || 0} /><p className="tq-small">{job.detail}</p><pre style={{ maxHeight: 180, overflow: 'auto', whiteSpace: 'pre-wrap' }}>{(job.logs || []).join('\n')}</pre></div>}
      <ErrorBox error={err} />
    </>}
  </Card>;
}

function Progress({ dep, device, go }) {
  const res = resultOf(dep, device);
  const pct = dep?.total ? Math.min(100, Math.round((dep.bytes / dep.total) * 100)) : null;
  return (
    <Card title="Installation progress" id="fw-prog" icon={ListChecks} testid="fw-progress" sub={dep ? `Deployment ${dep.id} · ${dep.from_version || '?'} → ${dep.version} · requested by ${dep.requested_by}` : 'No deployment yet'}>
      <StepTracker steps={stageSteps(dep)} label="Installation stages" testid="fw-stages" />
      {dep && ['DOWNLOADING', 'MANIFEST'].includes(dep.state) && pct != null && (
        <div className="tq-fw-progress" data-testid="fw-dl"><progress max={100} value={pct} /> <span className="tq-small tq-num">{pct} % · {kb(dep.bytes)} of {kb(dep.total)} written by the device</span></div>)}
      {res && (
        <AlertPanel tone={res[0]} icon={res[3]} title={res[1]} testid="fw-result" action={dep.state === 'CONFIRMED' && go ? <LinkButton aria-label="Return to Hardware Manager" onClick={() => go('device')}>Return to Hardware Manager</LinkButton> : null}>
          <p>{res[2]}</p>
          {dep.state === 'CONFIRMED' && <p className="tq-small">The update completed without starting the motor. Review the connected device in Hardware Manager before operation.</p>}
        </AlertPanel>)}
      {dep && (
        <Disclosure summary="Advanced details" meta={`${(dep.events || []).length} recorded event(s)`} testid="fw-events">
          <DataTable caption="Deployment events" rows={[...(dep.events || [])].reverse()} rowKey={(e) => `${e.at}-${e.state}`}
            columns={[{ key: 'at', label: 'Time', render: (e) => when(e.at) }, { key: 'st', label: 'State', render: (e) => e.state }, { key: 'd', label: 'Detail', render: (e) => <span className="tq-muted">{e.detail || '—'}</span> }]} />
          {device?.ota && <p className="tq-small tq-muted">Device report: running {device.ota.run}, inactive slot {kb(device.ota.psz)}, {device.ota.pend ? 'self-test pending' : 'confirmed'}{device.ota.blk ? `, update refused now: ${device.ota.blk}` : ''}.</p>}
        </Disclosure>)}
    </Card>
  );
}

function HistoryCard({ rows }) {
  const items = rows.filter((h) => h.kind === 'deployment_result' || h.kind === 'deployment_requested' || h.kind === 'release_uploaded').reverse();
  return (
    <Card title="Update history" id="fw-hist" icon={History} testid="fw-history" sub="Append-only record kept by the backend">
      <DataTable caption="Update history" rows={items} rowKey={(h, i) => `${h.at}-${h.kind}-${h.release}`} empty="No firmware activity yet." stack
        columns={[
          { key: 'at', label: 'Time', render: (h) => when(h.at) },
          { key: 'k', label: 'Event', render: (h) => ({ release_uploaded: 'Release uploaded', deployment_requested: 'Update requested', deployment_result: 'Update result' })[h.kind] },
          { key: 'v', label: 'Version', render: (h) => h.version },
          { key: 'r', label: 'Result', render: (h) => (h.kind === 'deployment_result' ? <Pill tone={h.result === 'CONFIRMED' ? 'ok' : h.result === 'VERIFICATION_PENDING' || h.result === 'ROLLED_BACK' ? 'warn' : 'crit'}>{h.result}</Pill> : h.kind === 'release_uploaded' ? (h.deployable ? 'deployable' : 'not deployable') : `by ${h.by}`) },
          { key: 'd', label: 'Detail', render: (h) => <span className="tq-muted">{h.reason || (h.device ? `device ${h.device}` : '') || (h.sha256 ? `SHA-256 ${String(h.sha256).slice(0, 12)}…` : '')}</span> },
        ]} />
    </Card>
  );
}

export function FirmwarePage({ role, go }) {
  const admin = role === 'admin';
  const [tab, setTab] = useState('overview');
  const [s, setS] = useState(null);
  const [rel, setRel] = useState([]);
  const [hist, setHist] = useState([]);
  const [sel, setSel] = useState(null);
  const [detail, setDetail] = useState(null);
  const [err, setErr] = useState(null);
  const load = useCallback(async () => {
    try {
      const [st, r, h] = await Promise.all([api.fwStatus(), api.fwReleases(), api.fwDeployments()]);
      setS(st); setRel(r.releases || []); setHist(h.history || []); setErr(null);
    } catch (e) { setErr(e); }
  }, []);
  const active = s?.current && !TERMINAL.has(s.current.state);
  useEffect(() => { load(); const id = setInterval(load, active ? 1500 : 5000); return () => clearInterval(id); }, [load, active]);
  useEffect(() => { if (!sel) { setDetail(null); return; } api.fwRelease(sel).then(setDetail).catch(() => setDetail(null)); }, [sel, s?.device?.ota?.blk, s?.device?.firmware, s?.current?.state]);
  const rec = rel.find((r) => r.id === sel) || null;
  const cfg = s?.config;
  const tabs = [
    { key: 'overview', label: 'Overview' }, { key: 'development', label: 'Development' }, { key: 'build', label: 'Build' },
    { key: 'deployment', label: 'Deployment' }, { key: 'library', label: 'Firmware Library', count: rel.length },
    { key: 'console', label: 'Console & Diagnostics' }, { key: 'devices', label: 'Device Management' }, { key: 'security', label: 'Security & Audit' },
  ];
  return (
    <>
      <PageHead title="Firmware Manager" sub="Develop, validate and install signed ESP32-S3 firmware over supported USB or authenticated Wi-Fi transports." />
      {err && <ErrorBox error={err} />}
      {cfg && (cfg.signature_verification !== 'AVAILABLE' || cfg.device_url_problem || cfg.storage !== 'OK') && (
        <p className="tq-callout warn" role="note" data-testid="fw-config">Backend not ready for deployments: {[cfg.signature_verification !== 'AVAILABLE' && `signature verification unavailable (${cfg.signature_detail})`, cfg.device_url_problem, cfg.storage !== 'OK' && cfg.storage_detail].filter(Boolean).join('; ')}.</p>)}
      {cfg?.key_fingerprint && <p className="tq-small tq-muted" data-testid="fw-key">Release key {cfg.key_fingerprint} · device download URL {cfg.device_url}</p>}
      <Tabs tabs={tabs} value={tab} onChange={setTab} label="Firmware engineering workspaces" idBase="firmware-workspace" />
      <TabPanel tab={tab} idBase="firmware-workspace">
        {tab === 'overview' && <div className="tq-firmware-workspace tq-mt"><DeviceStatus s={s} /><Progress dep={s?.current} device={s?.device} go={go} /><HistoryCard rows={hist} /></div>}
        {(tab === 'development' || tab === 'build') && <div className="tq-mt"><SourceWorkspace admin={admin} deviceId={s?.device?.device_id} onCompiled={(r) => { setSel(r.release?.id || r.id); load(); }} onDeployed={load} /></div>}
        {tab === 'deployment' && <><div className="tq-grid tq-grid-wide tq-mt"><Validation rec={rec} /><UpdateDevice rec={rec} detail={detail} s={s} admin={admin} onDeployed={load} /></div><div className="tq-mt"><UsbDeployment rec={rec} s={s} admin={admin} /></div><div className="tq-mt"><Progress dep={s?.current} device={s?.device} go={go} /></div></>}
        {tab === 'library' && <><div className="tq-mt"><UploadCard admin={admin} max={cfg?.max_image_bytes} onUploaded={(r) => { setSel(r.id); load(); }} /></div><div className="tq-mt"><Releases rows={rel} selected={sel} onSelect={setSel} admin={admin} deviceId={s?.device?.device_id} onRolledBack={load} /></div><div className="tq-grid tq-grid-wide tq-mt"><Validation rec={rec} /><ReleaseMetadata rec={rec} admin={admin} onSaved={(out) => { setDetail(out); setRel((rows) => rows.map((r) => r.id === out.id ? out : r)); }} /></div></>}
        {tab === 'console' && <><div className="tq-grid tq-grid-wide tq-mt"><WirelessSerialMonitor /><FirmwareRuntimeDiagnostics device={s?.device} /></div><div className="tq-mt"><FirmwareAssistantPanel defaultTask="crash_analysis" /></div></>}
        {tab === 'devices' && <div className="tq-mt"><WifiProvisioningCard admin={admin} snap={s?.device} onDone={load} /><div className="tq-mt" /><WirelessControlCard admin={admin} operator={admin || role === 'operator'} snap={s?.device} onRefreshed={load} /></div>}
        {tab === 'security' && <div className="tq-grid tq-grid-wide tq-mt"><Card title="Firmware trust configuration" icon={ShieldCheck}><MetricList label="Firmware security" items={[
          { key: 'sig', label: 'Signature verification', value: cfg?.signature_verification || null, missingText: 'UNAVAILABLE' }, { key: 'key', label: 'Trusted key fingerprint', value: cfg?.key_fingerprint || null, missingText: 'UNAVAILABLE' },
          { key: 'url', label: 'Authenticated OTA endpoint', value: cfg?.device_url || null, missingText: 'UNAVAILABLE' }, { key: 'store', label: 'Artifact storage', value: cfg?.storage || null, missingText: 'UNAVAILABLE' },
          { key: 'role', label: 'Deployment authority', value: admin ? 'Admin — explicit authorization required' : `${role} — deployment unavailable` },
        ]} /></Card><HistoryCard rows={hist} /></div>}
      </TabPanel>
    </>
  );
}
