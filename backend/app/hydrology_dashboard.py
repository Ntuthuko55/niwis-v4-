"""Compact hydrology reads; the legacy full-dataset endpoint remains available."""
import pandas as pd
from fastapi import APIRouter, HTTPException
from app.dashboard_loader import dashboard_cache
from app.drought_source import latest_rows, read_rows, region_history, normalise_region, bounded_rows
from app.supabase_source import SupabaseSourceError

router = APIRouter(prefix='/hydrology', tags=['Hydrological drought'])
TABLE = 'hydrological_drought_master'
FIELDS = ('river_discharge_m3_s', 'fdc_percentiles_m3_s', 'ssi_dimensionless',
          'dam_storage_million_m3', 'dam_level_pct_fsc', 'dam_inflow_m3_s',
          'dam_outflow_m3_s', 'borehole_water_level_m_bgl', 'sgi_dimensionless',
          'surface_runoff_m3_s', 'baseflow_separation_m3_s')


@router.get('/metadata')
def metadata():
    try:
        rows = latest_rows(TABLE)
        names = sorted({row['district_name'] for row in rows})
        end = max((str(row['date'])[:10] for row in rows), default=None)
        return {'source': TABLE, 'districts': names, 'default_end': end,
                'default_start': str((pd.Timestamp(end) - pd.DateOffset(months=36)).date()) if end else None,
                'default_region': next((name for name in names if normalise_region(name) == 'tshwane'), names[0] if names else None)}
    except SupabaseSourceError as exc:
        raise HTTPException(503, str(exc)) from exc


@router.get('/observations')
def observations(region: str, start: str | None = None, end: str | None = None):
    try:
        if not start and not end:
            rows = region_history(TABLE, region)
        else:
            if not start or not end or pd.Timestamp(start) > pd.Timestamp(end):
                raise HTTPException(422, 'Choose a valid start and end date.')
            meta = metadata()
            canonical = next((name for name in meta['districts'] if normalise_region(name) == normalise_region(region)), None)
            if canonical is None:
                raise HTTPException(404, 'Hydrological district not found.')
            rows = bounded_rows(TABLE, start, end, canonical)
        records = [{key: row.get(key) for key in ('district_name', 'date', *FIELDS, '_niwis_source')} for row in rows]
        return {'source': TABLE, 'source_mode': 'local_csv_fallback' if any(row.get('_niwis_source') == 'local_csv_fallback' for row in rows) else 'database',
                'region': region, 'records': records, 'record_count': len(records)}
    except SupabaseSourceError as exc:
        raise HTTPException(503, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(422, 'Use valid observation dates.') from exc


@router.get('/forecast-source')
def forecast_source(region: str = 'National', start: str | None = None, end: str | None = None):
    try:
        meta = metadata()
        start, end = start or meta['default_start'], end or meta['default_end']
        if not start or not end or pd.Timestamp(start) > pd.Timestamp(end):
            raise HTTPException(422, 'Choose a valid forecast history window.')
        if region == 'National':
            rows = bounded_rows(TABLE, start, end)
        else:
            rows = observations(region, start, end)['records']
        if not rows:
            raise HTTPException(422, 'No hydrological observations are available.')
        frame = pd.DataFrame(rows)
        frame['date'] = pd.to_datetime(frame['date']).dt.to_period('M').astype(str)
        available = [key for key in FIELDS if key in frame]
        for key in available:
            frame[key] = pd.to_numeric(frame[key], errors='coerce')
        monthly = frame.groupby(['district_name', 'date'], as_index=False)[available].mean()
        series = monthly.groupby('date', as_index=False)[available].mean()
        return {'source': TABLE, 'source_mode': 'local_csv_fallback' if any(row.get('_niwis_source') == 'local_csv_fallback' for row in rows) else 'database',
                'region': region, 'series': __import__('json').loads(series.to_json(orient='records'))}
    except SupabaseSourceError as exc:
        raise HTTPException(503, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(422, 'Use valid forecast history dates.') from exc
