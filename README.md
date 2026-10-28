# NIWIS v4

National Integrated Water Information System (NIWIS) is a dashboard for exploring South African climate, drought, satellite, water-storage, and time-series data.

## Run locally

From the project root, create a dedicated backend environment and install its dependencies:

```powershell
python -m venv backend\.venv
.\backend\.venv\Scripts\python.exe -m pip install -r backend\requirements.txt
```

Start the backend from the project root:

```powershell
.\backend\start.ps1
```

The startup script runs a read-only connectivity check against the three
drought tables before it starts the API. Run it from a normal PowerShell
session with outbound network access; if the check fails, it stops before the
dashboard can fill with repeated Supabase socket errors. The development API
listens on `127.0.0.1:8000`.

If starting from the `backend` directory, use the same guarded startup script:

```powershell
cd backend
.\start.ps1
```

These commands use `backend\.venv` explicitly. A bare `uvicorn` command can use
the global Python installation, which may contain incompatible dependencies. If startup
reports a Pydantic/core version mismatch, reinstall the dependencies in the backend
environment with the installation command above. The application import path is
`app.main:app` when running from `backend`.

In a second terminal, start the frontend:

```powershell
cd frontend
npm install
npm run dev
```

Open the local Vite URL displayed in the terminal. The frontend proxies API requests to `http://127.0.0.1:8000`. Restart the frontend after changing proxy settings.

## Project layout

- `frontend/` - React and Vite dashboard
- `backend/` - FastAPI monitoring services and shared forecast models
- `output/` - generated verification reports and deployment notes
- `South_Africa_Provinces/` - provincial source datasets

The current file connections and source dependencies are documented in the
[system flow report](output/deployment-audit/System-Flow.md). The
[cleanup report](output/deployment-audit/Cleanup-Report.md) records removed files
and the location of the recovery archive.

The large reservoir reference CSV is stored using Git LFS. Install Git LFS and
run `git lfs pull` after cloning if the dataset has not downloaded automatically.

Runoff Status reads `runoff_variables_master` and
`7.2_derived_runoff_indicators_master` from Supabase. Set the server-only
`NIWIS_SUPABASE_TABLES_RUNOFF` in that order to override their names. Reads are
bounded by month, paginated, and cached; the original runoff CSVs remain comparison
and test inputs. Database errors are reported without switching to local files.

Surface Water Monitoring uses the dated `9_2_catchment_characteristics_master`
relation for the selected end month's catchment profile. Its hydrology and
earth-observation tables retain their own date coverage. See the
[section 9 database date check](output/surface-water-data-report/Database-Date-Update.md).

Analysis Studio and Prediction Engine have been removed, including their
exclusive frontend/backend files and standalone APIs. Forecast panels inside
monitoring dashboards remain available. See the
[removal report](output/deployment-audit/Dashboard-Removal.md).

Drought Monitoring, Hydrological Drought and Satellite & Remote Sensing Drought
now read `meteorological_drought_master`, `hydrological_drought_master` and
`satellite_remote_sensing` directly from the database. CSV fallback has been
removed. Source failures appear explicitly; maps retain all 52 districts.
Meteorological charts and forecasts share the same paginated source cache.
See the [drought database verification](output/drought-database/Drought-Database-Migration.md)
for schema, coverage and API/browser checks. In the current database configuration,
no dashboard requires a runtime CSV file. Original datasets remain reference inputs.

## Notes

Local environment files, development logs, virtual environments, and generated build output are excluded from version control.

The climate dashboard and its six indicator sections read Supabase through the
backend. The `climate/` CSV files are retained for source comparison only. Set `SUPABASE_URL` and
the server-only `SUPABASE_SERVICE_ROLE_KEY` (or an anon key with table read access)
in `backend/.env`. `NIWIS_SUPABASE_TABLES_MODULE_2` lists the six tables in section
order 4.1–4.6; the current streamflow table includes a space before `_master`.
See `backend/.env.example` for the exact names. Restart the backend after changing
configuration. Database failures appear as errors, with no CSV fallback.

Successful dashboard data, source reads, and JSON responses are cached in backend
memory for 24 hours by default (`NIWIS_DASHBOARD_CACHE_TTL`,
`NIWIS_SUPABASE_CACHE_TTL`, and `NIWIS_RESPONSE_CACHE_TTL`). The caches are
bounded and process-local, so a backend restart or cache-capacity eviction can
remove entries sooner; source errors are not cached. Change the TTL settings in
`backend/.env` and restart the backend to apply them. Climate queries still
retrieve all pages, with daily reads using bounded windows and annual tables using
exact pagination checks.
The dashboard shows available years and flags selections shorter than 30 years
and records that do not span the 1981–2010 temperature baseline.

The Groundwater Reserve Assessment module reads the three section 11 database
relations. Files in `Groundwater Reserve Assessment/` remain comparison inputs. It keeps dynamic and static reserve as
supplied indicators and derives a signed storage change and reserve balance
from water-table depth, aquifer area, the supplied storage coefficient and
abstraction. The ecological reserve is reported as unavailable because it is
not present in the supplied files.

Section 11 and section 12 service tests can be run with:

```powershell
.\.venv\Scripts\python.exe -m unittest test_groundwater_reserve_service.py test_water_quality_service.py
```

The Water Quality Monitoring Network module reads the four section 12 database
relations. Files in `water Quality Monitor/` remain comparison inputs. Physical, chemical, biological and SANSA proxy
observations remain separate, with supplied units and coverage shown directly;
no regulatory quality classification is inferred without threshold metadata.

The Wastewater Quality Compliance dashboard is module 11, placed after Dam and
Reservoir Status. It reads the three supplied Supabase relations
(`13.1_wastewater_effluent_quality_master`,
`13.2_WWTW_operational_master`, and
`13.3_meteorological_variables_(SAWS)_for_WWTW_Compliance_master`). It detects
indicators from source columns and presents KPI sparklines, an interactive district
map, effluent trend graphs, nutrient comparisons, flow versus capacity, hydraulic
loading, district comparisons and weather charts. Indicators and chart styles can
be changed without retrieving the source again. The national map retains all
districts while the charts follow the selected district. Successful source reads
share the existing 24-hour cache. The dashboard keeps table summaries independent
unless source records provide a safe common key. Green Drop grades are not
derived without certification and threshold data. Set
`NIWIS_SUPABASE_TABLES_MODULE_13` in `backend/.env` only when the deployed
relation names differ from these defaults.

Drinking Water Quality Compliance is dashboard 12 at
`/drinking-water-compliance`, after wastewater. It reads
`14.1_SANS_241_compliance_master`: 16,744 district-month records, 52 districts,
14 parameters and observations from January 2000 to October 2026 in the inspected
source. It provides an interactive map, compliance and parameter graphs, source
target lines, a recent-month check matrix, screening flags and monthly CSV export.
Source rows and successful API responses use the shared 24-hour cache.

The dashboard preserves the supplied limits, flags and reported compliance score.
Some stored limits differ from the published SANS 241:2015 reference, so these are
labelled **source targets**, rather than an independently verified certification.
Passing percentages count known flags with measurements, excluding missing values.
The relation has no supply-system IDs, sampling requirements, process scores or
Blue Drop risk ratings. Those indicators require an additional source. Override
`NIWIS_SUPABASE_TABLE_DRINKING_WATER` only when the deployed relation name differs.

Both water quality dashboards include the shared **Forecasting Studio** below
their charts. Select **Open forecasting studio**, choose National or a district,
then select a measurement, model and horizon (6 months, 1 year or 2 years).
LSTM is the default model and exposes selectable measurement inputs. Forecasts
use the latest ten calendar years of observed monthly source data, with the same
24-hour source cache. Wastewater offers effluent, operations and weather targets;
drinking water offers its 14 measurements and the reported compliance score.
Flags and diagnostic counts are excluded from forecast targets.

These studios retain monthly cadence for every model, including Auto, which
compares four monthly baseline models using chronological holdout error.
Missing measurements remain missing when registered; training reports a clear
error for incomplete selected inputs or gaps in the monthly history.

Focused drinking-water aggregation checks run from `backend` with
`.\.venv\Scripts\python.exe -m unittest test_drinking_water_service -v`.
Browser verification is `node verify-drinking-water-browser.mjs` from `frontend`.

Resource Water Quality Objectives is dashboard 13, after drinking water, at
`/resource-water-quality-objectives` (also `/rwqo`). It reads the three section 15
Supabase relations: `15.1_ecological_variables_master`,
`15.2_chemical_RWQO_variables_master`, and
`15.3_hydrological_RWQO_variables_master`. Each inspected table contains 16,744
district-month records across 52 districts, January 2000 to October 2026.
The source audit found matching district-month keys, no duplicates, no missing
district-months and no missing measurement values. Some source measurements are
negative; these remain visible with a data-quality notice.

The dashboard includes ecological, chemical and hydrological sections with 18
measurements, source score KPIs, an interactive district map, annual/monthly
trends, selectable indicators and chart styles, stored target references,
objective assessment matrices, recent failed flags and monthly CSV export.
National monthly values give districts equal weight; annual values first average
each district's available months. Missing values remain missing. The six chemical
objectives and five hydrological objectives use their stored flags. The nutrient
TN/TP pair counts as one assessment and requires both measurements. The stored
DIN target is not applied independently to the TN measurement.

Ecological targets, individual resource identifiers and gazetted objective
metadata are absent, so the dashboard does not infer ecological grades or
reach-level certification. Successful source reads, prepared data and API
responses use the shared 24-hour memory cache; errors are not cached. Override
`NIWIS_SUPABASE_TABLES_MODULE_15` only if the relation names differ, keeping the
ecological, chemical, hydrological order. Credentials remain server-only.

RWQO also uses the shared Forecasting Studio, with all 18 measurements, monthly
cadence and the latest ten calendar years of history. Missing selected inputs
are rejected during training. An Auto six-month forecast was verified; LSTM
remains selectable as the shared studio's default.

Run RWQO checks from `backend` with
`.\.venv\Scripts\python.exe -m unittest test_rwqo_service -v` and the read-only live
audit with `.\.venv\Scripts\python.exe verify_rwqo_database.py`. Run
`node verify-rwqo-browser.mjs` from `frontend` with the backend on port 8000 and
frontend on port 5173. These checks generate evidence in
[`output/rwqo-dashboard/`](output/rwqo-dashboard/); the implementation report is
[`RWQO-Implementation.md`](output/rwqo-dashboard/RWQO-Implementation.md).

Water Resource Management is dashboard 14, after RWQO, at
`/water-resource-management` (also `/wrm`). It reads the annual section 16 tables
`16_1_complete_wrm_matrix_master` and
`16_2_swsa_strategic_water_matrix_master`. The inspected district matrix has
1,352 records, 52 districts and 16 variables; the SWSA table has 130 records,
five named areas and six variables. Both cover 2000–2025, with no duplicate
entity-year keys, missing entity-years or missing measurements.

The WRM view includes a district map, all 16 variable selectors, climate and
resource trends, demand and loss measures, water-volume comparisons and the
complete variable matrix. The SWSA view provides independent area filters,
comparisons, climate/water and vegetation/snow/soil charts, river systems and
monitoring-priority profiles. Annual CSV export includes both sources. District
selection does not change SWSA scope, and area selection does not change the
district scope. Source boundaries, district-to-SWSA links, land-use change and
wetland observations are not supplied; soil-moisture units remain unspecified.

National values are equal district means. Per-capita and per-hectare demand
remain intensity measures. The `National_Water_Balance_million_m3_yr` column is
stored on district rows, so its National view is a mean of those supplied values,
not a reconciled national total. Industrial demand and ecological reserve are
converted from m³/year to million m³/year only for the volume comparison; the
components are not added to construct a balance.

Successful source reads, prepared data and `/wrm/` API responses use the shared
24-hour memory cache, with uncached failures and visible retry states. Override
`NIWIS_SUPABASE_TABLES_MODULE_16` only when relation names differ, in district
matrix then SWSA order. Credentials remain server-only.

The shared Forecasting Studio preserves annual cadence for WRM and SWSA series.
It uses all 26 available years by default and offers 1-, 3- and 5-year horizons.
Annual Auto compares Naive, Historic Average and Window Average using a
chronological holdout. Window Average uses the last five observed years. Missing
years or selected measurements are rejected. WRM offers these annual baseline
models; other dashboards keep their existing model selections and cadence.
District and SWSA three-year Auto forecasts were verified for 2026–2028.

From `backend`, run
`.\.venv\Scripts\python.exe -m unittest test_wrm_service test_annual_forecasting -v`
and the read-only live audit
`.\.venv\Scripts\python.exe verify_wrm_database.py`. Browser verification is
`node verify-wrm-browser.mjs` from `frontend`. These checks generate evidence in
[`output/wrm-dashboard/`](output/wrm-dashboard/); the implementation report is
[`WRM-Implementation.md`](output/wrm-dashboard/WRM-Implementation.md).

Water Quantity Assessment is dashboard 15, after Water Resource Management, at
`/water-quantity-assessment` (also `/water-quantity`). Its read-only source
inspection found **monthly reporting records**, not daily observations:

- `17_1_water_quantity_assessment_transfers_master`: 5,152 district-month records,
  16 districts, eight indicators, January 2000–October 2026.
- `17_2_national_water_balance_master`: 322 national-month records, ten water
  components plus reported total demand and net balance, over the same period.

Both tables have unique reporting keys, complete reporting-row coverage and no
missing measurements in the inspected data. Transfer columns retain their
supplied daily-rate/intensity units. No daily records or monthly transfer totals
are generated from them. All four transfer-rate columns report zero in all 16
districts for October 2026; these values remain zero with a visible notice because
the source has no zero-verification flags. Tugela–Vaal and Thukela–Vaal columns
remain separate because scheme identifiers and overlap rules are absent.

National transfer summaries use equal source-district means. The 52-district map
keeps the 36 uncovered districts grey and explains their missing source coverage.
The national balance table stays national when transfer-district filters change.
It preserves the supplied Mm³ values, with no annual summing of storage stocks or
undocumented volume periods.

The inspection found that stored total demand includes the Environmental Reserve.
The stored net balance follows `MAP - AET - MAR - groundwater recharge + net IBT -
total demand`, excluding storage. These inferred expressions match all 322 rows
within 0.025 Mm³; maximum differences are 0.01 and 0.02 Mm³ respectively. They are
displayed as source arithmetic checks, without claiming independently verified
hydrological accounting or changing the stored values.

The dashboard includes transfer and national-balance sections, KPI sparklines,
source coverage mapping, indicator/style selectors, comparison and component
charts, calculation checks, source matrices and monthly CSV export. Source reads,
prepared data and API responses use the shared 24-hour memory cache; failed reads
are not cached. Override `NIWIS_SUPABASE_TABLES_MODULE_17` only if relation names
differ, keeping transfer then national-balance order. Credentials stay server-only.

The shared Forecasting Studio offers the national balance and explicitly labelled
transfer forecast contexts. The two sources are never joined into district
balance records. Both use monthly cadence, the latest ten calendar years of
source history and rejection of missing selected inputs. Six-month Auto forecasts
were verified for November 2026–April 2027 for both sources. These projections do
not establish a daily operational feed.

From `backend`, run
`.\.venv\Scripts\python.exe -m unittest test_water_quantity_service -v` and the
read-only audit `.\.venv\Scripts\python.exe verify_water_quantity_database.py`.
Browser verification is `node verify-water-quantity-browser.mjs` from `frontend`.
See the [source inspection and implementation report](output/water-quantity-dashboard/Water-Quantity-Assessment.md)
for findings, limitations and verification evidence.

Run the climate reader/API regression checks from `backend`:

```powershell
.\.venv\Scripts\python.exe -m unittest test_climate_service
```

The live database value check (including national/district agreement) is:

```powershell
.\.venv\Scripts\python.exe verify_climate_values.py
```

Compare the database source with the local CSV copies:

```powershell
.\.venv\Scripts\python.exe compare_climate_sources.py
```

Vegetation dashboard loading improvements and measured checks are documented in
[Vegetation loading improvements](output/dashboard-performance/Vegetation-Loading-Improvements.md).

Rainfall Status Monitoring uses independent map/daily requests and shared monthly
summaries. See [Rainfall loading improvements](output/dashboard-performance/Rainfall-Loading-Improvements.md)
for measured timings and validation.

Groundwater Level Monitoring Network uses cached monthly summaries and independent
map/daily loading while preserving sparse observation dates. See
[Groundwater loading improvements](output/dashboard-performance/Groundwater-Loading-Improvements.md).
