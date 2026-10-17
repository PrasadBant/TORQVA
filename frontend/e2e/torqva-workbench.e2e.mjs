// Real-browser E2E for the analyst workflow: C1 investigation -> C4 multi-step test on a simulator copy -> C2 predictions for a custom target
// -> C3 gate + Safety Supervisor check -> confirmed request -> lifecycle; then the same pages in physical mode stay locked.
// Run against `npm run dev:sim` (automatic dev sign-in):  node e2e/torqva-workbench.e2e.mjs
import { chromium } from 'playwright-core';
import fs from 'fs';

const URL = process.env.TORQVA_URL || 'http://localhost:5173/';
const OUT = process.env.SHOTS_DIR || './e2e-shots'; fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.addInitScript(() => { try { localStorage.setItem('torqva.mode', 'SIMULATION'); } catch { /* storage unavailable */ } });
const res = []; const check = (n, ok, x = '') => res.push(`${ok ? 'PASS' : 'FAIL'}  ${n} ${x}`);
const errors = []; const devicePosts = []; let physWb = 0; let phys = false;
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(e.message));
page.on('request', (r) => {
  if (r.method() === 'POST' && /device\/commands/.test(r.url())) devicePosts.push(r.url());
  if (phys && /simulation\/workbench/.test(r.url())) physWb += 1;
});
const shot = (n) => page.screenshot({ path: `${OUT}/wb-${n}.png`, fullPage: true });
const api = (path) => page.evaluate((p) => fetch(`/api/torqva${p}`, { headers: { Authorization: 'Bearer ' + (sessionStorage.getItem('torqva.token') || '') } }).then((r) => r.json()), path);
const nav = async (name) => {
  const t = page.locator('[data-testid="nav-toggle"]');
  if (await t.isVisible() && (await t.getAttribute('aria-expanded')) !== 'true') await t.click();
  await page.click(`nav button:has-text("${name}")`); await page.waitForTimeout(500);
};
const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

await page.goto(URL);
await page.waitForSelector('[data-testid=sim-status-strip]', { timeout: 30000 });

// a faulty run that holds its action for a human decision
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

// C1
await nav('AI Diagnostics');
await page.waitForSelector('[data-testid^=hyp-]', { timeout: 15000 }).catch(() => {});
check('C1 shows the operating condition and the ranked hypotheses', /Anomaly|Consistent|Uncertain/.test(await page.textContent('[data-testid=c1-condition]')) && (await page.locator('[data-testid^=hyp-]').count()) >= 2);
check('C1 tiles carry SIM provenance', (await page.locator('[data-testid=c1-kpis] .tq-prov-sim').count()) === 5);
check('C1 offers no way to start a test from a hypothesis', (await page.locator('main button:has-text("Run")').count()) === 0);
await shot('c1');
await page.click('button:has-text("Configure in Diagnostic Tests")');
await page.waitForSelector('[data-testid=test-catalog]');
await page.waitForSelector('[data-testid=sequence] > li', { timeout: 10000 }).catch(() => {});
check('"Configure in Diagnostic Tests" opens C4 with a test pre-added', (await page.locator('[data-testid=sequence] > li').count()) === 1);

// C4: a two-step speed profile from the live setpoint, validated, then run on a copy
await page.click('[aria-label="Remove test 1"]');
await page.locator('.tq-cat-card').first().locator('button:has-text("Add to sequence")').click();
await page.click('button:has-text("Setpoint → 70 %")');
const rpmInputs = page.locator('[data-testid=profile-editor] input[type=number]');
await rpmInputs.nth(0).fill('5000');
check('an out-of-range step blocks the run with a reason', await page.isDisabled('[data-testid=run-sequence]') && /rpm must be/.test(await page.textContent('section[aria-labelledby=c-seq]')));
await rpmInputs.nth(0).fill('1800');
const before = await api('/status');
await page.click('[data-testid=run-sequence]');
await page.waitForSelector('[data-testid=run-assessment]', { timeout: 60000 });
const after = await api('/status');
check('the sequence ran on a copy: live simulation time and setpoint unchanged', before.t === after.t && before.device.setpoint_rpm === after.device.setpoint_rpm, `${before.t} -> ${after.t}`);
const rows = await page.locator('[data-testid=profile-table] tbody tr').allTextContents();
check('each profile step reports target and observed speed', rows.length === 2 && /1,800/.test(rows[0]) && /1,260/.test(rows[1]), rows.join(' | ').slice(0, 160));
check('the response chart is drawn from recorded windows', (await page.locator('section[aria-labelledby=c-run] .recharts-line').count()) >= 1);
check('the result separates ground truth from TORQVA\'s ranking', /Scenario ground truth/.test(await page.textContent('section[aria-labelledby=c-run]')) && /TORQVA ranking after the tests/.test(await page.textContent('section[aria-labelledby=c-run]')));
await shot('c4');

// C4 adaptive investigation on the simulator copy
const preAd = await api('/status');
check('C4 shows an evidence-sufficiency status', /SUFFICIENT EVIDENCE|MORE EVIDENCE REQUIRED|INVALID INPUT|TEST NOT SUPPORTED|INCONCLUSIVE/.test(await page.textContent('section[aria-labelledby=c-adaptive]')));
await page.click('[data-testid=run-adaptive]');
await page.waitForSelector('[data-testid=adaptive-result]', { timeout: 60000 });
const postAd = await api('/status');
check('the adaptive investigation ends with a stated status and reason, and the live run did not move', /SUFFICIENT EVIDENCE|MORE EVIDENCE REQUIRED|INVALID INPUT|TEST NOT SUPPORTED|INCONCLUSIVE/.test(await page.textContent('[data-testid=adaptive-result]')) && preAd.t === postAd.t);
await page.waitForFunction(() => document.querySelector('[data-testid=trace-test]')?.dataset.reached === 'yes', null, { timeout: 10000 }).catch(() => {});
check('the trace on C4 records the diagnostic runs', (await page.getAttribute('[data-testid=trace-test]', 'data-reached')) === 'yes');

// C2: a custom target triggers a fresh prediction for that target
await nav('Predictions');
await page.waitForSelector('[data-testid=cand-A] .recharts-wrapper', { timeout: 20000 });
await page.fill('[data-testid=target-A] input', '1400');
const sawPending = await page.waitForSelector('[data-testid=pending-A]', { timeout: 3000 }).then(() => true).catch(() => false);
await page.waitForSelector('[data-testid=cand-A] .recharts-wrapper', { timeout: 20000 });
check('changing a target marks it pending, then shows a prediction for the new target', sawPending && /1,400/.test(await page.textContent('[data-testid=cmp-table]')));
// C2 counterfactual lab: identical start, separate branches, reproducible
const preCf = await api('/status');
await page.click('[data-testid=run-cf]');
await page.waitForSelector('[data-testid=cf-result]', { timeout: 60000 });
const postCf = await api('/status');
check('the counterfactual lab compares branches without changing the live run', (await page.locator('[data-testid=cf-result] .tq-cand').count()) >= 2 && preCf.t === postCf.t && preCf.device.setpoint_rpm === postCf.device.setpoint_rpm);
check('the branch comparison is charted from observed branch windows', (await page.locator('[data-testid=cf-chart] .recharts-line').count()) >= 2);
await page.click('[data-testid=cf-rerun]');
check('re-running the experiment reproduces every branch', await page.waitForSelector('text=reproduced: every branch identical', { timeout: 20000 }).then(() => true).catch(() => false));
const selBtn = page.locator('[data-testid=cand-A] button:has-text("Select Action A")');
check('the select control names the actual target', /target 1,400 rpm/.test(await selBtn.textContent()));
await selBtn.click();
check('selecting records a proposal and sends nothing', /nothing has been sent/.test(await page.textContent('[data-testid=selection]')) && devicePosts.length === 0);
await shot('c2');
await page.click('button:has-text("Review on Interventions")');

// C3: gate + Supervisor check, then a confirmed request through the pipeline's held action
await page.waitForSelector('[data-testid=dcheck]', { timeout: 15000 });
const dc = await page.textContent('[data-testid=dcheck]');
check('C3 shows the gate verdict and the Supervisor verdict for the selected target', /ACT|REQUEST MORE DATA|RUN DIAGNOSTIC TEST|ESCALATE|SAFE STOP/.test(dc) && /ALLOW|DEFER|REJECT/.test(dc), dc.slice(0, 120));
const allowed = await page.isEnabled('[data-testid=req-start]');
if (allowed) {
  await page.click('[data-testid=req-start]');
  await page.click('[data-testid=req-confirm]');
  await page.waitForSelector('[data-testid=req-result]', { timeout: 15000 });
  const cmds = await api('/commands');
  const red = cmds.filter((c) => c.action === 'REDUCE_SPEED');
  check('the selected target reached the simulated device through the supervised path', red.length === 1 && red[0].params.rpm === 1400, JSON.stringify(red[0]?.params));
  await page.waitForFunction(() => document.querySelector('[data-testid=life-requested]')?.dataset.state === 'done', null, { timeout: 10000 }).catch(() => {});
  check('the lifecycle shows the request but not a recovery', (await page.getAttribute('[data-testid=life-requested]', 'data-state')) === 'done' && (await page.getAttribute('[data-testid=life-verified]', 'data-state')) !== 'done');
  check('an analyst-approved decision is shown as such', /analyst's selection/.test(await page.textContent('[data-testid=life-decision]')));
  await page.waitForSelector('[data-testid=receipt]', { timeout: 15000 }).catch(() => {});
  const rc = await page.textContent('[data-testid=receipt]').catch(() => '');
  check('the request has a decision receipt with its evidence and a lifecycle from records', /ACCEPTED/.test(rc) && /snapshot digest matches/.test(rc) && /Gate/.test(rc) && !/RECOVERED/.test(await page.textContent('[data-testid=receipt-lifecycle]')));
  const errsBefore = errors.length;
  const refused = await page.evaluate(() => fetch('/api/torqva/simulation/workbench/request', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + sessionStorage.getItem('torqva.token') },
    body: JSON.stringify({ action: 'REDUCE_SPEED', target_rpm: 1300, basis: { t: 0, setpoint_rpm: 1800 } }) }).then(async (r) => ({ code: r.status, detail: (await r.json()).detail })));
  check('a refused request is refused by the backend and leaves a receipt', refused.code === 409 && /decision receipt R-/.test(refused.detail), refused.detail);
  await page.waitForTimeout(300);
  for (let i = errors.length - 1; i >= errsBefore; i--) if (/status of 409/.test(errors[i])) { errors.splice(i, 1); break; }   // only the deliberate refusal above
  await page.waitForFunction(() => /REFUSED/.test(document.querySelector('[data-testid=receipt-list]')?.textContent || ''), null, { timeout: 15000 }).catch(() => {});
  check('the refusal is listed as visibly as the acceptance', /REFUSED/.test(await page.textContent('[data-testid=receipt-list]')));
  check('the trace on C3 reaches the safety decision', (await page.getAttribute('[data-testid=trace-decision]', 'data-reached')) === 'yes');
} else {
  check('when the check refuses, the reason is shown and nothing is sent', /Why it cannot be requested now/.test(await page.textContent('main')) && (await api('/commands')).every((c) => c.action !== 'REDUCE_SPEED'));
}
await shot('c3');

// responsive
for (const w of [1024, 768, 390]) {
  await page.setViewportSize({ width: w, height: 900 });
  for (const n of ['AI Diagnostics', 'Diagnostic Tests', 'Predictions', 'Interventions']) {
    await nav(n); await page.waitForTimeout(300);
    check(`no horizontal overflow at ${w}px: ${n}`, (await overflow()) <= 1, `(${await overflow()}px)`);
  }
}
await page.setViewportSize({ width: 1440, height: 900 });

// physical mode: same pages, locked, no simulator workbench requests
phys = true;
await page.click('button:has-text("Physical mode")');
await page.waitForSelector('[data-testid="phys-banner"]', { timeout: 15000 });
await nav('Diagnostic Tests');
check('physical C4 lists the tests as locked with the device blockers', await page.isVisible('[data-testid=phys-test-catalog]') && await page.isVisible('[data-testid=phys-C4-blockers]') && (await page.locator('[data-testid=run-sequence]').count()) === 0);
await nav('Predictions');
check('physical C2 shows no simulated candidates', (await page.locator('[data-testid=candidates]').count()) === 0 && await page.isVisible('[data-testid=phys-C2-blockers]'));
await nav('Interventions');
check('physical C3 has no request control', (await page.locator('[data-testid=req-start]').count()) === 0);
await page.waitForTimeout(2500);
check('physical mode never calls the simulator workbench', physWb === 0, String(physWb));
await shot('phys-c4');
check('no physical device command was sent', devicePosts.length === 0, String(devicePosts.length));
check('no console errors', errors.length === 0, errors.slice(0, 2).join(' | '));

await browser.close();
console.log(res.join('\n'));
process.exit(res.some((r) => r.startsWith('FAIL')) ? 1 : 0);
