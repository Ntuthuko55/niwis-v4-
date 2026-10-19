"""Regression checks for shared caching and bounded monitoring reads, offline."""
import asyncio
import json
import re
import unittest
from concurrent.futures import ThreadPoolExecutor
from threading import Event
from urllib.parse import parse_qs, urlparse
from unittest.mock import patch

import numpy as np
import pandas as pd

from app import dashboard_loader as cache
from app import reservoir_service as reservoirs
from app.dashboard_response_cache import DashboardResponseCache


class ResponseCacheTests(unittest.IsolatedAsyncioTestCase):
    async def request(self, middleware, query=b'', headers=None):
        output = []
        async def receive():
            return {'type': 'http.request', 'body': b'', 'more_body': False}
        async def send(message):
            output.append(message)
        await middleware({'type': 'http', 'method': 'GET', 'path': '/climate/dashboard',
                          'query_string': query, 'headers': headers or []}, receive, send)
        return output

    async def test_simultaneous_requests_share_serialized_result_and_query_order(self):
        calls = []
        async def app(scope, receive, send):
            calls.append(scope)
            await asyncio.sleep(.01)
            await send({'type': 'http.response.start', 'status': 200,
                        'headers': [(b'content-type', b'application/json')]})
            await send({'type': 'http.response.body', 'body': b'{"source":"Supabase","value":1}'})
        middleware = DashboardResponseCache(app, ttl=30)
        results = await asyncio.gather(*(self.request(middleware, b'end=2025&start=2018') for _ in range(8)))
        await self.request(middleware, b'start=2018&end=2025')
        self.assertEqual(len(calls), 1)
        self.assertEqual(len(middleware.inflight), 0)
        self.assertEqual({result[-1]['body'] for result in results}, {b'{"source":"Supabase","value":1}'})
        self.assertTrue(any(dict(result[0]['headers'])[b'x-niwis-cache'] == b'HIT' for result in results))

    async def test_errors_auth_and_oversized_responses_are_not_cached(self):
        calls = []
        status = [503]
        async def app(scope, receive, send):
            calls.append(scope)
            await send({'type': 'http.response.start', 'status': status[0],
                        'headers': [(b'content-type', b'application/json')]})
            await send({'type': 'http.response.body', 'body': b'{"data":"long response"}'})
        middleware = DashboardResponseCache(app, ttl=30, max_response_bytes=8)
        await self.request(middleware)
        await self.request(middleware)
        status[0] = 200
        await self.request(middleware)
        await self.request(middleware)
        self.assertEqual(len(calls), 4)
        self.assertFalse(middleware.entries)
        middleware = DashboardResponseCache(app, ttl=30)
        await self.request(middleware, headers=[(b'authorization', b'Bearer test')])
        await self.request(middleware, headers=[(b'authorization', b'Bearer test')])
        self.assertFalse(middleware.entries)


class SourceCacheTests(unittest.TestCase):
    def tearDown(self):
        cache.clear_dashboard_cache()

    def test_copies_remain_isolated_and_unrelated_keys_do_not_wait_for_copy(self):
        entered, release = Event(), Event()
        class SlowCopy:
            slow = False
            def __deepcopy__(self, memo):
                if self.slow:
                    entered.set()
                    self.assert_release = release.wait(2)
                return self
        item = SlowCopy()
        cache.cached_call('copy-test', 1, loader=lambda: item)
        item.slow = True
        with ThreadPoolExecutor(max_workers=2) as executor:
            slow = executor.submit(cache.cached_call, 'copy-test', 1, loader=lambda: None)
            self.assertTrue(entered.wait(1))
            fast = executor.submit(cache.cached_call, 'other-key', 2, loader=lambda: {'rows': [1]})
            value = fast.result(timeout=.5)
            release.set()
            slow.result(timeout=1)
        value['rows'].append(2)
        self.assertEqual(cache.cached_call('other-key', 2, loader=lambda: None), {'rows': [1]})


class BoundedSourceTests(unittest.TestCase):
    def test_reservoir_boundary_retries_transient_timeouts_only(self):
        snapshot = {'base': 'https://test.invalid', 'table': '8_1_reservoir_operational_master', 'key': 'test'}
        params = {'select': 'date', 'order': 'date.asc', 'limit': '1'}
        with patch.object(reservoirs, '_request_page', side_effect=[
                reservoirs.SupabaseSourceError('57014 statement timeout'), ([{'date': '2024-01-01'}], None)]) as request, \
                patch.object(reservoirs, 'sleep'):
            self.assertEqual(reservoirs._boundary_rows(snapshot, params), [{'date': '2024-01-01'}])
            self.assertEqual(request.call_count, 2)
        for message, attempts in [('57014 statement timeout', 3), ('invalid source column', 1)]:
            with patch.object(reservoirs, '_request_page', side_effect=reservoirs.SupabaseSourceError(message)) as request, \
                    patch.object(reservoirs, 'sleep'):
                with self.assertRaises(reservoirs.SupabaseSourceError):
                    reservoirs._boundary_rows(snapshot, params)
                self.assertEqual(request.call_count, attempts)

    def test_failed_remote_windows_use_one_scoped_configured_fallback(self):
        from app import drought_source as source
        local = [
            {'district_name': 'City of Tshwane', 'date': '2024-01-01', '_niwis_source': 'local_csv_fallback'},
            {'district_name': 'City of Tshwane', 'date': '2024-02-01', '_niwis_source': 'local_csv_fallback'},
            {'district_name': 'Vhembe', 'date': '2024-01-01', '_niwis_source': 'local_csv_fallback'},
        ]
        with patch.object(source, 'read_rows', side_effect=source.SupabaseSourceError('offline')), \
                patch.object(source, '_local_rows', return_value=local), \
                patch.object(source, '_can_use_local', return_value=True):
            rows = source.bounded_rows('hydrological_drought_master', '2024-01-01', '2024-01-31', 'City of Tshwane')
        self.assertEqual(rows, local[:1])
        with patch.object(source, 'read_rows', side_effect=source.SupabaseSourceError('offline')), \
                patch.object(source, '_local_rows') as fallback, \
                patch.object(source, '_can_use_local', return_value=False):
            with self.assertRaises(source.SupabaseSourceError):
                source.bounded_rows('hydrological_drought_master', '2024-01-01', '2024-01-31')
            fallback.assert_not_called()

    def test_postgres_bounds_are_both_bound_and_identifiers_quoted(self):
        from contextlib import contextmanager
        from app import postgres_source as source
        recorded = []
        class Session:
            def execute(self, sql, values):
                recorded.append((str(sql), values))
                return self
            def mappings(self): return self
            def all(self): return []
        @contextmanager
        def session():
            yield Session()
        with patch.object(source, 'session_scope', session), \
                patch.object(source, '_require_sqlalchemy', return_value=lambda sql: sql):
            source.read_rows_from_rest_params('4_1_temperature_change_master', {
                'select': 'Date,District_Name,Tavg_C', 'Date': 'gte.2024-01-01',
                'and': '(Date.lt.2025-01-01)', 'order': 'Date.asc', 'limit': '1000',
            })
        sql, values = recorded[0]
        self.assertIn('SELECT "Date", "District_Name", "Tavg_C"', sql)
        self.assertIn('public."4_1_temperature_change_master"', sql)
        self.assertIn('"Date" >= :filter_0', sql)
        self.assertIn('"Date" < :filter_1', sql)
        self.assertEqual(values['filter_0'], '2024-01-01')
        self.assertEqual(values['filter_1'], '2025-01-01')


class ReservoirBoundedTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.raw = []
        for name in ('City of Tshwane', 'Vhembe', 'Z F Mgcawu'):
            for index, date in enumerate(pd.date_range('2021-01-01', '2024-03-31')):
                stock = (250 + index * .01) * 1e6 if name == 'City of Tshwane' else 200e6
                cls.raw.append({'district_id': name, 'district_name': name, 'province': 'Test',
                    'dam_name': name + ' Reservoir', 'river': 'Test river', 'date': str(date.date()),
                    'storage_volume_m3': stock, 'pct_fsc': 40 if name == 'Vhembe' else 80,
                    'fsl_m_amsl': 1200, 'water_level_m_amsl': 1199, 'inflow_m3_s': 3,
                    'outflow_m3_s': 2, 'evaporation_mm_day': 5, 'seepage_m3_day': 6,
                    'rainfall_mm_day': 7, 'runoff_mm_day': 2, 'district_area_km2': 100,
                    'water_area_km2': 10, 'mean_ndwi': -.25})

    def setUp(self):
        cache.clear_dashboard_cache()
        self.queries = []
        self.settings = patch.object(reservoirs, '_settings', return_value=('https://test.invalid', 'test-key', 'unused'))
        self.transport = patch.object(reservoirs, '_request_page', side_effect=self.request_page)
        self.settings.start(); self.transport.start()
        self.addCleanup(self.settings.stop); self.addCleanup(self.transport.stop)

    def request_page(self, url, key, start=0, end=0, count_exact=False):
        query = {key: values[0] for key, values in parse_qs(urlparse(url).query).items()}
        self.queries.append((query, count_exact))
        rows = self.raw
        if query.get('district_name', '').startswith('eq.'):
            rows = [row for row in rows if row['district_name'] == query['district_name'][3:]]
        if 'date' in query:
            operator, value = query['date'].split('.', 1)
            compare = {'eq': lambda x: x == value, 'gte': lambda x: x >= value, 'lte': lambda x: x <= value}[operator]
            rows = [row for row in rows if compare(row['date'])]
        for operator, value in re.findall(r'date\.(lt|lte)\.([\d-]+)', query.get('and', '')):
            rows = [row for row in rows if row['date'] <= value] if operator == 'lte' else [row for row in rows if row['date'] < value]
        if 'or' in query:
            intervals = re.findall(r'and\(([^()]+)\)', query['or'])
            def matches(row):
                for interval in intervals:
                    predicates = re.findall(r'date\.(gte|lte|lt)\.([\d-]+)', interval)
                    if all((row['date'] >= value if op == 'gte' else row['date'] <= value if op == 'lte' else row['date'] < value) for op, value in predicates):
                        return True
                return False
            rows = [row for row in rows if matches(row)]
        for part in reversed(query.get('order', '').split(',')):
            if part:
                column, direction = part.split('.')[:2]
                rows = sorted(rows, key=lambda row: row[column], reverse=direction == 'desc')
        total = len(rows)
        if 'limit' in query:
            rows = rows[:int(query['limit'])]
        rows = rows[start:end + 1]
        if query.get('select') != '*':
            selected = query['select'].split(',')
            rows = [{column: row[column] for column in selected} for row in rows]
        return rows, f'{start}-{start + len(rows) - 1}/{total}' if count_exact else None

    def test_page_load_never_scans_full_table_and_preserves_national_map(self):
        with patch.object(reservoirs, '_read_all', side_effect=AssertionError('Full scan forbidden')):
            meta = reservoirs.metadata(as_of='2024-03-31')
            self.assertEqual(meta['groups'], 3)
            self.assertIsNone(meta['rows'])
            result = reservoirs.dashboard(region='City of Tshwane', start='2024-03-01', end='2024-03-31', as_of='2024-03-31')
        self.assertEqual(len(result['series']), 31)
        self.assertEqual(len(result['map']), 3)
        self.assertEqual(result['source'], 'Supabase')
        self.assertIsNone(result['indicators']['dir'])
        source = reservoirs.prepare(pd.DataFrame(self.raw))
        history = source[source.district_name.eq('City of Tshwane')]
        expected = reservoirs.clean(reservoirs.derived_indicators(history, pd.Timestamp('2024-03-31')))
        for key in ('rsi', 'monthly_storage_change', 'weekly_level_change', 'drawdown'):
            self.assertAlmostEqual(result['indicators'][key], expected[key], places=7)
        self.assertFalse(any(exact for _, exact in self.queries))
        for query, _ in self.queries:
            self.assertTrue('limit' in query or 'date' in query or 'or' in query, query)
        json.dumps(result, allow_nan=False)

    def test_national_means_and_period_validation(self):
        data = reservoirs.dashboard(region='National', start='2024-03-31', end='2024-03-31', as_of='2024-03-31')
        self.assertAlmostEqual(data['latest']['storage'], np.mean([row['storage'] for row in data['map']]), places=7)
        self.assertEqual(data['alerts'][0]['District_Name'], 'Vhembe')
        self.assertIsNone(data['indicators']['rsi'])
        for filters in ({'region': 'Unknown'}, {'start': '2024-03-31', 'end': '2024-03-01'}, {'end': '2024-04-01'}):
            from fastapi import HTTPException
            with self.assertRaises(HTTPException):
                reservoirs.dashboard(as_of='2024-03-31', **filters)


if __name__ == '__main__':
    unittest.main()
