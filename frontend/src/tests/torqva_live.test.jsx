import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { LivePage, eventMarks } from '../torqva/simulation/pages.jsx';

const samples = [10, 11, 12, 13, 14, 15].map((t) => ({ t, rpm: 1800, setpoint: 1800, housing: 30, vib_rms: 0.1, current: 1.2, score: 0.5 }));
const d = {
  status: { mode: 'SIMULATION', t: 15, scenario: { fault: 'imbalance', inject_after_s: 12 }, last_window: samples[5], device: { setpoint_rpm: 1800 } },
  telemetry: { samples }, log: [{ t: 13.4, kind: 'incident_opened', incident: 'INC-1' }, { t: 3, kind: 'incident_opened' }, { t: 14, kind: 'hypotheses' }],
};
const charts = () => screen.queryAllByRole('img', { name: /over time/ });

describe('Live Monitor signal filter and event marks', () => {
  it('marks only logged pipeline events and the scenario injection inside the window, on the nearest sample', () => {
    expect(eventMarks(d, samples)).toEqual([{ t: 12, label: 'fault injected (scenario)', n: 1, at: 12 }, { t: 13.4, label: 'incident opened', n: 2, at: 13 }]);   // in time order, numbered, drawn on the nearest sample
    expect(eventMarks(d, [])).toEqual([]);
  });

  it('shows or hides each chart, keeps at least one, and draws event marks only when asked', () => {
    render(<LivePage d={d} role="viewer" actions={{}} running={false} setRunning={() => {}} busy={false} />);
    expect(charts()).toHaveLength(4);
    const sig = screen.getByTestId('live-signals');
    for (const n of ['Speed', 'Temperature', 'Vibration']) fireEvent.click(within(sig).getByRole('button', { name: n }));
    expect(charts()).toHaveLength(1);
    fireEvent.click(within(sig).getByRole('button', { name: 'Current' }));                    // the last visible chart cannot be hidden
    expect(charts()).toHaveLength(1);
    expect(within(sig).getByRole('button', { name: 'Current' })).toHaveAttribute('aria-pressed', 'true');
    expect(charts()[0]).toHaveAccessibleName('Current over time');
    fireEvent.click(screen.getByTestId('live-events'));
    expect(charts()[0]).toHaveAccessibleName('Current over time, with 2 event mark(s)');
    expect(screen.getByTestId('live-marks')).toHaveTextContent('1 fault injected (scenario) (t = 12 s)2 incident opened (t = 13 s)');
  });
});
