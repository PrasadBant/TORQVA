// Real-browser E2E for the Phase 10 C2/C4 panels (opt-in; see e2e/README.md).
//   TORQVA_TOKEN=<operator token> node e2e/torqva-c2c4.e2e.mjs
// Needs the backend on :8000 (ideally started with TORQVA_C2_VARIANT=noise_aware), the frontend dev server on 127.0.0.1:5173, and Google Chrome.
import { chromium } from 'playwright-core';
import fs from 'fs';
const OP = process.env.TORQVA_TOKEN;
if (!OP) { console.error('Set TORQVA_TOKEN (operator)'); process.exit(2); }
const API = 'http://127.0.0.1:8000/api/torqva';
const OUT = process.env.SHOTS_DIR || './e2e-shots'; fs.mkdirSync(OUT, { recursive: true });
const api = async (path, method = 'GET', body) => {
  const r = await fetch(API + path, { method, headers: { Authorization: `Bearer ${OP}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) };
};
const res = []; const check = (n, ok, x = '') => res.push(`${ok ? 'PASS' : 'FAIL'}  ${n} ${x}`);

// ---- drive the simulation through the API (deterministic), human approval required
await api('/simulation/start', 'POST', { seed: 1, setpoint_rpm: 1800, fault: 'imbalance', severity: 0.6, clears_below_rpm: 1500, inject_after_s: 10, require_human_approval: true });
let st;
for (let i = 0; i < 40; i++) { await api('/simulation/step', 'POST', { seconds: 10 }); st = (await api('/status')).json; if (st.pending_approval) break; }
check('an action is awaiting approval', !!st.pending_approval, st.pending_approval?.action);
const variant = st.models?.c2_variant;

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const consoleMsgs = [], bad = [];
page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) consoleMsgs.push(`${m.type()}: ${m.text()}`); });
page.on('pageerror', (e) => consoleMsgs.push('pageerror: ' + e.message));
page.on('response', (r) => { if (r.status() >= 400) bad.push(`${r.status()} ${r.request().method()} ${r.url().replace(API, '')}`); });
const shot = (n) => page.screenshot({ path: `${OUT}/${n}.png`, fullPage: true });
const section = (id) => `section[aria-labelledby="${id}"]`;

await page.goto('http://127.0.0.1:5173/#/torqva');
await page.evaluate(() => sessionStorage.clear()); await page.reload();
await page.fill('input[type=password]', OP);
await page.click('button:has-text("Sign in")');
await page.waitForSelector('nav button:has-text("Predictions")');
await page.click('nav button:has-text("Predictions")');
await page.waitForSelector(section('c-pred'));
const predTxt = await page.textContent(section('c-pred'));
check('prediction table shows a status for every action', (predTxt.match(/supported/g) || []).length >= 3, `variant=${variant}`);
check('predictions labelled PRED and unvalidated', (await page.textContent('main')).includes('Intervention Outcome Prediction (unvalidated)'));
check('predicted-vs-observed card present with provenance note', (await page.textContent(section('c-predcheck'))).includes('not a recovery verdict'));
check('no comparison yet (action not executed)', (await page.textContent(section('c-predcheck'))).includes('No comparison yet'));
await page.click('nav button:has-text("Diagnostic Tests")');
await page.waitForSelector(section('c-tests'));
check('diagnostic-tests card present', (await page.textContent(section('c-tests'))).includes('Diagnostic tests (C4)'));
await page.waitForSelector('text=NOT adopted', { timeout: 10000 }).catch(() => {});
check('C4 calibration labelled not adopted', (await page.textContent('main')).includes('NOT adopted'));
await shot('40-c2c4-decisions-before');

// ---- approve through the UI, let the incident run to its end
await page.click('nav button:has-text("Interventions")');
await page.click('button:has-text("Approve")');
await page.waitForTimeout(600);
for (let i = 0; i < 60; i++) { await api('/simulation/step', 'POST', { seconds: 20 }); st = (await api('/status')).json; if (st.closed_incidents >= 1) break; }
check('incident closed after the approved action', st.closed_incidents >= 1);
const checks = (await api('/prediction-checks')).json;
check('server stored a prediction_check record', checks.length >= 1, `comparison=${checks[0]?.comparison}`);
await page.waitForTimeout(2500);                                                      // the UI polls
await page.click('nav button:has-text("Predictions")'); await page.waitForSelector(section('c-predcheck'));
const pcTxt = await page.textContent(section('c-predcheck'));
if (checks[0]?.comparison === 'available') {
  check('UI shows predicted vs observed rows', (await page.locator(`${section('c-predcheck')} table tbody tr`).count()) === checks[0].rows.length);
  check('UI row count and horizons match the server', pcTxt.includes(String(checks[0].horizons_reached[0])));
} else {
  check('UI explains that nothing was compared', pcTxt.includes('no comparison') || pcTxt.includes('No comparison'), pcTxt.slice(0, 80));
}
check('observation provenance is shown as simulated', (await page.locator(`${section('c-predcheck')} >> text=SIM`).count()) >= 1);
await shot('41-c2c4-decisions-after');

// ---- Evaluation view: run card (the latest-run endpoint must return an EvaluationRun) + Phase 10 validation card
await page.click('nav button:has-text("Evaluation")');
await page.waitForSelector(section('c-c2c4'));
const evTxt = await page.textContent('main');
check('evaluation run card shows an eval_sim_run file (not another study artifact)', /File eval_sim_run\d/.test(evTxt));
check('validation card has the hardware caveat', evTxt.includes('unvalidated against hardware'));
check('validation card has coverage tables for both variants', (await page.locator(`${section('c-c2c4')} table`).count()) === 3 && evTxt.includes('noise-aware C2 (opt-in)'));
check('Phase 11 card labels the conditional variant opt-in and C4 calibration as not adopted', evTxt.includes('Phase 11 (opt-in, not adopted by default)') && evTxt.includes('NOT adopted'));
check('limitations listed', evTxt.includes('No C2 variant is validated by Intervention Outcome Experiments on hardware'));
await shot('42-c2c4-evaluation');

// ---- responsive
for (const w of [1024, 768, 390]) {
  await page.setViewportSize({ width: w, height: 900 }); await page.waitForTimeout(250);
  const o = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(`no horizontal overflow at ${w}px (evaluation view)`, o <= 1, `(overflow ${o}px)`);
}
await page.setViewportSize({ width: 390, height: 900 });
await page.click('nav button:has-text("Predictions")'); await page.waitForTimeout(400);
check('no horizontal overflow at 390px (decisions view)', (await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 1);
await shot('43-c2c4-decisions-390');

const unexpected = bad.filter((b) => !/^(409|403|401) /.test(b));
check('no unexpected HTTP errors', unexpected.length === 0, unexpected.join(' | '));
const ce = consoleMsgs.filter((m) => !/Failed to load resource/.test(m));
check('no console errors', ce.length === 0, ce.join(' | ').slice(0, 300));
console.log(res.join('\n'));
await browser.close();
process.exit(res.some((r) => r.startsWith('FAIL')) ? 1 : 0);
