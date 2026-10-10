import React from 'react';
import { TrendingUp, TrendingDown, Minus, AlertCircle, Activity } from 'lucide-react';
import StatusBadge from './StatusBadge';

export default function SensorCard({
  title,
  icon: Icon,
  value,
  unit,
  baselineValue,
  status = 'NORMAL',
  isSensorHealthy = true,
  isConnected = true,
  subMetrics = null,
  precision = 1,
}) {
  const isUnavailable = !isSensorHealthy || !isConnected;

  // Calculate Delta against Baseline if both exist
  let deltaStr = null;
  let isElevated = false;
  if (!isUnavailable && typeof value === 'number' && typeof baselineValue === 'number') {
    const diff = value - baselineValue;
    const sign = diff > 0 ? '+' : '';
    deltaStr = `${sign}${diff.toFixed(precision)} ${unit}`;
    isElevated = diff > 0;
  }

  const borderStateColor = !isSensorHealthy
    ? 'rgba(239, 68, 68, 0.5)'
    : status === 'CRITICAL'
    ? 'rgba(239, 68, 68, 0.4)'
    : status === 'WARNING'
    ? 'rgba(245, 158, 11, 0.4)'
    : 'var(--border-tech)';

  return (
    <div className="tech-card" style={{
      borderColor: borderStateColor,
      padding: '20px 22px',
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'space-between',
      position: 'relative',
      minHeight: '168px',
      overflow: 'hidden',
    }}>
      {/* Corner Technical Markings */}
      <div className="tech-corner-tl" />
      <div className="tech-corner-tr" />
      <div className="tech-corner-bl" />
      <div className="tech-corner-br" />

      {/* Card Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          {Icon && (
            <div style={{
              width: '32px',
              height: '32px',
              borderRadius: '8px',
              backgroundColor: 'rgba(255, 255, 255, 0.04)',
              border: '1px solid var(--border-subtle)',
              color: isUnavailable ? 'var(--text-muted)' : 'var(--accent-cyan)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: !isUnavailable ? '0 0 10px rgba(6, 182, 212, 0.15)' : 'none',
            }}>
              <Icon size={17} />
            </div>
          )}
          <div>
            <h4 style={{
              fontSize: '12px',
              fontWeight: '800',
              color: 'var(--text-secondary)',
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
              margin: 0,
            }}>
              {title}
            </h4>
          </div>
        </div>
        <StatusBadge
          status={!isSensorHealthy ? 'UNAVAILABLE' : !isConnected ? 'OFFLINE' : status}
          label={!isSensorHealthy ? 'UNAVAILABLE' : !isConnected ? 'DATA NOT LIVE' : status}
          size="sm"
        />
      </div>

      {/* Main Measurement Section */}
      <div style={{ margin: '14px 0 8px 0' }}>
        {isUnavailable ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#f87171' }}>
            <AlertCircle size={20} />
            <span style={{ fontSize: '14px', fontWeight: '800', letterSpacing: '0.02em' }}>
              {!isSensorHealthy ? 'SENSOR UNAVAILABLE' : 'OFFLINE (DATA NOT LIVE)'}
            </span>
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px' }}>
            <span style={{
              fontSize: '32px',
              fontWeight: '900',
              fontFamily: 'var(--font-mono)',
              color: 'var(--text-primary)',
              letterSpacing: '-0.03em',
              lineHeight: '1',
              textShadow: '0 2px 10px rgba(0, 0, 0, 0.6)',
            }}>
              {typeof value === 'number' ? value.toFixed(precision) : '—'}
            </span>
            <span style={{ fontSize: '15px', fontWeight: '700', color: 'var(--accent-cyan)', fontFamily: 'var(--font-mono)' }}>
              {unit}
            </span>
          </div>
        )}
      </div>

      {/* Sub-metrics (e.g. 3-Axis dynamic acceleration X / Y / Z) */}
      {subMetrics && !isUnavailable && (
        <div style={{
          display: 'flex',
          gap: '8px',
          fontSize: '11px',
          color: 'var(--text-muted)',
          fontFamily: 'var(--font-mono)',
          margin: '2px 0 10px 0',
          flexWrap: 'wrap',
        }}>
          {Object.entries(subMetrics).map(([k, v]) => (
            <span key={k} style={{
              backgroundColor: 'rgba(255, 255, 255, 0.03)',
              border: '1px solid var(--border-subtle)',
              padding: '2px 6px',
              borderRadius: '4px',
            }}>
              <strong style={{ color: 'var(--text-secondary)' }}>{k.toUpperCase()}:</strong>{' '}
              {typeof v === 'number' ? v.toFixed(2) : '—'}g
            </span>
          ))}
        </div>
      )}

      {/* Baseline Comparison Footer */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingTop: '10px',
        borderTop: '1px solid var(--border-subtle)',
        fontSize: '11px',
      }}>
        <div style={{ color: 'var(--text-muted)' }}>
          Baseline:{' '}
          <span style={{ color: 'var(--text-secondary)', fontWeight: '700', fontFamily: 'var(--font-mono)' }}>
            {typeof baselineValue === 'number' ? `${baselineValue.toFixed(precision)} ${unit}` : 'Not set'}
          </span>
        </div>

        {deltaStr && (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '4px',
            color: isElevated ? '#f59e0b' : '#10b981',
            fontWeight: '700',
            fontFamily: 'var(--font-mono)',
            padding: '2px 6px',
            borderRadius: '4px',
            backgroundColor: isElevated ? 'rgba(245, 158, 11, 0.1)' : 'rgba(16, 185, 129, 0.1)',
            border: `1px solid ${isElevated ? 'rgba(245, 158, 11, 0.25)' : 'rgba(16, 185, 129, 0.25)'}`,
          }}>
            {isElevated ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
            <span>{deltaStr}</span>
          </div>
        )}
      </div>
    </div>
  );
}
