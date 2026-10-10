import React from 'react';

const BADGE_STYLES = {
  HEALTHY: { bg: 'rgba(16, 185, 129, 0.12)', text: '#10b981', border: 'rgba(16, 185, 129, 0.3)' },
  NORMAL: { bg: 'rgba(16, 185, 129, 0.12)', text: '#10b981', border: 'rgba(16, 185, 129, 0.3)' },
  CONNECTED: { bg: 'rgba(16, 185, 129, 0.12)', text: '#10b981', border: 'rgba(16, 185, 129, 0.3)' },
  RUNNING: { bg: 'rgba(16, 185, 129, 0.12)', text: '#10b981', border: 'rgba(16, 185, 129, 0.3)' },
  SAVED: { bg: 'rgba(16, 185, 129, 0.12)', text: '#10b981', border: 'rgba(16, 185, 129, 0.3)' },

  WARNING: { bg: 'rgba(245, 158, 11, 0.12)', text: '#f59e0b', border: 'rgba(245, 158, 11, 0.3)' },
  STALE: { bg: 'rgba(245, 158, 11, 0.12)', text: '#f59e0b', border: 'rgba(245, 158, 11, 0.3)' },
  COLLECTING: { bg: 'rgba(6, 182, 212, 0.12)', text: '#06b6d4', border: 'rgba(6, 182, 212, 0.3)' },
  BASELINE_REQUIRED: { bg: 'rgba(59, 130, 246, 0.12)', text: '#3b82f6', border: 'rgba(59, 130, 246, 0.3)' },

  CRITICAL: { bg: 'rgba(239, 68, 68, 0.12)', text: '#ef4444', border: 'rgba(239, 68, 68, 0.3)' },
  STOPPED: { bg: 'rgba(107, 114, 128, 0.15)', text: '#9ca3af', border: 'rgba(107, 114, 128, 0.3)' },
  OFFLINE: { bg: 'rgba(107, 114, 128, 0.15)', text: '#9ca3af', border: 'rgba(107, 114, 128, 0.3)' },
  NOT_CONFIGURED: { bg: 'rgba(107, 114, 128, 0.15)', text: '#9ca3af', border: 'rgba(107, 114, 128, 0.3)' },
  UNAVAILABLE: { bg: 'rgba(239, 68, 68, 0.12)', text: '#ef4444', border: 'rgba(239, 68, 68, 0.3)' },
  UNKNOWN: { bg: 'rgba(239, 68, 68, 0.12)', text: '#ef4444', border: 'rgba(239, 68, 68, 0.3)' },
  DATA_UNAVAILABLE: { bg: 'rgba(239, 68, 68, 0.12)', text: '#ef4444', border: 'rgba(239, 68, 68, 0.3)' },
  'UNKNOWN_/_DATA_UNAVAILABLE': { bg: 'rgba(239, 68, 68, 0.12)', text: '#ef4444', border: 'rgba(239, 68, 68, 0.3)' },
};

export default function StatusBadge({ status, label, size = 'md' }) {
  const normalizedKey = (status || '').toUpperCase().replace(/ /g, '_');
  const style = BADGE_STYLES[normalizedKey] || BADGE_STYLES.OFFLINE;

  const fontSizes = {
    sm: '11px',
    md: '12px',
    lg: '14px',
  };

  const paddings = {
    sm: '2px 8px',
    md: '4px 10px',
    lg: '6px 14px',
  };

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        padding: paddings[size] || paddings.md,
        borderRadius: '9999px',
        backgroundColor: style.bg,
        color: style.text,
        border: `1px solid ${style.border}`,
        fontSize: fontSizes[size] || fontSizes.md,
        fontWeight: '600',
        letterSpacing: '0.04em',
        textTransform: 'uppercase',
        fontFamily: 'inherit',
      }}
    >
      <span
        style={{
          width: size === 'sm' ? '5px' : '6px',
          height: size === 'sm' ? '5px' : '6px',
          borderRadius: '50%',
          backgroundColor: style.text,
        }}
      />
      {label || status || 'UNKNOWN'}
    </span>
  );
}
