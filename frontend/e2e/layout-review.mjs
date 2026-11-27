import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const phase = process.argv[2] || 'after';
const output = path.resolve('layout-review', phase);
fs.mkdirSync(output, { recursive: true });
// Digital Twin is deliberately excluded: this audit must not exercise or imply
// layout changes to its viewport, controls, or supporting panels.
const routes = ['overview', 'live', 'workflow', 'diagnostics', 'predictions', 'interventions', 'tests', 'recovery', 'learning', 'evaluation', 'scenario', 'lab', 'device', 'firmware'];
const widths = process.argv[3]?.split(',').map(Number);
const sizes = (phase === 'before' ? [[1440, 900]] : [[1024, 768], [1280, 720], [1366, 768], [1440, 900], [1920, 1080], [2560, 1440]]).filter(([width]) => !widths || widths.includes(width));
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const resultsFile = path.join(output, 'results.json');
const previous = widths && fs.existsSync(resultsFile) ? JSON.parse(fs.readFileSync(resultsFile)).results : [];
const results = previous.filter(result => !widths.includes(result.width));
const errors = [];
const writes = [];
try {
  for (const mode of ['PHYSICAL', 'SIMULATION']) {
    const page = await browser.newPage();
    page.on('pageerror', error => errors.push({ mode, message: error.message }));
    await page.route('**/api/**', async route => {
      if (route.request().method() !== 'GET') {
        writes.push({ method: route.request().method(), url: route.request().url() });
        await route.abort();
      } else await route.continue();
    });
    await page.addInitScript(selected => {
      localStorage.setItem('torqva.mode', selected);
      localStorage.setItem('torqva.theme', 'light');
      localStorage.setItem('torqva.navgroups', '[]');
    }, mode);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('http://localhost:5173');
    await page.waitForSelector('main .tq-view', { timeout: 30000 });
    for (const route of routes) {
      await page.goto(`http://localhost:5173/#/${route}`);
      await page.waitForSelector('main h2:visible', { timeout: 30000 });
      await page.waitForTimeout(400);
      for (const [width, height] of sizes) {
        await page.setViewportSize({ width, height });
        await page.waitForTimeout(120);
        const layout = await page.evaluate(() => {
          const main = document.querySelector('main');
          const headings = [...main.querySelectorAll('h2')].filter(node => node.getBoundingClientRect().height > 0).map(node => node.textContent);
          const cards = [...main.querySelectorAll('.tq-card')].filter(node => node.scrollWidth - node.clientWidth > 2).map(node => node.getAttribute('aria-labelledby'));
          const controls = [...main.querySelectorAll('button,input,select,textarea')].filter(node => {
            const rect = node.getBoundingClientRect();
            return rect.width > 0 && getComputedStyle(node).visibility !== 'hidden' && (rect.right > innerWidth + 2 || rect.left < -2);
          }).map(node => node.getAttribute('aria-label') || node.textContent.slice(0, 60));
          return { overflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth, headings, cardOverflow: cards, outsideControls: controls };
        });
        results.push({ mode, route, width, height, ...layout });
        await page.screenshot({ path: path.join(output, `${mode.toLowerCase()}-${route}-${width}.png`), fullPage: true });
      }
      console.log(`${phase} ${mode} ${route}`);
    }
    await page.goto('http://localhost:5173/#/device');
    await page.getByRole('tab', { name: 'Connection & Readiness', exact: true }).click();
    await page.waitForTimeout(400);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.screenshot({ path: path.join(output, `${mode.toLowerCase()}-connection-1440.png`), fullPage: true });
    await page.close();
  }
} finally {
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ results, errors, writes }, null, 2));
  await browser.close();
}
console.log(JSON.stringify({ layouts: results.length, overflow: results.filter(result => result.overflow > 1), errors, writes }));
