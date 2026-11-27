# Performance report

No fabricated before/after runtime comparison is claimed because no equivalent pre-change timing capture exists.

- Production build: 28.69 s, 2,939 transformed modules.
- Main application bundle: 364.55 kB minified / 109.01 kB gzip.
- Firmware workspace bundle: 29.82 kB / 9.71 kB gzip.
- Monaco is locally packaged and lazy-loaded only on opening Development: 2,311.83 kB / 600.47 kB gzip after narrowing imports to the editor API and C++ contribution.
- JSZip is lazy-loaded for export: 97.42 kB / 30.28 kB gzip.
- Device logs remain bounded and filtered; build logs are capped; firmware artifacts remain content-addressed and deduplicated.
- Six viewport sizes and all eight workspaces produced zero horizontal-overflow failures.
- A real isolated Docker editor build completed in 62.2 s with no artifact upload or deployment; the invalid-identity case completed and rejected in 37.72 s.

The Monaco payload warning is accepted as a documented tradeoff for a local/offline editor. Semantic services and language workers were not added.

