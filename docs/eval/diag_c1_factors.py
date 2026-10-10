"""Phase 8 step-1 diagnosis: which nuisance factor makes the UNCHANGED C1 flag healthy runs? (simulation only)"""
import sys
sys.path.insert(0, "backend")
import numpy as np
from torqva.detection import BaselineDetector, ThermalTracker
from torqva.sim import FEATURES, REGIMES, MotorSim, Regime

SPEEDS = [900, 1200, 1500, 1800, 2100]
det, tt = BaselineDetector(), ThermalTracker()
sim = MotorSim(0); data = []
for sp in SPEEDS:
    sim.set_setpoint(sp); data += sim.run(90)
tt.fit(data); tt.reset(data[0].housing)
for w in data:
    tt.update(w)
det.fit(data)
print("bins", det.coverage(), "thresholds", {b: round(m.threshold, 1) for b, m in det.bins.items()})


def run(label, seed, sp=1650, regime="baseline", tweak=None):
    s = MotorSim(seed, regime=REGIMES[regime])
    if tweak:
        tweak(s)
    s.housing = s.ambient_c
    s.set_setpoint(sp); ws = s.run(300)[20:]
    tt.reset(ws[0].housing); sc = []
    for w in ws:
        tt.update(w); sc.append(det.score(w))
    ok = [x for x in sc if x.z is not None]
    rate = np.mean([x.anomalous for x in ok])
    mz = np.mean([np.abs(x.z) for x in ok], axis=0)
    top = sorted(zip(FEATURES, mz), key=lambda t: -t[1])[:3]
    return rate, top


def agg(label, **kw):
    rs, tops = [], np.zeros(len(FEATURES))
    for seed in (9301, 9302, 9303):
        for sp in (1350, 1650, 1950):
            r, _ = run(label, seed, sp, **kw)
            rs.append(r)
    print(f"{label:34s} window false-alarm {np.mean(rs):6.1%}   (worst session {np.max(rs):.0%})")


agg("baseline")
for m in (1.5, 2.0, 3.0):
    agg(f"noise x{m}", tweak=None, regime="baseline") if False else None
for m in (1.5, 2.0, 3.0):
    r = Regime(f"n{m}", noise_mult=m); REGIMES[r.name] = r
    agg(f"noise x{m}", regime=r.name)
for g in (0.9, 1.1, 1.25):
    agg(f"vib gain {g}", tweak=lambda s, g=g: setattr(s, "vib_gain", g))
for v in (-0.25, 0.25):
    agg(f"supply offset {v:+}V", tweak=lambda s, v=v: setattr(s, "supply_off", v))
for c in (-0.03, 0.03):
    agg(f"current offset {c:+}A", tweak=lambda s, c=c: setattr(s, "current_off", c))
for a in (18.0, 26.0, 30.0):
    agg(f"ambient {a}C", tweak=lambda s, a=a: setattr(s, "ambient_c", a))
agg("session_shift (all offsets)", regime="session_shift")
agg("hard", regime="hard")

# per-feature mean |z| for the session_shift regime to attribute the cause
zs = []
for seed in range(9301, 9309):
    s = MotorSim(seed, regime=REGIMES["session_shift"]); s.set_setpoint(1650); ws = s.run(300)[20:]
    tt.reset(ws[0].housing)
    for w in ws:
        tt.update(w); sc = det.score(w)
        if sc.z is not None:
            zs.append(sc.z)
zs = np.array(zs)
print("session_shift mean|z| per feature:", {f: round(float(v), 2) for f, v in zip(FEATURES, np.abs(zs).mean(0))})
