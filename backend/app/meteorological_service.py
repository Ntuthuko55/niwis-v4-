"""Region-level meteorological observations from Supabase."""
from fastapi import APIRouter, HTTPException, Query

from app.supabase_source import SupabaseSourceError
from app.drought_source import read_rows as read_drought_rows, region_history

router = APIRouter(prefix="/meteorological")


def read_rows(params):
    return read_drought_rows('meteorological_drought_master', params)


@router.get("/regions")
def regions(date: str | None = None):
    try:
        target = f"{date}-01" if date and len(date) == 7 else date
        if target:
            rows = read_rows({"select": "*", "date": f"eq.{target}", "order": "district_name.asc,id.asc"})
        else:
            newest = read_rows({"select": "date", "order": "date.desc", "limit": "1"})
            rows = read_rows({"select": "*", "date": f"eq.{newest[0]['date']}", "order": "district_name.asc,id.asc"}) if newest else []
        return {"regions": rows, "source": "meteorological_drought_master",
                "source_mode": "database", "source_tables": ["meteorological_drought_master"]}
    except SupabaseSourceError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@router.get("/history")
def history(region: str = Query(..., min_length=1)):
    try:
        rows = region_history('meteorological_drought_master', region)
        return {"region": region, "history": rows, "source": "meteorological_drought_master",
                "source_mode": "database", "source_tables": ["meteorological_drought_master"]}
    except SupabaseSourceError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
