// Firmware Manager page: what it shows comes only from /firmware/status, /releases and /deployments; uploads and deployments are admin-only and gated; stages
// and results are derived from the deployment's own reports (a restart is "waiting for reconnection", never "failed" or "successful").
import React from 'react';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { FirmwarePage, stageSteps, resultOf } from '../torqva/physical/firmware.jsx';
import TorqvaApp from '../torqva/TorqvaApp.jsx';
import { setToken } from '../torqva/api.js';

const ok = (j) => ({ ok: true, status: 200, json: async () => j });
const INFO = { cap: 1, why: '', run: 'ota_0', psz: 3342336, pend: 0, last: '', lver: '', blk: '', busy: 0 };
const REL = { id: '0123456789ab', sha256: '0123456789ab' + '0'.repeat(52), version: '3.1.0', size: 956016, chip: 'esp32s3', uploaded_by: 'adam', uploaded_at: 1762190000, status: 'APPROVED', deployable: true,
  checks: { image: { status: 'VERIFIED', detail: '5 segments' }, chip: { status: 'VERIFIED', detail: 'ESP32-S3' }, partition: { status: 'VERIFIED', detail: 'fits' }, integrity: { status: 'VERIFIED', detail: 'SHA-256 x' }, signature: { status: 'VERIFIED', detail: 'ECDSA P-256' } }, deployments: [] };
function status({ info = INFO, current = null, connected = true, fw = '3.0.1' } = {}) {
  return { device: { connected, connection: connected ? 'CONNECTED' : 'DISCONNECTED', handshake: connected, device_id: connected ? 'RIG-1' : null, firmware: connected ? fw : null, chip: connected ? 'ESP32-S3' : null, session_active: connected, safety_state: 'OK', drive: 'IDLE', ota: connected ? info : null, ota_age_s: 0.4 },
    config: { signature_verification: 'AVAILABLE', key_fingerprint: '67a01148a1c4042f', device_url: 'https://ota.bench.lan', device_url_problem: '', max_image_bytes: 3342336, storage: 'OK' },
    current, eligibility: [], motor_operation: 'Firmware updates never enable motor operation.' };
}
let posts;
function server({ st = status(), releases = [REL], eligibility = [] } = {}) {
  posts = [];
  vi.stubGlobal('fetch', vi.fn(async (url, o = {}) => {
    const path = String(url).replace('/api/torqva', '').split('?')[0];
    if ((o.method || 'GET') !== 'GET') { posts.push({ path, body: o.body ? JSON.parse(o.body) : null }); return ok({ id: 'dep1', state: 'REQUESTED', events: [] }); }
    if (path === '/firmware/status') return ok(st);
    if (path === '/firmware/releases') return ok({ releases, config: st.config });
    if (path.startsWith('/firmware/releases/')) return ok({ ...REL, eligibility });
    if (path === '/firmware/deployments') return ok({ current: st.current, history: [{ kind: 'deployment_result', release: REL.id, version: '3.0.9', result: 'CONFIRMED', at: 1762100000, device: 'RIG-1' }] });
    return ok({});
  }));
}
beforeEach(() => { vi.unstubAllGlobals(); setToken('t'); });

describe('Firmware Manager page', () => {
  it('shows the device firmware facts and the separation from motor operation', async () => {
    server(); render(<FirmwarePage role="admin" go={() => {}} />);
    const dev = await screen.findByTestId('fw-device');
    await waitFor(() => expect(dev).toHaveTextContent('3.0.1'));
    expect(dev).toHaveTextContent('OTA capable'); expect(dev).toHaveTextContent('running ota_0');
    expect(screen.getByTestId('fw-banner')).toHaveTextContent('never enable motor operation');
  });

  it('a device without OTA support says OTA NOT CONFIGURED and needs the initial USB installation', async () => {
    server({ st: status({ info: { ...INFO, cap: 0, why: 'NO_OTA_PARTITIONS' } }) }); render(<FirmwarePage role="admin" go={() => {}} />);
    expect(await screen.findByTestId('fw-not-configured')).toHaveTextContent(/OTA NOT CONFIGURED.*initial USB installation/);
    expect(screen.getByTestId('fw-device')).toHaveTextContent('NO_OTA_PARTITIONS');
  });

  it('operators and viewers see the records but cannot upload or deploy', async () => {
    server(); render(<FirmwarePage role="operator" go={() => {}} />);
    await screen.findByTestId('fw-device');
    expect(screen.getByText('Uploading firmware requires the admin role.')).toBeInTheDocument();
    expect(screen.queryByTestId('fw-upload-btn')).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: '3.1.0' }));
    expect(await screen.findByText('Deploying firmware requires the admin role.')).toBeInTheDocument();
    expect(screen.queryByTestId('fw-deploy')).toBeNull();
  });

  it('checks a picked file in the browser and refuses source code or a non-ESP image', async () => {
    server(); render(<FirmwarePage role="admin" go={() => {}} />);
    const input = await screen.findByTestId('fw-file');
    await act(async () => { fireEvent.change(input, { target: { files: [new File(['void setup(){}'], 'main.cpp')] } }); });
    expect(await screen.findByTestId('fw-precheck')).toHaveTextContent(/Only a compiled application image/);
    expect(screen.getByTestId('fw-upload-btn')).toBeDisabled();
    const bad = new Uint8Array(64); bad[0] = 0x7f;
    await act(async () => { fireEvent.change(input, { target: { files: [new File([bad], 'firmware.bin')] } }); });
    await waitFor(() => expect(screen.getByTestId('fw-precheck')).toHaveTextContent(/not an ESP application image/));
    const good = new Uint8Array(64); good[0] = 0xE9; good[12] = 9;
    await act(async () => { fireEvent.change(input, { target: { files: [new File([good], 'firmware.bin')] } }); });
    await waitFor(() => expect(screen.queryByTestId('fw-precheck')).toBeNull());
    expect(screen.getByTestId('fw-upload-btn')).not.toBeDisabled();
  });

  it('shows each validation result separately for the selected release', async () => {
    server({ releases: [{ ...REL, deployable: false, status: 'NOT DEPLOYABLE', checks: { ...REL.checks, signature: { status: 'FAILED', detail: 'does not match' } } }] });
    render(<FirmwarePage role="admin" go={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: '3.1.0' }));
    const v = screen.getByTestId('fw-validation');
    expect(within(v).getByText('Signature verification').closest('li')).toHaveTextContent('FAILED');
    expect(within(v).getByText('SHA-256 integrity').closest('li')).toHaveTextContent('VERIFIED');
    expect(within(v).getByText('not deployable')).toBeInTheDocument();
  });

  it('deployment needs eligibility, the bench attestation and the exact phrase, then a second confirmation', async () => {
    server(); render(<FirmwarePage role="admin" go={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: '3.1.0' }));
    const btn = await screen.findByTestId('fw-deploy');
    expect(btn).toBeDisabled();
    fireEvent.click(screen.getByTestId('fw-bench'));
    expect(btn).toBeDisabled();
    fireEvent.change(screen.getByTestId('fw-phrase'), { target: { value: 'INSTALL 3.1.0 ON RIG-1' } });
    expect(btn).not.toBeDisabled();
    fireEvent.click(btn);
    expect(posts).toEqual([]);                                                   // the first press only arms it
    fireEvent.click(screen.getByRole('button', { name: /Confirm: install now/ }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({ path: '/firmware/deployments', body: { release_id: '0123456789ab', device_id: 'RIG-1', confirm: 'INSTALL 3.1.0 ON RIG-1', bench_power_disconnected: true } });
  });

  it('an ineligible release lists the reasons and the update stays disabled', async () => {
    server({ eligibility: ['the device refuses an update now: MOTOR_POWER_CONNECTED'] }); render(<FirmwarePage role="admin" go={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: '3.1.0' }));
    expect(await screen.findByTestId('fw-blockers')).toHaveTextContent('MOTOR_POWER_CONNECTED');
    fireEvent.click(screen.getByTestId('fw-bench'));
    fireEvent.change(screen.getByTestId('fw-phrase'), { target: { value: 'INSTALL 3.1.0 ON RIG-1' } });
    expect(screen.getByTestId('fw-deploy')).toBeDisabled();
  });

  it('a device restart shows WAITING FOR DEVICE RECONNECTION, not a failure', async () => {
    const dep = { id: 'd1', release: REL.id, version: '3.1.0', from_version: '3.0.1', requested_by: 'adam', state: 'WAITING_FOR_RECONNECTION', reason: '', bytes: 956016, total: 956016,
      events: ['REQUESTED', 'AUTHORIZED', 'WIFI', 'MANIFEST', 'DOWNLOADING', 'VERIFYING', 'READY', 'REBOOTING', 'WAITING_FOR_RECONNECTION'].map((s, i) => ({ state: s, at: 1762190000 + i, detail: '' })) };
    server({ st: status({ current: dep, connected: false }) }); render(<FirmwarePage role="admin" go={() => {}} />);
    expect(await screen.findByTestId('fw-result')).toHaveTextContent('WAITING FOR DEVICE RECONNECTION');
    expect(screen.getByTestId('fw-result')).not.toHaveTextContent(/failed|successful/i);
  });

  it('a confirmed update says so, keeps the motor statement and links back to Device & Safety', async () => {
    const go = vi.fn();
    const dep = { id: 'd1', release: REL.id, version: '3.1.0', from_version: '3.0.1', requested_by: 'adam', state: 'CONFIRMED', reason: '', bytes: 1, total: 1, events: [{ state: 'REQUESTED', at: 1 }, { state: 'CONFIRMED', at: 2 }] };
    server({ st: status({ current: dep, fw: '3.1.0' }) }); render(<FirmwarePage role="admin" go={go} />);
    const r = await screen.findByTestId('fw-result');
    expect(r).toHaveTextContent('Update successful'); expect(r).toHaveTextContent('Motor outputs stay disabled');
    fireEvent.click(within(r).getByRole('button', { name: /Return to Device & Safety/ }));
    expect(go).toHaveBeenCalledWith('device');
  });
});

describe('stages and results come only from the deployment record', () => {
  const ev = (...s) => s.map((x, i) => ({ state: x, at: i }));
  it('no stage is done without a report, and the current one is in progress', () => {
    const st = stageSteps({ state: 'DOWNLOADING', bytes: 4096, total: 100000, events: ev('REQUESTED', 'AUTHORIZED', 'WIFI', 'MANIFEST', 'DOWNLOADING') });
    expect(st.map((s) => s.state)).toEqual(['done', 'done', 'active', 'pending', 'pending', 'pending', 'pending', 'pending', 'pending']);
    expect(st[2].sub).toMatch(/4\.0 KB of 97\.7 KB/);
    const gap = stageSteps({ state: 'VERIFYING', events: ev('REQUESTED', 'VERIFYING') });       // Wi-Fi and download were never reported
    expect(gap[1]).toMatchObject({ state: 'skipped', sub: 'not reported' });
  });
  it('a failure marks the stage where it stopped; a rollback fails the self-test stage', () => {
    expect(stageSteps({ state: 'FAILED', events: ev('REQUESTED', 'AUTHORIZED', 'WIFI', 'FAILED') }).map((s) => s.state).slice(0, 3)).toEqual(['done', 'failed', 'pending']);
    expect(stageSteps({ state: 'ROLLBACK', events: ev('REQUESTED', 'REBOOTING', 'SELF_TEST', 'ROLLBACK') })[7].state).toBe('failed');
  });
  it('results are named only from terminal states', () => {
    expect(resultOf({ state: 'DOWNLOADING' })).toBeNull();
    expect(resultOf({ state: 'CONFIRMED', version: '3.1.0' }, { firmware: '3.1.0' })[1]).toBe('Update successful');
    expect(resultOf({ state: 'ROLLED_BACK', reason: 'r' }, { firmware: '3.0.1' })[1]).toBe('Update rolled back');
    expect(resultOf({ state: 'REFUSED', reason: 'MOTOR_TURNING' })[1]).toBe('Update failed');
    expect(resultOf({ state: 'VERIFICATION_PENDING', reason: 'x' })[1]).toBe('Update verification pending');
  });
});

describe('navigation', () => {
  it('Firmware Manager sits in the Device & Safety group; simulation mode says it is for the physical device only', async () => {
    window.localStorage.setItem('torqva.mode', 'SIMULATION');
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const path = String(url).replace('/api/torqva', '').split('?')[0];
      if (path === '/me') return ok({ user: 'tester', role: 'admin' });
      if (path === '/status') return ok({ mode: 'SIMULATION', t: 5, device: {}, models: {}, last_window: null });
      return ok(path === '/telemetry' ? { samples: [] } : []);
    }));
    render(<TorqvaApp pollMs={100000} />);
    await screen.findByText(/tester · /);
    const group = screen.getByRole('button', { name: 'Show or hide Device & Safety' }).closest('.tq-navgroup');
    expect(within(group).getByRole('button', { name: /^Firmware Manager$/ })).toBeInTheDocument();
    fireEvent.click(within(group).getByRole('button', { name: /^Firmware Manager$/ }));
    expect(await screen.findByTestId('fw-sim-note')).toHaveTextContent('PHYSICAL DEVICE ONLY');
    expect(fetch.mock.calls.some(([u]) => String(u).includes('/firmware/'))).toBe(false);      // simulation mode never calls the firmware routes
    window.localStorage.removeItem('torqva.mode');
  });
});
