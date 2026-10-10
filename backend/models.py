"""
Pydantic Data Contract & Domain Models for Smart DC Motor Monitoring.
Strict type validation, physical boundary checking, and NaN/Inf rejection are enforced.
"""

import math
from enum import Enum
from typing import Optional, Dict, Any, List
from pydantic import BaseModel, Field, field_validator, model_validator


class SensorHealthModel(BaseModel):
    adxl345: bool = Field(default=True, description="ADXL345 accelerometer health status")
    ds18b20: bool = Field(default=True, description="DS18B20 temperature sensor health status")
    ina219: bool = Field(default=True, description="INA219 voltage/current sensor health status")
    a3144: bool = Field(default=True, description="A3144 Hall-effect RPM sensor health status")


class TelemetryPayload(BaseModel):
    device_id: str = Field(..., min_length=1, max_length=64, description="Unique hardware identifier, e.g. ESP32-MOTOR-01")
    firmware: str = Field(default="1.0.0", description="Firmware version running on ESP32")
    timestamp: float = Field(..., description="Device epoch timestamp or millisecond clock")
    server_received_at: Optional[float] = Field(default=None, description="Server reception epoch timestamp")
    
    motor_running: bool = Field(..., description="True if motor is actively rotating/running")
    
    temperature: float = Field(..., description="Motor surface temperature in °C")
    
    vibration_x: float = Field(..., description="X-axis vibration acceleration in g")
    vibration_y: float = Field(..., description="Y-axis vibration acceleration in g")
    vibration_z: float = Field(..., description="Z-axis vibration acceleration in g")
    vibration_rms: float = Field(..., ge=0.0, description="Root-Mean-Square vibration acceleration in g")
    
    rpm: float = Field(..., ge=0.0, description="Motor shaft speed in RPM")
    
    voltage: float = Field(..., ge=0.0, description="DC Bus voltage in Volts")
    current: float = Field(..., description="Current draw in Amperes")
    power: Optional[float] = Field(default=None, description="Calculated or measured electrical power in Watts")
    
    sensor_health: SensorHealthModel = Field(
        default_factory=SensorHealthModel,
        description="Individual sensor operational health flags"
    )
    
    source: str = Field(default="live", description="Data origin: 'live' from ESP32 or 'demo' from simulator")
    hardware_condition: Optional[str] = Field(default=None, description="ESP32 hardware condition: NORMAL, WARNING, CRITICAL, SENSOR FAULT, MOTOR OFF, NO BASELINE")
    hardware_reason: Optional[str] = Field(default=None, description="ESP32 hardware condition reason or deviation detail")
    hardware_baseline_stored: Optional[bool] = Field(default=None, description="Whether ESP32 hardware Preferences baseline is stored")

    @field_validator("temperature", "vibration_x", "vibration_y", "vibration_z", "vibration_rms", "rpm", "voltage", "current", "power", mode="before")
    @classmethod
    def validate_finite_numbers(cls, value: Any, info) -> Any:
        """Reject NaN, Infinity, and non-numeric values."""
        if value is None:
            return value
        try:
            val = float(value)
        except (ValueError, TypeError):
            raise ValueError(f"Field '{info.field_name}' must be a valid numeric value.")
        
        if math.isnan(val) or math.isinf(val):
            raise ValueError(f"Field '{info.field_name}' cannot be NaN or Infinity.")
        return val

    @field_validator("temperature")
    @classmethod
    def validate_temperature_bounds(cls, v: float) -> float:
        if not (-50.0 <= v <= 200.0):
            raise ValueError(f"Temperature reading {v}°C is outside plausible physical boundaries (-50°C to 200°C).")
        return round(v, 2)

    @field_validator("vibration_rms")
    @classmethod
    def validate_vibration_bounds(cls, v: float) -> float:
        if v < 0.0 or v > 50.0:
            raise ValueError(f"Vibration RMS {v}g is outside plausible physical boundaries (0 to 50g).")
        return round(v, 3)

    @field_validator("rpm")
    @classmethod
    def validate_rpm_bounds(cls, v: float) -> float:
        if v < 0.0 or v > 30000.0:
            raise ValueError(f"RPM {v} is outside plausible operational boundaries (0 to 30,000 RPM).")
        return round(v, 1)

    @field_validator("voltage")
    @classmethod
    def validate_voltage_bounds(cls, v: float) -> float:
        if v < 0.0 or v > 100.0:
            raise ValueError(f"Voltage {v}V is outside plausible boundaries (0 to 100V).")
        return round(v, 2)

    @field_validator("current")
    @classmethod
    def validate_current_bounds(cls, v: float) -> float:
        if v < -5.0 or v > 50.0:
            raise ValueError(f"Current {v}A is outside plausible boundaries (-5A to 50A).")
        return round(v, 2)

    @field_validator("source")
    @classmethod
    def validate_source(cls, v: str) -> str:
        if v not in ["live", "demo"]:
            raise ValueError(f"Invalid telemetry source '{v}'. Must be 'live' or 'demo'.")
        return v

    @model_validator(mode="after")
    def compute_power_if_missing(self) -> "TelemetryPayload":
        """Compute power = voltage * current if power is not supplied by the sensor payload."""
        if self.power is None or self.power == 0.0:
            self.power = round(max(0.0, self.voltage * self.current), 2)
        else:
            self.power = round(self.power, 2)
        return self


class ConnectionState(str, Enum):
    CONNECTED = "CONNECTED"
    STALE = "STALE"
    OFFLINE = "OFFLINE"


class DeviceStatus(BaseModel):
    device_id: str = "ESP32-MOTOR-01"
    firmware: str = "1.0.0"
    ip_address: Optional[str] = None
    first_seen: Optional[float] = None
    last_seen: Optional[float] = None
    connection_state: ConnectionState = ConnectionState.OFFLINE
    sensor_health: SensorHealthModel = Field(default_factory=SensorHealthModel)
    uptime_seconds: Optional[float] = 0.0


class BaselineStatus(str, Enum):
    NOT_CONFIGURED = "NOT_CONFIGURED"
    COLLECTING = "COLLECTING"
    COMPLETED = "COMPLETED"
    SAVED = "SAVED"


class BaselineState(BaseModel):
    status: BaselineStatus = BaselineStatus.NOT_CONFIGURED
    temperature: Optional[float] = None
    vibration_rms: Optional[float] = None
    voltage: Optional[float] = None
    current: Optional[float] = None
    power: Optional[float] = None
    rpm: Optional[float] = None
    saved_at: Optional[float] = None
    samples: int = 0
    duration_seconds: float = 0.0


class CommandType(str, Enum):
    START_BASELINE = "START_BASELINE"
    CANCEL_BASELINE = "CANCEL_BASELINE"
    RESET_BASELINE = "RESET_BASELINE"


class DeviceCommand(BaseModel):
    command_id: str
    command: CommandType
    parameters: Optional[Dict[str, Any]] = None
    created_at: float
    status: str = "PENDING"  # PENDING, SENT, ACKNOWLEDGED, EXPIRED


class CommandAck(BaseModel):
    command_id: str
    device_id: str
    status: str = "ACKNOWLEDGED"
    message: Optional[str] = None


class MotorControlRequest(BaseModel):
    command: str = Field(..., description="Motor control action: 'ON' (MOTOR_ON) or 'OFF' (MOTOR_OFF)")


class HealthStatus(str, Enum):
    HEALTHY = "HEALTHY"
    WARNING = "WARNING"
    CRITICAL = "CRITICAL"
    BASELINE_REQUIRED = "BASELINE_REQUIRED"
    OFFLINE = "OFFLINE"


class AnomalyType(str, Enum):
    ABOVE_BASELINE = "ABOVE_BASELINE"
    BELOW_BASELINE = "BELOW_BASELINE"
    ABSOLUTE_LIMIT_EXCEEDED = "ABSOLUTE_LIMIT_EXCEEDED"
    SENSOR_UNAVAILABLE = "SENSOR_UNAVAILABLE"
    INVALID_VALUE = "INVALID_VALUE"
    INSUFFICIENT_BASELINE = "INSUFFICIENT_BASELINE"
    NO_BASELINE = "NO_BASELINE"


class AlertSeverity(str, Enum):
    INFO = "INFO"
    WARNING = "WARNING"
    CRITICAL = "CRITICAL"


class AnomalyDetail(BaseModel):
    sensor: str = Field(..., description="Monitored parameter identifier, e.g. vibration_rms")
    type: AnomalyType = Field(..., description="Machine-readable anomaly categorization")
    severity: AlertSeverity = Field(..., description="Anomaly severity: INFO, WARNING, CRITICAL")
    current: float = Field(..., description="Current sensor measurement")
    baseline: Optional[float] = Field(default=None, description="Reference baseline calibration value")
    deviation_percent: Optional[float] = Field(default=None, description="Calculated percentage deviation relative to baseline")
    message: str = Field(..., description="Human-readable and explainable anomaly description")
    suggested_inspection: str = Field(..., description="Non-definitive maintenance recommendation")


class HealthResult(BaseModel):
    score: float = Field(default=100.0, ge=0.0, le=100.0, description="Overall health score (0-100)")
    status: HealthStatus = HealthStatus.OFFLINE
    factors: Dict[str, float] = Field(default_factory=dict, description="Factor-specific scores (0-100)")
    alerts: List[Dict[str, Any]] = Field(default_factory=list, description="Active alerts and observations")
    anomalies: List[AnomalyDetail] = Field(default_factory=list, description="Deterministic baseline-relative anomaly records")
    explanations: List[str] = Field(default_factory=list, description="Explainable diagnostic breakdown reasons")
    evaluated_sensors: List[str] = Field(default_factory=list, description="List of sensors included in condition evaluation")
    unavailable_sensors: List[str] = Field(default_factory=list, description="List of unavailable or faulted sensors")
    baseline_age_seconds: Optional[float] = Field(default=None, description="Age of saved baseline in seconds")
    diagnostic_explanation: str = Field(
        default="System initialized. Awaiting live telemetry and baseline calibration.",
        description="Non-definitive diagnostic explanation adhering to safety guidelines"
    )


class AlertRecord(BaseModel):
    id: Optional[int] = None
    timestamp: float
    severity: str = "WARNING"  # INFO, WARNING, CRITICAL
    parameter: str
    title: str
    message: str
    current_value: float
    baseline_value: Optional[float] = None
    suggested_inspection: str
    source: str = "live"
    status: str = "ACTIVE"  # ACTIVE, RESOLVED
    resolved_at: Optional[float] = None


class IngestResponse(BaseModel):
    accepted: bool = True
    device_id: str
    server_time: float
    pending_commands: int = 0
    message: str = "Telemetry accepted"


class HistoryRecord(BaseModel):
    id: int
    timestamp: float
    server_received_at: float
    source: str
    device_id: str
    temperature: float
    vibration_x: float
    vibration_y: float
    vibration_z: float
    vibration_rms: float
    rpm: float
    voltage: float
    current: float
    power: float
    motor_running: bool
    health_score: Optional[float] = None
    status: Optional[str] = None
