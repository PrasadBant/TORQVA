import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, beforeEach } from 'vitest';
import { OfflineSetupGuide, ExperimentalPhysicalAiWidget, SpeedStatus } from '../torqva/physical/physical.jsx';
import { RunComparisonTable, SessionNoteEditor } from '../torqva/shared/recording.jsx';

describe('Phase 4 Physical Mode UX Enhancements', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  describe('OfflineSetupGuide', () => {
    it('renders 3-step hardware setup guide and simulation mode button', () => {
      let simClicked = false;
      render(<OfflineSetupGuide onSwitchToSim={() => { simClicked = true; }} />);

      expect(screen.getByText(/Physical Hardware Setup & Offline Guide/i)).toBeInTheDocument();
      expect(screen.getByText(/USB Link & Serial Port/i)).toBeInTheDocument();
      expect(screen.getByText(/Firmware v3.1.0\+/i)).toBeInTheDocument();
      expect(screen.getByText(/Motor Power & E-Stop/i)).toBeInTheDocument();

      const btn = screen.getByTestId('btn-try-simulation');
      expect(btn).toBeInTheDocument();
      fireEvent.click(btn);
      expect(simClicked).toBe(true);
    });
  });

  describe('ExperimentalPhysicalAiWidget', () => {
    it('handles offline state safely without error or false alarms', () => {
      render(<ExperimentalPhysicalAiWidget vals={{}} live={false} isRunning={false} />);
      expect(screen.getByText(/EXPERIMENTAL \(SIM-TRAINED\)/i)).toBeInTheDocument();
      expect(screen.getByText(/Awaiting Telemetry/i)).toBeInTheDocument();
    });

    it('shows 100% idle baseline with zero false alarms when motor is stopped', () => {
      const vals = {
        rpm: { value: 0, valid: true },
        current: { value: 0.1, valid: true },
        voltage: { value: 24.1, valid: true },
        housing: { value: 26.5, valid: true },
      };
      render(<ExperimentalPhysicalAiWidget vals={vals} live={true} isRunning={false} />);
      expect(screen.getByText(/100%/)).toBeInTheDocument();
      expect(screen.getByText(/Motor Idle \(Baseline locked; zero false alarms on idle telemetry\)/i)).toBeInTheDocument();
    });

    it('evaluates nominal running motor as healthy baseline', () => {
      const vals = {
        rpm: { value: 1350, valid: true },
        current: { value: 1.25, valid: true },
        voltage: { value: 23.8, valid: true },
        housing: { value: 34.2, valid: true },
      };
      render(<ExperimentalPhysicalAiWidget vals={vals} live={true} isRunning={true} />);
      expect(screen.getByText(/96%/)).toBeInTheDocument();
      expect(screen.getByText(/Nominal Baseline \(Speed-bin matched\)/i)).toBeInTheDocument();
    });

    it('detects elevated current anomaly and flags warning tone', () => {
      const vals = {
        rpm: { value: 1200, valid: true },
        current: { value: 5.8, valid: true },
        voltage: { value: 22.0, valid: true },
        housing: { value: 45.0, valid: true },
      };
      render(<ExperimentalPhysicalAiWidget vals={vals} live={true} isRunning={true} />);
      expect(screen.getByText(/68%/)).toBeInTheDocument();
      expect(screen.getByText(/Elevated Current Anomaly/i)).toBeInTheDocument();
    });
  });

  describe('SpeedStatus Hall Tachometer Details', () => {
    it('shows tachometer-only label, confidence, and active spike filter', () => {
      render(<SpeedStatus rpm={1350} isRunning={true} muted={false} onToggleMute={() => {}} />);
      expect(screen.getByText(/Tachometer Only \(Hall sensor on GPIO 9\)/i)).toBeInTheDocument();
      expect(screen.getByText(/Spike Filter:/i)).toBeInTheDocument();
      expect(screen.getByText(/ACTIVE/i)).toBeInTheDocument();
      expect(screen.getByText(/HIGH/i)).toBeInTheDocument();
    });
  });

  describe('Session Notes & Run Comparison', () => {
    it('allows editing and saving session notes', () => {
      let savedId = null;
      let savedText = null;
      render(
        <SessionNoteEditor
          sessionId="run_001"
          initialText=""
          onSave={(id, text) => {
            savedId = id;
            savedText = text;
          }}
        />
      );

      const input = screen.getByPlaceholderText(/Add note…/i);
      expect(input).toBeInTheDocument();

      fireEvent.change(input, { target: { value: 'Testing 50% duty with slight shaft eccentricity.' } });
      const saveBtn = screen.getByRole('button', { name: /Save/i });
      fireEvent.click(saveBtn);

      expect(savedId).toBe('run_001');
      expect(savedText).toBe('Testing 50% duty with slight shaft eccentricity.');
    });

    it('renders run comparison table side-by-side metrics', () => {
      const sessions = [
        { session_id: 'session_A123', mode: 'PHYSICAL', readings_count: 250, duration_s: 45.2 },
        { session_id: 'session_B456', mode: 'PHYSICAL', readings_count: 300, duration_s: 60.0 },
      ];
      const notes = {
        session_A123: 'First run baseline',
        session_B456: 'Second run loaded',
      };
      render(
        <RunComparisonTable
          compareIds={['session_A123', 'session_B456']}
          sessions={sessions}
          notes={notes}
        />
      );

      expect(screen.getByText(/Side-by-Side Run Comparison/i)).toBeInTheDocument();
      expect(screen.getByText(/session_A123/i)).toBeInTheDocument();
      expect(screen.getByText(/session_B456/i)).toBeInTheDocument();
      expect(screen.getByText(/00:45/i)).toBeInTheDocument();
      expect(screen.getByText(/01:00/i)).toBeInTheDocument();
      expect(screen.getByText(/First run baseline/i)).toBeInTheDocument();
      expect(screen.getByText(/Second run loaded/i)).toBeInTheDocument();
    });
  });
});
