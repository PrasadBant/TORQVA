// Every Recharts chart in the app. This is the only module that imports recharts (about half of the JavaScript), so it is loaded on demand
// through lazyCharts.jsx instead of delaying the sign-in page and the physical dashboard, which draw no chart.
// Shared rules: axis ticks and tooltips use the chart's own precision (`digits`), the unit sits at the top of the value axis, a missing value
// stays a gap (no line is drawn through it), and a prediction is always dashed with its interval shaded, never drawn like a measurement.
import React, { useId } from 'react';
import { LineChart, Line, ComposedChart, AreaChart, Area, XAxis, YAxis, Tooltip, Legend, ReferenceLine, ResponsiveContainer, CartesianGrid } from 'recharts';
import { AXIS, GRID, TOOLTIP, LEGEND } from './components.jsx';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
/** A value at a fixed precision, or as given when it is not a number. Large values never carry decimals on an axis. */
export const fixed = (v, digits, axis = false) => (!isNum(v) ? v : Number(v).toFixed(axis && Math.abs(v) >= 100 ? 0 : digits));
/** Tooltip text for one series value: the number at the chart's precision with its unit; a [low, high] pair as an interval. */
export const tipValue = (v, digits, unit = '') => {
  const u = unit ? ` ${unit}` : '';
  if (Array.isArray(v) && v.length === 2 && v.every(isNum)) return `${fixed(v[0], digits)}–${fixed(v[1], digits)}${u}`;
  if (typeof v === 'number') return isNum(v) ? `${fixed(v, digits)}${u}` : '—';      // NaN / Infinity is not a reading
  return v ?? '—';
};
const unitLabel = (unit) => (unit ? { value: unit, position: 'insideTopLeft', offset: 0, dy: -18, fill: 'var(--tq-text-2)', fontSize: 11 } : undefined);

/** KPI sparkline (decorative; the tile shows the value). */
export function Sparkline({ data, dataKey, color, height }) {
  const gid = `tqk${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
        <defs><linearGradient id={gid} x1="0" y1="0" x2="0" y2="1"><stop offset="0" style={{ stopColor: color, stopOpacity: 0.22 }} /><stop offset="1" style={{ stopColor: color, stopOpacity: 0 }} /></linearGradient></defs>
        <YAxis hide domain={['dataMin', 'dataMax']} />
        <Area dataKey={dataKey} stroke={color} strokeWidth={1.75} fill={`url(#${gid})`} dot={false} isAnimationActive={false} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

/** Telemetry over simulation time (seconds). */
// `marks`: optional event lines [{ t, at, n, label }]: numbered, drawn at `at` (an existing sample time, as the x axis is categorical); the caller lists what each number is.
export function TrendLines({ data, lines, height, yDomain, digits = 2, unit = '', marks = [] }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: unit ? 22 : 6, right: 10, bottom: 0, left: 0 }}><CartesianGrid {...GRID} /><XAxis dataKey="t" minTickGap={28} tickFormatter={(x) => `${Math.round(x)}s`} {...AXIS} /><YAxis domain={yDomain || ['auto', 'auto']} width={54} tickFormatter={(v) => fixed(v, digits, true)} label={unitLabel(unit)} {...AXIS} axisLine={false} />
        <Tooltip {...TOOLTIP} formatter={(v) => tipValue(v, digits, unit)} labelFormatter={(x) => `t = ${Math.round(x)} s`} /><Legend {...LEGEND} />{lines.map((l) => <Line key={l.key} dataKey={l.key} name={l.name} stroke={l.color} strokeDasharray={l.dash} strokeWidth={l.dash ? 1.5 : 2} dot={false} activeDot={{ r: 3.5, strokeWidth: 0 }} isAnimationActive={false} connectNulls={false} />)}
      {marks.map((m, i) => <ReferenceLine key={`${m.t}-${m.label}`} x={m.at ?? m.t} stroke="var(--tq-muted)" strokeDasharray="3 3" label={{ value: String(m.n ?? i + 1), position: i % 2 ? 'insideBottomRight' : 'insideTopRight', fill: 'var(--tq-text-2)', fontSize: 11, fontWeight: 600 }} />)}
        </LineChart>
    </ResponsiveContainer>
  );
}

/** Anomaly severity: the anomaly score divided by the learned threshold, log scale (1 = threshold). */
export function ScoreChart({ data, height }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 22, right: 10, bottom: 0, left: 0 }}><CartesianGrid {...GRID} /><XAxis dataKey="t" minTickGap={28} tickFormatter={(x) => `${Math.round(x)}s`} {...AXIS} />
        <YAxis scale="log" domain={[0.05, 'auto']} allowDataOverflow width={46} tickFormatter={(x) => (x >= 1 ? x.toFixed(0) : x.toFixed(2))} label={unitLabel('× threshold')} {...AXIS} axisLine={false} />
        <Tooltip {...TOOLTIP} formatter={(v) => tipValue(v, 2, '× threshold')} labelFormatter={(x) => `t = ${Math.round(x)} s`} /><Legend {...LEGEND} />
        <ReferenceLine y={1} stroke="var(--tq-crit)" strokeDasharray="4 3" label={{ value: 'threshold = 1', position: 'insideTopRight', fill: 'var(--tq-crit)', fontSize: 11 }} />
        <Line dataKey="score" stroke="var(--tq-chart-1)" strokeWidth={2} dot={false} activeDot={{ r: 3.5, strokeWidth: 0 }} isAnimationActive={false} connectNulls={false} name="Anomaly severity" /></LineChart></ResponsiveContainer>
  );
}

/** Predicted response with its 90 % interval over the prediction horizon. Point 0 is the current simulated value (marked "now"); the rest is
 *  the model's estimate, always dashed with the interval shaded, so it never reads as measured behaviour. */
export function ResponseChart({ data, height, yDomain, digits = 1, unit = '' }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={data} margin={{ top: unit ? 22 : 6, right: 10, bottom: 0, left: 0 }}><CartesianGrid {...GRID} /><XAxis dataKey="h" type="number" domain={[0, 120]} ticks={[0, 30, 60, 120]} tickFormatter={(x) => (x === 0 ? 'now' : `+${x}s`)} {...AXIS} /><YAxis width={50} domain={yDomain || ['auto', 'auto']} allowDataOverflow={!!yDomain} tickFormatter={(v) => fixed(v, digits, true)} label={unitLabel(unit)} {...AXIS} axisLine={false} />
        <Tooltip {...TOOLTIP} formatter={(v) => tipValue(v, digits, unit)} labelFormatter={(x) => (x === 0 ? 'now (current simulated value)' : `+${x} s (predicted)`)} /><Legend {...LEGEND} />
        <Area dataKey="band" name="90 % interval" stroke="none" fill="var(--tq-chart-1)" fillOpacity={0.16} isAnimationActive={false} />
        <Line dataKey="mean" name="Predicted (model estimate)" stroke="var(--tq-chart-1)" strokeWidth={2} strokeDasharray="5 3" dot={{ r: 3, strokeWidth: 0, fill: 'var(--tq-chart-1)' }} isAnimationActive={false} connectNulls={false} /></ComposedChart></ResponsiveContainer>
  );
}

/** Device history over wall-clock time. Gaps (null) stay gaps. */
export function HistoryChart({ data, name, height, color = 'var(--tq-chart-1)', digits = 2, unit = '' }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: unit ? 22 : 6, right: 10, bottom: 0, left: 0 }}><CartesianGrid {...GRID} />
        <XAxis dataKey="t" type="number" domain={['dataMin', 'dataMax']} tickFormatter={(x) => new Date(x * 1000).toLocaleTimeString()} minTickGap={40} {...AXIS} />
        <YAxis width={54} domain={['auto', 'auto']} tickFormatter={(v) => fixed(v, digits, true)} label={unitLabel(unit)} {...AXIS} axisLine={false} />
        <Tooltip labelFormatter={(x) => new Date(x * 1000).toLocaleTimeString()} formatter={(v) => tipValue(v, digits, unit)} {...TOOLTIP} />
        <Line dataKey="v" name={name} stroke={color} strokeWidth={2} dot={false} activeDot={{ r: 3.5, strokeWidth: 0 }} isAnimationActive={false} connectNulls={false} />
      </LineChart></ResponsiveContainer>
  );
}
