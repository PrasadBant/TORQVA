import { getToken } from '../access/token.js';
// TORQVA API client. Token is kept in sessionStorage only (cleared when the tab closes).
import { plainify, plainText } from './plain.js';

const BASE = (import.meta.env && import.meta.env.VITE_API_BASE_URL) || '';
export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// Reads time out so a backend that stops answering (rather than refusing) cannot leave the polling loop waiting forever. Writes are not timed
// out: aborting a POST would not undo it on the server, it would only hide whether it happened.
export const READ_TIMEOUT_MS = 20000;

const RAW = /^\/simulation\/workbench\/receipts/;

async function req(path, { method = 'GET', body } = {}) {
  const ctl = method === 'GET' && typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), READ_TIMEOUT_MS) : null;
  let res;
  try {
    res = await fetch(`${BASE}/api/torqva${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctl ? ctl.signal : undefined,
    });
  } catch (e) {
    if (ctl && ctl.signal.aborted) throw new Error(`The backend did not answer within ${READ_TIMEOUT_MS / 1000} s`);
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    const d = j.detail;
    throw new ApiError(res.status, plainText(typeof d === 'string' ? d : d && typeof d.message === 'string' ? d.message : d ? JSON.stringify(d) : `HTTP ${res.status}`));
  }
  // Prose from the backend is shown in product language (no internal layer ids). Decision summaries are kept exactly as recorded:
  // they carry a SHA-256 digest and are exported as JSON, so their text must match the record byte for byte.
  return RAW.test(path) ? res.json() : res.json().then(plainify);
}

/** Source or firmware upload (multipart) with real upload progress via XMLHttpRequest. */
function uploadSourceOrFirmware(endpoint, file, fields, onProgress) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('POST', `${BASE}/api/torqva${endpoint}`);
    x.setRequestHeader('Authorization', `Bearer ${getToken()}`);
    if (onProgress && x.upload) x.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded, e.total); };
    x.onerror = () => reject(new Error('The upload did not reach the backend'));
    x.onload = () => {
      let j = {};
      try { j = JSON.parse(x.responseText || '{}'); } catch { /* not JSON */ }
      if (x.status >= 200 && x.status < 300) { resolve(plainify(j)); return; }
      const d = j.detail;
      const e = new ApiError(x.status, plainText(typeof d === 'string' ? d : d && typeof d.message === 'string' ? d.message : `HTTP ${x.status}`));
      e.code = d && d.code;
      reject(e);
    };
    const f = new FormData();
    f.append('file', file, file.name);
    Object.entries(fields || {}).forEach(([k, v]) => f.append(k, v ?? ''));
    x.send(f);
  });
}

function uploadFirmware(file, fields, onProgress) {
  return uploadSourceOrFirmware('/firmware/releases', file, fields, onProgress);
}

export const api = {
  fwStatus: () => req('/firmware/status'),
  fwReleases: () => req('/firmware/releases'),
  fwRelease: (id) => req(`/firmware/releases/${encodeURIComponent(id)}`),
  fwDeployments: () => req('/firmware/deployments'),
  fwDeploy: (body) => req('/firmware/deployments', { method: 'POST', body }),
  fwRollback: (body) => req('/firmware/rollback', { method: 'POST', body }),
  fwUpload: uploadFirmware,
  fwDocker: () => req('/firmware/docker'),
  fwTemplates: () => req('/firmware/workspace/templates'),
  fwWorkspaceFiles: () => req('/firmware/workspace/files'),
  fwCompileEditor: (body) => req('/firmware/compile/editor', { method: 'POST', body }),
  fwCompileUpload: (file, fields, onProgress) => uploadSourceOrFirmware('/firmware/compile/upload', file, fields, onProgress),
  fwCompileJobs: () => req('/firmware/compile'),
  fwCompileJob: (id) => req(`/firmware/compile/${encodeURIComponent(id)}`),
  deviceDiscover: () => req('/device/discover'),
  deviceConnectIp: (body) => req('/device/connect-ip', { method: 'POST', body }),
  deviceWifi: () => req('/device/wifi'),
  deviceWifiUpdate: (body) => req('/device/wifi', { method: 'POST', body }),
  deviceRestart: () => req('/device/restart', { method: 'POST' }),
  deviceLogs: (limit = 300, search = '', level = '') => req(`/device/logs?limit=${Number(limit)}&search=${encodeURIComponent(search)}&level=${encodeURIComponent(level)}`),
  deviceLogsDownload: async (format = 'txt') => {
    const res = await fetch(`${BASE}/api/torqva/device/logs/download?format=${encodeURIComponent(format)}`, {
      headers: { Authorization: `Bearer ${getToken()}` },
    });
    if (!res.ok) throw new ApiError(res.status, `HTTP ${res.status}`);
    return res.text();
  },
  me: () => req('/me'),
  status: () => req('/status'),
  telemetry: (last = 300) => req(`/telemetry?last=${last}`),
  incidents: () => req('/incidents'),
  decisions: () => req('/decisions'),
  predictions: () => req('/predictions'),
  commands: () => req('/commands'),
  outcomes: () => req('/outcomes'),
  cases: () => req('/cases'),
  log: () => req('/log'),
  evaluation: () => req('/evaluation/latest'),
  evaluationPhysical: () => req('/evaluation/physical'),
  evaluationC2C4: () => req('/evaluation/c2c4'),
  predictionChecks: () => req('/prediction-checks'),
  deviceDiagnostics: () => req('/device/diagnostics'),
  deviceTestRun: (body) => req('/device/test/run', { method: 'POST', body }),
  deviceStatus: () => req('/device/status'),
  deviceCommands: () => req('/device/commands'),
  deviceHistory: (signal, seconds) => req(`/device/history?signal=${encodeURIComponent(signal)}&seconds=${Number(seconds)}`),
  devicePorts: () => req('/device/ports'),
  deviceConnect: (body) => req('/device/connect', { method: 'POST', body }),
  deviceDisconnect: () => req('/device/disconnect', { method: 'POST' }),
  deviceCommand: (body) => req('/device/commands', { method: 'POST', body }),
  audit: () => req('/audit'),
  start: (body) => req('/simulation/start', { method: 'POST', body }),
  step: (seconds) => req('/simulation/step', { method: 'POST', body: { seconds } }),
  // Analyst workbench: simulation only (the backend refuses these without a software simulation; nothing here reaches a device).
  wbPlan: () => req('/simulation/workbench/plan'),
  wbSequence: (body) => req('/simulation/workbench/sequence', { method: 'POST', body }),
  wbPredict: (targets) => req(`/simulation/workbench/predict?${targets.map((t) => `targets=${encodeURIComponent(t)}`).join('&')}`),   // a pure read
  wbCheck: (body) => req('/simulation/workbench/check', { method: 'POST', body }),
  wbRequest: (body) => req('/simulation/workbench/request', { method: 'POST', body }),
  wbAdaptive: (budget) => req('/simulation/workbench/adaptive', { method: 'POST', body: { budget } }),
  wbCounterfactual: (body) => req('/simulation/workbench/counterfactual', { method: 'POST', body }),
  wbCounterfactualGet: (id) => req(`/simulation/workbench/counterfactual/${encodeURIComponent(id)}`),
  wbCounterfactualRerun: (id) => req(`/simulation/workbench/counterfactual/${encodeURIComponent(id)}/rerun`, { method: 'POST' }),
  wbTrace: (incident) => req(`/simulation/workbench/trace${incident ? `?incident=${encodeURIComponent(incident)}` : ''}`),
  wbReceipts: () => req('/simulation/workbench/receipts'),
  wbReceipt: (id) => req(`/simulation/workbench/receipts/${encodeURIComponent(id)}`),
  // Unified diagnostic workflow (both modes; the backend enforces mode isolation, roles and every safety gate).
  wfPatterns: (mode) => req(`/workflow/patterns?mode=${encodeURIComponent(mode)}`),
  wfStart: (body) => req('/workflow/runs', { method: 'POST', body }),
  wfRuns: (mode) => req(`/workflow/runs?mode=${encodeURIComponent(mode)}`),
  wfGet: (id) => req(`/workflow/runs/${encodeURIComponent(id)}`),
  wfAuthorize: (id) => req(`/workflow/runs/${encodeURIComponent(id)}/authorize`, { method: 'POST' }),
  wfCancel: (id, reason = '') => req(`/workflow/runs/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: { reason } }),
  approve: () => req('/approvals/approve', { method: 'POST' }),
  reject: () => req('/approvals/reject', { method: 'POST' }),
  stop: () => req('/commands/stop', { method: 'POST' }),
  resetEstop: () => req('/commands/reset-estop', { method: 'POST' }),
  labRegimes: () => req('/lab/regimes'),
  labChecklist: () => req('/lab/checklist'),
  labSessions: () => req('/lab/sessions'),
  labExperiments: () => req('/lab/experiments'),
  labCreate: (body) => req('/lab/sessions', { method: 'POST', body }),
  labChecklistConfirm: (id, items) => req(`/lab/sessions/${id}/checklist`, { method: 'POST', body: { items } }),
  labRun: (id) => req(`/lab/sessions/${id}/run`, { method: 'POST' }),
  labReveal: (id) => req(`/lab/sessions/${id}/reveal`, { method: 'POST' }),
  labReproduce: (id) => req(`/lab/sessions/${id}/reproduce`, { method: 'POST' }),
  labExperiment: (body) => req('/lab/experiments', { method: 'POST', body }),
  attList: () => req('/attestation/candidates'),
  attOne: (id) => req(`/attestation/candidates/${id}`),
  attRefs: () => req('/attestation/references'),
  attEvents: () => req('/attestation/events'),
  attHold: () => req('/attestation/warmup'),
  attHoldStart: (body) => req('/attestation/warmup/start', { method: 'POST', body }),
  attHoldEnd: () => req('/attestation/warmup/end', { method: 'POST' }),
  attCapture: () => req('/attestation/candidates', { method: 'POST' }),
  attRefresh: (id, rev) => req(`/attestation/candidates/${id}/refresh`, { method: 'POST', body: { expected_rev: rev } }),
  attAttest: (id, body) => req(`/attestation/candidates/${id}/attest`, { method: 'POST', body }),
  attReject: (id, body) => req(`/attestation/candidates/${id}/reject`, { method: 'POST', body }),
  attRevoke: (id, body) => req(`/attestation/candidates/${id}/revoke`, { method: 'POST', body }),
  attActivate: (v, reason) => req(`/attestation/references/${v}/activate`, { method: 'POST', body: { reason } }),
  attRollback: (reason) => req('/attestation/references/rollback', { method: 'POST', body: { reason } }),
  // Physical Recovery Verification (C5) and Continuous Intelligence (C6)
  recoveryPhysical: () => req('/recovery/physical'),
  recoveryVerifyPhysical: () => req('/recovery/verify-physical', { method: 'POST' }),
  attPhysicalCandidates: () => req('/attestation/physical/candidates'),
  attPhysicalOne: (id) => req(`/attestation/physical/candidates/${id}`),
  attPhysicalCapture: () => req('/attestation/physical/capture', { method: 'POST' }),
  attPhysicalAttest: (id, body) => req(`/attestation/physical/candidates/${id}/attest`, { method: 'POST', body }),
  attPhysicalReject: (id, body) => req(`/attestation/physical/candidates/${id}/reject`, { method: 'POST', body }),
  attPhysicalRevoke: (id, body) => req(`/attestation/physical/candidates/${id}/revoke`, { method: 'POST', body }),
  attPhysicalReferences: () => req('/attestation/physical/references'),
  attPhysicalActivate: (v, reason) => req(`/attestation/physical/references/${v}/activate`, { method: 'POST', body: { reason } }),
  attPhysicalRollback: (reason) => req('/attestation/physical/references/rollback', { method: 'POST', body: { reason } }),
  attPhysicalWarmup: () => req('/attestation/physical/warmup'),
  attPhysicalWarmupStart: (body) => req('/attestation/physical/warmup/start', { method: 'POST', body }),
  attPhysicalWarmupEnd: () => req('/attestation/physical/warmup/end', { method: 'POST' }),
  // Session recording (CSV recording, events, summary, export)
  recordingStatus: () => req('/recording/status'),
  recordingStart: (mode = 'PHYSICAL') => req(`/recording/start?mode=${encodeURIComponent(mode)}`, { method: 'POST' }),
  recordingStop: () => req('/recording/stop', { method: 'POST' }),
  recordingSessions: () => req('/recording/sessions'),
  recordingSession: (sid) => req(`/recording/sessions/${encodeURIComponent(sid)}`),
  recordingSessionSummary: (sid) => req(`/recording/sessions/${encodeURIComponent(sid)}/summary`),
  recordingSummary: () => req('/recording/summary'),
  recordingExportUrl: (sid) => `${BASE}/recording/sessions/${encodeURIComponent(sid)}/export`,
  recordingReportUrl: (sid) => `${BASE}/recording/sessions/${encodeURIComponent(sid)}/report`,
  resetHistory: () => req('/history/reset', { method: 'POST' }),
  // Limits configuration (Feature 1)
  getLimits: () => req('/limits'),
  updateLimit: (key, value, enabled) => req('/limits', { method: 'PUT', body: { key, value, enabled } }),
  resetLimits: () => req('/limits/reset', { method: 'POST' }),
};
