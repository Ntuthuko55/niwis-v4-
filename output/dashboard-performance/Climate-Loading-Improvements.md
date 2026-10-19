Climate loading improvements
============================

Climate pages now read only their selected section. The combined overview still reads all six sections. Monthly and seasonal annual summaries are cached by source, district, section and calendar year, so the overview, section pages, overlapping date ranges and forecast sources can reuse compact results. Large daily frames are released after aggregation. The existing dashboard cache policy is retained (five minutes by default), including source-version invalidation.

National maps use a separate source-date endpoint: one observed national day for daily indicators and one source year for annual indicators. The actual source day is looked up before fetching values. District changes do not refetch the map; map-month changes do not reload chart histories. The map can render while history is still loading. Missing values remain unavailable and all 52 district boundaries remain present.

The selected history range and Supabase source are retained. Annual-only sections do not request daily/monthly histories. Forecast registration omits map work and remains on demand. Legacy complete API responses remain available through the default include_map=true behavior.

Observed local browser results
------------------------------

The first full national overview in the final production run took 37.285 seconds; its map appeared after 12.349 seconds. The test held real history responses until the map was visible, confirming that the map is independent of chart completion. The database and some caches may already have been warm, and production/development checks shared the API. These are local measurements, not deployment latency guarantees.

After the overview had populated the summary caches:

| Page | Complete display | Chart requests |
| --- | --- | --- |
| /climate/temperature | 1.471 s | 2 |
| /climate/spells | 0.851 s | 1 |
| /climate/rainfall | 0.740 s | 1 |
| /climate/evaporation | 1.345 s | 2 |
| /climate/irrigation | 0.778 s | 2 |
| /climate/streamflow | 0.708 s | 1 |

The complete nine-year temperature annual request measured 15.287 seconds in the pilot. Its subsequent compact monthly request returned 105 monthly points in 0.039 seconds. A small national map request measured 0.734 seconds in that pilot. Long uncached national histories still involve substantial database reads; database-side monthly/annual aggregates remain the next step to reduce that first-history delay further.

Validation
----------

Ten new climate tests and fifteen existing cache/reservoir checks pass. They cover section scope, overlapping-year reuse, simultaneous annual/monthly reads, heat/frost counts and runs across missing days, seasonal means, source-day map bounds, explicit CSV adapter compatibility, missing optional data and legacy response values.

All seven climate routes pass in both development and production with external font requests blocked. Browser checks verify early map rendering, complete national map colours after a district change, no history request on map-month changes, no deferred forecast registration, no Plotly download before forecasting and no JavaScript errors. Live API comparison matches every daily-section monthly metric and every source-date map value against the previous full response. Real national and Tshwane Naive forecast jobs also completed with six future monthly observations each.

Evidence: climate-production-verification.json, climate-development-verification.json, climate-api-verification.json and forecast-verification.json in this directory. Run backend tests with `.venv/Scripts/python.exe -m unittest test_climate_performance test_dashboard_performance test_reservoir_service`; run the frontend check with `node verify-climate-performance.mjs`. NIWIS_VERIFY_URL and NIWIS_VERIFY_MODE select the development server and report name. The normal frontend production build passes.
