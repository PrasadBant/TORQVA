import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import TorqvaApp from '../app/TorqvaApp.jsx';
import { setToken } from '../access/token.js';

const mockSnap = {
  connection: "CONNECTING",
  handshake: false,
  identity: "unknown",
  device_id: null,
  origin: "none",
  label: "SIMULATION",
  firmware: null,
  wire_protocol: null,
  firmware_mode: null,
  safety_state: null,
  trip_reason: null,
  fault_mask: null,
  drive: null,
  hb_age_ms: null,
  control_enabled_in_firmware: null,
  start_blocked_reason: null,
  telemetry_fresh: false,
  telemetry_age_s: null,
  last_rx_unix: null,
  values: {
    rpm: null,
    current: null,
    voltage: null,
    power: null,
    housing: null,
    ambient: null,
    duty: null,
    setpoint: null,
    vibration: { value: null, valid: false, stale: false, origin: "unavailable" },
    acceleration: { value: null, valid: false, stale: false, origin: "unavailable" },
  },
  counters: { frames: 0, malformed: 10 },
  last_error: "The device sent data, but it is not valid TORQVA wire protocol 1.",
  error: { code: "HANDSHAKE_INVALID", message: "invalid" },
  port: "COM7",
  state_label: "HANDSHAKE INVALID",
  sensor_status: { rpm: "unavailable" },
  control_blockers: ["DEVICE NOT CONNECTED"],
  interlocks: [],
  config: null,
  analysis: { basis: "none", state: "WAITING", layers: {} },
};

describe('Physical Mode Real Live Repro', () => {
  beforeEach(() => {
    window.location.hash = '#/overview';
    window.localStorage.setItem('torqva.mode', 'PHYSICAL');
    window.localStorage.setItem('torqva.override_blockers', '1');
    setToken('torqva-local-dev-token');
  });

  afterEach(() => {
    window.localStorage.clear();
    vi.unstubAllGlobals();
  });

  it('renders without throwing when override_blockers is 1 in PHYSICAL mode with mockSnap', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const u = String(url);
      if (u.includes('/me')) return { ok: true, status: 200, json: async () => ({ user: 'local-dev', role: 'admin' }) };
      if (u.includes('/device/status')) return { ok: true, status: 200, json: async () => mockSnap };
      if (u.includes('/device/commands')) return { ok: true, status: 200, json: async () => [] };
      if (u.includes('/device/ports')) return { ok: true, status: 200, json: async () => ({ ports: [{ device: 'COM7', description: 'USB-Enhanced-SERIAL CH343' }] }) };
      if (u.includes('/status')) return { ok: true, status: 200, json: async () => ({ mode: 'PHYSICAL' }) };
      return { ok: true, status: 200, json: async () => [] };
    }));
    const { container } = render(<TorqvaApp pollMs={100000} />);
    await waitFor(() => {
      expect(screen.getByText('TORQVA')).toBeInTheDocument();
    });
    expect(container).toBeDefined();
  });

  it('renders without throwing even when snap is null initially', async () => {
    let resolveSnap;
    const snapPromise = new Promise((resolve) => { resolveSnap = resolve; });
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const u = String(url);
      if (u.includes('/me')) return { ok: true, status: 200, json: async () => ({ user: 'local-dev', role: 'admin' }) };
      if (u.includes('/device/status')) return snapPromise;
      if (u.includes('/device/commands')) return { ok: true, status: 200, json: async () => [] };
      if (u.includes('/device/ports')) return { ok: true, status: 200, json: async () => ({ ports: [] }) };
      if (u.includes('/status')) return { ok: true, status: 200, json: async () => ({ mode: 'PHYSICAL' }) };
      return { ok: true, status: 200, json: async () => [] };
    }));
    const { container } = render(<TorqvaApp pollMs={100000} />);
    expect(container).toBeDefined();
    resolveSnap({ ok: true, status: 200, json: async () => mockSnap });
  });
});
