import React from 'react';
import { HelpCircle, CheckCircle2, AlertTriangle, XCircle, Info, Activity } from 'lucide-react';
import StatusBadge from './StatusBadge';

export default function HealthAnalysis({ health, deviceStatus }) {
  const isConnected = deviceStatus?.connection_state === 'CONNECTED';
  const score = isConnected ? (health?.score ?? 100) : 0;
  const factors = health?.factors || { temperature: 100, vibration: 100, rpm: 100, current: 100, power: 100 };

  const getFactorState = (val) => {
    if (!isConnected) return { label: 'Offline', color: '#64748b', icon: Info, penalty: 0 };
    if (val >= 90) return { label: 'Nominal', color: '#10b981', icon: CheckCircle2, penalty: 0 };
    if (val >= 70) return { label: 'Elevated / Warning', color: '#f59e0b', icon: AlertTriangle, penalty: Math.round(100 - val) };
    return { label: 'Critical Anomaly', color: '#ef4444', icon: XCircle, penalty: Math.round(100 - val) };
  };

  return (
    <div className="tech-card" style={{
      padding: '22px 24px',
      display: 'flex',
      flexDirection: 'column',
      gap: '16px',
    }}>
      {/* Corner Technical Markings */}
      <div className="tech-corner-tl" />
      <div className="tech-corner-tr" />
      <div className="tech-corner-bl" />
      <div className="tech-corner-br" />

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <div style={{
            width: '32px',
            height: '32px',
            borderRadius: '8px',
            backgroundColor: 'rgba(6, 182, 212, 0.1)',
            border: '1px solid rgba(6, 182, 212, 0.3)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--accent-cyan)',
          }}>
            <HelpCircle size={18} />
          </div>
          <div>
            <h3 style={{ fontSize: '12px', fontWeight: '800', color: 'var(--text-secondary)', margin: 0, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
              WHY IS MOTOR HEALTH {isConnected ? `${score}/100` : 'OFFLINE'}?
            </h3>
            <span style={{ fontSize: '10px', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
              Deterministic Factor Breakdown
            </span>
          </div>
        </div>
        <StatusBadge status={isConnected ? health?.status : 'OFFLINE'} size="sm" />
      </div>

      {/* Factor Breakdown Grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '10px' }}>
        {Object.entries(factors).map(([name, factorVal]) => {
          const state = getFactorState(factorVal);
          const Icon = state.icon;
          return (
            <div
              key={name}
              style={{
                backgroundColor: 'rgba(255, 255, 255, 0.02)',
                border: '1px solid var(--border-subtle)',
                borderRadius: '8px',
                padding: '12px 14px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Icon size={16} color={state.color} />
                <div>
                  <span style={{ fontSize: '12px', fontWeight: '800', color: 'var(--text-primary)', textTransform: 'capitalize' }}>
                    {name}
                  </span>
                  <div style={{ fontSize: '11px', color: state.color, fontWeight: '700' }}>
                    {state.label}
                  </div>
                </div>
              </div>

              {state.penalty > 0 && isConnected && (
                <span style={{
                  fontSize: '11px',
                  fontWeight: '800',
                  color: '#f87171',
                  backgroundColor: 'rgba(239, 68, 68, 0.12)',
                  border: '1px solid rgba(239, 68, 68, 0.3)',
                  padding: '2px 6px',
                  borderRadius: '4px',
                  fontFamily: 'var(--font-mono)',
                }}>
                  -{state.penalty}%
                </span>
              )}
            </div>
          );
        })}
      </div>

      {/* Diagnostic Explanation Banner */}
      <div style={{
        backgroundColor: 'rgba(6, 182, 212, 0.06)',
        border: '1px solid rgba(6, 182, 212, 0.25)',
        borderRadius: '8px',
        padding: '14px 16px',
        display: 'flex',
        alignItems: 'flex-start',
        gap: '12px',
        boxShadow: 'inset 0 1px 0 rgba(255, 255, 255, 0.05)',
      }}>
        <Info size={18} color="var(--accent-cyan)" style={{ flexShrink: 0, marginTop: '2px' }} />
        <div>
          <span style={{ fontSize: '11px', fontWeight: '800', color: 'var(--accent-cyan)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Diagnostic Advisory:
          </span>
          <p style={{ fontSize: '13px', color: 'var(--text-secondary)', margin: '4px 0 0 0', lineHeight: '1.5', fontWeight: '500' }}>
            {isConnected
              ? health?.diagnostic_explanation || 'All operational conditions are within safe nominal thresholds.'
              : 'System offline. Connect ESP32-S3 or run backend simulator to evaluate real-time condition metrics.'}
          </p>
        </div>
      </div>
    </div>
  );
}
