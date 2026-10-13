import React from 'react';
import { Card, Empty, ErrorBox, Pill, ProvBadge, fmt } from '../shared/components.jsx';

const STATUS_TONE = { supported: 'ok', unsupported: 'crit', insufficiently_validated: 'warn' };
const STATUS_TEXT = {
  supported: 'supported', unsupported: 'unsupported — not used for decisions', insufficiently_validated: 'insufficiently validated',
};
export const TEST_INFO = {
  T1: 'Speed-step (to 70 % for 40 s): separates imbalance from looseness, and looseness from a faulty vibration channel.',
  T3: 'Thermal observation (up to 300 s): separates a cooling failure from an overload.',
  T4: 'Coast-down (driver disabled): separates friction/overload from cooling or electrical faults.',
};

export function StatusPill({ status }) {
  return <Pill tone={STATUS_TONE[status] || 'info'}>{STATUS_TEXT[status] || status || 'supported'}</Pill>;
}

/** Predicted (PRED) vs subsequently observed (SIM) values. Never a recovery verdict. */
export function PredictionChecks({ checks = [] }) {
  const c = checks[checks.length - 1];
  return (
    <Card title="Predicted vs observed (simulated)" id="c-predcheck" right={<><ProvBadge kind="PREDICTED" /> <ProvBadge kind="SIMULATED" /></>}>
      <p className="tq-warnbox" role="note">Observed values are simulated telemetry, not measurements. This comparison is not a recovery verdict, and a prediction that happened to be
        right does not validate the model.</p>
      {!c ? <Empty>No comparison yet. One is recorded when an executed action has been observed long enough.</Empty> : c.comparison === 'none' ? (
        <p data-testid="pc-none"><Pill tone="info">no comparison</Pill> {c.action?.replaceAll('_', ' ')} was not executed by the device (rejected, aborted, or a different action ran), so nothing is compared.</p>
      ) : (
        <>
          <p className="tq-muted">{c.action?.replaceAll('_', ' ')} · interval method {c.interval_method} · <StatusPill status={c.status} /> · horizons reached:{' '}
            <span className="tq-num">{(c.horizons_reached || []).join(', ') || 'none yet'}</span>{c.covered_fraction != null && <> · inside interval: <strong className="tq-num">{fmt(c.covered_fraction * 100, 0)}%</strong></>}</p>
          {c.comparison === 'no_horizon_reached' ? <Empty>The first horizon (30 s) has not been reached yet.</Empty> : (
            <table className="tq-table"><caption className="tq-sr">Predicted versus observed</caption>
              <thead><tr><th scope="col">Signal</th><th scope="col">Horizon</th><th scope="col">Predicted (90 % interval)</th><th scope="col">Observed</th><th scope="col">Inside</th></tr></thead>
              <tbody>{c.rows.map((r, i) => (
                <tr key={i}><td>{r.signal.replace('_', ' ')}</td><td className="tq-num">{r.horizon_s} s</td>
                  <td className="tq-num">{fmt(r.predicted, 3)} ({fmt(r.lo, 3)}–{fmt(r.hi, 3)})</td><td className="tq-num">{fmt(r.observed, 3)}</td>
                  <td>{r.covered ? <Pill tone="ok">yes</Pill> : <Pill tone="warn">no</Pill>}</td></tr>))}</tbody></table>)}
        </>)}
    </Card>
  );
}

/** Why a test was recommended, what it returned, or why it was aborted. A test never forces a diagnosis. */
export function DiagnosticTests({ log = [] }) {
  const rows = [];
  for (const l of log) {
    if (l.kind === 'gate' && l.test) rows.push({ k: `g${l.t}`, t: l.t, kind: 'recommended', test: l.test, text: l.reason });
    else if (l.kind === 'test_result') {
      const [top, p] = l.posterior?.[0] || [];
      rows.push({ k: `r${l.t}`, t: l.t, kind: p >= 0.7 ? 'result' : 'inconclusive', test: l.test, text: `top hypothesis ${String(top).replace('_', ' ')} at ${fmt((p || 0) * 100, 0)} %` });
    } else if (l.kind === 'test_aborted') rows.push({ k: `a${l.t}`, t: l.t, kind: 'aborted', test: '', text: `${l.status}${l.reason ? ` — ${l.reason}` : ''}` });
  }
  const tone = { recommended: 'wait', result: 'ok', inconclusive: 'warn', aborted: 'crit' };
  return (
    <Card title="Diagnostic tests (C4)" id="c-tests">
      <p className="tq-muted">A test only runs after the Safety Supervisor allows it (and, in hardware mode, a person approves). An aborted test produces no diagnosis; an
        ambiguous result stays <em>inconclusive</em>.</p>
      {!rows.length ? <Empty>No diagnostic test has been recommended in this session.</Empty> : (
        <table className="tq-table"><caption className="tq-sr">Diagnostic test history</caption>
          <thead><tr><th scope="col">t (s)</th><th scope="col">What</th><th scope="col">Test</th><th scope="col">Detail</th></tr></thead>
          <tbody>{rows.slice(-8).map((r) => (
            <tr key={r.k}><td className="tq-num">{fmt(r.t, 0)}</td><td><Pill tone={tone[r.kind]}>{r.kind}</Pill></td>
              <td>{r.test}{r.test && TEST_INFO[r.test] ? <span className="tq-muted"> — {TEST_INFO[r.test]}</span> : null}</td><td>{r.text}</td></tr>))}</tbody></table>)}
    </Card>
  );
}

const pct = (v) => (v == null ? '—' : `${fmt(v * 100, 1)}%`);

/** Phase 10 validation status: C2 interval coverage per regime and C4 test value, with the limitations spelled out. */
export function C2C4Validation({ data, error }) {
  if (error && !data) return <Card title="C2 / C4 validation (Phase 10)" id="c-c2c4"><Empty>No C2/C4 study result available ({String(error.message)}).</Empty></Card>;
  if (!data || !data.c2) return null;
  const regs = Object.keys(data.c2.control || {});
  const variants = [['control', 'shipped C2'], ['noise_aware', 'noise-aware C2 (opt-in)']];
  const real = data.c4_realistic_v2 || data.c4_realistic_v1 || {};
  const label = data.c4_realistic_v2 ? 'fresh seeds, v2' : 'v1';
  return (
    <Card title="C2 / C4 validation (Phase 10)" id="c-c2c4" className="tq-span" right={<ProvBadge kind="SIMULATED" />}>
      <p className="tq-warnbox" role="note">{data.WARNING}</p>
      <Pill tone="warn">unvalidated against hardware</Pill>
      <h4>C2: coverage of the intervals actually returned (target 90 %)</h4>
      <table className="tq-table"><caption className="tq-sr">C2 interval coverage by regime</caption>
        <thead><tr><th scope="col">Regime</th>{variants.map(([k, n]) => <th scope="col" key={k}>{n}</th>)}<th scope="col">Width (norm.) control → candidate</th></tr></thead>
        <tbody>{regs.map((rg) => (
          <tr key={rg}><td>{rg.replaceAll('_', ' ')}</td>
            {variants.map(([k]) => { const e = data.c2[k][rg]; return (
              <td key={k} className="tq-num">{pct(e.coverage)} <span className="tq-muted">[{pct(e.coverage_ci95[0])}–{pct(e.coverage_ci95[1])}] · abstains {pct(1 - e.trusted_frac)}</span></td>); })}
            <td className="tq-num">{fmt(data.c2.control[rg].mean_width_norm, 2)} → {fmt(data.c2.noise_aware[rg].mean_width_norm, 2)}</td></tr>))}</tbody></table>
      <h4>C4: what a speed-step test changes (looseness vs sensor fault, after C1 evidence; {label})</h4>
      <table className="tq-table"><caption className="tq-sr">C4 diagnostic value</caption>
        <thead><tr><th scope="col">Regime</th><th scope="col">Model</th><th scope="col">No test</th><th scope="col">After test</th><th scope="col">Inconclusive</th><th scope="col">Confidently wrong</th></tr></thead>
        <tbody>{Object.entries(real).flatMap(([rg, v]) => Object.entries(v).filter(([m, a]) => a.n && ['control', 'style_aware', 'style_aware_guarded'].includes(m)).map(([m, a]) => (
          <tr key={rg + m}><td>{rg}</td><td>{m.replaceAll('_', ' ')}</td><td className="tq-num">{pct(a.no_test_top1)}</td><td className="tq-num">{pct(a.accuracy_after)}</td>
            <td className="tq-num">{pct(a.inconclusive)}</td><td className="tq-num">{pct(a.confident_wrong)}</td></tr>)))}</tbody></table>
      {data.phase11?.c2_conditional && (<>
        <h4>Phase 11 (opt-in, not adopted by default): class-conditional C2 coverage, overload and worst fault, fresh seeds</h4>
        <table className="tq-table"><caption className="tq-sr">Phase 11 class-conditional C2 coverage</caption>
          <thead><tr><th scope="col">Regime</th><th scope="col">Cases</th><th scope="col">Coverage</th><th scope="col">Overload</th><th scope="col">Trusted</th><th scope="col">Coverage when trusted</th></tr></thead>
          <tbody>{Object.entries(data.phase11.c2_conditional.variants.class_conditional || {}).map(([rg, e]) => (
            <tr key={rg}><td>{rg.replaceAll('_', ' ')}</td><td className="tq-num">{e.n_cases}</td>
              <td className="tq-num">{pct(e.coverage)} <span className="tq-muted">[{pct(e.coverage_ci95[0])}–{pct(e.coverage_ci95[1])}]</span></td>
              <td className="tq-num">{pct(e.overload)}</td><td className="tq-num">{pct(e.trusted_frac)}</td><td className="tq-num">{pct(e.coverage_when_trusted)}</td></tr>))}</tbody></table>
        <p className="tq-muted">C4 calibration: {data.phase11.c4_calibration?.adopted ? 'adopted' : 'NOT adopted (failed the pre-registered validation bar)'}; shipped C4 behaviour is unchanged.</p>
      </>)}
      <h4>Limitations</h4>
      <ul className="tq-list">{(data.limitations || []).map((l) => <li key={l}>{l}</li>)}</ul>
    </Card>
  );
}
