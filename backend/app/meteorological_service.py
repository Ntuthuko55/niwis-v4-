"""Region-level meteorological observations from Supabase."""
from urllib.parse import urlencode

from fastapi import APIRouter, HTTPException, Query

from app.supabase_source import _settings, _request_page, SupabaseSourceError
from app.database import postgres_enabled
from app.postgres_source import read_rows_from_rest_params
from app.dashboard_loader import dashboard_cache

router = APIRouter(prefix="/meteorological")


@dashboard_cache('meteorological.rows')
def read_rows(params):
    if postgres_enabled():
        return read_rows_from_rest_params('meteorological_drought_master', params)
    base, key, _ = _settings()
    url = f"{base}/rest/v1/meteorological_drought_master?{urlencode(params)}"
    rows = []
    start = 0
    while True:
        page, _ = _request_page(url, key, start, start + 999)
        rows.extend(page)
        if len(page) < 1000:
            return rows
        start += len(page)


@router.get("/regions")
def regions(date: str | None = None):
    try:
        target = f"{date}-01" if date and len(date) == 7 else date
        if target:
            rows = read_rows({"select": "*", "date": f"eq.{target}", "order": "district_name.asc,id.asc"})
        else:
            newest = read_rows({"select": "date", "order": "date.desc", "limit": "1"})
            rows = read_rows({"select": "*", "date": f"eq.{newest[0]['date']}", "order": "district_name.asc,id.asc"}) if newest else []
        return {"regions": rows, "source": "meteorological_drought_master"}
    except SupabaseSourceError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@router.get("/history")
def history(region: str = Query(..., min_length=1)):
    try:
        rows = read_rows({"select": "*", "district_name": f"eq.{region}", "order": "date.asc,id.asc"})
        return {"region": region, "history": rows}
    except SupabaseSourceError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
