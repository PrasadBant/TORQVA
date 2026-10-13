import React, { createContext, useContext, useId } from 'react';
import { AlertTriangle, CheckCircle2, ShieldAlert, Info, XOctagon, Clock, XCircle, FlaskConical, Inbox, Loader2, AlertCircle, ArrowRight } from 'lucide-react';

/** Where the current page sits in the navigation (icon and group), provided by the application shell. */
export const NavContext = createContext(null);
export const useNavContext = () => useContext(NavContext);

/** TORQVA mark: a dial with a needle (monitoring) on the brand gradient. */
export function Logo({ size = 30 }) {
  const id = `tqlg${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  return (
    <svg className="tq-logo" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <defs><linearGradient id={id} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#4D74F0" /><stop offset="1" stopColor="#7A5AF0" /></linearGradient></defs>
      <rect width="32" height="32" rx="8" fill={`url(#${id})`} />
      <path d="M16 7.5a8.5 8.5 0 1 1-8.05 5.75" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" />
      <path d="M16 16 10.6 11.6" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" />
      <circle cx="16" cy="16" r="2.6" fill="#fff" />
    </svg>
  );
}

/** Page title row: the section icon from the navigation, title, subtitle and right-aligned status. */
export function PageHead({ title: t, sub, right }) {
  const I = useNavContext()?.icon;
  return (
    <div className="tq-page-head">
      <div className="tq-page-head-main">
        {I && <span className="tq-page-icon" aria-hidden="true"><I size={20} /></span>}
        <div><h2>{t}</h2>{sub && <p>{sub}</p>}</div>
      </div>
      <div className="tq-row">{right}</div>
    </div>
  );
}

/** A "go to the page with the details" action at the foot of a summary card. */
export function CardLink({ onClick, children }) {
  return <div className="tq-card-foot"><button className="tq-link" onClick={onClick}>{children}<ArrowRight size={14} aria-hidden="true" /></button></div>;
}

export function Tabs({ tabs, value, onChange, label }) {
  return (
    <div className="tq-tabs" role="tablist" aria-label={label}>
      {tabs.map(([k, name]) => (
        <button key={k} role="tab" className="tq-tab" aria-selected={value === k} onClick={() => onChange(k)}>{name}</button>))}
    </div>
  );
}

/** Persistent, non-dismissable. TORQVA only serves simulated data in this build. */
export function SimulationBanner({ mode = 'SIMULATION', physical = false }) {
  return (
    <div className={`tq-banner ${physical ? 'tq-banner--warn' : ''}`.trim()} role="status" aria-live="polite" data-testid="sim-banner">
      <FlaskConical size={15} aria-hidden="true" />
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

/** Empty and loading states: say what is missing and when it will appear. */
export function Empty({ children, loading = false }) {
  const I = loading ? Loader2 : Inbox;
  return <p className="tq-empty"><I size={16} aria-hidden="true" className={loading ? 'tq-spin' : undefined} />{children}</p>;
}
export function ErrorBox({ error }) {
  return error ? <p className="tq-error" role="alert"><AlertCircle size={16} aria-hidden="true" />{String(error.message || error)}</p> : null;
}

/** Shared chart styling so every Recharts chart reads as one system and follows the theme tokens. */
export const AXIS = { tick: { fontSize: 11, fill: 'var(--tq-muted)' }, tickLine: false, axisLine: { stroke: 'var(--tq-border)' } };
export const GRID = { stroke: 'var(--tq-grid)', strokeDasharray: '3 4', vertical: false };
export const TOOLTIP = {
  contentStyle: { background: 'var(--tq-s1)', border: '1px solid var(--tq-border)', borderRadius: 8, fontSize: 12, color: 'var(--tq-text)', padding: '8px 10px' },
  labelStyle: { color: 'var(--tq-muted)', marginBottom: 4 },
  itemStyle: { padding: 0 },
  cursor: { stroke: 'var(--tq-border-strong)', strokeDasharray: '3 3' },
};
export const LEGEND = { iconType: 'plainline', iconSize: 16, wrapperStyle: { fontSize: 12, paddingTop: 6 } };

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
