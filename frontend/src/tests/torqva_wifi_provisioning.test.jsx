// Configure Wi-Fi card: the form only enables when the backend reports ready and the operator confirmed motor power is off, the password never leaves the POST body, is cleared
// from the page once sent and never reaches browser storage, network names are shown exactly as received, and progress is exactly what the job reports.
import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { WifiProvisioningCard, jobSteps } from '../device/wifiProvisioning.jsx';

const ok = (j) => ({ ok: true, status: 200, json: async () => j });
const fail = (status, detail) => ({ ok: false, status, json: async () => ({ detail }) });
const CUR = { connected: false, transport: null, device_id: null, ssid: '', rssi: null, bars: 0, ip: '', band: '', configured_ssid: '', staging_supported: false, trial: false, trial_left_s: 0, session_active: false, telemetry_fresh: false };
const READY = { available: true, available_for_usb: true, esptool: true, trust_anchor: true, trust_anchor_detail: 'ok', default_backend_url: 'https://192.168.1.50:8443', busy_operation: null,
  recovery_required: null, gateway_cert_ok: true, gateway_cert_detail: '', current_network: CUR };
const WIFI_NOW = { ...CUR, connected: true, transport: 'wifi', device_id: 'RIG-1', ssid: 'HomeNet', rssi: -52, bars: 4, ip: '192.168.1.77', band: '2.4 GHz', configured_ssid: 'HomeNet', staging_supported: true, session_active: true, telemetry_fresh: true };
const PORTS = { ports: [{ device: 'COM3', description: 'Bluetooth link' }, { device: 'COM7', description: 'USB-Enhanced-SERIAL CH343' }] };
const SCAN = { networks: [
  { ssid: 'C4 Lab', rssi: -48, bars: 4, security: 'WPA2', channel: 6, frequency_mhz: 2437, band: '2.4 GHz', current: false, configured: true },
  { ssid: 'Guest', rssi: -78, bars: 1, security: 'OPEN', channel: 11, frequency_mhz: 2462, band: '2.4 GHz', current: true, configured: false }],
  note: 'The ESP32-S3 supports 2.4 GHz Wi-Fi only (channels 1-14). 5 GHz networks cannot be seen or used.', current_ssid: 'Guest', configured_ssid: 'C4 Lab', cached: false };
const RUNNING = { id: 'j1', kind: 'usb_provisioning', state: 'RELEASING_PORT', detail: 'closing', logs: [], checks: {}, recovery: [], created_at: 1762000000, ssid: 'NewNet' };

let calls;
function server({ status = READY, job = RUNNING, history = [], scan = SCAN, scanError = null } = {}) {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url, o = {}) => {
    const path = String(url).replace('/api/torqva', '').split('?')[0];
    calls.push({ path, method: o.method || 'GET', url: String(url), body: o.body || null });
    if (path === '/provisioning/status') return ok(status);
    if (path === '/provisioning/history') return ok({ jobs: history });
    if (path === '/device/ports') return ok(PORTS);
    if (path === '/provisioning/scan') return scanError ? fail(409, scanError) : ok(scan);
    if (path === '/provisioning/jobs' || path === '/provisioning/network-switch') return ok(job);
    if (path.startsWith('/provisioning/jobs/')) return ok(job);
    if (path === '/provisioning/recovery/clear') return ok({ cleared: true });
    if (path === '/provisioning/gateway-cert') return ok({ restart_required: true, detail: 'The gateway certificate was reissued. Restart the HTTPS gateway so it loads it.' });
    return ok({});
  }));
}
const type = (id, v) => fireEvent.change(screen.getByTestId(id), { target: { value: v } });
const mount = (props = {}) => render(<WifiProvisioningCard admin snap={{ device_id: 'RIG-1' }} onDone={() => {}} {...props} />);

describe('Configure Wi-Fi card', () => {
  beforeEach(() => { vi.unstubAllGlobals(); sessionStorage.clear(); localStorage.clear(); });

  it('detects the likely ESP32 port, shows the automatic backend address and keeps Configure disabled until confirmed', async () => {
    server(); mount();
    await waitFor(() => expect(screen.getByTestId('wifi-prov-port').value).toBe('COM7'));
    expect(screen.getByText(/Detected: https:\/\/192\.168\.1\.50:8443/)).toBeTruthy();
    type('wifi-prov-ssid', 'HomeNet'); type('wifi-prov-password', 'password123');
    expect(screen.getByTestId('wifi-prov-start').disabled).toBe(true);                 // motor-power confirmation missing
    fireEvent.click(screen.getByTestId('wifi-prov-confirm'));
    expect(screen.getByTestId('wifi-prov-start').disabled).toBe(false);
  });

  it('toggles password visibility', async () => {
    server(); mount({ snap: {} });
    const pw = await screen.findByTestId('wifi-prov-password');
    expect(pw.type).toBe('password');
    fireEvent.click(screen.getByLabelText('Show password'));
    expect(pw.type).toBe('text');
  });

  it('sends the password only in the POST body, never in a URL, clears it from the page and never writes it to browser storage', async () => {
    server(); mount({ snap: {} });
    await waitFor(() => expect(screen.getByTestId('wifi-prov-port').value).toBe('COM7'));
    type('wifi-prov-ssid', 'HomeNet'); type('wifi-prov-password', 'Sup3r-Secret-Pw');
    fireEvent.click(screen.getByTestId('wifi-prov-confirm'));
    fireEvent.click(screen.getByTestId('wifi-prov-start'));
    await waitFor(() => expect(screen.getByTestId('wifi-prov-progress')).toBeTruthy());
    const post = calls.find((c) => c.method === 'POST' && c.path === '/provisioning/jobs');
    expect(JSON.parse(post.body)).toMatchObject({ ssid: 'HomeNet', password: 'Sup3r-Secret-Pw', port: 'COM7', confirm_physical: true });
    expect(calls.some((c) => c.url.includes('Sup3r-Secret-Pw'))).toBe(false);
    expect(screen.getByTestId('wifi-prov-password').value).toBe('');
    expect(document.body.innerHTML.includes('Sup3r-Secret-Pw')).toBe(false);
    expect(JSON.stringify({ ...sessionStorage }) + JSON.stringify({ ...localStorage })).not.toContain('Sup3r-Secret-Pw');
  });

  it('is disabled with the backend reason when provisioning is not available', async () => {
    server({ status: { ...READY, available: false, available_for_usb: false, esptool: false } }); mount({ snap: {} });
    expect((await screen.findByTestId('wifi-prov-unavailable')).textContent).toMatch(/esptool is not installed/);
    expect(screen.getByTestId('wifi-prov-start').disabled).toBe(true);
  });

  it('requires admin', async () => {
    server(); mount({ admin: false, snap: {} });
    expect(await screen.findByText(/Admin authorization is required/)).toBeTruthy();
    expect(screen.queryByTestId('wifi-prov-start')).toBeNull();
  });
});

describe('network discovery', () => {
  beforeEach(() => { vi.unstubAllGlobals(); });

  it('lists scanned networks with signal, security, channel and band, marks current and saved ones, and explains 2.4 GHz', async () => {
    server(); mount({ snap: {} });
    fireEvent.click(await screen.findByTestId('wifi-prov-scan'));
    const sel = await screen.findByTestId('wifi-prov-network');
    await waitFor(() => expect(sel.disabled).toBe(false));
    const options = within(sel).getAllByRole('option').map((o) => o.textContent);
    expect(options.some((t) => /C4 Lab.*-48 dBm.*WPA2.*ch 6.*saved/.test(t))).toBe(true);
    expect(options.some((t) => /Guest.*-78 dBm.*OPEN.*ch 11.*current/.test(t))).toBe(true);
    fireEvent.change(sel, { target: { value: 'C4 Lab' } });
    const info = screen.getByTestId('wifi-prov-picked').textContent;
    expect(info).toMatch(/-48 dBm/); expect(info).toMatch(/WPA2/); expect(info).toMatch(/2437 MHz/); expect(info).toMatch(/2\.4 GHz/); expect(info).toMatch(/saved on board/);
    expect(screen.getByLabelText(/Signal 4 of 4 bars/)).toBeTruthy();
    expect(screen.getByTestId('wifi-prov-note').textContent).toMatch(/2\.4 GHz/);
    expect(screen.getByTestId('wifi-prov-note').textContent).toMatch(/5 GHz networks cannot be seen/);
    expect(screen.queryByTestId('wifi-prov-ssid')).toBeNull();                         // a listed network needs no typing
  });

  it('shows network names exactly as received (an SSID such as "C4 Lab" is never reworded)', async () => {
    server(); mount({ snap: {} });
    fireEvent.click(await screen.findByTestId('wifi-prov-scan'));
    const sel = await screen.findByTestId('wifi-prov-network');
    await waitFor(() => expect(sel.disabled).toBe(false));
    expect(within(sel).getAllByRole('option').some((o) => o.textContent.startsWith('C4 Lab'))).toBe(true);
    expect(sel.textContent).not.toMatch(/Diagnostic Investigation/);
  });

  it('a chosen scanned network is what gets configured, and hidden networks can be typed', async () => {
    server(); mount({ snap: {} });
    await waitFor(() => expect(screen.getByTestId('wifi-prov-port').value).toBe('COM7'));
    fireEvent.click(screen.getByTestId('wifi-prov-scan'));
    const sel = await screen.findByTestId('wifi-prov-network');
    await waitFor(() => expect(sel.disabled).toBe(false));
    fireEvent.change(sel, { target: { value: 'C4 Lab' } });
    type('wifi-prov-password', 'password123'); fireEvent.click(screen.getByTestId('wifi-prov-confirm'));
    fireEvent.click(screen.getByTestId('wifi-prov-start'));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST' && c.path === '/provisioning/jobs')).toBeTruthy());
    expect(JSON.parse(calls.find((c) => c.path === '/provisioning/jobs').body).ssid).toBe('C4 Lab');
    // hidden network: choose "Other" and type the name
    fireEvent.change(sel, { target: { value: '@manual' } });
    expect(screen.getByTestId('wifi-prov-ssid')).toBeTruthy();
  });

  it('falls back to manual entry and says why when the board cannot scan', async () => {
    server({ scanError: { code: 'NO_AUTHENTICATED_LINK', message: 'scanning needs the board connected with an authenticated session (USB or Wi-Fi); you can still type the network name by hand' } });
    mount({ snap: {} });
    fireEvent.click(await screen.findByTestId('wifi-prov-scan'));
    await waitFor(() => expect(screen.getByTestId('wifi-prov-note').textContent).toMatch(/Scanning is unavailable: scanning needs the board connected/));
    expect(screen.getByTestId('wifi-prov-ssid')).toBeTruthy();
  });
});

describe('status, recovery and certificate guidance', () => {
  beforeEach(() => { vi.unstubAllGlobals(); });

  it('shows current network details with signal strength and device connection', async () => {
    server({ status: { ...READY, current_network: WIFI_NOW } }); mount({ snap: { device_id: 'RIG-1', connection: 'CONNECTED', transport: { kind: 'wifi' } } });
    const now = await screen.findByTestId('wifi-now');
    await waitFor(() => expect(now.textContent).toMatch(/HomeNet/));
    expect(now.textContent).toMatch(/-52 dBm/); expect(now.textContent).toMatch(/2\.4 GHz/); expect(now.textContent).toMatch(/192\.168\.1\.77/); expect(now.textContent).toMatch(/RIG-1 · Wi-Fi/);
    expect(now.textContent).toMatch(/supported/);
    expect(within(now).getByLabelText(/Signal 4 of 4 bars \(-52 dBm\)/)).toBeTruthy();
  });

  it('missing values read UNAVAILABLE, never zero or blank', async () => {
    server(); mount({ snap: {} });
    const now = await screen.findByTestId('wifi-now');
    expect(now.textContent).toMatch(/UNAVAILABLE/);
  });

  it('Change Network is a staged change: only while on Wi-Fi with staging support, and it posts to the network-switch endpoint', async () => {
    server({ status: { ...READY, current_network: WIFI_NOW }, job: { ...RUNNING, kind: 'network_switch', state: 'STAGING' } });
    mount({ snap: { device_id: 'RIG-1', connection: 'CONNECTED', transport: { kind: 'wifi' } } });
    await waitFor(() => expect(screen.getByTestId('wifi-now').textContent).toMatch(/HomeNet/));
    type('wifi-prov-ssid', 'NewNet'); type('wifi-prov-password', 'password123');
    await waitFor(() => expect(screen.getByTestId('wifi-prov-change').disabled).toBe(false));
    expect(screen.getByTestId('wifi-prov-start').disabled).toBe(true);                 // USB setup is not for a board that is on Wi-Fi
    fireEvent.click(screen.getByTestId('wifi-prov-change'));
    await waitFor(() => expect(calls.find((c) => c.path === '/provisioning/network-switch')).toBeTruthy());
    const body = JSON.parse(calls.find((c) => c.path === '/provisioning/network-switch').body);
    expect(body).toMatchObject({ device_id: 'RIG-1', ssid: 'NewNet', password: 'password123' });
    expect(calls.some((c) => c.path === '/device/wifi')).toBe(false);                  // the old immediate-overwrite route is never used
  });

  it('Change Network is refused in the UI when the firmware cannot stage, and says what to do', async () => {
    server({ status: { ...READY, current_network: { ...WIFI_NOW, staging_supported: false } } });
    mount({ snap: { device_id: 'RIG-1', connection: 'CONNECTED', transport: { kind: 'wifi' } } });
    await waitFor(() => expect(screen.getByTestId('wifi-now').textContent).toMatch(/HomeNet/));
    type('wifi-prov-ssid', 'NewNet'); type('wifi-prov-password', 'password123');
    expect(screen.getByTestId('wifi-prov-change').disabled).toBe(true);
    expect(screen.getByText(/cannot stage a network change/)).toBeTruthy();
  });

  it('shows the recovery block and clears it only on request', async () => {
    server({ status: { ...READY, available: false, recovery_required: { reason: 'an interrupted Wi-Fi configuration write left the board state unknown', job: 'x' } } }); mount({ snap: {} });
    expect((await screen.findByTestId('wifi-recovery-required')).textContent).toMatch(/Recovery required/);
    expect(screen.getByTestId('wifi-prov-start').disabled).toBe(true);                 // no confirmation yet, but USB provisioning itself stays allowed once confirmed
    fireEvent.click(screen.getByTestId('wifi-recovery-clear'));
    await waitFor(() => expect(calls.find((c) => c.path === '/provisioning/recovery/clear' && c.method === 'POST')).toBeTruthy());
  });

  it('warns when the gateway certificate does not name this laptop and offers to reissue it', async () => {
    server({ status: { ...READY, gateway_cert_ok: false, gateway_cert_detail: 'the gateway certificate does not name this laptop\'s address 192.168.9.9' } }); mount({ snap: {} });
    expect((await screen.findByTestId('wifi-cert-warning')).textContent).toMatch(/does not name this laptop/);
    fireEvent.click(screen.getByTestId('wifi-cert-reissue'));
    await waitFor(() => expect(calls.find((c) => c.path === '/provisioning/gateway-cert')).toBeTruthy());
    expect((await screen.findByRole('status')).textContent).toMatch(/Restart the HTTPS gateway/);
  });
});

describe('progress, results and history', () => {
  beforeEach(() => { vi.unstubAllGlobals(); });

  it('renders the history with results and never shows a password', async () => {
    const history = [{ id: 'a1', kind: 'usb_provisioning', state: 'PAIRED_WIRELESS', ssid: 'HomeNet', detail: 'wireless link verified', created_at: 1762000000 },
      { id: 'a2', kind: 'network_switch', state: 'ROLLED_BACK', ssid: 'C4 Lab', detail: 'the board is back on HomeNet', created_at: 1762001000 }];
    server({ history }); mount({ snap: {} });
    const h = await screen.findByTestId('wifi-history');
    await waitFor(() => expect(h.textContent).toMatch(/HomeNet/));
    expect(h.textContent).toMatch(/Network change/); expect(h.textContent).toMatch(/USB setup/); expect(h.textContent).toMatch(/C4 Lab/);
    expect(h.textContent).toMatch(/Rolled back/); expect(h.textContent).toMatch(/Paired wireless/);
  });

  it('resumes a job that was still running when the page was reloaded', async () => {
    server({ history: [{ ...RUNNING, state: 'WRITING_NVS', stalled: false }], job: { ...RUNNING, state: 'WRITING_NVS', detail: 'writing the merged NVS image' } }); mount({ snap: {} });
    expect((await screen.findByTestId('wifi-prov-detail')).textContent).toMatch(/writing the merged NVS image/);
  });

  it('tells the user their previous network was restored after a rolled-back change', async () => {
    const job = { id: 'j2', kind: 'network_switch', state: 'ROLLED_BACK', error_code: 'PAIRING_TIMEOUT', previous_ssid: 'HomeNet', detail: 'the board is back on HomeNet', logs: [], checks: {},
      recovery: ['Check the Wi-Fi password.'], ssid: 'NewNet' };
    server({ status: { ...READY, current_network: WIFI_NOW }, job });
    mount({ snap: { device_id: 'RIG-1', connection: 'CONNECTED', transport: { kind: 'wifi' } } });
    await waitFor(() => expect(screen.getByTestId('wifi-now').textContent).toMatch(/HomeNet/));
    type('wifi-prov-ssid', 'NewNet'); type('wifi-prov-password', 'password123');
    await waitFor(() => expect(screen.getByTestId('wifi-prov-change').disabled).toBe(false));
    fireEvent.click(screen.getByTestId('wifi-prov-change'));
    const restored = await screen.findByTestId('wifi-prov-restored');
    expect(restored.textContent).toMatch(/previous network “HomeNet” is working again/);
    expect(screen.getByTestId('wifi-prov-recovery').textContent).toMatch(/Check the Wi-Fi password/);
    expect(screen.getByTestId('wifi-prov-detail').textContent).toMatch(/PAIRING_TIMEOUT/);
  });

  it('passes the backend error message through verbatim', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url, o = {}) => {
      const path = String(url).replace('/api/torqva', '').split('?')[0];
      if (path === '/provisioning/status') return ok(READY);
      if (path === '/device/ports') return ok(PORTS);
      if (path === '/provisioning/history') return ok({ jobs: [] });
      if (path === '/provisioning/jobs') return fail(409, { code: 'INVALID_INPUT', message: "the board did not complete an authenticated link on 'C4 Lab' in time" });
      return ok({});
    }));
    mount({ snap: {} });
    await waitFor(() => expect(screen.getByTestId('wifi-prov-port').value).toBe('COM7'));
    type('wifi-prov-ssid', 'C4 Lab'); type('wifi-prov-password', 'password123'); fireEvent.click(screen.getByTestId('wifi-prov-confirm'));
    fireEvent.click(screen.getByTestId('wifi-prov-start'));
    expect((await screen.findByRole('alert')).textContent).toMatch(/on 'C4 Lab' in time/);
  });
});

describe('jobSteps', () => {
  it('shows nothing done before a job and marks the reported step active', () => {
    expect(jobSteps(null).every((s) => s.state === 'pending')).toBe(true);
    expect(jobSteps({ state: 'WRITING_NVS' }).map((x) => x.state)).toEqual(['done', 'done', 'active', 'pending', 'pending', 'pending', 'pending', 'pending']);
  });
  it('marks the failing step from the failure code and leaves later ones pending; pairing complete marks all done', () => {
    const f = jobSteps({ state: 'FAILED', error_code: 'RESTART_FAILED' });
    expect(f.find((x) => x.key === 'RECONNECTING').state).toBe('failed');
    expect(f.find((x) => x.key === 'RESTARTING').state).toBe('done');
    expect(f.find((x) => x.key === 'VERIFYING_DEVICE').state).toBe('pending');
    expect(jobSteps({ state: 'PAIRED_WIRELESS' }).every((x) => x.state === 'done')).toBe(true);
  });
  it('USB paired but wireless not seen is not shown as complete', () => {
    const s = jobSteps({ state: 'WIRELESS_PENDING' });
    expect(s[s.length - 1].state).toBe('failed');
  });
  it('a staged USB job adds the commit step after the wireless wait', () => {
    const s = jobSteps({ state: 'COMMITTING', staged: true });
    expect(s[s.length - 1].key).toBe('COMMITTING'); expect(s[s.length - 1].state).toBe('active'); expect(s[s.length - 2].state).toBe('done');
    expect(jobSteps({ state: 'WIRELESS_PENDING', staged: true }).find((x) => x.key === 'WIRELESS_WAIT').state).toBe('failed');
  });
  it('a network change shows staging, joining, verifying and committing, plus the restore step only when it was needed', () => {
    const run = jobSteps({ kind: 'network_switch', state: 'SWITCHING' });
    expect(run.map((x) => x.state)).toEqual(['done', 'active', 'pending', 'pending']);
    const rolled = jobSteps({ kind: 'network_switch', state: 'ROLLED_BACK', error_code: 'PAIRING_TIMEOUT' });
    expect(rolled.map((x) => x.state)).toEqual(['done', 'failed', 'pending', 'pending', 'done']);
    expect(rolled[rolled.length - 1].key).toBe('ROLLBACK');
    const waiting = jobSteps({ kind: 'network_switch', state: 'WAITING_ROLLBACK', error_code: undefined });
    expect(waiting[waiting.length - 1].state).toBe('active');
    const lost = jobSteps({ kind: 'network_switch', state: 'FAILED', error_code: 'DEVICE_LOST' });
    expect(lost[lost.length - 1].state).toBe('failed');
    expect(jobSteps({ kind: 'network_switch', state: 'COMMITTED' }).every((x) => x.state === 'done')).toBe(true);
  });
});
