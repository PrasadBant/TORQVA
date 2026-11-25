# Hardware acceptance

Use the [bring-up checklist](../../docs/hardware/TORQVA_HARDWARE_BRINGUP_CHECKLIST.md) and [E-stop wiring guide](../../docs/hardware/TORQVA_ESTOP.md). Confirm the independent cut-off and board configuration before applying motor power.

With motor power isolated, verify the ESP32 identity, authenticated link, operating configuration, and fresh sensor frames over USB and Wi-Fi. Commission the interlocks and sensing with qualified bench supervision. Then verify START, live PWM and RPM changes, ramps, and STOP while observing driver output and shaft response. Exercise loss of communication and the independent emergency cut-off separately, recording the reported reason and checking that reconnection or reset does not restart the motor.

Record firmware profile, board revision, transport, measured results and outstanding faults. Keep simulation, firmware-in-the-loop and physical observations distinct.
