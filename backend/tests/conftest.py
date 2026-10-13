"""Shared, expensive-to-build simulation stack (baseline detector, thermal model, hypotheses, C4 models)."""
import os
import sys
import tempfile
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

# Hardware isolation for the WHOLE session, set at import time. The autouse fixture below repeats it per test, but module- and session-scoped
# fixtures (for example a module-wide SimulationService) are created before any function-scoped fixture runs, so without this they would start
# the USB auto-connector (scan=True), inherit a device port or the unlock flag from the shell, and read the operator's real commissioning record.
_ISOLATED = tempfile.mkdtemp(prefix="torqva-tests-")
for _k in ("TORQVA_DEVICE_PORT", "TORQVA_FORCE_UNLOCK"):
    os.environ.pop(_k, None)
os.environ["TORQVA_AUTOCONNECT"] = "0"
os.environ["TORQVA_COMMISSIONING_FILE"] = os.path.join(_ISOLATED, "commissioning.json")
os.environ["TORQVA_DEVICE_KEYS_FILE"] = os.path.join(_ISOLATED, "device_keys.json")

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


@pytest.fixture(autouse=True)
def _isolated_commissioning_file(tmp_path, monkeypatch):
    """Tests never read or write the operator's real commissioning record."""
    monkeypatch.setenv("TORQVA_AUTOCONNECT", "0")                     # tests never scan or open real ports
    monkeypatch.setenv("TORQVA_COMMISSIONING_FILE", str(tmp_path / "commissioning.json"))
    monkeypatch.setenv("TORQVA_DEVICE_KEYS_FILE", str(tmp_path / "device_keys.json"))
