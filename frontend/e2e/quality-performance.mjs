import { chromium } from 'playwright-core';
import fs from 'node:fs';

const phase = process.argv[2] || 'after';
const routes = ['overview', 'live', 'workflow', 'diagnostics', 'predictions', 'interventions', 'tests', 'recovery', 'learning', 'evaluation', 'scenario', 'lab', 'device', 'firmware'];
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const rows = [];
const writes = [];
const errors = [];

try {
  for (const mode of ['PHYSICAL', 'SIMULATION']) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on('pageerror', (error) => errors.push({ mode, message: error.message }));
    await page.route('**/api/**', async (route) => {
      if (route.request().method() !== 'GET') {
        writes.push({ method: route.request().method(), url: route.request().url() });
        await route.abort();
      } else await route.continue();
    });
    await page.addInitScript((selected) => {
      localStorage.setItem('torqva.mode', selected);
      localStorage.setItem('torqva.theme', 'light');
      window.__tqLongTasks = [];
      new PerformanceObserver((list) => window.__tqLongTasks.push(...list.getEntries().map((entry) => entry.duration))).observe({ type: 'longtask', buffered: true });
    }, mode);

    for (const route of routes) {
      const started = Date.now();
      await page.goto(`http://localhost:5173/#/${route}`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('main h2:visible', { timeout: 30000 });
      await page.waitForTimeout(250);
      const metrics = await page.evaluate(() => ({
        domNodes: document.getElementsByTagName('*').length,
        heapUsedMB: performance.memory ? performance.memory.usedJSHeapSize / 1048576 : null,
        resources: performance.getEntriesByType('resource').length,
        transferKB: performance.getEntriesByType('resource').reduce((sum, entry) => sum + (entry.transferSize || 0), 0) / 1024,
        longTasks: window.__tqLongTasks.length,
        longTaskMs: window.__tqLongTasks.reduce((sum, duration) => sum + duration, 0),
      }));
      rows.push({ mode, route, readyMs: Date.now() - started, ...metrics });
    }
    await page.close();
  }
} finally {
  fs.mkdirSync('quality-review', { recursive: true });
  fs.writeFileSync(`quality-review/performance-${phase}.json`, JSON.stringify({ phase, rows, writes, errors }, null, 2));
  await browser.close();
}

const avg = (key) => Number((rows.reduce((sum, row) => sum + (row[key] || 0), 0) / rows.length).toFixed(2));
console.log(JSON.stringify({ phase, pages: rows.length, averageReadyMs: avg('readyMs'), averageDomNodes: avg('domNodes'), averageHeapUsedMB: avg('heapUsedMB'), totalLongTasks: rows.reduce((sum, row) => sum + row.longTasks, 0), errors, writes }));
