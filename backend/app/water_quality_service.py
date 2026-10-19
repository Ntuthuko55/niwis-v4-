"""Supabase-backed Water Quality Monitoring Network (section 12)."""
from __future__ import annotations

import json
import os
import re
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache
from pathlib import Path
from threading import Lock
from time import monotonic
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen

import pandas as pd
from fastapi import APIRouter, HTTPException

from app.dashboard_loader import dashboard_cache
from app.supabase_source import SupabaseSourceError, _request_page, _settings

router = APIRouter(prefix="/water-quality", tags=["Water quality monitoring"])
TABLE_ENV = "NIWIS_SUPABASE_TABLES_MODULE_7"
QUALITY_TABLE_ENV = "NIWIS_SUPABASE_TABLES_MODULE_12"
DEFAULT_TABLES = ("12.1_physical_water_quality_master", "12.2_chemical_water_quality_master", "12.3_biological_water_quality_master", "12.4_sansa_water_quality_master")
PAGE_SIZE = 1000
SCHEMA_TTL_SECONDS = 900
ROOT = Path(__file__).resolve().parents[2] / "water Quality Monitor"
FILES = {
    "physical": "12.1_physical_water_quality_monthly_2000_2026.csv",
    "chemical": "12.2_chemical_water_quality_monthly_2000_2026.csv",
    "biological": "12.3_biological_water_quality_monthly_2000_2026.csv",
    "sansa": "12.4_sansa_water_quality_monthly_2000_2026.csv",
}

METRICS = {
    "temperature_c": ("Temperature", "°C", "Physical", "DWS / in situ sensor value"),
    "turbidity_ntu": ("Turbidity", "NTU", "Physical", "DWS / SANSA proxy value"),
    "colour_hazen": ("Colour", "Hazen units", "Physical", "DWS laboratory value"),
    "electrical_conductivity_ms_m": ("Electrical conductivity (EC)", "mS/m", "Physical", "DWS / in situ sensor value"),
    "tds_mg_l": ("Total dissolved solids (TDS)", "mg/L", "Physical", "DWS laboratory value"),
    "tss_mg_l": ("Total suspended solids (TSS)", "mg/L", "Physical", "DWS laboratory value"),
    "salinity_mg_l": ("Salinity", "mg/L or ppt", "Physical", "DWS value"),
    "ph": ("pH", "pH units", "Chemical", "DWS value"),
    "dissolved_oxygen_mg_l": ("Dissolved oxygen (DO)", "mg/L", "Chemical", "DWS / in situ value"),
    "bod5_mg_l": ("Biological oxygen demand (BOD5)", "mg/L", "Chemical", "DWS laboratory value"),
    "cod_mg_l": ("Chemical oxygen demand (COD)", "mg/L", "Chemical", "DWS laboratory value"),
    "ammonia_mg_l": ("Ammonia (NH₃-N)", "mg/L", "Nutrients", "DWS laboratory value"),
    "nitrate_mg_l": ("Nitrate (NO₃-N)", "mg/L", "Nutrients", "DWS laboratory value"),
    "nitrite_mg_l": ("Nitrite (NO₂-N)", "mg/L", "Nutrients", "DWS laboratory value"),
    "total_phosphorus_mg_l": ("Total phosphorus (TP)", "mg/L", "Nutrients", "DWS laboratory value"),
    "orthophosphate_mg_l": ("Orthophosphate (PO₄³⁻)", "mg/L", "Nutrients", "DWS laboratory value"),
    "lead_cadmium_chromium_ug_l": ("Lead / cadmium / chromium", "µg/L", "Metals", "DWS / CSIR value"),
    "arsenic_mercury_ug_l": ("Arsenic / mercury", "µg/L", "Metals", "DWS / CSIR value"),
    "iron_manganese_mg_l": ("Iron / manganese", "mg/L", "Metals", "DWS laboratory value"),
    "toc_mg_l": ("Total organic carbon (TOC)", "mg/L", "Organic", "DWS laboratory value"),
    "sulphate_mg_l": ("Sulphate (SO₄²⁻)", "mg/L", "Inorganic", "DWS laboratory value"),
    "chloride_mg_l": ("Chloride (Cl⁻)", "mg/L", "Inorganic", "DWS laboratory value"),
    "fluoride_mg_l": ("Fluoride (F⁻)", "mg/L", "Inorganic", "DWS laboratory value"),
    "ecoli_cfu_100ml": ("E. coli", "cfu/100 mL", "Biological", "DWS / municipal laboratory value"),
    "total_coliforms_cfu_100ml": ("Total coliforms", "cfu/100 mL", "Biological", "DWS laboratory value"),
    "chlorophyll_a_ug_l": ("Chlorophyll-a", "µg/L", "Biological", "DWS / SANSA proxy value"),
    "blue_green_algae_cells_ml": ("Blue-green algae", "cells/mL", "Biological", "DWS value"),
    "microcystin_ug_l": ("Microcystin", "µg/L", "Biological", "DWS laboratory value"),
    "macroinvertebrate_sass5": ("Macroinvertebrate index (SASS5)", "SASS5", "Biological", "DWS value"),
    "pathogens_index": ("Pathogens", "source index", "Biological", "DWS / specialist laboratory value"),
    "sansa_turbidity_proxy": ("SANSA turbidity proxy", "proxy index", "SANSA remote sensing", "SANSA / Sentinel-2"),
    "sansa_chlorophyll_a_proxy": ("SANSA chlorophyll-a proxy", "proxy index", "SANSA remote sensing", "SANSA / Sentinel-3"),
    "cyanobacterial_bloom_index": ("Cyanobacterial bloom", "proxy index", "SANSA remote sensing", "SANSA"),
    "cdom_proxy": ("Coloured dissolved organic matter (CDOM)", "proxy index", "SANSA remote sensing", "SANSA"),
    "tsm_proxy": ("Total suspended matter (TSM)", "proxy index", "SANSA remote sensing", "SANSA / Sentinel-2"),
}

FIELD_MAPS = {
    "physical": {
        "temperature_c": ("Temperature",), "turbidity_ntu": ("Turbidity",), "colour_hazen": ("Colour",),
        "electrical_conductivity_ms_m": ("Electrical Conductivity (EC)",), "tds_mg_l": ("Total Dissolved Solids (TDS)",),
        "tss_mg_l": ("Total Suspended Solids (TSS)",), "salinity_mg_l": ("Salinity",),
    },
    "chemical": {
        "ph": ("pH",), "dissolved_oxygen_mg_l": ("Dissolved Oxygen (DO)",), "bod5_mg_l": ("BOD5",), "cod_mg_l": ("COD",),
        "ammonia_mg_l": ("Ammonia (NH3-N)",), "nitrate_mg_l": ("Nitrate (NO3-N)",), "nitrite_mg_l": ("Nitrite (NO2-N)",),
        "total_phosphorus_mg_l": ("Total Phosphorus (TP)",), "orthophosphate_mg_l": ("Orthophosphate (PO43-)",),
        "lead_cadmium_chromium_ug_l": ("Lead/Cadmium/Chromium",), "arsenic_mercury_ug_l": ("Arsenic/Mercury",),
        "iron_manganese_mg_l": ("Iron/Manganese",), "toc_mg_l": ("TOC",), "sulphate_mg_l": ("Sulphate",),
        "chloride_mg_l": ("Chloride",), "fluoride_mg_l": ("Fluoride",),
    },
    "biological": {
        "ecoli_cfu_100ml": ("E. coli",), "total_coliforms_cfu_100ml": ("Total coliforms",), "chlorophyll_a_ug_l": ("Chlorophyll-a",),
        "blue_green_algae_cells_ml": ("Blue-green algae",), "microcystin_ug_l": ("Microcystin",),
        "macroinvertebrate_sass5": ("Macroinvertebrate index (SASS5)",), "pathogens_index": ("Pathogens",),
    },
    "sansa": {
        "sansa_turbidity_proxy": ("Turbidity",), "sansa_chlorophyll_a_proxy": ("Chlorophyll-a",),
        "cyanobacterial_bloom_index": ("Cyanobacterial bloom",), "cdom_proxy": ("CDOM",), "tsm_proxy": ("Total Suspended Matter (TSM)",),
    },
}

_SNAPSHOT_LOCK = Lock()
_METADATA_LOCK = Lock()


def _normalise(value: str) -> str:
    return re.sub(r"[^a-z0-9]", "", str(value).lower())


def _find_column(columns: list[str], *names: str) -> str | None:
    lookup = {_normalise(column): column for column in columns}
    return next((lookup[_normalise(name)] for name in names if _normalise(name) in lookup), None)


def _configured_tables() -> tuple[str, str, str, str]:
    explicit = os.getenv(QUALITY_TABLE_ENV, "").strip()
    raw = explicit or os.getenv(TABLE_ENV, "")
    configured = [part.strip() for part in raw.split(",") if part.strip()]
    selected = [name for name in configured if re.match(r"^12[._][1-4](?:[._]|$)", name)]
    if len(selected) < 4 and len(configured) == 4:
        selected = configured
    if len(selected) >= 4:
        ordered = []
        for index in range(1, 5):
            match = next((name for name in selected if re.match(rf"^12[._]{index}(?:[._]|$)", name)), None)
            if match: ordered.append(match)
        if len(ordered) == 4: selected = ordered
    if len(selected) != 4: selected = list(DEFAULT_TABLES)
    if any(not re.fullmatch(r"[A-Za-z0-9_. ]+", name) for name in selected):
        raise SupabaseSourceError(f"{QUALITY_TABLE_ENV} or {TABLE_ENV} contains an unsupported table name.")
    return tuple(selected)  # type: ignore[return-value]


def _table_candidates(configured: str, index: int) -> list[str]:
    candidates = [configured]
    dotted = configured.replace(f"12_{index + 1}_", f"12.{index + 1}_", 1)
    underscored = configured.replace(f"12.{index + 1}_", f"12_{index + 1}_", 1)
    for value in (dotted, underscored):
        if value not in candidates: candidates.append(value)
    return candidates


def _table_url(base: str, table: str, params: dict[str, str]) -> str:
    return f"{base}/rest/v1/{quote(table, safe='._')}?{urlencode(params)}"


def _select_columns(columns: list[str]) -> str:
    return ",".join(column if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", column) else f'"{column.replace(chr(34), chr(34) * 2)}"' for column in columns)


def _read_pages(base: str, key: str, table: str, params: dict[str, str]) -> list[dict]:
    params = {name: value for name, value in params.items() if name != "limit"}
    first, content_range = _request_page(_table_url(base, table, params), key, 0, PAGE_SIZE - 1, True)
    try: total = int((content_range or "").rsplit("/", 1)[1])
    except (ValueError, IndexError): total = len(first)
    if len(first) >= total or len(first) < PAGE_SIZE: return first
    ranges = [(offset, min(total - 1, offset + PAGE_SIZE - 1)) for offset in range(PAGE_SIZE, total, PAGE_SIZE)]
    with ThreadPoolExecutor(max_workers=min(12, len(ranges))) as executor:
        pages = list(executor.map(lambda item: _request_page(_table_url(base, table, params), key, item[0], item[1])[0], ranges))
    return first + [row for page in pages for row in page]


def _request_document(base: str, key: str) -> dict:
    request = Request(f"{base}/rest/v1/", headers={"apikey": key, "Authorization": f"Bearer {key}", "Accept": "application/json"})
    try:
        with urlopen(request, timeout=45) as response: value = json.loads(response.read().decode("utf-8"))
    except (HTTPError, URLError, TimeoutError) as exc: raise SupabaseSourceError(f"Could not inspect Supabase schema: {exc}") from exc
    return value if isinstance(value, dict) else {}


def _infer_type(value) -> tuple[str, str | None]:
    if isinstance(value, bool): return "boolean", None
    if isinstance(value, int): return "integer", "integer"
    if isinstance(value, float): return "number", "double precision"
    return "string", "text"


def _column_descriptors(properties: dict, sample: dict | None) -> list[dict]:
    names = list(properties) if properties else list((sample or {}).keys())
    descriptors = []
    for name in names:
        if properties.get(name): descriptors.append({"name": name, "type": properties[name].get("type", "unknown"), "format": properties[name].get("format")})
        else:
            kind, fmt = _infer_type((sample or {}).get(name)); descriptors.append({"name": name, "type": kind, "format": fmt})
    return descriptors


@lru_cache(maxsize=4)
def _snapshot_cached(base: str, key: str, configured: tuple[str, str, str, str], epoch: int) -> dict:
    del epoch
    names = tuple(next((candidate for candidate in _table_candidates(value, index) if not _table_error(base, key, candidate)), value) for index, value in enumerate(configured))
    definitions = _request_document(base, key).get("definitions", {})
    kinds = ("physical", "chemical", "biological", "sansa")
    descriptors, columns, actual = [], {}, {}
    for index, table in enumerate(names):
        sample_rows, _ = _request_page(_table_url(base, table, {"select": "*", "limit": "1"}), key, 0, 0)
        sample = sample_rows[0] if sample_rows else {}; definition = definitions.get(table, {}) if isinstance(definitions, dict) else {}; properties = definition.get("properties", {}) if isinstance(definition, dict) else {}
        kind = kinds[index]; descriptor = {"table": table, "configured_table": configured[index], "columns": _column_descriptors(properties, sample)}; descriptors.append(descriptor); columns[kind] = [item["name"] for item in descriptor["columns"]]
    region = {kind: _find_column(columns[kind], "district_name", "district", "region") for kind in kinds}; year = {kind: _find_column(columns[kind], "year") for kind in kinds}; month = {kind: _find_column(columns[kind], "month") for kind in kinds}
    if any(not region[kind] or not year[kind] or not month[kind] for kind in kinds): raise SupabaseSourceError("Section 12 tables must expose district_name, year, and month columns.")
    for kind in kinds: actual[kind] = {canonical: _find_column(columns[kind], *choices) for canonical, choices in FIELD_MAPS[kind].items()}
    return {"base": base, "key": key, "tables": dict(zip(kinds, names)), "configured_tables": dict(zip(kinds, configured)), "descriptors": descriptors, "columns": columns, "region": region, "year": year, "month": month, "actual": actual}


def _table_error(base: str, key: str, table: str) -> bool:
    try:
        _request_page(_table_url(base, table, {"select": "*", "limit": "1"}), key, 0, 0); return False
    except SupabaseSourceError as exc:
        if "PGRST205" in str(exc) or "Could not find the table" in str(exc): return True
        raise


def _snapshot() -> dict:
    base, key, _ = _settings(); configured = _configured_tables(); epoch = int(monotonic() // SCHEMA_TTL_SECONDS)
    with _SNAPSHOT_LOCK: return _snapshot_cached(base, key, configured, epoch)


def _descriptor_rows(snapshot: dict) -> list[dict]:
    result = []
    for index, descriptor in enumerate(snapshot["descriptors"]):
        kind = ("physical", "chemical", "biological", "sansa")[index]; table = descriptor["table"]; region = snapshot["region"][kind]; year = snapshot["year"][kind]; month = snapshot["month"][kind]; select = _select_columns([region, year, month]); first, content_range = _request_page(_table_url(snapshot["base"], table, {"select": select, "order": f"{year}.asc,{month}.asc", "limit": "1"}), snapshot["key"], 0, 0, True); last, _ = _request_page(_table_url(snapshot["base"], table, {"select": select, "order": f"{year}.desc,{month}.desc", "limit": "1"}), snapshot["key"], 0, 0)
        try: rows = int((content_range or "").rsplit("/", 1)[1])
        except (ValueError, IndexError): rows = None
        result.append({**descriptor, "rows": rows, "first": first[0] if first else None, "last": last[0] if last else None})
    return result


def _metadata_snapshot(snapshot: dict) -> dict:
    descriptors = _descriptor_rows(snapshot); first = descriptors[0]["first"] or {}; last = descriptors[0]["last"] or {}; year = snapshot["year"]["physical"]; month = snapshot["month"]["physical"]
    first_period = pd.Period(f"{int(first[year]):04d}-{int(first[month]):02d}", "M"); last_period = pd.Period(f"{int(last[year]):04d}-{int(last[month]):02d}", "M"); months = [str(period) for period in pd.period_range(first_period, last_period, freq="M")]
    region = snapshot["region"]["physical"]; rows = _read_pages(snapshot["base"], snapshot["key"], snapshot["tables"]["physical"], {"select": region, "order": f"{region}.asc", year: f"eq.{last_period.year}"}); regions = sorted({str(row[region]) for row in rows if row.get(region) is not None})
    kinds = ("physical", "chemical", "biological", "sansa"); source_rows = [{"file": item["table"], "table": item["table"], "rows": item["rows"], "cadence": "Monthly district values", "attribution": f"Supabase section 12.{index + 1}"} for index, item in enumerate(descriptors)]
    return {"source": "Supabase", "source_tables": [item["table"] for item in descriptors], "schema": descriptors, "first_date": f"{first_period}-01", "last_date": f"{last_period.end_time:%Y-%m-%d}", "latest_period": str(last_period), "default_start": int(first_period.year), "default_end": int(last_period.year), "years": list(range(first_period.year, last_period.year + 1)), "months": months, "regions": regions, "rows": {kind: descriptors[index]["rows"] for index, kind in enumerate(kinds)}, "files": [item["table"] for item in descriptors], "metrics": [{"key": key, "label": label, "unit": unit, "category": category, "description": description} for key, (label, unit, category, description) in METRICS.items()], "sources": source_rows}


def _metadata() -> dict:
    with _METADATA_LOCK:
        snapshot = _snapshot(); signature = (snapshot["base"], hash(snapshot["key"]), tuple(snapshot["tables"].items()), int(monotonic() // SCHEMA_TTL_SECONDS)); cached = getattr(_metadata, "_cache", None)
        if cached and cached[0] == signature: return cached[1]
        value = _metadata_snapshot(snapshot); _metadata._cache = (signature, value); return value


def _read_table(snapshot: dict, kind: str, start_year: int, end_year: int) -> pd.DataFrame:
    table = snapshot["tables"][kind]; region = snapshot["region"][kind]; year = snapshot["year"][kind]; month = snapshot["month"][kind]; actual = snapshot["actual"][kind]; columns = list(dict.fromkeys([region, year, month, *[column for column in actual.values() if column]])); params = {"select": _select_columns(columns), "order": f"{region}.asc,{year}.asc,{month}.asc", year: f"gte.{start_year}", "and": f"({year}.lte.{end_year})"}; rows = _read_pages(snapshot["base"], snapshot["key"], table, params); frame = pd.DataFrame(rows, columns=columns); frame = frame.rename(columns={region: "district_name", year: "year", month: "month", **{column: canonical for canonical, column in actual.items() if column}})
    if frame.empty: return frame
    frame["year"] = pd.to_numeric(frame["year"], errors="coerce"); frame["month"] = pd.to_numeric(frame["month"], errors="coerce")
    for key in actual:
        if key in frame: frame[key] = pd.to_numeric(frame[key], errors="coerce")
    return frame.dropna(subset=["district_name", "year", "month"]).drop_duplicates(["district_name", "year", "month"], keep="last")


@dashboard_cache("water-quality.monthly")
def _load_monthly(snapshot: dict, start_year: int, end_year: int) -> pd.DataFrame:
    kinds = ("physical", "chemical", "biological", "sansa")
    with ThreadPoolExecutor(max_workers=4) as executor: frames = dict(zip(kinds, executor.map(lambda kind: _read_table(snapshot, kind, int(start_year), int(end_year)), kinds)))
    keys = ["district_name", "year", "month"]; monthly = frames["physical"]
    for kind in kinds[1:]: monthly = monthly.merge(frames[kind], on=keys, how="outer")
    province = _find_column(snapshot["columns"]["physical"], "province_name", "province")
    if province:
        # Province is metadata only; it is retained when the physical relation provides it.
        p = _read_pages(snapshot["base"], snapshot["key"], snapshot["tables"]["physical"], {"select": _select_columns(["district_name", province]), "order": "district_name.asc", "district_name": "not.is.null", snapshot["year"]["physical"]: f"eq.{end_year}"})
        monthly = monthly.merge(pd.DataFrame(p).rename(columns={province: "province_name"}).drop_duplicates("district_name"), on="district_name", how="left")
    monthly["period"] = monthly.year.astype(int).astype(str) + "-" + monthly.month.astype(int).astype(str).str.zfill(2)
    return monthly.sort_values(["district_name", "period"]).reset_index(drop=True)


def _clean(value): return json.loads(pd.Series([value]).to_json(orient="values", force_ascii=False))[0]


def _validate(monthly: pd.DataFrame, region: str, start: int, end: int):
    if region != "National" and region not in set(monthly.district_name): raise HTTPException(400, f"Unknown water-quality district: {region}")
    start_year, end_year = int(start), int(end)
    if start_year > end_year: raise HTTPException(400, "Water-quality end year must be on or after start year.")
    return start_year, end_year


def _annual(frame: pd.DataFrame, metrics: list[str]) -> pd.DataFrame:
    available = [key for key in metrics if key in frame]; district_year = frame.groupby(["district_name", "year"], as_index=False)[available].mean(); annual = district_year.groupby("year", as_index=False)[available].mean()
    for key in metrics:
        if key not in annual: annual[key] = None
    return annual[["year", *metrics]]


@router.get("/metadata")
def metadata():
    try: return _metadata()
    except HTTPException: raise
    except SupabaseSourceError as exc: raise HTTPException(502, detail=str(exc)) from exc


@router.get("/dashboard")
def dashboard(region: str = "National", start: int = 2000, end: int = 2026):
    try:
        snapshot, meta = _snapshot(), _metadata(); monthly = _load_monthly(snapshot, start, end); start_year, end_year = _validate(monthly, region, start, end); metrics = list(METRICS); scoped = monthly if region == "National" else monthly[monthly.district_name.eq(region)]; selected = scoped[scoped.year.between(start_year, end_year)]
        if selected.empty: raise HTTPException(422, "No water-quality observations fall within this period.")
        annual = _annual(selected, metrics); latest = annual.iloc[-1].to_dict(); map_period = monthly[monthly.year.eq(end_year)]; available = [key for key in metrics if key in map_period]; district_map = map_period.groupby(["district_name"], as_index=False)[available].mean()
        warnings = ["The Supabase relations contain district-level monthly values, not station IDs, coordinates or a sampling-site inventory.", "The source rows do not include a network-type field separating surface water, groundwater and drinking water; the dashboard reports the supplied district aggregates.", "SANSA columns are remote-sensing proxies and are kept separate from laboratory and in-situ measurements.", "No SANS 241, ecological-status or DWS threshold classification is imposed because threshold metadata is not present in the source relations."]
        return _clean({"source": "Supabase", "source_tables": meta["source_tables"], "region": region, "start": start_year, "end": end_year, "series": annual.to_dict("records"), "latest": latest, "map": district_map.to_dict("records"), "warnings": warnings, "variables": metrics, "source_coverage": {"first_date": meta["first_date"], "last_date": meta["last_date"], "districts": len(meta["regions"])}, "quality": {"missing_values": int(selected[metrics].isna().sum().sum()), "rows": int(len(selected)), "map_year": end_year, "complete_rows": int(selected[metrics].notna().all(axis=1).sum())}})
    except HTTPException: raise
    except SupabaseSourceError as exc: raise HTTPException(502, detail=str(exc)) from exc


@router.get("/monthly")
def monthly_detail(region: str = "National", year: int | None = 2026, start: int | None = None, end: int | None = None):
    try:
        snapshot, meta = _snapshot(), _metadata(); selected_start, selected_end = (year, year) if start is None and end is None else (start or meta["default_start"], end or meta["default_end"]); monthly = _load_monthly(snapshot, selected_start, selected_end); selected_start, selected_end = _validate(monthly, region, selected_start, selected_end); scoped = monthly if region == "National" else monthly[monthly.district_name.eq(region)]; selected = scoped[scoped.year.between(selected_start, selected_end)]; metrics = list(METRICS); available = [key for key in metrics if key in selected]; district_month = selected.groupby(["district_name", "period"], as_index=False)[available].mean(); grouped = district_month.groupby("period", as_index=False)[available].mean()
        for key in metrics:
            if key not in grouped: grouped[key] = None
        return _clean({"source": "Supabase", "source_tables": meta["source_tables"], "region": region, "year": selected_end, "start": selected_start, "end": selected_end, "series": grouped[["period", *metrics]].to_dict("records"), "variables": metrics})
    except HTTPException: raise
    except SupabaseSourceError as exc: raise HTTPException(502, detail=str(exc)) from exc
