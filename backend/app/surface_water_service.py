"""Supabase-backed surface-water monitoring observations.

The existing surface-water dashboard is intentionally kept intact. This
adapter preserves its response contract while reading module 7 relations
through the server-side Supabase configuration. Reads are date-bounded,
paged, cached briefly, and request only columns used by the dashboard.
"""
from __future__ import annotations

import json
import os
import re
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache
from threading import Lock
from time import monotonic
from urllib.parse import quote, urlencode

import numpy as np
import pandas as pd
from fastapi import APIRouter, HTTPException

from app.supabase_source import SupabaseSourceError, _request_page, _settings
from app.dashboard_loader import dashboard_cache_ttl

router = APIRouter(prefix="/surface-water", tags=["Surface water network"])
TABLE_ENV = "NIWIS_SUPABASE_TABLES_MODULE_7"
DEFAULT_TABLES = ("9_1_hydrological_station_master", "9_2_catchment_characteristics_master", "9_3_sansa_earth_observation_master")
PAGE_SIZE = 1000
SCHEMA_TTL_SECONDS = dashboard_cache_ttl()
READ_CACHE_TTL_SECONDS = dashboard_cache_ttl()
READ_CACHE_MAX_ENTRIES = 96
_READ_CACHE: dict[tuple, tuple[float, pd.DataFrame]] = {}
_READ_CACHE_LOCK = Lock()
_SNAPSHOT_LOCK = Lock()
_METADATA_LOCK = Lock()

HYDRO = {"river_discharge_q": "discharge", "flow_velocity": "velocity", "stage_height": "stage", "daily_mean_flow": "daily_volume", "monthly_mean_flow": "reported_monthly_volume", "daily_sediment_load_t_day": "daily_sediment", "suspended_sediment_concentration": "sediment_concentration", "monthly_sediment_load_t_day": "reported_sediment_rate", "peak_instantaneous_flow": "reported_peak", "a_coeff": "rating_a", "b_exponent": "rating_b", "r_squared": "rating_r2"}
EO = {"surface_water_extent_km2": "water_extent", "ndwi_mean": "ndwi", "turbidity_proxy_ratio": "turbidity", "chlorophyll_a_mg_m3": "chlorophyll", "sediment_plume_pct": "plume", "flood_inundation_extent_km2": "flood_extent"}
LAND = [("water_bodies_pct", "Water bodies"), ("tree_cover_pct", "Tree cover"), ("shrubland_fynbos_pct", "Shrubland / fynbos"), ("grassland_pct", "Grassland"), ("cropland_agri_pct", "Cropland / agriculture"), ("wetland_pct", "Wetland"), ("builtup_urban_pct", "Built-up / urban"), ("bare_soil_mining_pct", "Bare soil / mining")]
METRICS = [
    ("discharge", "Reported river discharge", "m³/s", "Hydrology", "Mean of daily source discharge entries; not 15-minute telemetry"),
    ("velocity", "Flow velocity", "m/s", "Hydrology", "Monthly mean of daily source values"),
    ("stage", "Stage height", "m", "Hydrology", "Monthly mean above source gauge datum"),
    ("volume", "Daily-derived flow volume", "million m³", "Hydrology", "Sum of daily_mean_flow, treated as m³/day per specification, divided by 1,000,000"),
    ("reported_monthly_volume", "Reported monthly flow volume", "m³/month", "Hydrology", "One unique source value per month; conflicting months are unavailable"),
    ("volume_equivalent_q", "Volume-equivalent mean flow", "m³/s", "Hydrology", "Mean daily_mean_flow / 86,400, kept separate from reported Q"),
    ("reported_peak", "Reported peak flow", "m³/s", "Hydrology", "Maximum source peak entry per month; event timestamps not supplied"),
    ("bfi", "Baseflow index", "ratio", "Hydrology", "Not supplied; no baseflow separation inferred"),
    ("sediment_concentration", "Suspended sediment concentration", "mg/L", "Sediment", "Mean daily source concentration; not flow-weighted"),
    ("sediment_total", "Observed sediment load", "tonnes", "Sediment", "Sum of daily sediment-load entries over observed days"),
    ("reported_sediment_rate", "Source monthly sediment-rate field", "t/day", "Sediment", "Mean of monthly_sediment_load_t_day entries; retained as a rate, not a total"),
    ("water_extent", "Surface water extent", "km²", "Earth observation", "Reported monthly extent; not summed over time"),
    ("ndwi", "NDWI", "index", "Earth observation", "Reported monthly composite"),
    ("turbidity", "Turbidity proxy", "ratio", "Earth observation", "Reflectance proxy; not measured NTU"),
    ("chlorophyll", "Chlorophyll-a", "mg/m³", "Earth observation", "Source satellite estimate; no bloom threshold inferred"),
    ("plume", "Sediment plume", "%", "Earth observation", "Reported monthly visibility percentage; denominator unspecified"),
    ("flood_extent", "Flood inundation extent", "km²", "Earth observation", "Monthly source extent; no event polygons supplied"),
]

def _normalise(value: str) -> str:
    return re.sub(r"[^a-z0-9]", "", str(value).lower())

def _find_column(columns: list[str], *names: str) -> str | None:
    lookup = {_normalise(column): column for column in columns}
    return next((lookup[_normalise(name)] for name in names if _normalise(name) in lookup), None)

def _configured_tables() -> tuple[str, str, str]:
    raw = os.getenv(TABLE_ENV, ",".join(DEFAULT_TABLES))
    configured = [part.strip() for part in raw.split(",") if part.strip()]
    # Module 7 may also carry the section 11 reserve relations. Surface-water
    # keeps the first three 9.* relations and ignores those additional names.
    names = tuple(name for name in configured if re.match(r"^9[._][123](?:[._]|$)", name))
    if len(names) != 3 and len(configured) == 3:
        names = tuple(configured)
    if len(names) != 3 or len(set(names)) != 3:
        raise SupabaseSourceError(f"{TABLE_ENV} must list the hydrology, catchment, and earth-observation tables.")
    if any(not re.fullmatch(r"[A-Za-z0-9_. ]+", name) for name in names):
        raise SupabaseSourceError(f"{TABLE_ENV} contains an unsupported table name.")
    return names  # type: ignore[return-value]

def _table_candidates(configured: str, index: int) -> list[str]:
    candidates = [configured]
    prefix, dotted = (("9_1_", "9.1_"), ("9_2_", "9.2_"), ("9_3_", "9.3_"))[index]
    for value in (configured.replace(prefix, dotted, 1), configured.replace(dotted, prefix, 1)):
        if value not in candidates:
            candidates.append(value)
    return candidates

def _table_url(base: str, table: str, params: dict[str, str]) -> str:
    return f"{base}/rest/v1/{quote(table, safe='._')}?{urlencode(params)}"

def _read_pages(base: str, key: str, table: str, params: dict[str, str]) -> list[dict]:
    rows: list[dict] = []
    offset = 0
    for _ in range(512):
        page, _ = _request_page(_table_url(base, table, params), key, offset, offset + PAGE_SIZE - 1)
        rows.extend(page)
        if len(page) < PAGE_SIZE:
            return rows
        offset += len(page)
    raise SupabaseSourceError("A surface-water query exceeded the safe pagination limit.")

def _cached_frame(cache_key: tuple) -> pd.DataFrame | None:
    with _READ_CACHE_LOCK:
        cached = _READ_CACHE.get(cache_key)
        if not cached or cached[0] <= monotonic():
            _READ_CACHE.pop(cache_key, None)
            return None
        return cached[1].copy(deep=True)

def _store_frame(cache_key: tuple, frame: pd.DataFrame) -> None:
    with _READ_CACHE_LOCK:
        if len(_READ_CACHE) >= READ_CACHE_MAX_ENTRIES:
            _READ_CACHE.pop(min(_READ_CACHE, key=lambda item: _READ_CACHE[item][0]), None)
        _READ_CACHE[cache_key] = (monotonic() + READ_CACHE_TTL_SECONDS, frame.copy(deep=True))

def _worker_limit(count: int) -> int:
    try: configured = int(os.getenv("NIWIS_SURFACE_WATER_DB_WORKERS", "16"))
    except ValueError: configured = 16
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
    raise SupabaseSourceError(f"Could not resolve module 7 table '{configured}'. " + (errors[-1] if errors else ""))

def _column_descriptors(properties: dict, sample: dict | None) -> list[dict]:
    names = list(properties) if properties else list((sample or {}).keys())
    return [{"name": name, "type": (properties.get(name) or {}).get("type", "unknown"), "format": (properties.get(name) or {}).get("format")} for name in names]

@lru_cache(maxsize=4)
def _snapshot_cached(base: str, key: str, configured: tuple[str, str, str], epoch: int) -> dict:
    del epoch
    names = tuple(_resolve_relation(base, key, value, index) for index, value in enumerate(configured))
    from urllib.request import Request, urlopen
    from urllib.error import HTTPError, URLError
    request = Request(f"{base}/rest/v1/", headers={"apikey": key, "Authorization": f"Bearer {key}", "Accept": "application/json"})
    try:
        with urlopen(request, timeout=45) as response: openapi = json.loads(response.read().decode("utf-8"))
    except (HTTPError, URLError, TimeoutError) as exc:
        raise SupabaseSourceError(f"Could not inspect Supabase schema: {exc}") from exc
    definitions = openapi.get("definitions", {}) if isinstance(openapi, dict) else {}
    kinds = ("hydro", "catchments", "eo"); descriptors = []; columns = {}; samples = {}; properties = {}
    for index, table in enumerate(names):
        sample_rows, _ = _request_page(_table_url(base, table, {"select": "*", "limit": "1"}), key, 0, 0)
        sample = sample_rows[0] if sample_rows else {}; definition = definitions.get(table, {}) if isinstance(definitions, dict) else {}; table_properties = definition.get("properties", {}) if isinstance(definition, dict) else {}
        kind = kinds[index]; descriptor = {"table": table, "configured_table": configured[index], "columns": _column_descriptors(table_properties, sample)}
        descriptors.append(descriptor); columns[kind] = [item["name"] for item in descriptor["columns"]]; properties[kind] = table_properties; samples[kind] = sample
    district = {kind: _find_column(columns[kind], "district_name", "district", "region") for kind in kinds}
    date = {kind: _find_column(columns[kind], "date", "observation_date", "record_date") for kind in kinds}
    if any(not district[kind] for kind in kinds) or any(not date[kind] for kind in ("hydro", "eo")):
        raise SupabaseSourceError("Module 7 tables must expose district_name and date columns where applicable.")
    missing = [name for name in HYDRO if _find_column(columns["hydro"], name) is None] + [name for name in EO if _find_column(columns["eo"], name) is None] + [name for name, _ in LAND if _find_column(columns["catchments"], name) is None]
    if missing: raise SupabaseSourceError("Surface-water source columns are missing: " + ", ".join(missing))
    return {"base": base, "key": key, "tables": dict(zip(kinds, names)), "configured_tables": dict(zip(kinds, configured)), "columns": columns, "properties": properties, "samples": samples, "descriptors": descriptors, "district": district, "date": date, "hydro_actual": {source: _find_column(columns["hydro"], source) for source in HYDRO}, "eo_actual": {source: _find_column(columns["eo"], source) for source in EO}, "catchment_actual": {source: _find_column(columns["catchments"], source) for source, _ in LAND}}

def _snapshot() -> dict:
    base, key, _ = _settings(); configured = _configured_tables(); epoch = int(monotonic() // SCHEMA_TTL_SECONDS)
    with _SNAPSHOT_LOCK: return _snapshot_cached(base, key, configured, epoch)

def _date_windows(start: str, end: str) -> list[tuple[pd.Timestamp, pd.Timestamp]]:
    cursor = pd.Period(start, freq="M").start_time; final = (pd.Period(end, freq="M") + 1).start_time; windows = []
    while cursor < final:
        next_cursor = min(cursor + pd.Timedelta(days=90), final); windows.append((cursor, next_cursor)); cursor = next_cursor
    return windows

def _read_daily(snapshot: dict, kind: str, start: str, end: str, region: str | None) -> pd.DataFrame:
    cache_key = (kind, snapshot['base'], hash(snapshot['key']), snapshot["tables"][kind], start, end, region or "National"); cached = _cached_frame(cache_key)
    if cached is not None: return cached
    table, district, date = snapshot["tables"][kind], snapshot["district"][kind], snapshot["date"][kind]; actual_map = snapshot["hydro_actual"] if kind == "hydro" else snapshot["eo_actual"]; actual = list(actual_map.values()); columns = [district, date, *actual]; windows = _date_windows(start, end)
    def read(window):
        params = {"select": ",".join(columns), "order": f"{district}.asc,{date}.asc", date: f"gte.{window[0]:%Y-%m-%d}", "and": f"({date}.lt.{window[1]:%Y-%m-%d})"}
        if region and region != "National": params[district] = f"eq.{region}"
        rows = _read_pages(snapshot["base"], snapshot["key"], table, params); return pd.DataFrame(rows, columns=columns)
    with ThreadPoolExecutor(max_workers=_worker_limit(len(windows))) as executor: frames = list(executor.map(read, windows))
    frame = pd.concat([part for part in frames if not part.empty], ignore_index=True) if any(not part.empty for part in frames) else pd.DataFrame(columns=columns)
    frame = frame.rename(columns={district: "district_name", date: "date", **{actual: source for source, actual in actual_map.items()}})
    if not frame.empty:
        frame["date"] = pd.to_datetime(frame["date"], errors="coerce"); frame = frame.dropna(subset=["district_name", "date"]); frame = frame.sort_values(["district_name", "date"]).drop_duplicates(["district_name", "date"], keep="last")
        for column in [*HYDRO, *EO]:
            if column in frame: frame[column] = pd.to_numeric(frame[column], errors="coerce")
    _store_frame(cache_key, frame); return frame

def _read_catchments(snapshot: dict, month: str | None = None) -> pd.DataFrame:
    date = snapshot['date'].get('catchments')
    if date and month is None:
        raise SupabaseSourceError('Choose a month for dated catchment characteristics.')
    cache_key = ("catchments", snapshot['base'], hash(snapshot['key']), snapshot["tables"]["catchments"], month if date else None); cached = _cached_frame(cache_key)
    if cached is not None: return cached
    district = snapshot["district"]["catchments"]; actual = list(snapshot["catchment_actual"].values()); available = snapshot["columns"]["catchments"]
    wanted = [district, date, *actual, "dominant_hsg", "hsg_a_pct", "hsg_b_pct", "hsg_c_pct", "hsg_d_pct", "catchment_area_km2", "mean_slope_degrees", "mean_twi", "vegetation_cover_pct"]; columns = list(dict.fromkeys(column for column in wanted if column in available))
    params = {"select": ",".join(columns), "order": f"{district}.asc"}
    if date:
        period = pd.Period(month, freq='M')
        params.update({date: f'gte.{period.start_time:%Y-%m-%d}', 'and': f'({date}.lt.{(period + 1).start_time:%Y-%m-%d})', 'order': f'{district}.asc,{date}.asc'})
    rows = _read_pages(snapshot["base"], snapshot["key"], snapshot["tables"]["catchments"], params)
    rename = {district: "district_name", **{actual: source for source, actual in snapshot["catchment_actual"].items()}}
    if date:
        rename[date] = 'date'
    frame = pd.DataFrame(rows, columns=columns).rename(columns=rename)
    if date:
        frame['date'] = pd.to_datetime(frame['date'], errors='coerce')
        frame = frame.dropna(subset=['district_name', 'date'])
        attributes = [column for column in frame if column not in ('district_name', 'date')]
        if not frame.empty and frame.groupby(['district_name', 'date'])[attributes].nunique(dropna=False).gt(1).any().any():
            raise SupabaseSourceError('Conflicting catchment characteristics were found for the same district and date.')
        frame = frame.sort_values(['district_name', 'date'], kind='stable')
    for column in frame.columns:
        if column not in ("district_name", "dominant_hsg", "date"): frame[column] = pd.to_numeric(frame[column], errors="coerce")
    frame = frame.drop_duplicates("district_name", keep="last"); _store_frame(cache_key, frame); return frame

def _descriptor_rows(snapshot: dict) -> list[dict]:
    result = []
    for index, descriptor in enumerate(snapshot["descriptors"]):
        kind = ("hydro", "catchments", "eo")[index]; table = descriptor["table"]; district = snapshot["district"][kind]
        if kind == "catchments" and not snapshot['date'].get(kind): select, first_order, last_order = district, f"{district}.asc", f"{district}.desc"
        else:
            date = snapshot["date"][kind]; select, first_order, last_order = f"{district},{date}", f"{date}.asc", f"{date}.desc"
        first, content_range = _request_page(_table_url(snapshot["base"], table, {"select": select, "order": first_order, "limit": "1"}), snapshot["key"], 0, 0, count_exact=False); last, _ = _request_page(_table_url(snapshot["base"], table, {"select": select, "order": last_order, "limit": "1"}), snapshot["key"], 0, 0)
        try: rows = int((content_range or "").rsplit("/", 1)[1])
        except (ValueError, IndexError): rows = None
        result.append({**descriptor, "rows": rows, "first": first[0] if first else None, "last": last[0] if last else None})
    return result

def _metadata_snapshot(snapshot: dict) -> dict:
    descriptors = _descriptor_rows(snapshot); hydro_date, eo_date = snapshot["date"]["hydro"], snapshot["date"]["eo"]; hydro_first, hydro_last = descriptors[0]["first"] or {}, descriptors[0]["last"] or {}; eo_last = descriptors[2]["last"] or {}
    first_date, last_date = str(hydro_first.get(hydro_date, ""))[:10], str(hydro_last.get(hydro_date, ""))[:10]; months = [str(period) for period in pd.period_range(pd.Period(first_date[:7], freq="M"), pd.Period(last_date[:7], freq="M"), freq="M")]
    catchment_date = snapshot['date'].get('catchments')
    catchment_first = (descriptors[1]['first'] or {}).get(catchment_date) if catchment_date else None
    catchment_last = (descriptors[1]['last'] or {}).get(catchment_date) if catchment_date else None
    catchments = _read_catchments(snapshot, str(catchment_last)[:7] if catchment_last else None); region_count = catchments.district_name.nunique(); default_end = months[-1]
    # The newest daily month can be partial. Walk back only as far as needed
    # to find the newest month with every district and every calendar day.
    for candidate in reversed(months[-12:]):
        check = _read_daily(snapshot, "hydro", candidate, candidate, None)
        if check.empty: continue
        counts = check.groupby("district_name").date.nunique()
        if len(counts) == region_count and bool(counts.eq(pd.Period(candidate, freq="M").days_in_month).all()):
            default_end = candidate
            break
    kinds = ("hydro", "catchments", "eo"); cadence = {"hydro": "Daily hydrological rows", "catchments": "Dated catchment snapshots" if catchment_date else "Undated district characteristics", "eo": "Monthly earth-observation composites"}; source_rows = [{"file": descriptor["table"], "table": descriptor["table"], "rows": descriptor["rows"], "cadence": cadence[kinds[index]], "attribution": "Hydrological observations" if kinds[index] == "hydro" else "Catchment characteristics" if kinds[index] == "catchments" else "SANSA earth observation"} for index, descriptor in enumerate(descriptors)]
    regions = sorted(str(value) for value in catchments.district_name.dropna().unique())
    return {"source": "Supabase", "source_tables": [descriptor["table"] for descriptor in descriptors], "schema": descriptors, "regions": regions, "months": months, "default_start": max(months[0], str(pd.Period(default_end, freq="M") - 23)), "default_end": default_end, "latest_daily_date": str(hydro_last.get(hydro_date))[:10] if hydro_last else None, "latest_eo_month": str(eo_last.get(eo_date))[:7] if eo_last else None, "first_date": first_date, "rows": [descriptor["rows"] for descriptor in descriptors], "metrics": [{"key": key, "label": label, "unit": unit, "category": category, "method": method} for key, label, unit, category, method in METRICS], "files": [descriptor["table"] for descriptor in descriptors], "sources": source_rows, 'catchments_dated': bool(catchment_date), 'first_catchment_date': catchment_first, 'latest_catchment_date': catchment_last}

def _metadata() -> dict:
    with _METADATA_LOCK:
        snapshot = _snapshot(); signature_key = (snapshot["base"], hash(snapshot["key"]), tuple(snapshot["tables"].items()), int(monotonic() // SCHEMA_TTL_SECONDS)); cached = getattr(_metadata, "_cache", None)
        if cached and cached[0] == signature_key: return cached[1]
        value = _metadata_snapshot(snapshot); _metadata._cache = (signature_key, value); return value

def signature():
    snapshot = _snapshot(); return snapshot["base"], hash(snapshot["key"]), tuple(snapshot["tables"].items()), int(monotonic() // SCHEMA_TTL_SECONDS)

def clean(value):
    return json.loads(pd.Series([value]).to_json(orient="values", force_ascii=False))[0]

def prepare(hydro, catchments, eo):
    hydro = hydro.rename(columns=HYDRO).copy(); hydro["date"] = pd.to_datetime(hydro.date, errors="raise"); hydro = hydro.sort_values(["district_name", "date"]).drop_duplicates(["district_name", "date"], keep="last"); hydro["period"] = hydro.date.dt.strftime("%Y-%m"); hydro["volume_equivalent_q"] = hydro.daily_volume / 86400; hydro["flow_mismatch"] = ~np.isclose(hydro.discharge, hydro.volume_equivalent_q, rtol=.01, atol=.0001); hydro["flow_mismatch"] &= hydro.discharge.notna() & hydro.daily_volume.notna(); grouped = hydro.groupby(["district_name", "period"])
    monthly = grouped[["discharge", "velocity", "stage", "volume_equivalent_q", "sediment_concentration", "reported_sediment_rate"]].mean(); monthly["volume"] = grouped.daily_volume.sum(min_count=1) / 1e6; monthly["sediment_total"] = grouped.daily_sediment.sum(min_count=1); monthly["reported_peak"] = grouped.reported_peak.max(); monthly["reported_monthly_volume"] = grouped.reported_monthly_volume.first(); monthly["volume_conflict"] = grouped.reported_monthly_volume.nunique().gt(1); monthly.loc[monthly.volume_conflict, "reported_monthly_volume"] = np.nan; monthly["flow_mismatch_days"] = grouped.flow_mismatch.sum(); monthly["observed_days"] = grouped.daily_volume.count(); monthly["expected_days"] = pd.PeriodIndex(monthly.index.get_level_values("period"), freq="M").days_in_month; monthly["complete"] = monthly.observed_days.eq(monthly.expected_days); monthly["bfi"] = np.nan
    for key in ["rating_a", "rating_b", "rating_r2"]: monthly[key] = grouped[key].first().where(grouped[key].nunique().le(1))
    eo = eo.rename(columns=EO).copy(); eo["period"] = pd.to_datetime(eo.date).dt.strftime("%Y-%m"); eo_groups = eo.groupby(["district_name", "period"])
    if not eo.empty and eo_groups[list(EO.values())].nunique().gt(1).any().any(): raise HTTPException(503, "Conflicting satellite values were found for a district/month.")
    monthly = monthly.join(eo_groups[list(EO.values())].first(), how="outer"); monthly["complete"] = monthly.complete.fillna(False).astype(bool); monthly["volume_conflict"] = monthly.volume_conflict.fillna(False).astype(bool)
    if catchments.district_name.duplicated().any(): raise HTTPException(503, "Catchment characteristics must have one row per district.")
    return hydro, monthly.reset_index(), catchments.copy()

def _load_period(snapshot, start, end, region):
    with ThreadPoolExecutor(max_workers=2) as executor:
        hydro_future = executor.submit(_read_daily, snapshot, "hydro", start, end, region); eo_future = executor.submit(_read_daily, snapshot, "eo", start, end, region); return hydro_future.result(), eo_future.result()

def _validate(meta, region, start, end):
    if region != "National" and region not in set(meta["regions"]): raise HTTPException(404, "Surface-water district not found.")
    if start not in set(meta["months"]) or end not in set(meta["months"]) or start > end: raise HTTPException(422, "Choose a valid start and end month from the surface-water record.")

def _rainfall_context(region, start, end):
    try:
        from app import rainfall_service
        from app.drought_source import normalise_region
        rainfall_service.signature()
        try: body = rainfall_service._context_source(region, start, end)
        except HTTPException:
            meta = rainfall_service._metadata(); candidate = next((name for name in meta["regions"] if normalise_region(name) == normalise_region(region)), None)
            if candidate is None: raise
            body = rainfall_service._context_source(candidate, start, end)
        return {"status": "available", "source": "6.1_core_rainfall_variables_master", "latest_date": body.get("latest_date"), "series": [{"month": row.get("month"), "rainfall": row.get("rainfall"), "complete": bool(row.get("complete"))} for row in body.get("series", [])]}
    except (HTTPException, SupabaseSourceError, OSError, ValueError, KeyError):
        return {"status": "unavailable", "source": "Rainfall Status module", "series": []}


def _catchment_profile(catchments, region, month, regions):
    rows = catchments if region == 'National' else catchments[catchments.district_name.eq(region)]
    profile = rows.mean(numeric_only=True).to_dict()
    profile['soil_groups'] = sorted(rows.dominant_hsg.dropna().unique().tolist()) if 'dominant_hsg' in rows else []
    profile['land_cover_sum'] = rows[[key for key, _ in LAND]].sum(axis=1, min_count=len(LAND)).mean()
    profile['land_cover_valid_partition'] = bool(pd.notna(profile['land_cover_sum']) and abs(profile['land_cover_sum'] - 100) <= .1)
    expected = set(regions) if region == 'National' else {region}
    present = set(rows.district_name)
    dated = 'date' in rows
    dates = rows.date.dropna() if dated else pd.Series(dtype='datetime64[ns]')
    coverage = {'month': month if dated else None, 'districts': len(present), 'expected_districts': len(expected),
                'missing_districts': sorted(expected - present),
                'first_date': dates.min().strftime('%Y-%m-%d') if not dates.empty else None,
                'last_date': dates.max().strftime('%Y-%m-%d') if not dates.empty else None}
    return profile, coverage

def _dashboard(region="National", start=None, end=None):
    snapshot, meta = _snapshot(), _metadata(); start, end = start or meta["default_start"], end or meta["default_end"]; _validate(meta, region, start, end); history_start = max(meta["months"][0], str(pd.Period(start, freq="M") - 12)); requested = None if region == "National" else region; hydro, eo = _load_period(snapshot, history_start, end, requested); catchments = _read_catchments(snapshot, end); _, monthly, _ = prepare(hydro, catchments, eo); scoped = monthly if region == "National" else monthly[monthly.district_name.eq(region)]; full = scoped.groupby("period").mean(numeric_only=True); full["complete"] = scoped.groupby("period").complete.all(); full["volume_conflict"] = scoped.groupby("period").volume_conflict.any(); full.loc[full.volume_conflict, "reported_monthly_volume"] = np.nan; selected = full.loc[start:end].copy()
    if selected.empty: raise HTTPException(404, "No surface-water observations are available for this selection.")
    for month, row in selected.iterrows():
        prior = str(pd.Period(month, freq="M") - 12); selected.loc[month, "previous_discharge"] = full.loc[prior, "discharge"] if row.complete and prior in full.index and full.loc[prior, "complete"] else np.nan
    map_monthly = monthly
    if region != "National":
        map_hydro, map_eo = _load_period(snapshot, end, end, None); _, map_monthly, _ = prepare(map_hydro, catchments, map_eo)
    maps = map_monthly[map_monthly.period.eq(end)]; profile, catchment_coverage = _catchment_profile(catchments, region, end, meta['regions']); coverage = scoped[scoped.period.between(start, end)]; latest = selected.iloc[-1].to_dict(); rating = None if region == "National" else {key: latest.get(key) for key in ["rating_a", "rating_b", "rating_r2"]}
    weather = _rainfall_context(region, start, end); weather_by_month = {row["month"]: row for row in weather["series"]}; selected["rainfall"] = [weather_by_month.get(month, {}).get("rainfall", np.nan) for month in selected.index]; selected["rainfall_complete"] = [weather_by_month.get(month, {}).get("complete", False) for month in selected.index]; matched = selected[selected.complete & selected.rainfall_complete][["discharge", "rainfall"]].dropna(); correlation = matched.discharge.corr(matched.rainfall) if len(matched) >= 12 and matched.discharge.std() > 1e-12 and matched.rainfall.std() > 1e-12 else None
    warnings = ["This dataset covers 52 districts with daily rows. It does not identify individual gauges, provide station coordinates or contain 15-minute telemetry. BFI is not supplied."]
    if coverage.volume_conflict.any(): warnings.append("Reported monthly flow has conflicting values within selected months. Those monthly source volumes are unavailable; daily-derived volumes remain separate and visible.")
    if coverage.flow_mismatch_days.sum() > 0: warnings.append("Reported discharge and daily volume / 86,400 disagree in this selection. They are displayed separately and must not be treated as interchangeable measurements.")
    if catchment_coverage['missing_districts']: warnings.append(f"Catchment characteristics are unavailable for {len(catchment_coverage['missing_districts'])} selected district(s) in {end}. No attributes are filled from a different month.")
    if pd.notna(profile['land_cover_sum']) and not profile["land_cover_valid_partition"]: warnings.append("The eight supplied land-cover percentages do not sum to 100%. They are shown as independent reported values, without renormalising or drawing a composition pie.")
    if not selected.complete.all(): warnings.append("Partial daily coverage is present. Observed totals are not extrapolated to a full month; same-month comparisons and rainfall correlations require complete months.")
    return clean({"source": "Supabase", "source_tables": meta["source_tables"], "region": region, "start": start, "end": end, "latest_daily_date": meta["latest_daily_date"], "latest_eo_month": meta["latest_eo_month"], "series": selected.reset_index().rename(columns={"period": "month"}).to_dict("records"), "latest": latest, "summary": {"volume": selected.volume.sum(min_count=1), "sediment_total": selected.sediment_total.sum(min_count=1)}, "map": maps.to_dict("records"), "profile": profile, "catchment_coverage": catchment_coverage, "rating": rating, "land_cover": [{"label": label, "percent": profile.get(key)} for key, label in LAND], "soil": [{"label": group, "percent": profile.get(f"hsg_{group.lower()}_pct")} for group in "ABCD"], "coverage": {"observed_days": coverage.observed_days.sum(), "expected_days": coverage.expected_days.sum(), "complete_months": int(selected.complete.sum()), "months": len(selected), "conflicting_district_months": int(coverage.volume_conflict.sum()), "flow_mismatch_days": int(coverage.flow_mismatch_days.sum())}, "weather": {**weather, "correlation": correlation, "paired_months": len(matched)}, "warnings": warnings})

def _forecast_source(region="National", start=None, end=None):
    meta = _metadata(); end = end or meta["default_end"]; start = start or max(meta["months"][0], str(pd.Period(end, freq="M") - 35)); _validate(meta, region, start, end); snapshot = _snapshot(); catchments = _read_catchments(snapshot, end); hydro, eo = _load_period(snapshot, start, end, None if region == "National" else region); _, monthly, _ = prepare(hydro, catchments, eo); scoped = monthly if region == "National" else monthly[monthly.district_name.eq(region)]; series = scoped.groupby("period").mean(numeric_only=True); series["complete"] = scoped.groupby("period").complete.all()
    if series.empty: raise HTTPException(404, "No surface-water observations are available for this forecast selection.")
    return clean({"source": "Supabase", "source_tables": meta["source_tables"], "region": region, "start": start, "end": end, "series": series.reset_index().rename(columns={"period": "month"}).to_dict("records"), "metrics": [{"key": key, "label": label, "unit": unit, "category": category, "method": method} for key, label, unit, category, method in METRICS]})

@router.get("/metadata")
def metadata():
    try: return _metadata()
    except HTTPException: raise
    except SupabaseSourceError as exc: raise HTTPException(502, detail=str(exc)) from exc

@router.get("/dashboard")
def dashboard(region: str = "National", start: str | None = None, end: str | None = None):
    try: return _dashboard(region, start, end)
    except HTTPException: raise
    except SupabaseSourceError as exc: raise HTTPException(502, detail=str(exc)) from exc

@router.get("/forecast-source")
def forecast_source(region: str = "National", start: str | None = None, end: str | None = None):
    try: return _forecast_source(region, start, end)
    except HTTPException: raise
    except SupabaseSourceError as exc: raise HTTPException(502, detail=str(exc)) from exc

@router.get("/daily")
def daily(region: str = "National", month: str = "2026-08"):
    try:
        snapshot, meta = _snapshot(), _metadata(); _validate(meta, region, month, month); hydro = _read_daily(snapshot, "hydro", month, month, None if region == "National" else region)
        if hydro.empty: raise HTTPException(404, "No daily surface-water observations are available for this month.")
        hydro = hydro.rename(columns=HYDRO)
        hydro["volume_equivalent_q"] = hydro.daily_volume / 86400
        keys = ["discharge", "velocity", "stage", "daily_volume", "volume_equivalent_q", "daily_sediment", "sediment_concentration", "reported_monthly_volume", "reported_sediment_rate"]; result = hydro.groupby("date")[[key for key in keys if key in hydro]].mean().reset_index(); result["date"] = result.date.dt.strftime("%Y-%m-%d")
        return clean({"source": "Supabase", "region": region, "month": month, "series": result.to_dict("records")})
    except HTTPException: raise
    except SupabaseSourceError as exc: raise HTTPException(502, detail=str(exc)) from exc
