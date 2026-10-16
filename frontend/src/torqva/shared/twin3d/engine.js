// Rendering engine of the 3D Digital Twin (Three.js, no React). It owns one WebGLRenderer, the scene, the camera controller and the render loop.
// It is told what to show (selection, part tones, evidence alerts, reported motion, view options) and never decides any of it: no telemetry is read,
// derived or invented here, and nothing is sent anywhere. The shaft turns only while setMotion() says the source reports a valid, current speed.
//
// Rendering is on demand: a frame is drawn only when something changed (camera, selection, explode/cutaway, theme) or while the shaft animation
// runs. The loop stops when idle, when the canvas is off screen and when the page is hidden. dispose() frees every GPU resource it created.
import {
  ACESFilmicToneMapping, Box3, Color, DirectionalLight, EdgesGeometry, GridHelper, HemisphereLight, LineBasicMaterial, LineSegments, Mesh,
  MOUSE, OrthographicCamera, PCFShadowMap, PerspectiveCamera, Plane, PlaneGeometry, PMREMGenerator, Raycaster, Scene, ShadowMaterial,
  Spherical, SRGBColorSpace, Vector2, Vector3, WebGLRenderer, setConsoleFunction,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { buildRig } from './assembly.js';
import { AXIS, COMPONENT, EXPLODE, advanceAngle } from '../twinParts.js';

const D2R = Math.PI / 180;
export const TARGET = new Vector3(-12, 34, -8);           // centre of the rig the camera orbits by default
/** View presets: azimuth from +z towards +x and polar angle from +y (degrees). The front of the rig is its electronics side (-z). */
export const PRESETS = {
  iso: { az: 138, polar: 57, label: 'Isometric' },
  front: { az: 180, polar: 90, label: 'Front' },
  side: { az: 90, polar: 90, label: 'Side (shaft end)' },
  top: { az: 180, polar: 0.05, label: 'Top' },
};
const LIMITS = { minDistance: 60, maxDistance: 1500, minZoom: 0.35, maxZoom: 8 };
const PAN_BOX = new Box3(new Vector3(-190, -20, -140), new Vector3(150, 140, 130));   // the orbit target never leaves the rig
const ORTHO_H = 160;                                                                   // half-height of the orthographic frustum at zoom 1

// Three.js logs the compiler notes some drivers (ANGLE on Direct3D) attach to programs that linked successfully. Only that informational message is
// dropped; everything else, including real shader errors, goes to the console unchanged.
setConsoleFunction((level, message, ...params) => {
  if (level === 'warn' && String(message).startsWith('THREE.WebGLProgram: Program Info Log')) return;
  (console[level] || console.log)(message, ...params);                       // eslint-disable-line no-console
});

const reducedMotion = () => { try { return !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches; } catch { return false; } };
const ease = (p) => 1 - (1 - p) ** 3;

export class TwinEngine {
  /**
   * host: the element the engine's own canvas fills (the canvas is created here and removed on dispose, so a remount never reuses a lost context);
   * restore: a cameraState() of a previous engine to continue from (after a lost graphics context);
   * cb: { onPick(id, {double}), onHover(id, x, y), onProject(points), onStatus('ready' | 'lost' | 'restored'), onCamera(info) }
   */
  constructor({ host, restore = null, ...cb }) {
    const canvas = document.createElement('canvas');
    canvas.className = 'tq-t3-canvas';
    host.prepend(canvas);
    this.canvas = canvas; this.host = host; this.cb = cb;
    this.reduced = reducedMotion();
    try {
      this.renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
    } catch (e) { canvas.remove(); throw e; }
    const r = this.renderer;
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    r.outputColorSpace = SRGBColorSpace;
    r.toneMapping = ACESFilmicToneMapping; r.toneMappingExposure = 1.0;
    r.shadowMap.enabled = true; r.shadowMap.type = PCFShadowMap; r.shadowMap.autoUpdate = false;
    r.localClippingEnabled = true;
    r.setClearColor(0x000000, 0);

    this.scene = new Scene();
    this.pmrem = new PMREMGenerator(r);
    this.envScene = new RoomEnvironment();
    this.env = this.pmrem.fromScene(this.envScene, 0.04).texture;
    this.scene.environment = this.env;
    this.scene.environmentIntensity = 0.85;

    const hemi = new HemisphereLight(0xdfe7f2, 0x2a2f36, 0.35);
    const key = new DirectionalLight(0xffffff, 2.3);
    key.position.set(-150, 340, -270); key.target.position.copy(TARGET);
    key.castShadow = true;
    Object.assign(key.shadow.camera, { left: -230, right: 230, top: 200, bottom: -200, near: 50, far: 900 });
    key.shadow.mapSize.set(2048, 2048); key.shadow.bias = -0.0004; key.shadow.normalBias = 0.6; key.shadow.radius = 4;
    const rim = new DirectionalLight(0xcfdcff, 0.75); rim.position.set(240, 170, 330);
    this.scene.add(hemi, key, key.target, rim);
    this.lights = [hemi, key, rim];

    this.clip = new Plane(new Vector3(0, -1, 0), 1e6);           // effectively off until the cutaway is enabled
    this.rig = buildRig({ clippingPlane: this.clip });
    this.scene.add(this.rig.root);
    this.byPart = {};
    for (const m of this.rig.meshes) (this.byPart[m.userData.part] ||= []).push(m);

    this.shadowPlane = new Mesh(new PlaneGeometry(1400, 1400), new ShadowMaterial({ opacity: 0.22 }));
    this.shadowPlane.rotation.x = -Math.PI / 2; this.shadowPlane.position.y = -16.05; this.shadowPlane.receiveShadow = true;
    this.gridMinor = new GridHelper(900, 90); this.gridMajor = new GridHelper(900, 18);
    for (const [g, o] of [[this.gridMinor, 0.18], [this.gridMajor, 0.34]]) { g.position.y = -16; g.material.transparent = true; g.material.opacity = o; g.material.depthWrite = false; }
    this.scene.add(this.shadowPlane, this.gridMinor, this.gridMajor);

    this.persp = new PerspectiveCamera(32, 1, 2, 8000);
    this.ortho = new OrthographicCamera(-ORTHO_H, ORTHO_H, ORTHO_H, -ORTHO_H, -4000, 8000);
    this.camera = this.persp;
    this.controls = new OrbitControls(this.persp, canvas);
    Object.assign(this.controls, { enableDamping: true, dampingFactor: 0.12, rotateSpeed: 0.8, panSpeed: 0.9, zoomSpeed: 0.9, screenSpacePanning: true,
      maxPolarAngle: Math.PI / 2, ...LIMITS });
    this.controls.mouseButtons = { LEFT: MOUSE.ROTATE, MIDDLE: MOUSE.DOLLY, RIGHT: MOUSE.PAN };
    this.controls.addEventListener('change', () => { this.clampTarget(); this.invalidate(); });
    this.controls.addEventListener('start', () => { this.tween = null; this.userMoved = true; });

    this.state = { selected: null, hover: null, tones: {}, alerts: {}, spinning: false, rpm: null, explode: 0, explodeTarget: 0,
      isolate: false, cutaway: false, edges: false, ortho: false, theme: null };
    this.angle = 0; this.frames = 0; this.running = false; this.dirty = true; this.visible = true; this.lost = false;
    this.ray = new Raycaster(); this.ndc = new Vector2(); this.pointer = null; this.down = null;
    this.edgeCache = new Map();
    this._v = new Vector3(); this._n = new Vector3(); this._c = new Vector3();

    this.bind();
    this.resize();
    this.view('iso', { instant: true });
    if (restore) this.restoreCamera(restore);
    r.shadowMap.needsUpdate = true;
    this.cb.onStatus?.('ready');
  }

  /** Camera, projection and framing state, so a replacement engine can continue where this one stopped. */
  cameraState() {
    return { position: this.camera.position.toArray(), target: this.controls.target.toArray(), zoom: this.camera.zoom, ortho: this.camera === this.ortho, preset: this.preset, userMoved: !!this.userMoved };
  }
  restoreCamera(s) {
    if (s.ortho) { this.state.ortho = true; this.switchCamera(true); }
    this.camera.position.fromArray(s.position); this.controls.target.fromArray(s.target);
    this.camera.zoom = s.zoom; this.camera.updateProjectionMatrix(); this.camera.lookAt(this.controls.target);
    this.tween = null; this.controls.update();
    this.preset = s.preset; this.userMoved = s.userMoved;
  }
  /** Jump running transitions (explode) to their end state. */
  settle() { const s = this.state; if (s.explode !== s.explodeTarget) this.applyExplode(s.explodeTarget); this.invalidate(); }

  // ---------------------------------------------------------------- lifecycle

  bind() {
    const c = this.canvas;
    // A lost context invalidates every GPU object (buffers, programs, the reflection map). On restore the owner replaces this engine with a fresh one
    // on a new canvas instead of patching the old objects back in.
    this.onLost = (e) => { e.preventDefault(); this.lost = true; this.wasLost = true; this.running = false; cancelAnimationFrame(this.raf); this.cb.onStatus?.('lost'); };
    this.onRestored = () => { this.cb.onStatus?.('restored'); };
    this.onMove = (e) => { const b = c.getBoundingClientRect(); this.pointer = { x: e.clientX - b.left, y: e.clientY - b.top }; this.pickDirty = true; this.invalidate(); };
    this.onLeave = () => { this.pointer = null; this.setHover(null); };
    this.onDown = (e) => { this.down = { x: e.clientX, y: e.clientY, t: performance.now() }; };
    this.onUp = (e) => {
      const d = this.down; this.down = null;
      if (!d || e.button !== 0 || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5 || performance.now() - d.t > 600) return;
      const id = this.pickAt(e.clientX, e.clientY);
      if (id) this.cb.onPick?.(id, { double: false });
    };
    this.onDbl = (e) => { const id = this.pickAt(e.clientX, e.clientY); if (id) { this.cb.onPick?.(id, { double: true }); this.focus(id); } };
    c.addEventListener('webglcontextlost', this.onLost);
    c.addEventListener('webglcontextrestored', this.onRestored);
    c.addEventListener('pointermove', this.onMove);
    c.addEventListener('pointerleave', this.onLeave);
    c.addEventListener('pointerdown', this.onDown);
    c.addEventListener('pointerup', this.onUp);
    c.addEventListener('dblclick', this.onDbl);
    this.ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => this.resize()) : null;
    this.ro?.observe(this.host);
    this.io = typeof IntersectionObserver !== 'undefined' ? new IntersectionObserver(([en]) => { this.visible = en.isIntersecting; if (this.visible) this.invalidate(); }) : null;
    this.io?.observe(this.host);
    this.onVis = () => { if (!document.hidden) { this.last = null; this.invalidate(); } };
    document.addEventListener('visibilitychange', this.onVis);
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    const c = this.canvas;
    c.removeEventListener('webglcontextlost', this.onLost); c.removeEventListener('webglcontextrestored', this.onRestored);
    c.removeEventListener('pointermove', this.onMove); c.removeEventListener('pointerleave', this.onLeave);
    c.removeEventListener('pointerdown', this.onDown); c.removeEventListener('pointerup', this.onUp); c.removeEventListener('dblclick', this.onDbl);
    document.removeEventListener('visibilitychange', this.onVis);
    this.ro?.disconnect(); this.io?.disconnect();
    this.controls.dispose();
    if (this.wasLost) {                                   // its GPU objects died with the old context: deleting them would only raise WebGL errors
      try { this.renderer.forceContextLoss(); } catch { /* already lost */ }
      c.remove();
      return;
    }
    this.rig.dispose();
    for (const l of this.edgeCache.values()) { l.geometry.dispose(); l.material.dispose(); }
    this.shadowPlane.geometry.dispose(); this.shadowPlane.material.dispose();
    for (const g of [this.gridMinor, this.gridMajor]) g.dispose();
    this.env.dispose(); this.pmrem.dispose();
    this.envScene.traverse((o) => { o.geometry?.dispose?.(); o.material?.dispose?.(); });
    for (const l of this.lights) l.shadow?.map?.dispose();
    this.renderer.renderLists.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    c.remove();
  }

  resize() {
    const w = Math.max(1, this.host.clientWidth), h = Math.max(1, this.host.clientHeight);
    if (w === this.w && h === this.h) return;
    this.w = w; this.h = h;
    this.renderer.setSize(w, h, false);
    this.persp.aspect = w / h; this.persp.updateProjectionMatrix();
    const a = w / h;
    Object.assign(this.ortho, { left: -ORTHO_H * a, right: ORTHO_H * a, top: ORTHO_H, bottom: -ORTHO_H }); this.ortho.updateProjectionMatrix();
    if (this.preset && !this.userMoved) this.view(this.preset, { instant: true });         // keep the preset framed until the user takes over
    this.invalidate();
  }

  invalidate() {
    this.dirty = true;
    if (this.running || this.disposed || this.lost) return;
    this.running = true; this.last = null;
    this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  // ---------------------------------------------------------------- state from the React layer

  setSelection(id) { if (this.state.selected === id) return; this.state.selected = id; this.applyHighlight(); if (this.state.isolate) this.applyIsolation(true); this.invalidate(); }
  setStates(tones, alerts) { this.state.tones = tones || {}; this.state.alerts = alerts || {}; this.applyHighlight(); this.invalidate(); }
  setMotion(spinning, rpm) { this.state.spinning = !!spinning; this.state.rpm = spinning ? rpm : null; this.invalidate(); }
  setTheme(theme) {
    this.state.theme = theme;
    const minor = new Color(theme.grid), major = new Color(theme.gridMajor);
    this.gridMinor.material.color.copy(minor); this.gridMajor.material.color.copy(major);
    this.gridMinor.material.vertexColors = false; this.gridMajor.material.vertexColors = false;
    this.gridMinor.material.needsUpdate = true; this.gridMajor.material.needsUpdate = true;
    this.shadowPlane.material.opacity = theme.dark ? 0.42 : 0.2;
    for (const l of this.edgeCache.values()) l.material.color.set(l.userData.sel ? theme.accent : theme.edge);
    this.applyHighlight(); this.invalidate();
  }
  setOptions({ explode, isolate, cutaway, edges, ortho, inset }) {
    const s = this.state;
    if (inset !== undefined && inset !== this.inset) { this.inset = inset; if (!this.userMoved) this.view(this.preset || 'iso', { instant: this.frames === 0 }); }
    if (explode !== undefined && (explode ? 1 : 0) !== s.explodeTarget) { s.explodeTarget = explode ? 1 : 0; if (this.reduced) this.applyExplode(s.explodeTarget); }
    if (isolate !== undefined && isolate !== s.isolate) { s.isolate = isolate; this.applyIsolation(true); }
    if (cutaway !== undefined && cutaway !== s.cutaway) {
      s.cutaway = cutaway;
      for (const c of this.rig.caps) c.visible = cutaway && (!s.isolate || !s.selected || c.userData.part === s.selected);
      // the section is about the motor: look at it from the front quarter, where the bracket does not hide the cut
      if (cutaway) { if (!s.isolate) { const az = 208, polar = 66; this.goTo({ az, polar, ...this.frameBox(this.fitBox('motor'), az, polar) }); } }
      else this.clip.set(new Vector3(0, -1, 0), 1e6);
    }
    if (edges !== undefined && edges !== s.edges) { s.edges = edges; this.applyEdges(); }
    if (ortho !== undefined && ortho !== s.ortho) { s.ortho = ortho; this.switchCamera(ortho); }
    this.invalidate();
  }

  // ---------------------------------------------------------------- camera

  switchCamera(ortho) {
    const from = this.camera, to = ortho ? this.ortho : this.persp;
    if (from === to) return;
    const dist = from === this.persp ? from.position.distanceTo(this.controls.target) : null;
    to.position.copy(from.position); to.quaternion.copy(from.quaternion); to.up.copy(from.up);
    if (ortho) { to.zoom = Math.min(LIMITS.maxZoom, Math.max(LIMITS.minZoom, ORTHO_H / (dist * Math.tan((this.persp.fov * D2R) / 2)))); }
    else {                                                        // keep the apparent size when going back to perspective
      const d = ORTHO_H / from.zoom / Math.tan((this.persp.fov * D2R) / 2);
      const dir = this._v.copy(from.position).sub(this.controls.target).normalize();
      to.position.copy(this.controls.target).addScaledVector(dir, Math.min(LIMITS.maxDistance, Math.max(LIMITS.minDistance, d)));
    }
    to.updateProjectionMatrix();
    this.camera = to; this.controls.object = to; this.controls.update();
  }

  /**
   * Framing of a box seen from (az, polar): the target re-centred on the box's projection, the perspective distance that keeps all eight corners in
   * the frustum and the orthographic zoom that does the same. The free area excludes the callout columns (inset), so the cards do not cover the model.
   */
  frameBox(box, az, polar) {
    const inset = (this.w || 0) >= 440 ? this.inset || 0 : 0;                // narrow views show no callout columns
    const aspect = Math.max(0.35, ((this.w || 1) - 2 * inset) / (this.h || 1));
    const tanV = Math.tan((this.persp.fov * D2R) / 2), tanH = tanV * aspect;
    const th = az * D2R, ph = Math.max(polar, 0.05) * D2R;
    const dir = new Vector3(Math.sin(ph) * Math.sin(th), Math.cos(ph), Math.sin(ph) * Math.cos(th));        // target -> camera
    const right = new Vector3(Math.cos(th), 0, -Math.sin(th));
    const up = new Vector3().crossVectors(right, dir.clone().negate()).normalize();
    const c0 = box.getCenter(new Vector3());
    const corners = [];
    for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) corners.push(new Vector3(x, y, z).sub(c0));
    const xs = corners.map((v) => v.dot(right)), ys = corners.map((v) => v.dot(up));
    const cx = (Math.max(...xs) + Math.min(...xs)) / 2, cy = (Math.max(...ys) + Math.min(...ys)) / 2;
    const target = c0.clone().addScaledVector(right, cx).addScaledVector(up, cy);
    let dist = 0, halfH = 1;
    for (const v of corners) {
      const x = v.dot(right) - cx, y = v.dot(up) - cy, z = v.dot(dir);
      dist = Math.max(dist, z + Math.max(Math.abs(x) / tanH, Math.abs(y) / tanV));
      halfH = Math.max(halfH, Math.abs(y), Math.abs(x) / aspect);
    }
    // perspective refinement: project the corners for real, re-centre on their screen bounds and rescale so the box fills ~90% of the free area
    const abs = corners.map((v) => v.clone().add(c0));
    for (let k = 0; k < 4; k++) {
      const P = target.clone().addScaledVector(dir, dist);
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const c of abs) {
        const d = c.clone().sub(P), z = Math.max(1, -d.dot(dir));
        const nx = d.dot(right) / (z * tanH), ny = d.dot(up) / (z * tanV);
        x0 = Math.min(x0, nx); x1 = Math.max(x1, nx); y0 = Math.min(y0, ny); y1 = Math.max(y1, ny);
      }
      target.addScaledVector(right, ((x0 + x1) / 2) * dist * tanH).addScaledVector(up, ((y0 + y1) / 2) * dist * tanV);
      dist *= Math.max((x1 - x0) / 2, (y1 - y0) / 2) / 0.9;
    }
    return { target, dist: Math.min(LIMITS.maxDistance, Math.max(LIMITS.minDistance, dist)), zoom: Math.min(LIMITS.maxZoom, Math.max(LIMITS.minZoom, ORTHO_H / (halfH * 1.07))) };
  }

  /** Move the camera to a preset view (framing the visible parts). */
  view(name, { instant = false } = {}) {
    const p = PRESETS[name] || PRESETS.iso;
    this.goTo({ az: p.az, polar: p.polar, ...this.frameBox(this.fitBox(null), p.az, p.polar) }, instant);
    this.preset = name; this.userMoved = false;
  }

  /** Frame the visible assembly (or one part) from the current direction. */
  fit(part = null) {
    const sph = new Spherical().setFromVector3(this._v.copy(this.camera.position).sub(this.controls.target));
    const az = sph.theta / D2R, polar = sph.phi / D2R;
    this.goTo({ az, polar, ...this.frameBox(this.fitBox(part), az, polar) });
  }
  focus(id) { if (this.byPart[id]) this.fit(id); }
  reset() { this.view('iso'); }

  /** Box to frame: the visible parts (the USB lead leaving the base is ignored), padded so a single small part is not framed edge to edge. */
  fitBox(part) {
    const box = new Box3();
    for (const m of this.rig.meshes) if (m.visible && (part ? m.userData.part === part : m.userData.mat !== 'usb')) box.expandByObject(m);
    if (box.isEmpty()) box.setFromCenterAndSize(TARGET, new Vector3(300, 120, 220));
    const s = box.getSize(new Vector3()), min = part ? 30 : 80;
    if (part) box.expandByScalar(Math.max(s.x, s.y, s.z) * 0.14);                 // breathing room around a single part
    return box.expandByVector(new Vector3(Math.max(0, (min - s.x) / 2), Math.max(0, (min - s.y) / 2), Math.max(0, (min - s.z) / 2)));
  }

  goTo({ target, az, polar, dist, zoom }, instant = false) {
    const cam = this.camera, ctl = this.controls;
    const to = { target: new Vector3().copy(target), sph: new Spherical(this.camera === this.persp ? dist : cam.position.distanceTo(ctl.target) || dist, polar * D2R, az * D2R), zoom };
    to.target.clamp(PAN_BOX.min, PAN_BOX.max);
    if (this.camera !== this.persp) to.sph.radius = Math.max(400, dist);
    const from = { target: ctl.target.clone(), sph: new Spherical().setFromVector3(this._v.copy(cam.position).sub(ctl.target)), zoom: cam.zoom };
    let dTheta = to.sph.theta - from.sph.theta;                    // shortest way round
    dTheta = Math.atan2(Math.sin(dTheta), Math.cos(dTheta));
    to.sph.theta = from.sph.theta + dTheta;
    this.tween = { from, to, t0: performance.now(), dur: instant || this.reduced ? 0 : 520 };
    if (this.tween.dur === 0) this.stepTween(performance.now());
    this.invalidate();
  }

  stepTween(now) {
    const tw = this.tween; if (!tw) return false;
    const p = tw.dur ? Math.min(1, (now - tw.t0) / tw.dur) : 1, k = ease(p);
    const { from, to } = tw, ctl = this.controls, cam = this.camera;
    ctl.target.lerpVectors(from.target, to.target, k);
    const s = new Spherical(from.sph.radius + (to.sph.radius - from.sph.radius) * k, from.sph.phi + (to.sph.phi - from.sph.phi) * k, from.sph.theta + (to.sph.theta - from.sph.theta) * k);
    s.makeSafe();
    cam.position.setFromSpherical(s).add(ctl.target);
    if (cam === this.ortho) { cam.zoom = from.zoom + (to.zoom - from.zoom) * k; cam.updateProjectionMatrix(); }
    cam.lookAt(ctl.target);
    if (p >= 1) { this.tween = null; ctl.update(); }
    return true;
  }

  /** Keyboard camera moves: orbit by degrees, pan by a fraction of the view, zoom by a factor. */
  nudge({ orbit, pan, zoom }) {
    this.tween = null;
    const ctl = this.controls, cam = this.camera;
    const off = this._v.copy(cam.position).sub(ctl.target);
    const s = new Spherical().setFromVector3(off);
    if (orbit) { s.theta -= orbit[0] * D2R; s.phi = Math.min(ctl.maxPolarAngle, Math.max(0.01, s.phi - orbit[1] * D2R)); }
    if (zoom) {
      if (cam === this.persp) s.radius = Math.min(LIMITS.maxDistance, Math.max(LIMITS.minDistance, s.radius / zoom));
      else { cam.zoom = Math.min(LIMITS.maxZoom, Math.max(LIMITS.minZoom, cam.zoom * zoom)); cam.updateProjectionMatrix(); }
    }
    cam.position.setFromSpherical(s).add(ctl.target);
    if (pan) {
      const span = cam === this.persp ? s.radius * Math.tan((this.persp.fov * D2R) / 2) : ORTHO_H / cam.zoom;
      const right = this._n.setFromMatrixColumn(cam.matrix, 0).multiplyScalar(pan[0] * span);
      const up = this._c.setFromMatrixColumn(cam.matrix, 1).multiplyScalar(pan[1] * span);
      ctl.target.add(right).add(up); cam.position.add(right).add(up);
    }
    ctl.update();
  }

  clampTarget() {
    const t = this.controls.target;
    if (PAN_BOX.containsPoint(t)) return;
    const before = t.clone(); t.clamp(PAN_BOX.min, PAN_BOX.max);
    this.camera.position.add(before.sub(t).negate());
  }

  cameraInfo() {
    const s = new Spherical().setFromVector3(this._v.copy(this.camera.position).sub(this.controls.target));
    return { az: Math.round((((s.theta / D2R) % 360) + 360) % 360), polar: Math.round(s.phi / D2R), dist: Math.round(s.radius), zoom: +this.camera.zoom.toFixed(2), ortho: this.camera === this.ortho };
  }

  // ---------------------------------------------------------------- appearance

  applyHighlight() {
    const { selected, hover, alerts, theme } = this.state;
    if (!theme) return;
    const accent = new Color(theme.accent);
    for (const m of this.rig.meshes) {
      const part = m.userData.part, mat = m.material;
      const alert = alerts[part];
      let col = null, k = 0;
      if (part === selected) { col = accent; k = 0.32; }
      else if (part === hover) { col = accent; k = 0.16; }
      else if (alert) { col = new Color(theme[alert] || theme.crit); k = 0.07; }   // evidence-backed alert only: a faint steady tint plus an outline
      if (col) mat.emissive.copy(col).multiplyScalar(k); else mat.emissive.setRGB(0, 0, 0);
      mat.color.copy(mat.userData.baseColor);
      if (selected && part !== selected && !this.state.isolate) mat.color.multiplyScalar(theme.dark ? 0.62 : 0.78);   // the selection stays bright
    }
    this.applyEdges();
  }

  edgesFor(mesh) {
    let l = this.edgeCache.get(mesh);
    if (!l) {
      l = new LineSegments(new EdgesGeometry(mesh.geometry, 28), new LineBasicMaterial({ color: this.state.theme?.edge || '#222', transparent: true, opacity: 0.55 }));
      l.raycast = () => {}; l.userData = { sel: false };
      if (mesh.material.clippingPlanes) l.material.clippingPlanes = mesh.material.clippingPlanes;
      mesh.add(l); this.edgeCache.set(mesh, l);
    }
    return l;
  }

  applyEdges() {
    const { edges, selected, theme, alerts } = this.state;
    for (const m of this.rig.meshes) {
      const sel = m.userData.part === selected, alert = !sel && alerts[m.userData.part];
      const hide = (!edges && !sel && !alert) || (m.userData.node === 'harness' && !sel);   // cables have no useful feature edges
      if (hide) { const l = this.edgeCache.get(m); if (l) l.visible = false; continue; }
      const l = this.edgesFor(m);
      l.visible = true; l.userData.sel = sel;
      if (theme) l.material.color.set(sel ? theme.accent : alert ? theme[alert] || theme.crit : theme.edge);
      l.material.opacity = sel || alert ? 0.95 : 0.5;
    }
  }

  applyIsolation(refit) {
    const { isolate, selected } = this.state;
    const show = (part) => !isolate || !selected || part === selected;
    for (const m of this.rig.meshes) m.visible = show(m.userData.part) && !(m.userData.node === 'harness' && this.state.explode > 0.02);
    for (const c of this.rig.caps) c.visible = this.state.cutaway && show(c.userData.part);
    this.renderer.shadowMap.needsUpdate = true;
    if (refit) this.fit(isolate && selected ? selected : null);
    this.applyHighlight();
  }

  applyExplode(f) {
    this.state.explode = f;
    for (const [name, g] of Object.entries(this.rig.nodes)) {
      const e = EXPLODE[name] || [0, 0, 0];
      g.position.set(g.userData.base.x + e[0] * f, g.userData.base.y + e[1] * f, g.userData.base.z + e[2] * f);
    }
    const hideWires = f > 0.02;
    for (const m of this.byPart.harness || []) m.visible = !hideWires && (!this.state.isolate || this.state.selected === 'harness');
    this.renderer.shadowMap.needsUpdate = true;
  }

  updateClip() {
    if (!this.state.cutaway) return;
    // Section through the shaft axis, removing the half that faces the camera, so the inside is always visible.
    const n = this._n.set(0, this.camera.position.y - AXIS.y, this.camera.position.z - AXIS.z);
    if (n.lengthSq() < 1e-6) n.set(0, 0, 1);
    n.normalize();
    const a = this._c.set(0, AXIS.y, AXIS.z);
    this.clip.normal.copy(n).negate(); this.clip.constant = n.dot(a);
  }

  // ---------------------------------------------------------------- picking

  pickAt(clientX, clientY) {
    const b = this.canvas.getBoundingClientRect();
    this.ndc.set(((clientX - b.left) / b.width) * 2 - 1, -((clientY - b.top) / b.height) * 2 + 1);
    this.ray.setFromCamera(this.ndc, this.camera);
    const hits = this.ray.intersectObjects(this.rig.meshes.filter((m) => m.visible), false);
    for (const h of hits) {
      if (this.state.cutaway && h.object.userData.cut && this.clip.distanceToPoint(h.point) < 0) continue;   // clicked where the section removed material
      return h.object.userData.part;
    }
    return null;
  }

  setHover(id, x, y) {
    if (id === this.state.hover) { if (id) this.cb.onHover?.(id, x, y); return; }
    this.state.hover = id;
    this.canvas.style.cursor = id ? 'pointer' : '';
    this.applyHighlight(); this.invalidate();
    this.cb.onHover?.(id, x, y);
  }

  // ---------------------------------------------------------------- loop

  frame(now) {
    this.running = false;
    if (this.disposed || this.lost) return;
    const dt = this.last == null ? 0 : (now - this.last) / 1000;
    this.last = now;
    let active = false;
    if (this.stepTween(now)) active = true;
    if (this.controls.update()) active = true;                       // damping still settling
    const s = this.state;
    if (s.explode !== s.explodeTarget) {
      const step = Math.min(1, dt / 0.6);
      const next = s.explodeTarget > s.explode ? Math.min(s.explodeTarget, s.explode + step) : Math.max(s.explodeTarget, s.explode - step);
      this.applyExplode(next); active = true;
      if (next === s.explodeTarget && (s.isolate || !this.userMoved)) this.fit(s.isolate ? s.selected : null);
    }
    const spin = s.spinning && !this.reduced;
    if (spin) {
      this.angle = advanceAngle(this.angle, s.rpm, dt);
      this.rig.nodes.rotor.rotation.x = this.angle; this.rig.nodes.disc.rotation.x = this.angle;
      active = true;
    }
    if (this.pickDirty && this.pointer && !this.down) {
      this.pickDirty = false;
      const b = this.canvas.getBoundingClientRect();
      this.setHover(this.pickAt(b.left + this.pointer.x, b.top + this.pointer.y), this.pointer.x, this.pointer.y);
    }
    if (this.dirty || active) {
      this.dirty = false;
      this.updateClip();
      this.renderer.render(this.scene, this.camera);
      this.frames += 1;
      this.project();
    }
    if ((active || this.dirty) && this.visible && !document.hidden) { this.running = true; this.raf = requestAnimationFrame((t) => this.frame(t)); }
  }

  /** Screen positions of the component anchors, for the DOM markers and callouts. */
  project() {
    const pts = [];
    const cam = this.camera, f = this.state.explode;
    for (const id of Object.keys(COMPONENT)) {
      const c = COMPONENT[id], e = EXPLODE[c.node] || [0, 0, 0];
      const p = this._v.set(c.anchor[0] + e[0] * f, c.anchor[1] + e[1] * f, c.anchor[2] + e[2] * f);
      const toCam = this._c.copy(cam.position).sub(p).normalize();
      const facing = this._n.set(...c.normal).normalize().dot(cam === this.ortho ? this._c.set(0, 0, 1).applyQuaternion(cam.quaternion) : toCam);
      p.project(cam);
      const shown = !this.state.isolate || !this.state.selected || this.state.selected === id;
      pts.push({ id, x: ((p.x + 1) / 2) * this.w, y: ((1 - p.y) / 2) * this.h, inView: p.z < 1 && Math.abs(p.x) <= 1.02 && Math.abs(p.y) <= 1.02 && shown && !(id === 'harness' && f > 0.02), back: facing < -0.15 });
    }
    this.cb.onProject?.(pts, this.w, this.h);
    this.cb.onCamera?.({ ...this.cameraInfo(), frames: this.frames, calls: this.renderer.info.render.calls, triangles: this.renderer.info.render.triangles, geometries: this.renderer.info.memory.geometries });
  }
}
