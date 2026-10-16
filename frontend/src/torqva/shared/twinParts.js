// Component metadata for the Digital Twin: one stable id per physical component, what it is, what it measures and where the 3D model places it.
// Pure data, shared by the 3D scene (twin3d/), the inspection panel and the tests. A future CAD model can replace the procedural geometry and keep
// these ids, anchors and explode vectors. Positions are in millimetres in the rig frame: x along the motor shaft (towards the disc), y up from the
// top of the base plate, z away from the viewer of the front view (the electronics side is -z).
//
// Evidence: parts and interfaces from esp32/torqva_fw/lib/torqva_core/pinmap.h and docs/hardware.md; the disc + magnet + Hall arrangement and the
// base from docs/TORQVA_WIRING.md (rig build notes); the RS-775 envelope (Ø42 mm can, 5 mm shaft) is the motor family's typical published size.
// None of the positions is measured on the real rig and the wiring is not verified, so the model is ILLUSTRATIVE, not a CAD-accurate twin.

/** Shaft axis of the motor in the rig frame (mm). */
export const AXIS = { y: 58, z: 25 };

/** Exploded-view offsets (mm at full explosion) per scene node. Everything that turns moves only along the shaft axis. */
export const EXPLODE = {
  rearBell: [-48, 0, 0], can: [0, 64, 0], stator: [0, 64, 0], rotor: [0, 0, 0], disc: [50, 0, 0], hall: [84, 0, 0],
  accel: [0, 100, 0], temp: [0, 92, -22], base: [0, 0, 0], bracket: [0, 0, 0],
  driver: [0, 36, 0], ina: [0, 44, 0], controller: [0, 40, 0], oled: [0, 52, 0], psu: [0, 26, 0], harness: [0, 0, 0],
};

// kind: sensor | actuator | controller | structure | power | wiring. `node` is the scene node whose explode offset moves the anchor.
// anchor: where the marker sits on the part; normal: its outward direction (used to dim markers on the far side of the model).
export const COMPONENTS = [
  { id: 'hall', kind: 'sensor', name: 'Speed sensor', part: 'A3144 Hall-effect sensor', node: 'hall', anchor: [55.5, 88, AXIS.z], normal: [1, 0.25, 0.2],
    role: 'Switches once per revolution as the magnet in the disc passes, so the firmware can time the pulses and report shaft speed (rpm).',
    placement: 'On a post facing the disc face, a few millimetres from the magnet path (build notes: 2–5 mm gap). Not measured on the rig.' },
  { id: 'temp', kind: 'sensor', name: 'Housing temperature', part: 'DS18B20 one-wire probe', node: 'temp', anchor: [-14, AXIS.y + 17.5, AXIS.z - 17.5], normal: [0, 0.7, -0.7],
    role: 'Digital temperature probe held against the motor can; a second probe, if fitted, would read ambient.',
    placement: 'Strapped to the can. The real position is not documented; drawn on the upper quarter facing the electronics.' },
  { id: 'accel', kind: 'sensor', name: 'Accelerometer', part: 'ADXL345 accelerometer', node: 'accel', anchor: [10, AXIS.y + 23.6, AXIS.z], normal: [0, 1, -0.15],
    role: 'Reports raw 3-axis acceleration including gravity (about 1 g at rest). The firmware computes no vibration RMS.',
    placement: 'Mounting position not verified; drawn on top of the can.' },
  { id: 'ina', kind: 'sensor', name: 'Voltage and current', part: 'INA219 current / voltage monitor', node: 'ina', anchor: [-47, 8, -69], normal: [0, 1, -0.3],
    role: 'High-side monitor in the 24 V motor supply: bus voltage and shunt current. The firmware computes power from the two.',
    placement: 'In the supply line between the 24 V supply and the motor driver (docs/HARDWARE_WIRING.md).' },
  { id: 'driver', kind: 'actuator', name: 'Motor driver', part: 'BTS7960 / IBT-2 driver', node: 'driver', anchor: [5, 30, -75], normal: [0, 1, -0.3],
    role: 'H-bridge that drives the motor from the PWM duty the firmware commands. Forward only: the firmware never drives LPWM.',
    placement: 'On the base beside the motor; wiring from pinmap.h, not verified.' },
  { id: 'controller', kind: 'controller', name: 'Controller', part: 'ESP32-S3 with SH1106 OLED', node: 'controller', anchor: [84, 12, -82], normal: [0, 1, -0.3],
    role: 'Runs the TORQVA firmware: reads the sensors, enforces the safety monitor and talks to the backend over USB serial. The OLED is annunciation only.',
    placement: 'ESP32-S3 DevKitC-1 class board on stand-offs, OLED on a small stand. Layout illustrative.' },
  { id: 'motor', kind: 'structure', name: 'DC motor', part: 'RS-775 24 V brushed DC motor', node: 'can', anchor: [-24, AXIS.y + 15, AXIS.z - 15], normal: [0, 0.7, -0.7],
    role: 'Permanent-magnet brushed motor: steel can with two ferrite magnets, a wound armature, commutator and carbon brushes in the rear end bell.',
    placement: 'Bolted through its front face to an angle bracket on the base. Internals are drawn from the motor type, not from this unit.', related: ['hall', 'ina', 'temp', 'accel'] },
  { id: 'shaft', kind: 'structure', name: 'Shaft and disc', part: 'Output shaft, hub and disc with magnet', node: 'disc', anchor: [51, AXIS.y - 26, AXIS.z - 26], normal: [0.8, -0.2, -0.5],
    role: 'The rotating output: 5 mm shaft, clamping hub and a disc carrying the magnet the Hall sensor sees.',
    placement: 'Disc size is illustrative. Rotation direction depends on the (unverified) motor polarity and is drawn one way only.', related: ['hall'] },
  { id: 'base', kind: 'structure', name: 'Base and bracket', part: 'Rigid base plate and motor bracket', node: 'base', anchor: [-150, 0, 60], normal: [0, 1, 0],
    role: 'Rigid base the motor is screwed to, clamped to the bench (build notes). Material and size are illustrative.',
    placement: 'The build notes call for plywood, MDF or metal; drawn as a dark plate.' },
  { id: 'psu', kind: 'power', name: '24 V supply', part: '24 V DC motor supply', node: 'psu', anchor: [-120, 38, -75], normal: [0, 1, -0.3],
    role: 'Separate, current-limited 24 V supply for the motor. Logic is powered from USB. Not monitored by the twin except through the INA219.',
    placement: 'Drawn on the base for compactness; in practice a bench supply.', related: ['ina'] },
  { id: 'harness', kind: 'wiring', name: 'Wiring', part: 'Power and signal wiring', node: 'harness', anchor: [-75, 3, -20], normal: [0, 1, -0.3],
    role: 'Power: supply → INA219 (high side) → BTS7960 → motor terminals. Signals: each sensor and the driver to the ESP32-S3.',
    placement: 'Routes are drawn for readability. The wiring of the real rig is not verified; it is hidden in the exploded view.', related: ['ina', 'driver', 'controller'] },
];

export const COMPONENT = Object.fromEntries(COMPONENTS.map((c) => [c.id, c]));
/** Components that carry no sensor reading of their own (selectable for identification only). */
export const STRUCTURE_IDS = COMPONENTS.filter((c) => !['sensor', 'actuator', 'controller'].includes(c.kind)).map((c) => c.id);
export const KIND_LABEL = { sensor: 'Sensor', actuator: 'Actuator (motor driver)', controller: 'Controller', structure: 'Mechanical part', power: 'Power supply', wiring: 'Wiring' };

/** Where a component's marker is at explode factor `f` (0 assembled, 1 fully exploded). */
export function anchorAt(id, f = 0) {
  const c = COMPONENT[id];
  if (!c) return null;
  const e = EXPLODE[c.node] || [0, 0, 0];
  return [c.anchor[0] + e[0] * f, c.anchor[1] + e[1] * f, c.anchor[2] + e[2] * f];
}

// Animation speed is the reported speed divided by this factor, so a 1500 rpm shaft turns once every 1.6 s instead of 25 times a second.
export const SPIN_SCALE = 40;
/** Presentation angular velocity (rad/s) for a reported speed; 0 for anything that is not a finite positive number. */
export const spinRate = (rpm) => (typeof rpm === 'number' && Number.isFinite(rpm) && rpm > 0 ? ((2 * Math.PI * rpm) / 60) / SPIN_SCALE : 0);
/** Advance the drawn shaft angle by one frame. Driven by elapsed time, so the rate does not depend on the frame rate; long gaps are clamped. */
export function advanceAngle(angle, rpm, dtSeconds) {
  const dt = Math.min(Math.max(dtSeconds || 0, 0), 0.1);
  return (angle + spinRate(rpm) * dt) % (2 * Math.PI);
}
