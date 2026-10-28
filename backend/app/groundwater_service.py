"""Supabase-backed Groundwater Level Monitoring Network service.

The existing groundwater dashboard contract is retained while section 10.1
and 10.2 are read from their configured Supabase relations. Long-form level
and aquifer observations are averaged at district/month level; recharge
support variables remain separate and missing values are never interpolated.
"""
from __future__ import annotations

import json
import os
import re
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache
from threading import BoundedSemaphore, Lock
from time import monotonic
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen

import numpy as np
import pandas as pd
from fastapi import APIRouter, HTTPException

from app.supabase_source import SupabaseSourceError, _request_page, _settings
from app.dashboard_loader import cached_call, cached_result, dashboard_cache_ttl

router = APIRouter(prefix="/groundwater", tags=["Groundwater level monitoring"])
TABLE_ENV = "NIWIS_SUPABASE_TABLES_MODULE_6"
DEFAULT_TABLES = ("10_1_borehole_and_aquifer_master", "10_2_recharge_supporting _master")
PAGE_SIZE = 1000
SCHEMA_TTL_SECONDS = dashboard_cache_ttl()
READ_CACHE_TTL_SECONDS = dashboard_cache_ttl()
READ_CACHE_MAX_ENTRIES = 96
_READ_CACHE: dict[tuple, tuple[float, pd.DataFrame]] = {}
_READ_CACHE_LOCK = Lock()
_SNAPSHOT_LOCK = Lock()
_METADATA_LOCK = Lock()
_READ_SLOTS = BoundedSemaphore(12)

VARIABLES = {
    "groundwater_table_depth_m_bgl": ("Groundwater table depth", "m bgl", "Level", "Depth below ground level"),
    "hydraulic_head_amsl_m": ("Hydraulic head", "m amsl", "Level", "Pressure head above mean sea level"),
    "hydraulic_head_m_amsl": ("Hydraulic head (telemetry field)", "m bgl", "Level", "Source field is labelled hydraulic head but reports m bgl"),
    "seasonal_water_table_fluctuation_m": ("Seasonal water-table fluctuation", "m/season", "Level", "Derived seasonal fluctuation"),
    "sgi_dimensionless": ("Standardized Groundwater Index (SGI)", "dimensionless", "Level", "Derived groundwater condition index"),
    "annual_recharge_rate_mm_yr": ("Annual recharge rate", "mm/year", "Recharge", "Modelled annual recharge"),
    "recharge_fraction_percent": ("Recharge fraction", "%", "Recharge", "Recharge as a percentage of rainfall"),
    "borehole_pumping_rate_m3_h": ("Borehole pumping rate", "m³/h", "Abstraction", "Reported pumping rate"),
    "annual_abstraction_volume_m3_yr": ("Annual abstraction volume", "m³/year", "Abstraction", "Annual volume per borehole"),
    "saturated_thickness_m": ("Saturated thickness", "m", "Aquifer", "Aquifer saturated thickness"),
    "transmissivity_m2_day": ("Transmissivity", "m²/day", "Aquifer", "Aquifer test parameter"),
    "hydraulic_conductivity_m_day": ("Hydraulic conductivity", "m/day", "Aquifer", "Aquifer test parameter"),
    "storativity_specific_yield_dimensionless": ("Storativity / specific yield", "dimensionless", "Aquifer", "Aquifer test parameter"),
    "monthly_catchment_rainfall_mm": ("Monthly catchment rainfall", "mm/month", "Recharge support", "Section 10.2 supporting rainfall"),
    "vadose_zone_soil_moisture_m3_m3": ("Vadose-zone soil moisture", "m³/m³", "Recharge support", "Section 10.2 supporting soil moisture"),
    "actual_evapotranspiration_mm": ("Actual evapotranspiration", "mm/month", "Recharge support", "Section 10.2 actual ET"),
    "river_baseflow_proxy_m3_day": ("River baseflow proxy", "m³/day", "Recharge support", "Proxy for groundwater discharge"),
    "urban_agricultural_land_use_pct": ("Urban / agricultural land use", "%", "Recharge support", "Land-use pressure on recharge"),
    "water_table_rise_wtf_m": ("Water-table rise (WTF recharge)", "m", "Recharge support", "Water-table fluctuation method indicator"),
}
WIDE_FIELDS = ["monthly_catchment_rainfall_mm", "vadose_zone_soil_moisture_m3_m3", "actual_evapotranspiration_mm", "river_baseflow_proxy_m3_day", "urban_agricultural_land_use_pct", "water_table_rise_wtf_m"]


def _normalise(value: str) -> str:
    return re.sub(r"[^a-z0-9]", "", str(value).lower())


def _find_column(columns: list[str], *names: str) -> str | None:
    lookup = {_normalise(column): column for column in columns}
    return next((lookup[_normalise(name)] for name in names if _normalise(name) in lookup), None)


def _configured_tables() -> tuple[str, str]:
    raw = os.getenv(TABLE_ENV, ",".join(DEFAULT_TABLES))
    names = tuple(part.strip() for part in raw.split(",") if part.strip())
    if len(names) != 2 or len(set(names)) != 2:
        raise SupabaseSourceError(f"{TABLE_ENV} must list the borehole/aquifer and recharge-supporting tables.")
    if any(not re.fullmatch(r"[A-Za-z0-9_. \\]+", name) for name in names):
        raise SupabaseSourceError(f"{TABLE_ENV} contains an unsupported table name.")
    return names  # type: ignore[return-value]


def _table_candidates(configured: str, index: int) -> list[str]:
    candidates = [configured]
    cleaned = configured.replace("\\", "")
    if cleaned not in candidates:
        candidates.append(cleaned)
    prefix, dotted = (("10_1_", "10.1_"), ("10_2_", "10.2_"))[index]
    for value in (cleaned.replace(prefix, dotted, 1), cleaned.replace(dotted, prefix, 1)):
        if value not in candidates:
            candidates.append(value)
    return candidates


def _table_url(base: str, table: str, params: dict[str, str]) -> str:
    return f"{base}/rest/v1/{quote(table, safe='._')}?{urlencode(params)}"


def _read_pages(base: str, key: str, table: str, params: dict[str, str]) -> list[dict]:
    rows: list[dict] = []
    offset = 0
    for _ in range(512):
        with _READ_SLOTS:
            page, _ = _request_page(_table_url(base, table, params), key, offset, offset + PAGE_SIZE - 1)
        rows.extend(page)
        if len(page) < PAGE_SIZE:
            return rows
        offset += len(page)
    raise SupabaseSourceError("A groundwater query exceeded the safe pagination limit.")


def _cached_frame(cache_key: tuple) -> pd.DataFrame | None:
    with _READ_CACHE_LOCK:
        cached = _READ_CACHE.get(cache_key)
        if not cached or cached[0] <= monotonic():
            _READ_CACHE.pop(cache_key, None)
            return None
        frame = cached[1]
    return frame.copy(deep=True)


def _store_frame(cache_key: tuple, frame: pd.DataFrame) -> None:
    stored = frame.copy(deep=True)
    with _READ_CACHE_LOCK:
        if len(_READ_CACHE) >= READ_CACHE_MAX_ENTRIES:
            _READ_CACHE.pop(min(_READ_CACHE, key=lambda item: _READ_CACHE[item][0]), None)
        _READ_CACHE[cache_key] = (monotonic() + READ_CACHE_TTL_SECONDS, stored)


def _worker_limit(count: int) -> int:
    try:
        configured = int(os.getenv("NIWIS_GROUNDWATER_DB_WORKERS", "16"))
    except ValueError:
        configured = 16
    return max(4, min(20, configured, max(1, count)))


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
    raise SupabaseSourceError(f"Could not resolve module 6 table '{configured}'. " + (errors[-1] if errors else ""))


def _schema_document(base: str, key: str) -> dict:
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


@lru_cache(maxsize=4)
def _snapshot_cached(base: str, key: str, configured: tuple[str, str], epoch: int) -> dict:
    del epoch
    names = tuple(_resolve_relation(base, key, value, index) for index, value in enumerate(configured))
    definitions = _schema_document(base, key).get("definitions", {})
    kinds = ("long", "wide"); descriptors = []; columns = {}; properties = {}; samples = {}
    for index, table in enumerate(names):
        sample_rows, _ = _request_page(_table_url(base, table, {"select": "*", "limit": "1"}), key, 0, 0)
        sample = sample_rows[0] if sample_rows else {}
        definition = definitions.get(table, {}) if isinstance(definitions, dict) else {}
        table_properties = definition.get("properties", {}) if isinstance(definition, dict) else {}
        kind = kinds[index]
        descriptor = {"table": table, "configured_table": configured[index], "columns": _column_descriptors(table_properties, sample)}
        descriptors.append(descriptor); columns[kind] = [item["name"] for item in descriptor["columns"]]; properties[kind] = table_properties; samples[kind] = sample
    long_columns, wide_columns = columns["long"], columns["wide"]
    long_region = _find_column(long_columns, "district_name", "district", "region"); long_date = _find_column(long_columns, "date", "observation_date", "record_date"); variable = _find_column(long_columns, "variable_name", "indicator", "variable"); value = _find_column(long_columns, "value", "measurement", "observation_value")
    wide_region = _find_column(wide_columns, "district_name", "district", "region"); wide_date = _find_column(wide_columns, "date", "observation_date", "record_date")
    if not all((long_region, long_date, variable, value, wide_region, wide_date)):
        raise SupabaseSourceError("Module 6 tables must expose district, date, variable, and value columns.")
    long_actual = {name: name for name in VARIABLES}
    wide_actual = {name: _find_column(wide_columns, name) for name in WIDE_FIELDS}
    missing = [name for name, actual in wide_actual.items() if actual is None]
    if missing:
        raise SupabaseSourceError("Groundwater recharge-supporting columns are missing: " + ", ".join(missing))
    return {"base": base, "key": key, "tables": {"long": names[0], "wide": names[1]}, "configured_tables": dict(zip(kinds, configured)), "columns": columns, "properties": properties, "samples": samples, "descriptors": descriptors, "long_region": long_region, "long_date": long_date, "variable": variable, "value": value, "wide_region": wide_region, "wide_date": wide_date, "long_actual": long_actual, "wide_actual": wide_actual}


def _snapshot() -> dict:
    base, key, _ = _settings(); configured = _configured_tables(); epoch = int(monotonic() // SCHEMA_TTL_SECONDS)
    with _SNAPSHOT_LOCK:
        return _snapshot_cached(base, key, configured, epoch)


def _date_windows(start: str, end: str) -> list[tuple[pd.Timestamp, pd.Timestamp]]:
    cursor = pd.Period(start, freq="M").start_time; final = (pd.Period(end, freq="M") + 1).start_time; windows = []
    while cursor < final:
        next_cursor = min(cursor + pd.Timedelta(days=90), final); windows.append((cursor, next_cursor)); cursor = next_cursor
    return windows


def _read_long_window(snapshot: dict, start: str, end: str, region: str | None, cache_raw: bool = True) -> pd.DataFrame:
    cache_key = ("long", snapshot["base"], hash(snapshot["key"]), snapshot["tables"]["long"], start, end, region or "National"); cached = _cached_frame(cache_key) if cache_raw else None
    if cached is not None: return cached
    district, date, variable, value = snapshot["long_region"], snapshot["long_date"], snapshot["variable"], snapshot["value"]; columns = [district, date, variable, value]; windows = _date_windows(start, end)
    def read(window):
        params = {"select": ",".join(columns), "order": f"{district}.asc,{date}.asc,{variable}.asc", date: f"gte.{window[0]:%Y-%m-%d}", "and": f"({date}.lt.{window[1]:%Y-%m-%d})"}
        if region and region != "National": params[district] = f"eq.{region}"
        rows = _read_pages(snapshot["base"], snapshot["key"], snapshot["tables"]["long"], params); return pd.DataFrame(rows, columns=columns)
    with ThreadPoolExecutor(max_workers=_worker_limit(len(windows))) as executor: frames = list(executor.map(read, windows))
    frame = pd.concat([part for part in frames if not part.empty], ignore_index=True) if any(not part.empty for part in frames) else pd.DataFrame(columns=columns)
    frame = frame.rename(columns={district: "district_name", date: "date", variable: "variable_name", value: "value"})
    if not frame.empty:
        frame["date"] = pd.to_datetime(frame["date"], errors="coerce"); frame["value"] = pd.to_numeric(frame["value"], errors="coerce"); frame = frame.dropna(subset=["district_name", "date"])
    if cache_raw: _store_frame(cache_key, frame)
    return frame


def _read_wide_window(snapshot: dict, start: str, end: str, region: str | None, cache_raw: bool = True) -> pd.DataFrame:
    cache_key = ("wide", snapshot["base"], hash(snapshot["key"]), snapshot["tables"]["wide"], start, end, region or "National"); cached = _cached_frame(cache_key) if cache_raw else None
    if cached is not None: return cached
    district, date = snapshot["wide_region"], snapshot["wide_date"]; actual = list(snapshot["wide_actual"].values()); columns = [district, date, *actual]; windows = _date_windows(start, end)
    def read(window):
        params = {"select": ",".join(columns), "order": f"{district}.asc,{date}.asc", date: f"gte.{window[0]:%Y-%m-%d}", "and": f"({date}.lt.{window[1]:%Y-%m-%d})"}
        if region and region != "National": params[district] = f"eq.{region}"
        rows = _read_pages(snapshot["base"], snapshot["key"], snapshot["tables"]["wide"], params); return pd.DataFrame(rows, columns=columns)
    with ThreadPoolExecutor(max_workers=_worker_limit(len(windows))) as executor: frames = list(executor.map(read, windows))
    frame = pd.concat([part for part in frames if not part.empty], ignore_index=True) if any(not part.empty for part in frames) else pd.DataFrame(columns=columns)
    frame = frame.rename(columns={district: "district_name", date: "date", **{actual: source for source, actual in snapshot["wide_actual"].items()}})
    if not frame.empty:
        frame["date"] = pd.to_datetime(frame["date"], errors="coerce"); frame = frame.dropna(subset=["district_name", "date"])
        for column in WIDE_FIELDS: frame[column] = pd.to_numeric(frame[column], errors="coerce")
    if cache_raw: _store_frame(cache_key, frame)
    return frame


def _descriptor_rows(snapshot: dict) -> list[dict]:
    result = []
    for index, descriptor in enumerate(snapshot["descriptors"]):
        kind = ("long", "wide")[index]; table = descriptor["table"]; district = snapshot[f"{kind}_region"]; date = snapshot[f"{kind}_date"]; select = f"{district},{date}"; first, content_range = _request_page(_table_url(snapshot["base"], table, {"select": select, "order": f"{date}.asc", "limit": "1"}), snapshot["key"], 0, 0, count_exact=False); last, _ = _request_page(_table_url(snapshot["base"], table, {"select": select, "order": f"{date}.desc", "limit": "1"}), snapshot["key"], 0, 0)
        try: rows = int((content_range or "").rsplit("/", 1)[1])
        except (ValueError, IndexError): rows = None
        result.append({**descriptor, "rows": rows, "first": first[0] if first else None, "last": last[0] if last else None})
    return result


def _available_variables(snapshot: dict) -> list[str]:
    variable = snapshot["variable"]; table = snapshot["tables"]["long"]
    def check(name):
        rows, _ = _request_page(_table_url(snapshot["base"], table, {"select": variable, variable: f"eq.{name}", "limit": "1"}), snapshot["key"], 0, 0); return name if rows else None
    with ThreadPoolExecutor(max_workers=min(8, len(VARIABLES))) as executor: found = list(executor.map(check, VARIABLES))
    return [name for name in found if name]


def _metadata_snapshot(snapshot: dict) -> dict:
    descriptors = _descriptor_rows(snapshot); first_dates = [str(item["first"].get(snapshot[f"{kind}_date"], ""))[:10] for item, kind in zip(descriptors, ("long", "wide"))]; last_dates = [str(item["last"].get(snapshot[f"{kind}_date"], ""))[:10] for item, kind in zip(descriptors, ("long", "wide"))]; first_date, last_date = min(first_dates), max(last_dates); months = [str(period) for period in pd.period_range(pd.Period(first_date[:7], freq="M"), pd.Period(last_date[:7], freq="M"), freq="M")]
    wide = _read_wide_window(snapshot, str(pd.Period(months[-1], freq="M") - 1), months[-1], None); regions = sorted(str(value) for value in wide.district_name.dropna().unique()); long_variables = _available_variables(snapshot); variable_names = long_variables + [name for name in WIDE_FIELDS if name not in long_variables]; region_count = len(regions); default_end = months[-1]
    if not wide.empty:
        wide["period"] = wide.date.dt.to_period("M").astype(str); counts = wide.groupby("period").district_name.nunique(); complete = [month for month in counts.index if counts.loc[month] == region_count]
        if complete: default_end = sorted(complete)[-1]
    kinds = ("long", "wide"); source_rows = [{"file": descriptor["table"], "table": descriptor["table"], "rows": descriptor["rows"], "cadence": "Long-form daily/irregular observations" if index == 0 else "Monthly recharge-support observations", "attribution": "Borehole and aquifer observations" if index == 0 else "Recharge supporting variables"} for index, descriptor in enumerate(descriptors)]
    return {"source": "Supabase", "source_tables": [descriptor["table"] for descriptor in descriptors], "schema": descriptors, "first_date": first_date, "last_date": last_date, "latest_month": default_end, "default_start": max(months[0], str(pd.Period(default_end, freq="M") - 23)), "default_end": default_end, "months": months, "regions": regions, "rows": [descriptor["rows"] for descriptor in descriptors], "files": [descriptor["table"] for descriptor in descriptors], "variables": variable_names, "metrics": [{"key": key, "label": VARIABLES[key][0], "unit": VARIABLES[key][1], "category": VARIABLES[key][2], "description": VARIABLES[key][3]} for key in variable_names], "sources": source_rows}


def _metadata() -> dict:
    with _METADATA_LOCK:
        snapshot = _snapshot(); cache_key = (snapshot["base"], hash(snapshot["key"]), tuple(snapshot["tables"].items()), int(monotonic() // SCHEMA_TTL_SECONDS)); cached = getattr(_metadata, "_cache", None)
        if cached and cached[0] == cache_key: return cached[1]
        value = _metadata_snapshot(snapshot); _metadata._cache = (cache_key, value); return value


def signature():
    snapshot = _snapshot(); return snapshot["base"], hash(snapshot["key"]), tuple(snapshot["tables"].items()), int(monotonic() // SCHEMA_TTL_SECONDS)


def _clean(value):
    return json.loads(pd.Series([value]).to_json(orient="values", force_ascii=False))[0]


def _validate(meta: dict, region: str, start: str, end: str) -> tuple[pd.Period, pd.Period]:
    if region != "National" and region not in set(meta["regions"]): raise HTTPException(404, f"Unknown groundwater district: {region}")
    try: start_period, end_period = pd.Period(start, "M"), pd.Period(end, "M")
    except Exception as exc: raise HTTPException(422, "Groundwater dates must use YYYY-MM format.") from exc
    if start_period > end_period or str(start_period) not in set(meta["months"]) or str(end_period) not in set(meta["months"]): raise HTTPException(422, "Groundwater date range is outside the available Supabase record.")
    return start_period, end_period


def _prepare(long: pd.DataFrame, wide: pd.DataFrame, variables: list[str]) -> pd.DataFrame:
    if long.empty: long_month = pd.DataFrame(columns=["district_name", "period", *[key for key in variables if key not in WIDE_FIELDS]])
    else:
        long = long.copy(); long["period"] = long.date.dt.to_period("M").astype(str); long = long[long.variable_name.isin(variables)]; long_month = long.groupby(["district_name", "period", "variable_name"], as_index=False).value.mean().pivot(index=["district_name", "period"], columns="variable_name", values="value").reset_index()
    if wide.empty: wide_month = pd.DataFrame(columns=["district_name", "period", *WIDE_FIELDS])
    else:
        wide = wide.copy(); wide["period"] = wide.date.dt.to_period("M").astype(str); wide_month = wide.groupby(["district_name", "period"], as_index=False)[WIDE_FIELDS].mean()
    monthly = long_month.merge(wide_month, on=["district_name", "period"], how="outer"); monthly["date"] = pd.to_datetime(monthly.period + "-01", errors="coerce") + pd.offsets.MonthEnd(0)
    for key in variables:
        if key not in monthly: monthly[key] = np.nan
        monthly[key] = pd.to_numeric(monthly[key], errors="coerce")
    return monthly


def _load_period(snapshot, start: str, end: str, region: str | None, cache_raw: bool = True):
    with ThreadPoolExecutor(max_workers=2) as executor:
        long_future = executor.submit(_read_long_window, snapshot, start, end, region, cache_raw=cache_raw); wide_future = executor.submit(_read_wide_window, snapshot, start, end, region, cache_raw=cache_raw); return long_future.result(), wide_future.result()


def _latest_map(monthly: pd.DataFrame, metrics: list[str], end: str) -> tuple[list[dict], dict]:
    map_rows = monthly[monthly.period.le(end)] if not monthly.empty else monthly; records = []
    for district_name, district_rows in map_rows.groupby("district_name", sort=True):
        record = {"district_name": district_name}; ordered = district_rows.sort_values("date")
        for key in metrics:
            available = ordered.loc[ordered[key].notna(), key] if key in ordered else pd.Series(dtype=float); record[key] = available.iloc[-1] if not available.empty else None
        records.append(record)
    periods = {key: (map_rows.loc[map_rows[key].notna(), "period"].max() if key in map_rows and map_rows[key].notna().any() else None) for key in metrics}
    return records, periods


def _source_version(snapshot, variables):
    return (snapshot["base"], hash(snapshot["key"]), tuple(snapshot["tables"].items()),
            snapshot["long_region"], snapshot["long_date"], snapshot["variable"], snapshot["value"],
            tuple(snapshot["wide_actual"].items()), tuple(variables), int(monotonic() // SCHEMA_TTL_SECONDS))


def _year_summary(snapshot, variables, year, region):
    version = _source_version(snapshot, variables)
    if region:
        national = cached_result("groundwater-year", version, year, None)
        if national is not None:
            return {key: frame[frame.district_name.eq(region)].copy() for key, frame in national.items()}

    def load():
        long, wide = _load_period(snapshot, f"{year}-01", f"{year}-12", region, cache_raw=False)
        monthly = _prepare(long, wide, variables)
        # Preserve the existing quality counter's reporting cutoff and raw row
        # counts without retaining the long-form observation frames.
        counts = []
        for frame, date_column in ((long, "date"), (wide, "date")):
            dates = frame[["district_name", date_column]].copy()
            dates[date_column] = pd.to_datetime(dates[date_column], errors="coerce")
            dates["period"] = dates[date_column].dt.to_period("M").astype(str)
            dates["future_rows_after_2026_10_13"] = dates[date_column].gt(pd.Timestamp("2026-10-13")).astype(int)
            counts.append(dates.groupby(["district_name", "period"])["future_rows_after_2026_10_13"].sum().reset_index())
        quality = pd.concat(counts, ignore_index=True).groupby(["district_name", "period"], as_index=False).sum(numeric_only=True)
        return {"monthly": monthly, "quality": quality}

    return cached_call("groundwater-year", version, year, region, loader=load)


def _monthly_data(snapshot, variables, start, end, region):
    years = range(int(end[:4]), int(start[:4]) - 1, -1)
    with ThreadPoolExecutor(max_workers=3) as executor:
        packs = list(executor.map(lambda year: _year_summary(snapshot, variables, year, region), years))
    result = {}
    for key in ("monthly", "quality"):
        frame = pd.concat([pack[key] for pack in packs], ignore_index=True)
        result[key] = frame[frame.period.between(start, end)].sort_values(["district_name", "period"]).reset_index(drop=True)
    return result


def _map_summary(snapshot, meta, start, end):
    """Look back only until every district/indicator has a supplied value.

    The selected range remains the hard boundary. A missing indicator cannot
    borrow an observation from before the selected start month.
    """
    variables, frames = meta["variables"], []
    for year in range(int(end[:4]), int(start[:4]) - 1, -1):
        monthly = _year_summary(snapshot, variables, year, None)["monthly"]
        frames.append(monthly[monthly.period.between(start, end)])
        records, periods = _latest_map(pd.concat(frames, ignore_index=True), variables, end)
        maps = pd.DataFrame({"district_name": meta["regions"]}).merge(
            pd.DataFrame(records, columns=["district_name", *variables]), on="district_name", how="left")
        if maps[variables].notna().all().all():
            break
    return {"map": maps.to_dict("records"), "map_periods": periods}


def _dashboard(region: str = "National", start: str | None = None, end: str | None = None, include_map: bool = True):
    snapshot, meta = _snapshot(), _metadata()
    start, end = start or meta["default_start"], end or meta["default_end"]
    start_period, end_period = _validate(meta, region, start, end)
    start, end = str(start_period), str(end_period)
    variables, requested = meta["variables"], None if region == "National" else region
    pack = _monthly_data(snapshot, variables, start, end, requested)
    scoped = pack["monthly"]
    selected = scoped.groupby("period")[variables].mean(numeric_only=True).loc[start:end].copy()
    selected["month"] = selected.index
    selected = selected.reset_index(drop=True)
    if selected.empty: raise HTTPException(404, "No groundwater observations are available for this selection.")
    latest = selected.iloc[-1].to_dict()
    for key in variables:
        if latest.get(key) is None or (isinstance(latest.get(key), float) and np.isnan(latest[key])):
            available = selected[key].dropna()
            if not available.empty: latest[key] = available.iloc[-1]
    if include_map:
        mapping = _map_summary(snapshot, meta, start, end)
    else:
        periods = {key: (scoped.loc[scoped[key].notna(), "period"].max() if scoped[key].notna().any() else None) for key in variables}
        mapping = {"map": [], "map_periods": periods}
    warnings = ["The supplied Supabase relations contain district-level values, not borehole IDs, coordinates or a station inventory.", "Long-form observations are irregular; the dashboard averages repeated district/month values and does not interpolate missing observations."]
    if any(period and period < end for period in mapping["map_periods"].values()): warnings.append("Map indicators use each district's latest available observation within the selected period; the source does not provide every indicator through the selected end month.")
    if "hydraulic_head_m_amsl" in variables: warnings.append("The hydraulic_head_m_amsl source field reports unit m bgl; it is displayed separately from hydraulic_head_amsl_m (m amsl).")
    future_rows = int(pack["quality"]["future_rows_after_2026_10_13"].sum())
    return _clean({"source": "Supabase", "source_tables": meta["source_tables"], "region": region, "start": start, "end": end, "series": selected.to_dict("records"), "latest": latest, **mapping, "warnings": warnings, "variables": variables, "source_coverage": {"first_date": meta["first_date"], "last_date": meta["last_date"], "districts": len(meta["regions"])}, "quality": {"missing_values": int(scoped[variables].isna().sum().sum()), "future_rows_after_2026_10_13": future_rows}})


def _forecast_source(region: str = "National", start: str | None = None, end: str | None = None):
    meta = _metadata(); end = end or meta["default_end"]; start = start or max(meta["months"][0], str(pd.Period(end, freq="M") - 35)); start_period, end_period = _validate(meta, region, start, end)
    snapshot = _snapshot()
    scoped = _monthly_data(snapshot, meta["variables"], str(start_period), str(end_period), None if region == "National" else region)["monthly"]
    series = scoped.groupby("period")[meta["variables"]].mean(numeric_only=True).reset_index()
    if series.empty: raise HTTPException(404, "No groundwater observations are available for this forecast selection.")
    return _clean({"source": "Supabase", "source_tables": meta["source_tables"], "region": region, "start": str(start_period), "end": str(end_period), "series": series.to_dict("records"), "metrics": meta["metrics"]})


@router.get("/metadata")
def metadata():
    try: return _metadata()
    except HTTPException: raise
    except SupabaseSourceError as exc: raise HTTPException(502, detail=str(exc)) from exc


@router.get("/dashboard")
def dashboard(region: str = "National", start: str | None = None, end: str | None = None, include_map: bool = True):
    try: return _dashboard(region, start, end, include_map)
    except HTTPException: raise
    except SupabaseSourceError as exc: raise HTTPException(502, detail=str(exc)) from exc


@router.get("/forecast-source")
def forecast_source(region: str = "National", start: str | None = None, end: str | None = None):
    try: return _forecast_source(region, start, end)
    except HTTPException: raise
    except SupabaseSourceError as exc: raise HTTPException(502, detail=str(exc)) from exc


@router.get("/map")
def map_data(start: str | None = None, end: str | None = None):
    try:
        snapshot, meta = _snapshot(), _metadata()
        start, end = start or meta["default_start"], end or meta["default_end"]
        first, last = _validate(meta, "National", start, end)
        return _clean({"source": "Supabase", "source_tables": meta["source_tables"],
                       "start": str(first), "end": str(last), **_map_summary(snapshot, meta, str(first), str(last))})
    except SupabaseSourceError as exc: raise HTTPException(502, detail=str(exc)) from exc


def _daily_source(snapshot, variables, region, month):
    def load():
        requested = None if region == "National" else region
        long, wide = _load_period(snapshot, month, month, requested, cache_raw=False)
        if long.empty and wide.empty: raise HTTPException(404, "No daily groundwater observations are available for this month.")
        if not long.empty:
            pivot = long.pivot_table(index="date", columns="variable_name", values="value", aggfunc="mean").reset_index()
        else: pivot = pd.DataFrame(columns=["date"])
        if not wide.empty:
            wp = wide.groupby("date")[WIDE_FIELDS].mean().reset_index()
            out = pivot.merge(wp, on="date", how="outer")
        else: out = pivot
        out = out.sort_values("date"); out["date"] = out.date.dt.strftime("%Y-%m-%d")
        return _clean({"source": "Supabase", "region": region, "month": month, "series": out.to_dict("records")})
    return cached_call("groundwater-daily", _source_version(snapshot, variables), region, month, loader=load)


@router.get("/daily")
def daily(region: str = "National", month: str = "2026-12"):
    try:
        snapshot, meta = _snapshot(), _metadata()
        start_period, _ = _validate(meta, region, month, month)
        return _daily_source(snapshot, meta["variables"], region, str(start_period))
    except HTTPException: raise
    except SupabaseSourceError as exc: raise HTTPException(502, detail=str(exc)) from exc
