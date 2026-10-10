import React from 'react';
import { Cpu, ShieldCheck, AlertTriangle, AlertOctagon, CheckCircle2, Info, Power, Database, Radio } from 'lucide-react';
import StatusBadge from './StatusBadge';

export default function HardwareConditionCard({ telemetry, deviceStatus }) {
  const isConnected = deviceStatus?.connection_state === 'CONNECTED';
  const isLiveDevice = (deviceStatus?.device_id || telemetry?.device_id || 'ESP32-MOTOR-01') === 'ESP32-MOTOR-01';
  const isLive = isConnected && telemetry?.source === 'live' && isLiveDevice;

  // Requirement 13, 14, 15:
  // Must NOT recalculate hardware condition or fallback WARNING/CRITICAL to NORMAL.
  // Display exact hardware_condition reported by physical ESP32 for ESP32-MOTOR-01 device.
  let rawCondition = 'OFFLINE';
  if (isConnected) {
    if (telemetry && (telemetry.source === 'live' || !telemetry.source)) {
      rawCondition = telemetry.hardware_condition || 'UNKNOWN / DATA UNAVAILABLE';
    } else {
      rawCondition = 'UNKNOWN / DATA UNAVAILABLE';
    }
  }

  const condition = rawCondition.toUpperCase();
  const reason = isConnected
    ? (telemetry?.hardware_reason || (condition === 'MOTOR OFF' ? 'Motor is stopped (no rotation).' : 'Condition reported by physical ESP32 node.'))
    : 'Device is disconnected / offline.';
  const baselineStored = telemetry?.hardware_baseline_stored ?? true;
  const sensorHealth = telemetry?.sensor_health || { adxl345: true, ds18b20: true, ina219: true, a3144: true };

  // Determine state visual theme
  const getStateTheme = (cond) => {
    if (!isConnected || cond === 'OFFLINE') {
      return {
        label: 'OFFLINE',
        color: '#64748b',
        bg: 'rgba(100, 116, 139, 0.1)',
        border: 'rgba(100, 116, 139, 0.3)',
        icon: Info,
        glow: 'none',
      };
    }
    if (cond.includes('UNKNOWN') || cond.includes('UNAVAILABLE')) {
      return {
        label: 'UNKNOWN / DATA UNAVAILABLE',
        color: '#ef4444',
        bg: 'rgba(239, 68, 68, 0.12)',
        border: 'rgba(239, 68, 68, 0.4)',
        icon: Info,
        glow: 'none',
      };
    }
    if (cond === 'CRITICAL') {
      return {
        label: 'CRITICAL CONDITION',
        color: '#ef4444',
        bg: 'rgba(239, 68, 68, 0.15)',
        border: 'rgba(239, 68, 68, 0.5)',
        icon: AlertOctagon,
        glow: '0 0 20px rgba(239, 68, 68, 0.4)',
      };
    }
    if (cond === 'WARNING') {
      return {
        label: 'WARNING CONDITION',
        color: '#f59e0b',
        bg: 'rgba(245, 158, 11, 0.12)',
        border: 'rgba(245, 158, 11, 0.4)',
        icon: AlertTriangle,
        glow: '0 0 16px rgba(245, 158, 11, 0.25)',
      };
    }
    if (cond === 'SENSOR FAULT' || cond === 'SENSOR ERROR') {
      return {
        label: 'SENSOR FAULT',
        color: '#f87171',
        bg: 'rgba(239, 68, 68, 0.12)',
        border: 'rgba(239, 68, 68, 0.4)',
        icon: AlertTriangle,
        glow: '0 0 16px rgba(239, 68, 68, 0.3)',
      };
    }
    if (cond === 'NO BASELINE') {
      return {
        label: 'NO BASELINE',
        color: '#3b82f6',
        bg: 'rgba(59, 130, 246, 0.12)',
        border: 'rgba(59, 130, 246, 0.4)',
        icon: Database,
        glow: '0 0 14px rgba(59, 130, 246, 0.25)',
      };
    }
    if (cond === 'MOTOR OFF' || cond === 'STOPPED') {
      return {
        label: 'MOTOR OFF',
        color: '#06b6d4',
        bg: 'rgba(6, 182, 212, 0.08)',
        border: 'rgba(6, 182, 212, 0.3)',
        icon: Power,
        glow: 'none',
      };
    }
    // NORMAL
    return {
      label: 'NORMAL CONDITION',
      color: '#10b981',
      bg: 'rgba(16, 185, 129, 0.12)',
      border: 'rgba(16, 185, 129, 0.35)',
      icon: CheckCircle2,
      glow: '0 0 16px rgba(16, 185, 129, 0.25)',
    };
  };

  const theme = getStateTheme(condition);
  const StateIcon = theme.icon;

  return (
    <div className="tech-card" style={{
      padding: '22px 24px',
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'space-between',
      position: 'relative',
      overflow: 'hidden',
      borderColor: condition === 'CRITICAL' ? 'rgba(239, 68, 68, 0.6)' : undefined,
      boxShadow: condition === 'CRITICAL' ? '0 0 24px -2px rgba(239, 68, 68, 0.3)' : undefined,
    }}>
      {/* Corner Technical Markings */}
      <div className="tech-corner-tl" />
      <div className="tech-corner-tr" />
      <div className="tech-corner-bl" />
      <div className="tech-corner-br" />

      {/* Card Header */}
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div style={{
              width: '32px',
              height: '32px',
              borderRadius: '8px',
              backgroundColor: theme.bg,
              border: `1px solid ${theme.border}`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: theme.color,
              boxShadow: theme.glow,
            }}>
              <Cpu size={17} />
            </div>
            <div>
              <h3 style={{
                fontSize: '12px',
                fontWeight: '800',
                color: 'var(--text-secondary)',
                margin: 0,
                letterSpacing: '0.06em',
                textTransform: 'uppercase',
              }}>
                HARDWARE CONDITION — ESP32
              </h3>
              <span style={{ fontSize: '10px', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                Physical Firmware Baseline & Sensor Calculation
              </span>
            </div>
          </div>
          <StatusBadge status={condition} size="sm" />
        </div>

        {/* Condition Banner */}
        <div style={{
          backgroundColor: theme.bg,
          border: `1px solid ${theme.border}`,
          borderRadius: '10px',
          padding: '14px 16px',
          margin: '8px 0 12px 0',
          display: 'flex',
          alignItems: 'center',
          gap: '14px',
          boxShadow: theme.glow,
        }}>
          <StateIcon size={28} color={theme.color} />
          <div style={{ flex: 1 }}>
            <div style={{
              fontSize: '18px',
              fontWeight: '900',
              color: theme.color,
              letterSpacing: '0.02em',
              textTransform: 'uppercase',
            }}>
              {theme.label}
            </div>
            <div style={{
              fontSize: '11px',
              color: 'var(--text-secondary)',
              marginTop: '2px',
              lineHeight: '1.4',
            }}>
              {reason}
            </div>
          </div>
        </div>
      </div>

      {/* Hardware Metadata & Sensor Health Strip */}
      <div style={{
        display: 'flex',
        flexWrap: 'wrap',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: '10px',
        paddingTop: '10px',
        borderTop: '1px solid var(--border-subtle)',
        fontSize: '11px',
        fontFamily: 'var(--font-mono)',
      }}>
        {/* Source & Device ID */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ color: 'var(--text-muted)' }}>DEVICE:</span>
          <span style={{ color: 'var(--text-primary)', fontWeight: '700' }}>
            {deviceStatus?.device_id || 'ESP32-MOTOR-01'}
          </span>
          <span style={{
            padding: '2px 6px',
            borderRadius: '4px',
            fontSize: '10px',
            fontWeight: '800',
            backgroundColor: isLive ? 'rgba(16, 185, 129, 0.15)' : 'rgba(100, 116, 139, 0.15)',
            color: isLive ? '#10b981' : '#94a3b8',
            border: `1px solid ${isLive ? 'rgba(16, 185, 129, 0.35)' : 'rgba(100, 116, 139, 0.3)'}`,
            display: 'inline-flex',
            alignItems: 'center',
            gap: '4px',
          }}>
            <Radio size={10} />
            {isLive ? 'LIVE HARDWARE' : 'OFFLINE'}
          </span>
        </div>

        {/* Attached Sensor Health Chips */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <span style={{ color: 'var(--text-muted)', fontSize: '10px' }}>BUS:</span>
          {['adxl345', 'ds18b20', 'ina219', 'a3144'].map((sensorKey) => {
            const isOk = isConnected && sensorHealth[sensorKey] !== false;
            return (
              <span
                key={sensorKey}
                style={{
                  padding: '2px 6px',
                  borderRadius: '3px',
                  fontSize: '9px',
                  fontWeight: '700',
                  textTransform: 'uppercase',
                  backgroundColor: isOk ? 'rgba(16, 185, 129, 0.1)' : 'rgba(239, 68, 68, 0.15)',
                  color: isOk ? '#34d399' : '#f87171',
                  border: `1px solid ${isOk ? 'rgba(16, 185, 129, 0.25)' : 'rgba(239, 68, 68, 0.4)'}`,
                }}
              >
                {sensorKey}
              </span>
            );
          })}
        </div>
      </div>
    </div>
  );
}
