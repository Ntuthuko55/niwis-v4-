"""Section 15 RWQO observations, supplied targets and reported assessment flags.

District-month aggregates cannot establish compliance for an individual resource
reach. Ecological measurements have no source assessment flags or target limits.
"""
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

router = APIRouter(prefix="/rwqo", tags=["Resource Water Quality Objectives"])
TABLES = (
    ("ecological", "15.1_ecological_variables_master", "Ecological variables"),
    ("chemical", "15.2_chemical_RWQO_variables_master", "Chemical objectives"),
    ("hydrological", "15.3_hydrological_RWQO_variables_master", "Hydrological objectives"),
)
# key, label, unit, exact source column, objective prefix, reference agency
METRICS = {
    "ecological": (
        ("sass5_score", "SASS5 score", "score", "sass5_score", None, "DWS / WRC"),
        ("aspt", "Average Score per Taxon (ASPT)", "score", "aspt", None, "DWS"),
        ("fibi", "Fish Index of Biotic Integrity (FIBI)", "score", "fibi", None, "SANBI / DWS"),
        ("riparian_vegetation", "Riparian vegetation condition", "source index", "riparian_vegetation", None, "SANBI"),
        ("aquatic_habitat_integrity", "Aquatic habitat integrity", "source index", "aquatic_habitat_integrity", None, "DWS"),
        ("ecological_reserve_q", "Ecological Reserve (Q-value)", "m³/s", "ecological_reserve_q", None, "DWS / DWAF"),
    ),
    "chemical": (
        ("dissolved_oxygen", "Dissolved oxygen", "mg/L", "DO_Value", "DO", "DWS"),
        ("ph", "pH", "pH units", "pH_Range_Value", "pH_Range", "DWS"),
        ("conductivity", "Conductivity", "mS/m", "EC_Target_Value", "EC_Target", "DWS"),
        ("total_nitrogen", "Total nitrogen (source TN)", "mg/L", "Nutrient_Value_TN", "Nutrient", "DWS"),
        ("total_phosphorus", "Total phosphorus", "mg/L", "Nutrient_Value_TP", "Nutrient", "DWS"),
        ("toxicants", "Toxicants (source aggregate)", "µg/L", "Toxicant_Value_ugL", "Toxicant", "DWS / CSIR"),
        ("salinity_tds", "Salinity (TDS)", "mg/L", "Salinity_Value_TDS", "Salinity", "DWS"),
    ),
    "hydrological": (
        ("low_flow", "Ecological flow (low flow)", "m³/s", "Low_Flow_Value", "Low_Flow", "DWS"),
        ("high_flow", "Ecological flow (high flow)", "m³/s", "High_Flow_Value", "High_Flow", "DWS"),
        ("seasonality", "Flow seasonality", "index", "Seasonality_Value", "Seasonality", "DWS"),
        ("dilution_flow", "Dilution flow", "m³/s", "Dilution_Value", "Dilution", "DWS / derived"),
        ("assimilation_capacity", "Assimilation capacity", "%", "Assimilation_Value", "Assimilation", "DWS"),
    ),
}
SCORES = {"chemical": "RWQO_Compliance_Score", "hydrological": "Hydrological_RWQO_Score"}
BASE_FIELDS = ("district_name", "shapeID", "year", "month")
PAGE_SIZE = 1000


def _configured_tables():
    raw = os.getenv("NIWIS_SUPABASE_TABLES_MODULE_15", "").strip()
    names = tuple(part.strip() for part in raw.split(",")) if raw else tuple(item[1] for item in TABLES)
    if len(names) != 3 or any(not re.fullmatch(r"[A-Za-z0-9_. ]+", name) for name in names):
        raise SupabaseSourceError("NIWIS_SUPABASE_TABLES_MODULE_15 requires three relation names in ecological, chemical, hydrological order.")
    return names


def _url(base, table, params):
    return f"{base}/rest/v1/{quote(table, safe='._')}?{urlencode(params)}"


def _count(value):
    try:
        return int((value or "").rsplit("/", 1)[1])
    except (ValueError, IndexError):
        return None


@dashboard_cache("rwqo.source-rows")
def _read_table(base, key, table, kind):
    sample, _ = _request_page(_url(base, table, {"select": "*", "limit": "1"}), key, 0, 0)
    if not sample:
        raise SupabaseSourceError(f"RWQO relation '{table}' has no observations.")
    fields = list(BASE_FIELDS) + [item[3] for item in METRICS[kind]]
    for prefix in dict.fromkeys(item[4] for item in METRICS[kind] if item[4]):
        fields.extend(f"{prefix}_{suffix}" for suffix in ("Compliant", "Limit", "Source"))
    if kind in SCORES:
        fields.append(SCORES[kind])
    missing = set(fields).difference(sample[0])
    if missing:
        raise SupabaseSourceError(f"RWQO relation '{table}' is missing required columns: {', '.join(sorted(missing))}.")
    url = _url(base, table, {"select": ",".join(fields), "order": "district_name.asc,year.asc,month.asc,shapeID.asc"})
    rows, content_range = _request_page(url, key, 0, PAGE_SIZE - 1, True)
    total = _count(content_range)
    if not rows:
        raise SupabaseSourceError(f"RWQO relation '{table}' returned no data during pagination.")
    if total is not None:
        size = len(rows)
        offsets = list(range(size, total, size))
        if offsets:
            with ThreadPoolExecutor(max_workers=min(6, len(offsets))) as pool:
                pages = list(pool.map(lambda offset: _request_page(url, key, offset, min(total - 1, offset + size - 1))[0], offsets))
            for offset, page in zip(offsets, pages):
                if len(page) != min(size, total - offset):
                    raise SupabaseSourceError(f"RWQO relation '{table}' returned an incomplete page. Please retry.")
                rows.extend(page)
        if len(rows) != total:
            raise SupabaseSourceError(f"RWQO relation '{table}' returned an incomplete dataset.")
    else:
        while True:
            try:
                page, _ = _request_page(url, key, len(rows), len(rows) + PAGE_SIZE - 1)
            except SupabaseSourceError as exc:
                if "HTTP 416" in str(exc) and "PGRST103" in str(exc):
                    break
                raise
            if not page:
                break
            rows.extend(page)
    return rows


def _number(value):
    if value is None or isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return number if math.isfinite(number) else None


def _flag(value):
    if value is True or isinstance(value, str) and value.lower() == "true":
        return 100.0
    if value is False or isinstance(value, str) and value.lower() == "false":
        return 0.0
    return None


def _bounds(text):
    number = r"([+-]?(?:\d+(?:\.\d*)?|\.\d+))"
    ranged = re.fullmatch(rf"\s*{number}\s*[-–—]\s*{number}\s*", text)
    if ranged:
        return float(ranged[1]), float(ranged[2])
    # A compound nutrient rule requires analyte-specific metadata. Never map
    # the DIN limit onto the source TN column or turn it into a single bound.
    if len(re.findall(number, text)) != 1:
        return None, None
    rule = re.search(rf"(>=|<=|≥|≤)\s*{number}", text)
    if rule:
        value = float(rule[2])
        return (value, None) if rule[1] in (">=", "≥") else (None, value)
    return None, None


def _records(frame):
    return json.loads(frame.to_json(orient="records", double_precision=15))


def _prepare(rows, kind, table):
    raw = pd.DataFrame(rows)
    frame = raw[list(BASE_FIELDS)].copy()
    years = pd.to_numeric(frame["year"], errors="coerce")
    months = pd.to_numeric(frame["month"], errors="coerce")
    valid = (years.between(1900, 2200) & years.mod(1).eq(0) & months.between(1, 12) & months.mod(1).eq(0))
    identifiers = frame[["district_name", "shapeID"]].apply(lambda column: column.map(lambda value: isinstance(value, str) and bool(value.strip())))
    if not valid.all() or not identifiers.all().all():
        raise SupabaseSourceError(f"RWQO relation '{table}' contains invalid district identifiers or observation months.")
    frame["year"] = years.astype(int)
    frame["period"] = years.astype(int).astype(str) + "-" + months.astype(int).astype(str).str.zfill(2)
    if frame.duplicated(["district_name", "period"]).any():
        raise SupabaseSourceError(f"RWQO relation '{table}' contains duplicate district-month records; aggregation stopped to avoid double counting.")
    descriptors, objectives = [], []
    for key, label, unit, field, prefix, agency in METRICS[kind]:
        frame[key] = raw[field].map(_number).astype(float)
        limits = sorted(set(str(value).strip() for value in raw[f"{prefix}_Limit"].dropna() if str(value).strip())) if prefix else []
        agencies = sorted(set(str(value).strip() for value in raw[f"{prefix}_Source"].dropna() if str(value).strip())) if prefix else []
        minimum, maximum = _bounds(limits[0]) if len(limits) == 1 and prefix != "Nutrient" else (None, None)
        descriptors.append({"key": key, "label": label, "unit": unit, "category": kind,
                            "source_column": field, "objective": prefix, "source": "; ".join(agencies) or agency,
                            "source_basis": "source_table" if agencies else "requirements_reference",
                            "limit": limits[0] if len(limits) == 1 else "Multiple source targets" if limits else None,
                            "limits": limits, "min": minimum, "max": maximum})
    for prefix in dict.fromkeys(item[4] for item in METRICS[kind] if item[4]):
        members = [item for item in descriptors if item["objective"] == prefix]
        flag = raw[f"{prefix}_Compliant"].map(_flag).astype(float)
        frame[f"{prefix}_pass_pct"] = flag.where(frame[[item["key"] for item in members]].notna().all(axis=1))
        frame[f"{prefix}_limit"] = raw[f"{prefix}_Limit"]
        objectives.append({"key": prefix, "label": "Nutrient objectives (shared TN/TP flag)" if prefix == "Nutrient" else members[0]["label"],
                           "metrics": [item["key"] for item in members], "limit": members[0]["limit"]})
    if kind in SCORES:
        frame["reported_score"] = raw[SCORES[kind]].map(_number).astype(float)
    first, last = str(frame.period.min()), str(frame.period.max())
    expected = len(pd.period_range(first, last, freq="M")) * int(frame.district_name.nunique())
    keys = [item["key"] for item in descriptors]
    audit = {"table": table, "kind": kind, "rows": len(frame), "districts": int(frame.district_name.nunique()),
             "first_period": first, "last_period": last, "duplicate_district_months": 0,
             "missing_district_months": expected - len(frame), "missing_values": int(frame[keys].isna().sum().sum()),
             "negative_measurements": int(frame[keys].lt(0).sum().sum()),
             "metrics": len(keys), "objectives_with_flags": len(objectives),
             "columns": list(raw.columns), "measurement_ranges": [{"key": key, "min": _number(frame[key].min()),
                 "max": _number(frame[key].max()), "missing": int(frame[key].isna().sum()),
                 "negative_values": int(frame[key].lt(0).sum()),
                 "distinct_values": int(frame[key].nunique())} for key in keys]}
    return {"frame": frame, "indicators": descriptors, "objectives": objectives, "audit": audit}


@dashboard_cache("rwqo.prepared")
def _snapshot(base, key, names):
    def load(item):
        index, (kind, _, _) = item
        return kind, _prepare(_read_table(base, key, names[index], kind), kind, names[index])
    with ThreadPoolExecutor(max_workers=3) as pool:
        return dict(pool.map(load, enumerate(TABLES)))


def _load():
    base, key, _ = _settings()
    return _snapshot(base, key, _configured_tables())


def _metadata(data):
    years = sorted({int(year) for section in data.values() for year in section["frame"].year.unique()})
    regions = sorted({district for section in data.values() for district in section["frame"].district_name.unique()})
    return {"source": "Supabase", "source_tables": [data[kind]["audit"]["table"] for kind, _, _ in TABLES],
            "regions": regions, "years": years, "default_start": max(years[0], years[-1] - 9), "default_end": years[-1],
            "cache_ttl_seconds": dashboard_cache_ttl(), "coverage_level": "district-month",
            "sections": [{"key": kind, "label": label, "indicators": data[kind]["indicators"],
                          "objectives": data[kind]["objectives"], "audit": data[kind]["audit"]} for kind, _, label in TABLES],
            "warnings": ["These are district-month aggregates. Resource reach, dam, wetland and aquifer identifiers and gazetted objective metadata are not supplied.",
                         "Ecological targets and assessment flags are not supplied; ecological measurements are shown without a compliance grade.",
                         "The nutrient rule refers to DIN, but the source nitrogen column is TN. The stored shared nutrient flag is preserved; TN is not independently assessed against DIN.",
                         "Source values, units, targets and flags are preserved. Reported scores are separate from percentages calculated from assessed flags."]}


def _aggregate(frame, columns):
    monthly = frame.groupby("period")[columns].mean()
    if not frame.empty:
        periods = pd.period_range(frame.period.min(), frame.period.max(), freq="M").astype(str)
        monthly = monthly.reindex(periods).rename_axis("period")
    annual = frame.groupby(["district_name", "year"])[columns].mean().groupby("year").mean()
    if not annual.empty:
        annual = annual.reindex(range(int(frame.year.min()), int(frame.year.max()) + 1)).rename_axis("year")
    return _records(monthly.reset_index()), _records(annual.reset_index())


def _section_value(section, region, start, end):
    frame = section["frame"]
    window = frame[frame.year.between(start, end)]
    selected = window if region == "National" else window[window.district_name == region]
    metrics, objectives = section["indicators"], section["objectives"]
    keys = [item["key"] for item in metrics]
    rates = [f"{item['key']}_pass_pct" for item in objectives]
    columns = keys + rates + (["reported_score"] if "reported_score" in frame else [])
    monthly, annual = _aggregate(selected, columns)
    latest_period = str(selected.period.max()) if not selected.empty else None
    latest = next((row for row in reversed(monthly) if row["period"] == latest_period), {})
    map_period = str(window.period.max()) if not window.empty else None
    map_source = window[window.period == map_period]
    by_name = {row["district_name"]: row for row in _records(map_source[["district_name", "shapeID", "period", *columns]])}
    shapes = frame.sort_values("period").drop_duplicates("district_name", keep="last")
    mapped = [by_name.get(row.district_name, {"district_name": row.district_name, "shapeID": row.shapeID, "period": None,
                 **dict.fromkeys(columns)}) for row in shapes.sort_values("district_name").itertuples()]
    compliance, alerts = [], []
    latest_rows = selected[selected.period == latest_period]
    for objective in objectives:
        rate = f"{objective['key']}_pass_pct"
        assessed, passed = int(selected[rate].notna().sum()), int(selected[rate].eq(100).sum())
        compliance.append({**objective, "assessed": assessed, "passed": passed, "failed": assessed - passed,
                           "pass_pct": 100 * passed / assessed if assessed else None})
        for row in latest_rows[latest_rows[rate].eq(0)].to_dict("records"):
            alerts.append({"district_name": row["district_name"], "period": row["period"], "objective": objective["key"],
                           "label": objective["label"], "limit": row[f"{objective['key']}_limit"],
                           "values": [{"label": metric["label"], "value": _number(row[metric["key"]]), "unit": metric["unit"]}
                                      for metric in metrics if metric["key"] in objective["metrics"]]})
    return {"monthly": monthly, "series": annual, "latest": latest, "latest_period": latest_period,
            "map": mapped, "map_period": map_period, "compliance": compliance, "alerts": alerts,
            "coverage": {"selected_rows": len(selected), "selected_districts": int(selected.district_name.nunique()),
                         "missing_values": int(selected[keys].isna().sum().sum()),
                         "assessed": sum(row["assessed"] for row in compliance), "passed": sum(row["passed"] for row in compliance),
                         "failed": sum(row["failed"] for row in compliance),
                         "latest_flagged_districts": len({row["district_name"] for row in alerts})}}


def _selection(data, region, start, end):
    meta = _metadata(data)
    start = meta["default_start"] if start is None else start
    end = meta["default_end"] if end is None else end
    if start > end:
        raise HTTPException(400, "The end year must be on or after the start year.")
    if region != "National" and region not in meta["regions"]:
        raise HTTPException(400, "Select National or a district available in the RWQO source.")
    if not any(((section["frame"].year.between(start, end)) & ((section["frame"].district_name == region) if region != "National" else True)).any() for section in data.values()):
        raise HTTPException(404, "No RWQO observations are available for the selected district and years.")
    return start, end


def _dashboard_value(data, region="National", start=None, end=None):
    start, end = _selection(data, region, start, end)
    return {"source": "Supabase", "region": region, "start": start, "end": end,
            "sections": {kind: _section_value(section, region, start, end) for kind, section in data.items()}}


@router.get("/metadata")
def metadata():
    try:
        return _metadata(_load())
    except SupabaseSourceError as exc:
        raise HTTPException(502, str(exc)) from exc


@router.get("/dashboard")
def dashboard(region: str = "National", start: int | None = None, end: int | None = None):
    try:
        return _dashboard_value(_load(), region, start, end)
    except SupabaseSourceError as exc:
        raise HTTPException(502, str(exc)) from exc


@router.get("/forecast-metadata")
def forecast_metadata():
    try:
        meta = _metadata(_load())
        return {**{key: meta[key] for key in ("source", "source_tables", "regions", "years", "default_start", "default_end")},
                "frequency": "monthly", "metrics": [item for section in meta["sections"] for item in section["indicators"]]}
    except SupabaseSourceError as exc:
        raise HTTPException(502, str(exc)) from exc


@router.get("/forecast-source")
def forecast_source(region: str = "National", start: int | None = None, end: int | None = None):
    try:
        data = _load()
        start, end = _selection(data, region, start, end)
        # Each table has a validated unique district-month key. Keep an outer
        # union of months; an absent measurement must remain a missing input.
        frames, metrics = [], []
        for section in data.values():
            selected = section["frame"]
            selected = selected[selected.year.between(start, end)]
            if region != "National":
                selected = selected[selected.district_name == region]
            available = [item for item in section["indicators"] if selected[item["key"]].notna().any()]
            keys = [item["key"] for item in available]
            metrics.extend(available)
            frames.append(selected.groupby("period")[keys].mean())
        series = pd.concat(frames, axis=1).sort_index()
        series = series.reindex(pd.period_range(series.index.min(), series.index.max(), freq="M").astype(str)).rename_axis("period")
        return {"source": "Supabase", "source_tables": [section["audit"]["table"] for section in data.values()],
                "region": region, "start": start, "end": end, "frequency": "monthly", "metrics": metrics,
                "series": _records(series.reset_index())}
    except SupabaseSourceError as exc:
        raise HTTPException(502, str(exc)) from exc
