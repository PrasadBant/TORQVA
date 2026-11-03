// Shared chart rules (shared/charts.jsx): one precision per chart for ticks and tooltips, units shown, intervals as ranges, a missing value never
// turned into a number. These are display rules only: no metric changes meaning.
import { describe, it, expect } from 'vitest';
import { fixed, tipValue } from '../torqva/shared/charts.jsx';

describe('chart value formatting', () => {
  it('uses the chart precision on ticks, and no decimals on large axis values', () => {
    expect(fixed(24.5, 1, true)).toBe('24.5');                 // was 24.50: the axis forced two decimals
    expect(fixed(50, 0, true)).toBe('50');                     // rpm below 100 was 50.00
    expect(fixed(0.0734, 3, true)).toBe('0.073');
    expect(fixed(1795.4, 0, true)).toBe('1795');
    expect(fixed(1795.4, 2, true)).toBe('1795');               // >= 100 on an axis: no decimals
    expect(fixed(1795.4, 2)).toBe('1795.40');                  // tooltips keep the chart precision
  });
  it('tooltips carry the unit, show an interval as a range, and never invent a value', () => {
    expect(tipValue(1.23456, 2, 'A')).toBe('1.23 A');
    expect(tipValue([29.04, 31.19], 1, '°C')).toBe('29.0–31.2 °C');
    expect(tipValue(null, 2, 'A')).toBe('—');
    expect(tipValue(undefined, 2)).toBe('—');
    expect(tipValue(Number.NaN, 2, 'A')).toBe('—');             // not a finite number: missing, never formatted into a reading
    expect(tipValue(Number.POSITIVE_INFINITY, 2, 'A')).toBe('—');
    expect(tipValue([1, null], 2)).toEqual([1, null]);          // an incomplete interval is not drawn as a range
  });
});
