// Real-browser E2E for the Digital Twin page (opt-in; see e2e/README.md).
//   npm run dev:sim        (software-only backend + app, signs in automatically in development)
//   node e2e/torqva-twin.e2e.mjs
// Physical mode with no board (real backend, no mocks), then simulation mode: the shaft animates only while simulation time advances, selection and
// keyboard use, trends, both themes, 1440/1024/768/390 px layouts, and the twin itself never sends anything but reads. Needs playwright-core and Chrome.
// The 3D viewport (WebGL 2): it really draws, renders only on demand, orbit / Ctrl-zoom / presets / orthographic, picking in the scene, isolate,
// explode, section, recovery from a lost graphics context, the 2D drawing switch, and no WebGL context or geometry leak across remounts.
import { chromium } from 'playwright-core';
import fs from 'fs';
const URL = process.env.TORQVA_URL || 'http://localhost:5173/';
const OUT = process.env.SHOTS_DIR || './e2e-shots'; fs.mkdirSync(OUT, { recursive: true });
const res = []; const check = (n, ok, x = '') => res.push(`${ok ? 'PASS' : 'FAIL'}  ${n} ${x}`);

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.addInitScript(() => { try { if (!sessionStorage.getItem('tw-e2e')) { localStorage.removeItem('torqva.mode'); localStorage.setItem('torqva.theme', 'dark'); sessionStorage.setItem('tw-e2e', '1'); } } catch { /* storage unavailable */ } });
const consoleMsgs = [], writes = [], threeWarnings = [];
page.on('console', (m) => { if (m.type() === 'error') consoleMsgs.push(m.text()); if (m.type() === 'warning' && /THREE|WebGL/i.test(m.text())) threeWarnings.push(m.text()); });
page.on('pageerror', (e) => consoleMsgs.push('pageerror: ' + e.message));
page.on('request', (r) => { if (r.method() !== 'GET' && /\/api\//.test(r.url())) writes.push(`${r.method()} ${r.url().replace(/^.*\/api\/torqva/, '')}`); });
const shot = (n) => page.screenshot({ path: `${OUT}/${n}.png`, fullPage: true });
const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const nav = async (label) => { await page.click(`nav button:has-text("${label}")`); await page.waitForTimeout(300); };
const spinning = () => page.getAttribute('[data-testid=twin-model]', 'data-spinning');
const updated = () => page.textContent('[data-testid=twin-updated]');
const t3 = () => page.evaluate(() => ({ ...(document.querySelector('[data-testid=twin-model]')?.dataset || {}) }));
const cam = async () => (await t3()).camera.split(',').map(Number);              // [azimuth, polar, distance, zoom]
const settle = () => page.waitForTimeout(900);

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

// ---- 3D viewport
const v = await t3();
check('the 3D viewport is rendered with WebGL 2', v.renderer === 'webgl' && v.status === 'ready' && +v.frames > 0 && +v.calls > 10, JSON.stringify({ frames: v.frames, calls: v.calls }));
const png = await page.locator('.tq-t3-host').screenshot();
check('the canvas really draws a scene (not a blank frame)', png.length > 40000, `${png.length} bytes`);
await page.mouse.move(5, 5); await page.waitForTimeout(600);
const f0 = +(await t3()).frames; await page.waitForTimeout(1500); const f1 = +(await t3()).frames;
check('paused and idle: the viewport renders on demand only (no continuous frames)', f1 - f0 <= 2, `${f0} -> ${f1}`);
const host = await page.locator('.tq-t3-host').boundingBox();
const cx = host.x + host.width / 2, cy = host.y + host.height / 2;
const c0 = await cam();
await page.mouse.move(cx, cy); await page.mouse.down(); await page.mouse.move(cx + 160, cy + 10, { steps: 8 }); await page.mouse.up(); await settle();
const c1 = await cam();
check('dragging orbits the camera', Math.abs(c1[0] - c0[0]) > 10, `${c0[0]} -> ${c1[0]}`);
const y0 = await page.evaluate(() => window.scrollY);
await page.mouse.move(cx, cy); await page.mouse.wheel(0, 300); await page.waitForTimeout(500);
const c2 = await cam(), y1 = await page.evaluate(() => window.scrollY);
check('plain scrolling over the model scrolls the page and does not zoom', c2[2] === c1[2] && y1 !== y0, `dist ${c1[2]} -> ${c2[2]}, scrollY ${y0} -> ${y1}`);
const hb = await page.locator('.tq-t3-host').boundingBox();
await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
await page.keyboard.down('Control'); await page.mouse.wheel(0, -400); await page.keyboard.up('Control'); await settle();
const c3 = await cam();
check('Ctrl + scroll zooms the model', c3[2] < c2[2], `dist ${c2[2]} -> ${c3[2]}`);
await page.click('[data-testid=t3-view-top]'); await settle();
const top = await cam();
check('the Top preset looks straight down', top[1] <= 2, top.join(','));
await page.click('[data-testid=t3-view-front]'); await settle();
const front = await cam();
check('the Front preset faces the electronics side horizontally', Math.abs(front[0] - 180) <= 2 && Math.abs(front[1] - 90) <= 2, front.join(','));
await page.click('[data-testid=t3-ortho]'); await settle();
check('orthographic projection can be switched on', (await t3()).projection === 'orthographic');
await page.click('[data-testid=t3-ortho]'); await page.click('[data-testid=t3-reset]'); await settle();
check('Reset returns to the isometric view in perspective', (await t3()).projection === 'perspective' && Math.abs((await cam())[0] - 138) <= 2, (await t3()).camera);
// picking: sweep the viewport until the hover tag names a part, then click there
let picked = null;
const hb2 = await page.locator('.tq-t3-host').boundingBox();
for (let gy = 0.35; gy <= 0.75 && !picked; gy += 0.05) for (let gx = 0.3; gx <= 0.7 && !picked; gx += 0.05) {
  await page.mouse.move(hb2.x + hb2.width * gx, hb2.y + hb2.height * gy); await page.waitForTimeout(60);
  const name = await page.locator('.tq-t3-hover strong').textContent({ timeout: 50 }).catch(() => null);
  if (name) picked = { name, x: hb2.x + hb2.width * gx, y: hb2.y + hb2.height * gy };
}
if (picked) { await page.mouse.click(picked.x, picked.y); await page.waitForTimeout(400); }
const detailTitle = picked ? await page.textContent('[data-testid=twin-detail] h3').catch(() => '') : '';
check('hovering a part in the scene names it and clicking it opens that part', !!picked && detailTitle === picked.name, picked ? `${picked.name} / ${detailTitle}` : 'nothing under the pointer');
if (await page.locator('[data-testid=twin-close]').count()) await page.click('[data-testid=twin-close]');
await page.click('[data-testid=twin-hot-ina]'); await page.waitForTimeout(300);
await page.click('[data-testid=t3-isolate]'); await settle();
const vis = await page.evaluate(() => [...document.querySelectorAll('.tq-t3-hot')].map((e) => [e.dataset.testid, e.style.visibility]));
check('Isolate shows only the selected part', (await t3()).isolate === 'on' && vis.every(([id, st]) => (id === 'twin-hot-ina') === (st === 'visible')), JSON.stringify(vis));
await page.click('[data-testid=t3-isolate]'); await page.click('[data-testid=twin-close]'); await settle();
const hallAt = () => page.evaluate(() => document.querySelector('[data-testid=twin-hot-hall]').style.transform);
const h0 = await hallAt();
await page.click('[data-testid=t3-explode]'); await page.waitForTimeout(1500);
const h1 = await hallAt();
check('Explode moves the parts and their markers apart', (await t3()).explode === 'on' && h1 !== h0, `${h0} -> ${h1}`);
await shot('twin-3d-exploded');
await page.click('[data-testid=t3-explode]'); await page.waitForTimeout(900);
await page.click('[data-testid=t3-cutaway]'); await page.waitForTimeout(1200);
const cut = await t3();
check('Section cuts the motor housing and frames the motor', cut.cutaway === 'on' && +cut.camera.split(',')[2] < 600, cut.camera);
await shot('twin-3d-section');
await page.click('[data-testid=t3-cutaway]'); await page.click('[data-testid=t3-reset]'); await settle();
// a lost graphics context is reported, then recovered
await page.evaluate(() => { window.__tqLose = document.querySelector('.tq-t3-canvas').getContext('webgl2').getExtension('WEBGL_lose_context'); window.__tqLose.loseContext(); });
await page.waitForTimeout(500);
const lostShown = (await t3()).status === 'lost' && (await page.locator('.tq-t3-lost[role=alert]').count()) === 1;
await page.evaluate(() => window.__tqLose.restoreContext());
await page.locator('[data-testid=twin-model][data-status=ready]').waitFor({ timeout: 8000 }).catch(() => {});
check('a lost graphics context is reported and recovered', lostShown && (await t3()).status === 'ready');
await page.click('[data-testid=twin-view-2d]');
const is2d = await page.evaluate(() => document.querySelector('[data-testid=twin-model]')?.tagName.toLowerCase() === 'svg' && !document.querySelector('.tq-t3-canvas'));
await page.click('[data-testid=twin-view-3d]');
await page.locator('[data-testid=twin-model][data-status=ready]').waitFor({ timeout: 15000 });
check('the 2D drawing can be chosen instead, and the 3D view comes back', is2d);
// remounting the page must not leak WebGL contexts or GPU geometry
await page.waitForTimeout(600);
const geo0 = +(await t3()).geometries;
for (let i = 0; i < 6; i++) {
  await nav('Overview');
  await nav('Digital Twin');
  await page.locator('[data-testid=twin-model][data-status=ready]').waitFor({ timeout: 15000 });
}
await page.waitForTimeout(600);
const canvases = await page.evaluate(() => document.querySelectorAll('canvas.tq-t3-canvas').length);
const geo1 = +(await t3()).geometries;
check('six remounts leave one canvas and the same GPU geometry count', canvases === 1 && geo1 === geo0 && !consoleMsgs.concat(threeWarnings).some((m) => /too many active webgl contexts/i.test(m)), `canvases ${canvases}, geometries ${geo0} -> ${geo1}`);

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
check('no Three.js / WebGL warnings', threeWarnings.length === 0, threeWarnings.join(' | ').slice(0, 300));
console.log(res.join('\n'));
await browser.close();
process.exit(res.some((r) => r.startsWith('FAIL')) ? 1 : 0);
