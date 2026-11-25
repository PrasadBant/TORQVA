import { describe, it, expect } from 'vitest';
import { decimateMinMax } from '../shared/charts.jsx';

describe('decimateMinMax', () => {
  it('returns original points if length is within maxPoints limit', () => {
    const pts = [{ t: 1, v: 10 }, { t: 2, v: 20 }, { t: 3, v: 15 }];
    expect(decimateMinMax(pts, 300)).toEqual(pts);
  });

  it('preserves true min, max and does not hide null gaps', () => {
    const raw = [];
    for (let i = 0; i < 1000; i++) {
      let val = 100 + Math.sin(i / 10) * 10;
      if (i === 50) val = 999.0; // Extreme peak
      if (i === 120) val = -50.0; // Extreme valley
      if (i === 300) val = null;  // Outage gap
      raw.push({ t: i, v: val });
    }

    const decimated = decimateMinMax(raw, 100);
    expect(decimated.length).toBeLessThan(raw.length);
    expect(decimated.length).toBeLessThanOrEqual(150);

    // Peak preserved
    const maxVal = Math.max(...decimated.filter((p) => p.v !== null).map((p) => p.v));
    expect(maxVal).toBe(999.0);

    // Valley preserved
    const minVal = Math.min(...decimated.filter((p) => p.v !== null).map((p) => p.v));
    expect(minVal).toBe(-50.0);

    // Gap preserved
    const hasGap = decimated.some((p) => p.v === null);
    expect(hasGap).toBe(true);
  });
});
