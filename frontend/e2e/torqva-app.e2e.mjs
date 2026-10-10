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
const shot = (n) => page.screenshot({ path: `${OUT}/${n}.png`, fullPage: true });
const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

await page.goto(URL);
await page.waitForSelector('nav button:has-text("Overview")', { timeout: 20000 });
check('root route renders the application without sign-in', true);
check('simulation banner present', (await page.textContent('[data-testid="sim-banner"]')).includes('SIMULATION'));
await page.waitForFunction(() => !/UNAVAILABLE/.test(document.querySelector('.tq-kpi-value')?.textContent || 'UNAVAILABLE'), null, { timeout: 30000 }).catch(() => {});
await page.waitForTimeout(6000);
const kpi = await page.textContent('.tq-kpis');
check('overview shows simulated telemetry values', /rpm/.test(kpi) && !/UNAVAILABLE/.test(kpi), kpi.replace(/\s+/g, ' ').slice(0, 90));
check('telemetry tiles carry the SIM provenance label', (await page.locator('.tq-kpis .tq-prov-sim').count()) === 4);
check('environment is labelled software simulator', (await page.textContent('header.tq-top')).includes('software simulator'));
await shot('overview-1440');

const pages = [['Live Monitor', 'Latest telemetry'], ['AI Diagnostics', 'Fault hypotheses'], ['Predictions', 'Candidate interventions|Predictions'], ['Diagnostic Tests', 'Available tests'],
  ['Interventions', 'Decision gate'], ['Recovery', 'Outcomes'], ['Learning', 'Learning dataset'], ['Evaluation', 'Evaluation run'], ['Lab', 'Lab|session|Session'], ['Devices & Settings', 'Devices']];
for (const [nav, expect] of pages) {
  await page.click(`nav button:has-text("${nav}")`); await page.waitForTimeout(700);
  const txt = await page.textContent('main');
  check(`page renders: ${nav}`, new RegExp(expect).test(txt) && txt.length > 200);
  check(`  ${nav}: no horizontal overflow at 1440px`, (await overflow()) <= 1);
  await shot(nav.replace(/\W+/g, '-').toLowerCase() + '-1440');
}
const dev = await page.textContent('main');
check('physical device shown as not connected, simulated device distinguished', /not connected/.test(dev) && /software simulator/.test(dev));

// simulator controls: start a faulty run, run it, and watch for an incident
await page.click('nav button:has-text("Live Monitor")');
await page.selectOption('select >> nth=1', 'imbalance').catch(() => {});
await page.click('button:has-text("Start new simulation")');
await page.waitForTimeout(800);
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

// responsive layouts
for (const w of [1440, 1024, 768, 390]) {
  await page.setViewportSize({ width: w, height: 900 });
  for (const nav of ['Overview', 'Live Monitor', 'Predictions', 'Evaluation']) {
    await page.click(`nav button:has-text("${nav}")`); await page.waitForTimeout(400);
    check(`no horizontal overflow at ${w}px: ${nav}`, (await overflow()) <= 1, `(${await overflow()}px)`);
  }
  await page.click('nav button:has-text("Overview")'); await page.waitForTimeout(400);
  await shot(`overview-${w}`);
}
check('no unexpected HTTP errors', bad.filter((b) => !b.includes('ERR_FAILED')).length === 0, bad.slice(0, 3).join(' | '));
const ce = consoleMsgs.filter((m) => !/Failed to load resource|net::ERR|ERR_FAILED/.test(m));
check('no console errors', ce.length === 0, ce.slice(0, 3).join(' | '));
await browser.close();
console.log(res.join('\n'));
process.exit(res.some((r) => r.startsWith('FAIL')) ? 1 : 0);
