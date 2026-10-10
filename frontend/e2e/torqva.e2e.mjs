// Real-browser E2E for the TORQVA workspace. NOT part of `npm test` (needs a browser + running servers).
// Setup (not in package.json on purpose): npm i --no-save playwright-core
// Run:   TORQVA_TOKEN=<admin token> node e2e/torqva.e2e.mjs   (backend started with that token in TORQVA_TOKENS)
import { chromium } from 'playwright-core';
import fs from 'fs';
const TOKEN = process.env.TORQVA_TOKEN;
if (!TOKEN) { console.error('Set TORQVA_TOKEN (an admin token the backend was started with)'); process.exit(2); }
const BASE = process.env.BASE_URL || 'http://127.0.0.1:5173';
const OUT = process.env.SHOTS_DIR || './e2e-shots'; fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const consoleMsgs = [], bad = [];
page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) consoleMsgs.push(`${m.type()}: ${m.text()}`); });
page.on('pageerror', (e) => consoleMsgs.push('pageerror: ' + e.message));
page.on('response', (r) => { if (r.status() >= 400) bad.push(`${r.status()} ${r.request().method()} ${r.url()}`); });
const shot = (n) => page.screenshot({ path: `${OUT}/${n}.png`, fullPage: true });
const results = [];
const check = (name, ok, extra = '') => { results.push(`${ok ? 'PASS' : 'FAIL'}  ${name} ${extra}`); };

await page.goto(BASE + '/#/torqva');
await page.fill('input[type=password]', TOKEN);
await page.click('button:has-text("Sign in")');
await page.click('nav button:has-text("Live Monitor")');
await page.waitForSelector('text=Start new simulation');
check('banner visible on sign-in', await page.isVisible('[data-testid=sim-banner]'));
check('Run/STOP disabled before any simulation', await page.isDisabled('button:has-text("Run")') && await page.isDisabled('button[aria-label="Stop motor (coast)"]'));

// ---- scenario with human approval
await page.check('text=Require human approval');
await page.click('button:has-text("Start new simulation")');
await page.waitForSelector('button:has-text("Run"):not([disabled])', { timeout: 5000 }).catch(() => {});
check('Run enabled right after start (sim time 0)', await page.isEnabled('button:has-text("Run")'));
check('STOP enabled right after start', await page.isEnabled('button[aria-label="Stop motor (coast)"]'));
await page.click('button:has-text("Run")');
await page.click('nav button:has-text("Interventions")');
await page.waitForSelector('button:has-text("Approve"):not([disabled])', { timeout: 120000 });
await shot('10-awaiting-approval');
check('approval pending shown, REDUCE_SPEED not yet sent',
  !(await page.textContent('main')).includes('ACCEPTED'));
await page.click('button:has-text("Approve")');
await page.waitForSelector('text=accepted', { state: 'attached', timeout: 5000 }).catch(() => {});
await page.waitForFunction(() => document.querySelector('main').textContent.includes('yes (acknowledged by device)'), null, { timeout: 20000 });
check('after approve: device ACK shown with "took effect: yes"', true);
const idCell = await page.textContent('table >> nth=-1 >> tbody tr td');
check('command table shows an id (not history length)', /^\d+$/.test(idCell.trim()), `id=${idCell}`);
await shot('11-after-approve');
await page.click('nav button:has-text("Live")');
await page.waitForTimeout(1500);
await shot('12-live');
check('chart has legend', (await page.locator('.recharts-legend-item').count()) >= 3);

// wait for recovery
await page.click('nav button:has-text("Recovery")');
await page.waitForSelector('text=RECOVERED', { timeout: 150000 });
await shot('13-recovered');
check('Recovery shows RECOVERED with SIM badge', (await page.textContent('main')).includes('SIM'));
await page.click('button:has-text("Pause")').catch(() => {});

// ---- keyboard navigation
await page.focus('nav button:has-text("Overview")');
await page.keyboard.press('Tab'); await page.keyboard.press('Enter');
await page.waitForTimeout(500);
check('keyboard: Tab+Enter moves to next section', await page.getAttribute('nav button:has-text("Live")', 'aria-current') === 'page');
const ring = await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle);
check('focus is visible (outline)', ring !== 'none', `outline=${ring}`);

// ---- responsive
for (const w of [1024, 768, 390]) {
  await page.setViewportSize({ width: w, height: 900 });
  for (const v of ['Overview', 'Live Monitor', 'AI Diagnostics', 'Interventions', 'Recovery', 'Evaluation']) {
    await page.click(`nav button:has-text("${v}")`); await page.waitForTimeout(400);
    const ov = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(`no horizontal page overflow @${w} ${v}`, ov <= 1, `overflow=${ov}px`);
    if (w === 390 && ['Interventions', 'Live Monitor'].includes(v)) await shot(`14-w390-${v}`);
  }
}
await page.setViewportSize({ width: 1440, height: 900 });

// ---- error state: stop backend, UI must show an error and not crash
await page.click('nav button:has-text("Live Monitor")');
await page.route('**/api/torqva/**', (r) => r.abort());
await page.click('button[aria-label="Stop motor (coast)"]');
await page.waitForTimeout(2500);
await shot('15-backend-down');
const txt = await page.textContent('body');
check('backend down: UI shows an error (no blank page)', /Failed to fetch|HTTP|fetch|NetworkError|Unauthorized|error/i.test(txt) && txt.length > 200, '');
console.log(results.join('\n'));
console.log('console errors/warnings:', consoleMsgs.length ? [...new Set(consoleMsgs)].slice(0, 8) : 'none');
console.log('HTTP >=400:', bad.length ? [...new Set(bad)].slice(0, 8) : 'none');
await browser.close();
