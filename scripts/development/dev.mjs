// `npm run dev`: starts the TORQVA backend and the Vite dev server together.
// `npm run dev:sim` (this script with --sim): the software-only path. The backend never scans for, opens or unlocks a USB device, so nothing in this
// session can reach physical hardware; use it for development and automated checks.
// The local token below is a development-only constant: it is hashed into TORQVA_TOKENS for this one local backend process and handed to the dev
// server so the app signs in automatically. It is not used by production builds (the frontend ignores it unless import.meta.env.DEV) and the
// backend's authorization is unchanged. Use `npm run dev:ui` to run only the frontend against your own backend.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoDir = path.resolve(here, '..', '..');
const backendDir = path.join(repoDir, 'backend');
const frontendDir = path.join(repoDir, 'frontend');
const TOKEN = process.env.TORQVA_DEV_TOKEN || 'torqva-local-dev-token';
const tokens = JSON.stringify([{ sha256: createHash('sha256').update(TOKEN).digest('hex'), user: 'local-dev', role: 'admin' }]);
const python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const simOnly = process.argv.includes('--sim');
const lanMode = process.argv.includes('--lan');
const children = [];

const detectedLanHost = () => {
  const candidates = [];
  for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
    if (/vmware|virtual|wsl|hyper-v|loopback|vpn/i.test(name)) continue;
    for (const a of addresses || []) if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) candidates.push(a.address);
  }
  return candidates[0] || '';
};
const lanHost = process.env.TORQVA_LAN_HOST || (lanMode ? detectedLanHost() : '');
if (lanMode && (net.isIP(lanHost) !== 4 || lanHost.startsWith('127.'))) {
  console.error('LAN mode needs TORQVA_LAN_HOST set to this PC\'s reachable Wi-Fi/Ethernet IPv4 address.');
  process.exit(2);
}

let stopping = false;
const run = (cmd, args, opts, label) => {
  const c = spawn(cmd, args, { stdio: ['ignore', 'inherit', 'inherit'], ...opts });
  c.on('error', (e) => { console.error(`[${label}] failed to start: ${e.message}`); if (label === 'frontend') shutdown(1); });
  c.on('exit', (code, signal) => {
    if (stopping) return;
    const how = signal ? `signal ${signal}` : `code ${code}`;
    if (label === 'frontend') {
      // Say why everything stops, and never report a killed dev server as success: its own exit code is passed on, a signal becomes 1.
      console.error(`[frontend] the Vite dev server exited (${how}); stopping the backend as well.`);
      shutdown(signal ? 1 : code);
    } else console.error(`[${label}] exited (${how}). The app will show a "Backend unreachable" warning until it is restarted.`);
  });
  children.push(c);
};
// On Windows the frontend runs as cmd.exe -> npx -> vite: killing only the cmd.exe wrapper would leave the dev server running and holding
// port 5173, so the whole process tree is ended there.
const stopChild = (c) => {
  if (c.exitCode !== null || c.signalCode !== null || !c.pid) return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(c.pid), '/T', '/F'], { stdio: 'ignore' });
    else c.kill();
  } catch { /* already gone */ }
};
const shutdown = (code = 0) => { if (stopping) return; stopping = true; children.forEach(stopChild); process.exit(code); };
process.on('SIGINT', () => shutdown(0)); process.on('SIGTERM', () => shutdown(0));

let backendEnv;
if (simOnly) {
  // Remove anything inherited from the shell that could open a port or relax an interlock.
  const { TORQVA_DEVICE_PORT, TORQVA_FORCE_UNLOCK, TORQVA_DEVICE_LINK, ...rest } = process.env;   // no USB port and no Wi-Fi device link
  backendEnv = { ...rest, TORQVA_TOKENS: tokens, TORQVA_AUTOCONNECT: '0' };
  console.log('TORQVA (software only): backend on http://127.0.0.1:8000 with no device access, app on http://localhost:5173');
} else if (lanMode) {
  const secretsRoot = process.env.TORQVA_SECRETS_DIR || path.join(process.env.LOCALAPPDATA || os.homedir(), 'Torqva', 'secrets');
  const tlsDir = path.join(secretsRoot, 'tls');
  const cert = process.env.TORQVA_TLS_CERT || path.join(tlsDir, 'gateway_cert.pem');
  const key = process.env.TORQVA_TLS_KEY || path.join(tlsDir, 'gateway_key.pem');
  const releasePub = process.env.TORQVA_OTA_PUBLIC_KEY || path.join(secretsRoot, 'signing', 'release_public_key.pem');
  for (const [label, file] of [['gateway certificate', cert], ['gateway private key', key], ['release public key', releasePub]]) {
    if (!fs.existsSync(file)) {
      console.error(`LAN mode cannot start: ${label} is missing at ${file}. Run: python scripts/setup/provision_wireless.py --ip ${lanHost}`);
      process.exit(2);
    }
  }
  const lanOrigin = `http://${lanHost}:5173`;
  const cors = process.env.TORQVA_CORS_ORIGINS || `http://localhost:5173,http://127.0.0.1:5173,${lanOrigin}`;
  backendEnv = {
    ...process.env,
    TORQVA_TOKENS: tokens,
    TORQVA_DEVICE_LINK: '1',
    TORQVA_AUTOCONNECT: process.env.TORQVA_AUTOCONNECT || '0',
    TORQVA_CORS_ORIGINS: cors,
    TORQVA_FRONTEND_PUBLIC_URL: lanOrigin,
    TORQVA_OTA_PUBLIC_BASE_URL: process.env.TORQVA_OTA_PUBLIC_BASE_URL || `https://${lanHost}:8443`,
    TORQVA_OTA_PUBLIC_KEY: releasePub,
  };
  console.log(`TORQVA LAN: app ${lanOrigin}, API http://${lanHost}:8000, authenticated ESP32 gateway https://${lanHost}:8443`);
  run(python, [path.join(repoDir, 'scripts', 'development', 'ota_https_gateway.py'), 'serve', '--ip', lanHost, '--port', '8443', '--cert', cert, '--key', key, '--backend', 'http://127.0.0.1:8000'], { cwd: repoDir, env: process.env }, 'gateway');
} else {
  // Physical mode accepts the authenticated device Wi-Fi link as well as USB recovery.
  backendEnv = { ...process.env, TORQVA_TOKENS: tokens, TORQVA_DEVICE_LINK: '1' };
  console.log('TORQVA: starting backend on http://127.0.0.1:8000 and the app on http://localhost:5173 (connects to a TORQVA board if exactly one is plugged in)');
}
const viteBin = path.join(frontendDir, 'node_modules', 'vite', 'bin', 'vite.js');
run(python, ['-m', 'uvicorn', 'main:app', '--host', process.env.TORQVA_BACKEND_BIND || '0.0.0.0', '--port', '8000', '--reload'], { cwd: backendDir, env: backendEnv }, 'backend');
run(process.execPath, [viteBin, '--host', process.env.TORQVA_FRONTEND_BIND || '0.0.0.0'], { cwd: frontendDir, env: { ...process.env, VITE_TORQVA_DEV_TOKEN: TOKEN } }, 'frontend');
