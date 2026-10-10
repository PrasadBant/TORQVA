// Real-browser E2E for the TORQVA Lab (opt-in; see e2e/README.md). TORQVA_TOKEN=<admin token> node e2e/torqva-lab.e2e.mjs
import { chromium } from 'playwright-core';
import fs from 'fs';
const TOKEN = process.env.TORQVA_TOKEN;
if (!TOKEN) { console.error('Set TORQVA_TOKEN'); process.exit(2); }
const OUT = process.env.SHOTS_DIR || './e2e-shots'; fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const consoleMsgs = [], bad = [];
page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) consoleMsgs.push(`${m.type()}: ${m.text()}`); });
page.on('pageerror', (e) => consoleMsgs.push('pageerror: ' + e.message));
page.on('response', (r) => { if (r.status() >= 400) bad.push(`${r.status()} ${r.request().method()} ${r.url()}`); });
const shot = (n) => page.screenshot({ path: `${OUT}/${n}.png`, fullPage: true });
const res = []; const check = (n, ok, x = '') => res.push(`${ok ? 'PASS' : 'FAIL'}  ${n} ${x}`);

await page.goto('http://127.0.0.1:5173/#/torqva');
await page.fill('input[type=password]', TOKEN);
await page.click('button:has-text("Sign in")');
await page.waitForSelector('text=Start new simulation');
await page.click('nav button:has-text("Lab")');
await page.waitForSelector('text=New recording session');
await page.waitForSelector('[data-testid=regime-desc]');
await shot('20-lab-empty');
// choose the hard confusable regime + looseness, blind
await page.selectOption('select >> nth=1', 'confusable_sensor');
check('regime description updates', (await page.textContent('[data-testid=regime-desc]')).includes('mimics looseness'));
await page.selectOption('select >> nth=2', 'looseness');
await page.check('text=Blind session');
await page.fill('input[aria-label="step 1 hold seconds"]', '90');
await page.click('button:has-text("Add step")');
check('profile step added', (await page.locator('input[aria-label^="step"]').count()) === 4);
await page.fill('label:has-text("Mass g") input', '12');
await page.click('button:has-text("Create session")');
await page.waitForSelector('text=Pre-run checklist');
const runBtn = page.locator('button:has-text("Run session")');
check('Run disabled before checklist', await runBtn.isDisabled());
check('fault hidden in blind session', (await page.textContent('main')).includes('hidden (blind)'));
const boxes = page.locator('ul[aria-label="Pre-run checklist"] input[type=checkbox]');
const n = await boxes.count();
for (let i = 0; i < n; i++) { await boxes.nth(i).click(); await page.waitForTimeout(350); }
await page.waitForTimeout(500);
check('Run enabled after all checklist items', await runBtn.isEnabled());
await runBtn.click();
await page.waitForSelector('text=Model output (frozen before any reveal)');
check('still hidden after run', (await page.textContent('main')).includes('hidden (blind)'));
await shot('21-lab-run');
await page.click('button:has-text("Reproduce")');
await page.waitForSelector('text=reproduced identically', { timeout: 20000 });
check('reproduce reports identical', true);
await page.click('button:has-text("Reveal injected fault")');
await page.waitForSelector('text=Truth:');
const truth = await page.textContent('[role=status]:has-text("Truth")');
check('reveal shows truth vs model', /looseness/.test(truth), truth.trim().slice(0, 90));
await shot('22-lab-revealed');
// experiment
await page.click('button:has-text("Run experiment")');
await page.waitForSelector('text=Starting conditions matched', { timeout: 60000 });
check('experiment matched conditions = yes', (await page.textContent('article')).includes('yes'));
await shot('23-lab-experiment');
// responsive
for (const w of [768, 390]) {
  await page.setViewportSize({ width: w, height: 900 });
  await page.waitForTimeout(400);
  const ov = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check(`Lab no horizontal overflow @${w}`, ov <= 1, `overflow=${ov}`);
  await shot(`24-lab-w${w}`);
}
console.log(res.join('\n'));
console.log('console:', consoleMsgs.length ? [...new Set(consoleMsgs)] : 'none');
console.log('HTTP>=400:', bad.length ? [...new Set(bad)] : 'none');
await browser.close();
