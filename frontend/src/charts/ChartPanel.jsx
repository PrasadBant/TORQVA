import React from 'react';
import { LineChart, History, AlertCircle, RefreshCw } from 'lucide-react';
import TrendChart from './TrendChart';

const RANGES = [
  { label: 'LIVE STREAM', minutes: null },
  { label: '1 MIN', minutes: 1.0 },
  { label: '5 MIN', minutes: 5.0 },
  { label: '30 MIN', minutes: 30.0 },
  { label: '1 HR', minutes: 60.0 },
];

export default function ChartPanel({
  chartData,
  activeRange,
  onSelectRange,
  baseline,
  isLoadingHistory,
  historyError,
}) {
  return (
    <section style={{ marginTop: '28px' }}>
      {/* Section Header & Range Selectors */}
      <div style={{
        display: 'flex',
        flexWrap: 'wrap',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: '14px',
        marginBottom: '18px',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <div style={{
            width: '34px',
            height: '34px',
            borderRadius: '8px',
            backgroundColor: 'rgba(6, 182, 212, 0.1)',
            border: '1px solid rgba(6, 182, 212, 0.3)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--accent-cyan)',
          }}>
            <LineChart size={19} />
          </div>
          <div>
            <h3 style={{
              fontSize: '15px',
              fontWeight: '800',
              color: 'var(--text-primary)',
              letterSpacing: '0.04em',
              textTransform: 'uppercase',
              margin: 0,
            }}>
              LIVE SENSOR TRENDS & TIME-SERIES HISTORY
            </h3>
            <span style={{ fontSize: '10px', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
              7 Synchronized Diagnostic Telemetry Streams
            </span>
          </div>
        </div>

        {/* History Range Controls */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: '4px',
          backgroundColor: 'var(--bg-surface)',
          padding: '4px 6px',
          borderRadius: '10px',
          border: '1px solid var(--border-tech)',
          boxShadow: 'var(--shadow-card-3d)',
        }}>
          <History size={14} color="var(--text-muted)" style={{ margin: '0 6px' }} />
          {RANGES.map((r) => {
            const isActive = activeRange === r.minutes;
            return (
              <button
                key={r.label}
                onClick={() => onSelectRange(r.minutes)}
                disabled={isLoadingHistory}
                style={{
                  padding: '5px 12px',
                  borderRadius: '6px',
                  border: 'none',
                  backgroundColor: isActive ? 'var(--accent-cyan)' : 'transparent',
                  color: isActive ? '#000' : 'var(--text-secondary)',
                  fontSize: '11px',
                  fontWeight: '800',
                  letterSpacing: '0.04em',
                  cursor: isLoadingHistory ? 'wait' : 'pointer',
                  transition: 'all 0.2s ease',
                  fontFamily: 'var(--font-mono)',
                  boxShadow: isActive ? '0 0 12px -2px rgba(6, 182, 212, 0.4)' : 'none',
                }}
              >
                {r.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Localized History Error Banner if query failed */}
      {historyError && (
        <div style={{
          padding: '10px 14px',
          marginBottom: '16px',
          backgroundColor: 'rgba(239, 68, 68, 0.08)',
          border: '1px solid rgba(239, 68, 68, 0.25)',
          borderRadius: '8px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          fontSize: '12px',
          color: '#fca5a5',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <AlertCircle size={15} />
            <span>Unable to retrieve historical telemetry records for this range.</span>
          </div>
          <button
            onClick={() => onSelectRange(activeRange)}
            style={{
              padding: '4px 10px',
              backgroundColor: 'rgba(239, 68, 68, 0.2)',
              color: '#fff',
              border: 'none',
              borderRadius: '4px',
              fontSize: '11px',
              fontWeight: '700',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
            }}
          >
            <RefreshCw size={11} /> Retry
          </button>
        </div>
      )}

      {/* Grid of 7 Separate Charts */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))',
        gap: '16px',
      }}>
        {/* 1. Temperature Chart */}
        <TrendChart
          title="Motor Temperature"
          data={chartData}
          dataKey="temperature"
          unit="°C"
          color="#f97316" // Orange
          baselineValue={baseline?.temperature}
          precision={1}
          minDomain={20}
        />

        {/* 2. Vibration RMS Chart */}
        <TrendChart
          title="Vibration RMS Acceleration"
          data={chartData}
          dataKey="vibration_rms"
          unit="g"
          color="#ec4899" // Pink / Magenta
          baselineValue={baseline?.vibration_rms}
          precision={3}
          minDomain={0}
        />

        {/* 3. RPM Speed Chart */}
        <TrendChart
          title="Rotational Speed"
          data={chartData}
          dataKey="rpm"
          unit="RPM"
          color="#06b6d4" // Cyan
          baselineValue={baseline?.rpm}
          precision={0}
          minDomain={0}
        />

        {/* 4. DC Current Chart */}
        <TrendChart
          title="Motor Current Draw"
          data={chartData}
          dataKey="current"
          unit="A"
          color="#eab308" // Yellow
          baselineValue={baseline?.current}
          precision={2}
          minDomain={0}
        />

        {/* 5. Bus Voltage Chart */}
        <TrendChart
          title="DC Bus Voltage"
          data={chartData}
          dataKey="voltage"
          unit="V"
          color="#3b82f6" // Blue
          baselineValue={baseline?.voltage}
          precision={2}
          minDomain={0}
        />

        {/* 6. Active Power Chart */}
        <TrendChart
          title="Active Power"
          data={chartData}
          dataKey="power"
          unit="W"
          color="#8b5cf6" // Purple
          baselineValue={baseline?.power}
          precision={1}
          minDomain={0}
        />

        {/* 7. Health Score Chart */}
        <TrendChart
          title="Motor Health Score"
          data={chartData}
          dataKey="health_score"
          unit="/100"
          color="#10b981" // Emerald Green
          precision={0}
          minDomain={0}
          maxDomain={100}
        />
      </div>
    </section>
  );
}
