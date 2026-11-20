import React, { useEffect, useState, useCallback, useRef } from 'react';
import { Circle, Download, FileText, Copy, Check, X, RefreshCw, Play, Square, AlertCircle } from 'lucide-react';
import { api } from '../api.js';

export function formatDuration(sec) {
  if (sec === null || sec === undefined || isNaN(sec)) return '00:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

export function formatSummaryText(summary, mode = 'PHYSICAL') {
  if (!summary) return 'TORQVA SESSION SUMMARY\nNo session data available.';
  const dur = summary.duration_s != null ? `${Number(summary.duration_s).toFixed(1)} s` : '—';
  const rpm = summary.peak_rpm != null ? `${Math.round(summary.peak_rpm)} rpm` : '—';
  const cur = summary.peak_current_a != null ? `${Number(summary.peak_current_a).toFixed(2)} A` : '—';
  const tmp = summary.max_temp_c != null ? `${Number(summary.max_temp_c).toFixed(1)} °C` : '—';
  const qual = summary.data_quality_pct != null ? `${Number(summary.data_quality_pct).toFixed(1)}%` : '100.0%';
  const inv = summary.invalid_readings_count || 0;

  return [
    'TORQVA SESSION SUMMARY',
    `Mode: ${summary.mode || mode}`,
    `Duration: ${dur}`,
    `Peak Speed: ${rpm}`,
    `Peak Current: ${cur}`,
    `Max Temp: ${tmp}`,
    `Data Quality: ${qual} valid (${inv} invalid/missing)`,
  ].join('\n');
}

export async function copyToClipboard(text) {
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (_) {
    // fallback
  }
  try {
    const el = document.createElement('textarea');
    el.value = text;
    el.setAttribute('readonly', '');
    el.style.position = 'absolute';
    el.style.left = '-9999px';
    document.body.appendChild(el);
    el.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(el);
    return ok;
  } catch (_) {
    return false;
  }
}

/** Standalone Copy Summary Button for Live Monitor / Session Inspector */
export function CopySummaryButton({ mode = 'PHYSICAL', customSummary = null, className = 'tq-btn', testid = 'copy-summary-btn' }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef(null);

  const handleCopy = async () => {
    let summary = customSummary;
    if (!summary) {
      try {
        summary = await api.recordingSummary();
      } catch (_) {
        summary = null;
      }
    }
    const text = formatSummaryText(summary, mode);
    const ok = await copyToClipboard(text);
    if (ok) {
      setCopied(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 2000);
    }
  };

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return (
    <button
      type="button"
      className={className}
      onClick={handleCopy}
      data-testid={testid}
      title="Copy telemetry session metrics to clipboard"
    >
      {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
      <span>{copied ? 'Copied!' : 'Copy Summary'}</span>
    </button>
  );
}

/** Header Recording Indicator and Sessions Manager Modal */
export function RecordingIndicator({ physicalMode = false, role = 'operator' }) {
  const [status, setStatus] = useState({ active: false, session_id: null, readings_count: 0, duration_s: 0 });
  const [open, setOpen] = useState(false);
  const [sessions, setSessions] = useState([]);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [selectedSummary, setSelectedSummary] = useState(null);
  const [actionError, setActionError] = useState(null);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await api.recordingStatus();
      if (res) setStatus(res);
    } catch (_) {
      // Backend not running or unreachable
    }
  }, []);

  useEffect(() => {
    fetchStatus();
    const id = setInterval(fetchStatus, 2500);
    return () => clearInterval(id);
  }, [fetchStatus]);

  const loadSessions = async () => {
    setLoadingSessions(true);
    setActionError(null);
    try {
      const list = await api.recordingSessions();
      setSessions(Array.isArray(list) ? list : []);
    } catch (e) {
      setActionError('Failed to load past sessions');
    } finally {
      setLoadingSessions(false);
    }
  };

  const handleToggleModal = () => {
    const next = !open;
    setOpen(next);
    if (next) {
      loadSessions();
      api.recordingSummary().then(setSelectedSummary).catch(() => {});
    }
  };

  const handleStart = async () => {
    setActionError(null);
    try {
      await api.recordingStart(physicalMode ? 'PHYSICAL' : 'SIMULATION');
      await fetchStatus();
      loadSessions();
    } catch (e) {
      setActionError(e.message || 'Failed to start recording');
    }
  };

  const handleStop = async () => {
    setActionError(null);
    try {
      await api.recordingStop();
      await fetchStatus();
      loadSessions();
      const s = await api.recordingSummary();
      setSelectedSummary(s);
    } catch (e) {
      setActionError(e.message || 'Failed to stop recording');
    }
  };

  const isOperator = role === 'operator' || role === 'admin';

  return (
    <>
      <button
        type="button"
        className={`tq-rec-indicator ${status.active ? 'active' : 'idle'}`}
        onClick={handleToggleModal}
        data-testid="recording-indicator"
        aria-label={status.active ? `Recording Active (${status.readings_count} pts)` : 'Recording Idle'}
        title={status.active ? `Recording Active: ${status.readings_count} samples recorded (${formatDuration(status.duration_s)})` : 'Telemetry Recording'}
      >
        <span className={`tq-rec-dot ${status.active ? 'pulsing' : ''}`} aria-hidden="true">●</span>
        <span className="tq-rec-label">
          {status.active ? `REC ${formatDuration(status.duration_s)}` : 'REC'}
        </span>
      </button>

      {open && (
        <div className="tq-modal-scrim" onClick={() => setOpen(false)}>
          <div className="tq-modal" data-testid="recording-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '640px', width: '90%' }}>
            <div className="tq-modal-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span className={`tq-rec-dot ${status.active ? 'pulsing' : ''}`} style={{ fontSize: '1.2rem', color: status.active ? '#ef4444' : '#64748b' }}>●</span>
                <h3 style={{ margin: 0 }}>Telemetry Session Recording</h3>
              </div>
              <button type="button" className="tq-iconbtn" onClick={() => setOpen(false)} aria-label="Close modal">
                <X size={18} />
              </button>
            </div>

            <div className="tq-modal-body" style={{ padding: '16px 0' }}>
              {actionError && (
                <div className="tq-callout crit" style={{ marginBottom: '12px' }}>
                  <AlertCircle size={14} /> <span>{actionError}</span>
                </div>
              )}

              {/* Live Session Status */}
              <div className="tq-card" style={{ padding: '12px', marginBottom: '16px', background: 'var(--tq-surface-2, rgba(255,255,255,0.04))', borderRadius: '6px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <strong>Status: </strong>
                    <span style={{ color: status.active ? '#ef4444' : 'inherit', fontWeight: 600 }}>
                      {status.active ? 'RECORDING' : 'IDLE'}
                    </span>
                    {status.active && (
                      <div className="tq-small tq-muted" style={{ marginTop: '4px' }}>
                        Session: <code>{status.session_id}</code> ({status.mode}) · {status.readings_count} pts · {formatDuration(status.duration_s)}
                      </div>
                    )}
                  </div>

                  <div style={{ display: 'flex', gap: '8px' }}>
                    {status.active ? (
                      <button
                        type="button"
                        className="tq-btn tq-btn-danger"
                        onClick={handleStop}
                        disabled={!isOperator}
                        data-testid="recording-stop-btn"
                        style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
                      >
                        <Square size={14} /> Stop Recording
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="tq-btn tq-primary"
                        onClick={handleStart}
                        disabled={!isOperator}
                        data-testid="recording-start-btn"
                        style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
                      >
                        <Play size={14} /> Start Recording ({physicalMode ? 'PHYSICAL' : 'SIMULATION'})
                      </button>
                    )}
                    <CopySummaryButton mode={physicalMode ? 'PHYSICAL' : 'SIMULATION'} customSummary={selectedSummary} />
                  </div>
                </div>
              </div>

              {/* Past Sessions List */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                <h4 style={{ margin: 0 }}>Recorded Sessions</h4>
                <button type="button" className="tq-btn tq-ghost" onClick={loadSessions} disabled={loadingSessions} style={{ padding: '4px 8px' }}>
                  <RefreshCw size={13} className={loadingSessions ? 'spin' : ''} /> Refresh
                </button>
              </div>

              <div data-testid="recording-sessions-list" style={{ maxHeight: '240px', overflowY: 'auto', border: '1px solid var(--tq-border, #334155)', borderRadius: '6px' }}>
                {sessions.length === 0 ? (
                  <p style={{ padding: '16px', margin: 0, textAlign: 'center', color: 'var(--tq-text-muted, #94a3b8)' }}>
                    {loadingSessions ? 'Loading recorded sessions…' : 'No recorded sessions found.'}
                  </p>
                ) : (
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
                    <thead>
                      <tr style={{ borderBottom: '1px solid var(--tq-border, #334155)', textAlign: 'left', background: 'rgba(255,255,255,0.02)' }}>
                        <th style={{ padding: '8px' }}>Session / Date</th>
                        <th style={{ padding: '8px' }}>Mode</th>
                        <th style={{ padding: '8px' }}>Points</th>
                        <th style={{ padding: '8px' }}>Duration</th>
                        <th style={{ padding: '8px', textAlign: 'right' }}>Exports</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sessions.map((s) => (
                        <tr key={s.session_id} style={{ borderBottom: '1px solid var(--tq-border, #334155)' }}>
                          <td style={{ padding: '8px' }}>
                            <code style={{ fontSize: '0.8rem' }}>{s.session_id}</code>
                          </td>
                          <td style={{ padding: '8px' }}>
                            <span className="tq-pill" style={{ padding: '2px 6px', fontSize: '0.75rem' }}>{s.mode}</span>
                          </td>
                          <td style={{ padding: '8px' }}>{s.readings_count || 0}</td>
                          <td style={{ padding: '8px' }}>{formatDuration(s.duration_s)}</td>
                          <td style={{ padding: '8px', textAlign: 'right' }}>
                            <div style={{ display: 'inline-flex', gap: '6px' }}>
                              <a
                                href={api.recordingExportUrl(s.session_id)}
                                download={`torqva_session_${s.session_id}.zip`}
                                className="tq-btn tq-ghost"
                                style={{ padding: '2px 8px', fontSize: '0.75rem', display: 'inline-flex', alignItems: 'center', gap: '4px' }}
                                title="Download ZIP bundle (readings.csv, events.csv, session.json, checksums, report.html)"
                                data-testid={`export-zip-${s.session_id}`}
                              >
                                <Download size={12} /> ZIP
                              </a>
                              <a
                                href={api.recordingReportUrl(s.session_id)}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="tq-btn tq-ghost"
                                style={{ padding: '2px 8px', fontSize: '0.75rem', display: 'inline-flex', alignItems: 'center', gap: '4px' }}
                                title="Open HTML session report in new tab"
                                data-testid={`view-report-${s.session_id}`}
                              >
                                <FileText size={12} /> Report
                              </a>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>

            <div className="tq-modal-foot" style={{ display: 'flex', justifyContent: 'flex-end', paddingTop: '12px', borderTop: '1px solid var(--tq-border, #334155)' }}>
              <button type="button" className="tq-btn" onClick={() => setOpen(false)}>
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
