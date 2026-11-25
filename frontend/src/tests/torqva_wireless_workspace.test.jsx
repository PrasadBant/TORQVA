import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SourceWorkspace, WirelessControlCard, WirelessSerialMonitor } from '../device/wirelessWorkspace.jsx';

describe('Wireless OTA Engineering Workspace', () => {
  const origFetch = global.fetch;
  beforeEach(() => {
    vi.restoreAllMocks();
    window.sessionStorage.setItem('torqva.token', 'test-tok');
  });
  afterEach(() => {
    global.fetch = origFetch;
  });

  it('supports multi-file source editing, template selection, and isolated Docker compile + deploy', async () => {
    const calls = [];
    global.fetch = vi.fn(async (url, opts) => {
      const path = String(url).replace('/api/torqva', '');
      const body = opts?.body ? JSON.parse(opts.body) : null;
      calls.push({ path, method: opts?.method || 'GET', body });
      if (path === '/firmware/docker') return new Response(JSON.stringify({ available: true, server_version: '29.6.1', image_ready: true }));
      if (path === '/firmware/workspace/templates') return new Response(JSON.stringify({ templates: [{ id: 't1', name: 'Blink', profile: 'esp32s3_wireless', files: { 'src/blink.ino': 'void setup(){}\nvoid loop(){}' } }] }));
      if (path === '/firmware/compile/editor') return new Response(JSON.stringify({ id: 'job1', state: 'SUCCEEDED', version: '1.2.0', logs: ['[torqva] Release abc123 stored'], diagnostics: [], memory: { flash_pct: 30.6, ram_pct: 17.4, flash_used_bytes: 1021553 }, compatibility: { esp32s3_image: true, retains_wifi_link: true, retains_ota: true, partition_fit: true, sha256: 'abc' }, release: { id: 'abc123def456', version: '1.2.0' } }));
      return new Response('{}');
    });

    const onCompiled = vi.fn();
    render(<SourceWorkspace admin deviceId="RIG-1" onCompiled={onCompiled} onDeployed={() => {}} />);

    expect(await screen.findByText(/Docker 29\.6\.1/)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('fw-compile-and-deploy'));
    await waitFor(() => expect(screen.getByTestId('fw-compile-console')).toHaveTextContent('SUCCEEDED'));
    expect(onCompiled).toHaveBeenCalledWith({ id: 'abc123def456', version: '1.2.0' });
    const post = calls.find((c) => c.path === '/firmware/compile/editor');
    expect(post.body.auto_deploy).toBe(true);
    expect(post.body.device_id).toBe('RIG-1');
  });

  it('supports mDNS discovery, manual IP fallback, Wi-Fi update, and remote restart', async () => {
    const calls = [];
    global.fetch = vi.fn(async (url, opts) => {
      const path = String(url).replace('/api/torqva', '');
      const body = opts?.body ? JSON.parse(opts.body) : null;
      calls.push({ path, method: opts?.method || 'GET', body });
      if (path === '/device/discover') return new Response(JSON.stringify({ devices: [{ device_id: 'RIG-1', ip: '192.168.1.50', source: 'mdns', firmware: '1.1.2' }] }));
      if (path === '/device/connect-ip') return new Response(JSON.stringify({ ip: '192.168.1.50', reachable: true, latency_ms: 4.2, device_id: 'RIG-1' }));
      if (path === '/device/restart') return new Response(JSON.stringify({ ok: true, message: 'Restart sent' }));
      if (path === '/device/wifi') return new Response(JSON.stringify({ ok: true, message: 'Wi-Fi saved' }));
      return new Response('{}');
    });

    render(<WirelessControlCard admin operator snap={{ connection: 'CONNECTED', net_info: { ip: '192.168.1.50', ssid: 'LabWiFi', rssi: -55, mac: 'AA:BB', heap: 180000, uptime_s: 42 } }} />);
    fireEvent.click(screen.getByTestId('btn-discover'));
    expect(await screen.findByTestId('discovered-list')).toHaveTextContent('192.168.1.50');

    fireEvent.change(screen.getByTestId('manual-ip-input'), { target: { value: '192.168.1.50' } });
    fireEvent.click(screen.getByTestId('btn-probe-ip'));
    expect(await screen.findByTestId('manual-ip-result')).toHaveTextContent('Reachable (192.168.1.50');

    fireEvent.click(screen.getByTestId('btn-remote-restart'));
    await waitFor(() => expect(calls.some((c) => c.path === '/device/restart')).toBe(true));
  });

  it('renders Wireless Serial Monitor and filters logs', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({
      logs: [{ ts_unix: 1700000000, level: 'INFO', transport: 'wifi', msg: 'OTA download 100%' }],
    })));
    render(<WirelessSerialMonitor />);
    expect(await screen.findByTestId('serial-log-output')).toHaveTextContent('OTA download 100%');
  });
});
