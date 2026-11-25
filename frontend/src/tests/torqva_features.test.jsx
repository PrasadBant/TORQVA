import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { RecordingIndicator, CopySummaryButton, formatSummaryText, formatDuration, copyToClipboard } from '../shared/recording.jsx';
import { TelemetryWindowControl, TELEMETRY_WINDOWS } from '../shared/windows.jsx';
import { ChartInspectPopover } from '../shared/charts.jsx';
import { AlarmProvider, useAlarmContext, RpmAlarmBanner } from '../safety/alarmContext.jsx';
import { LimitsPanel } from '../safety/limits.jsx';
import { api } from '../shared/api.js';

describe('Feature 4: CSV Recording & Feature 5: Report/Export', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders RecordingIndicator in idle state and opens modal on click', async () => {
    vi.spyOn(api, 'recordingStatus').mockResolvedValue({
      active: false,
      session_id: null,
      readings_count: 0,
      duration_s: 0,
    });
    vi.spyOn(api, 'recordingSessions').mockResolvedValue([
      {
        session_id: '20261120_183000_physical',
        mode: 'PHYSICAL',
        readings_count: 142,
        duration_s: 28.4,
      },
    ]);
    vi.spyOn(api, 'recordingSummary').mockResolvedValue(null);

    render(<RecordingIndicator physicalMode={true} role="operator" />);

    const indicator = await screen.findByTestId('recording-indicator');
    expect(indicator).toBeInTheDocument();
    expect(indicator).toHaveTextContent(/REC/);

    // Open modal
    fireEvent.click(indicator);

    expect(await screen.findByTestId('recording-modal')).toBeInTheDocument();
    expect(screen.getByTestId('recording-start-btn')).toBeInTheDocument();
    expect(screen.getByTestId('recording-sessions-list')).toBeInTheDocument();

    // Check past session and export links
    expect(screen.getByText('20261120_183000_physical')).toBeInTheDocument();
    const zipLink = screen.getByTestId('export-zip-20261120_183000_physical');
    expect(zipLink).toHaveAttribute('href', expect.stringContaining('/recording/sessions/20261120_183000_physical/export'));

    const reportLink = screen.getByTestId('view-report-20261120_183000_physical');
    expect(reportLink).toHaveAttribute('href', expect.stringContaining('/recording/sessions/20261120_183000_physical/report'));
  });

  it('displays active recording with pulsing indicator and allows stop', async () => {
    vi.spyOn(api, 'recordingStatus').mockResolvedValue({
      active: true,
      session_id: '20261120_190000_sim',
      readings_count: 450,
      duration_s: 45.0,
      mode: 'SIMULATION',
    });
    vi.spyOn(api, 'recordingSessions').mockResolvedValue([]);
    const stopSpy = vi.spyOn(api, 'recordingStop').mockResolvedValue({ ok: true });

    render(<RecordingIndicator physicalMode={false} role="operator" />);

    const indicator = await screen.findByTestId('recording-indicator');
    expect(indicator).toHaveClass('active');
    expect(indicator).toHaveTextContent(/00:45/);

    fireEvent.click(indicator);
    const stopBtn = await screen.findByTestId('recording-stop-btn');
    expect(stopBtn).toBeInTheDocument();

    fireEvent.click(stopBtn);
    expect(stopSpy).toHaveBeenCalledTimes(1);
  });
});

describe('Feature 7: Copy Summary', () => {
  it('formats summary text correctly with valid and invalid values', () => {
    const summary = {
      mode: 'PHYSICAL',
      duration_s: 52.3,
      peak_rpm: 2950,
      peak_current_a: 3.42,
      max_temp_c: 49.8,
      data_quality_pct: 99.2,
      invalid_readings_count: 2,
    };
    const text = formatSummaryText(summary, 'PHYSICAL');
    expect(text).toContain('TORQVA SESSION SUMMARY');
    expect(text).toContain('Mode: PHYSICAL');
    expect(text).toContain('Duration: 52.3 s');
    expect(text).toContain('Peak Speed: 2950 rpm');
    expect(text).toContain('Peak Current: 3.42 A');
    expect(text).toContain('Max Temp: 49.8 °C');
    expect(text).toContain('Data Quality: 99.2% valid (2 invalid/missing)');
  });

  it('copies summary and updates button text to Copied!', async () => {
    const summary = {
      mode: 'SIMULATION',
      duration_s: 30.0,
      peak_rpm: 1500,
      peak_current_a: 1.2,
      max_temp_c: 35.0,
      data_quality_pct: 100.0,
    };
    vi.spyOn(api, 'recordingSummary').mockResolvedValue(summary);
    const writeTextSpy = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, {
      clipboard: { writeText: writeTextSpy },
    });

    render(<CopySummaryButton mode="SIMULATION" />);
    const btn = screen.getByTestId('copy-summary-btn');
    expect(btn).toHaveTextContent('Copy Summary');

    await act(async () => {
      fireEvent.click(btn);
    });

    expect(writeTextSpy).toHaveBeenCalled();
    expect(screen.getByTestId('copy-summary-btn')).toHaveTextContent('Copied!');
  });
});

describe('Feature 6: Click-to-Inspect', () => {
  it('renders ChartInspectPopover with timestamp, value, unit and quality flag', () => {
    const point = {
      t: 14.5,
      val: 2840,
      formatted: '2840',
      unit: 'rpm',
      name: 'Speed',
      quality: 'VALID',
    };
    const onClose = vi.fn();

    render(<ChartInspectPopover point={point} onClose={onClose} />);

    expect(screen.getByTestId('chart-inspect-popover')).toBeInTheDocument();
    expect(screen.getByText(/t = 14.5 s/)).toBeInTheDocument();
    expect(screen.getByTestId('inspect-quality-badge')).toHaveTextContent('VALID');
    expect(screen.getByTestId('inspect-value-text')).toHaveTextContent('2840 rpm');

    fireEvent.click(screen.getByRole('button', { name: /close/i }));
    expect(onClose).toHaveBeenCalled();
  });

  it('displays UNAVAILABLE quality flag for missing/invalid data point', () => {
    const point = {
      t: 22.0,
      val: null,
      formatted: 'UNAVAILABLE',
      unit: '°C',
      name: 'Housing temperature',
      quality: 'UNAVAILABLE',
    };

    render(<ChartInspectPopover point={point} onClose={() => {}} />);

    expect(screen.getByTestId('inspect-quality-badge')).toHaveTextContent('UNAVAILABLE');
    expect(screen.getByTestId('inspect-value-text')).toHaveTextContent('UNAVAILABLE');
  });
});

describe('Feature 3: Telemetry Windows Control', () => {
  it('renders all window options with default 60s selected', () => {
    const onChange = vi.fn();
    render(<TelemetryWindowControl seconds={60} onChange={onChange} />);

    expect(screen.getByTestId('telemetry-windows-control')).toBeInTheDocument();
    expect(screen.getByTestId('window-btn-60s')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('window-btn-1s')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('window-btn-10s')).toBeInTheDocument();
    expect(screen.getByTestId('window-btn-30s')).toBeInTheDocument();
    expect(screen.getByTestId('window-btn-3min')).toBeInTheDocument();
    expect(screen.getByTestId('window-btn-5min')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('window-btn-10s'));
    expect(onChange).toHaveBeenCalledWith(10);
  });

  it('invokes api.resetHistory on Reset button click', async () => {
    const resetSpy = vi.spyOn(api, 'resetHistory').mockResolvedValue({ ok: true });
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(<TelemetryWindowControl seconds={60} role="operator" />);

    const resetBtn = screen.getByTestId('history-reset-btn');
    expect(resetBtn).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(resetBtn);
    });

    expect(resetSpy).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Cleared')).toBeInTheDocument();
  });
});

describe('Feature 2: 3000 RPM Advisory Alarm', () => {
  function TestAlarmHarness() {
    const { evaluate } = useAlarmContext();
    return (
      <div>
        <button onClick={() => evaluate({ rpm: 3100, isRunning: true, valid: true })}>Trigger 3100</button>
        <button onClick={() => evaluate({ rpm: 2950, isRunning: true, valid: true })}>Drop to 2950</button>
        <button onClick={() => evaluate({ rpm: 2850, isRunning: true, valid: true })}>Clear to 2850</button>
        <button onClick={() => evaluate({ rpm: null, isRunning: true, valid: false })}>Invalid Hall</button>
        <RpmAlarmBanner rpm={3100} />
      </div>
    );
  }

  it('fires advisory alarm at 3000+ RPM and stays latched until < 2900 RPM (hysteresis)', async () => {
    render(
      <AlarmProvider>
        <TestAlarmHarness />
      </AlarmProvider>
    );

    expect(screen.queryByTestId('rpm-alarm-banner')).not.toBeInTheDocument();

    // Trigger above 3000
    fireEvent.click(screen.getByText('Trigger 3100'));
    expect(screen.getByTestId('rpm-alarm-banner')).toBeInTheDocument();
    expect(screen.getByText(/SPEED ADVISORY ALARM/)).toBeInTheDocument();

    // Drop to 2950 (inside hysteresis zone 2900..3000) -> alarm must remain active!
    fireEvent.click(screen.getByText('Drop to 2950'));
    expect(screen.getByTestId('rpm-alarm-banner')).toBeInTheDocument();

    // Clear below 2900 -> alarm clears!
    fireEvent.click(screen.getByText('Clear to 2850'));
    expect(screen.queryByTestId('rpm-alarm-banner')).not.toBeInTheDocument();
  });

  it('displays SPEED UNAVAILABLE when Hall data is invalid while running', async () => {
    render(
      <AlarmProvider>
        <TestAlarmHarness />
      </AlarmProvider>
    );

    fireEvent.click(screen.getByText('Invalid Hall'));
    expect(screen.getByTestId('hall-invalid-warning')).toBeInTheDocument();
    expect(screen.getByText(/SPEED UNAVAILABLE/)).toBeInTheDocument();
  });

  it('mutes alarm for 10 seconds and allows adjustment', async () => {
    render(
      <AlarmProvider>
        <TestAlarmHarness />
      </AlarmProvider>
    );

    fireEvent.click(screen.getByText('Trigger 3100'));
    const muteBtn = screen.getByTestId('alarm-mute-btn');
    expect(muteBtn).toHaveTextContent('Mute (10s)');

    fireEvent.click(muteBtn);
    expect(muteBtn).toHaveTextContent(/Muted/);

    const input = screen.getByTestId('alarm-threshold-input');
    expect(input).toHaveValue(3000);
    fireEvent.change(input, { target: { value: '3500' } });
    expect(input).toHaveValue(3500);
  });
});

describe('Feature 1: Limits Panel', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders all limit parameters and change log', async () => {
    vi.spyOn(api, 'getLimits').mockResolvedValue({
      limits: {
        duty: { name: 'Max Duty Cycle', value: 70, default: 70, unit: '%', enabled: true, min: 0, max: 100 },
        rpm: { name: 'Max Speed Setpoint', value: 3000, default: 3000, unit: 'rpm', enabled: true, min: 0, max: 20000 },
        current: { name: 'Sustained Over-Current', value: 4.0, default: 4.0, unit: 'A', enabled: true, min: 0.1, max: 50 },
      },
      change_log: [
        {
          timestamp_iso: '2026-11-20T19:00:00Z',
          user: 'operator',
          param: 'rpm',
          param_name: 'Max Speed Setpoint',
          old_value: 3000,
          new_value: 2800,
          old_enabled: true,
          new_enabled: true,
          unit: 'rpm',
        },
      ],
    });

    render(<LimitsPanel role="operator" />);

    expect(await screen.findByTestId('limits-panel')).toBeInTheDocument();
    expect(screen.getByText('Max Duty Cycle')).toBeInTheDocument();
    expect(screen.getAllByText('Max Speed Setpoint').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Sustained Over-Current')).toBeInTheDocument();

    expect(screen.getByTestId('limit-toggle-rpm')).toHaveTextContent('ON');
    expect(screen.getByTestId('limit-input-rpm')).toHaveValue(3000);

    expect(screen.getByTestId('limits-change-log')).toBeInTheDocument();
    expect(screen.getByText(/3000 → 2800 rpm/)).toBeInTheDocument();
  });

  it('toggles limit ON/OFF and calls api.updateLimit', async () => {
    vi.spyOn(api, 'getLimits').mockResolvedValue({
      limits: {
        duty: { name: 'Max Duty Cycle', value: 70, default: 70, unit: '%', enabled: true, min: 0, max: 100 },
      },
      change_log: [],
    });
    const updateSpy = vi.spyOn(api, 'updateLimit').mockResolvedValue({
      ok: true,
      limit: { name: 'Max Duty Cycle', value: 70, default: 70, unit: '%', enabled: false, min: 0, max: 100 },
    });

    render(<LimitsPanel role="operator" />);

    const toggle = await screen.findByTestId('limit-toggle-duty');
    expect(toggle).toHaveTextContent('ON');

    await act(async () => {
      fireEvent.click(toggle);
    });

    expect(updateSpy).toHaveBeenCalledWith('duty', 70, false);
  });

  it('resets defaults via Reset Defaults button', async () => {
    vi.spyOn(api, 'getLimits').mockResolvedValue({
      limits: {
        rpm: { name: 'Max Speed Setpoint', value: 2500, default: 3000, unit: 'rpm', enabled: true, min: 0, max: 20000 },
      },
      change_log: [],
    });
    const resetSpy = vi.spyOn(api, 'resetLimits').mockResolvedValue({
      limits: {
        rpm: { name: 'Max Speed Setpoint', value: 3000, default: 3000, unit: 'rpm', enabled: true, min: 0, max: 20000 },
      },
      change_log: [],
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(<LimitsPanel role="operator" />);

    const resetBtn = await screen.findByTestId('limits-reset-defaults-btn');
    await act(async () => {
      fireEvent.click(resetBtn);
    });

    expect(resetSpy).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Limits reset to torqva_limits.h defaults/)).toBeInTheDocument();
  });
});
