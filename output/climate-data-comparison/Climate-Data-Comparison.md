# Climate database / CSV comparison

Daily tables: 2025–2025, all 52 districts. Annual tables: complete source history.

The climate dashboard reads Supabase. CSVs are used only by this separate comparison; neither source is changed.

Numeric comparisons use absolute tolerance 1e-08 and relative tolerance 1e-12. Nulls match only nulls.

| Section | Database rows | CSV rows | CSV-only rows | DB-only rows | Different paired cells |
| --- | ---: | ---: | ---: | ---: | ---: |
| temperature | 18,928 | 18,928 | 0 | 0 | 0 |
| spells | 1,404 | 1,404 | 0 | 0 | 0 |
| rainfall | 1,404 | 1,404 | 0 | 0 | 0 |
| evaporation | 18,928 | 18,928 | 0 | 0 | 0 |
| irrigation | 18,928 | 18,928 | 0 | 0 | 0 |
| streamflow | 1,404 | 1,404 | 0 | 0 | 0 |

## Dashboard period means

| Indicator | Database | CSV | Difference | Unit |
| --- | ---: | ---: | ---: | --- |
| Tmin_C | 12.165316 | 12.165316 | 0 | °C |
| Tmax_C | 23.58224 | 23.58224 | 0 | °C |
| Tavg_C | 17.873778 | 17.873778 | 0 | °C |
| Temperature_Anomaly_C | 0.010929582 | 0.010929582 | 0 | °C |
| Heat_Days | 4.8461538 | 4.8461538 | 0 | days |
| Heat_Duration | 1.5961538 | 1.5961538 | 0 | days |
| Frost_Days | 4.0384615 | 4.0384615 | 0 | days |
| LST_Day_C | 21.743656 | 21.743656 | 0 | °C |
| LST_Night_C | 12.867692 | 12.867692 | 0 | °C |
| CWD_Days | 10.346154 | 10.346154 | 0 | days |
| CDD_Days | 38.865385 | 38.865385 | 0 | days |
| Rx1day_mm | 45.371346 | 45.371346 | 0 | mm |
| Rx5day_mm | 96.592308 | 96.592308 | 0 | mm |
| PRCPTOT_mm | 831.78577 | 831.78577 | 0 | mm |
| R10mm_Days | 24.942308 | 24.942308 | 0 | days |
| R20mm_Days | 7.5 | 7.5 | 0 | days |
| SDII_mm_per_wet_day | 6.5675 | 6.5675 | 0 | mm/wet day |
| MAP_mm | 869.08635 | 869.08635 | 0 | mm/year |
| Precip_MAM_mm | 227.75212 | 227.75212 | 0 | mm |
| Precip_JJA_mm | 57.958462 | 57.958462 | 0 | mm |
| Precip_SON_mm | 201.28019 | 201.28019 | 0 | mm |
| Precip_DJF_mm | 382.09558 | 382.09558 | 0 | mm |
| Nino34_Annual_Mean | -0.28083333 | -0.28083333 | 0 | °C |
| Daily_ET0_mm | 0.11654512 | 0.11654512 | 0 | mm/day |
| Daily_PET_mm | 0.11099493 | 0.11099493 | 0 | mm/day |
| Daily_AET_mm | 0.042167477 | 0.042167477 | 0 | mm/day |
| Daily_Pan_Evap_mm | 0.14429353 | 0.14429353 | 0 | mm/day |
| Daily_VPD_kPa | 0.77272712 | 0.77272712 | 0 | kPa |
| SPEI_Daily | 0.19882861 | 0.19882861 | 0 | index |
| CWR_mm_day | 0.099066093 | 0.099066093 | 0 | mm/day |
| Irrigation_Water_Demand_mm | 15.45025 | 15.45025 | 0 | mm |
| Rainfall_Deficit_mm | 15.336212 | 15.336212 | 0 | mm |
| Soil_Moisture_Deficit_m3m3 | 0.12263247 | 0.12263247 | 0 | m³/m³ |
| Growing_Season_Temp_C | 17.873863 | 17.873863 | 0 | °C |
| Irrigation_Return_Flow_mm | 2.3177308 | 2.3177308 | 0 | mm |
| MAR_m3_year | 8.3006191e+09 | 8.3006191e+09 | 0 | m³/year |
| Streamflow_Anomaly_percent | 26.383077 | 26.383077 | 0 | % |
| Q90_LowFlow_m3_year | 4.7459763e+09 | 4.7459763e+09 | 0 | m³/year |
| Q10_FloodFlow_m3_year | 8.2350707e+09 | 8.2350707e+09 | 0 | m³/year |
| Rainfall_Runoff_Ratio | 0.93790769 | 0.93790769 | 0 | ratio |
| Climate_Streamflow_Elasticity | 1.0968846 | 1.0968846 | 0 | ratio |

## temperature

Database table: `4_1_temperature_change_master`. CSV: `section_4_1_temperature_change_master.csv`.

## spells

Database table: `4_2_wet_dry_spells_master`. CSV: `section_4_2_wet_dry_spells_master.csv`.

## rainfall

Database table: `4_3_mean_annual_precipitation_master`. CSV: `section_4_3_Mean Annual Precipitation (MAP)_master.csv`.

## evaporation

Database table: `4_4_potential_evaporation_daily_master`. CSV: `section_4_4_evaporation_daily_master.csv`.

## irrigation

Database table: `4_5_irrigation_demand_daily_master`. CSV: `section_4_5_irrigation_daily_master.csv`.

## streamflow

Database table: `4_6_streamflow_and_climate_linkage_annual _master`. CSV: `section_4_6_streamflow_annual_master.csv`.

## Evidence and limits

Raw rows are matched by district and date/year before comparing values. Missing rows are counted separately from changed values.
Dashboard values use equal-weight district/year means; daily sums use observed rows and never fill missing dates.
Annual tables are fully compared. Daily years outside the stated interval are not compared; rerun with --start and --end to widen the interval.
See comparison.json for field-level deltas and example records, dashboard-values.csv for all 41 indicators, and *-missing-rows.csv for missing keys.
