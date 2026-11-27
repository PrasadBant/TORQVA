# Feature matrix

| Capability | Status | Evidence / limitation |
|---|---|---|
| Content-addressed firmware artifacts | IMPLEMENTED AND VERIFIED | SHA-256 storage; identical bytes are stored once |
| Duplicate upload reuse | IMPLEMENTED AND VERIFIED | Existing release is returned with non-deploying reuse actions |
| A → B → A → C → B lifecycle | IMPLEMENTED AND VERIFIED | Mocked device test confirms five independent, device-confirmed deployment records |
| Custom name, description, notes, tags, favorite and archive | IMPLEMENTED AND VERIFIED | Atomic persistent metadata API, UI editor and audit record |
| Reinstall and saved-release redeployment | IMPLEMENTED AND VERIFIED | Explicit reinstall/downgrade intent; eligibility and device verification remain mandatory |
| Last known good restoration | IMPLEMENTED AND VERIFIED | Derived only from the newest CONFIRMED deployment and survives manager restart |
| Device-native OTA-slot rollback | IMPLEMENTED — HARDWARE VERIFICATION REQUIRED | Authenticated device command; capability-dependent |
| Local Monaco development editor | IMPLEMENTED AND VERIFIED | Lazy local bundle, C/C++ highlighting, find/replace, undo/redo, tabs and diagnostics navigation |
| File create, rename, delete and autosave | IMPLEMENTED AND VERIFIED | Browser working draft, separate from protected release artifacts |
| ZIP project import and build | IMPLEMENTED | Safe backend extraction/build path; importing ZIP contents into the visual explorer remains partial |
| Source comparison and ZIP export | IMPLEMENTED | Template baseline comparison and real JSZip export |
| Isolated PlatformIO build | IMPLEMENTED AND VERIFIED | Networkless, read-only, resource-limited Docker worker; valid job succeeded and invalid identity was rejected; Docker image required at runtime |
| Build cancellation | IMPLEMENTED AND VERIFIED | Queued/running cancellation, race guard, terminal UI state |
| USB application flashing | IMPLEMENTED — HARDWARE VERIFICATION REQUIRED | Opt-in esptool worker, owned port and safety gates; reconnect identity verification required |
| Wireless OTA | IMPLEMENTED — HARDWARE VERIFICATION REQUIRED | Signed HTTPS/device-verified workflow |
| Console and bounded logs | IMPLEMENTED AND VERIFIED | Severity/search/pause/export and bounded backend retrieval |
| Runtime diagnostics | PARTIALLY IMPLEMENTED | Uptime/free heap shown when reported; unsupported protocol metrics explicitly UNAVAILABLE |
| Contextual AI assistant | IMPLEMENTED — INFRASTRUCTURE REQUIRED | Configurable OpenAI-compatible provider, disclosure consent, redaction and review-only diffs |
| Eight workspaces | IMPLEMENTED AND VERIFIED | 48 tab/viewport browser checks, no horizontal overflow |

