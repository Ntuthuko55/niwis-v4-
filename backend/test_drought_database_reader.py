"""Database-only source, paging, error and bounded-window regressions, offline."""
import unittest
from unittest.mock import patch

from app import drought_source as source
from app.dashboard_loader import clear_dashboard_cache


class DroughtDatabaseReaderTests(unittest.TestCase):
    def setUp(self):
        clear_dashboard_cache()
        self.csv = patch('pandas.read_csv', side_effect=AssertionError('Drought CSV read forbidden'))
        self.csv.start()
        self.addCleanup(self.csv.stop)
        self.addCleanup(clear_dashboard_cache)

    def test_pagination_and_cached_copies_preserve_all_rows(self):
        first = [{'id': index} for index in range(1000)]
        final = [{'id': 1000}]
        with patch.object(source, 'postgres_enabled', return_value=False), \
                patch.object(source, '_settings', return_value=('https://test.invalid', 'test', 'unused')), \
                patch.object(source, '_request_page', side_effect=[(first, None), (final, None)]) as read:
            rows = source.read_rows('satellite_remote_sensing', {'select': '*', 'order': 'id.asc'})
            self.assertEqual(len(rows), 1001)
            rows[0]['id'] = -1
            self.assertEqual(source.read_rows('satellite_remote_sensing', {'select': '*', 'order': 'id.asc'})[0]['id'], 0)
            self.assertEqual(read.call_count, 2)
            self.assertEqual(read.call_args_list[1].args[2:], (1000, 1999))

    def test_failed_reads_are_retried_and_never_cached(self):
        with patch.object(source, 'postgres_enabled', return_value=False), \
                patch.object(source, '_settings', return_value=('https://test.invalid', 'test', 'unused')), \
                patch.object(source, '_request_page', side_effect=[source.SupabaseSourceError('offline'), ([], None)]) as read:
            with self.assertRaises(source.SupabaseSourceError):
                source.read_rows('satellite_remote_sensing', {'select': '*'})
            self.assertEqual(source.read_rows('satellite_remote_sensing', {'select': '*'}), [])
            self.assertEqual(read.call_count, 2)

    def test_empty_database_selections_remain_empty(self):
        with patch.object(source, 'postgres_enabled', return_value=False), patch.object(source, 'read_rows', return_value=[]):
            self.assertEqual(source.latest_rows('satellite_remote_sensing'), [])
            self.assertEqual(source.rows_at_date('satellite_remote_sensing', '1990-01'), [])
            self.assertEqual(source.region_history('satellite_remote_sensing', 'Missing district'), [])
            self.assertEqual(source.bounded_rows('satellite_remote_sensing', '1990-01-01', '1990-01-31'), [])

    def test_socket_failures_propagate_from_every_reader(self):
        error = source.SupabaseSourceError('WinError 10013: forbidden by its access permissions')
        with patch.object(source, 'postgres_enabled', return_value=False), patch.object(source, 'read_rows', side_effect=error):
            for call in [lambda: source.latest_rows('satellite_remote_sensing'),
                         lambda: source.rows_at_date('satellite_remote_sensing', '2025-01'),
                         lambda: source.region_history('satellite_remote_sensing', 'Alfred Nzo'),
                         lambda: source.bounded_rows('satellite_remote_sensing', '2025-01-01', '2025-12-31')]:
                with self.assertRaises(source.SupabaseSourceError):
                    call()

    def test_region_aliases_use_the_database_district_label(self):
        latest = [{'district_name': 'City Of Tshwane'}, {'district_name': 'Eden'}]
        with patch.object(source, 'postgres_enabled', return_value=False), \
                patch.object(source, 'latest_rows', return_value=latest), patch.object(source, 'read_rows', return_value=[]) as read:
            source.region_history('satellite_remote_sensing', 'CITY OF TSHWANE')
            self.assertEqual(read.call_args.args[1]['district_name'], 'eq.City Of Tshwane')
            source.region_history('satellite_remote_sensing', 'Garden Route')
            self.assertEqual(read.call_args.args[1]['district_name'], 'eq.Eden')

    def test_daily_national_windows_are_contiguous_and_bounded(self):
        calls = []
        def read(table, params):
            calls.append(params)
            return [{'date': params['date'][4:]}]
        with patch.object(source, 'read_rows', side_effect=read):
            rows = source.bounded_rows('meteorological_drought_master', '2024-01-01', '2024-01-31')
        self.assertEqual(len(rows), 3)
        self.assertEqual({(p['date'], p['and']) for p in calls}, {
            ('gte.2024-01-01', '(date.lt.2024-01-15)'),
            ('gte.2024-01-15', '(date.lt.2024-01-29)'),
            ('gte.2024-01-29', '(date.lt.2024-02-01)'),
        })
        self.assertTrue(all('district_name' not in params for params in calls))

    def test_monthly_national_reads_use_one_year_window(self):
        with patch.object(source, 'read_rows', return_value=[]) as read:
            source.bounded_rows('hydrological_drought_master', '2025-01-01', '2025-12-31')
            self.assertEqual(read.call_count, 1)
            self.assertEqual(read.call_args.args[1]['and'], '(date.lt.2026-01-01)')

    def test_invalid_tables_and_reversed_windows_are_rejected(self):
        for call in [lambda: source.read_rows('other_table', {}),
                     lambda: source.latest_rows('other_table'),
                     lambda: source.region_history('other_table', 'Alfred Nzo'),
                     lambda: source.bounded_rows('other_table', '2025-01-01', '2025-02-01')]:
            with self.assertRaises(source.SupabaseSourceError):
                call()
        with self.assertRaises(ValueError):
            source.bounded_rows('satellite_remote_sensing', '2025-02-01', '2025-01-01')


if __name__ == '__main__':
    unittest.main()
