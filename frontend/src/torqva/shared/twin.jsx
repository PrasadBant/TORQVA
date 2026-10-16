// Digital Twin workspace: the 3D rig model (or the 2D drawing), its markers, a component inspection panel and the key readings. Presentation only.
// It receives an already-mapped `model` (built by simulation/twin.jsx from the simulator API or by physical/twin.jsx from the device stream) and never
// fetches, computes a reading or sends a command. A reading it is not given is shown as unavailable, never as zero.
//
// model = {
//   source: 'SIMULATION' | 'PHYSICAL', loading,
//   state: { tone, label, detail },        operating state as reported (motor / simulation)
//   clock: { tone, label } | null,         simulation advancing or paused (simulation only)
//   connection: { tone, label },           backend / device connection
//   freshness: 'live' | 'stale' | 'none',  whether the shown values are current, last-received, or absent
//   updated: string,                       when the shown values were observed
//   motion: { spinning, rpm, note },       spinning only when the source reports a valid, current, non-zero speed
//   parts: [{ id, name, short, part, iface, tone?, readings: [Reading], notes: [string] }],
//   alerts: [{ part, tone, kind: 'observation' | 'trip' | 'truth', label, detail }]   evidence that names a component; never inferred here
//   kpis: [[partId, readingKey]], findings: [{ tone, label, detail, go: [view, text] }], facts: [[label, value]],
// }
// Reading = { key, label, unit, digits, value: number | null, status: 'ok' | 'stale' | 'invalid' | 'unavailable', prov, note, observed, trend }
import React, { Suspense, lazy, useEffect, useState } from 'react';
import { Box, Crosshair, Maximize2, X, ChevronRight, Info, AlertTriangle } from 'lucide-react';
import { Card, Empty, Pill, ProvBadge, PageHead, fmt } from './components.jsx';
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
        <div><dt>Source</dt><dd><Pill tone="info">{source === 'SIMULATION' ? 'Software simulator' : 'Physical device'}</Pill></dd></div>
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
    <div className="tq-tw-kpis" data-testid="twin-kpis">
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

/** Identity of a component from the static metadata: id, type, function and where the model places it (and how reliable that is). */
function ComponentFacts({ id }) {
  const c = COMPONENT[id];
  if (!c) return null;
  return (
    <dl className="tq-tw-ident" data-testid="twin-ident">
      <div><dt>Component</dt><dd><code>{c.id}</code> · {KIND_LABEL[c.kind]}</dd></div>
      <div><dt>Function</dt><dd>{c.role}</dd></div>
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

function SensorDetail({ part, model, onClose, renderTrend }) {
  const trendable = part.readings.filter((r) => r.trend);
  const [trendKey, setTrendKey] = useState(trendable[0]?.key || null);
  useEffect(() => { setTrendKey(trendable[0]?.key || null); }, [part.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const reading = part.readings.find((r) => r.key === trendKey);
  const tone = partTone(part);
  return (
    <div className="tq-tw-detail" data-testid="twin-detail" aria-live="polite">
      <header className="tq-tw-detail-head">
        <div>
          <span className="tq-tw-eyebrow">{part.part}</span>
          <h3>{part.name}</h3>
          <span className="tq-tw-iface">{part.iface}</span>
        </div>
        <button type="button" className="tq-iconbtn" onClick={onClose} aria-label="Back to the full motor view" data-testid="twin-close"><X size={16} aria-hidden="true" /></button>
      </header>
      <Pill tone={tone}>{tone === 'ok' ? (model.source === 'SIMULATION' ? 'simulated readings available' : 'live readings') : tone === 'warn' ? 'readings stale' : tone === 'crit' ? 'invalid reading' : 'no current reading'}</Pill>
      <Evidence alerts={(model.alerts || []).filter((a) => a.part === part.id)} />
      <div className="tq-tw-readings">
        {part.readings.length ? part.readings.map((r) => <ReadingRow key={r.key} r={r} source={model.source} active={r.key === trendKey} onTrend={setTrendKey} />)
          : <Empty>This part reports no reading of its own.</Empty>}
      </div>
      {part.notes?.length > 0 && <ul className="tq-tw-notes">{part.notes.map((n) => <li key={n}><Info size={13} aria-hidden="true" />{n}</li>)}</ul>}
      {reading && (
        <div className="tq-tw-trend" data-testid="twin-trend">
          <h4>{reading.label} trend</h4>
          {renderTrend(part, reading)}
        </div>
      )}
      <ComponentFacts id={part.id} />
      <button type="button" className="tq-btn tq-tw-back" onClick={onClose}><Maximize2 size={14} aria-hidden="true" />Full motor view</button>
    </div>
  );
}

/** A mechanical, power or wiring component: identification only, with links to the sensors that observe it. It has no reading to show. */
function StructureDetail({ id, model, onClose, onSelect }) {
  const c = COMPONENT[id];
  const related = (c.related || []).map((r) => model.parts.find((p) => p.id === r)).filter(Boolean);
  return (
    <div className="tq-tw-detail" data-testid="twin-detail" aria-live="polite">
      <header className="tq-tw-detail-head">
        <div><span className="tq-tw-eyebrow">{c.part}</span><h3>{c.name}</h3><span className="tq-tw-iface">{KIND_LABEL[c.kind]} · no sensor of its own</span></div>
        <button type="button" className="tq-iconbtn" onClick={onClose} aria-label="Back to the full motor view" data-testid="twin-close"><X size={16} aria-hidden="true" /></button>
      </header>
      <Evidence alerts={(model.alerts || []).filter((a) => a.part === id)} />
      <p className="tq-tw-hint">The twin shows no reading for this part and makes no claim about its condition.</p>
      {related.length > 0 && (
        <div>
          <span className="tq-tw-eyebrow">Observed through</span>
          <ul className="tq-tw-partlist tq-mt-xs">
            {related.map((p) => {
              const lead = p.readings[0];
              return (
                <li key={p.id}><button type="button" onClick={() => onSelect(p.id)}>
                  <span className={`tq-tw-dot tq-${partTone(p)}`} aria-hidden="true" />
                  <span className="tq-tw-partlist-name"><strong>{p.name}</strong><small>{p.part}</small></span>
                  <span className="tq-tw-partlist-val tq-num">{lead ? shown(lead) : p.summary}</span><ChevronRight size={15} aria-hidden="true" />
                </button></li>
              );
            })}
          </ul>
        </div>
      )}
      <ComponentFacts id={id} />
      <button type="button" className="tq-btn tq-tw-back" onClick={onClose}><Maximize2 size={14} aria-hidden="true" />Full motor view</button>
    </div>
  );
}

function Overview({ model, items, onSelect }) {
  const structure = items.filter((i) => !i.sensor);
  return (
    <div className="tq-tw-detail" data-testid="twin-overview">
      <header className="tq-tw-detail-head"><div><span className="tq-tw-eyebrow">Full motor view</span><h3>Parts and readings</h3></div></header>
      <p className="tq-muted tq-tw-hint">Select a part on the model or in this list to inspect its readings, provenance and trend.</p>
      <ul className="tq-tw-partlist" aria-label="Sensors and electronics">
        {model.parts.map((p) => {
          const lead = p.readings[0];
          const tone = partTone(p);
          return (
            <li key={p.id}>
              <button type="button" onClick={() => onSelect(p.id)} data-testid={`twin-part-${p.id}`}>
                <span className={`tq-tw-dot tq-${tone}`} aria-hidden="true" />
                <span className="tq-tw-partlist-name"><strong>{p.name}</strong><small>{p.part}</small></span>
                <span className="tq-tw-partlist-val tq-num">{lead ? shown(lead) : p.summary}</span>
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

/** Catches a failure inside the 3D viewport so the page falls back to the 2D drawing instead of breaking. */
class ViewBoundary extends React.Component {
  constructor(props) { super(props); this.state = { failed: false }; }
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error) { this.props.onError(`The 3D view failed (${error?.message || 'rendering error'}).`); }
  render() { return this.state.failed ? null : this.props.children; }
}

/** The model area: the 3D viewport when WebGL 2 works, otherwise (or by choice) the 2D drawing. Both get the same parts and selection. */
function Stage({ model, items, selected, setSelected }) {
  const [gl] = useState(webgl2Available);
  const [view, setView] = useState(gl ? '3d' : '2d');
  const [notice, setNotice] = useState(gl ? null : 'This browser has no WebGL 2, so the 2D drawing is shown.');
  const [zoom, setZoom] = useState(true);
  const fallback = (why) => { setNotice(`${why} Showing the 2D drawing.`); setView('2d'); };
  const sensors = items.filter((i) => i.sensor);
  return (
    <section className="tq-tw-stage" aria-labelledby="tw-stage-h">
      <header className="tq-tw-stage-head">
        <h3 id="tw-stage-h"><Box size={16} aria-hidden="true" />Motor rig</h3>
        <div className="tq-tw-stage-tools">
          <ul className="tq-tw-legend" aria-label="Legend">{LEGEND.map(([t, l]) => <li key={t}><span className={`tq-tw-dot tq-${t}`} aria-hidden="true" />{l}</li>)}</ul>
          {view === '2d' && <button type="button" className={`tq-btn tq-btn-sm${zoom ? ' is-on' : ''}`} aria-pressed={zoom} onClick={() => setZoom((z) => !z)}><Crosshair size={14} aria-hidden="true" />Zoom to selection</button>}
          {gl && (
            <div className="tq-t3-seg" role="group" aria-label="Model view">
              <button type="button" className={`tq-t3-seg-btn${view === '3d' ? ' is-on' : ''}`} aria-pressed={view === '3d'} onClick={() => { setNotice(null); setView('3d'); }} data-testid="twin-view-3d">3D model</button>
              <button type="button" className={`tq-t3-seg-btn${view === '2d' ? ' is-on' : ''}`} aria-pressed={view === '2d'} onClick={() => setView('2d')} data-testid="twin-view-2d">2D drawing</button>
            </div>
          )}
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
  const head = <PageHead title="Digital Twin" sub="Interactive 3D motor model and synchronized telemetry" right={<Pill tone="info">{model.source === 'SIMULATION' ? 'SIMULATION MODE' : 'PHYSICAL MODE'}</Pill>} />;
  if (model.loading) return <>{head}<Empty loading>Loading the current state…</Empty></>;
  const part = model.parts.find((p) => p.id === selected);
  const items = twinItems(model);
  return (
    <div className="tq-tw" data-testid="twin-page" data-source={model.source}>
      {head}
      <TwinStatusBar model={model} />
      <Kpis model={model} onSelect={setSelected} selected={selected} />
      <div className="tq-tw-work">
        <Stage model={model} items={items} selected={selected} setSelected={setSelected} />
        <aside className="tq-tw-side" aria-label="Component inspection">
          {part ? <SensorDetail part={part} model={model} onClose={() => setSelected(null)} renderTrend={renderTrend} />
            : selected && COMPONENT[selected] ? <StructureDetail id={selected} model={model} onClose={() => setSelected(null)} onSelect={setSelected} />
              : <Overview model={model} items={items} onSelect={setSelected} />}
        </aside>
      </div>
      <div className="tq-grid tq-tw-support">
        <Card title="Findings" id="tw-findings">
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
        <Card title="Data source" id="tw-source">
          <dl className="tq-tw-facts">{model.facts.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
          {aside}
        </Card>
      </div>
      <details className="tq-disclosure tq-mt">
        <summary>Sensor inventory</summary>
        <div className="tq-disclosure-body">
          <Card title="Parts of the rig" id="tw-inv">
            <table className="tq-table"><caption className="tq-sr">Sensor inventory</caption>
              <thead><tr><th scope="col">Part</th><th scope="col">Measures</th><th scope="col">Intended interface (unverified)</th><th scope="col">Status</th></tr></thead>
              <tbody>{INVENTORY.map(([id, name, what, iface]) => {
                const p = model.parts.find((x) => x.id === id);
                const tone = p ? partTone(p) : 'off';
                return <tr key={id}><td>{name}</td><td className="tq-muted">{what}</td><td className="tq-muted">{iface}</td><td><Pill tone={tone}>{tone === 'ok' ? 'reading' : tone === 'warn' ? 'stale' : tone === 'crit' ? 'invalid' : 'unavailable'}</Pill></td></tr>;
              })}</tbody>
            </table>
          </Card>
        </div>
      </details>
      <details className="tq-disclosure tq-mt">
        <summary>Model assumptions and limitations</summary>
        <div className="tq-disclosure-body">
          <ul className="tq-tw-limits">
            <li>The 3D model is illustrative. It is built from the RS-775 motor type, typical breakout-board sizes and the rig build notes, not from a CAD model or measurements of this rig. Sensor positions, the disc size and the wiring are not verified.</li>
            <li>The motor internals shown in the section and exploded views (magnets, armature, commutator, brushes) are generic for a brushed PM motor of this type, not scanned from this unit.</li>
            <li>The twin only displays values supplied by the backend. It does not run its own physics, fill gaps, interpolate or estimate readings.</li>
            <li>Power is always derived, never measured directly: the firmware computes it from the INA219 voltage and current (physical), or the browser multiplies the voltage and current of the same simulated window (simulation). Both are labelled DERIVED.</li>
            <li>The ADXL345 reports raw acceleration including gravity. The firmware does not compute vibration RMS, so none is shown for the physical device; the simulator&apos;s vibration value is a simulated quantity.</li>
            <li>The shaft animation is presentation only. It runs only while the source reports a valid, current, non-zero speed, at a reduced rate and in one direction (the real direction depends on unverified motor polarity), and it never feeds any model or safety decision.</li>
            <li>A part is highlighted as an alert only when the source names it: a reading the device marked invalid, a safety trip the firmware attributes to that sensor&apos;s reading, or (simulation only) the fault the scenario injected. The absence of an alert says nothing about a part&apos;s health.</li>
            <li>The status LEDs and the OLED are drawn unlit because their state is not reported. This page sends no commands; motor control stays on its existing, supervised pages.</li>
          </ul>
        </div>
      </details>
    </div>
  );
}
