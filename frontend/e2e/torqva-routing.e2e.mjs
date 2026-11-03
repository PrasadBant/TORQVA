// Real-browser E2E for URL routing (opt-in; see e2e/README.md). Against `npm run dev:sim` (software only).
//   node e2e/torqva-routing.e2e.mjs
// A page lives in the URL hash: a refresh keeps it, Back / Forward move between pages, links open a page directly, the mode is never taken from
// the URL, and opening a route never sends a device command or starts a simulation.
import { chromium } from 'playwright-core';
const URL = process.env.TORQVA_URL || 'http://localhost:5173/';
const res = []; const check = (n, ok, x = '') => res.push(`${ok ? 'PASS' : 'FAIL'}  ${n} ${x}`);
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addInitScript(() => { if (!sessionStorage.getItem('e2e-init')) { sessionStorage.setItem('e2e-init', '1'); localStorage.setItem('torqva.mode', 'SIMULATION'); } });
const page = await ctx.newPage();
const errors = []; page.on('pageerror', (e) => errors.push(e.message)); page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
const posts = []; page.on('request', (r) => { if (r.method() !== 'GET' && /\/device\/commands|\/simulation\/(start|step)|\/approvals\//.test(r.url())) posts.push(r.url()); });
const active = () => page.textContent('nav [aria-current="page"]').catch(() => '');
const ready = () => page.waitForSelector('main h2', { timeout: 20000 });

await page.goto(URL + '#/predictions'); await ready();
check('a link to a page opens that page', /Failure Prediction/.test(await active()));
await page.reload(); await ready();
check('a refresh keeps the page', /Failure Prediction/.test(await active()) && page.url().endsWith('#/predictions'));
await page.click('nav button:has-text("Live Monitor")'); await page.waitForTimeout(300);
await page.click('nav button:has-text("Lab")'); await page.waitForTimeout(300);
check('navigation writes the page to the URL', page.url().endsWith('#/lab'));
await page.goBack(); await page.waitForTimeout(400);
check('Back returns to the previous page', /Live Monitor/.test(await active()) && page.url().endsWith('#/live'));
await page.goBack(); await page.waitForTimeout(400);
check('Back again returns to the first page', /Failure Prediction/.test(await active()));
await page.goForward(); await page.waitForTimeout(400);
check('Forward works', /Live Monitor/.test(await active()));
await page.goto(URL + '#/device/connection'); await ready(); await page.waitForTimeout(300);
check('a Device & Safety tab opens from the URL', (await page.getAttribute('[role=tab]:has-text("Connection & Readiness")', 'aria-selected')) === 'true');
await page.click('[role=tab]:has-text("Device")>> nth=0'); await page.waitForTimeout(300);
check('a tab change replaces the URL (no extra Back step)', page.url().endsWith('#/device/system'));
await page.goto(URL + '#/device/safety'); await ready(); await page.waitForTimeout(400);
check('simulation mode never opens Safety & Commissioning from a URL', (await page.locator('[role=tab]:has-text("Safety & Commissioning")').count()) === 0 && page.url().endsWith('#/device/system'));
check('the URL never changes the mode', (await page.evaluate(() => localStorage.getItem('torqva.mode'))) === 'SIMULATION' && (await page.locator('[data-testid="sim-banner"]').count()) === 1);
await page.goto(URL + '#/nothing-here'); await ready(); await page.waitForTimeout(300);
check('an unknown route opens Overview and corrects the URL', /Overview/.test(await active()) && page.url().endsWith('#/overview'));
// Physical mode: the same route shows the physical page; START stays locked after a refresh
await page.evaluate(() => localStorage.setItem('torqva.mode', 'PHYSICAL'));
await page.goto(URL + '#/device/safety'); await page.reload(); await ready(); await page.waitForTimeout(600);   // the mode is read at load, never from the URL
check('physical mode opens Safety & Commissioning from its URL', (await page.getAttribute('[role=tab]:has-text("Safety & Commissioning")', 'aria-selected')) === 'true');
await page.goto(URL + '#/overview'); await ready(); await page.reload(); await ready(); await page.waitForTimeout(800);
check('after a refresh physical START stays locked by its blockers', await page.isDisabled('[data-testid="btn-start"]'));
await page.evaluate(() => localStorage.setItem('torqva.mode', 'SIMULATION'));
check('opening routes sent no device command, approval or simulation start/step', posts.length === 0, posts.slice(0, 2).join(' '));
check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
await browser.close();
console.log(res.join('\n'));
const failed = res.filter((r) => r.startsWith('FAIL')).length;
console.log(`\n${res.length - failed}/${res.length} passed`);
process.exit(failed ? 1 : 0);
