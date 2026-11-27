import { chromium } from 'playwright-core';
import fs from 'fs';
import path from 'path';

const root = path.resolve('quality-review', 'firmware-workstation');
fs.mkdirSync(root, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const sizes = [[1024, 768], [1280, 720], [1366, 768], [1440, 900], [1920, 1080], [2560, 1440]];
const tabs = ['Overview', 'Development', 'Build', 'Deployment', 'Firmware Library', 'Console & Diagnostics', 'Device Management', 'Security & Audit'];
const results = [];
for (const [width, height] of sizes) {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.addInitScript((token) => sessionStorage.setItem('torqva.token', token), process.env.TORQVA_TOKEN || 'torqva-local-dev-token');
  await page.goto(`${process.env.TORQVA_URL || 'http://127.0.0.1:5173/'}#/firmware`);
  await page.getByRole('tab', { name: 'Overview', exact: true }).waitFor({ timeout: 20000 });
  for (const tab of tabs) {
    await page.getByRole('tab', { name: new RegExp(`^${tab.replace(/[&]/g, '\\&')}`) }).click();
    await page.waitForTimeout(tab === 'Development' ? 1800 : 100);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    results.push({ width, height, tab, overflow });
    if (width === 1440 && height === 900) {
      const slug = tab.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      await page.screenshot({ path: path.join(root, `firmware-1440x900-${slug}.png`), fullPage: true });
    }
  }
  await page.screenshot({ path: path.join(root, `firmware-${width}x${height}.png`), fullPage: true });
  await page.close();
}
fs.writeFileSync(path.join(root, 'results.json'), JSON.stringify(results, null, 2));
await browser.close();
const failures = results.filter((r) => r.overflow > 1);
console.log(`${results.length} workspace/viewport checks; ${failures.length} horizontal overflow failures`);
if (failures.length) { console.log(JSON.stringify(failures, null, 2)); process.exitCode = 1; }
