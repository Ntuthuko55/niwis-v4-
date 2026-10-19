"""Supabase-backed vegetation condition monitoring.

The dashboard keeps its existing response contract, but the source of truth is
the two module 3 relations in Supabase. The adapter discovers relation names
and columns from the Supabase schema before issuing bounded, paginated queries.
The service-role key is used only in this server module.
"""

from __future__ import annotations

import json
import os
import re
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache
from pathlib import Path
from threading import BoundedSemaphore, Lock
from time import monotonic
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen

import numpy as np
import pandas as pd
from fastapi import APIRouter, HTTPException

from app.supabase_source import SupabaseSourceError, _request_page, _settings
from app.dashboard_loader import cached_call, cached_result


router = APIRouter(prefix="/vegetation", tags=["Vegetation condition"])

# Retained for existing local tests and source documentation. The runtime API
# reads Supabase; these files are never used as a fallback.
ROOT = Path(__file__).resolve().parents[2] / "vegetation"
FILES = [
    "5.1_primary_satellite_vegetation_variables_sansa_master.csv",
    "5.2_meteorological_drivers_saws_master.csv",
]

DEFAULT_TABLES = (
    "5.1_primary_satellite_vegetation_variables_sansa_master",
    "5.2_meteorological_drivers_saws_master",
)
TABLE_ENV = "NIWIS_SUPABASE_TABLES_MODULE_3"
PAGE_SIZE = 1000
SCHEMA_TTL_SECONDS = 900
READ_CACHE_TTL_SECONDS = 300
READ_CACHE_MAX_ENTRIES = 64
_READ_CACHE: dict[tuple, tuple[float, pd.DataFrame]] = {}
_READ_CACHE_LOCK = Lock()
_SNAPSHOT_LOCK = Lock()
_METADATA_LOCK = Lock()
_READ_SLOTS = BoundedSemaphore(12)

METRICS = [
    ("NDVI_10day_composite", "NDVI", "Vegetation greenness", "index", "Greenness"),
    ("EVI", "EVI", "Enhanced vegetation index", "index", "Greenness"),
    ("SAVI", "SAVI", "Soil-adjusted vegetation index", "index", "Greenness"),
    ("MSAVI2", "MSAVI2", "Modified soil-adjusted vegetation index", "index", "Greenness"),
    ("VCI_percent", "VCI", "Vegetation condition index", "%", "Condition"),
    ("VHI_percent", "VHI", "Vegetation health index", "%", "Condition"),
    ("TCI_percent", "TCI", "Temperature condition index", "%", "Condition"),
    ("VPI_percent", "VPI", "Vegetation productivity index", "%", "Condition"),
    ("ASI_percent", "ASI", "Agricultural stress index", "%", "Condition"),
    ("SVI_standardised", "SVI", "Standard vegetation index", "standardised", "Condition"),
    ("NDWI", "NDWI", "Normalised difference water index", "index", "Water content"),
    ("NDII", "NDII", "Normalised difference infrared index", "index", "Water content"),
    ("LST_Land_Surface_Temperature_C", "LST", "Land surface temperature", "°C", "Thermal"),
    ("Surface_Soil_Moisture_m3m3", "Soil moisture", "Surface soil moisture", "m³/m³", "Moisture"),
    ("Monthly_Rainfall_mm", "Rainfall", "Monthly rainfall", "mm/month", "Weather"),
    ("Rainfall_Anomaly_percent", "Rainfall anomaly", "Reported rainfall anomaly", "%", "Weather"),
    ("SPI_1_month", "SPI-1", "1-month precipitation index", "index", "Weather"),
    ("SPI_3_month", "SPI-3", "3-month precipitation index", "index", "Weather"),
    ("SPI_6_month", "SPI-6", "6-month precipitation index", "index", "Weather"),
    ("SPEI_1_month", "SPEI-1", "1-month precipitation-evapotranspiration index", "index", "Weather"),
    ("SPEI_3_month", "SPEI-3", "3-month precipitation-evapotranspiration index", "index", "Weather"),
    ("SPEI_6_month", "SPEI-6", "6-month precipitation-evapotranspiration index", "index", "Weather"),
    ("Mean_Temperature_C", "Temperature", "Monthly mean air temperature", "°C", "Weather"),
    ("Potential_Evapotranspiration_ET0_mm", "ET₀", "Monthly reference evapotranspiration", "mm/month", "Weather"),
    ("Growing_Degree_Days_GDD_C", "GDD", "Growing degree days", "°C·days", "Weather"),
]
SAT_KEYS = [metric[0] for metric in METRICS if metric[4] != "Weather"]
DRIVER_KEYS = [metric[0] for metric in METRICS if metric[4] == "Weather"]
ALL_KEYS = SAT_KEYS + DRIVER_KEYS


def _normalise(value: str) -> str:
    return re.sub(r"[^a-z0-9]", "", str(value).lower())


def _find_column(columns: list[str], *names: str) -> str | None:
    by_normalised = {_normalise(column): column for column in columns}
    for name in names:
        if _normalise(name) in by_normalised:
            return by_normalised[_normalise(name)]
    return None


def _configured_tables() -> tuple[str, str]:
    raw = os.getenv(TABLE_ENV, ",".join(DEFAULT_TABLES))
    names = tuple(part.strip() for part in raw.split(",") if part.strip())
    if len(names) != 2 or len(set(names)) != 2:
        raise SupabaseSourceError(f"{TABLE_ENV} must list the satellite and meteorological module 3 tables.")
    if any(not re.fullmatch(r"[A-Za-z0-9_. ]+", name) for name in names):
        raise SupabaseSourceError(f"{TABLE_ENV} contains an unsupported table name.")
    return names  # type: ignore[return-value]


def _table_candidates(configured: str, index: int) -> list[str]:
    """Accept the prompt's 5_1/5_2 aliases while resolving real relations."""
    candidates = [configured]
    alias = configured.replace("5_1_", "5.1_", 1) if index == 0 else configured.replace("5_2_", "5.2_", 1)
    if alias not in candidates:
        candidates.append(alias)
    reverse = configured.replace("5.1_", "5_1_", 1) if index == 0 else configured.replace("5.2_", "5_2_", 1)
    if reverse not in candidates:
        candidates.append(reverse)
    return candidates


def _table_url(base: str, table: str, params: dict[str, str]) -> str:
    return f"{base}/rest/v1/{quote(table, safe='._')}?{urlencode(params)}"


def _request_document(url: str, key: str) -> dict:
    request = Request(url, headers={"apikey": key, "Authorization": f"Bearer {key}", "Accept": "application/json"})
    try:
        with urlopen(request, timeout=45) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:500]
        raise SupabaseSourceError(f"Supabase returned HTTP {exc.code}: {detail}") from exc
    except (URLError, TimeoutError) as exc:
        raise SupabaseSourceError(f"Could not reach Supabase: {exc}") from exc
    if not isinstance(payload, dict):
        raise SupabaseSourceError("Supabase returned an unexpected schema response.")
    return payload


def _read_pages(base: str, key: str, table: str, params: dict[str, str]) -> list[dict]:
    """Read a bounded query without an exact-count scan."""
    rows: list[dict] = []
    offset = 0
    for _ in range(512):
        with _READ_SLOTS:
            page, _ = _request_page(_table_url(base, table, params), key, offset, offset + PAGE_SIZE - 1)
        rows.extend(page)
        if len(page) < PAGE_SIZE:
            return rows
        offset += len(page)
    raise SupabaseSourceError("A vegetation query exceeded the safe pagination limit.")


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
            oldest = min(_READ_CACHE, key=lambda item: _READ_CACHE[item][0])
            _READ_CACHE.pop(oldest, None)
        _READ_CACHE[cache_key] = (monotonic() + READ_CACHE_TTL_SECONDS, stored)


def _worker_limit(job_count: int) -> int:
    try:
        configured = int(os.getenv("NIWIS_VEGETATION_DB_WORKERS", "16"))
    except ValueError:
        configured = 16
    return max(4, min(20, configured, max(1, job_count)))


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
    raise SupabaseSourceError(f"Neither configured module 3 relation could be found for '{configured}'. " + (errors[-1] if errors else ""))


def _column_descriptors(properties: dict, sample: dict | None) -> list[dict]:
    names = list(properties) if properties else list((sample or {}).keys())
    return [{"name": name, "type": (properties.get(name) or {}).get("type", "unknown"), "format": (properties.get(name) or {}).get("format")} for name in names]


def _metric_catalogue(columns: dict[str, list[str]]) -> list[tuple[str, str, str, str, str]]:
    available = set(columns["satellite"] + columns["drivers"])
    return [metric for metric in METRICS if metric[0] in available]


@lru_cache(maxsize=4)
def _snapshot_cached(base: str, key: str, configured: tuple[str, str], epoch: int) -> dict:
    del epoch  # The argument is part of the cache key and bounds schema staleness.
    names = tuple(_resolve_relation(base, key, name, index) for index, name in enumerate(configured))
    openapi = _request_document(f"{base}/rest/v1/", key)
    definitions = openapi.get("definitions", {})
    properties: dict[str, dict] = {}
    samples: dict[str, dict] = {}
    descriptors = []
    for index, table in enumerate(names):
        sample_rows, _ = _request_page(_table_url(base, table, {"select": "*", "limit": "1"}), key, 0, 0)
        sample = sample_rows[0] if sample_rows else {}
        definition = definitions.get(table, {}) if isinstance(definitions, dict) else {}
        table_properties = definition.get("properties", {}) if isinstance(definition, dict) else {}
        properties["satellite" if index == 0 else "drivers"] = table_properties
        samples["satellite" if index == 0 else "drivers"] = sample
        descriptors.append({"table": table, "configured_table": configured[index], "columns": _column_descriptors(table_properties, sample)})
    columns = {"satellite": [item["name"] for item in descriptors[0]["columns"]], "drivers": [item["name"] for item in descriptors[1]["columns"]]}
    region_sat = _find_column(columns["satellite"], "District_Name", "district", "region")
    region_driver = _find_column(columns["drivers"], "District_Name", "district", "region")
    date_column = _find_column(columns["satellite"], "Date", "observation_date", "date")
    year_column = _find_column(columns["drivers"], "Year", "year")
    month_column = _find_column(columns["drivers"], "Month", "month")
    if not all((region_sat, region_driver, date_column, year_column, month_column)):
        raise SupabaseSourceError("Module 3 tables do not expose the required district/date/year/month columns.")
    sat_keys = [key for key, _label, _description, _unit, category in METRICS if category != "Weather" and key in columns["satellite"]]
    driver_keys = [key for key, _label, _description, _unit, category in METRICS if category == "Weather" and key in columns["drivers"]]
    if not sat_keys or not driver_keys:
        raise SupabaseSourceError("Module 3 tables do not expose numeric vegetation and driver indicators.")
    return {
        "base": base,
        "key": key,
        "tables": {"satellite": names[0], "drivers": names[1]},
        "configured_tables": {"satellite": configured[0], "drivers": configured[1]},
        "columns": columns,
        "properties": properties,
        "samples": samples,
        "descriptors": descriptors,
        "region_columns": {"satellite": region_sat, "drivers": region_driver},
        "date_column": date_column,
        "year_column": year_column,
        "month_column": month_column,
        "sat_keys": sat_keys,
        "driver_keys": driver_keys,
    }


def _snapshot() -> dict:
    base, key, _ = _settings()
    configured = _configured_tables()
    epoch = int(monotonic() // SCHEMA_TTL_SECONDS)
    with _SNAPSHOT_LOCK:
        return _snapshot_cached(base, key, configured, epoch)


def _descriptor_rows(snapshot: dict) -> list[dict]:
    """Return table-level schema, row count, and coverage for metadata."""
    base, key = snapshot["base"], snapshot["key"]
    result = []
    for index, descriptor in enumerate(snapshot["descriptors"]):
        table = descriptor["table"]
        identifier = snapshot["region_columns"]["satellite" if index == 0 else "drivers"]
        order = snapshot["date_column"] if index == 0 else f"{snapshot['year_column']},{snapshot['month_column']}"
        select = f"{identifier},{snapshot['date_column']}" if index == 0 else f"{identifier},{snapshot['year_column']},{snapshot['month_column']}"
        params = {"select": select}
        first_order = f"{order}.asc" if index == 0 else f"{snapshot['year_column']}.asc,{snapshot['month_column']}.asc"
        last_order = f"{order}.desc" if index == 0 else f"{snapshot['year_column']}.desc,{snapshot['month_column']}.desc"
        first, content_range = _request_page(_table_url(base, table, {**params, "order": first_order, "limit": "1"}), key, 0, 0, count_exact=False)
        last, _ = _request_page(_table_url(base, table, {**params, "order": last_order, "limit": "1"}), key, 0, 0)
        try:
            rows = int((content_range or "").rsplit("/", 1)[1])
        except (ValueError, IndexError):
            rows = None
        result.append({**descriptor, "rows": rows, "first": first[0] if first else None, "last": last[0] if last else None})
    return result


def _metadata_snapshot(snapshot: dict) -> dict:
    descriptors = _descriptor_rows(snapshot)
    driver_first = descriptors[1].get("first") or {}
    driver_last = descriptors[1].get("last") or {}
    if driver_first.get(snapshot["year_column"]) is None or driver_last.get(snapshot["year_column"]) is None:
        raise SupabaseSourceError("The module 3 meteorological table is empty.")
    first_period = pd.Period(
        f"{int(driver_first[snapshot['year_column']]):04d}-{int(driver_first[snapshot['month_column']]):02d}",
        freq="M",
    )
    last_period = pd.Period(
        f"{int(driver_last[snapshot['year_column']]):04d}-{int(driver_last[snapshot['month_column']]):02d}",
        freq="M",
    )
    months = [str(period) for period in pd.period_range(first_period, last_period, freq="M")]
    check_start, check_end = last_period - 1, last_period + 1
    check_rows = _read_satellite(snapshot, check_start.strftime("%Y-%m"), check_end.strftime("%Y-%m"), None, snapshot["sat_keys"])
    regions = sorted(check_rows["District_Name"].dropna().astype(str).unique().tolist()) if not check_rows.empty else []
    if check_rows.empty:
        default_end = months[-1]
    else:
        check_rows["Date"] = pd.to_datetime(check_rows["Date"], errors="coerce")
        check_rows["month"] = check_rows.Date.dt.to_period("M").astype(str)
        counts = check_rows.groupby(["month", "District_Name"]).Date.nunique()
        complete_months = []
        for month in sorted(counts.index.get_level_values(0).unique()):
            expected = pd.Period(month, freq="M").days_in_month
            values = counts.loc[month]
            if len(values) == len(regions) and bool(values.eq(expected).all()):
                complete_months.append(month)
        default_end = complete_months[-1] if complete_months else months[-1]
    metrics = [{"key": key, "label": label, "description": description, "unit": unit, "category": category} for key, label, description, unit, category in _metric_catalogue(snapshot["columns"])]
    constant_metrics = []
    if not check_rows.empty:
        for key in snapshot["sat_keys"]:
            if key in check_rows.columns and check_rows[key].nunique(dropna=True) <= 1:
                constant_metrics.append(key)
    first_month = months[0]
    default_start = max(first_month, str(pd.Period(default_end, freq="M") - 23))
    source_rows = [{"file": descriptor["table"], "table": descriptor["table"], "rows": descriptor["rows"], "cadence": "Daily rows; monthly means shown" if index == 0 else "Monthly", "attribution": "SANSA / satellite observations" if index == 0 else "SAWS / meteorological drivers"} for index, descriptor in enumerate(descriptors)]
    return {
        "source": "Supabase",
        "source_tables": [descriptor["table"] for descriptor in descriptors],
        "schema": descriptors,
        "regions": regions,
        "months": months,
        "default_start": default_start,
        "default_end": default_end,
        "satellite_rows": descriptors[0]["rows"],
        "driver_rows": descriptors[1]["rows"],
        "latest_daily_date": str(descriptors[0]["last"].get(snapshot["date_column"])) if descriptors[0]["last"] else None,
        "constant_metrics": constant_metrics,
        "metrics": metrics,
        "sources": source_rows,
    }


def _metadata() -> dict:
    with _METADATA_LOCK:
        snapshot = _snapshot()
        signature = (snapshot["base"], hash(snapshot["key"]), tuple(snapshot["tables"].items()), int(monotonic() // SCHEMA_TTL_SECONDS))
        cached = getattr(_metadata, "_cache", None)
        if cached and cached[0] == signature:
            return cached[1]
        value = _metadata_snapshot(snapshot)
        _metadata._cache = (signature, value)
        return value


def _read_satellite_window(snapshot: dict, start_date: pd.Timestamp, end_date: pd.Timestamp, region: str | None, keys: list[str]) -> pd.DataFrame:
    # Daily rows are transient. Cache compact monthly district summaries below.
    table = snapshot["tables"]["satellite"]
    region_column, date_column = snapshot["region_columns"]["satellite"], snapshot["date_column"]
    params = {"select": ",".join([region_column, date_column, *keys]), "order": f"{region_column}.asc,{date_column}.asc", date_column: f"gte.{start_date:%Y-%m-%d}", "and": f"({date_column}.lt.{end_date:%Y-%m-%d})"}
    if region and region != "National":
        params[region_column] = f"eq.{region}"
    rows = _read_pages(snapshot["base"], snapshot["key"], table, params)
    frame = pd.DataFrame(rows, columns=[region_column, date_column, *keys]).rename(columns={region_column: "District_Name", date_column: "Date"})
    if frame.empty:
        return frame
    frame["Date"] = pd.to_datetime(frame["Date"], errors="coerce")
    for key in keys:
        frame[key] = pd.to_numeric(frame[key], errors="coerce")
    frame = frame.dropna(subset=["District_Name", "Date"])
    return frame


def _read_satellite(snapshot: dict, start: str, end: str, region: str | None, keys: list[str]) -> pd.DataFrame:
    """Read daily satellite rows in bounded windows to avoid statement timeouts."""
    cursor = pd.Period(start, freq="M").start_time
    final = (pd.Period(end, freq="M") + 1).start_time
    windows = []
    while cursor < final:
        next_cursor = min(cursor + pd.Timedelta(days=90), final)
        windows.append((cursor, next_cursor))
        cursor = next_cursor
    if not windows:
        return pd.DataFrame(columns=["District_Name", "Date", *keys])
    with ThreadPoolExecutor(max_workers=_worker_limit(len(windows))) as executor:
        frames = list(executor.map(lambda window: _read_satellite_window(snapshot, window[0], window[1], region, keys), windows))
    frames = [frame for frame in frames if not frame.empty]
    if not frames:
        return pd.DataFrame(columns=["District_Name", "Date", *keys])
    return pd.concat(frames, ignore_index=True).sort_values(["District_Name", "Date"]).reset_index(drop=True)


def _read_drivers(snapshot: dict, start: str, end: str, region: str | None, keys: list[str]) -> pd.DataFrame:
    cache_key = (
        "drivers",
        snapshot["base"], hash(snapshot["key"]),
        snapshot["tables"]["drivers"],
        start,
        end,
        region or "National",
        tuple(keys),
    )
    cached = _cached_frame(cache_key)
    if cached is not None:
        return cached
    table = snapshot["tables"]["drivers"]
    region_column, year_column, month_column = snapshot["region_columns"]["drivers"], snapshot["year_column"], snapshot["month_column"]
    start_year, end_year = pd.Period(start, freq="M").year, pd.Period(end, freq="M").year
    params = {"select": ",".join([region_column, year_column, month_column, *keys]), "order": f"{region_column}.asc,{year_column}.asc,{month_column}.asc", year_column: f"gte.{start_year}", "and": f"({year_column}.lte.{end_year})"}
    if region and region != "National":
        params[region_column] = f"eq.{region}"
    rows = _read_pages(snapshot["base"], snapshot["key"], table, params)
    frame = pd.DataFrame(rows, columns=[region_column, year_column, month_column, *keys]).rename(columns={region_column: "District_Name", year_column: "Year", month_column: "Month"})
    if frame.empty:
        _store_frame(cache_key, frame)
        return frame
    frame["Year"] = pd.to_numeric(frame["Year"], errors="coerce")
    frame["Month"] = pd.to_numeric(frame["Month"], errors="coerce")
    frame["month"] = pd.to_datetime(dict(year=frame["Year"], month=frame["Month"], day=1), errors="coerce").dt.strftime("%Y-%m")
    for key in keys:
        frame[key] = pd.to_numeric(frame[key], errors="coerce")
    frame = frame.dropna(subset=["District_Name", "month"])
    _store_frame(cache_key, frame)
    return frame


def aggregate_satellite(frame: pd.DataFrame, keys: list[str] | None = None) -> pd.DataFrame:
    keys = keys or SAT_KEYS
    if frame.empty:
        return pd.DataFrame(columns=["District_Name", "month", *keys, "observed_days", "expected_days", "complete"])
    frame = frame.copy()
    frame["Date"] = pd.to_datetime(frame.Date, errors="coerce")
    frame = frame.dropna(subset=["District_Name", "Date"])
    frame = frame.sort_values("Date").drop_duplicates(["District_Name", "Date"], keep="last")
    frame["month"] = frame.Date.dt.to_period("M").astype(str)
    grouped = frame.groupby(["District_Name", "month"], sort=True)
    monthly = grouped[keys].mean()
    monthly["observed_days"] = grouped.Date.nunique()
    monthly["expected_days"] = pd.PeriodIndex(monthly.index.get_level_values("month"), freq="M").days_in_month
    monthly["complete"] = monthly.observed_days.eq(monthly.expected_days)
    return monthly.reset_index()


def _combined_monthly(satellite: pd.DataFrame, drivers: pd.DataFrame, sat_keys: list[str], driver_keys: list[str]) -> pd.DataFrame:
    monthly = aggregate_satellite(satellite, sat_keys)
    return _join_monthly(monthly, drivers, driver_keys)


def _join_monthly(monthly: pd.DataFrame, drivers: pd.DataFrame, driver_keys: list[str]) -> pd.DataFrame:
    if drivers.empty:
        combined = monthly.copy()
        for key in driver_keys:
            combined[key] = np.nan
    else:
        driver_monthly = drivers.drop_duplicates(["District_Name", "month"], keep="last")
        combined = monthly.merge(driver_monthly[["District_Name", "month", *driver_keys]], on=["District_Name", "month"], how="outer", validate="one_to_one")
    if "complete" not in combined:
        combined["complete"] = False
    combined["complete"] = combined["complete"].fillna(False).astype(bool)
    return combined.sort_values(["District_Name", "month"]).reset_index(drop=True)


def _source_version(snapshot: dict) -> tuple:
    return (snapshot["base"], hash(snapshot["key"]), tuple(snapshot["tables"].items()),
            tuple(snapshot["sat_keys"]), tuple(snapshot["driver_keys"]),
            int(monotonic() // SCHEMA_TTL_SECONDS))


def _monthly_year(snapshot: dict, year: int, region: str | None, kind: str) -> pd.DataFrame:
    namespace = f"vegetation-monthly-{kind}"
    version = _source_version(snapshot)
    if kind == "baseline":
        # Older years contribute only NDVI and completeness to the seasonal
        # baseline; other indices and weather cannot affect those calculations.
        full = cached_result("vegetation-monthly-satellite", version, year, None)
        if full is None and region:
            full = cached_result("vegetation-monthly-satellite", version, year, region)
        if full is not None:
            return full[full.District_Name.eq(region)].copy() if region else full
    if region:
        national = cached_result(namespace, version, year, None)
        if national is not None:
            return national[national.District_Name.eq(region)].copy()

    def load():
        if kind in ("satellite", "baseline"):
            keys = snapshot["sat_keys"][:1] if kind == "baseline" else snapshot["sat_keys"]
            daily = _read_satellite(snapshot, f"{year}-01", f"{year}-12", region, keys)
            return aggregate_satellite(daily, keys)
        return _read_drivers(snapshot, f"{year}-01", f"{year}-12", region, snapshot["driver_keys"])

    return cached_call(namespace, version, year, region, loader=load)


def _monthly_range(snapshot: dict, start: str, end: str, region: str | None, include_drivers: bool = True, baseline_before: int | None = None) -> pd.DataFrame:
    """Share calendar-year summaries across maps, comparisons and forecasts.

    Load recent years first so an independent map need not wait for baseline
    history. Each year's daily reads retain the bounded 90-day pagination.
    """
    years = range(pd.Period(end, freq="M").year, pd.Period(start, freq="M").year - 1, -1)

    def load(year):
        baseline_only = baseline_before is not None and year < baseline_before
        monthly = _monthly_year(snapshot, year, region, "baseline" if baseline_only else "satellite")
        if baseline_only:
            for key in snapshot["sat_keys"] + snapshot["driver_keys"]:
                if key not in monthly:
                    monthly[key] = np.nan
        elif include_drivers:
            drivers = _monthly_year(snapshot, year, region, "drivers")
            monthly = _join_monthly(monthly, drivers, snapshot["driver_keys"])
        return monthly

    with ThreadPoolExecutor(max_workers=3) as executor:
        frames = list(executor.map(load, years))
    combined = pd.concat(frames, ignore_index=True)
    return combined[combined.month.between(start, end)].sort_values(["District_Name", "month"]).reset_index(drop=True)


def _map_summary(snapshot: dict, meta: dict, start: str, end: str) -> dict:
    monthly = _monthly_range(snapshot, start, end, None, include_drivers=False)
    keys = snapshot["sat_keys"]
    maps = monthly.groupby("District_Name")[keys].mean().reset_index()
    maps["months"] = monthly.groupby("District_Name").month.nunique().reindex(maps.District_Name).to_numpy()
    # Retain the national frame, including explicit nulls for missing districts.
    maps = pd.DataFrame({"District_Name": meta["regions"]}).merge(maps, on="District_Name", how="left")
    rank_keys = [key for key in ("District_Name", "VHI_percent", keys[0], "VCI_percent") if key in maps]
    rank = maps.dropna(subset=["VHI_percent"]).sort_values("VHI_percent", ascending=False) if "VHI_percent" in maps else maps
    return {"map": maps.to_dict("records"), "ranking": rank[rank_keys].to_dict("records")}


def regional_series(data: pd.DataFrame, region: str, keys: list[str] | None = None) -> pd.DataFrame:
    keys = keys or ALL_KEYS
    selected = data if region == "National" else data[data.District_Name.eq(region)]
    if selected.empty:
        return pd.DataFrame(columns=[*keys, "complete", "observed_days", "expected_days", "districts"])
    result = selected.groupby("month")[keys].mean()
    result["complete"] = selected.groupby("month").complete.all()
    result["observed_days"] = selected.groupby("month").observed_days.sum(min_count=1)
    result["expected_days"] = selected.groupby("month").expected_days.sum(min_count=1)
    result["districts"] = selected.groupby("month").District_Name.nunique()
    return result


def comparisons(full: pd.DataFrame, start: str, end: str, keys: list[str] | None = None, sat_keys: list[str] | None = None):
    keys = keys or ALL_KEYS
    sat_keys = sat_keys or [key for key in SAT_KEYS if key in keys]
    selected = full.loc[start:end].copy()
    historical = full[full.complete]
    previous = []
    for month, row in selected.iterrows():
        period = pd.Period(month, freq="M")
        previous_month = str(period - 12)
        prev = historical.loc[previous_month] if previous_month in historical.index else None
        previous.append({key: prev[key] if prev is not None and row.complete else None for key in keys})
        for key in sat_keys:
            selected.loc[month, f"{key}_previous"] = prev[key] if prev is not None and row.complete else np.nan
        baseline_months = [str(period - 12 * year) for year in range(1, 6)]
        ndvi_key = sat_keys[0] if sat_keys else None
        baseline = historical.reindex(baseline_months)[ndvi_key].dropna() if ndvi_key else pd.Series(dtype=float)
        selected.loc[month, "baseline_years"] = len(baseline)
        if len(baseline) >= 3 and ndvi_key:
            selected.loc[month, "ndvi_baseline"] = baseline.mean()
            selected.loc[month, "ndvi_low"] = baseline.min()
            selected.loc[month, "ndvi_high"] = baseline.max()
            selected.loc[month, "ndvi_anomaly_percent"] = (row[ndvi_key] / baseline.mean() - 1) * 100 if baseline.mean() != 0 else np.nan
    prior = pd.DataFrame(previous, index=selected.index, columns=keys)
    deltas = {}
    for key in keys:
        paired = pd.concat([selected[key].rename("current"), prior[key].rename("previous")], axis=1).dropna()
        deltas[key] = {"difference": paired.current.mean() - paired.previous.mean() if len(paired) else None, "paired_months": len(paired)}
    return selected, deltas


def _clean(value):
    return json.loads(pd.Series([value]).to_json(orient="values", force_ascii=False))[0]


def _selection(region: str, start: str | None, end: str | None, lag: int = 0):
    snapshot = _snapshot()
    meta = _metadata()
    start, end = start or meta["default_start"], end or meta["default_end"]
    available = set(meta["months"])
    if start not in available or end not in available or start > end:
        raise HTTPException(422, "Choose a valid start and end month within the available data.")
    if lag not in range(4):
        raise HTTPException(422, "Driver lag must be between zero and three months.")
    if region != "National" and region not in set(meta["regions"]):
        raise HTTPException(404, "Vegetation district not found.")
    return snapshot, meta, start, end


def _dashboard(region: str = "National", start: str | None = None, end: str | None = None, lag: int = 0, include_map: bool = True) -> dict:
    snapshot, meta, start, end = _selection(region, start, end, lag)
    sat_keys, driver_keys = snapshot["sat_keys"], snapshot["driver_keys"]
    all_keys = sat_keys + driver_keys
    history_start = max(meta["months"][0], str(pd.Period(start, freq="M") - 60))
    requested_region = None if region == "National" else region
    combined = _monthly_range(snapshot, history_start, end, requested_region,
                              baseline_before=(pd.Period(start, freq="M") - 12).year)
    full = regional_series(combined, region, all_keys)
    if full.empty:
        raise HTTPException(404, "No vegetation observations are available for this selection.")
    selected, deltas = comparisons(full, start, end, all_keys, sat_keys)
    if selected.empty:
        raise HTTPException(404, "No vegetation observations are available for this selection.")
    period_data = combined[combined.month.between(start, end)]
    map_result = _map_summary(snapshot, meta, start, end) if include_map else {"map": [], "ranking": []}
    correlations = []
    ndvi_key = sat_keys[0]
    correlation_keys = [candidate for candidate in ("Monthly_Rainfall_mm", "Mean_Temperature_C", "Potential_Evapotranspiration_ET0_mm", "SPI_3_month", "SPEI_3_month", "Growing_Degree_Days_GDD_C") if candidate in driver_keys]
    for key in correlation_keys:
        pairs = []
        for month, row in selected.iterrows():
            driver_month = str(pd.Period(month, freq="M") - lag)
            if row.complete and driver_month in full.index and full.loc[driver_month, "complete"]:
                pairs.append([row[ndvi_key], full.loc[driver_month, key]])
        frame = pd.DataFrame(pairs, columns=["ndvi", "driver"]).dropna()
        correlation = frame.ndvi.corr(frame.driver) if len(frame) >= 12 and frame.ndvi.std() > 1e-12 and frame.driver.std() > 1e-12 else None
        correlations.append({"key": key, "r": correlation, "pairs": len(frame)})
    coverage_data = period_data if region == "National" else period_data[period_data.District_Name.eq(region)]
    warnings = ["The NDVI column is named ‘10day composite’, but the source contains daily values. Charts show monthly means of those rows, not independently verified 10-day satellite composites."]
    incomplete = int((~selected.complete).sum())
    if incomplete:
        warnings.append(f"{incomplete} selected month(s) have incomplete daily coverage. Their monthly means remain visible; they are excluded from year-on-year comparisons and driver correlations.")
    if "Surface_Soil_Moisture_m3m3" in set(meta.get("constant_metrics", [])):
        warnings.append("Surface soil moisture is constant in the latest source window; it cannot explain variation in vegetation here.")
    summary = selected[all_keys].mean().to_dict()
    result = {"source": "Supabase", "source_tables": meta["source_tables"], "region": region, "start": start, "end": end, "lag": lag, "series": selected.reset_index().to_dict("records"), "summary": summary, "deltas": deltas, **map_result, "correlations": correlations, "warnings": warnings, "coverage": {"observed_days": coverage_data.observed_days.sum(min_count=1), "expected_days": coverage_data.expected_days.sum(min_count=1), "months": len(selected), "complete_months": int(selected.complete.sum())}, "ndvi_anomaly_percent": selected.get("ndvi_anomaly_percent", pd.Series(dtype=float)).mean(), "anomaly_months": int(selected.get("ndvi_anomaly_percent", pd.Series(dtype=float)).count()), "latest_daily_date": meta["latest_daily_date"]}
    return _clean(result)


def _forecast_source(region: str = "National", start: str | None = None, end: str | None = None) -> dict:
    """Return only a compact monthly series for the forecasting studio.

    Forecast registration does not need maps, year-on-year baselines, or the
    dashboard's five-year comparison window. Keeping this path separate avoids
    re-reading the expensive national daily frame when the studio is visible.
    """
    snapshot = _snapshot()
    meta = _metadata()
    end = end or meta["default_end"]
    if start is None:
        start = max(meta["months"][0], str(pd.Period(end, freq="M") - 35))
    available = set(meta["months"])
    if start not in available or end not in available or start > end:
        raise HTTPException(422, "Choose a valid forecast start and end month within the available data.")
    if region != "National" and region not in set(meta["regions"]):
        raise HTTPException(404, "Vegetation district not found.")
    requested_region = None if region == "National" else region
    combined = _monthly_range(snapshot, start, end, requested_region)
    series = regional_series(combined, region, snapshot["sat_keys"] + snapshot["driver_keys"])
    series = series.loc[start:end]
    if series.empty:
        raise HTTPException(404, "No vegetation observations are available for this forecast selection.")
    return _clean({
        "source": "Supabase",
        "source_tables": meta["source_tables"],
        "region": region,
        "start": start,
        "end": end,
        "series": series.reset_index().to_dict("records"),
        "metrics": meta["metrics"],
    })


@router.get("/metadata")
def metadata():
    try:
        return _metadata()
    except HTTPException:
        raise
    except SupabaseSourceError as exc:
        raise HTTPException(502, detail=str(exc)) from exc


@router.get("/dashboard")
def dashboard(region: str = "National", start: str | None = None, end: str | None = None, lag: int = 0, include_map: bool = True):
    try:
        return _dashboard(region, start, end, lag, include_map)
    except HTTPException:
        raise
    except SupabaseSourceError as exc:
        raise HTTPException(502, detail=str(exc)) from exc


@router.get("/forecast-source")
def forecast_source(region: str = "National", start: str | None = None, end: str | None = None):
    try:
        return _forecast_source(region, start, end)
    except HTTPException:
        raise
    except SupabaseSourceError as exc:
        raise HTTPException(502, detail=str(exc)) from exc


@router.get("/timeseries")
@router.get("/time-series")
def timeseries(region: str = "National", start: str | None = None, end: str | None = None, lag: int = 0):
    result = dashboard(region, start, end, lag, include_map=False)
    return {"source": result["source"], "region": result["region"], "start": result["start"], "end": result["end"], "lag": result["lag"], "series": result["series"], "metrics": _metadata()["metrics"]}


@router.get("/map")
def map_data(region: str = "National", start: str | None = None, end: str | None = None, lag: int = 0, indicator: str | None = None):
    try:
        snapshot, meta, start, end = _selection(region, start, end, lag)
        if indicator and indicator not in {metric["key"] for metric in meta["metrics"]}:
            raise HTTPException(422, "Choose an indicator reported by the vegetation metadata endpoint.")
        return _clean({"source": "Supabase", "source_tables": meta["source_tables"], "region": region,
                       "start": start, "end": end, "indicator": indicator, "latest_daily_date": meta["latest_daily_date"],
                       **_map_summary(snapshot, meta, start, end)})
    except SupabaseSourceError as exc:
        raise HTTPException(502, detail=str(exc)) from exc
