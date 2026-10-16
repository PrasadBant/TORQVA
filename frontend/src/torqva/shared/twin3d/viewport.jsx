// 3D viewport of the Digital Twin: toolbar, WebGL canvas (TwinEngine), DOM markers and measurement callouts. Loaded on demand by ../twin.jsx only when
// the browser has WebGL 2. Presentation only: it receives the already-mapped parts (values, provenance, tones, evidence alerts) and the reported
// motion, and it never fetches, computes a reading or sends a command. Markers and callouts are real DOM buttons, so every part stays reachable by
// keyboard and screen reader; their positions are written straight to the DOM on each rendered frame (no React render per frame).
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { RotateCcw, Maximize, Tag, MapPin, Gauge, Scissors, Focus, Expand, Layers, PenTool, AlertTriangle, Box } from 'lucide-react';
import { TwinEngine, PRESETS } from './engine.js';
import { layoutCallouts } from './overlay.js';
import { ProvBadge } from '../components.jsx';

const CARD_W = 170, CARD_H = 50;

function readTheme(el) {
  const cs = getComputedStyle(el);
  const v = (n, d) => cs.getPropertyValue(n).trim() || d;
  const dark = document.documentElement.getAttribute('data-theme') === 'dark' || !!el.closest('.tq-theme-dark');
  return { dark, accent: v('--tq-accent', '#2563EB'), crit: v('--tq-crit', '#C8222E'), stop: v('--tq-stop', '#C8222E'), warn: v('--tq-warn', '#A15C07'), info: v('--tq-accent', '#2563EB'), sim: v('--tq-sim', '#6941C6'),
    grid: dark ? '#262c34' : '#dde1e7', gridMajor: dark ? '#38404b' : '#c2c8d0', edge: dark ? '#cfd6df' : '#1d232b' };
}

function Tool({ on, onClick, icon: Icon, label, disabled, title, testid, short }) {
  return (
    <button type="button" className={`tq-t3-tool${on ? ' is-on' : ''}`} onClick={onClick} disabled={disabled} aria-pressed={on === undefined ? undefined : !!on}
      title={title || label} aria-label={label} data-testid={testid}>
      <Icon size={15} aria-hidden="true" /><span className="tq-t3-tool-text">{short || label}</span>
    </button>
  );
}

/**
 * items: [{ id, name, short, tone, value, summary, sensor, prov, tag, alert }] for every component; selected / onSelect: the shared selection;
 * motion: { spinning, rpm } as decided by the mode mapping; freshness: 'live' | 'stale' | 'none'; alerts: [{ part, tone, label }]; onFallback(reason).
 */
export default function TwinViewport({ items, selected, onSelect, motion, freshness, source, alerts, onFallback }) {
  const wrapRef = useRef(null), hostRef = useRef(null), hoverRef = useRef(null);
  const markerRefs = useRef({}), cardRefs = useRef({}), lineRefs = useRef({});
  const engineRef = useRef(null), selRef = useRef(selected), optsRef = useRef(null), alertIdx = useRef(0), snapRef = useRef(null);
  const motionRef = useRef(motion), alertsRef = useRef(alerts);
  motionRef.current = motion; alertsRef.current = alerts;
  const [status, setStatus] = useState('starting');
  const [gen, setGen] = useState(0);                     // bumped when a lost graphics context comes back: the engine is rebuilt
  const [hover, setHover] = useState(null);
  const [hint, setHint] = useState(false);
  const [preset, setPreset] = useState('iso');
  const wide = typeof window === 'undefined' || window.innerWidth >= 760;
  const [opts, setOpts] = useState({ labels: !wide, markers: true, overlays: wide, isolate: false, explode: false, cutaway: false, edges: false, ortho: false });
  selRef.current = selected; optsRef.current = opts;
  const byId = Object.fromEntries(items.map((i) => [i.id, i]));
  const itemsRef = useRef(byId); itemsRef.current = byId;

  // positions of markers, callouts and leader lines, written on every rendered frame
  const onProject = useCallback((pts, w, h) => {
    const o = optsRef.current;
    // labels that would overlap an already placed one are hidden (the selected part and front-facing parts are placed first)
    const order = pts.slice().sort((a, b) => (b.id === selRef.current) - (a.id === selRef.current) || a.back - b.back);
    const taken = [];
    for (const p of order) {
      const el = markerRefs.current[p.id];
      if (!el) continue;
      el.style.visibility = p.inView ? 'visible' : 'hidden';
      el.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px)`;
      el.classList.toggle('is-back', p.back);
      if (o.labels && p.inView) {
        const r = { x0: p.x - 12, y0: p.y - 12, x1: p.x + 30 + (itemsRef.current[p.id]?.short.length || 8) * 6.6, y1: p.y + 12 };
        const clash = taken.some((t) => r.x0 < t.x1 && r.x1 > t.x0 && r.y0 < t.y1 && r.y1 > t.y0);
        el.classList.toggle('no-label', clash);
        if (!clash) taken.push(r);
      }
    }
    const cards = o.overlays ? layoutCallouts(pts.filter((p) => p.inView && itemsRef.current[p.id]?.sensor), { w, h: h - 34, cardW: CARD_W, cardH: CARD_H }) : [];   // keep clear of the status chips along the bottom
    const placed = new Set(cards.map((c) => c.id));
    for (const c of cards) {
      const el = cardRefs.current[c.id], ln = lineRefs.current[c.id];
      if (el) { el.style.visibility = 'visible'; el.style.transform = `translate(${c.x.toFixed(1)}px, ${c.y.toFixed(1)}px)`; }
      if (ln) { const ex = c.side === 'left' ? c.x + CARD_W : c.x; ln.setAttribute('d', `M${ex.toFixed(1)},${(c.y + CARD_H / 2).toFixed(1)} L${c.ax.toFixed(1)},${c.ay.toFixed(1)}`); ln.style.visibility = 'visible'; }
    }
    for (const id of Object.keys(cardRefs.current)) if (!placed.has(id)) { const el = cardRefs.current[id]; if (el) el.style.visibility = 'hidden'; const ln = lineRefs.current[id]; if (ln) ln.style.visibility = 'hidden'; }
  }, []);

  const onCamera = useCallback((info) => {
    const el = wrapRef.current;
    if (!el) return;
    el.dataset.camera = `${info.az},${info.polar},${info.dist},${info.zoom}`;
    el.dataset.projection = info.ortho ? 'orthographic' : 'perspective';
    el.dataset.frames = String(info.frames); el.dataset.calls = String(info.calls); el.dataset.geometries = String(info.geometries);
  }, []);

  // engine lifecycle: one renderer per mounted viewport, fully disposed on unmount. After a lost graphics context comes back, a fresh engine on a new
  // canvas replaces the old one and continues from its camera, selection and view options.
  useEffect(() => {
    let engine;
    try {
      engine = new TwinEngine({
        host: hostRef.current, restore: gen > 0 ? snapRef.current : null,
        onPick: (id, { double }) => { if (double) { onSelect(id); return; } onSelect(selRef.current === id ? null : id); },
        onHover: (id, x, y) => { setHover(id); const t = hoverRef.current; if (t && id) t.style.transform = `translate(${Math.round(x + 14)}px, ${Math.round(y + 12)}px)`; },
        onProject, onCamera, onStatus: (st) => (st === 'restored' ? setGen((g) => g + 1) : setStatus(st)),
      });
    } catch (e) {
      onFallback?.(`The 3D renderer could not start (${e?.message || 'WebGL error'}).`);
      return undefined;
    }
    engineRef.current = engine;
    engine.setTheme(readTheme(wrapRef.current));
    if (gen > 0) {                                        // bring the replacement up to the current state at once
      engine.setSelection(selRef.current || null);
      engine.setMotion(motionRef.current.spinning, motionRef.current.rpm);
      engine.setStates(null, Object.fromEntries(alertsRef.current.map((a) => [a.part, a.tone])));
      engine.setOptions({ ...optsRef.current, inset: optsRef.current.overlays ? Math.round(CARD_W * 0.62) : 0 });
      engine.settle();
    }
    const mo = new MutationObserver(() => engine.setTheme(readTheme(wrapRef.current)));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
    return () => { mo.disconnect(); snapRef.current = engine.cameraState(); engine.dispose(); engineRef.current = null; };
  }, [gen]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { engineRef.current?.setSelection(selected || null); }, [selected]);
  useEffect(() => { engineRef.current?.setMotion(motion.spinning, motion.rpm); }, [motion.spinning, motion.rpm]);
  const alertKey = alerts.map((a) => `${a.part}:${a.tone}`).join('|');
  useEffect(() => { engineRef.current?.setStates(null, Object.fromEntries(alerts.map((a) => [a.part, a.tone]))); }, [alertKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const e = engineRef.current; if (!e) return; e.setOptions({ ...opts, inset: opts.overlays ? Math.round(CARD_W * 0.62) : 0 }); e.invalidate(); }, [opts]);
  useEffect(() => { engineRef.current?.invalidate(); }, [items.length, selected]);

  // plain scrolling over the model scrolls the page; Ctrl / Cmd + scroll (and trackpad pinch) zooms
  useEffect(() => {
    const el = hostRef.current;
    let t;
    const onWheel = (e) => { if (e.ctrlKey || e.metaKey) return; e.stopPropagation(); setHint(true); clearTimeout(t); t = setTimeout(() => setHint(false), 1400); };
    el.addEventListener('wheel', onWheel, { capture: true });
    return () => { el.removeEventListener('wheel', onWheel, { capture: true }); clearTimeout(t); };
  }, []);

  const set = (k) => setOpts((o) => ({ ...o, [k]: !o[k] }));
  const eng = () => engineRef.current;
  const goPreset = (p) => { setPreset(p); eng()?.view(p); };
  const onKeyDown = (e) => {
    const en = eng(); if (!en || e.target !== e.currentTarget) return;
    const k = e.key, step = e.shiftKey ? 0.12 : 8;
    const map = {
      ArrowLeft: () => (e.shiftKey ? en.nudge({ pan: [-step, 0] }) : en.nudge({ orbit: [-step, 0] })),
      ArrowRight: () => (e.shiftKey ? en.nudge({ pan: [step, 0] }) : en.nudge({ orbit: [step, 0] })),
      ArrowUp: () => (e.shiftKey ? en.nudge({ pan: [0, step] }) : en.nudge({ orbit: [0, step] })),
      ArrowDown: () => (e.shiftKey ? en.nudge({ pan: [0, -step] }) : en.nudge({ orbit: [0, -step] })),
      '+': () => en.nudge({ zoom: 1.15 }), '=': () => en.nudge({ zoom: 1.15 }), '-': () => en.nudge({ zoom: 1 / 1.15 }),
      0: () => goPreset('iso'), Home: () => goPreset('iso'), f: () => en.fit(), F: () => en.fit(),
      1: () => goPreset('iso'), 2: () => goPreset('front'), 3: () => goPreset('side'), 4: () => goPreset('top'),
    };
    if (map[k]) { e.preventDefault(); map[k](); }
  };
  const nextEvidence = () => {
    if (!alerts.length) return;
    const a = alerts[alertIdx.current % alerts.length]; alertIdx.current += 1;
    onSelect(a.part); eng()?.focus(a.part);
  };

  const sensors = items.filter((i) => i.sensor);
  const hv = hover ? byId[hover] : null;
  const banner = freshness === 'stale' ? 'Telemetry stale: the model shows the last values received, not live ones. The shaft is drawn still.'
    : freshness === 'none' ? (source === 'SIMULATION' ? 'No simulation data: the model shows geometry only.' : 'No live device data: the model shows geometry only, not the state of the rig.') : null;

  return (
    <div className="tq-t3" ref={wrapRef} data-testid="twin-model" data-renderer="webgl" data-status={status} data-spinning={motion.spinning ? 'yes' : 'no'} data-selected={selected || ''}
      data-explode={opts.explode ? 'on' : 'off'} data-cutaway={opts.cutaway ? 'on' : 'off'} data-isolate={opts.isolate ? 'on' : 'off'}>
      <div className="tq-t3-toolbar" role="toolbar" aria-label="3D view tools">
        <div className="tq-t3-group" role="group" aria-label="Camera">
          <Tool icon={RotateCcw} label="Reset view" short="Reset" onClick={() => goPreset('iso')} testid="t3-reset" />
          <Tool icon={Maximize} label="Fit assembly to view" short="Fit" onClick={() => eng()?.fit()} testid="t3-fit" />
          <Tool icon={Focus} label="Focus the selected part" short="Focus" disabled={!selected} title={selected ? 'Frame the selected part' : 'Select a part first'} onClick={() => eng()?.focus(selected)} testid="t3-focus" />
        </div>
        <div className="tq-t3-group tq-t3-seg" role="group" aria-label="View presets">
          {Object.entries(PRESETS).map(([k, p]) => (
            <button key={k} type="button" className={`tq-t3-seg-btn${preset === k ? ' is-on' : ''}`} aria-pressed={preset === k} onClick={() => goPreset(k)} title={`${p.label} view`} data-testid={`t3-view-${k}`}>{k === 'side' ? 'Side' : p.label}</button>
          ))}
          <button type="button" className={`tq-t3-seg-btn${opts.ortho ? ' is-on' : ''}`} aria-pressed={opts.ortho} onClick={() => set('ortho')} title="Orthographic projection (no perspective) for technical inspection" data-testid="t3-ortho">Ortho</button>
        </div>
        <div className="tq-t3-group" role="group" aria-label="Display">
          <Tool icon={MapPin} label="Sensor markers" short="Markers" on={opts.markers} onClick={() => set('markers')} testid="t3-markers" />
          <Tool icon={Tag} label="Part labels" short="Labels" on={opts.labels} onClick={() => set('labels')} testid="t3-labels" />
          <Tool icon={Gauge} label="Measurement callouts" short="Readouts" on={opts.overlays} onClick={() => set('overlays')} testid="t3-overlays" />
          <Tool icon={PenTool} label="Technical edges" short="Edges" on={opts.edges} onClick={() => set('edges')} testid="t3-edges" />
        </div>
        <div className="tq-t3-group" role="group" aria-label="Inspect">
          <Tool icon={Box} label="Isolate the selected part" short="Isolate" on={opts.isolate} disabled={!selected && !opts.isolate} title={selected ? 'Show only the selected part' : 'Select a part first'} onClick={() => set('isolate')} testid="t3-isolate" />
          <Tool icon={Expand} label="Exploded view" short="Explode" on={opts.explode} onClick={() => set('explode')} testid="t3-explode" />
          <Tool icon={Scissors} label="Section view through the motor axis" short="Section" on={opts.cutaway} onClick={() => set('cutaway')} testid="t3-cutaway" />
          {alerts.length > 0 && <Tool icon={AlertTriangle} label={`Inspect evidence (${alerts.length} part${alerts.length > 1 ? 's' : ''})`} short={`Evidence ${alerts.length}`} onClick={nextEvidence} testid="t3-evidence" />}
        </div>
      </div>

      <div className={`tq-t3-host${freshness !== 'live' ? ' is-dim' : ''}`} ref={hostRef} tabIndex={0} role="group" aria-roledescription="3D viewport"
        aria-label="Interactive 3D model of the TORQVA rig. Arrow keys orbit, Shift plus arrow keys pan, plus and minus zoom, 1 to 4 choose a view, F fits the assembly."
        aria-describedby="t3-help" onKeyDown={onKeyDown}>
        <svg className="tq-t3-lines" aria-hidden="true">{opts.overlays && sensors.map((i) => <path key={i.id} ref={(el) => { lineRefs.current[i.id] = el; }} className={`tq-tw-tone-${i.tone}${selected === i.id ? ' is-sel' : ''}`} />)}</svg>
        {opts.overlays && sensors.map((i) => (
          <button key={`c-${i.id}`} type="button" ref={(el) => { cardRefs.current[i.id] = el; }} className={`tq-t3-card tq-tw-tone-${i.tone}${selected === i.id ? ' is-sel' : ''}`}
            onClick={() => onSelect(selected === i.id ? null : i.id)} aria-label={`${i.name}: ${i.summary}`} data-testid={`t3-card-${i.id}`} tabIndex={-1}>
            <span className="tq-t3-card-name"><span className="tq-tw-dot" aria-hidden="true" />{i.short}</span>
            <span className="tq-t3-card-val tq-num">{i.value}</span>
            {(i.prov || i.tag) && <span className="tq-t3-card-meta">{i.prov && <ProvBadge kind={i.prov} />}{i.tag && <span className={`tq-tw-tag tq-tw-tag-${i.status}`}>{i.tag}</span>}</span>}
          </button>
        ))}
        {opts.markers && sensors.map((i) => (
          <button key={`h-${i.id}`} type="button" ref={(el) => { markerRefs.current[i.id] = el; }} className={`tq-t3-hot tq-tw-tone-${i.tone}${selected === i.id ? ' is-sel' : ''}`}
            aria-pressed={selected === i.id} aria-label={`${i.name}: ${i.summary}`} data-testid={`twin-hot-${i.id}`} onClick={() => onSelect(selected === i.id ? null : i.id)}>
            <span className="tq-t3-hot-ring" aria-hidden="true" />
            {i.alert && <span className={`tq-t3-hot-alert tq-tw-tone-${i.alert}`} aria-hidden="true">!</span>}
            {opts.labels && <span className="tq-t3-hot-label">{i.short}</span>}
          </button>
        ))}
        {hv && <div className="tq-t3-hover" ref={hoverRef} role="presentation"><strong>{hv.name}</strong>{hv.sensor ? <span className="tq-num">{hv.value}</span> : <span>{hv.part}</span>}</div>}
        {banner && <div className={`tq-t3-banner tq-${freshness === 'stale' ? 'warn' : 'off'}`} role="status" data-testid="t3-banner">{banner}</div>}
        {hint && <div className="tq-t3-hint" role="status">Hold Ctrl (⌘ on Mac) and scroll, or pinch, to zoom</div>}
        {status === 'lost' && (
          <div className="tq-t3-lost" role="alert">
            <p>The graphics context was lost. The browser is trying to restore it.</p>
            <button type="button" className="tq-btn tq-btn-sm" onClick={() => onFallback?.('The 3D renderer lost its graphics context.')}>Show the 2D drawing</button>
          </div>
        )}
        <div className="tq-t3-foot">
          <span className="tq-t3-chip"><Layers size={12} aria-hidden="true" />{status === 'ready' ? '3D · WebGL 2' : status === 'lost' ? '3D · context lost' : '3D · starting'}</span>
          <span className="tq-t3-chip">{opts.ortho ? 'Orthographic' : 'Perspective'}</span>
          {opts.cutaway && <span className="tq-t3-chip tq-t3-chip-cut">Section: motor housing cut through its axis</span>}
          {opts.explode && <span className="tq-t3-chip">Exploded · wiring hidden</span>}
        </div>
      </div>
      <p id="t3-help" className="tq-t3-help">Drag to orbit · right-drag or Shift-drag to pan · Ctrl + scroll or pinch to zoom · double-click a part to frame it · keyboard: arrows, Shift + arrows, + / −, 1–4, F.</p>
    </div>
  );
}
