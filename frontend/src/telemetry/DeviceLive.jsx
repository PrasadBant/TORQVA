import React, { useEffect, useMemo, useState } from 'react';
import { Activity, Gauge, Move3d, Plug, SlidersHorizontal, Thermometer, Waves, Zap } from 'lucide-react';
import { api } from '../shared/api.js';
import { AlertPanel, Card, ChartPanel, DataTable, ErrorBox, MetricList, SourceTag, fmt, title } from '../components/components.jsx';
import { HistoryChart } from '../shared/lazyCharts.jsx';
import { TelemetryWindowControl } from '../shared/windows.jsx';
import { CopySummaryButton } from '../shared/recording.jsx';
import { useAlarmContext, RpmAlarmBanner } from '../safety/alarmContext.jsx';
import { ago, clock, originOf, readingOf } from './devicePresentation.js';

/* ------------------------------------------------------------------ Device history (Live Monitor, Overview mini charts) */
/** Polls /device/history for several signals while `enabled`. Each series is [[unix, value|null]]; null is an invalid reading (a gap), never zero.
 *  Nothing is fetched without a device handshake, and the series are cleared when it is lost. */
export function useDeviceHistories(signals, seconds, enabled, everyMs = 2500) {
  const [series, setSeries] = useState({});
  const [err, setErr] = useState(null);
  const key = signals.join(',');
  useEffect(() => {
    if (!enabled) { setSeries({}); return undefined; }
    let on = true;
    const load = () => Promise.all(key.split(',').map((s) => api.deviceHistory(s, seconds).then((r) => [s, Array.isArray(r?.points) ? r.points : []], (e) => [s, null, e])))
      .then((rs) => {
        if (!on) return;
        const bad = rs.find((r) => r[2]);
        setErr(bad ? bad[2] : null);
        setSeries((prev) => Object.fromEntries(rs.map(([s, p]) => [s, p || prev[s] || []])));
      });
    load();
    const id = setInterval(load, everyMs);
    return () => { on = false; clearInterval(id); };
  }, [key, seconds, enabled, everyMs]);
  return { series, err };
}

// Signals the device history supports, with display metadata: [key, title, unit, digits, provenance when physical, sensor colour, note].
export const LIVE_SIGNALS = [
  ['rpm', 'Speed (Hall sensor)', 'rpm', 0, 'MEASURED', 'var(--tq-sig-rpm)', 'measured shaft speed'],
  ['current', 'Current', 'A', 2, 'MEASURED', 'var(--tq-sig-current)', 'motor current'],
  ['housing', 'Housing temperature', '°C', 1, 'MEASURED', 'var(--tq-sig-temp)', 'motor housing'],
  ['voltage', 'DC bus voltage', 'V', 1, 'MEASURED', 'var(--tq-sig-voltage)', 'supply'],
  ['power', 'Motor power', 'W', 1, 'DERIVED', 'var(--tq-sig-power)', 'computed by the firmware from V × I'],
  ['acceleration', 'Total acceleration', 'g', 3, 'MEASURED', 'var(--tq-sig-vib)', 'includes gravity; raw per-axis values; NOT vibration RMS'],
  ['duty', 'Drive duty (command)', '%', 1, 'COMMAND', 'var(--tq-chart-ink)', 'commanded, not measured'],
];
const SIG_ICON = { rpm: Gauge, current: Zap, housing: Thermometer, voltage: Plug, power: Zap, acceleration: Move3d, duty: SlidersHorizontal };
const RANGES = [[60, '60 s'], [180, '3 min'], [360, '6 min']];
const rangeName = (s) => (s < 120 ? `${s} s` : `${s / 60} min`);
const SAMPLE_KEYS = ['rpm', 'current', 'voltage', 'power', 'housing', 'duty'];        // one backend history record per frame: these share timestamps

/** A reading that may be shown as a number: present, valid and finite. Anything else is UNAVAILABLE, never zero. */

/* ------------------------------------------------------------------ Live device charts (Live Monitor in both modes) */
export function DeviceLive({ stream }) {
  const { snap } = stream;
  const [seconds, setSeconds] = useState(60);
  const [viewMode, setViewMode] = useState('grid');
  const o = originOf(snap);
  const { series, err } = useDeviceHistories(LIVE_SIGNALS.map((s) => s[0]), seconds, !!snap?.handshake);
  const stale = snap && !snap.telemetry_fresh;
  const vals = snap?.values || {};
  const provOf = (p) => (o.physical ? p : 'SIMULATED');
  const rpmReading = readingOf(vals.rpm);
  const isRunning = snap?.state === 2 || snap?.state === 'RUNNING' || (snap?.state_label && snap.state_label.includes('RUNNING')) || (rpmReading !== null && rpmReading > 50);
  const { evaluate } = useAlarmContext();
  useEffect(() => {
    evaluate({ rpm: rpmReading, isRunning, valid: vals.rpm?.valid !== false && rpmReading !== null });
  }, [rpmReading, isRunning, vals.rpm, evaluate]);

  const stats = useMemo(() => {
    const res = {};
    for (const [k] of LIVE_SIGNALS) {
      const pts = (series[k] || []).map(([, y]) => y).filter((y) => y !== null && Number.isFinite(y));
      if (pts.length) {
        res[k] = { min: Math.min(...pts), max: Math.max(...pts) };
      } else {
        res[k] = null;
      }
    }
    return res;
  }, [series]);

  const rows = useMemo(() => {
    const m = new Map();
    for (const k of SAMPLE_KEYS) for (const [t, v] of series[k] || []) { const r = m.get(t) || { t }; r[k] = v; m.set(t, r); }
    return [...m.values()].sort((a, b) => b.t - a.t).slice(0, 10);
  }, [series]);
  const n = (v, d) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? '—' : fmt(v, d));

  const recentCommands = useMemo(() => {
    return (stream.commands || []).slice(0, 6);
  }, [stream.commands]);

  return (
    <div className="tq-stack tq-mon-live">
      <RpmAlarmBanner rpm={rpmReading} />

      {/* Sensor Health, Frame Rate, and Dropped Frames */}
      <div className="tq-card" style={{ padding: '10px 14px', background: 'var(--tq-surface-2, rgba(255,255,255,0.03))', borderRadius: '6px' }} data-testid="sensor-health-bar">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.85rem' }}>
            <strong>Telemetry Health:</strong>
            <span className="tq-chip" data-testid="sensor-rate" title="Measured browser telemetry rate">{stream.frameRate == null ? "Rate unavailable" : `${stream.frameRate} Hz to browser`}</span>
            <span className={`tq-chip ${stream.droppedCount > 0 ? 'tq-chip-warn' : 'tq-chip-ok'}`} data-testid="dropped-frames-counter" title="Dropped, missing, or malformed frames">
              {stream.droppedCount || 0} dropped frames
            </span>
            {snap?.last_rx_unix && <span className="tq-small tq-muted">Last seen: {ago(snap.last_rx_unix)}</span>}
          </div>
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', fontSize: '0.75rem' }}>
            {['rpm', 'current', 'voltage', 'power', 'housing'].map((k) => {
              const item = vals[k];
              const isOk = item?.valid && !item?.stale;
              const isStale = item?.stale;
              const label = k === 'rpm' ? 'RPM' : k === 'housing' ? 'TEMP' : k.toUpperCase();
              return (
                <span key={k} className={`tq-pill tq-pill--${isOk ? 'ok' : isStale ? 'warn' : 'off'}`} data-testid={`sensor-status-${k}`} title={`${label}: ${isOk ? 'Valid' : isStale ? 'Stale' : 'Unavailable'}`}>
                  {label}: {isOk ? 'VALID' : isStale ? 'STALE' : 'UNAVAILABLE'}
                </span>
              );
            })}
          </div>
        </div>
      </div>

      <div className="tq-toolbar">
        <div className="tq-seg" role="group" aria-label="Chart view mode" style={{ marginRight: '8px' }}>
          <button type="button" className="tq-btn tq-small" aria-pressed={viewMode === 'grid'} onClick={() => setViewMode('grid')}>Individual Channels</button>
          <button type="button" className="tq-btn tq-small" aria-pressed={viewMode === 'shared'} onClick={() => setViewMode('shared')} data-testid="btn-shared-axis">Shared Time Axis (Overlay)</button>
        </div>
        <TelemetryWindowControl seconds={seconds} onChange={setSeconds} />
        <CopySummaryButton mode="PHYSICAL" />
        <span className="tq-grow" />
        <SourceTag kind={stale && snap?.handshake ? 'STALE' : o.physical ? 'PHYSICAL' : snap?.handshake ? 'SIMULATED' : 'UNKNOWN'} />
      </div>

      <p className={`tq-callout ${o.physical ? '' : 'warn'}`} role="note">
        {o.physical ? 'Values below are measurements reported by the connected ESP32-S3.' : snap?.handshake ? 'The connected firmware reports SIMULATION mode: these are not physical measurements.' : 'No device is connected. There is no physical-device telemetry; nothing here is simulated or invented.'}
        {' '}Gaps mean invalid readings or a disconnect; they are never drawn as zero.
      </p>
      {stale && snap?.handshake && (
        <AlertPanel tone="warn" title={`Telemetry is STALE: last frame ${fmt(snap.telemetry_age_s, 1)} s ago. Showing the last readings, not live data.`} testid="dev-stale" />)}
      <ErrorBox error={err} />

      {viewMode === 'shared' ? (
        <Card title="Shared Time Axis: Multi-Signal Monitor" id="dev-shared-axis-card" icon={Activity}
          sub={`rpm, current, voltage, power, and temperature plotted on a shared time axis (${rangeName(seconds)} window)`}
          data-testid="shared-axis-monitor"
          right={<span className="tq-small tq-muted">Synchronized {seconds}s time base</span>}
          foot={
            <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'center' }}>
              <span className="tq-muted tq-small">Min/Max in window:</span>
              {['rpm', 'current', 'voltage', 'power', 'housing'].map((k) => {
                const st = stats[k];
                if (!st) return null;
                const d = k === 'current' ? 2 : k === 'rpm' ? 0 : 1;
                const u = k === 'rpm' ? 'rpm' : k === 'current' ? 'A' : k === 'voltage' ? 'V' : k === 'power' ? 'W' : '°C';
                return (
                  <span key={k} className="tq-chip" style={{ fontSize: '0.75rem' }}>
                    <strong>{k.toUpperCase()}</strong>: {fmt(st.min, d)}–{fmt(st.max, d)} {u}
                  </span>
                );
              })}
            </div>
          }>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {['rpm', 'current', 'voltage', 'power', 'housing'].map((k) => {
              const sig = LIVE_SIGNALS.find(([sk]) => sk === k);
              if (!sig) return null;
              const [, name, unit, d, , color] = sig;
              const pts = (series[k] || []).map(([t, y]) => ({ t, v: y }));
              return (
                <div key={k} style={{ borderBottom: '1px solid var(--tq-border, rgba(255,255,255,0.06))', paddingBottom: '6px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', marginBottom: '2px' }}>
                    <span style={{ color, fontWeight: 600 }}>{name} ({unit})</span>
                    <span className="tq-num">{pts.length ? `${fmt(pts[pts.length - 1].v, d)} ${unit}` : '—'}</span>
                  </div>
                  {pts.length ? (
                    <div role="img" aria-label={`${name} history`} className="tq-chart">
                      <HistoryChart data={pts} name={`${name} (${unit})`} height={75} color={color} digits={d} unit={unit} />
                    </div>
                  ) : <p className="tq-mon-nochart" style={{ padding: '8px 0' }}>No points</p>}
                </div>
              );
            })}
          </div>

          {recentCommands.length > 0 && (
            <div style={{ marginTop: '12px', paddingTop: '8px', borderTop: '1px solid var(--tq-border, #334155)' }}>
              <span className="tq-muted tq-small">Recent Event Markers:</span>
              <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '4px' }}>
                {recentCommands.map((c) => (
                  <span key={c.id} className="tq-chip" style={{ fontSize: '0.72rem' }}>
                    #{c.id} {c.action} ({c.state}) · {clock(c.created_unix)}
                  </span>
                ))}
              </div>
            </div>
          )}
        </Card>
      ) : (
        <div className="tq-mon-livegrid">
          <div className="tq-mon-charts">
            {LIVE_SIGNALS.map(([k, name, unit, d, prov, color, note]) => {
              const v = vals[k]; const x = readingOf(v); const pts = series[k] || [];
              const data = pts.map(([t, y]) => ({ t, v: y }));
              const I = SIG_ICON[k] || Activity;
              const st = stats[k];
              const minMaxTxt = st ? ` · min ${fmt(st.min, d)} / max ${fmt(st.max, d)}` : '';
              return (
                <ChartPanel key={k} id={`dev-ch-${k}`} testid={`dev-chart-${k}`} title={<><I size={15} aria-hidden="true" style={{ color }} /> {name}</>}
                  value={x === null ? null : fmt(x, d)} unit={unit} prov={x === null ? undefined : provOf(prov)}
                  right={x !== null && v.stale ? <SourceTag kind="STALE" /> : null}
                  foot={`${note} · last ${rangeName(seconds)}${pts.length ? ` · ${pts.length} pts${minMaxTxt}` : ''}${x === null && v && !v.valid && v.origin !== 'unavailable' ? ' · invalid sensor reading' : ''}`}>
                  {data.length ? (
                    <div role="img" aria-label={`${name} history, last ${rangeName(seconds)}`} className="tq-chart"><HistoryChart data={data} name={`${name} (${unit})`} height={150} color={color} digits={d} unit={unit} /></div>
                  ) : <p className="tq-mon-nochart">No device history in this window. History exists only while a device is sending telemetry.</p>}
                </ChartPanel>);
            })}
            <ChartPanel id="dev-ch-vib" testid="dev-chart-vib" title={<><Waves size={15} aria-hidden="true" style={{ color: 'var(--tq-sig-vib)' }} /> Vibration RMS</>} value={null}
              foot="see total acceleration for the raw accelerometer">
              <p className="tq-mon-nochart">the firmware does not compute it</p>
            </ChartPanel>
          </div>
          <div className="tq-stack">
            <Card title="Telemetry details" id="c-devdetails" sub={snap?.last_rx_unix ? `last frame ${clock(snap.last_rx_unix)}` : 'no frame received'}>
              <MetricList label="Telemetry details" testid="dev-metrics" items={[
                ...LIVE_SIGNALS.map(([k, name, unit, d, prov, color]) => { const x = readingOf(vals[k]); return { key: k, label: name, icon: SIG_ICON[k], color, value: x === null ? null : fmt(x, d), unit, prov: x === null ? undefined : provOf(prov), missingText: 'UNAVAILABLE' }; }),
                ...(vals.ambient ? [{ key: 'ambient', label: 'Ambient temperature', icon: Thermometer, value: readingOf(vals.ambient) === null ? null : fmt(readingOf(vals.ambient), 1), unit: '°C', prov: readingOf(vals.ambient) === null ? undefined : provOf('MEASURED'), missingText: 'UNAVAILABLE' }] : []),
                { key: 'drive', label: 'Drive mode', value: snap?.handshake ? (snap.drive || null) : null },
                { key: 'src', label: 'Data source', value: o.label },
                { key: 'upd', label: 'Last updated', value: snap?.last_rx_unix ? ago(snap.last_rx_unix) : null, missingText: 'never' },
              ]} />
            </Card>
          </div>
        </div>
      )}
      <Card title="Latest telemetry samples" id="c-devsamples" sub="Newest first; — means invalid or missing, never zero">
        <DataTable testid="dev-samples" caption="Latest device telemetry samples" rowKey={(r) => r.t} rows={rows} empty="No samples in this window."
          columns={[{ key: 't', label: 'Time', render: (r) => clock(r.t) }, { key: 'rpm', label: 'Speed (rpm)', align: 'num', render: (r) => n(r.rpm, 0) },
          { key: 'current', label: 'Current (A)', align: 'num', render: (r) => n(r.current, 2) }, { key: 'voltage', label: 'Voltage (V)', align: 'num', render: (r) => n(r.voltage, 1) },
          { key: 'power', label: 'Power (W)', align: 'num', render: (r) => n(r.power, 1) }, { key: 'housing', label: 'Temp (°C)', align: 'num', render: (r) => n(r.housing, 1) },
          { key: 'duty', label: 'Duty (%)', align: 'num', render: (r) => n(r.duty, 1) }]} />
      </Card>
    </div>
  );
}
