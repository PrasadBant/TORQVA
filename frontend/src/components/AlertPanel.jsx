import React from 'react';
import { AlertOctagon, CheckCircle, Bell, Wrench, ShieldAlert } from 'lucide-react';
import StatusBadge from './StatusBadge';
import { EmptyState } from './EmptyState';

export default function AlertPanel({ alerts, isConnected }) {
  const activeAlerts = Array.isArray(alerts) ? alerts : [];

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
            backgroundColor: activeAlerts.length > 0 ? 'rgba(239, 68, 68, 0.12)' : 'rgba(6, 182, 212, 0.1)',
            border: `1px solid ${activeAlerts.length > 0 ? 'rgba(239, 68, 68, 0.3)' : 'rgba(6, 182, 212, 0.3)'}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: activeAlerts.length > 0 ? '#ef4444' : 'var(--accent-cyan)',
          }}>
            <Bell size={18} />
          </div>
          <div>
            <h3 style={{ fontSize: '12px', fontWeight: '800', color: 'var(--text-secondary)', margin: 0, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
              ACTIVE CONDITION ALERTS & OBSERVATIONS
            </h3>
            <span style={{ fontSize: '10px', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
              Real-Time Anomaly Feed
            </span>
          </div>
        </div>

        <span style={{
          fontSize: '11px',
          fontWeight: '800',
          padding: '4px 12px',
          borderRadius: '9999px',
          backgroundColor: activeAlerts.length > 0 ? 'rgba(239, 68, 68, 0.15)' : 'rgba(16, 185, 129, 0.15)',
          color: activeAlerts.length > 0 ? '#ef4444' : '#10b981',
          border: `1px solid ${activeAlerts.length > 0 ? 'rgba(239, 68, 68, 0.35)' : 'rgba(16, 185, 129, 0.35)'}`,
          fontFamily: 'var(--font-mono)',
          boxShadow: activeAlerts.length > 0 ? '0 0 12px -2px rgba(239, 68, 68, 0.3)' : 'none',
        }}>
          {activeAlerts.length} Active
        </span>
      </div>

      {activeAlerts.length === 0 ? (
        <EmptyState
          icon={CheckCircle}
          title="No Active Anomaly Alerts"
          description={
            isConnected
              ? 'All monitored electrical, thermal, and mechanical parameters are within calibrated nominal ranges.'
              : 'Awaiting hardware telemetry link to evaluate condition thresholds.'
          }
        />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {activeAlerts.map((alert, idx) => {
            const timeStr = alert.timestamp
              ? new Date(alert.timestamp * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
              : 'Live';

            const isCritical = alert.severity === 'CRITICAL';

            return (
              <div
                key={alert.id || idx}
                style={{
                  backgroundColor: isCritical ? 'rgba(239, 68, 68, 0.06)' : 'rgba(245, 158, 11, 0.06)',
                  border: `1px solid ${isCritical ? 'rgba(239, 68, 68, 0.3)' : 'rgba(245, 158, 11, 0.3)'}`,
                  borderLeft: `4px solid ${isCritical ? '#ef4444' : '#f59e0b'}`,
                  borderRadius: '8px',
                  padding: '14px 16px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '8px',
                  boxShadow: '0 2px 8px rgba(0, 0, 0, 0.3)',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <AlertOctagon size={16} color={isCritical ? '#ef4444' : '#f59e0b'} />
                    <span style={{ fontSize: '13px', fontWeight: '800', color: 'var(--text-primary)' }}>
                      {alert.title}
                    </span>
                    <span style={{
                      fontSize: '10px',
                      fontWeight: '700',
                      color: 'var(--text-secondary)',
                      textTransform: 'uppercase',
                      padding: '2px 6px',
                      borderRadius: '4px',
                      backgroundColor: 'rgba(255, 255, 255, 0.06)',
                      fontFamily: 'var(--font-mono)',
                    }}>
                      {alert.parameter}
                    </span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                      {timeStr}
                    </span>
                    <StatusBadge status={alert.severity} size="sm" />
                  </div>
                </div>

                <p style={{ fontSize: '12px', color: 'var(--text-secondary)', margin: 0, lineHeight: '1.5', fontWeight: '500' }}>
                  {alert.message}
                </p>

                {/* Values & Inspection Section */}
                <div style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: '8px',
                  paddingTop: '8px',
                  borderTop: '1px solid rgba(255, 255, 255, 0.06)',
                  fontSize: '11px',
                }}>
                  <div style={{ display: 'flex', gap: '12px', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                    <span>
                      <strong style={{ color: 'var(--text-secondary)' }}>Current:</strong> {alert.current_value}
                    </span>
                    {alert.baseline_value !== null && alert.baseline_value !== undefined && (
                      <span>
                        <strong style={{ color: 'var(--text-secondary)' }}>Baseline:</strong> {alert.baseline_value}
                      </span>
                    )}
                  </div>

                  {alert.suggested_inspection && (
                    <div style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '5px',
                      color: '#f59e0b',
                      backgroundColor: 'rgba(245, 158, 11, 0.08)',
                      padding: '2px 8px',
                      borderRadius: '4px',
                      border: '1px solid rgba(245, 158, 11, 0.2)',
                      fontWeight: '600',
                    }}>
                      <Wrench size={12} />
                      <span>{alert.suggested_inspection}</span>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
