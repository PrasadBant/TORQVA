// 3D Digital Twin: component metadata, the presentation-only spin, the procedural geometry, the callout layout, evidence-backed alerts in both
// mappings, the viewport <-> engine contract (with the WebGL engine mocked) and the fallback to the 2D drawing when WebGL 2 is missing.
import React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, screen, fireEvent, act, within } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { Vector3 } from 'three';

const engines = [];
vi.mock('../torqva/shared/twin3d/engine.js', () => {
  class FakeEngine {
    constructor(opts) {
      if (globalThis.__failEngine) throw new Error('no context');
      this.opts = opts; this.calls = []; engines.push(this);
      const log = (name) => (...a) => this.calls.push([name, ...a]);
      for (const m of ['setSelection', 'setMotion', 'setStates', 'setOptions', 'setTheme', 'invalidate', 'requestProjection', 'view', 'fit', 'focus', 'nudge', 'settle']) this[m] = log(m);
      this.cameraState = () => ({ snapshot: engines.indexOf(this) });
      this.dispose = () => { this.disposed = true; };
      opts.onStatus?.('ready');
    }
  }
  return { TwinEngine: FakeEngine, PRESETS: { iso: { label: 'Isometric' }, front: { label: 'Front' }, side: { label: 'Side (shaft end)' }, top: { label: 'Top' } } };
});

const { COMPONENT, COMPONENTS, EXPLODE, STRUCTURE_IDS, anchorAt, advanceAngle, spinRate, SPIN_SCALE } = await import('../torqva/shared/twinParts.js');
const { buildRig, revolve, SPIN_NODES } = await import('../torqva/shared/twin3d/assembly.js');
const { layoutCallouts } = await import('../torqva/shared/twin3d/overlay.js');
const { default: TwinViewport } = await import('../torqva/shared/twin3d/viewport.jsx');
const { simTwin, SimTwinPage } = await import('../torqva/simulation/twin.jsx');
const { physTwin, PhysTwinPage } = await import('../torqva/physical/twin.jsx');
const { twinItems } = await import('../torqva/shared/twin.jsx');

const now = Date.now() / 1000;
const W = { t: 120, rpm: 1500, duty: 34, voltage: 23.6, current: 1.25, housing: 31.4, vib_rms: 0.07, valid: true };
const STATUS = { mode: 'SIMULATION', t: 120, scenario: { fault: 'imbalance', severity: 0.6, clears_below_rpm: null, seed: 7, inject_after_s: 60 },
  device: { estop: false, estop_reason: '', setpoint_rpm: 1500 }, incident: null, pending_approval: null, last_window: W, models: { c2_label: 'x' }, closed_incidents: 0 };
const D = { status: STATUS, telemetry: { samples: [] } };
const val = (v, extra = {}) => ({ value: v, valid: v !== null, stale: false, origin: 'device_measurement', received_unix: now, ...extra });
const CONNECTED = { connection: 'CONNECTED', handshake: true, origin: 'physical_device', telemetry_fresh: true, last_rx_unix: now, safety_state: 'OK', drive: 'RUNNING', control_blockers: [],
  values: { rpm: val(1210), current: val(0.8), voltage: val(23.9), power: val(19.1), housing: val(29.5), duty: val(30, { origin: 'device_command_state' }), setpoint: val(1200, { origin: 'device_command_state' }),
    acceleration: { value: 1.0, x_g: 0, y_g: 0, z_g: 1, valid: true, stale: false, origin: 'device_measurement', received_unix: now } }, analysis: { layers: {} } };
const DISCONNECTED = { connection: 'DISCONNECTED', handshake: false, origin: 'none', telemetry_fresh: false, values: {}, control_blockers: [], analysis: { layers: {} } };

beforeEach(() => { engines.length = 0; globalThis.__failEngine = false; vi.unstubAllGlobals(); });

describe('component metadata', () => {
  it('every part either mapping produces has stable 3D metadata, and the mechanical parts carry no sensor', () => {
    const ids = new Set([...simTwin(D).parts, ...physTwin(CONNECTED).parts].map((p) => p.id));
    for (const id of ids) {
      const c = COMPONENT[id];
      expect(c, id).toBeTruthy();
      expect(c.anchor).toHaveLength(3); expect(c.normal).toHaveLength(3);
      expect(EXPLODE[c.node], id).toBeTruthy();
    }
    for (const id of STRUCTURE_IDS) expect(ids.has(id)).toBe(false);
    expect(new Set(COMPONENTS.map((c) => c.id)).size).toBe(COMPONENTS.length);
  });

  it('a marker follows its part in the exploded view', () => {
    expect(anchorAt('hall', 0)).toEqual(COMPONENT.hall.anchor);
    expect(anchorAt('hall', 1)[0]).toBeCloseTo(COMPONENT.hall.anchor[0] + EXPLODE.hall[0], 9);
    expect(anchorAt('nope')).toBeNull();
  });
});

describe('presentation-only shaft motion', () => {
  it('never turns for a missing, invalid, zero or negative speed', () => {
    for (const rpm of [null, undefined, NaN, Infinity, 0, -100, '1500']) expect(advanceAngle(1, rpm, 0.05)).toBe(1 % (2 * Math.PI));
  });

  it('is driven by elapsed time, not frame count, at 1/SPIN_SCALE of the reported speed', () => {
    let a60 = 0; for (let i = 0; i < 60; i++) a60 = advanceAngle(a60, 1500, 1 / 60);
    let a30 = 0; for (let i = 0; i < 30; i++) a30 = advanceAngle(a30, 1500, 1 / 30);
    expect(a60).toBeCloseTo(a30, 9);
    expect(a60).toBeCloseTo((spinRate(1500) * 1) % (2 * Math.PI), 9);
    expect(spinRate(1500)).toBeCloseTo((2 * Math.PI * 25) / SPIN_SCALE, 9);
    expect(advanceAngle(0, 1500, 5)).toBeCloseTo(spinRate(1500) * 0.1, 9);                  // a long pause (hidden tab) does not jump the shaft
  });
});

describe('procedural geometry', () => {
  it('revolved solids have outward normals and front-facing triangles that agree with them', () => {
    const g = revolve([[0, 0], [0, 5], [10, 5], [10, 0]], 24);
    const p = g.attributes.position, n = g.attributes.normal, idx = g.index.array;
    const centre = new Vector3(5, 0, 0);
    let bad = 0;
    for (let t = 0; t < idx.length; t += 3) {
      const [a, b, c] = [idx[t], idx[t + 1], idx[t + 2]].map((i) => new Vector3(p.getX(i), p.getY(i), p.getZ(i)));
      const face = new Vector3().subVectors(b, a).cross(new Vector3().subVectors(c, a));
      if (face.lengthSq() < 1e-12) continue;                                                // degenerate triangle at the axis
      const nn = new Vector3(n.getX(idx[t]), n.getY(idx[t]), n.getZ(idx[t]));
      const out = new Vector3().addVectors(a, b).add(c).divideScalar(3).sub(centre);
      if (face.dot(nn) <= 0 || nn.dot(out) <= 0) bad += 1;
    }
    expect(bad).toBe(0);
  });

  it('builds every component, gives each cut solid a section cap, and frees what it created', () => {
    const rig = buildRig({ clippingPlane: { isPlane: true } });
    const parts = new Set(rig.meshes.map((m) => m.userData.part));
    for (const c of COMPONENTS) expect(parts.has(c.id), c.id).toBe(true);
    const cut = rig.meshes.filter((m) => m.userData.cut);
    expect(cut.length).toBeGreaterThan(4);
    expect(rig.caps).toHaveLength(cut.length);
    for (const name of SPIN_NODES) expect(rig.nodes[name].children.length).toBeGreaterThan(0);
    expect(rig.meshes.filter((m) => SPIN_NODES.includes(m.userData.node)).every((m) => ['shaft', 'motor'].includes(m.userData.part))).toBe(true);
    expect(rig.meshes.length).toBeLessThan(90);                                               // merged per node, part and material
    const spy = vi.spyOn(rig.meshes[0].geometry, 'dispose');
    rig.dispose();
    expect(spy).toHaveBeenCalled();
  });
});

describe('callout layout', () => {
  const pts = [{ id: 'a', x: 100, y: 300 }, { id: 'b', x: 120, y: 305 }, { id: 'c', x: 140, y: 310 }, { id: 'd', x: 700, y: 50 }, { id: 'e', x: 650, y: 52 }];
  it('stacks cards in two columns without overlap, inside the viewport, on the side of their anchor', () => {
    const out = layoutCallouts(pts, { w: 800, h: 500 });
    expect(out).toHaveLength(5);
    for (const side of ['left', 'right']) {
      const col = out.filter((c) => c.side === side).sort((a, b) => a.y - b.y);
      for (let i = 1; i < col.length; i++) expect(col[i].y - col[i - 1].y).toBeGreaterThanOrEqual(48);
    }
    for (const c of out) { expect(c.y).toBeGreaterThanOrEqual(10); expect(c.y + 48).toBeLessThanOrEqual(490); }
    expect(out.find((c) => c.id === 'a').side).toBe('left');
    expect(out.find((c) => c.id === 'd').side).toBe('right');
  });
  it('shows nothing rather than overlapping cards when the viewport is too small', () => {
    expect(layoutCallouts(pts, { w: 300, h: 500 })).toEqual([]);
    expect(layoutCallouts(pts, { w: 800, h: 120 }).length).toBeLessThanOrEqual(4);
  });
});

describe('evidence-backed alerts and freshness', () => {
  it('physical: an invalid reading and an attributed trip name their part; an unknown or unconnected device names none', () => {
    const inv = physTwin({ ...CONNECTED, values: { ...CONNECTED.values, housing: { value: null, valid: false, stale: false, origin: 'device_measurement' } } });
    expect(inv.alerts).toEqual([expect.objectContaining({ part: 'temp', kind: 'observation', tone: 'crit' })]);
    const trip = physTwin({ ...CONNECTED, safety_state: 'EMERGENCY_STOP', trip_reason: 'OVER_CURRENT_INSTANT' });
    expect(trip.alerts).toEqual([expect.objectContaining({ part: 'ina', kind: 'trip' })]);
    expect(physTwin({ ...CONNECTED, safety_state: 'EMERGENCY_STOP', trip_reason: 'EXTERNAL_ESTOP' }).alerts).toEqual([]);   // names no drawn part
    expect(physTwin(trip.alerts && { ...CONNECTED, safety_state: 'EMERGENCY_STOP', trip_reason: 'TEMP_STOP' }, { unreachable: true }).alerts).toEqual([]);
    expect(physTwin(DISCONNECTED).alerts).toEqual([]);
    expect(physTwin(CONNECTED).freshness).toBe('live');
    expect(physTwin({ ...CONNECTED, telemetry_fresh: false }).freshness).toBe('stale');
    expect(physTwin(CONNECTED, { unreachable: true }).freshness).toBe('stale');
    expect(physTwin(DISCONNECTED).freshness).toBe('none');
  });

  it('simulation: the injected fault is ground truth only after injection, a simulated trip names its sensor, and an invalid window names no part', () => {
    expect(simTwin(D).alerts).toEqual([expect.objectContaining({ part: 'shaft', kind: 'truth', tone: 'sim' })]);
    expect(simTwin({ ...D, status: { ...STATUS, t: 30 } }).alerts).toEqual([]);
    expect(simTwin(D, { stale: true }).alerts).toEqual([]);
    const est = simTwin({ ...D, status: { ...STATUS, scenario: { ...STATUS.scenario, fault: null }, device: { estop: true, estop_reason: 'TEMP_STOP', setpoint_rpm: 0 } } });
    expect(est.alerts).toEqual([expect.objectContaining({ part: 'temp', kind: 'trip' })]);
    expect(simTwin({ ...D, status: { ...STATUS, scenario: { ...STATUS.scenario, fault: null }, last_window: { ...W, valid: false } } }).alerts).toEqual([]);
    expect(simTwin(D).freshness).toBe('live');
    expect(simTwin(D, { stale: true }).freshness).toBe('stale');
    expect(simTwin({ status: { mode: 'SIMULATION', simulation: null } }).freshness).toBe('none');
  });

  it('mechanical parts never show a reading and a missing sensor value stays UNAVAILABLE', () => {
    const items = twinItems(physTwin(DISCONNECTED));
    for (const id of STRUCTURE_IDS) {
      const it = items.find((i) => i.id === id);
      expect(it).toMatchObject({ sensor: false, tone: 'none' });
      expect(it.prov).toBeFalsy();
      expect(it.value).not.toMatch(/\d/);                                                        // a kind label, never a number
    }
    expect(items.find((i) => i.id === 'hall')).toMatchObject({ value: 'UNAVAILABLE', prov: null });
  });
});

describe('3D viewport (engine mocked)', () => {
  const items = twinItems(simTwin(D, { running: true }));
  const base = { items, motion: { spinning: true, rpm: 1500 }, freshness: 'live', source: 'SIMULATION', alerts: [] };

  it('creates one engine, forwards selection, motion and options, and disposes it on unmount', () => {
    const onSelect = vi.fn();
    const { rerender, unmount } = render(<TwinViewport {...base} selected={null} onSelect={onSelect} />);
    expect(engines).toHaveLength(1);
    const e = engines[0];
    expect(e.calls).toContainEqual(['setMotion', true, 1500]);
    rerender(<TwinViewport {...base} selected="hall" onSelect={onSelect} motion={{ spinning: false, rpm: null }} />);
    expect(e.calls).toContainEqual(['setSelection', 'hall']);
    expect(e.calls).toContainEqual(['setMotion', false, null]);
    fireEvent.click(screen.getByTestId('t3-explode'));
    fireEvent.click(screen.getByTestId('t3-cutaway'));
    fireEvent.click(screen.getByTestId('t3-ortho'));
    const last = e.calls.filter(([n]) => n === 'setOptions').pop()[1];
    expect(last).toMatchObject({ explode: true, cutaway: true, ortho: true });
    fireEvent.click(screen.getByTestId('t3-view-top'));
    expect(e.calls).toContainEqual(['view', 'top']);
    fireEvent.click(screen.getByTestId('t3-fit'));
    expect(e.calls.some(([n]) => n === 'fit')).toBe(true);
    fireEvent.click(screen.getByTestId('t3-focus'));
    expect(e.calls).toContainEqual(['focus', 'hall']);
    unmount();
    expect(e.disposed).toBe(true);
  });

  it('picking a part in the scene selects it, picking it again clears it; isolate and focus need a selection', () => {
    const onSelect = vi.fn();
    render(<TwinViewport {...base} selected={null} onSelect={onSelect} />);
    act(() => engines[0].opts.onPick('ina', { double: false }));
    expect(onSelect).toHaveBeenLastCalledWith('ina');
    expect(screen.getByTestId('t3-isolate')).toBeDisabled();
    expect(screen.getByTestId('t3-focus')).toBeDisabled();
    fireEvent.click(screen.getByTestId('twin-hot-temp'));
    expect(onSelect).toHaveBeenLastCalledWith('temp');
  });

  it('keyboard camera control on the viewport, and Ctrl-less scrolling is left to the page', () => {
    render(<TwinViewport {...base} selected={null} onSelect={() => {}} />);
    const host = screen.getByRole('group', { name: /Interactive 3D model/ });
    fireEvent.keyDown(host, { key: 'ArrowLeft' }); fireEvent.keyDown(host, { key: 'ArrowUp', shiftKey: true }); fireEvent.keyDown(host, { key: '+' }); fireEvent.keyDown(host, { key: '3' });
    const c = engines[0].calls;
    expect(c).toContainEqual(['nudge', { orbit: [-8, 0] }]);
    expect(c).toContainEqual(['nudge', { pan: [0, 0.12] }]);
    expect(c).toContainEqual(['nudge', { zoom: 1.15 }]);
    expect(c).toContainEqual(['view', 'side']);
    const wheel = new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true });
    act(() => { host.dispatchEvent(wheel); });
    expect(wheel.defaultPrevented).toBe(false);
    expect(screen.getByText(/Hold Ctrl/)).toBeInTheDocument();
  });

  it('shows the evidence tool only with an alert and the stale banner when values are not live', () => {
    const { rerender } = render(<TwinViewport {...base} selected={null} onSelect={() => {}} />);
    expect(screen.queryByTestId('t3-evidence')).toBeNull();
    expect(screen.queryByTestId('t3-banner')).toBeNull();
    const onSelect = vi.fn();
    rerender(<TwinViewport {...base} freshness="stale" alerts={[{ part: 'shaft', tone: 'sim', kind: 'truth', label: 'x' }]} selected={null} onSelect={onSelect} />);
    expect(screen.getByTestId('t3-banner')).toHaveTextContent(/stale/i);
    fireEvent.click(screen.getByTestId('t3-evidence'));
    expect(onSelect).toHaveBeenCalledWith('shaft');
    expect(engines[0].calls).toContainEqual(['focus', 'shaft']);
  });

  it('after a lost graphics context comes back, a fresh engine replaces the old one and keeps its camera and state', () => {
    render(<TwinViewport {...base} selected="hall" onSelect={() => {}} />);
    fireEvent.click(screen.getByTestId('t3-explode'));
    act(() => engines[0].opts.onStatus('lost'));
    expect(screen.getByRole('alert')).toHaveTextContent(/graphics context was lost/);
    act(() => engines[0].opts.onStatus('restored'));
    expect(engines).toHaveLength(2);
    expect(engines[0].disposed).toBe(true);
    expect(engines[1].opts.restore).toEqual({ snapshot: 0 });
    expect(engines[1].calls).toContainEqual(['setSelection', 'hall']);
    expect(engines[1].calls.find(([n]) => n === 'setOptions')[1]).toMatchObject({ explode: true });
    expect(engines[1].calls.some(([n]) => n === 'settle')).toBe(true);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a renderer that cannot start reports it so the page can fall back', () => {
    globalThis.__failEngine = true;
    const onFallback = vi.fn();
    render(<TwinViewport {...base} selected={null} onSelect={() => {}} onFallback={onFallback} />);
    expect(onFallback).toHaveBeenCalledWith(expect.stringMatching(/could not start/));
  });
});

describe('twin page without WebGL 2 (jsdom)', () => {
  it('falls back to the 2D drawing with a notice, and mechanical parts open an identification-only panel', () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ points: [] }) })));
    render(<PhysTwinPage stream={{ snap: DISCONNECTED, unreachable: false }} go={() => {}} />);
    expect(screen.getByTestId('twin-notice')).toHaveTextContent(/WebGL 2/);
    expect(screen.getByTestId('twin-model').tagName.toLowerCase()).toBe('svg');
    fireEvent.click(screen.getByTestId('twin-part-motor'));
    const d = screen.getByTestId('twin-detail');
    expect(within(d).getByText('DC motor')).toBeInTheDocument();
    expect(d).toHaveTextContent(/no reading for this part/);
    expect(within(d).getByTestId('twin-ident')).toHaveTextContent('motor');
    fireEvent.click(within(d).getByRole('button', { name: /Speed sensor/ }));
    expect(screen.getByTestId('twin-reading-rpm')).toHaveTextContent('UNAVAILABLE');
  });

  it('the evidence for a part is shown in its panel, labelled by kind', () => {
    render(<SimTwinPage d={D} running stale={false} go={() => {}} />);
    fireEvent.click(screen.getByTestId('twin-part-shaft'));
    expect(screen.getByTestId('twin-evidence')).toHaveTextContent(/Scenario ground truth/);
    expect(screen.getByTestId('twin-evidence')).toHaveTextContent(/did not detect or diagnose/);
  });
});

describe('source guard', () => {
  it('the 3D modules fetch nothing, send nothing and import no mode-specific data module', () => {
    const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'torqva', 'shared');
    for (const f of ['twinParts.js', 'twin3d/assembly.js', 'twin3d/engine.js', 'twin3d/overlay.js', 'twin3d/support.js', 'twin3d/viewport.jsx']) {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      expect(src, f).not.toMatch(/\bfetch\(|WebSocket|XMLHttpRequest|sendBeacon|EventSource/);
      expect(src, f).not.toMatch(/from ['"][./]*(api\.js|\.\.\/api\.js|.*physical\/|.*simulation\/)/);
      expect(src, f).not.toMatch(/api\.\w+\(/);
    }
  });
});
