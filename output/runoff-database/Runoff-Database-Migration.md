# Runoff Status database connection

The later [dashboard removal and current CSV inventory](../deployment-audit/Dashboard-Removal.md)
supersedes this migration report's initial runtime-file inventory.

Updated 20 October 2026. Runoff Status now reads these two Supabase relations:

| Purpose | Table |
| --- | --- |
| Daily catchment/runoff observations | `runoff_variables_master` |
| Monthly derived indicators | `7.2_derived_runoff_indicators_master` |

The backend configuration is `NIWIS_SUPABASE_TABLES_RUNOFF=runoff_variables_master,7.2_derived_runoff_indicators_master`, in that order. The runtime environment and example configuration both contain this setting. Credentials stay in the backend.

## Schema and coverage

Live inspection verified column names, PostgreSQL data types, samples and date bounds before mapping the reader. Districts and land cover are text; dates are PostgreSQL dates; year/month are integers; source measurements are double precision.

- Daily coverage: **2000-01-01 through 2026-09-06**.
- Monthly derived catalogue: **16,692 observations**, covering January 2000 through September 2026 across **52 districts**.
- All **23 dashboard indicators** retain their existing keys, units and methods.
- The derived table's `date` is the 25th of the reporting month. The reader uses its `Year` and `Month` fields, preserving reporting periods.
- September 2026 has six observed daily records per district and remains incomplete. The default complete period ends in **August 2026**.

## Behaviour

All four existing `/runoff` endpoints (`metadata`, `dashboard`, `daily`, `forecast-source`) now return `source=Supabase`, `source_mode=database`, and the two resolved table names. Original source columns and API metric keys are preserved.

Daily database reads are limited to one calendar month and one requested district when applicable. Results use stable ordering and pages of at most 1,000 records. At most eight source requests run concurrently; successful monthly summaries share the existing dashboard cache. Metadata reads the small monthly catalogue and assesses only recent daily months, avoiding full daily-history reads and exact full-table counts. Year-on-year comparisons load only the required preceding history.

The national map still contains all 52 districts when a district is selected. Monthly volumes, rainfall/ET depths, weighted ratios, period maxima, daily mean rates, incomplete months, annual filter scope and forecast-source values preserve their calculation semantics. Period baseflow means weight monthly means by the number of nonmissing daily rate observations.

The layout, filters and charts are retained. Source labels identify database observations, an unrequested full daily count displays as `Not counted`, and constant-attribute statements identify the assessed snapshot. The database is a supplied-data snapshot; it does not establish live gauge telemetry.

Database failures produce a visible error and retry state. There is **no runtime CSV fallback** in this module. The two original runoff CSVs remain independent comparison/test inputs; neither is required to run the dashboard. The application's remaining default runtime/fallback CSV inventory is four files, approximately **77.48 MiB**.

## Verification

- **22 offline tests passed** across `test_runoff_service` and `test_dashboard_performance`: unit conversions, leap-year daily detail, missing values, repeated monthly values, source aliases, malformed/missing schema, pagination, prior-year comparisons, full map coverage and database errors.
- Live HTTP checks passed for metadata, national/district dashboards, daily detail, forecast input, partial-month handling and warm-cache reuse. Runtime CSV reads were blocked during these checks.
- Independent City of Tshwane reference calculations for February–March 2024 matched database API runoff volume, baseflow and peak flow.
- Production frontend build passed, including gzip/Brotli assets. Existing plotting-bundle size warnings remain.
- Production browser checks passed: national/district charts and all 52 map boundaries, February daily CSV export, mobile layout, database failure and retry. There were zero JavaScript runtime errors and zero source CSV requests.

The live check recorded approximately 7.33 seconds for cold metadata, 7.40 seconds for the subsequent default national dashboard, 0.91 seconds for the district history, 0.30 seconds for daily detail, and 0.05 seconds for a warm default dashboard. These are observations from one run, not a controlled comparison with the old CSV reader.

Evidence: [API verification](api-verification.json), [browser verification](browser-verification.json).

Re-run from `backend`:

```powershell
.venv/Scripts/python.exe -B -m unittest test_runoff_service test_dashboard_performance
.venv/Scripts/python.exe -B verify_runoff_database.py
```

For the rendered checks, build the frontend and run `node verify-runoff-database.mjs` from `frontend`. That verifier starts and stops its own local API/preview services. No deployment or Git push was performed as part of this migration.
