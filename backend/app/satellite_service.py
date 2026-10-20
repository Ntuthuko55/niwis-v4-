"""Satellite indicators read only from Supabase."""
from app.drought_source import latest_rows, rows_at_date, region_history, bounded_rows, normalise_region

TABLE = 'satellite_remote_sensing'
FIELDS = {'ndvi': 'NDVI', 'lst': 'LST', 'ndwi': 'NDWI', 'vci': 'VCI',
          'tci': 'TCI', 'vhi': 'VHI', 'grace_tws': 'GRACE_TWS'}


def normalise_row(row):
    return {FIELDS.get(key, key): value for key, value in row.items() if key != 'id'}


def stations(date=None):
    rows = rows_at_date(TABLE, date) if date else latest_rows(TABLE)
    return {'source': TABLE, 'source_mode': 'database', 'source_tables': [TABLE], 'date': rows[0]['date'] if rows else None,
            'station_count': len(rows),
            'stations': [{**normalise_row(r), 'name': r['district_name']} for r in rows]}


def history(district):
    rows = region_history(TABLE, district)
    return {'source': TABLE, 'source_mode': 'database', 'source_tables': [TABLE], 'district': rows[0]['district_name'] if rows else district,
            'history': [normalise_row(r) for r in rows]}


def forecast_source(region='National'):
    import json
    import pandas as pd
    from fastapi import HTTPException
    snapshot = latest_rows(TABLE)
    if not snapshot:
        raise HTTPException(422, 'No satellite observations are available.')
    end = max(str(row['date'])[:10] for row in snapshot)
    start = str((pd.Timestamp(end) - pd.DateOffset(months=36)).date())
    canonical = None if region == 'National' else next((row['district_name'] for row in snapshot
        if normalise_region(row['district_name']) == normalise_region(region)), None)
    if region != 'National' and canonical is None:
        raise HTTPException(404, 'Satellite district not found.')
    rows = bounded_rows(TABLE, start, end, canonical)
    frame = pd.DataFrame([normalise_row(row) for row in rows])
    if frame.empty:
        raise HTTPException(422, 'No satellite forecast observations are available.')
    frame['date'] = pd.to_datetime(frame['date']).dt.to_period('M').astype(str)
    keys = [key for key in frame.select_dtypes(include='number').columns if key not in {'id', 'year', 'month'}]
    monthly = frame.groupby(['district_name', 'date'], as_index=False)[keys].mean()
    series = monthly.groupby('date', as_index=False)[keys].mean()
    return {'source': TABLE, 'source_mode': 'database', 'source_tables': [TABLE],
            'region': region, 'series': json.loads(series.to_json(orient='records'))}
