Rainfall loading improvements
=============================

Rainfall Status Monitoring follows vegetation in the dashboard navigation. It now loads its national map independently of the monthly charts and year comparisons. District selections reuse the loaded national map, with all 52 boundaries retained. Changing the map month or indicator leaves the main charts and daily-detail request unchanged. District ranking continues to use the chart's end month.

The backend caches compact monthly summaries by source, region and calendar year using the shared five-minute dashboard cache. Concurrent map/history requests share each year load. District requests reuse available national summaries; a district opened without a national cache still uses district-filtered database reads. Large yearly daily frames are released after aggregation. Existing bounded 90-day pagination remains, with a shared limit of 12 active upstream reads for this module.

Daily detail retrieves only its five measurements for one month, rather than all monthly and annual fields. Its request and retry state are independent of the main charts. Forecast-source retrieval reuses monthly summaries and no longer reads unused runoff data. The page opts into include_map=false and include_runoff=false because neither embedded result is needed by its chart request. The default API response retains its map and runoff context for existing callers.

Annual and seasonal source values are retained by observation month inside each compact summary. Coverage is reconstructed through the requested end month. Reading a full calendar year into the cache therefore does not make an August selection include September observations, mark an incomplete season complete, or give future seasons zero rainfall.

Supabase remains the source for the existing module 4 relations. All 19 indicators, original units, daily-derived rainfall totals, rainy-day counts, repeated monthly and annual source fields, once-per-dekad TAMSAT estimates, drought indices, missing observations and incomplete-month comparison rules are preserved. Loading percentages and independent map/daily retry controls are provided through the existing interface.

Observed local results
----------------------

| Complete browser check | Development, caches populated | Production, caches populated |
| --- | --- | --- |
| Initial national map visible | 0.496 s | 0.339 s |
| Main history and daily detail ready | 1.080 s | 0.692 s |
| Change to Tshwane, including daily detail | 0.751 s | 0.497 s |

An earlier development load during verification took 22.120 seconds for the map and 26.858 seconds for history plus daily detail, including initial source/schema retrieval while the frontend build was running. Both early-load checks held the real chart response until the map appeared, confirming independent rendering. No database cache reset was forced. These are local measurements, not deployment guarantees; uncached schema/catalogue and national history reads still take substantially longer than cached updates.

Warm API checks measured 0.014 seconds for a map month and 0.030 seconds for forecast-source retrieval. The source reported its latest observation as 2026-09-06; retrieval timestamps remain separate from source observation dates.

Validation
----------

51 offline backend checks pass: twelve new rainfall performance checks, three existing rainfall cadence checks, eleven vegetation performance checks, ten climate checks and fifteen shared cache/reservoir checks. They cover full-daily/monthly parity, partial-year annual and seasonal coverage, national-summary reuse, simultaneous map/history reads, district-only query scope, map and forecast scope, narrow daily selects, missing districts, source errors and partial-month exclusions.

Live comparisons exactly match captured previous national, Tshwane, leap-year daily-detail and partial-month API responses. This includes every monthly series, summary, comparison, annual/seasonal value, coverage field, satellite agreement value, warning, national map and legacy runoff context. Forecast-source values match the chart series.

Development and production browser checks pass: independent early map display; national map colors after district selection; no chart reload for map/daily-month changes; ranking selection; all eight drought indices and nineteen register rows; leap-day daily detail and three dekads; real monthly CSV export with source units; separate map/daily/chart failures and recovery; incomplete-month warnings; unavailable future seasons; and mobile layout. Both runs report no JavaScript errors. Forecast registration and Plotly remain deferred until the forecasting studio is opened.

The production build passes, with the existing large-chunk warning for deferred chart assets.

Run from backend:

```powershell
.venv/Scripts/python.exe -m unittest test_rainfall_performance test_rainfall_service.RainfallTests.test_cadences_not_multiplied_and_duplicate_daily_rows_not_counted test_rainfall_service.RainfallTests.test_missing_measurements_are_not_dry_days_or_zero_totals test_rainfall_service.RainfallTests.test_inconsistent_repeated_totals_rejected test_vegetation_performance test_climate_performance test_dashboard_performance test_reservoir_service
```

Run from frontend against a running development or production preview server:

```powershell
$env:NIWIS_VERIFY_URL='http://127.0.0.1:5185'
$env:NIWIS_VERIFY_MODE='development'
node verify-rainfall-performance.mjs
```

Evidence in this directory: rainfall-api-verification.json, rainfall-development-verification.json, rainfall-production-verification.json, captured rainfall-legacy/optimized JSON responses and desktop/mobile screenshots.
