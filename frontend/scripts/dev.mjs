// `npm run dev`: starts the TORQVA backend and the Vite dev server together.
// `npm run dev:sim` (this script with --sim): the software-only path. The backend never scans for, opens or unlocks a USB device, so nothing in this
// session can reach physical hardware; use it for development and automated checks.
// The local token below is a development-only constant: it is hashed into TORQVA_TOKENS for this one local backend process and handed to the dev
// server so the app signs in automatically. It is not used by production builds (the frontend ignores it unless import.meta.env.DEV) and the
// backend's authorization is unchanged. Use `npm run dev:ui` to run only the frontend against your own backend.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const backendDir = path.resolve(here, '..', '..', 'backend');
const TOKEN = process.env.TORQVA_DEV_TOKEN || 'torqva-local-dev-token';
const tokens = JSON.stringify([{ sha256: createHash('sha256').update(TOKEN).digest('hex'), user: 'local-dev', role: 'admin' }]);
const python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const simOnly = process.argv.includes('--sim');
const children = [];

const run = (cmd, args, opts, label) => {
  const c = spawn(cmd, args, { stdio: ['ignore', 'inherit', 'inherit'], shell: process.platform === 'win32' && cmd === 'npx', ...opts });
  c.on('error', (e) => console.error(`[${label}] failed to start: ${e.message}`));
  c.on('exit', (code) => { if (label === 'frontend') shutdown(code ?? 0); else console.error(`[${label}] exited (${code}). The app will show a "Backend unreachable" warning until it is restarted.`); });
  children.push(c);
};
const shutdown = (code = 0) => { children.forEach((c) => { try { c.kill(); } catch { /* already gone */ } }); process.exit(code); };
process.on('SIGINT', () => shutdown(0)); process.on('SIGTERM', () => shutdown(0));

let backendEnv;
if (simOnly) {
  // Remove anything inherited from the shell that could open a port or relax an interlock.
  const { TORQVA_DEVICE_PORT, TORQVA_FORCE_UNLOCK, ...rest } = process.env;
  backendEnv = { ...rest, TORQVA_TOKENS: tokens, TORQVA_AUTOCONNECT: '0' };
  console.log('TORQVA (software only): backend on http://127.0.0.1:8000 with no device access, app on http://localhost:5173');
} else {
  // Physical-first: the backend connects by itself when exactly one USB-serial board is present (or to TORQVA_DEVICE_PORT if you set it). No port is
  // assumed and no interlock is relaxed: START and speed stay subject to the commissioning record, the session check and the Safety Supervisor.
  backendEnv = { ...process.env, TORQVA_TOKENS: tokens };
  console.log('TORQVA: starting backend on http://127.0.0.1:8000 and the app on http://localhost:5173 (connects to a TORQVA board if exactly one is plugged in)');
  if (process.env.TORQVA_FORCE_UNLOCK === '1') {
    console.warn('TORQVA WARNING: TORQVA_FORCE_UNLOCK=1 is set in YOUR shell. It bypasses the commissioning record, the session check and Safety Supervisor refusals '
      + 'for a connected motor. This script never sets it; remove it from your environment unless you mean to do that.');
  }
}
run(python, ['-m', 'uvicorn', 'main:app', '--host', '127.0.0.1', '--port', '8000'], { cwd: backendDir, env: backendEnv }, 'backend');
run('npx', ['vite'], { cwd: path.resolve(here, '..'), env: { ...process.env, VITE_TORQVA_DEV_TOKEN: TOKEN } }, 'frontend');
