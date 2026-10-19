"""Paginated, server-only drought reads with a packaged-data fallback.

Supabase/PostgreSQL remains the primary source. The packaged CSV reader is
only used when the configured database cannot be reached, so a local checkout
does not render an empty monitoring dashboard while the database is offline.
"""
from calendar import monthrange
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from pathlib import Path
from threading import Lock
from urllib.parse import urlencode

import pandas as pd

from app.supabase_source import _settings, _request_page, SupabaseSourceError
from app.dashboard_loader import cached_call
from app.database import postgres_enabled
from app.postgres_source import read_rows_from_rest_params, read_latest_rows as postgres_latest_rows, read_region_history as postgres_region_history

TABLES = {'meteorological_drought_master', 'hydrological_drought_master', 'satellite_remote_sensing'}
REPO_ROOT = Path(__file__).resolve().parents[2]
LOCAL_FILES = {
    'meteorological_drought_master': REPO_ROOT / 'vegetation' / '5.2_meteorological_drivers_saws_master.csv',
    'hydrological_drought_master': REPO_ROOT / "csv's" / 'hydrology.csv',
    'satellite_remote_sensing': REPO_ROOT / "csv's" / 'satelite.csv',
}
_LOCAL_CACHE = {}
_LOCAL_LOCK = Lock()


def _local_enabled():
    # Keep this fallback enabled for the packaged application. Deployments
    # that require a hard database-only policy can set it to false.
    import os
    return os.getenv('NIWIS_DROUGHT_LOCAL_FALLBACK', 'true').strip().lower() not in {'0', 'false', 'no', 'off'}


def _network_blocked(error):
    """Identify a local socket-policy failure that should use packaged data."""
    message = str(error).lower()
    return 'winerror 10013' in message or 'forbidden by its access permissions' in message


def _can_use_local(error):
    # A blocked outbound socket is an execution-environment failure, not a
    # data-quality result. Keep the drought dashboard usable from its packaged
    # observations even when a deployment has disabled general fallback.
    return _local_enabled() or _network_blocked(error)


def _local_rows(table):
    """Read the matching packaged dataset and normalize it to DB field names."""
    path = LOCAL_FILES.get(table)
    if not path or not path.exists():
        return []
    with _LOCAL_LOCK:
        cached = _LOCAL_CACHE.get(table)
        if cached is not None:
            return deepcopy(cached)
    frame = pd.read_csv(path, low_memory=False)
    if table == 'meteorological_drought_master':
        frame['date'] = pd.to_datetime(frame['Year'].astype(str) + '-' + frame['Month'].astype(str).str.zfill(2) + '-01').dt.strftime('%Y-%m-%d')
        frame = frame.rename(columns={
            'District_Name': 'district_name',
            'Mean_Temperature_C': 'tavg_c',
            'Potential_Evapotranspiration_ET0_mm': 'et0_mm_month',
            'SPI_1_month': 'spi_1', 'SPI_3_month': 'spi_3', 'SPI_6_month': 'spi_6',
            'SPEI_1_month': 'spei_1', 'SPEI_3_month': 'spei_3', 'SPEI_6_month': 'spei_6',
            'Monthly_Rainfall_mm': 'monthly_rainfall_mm_month',
        })
        frame['pet_mm_day'] = frame['et0_mm_month'] / frame.apply(lambda row: monthrange(int(row['Year']), int(row['Month']))[1], axis=1)
        frame['et0_mm_day'] = frame['pet_mm_day']
        # This source is monthly, so source_analysis must not treat one row as
        # one observed day or sum a monthly rainfall value as daily rainfall.
        frame['_monthly_observation'] = True
        frame['_niwis_source'] = 'local_csv_fallback'
    elif table == 'satellite_remote_sensing':
        frame = frame.rename(columns={
            'NDVI': 'ndvi', 'LST': 'lst', 'NDWI': 'ndwi', 'VCI': 'vci',
            'TCI': 'tci', 'VHI': 'vhi', 'GRACE_TWS': 'grace_tws',
        })
        frame['_niwis_source'] = 'local_csv_fallback'
    else:
        frame['_niwis_source'] = 'local_csv_fallback'
    rows = frame.where(pd.notna(frame), None).to_dict(orient='records')
    with _LOCAL_LOCK:
        _LOCAL_CACHE[table] = rows
    return deepcopy(rows)


def read_rows(table, params):
    if table not in TABLES:
        raise SupabaseSourceError('Unknown drought data source.')
    if postgres_enabled():
        return read_rows_from_rest_params(table, params)
    base, key, _ = _settings()
    url = f'{base}/rest/v1/{table}?{urlencode(params)}'

    def load():
        rows, start = [], 0
        while True:
            page, _ = _request_page(url, key, start, start + 999)
            rows.extend(page)
            if len(page) < 1000:
                return rows
            start += len(page)

    return cached_call('drought.rows', url, loader=load)


def latest_rows(table):
    def remote():
        if postgres_enabled():
            return postgres_latest_rows(table)
        newest = read_rows(table, {'select': 'date', 'order': 'date.desc', 'limit': '1'})
        if not newest:
            return []
        return read_rows(table, {'select': '*', 'date': f"eq.{newest[0]['date']}", 'order': 'district_name.asc,id.asc'})

    try:
        rows = remote()
        if rows:
            return rows
    except Exception as error:
        if not _can_use_local(error):
            raise
    rows = _local_rows(table)
    if not rows:
        return []
    latest = max(str(row.get('date', '')) for row in rows)
    return [row for row in rows if str(row.get('date', '')) == latest]


def rows_at_date(table, date):
    """Return the source rows for a selected monthly map date.

    Drought source dates are stored as the first day of a month.  Keep the
    query bounded to that date so changing the map date does not reload the
    complete history.
    """
    if not date:
        return latest_rows(table)
    target = str(date)
    if len(target) == 7:
        target = f'{target}-01'
    try:
        if postgres_enabled():
            rows = read_rows_from_rest_params(table, {'select': '*', 'date': f'eq.{target}', 'order': 'district_name.asc,id.asc'})
        else:
            rows = read_rows(table, {'select': '*', 'date': f'eq.{target}', 'order': 'district_name.asc,id.asc'})
        if rows:
            return rows
    except Exception as error:
        if not _can_use_local(error):
            raise
    rows = _local_rows(table)
    return [row for row in rows if str(row.get('date', ''))[:10] == target]


def normalise_region(name):
    key = ''.join(c for c in name.lower().removeprefix('city of ') if c.isalnum())
    return {'cacadu': 'sarahbaartman', 'eden': 'gardenroute', 'sisonke': 'harrygwala',
            'uthungulu': 'kingcetshwayo', 'siyanda': 'zfmgcawu',
            'greatersekhukhune': 'sekhukhune'}.get(key, key)


def region_history(table, name):
    try:
        if postgres_enabled():
            return postgres_region_history(table, name)
        region = next((r['district_name'] for r in latest_rows(table)
                       if normalise_region(r['district_name']) == normalise_region(name)), name)
        rows = read_rows(table, {'select': '*', 'district_name': f'eq.{region}', 'order': 'date.asc,id.asc'})
        if rows:
            return rows
    except Exception as error:
        if not _can_use_local(error):
            raise
    rows = _local_rows(table)
    wanted = normalise_region(name)
    return [row for row in rows if normalise_region(str(row.get('district_name', ''))) == wanted]


def bounded_rows(table, start, end, region=None):
    """Read a bounded forecast window without national full-history scans."""
    if table not in TABLES:
        raise SupabaseSourceError('Unknown drought data source.')
    first, final = pd.Timestamp(start), pd.Timestamp(end) + pd.Timedelta(days=1)
    jobs = []
    while first < final:
        following = min(first + pd.Timedelta(days=365 if region else 14), final)
        params = {'select': '*', 'date': f'gte.{first:%Y-%m-%d}',
                  'and': f'(date.lt.{following:%Y-%m-%d})',
                  'order': 'district_name.asc,date.asc,id.asc'}
        if region:
            params['district_name'] = f'eq.{region}'
        jobs.append(params)
        first = following
    try:
        with ThreadPoolExecutor(max_workers=min(8, max(1, len(jobs)))) as executor:
            rows = [row for page in executor.map(lambda params: read_rows(table, params), jobs) for row in page]
        if rows:
            return rows
    except Exception as error:
        if not _can_use_local(error):
            raise
    # Preserve the drought modules' configured fallback with the same bounds.
    # A failed remote window never yields a mixture of remote and local rows.
    return [row for row in _local_rows(table)
            if str(start)[:10] <= str(row.get('date', ''))[:10] <= str(end)[:10]
            and (not region or normalise_region(str(row.get('district_name', ''))) == normalise_region(region))]
