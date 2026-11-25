# Safety configuration

[The firmware safety library](../../firmware/lib/torqva_core/safety/) owns local protections. Compile-time declarations remain in [PlatformIO configuration](../../firmware/platformio.ini) and the board entry point. Verify the physical E-stop and sensing circuit before declaring it wired. See [the safety inventory](../../docs/SAFETY_INVENTORY.md).
