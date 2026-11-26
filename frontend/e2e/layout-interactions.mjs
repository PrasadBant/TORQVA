import { chromium } from 'playwright-core';
import fs from 'node:fs';

const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const output = 'layout-review/states';
fs.mkdirSync(output, { recursive: true });
const checks = [];
const writes = [];
const errors = [];
page.on('pageerror', error => errors.push(error.message));
await page.route('**/api/**', async route => {
  if (route.request().method() !== 'GET') { writes.push(route.request().url()); await route.abort(); }
  else await route.continue();
});
await page.addInitScript(() => {
  localStorage.setItem('torqva.mode', 'SIMULATION');
  localStorage.setItem('torqva.theme', 'light');
});
try {
  for (const route of ['diagnostics', 'predictions', 'interventions', 'tests', 'evaluation', 'device']) {
    await page.goto(`http://localhost:5173/#/${route}`);
    await page.waitForSelector('main h2:visible');
    await page.waitForTimeout(350);
    const tabs = await page.locator('main [role=tab]').allTextContents();
    for (const name of tabs) {
      const tab = page.locator('main [role=tab]').filter({ hasText: name.trim() }).first();
      if (!await tab.count()) continue;
      await tab.click();
      await page.waitForTimeout(150);
      checks.push({ route, tab: name.trim(), selected: await tab.getAttribute('aria-selected') === 'true', overflow: await page.evaluate(() => document.documentElement.scrollWidth - innerWidth) });
    }
    await page.screenshot({ path: `${output}/${route}-alternate-tab.png`, fullPage: true });
  }
  for (const [width, height] of [[1024,768],[1280,720],[1366,768],[1440,900],[1920,1080],[2560,1440]]) {
    await page.setViewportSize({ width, height });
    checks.push({ action: 'Connection and readiness layout', width, selected: true, overflow: await page.evaluate(() => document.documentElement.scrollWidth - innerWidth) });
    await page.screenshot({ path: `${output}/connection-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width:1280, height:720 });
  await page.goto('http://localhost:5173/#/overview');
  await page.waitForSelector('main h2:visible');
  await page.getByRole('button', { name: 'Toggle theme', exact: true }).click();
  checks.push({ action: 'Existing dark theme', selected: await page.locator('.tq-theme-dark').count() === 1 });
  await page.screenshot({ path: `${output}/dark-theme.png`, fullPage: true });
  await page.locator('.tq-collapse-btn').click();
  checks.push({ action: 'Collapse sidebar', selected: await page.locator('.tq-nav-collapsed').count() === 1 });
  await page.screenshot({ path: `${output}/collapsed-sidebar.png`, fullPage: true });
} finally {
  fs.writeFileSync(`${output}/results.json`, JSON.stringify({ checks, writes, errors }, null, 2));
  await browser.close();
}
console.log(JSON.stringify({ checks: checks.length, failed: checks.filter(check => !check.selected || check.overflow > 1), errors, writes }));
