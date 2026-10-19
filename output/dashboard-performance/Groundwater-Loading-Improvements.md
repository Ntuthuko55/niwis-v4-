Groundwater Level Monitoring Network loading improvements
========================================================

The groundwater page now loads its national map separately from district charts and daily observations. District changes reuse the national map; choosing a map month or daily-observation month does not reload chart history. District boundaries load independently, so a failed boundary download does not block charts, tables or exports.

The backend caches compact monthly district summaries by source, region and calendar year using the existing five-minute dashboard cache policy. Simultaneous map/chart requests share their year load. District and forecast requests reuse available national summaries. A district opened without a national cache still uses district-filtered database queries. Raw yearly observation frames are released after aggregation; daily responses have a separate cache for the requested month and region. Paginated source reads retain their 90-day bounds and share a limit of 12 active reads.

Groundwater maps preserve each district/indicator's latest supplied observation inside the selected period. The map checks recent years first and stops once every district/indicator has a value, avoiding a full historical read when recent observations suffice. A historical lookup cannot borrow a reading from before the selected start month. All 52 district identities remain, including nulls where observations are unavailable.

The map selector explicitly offers Selected period and individual months. The default period map retains October 2026 hydraulic-head observations when the period ends in December. An explicit December-only map leaves that indicator unavailable and labels the absence. Returning to Selected period restores the cached October observations. Map notes use the actual observation month, independently of chart loading.

Sparse-month failure fixed
-------------------------

A December-only dashboard request previously returned HTTP 500 when some long-form indicators were absent from that month. Monthly preparation now retains all 19 variable columns with nulls for unavailable values. Recharge-support-only selections also retain their supplied fields without conflicting column names. No missing observations are interpolated or replaced with zeros.

Supabase remains the source: 10_1_borehole_and_aquifer_master and 10_2_recharge_supporting _master. Monthly means, repeated-observation weighting, source units, latest-value rules, source coverage and raw-row quality counts are preserved. hydraulic_head_amsl_m retains m amsl; the separate hydraulic_head_m_amsl source field retains its supplied m bgl unit. The existing quality counter's reporting cutoff of 13 October 2026 is preserved.

Observed local results
----------------------

| Browser check | Development run | Production, with backend caches populated |
| --- | --- | --- |
| National map visible | 8.255 s | 1.000 s |
| Chart history and daily detail ready | 9.356 s | 1.231 s |
| Change to Tshwane, including daily detail | 1.218 s | 0.281 s |

The production check reused the running backend after development verification. No forced database-cache reset was performed. These are local measurements, not deployment guarantees; uncached schema and historical reads can take longer. Both tests held the real chart response until the map appeared to confirm independent rendering.

Warm API checks measured 0.020 seconds for the compact district chart, 0.013 seconds for forecast-source retrieval and 0.003 seconds for previously inspected October daily observations. A map selection covering 2000-2026 returned all 52 districts and October 2026 hydraulic-head values while the map loader needed only the recent summaries.

Validation
----------

62 offline backend checks pass: fourteen new groundwater performance checks, twelve rainfall checks, eleven vegetation checks, ten climate checks and fifteen shared cache/reservoir checks. Coverage includes monthly means, repeated observations, missing indicators, recharge-support-only years, original raw-row quality counts, recent-year map stopping, per-district historical lookup, selected-period bounds, national-summary reuse, district-only cold query scope, simultaneous map/chart loads, irregular daily dates, source errors and bounded queries.

Live API comparisons exactly match captured national and Tshwane dashboard responses across every field: all 19 indicators, monthly series, latest values, maps and observation periods, warnings, source coverage and quality counts. October/December daily responses and the forecast-source response also match exactly. Compact forecast-source values match their chart series. A December-only dashboard now succeeds with unavailable hydraulic-head values as null.

Development and production browser checks pass: early independent maps; full national colors after district selection; actual observation dates and bounded sparse-month maps; map/daily month isolation; independent map/chart/daily errors and retries; boundary-failure isolation; all 19 register rows; real monthly/daily CSV downloads with source units; December-only filters; and mobile layout. Both runs report no JavaScript errors. Forecast registration and Plotly remain deferred until the forecasting studio is opened. The production build passes with the existing large-chunk warning for deferred chart assets.

Run from backend:

```powershell
.venv/Scripts/python.exe -m unittest test_groundwater_performance test_rainfall_performance test_vegetation_performance test_climate_performance test_dashboard_performance test_reservoir_service
```

Run from frontend against a running development or production preview server:

```powershell
$env:NIWIS_VERIFY_URL='http://127.0.0.1:5185'
$env:NIWIS_VERIFY_MODE='development'
node verify-groundwater-performance.mjs
```

Evidence in this directory: groundwater-api-verification.json, groundwater-development-verification.json, groundwater-production-verification.json, captured groundwater-legacy/optimized JSON responses and desktop/mobile screenshots.
