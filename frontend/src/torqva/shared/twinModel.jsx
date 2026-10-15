// Illustrative 2.5D drawing of the TORQVA rig (RS-775 motor, BTS7960 driver, INA219, ADXL345, DS18B20, A3144 Hall sensor, ESP32-S3 with SH1106 OLED).
// Parts come from esp32/torqva_fw/lib/torqva_core/pinmap.h and docs/hardware.md. It is NOT a CAD model: proportions, sensor positions and wiring
// are drawn for readability and none of them is verified. Presentation only: nothing here reads, computes or sends anything.
import React, { useEffect, useRef, useState } from 'react';

export const VIEW = [0, 0, 1000, 560];

/** Where each selectable part sits in the drawing: hotspot centre and its callout box. */
export const PARTS = {
  hall: { x: 215, y: 241, label: [36, 132], leader: [186, 152] },
  accel: { x: 381, y: 171, label: [214, 62], leader: [364, 84] },
  temp: { x: 481, y: 171, label: [470, 62], leader: [520, 84] },
  controller: { x: 800, y: 136, label: [700, 14], leader: [800, 58] },
  driver: { x: 760, y: 404, label: [600, 486], leader: [700, 486] },
  ina: { x: 912, y: 401, label: [838, 296], leader: [912, 340] },
};
const LABEL_W = 150, LABEL_H = 44;

// Animation speed is the reported speed divided by this factor, so a 1500 rpm shaft turns once every 1.6 s instead of 25 times a second.
export const SPIN_SCALE = 40;
export const spinPeriod = (rpm) => Math.min(12, Math.max(0.6, (60 / rpm) * SPIN_SCALE));

const reducedMotion = () => { try { return !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches; } catch { return false; } };

/** Tween the viewBox towards `target` (zoom to a part, or back to the whole rig). */
function useViewBox(target) {
  const [vb, setVb] = useState(target);
  const cur = useRef(target);
  useEffect(() => {
    const from = cur.current;
    if (from.every((v, i) => v === target[i])) return undefined;
    if (reducedMotion() || typeof requestAnimationFrame !== 'function') { cur.current = target; setVb(target); return undefined; }
    let raf; const t0 = performance.now(), dur = 420;
    const ease = (p) => 1 - (1 - p) ** 3;
    const tick = (now) => {
      const p = Math.min(1, (now - t0) / dur);
      const next = from.map((v, i) => v + (target[i] - v) * ease(p));
      cur.current = next; setVb(next);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target[0], target[1], target[2], target[3]]); // eslint-disable-line react-hooks/exhaustive-deps
  return vb;
}

export function focusBox(id) {
  const p = PARTS[id];
  if (!p) return VIEW;
  const w = 520, h = 292;
  const x = Math.min(Math.max(p.x - w / 2, 0), VIEW[2] - w), y = Math.min(Math.max(p.y - h / 2, 0), VIEW[3] - h);
  return [x, y, w, h];
}

/** One callout: part name and its headline reading, joined to the hotspot by a leader line. */
function Callout({ id, title, value, tone, selected }) {
  const p = PARTS[id];
  const [lx, ly] = p.label;
  const [ax, ay] = p.leader;
  return (
    <g className={`tq-tw-callout tq-tw-tone-${tone}${selected ? ' is-sel' : ''}`} aria-hidden="true">
      <path className="tq-tw-leader" d={`M${ax},${ay} L${p.x},${p.y}`} />
      <rect x={lx} y={ly} width={LABEL_W} height={LABEL_H} rx="9" className="tq-tw-label-box" />
      <circle cx={lx + 14} cy={ly + 15} r="3.5" className="tq-tw-label-dot" />
      <text x={lx + 24} y={ly + 18} className="tq-tw-label-title">{title}</text>
      <text x={lx + 12} y={ly + 36} className="tq-tw-label-value">{value}</text>
    </g>
  );
}

/** Focusable hotspot over a part. Enter or Space selects it; the same key on the selected part returns to the whole view. */
function Hotspot({ id, name, tone, selected, onSelect, summary }) {
  const p = PARTS[id];
  const act = () => onSelect(selected ? null : id);
  return (
    <g className={`tq-tw-hot tq-tw-tone-${tone}${selected ? ' is-sel' : ''}`} role="button" tabIndex={0} aria-pressed={selected}
      aria-label={`${name}: ${summary}`} data-testid={`twin-hot-${id}`}
      onClick={act} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); act(); } }}>
      <circle cx={p.x} cy={p.y} r="26" className="tq-tw-hot-hit" />
      <circle cx={p.x} cy={p.y} r="15" className="tq-tw-hot-pulse" />
      <circle cx={p.x} cy={p.y} r="9" className="tq-tw-hot-ring" />
      <circle cx={p.x} cy={p.y} r="4" className="tq-tw-hot-core" />
    </g>
  );
}

const Defs = () => (
  <defs>
    <linearGradient id="tqtw-can" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" style={{ stopColor: 'var(--tq-tw-metal-lo)' }} />
      <stop offset=".18" style={{ stopColor: 'var(--tq-tw-metal-hi)' }} />
      <stop offset=".34" style={{ stopColor: 'var(--tq-tw-metal-mid)' }} />
      <stop offset=".78" style={{ stopColor: 'var(--tq-tw-metal-lo)' }} />
      <stop offset="1" style={{ stopColor: 'var(--tq-tw-metal-deep)' }} />
    </linearGradient>
    <linearGradient id="tqtw-bell" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" style={{ stopColor: 'var(--tq-tw-bell-lo)' }} />
      <stop offset=".25" style={{ stopColor: 'var(--tq-tw-bell-hi)' }} />
      <stop offset="1" style={{ stopColor: 'var(--tq-tw-bell-lo)' }} />
    </linearGradient>
    <radialGradient id="tqtw-face" cx=".38" cy=".32" r=".8">
      <stop offset="0" style={{ stopColor: 'var(--tq-tw-metal-hi)' }} />
      <stop offset=".7" style={{ stopColor: 'var(--tq-tw-metal-mid)' }} />
      <stop offset="1" style={{ stopColor: 'var(--tq-tw-metal-lo)' }} />
    </radialGradient>
    <linearGradient id="tqtw-shaft" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" style={{ stopColor: 'var(--tq-tw-metal-lo)' }} />
      <stop offset=".35" style={{ stopColor: 'var(--tq-tw-steel-hi)' }} />
      <stop offset="1" style={{ stopColor: 'var(--tq-tw-metal-deep)' }} />
    </linearGradient>
    <linearGradient id="tqtw-sink" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" style={{ stopColor: 'var(--tq-tw-sink-hi)' }} />
      <stop offset="1" style={{ stopColor: 'var(--tq-tw-sink-lo)' }} />
    </linearGradient>
    <radialGradient id="tqtw-shadow" cx=".5" cy=".5" r=".5">
      <stop offset="0" style={{ stopColor: 'var(--tq-tw-shadow)', stopOpacity: 0.55 }} />
      <stop offset="1" style={{ stopColor: 'var(--tq-tw-shadow)', stopOpacity: 0 }} />
    </radialGradient>
    <pattern id="tqtw-grid" width="24" height="24" patternUnits="userSpaceOnUse">
      <path d="M24 0H0V24" className="tq-tw-gridline" />
    </pattern>
    <clipPath id="tqtw-shaft-clip"><rect x="150" y="271" width="150" height="18" rx="2" /></clipPath>
  </defs>
);

/** Parts that are wires and boards, not sensors: drawn once, dimmed with the rest when something else is selected. */
function Wiring() {
  return (
    <g className="tq-tw-wires" aria-hidden="true">
      {/* power: supply -> INA219 (high side) -> BTS7960 -> motor terminals */}
      <path className="tq-tw-wire tq-tw-wire-pos" d="M890,478 C890,452 900,444 902,420" />
      <path className="tq-tw-wire tq-tw-wire-pos" d="M890,394 C868,388 860,404 842,404" />
      <path className="tq-tw-wire tq-tw-wire-neg" d="M930,478 C930,462 860,470 842,428" />
      <path className="tq-tw-wire tq-tw-wire-pos" d="M680,392 C650,388 652,262 626,254" />
      <path className="tq-tw-wire tq-tw-wire-neg" d="M680,416 C640,418 646,312 626,306" />
      {/* signals to the ESP32-S3 (thin, dashed) */}
      <path className="tq-tw-sig" d="M215,224 C215,120 560,120 712,150" />
      <path className="tq-tw-sig" d="M381,160 C390,110 600,100 712,128" />
      <path className="tq-tw-sig" d="M500,168 C540,150 640,170 712,170" />
      <path className="tq-tw-sig" d="M760,368 C760,300 780,250 780,190" />
      <path className="tq-tw-sig" d="M912,380 C912,300 860,230 860,190" />
    </g>
  );
}

function Motor({ spinning, period }) {
  return (
    <g className={`tq-tw-motor${spinning ? ' tq-tw-spinning' : ''}`} style={{ '--tw-period': `${period}s` }}>
      <ellipse cx="420" cy="398" rx="300" ry="26" fill="url(#tqtw-shadow)" />
      {/* rear end bell with cooling slots and the two brush terminals */}
      <g data-part="bell">
        <path d="M594,190 L640,190 A30,90 0 0 1 640,370 L594,370 Z" fill="url(#tqtw-bell)" className="tq-tw-edge" />
        {[214, 240, 266, 292, 318, 344].map((y) => <rect key={y} x="606" y={y} width="22" height="9" rx="4" className="tq-tw-vent" />)}
        <rect x="618" y="246" width="16" height="12" rx="2" className="tq-tw-terminal" />
        <rect x="618" y="300" width="16" height="12" rx="2" className="tq-tw-terminal" />
      </g>
      {/* can */}
      <rect x="300" y="180" width="298" height="200" fill="url(#tqtw-can)" className="tq-tw-edge" />
      <rect x="300" y="180" width="30" height="200" fill="url(#tqtw-bell)" opacity=".9" />
      <rect x="474" y="180" width="14" height="200" className="tq-tw-strap" />
      <g className="tq-tw-plate">
        <rect x="372" y="262" width="92" height="38" rx="5" />
        <text x="418" y="279" textAnchor="middle">RS-775</text>
        <text x="418" y="293" textAnchor="middle" className="tq-tw-plate-sub">24 V DC (illustrative)</text>
      </g>
      <path d="M300,196 L598,196" className="tq-tw-sheen" />
      {/* front face, bearing boss and the rotation marker */}
      <ellipse cx="300" cy="280" rx="34" ry="100" fill="url(#tqtw-face)" className="tq-tw-edge" />
      <ellipse cx="300" cy="226" rx="3" ry="7" className="tq-tw-hole" />
      <ellipse cx="300" cy="334" rx="3" ry="7" className="tq-tw-hole" />
      <g transform="translate(300 280) scale(0.34 1)">
        <circle r="72" className="tq-tw-ring" />
        <circle r="72" className="tq-tw-spin tq-tw-spin-dash" />
      </g>
      <ellipse cx="300" cy="280" rx="12" ry="34" className="tq-tw-boss" />
      {/* shaft (side view): the moving flats read as rotation */}
      <rect x="150" y="271" width="150" height="18" rx="2" fill="url(#tqtw-shaft)" className="tq-tw-edge" />
      <g clipPath="url(#tqtw-shaft-clip)">
        <g className="tq-tw-flats">
          {[-36, -18, 0, 18, 36].map((dy) => <rect key={dy} x="150" y={274 + dy} width="150" height="3" className="tq-tw-flat" />)}
        </g>
      </g>
      <ellipse cx="150" cy="280" rx="3.5" ry="9" className="tq-tw-shaft-end" />
    </g>
  );
}

function Sensors() {
  return (
    <g aria-hidden="true">
      {/* A3144 Hall sensor (TO-92) on a bracket, facing the shaft */}
      <g data-part="hall" className="tq-tw-part">
        <path d="M200,206 L230,206 L230,214 L208,214 L208,232" className="tq-tw-bracket" />
        <path d="M207,232 h16 v14 a8,6 0 0 1 -16,0 Z" className="tq-tw-ic" />
        <path d="M211,232 v-10 M215,232 v-10 M219,232 v-10" className="tq-tw-lead" />
      </g>
      {/* ADXL345 breakout on the can (mounting position unverified) */}
      <g data-part="accel" className="tq-tw-part">
        <rect x="360" y="161" width="42" height="20" rx="3" className="tq-tw-pcb-acc" />
        <rect x="375" y="166" width="11" height="10" rx="1.5" className="tq-tw-icchip" />
        {[364, 368, 372].map((x) => <circle key={x} cx={x} cy="177" r="1.4" className="tq-tw-pad" />)}
      </g>
      {/* DS18B20 probe under the strap */}
      <g data-part="temp" className="tq-tw-part">
        <rect x="460" y="164" width="44" height="13" rx="6.5" className="tq-tw-probe" />
        <path d="M466,168 h28" className="tq-tw-probe-sheen" />
      </g>
    </g>
  );
}

function Boards() {
  return (
    <g aria-hidden="true">
      {/* ESP32-S3 controller with the SH1106 OLED */}
      <g data-part="controller" className="tq-tw-part">
        <rect x="700" y="74" width="200" height="118" rx="10" className="tq-tw-pcb" />
        <rect x="820" y="88" width="66" height="54" rx="4" className="tq-tw-shield" />
        <path d="M828,98 h50 M828,106 h50 M828,114 h50" className="tq-tw-shield-line" />
        <rect x="714" y="88" width="88" height="48" rx="4" className="tq-tw-oled" />
        <text x="758" y="116" textAnchor="middle" className="tq-tw-oled-text">SH1106 OLED</text>
        {[0, 1, 2, 3].map((i) => <circle key={i} cx={720 + i * 14} cy="160" r="4" className="tq-tw-led" />)}
        <rect x="810" y="152" width="22" height="14" rx="2" className="tq-tw-usb" />
        {Array.from({ length: 16 }, (_, i) => <rect key={i} x={706 + i * 12} y="180" width="5" height="6" rx="1" className="tq-tw-pin" />)}
      </g>
      {/* BTS7960 / IBT-2 driver: red board under a finned heatsink */}
      <g data-part="driver" className="tq-tw-part">
        <rect x="680" y="372" width="162" height="70" rx="6" className="tq-tw-pcb-drv" />
        <rect x="698" y="380" width="126" height="44" rx="4" fill="url(#tqtw-sink)" className="tq-tw-edge" />
        {Array.from({ length: 9 }, (_, i) => <path key={i} d={`M${708 + i * 13},382 v40`} className="tq-tw-fin" />)}
        <rect x="684" y="386" width="10" height="12" rx="2" className="tq-tw-terminal" />
        <rect x="684" y="410" width="10" height="12" rx="2" className="tq-tw-terminal" />
      </g>
      {/* INA219 breakout in the supply line */}
      <g data-part="ina" className="tq-tw-part">
        <rect x="884" y="384" width="56" height="34" rx="4" className="tq-tw-pcb-ina" />
        <rect x="904" y="392" width="14" height="10" rx="1.5" className="tq-tw-icchip" />
        <rect x="888" y="390" width="10" height="10" rx="1.5" className="tq-tw-terminal" />
        <rect x="888" y="404" width="10" height="10" rx="1.5" className="tq-tw-terminal" />
      </g>
      {/* 24 V supply (not a sensor; not selectable) */}
      <g className="tq-tw-psu">
        <rect x="864" y="476" width="100" height="58" rx="8" />
        <text x="914" y="502" textAnchor="middle">24 V DC</text>
        <text x="914" y="518" textAnchor="middle" className="tq-tw-psu-sub">supply</text>
      </g>
    </g>
  );
}

/**
 * The rig drawing with interactive hotspots.
 * parts: [{ id, name, short, value, tone, summary }] for the selectable parts; selected: id | null; spinning/rpm drive the presentation-only shaft animation.
 */
export function MotorModel({ parts, selected, onSelect, spinning, rpm, zoom }) {
  const vb = useViewBox(zoom && selected ? focusBox(selected) : VIEW);
  const period = spinning && rpm > 0 ? spinPeriod(rpm) : 4;
  return (
    <svg className={`tq-tw-svg${selected ? ' has-sel' : ''}`} viewBox={vb.join(' ')} role="group" preserveAspectRatio="xMidYMid meet"
      aria-label="Illustrative drawing of the TORQVA motor rig. Select a part to see its readings." data-testid="twin-model" data-spinning={spinning ? 'yes' : 'no'}
      data-selected={selected || ''}>
      <Defs />
      <rect x="-200" y="-200" width="1400" height="960" fill="url(#tqtw-grid)" />
      <Wiring />
      <Motor spinning={spinning} period={period} />
      <Sensors />
      <Boards />
      {parts.map((p) => <Callout key={`c-${p.id}`} id={p.id} title={p.short} value={p.value} tone={p.tone} selected={selected === p.id} />)}
      {parts.map((p) => <Hotspot key={`h-${p.id}`} id={p.id} name={p.name} tone={p.tone} selected={selected === p.id} onSelect={onSelect} summary={p.summary} />)}
    </svg>
  );
}
