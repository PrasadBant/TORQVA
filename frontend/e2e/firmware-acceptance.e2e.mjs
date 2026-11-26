import { chromium } from 'playwright-core';
import fs from 'fs';
import path from 'path';

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
await page.addInitScript((token) => sessionStorage.setItem('torqva.token', token), process.env.TORQVA_TOKEN || 'torqva-local-dev-token');
const failures = []; const checks = [];
const check = (name, ok, detail = '') => { checks.push({ name, ok, detail }); if (!ok) failures.push({ name, detail }); };
const errors = []; page.on('pageerror', (e) => errors.push(e.message));

await page.goto(`${process.env.TORQVA_URL || 'http://127.0.0.1:5173/'}#/firmware`);
await page.getByRole('tab', { name: 'Overview', exact: true }).waitFor({ timeout: 20000 });
const tabs = ['Overview', 'Development', 'Build', 'Deployment', 'Firmware Library', 'Console & Diagnostics', 'Device Management', 'Security & Audit'];
for (const name of tabs) {
  const tab = page.getByRole('tab', { name: new RegExp(`^${name.replace('&', '\\&')}`) });
  await tab.click(); await page.waitForTimeout(name === 'Development' || name === 'Build' ? 1800 : 250);
  check(`${name} tab activates`, (await tab.getAttribute('aria-selected')) === 'true');
  check(`${name} has visible content`, await page.locator('[role=tabpanel]').isVisible());
}

await page.getByRole('tab', { name: 'Development', exact: true }).click(); await page.waitForTimeout(1800);
check('Monaco loaded', await page.locator('.monaco-editor').isVisible());
await page.getByLabel('New file path').fill('src/acceptance_tmp.h'); await page.getByTestId('fw-add-file').click();
check('file creation', await page.getByTestId('fw-file-tab-src/acceptance_tmp.h').isVisible());
await page.getByLabel('Rename active file').fill('src/acceptance_renamed.h'); await page.getByRole('button', { name: 'Rename', exact: true }).click();
check('file rename', await page.getByTestId('fw-file-tab-src/acceptance_renamed.h').isVisible());
await page.getByRole('button', { name: 'Set Compare Baseline' }).click();
check('source comparison baseline', /workspace matches/.test(await page.getByTestId('fw-source-comparison').textContent()));
const dl = page.waitForEvent('download'); await page.getByRole('button', { name: /Export ZIP/ }).click(); const download = await dl;
check('ZIP export', (await download.suggestedFilename()).endsWith('.zip'));
await page.getByLabel('Delete src/acceptance_renamed.h').click();
check('file deletion', await page.getByTestId('fw-file-tab-src/acceptance_renamed.h').count() === 0);
check('compile controls available', await page.getByTestId('fw-compile-only').isEnabled() && await page.getByTestId('fw-compile-and-deploy').isEnabled());

await page.getByRole('tab', { name: 'Deployment', exact: true }).click();
const deploy = page.getByTestId('fw-deploy'); if (await deploy.count()) check('OTA deploy fail-closed while disconnected', await deploy.isDisabled());
const usbStart = page.getByRole('button', { name: 'Start USB Flash' });
check('USB flash fail-closed without target and confirmation', await usbStart.count() ? await usbStart.isDisabled() : /select.*firmware/i.test(await page.locator('[role=tabpanel]').textContent()));

await page.getByRole('tab', { name: /^Firmware Library/ }).click(); await page.waitForTimeout(300);
const search = page.getByLabel('Search firmware library');
check('library search present', await search.isVisible());
await search.fill('__no_such_release__');
check('library filtering', /No matching firmware releases/.test(await page.locator('[role=tabpanel]').textContent()));
await search.fill('');

await page.getByRole('tab', { name: 'Console & Diagnostics', exact: true }).click(); await page.waitForTimeout(300);
const pause = page.getByTestId('btn-log-pause'); await pause.click(); check('console pause', /Resume/.test(await pause.textContent())); await pause.click();
check('console resume', /Pause/.test(await pause.textContent()));
await page.getByRole('button', { name: 'Clear view' }).click();
check('unsupported metrics explicit', /UNAVAILABLE/.test(await page.locator('[role=tabpanel]').textContent()));
check('AI unavailable is honest', /No AI provider is configured/.test(await page.locator('[role=tabpanel]').textContent()));

await page.getByRole('tab', { name: 'Device Management', exact: true }).click();
check('device actions reflect disconnected state', /disconnected|not connected|unavailable/i.test(await page.locator('[role=tabpanel]').textContent()));
await page.getByRole('tab', { name: 'Security & Audit', exact: true }).click();
check('security provenance shown', /Signature verification/.test(await page.locator('[role=tabpanel]').textContent()));
check('no browser page errors', errors.length === 0, errors.join(' | '));

const out = path.resolve('quality-review', 'firmware-workstation', 'acceptance-interactions.json');
fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify({ checks, failures }, null, 2));
await browser.close();
console.log(`${checks.length - failures.length}/${checks.length} interaction checks passed`);
if (failures.length) { console.log(JSON.stringify(failures, null, 2)); process.exitCode = 1; }
