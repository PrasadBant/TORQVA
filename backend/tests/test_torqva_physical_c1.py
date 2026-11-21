import math
from torqva.physical_adapter import (
    PhysicalWindow,
    measured_c1_gaps,
    measured_c1_window,
    compute_physical_diagnostics,
)


def test_measured_c1_window_and_gaps():
    # 1. Complete physical window with measured signals (no vibration RMS)
    w = PhysicalWindow(
        t_unix=100.0,
        values={
            "rpm": 1200.0,
            "voltage": 24.0,
            "current": 1.5,
            "power": 36.0,
            "housing": 35.0,
            "ambient": 22.0,
        },
        valid={
            "rpm": True,
            "voltage": True,
            "current": True,
            "power": True,
            "housing": True,
            "ambient": True,
        },
    )
    gaps = measured_c1_gaps(w)
    assert gaps == []
    win = measured_c1_window(w)
    assert win is not None
    assert win["rpm"] == 1200.0
    assert win["current"] == 1.5
    assert win["power"] == 36.0
    assert "vib_rms" not in win  # No vibration RMS needed!

    # 2. If a measured signal is invalid/missing -> gap reported, window None (UNAVAILABLE)
    w_bad = PhysicalWindow(
        t_unix=100.0,
        values={"rpm": 1200.0, "voltage": None, "current": 1.5, "power": None, "housing": 35.0},
        valid={"rpm": True, "voltage": False, "current": True, "power": False, "housing": True},
    )
    assert "voltage" in measured_c1_gaps(w_bad)
    assert measured_c1_window(w_bad) is None


def test_physical_diagnostics_without_vibration_rms():
    # Snapshot without accelerometer / vibration
    snapshot = {
        "values": {
            "rpm": {"value": 1200.0, "valid": True},
            "setpoint": {"value": 1200.0, "valid": True},
            "voltage": {"value": 24.0, "valid": True},
            "current": {"value": 0.2, "valid": True},  # normal no-load
            "housing": {"value": 28.0, "valid": True},
            "ambient": {"value": 24.0, "valid": True},
        }
    }
    diag = compute_physical_diagnostics(snapshot)
    assert diag["c1"]["status"] == "ACTIVE"
    assert diag["c1"]["anomalous"] is False
    assert diag["c1"]["score"] < 1.0

    # Elevated current / friction without vibration
    snapshot_high_load = {
        "values": {
            "rpm": {"value": 1200.0, "valid": True},
            "setpoint": {"value": 1200.0, "valid": True},
            "voltage": {"value": 24.0, "valid": True},
            "current": {"value": 2.2, "valid": True},  # high overload current
            "housing": {"value": 60.0, "valid": True},  # elevated temp
            "ambient": {"value": 24.0, "valid": True},
        }
    }
    diag_high = compute_physical_diagnostics(snapshot_high_load)
    assert diag_high["c1"]["status"] == "ACTIVE"
    assert diag_high["c1"]["anomalous"] is True
    assert diag_high["c1"]["score"] >= 1.0
    top_hyp = diag_high["c1"]["hypotheses"][0]["hypothesis"]
    assert top_hyp in ("BEARING_FRICTION_LOAD", "THERMAL_STRESS")
