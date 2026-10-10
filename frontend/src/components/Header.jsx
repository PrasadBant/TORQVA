import React from 'react';
import { Cpu, Activity, Radio, Wifi, WifiOff, Terminal } from 'lucide-react';
import StatusBadge from './StatusBadge';

export default function Header({ deviceStatus, wsConnected, telemetry }) {
  const isDeviceConnected = deviceStatus?.connection_state === 'CONNECTED';
  const isLiveSource = isDeviceConnected && telemetry?.source === 'live';
  const isDemoSource = isDeviceConnected && telemetry?.source === 'demo';

  return (
    <header style={{
      display: 'flex',
      flexWrap: 'wrap',
      justifyContent: 'space-between',
      alignItems: 'center',
      gap: '16px',
      padding: '16px 28px',
      backgroundColor: 'var(--bg-surface-overlay)',
      borderBottom: '1px solid var(--border-tech)',
      boxShadow: '0 4px 20px -2px rgba(0, 0, 0, 0.5), inset 0 -1px 0 rgba(255, 255, 255, 0.05)',
      position: 'sticky',
      top: 0,
      zIndex: 100,
      backdropFilter: 'blur(16px)',
    }}>
      {/* Title & Brand */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
        <div style={{
          width: '46px',
          height: '46px',
          borderRadius: '10px',
          background: 'linear-gradient(135deg, rgba(6, 182, 212, 0.2) 0%, rgba(6, 182, 212, 0.04) 100%)',
          border: '1px solid rgba(6, 182, 212, 0.4)',
          boxShadow: '0 0 16px -2px rgba(6, 182, 212, 0.25), inset 0 1px 0 rgba(255, 255, 255, 0.2)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--accent-cyan)',
          position: 'relative',
        }}>
          <Activity size={26} className={isLiveSource ? 'glow-breathe' : ''} />
          <div style={{
            position: 'absolute',
            bottom: '-2px',
            right: '-2px',
            width: '8px',
            height: '8px',
            borderRadius: '50%',
            backgroundColor: isLiveSource ? '#10b981' : isDeviceConnected ? '#06b6d4' : '#ef4444',
            boxShadow: `0 0 6px ${isLiveSource ? '#10b981' : isDeviceConnected ? '#06b6d4' : '#ef4444'}`,
          }} />
        </div>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <h1 style={{
              fontSize: '20px',
              fontWeight: '800',
              letterSpacing: '-0.02em',
              color: 'var(--text-primary)',
              margin: 0,
              textShadow: '0 2px 8px rgba(0, 0, 0, 0.5)',
            }}>
              SMART DC MOTOR MONITORING
            </h1>
            <span style={{
              fontSize: '10px',
              fontWeight: '800',
              padding: '2px 8px',
              borderRadius: '4px',
              background: 'linear-gradient(180deg, rgba(255,255,255,0.1) 0%, rgba(255,255,255,0.03) 100%)',
              border: '1px solid rgba(255, 255, 255, 0.12)',
              color: 'var(--text-secondary)',
              fontFamily: 'var(--font-mono)',
              letterSpacing: '0.05em',
            }}>
              v2.0 PRO
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '2px' }}>
            <Terminal size={12} color="var(--accent-cyan)" />
            <p style={{
              fontSize: '12px',
              color: 'var(--text-secondary)',
              margin: 0,
              fontWeight: '500',
              letterSpacing: '0.01em',
            }}>
              Industrial IoT Condition Monitoring & Predictive Maintenance
            </p>
          </div>
        </div>
      </div>

      {/* Header Status Badges */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
        {/* Source Badge (LIVE HARDWARE / DEMO / DATA NOT LIVE) */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          padding: '6px 14px',
          borderRadius: '8px',
          backgroundColor: isLiveSource
            ? 'rgba(16, 185, 129, 0.12)'
            : isDemoSource
            ? 'rgba(245, 158, 11, 0.12)'
            : 'rgba(100, 116, 139, 0.12)',
          border: `1px solid ${
            isLiveSource
              ? 'rgba(16, 185, 129, 0.4)'
              : isDemoSource
              ? 'rgba(245, 158, 11, 0.4)'
              : 'rgba(100, 116, 139, 0.3)'
          }`,
          boxShadow: isLiveSource
            ? '0 0 12px -2px rgba(16, 185, 129, 0.25), inset 0 1px 0 rgba(255, 255, 255, 0.1)'
            : 'inset 0 1px 0 rgba(255, 255, 255, 0.05)',
          fontSize: '11px',
          fontWeight: '800',
          letterSpacing: '0.06em',
          color: isLiveSource ? '#10b981' : isDemoSource ? '#f59e0b' : '#94a3b8',
          fontFamily: 'var(--font-mono)',
        }}>
          <Radio size={13} className={isLiveSource ? 'pulse-animation' : ''} />
          <span>{isLiveSource ? 'LIVE HARDWARE' : isDemoSource ? 'DEMO' : 'DATA NOT LIVE'}</span>
        </div>

        {/* ESP32-S3 Connection Status */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          padding: '5px 14px',
          borderRadius: '8px',
          backgroundColor: isDeviceConnected ? 'rgba(16, 185, 129, 0.08)' : 'rgba(239, 68, 68, 0.08)',
          border: `1px solid ${isDeviceConnected ? 'rgba(16, 185, 129, 0.3)' : 'rgba(239, 68, 68, 0.3)'}`,
          boxShadow: 'inset 0 1px 0 rgba(255, 255, 255, 0.05)',
        }}>
          <Cpu size={14} color={isDeviceConnected ? '#10b981' : '#ef4444'} />
          <span style={{ fontSize: '11px', fontWeight: '700', color: 'var(--text-muted)', letterSpacing: '0.04em' }}>
            ESP32-S3:
          </span>
          <StatusBadge
            status={deviceStatus?.connection_state || 'OFFLINE'}
            size="sm"
          />
        </div>

        {/* WebSocket Pipeline Indicator */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          padding: '5px 12px',
          borderRadius: '8px',
          backgroundColor: 'rgba(255, 255, 255, 0.03)',
          border: '1px solid var(--border-subtle)',
          fontSize: '11px',
          fontWeight: '700',
          fontFamily: 'var(--font-mono)',
          color: wsConnected ? 'var(--text-secondary)' : '#f87171',
        }}>
          {wsConnected ? <Wifi size={13} color="#10b981" /> : <WifiOff size={13} color="#ef4444" />}
          <span>{wsConnected ? 'WS STREAM' : 'WS RECONNECTING'}</span>
        </div>
      </div>
    </header>
  );
}
