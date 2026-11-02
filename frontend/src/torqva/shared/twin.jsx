// Digital Twin workspace: the 3D rig model (or the 2D schematic), its markers, a Component Info panel and the key readings. Presentation only.
// It receives an already-mapped `model` (built by simulation/twin.jsx from the simulator API or by physical/twin.jsx from the device stream) and never
// fetches, computes a reading or sends a command. A reading it is not given is shown as unavailable, never as zero.
//
// model = {
//   source: 'SIMULATION' | 'PHYSICAL', loading,
//   sourceTag: 'SIMULATED' | 'PHYSICAL' | 'STALE' | 'UNKNOWN',   what the shown values are, in words (never inferred here)
//   state: { tone, label, detail },        operating state as reported (motor / simulation)
//   clock: { tone, label } | null,         simulation advancing or paused (simulation only)
//   connection: { tone, label },           backend / device connection
//   freshness: 'live' | 'stale' | 'none',  whether the shown values are current, last-received, or absent
//   updated: string,                       when the shown values were observed
//   motion: { spinning, rpm, note },       spinning only when the source reports a valid, current, non-zero speed
//   parts: [{ id, name, short, part, iface, tone?, readings: [Reading], notes: [string] }],
//   alerts: [{ part, tone, kind: 'observation' | 'trip' | 'truth', label, detail }]   evidence that names a component; never inferred here
//   hypotheses: [{ part, fault, p, label, where, incident }]  TORQVA's own C1 ranking, listed on the part where the simulator models that fault
//   links: { [partId]: [view, label] },    the page with the details of a component (a real route of the shell)
//   kpis: [[partId, readingKey]], findings: [{ tone, label, detail, go: [view, text] }], facts: [[label, value]],
// }
// Reading = { key, label, unit, digits, value: number | null, status: 'ok' | 'stale' | 'invalid' | 'unavailable', prov, note, observed, trend }
import React, { Suspense, lazy, useEffect, useState } from 'react';
import { Box, Crosshair, Maximize2, X, ChevronRight, Info, AlertTriangle, Brain, Cpu, Layers } from 'lucide-react';
import { Card, Empty, Pill, ProvBadge, PageHead, SourceTag, LinkButton, Disclosure, fmt, title } from './components.jsx';
import { MotorModel } from './twinModel.jsx';
import { COMPONENT, KIND_LABEL, STRUCTURE_IDS, SPIN_SCALE } from './twinParts.js';
import { webgl2Available } from './twin3d/support.js';

const TwinViewport = lazy(() => import('./twin3d/viewport.jsx'));

const TONE = { ok: 'ok', stale: 'warn', invalid: 'crit', unavailable: 'off' };
const RANK = { ok: 0, unavailable: 1, stale: 2, invalid: 3 };
const STATUS_TEXT = { ok: null, stale: 'STALE', invalid: 'INVALID', unavailable: 'UNAVAILABLE' };
const ALERT_KIND = { observation: 'Observation', trip: 'Safety trip', truth: 'Scenario ground truth (simulation)' };
const ALERT_RANK = { sim: 0, warn: 1, crit: 2, stop: 3 };

// Next to a shown number: VALID (simulator, whose SIM badge already gives the origin) or LIVE (device), or STALE. Missing values say so in place of the number.
export const statusText = (r, source) => (r.status === 'ok' ? (source === 'SIMULATION' ? 'VALID' : 'LIVE') : STATUS_TEXT[r.status]);
/** A reading is shown as a number only when it is present and finite; stale values stay visible but are marked stale. */
export const hasValue = (r) => !!r && (r.status === 'ok' || r.status === 'stale') && typeof r.value === 'number' && Number.isFinite(r.value);
export const shown = (r) => (hasValue(r) ? `${fmt(r.value, r.digits)}${r.unit ? ` ${r.unit}` : ''}` : (r ? STATUS_TEXT[r.status] || 'UNAVAILABLE' : 'UNAVAILABLE'));

/** A part's tone is its worst reading, unless the mapping gives one (e.g. the controller has a connection, not a reading). */
export function partTone(p) {
  if (p.tone) return p.tone;
  const rs = p.readings || [];
  if (!rs.length) return 'off';
  const worst = rs.reduce((a, r) => (RANK[r.status] > RANK[a.status] ? r : a), rs[0]);
  return TONE[worst.status] || 'off';
}
const toneWord = (tone, source) => (tone === 'ok' ? (source === 'SIMULATION' ? 'simulated readings available' : 'live readings') : tone === 'warn' ? 'readings stale' : tone === 'crit' ? 'invalid reading' : 'no current reading');

/** Everything the viewport draws per component: sensor parts from the model, mechanical / power parts from the static metadata (no reading). */
export function twinItems(model) {
  const alerts = model.alerts || [];
  const worst = (id) => alerts.filter((a) => a.part === id).reduce((w, a) => (w && ALERT_RANK[w] >= ALERT_RANK[a.tone] ? w : a.tone), null);
  const sensors = model.parts.map((p) => {
    const lead = p.readings[0];
    const ok = hasValue(lead);
    return { id: p.id, name: p.name, short: p.short, part: p.part, tone: partTone(p), value: lead ? shown(lead) : p.summary, summary: lead ? `${lead.label} ${shown(lead)}` : p.summary,
      sensor: true, prov: ok ? lead.prov : null, tag: ok ? statusText(lead, model.source) : null, status: lead?.status || 'ok', alert: worst(p.id) };
  });
  const structure = STRUCTURE_IDS.map((id) => {
    const c = COMPONENT[id];
    return { id, name: c.name, short: c.name, part: c.part, tone: 'none', value: KIND_LABEL[c.kind], summary: `${c.part} (no sensor of its own)`, sensor: false, alert: worst(id) };
  });
  return [...sensors, ...structure];
}

/** Operating state, data source, connection, simulation clock and the time of the shown values, in one strip. */
function TwinStatusBar({ model }) {
  const { state, clock, connection, updated, source } = model;
  return (
    <div className="tq-tw-status" data-testid="twin-status">
      <div className="tq-tw-status-main">
        <span className={`tq-tw-state-dot tq-${state.tone}`} aria-hidden="true" />
        <div>
          <span className="tq-tw-eyebrow">Operating state</span>
          <strong className="tq-tw-state" data-testid="twin-state">{state.label}</strong>
          {state.detail && <span className="tq-tw-state-detail">{state.detail}</span>}
        </div>
      </div>
      <dl className="tq-tw-status-facts">
        <div><dt>Data</dt><dd><SourceTag kind={model.sourceTag || 'UNKNOWN'} /></dd></div>
        <div><dt>Source</dt><dd>{source === 'SIMULATION' ? 'Software simulator' : 'Physical device'}</dd></div>
        <div><dt>Connection</dt><dd><Pill tone={connection.tone}>{connection.label}</Pill></dd></div>
        {clock && <div><dt>Simulation</dt><dd><Pill tone={clock.tone}>{clock.label}</Pill></dd></div>}
        <div><dt>Last update</dt><dd className="tq-num" data-testid="twin-updated">{updated}</dd></div>
      </dl>
    </div>
  );
}

function Kpis({ model, onSelect, selected }) {
  const find = (pid, key) => (model.parts.find((p) => p.id === pid)?.readings || []).find((r) => r.key === key);
  return (
    <div className="tq-tw-kpis" data-testid="twin-kpis" role="group" aria-label="Key readings">
      {model.kpis.map(([pid, key]) => {
        const r = find(pid, key);
        if (!r) return null;
        const ok = hasValue(r);
        return (
          <button type="button" key={`${pid}-${key}`} className={`tq-tw-kpi${selected === pid ? ' is-sel' : ''}${ok ? '' : ' is-na'}`} onClick={() => onSelect(selected === pid ? null : pid)}
            data-testid={`twin-kpi-${key}`} aria-pressed={selected === pid}>
            <span className="tq-tw-kpi-label">{r.label}</span>
            <span className="tq-tw-kpi-value tq-num">{ok ? fmt(r.value, r.digits) : STATUS_TEXT[r.status]}{ok && r.unit && <small>{r.unit}</small>}</span>
            <span className="tq-tw-kpi-meta">{ok ? <><ProvBadge kind={r.prov} /><span className={`tq-tw-tag tq-tw-tag-${r.status}`}>{statusText(r, model.source)}</span></> : <span className="tq-tw-kpi-why">{r.status === 'invalid' ? 'sensor fault' : 'no reading'}</span>}</span>
          </button>
        );
      })}
    </div>
  );
}

function ReadingRow({ r, source, active, onTrend }) {
  const ok = hasValue(r);
  return (
    <div className={`tq-tw-reading${active ? ' is-active' : ''}`} data-testid={`twin-reading-${r.key}`}>
      <div className="tq-tw-reading-head">
        <span>{r.label}</span>
        {ok && <span className="tq-tw-reading-tags"><ProvBadge kind={r.prov} /><span className={`tq-tw-tag tq-tw-tag-${r.status}`}>{statusText(r, source)}</span></span>}
      </div>
      <div className={`tq-tw-reading-value tq-num${ok ? '' : ' is-na'}`}>{ok ? fmt(r.value, r.digits) : STATUS_TEXT[r.status]}{ok && r.unit && <small>{r.unit}</small>}</div>
      <div className="tq-tw-reading-foot">
        <span>{r.observed}</span>
        {r.trend && <button type="button" className="tq-linkbtn" onClick={() => onTrend(r.key)} aria-pressed={active}>{active ? 'Trend shown' : 'Show trend'}</button>}
      </div>
      {r.note && <p className="tq-tw-note">{r.note}</p>}
    </div>
  );
}

/** Identity of a component from the static metadata: id, type and where the model places it (and how reliable that is). */
function ComponentFacts({ id }) {
  const c = COMPONENT[id];
  if (!c) return null;
  return (
    <dl className="tq-tw-ident" data-testid="twin-ident">
      <div><dt>Component</dt><dd><code>{c.id}</code> · {KIND_LABEL[c.kind]}</dd></div>
      <div><dt>Part</dt><dd>{c.part}</dd></div>
      <div><dt>Placement</dt><dd>{c.placement}</dd></div>
    </dl>
  );
}

function Evidence({ alerts }) {
  if (!alerts.length) return null;
  return (
    <ul className="tq-tw-evidence" data-testid="twin-evidence">
      {alerts.map((a) => (
        <li key={`${a.kind}-${a.label}`} className={`tq-tw-tone-${a.tone}`}>
          <AlertTriangle size={14} aria-hidden="true" />
          <div><span className="tq-tw-eyebrow">{ALERT_KIND[a.kind] || a.kind}</span><strong>{a.label}</strong><span className="tq-muted">{a.detail}</span></div>
        </li>
      ))}
    </ul>
  );
}

/** TORQVA's own C1 hypotheses about faults the simulator models on this part. A ranking, never ground truth and never drawn on the model. */
function Hypotheses({ items, go }) {
  if (!items.length) return null;
  return (
    <ul className="tq-tw-evidence tq-tw-hyps" data-testid="twin-hypotheses">
      {items.map((h) => (
        <li key={h.fault} className="tq-tw-tone-info">
          <Brain size={14} aria-hidden="true" />
          <div>
            <span className="tq-tw-eyebrow">Fault hypothesis · TORQVA diagnosis</span>
            <strong>{title(h.fault)} <span className="tq-num">{fmt(h.p * 100, 0)}%</span> <span className="tq-muted">({h.label || 'unlabelled'})</span></strong>
            <span className="tq-muted">Incident {h.incident}. The simulator models {title(h.fault)} as {h.where}, on this part. This is the AI&apos;s ranking from simulated evidence, not the scenario ground truth.</span>
          </div>
        </li>
      ))}
      {go && <li className="tq-tw-hyps-link"><LinkButton onClick={() => go('diagnostics')}>Full ranking in Anomaly Detection</LinkButton></li>}
    </ul>
  );
}

/** Evidence the app links to this component (observations, trips, scenario ground truth, mapped C1 hypotheses), or a plain statement that there is none. */
function EvidenceSection({ id, model, go }) {
  const alerts = (model.alerts || []).filter((a) => a.part === id);
  const hyps = (model.hypotheses || []).filter((h) => h.part === id);
  return (
    <section className="tq-tw-sec" aria-labelledby={`tw-ev-${id}`}>
      <h4 id={`tw-ev-${id}`}>Diagnostic evidence</h4>
      {!alerts.length && !hyps.length
        ? <p className="tq-tw-hint tq-muted" data-testid="twin-no-evidence">No evidence names this component. That says nothing about its health: the twin only lists what the source attributes to a part.</p>
        : <><Evidence alerts={alerts} /><Hypotheses items={hyps} go={go} /></>}
    </section>
  );
}

function DetailHead({ eyebrow, name, sub, tone, model, onClose }) {
  return (
    <>
      <header className="tq-tw-detail-head">
        <div>
          <span className="tq-tw-eyebrow">{eyebrow}</span>
          <h3>{name}</h3>
          <span className="tq-tw-iface">{sub}</span>
        </div>
        <button type="button" className="tq-iconbtn" onClick={onClose} aria-label="Back to the full motor view" data-testid="twin-close"><X size={16} aria-hidden="true" /></button>
      </header>
      {tone && <Pill tone={tone}>{toneWord(tone, model.source)}</Pill>}
    </>
  );
}

function DetailFoot({ id, model, go, onClose }) {
  const link = model.links?.[id];
  return (
    <div className="tq-tw-detail-foot">
      {link && go && <LinkButton onClick={() => go(link[0])} testid="twin-view-details">View details in {link[1]}</LinkButton>}
      <button type="button" className="tq-btn tq-btn-sm tq-tw-back" onClick={onClose}><Maximize2 size={14} aria-hidden="true" />Full motor view</button>
    </div>
  );
}

/** A sensor, the motor driver or the controller: what it is, its readings (with provenance), notes, trend and linked evidence. */
function SensorDetail({ part, model, onClose, renderTrend, go }) {
  const trendable = part.readings.filter((r) => r.trend);
  const [trendKey, setTrendKey] = useState(trendable[0]?.key || null);
  useEffect(() => { setTrendKey(trendable[0]?.key || null); }, [part.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const reading = part.readings.find((r) => r.key === trendKey);
  const c = COMPONENT[part.id];
  return (
    <div className="tq-tw-detail" data-testid="twin-detail" aria-live="polite">
      <DetailHead eyebrow={c ? KIND_LABEL[c.kind] : 'Component'} name={part.name} sub={`${part.part} · ${part.iface}`} tone={partTone(part)} model={model} onClose={onClose} />
      {c && <p className="tq-tw-desc">{c.role}</p>}
      <section className="tq-tw-sec" aria-labelledby={`tw-rd-${part.id}`}>
        <h4 id={`tw-rd-${part.id}`}>{part.readings.length ? 'Readings from this component' : 'Readings'}</h4>
        <div className="tq-tw-readings">
          {part.readings.length ? part.readings.map((r) => <ReadingRow key={r.key} r={r} source={model.source} active={r.key === trendKey} onTrend={setTrendKey} />)
            : <Empty>This part reports no reading of its own.</Empty>}
        </div>
        {part.notes?.length > 0 && <ul className="tq-tw-notes">{part.notes.map((n) => <li key={n}><Info size={13} aria-hidden="true" />{n}</li>)}</ul>}
      </section>
      {reading && (
        <div className="tq-tw-trend" data-testid="twin-trend">
          <h4>{reading.label} trend</h4>
          {renderTrend(part, reading)}
        </div>
      )}
      <EvidenceSection id={part.id} model={model} go={go} />
      <ComponentFacts id={part.id} />
      <DetailFoot id={part.id} model={model} go={go} onClose={onClose} />
    </div>
  );
}

/** A mechanical, power or wiring component: identification, the sensors that observe it (with their values) and linked evidence. No reading of its own. */
function StructureDetail({ id, model, onClose, onSelect, go }) {
  const c = COMPONENT[id];
  const related = (c.related || []).map((r) => model.parts.find((p) => p.id === r)).filter(Boolean);
  return (
    <div className="tq-tw-detail" data-testid="twin-detail" aria-live="polite">
      <DetailHead eyebrow={KIND_LABEL[c.kind]} name={c.name} sub={`${c.part} · no sensor of its own`} model={model} onClose={onClose} />
      <p className="tq-tw-desc">{c.role}</p>
      <p className="tq-tw-hint tq-muted">The twin shows no reading for this part and makes no claim about its condition.</p>
      <section className="tq-tw-sec" aria-labelledby={`tw-obs-${id}`}>
        <h4 id={`tw-obs-${id}`}>Sensors observing this component</h4>
        {!related.length ? <p className="tq-tw-hint tq-muted">No sensor of the rig observes this part directly.</p> : (
          <ul className="tq-tw-partlist">
            {related.map((p) => {
              const lead = p.readings[0];
              const ok = hasValue(lead);
              return (
                <li key={p.id}><button type="button" onClick={() => onSelect(p.id)}>
                  <span className={`tq-tw-dot tq-${partTone(p)}`} aria-hidden="true" />
                  <span className="tq-tw-partlist-name"><strong>{p.name}</strong><small>{lead ? lead.label : p.part}</small></span>
                  <span className={`tq-tw-partlist-val tq-num${ok ? '' : ' is-na'}`}>{lead ? shown(lead) : p.summary}</span>
                  {ok && <ProvBadge kind={lead.prov} />}
                  <ChevronRight size={15} aria-hidden="true" />
                </button></li>
              );
            })}
          </ul>
        )}
      </section>
      <EvidenceSection id={id} model={model} go={go} />
      <ComponentFacts id={id} />
      <DetailFoot id={id} model={model} go={go} onClose={onClose} />
    </div>
  );
}

function Overview({ model, items, onSelect }) {
  const structure = items.filter((i) => !i.sensor);
  return (
    <div className="tq-tw-detail" data-testid="twin-overview">
      <p className="tq-muted tq-tw-hint">Select a part on the model, in this list or in the menu above to see what it is, its readings and provenance, and the evidence linked to it.</p>
      <span className="tq-tw-eyebrow">Sensors and electronics</span>
      <ul className="tq-tw-partlist" aria-label="Sensors and electronics">
        {model.parts.map((p) => {
          const lead = p.readings[0];
          const ok = hasValue(lead);
          return (
            <li key={p.id}>
              <button type="button" onClick={() => onSelect(p.id)} data-testid={`twin-part-${p.id}`}>
                <span className={`tq-tw-dot tq-${partTone(p)}`} aria-hidden="true" />
                <span className="tq-tw-partlist-name"><strong>{p.name}</strong><small>{p.part}</small></span>
                <span className={`tq-tw-partlist-val tq-num${!lead || ok ? '' : ' is-na'}`}>{lead ? shown(lead) : p.summary}</span>
                <ChevronRight size={15} aria-hidden="true" />
              </button>
            </li>
          );
        })}
      </ul>
      <span className="tq-tw-eyebrow tq-mt-xs">Mechanical, power and wiring (no sensor)</span>
      <ul className="tq-tw-partlist" aria-label="Mechanical, power and wiring parts">
        {structure.map((i) => (
          <li key={i.id}>
            <button type="button" onClick={() => onSelect(i.id)} data-testid={`twin-part-${i.id}`}>
              <span className="tq-tw-dot tq-none" aria-hidden="true" />
              <span className="tq-tw-partlist-name"><strong>{i.name}</strong><small>{i.part}</small></span>
              <span className="tq-tw-partlist-val">{i.value}</span>
              <ChevronRight size={15} aria-hidden="true" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The Component Info panel: a component picker, then the overview list or the selected component's details. */
function ComponentInfo({ model, items, selected, setSelected, renderTrend, go }) {
  const part = model.parts.find((p) => p.id === selected);
  const sensors = items.filter((i) => i.sensor), structure = items.filter((i) => !i.sensor);
  return (
    <aside className="tq-tw-side" aria-label="Component information" data-testid="twin-info">
      <header className="tq-tw-side-head">
        <h3 id="tw-info-h"><Layers size={16} aria-hidden="true" />Component Info</h3>
        <label className="tq-tw-pick">
          <span className="tq-sr">Component</span>
          <select value={selected && COMPONENT[selected] ? selected : ''} onChange={(e) => setSelected(e.target.value || null)} data-testid="twin-pick">
            <option value="">Whole rig (all parts)</option>
            <optgroup label="Sensors and electronics">{sensors.map((i) => <option key={i.id} value={i.id}>{i.short}</option>)}</optgroup>
            <optgroup label="Mechanical, power and wiring">{structure.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}</optgroup>
          </select>
        </label>
      </header>
      {part ? <SensorDetail part={part} model={model} onClose={() => setSelected(null)} renderTrend={renderTrend} go={go} />
        : selected && COMPONENT[selected] ? <StructureDetail id={selected} model={model} onClose={() => setSelected(null)} onSelect={setSelected} go={go} />
          : <Overview model={model} items={items} onSelect={setSelected} />}
    </aside>
  );
}

const LEGEND = [['ok', 'Current reading'], ['warn', 'Stale'], ['crit', 'Invalid'], ['off', 'Unavailable']];

/** Static description of the rig: parts, what they measure and the INTENDED interface (pinmap.h; wiring unverified). */
export const INVENTORY = [
  ['hall', 'A3144 Hall-effect sensor', 'Shaft speed (rpm) from pulse timing', 'Digital interrupt, GPIO 9'],
  ['temp', 'DS18B20 (one-wire)', 'Housing temperature (°C); a second probe, if fitted, is ambient', '1-Wire, GPIO 6'],
  ['ina', 'INA219 current / voltage monitor', 'DC bus voltage (V) and current (A); the firmware computes power (W) from them', 'I²C bus 1 (SDA 7, SCL 8), 0x40'],
  ['accel', 'ADXL345 accelerometer', 'Raw 3-axis acceleration (g), gravity included; not vibration RMS', 'I²C bus 0 (SDA 16, SCL 17), 0x53'],
  ['driver', 'BTS7960 / IBT-2 motor driver', 'No sensor: drives the motor from the PWM duty the firmware commands', 'RPWM 38, LPWM 39, R_EN 18, L_EN 21'],
  ['controller', 'ESP32-S3 with SH1106 OLED', 'Runs the TORQVA firmware; the OLED is local annunciation only', 'USB serial to the backend; OLED on software I²C (SDA 4, SCL 5)'],
];

const reducedMotion = () => { try { return !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches; } catch { return false; } };

/** Catches a failure inside the 3D viewport so the page falls back to the 2D schematic instead of breaking. */
class ViewBoundary extends React.Component {
  constructor(props) { super(props); this.state = { failed: false }; }
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error) { this.props.onError(`The 3D view failed (${error?.message || 'rendering error'}).`); }
  render() { return this.state.failed ? null : this.props.children; }
}

/** The model area: the 3D viewport when WebGL 2 works, otherwise (or by choice) the 2D schematic. Both get the same parts and selection. */
function Stage({ model, items, selected, setSelected }) {
  const [gl] = useState(webgl2Available);
  const [view, setView] = useState(gl ? '3d' : '2d');
  const [notice, setNotice] = useState(gl ? null : 'This browser has no WebGL 2, so the 2D schematic is shown.');
  const [zoom, setZoom] = useState(true);
  const fallback = (why) => { setNotice(`${why} Showing the 2D schematic.`); setView('2d'); };
  const sensors = items.filter((i) => i.sensor);
  return (
    <section className="tq-tw-stage" aria-labelledby="tw-stage-h">
      <header className="tq-tw-stage-head">
        <div className="tq-tw-stage-title">
          <h3 id="tw-stage-h" className="tq-sr">Motor rig model</h3>
          <div className="tq-t3-seg tq-tw-viewswitch" role="group" aria-label="Model view">
            <button type="button" className={`tq-t3-seg-btn${view === '3d' ? ' is-on' : ''}`} aria-pressed={view === '3d'} disabled={!gl} title={gl ? undefined : 'WebGL 2 is not available in this browser'}
              onClick={() => { setNotice(null); setView('3d'); }} data-testid="twin-view-3d"><Box size={14} aria-hidden="true" />3D Model</button>
            <button type="button" className={`tq-t3-seg-btn${view === '2d' ? ' is-on' : ''}`} aria-pressed={view === '2d'} onClick={() => setView('2d')} data-testid="twin-view-2d"><Cpu size={14} aria-hidden="true" />2D Schematic</button>
          </div>
        </div>
        <div className="tq-tw-stage-tools">
          <ul className="tq-tw-legend" aria-label="Legend">{LEGEND.map(([t, l]) => <li key={t}><span className={`tq-tw-dot tq-${t}`} aria-hidden="true" />{l}</li>)}</ul>
          {view === '2d' && <button type="button" className={`tq-btn tq-btn-sm${zoom ? ' is-on' : ''}`} aria-pressed={zoom} onClick={() => setZoom((z) => !z)}><Crosshair size={14} aria-hidden="true" />Zoom to selection</button>}
        </div>
      </header>
      {notice && <p className="tq-tw-notice" role="status" data-testid="twin-notice">{notice}</p>}
      {view === '3d' ? (
        <ViewBoundary onError={fallback}>
          <Suspense fallback={<div className="tq-t3-loading"><Empty loading>Loading the 3D model…</Empty></div>}>
            <TwinViewport items={items} selected={selected} onSelect={setSelected} motion={model.motion} freshness={model.freshness || 'none'} source={model.source}
              alerts={model.alerts || []} onFallback={fallback} />
          </Suspense>
        </ViewBoundary>
      ) : (
        <div className="tq-tw-canvas">
          <MotorModel parts={sensors} selected={COMPONENT[selected] && sensors.some((s) => s.id === selected) ? selected : null} onSelect={setSelected} spinning={model.motion.spinning} rpm={model.motion.rpm} zoom={zoom} />
        </div>
      )}
      <div className="tq-tw-chips" role="group" aria-label="Parts">
        {items.map((p) => (
          <button key={p.id} type="button" className={`tq-tw-chip${selected === p.id ? ' is-sel' : ''}${p.sensor ? '' : ' is-struct'}`} aria-pressed={selected === p.id} onClick={() => setSelected(selected === p.id ? null : p.id)}>
            <span className={`tq-tw-dot tq-${p.tone}`} aria-hidden="true" />{p.short}
          </button>
        ))}
      </div>
      <p className="tq-tw-caption" data-testid="twin-motion-note">
        <strong>Illustrative model, not CAD-accurate.</strong> {view === '3d' ? 'Geometry follows the typical RS-775 and breakout-board sizes and the build notes; positions, internals and wiring are not measured on the rig.' : 'Proportions, sensor positions and wiring are drawn for readability and are not verified.'} {model.motion.note}
        {model.motion.spinning && (view === '3d' && reducedMotion() ? ' The shaft animation is off because your system asks for reduced motion.' : ` The shaft animation turns at 1/${SPIN_SCALE} of the reported speed so it stays readable; it is presentation only.`)}
      </p>
    </section>
  );
}

export function DigitalTwin({ model, renderTrend, go, aside }) {
  const [selected, setSelected] = useState(null);
  useEffect(() => {
    if (!selected) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setSelected(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected]);
  const head = <PageHead title="Digital Twin" sub="Interactive model of the motor rig: where each sensor sits, what it reports now and the evidence linked to each part."
    right={<Pill tone="info">{model.source === 'SIMULATION' ? 'SIMULATION MODE' : 'PHYSICAL MODE'}</Pill>} />;
  if (model.loading) return <>{head}<Empty loading>Loading the current state…</Empty></>;
  const items = twinItems(model);
  return (
    <div className="tq-tw" data-testid="twin-page" data-source={model.source}>
      {head}
      <TwinStatusBar model={model} />
      <Kpis model={model} onSelect={setSelected} selected={selected} />
      <div className="tq-tw-work">
        <Stage model={model} items={items} selected={selected} setSelected={setSelected} />
        <ComponentInfo model={model} items={items} selected={selected} setSelected={setSelected} renderTrend={renderTrend} go={go} />
      </div>
      <div className="tq-grid tq-tw-support">
        <Card title="Findings" id="tw-findings" sub="What the pipeline and the source report, with the page that has the details.">
          {!model.findings.length ? <Empty>No findings to report.</Empty> : (
            <ul className="tq-tw-findings" data-testid="twin-findings">
              {model.findings.map((f) => (
                <li key={f.label}>
                  <Pill tone={f.tone}>{f.label}</Pill>
                  {f.detail && <span className="tq-muted">{f.detail}</span>}
                  {f.go && go && <button type="button" className="tq-linkbtn" onClick={() => go(f.go[0])}>{f.go[1]}<ChevronRight size={13} aria-hidden="true" /></button>}
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Data source" id="tw-source" right={<SourceTag kind={model.sourceTag || 'UNKNOWN'} />}>
          <dl className="tq-tw-facts">{model.facts.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
          {aside}
        </Card>
      </div>
      <div className="tq-tw-more">
        <Disclosure summary="Sensor inventory" meta="parts, what they measure, intended interface">
          <table className="tq-table"><caption className="tq-sr">Sensor inventory</caption>
            <thead><tr><th scope="col">Part</th><th scope="col">Measures</th><th scope="col">Intended interface (unverified)</th><th scope="col">Status</th></tr></thead>
            <tbody>{INVENTORY.map(([id, name, what, iface]) => {
              const p = model.parts.find((x) => x.id === id);
              const tone = p ? partTone(p) : 'off';
              return <tr key={id}><td>{name}</td><td className="tq-muted">{what}</td><td className="tq-muted">{iface}</td><td><Pill tone={tone}>{tone === 'ok' ? 'reading' : tone === 'warn' ? 'stale' : tone === 'crit' ? 'invalid' : 'unavailable'}</Pill></td></tr>;
            })}</tbody>
          </table>
        </Disclosure>
        <Disclosure summary="Model assumptions and limitations" meta="what the twin does and does not claim">
          <ul className="tq-tw-limits">
            <li>The 3D model is illustrative. It is built from the RS-775 motor type, typical breakout-board sizes and the rig build notes, not from a CAD model or measurements of this rig. Sensor positions, the disc size and the wiring are not verified.</li>
            <li>The motor internals shown in the section and exploded views (magnets, armature, commutator, brushes) are generic for a brushed PM motor of this type, not scanned from this unit.</li>
            <li>The twin only displays values supplied by the backend. It does not run its own physics, fill gaps, interpolate or estimate readings.</li>
            <li>Power is always derived, never measured directly: the firmware computes it from the INA219 voltage and current (physical), or the browser multiplies the voltage and current of the same simulated window (simulation). Both are labelled DERIVED.</li>
            <li>The ADXL345 reports raw acceleration including gravity. The firmware does not compute vibration RMS, so none is shown for the physical device; the simulator&apos;s vibration value is a simulated quantity.</li>
            <li>The shaft animation is presentation only. It runs only while the source reports a valid, current, non-zero speed, at a reduced rate and in one direction (the real direction depends on unverified motor polarity), and it never feeds any model or safety decision.</li>
            <li>A part is highlighted as an alert only when the source names it: a reading the device marked invalid, a safety trip the firmware attributes to that sensor&apos;s reading, or (simulation only) the fault the scenario injected. The absence of an alert says nothing about a part&apos;s health.</li>
            <li>Fault hypotheses are listed in a part&apos;s panel only in simulation, and only for faults the simulator models on that part (for example imbalance on the shaft and disc). They are TORQVA&apos;s ranking, are never drawn on the model and are not ground truth.</li>
            <li>The status LEDs and the OLED are drawn unlit because their state is not reported. This page sends no commands; motor control stays on its existing, supervised pages.</li>
          </ul>
        </Disclosure>
      </div>
    </div>
  );
}
