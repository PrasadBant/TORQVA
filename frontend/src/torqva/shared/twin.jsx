// Digital Twin workspace: the rig drawing, its hotspots, a sensor detail panel and the key readings. Presentation only.
// It receives an already-mapped `model` (built by simulation/twin.jsx from the simulator API or by physical/twin.jsx from the device stream) and never
// fetches, computes a reading, or sends a command. A reading it is not given is shown as unavailable, never as zero.
//
// model = {
//   source: 'SIMULATION' | 'PHYSICAL', loading,
//   state: { tone, label, detail },        operating state as reported (motor / simulation)
//   clock: { tone, label } | null,         simulation advancing or paused (simulation only)
//   connection: { tone, label },           backend / device connection
//   updated: string,                       when the shown values were observed
//   motion: { spinning, rpm, note },       spinning only when the source reports a valid, current, non-zero speed
//   parts: [{ id, name, short, part, iface, tone?, readings: [Reading], notes: [string] }],
//   kpis: [[partId, readingKey]], findings: [{ tone, label, detail, go: [view, text] }], facts: [[label, value]],
// }
// Reading = { key, label, unit, digits, value: number | null, status: 'ok' | 'stale' | 'invalid' | 'unavailable', prov, note, observed, trend }
import React, { useEffect, useState } from 'react';
import { Box, Crosshair, Maximize2, X, ChevronRight, Info } from 'lucide-react';
import { Card, Empty, Pill, ProvBadge, PageHead, fmt } from './components.jsx';
import { MotorModel, SPIN_SCALE } from './twinModel.jsx';

const TONE = { ok: 'ok', stale: 'warn', invalid: 'crit', unavailable: 'off' };
const RANK = { ok: 0, unavailable: 1, stale: 2, invalid: 3 };
const STATUS_TEXT = { ok: null, stale: 'STALE', invalid: 'INVALID', unavailable: 'UNAVAILABLE' };

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
      <button type="button" className="tq-btn tq-tw-back" onClick={onClose}><Maximize2 size={14} aria-hidden="true" />Full motor view</button>
    </div>
  );
}

function Overview({ model, onSelect }) {
  return (
    <div className="tq-tw-detail" data-testid="twin-overview">
      <header className="tq-tw-detail-head"><div><span className="tq-tw-eyebrow">Full motor view</span><h3>Parts and readings</h3></div></header>
      <p className="tq-muted tq-tw-hint">Select a part on the drawing or in this list to inspect its readings, provenance and trend.</p>
      <ul className="tq-tw-partlist">
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

export function DigitalTwin({ model, renderTrend, go, aside }) {
  const [selected, setSelected] = useState(null);
  const [zoom, setZoom] = useState(true);
  useEffect(() => {
    if (!selected) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setSelected(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected]);
  const head = <PageHead title="Digital Twin" sub="Interactive motor model and synchronized telemetry" right={<Pill tone="info">{model.source === 'SIMULATION' ? 'SIMULATION MODE' : 'PHYSICAL MODE'}</Pill>} />;
  if (model.loading) return <>{head}<Empty loading>Loading the current state…</Empty></>;
  const part = model.parts.find((p) => p.id === selected);
  const drawn = model.parts.map((p) => {
    const lead = p.readings[0];
    return { id: p.id, name: p.name, short: p.short, tone: partTone(p), value: lead ? shown(lead) : p.summary, summary: lead ? `${lead.label} ${shown(lead)}` : p.summary };
  });
  return (
    <div className="tq-tw" data-testid="twin-page" data-source={model.source}>
      {head}
      <TwinStatusBar model={model} />
      <Kpis model={model} onSelect={setSelected} selected={selected} />
      <div className="tq-tw-work">
        <section className="tq-tw-stage" aria-labelledby="tw-stage-h">
          <header className="tq-tw-stage-head">
            <h3 id="tw-stage-h"><Box size={16} aria-hidden="true" />Motor rig</h3>
            <div className="tq-tw-stage-tools">
              <ul className="tq-tw-legend" aria-label="Legend">{LEGEND.map(([t, l]) => <li key={t}><span className={`tq-tw-dot tq-${t}`} aria-hidden="true" />{l}</li>)}</ul>
              <button type="button" className={`tq-btn tq-btn-sm${zoom ? ' is-on' : ''}`} aria-pressed={zoom} onClick={() => setZoom((z) => !z)}><Crosshair size={14} aria-hidden="true" />Zoom to selection</button>
            </div>
          </header>
          <div className="tq-tw-canvas">
            <MotorModel parts={drawn} selected={selected} onSelect={setSelected} spinning={model.motion.spinning} rpm={model.motion.rpm} zoom={zoom} />
          </div>
          <div className="tq-tw-chips" role="group" aria-label="Parts">
            {drawn.map((p) => (
              <button key={p.id} type="button" className={`tq-tw-chip${selected === p.id ? ' is-sel' : ''}`} aria-pressed={selected === p.id} onClick={() => setSelected(selected === p.id ? null : p.id)}>
                <span className={`tq-tw-dot tq-${p.tone}`} aria-hidden="true" />{p.short}
              </button>
            ))}
          </div>
          <p className="tq-tw-caption" data-testid="twin-motion-note">
            <strong>Illustrative model, not CAD-accurate.</strong> Proportions, sensor positions and wiring are drawn for readability and are not verified. {model.motion.note}
            {model.motion.spinning && ` The shaft animation turns at 1/${SPIN_SCALE} of the reported speed so it stays readable; it is presentation only.`}
          </p>
        </section>
        <aside className="tq-tw-side">
          {part ? <SensorDetail part={part} model={model} onClose={() => setSelected(null)} renderTrend={renderTrend} /> : <Overview model={model} onSelect={setSelected} />}
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
            <li>The drawing is illustrative. It is not a CAD model and makes no claim about dimensions, sensor placement or wiring; the wiring of the real rig is not verified.</li>
            <li>The twin only displays values supplied by the backend. It does not run its own physics, fill gaps, interpolate or estimate readings.</li>
            <li>Power is always derived, never measured directly: the firmware computes it from the INA219 voltage and current (physical), or the browser multiplies the voltage and current of the same simulated window (simulation). Both are labelled DERIVED.</li>
            <li>The ADXL345 reports raw acceleration including gravity. The firmware does not compute vibration RMS, so none is shown for the physical device; the simulator&apos;s vibration value is a simulated quantity.</li>
            <li>The shaft animation is presentation only. It runs only while the source reports a valid, current, non-zero speed, at a reduced rate, and it never feeds any model or safety decision.</li>
            <li>This page sends no commands. Motor control stays on its existing, supervised pages.</li>
          </ul>
        </div>
      </details>
    </div>
  );
}
