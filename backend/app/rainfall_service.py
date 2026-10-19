"""Supabase-backed Rainfall Status Monitoring.

The existing rainfall response contract is preserved. Module 4 is read from
the two rainfall relations and the supporting runoff relation, with bounded
daily windows and a five-minute server cache so the national map does not
reload the full 2000-2026 source for every interaction.
"""

from __future__ import annotations

import calendar
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


router = APIRouter(prefix="/rainfall", tags=["Rainfall status"])
ROOT = Path(__file__).resolve().parents[2] / "Rainfall Status Monitoring"
FILES = ["6.1_core_rainfall_variables_master.csv", "6.2_rainfall_derived_drought_indices_master.csv"]
DEFAULT_TABLES = (
    "6.1_core_rainfall_variables_master",
    "6.2_rainfall_derived_drought_indices_master",
    "runoff_variables_master",
)
TABLE_ENV = "NIWIS_SUPABASE_TABLES_MODULE_4"
PAGE_SIZE = 1000
SCHEMA_TTL_SECONDS = 900
READ_CACHE_TTL_SECONDS = 300
READ_CACHE_MAX_ENTRIES = 96
_READ_CACHE: dict[tuple, tuple[float, pd.DataFrame]] = {}
_READ_CACHE_LOCK = Lock()
_SNAPSHOT_LOCK = Lock()
_METADATA_LOCK = Lock()
_READ_SLOTS = BoundedSemaphore(12)

DAILY = {
    "Daily_Rainfall_Total_mm": "rainfall",
    "CHIRPS_Daily_Rainfall_Estimate_mm_day": "chirps",
    "Gridded_Rainfall_Product_1km_mm": "gridded",
    "Hourly_Rainfall_Intensity_mm_h": "intensity",
}
MONTHLY = {
    "Monthly_Total_Precipitation_mm": "reported_rainfall",
    "Number_of_Rainy_Days_days_month": "reported_rainy_days",
    "Monthly_Anomaly_mm": "anomaly_mm",
    "Monthly_Anomaly_percent": "anomaly_percent",
}
ANNUAL = {
    "Annual_Total_Precipitation_mm": "annual_rainfall",
    **{f"Seasonal_Total_{season}_mm": season for season in ["JFM", "AMJ", "JAS", "OND"]},
}
INDICES = {
    "SPI_1_Meteorological_Drought_Onset": "spi1",
    "SPI_3_Short_Term_Agricultural_Drought": "spi3",
    "SPI_6_Medium_Term_Hydrological_Impacts": "spi6",
    "SPI_12_Long_Term_Groundwater_Impacts": "spi12",
    "SPI_24_Very_Long_Term_Drought": "spi24",
    "SPEI_3_Agricultural_Drought_ET": "spei3",
    "SPEI_12_Annual_Water_Balance_Drought": "spei12",
    "RAI_Rainfall_Anomaly_Index": "rai",
}
RUNOFF_FIELDS = {
    "Mean_Catchment_Rainfall_mm": "catchment_rainfall_mm",
    "Daily_Surface_Runoff_Volume_m3_day": "runoff_volume_m3",
    "Monthly_Runoff_Totals_Million_m3_month": "runoff_total_million_m3",
    "Runoff_Coefficient_dimensionless": "runoff_coefficient",
    "Peak_Flow_Rates_m3s": "runoff_peak_flow_m3s",
    "Baseflow_Component_m3s": "runoff_baseflow_m3s",
}
METRICS = [
    ("rainfall", "Observed rainfall", "mm", "Sum of available daily rainfall"),
    ("reported_rainfall", "Reported monthly rainfall", "mm", "One source value per district/month"),
    ("rainy_days", "Rainy days", "days", "Count of observed days with rainfall >= 1 mm"),
    ("reported_rainy_days", "Reported rainy days", "days", "One source value per district/month"),
    ("anomaly_mm", "Reported rainfall anomaly", "mm", "Monthly source anomaly"),
    ("anomaly_percent", "Reported rainfall anomaly", "%", "Monthly source anomaly; reference period not independently verified"),
    ("chirps", "CHIRPS rainfall", "mm", "Sum of supplied daily estimates"),
    ("gridded", "Gridded product value", "mm", "Sum of supplied district daily values; no raster supplied"),
    ("tamsat", "TAMSAT rainfall", "mm", "Sum of one value per observed dekad; partial dekads retained and flagged"),
    ("intensity", "Mean reported intensity", "mm/h", "Mean of daily source intensity entries, including zeros"),
    ("max_intensity", "Maximum reported intensity", "mm/h", "Maximum daily source intensity entry"),
    *[(key, key.upper().replace("SPI", "SPI-").replace("SPEI", "SPEI-"), "index", "One supplied index per district/month") for key in INDICES.values()],
]

CORE_COLUMNS = [*DAILY, *MONTHLY, *ANNUAL, "TAMSAT_Satellite_Rainfall_Estimate_mm_dekad"]


def _normalise(value: str) -> str:
    return re.sub(r"[^a-z0-9]", "", str(value).lower())


def _find_column(columns: list[str], *names: str) -> str | None:
    lookup = {_normalise(column): column for column in columns}
    for name in names:
        if _normalise(name) in lookup:
            return lookup[_normalise(name)]
    return None


def _configured_tables() -> tuple[str, str, str]:
    raw = os.getenv(TABLE_ENV, ",".join(DEFAULT_TABLES))
    names = tuple(part.strip() for part in raw.split(",") if part.strip())
    if len(names) != 3 or len(set(names)) != 3:
        raise SupabaseSourceError(f"{TABLE_ENV} must list the core, index, and runoff module 4 tables.")
    if any(not re.fullmatch(r"[A-Za-z0-9_. ]+", name) for name in names):
        raise SupabaseSourceError(f"{TABLE_ENV} contains an unsupported table name.")
    return names  # type: ignore[return-value]


def _table_candidates(configured: str, index: int) -> list[str]:
    candidates = [configured]
    if index == 0:
        alias = configured.replace("6_1_", "6.1_", 1)
        reverse = configured.replace("6.1_", "6_1_", 1)
    elif index == 1:
        alias = configured.replace("6_2_", "6.2_", 1)
        reverse = configured.replace("6.2_", "6_2_", 1)
    else:
        alias = reverse = configured
    for candidate in (alias, reverse):
        if candidate not in candidates:
            candidates.append(candidate)
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
    rows: list[dict] = []
    offset = 0
    for _ in range(512):
        with _READ_SLOTS:
            page, _ = _request_page(_table_url(base, table, params), key, offset, offset + PAGE_SIZE - 1)
        rows.extend(page)
        if len(page) < PAGE_SIZE:
            return rows
        offset += len(page)
    raise SupabaseSourceError("A rainfall query exceeded the safe pagination limit.")


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


def _worker_limit(count: int) -> int:
    try:
        configured = int(os.getenv("NIWIS_RAINFALL_DB_WORKERS", "16"))
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
    raise SupabaseSourceError(f"Could not resolve module 4 table '{configured}'. " + (errors[-1] if errors else ""))


def _column_descriptors(properties: dict, sample: dict | None) -> list[dict]:
    names = list(properties) if properties else list((sample or {}).keys())
    return [{"name": name, "type": (properties.get(name) or {}).get("type", "unknown"), "format": (properties.get(name) or {}).get("format")} for name in names]


@lru_cache(maxsize=4)
def _snapshot_cached(base: str, key: str, configured: tuple[str, str, str], epoch: int) -> dict:
    del epoch
    names = tuple(_resolve_relation(base, key, name, index) for index, name in enumerate(configured))
    openapi = _request_document(f"{base}/rest/v1/", key)
    definitions = openapi.get("definitions", {})
    descriptors = []
    properties = {}
    samples = {}
    for index, table in enumerate(names):
        sample_rows, _ = _request_page(_table_url(base, table, {"select": "*", "limit": "1"}), key, 0, 0)
        sample = sample_rows[0] if sample_rows else {}
        definition = definitions.get(table, {}) if isinstance(definitions, dict) else {}
        table_properties = definition.get("properties", {}) if isinstance(definition, dict) else {}
        name = ("core", "indices", "runoff")[index]
        properties[name] = table_properties
        samples[name] = sample
        descriptors.append({"table": table, "configured_table": configured[index], "columns": _column_descriptors(table_properties, sample)})
    columns = {name: [item["name"] for item in descriptors[index]["columns"]] for index, name in enumerate(("core", "indices", "runoff"))}
    region_columns = {name: _find_column(columns[name], "District_Name", "district", "region") for name in columns}
    date_column = _find_column(columns["core"], "Date", "observation_date", "date")
    year_columns = {name: _find_column(columns[name], "Year", "year") for name in columns}
    month_columns = {name: _find_column(columns[name], "Month", "month") for name in columns}
    if not region_columns["core"] or not region_columns["indices"] or not region_columns["runoff"] or not date_column or not year_columns["indices"] or not month_columns["indices"]:
        raise SupabaseSourceError("Module 4 tables do not expose the required district/date/year/month columns.")
    missing_core = [column for column in CORE_COLUMNS if column not in columns["core"]]
    missing_indices = [column for column in INDICES if column not in columns["indices"]]
    if missing_core or missing_indices:
        raise SupabaseSourceError(f"Rainfall source columns are missing: {', '.join(missing_core + missing_indices)}")
    core_actual = {column: column for column in CORE_COLUMNS}
    index_actual = {column: column for column in INDICES}
    runoff_actual = {column: RUNOFF_FIELDS[column] for column in RUNOFF_FIELDS if column in columns["runoff"]}
    return {
        "base": base,
        "key": key,
        "tables": {"core": names[0], "indices": names[1], "runoff": names[2]},
        "configured_tables": dict(zip(("core", "indices", "runoff"), configured)),
        "columns": columns,
        "properties": properties,
        "samples": samples,
        "descriptors": descriptors,
        "region_columns": region_columns,
        "date_column": date_column,
        "year_columns": year_columns,
        "month_columns": month_columns,
        "core_actual": core_actual,
        "index_actual": index_actual,
        "runoff_actual": runoff_actual,
    }


def _snapshot() -> dict:
    base, key, _ = _settings()
    configured = _configured_tables()
    epoch = int(monotonic() // SCHEMA_TTL_SECONDS)
    with _SNAPSHOT_LOCK:
        return _snapshot_cached(base, key, configured, epoch)


def _descriptor_rows(snapshot: dict) -> list[dict]:
    result = []
    for index, descriptor in enumerate(snapshot["descriptors"]):
        kind = ("core", "indices", "runoff")[index]
        table = descriptor["table"]
        region_column = snapshot["region_columns"][kind]
        if kind == "core" or kind == "runoff":
            select = f"{region_column},{snapshot['date_column']}"
            order_first = f"{snapshot['date_column']}.asc"
            order_last = f"{snapshot['date_column']}.desc"
        else:
            select = f"{region_column},{snapshot['year_columns'][kind]},{snapshot['month_columns'][kind]}"
            order_first = f"{snapshot['year_columns'][kind]}.asc,{snapshot['month_columns'][kind]}.asc"
            order_last = f"{snapshot['year_columns'][kind]}.desc,{snapshot['month_columns'][kind]}.desc"
        first, content_range = _request_page(_table_url(snapshot["base"], table, {"select": select, "order": order_first, "limit": "1"}), snapshot["key"], 0, 0, count_exact=False)
        last, _ = _request_page(_table_url(snapshot["base"], table, {"select": select, "order": order_last, "limit": "1"}), snapshot["key"], 0, 0)
        try:
            rows = int((content_range or "").rsplit("/", 1)[1])
        except (ValueError, IndexError):
            rows = None
        result.append({**descriptor, "rows": rows, "first": first[0] if first else None, "last": last[0] if last else None})
    return result


def _read_core_window(snapshot: dict, start: str, end: str, region: str | None, cache_raw: bool = True) -> pd.DataFrame:
    key = ("core", snapshot["base"], hash(snapshot["key"]), snapshot["tables"]["core"], start, end, region or "National")
    cached = _cached_frame(key) if cache_raw else None
    if cached is not None:
        return cached
    cursor = pd.Period(start, freq="M").start_time
    final = (pd.Period(end, freq="M") + 1).start_time
    windows = []
    while cursor < final:
        next_cursor = min(cursor + pd.Timedelta(days=90), final)
        windows.append((cursor, next_cursor))
        cursor = next_cursor
    region_column, date_column = snapshot["region_columns"]["core"], snapshot["date_column"]
    actual = list(snapshot["core_actual"].values())

    def read(window):
        params = {
            "select": ",".join([region_column, date_column, *actual]),
            "order": f"{region_column}.asc,{date_column}.asc",
            date_column: f"gte.{window[0]:%Y-%m-%d}",
            "and": f"({date_column}.lt.{window[1]:%Y-%m-%d})",
        }
        if region and region != "National":
            params[region_column] = f"eq.{region}"
        rows = _read_pages(snapshot["base"], snapshot["key"], snapshot["tables"]["core"], params)
        return pd.DataFrame(rows, columns=[region_column, date_column, *actual])

    with ThreadPoolExecutor(max_workers=_worker_limit(len(windows))) as executor:
        frames = list(executor.map(read, windows))
    frame = pd.concat([part for part in frames if not part.empty], ignore_index=True) if any(not part.empty for part in frames) else pd.DataFrame(columns=[region_column, date_column, *actual])
    frame = frame.rename(columns={region_column: "District_Name", date_column: "Date", **{actual[index]: source for index, source in enumerate(snapshot["core_actual"])} })
    if not frame.empty:
        frame["Date"] = pd.to_datetime(frame["Date"], errors="coerce")
        frame = frame.dropna(subset=["District_Name", "Date"])
        frame = frame.sort_values(["District_Name", "Date"]).drop_duplicates(["District_Name", "Date"], keep="last")
        for column in [*DAILY, *MONTHLY, *ANNUAL, "TAMSAT_Satellite_Rainfall_Estimate_mm_dekad"]:
            frame[column] = pd.to_numeric(frame[column], errors="coerce")
    if cache_raw:
        _store_frame(key, frame)
    return frame


def _read_indices(snapshot: dict, start: str, end: str, region: str | None) -> pd.DataFrame:
    key = ("indices", snapshot["base"], hash(snapshot["key"]), snapshot["tables"]["indices"], start, end, region or "National")
    cached = _cached_frame(key)
    if cached is not None:
        return cached
    region_column = snapshot["region_columns"]["indices"]
    year_column, month_column = snapshot["year_columns"]["indices"], snapshot["month_columns"]["indices"]
    actual = list(snapshot["index_actual"].values())
    start_year, end_year = pd.Period(start, freq="M").year, pd.Period(end, freq="M").year
    params = {"select": ",".join([region_column, year_column, month_column, *actual]), "order": f"{region_column}.asc,{year_column}.asc,{month_column}.asc", year_column: f"gte.{start_year}", "and": f"({year_column}.lte.{end_year})"}
    if region and region != "National":
        params[region_column] = f"eq.{region}"
    rows = _read_pages(snapshot["base"], snapshot["key"], snapshot["tables"]["indices"], params)
    frame = pd.DataFrame(rows, columns=[region_column, year_column, month_column, *actual]).rename(columns={region_column: "District_Name", year_column: "Year", month_column: "Month", **{actual[index]: source for index, source in enumerate(snapshot["index_actual"])} })
    if not frame.empty:
        frame["Year"] = pd.to_numeric(frame["Year"], errors="coerce")
        frame["Month"] = pd.to_numeric(frame["Month"], errors="coerce")
        for column in INDICES:
            frame[column] = pd.to_numeric(frame[column], errors="coerce")
    _store_frame(key, frame)
    return frame


def _read_runoff_window(snapshot: dict, start: str, end: str, region: str | None) -> pd.DataFrame:
    key = ("runoff", snapshot["base"], hash(snapshot["key"]), snapshot["tables"]["runoff"], start, end, region or "National")
    cached = _cached_frame(key)
    if cached is not None:
        return cached
    actual = list(snapshot["runoff_actual"])
    if not actual:
        return pd.DataFrame(columns=["District_Name", "Date"])
    cursor = pd.Period(start, freq="M").start_time
    final = (pd.Period(end, freq="M") + 1).start_time
    windows = []
    while cursor < final:
        next_cursor = min(cursor + pd.Timedelta(days=90), final)
        windows.append((cursor, next_cursor))
        cursor = next_cursor
    region_column = snapshot["region_columns"]["runoff"]
    date_column = snapshot["date_column"]

    def read(window):
        params = {"select": ",".join([region_column, date_column, *actual]), "order": f"{region_column}.asc,{date_column}.asc", date_column: f"gte.{window[0]:%Y-%m-%d}", "and": f"({date_column}.lt.{window[1]:%Y-%m-%d})"}
        if region and region != "National":
            params[region_column] = f"eq.{region}"
        rows = _read_pages(snapshot["base"], snapshot["key"], snapshot["tables"]["runoff"], params)
        return pd.DataFrame(rows, columns=[region_column, date_column, *actual])

    # Context is optional and shares the same source as Rainfall Status. Keep
    # its national fan-out conservative so it cannot starve the main dashboard
    # query or trigger Supabase statement timeouts.
    with ThreadPoolExecutor(max_workers=min(4, len(windows))) as executor:
        frames = list(executor.map(read, windows))
    frame = pd.concat([part for part in frames if not part.empty], ignore_index=True) if any(not part.empty for part in frames) else pd.DataFrame(columns=[region_column, date_column, *actual])
    frame = frame.rename(columns={region_column: "District_Name", date_column: "Date", **{actual[index]: source for index, source in enumerate(snapshot["runoff_actual"].values())} })
    if not frame.empty:
        frame["Date"] = pd.to_datetime(frame["Date"], errors="coerce")
        frame = frame.dropna(subset=["District_Name", "Date"])
        for column in RUNOFF_FIELDS.values():
            if column in frame:
                frame[column] = pd.to_numeric(frame[column], errors="coerce")
        frame = frame.sort_values(["District_Name", "Date"]).drop_duplicates(["District_Name", "Date"], keep="last")
    _store_frame(key, frame)
    return frame


def _metadata_snapshot(snapshot: dict) -> dict:
    descriptors = _descriptor_rows(snapshot)
    region_column = snapshot["region_columns"]["indices"]
    year_column, month_column = snapshot["year_columns"]["indices"], snapshot["month_columns"]["indices"]
    rows = _read_pages(snapshot["base"], snapshot["key"], snapshot["tables"]["indices"], {"select": f"{region_column},{year_column},{month_column}", "order": f"{region_column}.asc,{year_column}.asc,{month_column}.asc"})
    regions = sorted({str(row[region_column]) for row in rows if row.get(region_column) is not None})
    first = descriptors[1]["first"] or {}
    last = descriptors[1]["last"] or {}
    if not first or not last:
        raise SupabaseSourceError("The module 4 index table is empty.")
    first_period = pd.Period(f"{int(first[year_column]):04d}-{int(first[month_column]):02d}", freq="M")
    last_period = pd.Period(f"{int(last[year_column]):04d}-{int(last[month_column]):02d}", freq="M")
    months = [str(period) for period in pd.period_range(first_period, last_period, freq="M")]
    check = _read_core_window(snapshot, str(last_period - 1), str(last_period), None)
    if check.empty:
        default_end = months[-1]
        gridded_matches = intensity_matches = False
    else:
        check["month"] = check.Date.dt.to_period("M").astype(str)
        counts = check.groupby(["month", "District_Name"]).Date.nunique()
        complete = []
        for month in sorted(counts.index.get_level_values(0).unique()):
            values = counts.loc[month]
            if len(values) == len(regions) and bool(values.eq(pd.Period(month, freq="M").days_in_month).all()):
                complete.append(month)
        default_end = complete[-1] if complete else months[-1]
        gridded_matches = bool(np.allclose(check["Gridded_Rainfall_Product_1km_mm"], check["Daily_Rainfall_Total_mm"], equal_nan=True))
        intensity_matches = bool(np.allclose(check["Hourly_Rainfall_Intensity_mm_h"], check["Daily_Rainfall_Total_mm"] / 6, atol=.00051, equal_nan=True))
    source_rows = []
    cadence = {"core": "Daily rows with repeated monthly/annual values", "indices": "Monthly", "runoff": "Daily rows with repeated monthly values"}
    for index, descriptor in enumerate(descriptors):
        kind = ("core", "indices", "runoff")[index]
        source_rows.append({"file": descriptor["table"], "table": descriptor["table"], "rows": descriptor["rows"], "cadence": cadence[kind], "attribution": "Rainfall observations" if kind == "core" else "Derived drought indices" if kind == "indices" else "Runoff supporting variables"})
    return {
        "source": "Supabase",
        "source_tables": [descriptor["table"] for descriptor in descriptors],
        "schema": descriptors,
        "regions": regions,
        "months": months,
        "default_start": max(months[0], str(pd.Period(default_end, freq="M") - 23)),
        "default_end": default_end,
        "latest_date": str(descriptors[0]["last"].get(snapshot["date_column"])) if descriptors[0]["last"] else None,
        "core_rows": descriptors[0]["rows"],
        "index_rows": descriptors[1]["rows"],
        "runoff_rows": descriptors[2]["rows"],
        "gridded_matches_daily": gridded_matches,
        "intensity_matches_daily_div6": intensity_matches,
        "metrics": [{"key": key, "label": label, "unit": unit, "method": method} for key, label, unit, method in METRICS],
        "files": [descriptor["table"] for descriptor in descriptors[:2]],
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


def signature():
    snapshot = _snapshot()
    return snapshot["base"], hash(snapshot["key"]), tuple(snapshot["tables"].items()), int(monotonic() // SCHEMA_TTL_SECONDS)


def clean(value):
    return json.loads(pd.Series([value]).to_json(orient="values", force_ascii=False))[0]


def one_per_period(frame, groups, columns):
    grouped = frame.groupby(groups)
    if grouped[columns].nunique().gt(1).any().any():
        raise HTTPException(503, "Conflicting repeated rainfall values were found within a reporting period. Check the source data.")
    return grouped[columns].first()


def prepare(core, indices):
    """Preserve the existing cadence-aware calculations for tests and reuse."""
    core = core.copy()
    core["Date"] = pd.to_datetime(core.Date, errors="raise")
    core = core.sort_values(["District_Name", "Date"]).drop_duplicates(["District_Name", "Date"], keep="last")
    core["year"] = core.Date.dt.year
    core["month"] = core.Date.dt.strftime("%Y-%m")
    core["dekad"] = np.minimum((core.Date.dt.day - 1) // 10 + 1, 3)
    core = core.rename(columns={**DAILY, **MONTHLY, **ANNUAL, "TAMSAT_Satellite_Rainfall_Estimate_mm_dekad": "tamsat"})
    core["rainy_days"] = (core.rainfall >= 1).astype(float).where(core.rainfall.notna())
    groups = ["District_Name", "month"]
    daily = core.groupby(groups)
    monthly = daily[["rainfall", "chirps", "gridded", "rainy_days"]].sum(min_count=1)
    monthly["intensity"] = daily.intensity.mean()
    monthly["max_intensity"] = daily.intensity.max()
    monthly["observed_days"] = daily.rainfall.count()
    monthly["expected_days"] = pd.PeriodIndex(monthly.index.get_level_values("month"), freq="M").days_in_month
    monthly["complete"] = monthly.observed_days.eq(monthly.expected_days)
    monthly = monthly.join(one_per_period(core, groups, list(MONTHLY.values())))
    dekads = one_per_period(core, groups + ["dekad"], ["tamsat"])
    monthly["tamsat"] = dekads.groupby(level=[0, 1]).tamsat.sum(min_count=1)
    monthly["dekads"] = dekads.groupby(level=[0, 1]).tamsat.count()
    monthly["implied_normal"] = monthly.reported_rainfall - monthly.anomaly_mm
    indices = indices.rename(columns=INDICES).copy()
    indices["month"] = pd.to_datetime(dict(year=indices.Year, month=indices.Month, day=1)).dt.strftime("%Y-%m")
    monthly = monthly.join(one_per_period(indices, groups, list(INDICES.values())), how="outer")
    monthly["complete"] = monthly.complete.fillna(False).astype(bool)
    annual = one_per_period(core, ["District_Name", "year"], list(ANNUAL.values()))
    annual["observed_days"] = core.groupby(["District_Name", "year"]).rainfall.count()
    annual["expected_days"] = [366 if calendar.isleap(int(year)) else 365 for _, year in annual.index]
    annual["complete"] = annual.observed_days.eq(annual.expected_days)
    seasonal_groups = core.assign(quarter=core.Date.dt.quarter).groupby(["District_Name", "year", "quarter"]).rainfall.count()
    for quarter, season in enumerate(["JFM", "AMJ", "JAS", "OND"], 1):
        observed = pd.Series([seasonal_groups.get((district, year, quarter), 0) for district, year in annual.index], index=annual.index)
        expected = pd.Series([sum(calendar.monthrange(int(year), month)[1] for month in range(quarter * 3 - 2, quarter * 3 + 1)) for _, year in annual.index], index=annual.index)
        annual[season] = annual[season].where(observed > 0)
        annual[f"{season}_complete"] = observed.eq(expected)
    return core, monthly.reset_index(), annual.reset_index()


def _prepare_runoff(frame: pd.DataFrame) -> pd.DataFrame:
    if frame.empty:
        return pd.DataFrame(columns=["District_Name", "month", *RUNOFF_FIELDS.values()])
    frame = frame.copy()
    frame["Date"] = pd.to_datetime(frame["Date"], errors="coerce")
    frame = frame.dropna(subset=["District_Name", "Date"]).sort_values("Date").drop_duplicates(["District_Name", "Date"], keep="last")
    frame["month"] = frame.Date.dt.to_period("M").astype(str)
    grouped = frame.groupby(["District_Name", "month"])
    result = pd.DataFrame(index=grouped.size().index)
    if "runoff_volume_m3" in frame:
        result["runoff_volume_m3"] = grouped.runoff_volume_m3.sum(min_count=1)
    for key in ["catchment_rainfall_mm", "runoff_total_million_m3", "runoff_coefficient", "runoff_peak_flow_m3s", "runoff_baseflow_m3s"]:
        if key in frame:
            result[key] = grouped[key].mean()
    return result.reset_index()


def _region_months(monthly, region):
    data = monthly if region == "National" else monthly[monthly.District_Name.eq(region)]
    result = data.groupby("month").mean(numeric_only=True)
    result["complete"] = data.groupby("month").complete.all()
    result["districts"] = data.groupby("month").District_Name.nunique()
    return result


def _validate(meta, region, start, end):
    if region != "National" and region not in set(meta["regions"]):
        raise HTTPException(404, "Rainfall district not found.")
    months = set(meta["months"])
    if start not in months or end not in months or start > end:
        raise HTTPException(422, "Select a valid start and end month from the available rainfall record.")


def _history_start(meta, start):
    candidate = str(pd.Period(f"{start[:4]}-01", freq="M") - 12)
    return max(meta["months"][0], candidate)


def _load_period(snapshot, start, end, region, runoff_start=None, runoff_end=None):
    runoff_start = runoff_start or start
    runoff_end = runoff_end or end
    with ThreadPoolExecutor(max_workers=3) as executor:
        core_future = executor.submit(_read_core_window, snapshot, start, end, region)
        index_future = executor.submit(_read_indices, snapshot, start, end, region)
        runoff_future = executor.submit(_read_runoff_window, snapshot, runoff_start, runoff_end, region)
        return core_future.result(), index_future.result(), runoff_future.result()


def _source_version(snapshot):
    return (snapshot["base"], hash(snapshot["key"]), tuple(snapshot["tables"].items()),
            tuple(snapshot["core_actual"].items()), tuple(snapshot["index_actual"].items()),
            int(monotonic() // SCHEMA_TTL_SECONDS))


def _year_summary(snapshot, year, region):
    """Cache monthly totals and annual source values; release the daily frame."""
    version = _source_version(snapshot)
    if region:
        national = cached_result("rainfall-year", version, year, None)
        if national is not None:
            return {key: frame[frame.District_Name.eq(region)].copy() for key, frame in national.items()}

    def load():
        with ThreadPoolExecutor(max_workers=2) as executor:
            core_future = executor.submit(_read_core_window, snapshot, f"{year}-01", f"{year}-12", region, cache_raw=False)
            indices_future = executor.submit(_read_indices, snapshot, f"{year}-01", f"{year}-12", region)
            core, monthly, _ = prepare(core_future.result(), indices_future.result())
        # Keep annual source fields by month so an end-month selection retains
        # its original as-of-date coverage and unavailable future seasons.
        annual_months = one_per_period(core, ["District_Name", "month"], list(ANNUAL.values()))
        annual_months["observed_days"] = core.groupby(["District_Name", "month"]).rainfall.count()
        return {"monthly": monthly, "annual_months": annual_months.reset_index()}

    return cached_call("rainfall-year", version, year, region, loader=load)


def _monthly_data(snapshot, start, end, region):
    years = range(int(end[:4]), int(start[:4]) - 1, -1)
    # Recent years are shared by the independent map before history completes.
    with ThreadPoolExecutor(max_workers=3) as executor:
        packs = list(executor.map(lambda year: _year_summary(snapshot, year, region), years))
    result = {}
    for key in ("monthly", "annual_months"):
        frame = pd.concat([pack[key] for pack in packs], ignore_index=True)
        result[key] = frame[frame.month.between(start, end)].sort_values(["District_Name", "month"]).reset_index(drop=True)
    return result["monthly"], result["annual_months"]


def _annual_context(annual_months):
    """Recreate annual/seasonal coverage from observed monthly day counts."""
    data = annual_months.copy()
    data["year"] = data.month.str[:4].astype(int)
    data["quarter"] = (data.month.str[5:7].astype(int) - 1) // 3 + 1
    annual = one_per_period(data, ["District_Name", "year"], list(ANNUAL.values()))
    annual["observed_days"] = data.groupby(["District_Name", "year"]).observed_days.sum()
    annual["expected_days"] = [366 if calendar.isleap(int(year)) else 365 for _, year in annual.index]
    annual["complete"] = annual.observed_days.eq(annual.expected_days)
    observed_seasons = data.groupby(["District_Name", "year", "quarter"]).observed_days.sum()
    for quarter, season in enumerate(["JFM", "AMJ", "JAS", "OND"], 1):
        observed = pd.Series([observed_seasons.get((district, year, quarter), 0) for district, year in annual.index], index=annual.index, dtype=float)
        expected = pd.Series([sum(calendar.monthrange(int(year), month)[1] for month in range(quarter * 3 - 2, quarter * 3 + 1)) for _, year in annual.index], index=annual.index, dtype=float)
        annual[season] = annual[season].where(observed > 0)
        annual[f"{season}_complete"] = observed.eq(expected)
    return annual.reset_index()


def _national_map(snapshot, meta, month):
    monthly = _year_summary(snapshot, int(month[:4]), None)["monthly"]
    values = monthly[monthly.month.eq(month)]
    return pd.DataFrame({"District_Name": meta["regions"]}).merge(values, on="District_Name", how="left").to_dict("records")


def _dashboard(region="National", start=None, end=None, include_map=True, include_runoff=True):
    snapshot = _snapshot()
    meta = _metadata()
    start, end = start or meta["default_start"], end or meta["default_end"]
    _validate(meta, region, start, end)
    history_start = _history_start(meta, start)
    requested_region = None if region == "National" else region
    monthly, annual_months = _monthly_data(snapshot, history_start, end, requested_region)
    annual = _annual_context(annual_months)
    full = _region_months(monthly, region)
    selected = full.loc[start:end].copy()
    if selected.empty:
        raise HTTPException(404, "No rainfall observations are available for this selection.")
    for month, row in selected.iterrows():
        previous = str(pd.Period(month, freq="M") - 12)
        selected.loc[month, "previous_year"] = full.loc[previous, "rainfall"] if row.complete and previous in full.index and full.loc[previous, "complete"] else np.nan
    valid = selected[selected.complete & selected.chirps.notna() & selected.rainfall.notna()]
    bias = (valid.chirps - valid.rainfall).mean() if len(valid) else None
    rmse = np.sqrt(((valid.chirps - valid.rainfall) ** 2).mean()) if len(valid) else None
    maps = _national_map(snapshot, meta, end) if include_map else []
    annual_selection = annual[annual.year.between(int(start[:4]), int(end[:4]))]
    if region != "National":
        annual_selection = annual_selection[annual_selection.District_Name.eq(region)]
    annual_mean = annual_selection.groupby("year").mean(numeric_only=True)
    for column in ["complete", "JFM_complete", "AMJ_complete", "JAS_complete", "OND_complete"]:
        annual_mean[column] = annual_selection.groupby("year")[column].all()
    season_year = annual_mean.loc[int(end[:4])] if int(end[:4]) in annual_mean.index else pd.Series(dtype=float)
    coverage = monthly[monthly.month.between(start, end)]
    if region != "National":
        coverage = coverage[coverage.District_Name.eq(region)]
    runoff_monthly = _prepare_runoff(_read_runoff_window(snapshot, end, end, requested_region)) if include_runoff else pd.DataFrame()
    runoff_series = _region_months_runoff(runoff_monthly, region).loc[start:end] if not runoff_monthly.empty else pd.DataFrame()
    runoff_latest = runoff_series.iloc[-1].to_dict() if not runoff_series.empty else {}
    warnings = []
    if not selected.complete.all():
        warnings.append("The selected range includes incomplete months. Their observed totals remain visible; year-on-year and CHIRPS validation exclude them.")
    if meta["intensity_matches_daily_div6"]:
        warnings.append("Reported intensity equals daily rainfall divided by six (within source rounding). Treat it as a supplied derived value, not measured hourly peaks.")
    if meta["gridded_matches_daily"]:
        warnings.append("The gridded-product column duplicates district daily rainfall. No 1 km raster or individual station locations are included.")
    warnings.append("The record begins in 2000. Source anomalies and implied normals are retained, but a full 1981-2010 baseline cannot be verified from these sources.")
    seasonal = [{"season": season, "rainfall": season_year.get(season), "complete": season_year.get(f"{season}_complete")} for season in ["JFM", "AMJ", "JAS", "OND"]]
    return clean({
        "source": "Supabase",
        "source_tables": meta["source_tables"],
        "region": region,
        "start": start,
        "end": end,
        "latest_date": meta["latest_date"],
        "series": selected.reset_index().to_dict("records"),
        "latest": selected.iloc[-1].to_dict(),
        "summary": {"rainfall": selected.rainfall.sum(min_count=1), "rainy_days": selected.rainy_days.sum(min_count=1), "chirps": selected.chirps.sum(min_count=1), "tamsat": selected.tamsat.sum(min_count=1)},
        "map": maps,
        "annual": annual_mean.reset_index().to_dict("records"),
        "seasonal": seasonal,
        "coverage": {"observed_days": coverage.observed_days.sum(), "expected_days": coverage.expected_days.sum(), "complete_months": int(selected.complete.sum()), "months": len(selected)},
        "satellite_agreement": {"bias_mm": bias, "rmse_mm": rmse, "months": len(valid)},
        "runoff": {"latest": runoff_latest, "series": runoff_series.reset_index().to_dict("records") if not runoff_series.empty else []},
        "warnings": warnings,
    })


def _forecast_source(region="National", start=None, end=None):
    """Return a compact monthly rainfall series for the shared forecast panel."""
    snapshot = _snapshot()
    meta = _metadata()
    end = end or meta["default_end"]
    start = start or max(meta["months"][0], str(pd.Period(end, freq="M") - 35))
    _validate(meta, region, start, end)
    requested_region = None if region == "National" else region
    monthly, _ = _monthly_data(snapshot, start, end, requested_region)
    series = _region_months(monthly, region).loc[start:end]
    if series.empty:
        raise HTTPException(404, "No rainfall observations are available for this forecast selection.")
    return clean({"source": "Supabase", "source_tables": meta["source_tables"], "region": region, "start": start, "end": end, "series": series.reset_index().to_dict("records"), "metrics": meta["metrics"]})


def _context_source(region="National", start=None, end=None):
    """Return only the monthly rainfall rows needed by another dashboard.

    Surface water uses rainfall as optional context. It must not pay the full
    rainfall metadata/count/schema walk on every surface-water request.
    """
    snapshot = _snapshot()
    start = start or end
    end = end or start
    region_column, date_column = snapshot["region_columns"]["core"], snapshot["date_column"]
    rainfall_column = snapshot["core_actual"]["Daily_Rainfall_Total_mm"]
    windows = []
    cursor = pd.Period(start, freq="M").start_time
    final = (pd.Period(end, freq="M") + 1).start_time
    while cursor < final:
        next_cursor = min(cursor + pd.Timedelta(days=90), final); windows.append((cursor, next_cursor)); cursor = next_cursor

    def read(window, requested):
        params = {"select": f"{region_column},{date_column},{rainfall_column}", "order": f"{date_column}.asc,{region_column}.asc", date_column: f"gte.{window[0]:%Y-%m-%d}", "and": f"({date_column}.lt.{window[1]:%Y-%m-%d})"}
        if requested: params[region_column] = f"eq.{requested}"
        rows = _read_pages(snapshot["base"], snapshot["key"], snapshot["tables"]["core"], params)
        return pd.DataFrame(rows, columns=[region_column, date_column, rainfall_column])

    requested = None if region == "National" else region
    matched_region = requested
    # Context is optional and shares the same source as Rainfall Status. Keep
    # its national fan-out conservative so it cannot starve the main dashboard
    # query or trigger Supabase statement timeouts.
    with ThreadPoolExecutor(max_workers=min(4, len(windows))) as executor:
        frames = list(executor.map(lambda window: read(window, requested), windows))
    core = pd.concat([frame for frame in frames if not frame.empty], ignore_index=True) if any(not frame.empty for frame in frames) else pd.DataFrame(columns=[region_column, date_column, rainfall_column])
    if requested and core.empty:
        # Historical district aliases are resolved from the same bounded read.
        with ThreadPoolExecutor(max_workers=min(4, len(windows))) as executor:
            frames = list(executor.map(lambda window: read(window, None), windows))
        core = pd.concat([frame for frame in frames if not frame.empty], ignore_index=True) if any(not frame.empty for frame in frames) else core
        from app.drought_source import normalise_region
        names = set(core[region_column].dropna())
        candidate = next((name for name in names if normalise_region(name) == normalise_region(region)), None)
        if candidate is not None:
            matched_region = candidate
            core = core[core[region_column].eq(candidate)]
    if core.empty: raise HTTPException(404, "No rainfall observations are available for this context selection.")
    core = core.rename(columns={region_column: "District_Name", date_column: "Date", rainfall_column: "Daily_Rainfall_Total_mm"})
    core["Date"] = pd.to_datetime(core["Date"], errors="coerce"); core["rainfall"] = pd.to_numeric(core["Daily_Rainfall_Total_mm"], errors="coerce"); core["month"] = core.Date.dt.to_period("M").astype(str)
    core = core.dropna(subset=["District_Name", "Date"])
    grouped = core.groupby(["District_Name", "month"]); monthly = grouped.rainfall.sum(min_count=1).to_frame(); monthly["observed_days"] = grouped.rainfall.count(); monthly["expected_days"] = pd.PeriodIndex(monthly.index.get_level_values("month"), freq="M").days_in_month; monthly["complete"] = monthly.observed_days.eq(monthly.expected_days); monthly = monthly.reset_index()
    series = monthly if region == "National" else monthly[monthly.District_Name.eq(matched_region)]
    if region == "National":
        grouped = monthly.groupby("month")
        series = grouped.mean(numeric_only=True)
        series["complete"] = grouped.complete.all()
        series = series.reset_index()
    else:
        grouped = series.groupby("month")
        series = grouped.mean(numeric_only=True)
        series["complete"] = grouped.complete.all()
        series = series.reset_index()
    return clean({"source": "Supabase", "region": region, "start": start, "end": end, "series": series.to_dict("records")})


def _region_months_runoff(monthly, region):
    data = monthly if region == "National" else monthly[monthly.District_Name.eq(region)]
    return data.groupby("month").mean(numeric_only=True)


@router.get("/metadata")
def metadata():
    try:
        return _metadata()
    except HTTPException:
        raise
    except SupabaseSourceError as exc:
        raise HTTPException(502, detail=str(exc)) from exc


@router.get("/dashboard")
def dashboard(region: str = "National", start: str | None = None, end: str | None = None, include_map: bool = True, include_runoff: bool = True):
    try:
        return _dashboard(region, start, end, include_map, include_runoff)
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


@router.get("/map")
def map_data(month: str | None = None):
    try:
        snapshot, meta = _snapshot(), _metadata()
        month = month or meta["default_end"]
        _validate(meta, "National", month, month)
        return clean({"source": "Supabase", "source_tables": meta["source_tables"][:2],
                      "month": month, "latest_date": meta["latest_date"], "map": _national_map(snapshot, meta, month)})
    except SupabaseSourceError as exc:
        raise HTTPException(502, detail=str(exc)) from exc


def _daily_rows(snapshot, month, region):
    def load():
        region_column, date_column = snapshot["region_columns"]["core"], snapshot["date_column"]
        keys = [*DAILY, "TAMSAT_Satellite_Rainfall_Estimate_mm_dekad"]
        actual = [snapshot["core_actual"][key] for key in keys]
        start, end = pd.Period(month, freq="M"), pd.Period(month, freq="M") + 1
        params = {"select": ",".join([region_column, date_column, *actual]),
                  "order": f"{region_column}.asc,{date_column}.asc", date_column: f"gte.{start.start_time:%Y-%m-%d}",
                  "and": f"({date_column}.lt.{end.start_time:%Y-%m-%d})"}
        if region:
            params[region_column] = f"eq.{region}"
        rows = _read_pages(snapshot["base"], snapshot["key"], snapshot["tables"]["core"], params)
        frame = pd.DataFrame(rows, columns=[region_column, date_column, *actual]).rename(columns={region_column: "District_Name", date_column: "Date", **dict(zip(actual, keys))})
        frame["Date"] = pd.to_datetime(frame.Date, errors="coerce")
        frame = frame.dropna(subset=["District_Name", "Date"]).sort_values(["District_Name", "Date"]).drop_duplicates(["District_Name", "Date"], keep="last")
        for key in keys:
            frame[key] = pd.to_numeric(frame[key], errors="coerce")
        return frame

    return cached_call("rainfall-daily", _source_version(snapshot), month, region, loader=load)


@router.get("/daily")
def daily(region: str = "National", month: str = "2026-08"):
    try:
        snapshot = _snapshot()
        meta = _metadata()
        _validate(meta, region, month, month)
        core = _daily_rows(snapshot, month, None if region == "National" else region)
        if core.empty:
            raise HTTPException(404, "No daily rainfall observations are available for this month.")
        selected = core.copy()
        selected["month"] = selected.Date.dt.strftime("%Y-%m")
        selected["dekad"] = np.minimum((selected.Date.dt.day - 1) // 10 + 1, 3)
        rows = selected.groupby("Date")[["Daily_Rainfall_Total_mm", "CHIRPS_Daily_Rainfall_Estimate_mm_day", "Gridded_Rainfall_Product_1km_mm", "Hourly_Rainfall_Intensity_mm_h"]].mean().reset_index()
        rows = rows.rename(columns={"Daily_Rainfall_Total_mm": "rainfall", "CHIRPS_Daily_Rainfall_Estimate_mm_day": "chirps", "Gridded_Rainfall_Product_1km_mm": "gridded", "Hourly_Rainfall_Intensity_mm_h": "intensity"})
        rows["date"] = rows.Date.dt.strftime("%Y-%m-%d")
        dekads = one_per_period(selected.rename(columns={"TAMSAT_Satellite_Rainfall_Estimate_mm_dekad": "tamsat"}), ["District_Name", "dekad"], ["tamsat"]).reset_index().groupby("dekad").tamsat.mean()
        days = pd.Period(month, freq="M").days_in_month
        return clean({"source": "Supabase", "region": region, "month": month, "series": rows.drop(columns="Date").to_dict("records"), "dekads": [{"dekad": int(dekad), "label": f"{(dekad - 1) * 10 + 1}-{min(dekad * 10, days) if dekad < 3 else days}", "tamsat": value} for dekad, value in dekads.items()]})
    except HTTPException:
        raise
    except SupabaseSourceError as exc:
        raise HTTPException(502, detail=str(exc)) from exc
