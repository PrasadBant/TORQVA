import json
import tempfile
from pathlib import Path
from torqva.serial_bridge import DeviceBridge, MemoryTransport, CmdState
from torqva.schemas import Role
from torqva.store import Store

class DummyCommissioning:
    def __init__(self, path=None):
        self.ds18b20_mapping = {}
        self.limits = {"version": 1, "max_duty_pct": 100.0, "max_rpm": 20000.0, "confirmed": True, "evidence": "test", "user": "admin"}
        self.confirmed = True
    def physical_control_enabled(self):
        return True
    def status_of(self, item_id):
        return {"status": "VERIFIED", "by": "admin", "evidence": "test"}
    def set_ds18b20_mapping(self, housing_rom, ambient_rom, user="admin"):
        self.ds18b20_mapping = {"housing": housing_rom, "ambient": ambient_rom}

def test_ds18b20_mapping_and_warnings():
    with tempfile.TemporaryDirectory() as td:
        comm = DummyCommissioning()
        comm.set_ds18b20_mapping(housing_rom="28FF641E80140224", ambient_rom="28FF421A90150371", user="admin")
        assert comm.ds18b20_mapping["housing"] == "28FF641E80140224"
        assert comm.ds18b20_mapping["ambient"] == "28FF421A90150371"

        bridge = DeviceBridge()
        bridge.commissioning = comm
        mock_rig = MemoryTransport()
        bridge.connect(mock_rig)

        # 1. Normal matching ROM IDs
        slow_normal = {"t": "slow", "seq": 10, "ts": 1000, "housing": 45.0, "ambient": 25.0, "q": 63,
                       "rom0": "28FF641E80140224", "rom1": "28FF421A90150371"}
        bridge.check_ds18b20(slow_normal)
        assert bridge.ds18b20_warning is None

        # 2. Flipped ROM IDs: index 0 is ambient, index 1 is housing
        slow_flipped = {"t": "slow", "seq": 11, "ts": 1001, "housing": 25.0, "ambient": 45.0, "q": 63,
                        "rom0": "28FF421A90150371", "rom1": "28FF641E80140224"}
        bridge.check_ds18b20(slow_flipped)
        assert bridge.ds18b20_warning is not None
        assert "flipped" in bridge.ds18b20_warning.lower()

        # 3. Unknown ROM ID
        slow_unknown = {"t": "slow", "seq": 12, "ts": 1002, "housing": 30.0, "ambient": 25.0, "q": 63,
                        "rom0": "2800000000000099", "rom1": "28FF421A90150371"}
        bridge.check_ds18b20(slow_unknown)
        assert bridge.ds18b20_warning is not None
        assert "Unknown DS18B20 ROM ID" in bridge.ds18b20_warning

        # Snapshot includes mapping and warning
        snap = bridge.snapshot()
        assert snap["ds18b20_warning"] == bridge.ds18b20_warning
        assert snap["ds18b20_mapping"]["housing"] == "28FF641E80140224"


def test_command_and_incident_persistence_across_restarts():
    with tempfile.TemporaryDirectory() as td:
        db_path = str(Path(td) / "test.db")
        store1 = Store(db_path)
        bridge1 = DeviceBridge()
        bridge1.store = store1
        bridge1.direct_mode = True
        mock_rig = MemoryTransport()
        bridge1.connect(mock_rig)

        # Feed status frame so device transitions to CONNECTED
        status_frame = json.dumps({
            "t": "status", "seq": 1, "ts": 1000, "proto": 1, "dev": "RIG-1",
            "state": "OK", "reason": "NONE", "mode": "HW", "drive": "IDLE", "ctl": 1,
            "hb_age": 10, "test": 0, "blk": "", "fm": 0, "fw": "3.1.0", "wiring": "standard",
            "limits_v": 1, "es": 2
        }) + "\n"
        mock_rig.feed(status_frame)
        import time; time.sleep(0.1)

        # Execute a command
        rec = bridge1.request_command("STOP", {}, "operator", Role.ADMIN)
        assert rec.state in (CmdState.SENT, CmdState.EXECUTED)

        # Simulate ACK
        ack_frame = json.dumps({"t": "ack", "id": rec.id, "status": "COMPLETED", "reason": "STOPPED"}) + "\n"
        mock_rig.feed(ack_frame)
        time.sleep(0.1)

        # Store should have command under PHYSICAL namespace
        cmds = store1.list("command", provenance="MEASURED")
        assert len(cmds) >= 1
        assert any(c["id"] == rec.id for c in cmds)

        # Simulate restart with fresh DeviceBridge loading from same store
        store2 = Store(db_path)
        bridge2 = DeviceBridge()
        bridge2.store = store2
        bridge2.load_persisted_commands()
        assert rec.id in bridge2.commands
        assert bridge2.commands[rec.id].action == "STOP"

        # Verify incident persistence under PHYSICAL namespace
        store2.persist_incident("PHYSICAL", "inc_001", {"reason": "OVERHEAT", "temp": 85.0}, "MEASURED")
        inc_doc = store2.get("incident", "PHYSICAL/inc_001")
        assert inc_doc is not None
        assert inc_doc["reason"] == "OVERHEAT"
        assert inc_doc["_provenance"] == "MEASURED"

        # Separate SIM namespace
        store2.persist_incident("SIM", "inc_sim_001", {"reason": "SIM_TRIP"}, "SIMULATED")
        sim_doc = store2.get("incident", "SIM/inc_sim_001")
        assert sim_doc is not None
        assert sim_doc["_provenance"] == "SIMULATED"
        assert store2.get("incident", "PHYSICAL/inc_sim_001") is None

        store1._db.close()
        store2._db.close()
