// Rendered review of Firmware Manager -> Device Management -> Configure Wi-Fi in real Chrome: six resolutions x light/dark x four states, plus one pass against the live backend.
// Checks: no page-level horizontal overflow, nothing of the card sticks out of it, text contrast >= 4.5:1, no console errors, and (interaction) keyboard operation, the password
// toggle, and that the password reaches only the POST body (never the DOM, storage, URLs or console).
// Run:  npm run dev:sim   (in another terminal; software-only: it never opens a serial port)   then   node e2e/wifi-provisioning-review.mjs
// Env:  TORQVA_URL (default http://127.0.0.1:5173/)  TORQVA_TOKEN (default torqva-local-dev-token)  CHROME_PATH
import { chromium } from 'playwright-core';
import fs from 'fs';
import path from 'path';

const URL = process.env.TORQVA_URL || 'http://127.0.0.1:5173/';
const TOKEN = process.env.TORQVA_TOKEN || 'torqva-local-dev-token';
const out = path.resolve('quality-review', 'wifi-provisioning');
fs.mkdirSync(out, { recursive: true });
const SIZES = [[1024, 768], [1280, 720], [1366, 768], [1440, 900], [1920, 1080], [2560, 1440]];
const THEMES = ['dark', 'light'];
const SECRET = 'Rev1ew-Secret-Pass';

// ---------------------------------------------------------------- mocked backend state
const CUR = { connected: false, transport: null, device_id: null, ssid: '', rssi: null, bars: 0, ip: '', band: '', configured_ssid: '', staging_supported: false, trial: false, trial_left_s: 0, session_active: false, telemetry_fresh: false };
const WIFI_NOW = { ...CUR, connected: true, transport: 'wifi', device_id: 'RIG-1', ssid: 'HomeNet', rssi: -52, bars: 4, ip: '192.168.1.77', band: '2.4 GHz', configured_ssid: 'HomeNet', staging_supported: true, session_active: true, telemetry_fresh: true };
const STATUS = { available: true, available_for_usb: true, esptool: true, trust_anchor: true, trust_anchor_detail: 'ok', default_backend_url: 'https://192.168.1.50:8443', busy_operation: null, recovery_required: null,
  gateway_cert_ok: true, gateway_cert_detail: '', current_network: CUR };
const SCAN = { networks: [
  { ssid: 'HomeNet', rssi: -48, bars: 4, security: 'WPA2', channel: 6, frequency_mhz: 2437, band: '2.4 GHz', current: true, configured: true },
  { ssid: 'C4 Lab 2.4G (long network name that must wrap or truncate cleanly)', rssi: -63, bars: 3, security: 'WPA2/WPA3', channel: 1, frequency_mhz: 2412, band: '2.4 GHz', current: false, configured: false },
  { ssid: 'Guest', rssi: -78, bars: 1, security: 'OPEN', channel: 11, frequency_mhz: 2462, band: '2.4 GHz', current: false, configured: false }],
  note: 'The ESP32-S3 supports 2.4 GHz Wi-Fi only (channels 1-14). 5 GHz networks cannot be seen or used; if your router combines both bands under one name, enable its 2.4 GHz radio. Hidden networks are not listed: type their name by hand.',
  current_ssid: 'HomeNet', configured_ssid: 'HomeNet', cached: false };
const HISTORY = [
  { id: 'h3', kind: 'network_switch', state: 'ROLLED_BACK', ssid: 'OfficeNet', detail: 'The board is back on HomeNet: authenticated, identity confirmed, telemetry fresh. Nothing was changed.', created_at: 1762002000 },
  { id: 'h2', kind: 'usb_provisioning', state: 'PAIRED_WIRELESS', ssid: 'HomeNet', detail: 'wireless link verified with the same device identity; the new network is now permanent', created_at: 1762001000 },
  { id: 'h1', kind: 'usb_provisioning', state: 'FAILED', ssid: 'HomeNet', detail: 'the board did not reappear on COM7 after restart (no response). The NVS write was verified; check the board, then retry USB recovery', created_at: 1762000000 }];
const LOGS = ['10:02:11 RELEASING_PORT: closing the backend serial connection', '10:02:12 READING_NVS: reading the device partition table and NVS partition',
  '10:02:13 NVS merge: 9 existing entries kept; identity reused; staged (previous network kept)', '10:02:14 WRITING_NVS: writing the merged NVS image to 0x9000 only'];
const JOBS = {
  progress: { id: 'j1', kind: 'usb_provisioning', device_id: 'RIG-1', port: 'COM7', ssid: 'NewNet', state: 'VERIFYING_NVS', progress: 60, detail: 'reading the partition back and comparing it with the image that was written',
    logs: LOGS, checks: { existing_entries: 9, nvs_verified: false }, recovery: [], staged: true, previous_ssid: 'HomeNet', created_at: 1762003000, wait_until: null },
  waiting: { id: 'j4', kind: 'usb_provisioning', device_id: 'RIG-1', port: 'COM7', ssid: 'NewNet', state: 'WIRELESS_WAIT', progress: 95, detail: 'USB pairing verified. Unplug the USB data cable; the board joins Wi-Fi and TORQVA confirms the wireless link',
    logs: LOGS, checks: { existing_entries: 9, nvs_verified: true, authenticated_session: true, telemetry_fresh: true }, recovery: [], staged: true, previous_ssid: 'HomeNet', created_at: 1762003000, wait_until: Math.floor(Date.now() / 1000) + 240 },
  rolled: { id: 'j2', kind: 'network_switch', device_id: 'RIG-1', ssid: 'OfficeNet', state: 'ROLLED_BACK', progress: 100, error_code: 'PAIRING_TIMEOUT', previous_ssid: 'HomeNet',
    detail: "the board did not complete an authenticated link on 'OfficeNet' in time (the board has not reported joining that network yet). Common causes: wrong password, a 5 GHz-only network, router client isolation, the laptop's firewall blocking the gateway port on that network, or a gateway certificate that does not name this laptop's address on that network. The board is back on 'HomeNet': authenticated, identity confirmed, telemetry fresh. Nothing was changed.",
    logs: LOGS, checks: { wireless_session: false }, recovery: ['The new network was not changed on the board. Check the Wi-Fi password, that the network is 2.4 GHz, and that this laptop gateway is reachable on it, then try again.'], created_at: 1762003000 },
  failed: { id: 'j3', kind: 'usb_provisioning', device_id: 'RIG-1', port: 'COM7', ssid: 'NewNet', state: 'FAILED', progress: 100, error_code: 'NVS_UNREADABLE', detail: 'the device NVS partition is damaged (NVS entry CRC mismatch); it was not modified.',
    logs: LOGS, checks: {}, recovery: ['Keep the board on USB with motor power disconnected.', 'Fix the reported problem, then run Configure & Connect again.'], created_at: 1762003000 },
};
const SCENARIOS = {
  'ready-wifi': { status: { ...STATUS, current_network: WIFI_NOW }, history: HISTORY, job: null, scan: true },
  'usb-progress': { status: STATUS, history: HISTORY, job: JOBS.progress, scan: false },
  'wireless-wait': { status: { ...STATUS, current_network: { ...CUR, connected: true, transport: 'usb', device_id: 'RIG-1', staging_supported: true, session_active: true, telemetry_fresh: true } }, history: HISTORY, job: JOBS.waiting, scan: true },
  'rolled-back': { status: { ...STATUS, current_network: WIFI_NOW }, history: HISTORY, job: JOBS.rolled, scan: true },
  'recovery': { status: { ...STATUS, available: false, recovery_required: { reason: 'an interrupted Wi-Fi configuration write left the board state unknown', job: 'x' }, gateway_cert_ok: false,
    gateway_cert_detail: 'the gateway certificate does not name this laptop address 192.168.9.9' }, history: HISTORY, job: JOBS.failed, scan: false },
};

// ---------------------------------------------------------------- helpers
async function mock(page, sc, record) {
  const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route('**/api/torqva/device/ports', (r) => json(r, { ports: [{ device: 'COM3', description: 'Bluetooth link' }, { device: 'COM7', description: 'USB-Enhanced-SERIAL CH343' }] }));
  await page.route('**/api/torqva/provisioning/**', async (route) => {
    const req = route.request(); const u = new globalThis.URL(req.url()); const p = u.pathname.replace('/api/torqva', '');
    if (record && req.method() === 'POST') record.push({ path: p, url: req.url(), body: req.postData() });
    if (p === '/provisioning/status') return json(route, sc.status);
    if (p === '/provisioning/history') return json(route, { jobs: sc.history });
    if (p === '/provisioning/scan') return sc.scan ? json(route, SCAN) : json(route, { detail: { code: 'NO_AUTHENTICATED_LINK', message: 'scanning needs the board connected with an authenticated session (USB or Wi-Fi); you can still type the network name by hand' } }, 409);
    if (p === '/provisioning/jobs' || p === '/provisioning/network-switch') return json(route, sc.job || JOBS.progress);
    if (p.startsWith('/provisioning/jobs/')) return json(route, sc.job || JOBS.progress);
    return json(route, {});
  });
}

async function openCard(page, hash = '#/firmware') {
  await page.goto(`${URL}${hash}`);
  await page.getByRole('tab', { name: 'Overview', exact: true }).waitFor({ timeout: 30000 });
  await page.getByRole('tab', { name: /^Device Management/ }).click();
  const card = page.getByTestId('wifi-provisioning');
  await card.waitFor({ timeout: 20000 });
  await page.waitForTimeout(500);
  return card;
}

// Everything below runs in the page.
const inPage = {
  layout: () => {
    const card = document.querySelector('[data-testid=wifi-provisioning]');
    const cr = card.getBoundingClientRect();
    const scrollers = '.wifi-log, .wifi-history, .tq-table-wrap, select, pre';
    const sticking = [];
    for (const el of card.querySelectorAll('*')) {
      if (el.closest(scrollers) || !el.getClientRects().length) continue;
      const r = el.getBoundingClientRect();
      if (r.width > 0 && (r.right > cr.right + 1 || r.left < cr.left - 1)) sticking.push(`${el.tagName.toLowerCase()}${el.className ? '.' + String(el.className).split(' ')[0] : ''} (${Math.round(r.right - cr.right)}px)`);
    }
    const unknownSteps = [...card.querySelectorAll('.tq-step')].filter((li) => !/\bis-(done|active|failed|pending|waiting|blocked|skipped)\b/.test(li.className)).length;      // a state the tracker cannot draw
    return { pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth, cardOverflow: card.scrollWidth - card.clientWidth, sticking: sticking.slice(0, 6), cardWidth: Math.round(cr.width), unknownSteps };
  },
  contrast: () => {
    const card = document.querySelector('[data-testid=wifi-provisioning]');
    const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(',').map((x) => parseFloat(x)); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
    const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    const bgOf = (el) => { let bg = { r: 255, g: 255, b: 255 }; const chain = []; for (let e = el; e; e = e.parentElement) chain.push(e);
      for (const e of chain.reverse()) { const c = parse(getComputedStyle(e).backgroundColor); if (c && c.a > 0) bg = { r: c.r * c.a + bg.r * (1 - c.a), g: c.g * c.a + bg.g * (1 - c.a), b: c.b * c.a + bg.b * (1 - c.a) }; } return bg; };
    const bad = []; let min = 99;
    for (const el of card.querySelectorAll('*')) {
      const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
      if (!own || !el.getClientRects().length || el.closest('option')) continue;
      const cs = getComputedStyle(el); const fg = parse(cs.color); if (!fg) continue;
      const bg = bgOf(el); const a = lum({ r: fg.r, g: fg.g, b: fg.b }); const b = lum(bg); const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      if (el.disabled || el.closest('button:disabled')) continue;                  // disabled controls are exempt (WCAG 1.4.3)
      min = Math.min(min, ratio);
      if (ratio < 4.5) bad.push(`${el.tagName.toLowerCase()} "${el.textContent.trim().slice(0, 30)}" ${ratio.toFixed(2)}`);
    }
    return { min: Number(min.toFixed(2)), bad: bad.slice(0, 6) };
  },
};

const results = []; const failures = [];
const note = (r) => { results.push(r); if (r.fail) failures.push(r); };

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });

async function newPage(width, height, theme, consoleLog) {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.addInitScript(([tok, th]) => { sessionStorage.setItem('torqva.token', tok); localStorage.setItem('torqva.theme', th); }, [TOKEN, theme]);
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') consoleLog.push(`${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => consoleLog.push(`pageerror: ${e.message}`));
  return page;
}

// ---------------------------------------------------------------- 1. layout, contrast and console across sizes x themes x states
for (const [name, sc] of Object.entries(SCENARIOS)) {
  for (const theme of THEMES) {
    for (const [width, height] of SIZES) {
      const consoleLog = [];
      const page = await newPage(width, height, theme, consoleLog);
      await mock(page, sc);
      const card = await openCard(page);
      if (sc.scan) { await page.getByTestId('wifi-prov-scan').click(); await page.getByTestId('wifi-prov-network').locator('option').nth(1).waitFor({ state: 'attached', timeout: 5000 }); }
      if (sc.job) {                                                    // show the job: fill the form and submit (USB) or change network (Wi-Fi)
        await page.getByTestId('wifi-prov-password').fill('password123');
        if (sc.scan) await page.getByTestId('wifi-prov-network').selectOption({ index: 2 }); else await page.getByTestId('wifi-prov-ssid').fill('NewNet');
        const onWifi = sc.status.current_network.transport === 'wifi';
        if (onWifi) { await page.getByTestId('wifi-prov-change').click(); }
        else { await page.getByTestId('wifi-prov-confirm').check(); await page.getByTestId('wifi-prov-start').click(); }
        await page.getByTestId('wifi-prov-progress').waitFor({ timeout: 5000 });
      }
      await page.waitForTimeout(300);
      const lay = await page.evaluate(inPage.layout); const con = await page.evaluate(inPage.contrast);
      const errors = consoleLog.filter((l) => !/favicon|WebSocket|ws:\/\/|Failed to load resource.*(ws|device)/i.test(l));
      const fail = lay.pageOverflow > 1 || lay.cardOverflow > 1 || lay.sticking.length > 0 || lay.unknownSteps > 0 || con.bad.length > 0 || errors.length > 0;
      note({ kind: 'layout', scenario: name, theme, width, height, ...lay, contrastMin: con.min, contrastBad: con.bad, console: errors, fail });
      await card.screenshot({ path: path.join(out, `${name}-${theme}-${width}x${height}.png`) });
      if (width === 1440) await page.screenshot({ path: path.join(out, `page-${name}-${theme}-1440x900.png`), fullPage: true });
      await page.close();
    }
  }
}

// ---------------------------------------------------------------- 2. interaction: keyboard, password toggle, password confined to the POST body
for (const theme of THEMES) {
  const consoleLog = []; const record = [];
  const page = await newPage(1440, 900, theme, consoleLog);
  await mock(page, SCENARIOS['ready-wifi'], record);
  const sc = { ...SCENARIOS['usb-progress'], scan: true, status: { ...STATUS, current_network: CUR } };      // board on USB path: Configure & Connect
  await page.unroute('**/api/torqva/provisioning/**'); await mock(page, sc, record);
  await openCard(page);
  const checks = {};
  await page.getByTestId('wifi-prov-scan').focus(); await page.keyboard.press('Enter');              // keyboard: activate Scan
  await page.getByTestId('wifi-prov-network').locator('option').nth(1).waitFor({ state: 'attached', timeout: 5000 });
  await page.getByTestId('wifi-prov-network').focus(); await page.keyboard.press('ArrowDown');             // keyboard: choose a network
  checks.chosenByKeyboard = (await page.getByTestId('wifi-prov-network').inputValue()) !== '';
  checks.networkDetails = (await page.getByTestId('wifi-prov-picked').innerText()).includes('dBm');
  const pw = page.getByTestId('wifi-prov-password');
  await pw.fill(SECRET);
  checks.hiddenByDefault = (await pw.getAttribute('type')) === 'password';
  await page.getByLabel('Show password').click(); checks.visibleAfterToggle = (await pw.getAttribute('type')) === 'text';
  await page.getByLabel('Hide password').click(); checks.hiddenAgain = (await pw.getAttribute('type')) === 'password';
  checks.startDisabledUntilConfirmed = await page.getByTestId('wifi-prov-start').isDisabled();
  await page.getByTestId('wifi-prov-confirm').focus(); await page.keyboard.press('Space');                // keyboard: tick the confirmation
  checks.startEnabledAfterConfirm = await page.getByTestId('wifi-prov-start').isEnabled();
  await page.getByTestId('wifi-prov-start').focus(); await page.keyboard.press('Enter');
  await page.getByTestId('wifi-prov-progress').waitFor({ timeout: 5000 });
  await page.waitForTimeout(300);
  const post = record.find((r) => r.path === '/provisioning/jobs');
  checks.passwordOnlyInPostBody = !!post && JSON.parse(post.body).password === SECRET && !record.some((r) => r.url.includes(SECRET));
  checks.fieldCleared = (await pw.inputValue()) === '';
  const html = await page.content();
  checks.notInDom = !html.includes(SECRET);
  const storage = await page.evaluate(() => JSON.stringify({ ...sessionStorage }) + JSON.stringify({ ...localStorage }));
  checks.notInStorage = !storage.includes(SECRET);
  checks.notInConsole = !consoleLog.some((l) => l.includes(SECRET));
  checks.progressShown = (await page.getByTestId('wifi-prov-steps').locator('li').count()) >= 8;
  const fail = Object.values(checks).some((v) => v !== true);
  note({ kind: 'interaction', theme, checks, fail });
  await page.getByTestId('wifi-provisioning').screenshot({ path: path.join(out, `interaction-${theme}-1440x900.png`) });
  await page.close();
}

// ---------------------------------------------------------------- 3. live backend (no mocks): the real endpoints render without errors
for (const theme of THEMES) {
  const consoleLog = [];
  const page = await newPage(1440, 900, theme, consoleLog);
  const card = await openCard(page);
  await page.waitForTimeout(800);
  const text = await card.innerText();
  const lay = await page.evaluate(inPage.layout); const con = await page.evaluate(inPage.contrast);
  const errors = consoleLog.filter((l) => !/favicon|WebSocket|ws:\/\/|Failed to load resource.*(ws|device)/i.test(l));
  const fail = !/Configure Wi-Fi/.test(text) || !/provisioning history/i.test(text) || lay.pageOverflow > 1 || lay.sticking.length > 0 || con.bad.length > 0 || errors.length > 0;
  note({ kind: 'live', theme, ...lay, contrastMin: con.min, contrastBad: con.bad, console: errors, headline: text.split('\n').slice(0, 14).join(' | '), fail });
  await card.screenshot({ path: path.join(out, `live-${theme}-1440x900.png`) });
  await page.close();
}

await browser.close();
fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(results, null, 2));
const layoutRows = results.filter((r) => r.kind === 'layout');
console.log(`layout: ${layoutRows.length} checks (${SIZES.length} sizes x ${THEMES.length} themes x ${Object.keys(SCENARIOS).length} states), ${layoutRows.filter((r) => r.fail).length} failing; ` +
  `min contrast ${Math.min(...results.filter((r) => r.contrastMin).map((r) => r.contrastMin))}`);
console.log(`interaction: ${results.filter((r) => r.kind === 'interaction').map((r) => `${r.theme}=${r.fail ? 'FAIL' : 'ok'}`).join(' ')}; live: ${results.filter((r) => r.kind === 'live').map((r) => `${r.theme}=${r.fail ? 'FAIL' : 'ok'}`).join(' ')}`);
if (failures.length) { console.log(JSON.stringify(failures.slice(0, 12), null, 2)); process.exitCode = 1; }
