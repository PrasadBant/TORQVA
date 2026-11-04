// Real-browser E2E for the Firmware Manager (opt-in; see e2e/README.md). Against a token backend started with a scratch firmware directory, the
// development release public key and a device-facing HTTPS URL, and no device attached:
//   TORQVA_FIRMWARE_DIR=<empty dir> TORQVA_OTA_PUBLIC_KEY=<release_public_key.pem> TORQVA_OTA_PUBLIC_BASE_URL=https://ota.bench.lan  (backend env)
//   TORQVA_TOKEN=<admin> TORQVA_VIEWER_TOKEN=<viewer> FW_BIN=<firmware.bin built by pio run -e esp32s3> FW_SIG=<its .sig> node e2e/torqva-firmware.e2e.mjs
// Uploads the REAL compiled image through the page, checks every validation result, refuses a tampered and a duplicate image, shows that nothing can be
// deployed without a connected OTA-capable device, and that no device command or deployment request is ever sent. Nothing is flashed.
import { chromium } from 'playwright-core';
import fs from 'fs';
import os from 'os';
import path from 'path';
const { TORQVA_TOKEN: ADMIN, TORQVA_VIEWER_TOKEN: VIEWER, FW_BIN, FW_SIG } = process.env;
if (!ADMIN || !VIEWER || !FW_BIN || !FW_SIG) { console.error('Set TORQVA_TOKEN, TORQVA_VIEWER_TOKEN, FW_BIN and FW_SIG'); process.exit(2); }
const URL = process.env.TORQVA_URL || 'http://127.0.0.1:5173/';
const res = []; const check = (n, ok, x = '') => res.push(`${ok ? 'PASS' : 'FAIL'}  ${n} ${x}`);
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addInitScript(() => { try { if (!sessionStorage.getItem('fw-e2e')) { sessionStorage.setItem('fw-e2e', '1'); localStorage.removeItem('torqva.mode'); localStorage.setItem('torqva.theme', 'light'); } } catch { /* */ } });
const page = await ctx.newPage();
const errors = []; page.on('pageerror', (e) => errors.push(e.message));
const writes = []; page.on('request', (r) => { if (r.method() !== 'GET') writes.push(`${r.method()} ${r.url().replace(/^.*\/api\/torqva/, '')}`); });
const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const signIn = async (tok) => { await page.goto(URL + '#/firmware'); await page.fill('input[type=password]', tok); await page.click('button:has-text("Sign in")'); await page.waitForSelector('[data-testid=fw-device]', { timeout: 20000 }); };
const sig = fs.readFileSync(FW_SIG, 'utf8').trim();

await signIn(ADMIN);
check('the page opens from its URL in physical mode, inside the Device & Safety group', (await page.textContent('main h2')).includes('Firmware Manager')
  && (await page.locator('.tq-navgroup:has(button[aria-label="Show or hide Device & Safety"]) button.tq-nav:has-text("Firmware Manager")').count()) === 1);
check('without a board the device is not connected and no update capability is claimed', /not connected/.test(await page.textContent('[data-testid=fw-device]')) && !/OTA ready/.test(await page.textContent('[data-testid=fw-device]')));
check('the page states that firmware updates never enable motor operation', (await page.textContent('[data-testid=fw-banner]')).includes('never enable motor operation'));

// upload the real compiled image
await page.setInputFiles('[data-testid=fw-file]', FW_BIN);
await page.fill('[data-testid=fw-sig]', sig);
await page.click('[data-testid=fw-upload-btn]');
await page.waitForSelector('[data-testid=fw-validation] li', { timeout: 30000 });
const val = await page.textContent('[data-testid=fw-validation]');
check('the real image passes image, chip, partition, integrity and signature checks', ['Image validity', 'ESP32-S3 compatibility', 'Partition compatibility', 'SHA-256 integrity', 'Signature verification']
  .every((l) => new RegExp(`${l}.*?VERIFIED`).test(val)) && val.includes('eligible for deployment'), val.replace(/\s+/g, ' ').slice(0, 160));
check('the version shown is the one compiled into the image', /Release 3\.0\.1-dev/.test(val));
check('the release is listed', (await page.textContent('[data-testid=fw-releases]')).includes('3.0.1-dev'));

// nothing can be deployed without a connected OTA-capable device
await page.click('[data-testid=fw-releases] button:has-text("3.0.1-dev")');
await page.waitForSelector('[data-testid=fw-blockers]', { timeout: 10000 });
check('Update Firmware stays disabled and names the reason', await page.isDisabled('[data-testid=fw-deploy]') && /device not connected/.test(await page.textContent('[data-testid=fw-blockers]')));
await page.check('[data-testid=fw-bench]');
check('the attestation alone does not enable it', await page.isDisabled('[data-testid=fw-deploy]'));

// a tampered copy and a duplicate are refused
const tampered = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fwe2e-')), 'firmware.bin');
const buf = fs.readFileSync(FW_BIN); buf[5000] ^= 1; fs.writeFileSync(tampered, buf);
await page.setInputFiles('[data-testid=fw-file]', tampered);
await page.fill('[data-testid=fw-sig]', sig);
await page.click('[data-testid=fw-upload-btn]');
await page.waitForSelector('[data-testid=fw-upload] [role=alert]', { timeout: 15000 });
check('a tampered image is refused by its checksum', /checksum/i.test(await page.textContent('[data-testid=fw-upload] [role=alert]')));
await page.setInputFiles('[data-testid=fw-file]', FW_BIN);
await page.fill('[data-testid=fw-sig]', sig);
await page.click('[data-testid=fw-upload-btn]');
await page.waitForFunction(() => /already release/.test(document.querySelector('[data-testid=fw-upload]')?.textContent || ''), null, { timeout: 15000 });
check('the same image cannot be uploaded twice', true);
await page.setInputFiles('[data-testid=fw-file]', { name: 'main.cpp', mimeType: 'text/plain', buffer: Buffer.from('void setup(){}') });
check('source code is refused before upload', /Only a compiled application image/.test(await page.textContent('[data-testid=fw-precheck]')) && await page.isDisabled('[data-testid=fw-upload-btn]'));

// layouts
check('no horizontal overflow at 1440 px', (await overflow()) <= 1);
await page.setViewportSize({ width: 390, height: 900 }); await page.waitForTimeout(300);
check('no horizontal overflow at 390 px', (await overflow()) <= 1, `${await overflow()} px`);
await page.evaluate(() => localStorage.setItem('torqva.theme', 'dark')); await page.reload(); await page.waitForSelector('[data-testid=fw-device]');
check('no horizontal overflow at 390 px in the dark theme', (await overflow()) <= 1);
await page.setViewportSize({ width: 1440, height: 900 });

// a viewer reads but cannot upload or deploy
await page.click('button[aria-label="Sign out"]');
await signIn(VIEWER);
await page.waitForFunction(() => (document.querySelector('[data-testid=fw-releases]')?.textContent || '').includes('3.0.1-dev'), null, { timeout: 15000 }).catch(() => {});   // the list loads after sign-in
check('a viewer sees the release but no upload control', (await page.locator('[data-testid=fw-upload-btn]').count()) === 0 && (await page.textContent('[data-testid=fw-releases]')).includes('3.0.1-dev'));
await page.click('[data-testid=fw-releases] button:has-text("3.0.1-dev")');
await page.waitForSelector('text=Deploying firmware requires the admin role.');
check('a viewer has no deploy control', (await page.locator('[data-testid=fw-deploy]').count()) === 0);

check('no device command, deployment or simulation request was sent', !writes.some((w) => /device\/commands|firmware\/deployments|simulation\//.test(w)), writes.filter((w) => !/firmware\/releases/.test(w)).join(' '));
check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(res.join('\n'));
const failed = res.filter((r) => r.startsWith('FAIL')).length;
console.log(`\n${res.length - failed}/${res.length} passed`);
process.exit(failed ? 1 : 0);
