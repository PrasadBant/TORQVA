/**
 * REST API client for Smart DC Motor Monitoring Backend.
 * Centralizes all HTTP communication and handles network errors gracefully.
 */

const API_BASE = import.meta.env.VITE_API_BASE_URL || '';

async function request(endpoint, options = {}) {
  const url = `${API_BASE}${endpoint}`;
  const config = {
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
    ...options,
  };

  try {
    const response = await fetch(url, config);
    if (!response.ok) {
      const errorBody = await response.json().catch(() => ({}));
      throw new Error(errorBody.detail || errorBody.message || `HTTP error ${response.status}`);
    }
    return await response.json();
  } catch (err) {
    console.error(`[API ERROR] ${options.method || 'GET'} ${endpoint}:`, err.message);
    throw err;
  }
}

export const api = {
  // System & Connection Status
  getStatus: () => request('/api/status'),

  // Latest Telemetry
  getLatestSensors: (source) => {
    const query = source ? `?source=${encodeURIComponent(source)}` : '';
    return request(`/api/sensors/latest${query}`);
  },

  // Chronological Historical Lookback
  getHistory: (minutes = 5.0, source = null, limit = 5000) => {
    const params = new URLSearchParams();
    if (minutes) params.append('minutes', minutes);
    if (source) params.append('source', source);
    if (limit) params.append('limit', limit);
    return request(`/api/history?${params.toString()}`);
  },

  // Baseline Calibration State
  getBaseline: () => request('/api/baseline'),

  // Health Score & Diagnostics
  getHealth: () => request('/api/health'),

  // System Configuration & Thresholds
  getConfig: () => request('/api/config'),

  // Baseline Operations (Dispatches non-control commands to ESP32 queue)
  startBaseline: () => request('/api/baseline/start', { method: 'POST' }),
  cancelBaseline: () => request('/api/baseline/cancel', { method: 'POST' }),
  resetBaseline: () => request('/api/baseline/reset', { method: 'POST' }),
};

export default api;
