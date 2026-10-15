// Real-browser E2E for the Digital Twin page (opt-in; see e2e/README.md).
//   npm run dev:sim        (software-only backend + app, signs in automatically in development)
//   node e2e/torqva-twin.e2e.mjs
// Physical mode with no board (real backend, no mocks), then simulation mode: the shaft animates only while simulation time advances, selection and
// keyboard use, trends, both themes, 1440/1024/768/390 px layouts, and the twin itself never sends anything but reads. Needs playwright-core and Chrome.
import { chromium } from 'playwright-core';
import fs from 'fs';
const URL = process.env.TORQVA_URL || 'http://localhost:5173/';
const OUT = process.env.SHOTS_DIR || './e2e-shots'; fs.mkdirSync(OUT, { recursive: true });
const res = []; const check = (n, ok, x = '') => res.push(`${ok ? 'PASS' : 'FAIL'}  ${n} ${x}`);

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.addInitScript(() => { try { if (!sessionStorage.getItem('tw-e2e')) { localStorage.removeItem('torqva.mode'); localStorage.setItem('torqva.theme', 'dark'); sessionStorage.setItem('tw-e2e', '1'); } } catch { /* storage unavailable */ } });
const consoleMsgs = [], writes = [];
page.on('console', (m) => { if (m.type() === 'error') consoleMsgs.push(m.text()); });
page.on('pageerror', (e) => consoleMsgs.push('pageerror: ' + e.message));
page.on('request', (r) => { if (r.method() !== 'GET' && /\/api\//.test(r.url())) writes.push(`${r.method()} ${r.url().replace(/^.*\/api\/torqva/, '')}`); });
const shot = (n) => page.screenshot({ path: `${OUT}/${n}.png`, fullPage: true });
const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const nav = async (label) => { await page.click(`nav button:has-text("${label}")`); await page.waitForTimeout(300); };
const spinning = () => page.getAttribute('[data-testid=twin-model]', 'data-spinning');
const updated = () => page.textContent('[data-testid=twin-updated]');

await page.goto(URL);
await page.waitForSelector('nav button:has-text("Digital Twin")', { timeout: 20000 });

// ---- physical mode, no board
await nav('Digital Twin');
await page.waitForSelector('[data-testid=twin-page][data-source=PHYSICAL]', { timeout: 15000 });
check('physical twin says HARDWARE NOT CONNECTED (real backend, no board)', (await page.textContent('[data-testid=twin-state]')).includes('HARDWARE NOT CONNECTED'));
check('physical twin does not animate the shaft without hardware', (await spinning()) === 'no');
const kpis = await page.locator('[data-testid=twin-kpis] .tq-tw-kpi-value').allTextContents();
check('physical readings are UNAVAILABLE, never numbers', kpis.length === 7 && kpis.every((k) => k === 'UNAVAILABLE'), kpis.join(','));
let before = writes.length;
for (const id of ['hall', 'temp', 'ina', 'accel', 'driver', 'controller']) { await page.click(`.tq-tw-chip >> nth=${['hall', 'temp', 'ina', 'accel', 'driver', 'controller'].indexOf(id)}`); await page.waitForTimeout(200); }
check('exploring every part in physical mode sends nothing to the backend', writes.length === before, writes.slice(before).join(' | '));
check('no motor-command control on the physical twin', (await page.locator('[data-testid=twin-page] button:has-text("START"), [data-testid=twin-page] button:has-text("STOP"), [data-testid=twin-page] input[type=range]').count()) === 0);
await shot('twin-physical-disconnected');

// ---- simulation mode: start a run on the existing Live Monitor controls, then watch the twin
await page.click('button:has-text("Simulation mode (demo)")');
await nav('Live Monitor');
await page.click('button:has-text("Start new simulation")');
await page.waitForTimeout(800);
await page.click('button:has-text("Run")');
await nav('Digital Twin');
await page.waitForSelector('[data-testid=twin-page][data-source=SIMULATION]', { timeout: 15000 });
await page.waitForFunction(() => document.querySelector('[data-testid=twin-model]')?.getAttribute('data-spinning') === 'yes', null, { timeout: 15000 }).catch(() => {});
check('simulation twin animates while simulation time advances', (await spinning()) === 'yes');
const t1 = await updated(); await page.waitForTimeout(3500); const t2 = await updated();
check('the twin follows the simulator (simulation time advances)', t1 !== t2, `${t1} -> ${t2}`);
const rpmTile = await page.textContent('[data-testid=twin-kpi-rpm]');
check('speed tile shows a simulated number with its SIM badge', /\d/.test(rpmTile) && /SIM/.test(rpmTile), rpmTile);
check('power is labelled DERIVED', /DERIVED/.test(await page.textContent('[data-testid=twin-kpi-power]')));
await shot('twin-sim-running');

await nav('Live Monitor');
await page.click('button:has-text("Pause")');
await nav('Digital Twin');
await page.waitForTimeout(600);
check('pausing the simulation stops the shaft', (await spinning()) === 'no');
// Count this page's own step requests: the backend simulator is shared, so another open tab may still be advancing it.
const steps = []; const onStep = (r) => { if (/simulation[/]step/.test(r.url())) steps.push(r.url()); };
page.on('request', onStep); await page.waitForTimeout(3500); page.off('request', onStep);
check('paused: this page stops stepping the simulator', steps.length === 0, `${steps.length} step request(s)`);

before = writes.length;
await page.click('[data-testid=twin-hot-hall]');
await page.waitForSelector('[data-testid=twin-detail]');
check('selecting the Hall hotspot opens the speed sensor', (await page.textContent('[data-testid=twin-detail]')).includes('Speed sensor'));
check('the drawing highlights the selected part', (await page.getAttribute('[data-testid=twin-model]', 'data-selected')) === 'hall');
await page.waitForSelector('[data-testid=twin-trend] .recharts-line-curve', { timeout: 15000 }).catch(() => {});
check('a real trend chart is drawn from the simulated history', (await page.locator('[data-testid=twin-trend] .recharts-line-curve').count()) >= 1);
await page.keyboard.press('Escape');
await page.waitForSelector('[data-testid=twin-overview]');
check('Escape returns to the full motor view', true);
await page.focus('[data-testid=twin-hot-temp]'); await page.keyboard.press('Enter');
check('keyboard Enter on a hotspot selects it', (await page.getAttribute('[data-testid=twin-model]', 'data-selected')) === 'temp');
await page.click('[data-testid=twin-close]');
check('exploring the twin while paused sends nothing to the backend', writes.length === before, writes.slice(before).join(' | '));

// ---- light theme and layouts
await page.click('button[aria-label*="theme" i]').catch(() => {});
await page.waitForTimeout(300);
check('light theme applies', (await page.evaluate(() => document.documentElement.getAttribute('data-theme'))) === 'light');
await page.click('[data-testid=twin-hot-ina]'); await page.waitForTimeout(500);
await shot('twin-sim-light-ina');
await page.click('[data-testid=twin-close]');
for (const w of [1024, 768, 390]) {
  await page.setViewportSize({ width: w, height: 900 }); await page.waitForTimeout(400);
  const o = await overflow();
  check(`no horizontal overflow at ${w}px`, o <= 1, `(overflow ${o}px)`);
  await shot(`twin-${w}`);
}
// ---- switching to physical mode on the twin page must not carry any simulated value across
await page.setViewportSize({ width: 1440, height: 900 }); await page.waitForTimeout(300);
await page.click('button:has-text("Physical mode")');
await page.waitForSelector('[data-testid=twin-page][data-source=PHYSICAL]', { timeout: 15000 });
const physVals = await page.locator('[data-testid=twin-kpis] .tq-tw-kpi-value').allTextContents();
check('after switching to physical mode no simulated value remains on the twin', physVals.every((k) => k === 'UNAVAILABLE') && (await page.locator('[data-testid=twin-page] .tq-prov-sim').count()) === 0, physVals.join(','));
check('after switching, the twin shows the real device state and a still shaft', (await page.textContent('[data-testid=twin-state]')).includes('HARDWARE NOT CONNECTED') && (await spinning()) === 'no');
const simReq = []; const onReq = (r) => { if (/\/api\/torqva\/(simulation|status|telemetry)/.test(r.url())) simReq.push(r.url()); };
page.on('request', onReq); await page.waitForTimeout(4000); page.off('request', onReq);
check('physical mode on the twin makes no simulator requests', simReq.length === 0, simReq.slice(0, 3).join(' | '));
check('the twin never sent a device command', !writes.some((w) => /device\/commands|commissioning/.test(w)), writes.join(' | '));
check('no console errors', consoleMsgs.length === 0, consoleMsgs.join(' | ').slice(0, 300));
console.log(res.join('\n'));
await browser.close();
process.exit(res.some((r) => r.startsWith('FAIL')) ? 1 : 0);
