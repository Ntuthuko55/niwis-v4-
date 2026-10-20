"""Read-only schema and source verification for the three drought tables."""
import argparse
import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from time import perf_counter
from unittest.mock import patch
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from app.supabase_source import _settings, _request_page

TABLES = ('meteorological_drought_master', 'hydrological_drought_master', 'satellite_remote_sensing')
OUTPUT = Path(__file__).resolve().parents[1] / 'output' / 'drought-database'


def inspect_tables():
    base, key, _ = _settings()
    request = Request(base + '/rest/v1/', headers={
        'apikey': key, 'Authorization': 'Bearer ' + key,
        'Accept': 'application/openapi+json',
    })
    with urlopen(request, timeout=45) as response:
        definitions = json.load(response).get('definitions', {})

    def inspect(table):
        started = perf_counter()
        def read(params):
            return _request_page(base + '/rest/v1/' + table + '?' + urlencode(params), key)[0]
        sample = read({'select': '*', 'limit': '1'})
        assert sample, f'{table}: no observations'
        required = {'id', 'date', 'district_name'}
        assert required <= sample[0].keys(), f'{table}: missing keys {required - sample[0].keys()}'
        first = read({'select': 'date', 'order': 'date.asc', 'limit': '1'})[0]['date']
        last = read({'select': 'date', 'order': 'date.desc', 'limit': '1'})[0]['date']
        latest = read({'select': '*', 'date': 'eq.' + last, 'order': 'district_name.asc,id.asc'})
        assert len({row['district_name'] for row in latest}) == 52, f'{table}: latest snapshot has incomplete district coverage'
        columns = definitions.get(table, {}).get('properties', {})
        assert columns.get('date', {}).get('format') == 'date', f'{table}: date must be a database date'
        result = {'table': table, 'first_date': first, 'last_date': last,
                  'latest_snapshot_rows': len(latest),
                  'districts': sorted({row['district_name'] for row in latest}),
                  'columns': [{'name': name, 'type': spec.get('type'), 'format': spec.get('format')}
                              for name, spec in columns.items()],
                  'sample': sample[0], 'seconds': round(perf_counter() - started, 3)}
        print(json.dumps({key: result[key] for key in ('table', 'first_date', 'last_date', 'latest_snapshot_rows', 'seconds')}), flush=True)
        return result

    with ThreadPoolExecutor(max_workers=3) as executor:
        result = list(executor.map(inspect, TABLES))
    OUTPUT.mkdir(parents=True, exist_ok=True)
    (OUTPUT / 'table-inspection.json').write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
    return result


def verify_api():
    import numpy as np
    import pandas as pd
    from app import main, drought_source as source
    from app.dashboard_loader import clear_dashboard_cache
    from verify_runoff_database import running_api

    clear_dashboard_cache()
    timings, checks = [], []
    canonical = {}
    with patch('pandas.read_csv', side_effect=AssertionError('Drought CSV read forbidden')) as csv, running_api(main.app) as get:
        def request(path, expected=200):
            started = perf_counter()
            status, data = get(path)
            assert status == expected, f'{path}: HTTP {status}: {data}'
            json.dumps(data, allow_nan=False)
            timings.append({'path': path, 'status': status, 'seconds': round(perf_counter() - started, 3)})
            print(json.dumps(timings[-1]), flush=True)
            return data

        catalog = request('/drought-monitoring/regions')
        assert len(catalog['regions']) == 52 and not catalog['errors']
        assert catalog['source_mode'] == 'database' and catalog['source_tables'] == list(TABLES)
        tshwane = next(region for region in catalog['regions'] if region['key'] == 'tshwane')
        for kind, table in zip(('meteorological', 'hydrological', 'satellite'), TABLES):
            canonical[table] = tshwane['sources'][kind]['district_name']

        combined = request('/drought-monitoring/region?' + urlencode({'region': 'City Of Tshwane'}))
        assert combined['source_mode'] == 'database'
        for kind, table in zip(('meteorological', 'hydrological', 'satellite'), TABLES):
            raw = source.region_history(table, canonical[table])
            frame = pd.DataFrame(raw)
            assert not frame.duplicated(['district_name', 'date']).any()
            analyzed = combined['sources'][kind]
            assert analyzed['status'] == 'ok' and analyzed['source'] == 'database'
            assert analyzed['records'] == len(raw)
            assert analyzed['end'] == max(row['date'] for row in raw)
            checks.append({'source': table, 'region': canonical[table], 'rows': len(raw),
                           'first_date': min(row['date'] for row in raw), 'last_date': analyzed['end']})
            if kind == 'meteorological':
                january = frame[frame.date.str.startswith('2025-01')]
                result = next(point for point in analyzed['monthly'] if point['month'] == '2025-01')
                assert len(january) == 31 and result['complete']
                assert np.isclose(result['rainfall_mm'], january.daily_rainfall_mm_day.sum(), atol=1e-4)
        common = set.intersection(*({row['month'] for row in data['monthly'] if row['complete']} for data in combined['sources'].values()))
        assert combined['alignment']['month'] == max(common)
        repeated = request('/drought-monitoring/region?' + urlencode({'region': 'City Of Tshwane'}))
        assert combined == repeated

        hydro = request('/hydrology/metadata')
        assert len(hydro['districts']) == 52 and hydro['source_mode'] == 'database'
        regional = request('/hydrology/observations?' + urlencode({'region': 'CITY OF TSHWANE'}))
        assert regional['source_mode'] == 'database' and regional['record_count'] == checks[1]['rows']
        bounded = request('/hydrology/observations?' + urlencode({'region': 'City of Tshwane', 'start': '2024-01-01', 'end': '2024-01-31'}))
        assert bounded['record_count'] == 1 and bounded['records'][0]['date'] == '2024-01-01'

        satellite = request('/satellite/stations')
        assert satellite['station_count'] == 52 and satellite['source_mode'] == 'database'
        dated = request('/satellite/stations?date=2024-01')
        assert dated['station_count'] == 52 and dated['date'] == '2024-01-01'
        empty = request('/satellite/stations?date=1990-01')
        assert empty['station_count'] == 0 and not empty['stations']
        history = request('/satellite/history?' + urlencode({'district': canonical[TABLES[2]].upper()}))
        assert history['source_mode'] == 'database' and len(history['history']) == checks[2]['rows']
        raw_satellite = source.region_history(TABLES[2], canonical[TABLES[2]])
        assert history['history'][-1]['NDVI'] == raw_satellite[-1]['ndvi']

        meteorological = request('/meteorological/regions')
        assert len(meteorological['regions']) == 52 and meteorological['source_mode'] == 'database'
        weather = request('/meteorological/history?' + urlencode({'region': canonical[TABLES[0]]}))
        assert weather['source_mode'] == 'database' and len(weather['history']) == checks[0]['rows']

        for module in ('hydrology', 'satellite'):
            for region in ('National', 'City of Tshwane'):
                forecast = request(f'/{module}/forecast-source?' + urlencode({'region': region}))
                assert forecast['source_mode'] == 'database' and len(forecast['series']) >= 36
                assert all(row['date'] for row in forecast['series'])

        clear_dashboard_cache()
        with patch.object(source, '_request_page', side_effect=source.SupabaseSourceError('Drought database unavailable for verification')):
            for path in ['/hydrology/observations?region=Alfred%20Nzo&_source_check=offline',
                         '/satellite/stations?_source_check=offline',
                         '/satellite/history?district=Alfred%20Nzo&_source_check=offline']:
                status, data = get(path)
                assert status in (502, 503) and 'database unavailable' in data['detail']
            unavailable = request('/drought-monitoring/regions?_source_check=offline')
            assert not unavailable['regions'] and len(unavailable['errors']) == 3
        csv.assert_not_called()

    report = {'status': 'passed', 'source_mode': 'database', 'source_tables': list(TABLES),
              'regional_checks': checks, 'api_checks': timings, 'csv_reads': csv.call_count,
              'checks': ['52 districts per source', 'Regional values match direct database history',
                         'Complete-month rainfall and cross-source alignment', 'Case-insensitive region selection',
                         'Dated map snapshots and empty selections', 'National and regional forecast inputs',
                         'Database outages stay visible without CSV substitution']}
    (OUTPUT / 'api-verification.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    print('PASS drought database sources, API values, maps, forecast inputs and outage behavior; zero CSV reads.', flush=True)
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--inspect-only', action='store_true')
    args = parser.parse_args()
    inspect_tables()
    if not args.inspect_only:
        verify_api()
