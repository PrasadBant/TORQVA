import React from 'react';
import { AlertTriangle, CheckCircle2, ShieldAlert, Info, XOctagon, Clock, XCircle, FlaskConical } from 'lucide-react';

/** Persistent, non-dismissable. TORQVA only serves simulated data in this build. */
export function SimulationBanner({ mode = 'SIMULATION', physical = false }) {
  return (
    <div className="tq-banner" role="status" aria-live="polite" data-testid="sim-banner">
      <FlaskConical size={16} aria-hidden="true" />
      <strong>{physical ? 'PHYSICAL DEVICE CONNECTED' : mode}</strong>
      {physical
        ? <span>A device is connected over USB. Simulated data is labelled SIM and device readings HW. Physical motor control is disabled; this is not hardware validation.</span>
        : <span>All values below are simulated. No physical motor is connected or controlled. Not hardware evidence.</span>}
    </div>
  );
}

const PROV = {
  SIMULATED: { cls: 'sim', text: 'SIM', title: 'Simulated value' },
  PREDICTED: { cls: 'pred', text: 'PRED', title: 'Model prediction, not a measurement' },
  MEASURED: { cls: 'real', text: 'HW', title: 'Measured on hardware' },
  DERIVED: { cls: 'derived', text: 'DERIVED', title: 'Computed from measured/simulated values' },
  HUMAN_CONFIRMED: { cls: 'human', text: 'HUMAN', title: 'Confirmed by a person' },
};
export function ProvBadge({ kind = 'SIMULATED' }) {
  const p = PROV[kind] || PROV.SIMULATED;
  return <span className={`tq-prov tq-prov-${p.cls}`} title={p.title} aria-label={p.title}>{p.text}</span>;
}

const TONE_ICON = { ok: CheckCircle2, warn: AlertTriangle, crit: ShieldAlert, info: Info, stop: XOctagon, wait: Clock, off: XCircle };
/** Status = colour + icon + text, never colour alone. */
export function Pill({ tone = 'info', children }) {
  const I = TONE_ICON[tone] || Info;
  return <span className={`tq-pill tq-${tone}`}><I size={13} aria-hidden="true" />{children}</span>;
}

export function stateTone(state) {
  if (!state) return 'off';
  if (['RECOVERED', 'CLOSED', 'NORMAL'].includes(state)) return 'ok';
  if (['EMERGENCY_STOP'].includes(state)) return 'stop';
  if (['HUMAN_INSPECTION_REQUIRED', 'UNRESOLVED', 'COMMAND_FAILED', 'SENSOR_UNRELIABLE'].includes(state)) return 'crit';
  if (['AWAITING_APPROVAL', 'AWAITING_ACK', 'AWAITING_MORE_DATA', 'DIAGNOSTIC_PROPOSED', 'VERIFYING_RECOVERY'].includes(state)) return 'wait';
  return 'info';
}

export function Card({ title, right, children, id, className = '' }) {
  return (
    <section className={`tq-card ${className}`.trim()} aria-labelledby={id}>
      <header><h3 id={id}>{title}</h3>{right}</header>
      {children}
    </section>
  );
}

export function Empty({ children }) { return <p className="tq-empty">{children}</p>; }
export function ErrorBox({ error }) { return error ? <p className="tq-error" role="alert">{String(error.message || error)}</p> : null; }

/** Posterior over fault hypotheses: bars with numbers, plus a confident/ambiguous/insufficient label. */
export function PosteriorBars({ ranked = [], label }) {
  if (!ranked.length) return <Empty>No hypothesis ranking yet. It appears once an anomaly has persisted.</Empty>;
  const tone = label === 'confident' ? 'ok' : label === 'ambiguous' ? 'warn' : 'info';
  return (
    <div>
      <Pill tone={tone}>{label || 'unknown'}</Pill>
      <ul className="tq-bars" aria-label="Fault hypothesis probabilities">
        {ranked.map(([h, p]) => (
          <li key={h}>
            <span className="tq-bar-label">{h.replace('_', ' ')}</span>
            <span className="tq-bar-track"><span className="tq-bar-fill" style={{ width: `${Math.max(0, Math.min(1, p)) * 100}%` }} /></span>
            <span className="tq-num">{(p * 100).toFixed(1)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export const fmt = (v, d = 1) => (v === null || v === undefined || Number.isNaN(v) ? '—' : Number(v).toFixed(d));
