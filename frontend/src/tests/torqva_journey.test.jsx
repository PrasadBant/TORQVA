import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { JourneyBar } from '../torqva/simulation/journey.jsx';

describe('investigation progress bar', () => {
  it('without a simulation every step says it is unavailable or not reached, never complete', () => {
    render(<JourneyBar d={{ status: {}, log: [] }} view="diagnostics" go={() => {}} />);
    const bar = screen.getByTestId('journey');
    expect(within(bar).queryByText('complete')).toBeNull();
    expect(screen.getByTestId('journey-c1')).toHaveAttribute('data-state', 'na');
    expect(screen.getByTestId('journey-c5')).toHaveAttribute('data-state', 'idle');
  });

  it('marks the current page, follows the analyst order and opens a step page on click', () => {
    const go = vi.fn();
    render(<JourneyBar d={{ status: {}, log: [] }} view="predictions" go={go} />);
    const steps = screen.getAllByRole('listitem').map((li) => li.getAttribute('data-testid'));
    expect(steps).toEqual(['journey-monitor', 'journey-c1', 'journey-c4', 'journey-c2', 'journey-c3', 'journey-c5']);
    expect(within(screen.getByTestId('journey-c2')).getByRole('button')).toHaveAttribute('aria-current', 'step');
    fireEvent.click(within(screen.getByTestId('journey-c4')).getByRole('button'));
    expect(go).toHaveBeenCalledWith('tests');
    expect(screen.getByTestId('journey-note')).toHaveTextContent('Understand · Failure Prediction: Not reached: no incident has been opened.');   // the backend summary is visible, not only on hover
  });
});
