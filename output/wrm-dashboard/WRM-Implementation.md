# Water Resource Management

Implemented and verified on 28 October 2026. Dashboard 14 follows Resource Water
Quality Objectives. Open `/water-resource-management` or `/wrm`.

## Source inspection

| Relation | Records | Geography | Cadence | Coverage |
| --- | ---: | --- | --- | --- |
| `16_1_complete_wrm_matrix_master` | 1,352 | 52 districts | Annual | 2000–2025 |
| `16_2_swsa_strategic_water_matrix_master` | 130 | Five named SWSAs | Annual | 2000–2025 |

Both tables have unique entity-year keys, complete annual coverage and no missing
measurement values in the inspected data. WRM contains 16 variables across nine
categories. SWSAs contain six measured variables: rainfall, streamflow,
groundwater recharge, NDVI, snow cover and soil moisture. The source provides
province, river-system and priority-variable descriptions for all five areas.

## Implemented behavior

- Independent district and source-area scopes, with year filters and shared
  source/cache reads. The 52-district map keeps national coverage when charts
  follow one district. SWSA comparisons keep all five source areas.
- Four WRM indicator explorers, climate trends, water-volume comparison, source
  variable matrix, KPI sparklines and CSV export of annual WRM and SWSA values.
- SWSA indicator explorers, six comparison options, source profiles and area
  selection from cards. Missing observations remain gaps; map values are not
  backfilled from an earlier year.
- Source and prepared-data caches use the existing bounded shared loader with
  86,400-second default TTL and duplicate in-flight read suppression. `/wrm/`
  responses join the existing response cache. Failures are not cached. Cache
  entries are process-local and can expire earlier on restart or eviction.
- The existing Forecasting Studio supports both data sources, retaining annual
  cadence and full 26-year history. Horizons are 1, 3 or 5 years. Auto compares
  three annual baselines using chronological holdout RMSE. Other dashboards keep
  their existing models and frequency. Missing years and measurements are
  rejected rather than interpolated. No monthly records are synthesized.

## Interpretation and limits

National WRM figures are unweighted district means. Source-area overviews are
unweighted area means. The source's national-water-balance field is stored on
district rows; the dashboard preserves it as a reported value and does not
independently reconstruct a national total. Per-capita/per-hectare intensities
cannot be combined into a demand volume without population and irrigated area.
Transfer directions and industrial sector identifiers are also absent.

The volume comparison converts industrial demand and ecological reserve from
m³/year to million m³/year. Source values elsewhere retain their original units.
The components overlap and do not establish an additive balance.

SWSA polygons, district/catchment/CMA links and provider metadata are absent.
The district map is not used as a source-area boundary map. Land-use change and
wetland condition are priorities without measured columns. Soil-moisture units
are explicitly unspecified. The requirements' surface-runoff contribution
statistic is not reproduced as a computed result from these tables.

## Verification

- 26 unit/API checks passed: new WRM/annual checks plus RWQO and drinking-water
  regression coverage. Checks include pagination caps and truncation recovery,
  means and conversions, independent geography scopes, missing years/values,
  duplicate keys, source-error retry and successful API cache hits.
- Read-only live audit compared latest national and SWSA summaries with database
  values, validated geography coverage and district/area forecasts, and confirmed
  the default 24-hour TTL and repeat-response cache hit.
- Browser checks through the real frontend proxy passed for all 22 indicators,
  map values, area profiles, independent filters, styles, year validation, CSV
  export, mobile navigation/layout and source-outage retry.
- Three-year Auto training completed for both the district matrix and a named
  SWSA. Each used 26 annual observations and projected 2026, 2027 and 2028.
- The existing RWQO browser suite passed again, including its monthly six-month
  Auto forecast, after the shared studio gained annual support.
- Production build and whitespace checks passed.

Evidence: `database-verification.json`, `browser-verification.json`,
`wrm-desktop.png`, `swsa-desktop.png`, `wrm-mobile.png`, `swsa-mobile.png`.

No database rows or schema were changed. Authentication and machine networking
were left intact.
