# Direct control architecture

```text
frontend/src/control/MotionPanel.jsx
  -> frontend/src/shared/api.js
  -> POST /api/torqva/device/commands
  -> backend/torqva/api/device_routes.py
  -> backend/torqva/control/manual.py
  -> DeviceBridge in backend/torqva/device/serial_bridge.py
  -> SerialTransport or WsTransport
  -> ESP32 USB/UART or Wi-Fi input
  -> firmware/lib/torqva_core/shared/device.cpp
  -> control/commands.cpp and control/control.cpp
  -> firmware/src/main.cpp
  -> BTS7960 RPWM and enable outputs
```

The backend API verifies the principal and calls the same command coordinator for both links. The coordinator validates the request and current operating state, preempts subsequent diagnostic steps, and sends the command through the bridge's single writer. The device validates the frame again and handles START, STOP, SET_SPEED, SET_PWM and SET_RAMP through its command dispatcher and drive controller. START and SET_SPEED may enable drive inside the operating envelope. STOP de-energizes the drive and cancels active diagnostics. Hardware protection can disable drive at any time.

```text
Hall / INA219 / temperature / accelerometer / drive state
  -> ESP32 acquisition in firmware/src/main.cpp
  -> firmware core telemetry/device_telemetry.cpp and protocol ACK frames
  -> same USB or Wi-Fi transport
  -> backend/torqva/device/wire_protocol.py
  -> backend/torqva/telemetry/device_state.py and events.py
  -> FastAPI status/history and browser WebSocket
  -> frontend/src/telemetry and frontend/src/control
```

The bridge correlates ACKs with command IDs and records outcomes including rejection, timeout and an unknown outcome after link loss. PWM telemetry reports firmware output duty, while RPM is measured from usable Hall pulses. The production speed profile uses feedforward duty. The board configuration drives forward only. Verified physical motion requires the bench procedure.

[Safety and access inventory](../SAFETY_INVENTORY.md)
[Hardware acceptance](../../tests/hardware/README.md)
