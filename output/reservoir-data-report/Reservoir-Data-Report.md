# Dam and Reservoir Dataset Review

Monitoring cutoff: **2026-10-16**.

Source: `south_africa_reservoir_master_12vars_mapped.csv` (144,552,281 bytes).

The file contains **522,686 daily rows**, **20 columns** and **53 district reservoir groups**, from **2000-01-01** to **2026-12-31**.

## Findings that affect the dashboard

- There are 0 invalid dates, 0 missing cells and 0 duplicate district-name/date rows.
- The identifier `D_UNMAPPED` is reused by John Taolo Gaetsewe, Siyanda and Ugu. Use district names as series identifiers so these records remain separate.
- Siyanda and Z F Mgcawu refer to the same mapped geography. Both source histories remain selectable; the map uses the current Z F Mgcawu group for that polygon. National charts average source groups and are not national totals.
- 4,028 rows occur after the monitoring cutoff. Default operational views exclude them; the source file remains unchanged.
- Storage is constant throughout 52 of 53 group histories. Only Vhembe changes. Flat charts therefore reflect the file.
- All FSL values are 1,200 m amsl. Water level exactly follows FSL - (100 - % FSC) x 0.05. All inflow rates exactly equal district runoff depth x district area / 86,400. These relationships do not establish independent telemetry or gauging provenance.
- Most dam names join multiple reservoirs with `/`; data cannot be attributed separately to either named dam. No dam coordinates or reservoir footprint polygons are supplied.
- Six priority dam names occur within grouped mappings. Vanderkloof and Katse do not occur in the file. Reference capacities from the supplied specification are inventory values, not measured group capacities.
- RSI can be computed only where a same-month historical storage baseline has nonzero variability. Constant histories produce an unavailable RSI, rather than zero.
- Days-to-empty is conditional on a complete 30-day observed drawdown window. No decline produces an unavailable projection, not an assertion of unlimited supply.
- DIR has no supplied values or formula and remains unavailable.

## Units and numerical ranges

| Source column | Minimum | Maximum | Missing | Constant groups |
| --- | ---: | ---: | ---: | ---: |
| soil_moisture_m3_m3 | 0.0315999 | 0.357848 | 0 | 1 |
| rainfall_mm_day | 0 | 134.095 | 0 | 1 |
| evaporation_mm_day | 4.25 | 6 | 0 | 0 |
| runoff_mm_day | 6.029e-06 | 38.059 | 0 | 1 |
| district_area_km2 | 1644.93 | 126836 | 0 | 1 |
| water_area_km2 | 52.5 | 110.507 | 0 | 52 |
| mean_ndwi | -0.538651 | 0.000120765 | 0 | 45 |
| storage_volume_m3 | 2.51998e+08 | 6.8827e+08 | 0 | 52 |
| pct_fsc | 42.9606 | 100 | 0 | 52 |
| fsl_m_amsl | 1200 | 1200 | 0 | 53 |
| water_level_m_amsl | 1197.15 | 1200 | 0 | 52 |
| inflow_m3_s | 0.00715131 | 4953.63 | 0 | 1 |
| seepage_m3_day | 5.5 | 5.59476 | 0 | 52 |
| outflow_m3_s | 0.01 | 4953.63 | 0 | 0 |

## Display and calculation rules

Storage converts m3 to million m3 and is never summed across days. Rates stay in m3/s; seepage stays in m3/day. Daily rainfall and evaporation remain mm/day. Estimated runoff converts depth using the supplied district area, which is a catchment proxy.

Weekly level change compares exact dates seven days apart (m/week). Monthly relative storage change compares the latest date with the corresponding date one calendar month earlier (%/month). Days-to-empty divides current storage by the observed 30-day mean daily drawdown. RSI standardises the latest storage against prior years' same-calendar-month mean storage, using sample standard deviation and at least three years.

Critical FSC thresholds use the supplied strict limits: Level 3 below 15%, Level 2 below 30%, Level 1 below 50%; 50% and above are outside those alert levels. Missing values remain unavailable.

Source SHA-256: `ecd8ac46e527dc3f51b9ea02c6ff664d20fe0a15891a11c23d2f6514a92cf4d3`.
