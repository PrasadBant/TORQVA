import json
import math
from torqva.serial_bridge import DeviceModel, parse_frame


def test_sensor_validity_outlier_rejection_and_derived_power():
    m = DeviceModel()
    
    # 1. Normal valid frame
    f1 = parse_frame(json.dumps({
        "t": "fast", "seq": 1, "ts": 100,
        "rpm": 1500.0, "sp": 1500.0, "duty": 30.0,
        "v": 24.0, "i": 2.5, "p": 60.0, "q": 63
    }))
    m.ingest(f1, 1.0, 100.0)
    assert m.values["rpm"]["valid"] is True
    assert m.values["rpm"]["value"] == 1500.0
    assert m.values["voltage"]["value"] == 24.0
    assert m.values["current"]["value"] == 2.5
    assert m.values["power"]["valid"] is True
    assert m.values["power"]["value"] == 60.0  # 24.0 * 2.5

    # 2. Outlier rejection: impossible RPM (> 30000) rejected as invalid UNAVAILABLE (None, never 0)
    f2 = parse_frame(json.dumps({
        "t": "fast", "seq": 2, "ts": 200,
        "rpm": 45000.0, "sp": 1500.0, "duty": 30.0,
        "v": 24.0, "i": 2.5, "p": 60.0, "q": 63
    }))
    m.ingest(f2, 1.1, 100.1)
    assert m.values["rpm"]["valid"] is False
    assert m.values["rpm"]["value"] is None  # UNAVAILABLE, never 0

    # 3. High legitimate peak (real peak preserved without hiding)
    f3 = parse_frame(json.dumps({
        "t": "fast", "seq": 3, "ts": 300,
        "rpm": 19500.0, "sp": 20000.0, "duty": 95.0,
        "v": 23.5, "i": 18.0, "p": 423.0, "q": 63
    }))
    m.ingest(f3, 1.2, 100.2)
    assert m.values["rpm"]["valid"] is True
    assert m.values["rpm"]["value"] == 19500.0
    assert m.values["current"]["value"] == 18.0
    assert m.values["power"]["value"] == round(23.5 * 18.0, 2)

    # 4. Sensor failure / missing voltage bit (q & Q_BITS['voltage'] == 0) -> power UNAVAILABLE
    f4 = parse_frame(json.dumps({
        "t": "fast", "seq": 4, "ts": 400,
        "rpm": 1500.0, "sp": 1500.0, "duty": 30.0,
        "v": 24.0, "i": 2.5, "p": 60.0, "q": 63 & ~2  # voltage invalid
    }))
    m.ingest(f4, 1.3, 100.3)
    assert m.values["voltage"]["valid"] is False
    assert m.values["voltage"]["value"] is None
    assert m.values["power"]["valid"] is False
    assert m.values["power"]["value"] is None

    # 5. Gaps preserved as gaps
    f5 = parse_frame(json.dumps({
        "t": "fast", "seq": 10, "ts": 1000,
        "rpm": 1500.0, "sp": 1500.0, "duty": 30.0,
        "v": 24.0, "i": 2.5, "p": 60.0, "q": 63
    }))
    ev = m.ingest(f5, 1.4, 100.4)
    assert "gap" in ev
    assert m.counters["gaps"] >= 1
    assert m.counters["missing"] == 5
