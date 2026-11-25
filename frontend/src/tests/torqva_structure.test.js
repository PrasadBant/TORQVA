// Guards the source layout described in the README: physical-device pages and simulator pages never import each other, and the chart library is
// imported only by shared/charts.jsx (so it stays out of the initial bundle).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = (dir) => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
  const relative = path.join(dir, entry.name);
  if (entry.isDirectory()) return entry.name === 'tests' ? [] : files(relative);
  return /\.jsx?$/.test(entry.name) ? [path.join(ROOT, relative)] : [];
});
const imports = (file) => [...fs.readFileSync(file, 'utf8').matchAll(/(?:from\s+|import\s*\(\s*|import\s+)['"]([^'"]+)['"]/g)].map((m) => m[1]);
const resolved = (file) => imports(file).filter((s) => s.startsWith('.')).map((s) => path.relative(ROOT, path.resolve(path.dirname(file), s)).replace(/\\/g, '/'));

describe('frontend source layout', () => {
  it('physical and simulation pages do not import each other or the app shell', () => {
    for (const [dir, other] of [['pages/physical', 'pages/simulation'], ['pages/simulation', 'pages/physical']]) {
      for (const f of files(dir)) {
        const deps = resolved(f);
        expect(deps.filter((d) => d.startsWith(`${other}/`)), path.relative(ROOT, f)).toEqual([]);
        expect(deps.filter((d) => d === 'app/TorqvaApp.jsx'), path.relative(ROOT, f)).toEqual([]);
      }
    }
  });

  it('every relative import points at an existing file', () => {
    for (const f of files('.')) for (const d of resolved(f)) expect(fs.existsSync(path.join(ROOT, d)), `${path.relative(ROOT, f)} -> ${d}`).toBe(true);
  });

  it('only shared/charts.jsx imports recharts', () => {
    const users = files('.').filter((f) => imports(f).includes('recharts')).map((f) => path.relative(ROOT, f).replace(/\\/g, '/'));
    expect(users).toEqual(['shared/charts.jsx']);
  });
});
