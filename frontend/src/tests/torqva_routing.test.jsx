// URL routing: the page lives in the URL hash (#/<page>, #/device/<tab>) so a refresh, a link and Back / Forward open the right page. A route only
// chooses what is shown: the mode is never taken from the URL, Safety & Commissioning never opens in simulation mode, and nothing is sent.
import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import TorqvaApp, { parseRoute, routeHash } from '../torqva/TorqvaApp.jsx';
import { setToken } from '../torqva/api.js';

const ok = (j) => ({ ok: true, status: 200, json: async () => j });
let posts;
function server() {
  posts = [];
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    const path = String(url).replace('/api/torqva', '').split('?')[0];
    if ((opts.method || 'GET') !== 'GET') posts.push(path);
    if (path === '/me') return ok({ user: 'tester', role: 'admin' });
    if (path === '/status') return ok({ mode: 'SIMULATION', t: 60, device: { estop: false, setpoint_rpm: 1800 }, last_window: { t: 60, rpm: 1795, current: 1.3, voltage: 24, housing: 24.5, vib_rms: 0.08, valid: true }, models: {}, scenario: { fault: null } });
    if (path === '/telemetry') return ok({ samples: [] });
    if (path === '/attestation/references') return ok({ versions: [], active_version: null });
    if (path === '/attestation/warmup') return ok({ active: false });
    return ok([]);
  }));
}
const active = () => document.querySelector('nav [aria-current="page"]')?.textContent;
async function open(hash, mode = 'SIMULATION') {
  window.localStorage.setItem('torqva.mode', mode);
  window.history.replaceState(null, '', `/${hash}`);
  server(); setToken('t');
  const r = render(<TorqvaApp pollMs={100000} />);
  await screen.findByText(/tester · /);
  return r;
}
beforeEach(() => { vi.unstubAllGlobals(); setToken(''); });

describe('route parsing', () => {
  it('accepts every page id, the device tabs and the old aliases, and nothing else', () => {
    expect(parseRoute('#/live')).toEqual({ view: 'live', tab: null });
    expect(parseRoute('#/device/connection')).toEqual({ view: 'device', tab: 'connection' });
    expect(parseRoute('#/device')).toEqual({ view: 'device', tab: 'system' });
    expect(parseRoute('#/control')).toEqual({ view: 'device', tab: 'safety' });
    for (const bad of ['', '#', '#/', '#/nope', '#/live/extra', '#/device/nope', '#/LIVE', '#/../x', '#/live?x=1']) expect(parseRoute(bad), bad).toBeNull();
    expect(routeHash('device', 'safety')).toBe('#/device/safety');
    expect(routeHash('tests')).toBe('#/tests');
  });
});

describe('URL routing in the app', () => {
  it('opens the page named in the URL (a refresh keeps the page) and keeps its group expanded', async () => {
    await open('#/predictions');
    await waitFor(() => expect(active()).toMatch(/^Failure Prediction/));
    expect(screen.getByRole('button', { name: 'Show or hide Diagnose' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('writes the page to the URL on navigation and follows Back', async () => {
    await open('');
    await waitFor(() => expect(window.location.hash).toBe('#/overview'));          // the first page replaces, it adds no entry
    fireEvent.click(screen.getByRole('button', { name: /^Live Monitor/ }));
    await waitFor(() => expect(window.location.hash).toBe('#/live'));
    fireEvent.click(screen.getByRole('button', { name: /^Lab/ }));
    await waitFor(() => expect(window.location.hash).toBe('#/lab'));
    act(() => { window.history.replaceState(null, '', '/#/live'); window.dispatchEvent(new PopStateEvent('popstate')); });   // what Back does
    await waitFor(() => expect(active()).toMatch(/^Live Monitor/));
  });

  it('an unknown route opens Overview and the URL is corrected', async () => {
    await open('#/not-a-page');
    await waitFor(() => expect(active()).toMatch(/^Overview/));
    await waitFor(() => expect(window.location.hash).toBe('#/overview'));
  });

  it('a Device & Safety tab is part of the URL', async () => {
    await open('#/device/connection');
    await waitFor(() => expect(screen.getByRole('tab', { name: /Connection & Readiness/ })).toHaveAttribute('aria-selected', 'true'));
    fireEvent.click(screen.getByRole('tab', { name: /^Device$/ }));
    await waitFor(() => expect(window.location.hash).toBe('#/device/system'));
  });

  it('Safety & Commissioning cannot be opened by URL in simulation mode, and the URL never switches the mode', async () => {
    await open('#/device/safety', 'SIMULATION');
    await waitFor(() => expect(screen.getByRole('tab', { name: /^Device$/ })).toHaveAttribute('aria-selected', 'true'));
    expect(screen.queryByRole('tab', { name: /Safety & Commissioning/ })).toBeNull();
    await waitFor(() => expect(window.location.hash).toBe('#/device/system'));
    expect(window.localStorage.getItem('torqva.mode')).toBe('SIMULATION');
  });

  it('a hand-edited URL to Safety & Commissioning in simulation mode is corrected too (same page, no reload)', async () => {
    await open('#/device/system', 'SIMULATION');
    act(() => { window.history.replaceState(null, '', '/#/device/safety'); window.dispatchEvent(new HashChangeEvent('hashchange')); });
    await waitFor(() => expect(window.location.hash).toBe('#/device/system'));
    expect(screen.queryByRole('tab', { name: /Safety & Commissioning/ })).toBeNull();
  });

  it('opening a route sends no command and starts nothing', async () => {
    for (const h of ['#/scenario', '#/interventions', '#/workflow', '#/device/connection']) {
      const { unmount } = await open(h);
      await new Promise((r) => setTimeout(r, 50));
      expect(posts, h).toEqual([]);
      unmount(); vi.unstubAllGlobals(); setToken('');
    }
  });
});
