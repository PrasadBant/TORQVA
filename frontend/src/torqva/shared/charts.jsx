// Every Recharts chart in the app. This is the only module that imports recharts (about half of the JavaScript), so it is loaded on demand
// through lazyCharts.jsx instead of delaying the sign-in page and the physical dashboard, which draw no chart.
import React, { useId } from 'react';
import { LineChart, Line, ComposedChart, AreaChart, Area, XAxis, YAxis, Tooltip, Legend, ReferenceLine, ResponsiveContainer, CartesianGrid } from 'recharts';
import { AXIS, GRID, TOOLTIP, LEGEND } from './components.jsx';

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

/** Simulator telemetry over simulation time. */
export function TrendLines({ data, lines, height, yDomain, digits = 2, unit = '' }) {
  const tip = (v) => (typeof v === 'number' ? `${v.toFixed(digits)}${unit ? ` ${unit}` : ''}` : v);
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 6, right: 10, bottom: 0, left: 0 }}><CartesianGrid {...GRID} /><XAxis dataKey="t" minTickGap={28} tickFormatter={(x) => `${Math.round(x)}s`} {...AXIS} /><YAxis domain={yDomain || ['auto', 'auto']} width={54} tickFormatter={(v) => (Math.abs(v) >= 100 ? Number(v).toFixed(0) : Number(v).toFixed(2))} {...AXIS} axisLine={false} />
        <Tooltip {...TOOLTIP} formatter={tip} labelFormatter={(x) => `t = ${Math.round(x)} s`} /><Legend {...LEGEND} />{lines.map((l) => <Line key={l.key} dataKey={l.key} name={l.name} stroke={l.color} strokeDasharray={l.dash} strokeWidth={l.dash ? 1.5 : 2} dot={false} activeDot={{ r: 3.5, strokeWidth: 0 }} isAnimationActive={false} />)}
      </LineChart>
    </ResponsiveContainer>
  );
}

/** C1 anomaly score divided by the learned threshold, log scale. */
export function ScoreChart({ data, height }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 6, right: 10, bottom: 0, left: 0 }}><CartesianGrid {...GRID} /><XAxis dataKey="t" minTickGap={28} tickFormatter={(x) => `${Math.round(x)}s`} {...AXIS} />
        <YAxis scale="log" domain={[0.05, 'auto']} allowDataOverflow width={46} tickFormatter={(x) => (x >= 1 ? x.toFixed(0) : x.toFixed(2))} {...AXIS} axisLine={false} /><Tooltip {...TOOLTIP} /><Legend {...LEGEND} />
        <ReferenceLine y={1} stroke="var(--tq-crit)" strokeDasharray="4 3" label={{ value: 'threshold = 1', position: 'insideTopRight', fill: 'var(--tq-crit)', fontSize: 11 }} />
        <Line dataKey="score" stroke="var(--tq-chart-1)" strokeWidth={2} dot={false} activeDot={{ r: 3.5, strokeWidth: 0 }} isAnimationActive={false} name="score ratio" /></LineChart></ResponsiveContainer>
  );
}

/** C2 predicted response with its 90 % interval (point 0 is the current simulated value). */
export function ResponseChart({ data, height }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={data} margin={{ top: 6, right: 10, bottom: 0, left: 0 }}><CartesianGrid {...GRID} /><XAxis dataKey="h" type="number" domain={[0, 120]} ticks={[0, 30, 60, 120]} tickFormatter={(x) => `${x}s`} {...AXIS} /><YAxis width={50} domain={['auto', 'auto']} {...AXIS} axisLine={false} /><Tooltip {...TOOLTIP} /><Legend {...LEGEND} />
        <Area dataKey="band" name="90% interval" stroke="none" fill="var(--tq-chart-1)" fillOpacity={0.16} isAnimationActive={false} />
        <Line dataKey="mean" name="predicted (point 0 = current simulated value)" stroke="var(--tq-chart-1)" strokeWidth={2} strokeDasharray="5 3" dot={{ r: 3, strokeWidth: 0, fill: 'var(--tq-chart-1)' }} isAnimationActive={false} /></ComposedChart></ResponsiveContainer>
  );
}

/** Device history over wall-clock time. Gaps (null) stay gaps. */
export function HistoryChart({ data, name, height }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 6, right: 10, bottom: 0, left: 0 }}><CartesianGrid {...GRID} />
        <XAxis dataKey="t" type="number" domain={['dataMin', 'dataMax']} tickFormatter={(x) => new Date(x * 1000).toLocaleTimeString()} minTickGap={40} {...AXIS} />
        <YAxis width={54} domain={['auto', 'auto']} {...AXIS} axisLine={false} /><Tooltip labelFormatter={(x) => new Date(x * 1000).toLocaleTimeString()} {...TOOLTIP} />
        <Line dataKey="v" name={name} stroke="var(--tq-chart-1)" strokeWidth={2} dot={false} activeDot={{ r: 3.5, strokeWidth: 0 }} isAnimationActive={false} connectNulls={false} />
      </LineChart></ResponsiveContainer>
  );
}
