"""Read-only audit of dated section 9 catchments and the surface-water API."""
import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from time import perf_counter
from unittest.mock import patch

import numpy as np
import pandas as pd
from fastapi import FastAPI

from app import surface_water_service as surface
from verify_runoff_database import running_api


def main():
    output = Path(__file__).resolve().parents[1] / 'output' / 'surface-water-data-report'
    output.mkdir(parents=True, exist_ok=True)
    app = FastAPI()
    app.include_router(surface.router)
    checks = []

    def request(path):
        started = perf_counter()
        status, payload = get(path)
        assert status == 200, f'{path}: HTTP {status}: {payload}'
        assert payload['source'] == 'Supabase'
        if not path.startswith('/surface-water/daily?'):
            assert payload['source_tables'] == list(surface.DEFAULT_TABLES)
        json.dumps(payload, allow_nan=False)
        checks.append({'path': path, 'status': status, 'seconds': round(perf_counter() - started, 3)})
        print(json.dumps(checks[-1]), flush=True)
        return payload

    weather = {'status': 'unavailable', 'source': 'Unrelated rainfall source excluded from section 9 audit', 'series': []}
    with running_api(app) as get, patch.object(pd, 'read_csv', side_effect=AssertionError('Surface-water CSV read forbidden')), patch.object(surface, '_rainfall_context', return_value=weather):
        meta = request('/surface-water/metadata')
        assert meta['catchments_dated']
        assert len(meta['regions']) == 52
        assert meta['first_catchment_date'] == '2000-01-01'
        assert meta['latest_catchment_date'] == '2026-10-01'
        assert meta['latest_daily_date'] == '2026-09-24'
        assert meta['latest_eo_month'] == '2026-09'
        assert meta['default_end'] == '2026-08'
        catchment_schema = {column['name']: column for column in meta['schema'][1]['columns']}
        assert catchment_schema['date']['format'] == 'date'
        assert catchment_schema['month']['type'] == 'string'
        snapshot = surface._snapshot()
        table = snapshot['tables']['catchments']

        def catalogue(year):
            return surface._read_pages(snapshot['base'], snapshot['key'], table, {
                'select': 'date,district_name,year,month', 'date': f'gte.{year}-01-01',
                'and': f'(date.lt.{year + 1}-01-01)', 'order': 'district_name.asc,date.asc',
            })
        with ThreadPoolExecutor(max_workers=8) as executor:
            records = [row for part in executor.map(catalogue, range(2000, 2027)) for row in part]
        index = pd.DataFrame(records)
        assert not index.duplicated(['district_name', 'date']).any()
        assert index.date.str[:7].eq(index.month).all()
        assert index.date.str[:4].astype(int).eq(index.year).all()
        assert index.groupby('date').district_name.nunique().eq(52).all()
        nulls, content_range = surface._request_page(surface._table_url(snapshot['base'], table, {'select': 'date', 'date': 'is.null', 'limit': '1'}), snapshot['key'], 0, 0, count_exact=True)
        assert not nulls and (content_range or '').endswith('/0')

        national = request('/surface-water/dashboard?start=2026-08&end=2026-08')
        assert len(national['map']) == 52
        assert national['catchment_coverage']['districts'] == 52
        assert national['catchment_coverage']['month'] == '2026-08'
        assert national['catchment_coverage']['last_date'] == '2026-08-01'
        district = request('/surface-water/dashboard?region=City+of+Cape+Town&start=2024-02&end=2024-02')
        assert len(district['map']) == 52
        assert district['catchment_coverage']['first_date'] == '2024-02-01'
        assert district['catchment_coverage']['last_date'] == '2024-02-01'
        assert district['catchment_coverage']['districts'] == 1
        assert np.isclose(district['profile']['catchment_area_km2'], 2458.11)
        assert district['coverage']['observed_days'] == 29
        assert not district['profile']['land_cover_valid_partition']
        daily = request('/surface-water/daily?region=City+of+Cape+Town&month=2024-02')
        assert len(daily['series']) == 29
        forecast = request('/surface-water/forecast-source?region=City+of+Cape+Town&start=2024-02&end=2024-02')
        assert len(forecast['series']) == 1
        assert np.isclose(forecast['series'][0]['discharge'], district['latest']['discharge'])
        partial = request('/surface-water/dashboard?region=City+of+Tshwane&start=2026-09&end=2026-09')
        assert partial['coverage']['observed_days'] == 24
        assert not partial['latest']['complete']
        assert partial['catchment_coverage']['last_date'] == '2026-09-01'
        sample = surface._read_pages(snapshot['base'], snapshot['key'], table, {'select': '*', 'district_name': 'eq.City of Cape Town', 'order': 'date.asc'})
        fields = [field for field in sample[0] if field not in {'district_name', 'date', 'year', 'month'}]
        distinct = {field: len({json.dumps(row[field]) for row in sample}) for field in fields}

    report = {'source_tables': meta['source_tables'], 'schema': meta['schema'],
              'hydrology_last_date': meta['latest_daily_date'], 'earth_observation_latest_month': meta['latest_eo_month'],
              'catchments': {'first_date': meta['first_catchment_date'], 'last_date': meta['latest_catchment_date'],
                             'rows': len(index), 'periods': index.date.nunique(), 'districts': index.district_name.nunique(),
                             'duplicate_district_dates': 0, 'null_dates': 0, 'month_type': 'text: YYYY-MM',
                             'sample_district': 'City of Cape Town', 'sample_history_rows': len(sample), 'sample_distinct_values': distinct},
              'checks': checks, 'selected_national_catchment_coverage': national['catchment_coverage'],
              'selected_district_catchment_coverage': district['catchment_coverage'], 'runtime_csv_reads': 0}
    (output / 'database-date-verification.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    print('Surface-water date/schema and live API checks passed.', flush=True)


if __name__ == '__main__':
    main()
