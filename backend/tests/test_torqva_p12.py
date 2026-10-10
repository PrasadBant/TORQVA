"""Phase 12: fresh-seed confirmation study hygiene, evaluation-run selection, and the API's honest handling of history. Simulation only."""
import ast
import inspect
import json
import os
import time

import pytest

from torqva import c2cov_study as c2s, c4cal_study as c4s, generalization_study as gs

DOCS = os.path.join(os.path.dirname(__file__), "..", "..", "docs", "eval")


def test_conf_partition_is_registered_only_inside_the_context_and_is_disjoint():
    assert "CONF" not in c2s.BASES and "CONF" not in c4s.BASES
    with gs.conf_partitions():
        c2s.assert_seed_hygiene(); c4s.assert_seed_hygiene()          # no duplicates, no cross-partition overlap, no offset-stream collision, no overlap with earlier phases
        conf2 = set(c2s.seeds_of("CONF", c2s.RNAMES)); conf4 = set(c4s.all_seeds("CONF", c4s.RNAMES, c4s.HYPS))
        for p in ("CAL", "VAL", "TEST", "VAL2", "TEST2"):
            assert not conf2 & set(c2s.seeds_of(p, c2s.RNAMES))
        for p in ("CAL", "VAL", "TEST"):
            assert not conf4 & set(c4s.all_seeds(p, c4s.RNAMES, c4s.HYPS))
        assert not conf2 & conf4
    assert "CONF" not in c2s.BASES and "CONF" not in c4s.BASES and "CONF" not in c2s.K_COUNT and "CONF" not in c4s.K_COUNT


def test_conf_partition_is_restored_even_when_the_body_raises():
    with pytest.raises(RuntimeError):
        with gs.conf_partitions():
            raise RuntimeError("boom")
    assert "CONF" not in c2s.BASES and "CONF" not in c4s.BASES


def test_calibration_and_selection_code_never_touch_the_conf_partition():
    for mod in (c2s, c4s):
        for fn in ("stage_validate",):
            src = inspect.getsource(getattr(mod, fn))
            assert "CONF" not in src, (mod.__name__, fn)
    # the confirmation study only READS the frozen selection files; it never writes them
    tree = ast.parse(inspect.getsource(gs))
    writes = [n for n in ast.walk(tree) if isinstance(n, ast.Call) and getattr(n.func, "id", "") == "open" and len(n.args) > 1 and getattr(n.args[1], "value", "") == "w"]
    assert len(writes) == 1                                           # exactly one output: generalization_phase12_final.json


def test_committed_confirmation_artifact_is_fresh_and_adopts_nothing():
    g = json.load(open(os.path.join(DOCS, "generalization_phase12_final.json")))
    assert g["c2"]["n_test_cases"] == g["c2"]["unique_seeds"] and g["c4"]["n_test_sessions"] == g["c4"]["unique_seeds"]
    assert g["c4"]["candidate_vs_phase10_guard"]["adopt"] is False
    assert g["data_provenance"] == "SIMULATED" and "Nothing was re-fitted" in g["WARNING"]
    for nm, v in g["c4"]["acceptance_bar_on_fresh_seeds"].items():
        assert v["meets_bar"] is False, nm                            # no variant meets the pre-registered bar on fresh seeds; the artifact must say so
    for k, v in g["c2"]["variants"].items():                          # abstention and supported fraction are reported for every variant and regime
        assert set(v["abstention_by_regime"]) == set(v["supported_fraction_by_regime"])


def test_latest_evaluation_run_selection_does_not_depend_on_file_modification_time():
    import hashlib
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from torqva.api import create_router
    from torqva.auth import TokenAuth
    from torqva.service import SimulationService
    app = FastAPI()
    app.include_router(create_router(SimulationService(), TokenAuth([{"sha256": hashlib.sha256(b"v-tok").hexdigest(), "user": "v", "role": "viewer"}])))
    c = TestClient(app)
    H = {"Authorization": "Bearer v-tok"}
    run1 = os.path.join(DOCS, "eval_sim_run1.json"); st = os.stat(run1)
    try:
        os.utime(run1, (time.time() + 3600, time.time() + 3600))      # make the OLDER run look newest by mtime
        r = c.get("/api/torqva/evaluation/latest", headers=H)
        assert r.status_code == 200
        j = r.json()
        assert j["file"] == "eval_sim_run2.json", j["file"]
        files = [x["file"] for x in j["available_runs"]]
        assert files == sorted(files) and "eval_sim_run1.json" in files
    finally:
        os.utime(run1, (st.st_atime, st.st_mtime))
