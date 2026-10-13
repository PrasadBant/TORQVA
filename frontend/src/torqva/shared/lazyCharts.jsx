// On-demand wrappers for charts.jsx. Each keeps its final height while the chart code loads, so the layout does not jump.
import React, { Suspense, lazy } from 'react';

const loadCharts = () => import('./charts.jsx');
/** Fetch the chart code ahead of use (e.g. right after sign-in); failures are ignored because the lazy components retry on render. */
export const prefetchCharts = () => { loadCharts().catch(() => {}); };

const wrap = (name) => {
  const Chart = lazy(() => loadCharts().then((m) => ({ default: m[name] })));
  function LazyChart({ height = 240, ...props }) {
    return <Suspense fallback={<div className="tq-chart-pending" style={{ height }} />}><Chart height={height} {...props} /></Suspense>;
  }
  LazyChart.displayName = `Lazy${name}`;
  return LazyChart;
};

export const Sparkline = wrap('Sparkline');
export const TrendLines = wrap('TrendLines');
export const ScoreChart = wrap('ScoreChart');
export const ResponseChart = wrap('ResponseChart');
export const HistoryChart = wrap('HistoryChart');
