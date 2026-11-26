// Engineering Workspace components: Multi-file Source Editor, Live Docker Compilation Console,
// Automatic ESP32 Discovery, Manual IP Fallback, Wi-Fi Network Manager, Remote Restart, and Wireless Serial Monitor.
import React, { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import {
  Code2, Play, Rocket, Terminal, Wifi, Radar, RefreshCw, Download, Search,
  Pause, Trash2, Plus, FileCode2, Cpu, RotateCcw, CheckCircle2, XCircle, Globe,
} from 'lucide-react';
import { api } from '../shared/api.js';
import { Card, Empty, ErrorBox, Pill, MetricList, fmt } from '../components/components.jsx';

const MonacoEditor = lazy(() => import('./MonacoEditorLocal.jsx'));
const DRAFT_KEY = 'torqva.firmware.workspace.v1';
const initialFiles = () => {
  try { const saved = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'); if (saved?.files && typeof saved.files === 'object') return saved.files; } catch { /* use safe default */ }
  return { 'src/custom_sketch.ino': '// Custom Arduino sketch bridged with TORQVA Wireless OTA.\nvoid setup() {\n  // Initialize custom hardware or sensors\n}\n\nvoid loop() {\n  delay(100);\n}\n' };
};

export function FirmwareAssistantPanel({ context = '', defaultTask = 'code_review' }) {
  const [status, setStatus] = useState(null); const [task, setTask] = useState(defaultTask); const [evidence, setEvidence] = useState(context);
  const [consent, setConsent] = useState(false); const [result, setResult] = useState(null); const [err, setErr] = useState(null); const [busy, setBusy] = useState(false);
  useEffect(() => { api.fwAssistantStatus().then(setStatus).catch((e) => setErr(e)); }, []);
  useEffect(() => { if (context) setEvidence(context); }, [context]);
  const run = async () => { setBusy(true); setErr(null); setResult(null); try { setResult(await api.fwAssistantAnalyze({ task, context: evidence, consent_external: consent })); } catch (e) { setErr(e); } finally { setBusy(false); } };
  return <Card title="AI Firmware Assistant" icon={Code2} sub="Advisory analysis only; it cannot edit, deploy, sign or command a device" testid="fw-ai-assistant" right={<Pill tone={status?.available ? 'ok' : 'off'}>{status?.available ? `${status.provider} · ${status.model}` : 'Unavailable'}</Pill>}>
    {!status?.available ? <Empty>{status?.detail || 'Checking configured AI provider…'}</Empty> : <>
      <div className="tq-row" style={{ gap: '0.5rem', flexWrap: 'wrap' }}><select value={task} onChange={(e) => setTask(e.target.value)} aria-label="AI firmware task">
        <option value="explain">Explain source</option><option value="compile_error">Analyze compilation error</option><option value="code_review">Review code quality</option>
        <option value="crash_analysis">Analyze crash log</option><option value="memory">Memory optimization</option><option value="performance">Performance review</option>
        <option value="security">Security review</option><option value="safety">Safety review</option><option value="compatibility">Hardware compatibility</option><option value="troubleshoot">Guided troubleshooting</option>
      </select><label className="tq-check"><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} /> I authorize transmitting the evidence below to the configured provider</label></div>
      <textarea rows={7} value={evidence} onChange={(e) => setEvidence(e.target.value)} placeholder="Selected source, compiler diagnostics or crash logs" aria-label="AI evidence" />
      <button type="button" className="tq-btn tq-primary" onClick={run} disabled={busy || !consent || !evidence.trim()}>{busy ? 'Analyzing…' : 'Analyze Evidence'}</button>
      {result && <div className="tq-callout info tq-mt"><p><strong>Advisory result — review required</strong></p><pre style={{ whiteSpace: 'pre-wrap', maxHeight: 420, overflow: 'auto' }}>{result.analysis}</pre><p className="tq-small">{result.notice}</p></div>}
      <ErrorBox error={err} />
    </>}
  </Card>;
}

/* ------------------------------------------------------------------ 1. Multi-File Source Editor + Docker Compiler */
export function SourceWorkspace({ admin, deviceId, onCompiled, onDeployed }) {
  const [docker, setDocker] = useState(null);
  const [templates, setTemplates] = useState([]);
  const [files, setFiles] = useState(initialFiles);
  const [baseline, setBaseline] = useState(initialFiles);
  const [activeFile, setActiveFile] = useState('src/custom_sketch.ino');
  const [newName, setNewName] = useState('');
  const [renameTo, setRenameTo] = useState('');
  const [profile, setProfile] = useState('esp32s3_wireless');
  const [version, setVersion] = useState('');
  const [notes, setNotes] = useState('');
  const [sig, setSig] = useState('');
  const [job, setJob] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [zipFile, setZipFile] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const srcInputRef = useRef(null);
  const logRef = useRef(null);
  const editorRef = useRef(null);

  useEffect(() => {
    const timer = setTimeout(() => { try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ files, activeFile, profile, savedAt: Date.now() })); } catch { /* storage unavailable */ } }, 350);
    return () => clearTimeout(timer);
  }, [files, activeFile, profile]);

  const handleSourceDrop = async (f) => {
    if (!f) return;
    setErr(null);
    if (/\.(zip|bin)$/i.test(f.name)) {
      setZipFile(f);
      return;
    }
    if (/\.(ino|cpp|c|h|hpp)$/i.test(f.name)) {
      setZipFile(null);
      const txt = await f.text();
      const targetPath = f.name.includes('/') ? f.name : `src/${f.name}`;
      setFiles((prev) => ({ ...prev, [targetPath]: txt }));
      setActiveFile(targetPath);
      return;
    }
    setErr(new Error('Supported uploads: .ino, .cpp, .c, .h, .hpp, .zip, .bin'));
  };

  const triggerZipCompile = async (autoDeploy) => {
    if (!zipFile) return;
    setBusy(true);
    setErr(null);
    try {
      const started = await api.fwCompileUpload(zipFile, {
        version: version.trim(),
        profile,
        notes: notes.trim(),
        signature: sig.trim(),
        auto_upload: 'true',
        auto_deploy: autoDeploy ? 'true' : 'false',
        device_id: deviceId || '',
      });
      setJob(started);
      setZipFile(null);
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    api.fwDocker().then(setDocker).catch(() => null);
    api.fwTemplates().then((r) => {
      if (r?.templates?.length) setTemplates(r.templates);
    }).catch(() => null);
  }, []);

  // Poll live compilation job while running
  useEffect(() => {
    if (!job || ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(job.state)) return undefined;
    const iv = setInterval(() => {
      api.fwCompileJob(job.id).then((updated) => {
        setJob(updated);
        if (updated.state === 'SUCCEEDED') {
          if (updated.release && onCompiled) onCompiled(updated.release);
          if (updated.deployment && onDeployed) onDeployed(updated.deployment);
        }
      }).catch(() => null);
    }, 900);
    return () => clearInterval(iv);
  }, [job?.id, job?.state, onCompiled, onDeployed]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [job?.logs?.length]);

  const fileKeys = Object.keys(files);
  const activeCode = files[activeFile] ?? '';
  const lineCount = Math.max(1, activeCode.split('\n').length);
  const changedFiles = [...new Set([...Object.keys(files), ...Object.keys(baseline)])].filter((name) => files[name] !== baseline[name]);

  const loadTemplate = (tplId) => {
    const t = templates.find((x) => x.id === tplId);
    if (!t || !t.files) return;
    setFiles({ ...t.files });
    setBaseline({ ...t.files });
    const first = Object.keys(t.files)[0];
    if (first) setActiveFile(first);
    if (t.profile) setProfile(t.profile);
    setErr(null);
  };

  const addFile = () => {
    const clean = newName.trim().replace(/^\/+/, '');
    if (!clean) return;
    const path = clean.includes('/') ? clean : `src/${clean}`;
    if (!/\.(ino|cpp|c|h|hpp)$/i.test(path)) {
      setErr(new Error('Supported extensions: .ino, .cpp, .c, .h, .hpp'));
      return;
    }
    setFiles((prev) => ({ ...prev, [path]: prev[path] ?? `// ${path}\n` }));
    setActiveFile(path);
    setNewName('');
    setErr(null);
  };

  const removeFile = (path) => {
    if (fileKeys.length <= 1) return;
    setFiles((prev) => {
      const next = { ...prev };
      delete next[path];
      return next;
    });
    if (activeFile === path) {
      const remaining = fileKeys.filter((k) => k !== path);
      setActiveFile(remaining[0] || '');
    }
  };

  const renameFile = () => {
    const target = renameTo.trim().replace(/^\/+/, '');
    if (!target || target === activeFile || !/\.(ino|cpp|c|h|hpp)$/i.test(target) || files[target]) { setErr(new Error('Choose a unique source path ending in .ino, .cpp, .c, .h or .hpp')); return; }
    setFiles((prev) => { const next = { ...prev, [target]: prev[activeFile] }; delete next[activeFile]; return next; });
    setActiveFile(target); setRenameTo(''); setErr(null);
  };

  const exportProject = async () => {
    const { default: JSZip } = await import('jszip');
    const zip = new JSZip(); Object.entries(files).forEach(([name, source]) => zip.file(name, source));
    zip.file('platformio.ini', `[env:${profile}]\nplatform = espressif32\nboard = esp32-s3-devkitc-1\nframework = arduino\n`);
    const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
    const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `torqva-${version || 'draft'}.zip`; a.click(); URL.revokeObjectURL(url);
  };

  const triggerCompile = async (autoDeploy) => {
    setBusy(true);
    setErr(null);
    try {
      const started = await api.fwCompileEditor({
        files,
        version: version.trim(),
        profile,
        notes: notes.trim(),
        signature: sig.trim(),
        auto_upload: true,
        auto_deploy: autoDeploy,
        device_id: deviceId || '',
      });
      setJob(started);
      if (started.state === 'SUCCEEDED') {
        if (started.release && onCompiled) onCompiled(started.release);
        if (started.deployment && onDeployed) onDeployed(started.deployment);
      }
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };

  const dockerTone = !docker ? 'off' : docker.available && docker.image_ready ? 'ok' : docker.available ? 'warn' : 'crit';
  const dockerLabel = !docker ? 'Checking Docker…' : docker.available && docker.image_ready ? `Docker ${docker.server_version} · torqva-pio ready` : docker.available ? 'Docker ready (building toolchain)' : `Docker unavailable: ${docker.error || 'off'}`;

  return (
    <Card
      title="Source Code Editor & Isolated Docker Compiler"
      id="fw-editor"
      icon={Code2}
      testid="fw-source-workspace"
      sub="Edit or compose ESP32-S3 source code (.ino, .cpp, .c, .h, .hpp), compile in an isolated --network none Docker container, validate, and deploy OTA"
      right={<Pill tone={dockerTone}>{dockerLabel}</Pill>}
    >
      {!admin ? (
        <Empty>Source compilation and OTA deployment require the admin role.</Empty>
      ) : (
        <>
          <div className="tq-row" style={{ gap: '0.5rem', flexWrap: 'wrap', marginBottom: '0.75rem', alignItems: 'center' }}>
            {templates.length > 0 && (
              <label className="tq-small" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                <span>Template:</span>
                <select onChange={(e) => { if (e.target.value) loadTemplate(e.target.value); }} defaultValue="" data-testid="fw-template-select">
                  <option value="">Load workspace template…</option>
                  {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </label>
            )}
            <label className="tq-small" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
              <span>Profile:</span>
              <select value={profile} onChange={(e) => setProfile(e.target.value)} data-testid="fw-profile-select">
                <option value="esp32s3_wireless">esp32s3_wireless (Production Motor + Wi-Fi + OTA)</option>
                <option value="esp32s3_ota_led_v112">esp32s3_ota_led_v112 (OTA LED Bench + Wi-Fi)</option>
                <option value="esp32s3">esp32s3 (USB + OTA)</option>
              </select>
            </label>
            <input
              type="text"
              value={version}
              onChange={(e) => setVersion(e.target.value)}
              placeholder="Version (auto if blank, e.g. 1.1.3)"
              aria-label="Target firmware version"
              style={{ maxWidth: '185px' }}
              data-testid="fw-compile-version"
            />
            <input
              type="text"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Release notes"
              aria-label="Release notes"
              style={{ flex: 1, minWidth: '140px' }}
            />
          </div>

          {/* Drag-and-drop source file (.ino, .cpp, .c, .h, .hpp, .zip) */}
          <div
            className={`tq-fw-drop${dragOver ? ' is-over' : ''}`}
            style={{ padding: '0.65rem 1rem', marginBottom: '0.75rem' }}
            data-testid="fw-source-drop"
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => { e.preventDefault(); setDragOver(false); handleSourceDrop(e.dataTransfer.files?.[0]); }}
          >
            <p className="tq-small" style={{ margin: 0 }}>
              <strong>Drop .ino, .cpp, .c, .h, .hpp, .zip or .bin here</strong> or{' '}
              <button type="button" className="tq-linkbtn" onClick={() => srcInputRef.current?.click()}>browse source</button>
              {zipFile && <> · File ready: <strong>{zipFile.name}</strong> <button type="button" className="tq-btn tq-small tq-primary" onClick={() => triggerZipCompile(true)} disabled={busy}>{/\.bin$/i.test(zipFile.name) ? 'Validate & Deploy .bin' : 'Compile ZIP & Deploy'}</button></>}
            </p>
            <input ref={srcInputRef} type="file" accept=".ino,.cpp,.c,.h,.hpp,.zip,.bin" hidden data-testid="fw-source-file" onChange={(e) => handleSourceDrop(e.target.files?.[0])} />
          </div>

          {/* Multi-file tab bar + Add file */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem', alignItems: 'center', marginBottom: '0.5rem' }}>
            {fileKeys.map((path) => (
              <div key={path} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.2rem' }}>
                <button
                  type="button"
                  className={`tq-btn tq-small ${activeFile === path ? 'tq-primary' : 'tq-ghost'}`}
                  onClick={() => setActiveFile(path)}
                  data-testid={`fw-file-tab-${path}`}
                >
                  <FileCode2 size={13} aria-hidden="true" /> {path}
                </button>
                {fileKeys.length > 1 && (
                  <button
                    type="button"
                    className="tq-linkbtn tq-small"
                    aria-label={`Delete ${path}`}
                    onClick={() => removeFile(path)}
                    title={`Delete ${path}`}
                  >
                    ×
                  </button>
                )}
              </div>
            ))}
            <div style={{ marginLeft: 'auto', display: 'flex', gap: '0.3rem', alignItems: 'center' }}>
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="src/helper.h"
                style={{ width: '130px', fontSize: '0.8rem' }}
                aria-label="New file path"
              />
              <button type="button" className="tq-btn tq-small" onClick={addFile} data-testid="fw-add-file">
                <Plus size={13} aria-hidden="true" /> Add file
              </button>
              <input value={renameTo} onChange={(e) => setRenameTo(e.target.value)} placeholder={activeFile} aria-label="Rename active file" style={{ width: '145px', fontSize: '0.8rem' }} />
              <button type="button" className="tq-btn tq-small" onClick={renameFile}>Rename</button>
              <button type="button" className="tq-btn tq-small" onClick={exportProject}><Download size={13} aria-hidden="true" /> Export ZIP</button>
              <button type="button" className="tq-btn tq-small" onClick={() => setBaseline({ ...files })}>Set Compare Baseline</button>
            </div>
          </div>
          <p className="tq-small tq-muted" data-testid="fw-source-comparison">Source comparison: {changedFiles.length ? `${changedFiles.length} changed file(s): ${changedFiles.join(', ')}` : 'workspace matches the selected baseline'}.</p>

          <div data-testid="fw-code-editor" style={{ border: '1px solid rgba(148,163,184,0.25)', borderRadius: '6px', overflow: 'hidden', minHeight: 360 }}>
            {import.meta.env.MODE === 'test' ? <textarea value={activeCode} onChange={(e) => setFiles((prev) => ({ ...prev, [activeFile]: e.target.value }))} aria-label={`Source code for ${activeFile}`} rows={13} /> :
              <Suspense fallback={<p className="tq-muted tq-small" style={{ padding: '1rem' }}>Loading Monaco editor…</p>}>
                <MonacoEditor height="360px" path={activeFile} value={activeCode} language={/\.(c|cpp|ino)$/i.test(activeFile) ? 'cpp' : 'c'} theme="vs-dark"
                  onMount={(editor) => { editorRef.current = editor; }} onChange={(value) => setFiles((prev) => ({ ...prev, [activeFile]: value ?? '' }))}
                  options={{ automaticLayout: true, minimap: { enabled: false }, fontSize: 13, tabSize: 2, wordWrap: 'on', scrollBeyondLastLine: false, suggestOnTriggerCharacters: true }} />
              </Suspense>}
          </div>
          <p className="tq-muted tq-small">Draft saves automatically in this browser. Monaco provides C/C++ highlighting, completion, find/replace, undo/redo and keyboard navigation. {lineCount} lines.</p>

          <div className="tq-row tq-mt" style={{ gap: '0.6rem', flexWrap: 'wrap', alignItems: 'center' }}>
            <button
              type="button"
              className="tq-btn"
              disabled={busy || (job && !['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(job.state))}
              onClick={() => triggerCompile(false)}
              data-testid="fw-compile-only"
            >
              <Play size={14} aria-hidden="true" /> Compile in Docker
            </button>
            <button
              type="button"
              className="tq-btn tq-primary"
              disabled={busy || (job && !['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(job.state))}
              onClick={() => triggerCompile(true)}
              data-testid="fw-compile-and-deploy"
            >
              <Rocket size={14} aria-hidden="true" /> Compile &amp; Upload Wirelessly
            </button>
            <input
              type="text"
              value={sig}
              onChange={(e) => setSig(e.target.value)}
              placeholder="Optional base64 ECDSA signature (auto if host signing configured)"
              aria-label="Optional ECDSA signature"
              style={{ flex: 1, minWidth: '210px', fontSize: '0.8rem' }}
            />
          </div>

          <ErrorBox error={err} />

          <div className="tq-mt"><FirmwareAssistantPanel context={`${Object.entries(files).map(([name, source]) => `// FILE: ${name}\n${source}`).join('\n\n')}${job?.diagnostics?.length ? `\n\n// BUILD DIAGNOSTICS\n${job.diagnostics.map((d) => `${d.file}:${d.line}:${d.col} ${d.severity} ${d.message}`).join('\n')}` : ''}`} defaultTask={job?.diagnostics?.length ? 'compile_error' : 'code_review'} /></div>

          {/* Live Compilation Console */}
          {job && (
            <div className="tq-mt" data-testid="fw-compile-console" style={{ border: '1px solid rgba(148,163,184,0.25)', borderRadius: '6px', padding: '0.75rem', background: '#070b14' }}>
              <div className="tq-row" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <Terminal size={15} aria-hidden="true" />
                  <strong>Compilation Job {job.id}</strong>
                  <Pill tone={job.state === 'SUCCEEDED' ? 'ok' : job.state === 'FAILED' ? 'crit' : job.state === 'CANCELLED' ? 'warn' : 'wait'}>{job.state}</Pill>
                  {job.duration_s != null && <span className="tq-muted tq-small">{job.duration_s} s</span>}
                  {['QUEUED', 'COMPILING'].includes(job.state) && <button type="button" className="tq-btn tq-small" onClick={async () => { try { setJob(await api.fwCancelCompile(job.id)); } catch (e) { setErr(e); } }}>Cancel build</button>}
                </div>
                {job.memory?.flash_pct != null && (
                  <span className="tq-small tq-num">
                    RAM {job.memory.ram_pct ?? '—'}% · Flash {job.memory.flash_pct}% ({Math.round((job.memory.flash_used_bytes || 0) / 1024)} KB)
                  </span>
                )}
              </div>

              {job.compatibility?.sha256 && (
                <div className="tq-row tq-small" style={{ gap: '0.75rem', marginBottom: '0.5rem', flexWrap: 'wrap' }}>
                  <Pill tone={job.compatibility.esp32s3_image ? 'ok' : 'crit'}>ESP32-S3 Image</Pill>
                  <Pill tone={job.compatibility.retains_wifi_link ? 'ok' : 'warn'}>Wi-Fi Link Retained</Pill>
                  <Pill tone={job.compatibility.retains_ota ? 'ok' : 'crit'}>OTA Receiver Retained</Pill>
                  <Pill tone={job.compatibility.partition_fit ? 'ok' : 'crit'}>Partition Fit</Pill>
                </div>
              )}

              {job.diagnostics?.length > 0 && (
                <ul className="tq-callout warn tq-list tq-small" style={{ marginBottom: '0.5rem' }}>
                  {job.diagnostics.map((d, i) => (
                    <li key={i}><button type="button" className="tq-linkbtn" onClick={() => { if (files[d.file] !== undefined) setActiveFile(d.file); requestAnimationFrame(() => { editorRef.current?.revealLineInCenter(Number(d.line) || 1); editorRef.current?.setPosition({ lineNumber: Number(d.line) || 1, column: Number(d.col) || 1 }); editorRef.current?.focus(); }); }}><strong>{d.file}:{d.line}:{d.col}</strong></button> [{d.severity}] {d.message}</li>
                  ))}
                </ul>
              )}

              <pre
                ref={logRef}
                style={{
                  margin: 0, maxHeight: '220px', overflowY: 'auto', fontSize: '0.77rem',
                  lineHeight: '1.35', color: '#cbd5e1', whiteSpace: 'pre-wrap',
                }}
              >
                {(job.logs || []).join('\n') || 'Waiting for container output…'}
              </pre>
            </div>
          )}
        </>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------ 2. Discovery, Manual IP, Wi-Fi Manager & Remote Restart */
export function WirelessControlCard({ admin, operator, snap, onRefreshed }) {
  const [discovered, setDiscovered] = useState([]);
  const [scanning, setScanning] = useState(false);
  const [manualIp, setManualIp] = useState('');
  const [manualPort, setManualPort] = useState('80');
  const [probeRes, setProbeRes] = useState(null);
  const [wifiForm, setWifiForm] = useState({ ssid: '', password: '', base_url: '' });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [err, setErr] = useState(null);

  const scan = async () => {
    setScanning(true);
    setErr(null);
    try {
      const r = await api.deviceDiscover();
      setDiscovered(r.devices || []);
    } catch (e) {
      setErr(e);
    } finally {
      setScanning(false);
    }
  };

  const probeIp = async (e) => {
    e.preventDefault();
    if (!manualIp.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await api.deviceConnectIp({ host: manualIp.trim(), port: Number(manualPort) || 80 });
      setProbeRes(r);
    } catch (e2) {
      setErr(e2);
    } finally {
      setBusy(false);
    }
  };

  const updateWifi = async (e) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const r = await api.deviceWifiUpdate(wifiForm);
      setMsg(r.message || 'Wi-Fi configuration updated.');
      setWifiForm((p) => ({ ...p, password: '' }));
      if (onRefreshed) onRefreshed();
    } catch (e2) {
      setErr(e2);
    } finally {
      setBusy(false);
    }
  };

  const restartDevice = async () => {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const r = await api.deviceRestart();
      setMsg(r.message || 'Restart command sent.');
      if (onRefreshed) onRefreshed();
    } catch (e2) {
      setErr(e2);
    } finally {
      setBusy(false);
    }
  };

  const net = snap?.net_info;
  const connected = snap?.connection === 'CONNECTED' || snap?.connection === 'STALE';

  return (
    <Card
      title="Wireless Discovery, Wi-Fi & Device Control"
      id="dev-wireless-mgr"
      icon={Wifi}
      testid="wireless-control-card"
      sub="mDNS discovery (_torqva._tcp), manual IP probe fallback, live Wi-Fi diagnostics, credentials, and safe remote restart"
      right={
        admin && (
          <button
            type="button"
            className="tq-btn tq-small"
            disabled={busy || !connected}
            onClick={restartDevice}
            data-testid="btn-remote-restart"
          >
            <RotateCcw size={13} aria-hidden="true" /> Remote Restart
          </button>
        )
      }
    >
      <div className="tq-grid tq-grid-wide">
        <div>
          <h4 className="tq-mon-subhead">Live Wireless Info</h4>
          <MetricList label="Network telemetry" items={[
            { key: 'ip', label: 'Device IP', value: net?.ip || snap?.transport?.remote || null, missingText: 'UNAVAILABLE' },
            { key: 'ssid', label: 'Wi-Fi SSID', value: net?.ssid || null, missingText: 'UNAVAILABLE' },
            { key: 'rssi', label: 'Signal (RSSI)', value: net?.rssi != null ? `${net.rssi} dBm` : null, missingText: 'UNAVAILABLE' },
            { key: 'mac', label: 'MAC Address', value: net?.mac || null, missingText: 'UNAVAILABLE' },
            { key: 'heap', label: 'Free Heap', value: net?.heap != null ? `${Math.round(net.heap / 1024)} KB` : null, missingText: 'UNAVAILABLE' },
            { key: 'up', label: 'Uptime', value: net?.uptime_s != null ? `${net.uptime_s} s` : null, missingText: 'UNAVAILABLE' },
          ]} />

          <h4 className="tq-mon-subhead tq-mt">Automatic ESP32 Discovery (mDNS)</h4>
          <div className="tq-row" style={{ gap: '0.5rem', marginBottom: '0.5rem' }}>
            <button type="button" className="tq-btn tq-small" onClick={scan} disabled={scanning} data-testid="btn-discover">
              <Radar size={13} aria-hidden="true" /> {scanning ? 'Scanning LAN…' : 'Scan Network (mDNS)'}
            </button>
          </div>
          {discovered.length === 0 ? (
            <p className="tq-small tq-muted">No LAN devices listed yet. Click Scan Network to query `_torqva._tcp.local`.</p>
          ) : (
            <ul className="tq-list tq-small" data-testid="discovered-list">
              {discovered.map((d, i) => (
                <li key={i}>
                  <strong>{d.device_id}</strong> · {d.ip || d.port} ({d.source})
                  {d.firmware ? ` · fw ${d.firmware}` : ''} {d.connected ? '· CONNECTED' : ''}
                </li>
              ))}
            </ul>
          )}

          <h4 className="tq-mon-subhead tq-mt">Manual IP Connection Fallback</h4>
          <form className="tq-row" onSubmit={probeIp} style={{ gap: '0.4rem', flexWrap: 'wrap' }}>
            <input type="text" value={manualIp} onChange={(e) => setManualIp(e.target.value)} placeholder="192.168.1.50" aria-label="ESP32 IP address" style={{ maxWidth: '150px' }} data-testid="manual-ip-input" />
            <input type="number" value={manualPort} onChange={(e) => setManualPort(e.target.value)} aria-label="Fallback port" style={{ maxWidth: '75px' }} />
            <button type="submit" className="tq-btn tq-small" disabled={busy || !operator || !manualIp.trim()} data-testid="btn-probe-ip">
              <Globe size={13} aria-hidden="true" /> Probe IP
            </button>
          </form>
          {probeRes && (
            <p className="tq-small tq-mt" data-testid="manual-ip-result">
              {probeRes.reachable ? `Reachable (${probeRes.ip}, ${probeRes.latency_ms} ms${probeRes.device_id ? `, id ${probeRes.device_id}` : ''})` : `Unreachable: ${probeRes.error || 'no response'}`}
            </p>
          )}
        </div>

        <div>
          <h4 className="tq-mon-subhead">Wi-Fi Network Manager (Authenticated NVS Update)</h4>
          {!admin ? (
            <Empty>Admin access required to update device Wi-Fi settings.</Empty>
          ) : snap?.wifi_state?.supported ? (
            <p className="tq-callout info tq-small" role="note" data-testid="wifi-legacy-retired">
              This board supports staged network changes, which keep your working network until the new one is verified and restore it automatically if the new one fails.
              Use <strong>Configure Wi-Fi</strong> above (Change Network); the direct update is not offered for this board.
            </p>
          ) : (
            <form className="tq-form" onSubmit={updateWifi}>
              <p className="tq-callout warn tq-small" role="note" data-testid="wifi-legacy-warning">
                This firmware cannot stage a change. Saving replaces the working network immediately; if the new one fails the board stays offline until it is reconnected over USB.
              </p>
              <label>Wi-Fi SSID
                <input type="text" value={wifiForm.ssid} onChange={(e) => setWifiForm({ ...wifiForm, ssid: e.target.value })} placeholder="BenchWiFi" maxLength={32} required data-testid="wifi-ssid-input" />
              </label>
              <label>Wi-Fi Password
                <input type="password" value={wifiForm.password} onChange={(e) => setWifiForm({ ...wifiForm, password: e.target.value })} placeholder="WPA2 passphrase" maxLength={64} data-testid="wifi-pass-input" />
              </label>
              <label>Backend HTTPS Gateway URL (optional override)
                <input type="text" value={wifiForm.base_url} onChange={(e) => setWifiForm({ ...wifiForm, base_url: e.target.value })} placeholder="https://192.168.1.10:8443" maxLength={128} />
              </label>
              <button type="submit" className="tq-btn tq-primary tq-small" disabled={busy || !connected} data-testid="btn-wifi-save">
                Save Wi-Fi &amp; Reconnect
              </button>
            </form>
          )}
          {msg && <p className="tq-callout ok tq-mt tq-small">{msg}</p>}
          <ErrorBox error={err} />
        </div>
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------------ 3. Wireless Serial Monitor */
export function WirelessSerialMonitor() {
  const [logs, setLogs] = useState([]);
  const [search, setSearch] = useState('');
  const [level, setLevel] = useState('');
  const [paused, setPaused] = useState(false);
  const [err, setErr] = useState(null);
  const boxRef = useRef(null);

  const loadLogs = useCallback(async () => {
    try {
      const r = await api.deviceLogs(300, search, level);
      if (r && Array.isArray(r.logs)) setLogs(r.logs);
      setErr(null);
    } catch {
      /* ignore background poll failure if disconnected/unmocked */
    }
  }, [search, level]);

  useEffect(() => {
    if (paused) return undefined;
    loadLogs();
    const iv = setInterval(loadLogs, 1500);
    return () => clearInterval(iv);
  }, [loadLogs, paused]);

  useEffect(() => {
    if (!paused && boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight;
  }, [logs.length, paused]);

  const download = async (format) => {
    try {
      const content = await api.deviceLogsDownload(format);
      const blob = new Blob([content], { type: format === 'jsonl' ? 'application/x-ndjson' : 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `torqva_serial_logs.${format}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setErr(e);
    }
  };

  return (
    <Card
      title="Wireless & USB Serial Monitor"
      id="dev-serial-mon"
      icon={Terminal}
      testid="wireless-serial-monitor"
      sub="Real-time device telemetry, OTA & system logs over Wi-Fi WebSocket or USB"
      right={<Pill tone={paused ? 'warn' : 'ok'}>{paused ? 'Paused' : 'Streaming'}</Pill>}
    >
      <div className="tq-row" style={{ gap: '0.45rem', flexWrap: 'wrap', marginBottom: '0.5rem', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', flex: 1, minWidth: '180px' }}>
          <Search size={14} aria-hidden="true" />
          <input type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search logs…" aria-label="Search serial logs" style={{ flex: 1 }} data-testid="serial-log-search" />
        </div>
        <select value={level} onChange={(e) => setLevel(e.target.value)} aria-label="Filter log level" data-testid="serial-log-level">
          <option value="">All levels</option>
          <option value="INFO">INFO</option>
          <option value="WARN">WARN</option>
          <option value="ERROR">ERROR</option>
        </select>
        <button type="button" className="tq-btn tq-small" onClick={() => setPaused((p) => !p)} data-testid="btn-log-pause">
          <Pause size={13} aria-hidden="true" /> {paused ? 'Resume' : 'Pause'}
        </button>
        <button type="button" className="tq-btn tq-small" onClick={() => setLogs([])}>
          <Trash2 size={13} aria-hidden="true" /> Clear view
        </button>
        <button type="button" className="tq-btn tq-small" onClick={() => download('txt')} data-testid="btn-log-dl-txt">
          <Download size={13} aria-hidden="true" /> .TXT
        </button>
        <button type="button" className="tq-btn tq-small" onClick={() => download('jsonl')} data-testid="btn-log-dl-json">
          <Download size={13} aria-hidden="true" /> .JSONL
        </button>
      </div>
      <ErrorBox error={err} />
      <pre
        ref={boxRef}
        data-testid="serial-log-output"
        style={{
          margin: 0, height: '210px', overflowY: 'auto', padding: '0.65rem', borderRadius: '6px',
          background: '#070b14', color: '#cbd5e1', fontSize: '0.78rem', lineHeight: '1.4', whiteSpace: 'pre-wrap',
        }}
      >
        {logs.length === 0
          ? 'No device log lines recorded yet.'
          : logs.map((r, i) => `[${new Date(r.ts_unix * 1000).toLocaleTimeString()}] [${r.level}] (${r.transport}) ${r.msg}`).join('\n')}
      </pre>
    </Card>
  );
}

export function FirmwareRuntimeDiagnostics({ device }) {
  const net = device?.net_info || {}; const runtime = device?.runtime || {};
  return <Card title="Firmware Runtime Diagnostics" icon={Cpu} sub="Device-reported metrics only; unsupported values are never estimated" testid="fw-runtime-diagnostics">
    <MetricList label="Runtime resources" items={[
      { key: 'up', label: 'Device uptime', value: net.uptime_s != null ? `${net.uptime_s} s` : null, missingText: 'UNAVAILABLE — device did not report uptime' },
      { key: 'heap', label: 'Free heap', value: net.heap != null ? `${Math.round(net.heap / 1024)} KB` : null, missingText: 'UNAVAILABLE — device did not report free heap' },
      { key: 'minheap', label: 'Minimum free heap', value: runtime.min_heap_bytes != null ? `${Math.round(runtime.min_heap_bytes / 1024)} KB` : null, missingText: 'UNAVAILABLE — current firmware protocol does not report it' },
      { key: 'psram', label: 'PSRAM usage', value: runtime.psram_used_bytes != null ? `${Math.round(runtime.psram_used_bytes / 1024)} KB` : null, missingText: 'UNAVAILABLE — current firmware protocol does not report it' },
      { key: 'flash', label: 'Runtime flash usage', value: runtime.flash_used_bytes != null ? `${Math.round(runtime.flash_used_bytes / 1024)} KB` : null, missingText: 'UNAVAILABLE — use signed build metadata' },
      { key: 'cpu', label: 'CPU utilization', value: runtime.cpu_pct != null ? `${fmt(runtime.cpu_pct, 1)}%` : null, missingText: 'UNAVAILABLE — not measured by the device' },
      { key: 'reset', label: 'Last restart reason', value: device?.reset_reason || null, missingText: 'UNAVAILABLE — firmware does not report reset reason' },
      { key: 'loss', label: 'Packet loss', value: runtime.packet_loss_pct != null ? `${fmt(runtime.packet_loss_pct, 2)}%` : null, missingText: 'UNAVAILABLE — sequence loss is not currently aggregated' },
    ]} />
    <p className="tq-small tq-muted">Watchdog and crash evidence appears in the bounded log console when the firmware emits it. Absence of a log is not evidence that no reset occurred.</p>
  </Card>;
}
