import React, { createContext, useContext, useEffect, useId, useRef, useState } from 'react';
import { Activity, AlertTriangle, CheckCircle2, ShieldAlert, Info, XOctagon, Clock, XCircle, FlaskConical, Inbox, Loader2, AlertCircle, ArrowRight, CircleDashed, CircleDot, HelpCircle, Lock } from 'lucide-react';

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

// The five motor-condition words used everywhere, each with one tone. A condition is only ever derived from records the app has;
// anything it cannot judge is Unavailable.
export const CONDITION_TONE = { Normal: 'ok', 'Investigation Required': 'warn', 'Action Verification': 'wait', Critical: 'stop', Unavailable: 'off' };

/** Compact motor-condition badge for page heads (the shell supplies the condition; the Overview shows the full banner instead). */
export function ConditionBadge({ c }) {
  if (!c) return null;
  return <span className="tq-cond-badge" data-testid="cond-badge" title={c.why}><Pill tone={CONDITION_TONE[c.status] || 'off'}>Motor: {c.status}</Pill></span>;
}

/** The Overview's lead: the motor condition, why, and one next step. */
export function ConditionBanner({ c, go, testid = 'ov-health', children }) {
  return (
    <section className={`tq-ov-health tq-ov-health--${CONDITION_TONE[c.status] || 'off'}`} data-testid={testid} aria-label="Motor condition">
      <span className="tq-ov-health-icon" aria-hidden="true"><Activity size={22} /></span>
      <div className="tq-ov-health-text">
        <span className="tq-ov-health-label">Motor condition</span>
        <strong data-testid={`${testid}-status`}>{c.status}</strong>
        <p>{c.why}</p>{children}
      </div>
      {c.next && go && <button type="button" className="tq-btn tq-primary" data-testid="ov-next" onClick={() => go(c.next[0])}>{c.next[1]}<ArrowRight size={14} aria-hidden="true" /></button>}
    </section>
  );
}

/** Page title row: the title, an optional short purpose, the motor-condition badge and right-aligned status. The sidebar names the
 *  section, so the head repeats neither the group nor the page name. */
export function PageHead({ title: t, sub, right, eyebrow }) {
  const nav = useNavContext();
  const I = nav?.icon;
  return (
    <div className="tq-page-head">
      <div className="tq-page-head-main">
        {I && <span className="tq-page-icon" aria-hidden="true"><I size={20} /></span>}
        <div>{eyebrow && <p className="tq-eyebrow">{eyebrow}</p>}<h2>{t}</h2>{sub && <p>{sub}</p>}</div>
      </div>
      <div className="tq-row"><ConditionBadge c={nav?.condition} />{right}</div>
    </div>
  );
}

/** A "go to the page with the details" action at the foot of a summary card. */
export function CardLink({ onClick, children }) {
  return <div className="tq-card-foot"><button className="tq-link" onClick={onClick}>{children}<ArrowRight size={14} aria-hidden="true" /></button></div>;
}

/** Inline text link that navigates (e.g. "View blockers →"). Always a real action: pass the shell's `go` or a handler. */
export function LinkButton({ onClick, children, testid }) {
  return <button type="button" className="tq-link" onClick={onClick} data-testid={testid}>{children}<ArrowRight size={14} aria-hidden="true" /></button>;
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
  COMMAND: { cls: 'derived', text: 'CMD', title: 'Commanded value reported by the device, not a measurement' },
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

/** One cell of a status strip (the physical dashboard's `.tq-summary` layout): icon, uppercase label, pills and an optional meta line. */
export function SummaryCell({ icon: I, tone = 'info', label, meta, children, testid }) {
  return (
    <div className="tq-summary-cell" data-testid={testid}>
      <span className={`tq-kpi-icon tq-${tone}`} aria-hidden="true">{I && <I size={15} />}</span>
      <span className="tq-summary-label">{label}</span>
      <div className="tq-row tq-wrap-pills">{children}</div>
      {meta ? <span className="tq-summary-meta tq-num">{meta}</span> : null}
    </div>
  );
}

/** Section card. `icon` sits before the title, `sub` is a one-line description under it, `foot` is a footer row (usually a LinkButton). */
export function Card({ title, right, children, id, className = '', icon: I, sub, foot, testid }) {
  return (
    <section className={`tq-card ${className}`.trim()} aria-labelledby={id} data-testid={testid}>
      <header>
        <div className="tq-card-title">{I && <span className="tq-card-icon" aria-hidden="true"><I size={16} /></span>}<div><h3 id={id}>{title}</h3>{sub && <p className="tq-card-sub">{sub}</p>}</div></div>
        {right}
      </header>
      {children}
      {foot && <div className="tq-card-foot">{foot}</div>}
    </section>
  );
}

/** Empty and loading states: say what is missing and when it will appear. */
/** Progressive disclosure for advanced detail (evidence, model internals, traces, audit records). Native <details>: keyboard and
 *  screen-reader operable, and its content stays in the page. Never use it for warnings, blockers, STOP or an authorization step. */
export function Disclosure({ summary, meta, children, testid, open = false, className = '' }) {
  // `open` OPENS the section when its content becomes relevant (a hold starts, a receipt is written); it never closes it: once open,
  // only the user collapses it, so a state change cannot fold away what someone is reading.
  const ref = useRef(null);
  useEffect(() => { if (open && ref.current) ref.current.open = true; }, [open]);
  return (
    <details ref={ref} className={`tq-disclosure ${className}`.trim()} data-testid={testid}>
      <summary><span className="tq-disclosure-title">{summary}</span>{meta && <span className="tq-disclosure-meta">{meta}</span>}</summary>
      <div className="tq-disclosure-body">{children}</div>
    </details>
  );
}

export function Empty({ children, loading = false, action }) {
  const I = loading ? Loader2 : Inbox;
  if (action) return <div className="tq-empty"><I size={16} aria-hidden="true" className={loading ? 'tq-spin' : undefined} /><span className="tq-empty-text">{children}</span><span className="tq-empty-action">{action}</span></div>;
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

/** Shared text helpers (one definition each; simulation and physical pages import them from here). */
export const title = (s) => String(s ?? '').replaceAll('_', ' ');
export const pct = (p, d = 0) => (p === null || p === undefined || !Number.isFinite(p) ? '—' : `${(p * 100).toFixed(d)}%`);
export const fmtRpm = (v) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? '—' : Math.round(Number(v)).toLocaleString('en-US'));
/** Roles that may operate the simulator or request an action (the backend enforces the same rule). */
export const canControl = (role) => role === 'operator' || role === 'admin';
export const fmt = (v, d = 1) => (v === null || v === undefined || Number.isNaN(v) ? '—' : Number(v).toFixed(d));

/* ================================================================== Design system v3 primitives (shared; owned by the lead).
   Every primitive renders only what it is given: none of them invents a status, a value or an action. */

const STATE_ICON = { ok: CheckCircle2, warn: AlertTriangle, crit: XCircle, fail: XCircle, stop: XOctagon, wait: Clock, info: Info, off: CircleDashed, pending: CircleDashed, unknown: HelpCircle };

/** Headline status tile (the tiles across the top of an overview): icon disc, label, value in words or numbers, a short detail line and
 *  an optional follow-up action. `tone` drives colour, but the value text always carries the meaning on its own. */
export function StatTile({ icon: I, tone = 'info', label, value, unit, sub, action, testid, children }) {
  return (
    <div className={`tq-stat tq-${tone}`} data-testid={testid}>
      <span className="tq-stat-icon" aria-hidden="true">{I ? <I size={18} /> : null}</span>
      <div className="tq-stat-body">
        <span className="tq-stat-label">{label}</span>
        <strong className="tq-stat-value tq-num">{value}{unit && <small className="tq-stat-unit">{unit}</small>}</strong>
        {sub && <span className="tq-stat-sub">{sub}</span>}
        {children}
        {action && <span className="tq-stat-action">{action}</span>}
      </div>
    </div>
  );
}
export function StatGrid({ children, label, testid }) {
  return <div className="tq-stats" role={label ? 'group' : undefined} aria-label={label} data-testid={testid}>{children}</div>;
}

const STEP_ICON = { done: CheckCircle2, active: CircleDot, blocked: XCircle, failed: XCircle, pending: CircleDashed, skipped: CircleDashed, waiting: Clock };
const STEP_WORD = { done: 'complete', active: 'in progress', blocked: 'blocked', failed: 'failed', pending: 'not started', skipped: 'skipped', waiting: 'waiting' };
/** Horizontal progress through ordered steps (commissioning, the analyst workflow ...). `state`: done | active | waiting | blocked | failed | pending | skipped.
 *  A step is drawn done only when the caller says so from real records. */
export function StepTracker({ steps = [], label = 'Progress', onSelect, testid }) {
  return (
    <ol className="tq-steps" aria-label={label} data-testid={testid}>
      {steps.map((s, i) => {
        const I = STEP_ICON[s.state] || CircleDashed;
        const inner = (<>
          <span className="tq-step-mark" aria-hidden="true"><I size={16} /></span>
          <span className="tq-step-text"><span className="tq-step-label">{s.label}</span><span className="tq-step-sub">{s.sub || STEP_WORD[s.state] || ''}</span></span>
          <span className="tq-sr">{`, step ${i + 1}: ${STEP_WORD[s.state] || s.state}`}</span>
        </>);
        return (
          <li key={s.key || s.label} className={`tq-step is-${s.state}`} aria-current={s.state === 'active' ? 'step' : undefined}>
            {onSelect ? <button type="button" className="tq-step-btn" onClick={() => onSelect(s.key)}>{inner}</button> : <div className="tq-step-btn">{inner}</div>}
          </li>);
      })}
    </ol>
  );
}

const CHECK_TONE = { ok: 'ok', fail: 'crit', warn: 'warn', pending: 'off', unknown: 'off', info: 'info', stop: 'stop' };
/** Checklist rows: icon + name + status text (+ optional detail and action). `state`: ok | fail | warn | pending | unknown | info | stop. */
export function CheckList({ items = [], label, testid, dense = false }) {
  return (
    <ul className={`tq-checks ${dense ? 'is-dense' : ''}`.trim()} aria-label={label} data-testid={testid}>
      {items.map((it) => {
        const t = CHECK_TONE[it.state] || 'info'; const I = STATE_ICON[it.state] || Info;
        return (
          <li key={it.key || it.label} className={`tq-check-row tq-${t}`} data-testid={it.testid}>
            <span className="tq-check-icon" aria-hidden="true"><I size={16} /></span>
            <span className="tq-check-main"><span className="tq-check-label">{it.label}</span>{it.detail && <span className="tq-check-detail">{it.detail}</span>}</span>
            <span className="tq-check-status">{it.status}</span>
            {it.action && <span className="tq-check-action">{it.action}</span>}
          </li>);
      })}
    </ul>
  );
}

/** Prominent state panel ("System not ready", "Recovery verified"): icon, title, explanation and an optional next action.
 *  role="alert" only for tone crit/stop/warn, so routine information is not announced as an alarm. */
// `role` overrides the default (e.g. "note" for a standing warn-tone notice that should not be announced as an alarm).
export function AlertPanel({ tone = 'info', icon, title: t, children, action, testid, role }) {
  const I = icon || STATE_ICON[tone] || Info;
  const urgent = ['crit', 'stop', 'warn'].includes(tone);
  return (
    <div className={`tq-alertpanel tq-${tone}`} role={role || (urgent ? 'alert' : 'status')} data-testid={testid}>
      <span className="tq-alertpanel-icon" aria-hidden="true"><I size={20} /></span>
      <div className="tq-alertpanel-body"><strong>{t}</strong>{children && <div className="tq-alertpanel-text">{children}</div>}</div>
      {action && <div className="tq-alertpanel-action">{action}</div>}
    </div>
  );
}

/** Why an action cannot run: the first reason in full, the rest behind a disclosure. Reasons come from the backend; never write your own. */
// `expanded` lists every reason in the open (use it where a hidden blocker would mislead, e.g. a decision check).
export function BlockedReason({ title: t = 'Action unavailable', reasons = [], action, testid, expanded = false }) {
  if (!reasons.length) return null;
  return (
    <div className="tq-blocked" role="status" data-testid={testid}>
      <span className="tq-blocked-icon" aria-hidden="true"><Lock size={15} /></span>
      <div className="tq-blocked-body">
        <strong>{t}</strong>
        {expanded ? <ul>{reasons.map((r) => <li key={r}>{r}</li>)}</ul> : <span>{reasons[0]}</span>}
        {!expanded && reasons.length > 1 && (
          <details><summary>{reasons.length - 1} more reason{reasons.length > 2 ? 's' : ''}</summary><ul>{reasons.slice(1).map((r) => <li key={r}>{r}</li>)}</ul></details>)}
      </div>
      {action && <div className="tq-blocked-action">{action}</div>}
    </div>
  );
}

/** Label/value list with optional icon, unit and provenance per row (the "Telemetry details" panel). A missing value reads "—" (or
 *  `missingText`), never 0. */
export function MetricList({ items = [], label, testid }) {
  return (
    <dl className="tq-metrics" aria-label={label} data-testid={testid}>
      {items.map((m) => {
        const I = m.icon; const missing = m.value === null || m.value === undefined || m.value === '';
        return (
          <div key={m.key || m.label} className="tq-metric">
            <dt>{I && <span className="tq-metric-icon" aria-hidden="true" style={m.color ? { color: m.color } : undefined}><I size={14} /></span>}{m.label}</dt>
            <dd className="tq-num">{missing ? <span className="tq-metric-na">{m.missingText || '—'}</span> : <>{m.value}{m.unit && <small> {m.unit}</small>}</>}{m.prov && !missing && <> <ProvBadge kind={m.prov} /></>}</dd>
          </div>);
      })}
    </dl>
  );
}

/** Accessible tabs (WAI-ARIA tablist; arrow keys, Home and End move between tabs). Render the panel with TabPanel. */
export function Tabs({ tabs = [], value, onChange, label, idBase = 'tq-tab' }) {
  const refs = useRef({});
  const keys = tabs.map((t) => t.key);
  const move = (e) => {
    const i = keys.indexOf(value); let n = null;
    if (e.key === 'ArrowRight') n = keys[(i + 1) % keys.length];
    else if (e.key === 'ArrowLeft') n = keys[(i - 1 + keys.length) % keys.length];
    else if (e.key === 'Home') n = keys[0];
    else if (e.key === 'End') n = keys[keys.length - 1];
    if (n !== null) { e.preventDefault(); onChange(n); refs.current[n]?.focus(); }
  };
  return (
    <div className="tq-tabs" role="tablist" aria-label={label} onKeyDown={move}>
      {tabs.map((t) => (
        <button key={t.key} type="button" role="tab" id={`${idBase}-${t.key}`} aria-controls={`${idBase}-${t.key}-panel`} aria-selected={value === t.key}
          tabIndex={value === t.key ? 0 : -1} ref={(el) => { refs.current[t.key] = el; }} className="tq-tab" onClick={() => onChange(t.key)}>
          {t.icon && <t.icon size={14} aria-hidden="true" />}{t.label}{t.count !== undefined && t.count !== null && <span className="tq-tab-count">{t.count}</span>}
        </button>))}
    </div>
  );
}
export function TabPanel({ tab, idBase = 'tq-tab', children }) {
  return <div role="tabpanel" id={`${idBase}-${tab}-panel`} aria-labelledby={`${idBase}-${tab}`} className="tq-tabpanel">{children}</div>;
}

/** Chart card: title, the latest value with unit and provenance, the chart, and a footnote (window, freshness).
 *  A missing latest value shows `status` (default UNAVAILABLE), never 0. */
export function ChartPanel({ title: t, value, unit, prov, right, foot, children, id, testid, status }) {
  const missing = value === null || (typeof value === 'number' && !Number.isFinite(value));
  return (
    <section className="tq-chartpanel" aria-labelledby={id} data-testid={testid}>
      <header>
        <h3 id={id}>{t}</h3>
        <div className="tq-chartpanel-val">
          {value !== undefined && <strong className={`tq-num ${missing ? 'tq-metric-na' : ''}`}>{missing ? (status || 'UNAVAILABLE') : value}{!missing && unit && <small> {unit}</small>}</strong>}
          {prov && !missing && <ProvBadge kind={prov} />}{right}
        </div>
      </header>
      <div className="tq-chartpanel-body">{children}</div>
      {foot && <p className="tq-chartpanel-foot">{foot}</p>}
    </section>
  );
}

const cmp = (x, y) => (x === y ? 0 : x === null || x === undefined ? 1 : y === null || y === undefined ? -1 : x > y ? 1 : -1);
/** Data table with optional click-to-sort columns. columns: [{ key, label, align: 'num', render(row), sort(row) }]. `stack` turns each row into a
 *  labelled card on phone widths (for short descriptive tables; numeric matrices keep scrolling sideways with a sticky first column).
 *  Sorting is client-side over the rows given; nothing is fetched or invented. Missing values sort last. */
export function DataTable({ columns = [], rows = [], rowKey, caption, empty = 'No rows.', initialSort = null, maxRows, testid, rowClass, stack = false }) {
  const [sort, setSort] = useState(initialSort);       // { key, dir: 1 | -1 }
  const col = sort && columns.find((c) => c.key === sort.key);
  const sorted = col && col.sort ? [...rows].sort((a, b) => { const x = col.sort(a); const y = col.sort(b); return x == null || y == null ? cmp(x, y) : cmp(x, y) * sort.dir; }) : rows;
  const shown = maxRows ? sorted.slice(0, maxRows) : sorted;
  if (!rows.length) return <Empty>{empty}</Empty>;
  return (
    <div className={`tq-table-wrap${stack ? ' is-stack' : ''}`} data-testid={testid}>
      <table className="tq-table">
        {caption && <caption className="tq-sr">{caption}</caption>}
        <thead><tr>{columns.map((c) => {
          const on = sort?.key === c.key;
          return (
            <th key={c.key} scope="col" className={c.align === 'num' ? 'tq-th-num' : undefined} aria-sort={on ? (sort.dir === 1 ? 'ascending' : 'descending') : undefined}>
              {c.sort ? <button type="button" className="tq-th-sort" onClick={() => setSort({ key: c.key, dir: on ? -sort.dir : 1 })}>{c.label}<span aria-hidden="true">{on ? (sort.dir === 1 ? ' ▲' : ' ▼') : ' ↕'}</span></button> : c.label}
            </th>); })}</tr></thead>
        <tbody>{shown.map((r, i) => (
          <tr key={rowKey ? rowKey(r) : i} className={rowClass ? rowClass(r) : undefined}>{columns.map((c) => <td key={c.key} data-label={c.label} className={c.align === 'num' ? 'tq-num tq-td-num' : undefined}>{stack ? <span className="tq-td-v">{c.render ? c.render(r) : r[c.key]}</span> : (c.render ? c.render(r) : r[c.key])}</td>)}</tr>))}</tbody>
      </table>
    </div>
  );
}

/** Placeholder bars while data loads (keeps the layout stable). Hidden from assistive technology: pair it with a text loading state. */
export function Skeleton({ lines = 3, height = 12 }) {
  return <div className="tq-skeleton" aria-hidden="true">{Array.from({ length: lines }, (_, i) => <span key={i} style={{ height, width: `${100 - (i % 3) * 18}%` }} />)}</div>;
}

/** Two-step confirmation for a consequential action: the first press arms it, the second performs it, Cancel disarms.
 *  Disabled while `busy`, so one press can never submit twice. The caller still shows the backend's answer. */
export function ConfirmButton({ onConfirm, children, confirmLabel, disabled, busy, className = 'tq-btn tq-primary', testid, icon: I }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => { if (disabled) setArmed(false); }, [disabled]);
  return (
    <span className="tq-confirm">
      <button type="button" className={className} disabled={disabled || busy} data-testid={testid}
        onClick={() => { if (armed) { setArmed(false); onConfirm(); } else setArmed(true); }}>
        {busy ? <Loader2 size={14} className="tq-spin" aria-hidden="true" /> : I ? <I size={14} aria-hidden="true" /> : null}{armed ? (confirmLabel || <>Confirm {children}</>) : children}
      </button>
      {armed && <button type="button" className="tq-btn" onClick={() => setArmed(false)}>Cancel</button>}
    </span>
  );
}

/** Data-source label for a whole section, in words: PHYSICAL / SIMULATED / DERIVED / PREDICTED / UNKNOWN / STALE.
 *  (ProvBadge is the compact per-value form: HW / SIM / DERIVED / PRED.) */
const SOURCE = {
  PHYSICAL: ['real', 'PHYSICAL', 'Measured on the connected hardware'], SIMULATED: ['sim', 'SIMULATED', 'Generated by the software simulator'],
  DERIVED: ['derived', 'DERIVED', 'Calculated from source measurements'], PREDICTED: ['pred', 'PREDICTED', 'Model estimate, not a measurement'],
  UNKNOWN: ['off', 'UNKNOWN', 'Source unavailable'], STALE: ['stale', 'STALE', 'Not current: the last reading is too old'],
};
export function SourceTag({ kind = 'UNKNOWN' }) {
  const [cls, text, help] = SOURCE[kind] || SOURCE.UNKNOWN;
  return <span className={`tq-source tq-prov-${cls}`} title={help}>{text}<span className="tq-sr"> ({help})</span></span>;
}
