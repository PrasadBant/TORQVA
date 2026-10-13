// TORQVA API client. Token is kept in sessionStorage only (cleared when the tab closes).
const BASE = (import.meta.env && import.meta.env.VITE_API_BASE_URL) || '';
const KEY = 'torqva.token';

export function getToken() {
  try { return sessionStorage.getItem(KEY) || ''; } catch { return ''; }
}
export function setToken(t) {
  try { t ? sessionStorage.setItem(KEY, t) : sessionStorage.removeItem(KEY); } catch { /* storage may be blocked */ }
}

export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// Reads time out so a backend that stops answering (rather than refusing) cannot leave the polling loop waiting forever. Writes are not timed
// out: aborting a POST would not undo it on the server, it would only hide whether it happened.
export const READ_TIMEOUT_MS = 20000;

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
    throw new ApiError(res.status, typeof d === 'string' ? d : d ? JSON.stringify(d) : `HTTP ${res.status}`);
  }
  return res.json();
}

export const api = {
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
  evaluationC2C4: () => req('/evaluation/c2c4'),
  predictionChecks: () => req('/prediction-checks'),
  deviceStatus: () => req('/device/status'),
  deviceCommands: () => req('/device/commands'),
  deviceHistory: (signal, seconds) => req(`/device/history?signal=${encodeURIComponent(signal)}&seconds=${Number(seconds)}`),
  devicePorts: () => req('/device/ports'),
  deviceConnect: (body) => req('/device/connect', { method: 'POST', body }),
  deviceDisconnect: () => req('/device/disconnect', { method: 'POST' }),
  commissioning: () => req('/device/commissioning'),
  commissioningItem: (id, body) => req(`/device/commissioning/items/${encodeURIComponent(id)}`, { method: 'POST', body }),
  commissioningLimits: (body) => req('/device/commissioning/limits', { method: 'PUT', body }),
  commissioningEnable: (body) => req('/device/commissioning/enable', { method: 'POST', body }),
  deviceCommand: (body) => req('/device/commands', { method: 'POST', body }),
  audit: () => req('/audit'),
  start: (body) => req('/simulation/start', { method: 'POST', body }),
  step: (seconds) => req('/simulation/step', { method: 'POST', body: { seconds } }),
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
};
