// Real-browser E2E for the unified Diagnostic Workflow: choose a test pattern, press Run Diagnostic Workflow once, receive the evidence-based
// diagnosis, RPM recommendation and action, authorize it, let the simulation advance and see C5 verify the outcome; then the same page in
// physical mode is blocked by the backend's real reasons and never touches the simulator or the device.
// Run against `npm run dev:sim` (automatic dev sign-in):  node e2e/torqva-workflow.e2e.mjs
import { chromium } from 'playwright-core';
import fs from 'fs';

const URL = process.env.TORQVA_URL || 'http://localhost:5173/';
const OUT = process.env.SHOTS_DIR || './e2e-shots'; fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.addInitScript(() => { try { localStorage.setItem('torqva.mode', 'SIMULATION'); } catch { /* storage unavailable */ } });
const res = []; const check = (n, ok, x = '') => res.push(`${ok ? 'PASS' : 'FAIL'}  ${n} ${x}`);
const errors = []; const devicePosts = []; const runPosts = []; let physSim = 0; let phys = false;
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(e.message));
page.on('request', (r) => {
  if (r.method() === 'POST' && /device\/commands/.test(r.url())) devicePosts.push(r.url());
  if (r.method() === 'POST' && /\/workflow\/runs$/.test(r.url())) runPosts.push(r.postDataJSON());
  if (phys && /\/simulation\//.test(r.url())) physSim += 1;
});
const shot = (n) => page.screenshot({ path: `${OUT}/wf-${n}.png`, fullPage: true });
const api = (path) => page.evaluate((p) => fetch(`/api/torqva${p}`, { headers: { Authorization: 'Bearer ' + (sessionStorage.getItem('torqva.token') || '') } }).then((r) => r.json()), path);
const nav = async (name) => {
  const t = page.locator('[data-testid="nav-toggle"]');
  if (await t.isVisible() && (await t.getAttribute('aria-expanded')) !== 'true') await t.click();
  await page.click(`nav button:has-text("${name}")`); await page.waitForTimeout(500);
};
const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const status = () => page.getAttribute('[data-testid=wf-record]', 'data-status');

await page.goto(URL);
await page.waitForSelector('[data-testid=sim-status-strip]', { timeout: 30000 });

// a faulty run whose pipeline holds its action for a human decision
for (let i = 0; i < 20; i++) {   // the new-scenario form is a disclosure in Scenario Studio; it folds once when the run state first loads
  await page.evaluate(() => document.querySelectorAll('[data-testid=scn-new]').forEach((x) => { x.open = true; }));
  await page.waitForTimeout(300);
  if (await page.evaluate(() => [...document.querySelectorAll('[data-testid=scn-new]')].every((x) => x.open))) break;
}
await page.selectOption('label:has-text("Injected fault") select', 'imbalance');
await page.fill('label:has-text("Inject fault at") input', '10');
await page.check('text=Require human approval');
await page.click('button:has-text("Start new simulation")');
await page.waitForTimeout(800);
await page.click('button:has-text("Run")');
let st = null;
for (let i = 0; i < 60; i++) { await page.waitForTimeout(1000); st = await api('/status'); if (st.pending_approval) break; }
await page.click('button:has-text("Pause")').catch(() => {});
check('the scenario reaches a held action', !!st?.pending_approval, st?.pending_approval?.action || st?.incident?.state);

// 1. configuration
await nav('Diagnostic Workflow');
await page.waitForSelector('[data-testid=wf-pattern-T3]', { timeout: 15000 });
check('five real test patterns are offered', (await page.locator('[data-testid^=wf-pattern-]:not([data-testid=wf-pattern-detail])').count()) === 5);
await page.click('[data-testid=wf-pattern-T3]');
check('the pattern detail shows its sequence and live prerequisites', await page.isVisible('[data-testid=wf-pattern-detail] table') && (await page.locator('[data-testid=wf-prereqs] li').count()) >= 6);
await shot('config');
const cmds0 = (await api('/commands')).length;

// 2. one click runs the whole analysis
const started = page.waitForResponse((r) => r.request().method() === 'POST' && /\/workflow\/runs$/.test(r.url()), { timeout: 20000 });
await page.dblclick('[data-testid=wf-run]');
const newId = (await (await started).json()).id;
await page.waitForFunction((i) => document.querySelector('#wf-exec')?.textContent.includes(i), newId, { timeout: 20000 });
check('one double-click sends exactly one workflow request', runPosts.length === 1, String(runPosts.length));
check('the request carries the pattern, policy and an idempotency key', runPosts[0]?.pattern === 'T3' && runPosts[0]?.execution_policy === 'require_confirmation' && /^wf-/.test(runPosts[0]?.idempotency_key || ''));
check('the workflow stops for authorization', (await status()) === 'AWAITING_AUTHORIZATION', await status());
const done = await page.locator('[data-testid=wf-stages] [data-state=completed]').count();
check('seven analytical stages completed without another click', done === 7, String(done));
check('an evidence-based diagnosis is shown', /Suspected|Anomaly|No anomaly/.test(await page.textContent('[data-testid=wf-diagnosis]')));
const target = await page.textContent('[data-testid=wf-target]');
check('a recommended target RPM is shown', /\d rpm/.test(target), target);
check('candidate actions are compared', (await page.locator('[data-testid=wf-candidates] tbody tr').count()) >= 3);
check('adjustments and the rationale are listed', (await page.locator('[data-testid=wf-adjustments] li').count()) >= 1 && (await page.locator('[data-testid=wf-why] li').count()) >= 1);
check('nothing was sent before authorization', (await api('/commands')).length === cmds0);
await shot('awaiting');

// 3. authorization carries the exact recommendation through C3
await page.click('[data-testid=wf-authorize]');
await page.waitForFunction(() => document.querySelector('[data-testid=wf-record]')?.dataset.status === 'VERIFYING_OUTCOME', null, { timeout: 15000 });
const cmds = await api('/commands');
const last = cmds[cmds.length - 1];
check('exactly one command was dispatched', cmds.length === cmds0 + 1, `${cmds0} → ${cmds.length}`);
check('the dispatched command is the recommended one', last && last.action === 'REDUCE_SPEED' && target.includes(Math.round(last.params.rpm).toLocaleString('en-US')), JSON.stringify(last?.params));
check('the authorize button is gone (no second send)', (await page.locator('[data-testid=wf-authorize]').count()) === 0);
const id = (await page.textContent('#wf-exec')).match(/WF-\d+/)?.[0];

// 4. C5 verification after simulated time passes
await nav('Live Monitor');
await page.getByRole('button', { name: 'Run', exact: true }).click();
let w = null;
for (let i = 0; i < 90; i++) { await page.waitForTimeout(1000); w = await api(`/workflow/runs/${id}`); if (w.status !== 'VERIFYING_OUTCOME') break; }
await page.getByRole('button', { name: 'Pause', exact: true }).click().catch(() => {});
check('C5 decides the outcome from fresh windows', w?.status === 'COMPLETED', `${id} ${w?.status} ${w?.outcome}`);
check('the run button was never pressed again', runPosts.length === 1, String(runPosts.length));
await nav('Diagnostic Workflow');
await page.waitForSelector('[data-testid=wf-record][data-status=COMPLETED]', { timeout: 15000 }).catch(() => {});
check('after navigating away and back the completed workflow is restored', (await status()) === 'COMPLETED');
check('the verification steps distinguish accepted, executed, improvement and recovery', (await page.locator('[data-testid=wf-verify-steps] li').count()) === 5);
check('the outcome shown is the backend outcome', (await page.textContent('[data-testid=wf-headline]')).includes(w?.headline || '§'));
await page.click('summary:has-text("Workflow events")');
check('the workflow history is inspectable', (await page.locator('[data-testid=wf-events] li').count()) >= 10);
await shot('completed');

// responsive
for (const vw of [768, 390]) {
  await page.setViewportSize({ width: vw, height: 900 });
  await page.waitForTimeout(300);
  check(`no horizontal overflow at ${vw}px`, (await overflow()) <= 1, `(${await overflow()}px)`);
}
await shot('390');
await page.setViewportSize({ width: 1440, height: 900 });

// physical mode: same layout, blocked by the backend's real reasons, no simulator or device traffic
phys = true;
await page.click('button:has-text("Physical mode")');
await page.waitForSelector('[data-testid="phys-banner"]', { timeout: 15000 });
await nav('Diagnostic Workflow');
await page.waitForSelector('[data-testid=wf-pattern-T1]', { timeout: 15000 });
check('physical mode shows the same configuration layout', await page.isVisible('#wf-config') && (await page.locator('[data-testid^=wf-pattern-]:not([data-testid=wf-pattern-detail])').count()) === 5);
check('physical patterns are not runnable', await page.isDisabled('[data-testid=wf-run]'));
check('the physical prerequisites name the firmware limitation', /no diagnostic-test command/.test(await page.textContent('[data-testid=wf-prereqs]')));
check('no simulation workflow is listed in physical mode', (await page.locator('[data-testid=wf-record]').count()) === 0);
await page.waitForTimeout(2500);
check('physical mode never calls the simulator', physSim === 0, String(physSim));
await shot('physical');
check('no physical device command was sent', devicePosts.length === 0, String(devicePosts.length));
check('no console errors', errors.length === 0, errors.slice(0, 2).join(' | '));

await browser.close();
console.log(res.join('\n'));
process.exit(res.some((r) => r.startsWith('FAIL')) ? 1 : 0);
