# Dashboard removal and CSV inventory

Completed 20 October 2026. Analysis Studio and Prediction Engine have been removed.

The subsequent [drought database migration](../drought-database/Drought-Database-Migration.md)
removed the three remaining drought CSV fallback readers. The current database
configuration requires no runtime CSVs; the inventory below records the earlier
state at the time these standalone pages were removed.

## CSV readers at the time of page removal

No monitoring dashboard is configured to use CSV as its primary source. Three
monitoring dashboards retain database-first CSV fallbacks:

| Dashboard | CSV files it can read |
| --- | --- |
| Drought Monitoring | `csv's/hydrology.csv`, `csv's/satelite.csv`, `vegetation/5.2_meteorological_drivers_saws_master.csv` |
| Hydrological Drought | `csv's/hydrology.csv` |
| Satellite & Remote Sensing Drought | `csv's/satelite.csv` |

Climate and its indicator sections retain an optional CSV adapter, activated
only by explicitly selecting `NIWIS_CLIMATE_SOURCE=csv`. The current runtime
`backend/.env` selects `NIWIS_CLIMATE_SOURCE=supabase`. This is a configuration
and code audit; it does not claim every drought request always succeeds against
the database. A fallback response identifies its source as `local_csv_fallback`.

Runoff, Surface Water, Vegetation, Rainfall, reservoirs, groundwater levels,
groundwater reserve, water quality and standalone Meteorological Drought use
database readers. Original CSVs in those data folders remain reference/test
inputs. CSV export buttons generate downloads from API results.

The removed standalone provincial history loader preferred `mateological.csv`;
it and its route have been deleted. That file is no longer a runtime requirement.
The three remaining packaged fallback files total **7.26 MiB**.

## Removal scope

Deleted **45 source, asset and obsolete verification files** plus
**11 stale bytecode files**. The complete list and original hashes are recorded
in [studio-removal-manifest.json](studio-removal-manifest.json).

- Removed both navigation items, page descriptions, route mappings, page state
  and rendering branches. Old `/studio` and `/prediction` bookmarks open `/drought`.
- Simplified `App.jsx` to render the monitoring portal directly.
- Deleted the standalone forecasting workspace, time-series analysis components,
  spatial application, multivariate application and their exclusive styles.
- Deleted spatial/multivariate backend packages, their mounts and Vite proxies.
- Removed standalone upload, preview, analysis, PDF, feature, trend, export and
  legacy forecast endpoints. Retired endpoint-specific scripts were deleted.
- Removed the CSV-first provincial history loader and API wrapper.
- Trimmed shared dataframe preparation and request schemas to the monitoring
  forecast flow. Removed obsolete workspace CSS and the stale Runoff files badge.
- Removed three Highcharts package declarations and eleven Python requirements
  used by the retired tools. Existing local development environments were
  retained; fresh deployments install the smaller dependency lists.

Forecast panels inside monitoring dashboards still use `model_training.py`,
`training_worker.py`, `forecasting/`, Plotly and the shared registration/job APIs.
The `/drought-status` route also shares the provincial database summary service,
so `/niwis-api` remains mounted. These shared components were preserved.
Original source datasets, notebooks and unrelated in-progress source migrations
were retained.

## Recovery

A ZIP archive was created before editing or deleting the affected files:

`C:\Users\student\AppData\Local\Temp\niwis-studio-removal-20261020-103723.zip`

Each deleted source file was checked against its archived SHA-256 hash before
removal. The archive is outside the repository and is local to this machine.

## Verification

- Production frontend build passed, including static gzip/Brotli assets. The
  existing large Plotly chunk warning remains because monitoring forecasts use it.
- **30 backend regression checks passed** for dashboard performance, Runoff and
  dated Surface Water behavior.
- Regional Naive training, failed-job reporting/progress cleanup and a separate
  model worker passed. The failure verifier now polls for a terminal status
  before checking progress cleanup, allowing for worker/module startup.
- API inventory: **56 paths** remain. Removed standalone endpoints return 404;
  monitoring dataset registration, region loading, model training, job polling
  and regional history remain registered.
- Browser: both navigation items absent on desktop and mobile; retired bookmarks
  open Drought Monitoring; real Runoff database results retain all 52 districts;
  its retained forecast panel registers observations, trains Naive, polls the job
  and plots six future observations. **Zero JavaScript errors** and zero CSV
  network requests were observed during this browser run.
- The bookmark tests isolate the drought source using an explicit error response;
  they verify routing, not drought data availability. Runoff and its forecast use
  actual configured database observations; shared provincial summary requests
  are isolated in the browser test.
- Entry graph: **47 frontend files**, **38 backend files**, no unresolved frontend
  imports and no application modules outside the current graph. Changed portal
  modules were also checked for unbound JavaScript references.

Browser evidence: [verification.json](../dashboard-removal/verification.json),
[desktop screenshot](../dashboard-removal/monitoring-desktop.png),
[mobile screenshot](../dashboard-removal/monitoring-mobile.png).

Re-run `node verify-dashboard-removal.mjs` from `frontend` after building. It starts
and stops its own temporary backend and frontend preview processes. No deployment
or Git push was performed for this change.
