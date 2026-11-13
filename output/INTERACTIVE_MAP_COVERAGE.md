# NIWIS interactive monitoring maps

Implemented inside the existing portal. `DashboardMap` retains Standard map,
Satellite (when configured), Street map and Interactive boundaries. Interactive
boundaries are the initial view so zoom, pan, keyboard selection, reset extent
and fullscreen are immediately available without a tile-provider dependency.

`DistrictMap` adds province extent and district controls, measurement tooltips,
selected-value captions and an explicit missing-observation legend. The province
control changes the geographic extent; choosing a district applies the existing
dashboard region filter and updates its analyses. It does not manufacture
province-level statistics from datasets that do not support that aggregation.

## Coverage and original spatial resolution

Module numbers below follow the supplied requirements, rather than the portal's
existing navigation order.

| Module | Available monitoring maps | Geographic limits retained |
| --- | --- | --- |
| 5 Vegetation | All 14 primary satellite indicators and 11 meteorological drivers | District aggregates, not new satellite rasters. Derived land degradation, pasture, cover-change and early-warning classifications need their own validated products. |
| 6 Rainfall | 19 monthly indicators, including CHIRPS/TAMSAT summaries, SPI-1/3/6/12/24, SPEI-3/12 and RAI | Daily observations are not represented as a daily geographic product. |
| 7 Runoff | 23 runoff, moisture, streamflow, anomaly and hydrological-response indicators | District summaries; catchment boundaries, river geometry and validated flood-risk classes are not supplied. Return-period source flow estimates retain their original meaning. |
| 8 Reservoirs | 12 operational measurements across 53 reported groups | Named-dam reference coordinates and explicitly labelled district-centroid proxies. A proxy is not a surveyed dam location or an independent dam observation. |
| 9 Surface water | 17 hydrological, catchment-characteristic and Earth-observation indicators | District aggregates; no invented gauge locations, land-use polygons or interpolated surfaces. |
| 10 Groundwater | 19 borehole/aquifer, recharge and supporting indicators | District records do not locate individual boreholes or aquifers. Missing GRACE products are not inferred from borehole measurements. |
| 11 Groundwater reserve | 28 hydrogeological, recharge, reserve and exploitation indicators | District aggregates; no aquifer boundary geometry or inferred sustainability thresholds. |
| 12 Water quality | 35 physical, chemical, biological and satellite-support measurements | District summaries and original units; no invented station positions or compliance thresholds. |
| 13 Wastewater | Effluent, operational and meteorological district observations | District source records do not locate treatment plants. Proxy flood indicators are not validated flood exposure or risk surfaces. |
| 14 Drinking water | Reported compliance, parameter values and stored screening results | SANS observations retain district scope. Blue Drop process scores and facility positions require an additional source; its map keeps an unavailable-data state. |
| 15 RWQO | Existing ecological, chemical and hydrological section maps | Existing district identifiers and source units are preserved. |
| 16 Water resource management | WRM district matrix; SWSA geographic workspace | Five named source areas lack supplied boundaries or verified district links. Their measurements remain in source-area charts rather than being spread across districts. |
| 17 Water quantity | Prominent transfer-district map and national-balance workspace | National monthly balance measurements are shown at national scope. No district deficit or transfer-route geometry is invented. |
| 18 Water services | Maps in Access, Operations, SANSA and Reliability tabs | SANSA has 52 district records. Other source regions mix geographies without a verified crosswalk; their boundaries stay unshaded with an explanation. |
| 19 Tariffs and costs | All three existing pricing/cost datasets | Current municipal boundaries and documented matching limitations remain explicit. Missing measurements retain grey outlines rather than disappearing or becoming zero. |

Drought, meteorological, hydrological, satellite and all six climate section
routes also keep their geographic workspace on missing observations or source
errors. GRACE district summaries explicitly retain their coarse source-resolution
limitation. The legacy provincial drought view no longer colours unavailable
observations using illustrative baseline values.

## Shared behavior and performance

- Metric choices use the existing source catalogues. Standardized drought
  indices use a labelled dry-to-wet classification; other quantities use their
  documented scales or clearly labelled numeric bands without inferred risk.
- District clicks use the existing region/apply-filter flow. Primary indicator
  trends follow map choices where they share a source; independent analytical
  panels remain separately labelled. Date controls use existing observation
  endpoints or already loaded period snapshots.
- Missing/null/non-finite values are not treated as zero. Unlocated national,
  named-area or mixed-geography values are never copied into district polygons.
- Leaflet is loaded on demand, geometry is reused, display choices/viewports are
  bounded in memory, and shared boundary requests are cached and cancelled when
  no active map needs them. Existing source caches and abortable requests remain.
- Vegetation's existing map endpoint now honours meteorological indicators with
  a separately cached monthly-driver read, avoiding national daily satellite
  reads when a user selects a weather layer. No database schema changed.
- Provider imagery and scientific layer colours are preserved across Navy and
  Light themes; controls, text, captions and selection outlines follow the theme.

## Verification

Browser verification artifacts are written to `output/interactive-map-verification/`
and `output/theme-verification/`. Run the checks against the active local frontend:

```powershell
cd frontend
node verify-interactive-maps.mjs
node verify-theme-browser.mjs
npm run build
```

The frontend proxy continues to use the existing backend on port 8000.
