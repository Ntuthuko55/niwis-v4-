# NIWIS cleanup

Completed 19 October 2026 after reviewing the [system flow](System-Flow.md).

The later removal of Analysis Studio and Prediction Engine is recorded separately
in [Dashboard-Removal.md](Dashboard-Removal.md).

This records the cleanup state on that date. Runoff subsequently moved to the
database on 20 October; see the [migration report](../runoff-database/Runoff-Database-Migration.md)
for its current source and the updated runtime CSV inventory.

Removed **169 files**, reducing the project contents by **383,044,016 bytes (365.30 MiB)**. No active dashboard, backend service, original dataset, research notebook, report, or required map asset was removed.

## Removed files

| Category | Files |
| --- | ---: |
| Frontend modules outside the active import graph | 10 |
| Generated Jupyter checkpoints with retained originals | 15 |
| Python bytecode and test caches | 120 |
| Temporary inspection/startup files and a local shortcut | 6 |
| Captured API responses used for debugging | 3 |
| Unreferenced public data copies, placeholder and unrelated image | 4 |
| Generated development screenshots | 9 |
| Vite development logs | 2 |

All CSV checkpoints matched their retained original datasets byte for byte. The full per-file list, sizes, SHA-256 checksums, reasons and validation results are in [cleanup-manifest.json](cleanup-manifest.json).

The removed frontend modules were `AnalysisChart.jsx`, `DataUpload.jsx`, `FeatureEngineering.jsx`, `ModelGuide.jsx`, `NIWISDashboard.jsx`, `ProvinceForecasting.jsx`, `SouthAfricaMap.jsx`, `mateoData.js`, and the two unused `supabaseClient.js` modules. Active workspaces retain their upload and analysis flows.

## Dependency files

Removed six unused dependency declarations from `frontend/package.json` and updated `frontend/package-lock.json` offline:

```text
@supabase/supabase-js
plotly.js-dist-min
proj4
react-leaflet
react-simple-maps
xlsx
```

The lockfile dropped 29 package entries, added none, and kept the versions of every retained package. `plotly.js` remains because `react-plotly.js` needs it. The existing local `node_modules` directory was preserved; a fresh install will use the trimmed dependency files. A fresh install was not run during this cleanup.

Added ignore rules for pytest caches and generated frontend inspection artifacts so they do not reappear in version-control changes. Existing local environments, credential files, and dependency installations were retained.

Python bytecode caches can regenerate when the application runs. The running backend recreated 42 during validation; those were cleared again after the checks.

## Preserved connections

- Verified SHA-256 hashes for **128 active source files, map assets and required CSVs** before and after removal: all unchanged.
- Retained **63 reachable frontend source/style files** and **55 reachable backend Python files**, including dynamic multivariate analyses and the three mounted Flask apps.
- Retained the six required runtime/fallback CSVs, totaling **144.8 MiB**. Runoff and provincial history still use local files; drought retains packaged fallbacks.
- Retained the original district boundary file used to regenerate the smaller display map, optional climate CSV inputs, test fixtures, original source datasets, notebooks and report evidence.

## Validation

- `npm run build`: passed; Vite transformed 2,527 modules and prepared gzip/Brotli assets. Existing large-chunk warnings remain for plotting/analysis bundles.
- `python -B -m unittest test_dashboard_performance`: **8 tests passed**.
- Re-ran the import audit: **no unresolved frontend imports and no frontend/backend source modules outside the entry-point graph**.
- FastAPI health and all three mounted Flask health endpoints: **HTTP 200**.
- OpenAPI endpoint: **HTTP 200**, with the same **75 FastAPI paths**.

The checks cover build integrity, shared dashboard regressions, file preservation and service availability. They do not exercise every model or chart end to end. No deployment was performed.

## Recovery

A validated recovery archive was created before deleting any file. It contains all 169 removed files, the original dependency files, and the earlier audit snapshots:

[Recovery archive](<C:/Users/student/AppData/Local/Temp/niwis-cleanup-20261019-151101.zip>)

The archive is outside the project and is approximately 69.91 MiB. Restore selected files from it using their recorded relative paths; keep the current active files when reviewing an older snapshot.
