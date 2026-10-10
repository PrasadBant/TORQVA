"""
Demo Simulation Engine Interface & Foundation.
Allows simulating nominal and anomalous motor profiles for testing and presentation.
All simulated telemetry is explicitly tagged with source='demo'.
"""

from typing import Optional
import time
from models import TelemetryPayload, SensorHealthModel


class DemoEngine:
    """
    Simulation engine producing synthetically generated motor telemetry profiles.
    Used for offline testing, UI demonstration, and fault injection verification.
    """

    def __init__(self):
        self.active_mode: str = "normal"  # normal, high_temperature, high_vibration, low_rpm, high_current, multiple
        self.is_running: bool = False

    def set_scenario(self, scenario: str) -> None:
        """Configures the synthetic failure/operation scenario."""
        valid_scenarios = ["normal", "high_temperature", "high_vibration", "low_rpm", "high_current", "multiple"]
        if scenario in valid_scenarios:
            self.active_mode = scenario

    def generate_sample(self) -> TelemetryPayload:
        """
        Generates a synthetic telemetry payload based on active scenario.
        Source is always explicitly set to 'demo'.
        """
        now = time.time()
        
        # Base nominal operating parameters (RS-775 24V motor)
        temp = 38.5
        vib_x, vib_y, vib_z = 0.08, 0.10, 0.12
        vib_rms = 0.11
        rpm = 1520.0
        voltage = 24.1
        current = 1.35
        motor_running = True

        if self.active_mode == "high_temperature":
            temp = 74.2
        elif self.active_mode == "high_vibration":
            vib_x, vib_y, vib_z = 0.55, 0.62, 0.78
            vib_rms = 0.72
        elif self.active_mode == "low_rpm":
            rpm = 750.0
            current = 2.8
        elif self.active_mode == "high_current":
            current = 3.9
            temp = 62.0
        elif self.active_mode == "multiple":
            temp = 71.0
            vib_rms = 0.68
            rpm = 820.0
            current = 3.6

        return TelemetryPayload(
            device_id="DEMO-SIM-01",
            firmware="1.0.0-demo",
            timestamp=now,
            motor_running=motor_running,
            temperature=temp,
            vibration_x=vib_x,
            vibration_y=vib_y,
            vibration_z=vib_z,
            vibration_rms=vib_rms,
            rpm=rpm,
            voltage=voltage,
            current=current,
            power=round(voltage * current, 2),
            sensor_health=SensorHealthModel(adxl345=True, ds18b20=True, ina219=True, a3144=True),
            source="demo"
        )


# Global singleton instance
demo_engine = DemoEngine()
