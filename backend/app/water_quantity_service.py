"""Monthly section 17 transfer rates and independently scoped national balances.

The supplied tables do not contain daily observations, scheme topology or a
documented balance method. Preserve their values and expose calculation checks.
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

router = APIRouter(prefix="/water-quantity", tags=["Water Quantity Assessment"])
TABLES = ("17_1_water_quantity_assessment_transfers_master", "17_2_national_water_balance_master")
TRANSFER_METRICS = (
    ("katse_vaal", "Katse to Vaal transfer", "m³/day", "Katse_to_Vaal_Daily_Transfer_m3_day", "Transfer rates", "LHDA / DWS"),
    ("tugela_vaal", "Tugela–Vaal transfer (source column)", "m³/day", "Tugela_Vaal_Daily_Transfer_m3_day", "Transfer rates", "DWS / Eskom"),
    ("orange_transfer", "Orange River system transfer", "m³/day", "Orange_River_System_Transfer_m3_day", "Transfer rates", "DWS"),
    ("thukela_vaal", "Thukela–Vaal emergency / regular (source column)", "m³/day", "Thukela_Vaal_Emergency_Regular_Transfer_m3_day", "Transfer rates", "DWS"),
    ("transfer_loss", "Seepage & evaporation loss", "m³/day", "Transfer_Loss_Seepage_Evaporation_m3_day", "Transfer operations", "DWS"),
    ("pumping_energy", "Transfer pumping energy intensity", "kWh/ML", "Transfer_Pumping_Energy_kWh_Ml", "Transfer operations", "DWS / Eskom"),
    ("donor_storage", "Donor basin storage", "% FSC", "Donor_Basin_Storage_FSC_pct", "Basin conditions", "DWS"),
    ("receiving_deficit", "Receiving system demand deficit", "m³/day", "Receiving_System_Demand_Deficit_m3_day", "Basin conditions", "DWS"),
)
BALANCE_METRICS = (
    ("map_volume", "Precipitation (MAP)", "Mm³", "MAP_Mm3", "Source water components", "SAWS"),
    ("aet_volume", "Actual evapotranspiration (AET)", "Mm³", "AET_Mm3", "Source water components", "Modelled"),
    ("runoff_volume", "Runoff (MAR)", "Mm³", "MAR_Mm3", "Source water components", "DWS"),
    ("recharge_volume", "Groundwater recharge", "Mm³", "Groundwater_Recharge_Mm3", "Source water components", "DWS / WRC"),
    ("surface_storage", "Surface storage", "Mm³", "Surface_Storage_Mm3", "Storage stock", "DWS"),
    ("net_ibt", "Reported net inter-basin transfers", "Mm³", "Net_IBT_Mm3", "Source water components", "DWS / TCTA"),
    ("municipal_volume", "Municipal demand", "Mm³", "Municipal_Demand_Mm3", "Demand & Reserve", "DWS"),
    ("agricultural_volume", "Agricultural demand", "Mm³", "Agricultural_Demand_Mm3", "Demand & Reserve", "DWS / NDA"),
    ("industrial_volume", "Industrial demand", "Mm³", "Industrial_Demand_Mm3", "Demand & Reserve", "DTI / DWS"),
    ("environmental_reserve", "Environmental Reserve", "Mm³", "Environmental_Reserve_Mm3", "Demand & Reserve", "DWS"),
    ("reported_demand", "Reported total demand (includes Reserve)", "Mm³", "Total_Demand_Mm3", "Reported summaries", "Not specified in table"),
    ("reported_balance", "Reported net water balance", "Mm³", "Net_Water_Balance_Mm3", "Reported summaries", "Not specified in table"),
)
ROUTE_KEYS = tuple(item[0] for item in TRANSFER_METRICS[:4])
TRANSFER_PREFIX = "Transfers: "
TRANSFER_MEAN = "Source district mean"
BALANCE_FORMULA = "MAP - AET - MAR - groundwater recharge + net IBT - total demand"
DEMAND_FORMULA = "Municipal demand + agricultural demand + industrial demand + Environmental Reserve"


def _configured_tables():
    raw = os.getenv("NIWIS_SUPABASE_TABLES_MODULE_17", "").strip()
    names = tuple(part.strip() for part in raw.split(",")) if raw else TABLES
    if len(names) != 2 or any(not re.fullmatch(r"[A-Za-z0-9_. ]+", name) for name in names):
        raise SupabaseSourceError("NIWIS_SUPABASE_TABLES_MODULE_17 requires transfer and national-balance relation names in that order.")
    return names


def _number(value):
    if value is None or isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (ValueError, TypeError, OverflowError):
        return None
    return number if math.isfinite(number) else None


def _records(frame):
    return json.loads(frame.to_json(orient="records", double_precision=15))


def _url(base, table, params):
    return f"{base}/rest/v1/{quote(table, safe='._')}?{urlencode(params)}"


@dashboard_cache("water-quantity.source-rows")
def _read_table(base, key, table, kind):
    metrics = TRANSFER_METRICS if kind == "transfers" else BALANCE_METRICS
    fields = ["district_name", "year", "month", "date"] if kind == "transfers" else ["Year", "Month", "Date"]
    fields += [item[3] for item in metrics]
    sample, _ = _request_page(_url(base, table, {"select": "*", "limit": "1"}), key, 0, 0)
    if not sample:
        raise SupabaseSourceError(f"Water quantity relation '{table}' has no observations.")
    missing = set(fields).difference(sample[0])
    if missing:
        raise SupabaseSourceError(f"Water quantity relation '{table}' is missing columns: {', '.join(sorted(missing))}.")
    order = "district_name.asc,year.asc,month.asc" if kind == "transfers" else "Year.asc,Month.asc"
    if "id" in sample[0]:
        order += ",id.asc"
    url = _url(base, table, {"select": ",".join(fields), "order": order})
    rows, content_range = _request_page(url, key, 0, 999, True)
    try:
        total = int((content_range or "").rsplit("/", 1)[1])
    except (ValueError, IndexError):
        total = None
    if not rows:
        raise SupabaseSourceError(f"Water quantity relation '{table}' returned an empty first page.")
    if total is not None:
        size = len(rows)
        offsets = list(range(size, total, size))
        if offsets:
            with ThreadPoolExecutor(max_workers=min(6, len(offsets))) as pool:
                pages = list(pool.map(lambda offset: _request_page(url, key, offset, min(total - 1, offset + size - 1))[0], offsets))
            for offset, page in zip(offsets, pages):
                if len(page) != min(size, total - offset):
                    raise SupabaseSourceError(f"Water quantity relation '{table}' returned an incomplete page. Please retry.")
                rows.extend(page)
        if len(rows) != total:
            raise SupabaseSourceError(f"Water quantity relation '{table}' returned an incomplete dataset.")
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
    metrics = TRANSFER_METRICS if kind == "transfers" else BALANCE_METRICS
    raw = pd.DataFrame(rows)
    if raw.empty:
        raise SupabaseSourceError(f"Water quantity relation '{table}' has no observations.")
    year_field, month_field, date_field = ("year", "month", "date") if kind == "transfers" else ("Year", "Month", "Date")
    years = pd.to_numeric(raw[year_field], errors="coerce")
    months = pd.to_numeric(raw[month_field], errors="coerce")
    if not (years.between(1900, 2200) & years.mod(1).eq(0) & months.between(1, 12) & months.mod(1).eq(0)).all():
        raise SupabaseSourceError(f"Water quantity relation '{table}' has invalid reporting years or months.")
    frame = pd.DataFrame({"year": years.astype(int), "period": years.astype(int).astype(str) + "-" + months.astype(int).astype(str).str.zfill(2)})
    if not frame.period.eq(raw[date_field]).all():
        raise SupabaseSourceError(f"Water quantity relation '{table}' has dates that disagree with its reporting year and month.")
    if kind == "transfers":
        if not raw.district_name.map(lambda value: isinstance(value, str) and bool(value.strip())).all():
            raise SupabaseSourceError(f"Water quantity relation '{table}' contains invalid district names.")
        frame["district_name"] = raw.district_name
    key = ["district_name", "period"] if kind == "transfers" else ["period"]
    if frame.duplicated(key).any():
        raise SupabaseSourceError(f"Water quantity relation '{table}' has duplicate reporting keys; aggregation stopped to avoid double counting.")
    indicators = []
    for name, label, unit, field, category, source in metrics:
        frame[name] = raw[field].map(_number).astype(float)
        indicators.append({"key": name, "label": label, "unit": unit, "source_column": field, "category": category,
                           "reference_agency": source, "provenance": "requirements_reference",
                           "temporal_basis": "Monthly record of a supplied daily rate or intensity" if kind == "transfers" else "Volume or storage stock in a monthly source record; annualisation not specified"})
    keys = [item[0] for item in metrics]
    first, last = str(frame.period.min()), str(frame.period.max())
    entities = int(frame.district_name.nunique()) if kind == "transfers" else 1
    expected = len(pd.period_range(first, last, freq="M")) * entities
    audit = {"table": table, "rows": len(frame), "entities": entities, "scope": "district-month" if kind == "transfers" else "national-month",
             "first_period": first, "last_period": last, "duplicate_keys": 0, "missing_entity_months": expected - len(frame),
             "missing_measurements": int(frame[keys].isna().sum().sum()),
             "ranges": [{"key": name, "min": _number(frame[name].min()), "max": _number(frame[name].max()),
                         "missing": int(frame[name].isna().sum()), "zeros": int(frame[name].eq(0).sum()),
                         "distinct": int(frame[name].nunique())} for name in keys]}
    if kind == "transfers":
        latest = frame[frame.period == last]
        audit["latest_all_route_zero_districts"] = int((latest[list(ROUTE_KEYS)].notna().all(axis=1) & latest[list(ROUTE_KEYS)].eq(0).all(axis=1)).sum())
        audit["latest_districts"] = len(latest)
    else:
        audit["calculation_checks"] = _calculation_checks(frame)
    return {"frame": frame, "indicators": indicators, "audit": audit}


def _calculation_checks(frame):
    demand_fields = ["municipal_volume", "agricultural_volume", "industrial_volume", "environmental_reserve"]
    expected_demand = frame[demand_fields].sum(axis=1, min_count=len(demand_fields))
    expected_balance = frame.map_volume - frame.aet_volume - frame.runoff_volume - frame.recharge_volume + frame.net_ibt - frame.reported_demand
    result = {}
    for name, expected, actual, formula in (("total_demand", expected_demand, frame.reported_demand, DEMAND_FORMULA),
                                             ("reported_balance", expected_balance, frame.reported_balance, BALANCE_FORMULA)):
        difference = (actual - expected).abs()
        result[name] = {"expression": formula, "complete_rows": int(difference.notna().sum()),
                        "matching_rows": int(difference.le(0.025).sum()), "mismatching_rows": int(difference.gt(0.025).sum()),
                        "max_absolute_difference_mm3": _number(difference.max()), "tolerance_mm3": 0.025,
                        "status": "inferred source identity; not a documented accounting method"}
    return result


@dashboard_cache("water-quantity.prepared")
def _snapshot(base, key, names):
    def load(pair):
        index, kind = pair
        return kind, _prepare(_read_table(base, key, names[index], kind), kind, names[index])
    with ThreadPoolExecutor(max_workers=2) as pool:
        return dict(pool.map(load, enumerate(("transfers", "balance"))))


def _load():
    base, key, _ = _settings()
    return _snapshot(base, key, _configured_tables())


def _metadata(data):
    years = sorted({int(year) for section in data.values() for year in section["frame"].year.unique()})
    periods = sorted({period for section in data.values() for period in section["frame"].period.unique()})
    return {"source": "Supabase", "frequency": "monthly", "regions": sorted(data["transfers"]["frame"].district_name.unique()),
            "years": years, "first_period": periods[0], "last_period": periods[-1], "default_start": max(years[0], years[-1] - 9),
            "default_end": years[-1], "cache_ttl_seconds": dashboard_cache_ttl(),
            "transfer_indicators": data["transfers"]["indicators"], "balance_indicators": data["balance"]["indicators"],
            "audits": {kind: section["audit"] for kind, section in data.items()},
            "limitations": [
                "Both relations contain monthly reporting records. Daily timestamps, daily feeds and daily refresh evidence are absent.",
                "Transfer values retain m³/day, kWh/ML and % FSC units. They are not multiplied by calendar days or summed into monthly volumes.",
                "National transfer summaries are equal means of the source districts. Districts without source rows remain unobserved on the 52-district map.",
                "Tugela–Vaal and Thukela–Vaal are separate supplied columns. Scheme identifiers and overlap rules are absent; they are not added into a gross transfer total.",
                "The national balance is a separate national-month table and does not change when a transfer district is selected. District rates are not reconciled to its net IBT value.",
                "Volume columns are labelled Mm³ without a documented accumulation convention. Storage is a stock; monthly records are not summed into annual totals.",
                "Reported balance and demand are preserved. Formula checks describe inferred source identities, not independently verified hydrological accounting.",
                "Reference agencies come from the supplied requirements. Source status flags, zero-value verification, daily operational topology and field-level provenance are not supplied.",
            ]}


def _select(data, region, start, end):
    meta = _metadata(data)
    start = meta["default_start"] if start is None else start
    end = meta["default_end"] if end is None else end
    if start > end:
        raise HTTPException(400, "The end year must be on or after the start year.")
    if region != "National" and region not in meta["regions"]:
        raise HTTPException(400, "Select National or one of the source transfer districts.")
    return start, end


def _section_value(section, region, start, end, transfers):
    frame = section["frame"]
    window = frame[frame.year.between(start, end)]
    selected = window if not transfers or region == "National" else window[window.district_name == region]
    keys = [item["key"] for item in section["indicators"]]
    monthly = selected.groupby("period")[keys].mean()
    if not monthly.empty:
        monthly = monthly.reindex(pd.period_range(monthly.index.min(), monthly.index.max(), freq="M").astype(str)).rename_axis("period")
    latest_period = str(selected.period.max()) if not selected.empty else None
    records = _records(monthly.reset_index())
    latest = next((row for row in records if row["period"] == latest_period), {})
    result = {"monthly": records, "latest": latest, "latest_period": latest_period, "selected_rows": len(selected),
              "scope": region if transfers else "National", "missing_measurements": int(selected[keys].isna().sum().sum())}
    if transfers:
        map_period = str(window.period.max()) if not window.empty else None
        current = window[window.period == map_period]
        by_name = {row["district_name"]: row for row in _records(current[["district_name", "period", *keys]])}
        result["map"] = [by_name.get(name, {"district_name": name, "period": None, **dict.fromkeys(keys)}) for name in sorted(frame.district_name.unique())]
        result["map_period"] = map_period
        result["selected_districts"] = int(selected.district_name.nunique())
        latest_rows = selected[selected.period == latest_period]
        result["latest_all_route_zero_districts"] = int((latest_rows[list(ROUTE_KEYS)].notna().all(axis=1) & latest_rows[list(ROUTE_KEYS)].eq(0).all(axis=1)).sum())
    else:
        result["calculation_checks"] = _calculation_checks(selected)
        result["components"] = [{**item, "value": latest.get(item["key"])} for item in section["indicators"]]
        result["calculation_components"] = [{"component": label, "signed_volume": sign * latest[name] if latest.get(name) is not None else None}
            for name, label, sign in (("map_volume", "+ MAP", 1), ("aet_volume", "− AET", -1),
                                     ("runoff_volume", "− MAR", -1), ("recharge_volume", "− Recharge", -1),
                                     ("net_ibt", "+ Net IBT", 1), ("reported_demand", "− Total demand", -1),
                                     ("reported_balance", "Reported balance", 1))]
    return result


def _dashboard_value(data, region="National", start=None, end=None):
    start, end = _select(data, region, start, end)
    transfers = _section_value(data["transfers"], region, start, end, True)
    balance = _section_value(data["balance"], region, start, end, False)
    if not transfers["monthly"] and not balance["monthly"]:
        raise HTTPException(404, "No monthly water quantity observations are available for the selected years.")
    return {"source": "Supabase", "frequency": "monthly", "region": region, "start": start, "end": end,
            "transfers": transfers, "balance": balance}


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
        return {"source": "Supabase", "frequency": "monthly", "years": meta["years"], "default_start": meta["default_start"],
                "default_end": meta["default_end"], "regions": [TRANSFER_PREFIX + TRANSFER_MEAN, *[TRANSFER_PREFIX + name for name in meta["regions"]]],
                "metrics": [*meta["balance_indicators"], *meta["transfer_indicators"]]}
    except SupabaseSourceError as exc:
        raise HTTPException(502, str(exc)) from exc


@router.get("/forecast-source")
def forecast_source(region: str = "National", start: int | None = None, end: int | None = None):
    try:
        data = _load()
        transfers = region.startswith(TRANSFER_PREFIX)
        district = region[len(TRANSFER_PREFIX):] if transfers else "National"
        if not transfers and region != "National":
            raise HTTPException(400, "Choose National balance or a Transfers forecast region.")
        district = "National" if district == TRANSFER_MEAN else district
        start, end = _select(data, district, start, end)
        section = data["transfers" if transfers else "balance"]
        selected = _section_value(section, district, start, end, transfers)
        if not selected["monthly"]:
            raise HTTPException(404, "No monthly observations are available for this forecast selection.")
        metrics = [item for item in section["indicators"] if any(row.get(item["key"]) is not None for row in selected["monthly"])]
        return {"source": "Supabase", "frequency": "monthly", "source_table": section["audit"]["table"], "region": region,
                "start": start, "end": end, "metrics": metrics, "series": selected["monthly"]}
    except SupabaseSourceError as exc:
        raise HTTPException(502, str(exc)) from exc
