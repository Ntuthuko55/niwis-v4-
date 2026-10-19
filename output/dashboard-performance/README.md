Dashboard performance changes
=============================

All monitoring pages share lazy component loading, forecast panels opened on request,
request coalescing, a compact display map and cached SVG geometry. The original
district geometry remains available for analysis. Failed HTTP reads are never
kept in the browser cache. Cancelling one component's request does not cancel
another component's shared request.

The API caches successful serialized JSON responses for 30 seconds with a 32 MB
budget. Authenticated requests, cookies, errors, full audits and responses above
2 MB bypass storage. Source caches retain their existing policies and keep
defensive copies; copies now run outside the shared lock. Cache timestamps are
API retrieval times, not the observation dates shown in each dashboard.

Reservoir metadata loads date boundaries and one national monitoring day.
Charts fetch their requested district/period, maps fetch one day, and RSI reads
prior same-month observations plus the short recent comparison window. Counts
that require a full source scan remain unassessed until the full audit is opened.
The visible quality audit describes the selected chart period. The catalogue
describes groups present on the latest monitoring day; retired groups absent on
that day are not included in the current operational selector.

Hydrology loads its compact catalogue and selected district history. Its legacy
full-dataset API remains available for explicit consumers. Forecast source data
is aggregated monthly from a bounded three-year window. Existing source choices
and missing-data behavior in other monitoring modules remain in place.

Model fitting uses a lazily started process pool, with one model worker by
default. Job IDs and polling stay in the API process. Keep one API worker until
dataset and job registries have been moved into shared persistent storage.

Local production preparation
----------------------------

Run `npm.cmd run build` in frontend to create a split bundle and gzip/Brotli
assets. The build imports Vite's config natively to avoid the Windows config
bundling permission error. Run `backend/start.ps1 -Production` for the API
without the development file watcher. The nginx example in deployment serves
fingerprinted assets with long cache lifetimes and proxies the API. No external
hosting or database-region changes are made by this checkout.

Settings: NIWIS_RESPONSE_CACHE_TTL (30 seconds), NIWIS_TRAINING_WORKERS (1),
NIWIS_TRAINING_THREADS (2). Database connection/index settings remain server-side.

Checks
------

`python -m unittest test_dashboard_performance test_reservoir_service` covers
response coalescing, failure/auth bypass, independent cache keys, bounded
reservoir reads, national map coverage, source totals, RSI and date validation.
`python verify_training_worker.py` checks Windows process spawning and a finite
six-month forecast. Browser and build measurements are recorded separately.

Daily metadata in rainfall, vegetation, surface water and groundwater no longer requests exact full-table counts. Groundwater and the annual reserve/quality catalogues use a recent source window. Satellite forecasts use one bounded monthly endpoint instead of 52 full-history browser requests.

Font stylesheets load separately from dashboard CSS and do not block rendering. Google Fonts being unavailable must not prevent lazy dashboard modules from mounting. Source fallbacks in the drought modules retain their configured policy and are scoped to the requested period.

Measured local results
----------------------

The entry JavaScript is 273,689 bytes (92.8 kB gzip), with no eager dashboard/Plotly imports. The display boundary file falls from 4,274,862 to 561,214 bytes (86.9% smaller), retaining all 52 districts. This entry size excludes the route-specific chart libraries loaded when a dashboard opens.

Nine monitoring APIs passed series and national-map checks. Immediate repeated dashboard reads measured 2-32 ms in this local run; the source caches were already partly warm. These timings are not cold-database guarantees. The multi-year national climate screen still needed approximately 36 seconds in the browser before caches were warm; a database-side monthly/annual aggregate would be the next improvement for that path.

Fifteen backend checks pass, plus shared-fetch/date checks and the Windows process-worker check. The forecasting browser check completed real Naive jobs for national and Tshwane temperature histories, with valid monthly dates, six future observations, distinct datasets and no browser errors. Full browser results are in browser-verification.json; forecast and API checks have separate JSON files.

Reservoir date-boundary queries retry transient Supabase 57014 errors at most twice, with short backoff. Full history and invalid-schema errors are not retried. A cutoff reuses the cached lower date boundary instead of repeating it.

All 19 monitoring routes passed the production browser checks, including the six climate sections. External font requests were deliberately aborted. Reservoir and hydrology checks were repeated after the small boundary-query retry change; browser-initial-check.json retains the original transient Supabase failure for comparison. Hydrology also retains all 52 district shapes after switching to the national map and selecting another district.

The reservoir interaction check additionally passed metric tabs, units, 365-day CSV export, keyboard and alert selection, full national map values after district selection, mobile layout, a simulated source failure and retry recovery.

Climate-specific follow-up: see [Climate-Loading-Improvements.md](Climate-Loading-Improvements.md) for scoped table reads, compact yearly summary reuse, independent source-date maps, progressive rendering and current latency limits. All seven climate routes pass in development and production; the backend regression run now has 25 passing checks.
