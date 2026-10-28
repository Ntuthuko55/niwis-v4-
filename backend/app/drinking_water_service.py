"""Source-reported drinking water observations and compliance flags.

The source contains district-month aggregates, not a water supply system
inventory. Compliance percentages below use the supplied observation flags;
they are not an independent SANS assessment or a Blue Drop certification.
"""
from __future__ import annotations

import math
import os
import re
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import quote, urlencode

import pandas as pd
from fastapi import APIRouter, HTTPException

from app.dashboard_loader import dashboard_cache
from app.supabase_source import SupabaseSourceError, _request_page, _settings


router = APIRouter(prefix="/drinking-water", tags=["Drinking water compliance"])
TABLE = "14.1_SANS_241_compliance_master"
PAGE_SIZE = 1000
CAPABILITIES = {
    "system_inventory": False,
    "blue_drop_process": False,
    "sampling_frequency": False,
    "risk_score": False,
}
# Source prefixes are exact, rather than fuzzy matches between different analytes.
INDICATORS = (
    ("turbidity_ntu", "Turbidity", "NTU", "Physical", "Turbidity"),
    ("colour_tcu", "Colour", "TCU", "Physical", "Colour"),
    ("temperature_c", "Temperature", "°C", "Physical", "Temperature"),
    ("ecoli_cfu_100ml", "E. coli", "cfu/100 mL", "Microbiological", "E_coli"),
    ("total_coliforms_cfu_100ml", "Total coliforms", "cfu/100 mL", "Microbiological", "Total_Coliforms"),
    ("ph", "pH", "pH units", "Chemical", "pH"),
    ("electrical_conductivity_ms_m", "Electrical conductivity", "mS/m", "Chemical", "EC"),
    ("free_chlorine_mg_l", "Free chlorine residual", "mg/L", "Chemical", "Free_Chlorine"),
    ("nitrate_mg_l", "Nitrate (as N)", "mg/L", "Chemical", "Nitrate"),
    ("fluoride_mg_l", "Fluoride", "mg/L", "Chemical", "Fluoride"),
    ("arsenic_mg_l", "Arsenic", "mg/L", "Chemical", "Arsenic"),
    ("lead_mg_l", "Lead", "mg/L", "Chemical", "Lead"),
    ("cyanide_mg_l", "Cyanide", "mg/L", "Chemical", "Cyanide"),
    ("total_thms_mg_l", "Total trihalomethanes (THMs)", "mg/L", "Chemical", "Total_THMs"),
)
SOURCE_FIELDS = ("Category", "Parameter", "Limit", "Class", "Source", "Value", "Compliant")
BASE_FIELDS = ("district_name", "shapeID", "year", "month", "SANS_241_Compliance_Score")


def _url(base: str, table: str, params: dict[str, str]) -> str:
    return f"{base}/rest/v1/{quote(table, safe='._')}?{urlencode(params)}"


def _configured_table() -> str:
    name = os.getenv("NIWIS_SUPABASE_TABLE_DRINKING_WATER", TABLE).strip()
    if not re.fullmatch(r"[A-Za-z0-9_.]+", name):
        raise SupabaseSourceError("NIWIS_SUPABASE_TABLE_DRINKING_WATER contains unsupported characters.")
    return name


def _resolve_table(base: str, key: str, configured: str) -> tuple[str, dict]:
    """Only try relation aliases when PostgREST reports a missing relation."""
    candidates = list(dict.fromkeys((configured, configured.replace(".", "_", 1), configured.replace(".", "_"))))
    if "." not in configured and "_" in configured:
        candidates.append(configured.replace("_", ".", 1))
    for index, table in enumerate(candidates):
        try:
            rows, _ = _request_page(_url(base, table, {"select": "*", "limit": "1"}), key, 0, 0)
            if not rows:
                raise SupabaseSourceError(f"The drinking water source '{table}' has no observations.")
            return table, rows[0]
        except SupabaseSourceError as exc:
            if "PGRST205" not in str(exc) or index == len(candidates) - 1:
                raise
    raise SupabaseSourceError("The drinking water relation could not be resolved.")


def _count(content_range: str | None) -> int | None:
    try:
        return int((content_range or "").rsplit("/", 1)[1])
    except (ValueError, IndexError):
        return None


@dashboard_cache("drinking-water.source-rows")
def _read_source(base: str, key: str, configured: str) -> dict:
    table, sample = _resolve_table(base, key, configured)
    required = set(BASE_FIELDS) | {f"{item[4]}_{suffix}" for item in INDICATORS for suffix in SOURCE_FIELDS}
    missing = sorted(required.difference(sample))
    if missing:
        raise SupabaseSourceError("The drinking water source is missing required columns: " + ", ".join(missing) + ".")
    # Project only the dashboard's columns and retain a stable district-month order
    # for every page. No fixed row cap is applied to national coverage.
    observation_fields = set(BASE_FIELDS) | {f"{item[4]}_{suffix}" for item in INDICATORS for suffix in ("Value", "Compliant")}
    fields = [field for field in sample if field in observation_fields]
    url = _url(base, table, {"select": ",".join(fields), "order": "district_name.asc,year.asc,month.asc,shapeID.asc"})
    rows, content_range = _request_page(url, key, 0, PAGE_SIZE - 1, True)
    total = _count(content_range)
    if not rows:
        raise SupabaseSourceError(f"The drinking water source '{table}' has no observations.")
    page_size = len(rows)
    if total is not None:
        offsets = list(range(page_size, total, page_size))
        if offsets:
            with ThreadPoolExecutor(max_workers=min(6, len(offsets))) as pool:
                pages = list(pool.map(lambda offset: _request_page(url, key, offset, min(total - 1, offset + page_size - 1))[0], offsets))
            for offset, page in zip(offsets, pages):
                if len(page) != min(page_size, total - offset):
                    raise SupabaseSourceError("The drinking water source changed or returned an incomplete page. Please retry the request.")
                rows.extend(page)
        if len(rows) != total:
            raise SupabaseSourceError("The drinking water source returned an incomplete national dataset.")
    else:
        # PostgREST can omit exact counts. Continue until the next page is empty;
        # a short server page is not itself proof that the dataset is complete.
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
    return {"table": table, "sample": sample, "rows": rows}


def _load_source() -> dict:
    base, key, _ = _settings()
    return _read_source(base, key, _configured_table())


def _limit_bounds(text: str | None) -> tuple[float | None, float | None]:
    """Read only a leading rule, so '0 cfu/100 mL' never becomes 0-100."""
    raw = str(text or "").strip().replace("−", "-")
    number = r"([+-]?(?:\d+(?:\.\d*)?|\.\d+))"
    ranged = re.match(rf"^{number}\s*(?:–|—|-|\bto\b)\s*{number}(?:\s|$)", raw, re.IGNORECASE)
    if ranged:
        return float(ranged[1]), float(ranged[2])
    upper = re.match(rf"^(?:≤|<=|<)\s*{number}", raw)
    if upper:
        return None, float(upper[1])
    lower = re.match(rf"^(?:≥|>=|>)\s*{number}", raw)
    if lower:
        return float(lower[1]), None
    zero = re.match(r"^0(?:\.0+)?(?:\s|$)", raw)
    return (0.0, 0.0) if zero else (None, None)


def _text(value) -> str | None:
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return None
    text = str(value).strip()
    return text or None


def _descriptors(sample: dict) -> list[dict]:
    result = []
    for key, label, unit, category, prefix in INDICATORS:
        fields = {suffix.lower(): f"{prefix}_{suffix}" for suffix in SOURCE_FIELDS}
        limit = _text(sample.get(fields["limit"]))
        minimum, maximum = _limit_bounds(limit)
        result.append({"key": key, "label": label, "unit": unit, "category": category,
                       "class": _text(sample.get(fields["class"])), "limit": limit,
                       "min": minimum, "max": maximum, "source": _text(sample.get(fields["source"])),
                       "fields": fields, "threshold_provenance": "source_table"})
    return result


def _number(value):
    if value is None or isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return number if math.isfinite(number) else None


def _flag(value):
    if value is True or value == "true" or value == "True":
        return 1.0
    if value is False or value == "false" or value == "False":
        return 0.0
    return None


def _frame(rows: list[dict], descriptors: list[dict]) -> pd.DataFrame:
    source = pd.DataFrame(rows)
    frame = pd.DataFrame(index=source.index)
    frame["district_name"] = source["district_name"].map(_text)
    frame["shapeID"] = source["shapeID"].map(_text)
    years = pd.to_numeric(source["year"], errors="coerce")
    months = pd.to_numeric(source["month"], errors="coerce")
    valid_dates = years.between(1900, 2200) & years.mod(1).eq(0) & months.between(1, 12) & months.mod(1).eq(0)
    if not valid_dates.all() or frame["district_name"].isna().any() or frame["shapeID"].isna().any():
        raise SupabaseSourceError("The drinking water source contains an invalid district, map identifier, year or month.")
    frame["year"] = years.astype(int)
    frame["period"] = years.astype(int).astype(str) + "-" + months.astype(int).astype(str).str.zfill(2)
    frame["compliance_score"] = source["SANS_241_Compliance_Score"].map(_number)
    for descriptor in descriptors:
        key = descriptor["key"]
        frame[key] = source[descriptor["fields"]["value"]].map(_number)
        flags = source[descriptor["fields"]["compliant"]].map(_flag)
        # Unknown flags and nonfinite/missing values are unassessed, not failed.
        frame[f"{key}_pass_pct"] = flags.where(frame[key].notna()) * 100.0
        frame[f"{key}_flag_missing"] = flags.isna()
    return frame


def _mean(series: pd.Series) -> float | None:
    return _number(series.mean()) if not series.empty else None


def _period_values(frame: pd.DataFrame, descriptors: list[dict]) -> pd.DataFrame:
    keys = [item["key"] for item in descriptors]
    rates = [f"{key}_pass_pct" for key in keys]
    # Averaging within each district-month before national aggregation prevents
    # repeated rows for one district from giving that district extra weight.
    district = frame.groupby(["district_name", "shapeID", "year", "period"], as_index=False)[["compliance_score", *keys, *rates]].mean()
    for name, matching in (("health_pass_pct", [item for item in descriptors if str(item["class"]).lower() == "health"]),
                           ("microbial_pass_pct", [item for item in descriptors if item["category"] == "Microbiological"])):
        fields = [f"{item['key']}_pass_pct" for item in matching]
        district[name] = district[fields].mean(axis=1) if fields else float("nan")
    return district


def _records(frame: pd.DataFrame, *, precision: int = 10) -> list[dict]:
    # pandas converts NaN and NumPy scalars to strict JSON null/native scalars.
    import json
    return json.loads(frame.to_json(orient="records", force_ascii=False, double_precision=precision))


def _type(value) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, int):
        return "integer"
    if isinstance(value, float):
        return "number"
    return "string"


@router.get("/metadata")
def metadata():
    try:
        source = _load_source()
        indicators = _descriptors(source["sample"])
        frame = _frame(source["rows"], indicators)
        years = sorted(int(value) for value in frame["year"].unique())
        return {"source": "Supabase", "source_table": source["table"],
                "columns": [{"name": key, "type": _type(value)} for key, value in source["sample"].items()],
                "rows": len(frame), "regions": sorted(frame["district_name"].unique()), "years": years,
                "default_start": max(years[0], years[-1] - 9), "default_end": years[-1],
                "first_period": frame["period"].min(), "last_period": frame["period"].max(),
                "indicators": indicators, "capabilities": dict(CAPABILITIES),
                "compliance_basis": "Source-reported limits and observation flags; not independent SANS certification.",
                "aggregation": "District-month means; national months give each district equal weight. Annual values first average each district's available months, then give districts equal weight.",
                "coverage_level": "district-month", "systems": None}
    except SupabaseSourceError as exc:
        raise HTTPException(502, detail=str(exc)) from exc


def _dashboard_value(source: dict, region: str, start: int | None, end: int | None) -> dict:
    descriptors = _descriptors(source["sample"])
    frame = _frame(source["rows"], descriptors)
    regions = sorted(frame["district_name"].unique())
    first_year, last_year = int(frame["year"].min()), int(frame["year"].max())
    start = max(first_year, last_year - 9) if start is None else start
    end = last_year if end is None else end
    if start > end:
        raise HTTPException(400, "The end year must be on or after the start year.")
    if region != "National" and region not in regions:
        raise HTTPException(400, "Select National or a district available in the drinking water source.")
    window = frame[frame["year"].between(start, end)].copy()
    selected = window if region == "National" else window[window["district_name"] == region].copy()
    if selected.empty:
        raise HTTPException(404, "No drinking water observations are available for the selected district and years.")
    selected_periods = _period_values(selected, descriptors)
    all_periods = selected_periods if region == "National" else _period_values(window, descriptors)
    keys = [item["key"] for item in descriptors]
    rates = [f"{key}_pass_pct" for key in keys]
    aggregates = ["compliance_score", "health_pass_pct", "microbial_pass_pct", *keys, *rates]
    monthly = selected_periods.groupby("period", as_index=False)[aggregates].mean()
    district_annual = selected_periods.groupby(["district_name", "year"], as_index=False)[aggregates].mean()
    annual = district_annual.groupby("year", as_index=False)[aggregates].mean()
    failures = selected[rates].eq(0)
    counts = selected[["district_name", "year", "period"]].copy()
    counts["failed_checks"] = failures.sum(axis=1)
    counts["flagged"] = failures.any(axis=1)
    for grouping, summary in (("period", monthly), ("year", annual)):
        count_summary = counts.groupby(grouping)["failed_checks"].sum()
        flagged_summary = counts[counts["flagged"]].groupby(grouping)["district_name"].nunique()
        summary["failed_checks"] = summary[grouping].map(count_summary).fillna(0).astype(int)
        summary["flagged_districts"] = summary[grouping].map(flagged_summary).fillna(0).astype(int)
    latest_period = str(selected["period"].max())
    latest_rows = selected[selected["period"] == latest_period]
    latest = _records(monthly[monthly["period"] == latest_period])[0]
    map_rows = all_periods.sort_values(["period", "district_name"]).groupby("district_name", as_index=False).tail(1)
    map_by_name = {item["district_name"]: item for item in _records(map_rows[["district_name", "shapeID", "period", *aggregates]])}
    # Keep the national map frame even if a district has no values in this window.
    district_shapes = frame.sort_values("period").drop_duplicates("district_name", keep="last")
    national_map = [map_by_name.get(item.district_name, {"district_name": item.district_name, "shapeID": item.shapeID, "period": None, **dict.fromkeys(aggregates)})
                    for item in district_shapes[["district_name", "shapeID"]].sort_values("district_name").itertuples(index=False)]
    parameter_compliance, alerts = [], []
    assessed = passed = missing_values = missing_flags = 0
    for descriptor in descriptors:
        key, rate = descriptor["key"], f"{descriptor['key']}_pass_pct"
        known = selected[rate].notna()
        count = int(known.sum())
        pass_count = int(selected.loc[known, rate].eq(100).sum())
        assessed += count
        passed += pass_count
        missing_values += int(selected[key].isna().sum())
        missing_flags += int(selected[f"{key}_flag_missing"].sum())
        parameter_compliance.append({"key": key, "label": descriptor["label"], "category": descriptor["category"],
                                     "unit": descriptor["unit"], "limit": descriptor["limit"], "class": descriptor["class"],
                                     "passed": pass_count, "failed": count - pass_count, "assessed": count,
                                     "pass_pct": 100.0 * pass_count / count if count else None,
                                     "latest_value": latest.get(key), "latest_pass_pct": _mean(latest_rows[rate])})
        failing = latest_rows[latest_rows[rate].eq(0)]
        for row in failing.to_dict("records"):
            alerts.append({"district_name": row["district_name"], "period": row["period"], "key": key,
                           "label": descriptor["label"], "value": _number(row[key]), "unit": descriptor["unit"],
                           "limit": descriptor["limit"], "class": descriptor["class"], "category": descriptor["category"]})
    alerts.sort(key=lambda item: (0 if str(item["class"]).lower() == "health" else 1,
                                  0 if item["category"] == "Microbiological" else 1,
                                  item["district_name"], item["label"]))
    return {"source": "Supabase", "source_table": source["table"], "region": region, "start": start, "end": end,
            "latest_period": latest_period, "series": _records(annual), "monthly": _records(monthly), "latest": latest,
            "map": national_map, "parameter_compliance": parameter_compliance, "alerts": alerts[:20],
            "indicators": descriptors, "capabilities": dict(CAPABILITIES),
            "coverage": {"districts": len(regions), "selected_districts": int(selected["district_name"].nunique()),
                         "source_rows": len(frame), "selected_rows": len(selected), "assessed": assessed,
                         "passed": passed, "failed": assessed - passed, "latest_failed_checks": len(alerts),
                         "latest_flagged_districts": len({item["district_name"] for item in alerts}),
                         "systems": None, "first_period": str(selected["period"].min()), "last_period": latest_period,
                         "missing_values": missing_values, "missing_flags": missing_flags},
            "compliance_basis": "Source-reported limits and observation flags; not independent SANS certification."}


@router.get("/dashboard")
def dashboard(region: str = "National", start: int | None = None, end: int | None = None):
    try:
        return _dashboard_value(_load_source(), region, start, end)
    except SupabaseSourceError as exc:
        raise HTTPException(502, detail=str(exc)) from exc


def _forecast_dataset_value(source: dict) -> dict:
    descriptors = _descriptors(source["sample"])
    frame = _frame(source["rows"], descriptors)
    metrics = [{**item} for item in descriptors if frame[item["key"]].notna().any()]
    if frame["compliance_score"].notna().any():
        metrics.append({"key": "compliance_score", "label": "Reported compliance score", "unit": "%",
                        "category": "Reported compliance", "source": source["table"],
                        "fields": {"value": "SANS_241_Compliance_Score"}})
    if not metrics:
        raise SupabaseSourceError("The drinking water source has no numeric observations available for forecasting.")
    keys = [item["key"] for item in metrics]
    district_months = frame.groupby(["district_name", "period"], as_index=False)[keys].mean()
    years = sorted(int(value) for value in frame["year"].unique())
    return {"source": "Supabase", "source_tables": [source["table"]],
            "regions": sorted(frame["district_name"].unique()), "years": years,
            "default_start": max(years[0], years[-1] - 9), "default_end": years[-1],
            "first_period": str(frame["period"].min()), "last_period": str(frame["period"].max()),
            "metrics": metrics, "frequency": "monthly", "observations": _records(district_months, precision=15)}


@dashboard_cache("drinking-water.forecast-data")
def _forecast_dataset(base: str, key: str, configured: str) -> dict:
    # This shares the same successful source cache as the main dashboard.
    return _forecast_dataset_value(_read_source(base, key, configured))


def _forecast_load() -> dict:
    base, key, _ = _settings()
    return _forecast_dataset(base, key, _configured_table())


def _forecast_source_value(data: dict, region: str, start: int | None, end: int | None) -> dict:
    start = data["default_start"] if start is None else start
    end = data["default_end"] if end is None else end
    if start > end:
        raise HTTPException(400, "The forecast end year must be on or after the start year.")
    if region != "National" and region not in data["regions"]:
        raise HTTPException(400, "Select National or a district available in the drinking water source.")
    frame = pd.DataFrame(data["observations"])
    years = frame["period"].str[:4].astype(int)
    frame = frame[years.between(start, end)]
    if region != "National":
        frame = frame[frame["district_name"] == region]
    if frame.empty:
        raise HTTPException(404, "No monthly drinking water observations are available for the selected district and years.")
    metrics = [item for item in data["metrics"] if frame[item["key"]].notna().any()]
    if not metrics:
        raise HTTPException(404, "No numeric drinking water observations are available for this forecast selection.")
    keys = [item["key"] for item in metrics]
    # Each row is already one district-month. National months therefore give
    # districts equal weight and keep all measurements in their source units.
    series = frame.groupby("period", as_index=False)[keys].mean().sort_values("period")
    return {"source": "Supabase", "source_tables": data["source_tables"], "region": region,
            "start": start, "end": end, "frequency": "monthly", "metrics": metrics,
            "first_period": str(series["period"].iloc[0]), "last_period": str(series["period"].iloc[-1]),
            "series": _records(series, precision=15)}


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
