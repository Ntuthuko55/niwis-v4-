# Section 9 database date update

Checked and connected 20 October 2026. This audit reads the three named database tables; the earlier [CSV data report](Surface-Water-Data-Report.md) remains a record of the original supplied files.

| Database table | First date | Last date |
| --- | --- | --- |
| `9_1_hydrological_station_master` | 2000-01-01 | 2026-09-24 |
| `9_2_catchment_characteristics_master` | 2000-01-01 | 2026-10-01 |
| `9_3_sansa_earth_observation_master` | 2000-01-01 | 2026-09-01 |

The catchment table now has a PostgreSQL **date** column. Its `year` is an integer; its `month` is text in **YYYY-MM** form. Measured numeric attributes use double precision. The reader uses `date` directly, avoiding assumptions that `month` is an integer.

## Catchment checks

- **16,744 rows**, **322 monthly dates**, and **52 districts**.
- All 322 dates have records for all 52 districts.
- **Zero null dates** and **zero duplicate district/date pairs**.
- All `date`, `year`, and `month` values agree.
- Cape Town has 322 dated records. Every inspected catchment attribute has one distinct value across that history. These are repeated dated snapshots for this district; the dates alone do not establish new measurements or changing catchment conditions. Other districts were not assessed for attribute variability in this check.

## Application changes

The previous configuration pointed to `9_2_catchment_master`. The runtime environment, default reader and example configuration now use **`9_2_catchment_characteristics_master`**. Other section 11/12 entries in the shared module setting are preserved.

Catchment queries now select only the requested end month. Within that month, the latest dated snapshot per district supplies land cover, soils, area and terrain attributes. The reader retains the actual snapshot dates and reports them in `catchment_coverage`.

Selecting February 2024 reads February 2024 catchment data, even though the table contains October 2026 records. Cache entries distinguish months. Missing months remain unavailable, and conflicting values for the same district and exact date are rejected. The reader does not fill an older view from newer records. Explicitly configured legacy tables without a date remain supported and labelled as undated.

The dashboard layout and hydrological/satellite calculations are retained. Source captions show the chosen catchment month. National attributes remain equal-weight district means, land-cover percentages are not renormalised, and all 52 map districts remain available after selecting a district.

Hydrological coverage still ends on 24 September 2026, so September remains partial and August 2026 remains the default complete monitoring month. October catchment records do not create October hydrological or satellite observations.

## Verification

- **11 offline tests passed**: eight dated-catchment checks plus three existing unit/cadence/coverage regressions.
- Six live HTTP checks passed: metadata, national and historical district dashboards, daily observations, forecasting input and partial September handling.
- CSV reads were blocked during live checks. The optional rainfall context was excluded so the audit accessed only the three section 9 data sources.
- Production build passed, including gzip/Brotli assets; existing plotting-bundle size warnings remain.
- Production browser checks passed for national and historical district selections, month captions, all 52 map boundaries, and mobile layout. There were no JavaScript runtime errors or source CSV requests.

Evidence: [database/date audit](database-date-verification.json), [browser checks](database-date-browser-verification.json), [desktop](dated-catchments-desktop.png), [mobile](dated-catchments-mobile.png).

From `backend`, repeat the database check with:

```powershell
.venv/Scripts/python.exe -B verify_surface_water_dates.py
```

No database records were modified, and no Git push or deployment was performed.
