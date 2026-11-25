"""Operating envelope and device-reported readiness for physical motion."""

from dataclasses import dataclass
from typing import Dict, List, Optional

from torqva.telemetry.device_state import DeviceModel

@dataclass
class PhysicalControlPolicy:
    """Direct physical START / speed policy without interlocks or motion blockers."""
    physical_control_enabled: bool = True
    max_duty_pct: Optional[float] = 100.0
    max_rpm: Optional[float] = 30000.0


def describe_interlocks(bridge) -> List[Dict[str, str]]:
    """Interlocks removed: direct operator motor control has no interlocks or blockers."""
    return []
