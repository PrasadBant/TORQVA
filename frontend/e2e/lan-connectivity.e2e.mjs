import { chromium } from 'playwright-core';

const host = process.env.TORQVA_LAN_HOST;
const token = process.env.TORQVA_TOKEN || 'torqva-local-dev-token';
if (!host) throw new Error('TORQVA_LAN_HOST is required');
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const page = await browser.newPage();
await page.goto(`http://${host}:5173/`, { waitUntil: 'domcontentloaded' });
const result = await page.evaluate(async ({ host, token }) => {
  const sameOrigin = await fetch('/api/health').then((r) => ({ ok: r.ok, cors: r.headers.get('access-control-allow-origin') }));
  const direct = await fetch(`http://${host}:8000/api/health`).then((r) => ({ ok: r.ok, cors: r.headers.get('access-control-allow-origin') }));
  const ws = await new Promise((resolve) => {
    const socket = new WebSocket(`ws://${host}:5173/api/torqva/ws`);
    const timer = setTimeout(() => { socket.close(); resolve({ ok: false, reason: 'timeout' }); }, 8000);
    socket.onopen = () => socket.send(JSON.stringify({ type: 'auth', token }));
    socket.onmessage = (event) => {
      let message; try { message = JSON.parse(event.data); } catch { return; }
      if (message.type === 'snapshot') { clearTimeout(timer); socket.close(); resolve({ ok: true, connection: message.data?.connection }); }
    };
    socket.onerror = () => { clearTimeout(timer); resolve({ ok: false, reason: 'socket error' }); };
  });
  return { sameOrigin, direct, ws };
}, { host, token });
await browser.close();
console.log(JSON.stringify(result));
if (!result.sameOrigin.ok || !result.direct.ok || !result.ws.ok) process.exitCode = 1;
