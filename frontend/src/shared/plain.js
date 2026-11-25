// User-facing wording for text the backend writes. The backend's messages (reasons, notes, summaries, limitations) still name its internal
// layers C1–C6; the interface never shows those identifiers. Only prose is rewritten: a string must contain a space, so bare keys and
// values such as 'C1' (layer ids the code matches on) are never touched, and object keys are left as they are.

const NAMES = { 1: 'Anomaly Detection', 2: 'Failure Prediction', 3: 'Action Recommendations', 4: 'Diagnostic Investigation', 5: 'Recovery Verification', 6: 'Continuous Intelligence' };
// Phrases that read better than a plain substitution, applied first.
const PHRASES = [
  [/\bC2\s*\/\s*C4\b/g, 'prediction and diagnostic-test'],
  [/\bC1\s*\/\s*C2\b/g, 'anomaly detection and prediction'],
  [/\bC1 score\b/g, 'anomaly severity'],
  [/\bC1 threshold\b/g, 'anomaly threshold'],
  [/\bC2 predictions\b/g, 'predictions'],
  [/\bC2 prediction\b/g, 'prediction'],
  [/\bC2's\b/g, "the predictor's"],
  [/\bC2 predictor\b/g, 'predictor'],
  [/\bC5 recovery\b/g, 'recovery'],
  [/\bC5 verdict\b/g, 'recovery verdict'],
  [/\bthe C3 analyst path\b/g, 'the analyst approval path'],
  [/\bthe C3 path\b/g, 'the analyst approval path'],
];
const ID = /\bC([1-6])\b/g;

/** One string in plain product language. Strings without a space (identifiers) are returned unchanged. */
export function plainText(s) {
  if (typeof s !== 'string' || !s.includes(' ') || !/\bC[1-6]\b/.test(s)) return s;
  let out = s;
  for (const [re, to] of PHRASES) out = out.replace(re, to);
  return out.replace(ID, (_, n) => NAMES[n]);
}

/** An identifier shown as a label (an audit event kind such as "c2_ranking"): words, first letter capitalised, any layer id written as its
 *  product name ("Failure Prediction ranking"). Use only for display; the identifier itself is never changed. */
export function plainLabel(k) {
  const words = String(k ?? '').replaceAll('_', ' ').trim().replace(/\b[cC]([1-6])\b/g, 'C$1');
  const out = plainText(`${words} `).trim();
  return out ? out[0].toUpperCase() + out.slice(1) : out;
}

/** A parsed API response with every prose string rewritten by plainText. Arrays and objects are copied; keys are kept. */
export function plainify(v) {
  if (typeof v === 'string') return plainText(v);
  if (Array.isArray(v)) return v.map(plainify);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v)) o[k] = plainify(v[k]);
    return o;
  }
  return v;
}
