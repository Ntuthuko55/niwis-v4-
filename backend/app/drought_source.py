"""Cached, paginated database reads for the three drought dashboards.

Database failures propagate to the dashboard. Empty selections stay empty;
no local dataset is substituted for a missing database observation.
"""
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urlencode

import pandas as pd

from app.supabase_source import _settings, _request_page, SupabaseSourceError
from app.dashboard_loader import cached_call
from app.database import postgres_enabled
from app.postgres_source import read_rows_from_rest_params, read_latest_rows as postgres_latest_rows, read_region_history as postgres_region_history

TABLES = {'meteorological_drought_master', 'hydrological_drought_master', 'satellite_remote_sensing'}


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
    if table not in TABLES:
        raise SupabaseSourceError('Unknown drought data source.')
    if postgres_enabled():
        return postgres_latest_rows(table)
    newest = read_rows(table, {'select': 'date', 'order': 'date.desc', 'limit': '1'})
    if not newest:
        return []
    return read_rows(table, {'select': '*', 'date': f"eq.{newest[0]['date']}", 'order': 'district_name.asc,id.asc'})


def rows_at_date(table, date):
    """Return the source rows for a selected monthly map date.

    Hydrological and satellite dates identify monthly observations; the
    meteorological table is daily. Changing the map date reads that snapshot.
    """
    if not date:
        return latest_rows(table)
    target = str(date)
    if len(target) == 7:
        target = f'{target}-01'
    return read_rows(table, {'select': '*', 'date': f'eq.{target}', 'order': 'district_name.asc,id.asc'})


def normalise_region(name):
    key = ''.join(c for c in name.lower().removeprefix('city of ') if c.isalnum())
    return {'cacadu': 'sarahbaartman', 'eden': 'gardenroute', 'sisonke': 'harrygwala',
            'uthungulu': 'kingcetshwayo', 'siyanda': 'zfmgcawu',
            'greatersekhukhune': 'sekhukhune'}.get(key, key)


def region_history(table, name):
    if table not in TABLES:
        raise SupabaseSourceError('Unknown drought data source.')
    if postgres_enabled():
        return postgres_region_history(table, name)
    region = next((r['district_name'] for r in latest_rows(table)
                   if normalise_region(r['district_name']) == normalise_region(name)), name)
    return read_rows(table, {'select': '*', 'district_name': f'eq.{region}', 'order': 'date.asc,id.asc'})


def bounded_rows(table, start, end, region=None):
    """Read a bounded forecast window without national full-history scans."""
    if table not in TABLES:
        raise SupabaseSourceError('Unknown drought data source.')
    first, last = pd.Timestamp(start), pd.Timestamp(end)
    if pd.isna(first) or pd.isna(last) or first > last:
        raise ValueError('Choose a valid observation window.')
    final = last + pd.Timedelta(days=1)
    # A year of monthly observations is only 624 national district rows.
    # Daily national meteorological reads stay below 1,000 rows per window.
    window_days = 365 if region or table != 'meteorological_drought_master' else 14
    jobs = []
    while first < final:
        following = min(first + pd.Timedelta(days=window_days), final)
        params = {'select': '*', 'date': f'gte.{first:%Y-%m-%d}',
                  'and': f'(date.lt.{following:%Y-%m-%d})',
                  'order': 'district_name.asc,date.asc,id.asc'}
        if region:
            params['district_name'] = f'eq.{region}'
        jobs.append(params)
        first = following
    with ThreadPoolExecutor(max_workers=min(8, max(1, len(jobs)))) as executor:
        return [row for page in executor.map(lambda params: read_rows(table, params), jobs) for row in page]
