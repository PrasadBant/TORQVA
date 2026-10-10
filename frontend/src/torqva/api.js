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

async function req(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${BASE}/api/torqva${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
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
  audit: () => req('/audit'),
  start: (body) => req('/simulation/start', { method: 'POST', body }),
  step: (seconds) => req('/simulation/step', { method: 'POST', body: { seconds } }),
  approve: () => req('/approvals/approve', { method: 'POST' }),
  reject: () => req('/approvals/reject', { method: 'POST' }),
  stop: () => req('/commands/stop', { method: 'POST' }),
  resetEstop: () => req('/commands/reset-estop', { method: 'POST' }),
};
