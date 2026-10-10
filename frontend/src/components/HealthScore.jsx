import React from 'react';
import { HeartPulse, ShieldCheck, Activity } from 'lucide-react';
import StatusBadge from './StatusBadge';

export default function HealthScore({ health, deviceStatus }) {
  const isConnected = deviceStatus?.connection_state === 'CONNECTED';
  const score = isConnected ? (health?.score ?? 100) : 0;
  const status = isConnected ? (health?.status || 'HEALTHY') : 'OFFLINE';

  // Determine gauge color based on score & status
  let gaugeColor = '#10b981'; // Green
  let glowColor = 'rgba(16, 185, 129, 0.4)';
  if (status === 'OFFLINE' || !isConnected) {
    gaugeColor = '#64748b';
    glowColor = 'transparent';
  } else if (status === 'CRITICAL' || score < 60) {
    gaugeColor = '#ef4444';
    glowColor = 'rgba(239, 68, 68, 0.4)';
  } else if (status === 'WARNING' || score < 85) {
    gaugeColor = '#f59e0b';
    glowColor = 'rgba(245, 158, 11, 0.4)';
  } else if (status === 'BASELINE_REQUIRED') {
    gaugeColor = '#3b82f6';
    glowColor = 'rgba(59, 130, 246, 0.4)';
  }

  // SVG Gauge calculations
  const size = 118;
  const strokeWidth = 11;
  const center = size / 2;
  const radius = center - strokeWidth;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference - (score / 100) * circumference;

  return (
    <div className="tech-card" style={{
      padding: '22px 24px',
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'space-between',
    }}>
      {/* Corner Technical Markings */}
      <div className="tech-corner-tl" />
      <div className="tech-corner-tr" />
      <div className="tech-corner-bl" />
      <div className="tech-corner-br" />

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <div style={{
            width: '32px',
            height: '32px',
            borderRadius: '8px',
            backgroundColor: 'rgba(255, 255, 255, 0.05)',
            border: `1px solid ${gaugeColor}40`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: gaugeColor,
          }}>
            <HeartPulse size={18} />
          </div>
          <h3 style={{ fontSize: '12px', fontWeight: '800', color: 'var(--text-secondary)', margin: 0, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
            MOTOR HEALTH SCORE
          </h3>
        </div>
        <StatusBadge status={status} size="sm" />
      </div>

      {/* Radial Gauge & Condition Breakdown */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-around', margin: '8px 0' }}>
        {/* 3D Radial Gauge */}
        <div style={{ position: 'relative', width: size, height: size, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
            <defs>
              <filter id="gaugeShadow" x="-20%" y="-20%" width="140%" height="140%">
                <feDropShadow dx="0" dy="0" stdDeviation="3" floodColor={glowColor} />
              </filter>
              <linearGradient id="gaugeTrackGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="rgba(255, 255, 255, 0.08)" />
                <stop offset="100%" stopColor="rgba(0, 0, 0, 0.4)" />
              </linearGradient>
            </defs>
            {/* Outer Decorative Track Ring */}
            <circle
              cx={center}
              cy={center}
              r={radius + 3}
              stroke="rgba(255, 255, 255, 0.04)"
              strokeWidth="1"
              fill="transparent"
              strokeDasharray="2 4"
            />
            {/* Base Gauge Track */}
            <circle
              cx={center}
              cy={center}
              r={radius}
              stroke="url(#gaugeTrackGrad)"
              strokeWidth={strokeWidth}
              fill="transparent"
            />
            {/* Active Progress Arc with 3D Glow Filter */}
            <circle
              cx={center}
              cy={center}
              r={radius}
              stroke={gaugeColor}
              strokeWidth={strokeWidth}
              fill="transparent"
              strokeDasharray={circumference}
              strokeDashoffset={isConnected ? strokeDashoffset : circumference}
              strokeLinecap="round"
              filter="url(#gaugeShadow)"
              style={{ transition: 'stroke-dashoffset 0.8s cubic-bezier(0.16, 1, 0.3, 1), stroke 0.4s ease' }}
            />
          </svg>

          {/* Center Score Display */}
          <div style={{
            position: 'absolute',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
          }}>
            <span style={{
              fontSize: '26px',
              fontWeight: '900',
              fontFamily: 'var(--font-mono)',
              color: isConnected ? 'var(--text-primary)' : 'var(--text-muted)',
              lineHeight: '1',
              letterSpacing: '-0.02em',
              textShadow: isConnected ? `0 0 14px ${glowColor}` : 'none',
            }}>
              {isConnected ? score : '—'}
            </span>
            <span style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '2px', fontWeight: '700', fontFamily: 'var(--font-mono)' }}>
              / 100
            </span>
          </div>
        </div>

        {/* Multi-Factor Health Breakdown */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', minWidth: '135px' }}>
          {Object.entries(health?.factors || {}).map(([factor, factorScore]) => (
            <div key={factor} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '11px' }}>
              <span style={{ color: 'var(--text-secondary)', textTransform: 'capitalize', fontWeight: '500' }}>
                {factor}:
              </span>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <div style={{
                  width: '38px',
                  height: '4px',
                  backgroundColor: 'rgba(255, 255, 255, 0.08)',
                  borderRadius: '2px',
                  overflow: 'hidden',
                }}>
                  <div style={{
                    width: isConnected ? `${factorScore}%` : '0%',
                    height: '100%',
                    backgroundColor: factorScore >= 90 ? '#10b981' : factorScore >= 70 ? '#f59e0b' : '#ef4444',
                    transition: 'width 0.5s ease',
                  }} />
                </div>
                <span style={{
                  fontWeight: '700',
                  fontFamily: 'var(--font-mono)',
                  fontSize: '11px',
                  color: !isConnected
                    ? 'var(--text-muted)'
                    : factorScore >= 90
                    ? '#10b981'
                    : factorScore >= 70
                    ? '#f59e0b'
                    : '#ef4444',
                  minWidth: '28px',
                  textAlign: 'right',
                }}>
                  {isConnected ? `${Math.round(factorScore)}%` : '—'}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Footer Notice */}
      <div style={{
        fontSize: '11px',
        color: 'var(--text-muted)',
        textAlign: 'center',
        paddingTop: '10px',
        borderTop: '1px solid var(--border-subtle)',
        letterSpacing: '0.02em',
        fontFamily: 'var(--font-sans)',
      }}>
        Rule-Based Condition Analysis (Deterministic Baseline Comparison)
      </div>
    </div>
  );
}
