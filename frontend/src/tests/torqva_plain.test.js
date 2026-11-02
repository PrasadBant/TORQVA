import { describe, it, expect } from 'vitest';
import { plainText, plainify } from '../torqva/shared/plain.js';

describe('product wording for backend text', () => {
  it('replaces internal layer ids in prose with the product names', () => {
    expect(plainText('C5 decides from fresh windows after the ack.')).toBe('Recovery Verification decides from fresh windows after the ack.');
    expect(plainText('C2 predictions are conditional on a ranking')).toBe('predictions are conditional on a ranking');
    expect(plainText('No C2/C4 study result found')).toBe('No prediction and diagnostic-test study result found');
    expect(plainText('refused by the C3 path: stale')).toBe('refused by the analyst approval path: stale');
  });
  it('never touches identifiers, keys or text without a layer id', () => {
    expect(plainText('C1')).toBe('C1');
    expect(plainText('C12 bearing')).toBe('C12 bearing');
    const v = plainify({ layers: { C1: { status: 'NOT AVAILABLE', reason: 'C1 needs vibration RMS' } }, layer: 'C2', n: 3 });
    expect(Object.keys(v.layers)).toEqual(['C1']);
    expect(v.layer).toBe('C2');
    expect(v.n).toBe(3);
    expect(v.layers.C1.reason).toBe('Anomaly Detection needs vibration RMS');
  });
});
