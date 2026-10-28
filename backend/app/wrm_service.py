"""Annual section 16 district WRM matrix and independently scoped SWSA data."""
from __future__ import annotations

import json
import math
import os
import re
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import quote, urlencode

import pandas as pd
from fastapi import APIRouter, HTTPException

from app.dashboard_loader import dashboard_cache, dashboard_cache_ttl
from app.supabase_source import SupabaseSourceError, _request_page, _settings

router = APIRouter(prefix="/wrm", tags=["Water Resource Management"])
TABLES = ("16_1_complete_wrm_matrix_master", "16_2_swsa_strategic_water_matrix_master")
# Canonical key, display label, unit, source column, category, reference source.
WRM_METRICS = (
    ("precipitation", "Mean annual precipitation (MAP)", "mm/year", "Mean_Annual_Precipitation_MAP_mm_yr", "Climate", "SAWS"),
    ("evapotranspiration", "Mean annual evapotranspiration (MAE)", "mm/year", "Mean_Annual_Evapotranspiration_MAE_mm_yr", "Climate", "SAWS / derived"),
    ("rainfall_cv", "Climate variability index", "CV of annual rainfall", "Climate_Variability_Index_CV_rainfall", "Climate", "SAWS / derived"),
    ("runoff", "Mean annual runoff (MAR)", "million m³/year", "Mean_Annual_Runoff_MAR_million_m3_yr", "Surface Water", "DWS"),
    ("availability", "Surface water availability index", "MAR / demand ratio", "Surface_Water_Availability_Index_ratio", "Surface Water", "DWS / derived"),
    ("storage_efficiency", "Inter-annual storage efficiency", "%", "Inter_Annual_Storage_Efficiency_pct", "Surface Water", "DWS"),
    ("recharge", "Mean annual groundwater recharge", "mm/year", "Mean_Annual_Groundwater_Recharge_mm_yr", "Groundwater", "DWS / modelled"),
    ("groundwater_dependency", "Groundwater dependency index", "% of supply", "Groundwater_Dependency_Index_pct", "Groundwater", "DWS"),
    ("transfers", "Inter-basin transfer volumes", "million m³/year", "Inter_Basin_Transfer_Volumes_million_m3_yr", "Water Transfers", "DWS / TCTA"),
    ("reported_balance", "Reported water balance", "million m³/year", "National_Water_Balance_million_m3_yr", "Water Balance", "DWS"),
    ("municipal_demand", "Municipal water demand", "L/capita/day", "Municipal_Water_Demand_L_cap_day", "Demand", "Municipalities"),
    ("agricultural_demand", "Agricultural water demand", "m³/ha/season", "Agricultural_Water_Demand_m3_ha_season", "Demand", "NDA / DWS"),
    ("industrial_demand", "Industrial water demand", "m³/year", "Industrial_Water_Demand_m3_yr", "Demand", "DTI / DWS"),
    ("water_losses", "System losses / non-revenue water", "% of production", "System_Water_Losses_pct", "Losses", "Municipalities"),
    ("ecological_reserve", "Ecological Reserve water requirement", "m³/year", "Ecological_Reserve_Water_Requirement_m3_yr", "Ecology", "DWS"),
    ("return_flows", "Return flow / recycled water", "million m³/year", "Return_Flow_Recycled_Water_million_m3_yr", "Policy", "DWS"),
)
SWSA_METRICS = (
    ("swsa_rainfall", "SWSA rainfall (MAP)", "mm/year", "Rainfall_MAP_mm_yr", "Climate", None),
    ("swsa_streamflow", "SWSA streamflow (MAR)", "million m³/year", "Streamflow_MAR_million_m3_yr", "Surface Water", None),
    ("swsa_recharge", "SWSA groundwater recharge", "mm/year", "Groundwater_Recharge_mm_yr", "Groundwater", None),
    ("swsa_ndvi", "Vegetation index (NDVI)", "index", "Vegetation_Index_NDVI", "Vegetation", None),
    ("swsa_snow", "Snow cover", "%", "Snow_Cover_pct", "Snow", None),
    ("swsa_soil_moisture", "Soil moisture (0–10 cm)", "source units not supplied", "Soil_Moisture_0_10cm_tavg", "Soil Moisture", None),
)
SWSA_PROFILE = {"provinces": "Provinces", "rivers": "Key_River_Systems", "priorities": "Priority_Variables"}
ALL_AREAS = "All SWSAs"
SWSA_PREFIX = "SWSA: "


def _configured_tables():
    raw = os.getenv("NIWIS_SUPABASE_TABLES_MODULE_16", "").strip()
    names = tuple(part.strip() for part in raw.split(",")) if raw else TABLES
    if len(names) != 2 or any(not re.fullmatch(r"[A-Za-z0-9_. ]+", name) for name in names):
        raise SupabaseSourceError("NIWIS_SUPABASE_TABLES_MODULE_16 requires the WRM and SWSA relation names in that order.")
    return names


def _number(value):
    if value is None or isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return number if math.isfinite(number) else None


def _records(frame):
    return json.loads(frame.to_json(orient="records", double_precision=15))


def _url(base, table, params):
    return f"{base}/rest/v1/{quote(table, safe='._')}?{urlencode(params)}"


@dashboard_cache("wrm.source-rows")
def _read_table(base, key, table, kind):
    metrics = WRM_METRICS if kind == "matrix" else SWSA_METRICS
    entity = "district_name" if kind == "matrix" else "SWSA_Name"
    fields = [entity, "year", *[item[3] for item in metrics], *([] if kind == "matrix" else SWSA_PROFILE.values())]
    sample, _ = _request_page(_url(base, table, {"select": "*", "limit": "1"}), key, 0, 0)
    if not sample:
        raise SupabaseSourceError(f"WRM relation '{table}' has no observations.")
    missing = set(fields).difference(sample[0])
    if missing:
        raise SupabaseSourceError(f"WRM relation '{table}' is missing required columns: {', '.join(sorted(missing))}.")
    url = _url(base, table, {"select": ",".join(fields), "order": f"{entity}.asc,year.asc"})
    rows, content_range = _request_page(url, key, 0, 999, True)
    try:
        total = int((content_range or "").rsplit("/", 1)[1])
    except (ValueError, IndexError):
        total = None
    if not rows:
        raise SupabaseSourceError(f"WRM relation '{table}' returned an empty first page.")
    if total is not None:
        size = len(rows)
        offsets = list(range(size, total, size))
        if offsets:
            with ThreadPoolExecutor(max_workers=min(6, len(offsets))) as pool:
                pages = list(pool.map(lambda offset: _request_page(url, key, offset, min(total - 1, offset + size - 1))[0], offsets))
            for offset, page in zip(offsets, pages):
                if len(page) != min(size, total - offset):
                    raise SupabaseSourceError(f"WRM relation '{table}' returned an incomplete page. Please retry.")
                rows.extend(page)
        if len(rows) != total:
            raise SupabaseSourceError(f"WRM relation '{table}' returned an incomplete dataset.")
    else:
        while True:
            try:
                page, _ = _request_page(url, key, len(rows), len(rows) + 999)
            except SupabaseSourceError as exc:
                if "HTTP 416" in str(exc) and "PGRST103" in str(exc):
                    break
                raise
            if not page:
                break
            rows.extend(page)
    return rows


def _prepare(rows, kind, table):
    metrics = WRM_METRICS if kind == "matrix" else SWSA_METRICS
    entity = "district_name" if kind == "matrix" else "SWSA_Name"
    raw = pd.DataFrame(rows)
    if raw.empty:
        raise SupabaseSourceError(f"WRM relation '{table}' has no observations.")
    years = pd.to_numeric(raw.year, errors="coerce")
    valid_names = raw[entity].map(lambda value: isinstance(value, str) and bool(value.strip()))
    if not (years.between(1900, 2200) & years.mod(1).eq(0) & valid_names).all():
        raise SupabaseSourceError(f"WRM relation '{table}' contains an invalid entity or year.")
    frame = pd.DataFrame({"entity": raw[entity], "year": years.astype(int)})
    if frame.duplicated(["entity", "year"]).any():
        raise SupabaseSourceError(f"WRM relation '{table}' contains duplicate entity-year records; aggregation stopped to avoid double counting.")
    indicators = []
    for name, label, unit, field, category, source in metrics:
        frame[name] = raw[field].map(_number).astype(float)
        indicators.append({"key": name, "label": label, "unit": unit, "source_column": field,
                           "category": category, "source": source or "Not specified in source table",
                           "source_basis": "requirements_reference" if source else "not_supplied"})
    if kind == "swsa":
        for name, field in SWSA_PROFILE.items():
            frame[name] = raw[field].map(lambda value: str(value).strip() if value is not None else None)
    keys = [item[0] for item in metrics]
    first, last = int(frame.year.min()), int(frame.year.max())
    audit = {"table": table, "rows": len(frame), "entities": int(frame.entity.nunique()),
             "first_year": first, "last_year": last, "duplicate_entity_years": 0,
             "missing_entity_years": int(frame.entity.nunique()) * (last - first + 1) - len(frame),
             "missing_measurements": int(frame[keys].isna().sum().sum()),
             "ranges": [{"key": name, "min": _number(frame[name].min()), "max": _number(frame[name].max()),
                         "missing": int(frame[name].isna().sum()), "distinct": int(frame[name].nunique())} for name in keys]}
    return {"frame": frame, "indicators": indicators, "audit": audit}


@dashboard_cache("wrm.prepared")
def _snapshot(base, key, names):
    def load(pair):
        index, kind = pair
        return kind, _prepare(_read_table(base, key, names[index], kind), kind, names[index])
    with ThreadPoolExecutor(max_workers=2) as pool:
        return dict(pool.map(load, enumerate(("matrix", "swsa"))))


def _load():
    base, key, _ = _settings()
    return _snapshot(base, key, _configured_tables())


def _metadata(data):
    matrix, swsa = data["matrix"], data["swsa"]
    years = sorted({int(year) for section in data.values() for year in section["frame"].year.unique()})
    profiles = swsa["frame"].sort_values("year").drop_duplicates("entity", keep="last").sort_values("entity")
    return {"source": "Supabase", "frequency": "annual", "years": years,
            "regions": sorted(matrix["frame"].entity.unique()), "areas": sorted(swsa["frame"].entity.unique()),
            "profiles": _records(profiles[["entity", "year", *SWSA_PROFILE]]),
            "default_start": max(years[0], years[-1] - 9), "default_end": years[-1],
            "indicators": matrix["indicators"], "swsa_indicators": swsa["indicators"],
            "audits": {kind: section["audit"] for kind, section in data.items()},
            "cache_ttl_seconds": dashboard_cache_ttl(),
            "aggregation": "National values are unweighted district means, not population-weighted rates or independently reconciled national totals. SWSA overview values are unweighted means across the named source areas.",
            "limitations": [
                "Annual observations end in the displayed source year; no monthly or live observations are inferred.",
                "The national-water-balance column is stored on district rows. Its National view is a mean of supplied district values; components are not summed to reconstruct a national balance.",
                "Municipal and agricultural demand are intensity measures. Population, irrigated area, industrial sector identifiers and transfer directions are not supplied, so total demand and a reconciled balance cannot be derived.",
                "SWSA polygons and links to districts, catchments or CMAs are absent. The district map does not represent SWSA boundaries.",
                "Land-use change and wetland condition are named SWSA priorities without measurement columns. Soil-moisture units and provider metadata are not supplied.",
                "Reference agencies for WRM indicators come from the supplied requirements; the two tables do not establish field-level provenance or regulatory certification.",
            ]}


def _select(data, region, area, start, end):
    meta = _metadata(data)
    start = meta["default_start"] if start is None else start
    end = meta["default_end"] if end is None else end
    if start > end:
        raise HTTPException(400, "The end year must be on or after the start year.")
    if region != "National" and region not in meta["regions"]:
        raise HTTPException(400, "Select National or a district available in the WRM matrix.")
    if area != ALL_AREAS and area not in meta["areas"]:
        raise HTTPException(400, "Select All SWSAs or a named source area available in the SWSA table.")
    return start, end


def _section_value(section, entity, overview, start, end):
    frame = section["frame"]
    window = frame[frame.year.between(start, end)]
    selected = window if entity == overview else window[window.entity == entity]
    keys = [item["key"] for item in section["indicators"]]
    series = selected.groupby("year")[keys].mean()
    if not series.empty:
        series = series.reindex(range(int(selected.year.min()), int(selected.year.max()) + 1)).rename_axis("year")
    latest_year = int(selected.year.max()) if not selected.empty else None
    records = _records(series.reset_index())
    latest = next((row for row in records if row["year"] == latest_year), {})
    map_year = int(window.year.max()) if not window.empty else None
    map_frame = window[window.year == map_year]
    values = {row["entity"]: row for row in _records(map_frame[["entity", "year", *keys]])}
    comparisons = [values.get(name, {"entity": name, "year": None, **dict.fromkeys(keys)}) for name in sorted(frame.entity.unique())]
    result = {"series": records, "latest": latest, "latest_year": latest_year, "comparison_year": map_year,
              "comparison": comparisons, "selected_rows": len(selected), "selected_entities": int(selected.entity.nunique()),
              "missing_measurements": int(selected[keys].isna().sum().sum())}
    if "reported_balance" in keys:
        result["map"] = [{**row, "district_name": row["entity"]} for row in comparisons]
        flows = series[["runoff", "transfers", "return_flows", "industrial_demand", "ecological_reserve"]].copy()
        flows["industrial_demand"] = flows["industrial_demand"] / 1_000_000
        flows["ecological_reserve"] = flows["ecological_reserve"] / 1_000_000
        result["volume_comparison"] = _records(flows.reset_index())
    else:
        profiles = window.sort_values("year").drop_duplicates("entity", keep="last").sort_values("entity")
        result["profiles"] = _records(profiles[["entity", "year", *SWSA_PROFILE]])
    return result


def _dashboard_value(data, region="National", area=ALL_AREAS, start=None, end=None):
    start, end = _select(data, region, area, start, end)
    matrix = _section_value(data["matrix"], region, "National", start, end)
    swsa = _section_value(data["swsa"], area, ALL_AREAS, start, end)
    if not matrix["series"] and not swsa["series"]:
        raise HTTPException(404, "No annual WRM or SWSA observations are available for this selection.")
    return {"source": "Supabase", "frequency": "annual", "region": region, "area": area, "start": start, "end": end,
            "matrix": matrix, "swsa": swsa}


@router.get("/metadata")
def metadata():
    try:
        return _metadata(_load())
    except SupabaseSourceError as exc:
        raise HTTPException(502, str(exc)) from exc


@router.get("/dashboard")
def dashboard(region: str = "National", area: str = ALL_AREAS, start: int | None = None, end: int | None = None):
    try:
        return _dashboard_value(_load(), region, area, start, end)
    except SupabaseSourceError as exc:
        raise HTTPException(502, str(exc)) from exc


@router.get("/forecast-metadata")
def forecast_metadata():
    try:
        meta = _metadata(_load())
        return {"source": "Supabase", "frequency": "annual", "years": meta["years"],
                "default_start": meta["years"][0], "default_end": meta["default_end"],
                "regions": [*meta["regions"], SWSA_PREFIX + ALL_AREAS, *[SWSA_PREFIX + name for name in meta["areas"]]],
                "metrics": [*meta["indicators"], *meta["swsa_indicators"]]}
    except SupabaseSourceError as exc:
        raise HTTPException(502, str(exc)) from exc


@router.get("/forecast-source")
def forecast_source(region: str = "National", start: int | None = None, end: int | None = None):
    try:
        data = _load()
        swsa = region.startswith(SWSA_PREFIX)
        name = region[len(SWSA_PREFIX):] if swsa else region
        meta = _metadata(data)
        start = meta["years"][0] if start is None else start
        start, end = _select(data, "National" if swsa else name, name if swsa else ALL_AREAS, start, end)
        section = data["swsa" if swsa else "matrix"]
        selected = _section_value(section, name, ALL_AREAS if swsa else "National", start, end)
        if not selected["series"]:
            raise HTTPException(404, "No annual observations are available for this forecast selection.")
        metrics = [item for item in section["indicators"] if any(row.get(item["key"]) is not None for row in selected["series"])]
        return {"source": "Supabase", "source_table": section["audit"]["table"], "frequency": "annual",
                "region": region, "start": start, "end": end, "metrics": metrics,
                "series": [{"year": row["year"], **{item["key"]: row.get(item["key"]) for item in metrics}} for row in selected["series"]]}
    except SupabaseSourceError as exc:
        raise HTTPException(502, str(exc)) from exc
