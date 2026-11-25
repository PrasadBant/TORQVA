# Configuration

The server seeds an absent local operating configuration from [device_config.json](defaults/device_config.json). Existing site state, including sensor mapping and limit version, remains in `backend/data/device_config.json` or the path configured by `TORQVA_DEVICE_CONFIG_FILE`.

- [Control](control/README.md) identifies the command envelope and ramp settings.
- [Safety](safety/README.md) identifies compiled protections and commissioning settings.
- [Devices](devices/README.md) identifies credentials and transport settings.
