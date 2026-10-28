"""Supabase-backed wastewater compliance intelligence (section 13)."""
from __future__ import annotations

import json
import math
import os
import re
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache
from time import monotonic
from urllib.parse import quote, urlencode

import pandas as pd
from fastapi import APIRouter, HTTPException

from app.dashboard_loader import dashboard_cache
from app.supabase_source import SupabaseSourceError, _request_page, _settings

router = APIRouter(prefix="/wastewater", tags=["Wastewater compliance"])
PAGE_SIZE = 1000
SCHEMA_TTL_SECONDS = 900
TABLES = (
    ("effluent", "13.1_wastewater_effluent_quality_master", "Effluent quality"),
    ("operations", "13.2_WWTW_operational_master", "WWTW operations"),
    ("meteorology", "13.3_meteorological_variables_(SAWS)_for_WWTW_Compliance_master", "SAWS meteorology"),
)

# Alias matching is schema-driven: only indicators represented by a real source
# column (or long-form variable row) are returned as available.
INDICATORS = {
    "temperature_c": ("Temperature", "°C", "Physical", ("temperature", "temp_c")),
    "turbidity_ntu": ("Turbidity / clarity", "NTU", "Physical", ("turbidity", "clarity")),
    "electrical_conductivity_ms_m": ("Electrical conductivity (EC)", "mS/m", "Physical", ("electrical_conductivity", "conductivity", "ec_ms_m", "ec_salinity")),
    "tss_mg_l": ("Total suspended solids (TSS)", "mg/L", "Physical", ("total_suspended_solids", "tss")),
    "ph": ("pH", "pH units", "Chemical", ("ph", "ph_value")),
    "dissolved_oxygen_mg_l": ("Dissolved oxygen (DO)", "mg/L", "Chemical", ("dissolved_oxygen", "do_mg_l", "do")),
    "bod5_mg_l": ("BOD5", "mg/L", "Chemical", ("bod5", "biochemical_oxygen_demand")),
    "cod_mg_l": ("COD", "mg/L", "Chemical", ("cod", "chemical_oxygen_demand")),
    "ammonia_mg_l": ("Ammonia (NH₃-N)", "mg/L", "Nutrients", ("ammonia", "nh3_n")),
    "tin_mg_l": ("Total inorganic nitrogen (TIN)", "mg/L", "Nutrients", ("total_inorganic_nitrogen", "tin")),
    "total_phosphorus_mg_l": ("Total phosphorus (TP)", "mg/L", "Nutrients", ("total_phosphorus", "phosphorus", "tp")),
    "heavy_metals_ug_l": ("Heavy metals (Pb, Hg, Cd, Cr, As, Ni, Zn)", "µg/L", "Metals", ("heavy_metals", "heavy_metal_concentration")),
    "ecoli_cfu_100ml": ("E. coli", "cfu/100 mL", "Biological", ("ecoli", "e_coli", "escherichia_coli")),
    "faecal_coliforms_cfu_100ml": ("Faecal coliforms", "cfu/100 mL", "Biological", ("faecal_coliform", "fecal_coliform")),
    "helminth_eggs_l": ("Helminth eggs", "eggs/L", "Biological", ("helminth", "eggs_per_litre")),
    "influent_flow_m3_day": ("Influent flow rate", "m³/day", "Operations", ("influent_flow", "inflow", "flow_rate")),
    "design_capacity_m3_day": ("Design capacity", "m³/day", "Operations", ("design_capacity", "licensed_capacity")),
    "hydraulic_loading_pct": ("Hydraulic loading rate", "% of capacity", "Operations", ("hydraulic_loading", "loading_rate")),
    "hydraulic_retention_hours": ("Hydraulic retention time", "hours", "Operations", ("hydraulic_retention", "retention_time", "hrt")),
    "sludge_production_m3_day": ("Sludge production", "m³/day", "Operations", ("sludge_production", "sludge_volume")),
    "chlorine_residual_mg_l": ("Chlorine dosing / residual", "mg/L", "Operations", ("chlorine", "chlorine_residual")),
    "power_consumption_kwh_day": ("Power consumption", "kWh/day", "Operations", ("power_consumption", "energy_consumption", "kwh")),
    "inflow_infiltration_m3_day": ("Inflow / infiltration (I&I)", "m³/day", "Operations", ("inflow_infiltration", "infiltration", "i_i")),
    "rainfall_mm": ("Rainfall", "mm", "Meteorological", ("rainfall", "precipitation")),
    "flood_events": ("Flood events", "events", "Meteorological", ("flood_event", "flood")),
    "air_temperature_c": ("Air temperature", "°C", "Meteorological", ("air_temperature", "temperature", "temp_c")),
    "evaporation_mm": ("Evaporation", "mm", "Meteorological", ("evaporation", "evapotranspiration")),
}
ALLOWED_TABLES = {
    **{key: {"effluent"} for key, value in INDICATORS.items() if value[2] in {"Physical", "Chemical", "Nutrients", "Metals", "Biological"}},
    **{key: {"operations"} for key, value in INDICATORS.items() if value[2] == "Operations"},
    **{key: {"meteorology"} for key, value in INDICATORS.items() if value[2] == "Meteorological"},
}


def _norm(value: str) -> str:
    return re.sub(r"[^a-z0-9]", "", str(value).lower())


def _table_url(base: str, table: str, params: dict[str, str]) -> str:
    return f"{base}/rest/v1/{quote(table, safe='._')}?{urlencode(params)}"


@dashboard_cache("wastewater.source-rows")
def _read_table(base: str, key: str, table: str) -> list[dict]:
    sample, _ = _request_page(_table_url(base, table, {"select": "*", "limit": "1"}), key, 0, 0)
    if not sample:
        return []
    columns = list(sample[0])
    order_columns = list(dict.fromkeys(column for column in (
        _column(columns, "district_name", "district", "municipality", "region", "province"),
        _column(columns, "date", "sample_date", "observation_date", "record_date", "timestamp"),
        _column(columns, "year"), _column(columns, "month"), _column(columns, "shapeID"),
    ) if column))
    params = {"select": "*"}
    if order_columns:
        params["order"] = ",".join(f"{column}.asc" for column in order_columns)
    url = _table_url(base, table, params)
    rows, content_range = _request_page(url, key, 0, PAGE_SIZE - 1, True)
    try:
        total = int((content_range or "").rsplit("/", 1)[1])
    except (ValueError, IndexError):
        total = None
    if not rows:
        if total:
            raise SupabaseSourceError("The wastewater source returned an incomplete first page.")
        return []
    page_size = len(rows)
    if total is None:
        while True:
            offset = len(rows)
            try:
                page, _ = _request_page(url, key, offset, offset + PAGE_SIZE - 1)
            except SupabaseSourceError as exc:
                if "HTTP 416" in str(exc) and "PGRST103" in str(exc):
                    break
                raise
            if not page:
                break
            rows.extend(page)
    else:
        offsets = list(range(page_size, total, page_size))
        if offsets:
            with ThreadPoolExecutor(max_workers=min(8, len(offsets))) as pool:
                pages = list(pool.map(lambda offset: _request_page(url, key, offset, min(total - 1, offset + page_size - 1))[0], offsets))
            for offset, page in zip(offsets, pages):
                if len(page) != min(page_size, total - offset):
                    raise SupabaseSourceError("The wastewater source changed or returned an incomplete page. Please retry the request.")
                rows.extend(page)
        if len(rows) != total:
            raise SupabaseSourceError("The wastewater source returned an incomplete national dataset.")
    return rows


def _first_existing(base: str, key: str, configured: str) -> tuple[str, list[dict]]:
    candidates = [configured]
    candidates.extend((configured.replace(".", "_", 1), configured.replace(".", "_")))
    last_error = None
    for table in dict.fromkeys(candidates):
        try:
            rows, _ = _request_page(_table_url(base, table, {"select": "*", "limit": "1"}), key, 0, 0)
            return table, rows
        except SupabaseSourceError as exc:
            last_error = exc
            if "PGRST205" not in str(exc) and "Could not find the table" not in str(exc):
                raise
    raise last_error or SupabaseSourceError(f"Could not find Supabase table '{configured}'.")


@lru_cache(maxsize=4)
def _snapshot(base: str, key: str, table_names: tuple[str, str, str], epoch: int) -> dict:
    del epoch
    resolved = []
    for (kind, _, label), configured in zip(TABLES, table_names):
        table, sample = _first_existing(base, key, configured)
        resolved.append({"kind": kind, "label": label, "table": table, "configured_table": configured, "columns": list(sample[0]) if sample else []})
    return {"base": base, "key": key, "tables": resolved}


def _configured_tables() -> tuple[str, str, str]:
    raw = os.getenv("NIWIS_SUPABASE_TABLES_MODULE_13", "").strip()
    names = tuple(part.strip() for part in raw.split(",") if part.strip()) if raw else tuple(item[1] for item in TABLES)
    if len(names) != 3 or any(not re.fullmatch(r"[A-Za-z0-9_.() -]+", item) for item in names):
        raise SupabaseSourceError("NIWIS_SUPABASE_TABLES_MODULE_13 must contain the three wastewater relation names.")
    return names  # type: ignore[return-value]


def _snapshot_live() -> dict:
    base, key, _ = _settings()
    epoch = int(monotonic() // SCHEMA_TTL_SECONDS)
    return _snapshot(base, key, _configured_tables(), epoch)


def _column(columns: list[str], *aliases: str) -> str | None:
    lookup = {_norm(value): value for value in columns}
    for alias in aliases:
        normalized = _norm(alias)
        if normalized in lookup:
            return lookup[normalized]
        if len(normalized) >= 4:
            match = next((column for key, column in lookup.items() if normalized in key), None)
            if match:
                return match
    return None


def _descriptors(snapshot: dict) -> list[dict]:
    output = []
    for descriptor in snapshot["tables"]:
        rows, content_range = _request_page(_table_url(snapshot["base"], descriptor["table"], {"select": "*"}), snapshot["key"], 0, 99, True)
        try:
            count = int((content_range or "").rsplit("/", 1)[1])
        except (ValueError, IndexError):
            count = None
        output.append({**descriptor, "rows": count, "sample": rows[:1]})
    return output


def _metadata_value(snapshot: dict) -> dict:
    descriptors = _descriptors(snapshot)
    table_columns = {item["kind"]: item["columns"] for item in descriptors}
    match_fields = []
    for key, (label, unit, category, aliases) in INDICATORS.items():
        actual = {}
        for item in descriptors:
            if item["kind"] not in ALLOWED_TABLES[key]:
                continue
            found = _column(item["columns"], key, *aliases)
            if found:
                actual[item["kind"]] = found
            else:
                # Support long-form tables with a parameter/name and numeric value column.
                parameter = _column(item["columns"], "parameter", "parameter_name", "variable", "variable_name", "indicator", "indicator_name", "analyte", "measurement")
                value = _column(item["columns"], "value", "result", "measurement_value", "concentration")
                parameter_values = [str(row.get(parameter, "")) for row in item.get("sample", [])] if parameter else []
                if parameter and value and any(any(_norm(alias) in _norm(parameter_value) for alias in aliases) for parameter_value in parameter_values):
                    actual[item["kind"]] = {"parameter": parameter, "value": value}
        if actual:
            match_fields.append({"key": key, "label": label, "unit": unit, "category": category, "fields": actual})
    rows_total = sum(item["rows"] or 0 for item in descriptors)
    return {
        "source": "Supabase", "source_tables": [item["table"] for item in descriptors],
        "tables": [{"kind": item["kind"], "label": item["label"], "table": item["table"], "rows": item["rows"], "columns": item["columns"]} for item in descriptors],
        "indicators": match_fields,
        "coverage": {"rows": rows_total, "works": None, "read_limit_per_table": None},
        "capabilities": {"date": any(_column(cols, "date", "sample_date", "observation_date", "record_date", "year") for cols in table_columns.values()), "district": any(_column(cols, "district", "district_name", "municipality", "region", "province") for cols in table_columns.values()), "receiving_water": any(_column(cols, "receiving_water", "river", "catchment", "downstream_site") for cols in table_columns.values()), "plant_coordinates": any(_column(cols, "latitude", "lat") and _column(cols, "longitude", "lon", "lng") for cols in table_columns.values())},
    }


def _metadata() -> dict:
    snapshot = _snapshot_live()
    signature = (snapshot["base"], hash(snapshot["key"]), tuple(item["table"] for item in snapshot["tables"]), int(monotonic() // SCHEMA_TTL_SECONDS))
    cached = getattr(_metadata, "_cache", None)
    if cached and cached[0] == signature:
        return cached[1]
    result = _metadata_value(snapshot)
    _metadata._cache = (signature, result)
    return result


def _to_frame(rows: list[dict], descriptor: dict) -> pd.DataFrame:
    frame = pd.DataFrame(rows)
    if frame.empty:
        return frame
    date_col = _column(list(frame.columns), "date", "sample_date", "observation_date", "record_date", "timestamp")
    year_col = _column(list(frame.columns), "year")
    if date_col:
        dates = pd.to_datetime(frame[date_col], errors="coerce")
        frame["_year"] = dates.dt.year
        frame["_period"] = dates.dt.to_period("M").astype(str)
    elif year_col:
        frame["_year"] = pd.to_numeric(frame[year_col], errors="coerce")
        month_col = _column(list(frame.columns), "month")
        frame["_period"] = frame["_year"].astype("Int64").astype(str) + ("-" + pd.to_numeric(frame[month_col], errors="coerce").astype("Int64").astype(str).str.zfill(2) if month_col else "")
    else:
        return frame
    return frame


def _clean(value):
    return json.loads(pd.Series([value]).to_json(orient="values", force_ascii=False))[0]


@router.get("/metadata")
def metadata():
    try:
        return _metadata()
    except SupabaseSourceError as exc:
        raise HTTPException(502, detail=str(exc)) from exc


@router.get("/dashboard")
@dashboard_cache("wastewater.dashboard")
def dashboard(region: str = "National", start: int = 2000, end: int = 2026):
    if start > end:
        raise HTTPException(400, "Wastewater end year must be on or after start year.")
    try:
        snapshot = _snapshot_live()
        meta = _metadata()
        frames = {}
        for item in snapshot["tables"]:
            frames[item["kind"]] = _to_frame(_read_table(snapshot["base"], snapshot["key"], item["table"]), item)
        values, district_rows = {}, {}
        available = {item["key"]: item for item in meta["indicators"]}
        for indicator, descriptor in available.items():
            yearly = []
            mapped = []
            spec = INDICATORS[indicator]
            for kind, field in descriptor["fields"].items():
                frame = frames[kind]
                if frame.empty or "_year" not in frame:
                    continue
                district = _column(list(frame.columns), "district", "district_name", "municipality", "region", "province")
                value_col = field.get("value") if isinstance(field, dict) else field
                if isinstance(field, dict):
                    parameter = field["parameter"]
                    mask = frame[parameter].astype(str).map(_norm).str.contains("|".join(_norm(a) for a in spec[3]), regex=True, na=False)
                    frame = frame.loc[mask]
                if value_col not in frame:
                    continue
                frame = frame.copy()
                frame["_value"] = pd.to_numeric(frame[value_col], errors="coerce")
                frame = frame[frame["_year"].between(start, end) & frame["_value"].notna()]
                if region != "National" and district:
                    frame = frame[frame[district].astype(str).str.casefold() == region.casefold()]
                if frame.empty:
                    continue
                agg = frame.groupby("_year", as_index=False)["_value"].mean()
                yearly.extend({"year": int(year), indicator: float(value)} for year, value in agg.itertuples(index=False, name=None))
                if district:
                    # The map depicts each district's latest available source value
                    # within the selected period; trends retain the full interval.
                    latest_year = frame["_year"].max()
                    map_frame = frame[frame["_year"] == latest_year]
                    per_district = map_frame.groupby(district, as_index=False)["_value"].mean()
                    mapped.extend({"district_name": str(row[0]), indicator: float(row[1])} for row in per_district.itertuples(index=False, name=None))
            if yearly:
                grouped = pd.DataFrame(yearly).groupby("year", as_index=False)[indicator].mean()
                values[indicator] = {"label": descriptor["label"], "unit": descriptor["unit"], "category": descriptor["category"], "series": grouped.to_dict("records"), "latest": grouped.iloc[-1][indicator]}
            if mapped:
                district_rows[indicator] = {row["district_name"]: row[indicator] for row in mapped}
        years = sorted({int(row["year"]) for item in values.values() for row in item["series"]})
        series = []
        for year in years:
            item = {"year": year}
            for key, value in values.items():
                match = next((row for row in value["series"] if int(row["year"]) == year), None)
                item[key] = match[key] if match else None
            series.append(item)
        map_rows = {}
        for key, records in district_rows.items():
            for district, value in records.items():
                map_rows.setdefault(district, {"district_name": district})[key] = value
        return _clean({"source": "Supabase", "source_tables": meta["source_tables"], "region": region, "start": start, "end": end, "indicators": values, "series": series, "map": list(map_rows.values()), "source_coverage": meta["coverage"], "capabilities": meta["capabilities"], "compliance_classification": None})
    except SupabaseSourceError as exc:
        raise HTTPException(502, detail=str(exc)) from exc


def _forecast_number(value):
    if value is None or isinstance(value, bool):
        return None
    try:
        result = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return result if math.isfinite(result) else None


def _forecast_column(columns: list[str], *aliases: str) -> str | None:
    # Forecast time and geography fields require an exact normalized alias.
    # Fuzzy 'date' matching can otherwise select an unrelated metadata column.
    lookup = {_norm(column): column for column in columns}
    return next((lookup[_norm(alias)] for alias in aliases if _norm(alias) in lookup), None)


def _monthly_source_frame(rows: list[dict], table: str) -> pd.DataFrame:
    frame = pd.DataFrame(rows)
    if frame.empty:
        return frame
    columns = list(frame.columns)
    district = _forecast_column(columns, "district_name", "district", "municipality", "region", "province")
    if not district:
        raise SupabaseSourceError(f"Wastewater forecasting requires a district column in '{table}'.")
    frame["_district"] = frame[district].map(lambda value: str(value).strip() if pd.notna(value) else "")
    if frame["_district"].eq("").any():
        raise SupabaseSourceError(f"The wastewater source '{table}' contains an empty district.")
    date_column = _forecast_column(columns, "date", "sample_date", "observation_date", "record_date", "timestamp", "datetime", "measurement_date")
    year_column = _forecast_column(columns, "year", "observation_year", "reporting_year")
    month_column = _forecast_column(columns, "month", "observation_month", "reporting_month")
    if date_column:
        dates = pd.to_datetime(frame[date_column], errors="coerce", utc=True)
        if dates.isna().any():
            raise SupabaseSourceError(f"The wastewater source '{table}' contains an invalid observation date.")
        frame["_period"] = dates.dt.strftime("%Y-%m")
    elif year_column and month_column:
        years = pd.to_numeric(frame[year_column], errors="coerce")
        months = pd.to_numeric(frame[month_column], errors="coerce")
        valid = years.between(1900, 2200) & years.mod(1).eq(0) & months.between(1, 12) & months.mod(1).eq(0)
        if not valid.all():
            raise SupabaseSourceError(f"The wastewater source '{table}' contains an invalid observation year or month.")
        frame["_period"] = years.astype(int).astype(str) + "-" + months.astype(int).astype(str).str.zfill(2)
    else:
        raise SupabaseSourceError(f"Monthly wastewater forecasting requires a date or both year and month in '{table}'.")
    return frame


def _forecast_dataset_value(snapshot: dict, metadata_value: dict, source_rows: dict[str, list[dict]]) -> dict:
    # Keep each source domain separate until it has been reduced to a real
    # district-month measurement. Effluent temperature can never become air temperature.
    frames = {item["kind"]: _monthly_source_frame(source_rows[item["kind"]], item["table"]) for item in snapshot["tables"]}
    metrics, measured = [], []
    for descriptor in metadata_value["indicators"]:
        key = descriptor["key"]
        parts = []
        for kind, field in descriptor["fields"].items():
            frame = frames.get(kind)
            if frame is None or frame.empty:
                continue
            value_column = field.get("value") if isinstance(field, dict) else field
            if value_column not in frame:
                continue
            if isinstance(field, dict):
                parameter_column = field.get("parameter")
                if parameter_column not in frame:
                    continue
                aliases = [_norm(alias) for alias in INDICATORS[key][3]]
                matching = frame[parameter_column].astype(str).map(_norm).map(
                    lambda name: any(name == alias or (len(alias) >= 4 and alias in name) for alias in aliases))
                frame = frame[matching]
            if frame.empty:
                continue
            part = frame[["_district", "_period"]].copy()
            part[key] = pd.to_numeric(frame[value_column].map(_forecast_number), errors="coerce")
            parts.append(part)
        if not parts:
            continue
        values = pd.concat(parts, ignore_index=True)
        if not values[key].notna().any():
            continue
        measured.append(values.groupby(["_district", "_period"])[key].mean())
        metrics.append({name: descriptor[name] for name in ("key", "label", "unit", "category", "fields") if name in descriptor})
    if not measured:
        raise SupabaseSourceError("The wastewater source has no numeric monthly observations available for forecasting.")
    observations = pd.concat(measured, axis=1).reset_index().rename(columns={"_district": "district_name", "_period": "period"})
    observations = observations.sort_values(["district_name", "period"])
    years = sorted(int(value) for value in observations["period"].str[:4].unique())
    return {"source": "Supabase", "source_tables": [item["table"] for item in snapshot["tables"]],
            "regions": sorted(observations["district_name"].unique()), "years": years,
            "default_start": max(years[0], years[-1] - 9), "default_end": years[-1],
            "first_period": str(observations["period"].min()), "last_period": str(observations["period"].max()),
            "metrics": metrics, "frequency": "monthly",
            "observations": json.loads(observations.to_json(orient="records", force_ascii=False, double_precision=15))}


@dashboard_cache("wastewater.forecast-data")
def _forecast_dataset(snapshot: dict, metadata_value: dict) -> dict:
    source_rows = {item["kind"]: _read_table(snapshot["base"], snapshot["key"], item["table"]) for item in snapshot["tables"]}
    return _forecast_dataset_value(snapshot, metadata_value, source_rows)


def _forecast_load() -> dict:
    return _forecast_dataset(_snapshot_live(), _metadata())


def _forecast_source_value(data: dict, region: str, start: int | None, end: int | None) -> dict:
    start = data["default_start"] if start is None else start
    end = data["default_end"] if end is None else end
    if start > end:
        raise HTTPException(400, "The forecast end year must be on or after the start year.")
    if region != "National" and region not in data["regions"]:
        raise HTTPException(400, "Select National or a district available in the wastewater source.")
    frame = pd.DataFrame(data["observations"])
    years = frame["period"].str[:4].astype(int)
    frame = frame[years.between(start, end)]
    if region != "National":
        frame = frame[frame["district_name"] == region]
    if frame.empty:
        raise HTTPException(404, "No monthly wastewater observations are available for the selected district and years.")
    metrics = [item for item in data["metrics"] if frame[item["key"]].notna().any()]
    if not metrics:
        raise HTTPException(404, "No numeric wastewater observations are available for this forecast selection.")
    keys = [item["key"] for item in metrics]
    series = frame.groupby("period", as_index=False)[keys].mean().sort_values("period")
    return {"source": "Supabase", "source_tables": data["source_tables"], "region": region,
            "start": start, "end": end, "frequency": "monthly", "metrics": metrics,
            "first_period": str(series["period"].iloc[0]), "last_period": str(series["period"].iloc[-1]),
            "series": json.loads(series.to_json(orient="records", force_ascii=False, double_precision=15))}


@router.get("/forecast-metadata")
def forecast_metadata():
    try:
        return {key: value for key, value in _forecast_load().items() if key != "observations"}
    except SupabaseSourceError as exc:
        raise HTTPException(502, detail=str(exc)) from exc


@router.get("/forecast-source")
def forecast_source(region: str = "National", start: int | None = None, end: int | None = None):
    if start is not None and end is not None and start > end:
        raise HTTPException(400, "The forecast end year must be on or after the start year.")
    try:
        return _forecast_source_value(_forecast_load(), region, start, end)
    except SupabaseSourceError as exc:
        raise HTTPException(502, detail=str(exc)) from exc
