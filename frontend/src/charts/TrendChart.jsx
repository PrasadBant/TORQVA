import React from 'react';
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ReferenceLine,
} from 'recharts';

function CustomTooltip({ active, payload, label, unit, precision = 2 }) {
  if (active && payload && payload.length) {
    const dataPoint = payload[0];
    return (
      <div style={{
        backgroundColor: 'rgba(10, 14, 23, 0.95)',
        border: '1px solid rgba(255, 255, 255, 0.2)',
        borderRadius: '8px',
        padding: '10px 14px',
        boxShadow: '0 8px 24px rgba(0, 0, 0, 0.7), 0 0 12px rgba(6, 182, 212, 0.2)',
        fontSize: '12px',
        backdropFilter: 'blur(8px)',
      }}>
        <div style={{ color: 'var(--text-muted)', marginBottom: '6px', fontSize: '11px', fontFamily: 'var(--font-mono)' }}>
          {label}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{
            width: '8px',
            height: '8px',
            borderRadius: '50%',
            backgroundColor: dataPoint.color,
            boxShadow: `0 0 8px ${dataPoint.color}`,
          }} />
          <span style={{ color: 'var(--text-secondary)', fontWeight: '600' }}>Value:</span>
          <strong style={{ color: 'var(--text-primary)', fontFamily: 'var(--font-mono)', fontSize: '13px' }}>
            {typeof dataPoint.value === 'number' ? dataPoint.value.toFixed(precision) : dataPoint.value} {unit}
          </strong>
        </div>
      </div>
    );
  }
  return null;
}

export default function TrendChart({
  title,
  data,
  dataKey,
  unit,
  color = '#06b6d4',
  baselineValue = null,
  precision = 2,
  minDomain = 'auto',
  maxDomain = 'auto',
}) {
  const chartData = (data || []).map((item) => {
    let timeLabel = '';
    if (item.timestamp) {
      const d = new Date(item.timestamp * 1000);
      timeLabel = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }
    return {
      ...item,
      timeLabel,
      val: item[dataKey],
    };
  });

  return (
    <div className="tech-card" style={{
      padding: '18px 20px',
      display: 'flex',
      flexDirection: 'column',
    }}>
      {/* Corner Technical Markings */}
      <div className="tech-corner-tl" />
      <div className="tech-corner-tr" />
      <div className="tech-corner-bl" />
      <div className="tech-corner-br" />

      {/* Header */}
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: '12px',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ width: '6px', height: '6px', borderRadius: '50%', backgroundColor: color, boxShadow: `0 0 6px ${color}` }} />
          <h4 style={{
            fontSize: '12px',
            fontWeight: '800',
            color: 'var(--text-secondary)',
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
            margin: 0,
          }}>
            {title}
          </h4>
        </div>
        <span style={{
          fontSize: '10px',
          fontWeight: '700',
          color: 'var(--text-muted)',
          fontFamily: 'var(--font-mono)',
          padding: '2px 6px',
          borderRadius: '4px',
          backgroundColor: 'rgba(255, 255, 255, 0.04)',
          border: '1px solid var(--border-subtle)',
        }}>
          {unit}
        </span>
      </div>

      <div style={{ width: '100%', height: '165px' }}>
        {chartData.length === 0 ? (
          <div style={{
            height: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--text-muted)',
            fontSize: '12px',
            fontFamily: 'var(--font-mono)',
          }}>
            Awaiting telemetry points...
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chartData} margin={{ top: 5, right: 10, left: -20, bottom: 0 }}>
              <defs>
                <linearGradient id={`grad-${dataKey}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={color} stopOpacity={0.35} />
                  <stop offset="95%" stopColor={color} stopOpacity={0.0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255, 255, 255, 0.04)" vertical={false} />
              <XAxis
                dataKey="timeLabel"
                stroke="rgba(255, 255, 255, 0.15)"
                tick={{ fill: '#64748b', fontSize: 10, fontFamily: 'var(--font-mono)' }}
                tickLine={false}
                minTickGap={25}
              />
              <YAxis
                stroke="rgba(255, 255, 255, 0.15)"
                tick={{ fill: '#64748b', fontSize: 10, fontFamily: 'var(--font-mono)' }}
                tickLine={false}
                domain={[minDomain, maxDomain]}
              />
              <Tooltip content={<CustomTooltip unit={unit} precision={precision} />} />
              {typeof baselineValue === 'number' && (
                <ReferenceLine
                  y={baselineValue}
                  stroke="#f59e0b"
                  strokeDasharray="4 4"
                  strokeWidth={1.5}
                  label={{
                    value: `Ref: ${baselineValue.toFixed(precision)}`,
                    fill: '#f59e0b',
                    fontSize: 10,
                    fontFamily: 'var(--font-mono)',
                    position: 'insideTopRight',
                  }}
                />
              )}
              <Area
                type="monotone"
                dataKey="val"
                stroke={color}
                strokeWidth={2.2}
                fillOpacity={1}
                fill={`url(#grad-${dataKey})`}
                isAnimationActive={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}
