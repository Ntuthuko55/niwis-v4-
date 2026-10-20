# Drought dashboards: database-only sources

Verified 20 October 2026 against the configured Supabase database. The three
tables exist, their date columns are database dates, and the latest snapshot
of each contains all **52 districts**.

| Table | First date | Latest date | Observations |
| --- | --- | --- | --- |
| `meteorological_drought_master` | 2000-01-01 | 2026-09-06 | Daily meteorological observations; 9,720 records in the checked Tshwane history. |
| `hydrological_drought_master` | 2001-01-01 | 2025-12-01 | Monthly hydrological observations; 300 records in the checked Tshwane history. |
| `satellite_remote_sensing` | 2001-01-01 | 2025-12-01 | Monthly satellite observations; 300 records in the checked Tshwane history. |

The full inspected columns, types, district labels and samples are recorded in
[table-inspection.json](table-inspection.json). Numeric indicators are supplied
as double precision values; district names are strings and observation IDs are
big integers. District labels differ between tables: for example, the sources
use `City of Tshwane`, `city of tshwane`, and `tshwane`. The shared reader resolves
these aliases when loading a selected district.

## Dashboard connections

| Dashboard | Source |
| --- | --- |
| Drought Monitoring | All three tables, aligned by district and complete calendar month. |
| Hydrological Drought | `hydrological_drought_master`. |
| Satellite & Remote Sensing Drought | `satellite_remote_sensing`. |
| Standalone Meteorological Drought and regional forecasts | `meteorological_drought_master`, sharing the same source cache. |

The database was already the preferred source. This change removes the remaining
packaged CSV fallback and its setting, including the exception that previously
substituted CSV data for blocked sockets. Failed database requests now remain
visible. A database selection with no observations remains empty.

Responses identify `source_mode=database` and the applicable `source_tables`.
Existing chart fields, units, district selections, map geometry and forecast
contracts are preserved. Original CSV datasets remain reference and test inputs.
No database table or observation was modified.

## Loading and source reuse

- Successful source queries retain pagination, caching, defensive copies and
  coalescing of identical concurrent requests. Source errors are not cached.
- Latest map snapshots read only the newest date plus that date's district rows.
- District history reads only the selected district, with complete pagination.
- National daily forecast windows remain bounded to 14 days. National monthly
  sources use yearly windows, with at most eight concurrent reads.
- Meteorological Drought and combined Drought Monitoring now share the same
  cached meteorological reader, avoiding a second independent history download.
- Existing loading percentages remain in place. The satellite mobile layout
  also constrains the content column so its scrollable KPI strip cannot widen
  the entire page.

## Coverage and unavailable data

Date ranges do not establish complete daily coverage. The checked Tshwane
meteorological history contains 27 incomplete months, including the current
partial month. Rainfall totals continue to require every day of a month; annual
coverage flags and missing values remain visible. The running combined dashboard
uses **November 2025** as the latest common complete comparison month for Tshwane.
Hydrological and satellite coverage ends in December 2025, while meteorological
observations continue into September 2026. No dates or indicators were filled
to make these ranges match.

## Verification

- Twenty offline checks passed for source paging, isolated cached results,
  retries after errors, empty selections, district aliases, bounded windows,
  socket failures and existing drought calculations/cache behavior.
- Live API results were compared with direct database history. January 2025
  rainfall was independently summed from daily observations; common-month
  alignment was checked across the three source series.
- National maps and dated satellite snapshots each retain 52 districts.
  District selection and upper-case names return the correct database history.
- National and district forecast inputs were checked for hydrological and
  satellite data. The model implementations were retained.
- Database outages were simulated, including blocked sockets, with CSV reads
  forbidden. Empty sources remained empty and source failures stayed explicit.
- The production frontend build and checks for unbound JavaScript references
  passed. The import audit contains no unresolved imports and requires zero
  runtime CSV files in the current database configuration.
- Final browser checks passed for all three drought dashboards on desktop and
  mobile, including region changes, map layers, dated satellite observations
  and a visible satellite database-outage message. No JavaScript errors or CSV
  network requests were observed. The satellite mobile overflow is resolved.

Detailed API evidence: [api-verification.json](api-verification.json).
Browser results and desktop/mobile screenshots are stored alongside this report
in [browser-verification.json](browser-verification.json).

The existing Climate CSV adapter remains available only when explicitly selected
with `NIWIS_CLIMATE_SOURCE=csv`. The current configuration selects Supabase.

Re-run the live API verification from `backend` with
`.venv/Scripts/python.exe verify_drought_database.py`; add `--inspect-only` for
schema/coverage inspection. After building the frontend, run
`node verify-drought-database.mjs` from `frontend` for browser checks. Both use
read-only source requests; the browser verifier stops its own temporary servers.
