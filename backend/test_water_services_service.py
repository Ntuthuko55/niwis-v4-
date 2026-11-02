"""Section 18 scope isolation, invalid-source handling and cache recovery."""
import asyncio
import unittest
from unittest.mock import patch

from fastapi import FastAPI, HTTPException
from scripts.asgi_probe import get_json

from app.dashboard_response_cache import DashboardResponseCache
from app.supabase_source import SupabaseSourceError
from app.water_services_service import ALL, KINDS, METRICS, _prepare, _dashboard_value, _read_table, router


def row(kind='access', region='Region A', year=2026, value=10, category='Total'):
    base = {metric[3]: value for metric in METRICS[kind]}
    if kind == 'access':
        return {**base, 'Region': region, 'Time Frame': f'April {year}', 'Category': category}
    if kind == 'operations':
        return {**base, 'Region': region, 'Standardized_Year': year, 'Time Frame': f'{year}/{str(year + 1)[-2:]}',
                'Pipe_Age_Profile_pct_by_decade': 'Pre-1980: 20%, 1980-1999: 40%, 2000+: 40%',
                'Non_Revenue_Water_Percentage_pct': '4\u00a0982.00'}
    return {**base, 'district_name': region, 'Year': year}


def data(kind='access', rows=None):
    return _prepare(rows if rows is not None else [row(kind)], kind, 'test_source')


class WaterServicesTests(unittest.TestCase):
    def tearDown(self):
        _read_table.cache_clear()

    def test_total_and_urban_are_never_added_and_overview_is_not_national_total(self):
        source = data(rows=[row(value=10), row(region='Region B', value=30), row(value=90, category='Urban')])
        result = _dashboard_value(source, 'access')
        self.assertEqual(result['latest']['total_households'], 20)
        self.assertEqual(result['latest_counts']['total_households'], 2)
        self.assertEqual(_dashboard_value(source, 'access', category='Urban')['latest']['total_households'], 90)
        self.assertEqual(_dashboard_value(source, 'access', region='Region A')['latest']['total_households'], 10)

    def test_national_source_row_is_separate_from_regional_means(self):
        source = data('operations', [row('operations', value=10), row('operations', region='Region B', value=30), row('operations', region='National', value=90)])
        result = _dashboard_value(source, 'operations')
        self.assertEqual(result['latest']['production'], 20)
        self.assertEqual(len(result['comparison']), 2)
        self.assertEqual(_dashboard_value(source, 'operations', region='National')['latest']['production'], 90)

    def test_nonfinite_out_of_range_and_negative_physical_values_are_missing(self):
        record = row('operations')
        record.update({'Computed_NRW_Percentage': 101, 'Daily_Unplanned_Supply_Interruptions_events_per_day': '-Infinity',
                       'Physical_Losses_Real_Losses_m3_day': -5, 'Average_Duration_Of_Outages_hours_per_event': True,
                       'Load_Shedding_Induced_Interruptions_hours_per_day': 0})
        source = data('operations', [record])
        result = _dashboard_value(source, 'operations')
        for key in ('nrw_pct', 'interruptions', 'physical_losses', 'outage_duration'):
            self.assertIsNone(result['latest'][key])
        self.assertEqual(result['latest']['load_shedding'], 0)
        self.assertEqual(source['audit']['invalid_measurements'], 4)
        self.assertEqual(source['audit']['legacy_nrw_out_of_range_rows'], 1)

    def test_signed_pdsi_preserved_without_classification(self):
        record = row('eo')
        record['Drought_Severity_PDSI'] = -196.43
        result = _dashboard_value(data('eo', [record]), 'eo')
        self.assertEqual(result['latest']['pdsi'], -196.43)
        self.assertNotIn('drought_class', result)

    def test_missing_years_and_end_year_measurements_are_not_filled(self):
        latest = row(year=2026)
        latest['Reliable Water Percentage'] = None
        source = data(rows=[row(year=2024), latest, row(region='Region B', year=2024)])
        result = _dashboard_value(source, 'access', start=2024, end=2026)
        self.assertIsNone(result['series'][1]['rdp_pct'])
        self.assertIsNone(result['latest']['reliable_pct'])
        self.assertIsNone(next(item for item in result['comparison'] if item['region'] == 'Region B')['rdp_pct'])
        self.assertEqual(result['latest_counts']['reliable_pct'], 0)

    def test_reported_timeframes_preserved_and_trimmed_regions_match(self):
        source = data('operations', [row('operations', region='Region A ', year=2004)])
        result = _dashboard_value(source, 'operations', region='Region A')
        self.assertEqual(result['series'][0]['source_periods'], '2004/05')
        self.assertIn('1980-1999', result['profiles'][0]['pipe_profile'])

    def test_description_row_excluded_but_invalid_reporting_rows_rejected(self):
        descriptive = row(region='<b>Subject area</b>')
        descriptive['Time Frame'] = None
        source = data(rows=[row(), descriptive])
        self.assertEqual(source['audit']['excluded_description_rows'], 1)
        self.assertEqual(source['audit']['rows'], 1)
        with self.assertRaises(SupabaseSourceError):
            data(rows=[{**row(), 'Time Frame': 'invalid'}])
        with self.assertRaises(SupabaseSourceError):
            data(rows=[row(), row()])
        with self.assertRaises(SupabaseSourceError):
            data('operations', [row('operations'), row('operations', region='Region A ')])

    def test_counts_are_not_forced_to_reconcile_with_household_totals(self):
        source = data(rows=[row()])
        result = _dashboard_value(source, 'access')
        self.assertEqual(source['audit']['access_counts_exceed_total_rows'], 1)
        self.assertEqual(result['latest']['dwelling_households'], 10)
        self.assertEqual(result['latest']['yard_households'], 10)
        self.assertEqual(result['latest']['standpipe_households'], 10)

    def test_no_data_selection_and_filter_validation(self):
        source = data(rows=[row(year=2024), row(year=2026, category='Urban')])
        self.assertTrue(_dashboard_value(source, 'access', category='Urban', start=2024, end=2024)['empty'])
        for kwargs in ({'region': 'Unknown'}, {'category': 'Unknown'}, {'start': 2026, 'end': 2024}, {'start': 1900}):
            with self.assertRaises(HTTPException) as error:
                _dashboard_value(source, 'access', **kwargs)
            self.assertEqual(error.exception.status_code, 400)

    def test_reader_respects_server_page_cap_and_retries_incomplete_pages(self):
        rows = [row(region=str(i)) for i in range(7)]

        def request(url, key, start, end, count_exact=False):
            return rows[start:min(end + 1, start + 2)], '0-1/7' if count_exact else None

        def incomplete(url, key, start, end, count_exact=False):
            return (rows[:2], '0-1/7') if count_exact else ([], None)

        with patch('app.water_services_service._request_page', side_effect=incomplete):
            with self.assertRaises(SupabaseSourceError):
                _read_table('https://example.invalid', 'test', 'table', 'access')
        with patch('app.water_services_service._request_page', side_effect=request) as fetch:
            self.assertEqual(len(_read_table('https://example.invalid', 'test', 'table', 'access')), 7)
            calls = fetch.call_count
            self.assertEqual(len(_read_table('https://example.invalid', 'test', 'table', 'access')), 7)
            self.assertEqual(fetch.call_count, calls)

    def test_http_cache_recovers_after_source_error_and_reuses_success(self):
        app = FastAPI()
        app.include_router(router)
        app.add_middleware(DashboardResponseCache)

        async def requests():
            return [await get_json(app, '/water-services/dashboard') for _ in range(3)]

        with patch('app.water_services_service._load', side_effect=[SupabaseSourceError('offline'), data()]) as loader:
            failure, restored, cached = asyncio.run(requests())
        self.assertEqual(failure.status_code, 502)
        self.assertEqual(restored.status_code, 200)
        self.assertEqual(cached.headers['x-niwis-cache'], 'HIT')
        self.assertEqual(loader.call_count, 2)

    def test_partial_metadata_stays_usable_and_is_not_cached(self):
        app = FastAPI()
        app.include_router(router)
        app.add_middleware(DashboardResponseCache)
        sources = {kind: data(kind) for kind in KINDS}

        def partial(kind):
            if kind == 'operations':
                raise SupabaseSourceError('offline')
            return sources[kind]

        async def requests():
            with patch('app.water_services_service._load', side_effect=partial):
                first = await get_json(app, '/water-services/metadata')
            with patch('app.water_services_service._load', side_effect=lambda kind: sources[kind]):
                restored = await get_json(app, '/water-services/metadata')
            return first, restored

        first, restored = asyncio.run(requests())
        self.assertEqual(set(first.json()['sections']), {'access', 'eo'})
        self.assertEqual(set(restored.json()['sections']), set(KINDS))
        self.assertEqual(restored.headers['x-niwis-cache'], 'MISS')
        self.assertTrue(all(item['status'] == 'Unavailable' for item in restored.json()['reliability']))


if __name__ == '__main__':
    unittest.main()
