// Real-browser E2E for the TORQVA Attestation tab (opt-in; see e2e/README.md).
//   TORQVA_TOKEN=<operator token> TORQVA_VIEWER_TOKEN=<viewer token> node e2e/torqva-attestation.e2e.mjs
// Needs: backend on :8000 with both tokens in TORQVA_TOKENS, frontend dev server on :5173, Google Chrome.
import { chromium } from 'playwright-core';
import fs from 'fs';
const OP = process.env.TORQVA_TOKEN, VW = process.env.TORQVA_VIEWER_TOKEN;
if (!OP || !VW) { console.error('Set TORQVA_TOKEN (operator) and TORQVA_VIEWER_TOKEN (viewer)'); process.exit(2); }
const API = 'http://127.0.0.1:8000/api/torqva';
const OUT = process.env.SHOTS_DIR || './e2e-shots'; fs.mkdirSync(OUT, { recursive: true });
const api = async (path, tok, method = 'GET', body) => {
  const r = await fetch(API + path, { method, headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) };
};
const res = []; const check = (n, ok, x = '') => res.push(`${ok ? 'PASS' : 'FAIL'}  ${n} ${x}`);

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.addInitScript(() => { try { localStorage.setItem('torqva.mode', 'SIMULATION'); } catch { /* storage unavailable */ } });   // the app opens in physical mode by default
const consoleMsgs = [], bad = [];
page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) consoleMsgs.push(`${m.type()}: ${m.text()}`); });
page.on('pageerror', (e) => consoleMsgs.push('pageerror: ' + e.message));
page.on('response', (r) => { if (r.status() >= 400) bad.push(`${r.status()} ${r.request().method()} ${r.url().replace(API, '')}`); });
const shot = (n) => page.screenshot({ path: `${OUT}/${n}.png`, fullPage: true });
const REASON = 'Reviewed the telemetry summary and checks; motor steady and quiet.';

async function login(tok) {
  await page.goto('http://127.0.0.1:5173/#/torqva');
  await page.evaluate(() => sessionStorage.clear());
  await page.reload();
  await page.fill('input[type=password]', tok);
  await page.click('button:has-text("Sign in")');
  await page.waitForSelector('nav button:has-text("Learning")');
  await page.click('nav button:has-text("Learning")');
  await page.waitForSelector('text=Candidate warm-up sessions');
}
const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

// ---- 1. a healthy warm-up -> eligible -> attested -> activated -> rolled back (operator) ----
await api('/simulation/start', OP, 'POST', { seed: 1, setpoint_rpm: 1650, inject_after_s: 3600 });
await api('/simulation/step', OP, 'POST', { seconds: 70 });
await login(OP);
check('operator-judgment notice visible', await page.locator('[data-testid=att-notice]').isVisible() && (await page.textContent('[data-testid=att-notice]')).includes('not proof that the motor is fault-free'));
check('simulation banner visible', await page.locator('[data-testid=sim-banner]').isVisible());
await shot('30-att-empty');
// supervised warm-up hold: reason required, status matches the server, then ended
const startHold = page.locator('button:has-text("Start hold")');
check('Start hold disabled without a reason', await startHold.isDisabled());
await page.fill('form[aria-label="Start supervised warm-up"] input[type=text]', 'Supervised warm-up before attestation.');
await startHold.click();
await page.waitForSelector('[data-testid=hold-status]:has-text("Hold active")');
check('hold active and matches the server', (await api('/attestation/warmup', OP)).json.active === true);
check('no regime-escalation alert for a normal warm-up', (await page.locator('[data-testid=regime-escalation]').count()) === 0);
await page.click('button:has-text("End hold")');
await page.waitForSelector('[data-testid=hold-status]:has-text("Hold ended")');
check('hold ended and matches the server', (await api('/attestation/warmup', OP)).json.active === false);
await page.click('button:has-text("Capture candidate from current simulation")');
await page.waitForSelector('text=Evidence — C-');
const cid = (await page.textContent('h3#c-att-detail')).replace('Evidence — ', '').trim();
check('captured candidate is ELIGIBLE', (await page.textContent('section[aria-labelledby="c-att-detail"]')).includes('ELIGIBLE'));
check('checks table shows pass labels', (await page.locator('table[aria-label], table >> caption:has-text("Eligibility checks")').count()) >= 1 && (await page.locator('text=pass').count()) >= 10);
await shot('31-att-eligible');
await page.click('button:has-text("Attest…")');
const confirm = page.locator('button:has-text("Confirm attest")');
check('confirm disabled without reason', await confirm.isDisabled());
await page.fill('textarea[aria-label="Decision reason"]', 'short');
check('confirm disabled with short reason', await confirm.isDisabled());
await page.fill('textarea[aria-label="Decision reason"]', REASON);
check('confirm disabled without acknowledgement', await confirm.isDisabled());
await page.check('text=I understand this is an operator judgment');
check('confirm enabled with reason + acknowledgement', await confirm.isEnabled());
await shot('32-att-confirm');
await confirm.click();
await page.waitForSelector('section[aria-labelledby="c-att-detail"] >> text=ATTESTED');
check('history shows the attestation with operator and reason', (await page.textContent('section[aria-labelledby="c-att-detail"]')).includes(REASON));
const V = (await api(`/attestation/candidates/${cid}`, OP)).json.reference_version;
check('reference version created and listed', V != null && (await page.textContent('section[aria-labelledby="c-att-refs"]')).includes(`v${V}`), `v${V}`);
await page.fill('input[aria-label="Reference change reason"]', 'Activate for this session after review.');
await page.click(`button[aria-label="Activate v${V}"]`);
await page.waitForSelector('section[aria-labelledby="c-att-refs"] >> text=active');
check('reference shown as active and matches the server', (await api('/attestation/references', OP)).json.active_version === V);
await shot('33-att-active');
await page.click('button:has-text("Roll back active reference")');
await page.waitForFunction(() => document.querySelector('section[aria-labelledby="c-att-refs"]')?.textContent.includes('none (shipped detector, unadapted)'));
check('rollback reflected and matches the server', (await api('/attestation/references', OP)).json.active_version === null);
check('attestation log lists the events', (await page.textContent('section[aria-labelledby="c-att-log"]')).includes('attested'));

// ---- 2. rejection by the operator ----
await api('/simulation/step', OP, 'POST', { seconds: 5 });
await page.click('button:has-text("Capture candidate from current simulation")');
await page.waitForFunction((c) => !document.querySelector('section[aria-labelledby="c-att-detail"]')?.textContent.includes(c), cid);
await page.click('button:has-text("Reject…")');
await page.fill('textarea[aria-label="Decision reason"]', 'Operator heard a rub during this warm-up.');
await page.click('button:has-text("Confirm reject")');
await page.waitForSelector('section[aria-labelledby="c-att-detail"] >> text=REJECTED');
check('operator rejection shows REJECTED with no attest path', (await page.locator('button:has-text("Attest…")').count()) === 0);
await shot('34-att-rejected');

// ---- 3. eligibility failure: a fault is present in the warm-up ----
await api('/simulation/start', OP, 'POST', { seed: 2, setpoint_rpm: 1650, fault: 'imbalance', severity: 0.6, inject_after_s: 0 });
await api('/simulation/step', OP, 'POST', { seconds: 70 });
await page.click('button:has-text("Capture candidate from current simulation")');
await page.waitForFunction(() => document.querySelector('section[aria-labelledby="c-att-detail"]')?.textContent.includes('REJECTED') && document.querySelector('section[aria-labelledby="c-att-detail"]')?.textContent.includes('Why not eligible'));
const failTxt = await page.textContent('section[aria-labelledby="c-att-detail"]');
check('failed checks explained in words', /fail/.test(failTxt) && /Why not eligible/.test(failTxt));
check('no Attest button on an ineligible candidate', (await page.locator('button:has-text("Attest…")').count()) === 0);
await shot('35-att-ineligible');

// ---- 4. stale decision: UI re-syncs with the server instead of keeping a stale view ----
await api('/simulation/start', OP, 'POST', { seed: 3, setpoint_rpm: 1650, inject_after_s: 3600 });
await api('/simulation/step', OP, 'POST', { seconds: 70 });
await page.click('button:has-text("Capture candidate from current simulation")');
await page.waitForFunction(() => document.querySelector('section[aria-labelledby="c-att-detail"]')?.textContent.includes('ELIGIBLE'));
const cid2 = (await page.textContent('h3#c-att-detail')).replace('Evidence — ', '').trim();
const rev = (await api(`/attestation/candidates/${cid2}`, OP)).json.rev;
await api(`/attestation/candidates/${cid2}/reject`, OP, 'POST', { reason: 'Rejected by a colleague meanwhile.', expected_rev: rev });
await page.click('button:has-text("Attest…")');
await page.fill('textarea[aria-label="Decision reason"]', REASON);
await page.check('text=I understand this is an operator judgment');
await page.click('button:has-text("Confirm attest")');
await page.waitForSelector('[role=alert]');
const alertTxt = await page.textContent('[role=alert]');
check('server refusal is shown (409)', /changed|only ELIGIBLE/.test(alertTxt), alertTxt.slice(0, 80));
await page.waitForFunction(() => document.querySelector('section[aria-labelledby="c-att-detail"]')?.textContent.includes('REJECTED'));
check('view re-synced to the server state (REJECTED)', true);
await shot('36-att-stale');

// ---- 5. responsive layouts ----
for (const w of [1024, 768, 390]) {
  await page.setViewportSize({ width: w, height: 900 });
  await page.waitForTimeout(250);
  const o = await overflow();
  check(`no horizontal overflow at ${w}px`, o <= 1, `(overflow ${o}px)`);
  await shot(`37-att-${w}`);
}
await page.setViewportSize({ width: 1440, height: 900 });

// ---- 6. viewer: read-only; server refuses mutations ----
await login(VW);
await page.click('button[aria-label="Open candidate ' + cid + '"]');
await page.waitForSelector('section[aria-labelledby="c-att-detail"]');
const priv = page.locator('button:has-text("Attest…"), button:has-text("Reject…"), button:has-text("Revoke…"), button:has-text("Start hold"), button:has-text("End hold"), button[aria-label^="Activate"], button:has-text("Roll back"), button:has-text("Capture candidate")');
let enabledPriv = 0; for (let i = 0; i < await priv.count(); i++) if (await priv.nth(i).isEnabled()) enabledPriv++;
check('viewer has no enabled privileged action (decision buttons are absent, others disabled)', enabledPriv === 0 && (await page.locator('button:has-text("Attest…"), button:has-text("Reject…"), button:has-text("Revoke…")').count()) === 0);
check('viewer capture button disabled', await page.locator('button:has-text("Capture candidate")').isDisabled());
check('viewer warning about role visible', (await page.textContent('section[aria-labelledby="c-att-notice"]')).includes('cannot capture, attest, reject, revoke or activate'));
const forbid = await api('/attestation/candidates', VW, 'POST');
check('server returns 403 to a viewer mutation', forbid.status === 403);
check('server returns 401 without a token', (await api('/attestation/candidates', 'wrong')).status === 401);
await shot('38-att-viewer');

const unexpected = bad.filter((b) => !/^(409|403|401) /.test(b));
check('no unexpected HTTP errors', unexpected.length === 0, unexpected.join(' | '));
const ce = consoleMsgs.filter((m) => !/Failed to load resource/.test(m));
check('no console errors', ce.length === 0, ce.join(' | ').slice(0, 300));
console.log(res.join('\n'));
console.log('HTTP >=400 seen (expected: deliberate 409/403/401):', bad.join(' | '));
await browser.close();
process.exit(res.some((r) => r.startsWith('FAIL')) ? 1 : 0);
