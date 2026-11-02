// Checks that no backend text reaches the interface with an internal layer id (C1–C6) once the frontend's wording layer has run.
// Usage, against `npm run dev:sim` (software only, never a device): node scripts/check-layer-ids.mjs
// It reads the simulation and evaluation routes the pages poll; it starts nothing and sends no command.
import { plainify } from '../src/torqva/shared/plain.js';

const BASE = process.env.TORQVA_API || 'http://127.0.0.1:8000/api/torqva';
const TOKEN = process.env.TORQVA_DEV_TOKEN || 'torqva-local-dev-token';
const ROUTES = ['/status', '/telemetry?last=300', '/incidents', '/decisions', '/predictions', '/prediction-checks', '/commands', '/outcomes', '/cases', '/log',
  '/evaluation/latest', '/evaluation/c2c4', '/device/status', '/simulation/workbench/plan', '/simulation/workbench/trace', '/lab/regimes', '/lab/checklist',
  '/attestation/candidates', '/workflow/patterns?mode=SIMULATION', '/workflow/patterns?mode=PHYSICAL', '/workflow/runs?mode=SIMULATION'];
const ID = /\bC[1-6]\b/;

// Every string value (not key) still containing a layer id after plainify, with its JSON path.
function leftovers(v, path, out) {
  if (typeof v === 'string') { if (ID.test(v)) out.push(`${path}: ${v.slice(0, 120)}`); }
  else if (Array.isArray(v)) v.forEach((x, i) => leftovers(x, `${path}[${i}]`, out));
  else if (v && typeof v === 'object') for (const k of Object.keys(v)) leftovers(v[k], `${path}.${k}`, out);
  return out;
}

let bad = 0;
for (const r of ROUTES) {
  const res = await fetch(BASE + r, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!res.ok) { console.log(`skip ${r} (HTTP ${res.status})`); continue; }
  const raw = await res.json();
  // A bare id such as layer: 'C1' is a key the code matches on and is never displayed as text; only prose counts.
  const hits = leftovers(plainify(raw), r, []).filter((h) => / /.test(h.split(': ').slice(1).join(': ')));
  bad += hits.length;
  hits.slice(0, 5).forEach((h) => console.log('LEFT', h));
}
console.log(bad ? `${bad} prose string(s) still contain a layer id` : 'ok: no layer id left in backend prose');
process.exit(bad ? 1 : 0);
