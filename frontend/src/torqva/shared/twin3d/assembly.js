// Procedural 3D assembly of the TORQVA rig (Three.js). Geometry only: no data, no animation state, no DOM. Units are millimetres in the rig frame of
// ../twinParts.js (x along the shaft, y up from the base top; the electronics side, which the front view faces, is -z). The model is ILLUSTRATIVE: the RS-775 envelope and the
// breakout boards follow their typical published sizes, the layout follows the build notes, and nothing is measured on the real rig.
//
// Solids are built closed (lathe profiles with wall thickness, extruded sections) so the cutaway can show their section faces correctly. Pieces are
// merged per (scene node, component, material), which keeps the scene to a few dozen draw calls.
import {
  BoxGeometry, BufferAttribute, BufferGeometry, CatmullRomCurve3, CylinderGeometry, Euler, ExtrudeGeometry, Group, Matrix4, Mesh, MeshBasicMaterial,
  MeshStandardMaterial, Path, Quaternion, Shape, SphereGeometry, TorusGeometry, TubeGeometry, Vector3, BackSide,
} from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { AXIS, EXPLODE } from '../twinParts.js';

const D2R = Math.PI / 180;

/** Material library (physically based; colours in sRGB). */
export const MATERIALS = {
  can: { color: '#b9bfc7', metalness: 0.88, roughness: 0.34 },
  face: { color: '#d0d5db', metalness: 0.92, roughness: 0.26 },
  bell: { color: '#30353c', metalness: 0.55, roughness: 0.5 },
  vent: { color: '#0d0f12', metalness: 0, roughness: 0.9 },
  label: { color: '#1e3352', metalness: 0.05, roughness: 0.55 },
  ferrite: { color: '#3e4147', metalness: 0.1, roughness: 0.85 },
  lamination: { color: '#757c85', metalness: 0.75, roughness: 0.42 },
  copper: { color: '#b86b39', metalness: 1, roughness: 0.32 },
  dark: { color: '#16181b', metalness: 0.2, roughness: 0.7 },
  carbon: { color: '#202124', metalness: 0, roughness: 0.92 },
  brass: { color: '#c9a24a', metalness: 1, roughness: 0.3 },
  shaft: { color: '#e7eaee', metalness: 1, roughness: 0.14 },
  alu: { color: '#a9b1bb', metalness: 0.85, roughness: 0.4 },
  nickel: { color: '#e0e4e8', metalness: 1, roughness: 0.2 },
  basePlate: { color: '#373d46', metalness: 0.35, roughness: 0.72 },
  bracket: { color: '#bcc3cc', metalness: 0.85, roughness: 0.36 },
  rubber: { color: '#18191b', metalness: 0, roughness: 0.95 },
  fastener: { color: '#2b2e33', metalness: 0.8, roughness: 0.42 },
  pcbBlack: { color: '#161a1f', metalness: 0.1, roughness: 0.55 },
  pcbRed: { color: '#8e2b25', metalness: 0.1, roughness: 0.5 },
  pcbBlue: { color: '#21499a', metalness: 0.1, roughness: 0.5 },
  pcbPurple: { color: '#3b3390', metalness: 0.1, roughness: 0.5 },
  pcbGreen: { color: '#24553c', metalness: 0.1, roughness: 0.55 },
  chip: { color: '#121418', metalness: 0.2, roughness: 0.4 },
  gold: { color: '#d4af37', metalness: 1, roughness: 0.3 },
  shield: { color: '#c5cad0', metalness: 0.95, roughness: 0.28 },
  terminal: { color: '#2b6fb0', metalness: 0.05, roughness: 0.55 },
  heatsink: { color: '#b3b9c0', metalness: 0.85, roughness: 0.45 },
  glass: { color: '#050608', metalness: 0, roughness: 0.07 },
  ledRed: { color: '#7a1d1d', metalness: 0, roughness: 0.25 }, ledGreen: { color: '#1d5a33', metalness: 0, roughness: 0.25 },
  ledAmber: { color: '#7a5418', metalness: 0, roughness: 0.25 }, ledBlue: { color: '#1d3a7a', metalness: 0, roughness: 0.25 },
  psu: { color: '#c8cdd3', metalness: 0.7, roughness: 0.5 },
  stainless: { color: '#c9ced4', metalness: 0.9, roughness: 0.3 },
  wireRed: { color: '#b3261e', metalness: 0, roughness: 0.55 }, wireBlack: { color: '#1d1f22', metalness: 0, roughness: 0.6 },
  wireGrey: { color: '#7e848d', metalness: 0, roughness: 0.6 }, wirePurple: { color: '#6b5fa8', metalness: 0, roughness: 0.6 },
  wireBlue: { color: '#2f6db5', metalness: 0, roughness: 0.6 }, wireOrange: { color: '#cf7a2d', metalness: 0, roughness: 0.6 },
  usb: { color: '#2b2e33', metalness: 0, roughness: 0.65 },
};
export const SECTION_COLOR = '#c8553d';

// ---------------------------------------------------------------- geometry helpers

const tmpQ = new Quaternion();
/** Translation + rotation (degrees, XYZ) as a matrix. */
export function T(x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) {
  return new Matrix4().compose(new Vector3(x, y, z), tmpQ.setFromEuler(new Euler(rx * D2R, ry * D2R, rz * D2R)).clone(), new Vector3(1, 1, 1));
}

/**
 * Solid of revolution about the x axis. profile: [[x, r, smooth?], ...] traced clockwise in the (x right, r up) plane, so outward normals point out of
 * the solid. Unlike LatheGeometry, every corner stays sharp (per-segment normals) unless the point is flagged smooth.
 */
export function revolve(profile, seg = 64) {
  const n = profile.length;
  const segN = [];
  for (let k = 0; k < n - 1; k++) {
    const [x0, r0] = profile[k], [x1, r1] = profile[k + 1];
    const dx = x1 - x0, dr = r1 - r0, l = Math.hypot(dx, dr) || 1;
    segN.push([-dr / l, dx / l]);                                   // [nx, nr]
  }
  const nAt = (k, end) => {                                        // normal of segment k at its start (end = false) or end point
    const p = end ? k + 1 : k;
    const other = end ? k + 1 : k - 1;
    if (profile[p][2] && other >= 0 && other < segN.length) { const a = segN[k], b = segN[other], l = Math.hypot(a[0] + b[0], a[1] + b[1]) || 1; return [(a[0] + b[0]) / l, (a[1] + b[1]) / l]; }
    return segN[k];
  };
  const pos = [], nor = [], uv = [], idx = [];
  let len = 0;
  const total = profile.slice(1).reduce((s, p, i) => s + Math.hypot(p[0] - profile[i][0], p[1] - profile[i][1]), 0) || 1;
  for (let k = 0; k < n - 1; k++) {
    const ends = [[profile[k], nAt(k, false), len / total]];
    len += Math.hypot(profile[k + 1][0] - profile[k][0], profile[k + 1][1] - profile[k][1]);
    ends.push([profile[k + 1], nAt(k, true), len / total]);
    const base = pos.length / 3;
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
      for (const [[x, r], [nx, nr], v] of ends) { pos.push(x, r * c, r * s); nor.push(nx, nr * c, nr * s); uv.push(i / seg, v); }
    }
    for (let i = 0; i < seg; i++) {
      const a0 = base + i * 2, b0 = a0 + 1, a1 = a0 + 2, b1 = a0 + 3;
      idx.push(a0, a1, b0, b0, a1, b1);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('normal', new BufferAttribute(new Float32Array(nor), 3));
  g.setAttribute('uv', new BufferAttribute(new Float32Array(uv), 2));
  g.setIndex(idx);
  return g;
}

/** Closed cylinder along x from x0 to x1. */
export const rod = (x0, x1, r, seg = 32, ch = 0) => revolve(ch ? [[x0, 0], [x0, r - ch], [x0 + ch, r], [x1 - ch, r], [x1, r - ch], [x1, 0]] : [[x0, 0], [x0, r], [x1, r], [x1, 0]], seg);
const box = (w, h, d, r = 0) => (r > 0 ? new RoundedBoxGeometry(w, h, d, 2, r) : new BoxGeometry(w, h, d));
/** Vertical cylinder (axis y) standing on y = 0 at its base. */
const post = (r, h, seg = 20) => new CylinderGeometry(r, r, h, seg).translate(0, h / 2, 0);
/** Swept cable through control points. */
const cable = (pts, r, seg = 56) => new TubeGeometry(new CatmullRomCurve3(pts.map((p) => new Vector3(...p)), false, 'centripetal'), seg, r, 8, false);

/** Annular sector (angles in degrees) extruded along +x from x0 by `len`, centred on the shaft axis. */
function arcSegment(rIn, rOut, a0, a1, x0, len) {
  const s = new Shape();
  s.absarc(0, 0, rOut, a0 * D2R, a1 * D2R, false);
  s.absarc(0, 0, rIn, a1 * D2R, a0 * D2R, true);
  s.closePath();
  return new ExtrudeGeometry(s, { depth: len, bevelEnabled: false, curveSegments: 28 }).rotateY(Math.PI / 2).translate(x0, 0, 0);
}

/** Armature lamination stack: `slots` teeth between rSlot and rOut, bore rBore, extruded along +x. */
function lamination(rOut, rSlot, rBore, slots, x0, len) {
  const s = new Shape();
  const step = (Math.PI * 2) / slots, half = step * 0.3;
  for (let k = 0; k < slots; k++) {
    const c = k * step;
    const p = (r, a) => [r * Math.cos(a), r * Math.sin(a)];
    const pts = [p(rSlot, c - step / 2 + 0.04), p(rSlot, c - half * 0.55), p(rOut, c - half), p(rOut, c + half), p(rSlot, c + half * 0.55), p(rSlot, c + step / 2 - 0.04)];
    pts.forEach(([x, y], i) => (k === 0 && i === 0 ? s.moveTo(x, y) : s.lineTo(x, y)));
  }
  s.closePath();
  const hole = new Path(); hole.absarc(0, 0, rBore, 0, Math.PI * 2, true); s.holes.push(hole);
  return new ExtrudeGeometry(s, { depth: len, bevelEnabled: false, curveSegments: 20 }).rotateY(Math.PI / 2).translate(x0, 0, 0);
}

// ---------------------------------------------------------------- assembly

/** Collects geometry per (node, part, material, cut) and merges it at the end. */
class Collector {
  constructor() { this.groups = new Map(); }
  add(geo, node, part, mat, m, { cut = false } = {}) {
    if (m) geo.applyMatrix4(m);
    const key = `${node}|${part}|${mat}|${cut ? 1 : 0}`;
    if (!this.groups.has(key)) this.groups.set(key, { node, part, mat, cut, geos: [] });
    this.groups.get(key).geos.push(geo);
  }
}

/** Nodes that turn with the shaft: their geometry is built in world space and re-centred on the shaft axis. */
export const SPIN_NODES = ['rotor', 'disc'];

function buildMotor(c) {
  const ax = (x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) => T(x, AXIS.y + y, AXIS.z + z, rx, ry, rz);   // matrix relative to the shaft axis
  // can (thick-walled, closed) with cooling slots and a label band
  c.add(revolve([[-36, 19.6], [-36, 20.6], [-35.6, 21], [27.6, 21], [28, 20.6], [28, 19.6], [-36, 19.6]], 96), 'can', 'motor', 'can', ax(), { cut: true });
  c.add(revolve([[-4, 20.98], [-4, 21.12], [16, 21.12], [16, 20.98], [-4, 20.98]], 96), 'can', 'motor', 'label', ax(), { cut: true });
  for (let k = 0; k < 8; k++) c.add(box(9, 1, 4.2), 'can', 'motor', 'vent', ax(-27, 0, 0, k * 45 + 22.5).multiply(T(0, 20.55, 0)));
  // stator: two ferrite arc magnets bonded to the can
  c.add(arcSegment(15.8, 19.6, 28, 152, -30, 50), 'stator', 'motor', 'ferrite', ax(), { cut: true });
  c.add(arcSegment(15.8, 19.6, 208, 332, -30, 50), 'stator', 'motor', 'ferrite', ax(), { cut: true });
  // front plate with the bearing boss (stays on the bracket in the exploded view)
  c.add(revolve([[28, 2.6], [28, 21], [30.6, 21], [31, 20.6], [31, 8.75], [36.6, 8.75], [37, 8.35], [37, 4.5], [36, 4.5], [36, 2.6], [28, 2.6]], 96), 'bracket', 'motor', 'face', ax(), { cut: true });
  c.add(revolve([[31.5, 2.5], [31.5, 4.4], [35.5, 4.4], [35.5, 2.5], [31.5, 2.5]], 40), 'bracket', 'motor', 'shaft', ax(), { cut: true });   // front bearing
  // rear end bell with brush gear, bushing and the two terminals
  c.add(revolve([[-45, 2.6], [-45, 7], [-42.4, 7], [-42.4, 19.6], [-41, 21], [-36, 21], [-36, 19.6], [-41, 19.6], [-41, 2.6], [-45, 2.6]], 96), 'rearBell', 'motor', 'bell', ax(), { cut: true });
  c.add(revolve([[-45.2, 2.5], [-45.2, 3.1], [-41.5, 3.1], [-41.5, 2.5], [-45.2, 2.5]], 32), 'rearBell', 'motor', 'brass', ax(), { cut: true });
  for (const a of [45, 135, 225, 315]) c.add(box(0.3, 3, 7), 'rearBell', 'motor', 'vent', ax(-42.55, 0, 0, a).multiply(T(0, 13, 0)));
  for (const s of [1, -1]) {
    c.add(box(6, 3, 4), 'rearBell', 'motor', 'carbon', ax(-29.5, 8.6 * s, 0));                       // carbon brush on the commutator
    c.add(box(7, 4.4, 5.6), 'rearBell', 'motor', 'brass', ax(-29.5, 12.6 * s, 0));                   // brush holder
    c.add(box(1.2, 4, 10.4), 'rearBell', 'motor', 'dark', ax(-38.2, 12.6 * s, 0));                   // holder plate
    c.add(box(0.8, 6.5, 4.2), 'rearBell', 'motor', 'brass', ax(-45.6, 0, 11 * s));                   // terminal tab
    c.add(box(3.2, 8.5, 6), 'rearBell', 'motor', 'dark', ax(-43.6, 0, 11 * s));                      // terminal insulator
  }
  // rotor (turns): shaft, lamination stack, windings, commutator
  c.add(revolve([[-46.4, 0], [-46.4, 2.1], [-46, 2.5], [53, 2.5], [53.5, 2], [53.5, 0]], 40), 'rotor', 'shaft', 'shaft', ax());
  c.add(lamination(15, 10, 2.5, 12, -22, 34), 'rotor', 'motor', 'lamination', ax());
  c.add(rod(-21.5, 11.5, 13.2, 48), 'rotor', 'motor', 'copper', ax());
  for (const x of [-24.5, 14.5]) c.add(new TorusGeometry(10.6, 3.1, 14, 48).rotateY(Math.PI / 2), 'rotor', 'motor', 'copper', ax(x));
  c.add(rod(-33.5, -26, 6, 48), 'rotor', 'motor', 'copper', ax());
  for (let k = 0; k < 12; k++) c.add(box(7.6, 0.7, 1.1), 'rotor', 'motor', 'dark', ax(-29.75, 0, 0, k * 30).multiply(T(0, 5.8, 0)));
  // disc assembly (turns; slides off along the shaft in the exploded view): hub with set screw, disc, balance holes, magnet
  c.add(revolve([[39, 2.5], [39, 8.2], [39.5, 8.7], [46, 8.7], [46, 2.5], [39, 2.5]], 48), 'disc', 'shaft', 'alu', ax());
  c.add(new CylinderGeometry(1.6, 1.6, 1.2, 6), 'disc', 'shaft', 'dark', ax(42.5, 9.2, 0));
  c.add(revolve([[46, 2.5], [46, 39.2], [46.8, 40], [50.2, 40], [51, 39.2], [51, 8.7], [51, 2.5], [46, 2.5]], 96), 'disc', 'shaft', 'alu', ax());
  for (let k = 0; k < 6; k++) c.add(new CylinderGeometry(2.1, 2.1, 0.3, 20).rotateZ(Math.PI / 2), 'disc', 'shaft', 'dark', ax(51.05, 0, 0, k * 60 + 30).multiply(T(0, 22, 0)));
  c.add(rod(51, 52.5, 3, 28, 0.3), 'disc', 'shaft', 'nickel', ax(0, 30, 0));
}

function buildBaseAndBracket(c) {
  c.add(box(300, 12, 220, 3), 'base', 'base', 'basePlate', T(-20, -6, 0));
  for (const [x, z] of [[-160, -100], [-160, 100], [120, -100], [120, 100]]) c.add(post(10, 4, 28), 'base', 'base', 'rubber', T(x, -16, z));
  // angle bracket: upright bolted to the motor face, foot screwed to the base, two gussets
  c.add(box(4, 92, 64, 1), 'bracket', 'base', 'bracket', T(33, 46, AXIS.z));
  c.add(box(36, 4, 64, 1), 'bracket', 'base', 'bracket', T(13, 2, AXIS.z));
  const g = new Shape(); g.moveTo(31, 4); g.lineTo(31, 40); g.lineTo(6, 4); g.closePath();
  for (const z of [AXIS.z - 31, AXIS.z + 28]) c.add(new ExtrudeGeometry(g, { depth: 3, bevelEnabled: false }), 'bracket', 'base', 'bracket', T(0, 0, z));
  for (const z of [AXIS.z - 20, AXIS.z + 20]) c.add(new CylinderGeometry(4, 4, 2.6, 6), 'bracket', 'base', 'fastener', T(4, 5.3, z));
  for (const z of [-14.5, 14.5]) c.add(new CylinderGeometry(3.3, 3.3, 2.4, 24).rotateZ(Math.PI / 2), 'bracket', 'base', 'fastener', T(36.2, AXIS.y, AXIS.z + z));
  // rear cradle with a rubber pad under the can
  c.add(box(14, 34, 30, 1.5), 'base', 'base', 'bracket', T(-26, 17, AXIS.z));
  c.add(box(14, 3, 26), 'base', 'base', 'rubber', T(-26, 35.5, AXIS.z));
}

function buildSensors(c) {
  // A3144 Hall sensor on a small perfboard, on an aluminium post facing the disc (magnet path at r = 30 mm, ~2.5 mm air gap)
  c.add(box(3, 100, 22, 0.6), 'hall', 'hall', 'bracket', T(59.7, 50, AXIS.z));
  c.add(box(18, 3, 22, 0.6), 'hall', 'hall', 'bracket', T(67.2, 1.5, AXIS.z));
  c.add(new CylinderGeometry(3.5, 3.5, 2.4, 6), 'hall', 'hall', 'fastener', T(70, 4.2, AXIS.z));
  c.add(box(1.6, 14, 18), 'hall', 'hall', 'pcbGreen', T(57.4, AXIS.y + 30, AXIS.z));
  c.add(box(1.6, 3.8, 4.4, 0.4), 'hall', 'hall', 'chip', T(55.8, AXIS.y + 30, AXIS.z));
  for (const dz of [-1.27, 0, 1.27]) c.add(box(0.5, 0.5, 0.4), 'hall', 'hall', 'nickel', T(56.4, AXIS.y + 27.6, AXIS.z + dz));
  for (const dz of [-6, 6]) c.add(new CylinderGeometry(1.2, 1.2, 1.2, 12).rotateZ(Math.PI / 2), 'hall', 'hall', 'fastener', T(57.4 - 1.4, AXIS.y + 34, AXIS.z + dz));

  // ADXL345 breakout on an adhesive pad on top of the can
  c.add(box(18, 1.5, 13), 'accel', 'accel', 'rubber', T(10, AXIS.y + 21.6, AXIS.z));
  c.add(box(20.5, 1.6, 15.4, 0.3), 'accel', 'accel', 'pcbPurple', T(10, AXIS.y + 23.2, AXIS.z));
  c.add(box(5, 1, 5), 'accel', 'accel', 'chip', T(10, AXIS.y + 24.5, AXIS.z));
  for (let k = 0; k < 8; k++) c.add(new CylinderGeometry(0.7, 0.7, 0.4, 10), 'accel', 'accel', 'gold', T(1.4 + k * 2.54 * 0.85, AXIS.y + 24.1, AXIS.z - 6.3));

  // DS18B20 stainless probe under a band clamp on the can (upper quarter towards the electronics, 45 degrees)
  const a = -45 * D2R, rp = 24.05;
  const py = AXIS.y + rp * Math.cos(a), pz = AXIS.z + rp * Math.sin(a);
  c.add(revolve([[-24, 0], [-24, 2.6], [-23.6, 3], [4, 3, 1], [5.2, 2.6, 1], [5.9, 1.6, 1], [6.2, 0]], 32), 'temp', 'temp', 'stainless', T(0, py, pz));
  c.add(rod(-31, -24, 3.25, 24, 0.4), 'temp', 'temp', 'rubber', T(0, py, pz));
  c.add(revolve([[-17.5, 21.0], [-17.5, 21.7], [-10.5, 21.7], [-10.5, 21.0], [-17.5, 21.0]], 96), 'temp', 'temp', 'stainless', T(0, AXIS.y, AXIS.z));
  c.add(box(7, 0.8, 9, 0.3), 'temp', 'temp', 'stainless', T(-14, AXIS.y + 27.4 * Math.cos(a), AXIS.z + 27.4 * Math.sin(a), a / D2R));
  c.add(box(9, 4.5, 6, 0.8), 'temp', 'temp', 'stainless', T(-14, AXIS.y + 22.4 * Math.cos(-a), AXIS.z + 22.4 * Math.sin(-a), -a / D2R));
}

/** A breakout board on four stand-offs: returns the y of the board top. */
function board(c, node, part, mat, cx, cz, w, d, lift = 5, t = 1.6) {
  for (const [sx, sz] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) c.add(post(1.6, lift, 12), node, part, 'brass', T(cx + sx * (w / 2 - 2.6), 0, cz + sz * (d / 2 - 2.6)));
  c.add(box(w, t, d, 0.4), node, part, mat, T(cx, lift + t / 2, cz));
  return lift + t;
}
function header(c, node, part, x, y, z, n, along = 'x', down = false) {
  const L = n * 2.54;
  c.add(box(along === 'x' ? L : 2.5, 2.5, along === 'x' ? 2.5 : L), node, part, 'dark', T(x, y + (down ? -1.25 : 1.25), z));
  for (let k = 0; k < n; k++) {
    const o = -L / 2 + 1.27 + k * 2.54;
    c.add(box(0.64, 6, 0.64), node, part, 'gold', T(x + (along === 'x' ? o : 0), y + (down ? -2.6 : 3), z + (along === 'x' ? 0 : o)));
  }
}
function screwTerminal(c, node, part, x, y, z, n, along = 'z') {
  const L = n * 5.08;
  c.add(box(along === 'z' ? 7.6 : L, 8.5, along === 'z' ? L : 7.6, 0.5), node, part, 'terminal', T(x, y + 4.25, z));
  for (let k = 0; k < n; k++) {
    const o = -L / 2 + 2.54 + k * 5.08;
    c.add(new CylinderGeometry(1.6, 1.6, 0.8, 16), node, part, 'nickel', T(x + (along === 'z' ? 0 : o), y + 8.7, z + (along === 'z' ? o : 0)));
  }
}

function buildElectronics(c) {
  // INA219 breakout: shunt, chip, supply terminal block, header
  const yi = board(c, 'ina', 'ina', 'pcbBlue', -47, -69, 25.5, 22.3);
  c.add(box(6.3, 1, 3.2), 'ina', 'ina', 'shield', T(-46, yi + 0.5, -63));
  c.add(box(5, 1.5, 4), 'ina', 'ina', 'chip', T(-45, yi + 0.75, -72));
  screwTerminal(c, 'ina', 'ina', -56.5, yi, -69, 2);
  header(c, 'ina', 'ina', -36.2, yi, -69, 6, 'z');

  // BTS7960 / IBT-2: red board, finned heat sink, motor/supply terminals, logic header
  const yd = board(c, 'driver', 'driver', 'pcbRed', 5, -75, 50, 50);
  c.add(box(40, 4, 44, 0.8), 'driver', 'driver', 'heatsink', T(7, yd + 2, -75));
  for (let k = 0; k < 9; k++) c.add(box(1.8, 16, 44, 0.5), 'driver', 'driver', 'heatsink', T(7 - 17.6 + k * 4.4, yd + 12, -75));
  screwTerminal(c, 'driver', 'driver', -15.5, yd, -75, 4);
  header(c, 'driver', 'driver', 27.6, yd, -75, 8, 'z');

  // ESP32-S3 DevKitC-1 class board: module with shield and antenna, two USB-C, buttons, pin headers underneath
  const yc = board(c, 'controller', 'controller', 'pcbBlack', 84, -82, 69, 26, 7);
  c.add(box(25.5, 0.8, 18, 0.2), 'controller', 'controller', 'pcbBlack', T(105.5, yc + 0.4, -82));
  c.add(box(17.6, 2.4, 15.6, 0.3), 'controller', 'controller', 'shield', T(102, yc + 2, -82));
  c.add(box(6, 0.2, 16), 'controller', 'controller', 'gold', T(114.5, yc + 0.9, -82));
  for (const z of [-88, -76]) c.add(box(7.4, 3.2, 9, 1.2), 'controller', 'controller', 'shield', T(53, yc + 1.6, z));
  for (const z of [-92.5, -71.5]) { c.add(box(4, 1.6, 3, 0.3), 'controller', 'controller', 'shield', T(61, yc + 0.8, z)); c.add(post(0.9, 2.2, 10), 'controller', 'controller', 'dark', T(61, yc + 0.5, z)); }
  c.add(box(1.6, 0.9, 1.6), 'controller', 'controller', 'nickel', T(66, yc + 0.45, -72));
  for (const z of [-93.7, -70.3]) header(c, 'controller', 'controller', 84, yc - 1.6, z, 22, 'x', true);
  // status LEDs and buzzer on a strip board (annunciators only; drawn unlit because their state is not reported)
  const ys = board(c, 'controller', 'controller', 'pcbGreen', 66, -58, 36, 10, 4);
  ['ledGreen', 'ledAmber', 'ledBlue', 'ledRed'].forEach((m, k) => {
    c.add(post(2.5, 4.6, 20), 'controller', 'controller', m, T(53 + k * 6.5, ys, -58));
    c.add(new SphereGeometry(2.5, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), 'controller', 'controller', m, T(53 + k * 6.5, ys + 4.6, -58));
  });
  c.add(post(5.8, 7.5, 32), 'controller', 'controller', 'dark', T(79.5, ys, -58));
  // SH1106 OLED on a small stand, tilted back and facing the front (screen drawn dark: its content is not reported)
  c.add(box(36, 3, 14, 0.6), 'oled', 'controller', 'bracket', T(108, 1.5, -46));
  c.add(box(36, 26, 3, 0.6), 'oled', 'controller', 'bracket', T(108, 14, -40, 18));
  const tilt = T(108, 20, -43.4, 18);
  c.add(box(35.4, 33.5, 1.6, 0.4).applyMatrix4(tilt), 'oled', 'controller', 'pcbBlue');
  c.add(box(33, 20, 1.4, 0.3).applyMatrix4(T(0, 2, -1.5)).applyMatrix4(tilt), 'oled', 'controller', 'glass');
  for (let k = 0; k < 4; k++) c.add(box(0.64, 0.64, 5).applyMatrix4(T(-3.81 + k * 2.54, 14.5, 1.8)).applyMatrix4(tilt), 'oled', 'controller', 'gold');

  // 24 V supply: perforated enclosure, terminal strip
  c.add(box(80, 36, 50, 1.6), 'psu', 'psu', 'psu', T(-120, 18, -75));
  for (let k = 0; k < 9; k++) c.add(box(56, 0.4, 1.6), 'psu', 'psu', 'vent', T(-124, 36.05, -91 + k * 4));
  c.add(box(3, 12, 42, 0.6), 'psu', 'psu', 'dark', T(-78.5, 12, -75));
  for (let k = 0; k < 5; k++) c.add(new CylinderGeometry(1.7, 1.7, 1, 16).rotateZ(Math.PI / 2), 'psu', 'psu', 'nickel', T(-76.6, 14, -91 + k * 8));
  c.add(box(40, 12, 0.3), 'psu', 'psu', 'label', T(-120, 20, -100.2));
}

function buildHarness(c) {
  const W = (pts, r, mat) => c.add(cable(pts, r), 'harness', 'harness', mat);
  // power: supply + -> INA219 (high side) -> driver B+; supply - -> driver B-; driver M+ / M- -> motor terminals
  W([[-77, 14, -67], [-70, 3, -66], [-62, 3, -67], [-57, 13.5, -66.5]], 1.4, 'wireRed');
  W([[-57, 13.5, -71.5], [-60, 3, -82], [-36, 2, -94], [-17, 3, -91], [-15.5, 13.5, -82.6]], 1.4, 'wireRed');
  W([[-77, 14, -83], [-66, 2.5, -96], [-30, 2, -100], [-17, 3, -84], [-15.5, 13.5, -77.5]], 1.4, 'wireBlack');
  W([[-15.5, 13.5, -72.4], [-26, 2.5, -56], [-44, 2.5, -16], [-60, 12, 26], [-54, 46, AXIS.z + 11], [-46.4, AXIS.y - 2, AXIS.z + 11]], 1.3, 'wireRed');
  W([[-15.5, 13.5, -67.4], [-30, 2.5, -52], [-50, 2.5, -14], [-64, 12, 18], [-56, 44, AXIS.z - 11], [-46.4, AXIS.y - 2, AXIS.z - 11]], 1.3, 'wireBlack');
  // signals to the ESP32-S3 header
  W([[61.5, AXIS.y + 30, AXIS.z + 6], [63, 60, AXIS.z + 8], [64, 4, AXIS.z + 12], [86, 2, -28], [80, 3, -66], [78, 8.6, -69.6]], 1.0, 'wireGrey');
  W([[1, AXIS.y + 24.4, AXIS.z - 6.3], [-4, AXIS.y + 20, AXIS.z - 14], [-8, 40, -4], [-6, 2.5, -30], [56, 2.5, -62], [66, 8.6, -69.6]], 1.0, 'wirePurple');
  W([[-31, AXIS.y + 17, AXIS.z - 17], [-40, 60, AXIS.z - 26], [-46, 3, -16], [-22, 2.5, -40], [54, 2.5, -63], [60, 8.6, -69.6]], 1.2, 'wireBlack');
  W([[-36.2, 9, -76.5], [-32, 2.5, -62], [44, 2.5, -63], [72, 8.6, -69.6]], 0.9, 'wireBlue');
  W([[30.4, 9, -84], [38, 2.5, -66], [48, 3, -67], [90, 8.6, -69.6]], 1.0, 'wireOrange');
  // USB to the backend computer, leaving the base
  W([[49.4, 9.4, -88], [38, 8, -99], [20, 2, -108], [4, -3, -114], [-6, -40, -118]], 1.9, 'usb');
}

/**
 * Build the rig. Returns the root group, its scene nodes (explode / spin transforms), the merged meshes with their component ids, the section-cap
 * meshes for the cutaway, the materials it created and a dispose() that frees everything it owns.
 */
export function buildRig({ clippingPlane = null } = {}) {
  const c = new Collector();
  buildMotor(c); buildBaseAndBracket(c); buildSensors(c); buildElectronics(c); buildHarness(c);

  const root = new Group(); root.name = 'torqva-rig';
  const nodes = {};
  for (const name of Object.keys(EXPLODE)) {
    const g = new Group(); g.name = name;
    g.userData.base = SPIN_NODES.includes(name) ? new Vector3(0, AXIS.y, AXIS.z) : new Vector3();
    g.position.copy(g.userData.base);
    nodes[name] = g; root.add(g);
  }
  const meshes = [], caps = [], materials = [], geometries = [];
  const unshift = new Matrix4().makeTranslation(0, -AXIS.y, -AXIS.z);
  for (const { node, part, mat, cut, geos } of c.groups.values()) {
    const flat = geos.map((g) => { const ng = g.index ? g.toNonIndexed() : g; for (const k of Object.keys(ng.attributes)) if (!['position', 'normal', 'uv'].includes(k)) ng.deleteAttribute(k); return ng; });
    const geo = mergeGeometries(flat, false);
    geos.forEach((g) => g.dispose()); flat.forEach((g) => g.dispose());
    if (SPIN_NODES.includes(node)) geo.applyMatrix4(unshift);
    geo.computeBoundingBox(); geo.computeBoundingSphere();
    const m = new MeshStandardMaterial({ ...MATERIALS[mat], envMapIntensity: 1 });
    if (cut && clippingPlane) m.clippingPlanes = [clippingPlane];
    m.userData.baseColor = m.color.clone();
    const mesh = new Mesh(geo, m);
    mesh.castShadow = node !== 'harness' || mat === 'usb';
    mesh.receiveShadow = true;
    mesh.userData = { part, node, mat, cut };
    nodes[node].add(mesh);
    meshes.push(mesh); materials.push(m); geometries.push(geo);
    if (cut && clippingPlane) {                                    // back faces of a cut closed solid read as its section
      const cm = new MeshBasicMaterial({ color: SECTION_COLOR, side: BackSide, clippingPlanes: [clippingPlane] });
      const cap = new Mesh(geo, cm); cap.visible = false; cap.userData = { part, node, cap: true };
      nodes[node].add(cap); caps.push(cap); materials.push(cm);
    }
  }
  return {
    root, nodes, meshes, caps, materials,
    dispose() { geometries.forEach((g) => g.dispose()); materials.forEach((m) => m.dispose()); },
  };
}
