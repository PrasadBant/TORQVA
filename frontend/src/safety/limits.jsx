import React, { useEffect, useState, useCallback } from 'react';
import { Sliders, RotateCcw, ShieldCheck, Check, AlertTriangle, History, RefreshCw } from 'lucide-react';
import { api } from '../shared/api.js';

export function LimitsPanel({ role = 'operator', onUpdated }) {
  const [data, setData] = useState({ limits: {}, change_log: [] });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState({});
  const [error, setError] = useState(null);
  const [successMsg, setSuccessMsg] = useState(null);

  const fetchLimits = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.getLimits();
      if (res) setData(res);
    } catch (e) {
      setError(e.message || 'Failed to load operational limits');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchLimits();
  }, [fetchLimits]);

  const handleToggle = async (key, currentEnabled, currentValue) => {
    setSaving((s) => ({ ...s, [key]: true }));
    setError(null);
    try {
      const res = await api.updateLimit(key, currentValue, !currentEnabled);
      if (res?.limit) {
        setData((prev) => ({
          ...prev,
          limits: { ...prev.limits, [key]: res.limit },
        }));
      }
      fetchLimits(); // refresh change log
      if (onUpdated) onUpdated();
    } catch (e) {
      setError(e.message || `Failed to update limit ${key}`);
    } finally {
      setSaving((s) => ({ ...s, [key]: false }));
    }
  };

  const handleValueChange = async (key, val, enabled) => {
    const num = parseFloat(val);
    if (isNaN(num)) return;
    setSaving((s) => ({ ...s, [key]: true }));
    setError(null);
    try {
      const res = await api.updateLimit(key, num, enabled);
      if (res?.limit) {
        setData((prev) => ({
          ...prev,
          limits: { ...prev.limits, [key]: res.limit },
        }));
      }
      fetchLimits(); // refresh change log
      if (onUpdated) onUpdated();
    } catch (e) {
      setError(e.message || `Failed to update value for ${key}`);
    } finally {
      setSaving((s) => ({ ...s, [key]: false }));
    }
  };

  const handleResetDefaults = async () => {
    if (!window.confirm('Reset all operational limits to torqva_limits.h defaults?')) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.resetLimits();
      if (res) setData(res);
      setSuccessMsg('Limits reset to torqva_limits.h defaults');
      setTimeout(() => setSuccessMsg(null), 3000);
      if (onUpdated) onUpdated();
    } catch (e) {
      setError(e.message || 'Failed to reset limits');
    } finally {
      setLoading(false);
    }
  };

  const isOperator = role === 'operator' || role === 'admin';
  const limitsList = Object.entries(data.limits || {});

  return (
    <div className="tq-card" data-testid="limits-panel" style={{ padding: '16px', margin: '16px 0' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Sliders size={18} style={{ color: 'var(--tq-accent, #38bdf8)' }} aria-hidden="true" />
          <h3 style={{ margin: 0, fontSize: '1.1rem' }}>Operational &amp; Safety Limits</h3>
          <span className="tq-small tq-muted">(Source: torqva_limits.h)</span>
        </div>

        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <button
            type="button"
            className="tq-btn tq-ghost"
            onClick={fetchLimits}
            disabled={loading}
            style={{ padding: '4px 8px', fontSize: '0.8rem' }}
          >
            <RefreshCw size={13} className={loading ? 'spin' : ''} /> Refresh
          </button>
          <button
            type="button"
            className="tq-btn"
            onClick={handleResetDefaults}
            disabled={!isOperator || loading}
            data-testid="limits-reset-defaults-btn"
            style={{ fontSize: '0.8rem', padding: '4px 10px' }}
            title="Reset all limits to hardware defaults defined in torqva_limits.h"
          >
            <RotateCcw size={13} aria-hidden="true" /> Reset Defaults
          </button>
        </div>
      </div>

      {error && (
        <div className="tq-callout crit" style={{ marginBottom: '12px' }}>
          <AlertTriangle size={14} /> <span>{error}</span>
        </div>
      )}

      {successMsg && (
        <div className="tq-callout ok" style={{ marginBottom: '12px' }}>
          <Check size={14} /> <span>{successMsg}</span>
        </div>
      )}

      {/* Limits Table */}
      <div style={{ overflowX: 'auto', marginBottom: '20px' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--tq-border, #334155)', textAlign: 'left', background: 'rgba(255,255,255,0.02)' }}>
              <th style={{ padding: '8px 10px' }}>Limit Parameter</th>
              <th style={{ padding: '8px 10px' }}>State (ON/OFF)</th>
              <th style={{ padding: '8px 10px' }}>Value</th>
              <th style={{ padding: '8px 10px' }}>Range</th>
              <th style={{ padding: '8px 10px' }}>Default</th>
            </tr>
          </thead>
          <tbody>
            {limitsList.map(([k, p]) => (
              <tr key={k} style={{ borderBottom: '1px solid var(--tq-border, #334155)' }}>
                <td style={{ padding: '8px 10px' }}>
                  <strong style={{ display: 'block' }}>{p.name}</strong>
                  <span className="tq-small tq-muted">{p.description}</span>
                </td>
                <td style={{ padding: '8px 10px' }}>
                  <button
                    type="button"
                    className={`tq-btn ${p.enabled ? 'tq-primary' : 'tq-ghost'}`}
                    onClick={() => handleToggle(k, p.enabled, p.value)}
                    disabled={!isOperator || saving[k]}
                    data-testid={`limit-toggle-${k}`}
                    style={{
                      padding: '2px 10px',
                      fontSize: '0.75rem',
                      fontWeight: 600,
                      background: p.enabled ? '#10b981' : '#475569',
                      color: '#fff',
                      border: 'none',
                    }}
                  >
                    {p.enabled ? 'ON' : 'OFF'}
                  </button>
                </td>
                <td style={{ padding: '8px 10px' }}>
                  <div style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                    <input
                      type="number"
                      step={p.unit === 'A' || p.unit === 'V' ? '0.1' : '1'}
                      min={p.min}
                      max={p.max}
                      defaultValue={p.value}
                      key={`${k}-${p.value}`}
                      onBlur={(e) => handleValueChange(k, e.target.value, p.enabled)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          handleValueChange(k, e.currentTarget.value, p.enabled);
                          e.currentTarget.blur();
                        }
                      }}
                      disabled={!isOperator || saving[k] || !p.enabled}
                      data-testid={`limit-input-${k}`}
                      style={{
                        width: '76px',
                        padding: '4px 6px',
                        fontSize: '0.85rem',
                        borderRadius: '4px',
                        border: '1px solid var(--tq-border, #475569)',
                        opacity: p.enabled ? 1 : 0.5,
                      }}
                    />
                    <span style={{ fontSize: '0.8rem', color: 'var(--tq-text-muted, #94a3b8)' }}>{p.unit}</span>
                  </div>
                </td>
                <td style={{ padding: '8px 10px', color: 'var(--tq-text-muted, #94a3b8)', fontSize: '0.8rem' }}>
                  {p.min} – {p.max} {p.unit}
                </td>
                <td style={{ padding: '8px 10px', color: 'var(--tq-text-muted, #94a3b8)', fontSize: '0.8rem' }}>
                  {p.default} {p.unit}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Change Log */}
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '8px' }}>
          <History size={15} aria-hidden="true" />
          <h4 style={{ margin: 0, fontSize: '0.95rem' }}>Limits Audit Change Log</h4>
        </div>

        <div data-testid="limits-change-log" style={{ maxHeight: '160px', overflowY: 'auto', border: '1px solid var(--tq-border, #334155)', borderRadius: '6px' }}>
          {(!data.change_log || data.change_log.length === 0) ? (
            <p style={{ padding: '12px', margin: 0, textAlign: 'center', color: 'var(--tq-text-muted, #94a3b8)', fontSize: '0.85rem' }}>
              No limit changes recorded in this session.
            </p>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--tq-border, #334155)', textAlign: 'left', background: 'rgba(255,255,255,0.02)' }}>
                  <th style={{ padding: '6px 8px' }}>Timestamp</th>
                  <th style={{ padding: '6px 8px' }}>User</th>
                  <th style={{ padding: '6px 8px' }}>Parameter</th>
                  <th style={{ padding: '6px 8px' }}>Value Change</th>
                  <th style={{ padding: '6px 8px' }}>Enabled State</th>
                </tr>
              </thead>
              <tbody>
                {data.change_log.slice().reverse().map((entry, idx) => (
                  <tr key={idx} style={{ borderBottom: '1px solid var(--tq-border, #334155)' }}>
                    <td style={{ padding: '6px 8px', whiteSpace: 'nowrap' }}>
                      {entry.timestamp_iso ? new Date(entry.timestamp_iso).toLocaleTimeString() : '—'}
                    </td>
                    <td style={{ padding: '6px 8px' }}>
                      <span className="tq-pill" style={{ padding: '1px 5px', fontSize: '0.7rem' }}>{entry.user}</span>
                    </td>
                    <td style={{ padding: '6px 8px' }}>{entry.param_name || entry.param}</td>
                    <td style={{ padding: '6px 8px' }}>
                      {entry.old_value != null ? `${entry.old_value} → ${entry.new_value} ${entry.unit}` : 'Reset'}
                    </td>
                    <td style={{ padding: '6px 8px' }}>
                      {entry.old_enabled != null ? `${entry.old_enabled ? 'ON' : 'OFF'} → ${entry.new_enabled ? 'ON' : 'OFF'}` : 'Default'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
