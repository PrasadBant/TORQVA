"""
Configuration module for Smart DC Motor Monitoring and Predictive Maintenance System.
All operational thresholds, baseline deviation limits, timeouts, retention periods,
and health weights are centrally managed here.
"""

from typing import Dict
from pydantic import BaseModel, Field


class ThresholdConfig(BaseModel):
    warning: float
    critical: float


class RPMThresholdConfig(BaseModel):
    min_warning: float = 1100.0
    min_critical: float = 900.0
    max_warning: float = 1900.0
    max_critical: float = 2200.0


class BaselineDeviationThresholds(BaseModel):
    """
    Centralized baseline deviation percentage limits.
    Configurable for hardware tuning on real motor benches.
    """
    temperature_warning_percent: float = Field(default=15.0, description="Warning threshold: % temperature rise above baseline")
    temperature_critical_percent: float = Field(default=35.0, description="Critical threshold: % temperature rise above baseline")

    vibration_warning_percent: float = Field(default=25.0, description="Warning threshold: % vibration RMS increase above baseline")
    vibration_critical_percent: float = Field(default=60.0, description="Critical threshold: % vibration RMS increase above baseline")

    rpm_warning_percent: float = Field(default=15.0, description="Warning threshold: % RPM deviation from baseline")
    rpm_critical_percent: float = Field(default=30.0, description="Critical threshold: % RPM deviation from baseline")

    current_warning_percent: float = Field(default=20.0, description="Warning threshold: % current draw above baseline")
    current_critical_percent: float = Field(default=50.0, description="Critical threshold: % current draw above baseline")

    power_warning_percent: float = Field(default=20.0, description="Warning threshold: % active power above baseline")
    power_critical_percent: float = Field(default=50.0, description="Critical threshold: % active power above baseline")

    voltage_warning_percent: float = Field(default=10.0, description="Warning threshold: % voltage drift from nominal/baseline")
    voltage_critical_percent: float = Field(default=20.0, description="Critical threshold: % voltage drift from nominal/baseline")


class HealthWeights(BaseModel):
    temperature: float = Field(default=0.20, description="Weight for temperature factor")
    vibration: float = Field(default=0.30, description="Weight for vibration RMS factor")
    rpm: float = Field(default=0.20, description="Weight for RPM factor")
    current: float = Field(default=0.20, description="Weight for current draw factor")
    power: float = Field(default=0.10, description="Weight for power consumption factor")


class AppConfig(BaseModel):
    # Device connection & heartbeat settings
    stale_timeout_seconds: float = Field(default=3.0, description="Seconds without telemetry before ESP32 is marked STALE")
    offline_timeout_seconds: float = Field(default=5.0, description="Seconds without telemetry before ESP32 is marked OFFLINE")
    device_id_expected: str = Field(default="ESP32-MOTOR-01", description="Default expected device identifier")
    
    # Telemetry Retention Settings
    history_retention_seconds: float = Field(default=86400.0, description="Telemetry storage retention window in seconds (24 hours)")

    # Absolute Sensor Safety Thresholds (Nominal RS-775 24V DC Motor Profile)
    temperature: ThresholdConfig = Field(
        default=ThresholdConfig(warning=55.0, critical=70.0),
        description="Absolute temperature safety limits in °C"
    )
    vibration_rms: ThresholdConfig = Field(
        default=ThresholdConfig(warning=0.35, critical=0.70),
        description="Absolute vibration RMS safety limits in g"
    )
    rpm: RPMThresholdConfig = Field(
        default=RPMThresholdConfig(),
        description="Absolute operating RPM bounds"
    )
    current: ThresholdConfig = Field(
        default=ThresholdConfig(warning=2.2, critical=3.5),
        description="Absolute current limits in Amperes"
    )
    power: ThresholdConfig = Field(
        default=ThresholdConfig(warning=50.0, critical=85.0),
        description="Absolute power limits in Watts"
    )
    voltage_nominal: float = Field(default=24.0, description="Nominal supply voltage (V)")
    
    # Baseline-relative deviation threshold configuration
    baseline_deviations: BaselineDeviationThresholds = Field(default_factory=BaselineDeviationThresholds)

    # Health calculation weights
    health_weights: HealthWeights = Field(default_factory=HealthWeights)
    
    # Storage settings
    db_path: str = Field(default="data/motor_monitor.db", description="SQLite database file path")
    
    # Server settings
    host: str = "0.0.0.0"
    port: int = 8000


# Global singleton instance
config = AppConfig()
