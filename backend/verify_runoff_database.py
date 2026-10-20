"""Read-only verification of runoff APIs against bounded database observations."""
import json
import socket
from contextlib import contextmanager
from pathlib import Path
from threading import Thread
from time import perf_counter, sleep
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.parse import quote, urlencode
from urllib.request import urlopen

import numpy as np
import pandas as pd
from fastapi import FastAPI
import uvicorn

from app import runoff_service as runoff
from app.dashboard_loader import clear_dashboard_cache
from app.supabase_source import _request_page, _settings


def reference_observations(table, region, start, end):
    """Read raw rows independently of the dashboard's aggregation and cache."""
    base, key, _ = _settings()
    columns = ['District_Name', 'Date', 'Daily_Surface_Runoff_Volume_m3_day',
               'Baseflow_Component_m3s', 'Peak_Flow_Rates_m3s']
    params = {'select': ','.join(columns), 'District_Name': f'eq.{region}',
              'Date': f'gte.{start}', 'and': f'(Date.lt.{end})', 'order': 'Date.asc'}
    url = f"{base}/rest/v1/{quote(table, safe='._')}?{urlencode(params)}"
    rows, _ = _request_page(url, key, 0, 999)
    # Each comparison spans at most two months for one district. Never silently
    # compare a truncated result if the source unexpectedly contains duplicates.
    if len(rows) >= 1000:
        raise AssertionError('Bounded runoff comparison returned too many source rows.')
    frame = pd.DataFrame(rows, columns=columns)
    assert not frame.empty, 'No database observations for the comparison window.'
    assert frame.District_Name.eq(region).all()
    assert frame.Date.ge(start).all() and frame.Date.lt(end).all()
    assert not frame.duplicated(['District_Name', 'Date']).any(), 'Duplicate source district/date observations.'
    for column in columns[2:]:
        frame[column] = pd.to_numeric(frame[column], errors='raise')
    return frame


@contextmanager
def running_api(app):
    """Exercise real HTTP without adding a test-only HTTP client dependency."""
    listener = socket.socket()
    listener.bind(('127.0.0.1', 0))
    base = f'http://127.0.0.1:{listener.getsockname()[1]}'
    server = uvicorn.Server(uvicorn.Config(app, log_level='warning'))
    thread = Thread(target=server.run, kwargs={'sockets': [listener]}, daemon=True)
    thread.start()
    try:
        for _ in range(500):
            if server.started:
                break
            if not thread.is_alive():
                raise RuntimeError('Runoff verification server did not start.')
            sleep(.01)
        else:
            raise RuntimeError('Runoff verification server did not become ready.')
        def get(path):
            try:
                with urlopen(base + path, timeout=180) as response:
                    return response.status, json.load(response)
            except HTTPError as exc:
                return exc.code, json.load(exc)
        yield get
    finally:
        server.should_exit = True
        thread.join(timeout=10)
        listener.close()


def main():
    output = Path(__file__).resolve().parents[1] / 'output' / 'runoff-database'
    output.mkdir(parents=True, exist_ok=True)
    app = FastAPI()
    app.include_router(runoff.router)
    clear_dashboard_cache()
    checks = []

    def request(path):
        started = perf_counter()
        status, payload = get(path)
        duration = round(perf_counter() - started, 3)
        if status != 200:
            raise AssertionError(f'{path}: HTTP {status}: {payload}')
        assert payload['source'] == 'Supabase'
        assert payload['source_mode'] == 'database'
        assert len(payload['source_tables']) == 2
        json.dumps(payload, allow_nan=False)
        checks.append({'path': path, 'http_status': status, 'seconds': duration})
        print(json.dumps(checks[-1]), flush=True)
        return payload

    with running_api(app) as get, patch.object(pd, 'read_csv', side_effect=AssertionError('Runtime runoff CSV reads are forbidden')):
        meta = request('/runoff/metadata')
        assert len(meta['regions']) == 52
        assert meta['default_end'] == '2026-08'
        assert meta['latest_date'] == '2026-09-06'
        assert len(meta['metrics']) == 23
        expected = reference_observations(meta['source_tables'][0], 'City of Tshwane', '2024-02-01', '2024-04-01')
        expected_previous = reference_observations(meta['source_tables'][0], 'City of Tshwane', '2023-02-01', '2023-03-01')
        national = request('/runoff/dashboard')
        district = request('/runoff/dashboard?region=City+of+Tshwane&start=2024-02&end=2024-03')
        assert len(national['map']) == len(district['map']) == 52
        assert len(national['series']) == 24
        assert np.isclose(national['latest']['volume'], np.mean([row['volume'] for row in national['map']]))
        for field, target in {'volume': expected.Daily_Surface_Runoff_Volume_m3_day.sum() / 1e6,
                              'baseflow': expected.Baseflow_Component_m3s.mean(),
                              'peak_flow': expected.Peak_Flow_Rates_m3s.max()}.items():
            assert np.isclose(district['summary'][field], target, rtol=1e-10, atol=1e-7), field
        assert np.isclose(district['series'][0]['previous_volume'], expected_previous.Daily_Surface_Runoff_Volume_m3_day.sum() / 1e6)
        assert district['annual'][0]['selected_months'] == 2
        assert district['coverage']['observed_days'] == expected.Daily_Surface_Runoff_Volume_m3_day.count()
        daily = request('/runoff/daily?region=City+of+Tshwane&month=2024-02')
        assert len(daily['series']) == 29
        forecast = request('/runoff/forecast-source?region=City+of+Tshwane&start=2024-02&end=2024-03')
        assert len(forecast['series']) == 2
        assert np.isclose(forecast['series'][0]['volume'], district['series'][0]['volume'])
        partial = request('/runoff/dashboard?start=2026-09&end=2026-09')
        assert not partial['latest']['complete']
        assert partial['latest']['previous_volume'] is None
        assert partial['coverage']['observed_days'] == 52 * 6
        for path in ['/runoff/dashboard?region=Unknown', '/runoff/daily?month=2024-13']:
            status, _ = get(path)
            assert status in (404, 422)
        warm = request('/runoff/dashboard')
        assert warm == national

    report = {'source': 'Supabase', 'source_tables': meta['source_tables'], 'regions': len(meta['regions']),
              'first_date': meta['first_date'], 'latest_date': meta['latest_date'], 'default_start': meta['default_start'],
              'default_end': meta['default_end'], 'indicators': len(meta['metrics']), 'monthly_source_rows': meta['indicator_rows'],
              'schema': meta['schema'], 'checks': checks, 'runtime_csv_reads': 0,
              'reference_comparison': {'source': 'Independent bounded Supabase query',
                                       'table': meta['source_tables'][0], 'rows': len(expected),
                                       'region': 'City of Tshwane', 'start': '2024-02', 'end': '2024-03',
                                       'volume': district['summary']['volume'], 'baseflow': district['summary']['baseflow'],
                                       'peak_flow': district['summary']['peak_flow'], 'matched': True},
              'national_map_rows': len(district['map']), 'partial_month_observed_days': partial['coverage']['observed_days']}
    (output / 'api-verification.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    print('Live runoff database and API checks passed.', flush=True)


if __name__ == '__main__':
    main()
