Vegetation loading improvements
===============================

The vegetation dashboard now loads its national map separately from the chart and comparison history. The map endpoint reads the selected calendar years and does not calculate five-year baselines, weather joins or correlations. District and lag changes reuse the national map; choosing a map month does not reload chart histories. All 52 district boundaries remain visible.

The backend caches compact monthly district summaries by source, calendar year and region, with the existing five-minute dashboard cache policy. Concurrent requests share each load. District requests reuse an available national summary; a district opened without a national cache still makes district-filtered queries. Daily satellite frames are released after aggregation. Paginated database reads retain their 90-day bounds and share a maximum of 12 concurrent upstream reads.

Only NDVI and daily completeness are retrieved for older years needed solely by the seasonal baseline. Other satellite indices and weather are loaded for the selected and previous-year comparison periods. Maps, overlapping selections, lag changes and forecasting reuse these summaries.

Supabase module 3 remains the source, with the same two vegetation/meteorological tables and all 25 supplied indicators. Monthly means, units, incomplete-month exclusions, previous-year comparisons, five-year NDVI baselines and correlation rules are preserved. Missing observations remain unavailable. The default dashboard API still includes its map and ranking; the browser opts into include_map=false and loads its map separately.

The map selector now explicitly offers Selected period as well as individual months. This retains the original initial period-mean map and makes its displayed period accurate. District ranking continues to use the chart's selected period when an individual map month is displayed. Separate loading percentages, map errors and retry controls allow the map and charts to recover independently.

Observed local results
----------------------

| Check | Development | Production, with API caches populated |
| --- | --- | --- |
| Initial national map visible | 18.871 s | 0.363 s |
| Initial history displayed | 25.037 s | 0.641 s |
| Change to Tshwane | 0.757 s | 0.670 s |
| Change driver lag | 0.571 s | 0.447 s |

These are local browser measurements, not deployment guarantees. Development included initial schema and history retrieval; production reused the same running backend afterward. Both checks held the real chart response until the map appeared to prove independent rendering. The first national history still requires substantial Supabase reads. Database-side monthly aggregates would be the next step to reduce that initial delay further.

Subsequent warm API checks measured 0.207 seconds for a district chart, 0.199 seconds for a lag change, 0.012 seconds for a map month and 0.041 seconds for forecast-source retrieval. The source reported its latest daily observation as 2026-09-06; API cache timestamps are not observation dates.

Validation
----------

38 offline backend checks pass: eleven new vegetation performance checks, two existing vegetation calculation checks, ten climate checks and fifteen shared cache/reservoir checks. They cover compact/full daily calculation parity, national cache reuse, district-only cold scope, map-only scope, bounded queries, older-year NDVI scope, source errors, missing districts, partial months and cache copy isolation. Live API checks compare captured legacy and optimized national/Tshwane responses exactly across every indicator, series, summary, delta, correlation, warning, coverage value, map and ranking. Forecast-source values match the corresponding chart series. The legacy default response contract and incomplete latest-month exclusions also pass.

Development and production browser checks pass: early map rendering, complete national colors after district/lag changes, map-month isolation, indicator selection, previous-year toggle, weather register, a real 24-month CSV export with source units, independent map/chart failures and retries, date filters, ranking selection and mobile layout. Neither run reported JavaScript errors. Forecast registration and Plotly remain deferred until the forecasting studio is opened. The production build passes, with the existing large-chunk warning for deferred chart assets.

Run from backend:

```powershell
.venv/Scripts/python.exe -m unittest test_vegetation_performance test_vegetation_service.VegetationTests.test_daily_aggregation_deduplicates_and_marks_missing_days test_vegetation_service.VegetationTests.test_baseline_uses_only_prior_same_month_complete_years test_climate_performance test_dashboard_performance test_reservoir_service
```

Run from frontend against a running development or production preview server:

```powershell
$env:NIWIS_VERIFY_URL='http://127.0.0.1:5185'
$env:NIWIS_VERIFY_MODE='development'
node verify-vegetation-performance.mjs
```

Evidence: vegetation-api-verification.json, vegetation-development-verification.json, vegetation-production-verification.json, captured vegetation-legacy/optimized JSON responses and desktop/mobile screenshots in this directory.
