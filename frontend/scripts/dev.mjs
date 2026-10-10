// `npm run dev`: starts the TORQVA backend (software simulator, no hardware) and the Vite dev server together.
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
const children = [];

const run = (cmd, args, opts, label) => {
  const c = spawn(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' && cmd === 'npx', ...opts });
  c.on('error', (e) => console.error(`[${label}] failed to start: ${e.message}`));
  c.on('exit', (code) => { if (label === 'frontend') shutdown(code ?? 0); else console.error(`[${label}] exited (${code}). The app will show a "Backend unreachable" warning until it is restarted.`); });
  children.push(c);
};
const shutdown = (code = 0) => { children.forEach((c) => { try { c.kill(); } catch { /* already gone */ } }); process.exit(code); };
process.on('SIGINT', () => shutdown(0)); process.on('SIGTERM', () => shutdown(0));

console.log('TORQVA: starting backend (simulation mode) on http://127.0.0.1:8000 and the app on http://localhost:5173');
run(python, ['-m', 'uvicorn', 'main:app', '--host', '127.0.0.1', '--port', '8000'], { cwd: backendDir, env: { ...process.env, TORQVA_TOKENS: tokens } }, 'backend');
run('npx', ['vite'], { cwd: path.resolve(here, '..'), env: { ...process.env, VITE_TORQVA_DEV_TOKEN: TOKEN } }, 'frontend');
