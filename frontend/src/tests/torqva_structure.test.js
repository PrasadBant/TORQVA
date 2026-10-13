// Guards the source layout described in the README: physical-device pages and simulator pages never import each other, and the chart library is
// imported only by shared/charts.jsx (so it stays out of the initial bundle).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'torqva');
const files = (dir) => fs.readdirSync(path.join(ROOT, dir)).filter((f) => /\.jsx?$/.test(f)).map((f) => path.join(ROOT, dir, f));
const imports = (file) => [...fs.readFileSync(file, 'utf8').matchAll(/(?:from\s+|import\s*\(\s*|import\s+)['"]([^'"]+)['"]/g)].map((m) => m[1]);
const resolved = (file) => imports(file).filter((s) => s.startsWith('.')).map((s) => path.relative(ROOT, path.resolve(path.dirname(file), s)).replace(/\\/g, '/'));

describe('frontend source layout', () => {
  it('physical/ and simulation/ depend only on shared/ and api.js, never on each other', () => {
    for (const [dir, other] of [['physical', 'simulation'], ['simulation', 'physical']]) {
      for (const f of files(dir)) {
        const deps = resolved(f);
        expect(deps.filter((d) => d.startsWith(`${other}/`)), path.relative(ROOT, f)).toEqual([]);
        expect(deps.filter((d) => d === 'TorqvaApp.jsx'), path.relative(ROOT, f)).toEqual([]);
      }
    }
  });

  it('every relative import points at an existing file', () => {
    for (const dir of ['.', 'shared', 'physical', 'simulation']) {
      for (const f of files(dir)) for (const d of resolved(f)) expect(fs.existsSync(path.join(ROOT, d)), `${path.relative(ROOT, f)} -> ${d}`).toBe(true);
    }
  });

  it('only shared/charts.jsx imports recharts', () => {
    const users = ['.', 'shared', 'physical', 'simulation'].flatMap(files).filter((f) => imports(f).includes('recharts')).map((f) => path.relative(ROOT, f).replace(/\\/g, '/'));
    expect(users).toEqual(['shared/charts.jsx']);
  });
});
