// The 3D twin's render scheduler, run without a GPU: the real engine, scene and OrbitControls with a stand-in WebGLRenderer and a hand-driven
// requestAnimationFrame queue. Guards the regression where camera damping queued a second frame from inside a frame, so the number of render
// loops doubled on every damped frame (hundreds of renders per display refresh after one orbit while the shaft was turning).
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

vi.mock('three', async (importOriginal) => {
  const T = await importOriginal();
  class FakeRenderer {
    constructor({ canvas }) {
      this.domElement = canvas; this.renders = 0; this.ratio = 1;
      this.shadowMap = { enabled: false, autoUpdate: true, needsUpdate: false, type: 0 };
      this.debug = {}; this.info = { render: { calls: 0, triangles: 0 }, memory: { geometries: 0, textures: 0 }, programs: [] };
      this.renderLists = { dispose() {} };
      this.info.reset = () => {};
    }
    getContext() { return { isContextLost: () => false }; }
    setRenderTarget() {}
    setPixelRatio(r) { this.ratio = r; } getPixelRatio() { return this.ratio; } setSize() {} setClearColor() {}
    render() { this.renders += 1; }
    dispose() { this.disposed = true; } forceContextLoss() {}
  }
  class FakePMREM { fromScene() { return { texture: { dispose() {} } }; } dispose() {} }
  return { ...T, WebGLRenderer: FakeRenderer, PMREMGenerator: FakePMREM };
});

const { TwinEngine } = await import('../torqva/shared/twin3d/engine.js');
const { QualityGovernor } = await import('../torqva/shared/twin3d/quality.js');
const { spinRate } = await import('../torqva/shared/twinParts.js');

let queue, now;
const tick = () => { const q = queue; queue = []; now += 16.7; for (const f of q) f(now); return q.length; };
const settle = (max = 400) => { let n = 0; while (queue.length && n < max) { tick(); n += 1; } return n; };
const THEME = { dark: true, accent: '#7DA3FF', crit: '#FF6B6B', stop: '#FF6B6B', warn: '#F2B44F', info: '#7DA3FF', sim: '#A78BFA', grid: '#222', gridMajor: '#333', edge: '#ccc' };

function make(extra = {}) {
  const host = document.createElement('div'); document.body.appendChild(host);
  const cb = { onProject: vi.fn(), onCamera: vi.fn(), onStatus: vi.fn(), ...extra };
  const e = new TwinEngine({ host, ...cb });
  e.setTheme(THEME);
  return { e, cb, host };
}

beforeEach(() => {
  queue = []; now = 1000;
  vi.stubGlobal('requestAnimationFrame', (f) => { queue.push(f); return queue.length; });
  vi.stubGlobal('cancelAnimationFrame', () => { queue = []; });
});
afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = ''; });

describe('render scheduler', () => {
  it('goes idle after the first frames and wakes for a single frame on change', () => {
    const { e } = make();
    settle();
    expect(queue).toHaveLength(0);
    const before = e.renderer.renders;
    e.invalidate(); e.invalidate(); e.requestProjection(); e.setSelection('hall');
    expect(queue).toHaveLength(1);                                              // many requests, one frame
    settle();
    expect(e.renderer.renders - before).toBeLessThanOrEqual(2);
    e.dispose();
  });

  it('camera damping keeps exactly one frame queued per refresh until it settles, then stops', () => {
    const { e } = make();
    settle();
    const real = e.controls.update.bind(e.controls);
    let damping = 12;
    e.controls.update = () => { if (damping > 0) { damping -= 1; e.controls.dispatchEvent({ type: 'change' }); return true; } return real(); };
    e.invalidate();
    let maxQueued = 0, ticks = 0;
    while (queue.length && ticks < 200) { tick(); ticks += 1; maxQueued = Math.max(maxQueued, queue.length); }
    expect(maxQueued).toBe(1);
    expect(queue).toHaveLength(0);
    expect(ticks).toBeGreaterThanOrEqual(12);
    e.dispose();
  });

  it('a turning shaft renders once per refresh, survives new speed values without extra loops, and stops when motion stops', () => {
    const { e, cb } = make();
    settle();
    cb.onProject.mockClear();
    e.setMotion(true, 1500);
    const r0 = e.renderer.renders;
    for (let i = 0; i < 30; i++) { if (i % 10 === 0) e.setMotion(true, 1500 + i); expect(tick()).toBe(1); }
    expect(e.renderer.renders - r0).toBe(30);
    expect(e.rig.nodes.rotor.rotation.x).not.toBe(0);
    expect(cb.onProject.mock.calls.length).toBeLessThanOrEqual(1);                // the camera did not move: no marker re-projection
    e.setMotion(false, null);
    settle();
    expect(queue).toHaveLength(0);
    e.dispose();
  });

  it('nothing is scheduled while the page is hidden or after dispose', () => {
    const { e } = make();
    settle();
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    e.setMotion(true, 1500); e.invalidate();
    expect(queue).toHaveLength(0);
    hidden.mockRestore();
    e.invalidate();
    expect(queue).toHaveLength(1);
    e.dispose();
    expect(queue).toHaveLength(0);
    e.invalidate();
    expect(queue).toHaveLength(0);
  });

  it('after a long pause the shaft advances at most one clamped step (0.1 s of rotation), not the whole gap', () => {
    const { e } = make();
    settle();
    e.setMotion(true, 1500); tick(); tick();
    const a = e.rig.nodes.rotor.rotation.x;
    now += 60000;                                                               // e.g. a background tab
    tick();
    expect(Math.abs(e.rig.nodes.rotor.rotation.x - a)).toBeLessThanOrEqual(spinRate(1500) * 0.1 + 1e-9);
    e.dispose();
  });
});

describe('renderer reuse', () => {
  it('one WebGL renderer is lent to successive engines instead of creating one per mount, and a second is made only while the first is in use', () => {
    const a = make().e; const r1 = a.renderer; a.dispose();
    const b = make().e; expect(b.renderer).toBe(r1);                             // remount: same renderer, canvas re-attached
    expect(b.host.contains(b.canvas)).toBe(true);
    const c = make().e; expect(c.renderer).not.toBe(r1);                         // two viewports at once: a separate renderer
    c.dispose(); expect(c.renderer.disposed).toBe(true);
    b.dispose(); expect(r1.disposed).toBeFalsy();                                // the shared one is kept, its scene freed
    expect(b.canvas.isConnected).toBe(false);
  });
});

describe('adaptive resolution', () => {
  it('steps the pixel ratio down only after sustained slow frames, never below 1, and restores it when idle', () => {
    const q = new QualityGovernor(2);
    for (let i = 0; i < 200; i++) q.frame(16.7);
    expect(q.ratio).toBe(2);                                                    // 60 fps: full resolution
    for (let i = 0; i < 30; i++) q.frame(40);
    expect(q.ratio).toBe(2);                                                    // a short slow burst is not enough
    for (let i = 0; i < 100; i++) q.frame(40);
    expect(q.ratio).toBeLessThan(2);
    for (let i = 0; i < 1000; i++) q.frame(60);
    expect(q.ratio).toBe(1);
    expect(q.idle()).toBe(true);
    expect(q.ratio).toBe(2);
    expect(q.idle()).toBe(false);
  });
  it('ignores pauses and the first frame of a run', () => {
    const q = new QualityGovernor(2);
    for (let i = 0; i < 500; i++) q.frame(i % 2 ? 5000 : 0);
    expect(q.ratio).toBe(2);
  });
});

describe('camera moves do not fight', () => {
  it('a camera move asked for while the parts are exploding is not overridden when the explode animation ends', () => {
    const { e } = make();
    settle();
    e.setOptions({ explode: true });
    tick(); tick();
    e.view('side');                                                                 // an explicit view while the parts are still moving
    settle();
    expect(e.cameraInfo().az).toBe(90);
    e.dispose();
  });
});

describe('off-screen viewport', () => {
  it('stops the shaft animation while off screen but still renders changes, tweens and explode to completion', () => {
    const { e } = make();
    settle();
    e.visible = false;                                                              // as reported by the IntersectionObserver
    e.setMotion(true, 1500);
    settle();
    expect(queue).toHaveLength(0);                                                  // no open-ended loop off screen
    e.setOptions({ explode: true });
    e.view('side');
    expect(settle()).toBeGreaterThan(5);
    expect(e.state.explode).toBe(1);
    expect(e.cameraInfo().az).toBe(90);
    expect(queue).toHaveLength(0);
    e.visible = true; e.invalidate();
    expect(tick()).toBe(1); expect(queue).toHaveLength(1);                          // back on screen: the shaft turns again
    e.dispose();
  });
});
