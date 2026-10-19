"""Supabase-backed Groundwater Reserve Assessment (section 11)."""
from __future__ import annotations

import json
import os
import re
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache
from threading import Lock
from time import monotonic
from urllib.parse import quote, urlencode
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

import pandas as pd
from pathlib import Path
from fastapi import APIRouter, HTTPException

from app.dashboard_loader import dashboard_cache
from app.supabase_source import SupabaseSourceError, _request_page, _settings

router = APIRouter(prefix="/groundwater-reserve", tags=["Groundwater reserve assessment"])
TABLE_ENV = "NIWIS_SUPABASE_TABLES_MODULE_7"
RESERVE_TABLE_ENV = "NIWIS_SUPABASE_TABLES_MODULE_11"
DEFAULT_TABLES = ("11_1_hydrogeological", "11.2_recharge_and_discharge", "11.3_aquifer_sustainability")
PAGE_SIZE = 1000
SCHEMA_TTL_SECONDS = 900

# Kept for compatibility with existing reports/tests. Runtime reads are
# database-first and do not use these files.
ROOT = Path(__file__).resolve().parents[2] / "Groundwater Reserve Assessment"
FILES = ["11.1_hydrogeological_unified_timeseries.csv", "11.2_recharge_discharge_unified_timeseries.csv", "11.3_aquifer_sustainability_unified_timeseries.csv"]

METRICS = {
    "water_table_depth_m_bgl": ("Depth to water table", "m bgl", "Hydrogeology", "Supplied monthly water-table depth"),
    "aquifer_extent_km2": ("Aquifer extent", "km²", "Hydrogeology", "Supplied aquifer map area"),
    "saturated_thickness_m": ("Saturated thickness", "m", "Hydrogeology", "Supplied saturated aquifer thickness"),
    "depth_to_bedrock_m_bgl": ("Depth to aquifer base", "m bgl", "Hydrogeology", "Supplied depth to bedrock / aquifer base"),
    "dynamic_reserve_million_m3_yr": ("Dynamic reserve", "million m³/year", "Reserve", "Supplied renewable reserve"),
    "static_reserve_million_m3": ("Static reserve", "million m³", "Reserve", "Supplied groundwater in storage"),
    "storage_coefficient": ("Groundwater storage coefficient", "dimensionless", "Hydrogeology", "Supplied storage coefficient"),
    "permeability_m_day": ("Hydraulic conductivity", "m/day", "Hydrogeology", "Supplied permeability / hydraulic conductivity"),
    "porosity_percent": ("Porosity", "%", "Hydrogeology", "Supplied total and effective porosity"),
    "specific_storage": ("Specific storage", "dimensionless", "Hydrogeology", "Supplied specific storage"),
    "specific_yield": ("Specific yield", "dimensionless", "Hydrogeology", "Supplied specific yield"),
    "storativity_specific_yield": ("Storativity / specific yield", "dimensionless", "Hydrogeology", "Supplied storage coefficient / storativity / specific yield"),
    "transmissivity_m2_day": ("Transmissivity", "m²/day", "Hydrogeology", "Supplied aquifer-test transmissivity"),
    "rainfall_infiltration_mm_yr": ("Rainfall infiltration", "mm/year", "Recharge", "Supplied effective rainfall reaching the water table"),
    "direct_recharge_mm_yr": ("Direct recharge", "mm/year", "Recharge", "Supplied rainfall-derived recharge fraction"),
    "indirect_recharge_m3_yr": ("Indirect recharge", "m³/year", "Recharge", "Supplied river-fed / flood recharge"),
    "baseflow_discharge_m3_s": ("Baseflow discharge", "m³/s", "Discharge", "Supplied groundwater discharge to rivers"),
    "spring_discharge_l_s": ("Spring discharge", "L/s", "Discharge", "Supplied natural spring flow"),
    "evapotranspiration_mm": ("Groundwater evapotranspiration", "mm", "Discharge", "Supplied groundwater ET"),
    "total_abstraction_m3_yr": ("Total abstraction", "m³/year", "Sustainability", "Supplied annual licensed abstraction"),
    "exploitation_index_percent": ("Exploitation index", "%", "Sustainability", "Supplied abstraction-to-recharge ratio"),
    "aquifer_depletion_rate_m_yr": ("Aquifer depletion rate", "m/year", "Sustainability", "Supplied water-table decline rate"),
    "borehole_yield_m3_h": ("Borehole yield", "m³/h", "Sustainability", "Supplied sustainable borehole yield"),
    "water_quality_for_use": ("Water quality for use", "index", "Sustainability", "Supplied water-use quality indicator"),
    "recharge_sensitivity_percent": ("Recharge sensitivity", "%", "Sustainability", "Supplied vulnerability to land-use change and drought"),
    "storage_change_m3_yr": ("Change in storage", "m³/year", "Derived balance", "Derived from water-table change, aquifer area and storage coefficient"),
    "storage_change_million_m3_yr": ("Change in storage", "million m³/year", "Derived balance", "Derived signed storage change in reserve units"),
    "reserve_balance_million_m3_yr": ("Groundwater reserve balance", "million m³/year", "Derived balance", "Dynamic reserve minus abstraction plus change in storage"),
}

HYDRO_FIELDS = {
    "water_table_depth_m_bgl": ("value",),
    "aquifer_extent_km2": ("Aquifer extent (map area)",),
    "saturated_thickness_m": ("Aquifer saturated thickness",),
    "depth_to_bedrock_m_bgl": ("Depth to bedrock / aquifer base",),
    "dynamic_reserve_million_m3_yr": ("Dynamic (renewable) reserve",),
    "storage_coefficient": ("Groundwater storage coefficient",),
    "permeability_m_day": ("Permeability / hydraulic conductivity",),
    "porosity_percent": ("Porosity (total and effective)",),
    "specific_storage": ("Specific storage",),
    "specific_yield": ("Specific yield",),
    "static_reserve_million_m3": ("Static reserve volume",),
    "storativity_specific_yield": ("Storage coefficient / storativity / specific yield",),
    "transmissivity_m2_day": ("Transmissivity",),
}
RECHARGE_FIELDS = {
    "rainfall_infiltration_mm_yr": ("Rainfall infiltration",),
    "direct_recharge_mm_yr": ("Direct recharge",),
    "indirect_recharge_m3_yr": ("Indirect recharge",),
    "baseflow_discharge_m3_s": ("Baseflow discharge",),
    "spring_discharge_l_s": ("Spring discharge",),
    "evapotranspiration_mm": ("Evapotranspiration",),
}
SUSTAINABILITY_FIELDS = {
    "total_abstraction_m3_yr": ("Total abstraction",),
    "exploitation_index_percent": ("Exploitation index",),
    "aquifer_depletion_rate_m_yr": ("Aquifer depletion rate",),
    "borehole_yield_m3_h": ("Borehole yield",),
    "water_quality_for_use": ("Water quality for use",),
    "recharge_sensitivity_percent": ("Recharge sensitivity",),
}

_SNAPSHOT_LOCK = Lock()
_METADATA_LOCK = Lock()


def _normalise(value: str) -> str:
    return re.sub(r"[^a-z0-9]", "", str(value).lower())


def _find_column(columns: list[str], *names: str) -> str | None:
    lookup = {_normalise(column): column for column in columns}
    return next((lookup[_normalise(name)] for name in names if _normalise(name) in lookup), None)


def _configured_tables() -> tuple[str, str, str]:
    explicit = os.getenv(RESERVE_TABLE_ENV, "").strip()
    raw = explicit or os.getenv(TABLE_ENV, "")
    configured = [part.strip() for part in raw.split(",") if part.strip()]
    reserve = [name for name in configured if re.match(r"^11[._][123](?:[._]|$)", name)]
    if len(reserve) < 3 and len(configured) == 3:
        reserve = configured
    if len(reserve) >= 3:
        ordered = []
        for index in (1, 2, 3):
            match = next((name for name in reserve if re.match(rf"^11[._]{index}(?:[._]|$)", name)), None)
            if match:
                ordered.append(match)
        if len(ordered) == 3:
            reserve = ordered
    if len(reserve) != 3:
        reserve = list(DEFAULT_TABLES)
    if any(not re.fullmatch(r"[A-Za-z0-9_. ]+", name) for name in reserve):
        raise SupabaseSourceError(f"{RESERVE_TABLE_ENV} or {TABLE_ENV} contains an unsupported table name.")
    return tuple(reserve)  # type: ignore[return-value]


def _table_candidates(configured: str, index: int) -> list[str]:
    candidates = [configured]
    if index == 0:
        variants = (configured.replace("11.1_", "11_1_", 1), configured.replace("11_1_", "11.1_", 1))
    elif index == 1:
        variants = (configured.replace("11_2_", "11.2_", 1), configured.replace("11.2_", "11_2_", 1))
    else:
        variants = (configured.replace("11_3_", "11.3_", 1), configured.replace("11.3_", "11_3_", 1))
    for value in variants:
        if value not in candidates:
            candidates.append(value)
    return candidates


def _table_url(base: str, table: str, params: dict[str, str]) -> str:
    return f"{base}/rest/v1/{quote(table, safe='._')}?{urlencode(params)}"


def _select_columns(columns: list[str]) -> str:
    """Quote source identifiers containing spaces or punctuation for PostgREST."""
    return ",".join(column if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", column) else f'"{column.replace(chr(34), chr(34) * 2)}"' for column in columns)


def _read_pages(base: str, key: str, table: str, params: dict[str, str]) -> list[dict]:
    """Read a bounded PostgREST query with concurrent 1,000-row pages."""
    # Range pagination and a URL-level limit conflict in PostgREST. The
    # reader owns the page size, so discard any caller-provided limit.
    params = {name: value for name, value in params.items() if name != "limit"}
    first, content_range = _request_page(_table_url(base, table, params), key, 0, PAGE_SIZE - 1, True)
    try:
        total = int((content_range or "").rsplit("/", 1)[1])
    except (ValueError, IndexError):
        total = len(first)
    if len(first) >= total or len(first) < PAGE_SIZE:
        return first
    ranges = [(offset, min(total - 1, offset + PAGE_SIZE - 1)) for offset in range(PAGE_SIZE, total, PAGE_SIZE)]
    with ThreadPoolExecutor(max_workers=min(12, len(ranges))) as executor:
        pages = list(executor.map(lambda item: _request_page(_table_url(base, table, params), key, item[0], item[1])[0], ranges))
    return first + [row for page in pages for row in page]


def _request_document(base: str, key: str) -> dict:
    request = Request(f"{base}/rest/v1/", headers={"apikey": key, "Authorization": f"Bearer {key}", "Accept": "application/json"})
    try:
        with urlopen(request, timeout=45) as response:
            value = json.loads(response.read().decode("utf-8"))
    except (HTTPError, URLError, TimeoutError) as exc:
        raise SupabaseSourceError(f"Could not inspect Supabase schema: {exc}") from exc
    return value if isinstance(value, dict) else {}


def _column_descriptors(properties: dict, sample: dict | None) -> list[dict]:
    names = list(properties) if properties else list((sample or {}).keys())
    return [{"name": name, "type": (properties.get(name) or {}).get("type", "unknown"), "format": (properties.get(name) or {}).get("format")} for name in names]


def _resolve_relation(base: str, key: str, configured: str, index: int) -> str:
    errors = []
    for candidate in _table_candidates(configured, index):
        try:
            _request_page(_table_url(base, candidate, {"select": "*", "limit": "1"}), key, 0, 0)
            return candidate
        except SupabaseSourceError as exc:
            errors.append(str(exc))
            if "PGRST205" not in str(exc) and "Could not find the table" not in str(exc):
                raise
    raise SupabaseSourceError(f"Could not resolve groundwater reserve table '{configured}'. " + (errors[-1] if errors else ""))


@lru_cache(maxsize=4)
def _snapshot_cached(base: str, key: str, configured: tuple[str, str, str], epoch: int) -> dict:
    del epoch
    names = tuple(_resolve_relation(base, key, name, index) for index, name in enumerate(configured))
    definitions = _request_document(base, key).get("definitions", {})
    kinds = ("hydrogeology", "recharge", "sustainability")
    descriptors, columns, properties = [], {}, {}
    for index, table in enumerate(names):
        sample_rows, _ = _request_page(_table_url(base, table, {"select": "*", "limit": "1"}), key, 0, 0)
        sample = sample_rows[0] if sample_rows else {}
        definition = definitions.get(table, {}) if isinstance(definitions, dict) else {}
        table_properties = definition.get("properties", {}) if isinstance(definition, dict) else {}
        kind = kinds[index]
        descriptor = {"table": table, "configured_table": configured[index], "columns": _column_descriptors(table_properties, sample)}
        descriptors.append(descriptor); columns[kind] = [item["name"] for item in descriptor["columns"]]; properties[kind] = table_properties
    region = {kind: _find_column(columns[kind], "district_name", "district", "region") for kind in kinds}
    province = {kind: _find_column(columns[kind], "province_name", "province") for kind in kinds}
    year = {kind: _find_column(columns[kind], "year") for kind in kinds}
    month = {kind: _find_column(columns[kind], "month") for kind in kinds}
    if any(not region[kind] or not year[kind] or not month[kind] for kind in kinds):
        raise SupabaseSourceError("Section 11 tables must expose district_name, year, and month columns.")
    actual = {}
    for kind, field_map in (("hydrogeology", HYDRO_FIELDS), ("recharge", RECHARGE_FIELDS), ("sustainability", SUSTAINABILITY_FIELDS)):
        actual[kind] = {canonical: _find_column(columns[kind], *choices) for canonical, choices in field_map.items()}
    if not actual["hydrogeology"].get("water_table_depth_m_bgl"):
        raise SupabaseSourceError("The hydrogeological table must expose its water-table value column.")
    return {"base": base, "key": key, "tables": dict(zip(kinds, names)), "configured_tables": dict(zip(kinds, configured)), "descriptors": descriptors, "columns": columns, "properties": properties, "region": region, "province": province, "year": year, "month": month, "actual": actual}


def _snapshot() -> dict:
    base, key, _ = _settings(); configured = _configured_tables(); epoch = int(monotonic() // SCHEMA_TTL_SECONDS)
    with _SNAPSHOT_LOCK:
        return _snapshot_cached(base, key, configured, epoch)


def _descriptor_rows(snapshot: dict) -> list[dict]:
    result = []
    for index, descriptor in enumerate(snapshot["descriptors"]):
        kind = ("hydrogeology", "recharge", "sustainability")[index]
        table = descriptor["table"]; region = snapshot["region"][kind]; year = snapshot["year"][kind]; month = snapshot["month"][kind]
        select = f"{region},{year},{month}"; order = f"{year}.asc,{month}.asc"
        first, content_range = _request_page(_table_url(snapshot["base"], table, {"select": select, "order": order, "limit": "1"}), snapshot["key"], 0, 0, True)
        last, _ = _request_page(_table_url(snapshot["base"], table, {"select": select, "order": f"{year}.desc,{month}.desc", "limit": "1"}), snapshot["key"], 0, 0)
        try: rows = int((content_range or "").rsplit("/", 1)[1])
        except (ValueError, IndexError): rows = None
        result.append({**descriptor, "rows": rows, "first": first[0] if first else None, "last": last[0] if last else None})
    return result


def _metadata_snapshot(snapshot: dict) -> dict:
    descriptors = _descriptor_rows(snapshot)
    first = descriptors[0]["first"] or {}; last = descriptors[0]["last"] or {}
    year_column, month_column = snapshot["year"]["hydrogeology"], snapshot["month"]["hydrogeology"]
    if first.get(year_column) is None or last.get(year_column) is None:
        raise SupabaseSourceError("The hydrogeological table is empty.")
    first_period = pd.Period(f"{int(first[year_column]):04d}-{int(first[month_column]):02d}", freq="M")
    last_period = pd.Period(f"{int(last[year_column]):04d}-{int(last[month_column]):02d}", freq="M")
    months = [str(period) for period in pd.period_range(first_period, last_period, freq="M")]
    region = snapshot["region"]["hydrogeology"]
    rows = _read_pages(snapshot["base"], snapshot["key"], snapshot["tables"]["hydrogeology"], {"select": region, "order": f"{region}.asc", year_column: f"eq.{last_period.year}"})
    regions = sorted({str(row[region]) for row in rows if row.get(region) is not None})
    source_rows = []
    for index, descriptor in enumerate(descriptors):
        kind = ("hydrogeology", "recharge", "sustainability")[index]
        source_rows.append({"file": descriptor["table"], "table": descriptor["table"], "rows": descriptor["rows"], "cadence": "Monthly district values", "attribution": f"Supabase section 11.{index + 1}"})
    return {"source": "Supabase", "source_tables": [item["table"] for item in descriptors], "schema": descriptors, "first_date": f"{first_period}-01", "last_date": f"{last_period.end_time:%Y-%m-%d}", "latest_period": str(last_period), "default_start": int(first_period.year), "default_end": int(last_period.year), "years": list(range(first_period.year, last_period.year + 1)), "months": months, "regions": regions, "rows": {("hydrogeology", "recharge", "sustainability")[index]: descriptor["rows"] for index, descriptor in enumerate(descriptors)}, "files": [item["table"] for item in descriptors], "metrics": [{"key": key, "label": label, "unit": unit, "category": category, "description": description} for key, (label, unit, category, description) in METRICS.items()], "sources": source_rows}


def _metadata() -> dict:
    with _METADATA_LOCK:
        snapshot = _snapshot(); signature = (snapshot["base"], hash(snapshot["key"]), tuple(snapshot["tables"].items()), int(monotonic() // SCHEMA_TTL_SECONDS)); cached = getattr(_metadata, "_cache", None)
        if cached and cached[0] == signature: return cached[1]
        value = _metadata_snapshot(snapshot); _metadata._cache = (signature, value); return value


def _read_table(snapshot: dict, kind: str, start_year: int, end_year: int) -> pd.DataFrame:
    table = snapshot["tables"][kind]; region = snapshot["region"][kind]; province = snapshot["province"][kind]; year = snapshot["year"][kind]; month = snapshot["month"][kind]
    actual = snapshot["actual"][kind]; requested = [column for column in actual.values() if column]
    columns = list(dict.fromkeys([region, province, year, month, *requested]))
    params = {"select": _select_columns(columns), "order": f"{region}.asc,{year}.asc,{month}.asc", year: f"gte.{start_year}", "and": f"({year}.lte.{end_year})"}
    rows = _read_pages(snapshot["base"], snapshot["key"], table, params)
    frame = pd.DataFrame(rows, columns=columns)
    rename = {region: "district_name", province: "province_name", year: "year", month: "month"}
    rename.update({column: canonical for canonical, column in actual.items() if column})
    frame = frame.rename(columns=rename)
    if frame.empty:
        return frame
    frame["year"] = pd.to_numeric(frame["year"], errors="coerce"); frame["month"] = pd.to_numeric(frame["month"], errors="coerce")
    for key in actual:
        if key in frame: frame[key] = pd.to_numeric(frame[key], errors="coerce")
    return frame.dropna(subset=["district_name", "year", "month"]).drop_duplicates(["district_name", "year", "month"], keep="last")


def _prepare(snapshot: dict, start_year: int, end_year: int) -> pd.DataFrame:
    read_start = max(int(start_year) - 1, int(_metadata()["default_start"]))
    with ThreadPoolExecutor(max_workers=3) as executor:
        hydro, recharge, sustainability = executor.map(lambda kind: _read_table(snapshot, kind, read_start, int(end_year)), ("hydrogeology", "recharge", "sustainability"))
    keys = ["district_name", "province_name", "year", "month"]
    monthly = hydro.merge(recharge, on=keys, how="outer").merge(sustainability, on=keys, how="outer")
    monthly = monthly.sort_values(["district_name", "year", "month"]).reset_index(drop=True)
    monthly["period"] = monthly.year.astype(int).astype(str) + "-" + monthly.month.astype(int).astype(str).str.zfill(2)
    depth = monthly["water_table_depth_m_bgl"] if "water_table_depth_m_bgl" in monthly else pd.Series(index=monthly.index, dtype=float)
    delta = depth.groupby(monthly["district_name"]).diff()
    monthly["storage_change_m3_yr"] = -delta * monthly.get("aquifer_extent_km2") * 1_000_000 * monthly.get("storage_coefficient")
    monthly["storage_change_million_m3_yr"] = monthly["storage_change_m3_yr"] / 1_000_000
    monthly["reserve_balance_million_m3_yr"] = monthly.get("dynamic_reserve_million_m3_yr") - monthly.get("total_abstraction_m3_yr") / 1_000_000 + monthly["storage_change_million_m3_yr"]
    return monthly


@dashboard_cache("groundwater-reserve.monthly")
def _load_monthly(snapshot: dict, start_year: int, end_year: int) -> pd.DataFrame:
    return _prepare(snapshot, start_year, end_year)


def _clean(value):
    return json.loads(pd.Series([value]).to_json(orient="values", force_ascii=False))[0]


def _validate(monthly: pd.DataFrame, region: str, start: int, end: int):
    regions = set(monthly.district_name.dropna())
    if region != "National" and region not in regions:
        raise HTTPException(400, f"Unknown groundwater reserve district: {region}")
    if int(start) > int(end):
        raise HTTPException(400, "Groundwater reserve end year must be on or after start year.")
    return int(start), int(end)


def _annual(frame: pd.DataFrame, metrics: list[str]) -> pd.DataFrame:
    base = [key for key in metrics if key not in {"storage_change_m3_yr", "storage_change_million_m3_yr", "reserve_balance_million_m3_yr"} and key in frame]
    grouped = frame.groupby(["district_name", "year"], as_index=False)[base].mean()
    storage = frame.groupby(["district_name", "year"], as_index=False).storage_change_m3_yr.sum(min_count=1)
    grouped = grouped.merge(storage, on=["district_name", "year"], how="outer").groupby("year", as_index=False).mean(numeric_only=True)
    grouped["storage_change_million_m3_yr"] = grouped.storage_change_m3_yr / 1_000_000
    grouped["reserve_balance_million_m3_yr"] = grouped.dynamic_reserve_million_m3_yr - grouped.total_abstraction_m3_yr / 1_000_000 + grouped.storage_change_million_m3_yr
    for key in metrics:
        if key not in grouped: grouped[key] = None
    return grouped[["year", *metrics]]


def _map_rows(monthly: pd.DataFrame, year: int) -> pd.DataFrame:
    scoped = monthly[monthly.year.eq(year)]
    base = [key for key in METRICS if key not in {"storage_change_m3_yr", "storage_change_million_m3_yr", "reserve_balance_million_m3_yr"} and key in scoped]
    result = scoped.groupby(["district_name", "province_name"], as_index=False)[base].mean()
    storage = scoped.groupby(["district_name", "province_name"], as_index=False).storage_change_m3_yr.sum(min_count=1)
    result = result.merge(storage, on=["district_name", "province_name"], how="left")
    result["storage_change_million_m3_yr"] = result.storage_change_m3_yr / 1_000_000
    result["reserve_balance_million_m3_yr"] = result.dynamic_reserve_million_m3_yr - result.total_abstraction_m3_yr / 1_000_000 + result.storage_change_million_m3_yr
    return result


@router.get("/metadata")
def metadata():
    try: return _metadata()
    except HTTPException: raise
    except SupabaseSourceError as exc: raise HTTPException(502, detail=str(exc)) from exc


@router.get("/dashboard")
def dashboard(region: str = "National", start: int = 2000, end: int = 2026):
    try:
        snapshot, meta = _snapshot(), _metadata(); monthly = _load_monthly(snapshot, start, end); start_year, end_year = _validate(monthly, region, start, end)
        scoped = monthly if region == "National" else monthly[monthly.district_name.eq(region)]; period = scoped[scoped.year.between(start_year, end_year)]
        if period.empty: raise HTTPException(422, "No groundwater reserve observations fall within this period.")
        metrics = list(METRICS); annual = _annual(period, metrics); latest = annual.iloc[-1].to_dict(); maps = _map_rows(monthly, end_year)
        warnings = ["Section 11 Supabase relations contain district-level monthly values, not borehole identifiers, coordinates or a station inventory.", "Static reserve and dynamic reserve are supplied indicators. The ecological reserve is not present as a source field.", "Change in storage is derived from month-to-month water-table depth, aquifer area and the supplied storage coefficient; the first observation for each district has no storage-change value."]
        return _clean({"source": "Supabase", "source_tables": meta["source_tables"], "region": region, "start": start_year, "end": end_year, "series": annual.to_dict("records"), "latest": latest, "map": maps.to_dict("records"), "warnings": warnings, "variables": metrics, "source_coverage": {"first_date": meta["first_date"], "last_date": meta["last_date"], "districts": len(meta["regions"])}, "quality": {"missing_values": int(period[metrics].isna().sum().sum()), "rows": int(len(period)), "map_year": end_year}})
    except HTTPException: raise
    except SupabaseSourceError as exc: raise HTTPException(502, detail=str(exc)) from exc


@router.get("/monthly")
def monthly_detail(region: str = "National", year: int | None = 2026, start: int | None = None, end: int | None = None):
    try:
        snapshot, meta = _snapshot(), _metadata(); selected_start, selected_end = (year, year) if start is None and end is None else (start or meta["default_start"], end or meta["default_end"])
        monthly = _load_monthly(snapshot, selected_start, selected_end); selected_start, selected_end = _validate(monthly, region, selected_start, selected_end); scoped = monthly if region == "National" else monthly[monthly.district_name.eq(region)]; selected = scoped[scoped.year.between(selected_start, selected_end)]
        metrics = list(METRICS); base = [key for key in metrics if key not in {"storage_change_m3_yr", "storage_change_million_m3_yr", "reserve_balance_million_m3_yr"} and key in selected]
        grouped = selected.groupby(["district_name", "period"], as_index=False)[base].mean(); storage = selected.groupby(["district_name", "period"], as_index=False).storage_change_m3_yr.sum(min_count=1); grouped = grouped.merge(storage, on=["district_name", "period"], how="left").groupby("period", as_index=False).mean(numeric_only=True); grouped["storage_change_million_m3_yr"] = grouped.storage_change_m3_yr / 1_000_000; grouped["reserve_balance_million_m3_yr"] = grouped.dynamic_reserve_million_m3_yr - grouped.total_abstraction_m3_yr / 1_000_000 + grouped.storage_change_million_m3_yr
        return _clean({"source": "Supabase", "source_tables": meta["source_tables"], "region": region, "year": selected_end, "start": selected_start, "end": selected_end, "series": grouped.to_dict("records"), "variables": metrics})
    except HTTPException: raise
    except SupabaseSourceError as exc: raise HTTPException(502, detail=str(exc)) from exc
