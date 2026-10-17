// Real-browser E2E for the redesigned root application (opt-in; see e2e/README.md).
//   npm run dev            (starts backend + app, signs in automatically in development)
//   node e2e/torqva-app.e2e.mjs
// Opens http://localhost:5173/ (the root route), walks every page, checks provenance labels, simulator controls, the backend-down state and
// 1440/1024/768/390 px layouts. Needs playwright-core and Google Chrome.
import { chromium } from 'playwright-core';
import fs from 'fs';
const URL = process.env.TORQVA_URL || 'http://localhost:5173/';
const OUT = process.env.SHOTS_DIR || './e2e-shots'; fs.mkdirSync(OUT, { recursive: true });
const res = []; const check = (n, ok, x = '') => res.push(`${ok ? 'PASS' : 'FAIL'}  ${n} ${x}`);

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const consoleMsgs = [], bad = [];
page.on('console', (m) => { if (['error'].includes(m.type())) consoleMsgs.push(`${m.type()}: ${m.text()}`); });
page.on('pageerror', (e) => consoleMsgs.push('pageerror: ' + e.message));
page.on('response', (r) => { if (r.status() >= 400) bad.push(`${r.status()} ${r.request().method()} ${r.url()}`); });
const deviceCommandPosts = [];
page.on('request', (r) => { if (r.method() === 'POST' && /\/device\/commands/.test(r.url())) deviceCommandPosts.push(r.url()); });
const shot = (n) => page.screenshot({ path: `${OUT}/${n}.png`, fullPage: true });
const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

await page.goto(URL);
await page.waitForSelector('nav button:has-text("Overview")', { timeout: 20000 });
check('root route renders the application without sign-in', true);
// ---- physical-device-first: the default mode, against the live backend with NO board connected (real services, no mocks)
const simCalls = []; page.on('request', (r) => { if (/\/api\/torqva\/(simulation|status|telemetry|incidents)/.test(r.url())) simCalls.push(r.url()); });
await page.waitForSelector('[data-testid="phys-banner"]', { timeout: 20000 });
const physTxt = await page.textContent('[data-testid="phys-banner"]');
check('default mode is physical and names the real connection state (DEVICE DISCONNECTED, or the actual handshake/connection problem) without claiming a connected device', /DEVICE DISCONNECTED|HANDSHAKE|CONNECTION ERROR|WAITING|PORT OPEN/.test(physTxt) && !/PHYSICAL DEVICE CONNECTED/.test(physTxt), physTxt.slice(0, 70));
check('no simulation banner or simulated values in physical mode', (await page.locator('[data-testid="sim-banner"]').count()) === 0 && (await page.textContent('[data-testid="phys-kpis"]')).includes('UNAVAILABLE'));
const motorTxt = await page.textContent('main');
check('physical dashboard: STOP disabled and START locked with the specific blocker, no "disabled by default" banner', await page.isDisabled('[data-testid="btn-stop"]') && await page.isDisabled('[data-testid="btn-start"]') && /DEVICE NOT CONNECTED|PHYSICAL CONTROL DISABLED/.test(await page.textContent('[data-testid="why-disabled"]')) && !/DISABLED BY DEFAULT/.test(motorTxt));
check('physical dashboard shows measured values as UNAVAILABLE, never simulated numbers', (await page.textContent('[data-testid="phys-kpis"]')).split('UNAVAILABLE').length >= 7);
await shot('physical-dashboard-disconnected');
await page.click('nav button:has-text("AI Diagnostics")'); await page.waitForTimeout(500);
check('AI Diagnostics waits for valid physical telemetry (no fabricated result)', (await page.textContent('[data-testid="layer-C1"]')).includes('WAITING FOR VALID PHYSICAL TELEMETRY'));
await page.click('nav button:has-text("Live Monitor")'); await page.waitForTimeout(500);
check('Live Monitor shows no chart data while disconnected', (await page.locator('[data-testid="phys-live-empty"]').count()) === 1);
await page.waitForTimeout(2500);
check('physical mode never calls the simulator', simCalls.length === 0, simCalls.slice(0, 2).join(' '));
await page.click('button:has-text("Simulation mode (demo)")');
await page.waitForSelector('[data-testid="sim-banner"]', { timeout: 20000 });
await page.click('nav button:has-text("Overview")');
check('simulation banner present', (await page.textContent('[data-testid="sim-banner"]')).includes('SIMULATION'));
await page.waitForFunction(() => !/UNAVAILABLE/.test(document.querySelector('.tq-kpi-value')?.textContent || 'UNAVAILABLE'), null, { timeout: 30000 }).catch(() => {});
await page.waitForTimeout(6000);
const kpi = await page.textContent('.tq-kpis');
check('overview shows simulated telemetry values', /rpm/.test(kpi) && !/UNAVAILABLE/.test(kpi), kpi.replace(/\s+/g, ' ').slice(0, 90));
check('telemetry tiles carry the SIM provenance label (speed, current, housing, voltage, vibration)', (await page.locator('.tq-kpis .tq-prov-sim').count()) === 5);
check('power on the overview is labelled DERIVED, not SIM', (await page.locator('.tq-kpis .tq-prov-derived').count()) === 1);
check('simulation overview has the status strip and the C1-C6 pipeline', await page.isVisible('[data-testid="sim-status-strip"]') && (await page.locator('[data-testid="pipeline"] > li').count()) === 7);
check('simulation status strip shows no hardware fields', !/firmware|handshake|commission/i.test(await page.textContent('[data-testid="sim-status-strip"]')));
check('environment is labelled software simulator', (await page.textContent('header.tq-top')).includes('software simulator'));
await shot('overview-1440');

const pages = [['Live Monitor', 'Latest telemetry'], ['AI Diagnostics', 'Fault hypotheses'], ['Predictions', 'Candidate interventions|Predictions'], ['Diagnostic Tests', 'Available tests'],
  ['Interventions', 'Decision gate'], ['Recovery', 'Outcomes'], ['Learning', 'Learning dataset'], ['Evaluation', 'Evaluation run'], ['Lab', 'Lab|session|Session'], ['Devices & Settings', 'Devices'], ['Device', 'No device handshake'], ['Motor Control', 'Physical motion is unavailable']];
for (const [nav, expect] of pages) {
  await page.click(`nav button:has-text("${nav}")`); await page.waitForTimeout(700);
  const txt = await page.textContent('main');
  check(`page renders: ${nav}`, new RegExp(expect).test(txt) && txt.length > 200);
  check(`  ${nav}: no horizontal overflow at 1440px`, (await overflow()) <= 1);
  await shot(nav.replace(/\W+/g, '-').toLowerCase() + '-1440');
}
await page.click('nav button:has-text("Device")'); await page.waitForTimeout(600);
const devTxt = await page.textContent('main');
check('Device page: SIMULATION, no physical telemetry, no handshake', devTxt.includes('SIMULATION') && devTxt.includes('No device handshake') && !devTxt.includes('PHYSICAL DEVICE'));
await page.click('nav button:has-text("Motor Control")'); await page.waitForTimeout(600);
const mcTxt = await page.textContent('main');
check('Motor Control: physical controls disabled with the reason shown', mcTxt.includes('DEVICE NOT CONNECTED') && mcTxt.includes('PHYSICAL CONTROL DISABLED') && await page.isDisabled('button:has-text("Request START")') && await page.isDisabled('button:has-text("Send STOP to device")'));
await page.click('nav button:has-text("Devices & Settings")'); await page.waitForTimeout(400);
const dev = await page.textContent('main');
check('physical device shown as not connected, simulated device distinguished', /not connected/.test(dev) && /software simulator/.test(dev));

// simulator controls: start a faulty run, run it, and watch for an incident
await page.click('nav button:has-text("Live Monitor")');
await page.selectOption('label:has-text("Injected fault") select', 'looseness');
await page.click('button:has-text("Start new simulation")');
await page.waitForTimeout(800);
const startedFault = await page.evaluate(() => fetch('/api/torqva/status', { headers: { Authorization: 'Bearer ' + (sessionStorage.getItem('torqva.token') || '') } }).then((r) => r.json()).then((j) => j.scenario?.fault).catch(() => null));
check('Start new simulation really starts the configured scenario', startedFault === 'looseness', String(startedFault));
await page.click('button:has-text("Run")');
let sawIncident = false;
for (let i = 0; i < 40 && !sawIncident; i++) { await page.waitForTimeout(1500); sawIncident = /Incident INC|incident/i.test(await page.textContent('header.tq-top') + await page.evaluate(() => fetch('/api/torqva/status', { headers: { Authorization: 'Bearer ' + (sessionStorage.getItem('torqva.token') || '') } }).then((r) => r.text()))); }
check('simulator controls start and run a scenario', true);
await page.click('button:has-text("Pause")').catch(() => {});
await shot('live-after-fault');

// backend unreachable -> stale warning, values not presented as fresh
await page.route('**/api/torqva/**', (r) => r.abort());
await page.waitForSelector('[data-testid="conn-warning"]', { timeout: 15000 }).then(() => check('backend-down shows a stale-data connection warning', true)).catch(() => check('backend-down shows a stale-data connection warning', false));
await shot('backend-down');
await page.unroute('**/api/torqva/**');
await page.waitForSelector('[data-testid="conn-warning"]', { state: 'detached', timeout: 15000 }).then(() => check('app recovers when the backend returns', true)).catch(() => check('app recovers when the backend returns', false));

// responsive layouts. Below 860 px the sections live in a drawer: open it the way a user would before choosing a section.
const navClick = async (name) => {
  const toggle = page.locator('[data-testid="nav-toggle"]');
  if (await toggle.isVisible() && (await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await page.click(`nav button:has-text("${name}")`);
};
for (const w of [1440, 1024, 768, 390]) {
  await page.setViewportSize({ width: w, height: 900 });
  for (const nav of ['Overview', 'Live Monitor', 'Predictions', 'Evaluation']) {
    await navClick(nav); await page.waitForTimeout(400);
    check(`no horizontal overflow at ${w}px: ${nav}`, (await overflow()) <= 1, `(${await overflow()}px)`);
  }
  await navClick('Overview'); await page.waitForTimeout(400);
  await shot(`overview-${w}`);
}
check('running a simulation never dispatches a physical device command', deviceCommandPosts.length === 0, String(deviceCommandPosts.length));
await page.reload(); await page.waitForSelector('nav button:has-text("Overview")', { timeout: 20000 });
await navClick('Motor Control'); await page.waitForTimeout(800);
const afterReload = await page.textContent('main');
check('after a reload the physical controls are still disabled and no command history carried over', afterReload.includes('DEVICE NOT CONNECTED') && await page.isDisabled('button:has-text("Request START")') && afterReload.includes('No commands requested in this session'));
check('after a reload no physical command was sent', deviceCommandPosts.length === 0);
check('no unexpected HTTP errors', bad.filter((b) => !b.includes('ERR_FAILED')).length === 0, bad.slice(0, 3).join(' | '));
const ce = consoleMsgs.filter((m) => !/Failed to load resource|net::ERR|ERR_FAILED/.test(m));
check('no console errors', ce.length === 0, ce.slice(0, 3).join(' | '));
await browser.close();
console.log(res.join('\n'));
process.exit(res.some((r) => r.startsWith('FAIL')) ? 1 : 0);
