import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import TorqvaApp from '../torqva/TorqvaApp.jsx';
import { setToken } from '../torqva/api.js';

const CHECK = { items: [{ key: 'guard', text: 'Guard fitted' }, { key: 'estop', text: 'E-stop tested' }], note: 'x' };
const REGIMES = [
  { name: 'baseline', description: 'Original simulator.' },
  { name: 'confusable_sensor', description: 'Sensor fault mimics looseness at one speed.' },
];
const session = (over = {}) => ({
  id: 'L-0001', purpose: 'fault_run', operator: 'tester', blind: true, revealed: false, status: 'planned',
  config: { regime: 'baseline', seed: 1, fault: 'HIDDEN (blind session)', profile: [{ rpm: 1500, hold_s: 90 }] },
  config_hash: 'HIDDEN (blind session)', fault_settings: 'HIDDEN (blind session)',
  checklist: { items: { guard: false, estop: false }, complete: false }, result: null, ...over,
});

function server(role, sessions) {
  const calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url, o = {}) => {
    const path = String(url).replace('/api/torqva', '');
    calls.push({ path, method: o.method || 'GET', body: o.body });
    const ok = (j) => ({ ok: true, status: 200, json: async () => j });
    if (path === '/me') return ok({ user: 'tester', role });
    if (path === '/status') return ok({ mode: 'SIMULATION', device: {}, models: {} });
    if (path === '/lab/regimes') return ok(REGIMES);
    if (path === '/lab/checklist') return ok(CHECK);
    if (path === '/lab/sessions' && (o.method || 'GET') === 'GET') return ok(sessions());
    if (path === '/lab/experiments') return ok([]);
    if (o.method === 'POST') return ok(session());
    return ok(path.startsWith('/telemetry') ? { samples: [] } : []);
  }));
  return calls;
}

async function openLab(role = 'operator', sessions = () => [session()]) {
  const calls = server(role, sessions);
  setToken('t');
  render(<TorqvaApp pollMs={100000} />);
  await screen.findByText(/tester · /);
  fireEvent.click(screen.getByRole('button', { name: /^Lab/ }));
  await screen.findByText('New recording session');
  return calls;
}

beforeEach(() => { vi.unstubAllGlobals(); setToken(''); });

describe('TORQVA Lab', () => {
  it('shows the regime description for the selected regime', async () => {
    await openLab();
    expect(await screen.findByTestId('regime-desc')).toHaveTextContent('Original simulator.');
    fireEvent.change(screen.getByLabelText('Simulation regime'), { target: { value: 'confusable_sensor' } });
    expect(screen.getByTestId('regime-desc')).toHaveTextContent('mimics looseness');
  });

  it('hides the injected fault of a blind session and offers no reveal before it has run', async () => {
    await openLab();
    expect(await screen.findByText('hidden (blind)')).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Open session L-0001' }));
    expect(screen.getByRole('button', { name: 'Reveal injected fault' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Run session' })).toBeDisabled();
    expect(screen.getByText(/Confirm every item to enable the run/)).toBeInTheDocument();
  });

  it('enables Run only when the checklist is complete, and says the checklist is not a safety mechanism', async () => {
    await openLab('operator', () => [session({ blind: false, revealed: true, checklist: { items: { guard: true, estop: true }, complete: true } })]);
    fireEvent.click(await screen.findByRole('button', { name: 'Open session L-0001' }));
    expect(await screen.findByText(/not a safety mechanism/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Run session' })).toBeEnabled();
  });

  it('a viewer can look but not create, run or tick the checklist', async () => {
    await openLab('viewer');
    expect(screen.getByRole('button', { name: 'Create session' })).toBeDisabled();
    fireEvent.click(await screen.findByRole('button', { name: 'Open session L-0001' }));
    screen.getAllByRole('checkbox').filter((c) => c.closest('ul')).forEach((c) => expect(c).toBeDisabled());
    expect(screen.getByRole('button', { name: 'Run experiment' })).toBeDisabled();
  });

  it('creating a session posts the profile, regime and blind flag', async () => {
    const calls = await openLab();
    fireEvent.click(screen.getByLabelText(/Blind session/));
    fireEvent.change(screen.getByLabelText('Simulation regime'), { target: { value: 'confusable_sensor' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create session' }));
    await waitFor(() => expect(calls.some((c) => c.path === '/lab/sessions' && c.method === 'POST')).toBe(true));
    const body = JSON.parse(calls.find((c) => c.path === '/lab/sessions' && c.method === 'POST').body);
    expect(body.blind).toBe(true);
    expect(body.regime).toBe('confusable_sensor');
    expect(body.profile).toEqual([{ rpm: 1500, hold_s: 90 }]);
  });
});
