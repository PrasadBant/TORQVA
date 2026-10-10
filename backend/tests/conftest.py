"""Shared, expensive-to-build simulation stack (baseline detector, thermal model, hypotheses, C4 models)."""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from torqva.detection import BaselineDetector, ThermalTracker
from torqva.diagnostics import DiagnosticsModel
from torqva.hypotheses import HYPS, HypothesisModel
from torqva.schemas import Hypothesis
from torqva.sim import MotorSim

SPEEDS = [900, 1200, 1500, 1800, 2100]


@pytest.fixture(scope="session")
def stack():
    det, tt = BaselineDetector(), ThermalTracker()
    sim = MotorSim(0)
    data = []
    for sp in SPEEDS:
        sim.set_setpoint(sp); data += sim.run(90)
    assert tt.fit(data)
    tt.reset(data[0].housing)
    for w in data:
        tt.update(w)
    det.fit(data)

    def zs_for(h, sev, seed, sp=1500, n=30, pre=60):
        s = MotorSim(seed); s.set_setpoint(sp)
        s.run(pre if h != Hypothesis.COOLING_FAILURE else 400)
        s.inject(h, sev)
        ws = s.run(n if h != Hypothesis.COOLING_FAILURE else 600)
        tt.reset(ws[0].housing)
        out = []
        for w in ws:
            tt.update(w)
            sc = det.score(w)
            if sc.z is not None:
                out.append(sc.z)
        return out

    hm = HypothesisModel()
    samples = {h: [] for h in HYPS}
    for h in HYPS:
        for sev in (0.3, 0.5, 0.8):
            for seed in (101, 102):
                for sp in (1200, 1800):
                    samples[h] += zs_for(h, sev, seed, sp)[-20:]
    hm.fit(samples)
    dm = DiagnosticsModel()
    dm.learn(tt, seeds=(1, 2))
    return det, tt, hm, dm, zs_for


@pytest.fixture(params=["asyncio"])
def anyio_backend(request):
    """The TCP server is written against asyncio (asyncio.get_running_loop / start_server / StreamWriter) and the project's dependencies do not include trio.
    `@pytest.mark.anyio` tests therefore run on the asyncio backend only: a trio run would exercise asyncio-specific code outside an asyncio loop, which tests nothing real."""
    return request.param
