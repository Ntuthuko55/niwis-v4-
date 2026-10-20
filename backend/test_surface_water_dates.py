"""Offline checks for month-scoped catchment characteristics."""
import unittest
from urllib.parse import parse_qs, urlparse
from unittest.mock import patch

import pandas as pd

from app import surface_water_service as surface
from app.supabase_source import SupabaseSourceError


class CatchmentDateTests(unittest.TestCase):
    def setUp(self):
        with surface._READ_CACHE_LOCK:
            surface._READ_CACHE.clear()
        self.rows = [self.row('Alpha', '2024-01-01', 10), self.row('Alpha', '2024-02-01', 20),
                     self.row('Alpha', '2024-03-01', 999), self.row('Beta', '2024-01-01', 5),
                     self.row('Beta', '2024-02-01', 6)]
        columns = list(self.rows[0])
        self.snapshot = {'base': 'https://surface.test.invalid', 'key': 'test-key',
                         'tables': {'catchments': '9_2_catchment_characteristics_master'},
                         'date': {'catchments': 'date'}, 'district': {'catchments': 'district_name'},
                         'columns': {'catchments': columns},
                         'catchment_actual': {name: name for name, _ in surface.LAND}}
        self.queries = []
        transport = patch.object(surface, '_request_page', side_effect=self.request)
        transport.start()
        self.addCleanup(transport.stop)

    def row(self, district, date, area):
        return {'date': date, 'district_name': district, 'catchment_area_km2': area,
                'dominant_hsg': 'A', 'hsg_a_pct': 100, **{key: 20 for key, _ in surface.LAND}}

    def request(self, url, key, start=0, end=999, count_exact=False):
        params = {name: values[0] for name, values in parse_qs(urlparse(url).query).items()}
        self.queries.append(params)
        self.assertFalse(count_exact)
        rows = self.rows
        if self.snapshot['date']['catchments']:
            self.assertIn('date', params, 'Dated catchment reads must have a lower date bound')
            self.assertIn('and', params, 'Dated catchment reads must have an upper date bound')
            lower = params['date'].removeprefix('gte.')
            upper = params['and'].removeprefix('(date.lt.').removesuffix(')')
            rows = [row for row in rows if lower <= row['date'] < upper]
        selected = params['select'].split(',')
        return [{column: row.get(column) for column in selected} for row in rows[start:end + 1]], None

    def test_selected_month_and_cache_do_not_use_future_attributes(self):
        january = surface._read_catchments(self.snapshot, '2024-01')
        february = surface._read_catchments(self.snapshot, '2024-02')
        self.assertEqual(january.loc[january.district_name.eq('Alpha'), 'catchment_area_km2'].iloc[0], 10)
        self.assertEqual(february.loc[february.district_name.eq('Alpha'), 'catchment_area_km2'].iloc[0], 20)
        self.assertTrue(pd.api.types.is_datetime64_any_dtype(january.date))
        surface._read_catchments(self.snapshot, '2024-01')
        self.assertEqual(len(self.queries), 2, 'Cache keys must distinguish months and reuse an identical month')

    def test_national_profile_uses_one_snapshot_per_district(self):
        frame = surface._read_catchments(self.snapshot, '2024-01')
        profile, coverage = surface._catchment_profile(frame, 'National', '2024-01', ['Alpha', 'Beta'])
        self.assertEqual(profile['catchment_area_km2'], 7.5)
        self.assertEqual(profile['land_cover_sum'], 160)
        self.assertFalse(profile['land_cover_valid_partition'])
        self.assertEqual(coverage['month'], '2024-01')
        self.assertEqual(coverage['districts'], 2)
        self.assertEqual(coverage['first_date'], '2024-01-01')
        self.assertEqual(coverage['missing_districts'], [])

    def test_missing_month_is_unavailable_without_cross_month_filling(self):
        frame = surface._read_catchments(self.snapshot, '2024-04')
        profile, coverage = surface._catchment_profile(frame, 'National', '2024-04', ['Alpha', 'Beta'])
        self.assertTrue(pd.isna(profile['catchment_area_km2']))
        self.assertTrue(pd.isna(profile['land_cover_sum']))
        self.assertEqual(coverage['districts'], 0)
        self.assertEqual(coverage['missing_districts'], ['Alpha', 'Beta'])
        self.assertIsNone(coverage['first_date'])

    def test_latest_snapshot_within_month_is_used(self):
        self.rows.append(self.row('Alpha', '2024-02-15', 30))
        frame = surface._read_catchments(self.snapshot, '2024-02')
        profile, coverage = surface._catchment_profile(frame, 'Alpha', '2024-02', ['Alpha', 'Beta'])
        self.assertEqual(profile['catchment_area_km2'], 30)
        self.assertEqual(coverage['last_date'], '2024-02-15')

    def test_conflicting_same_date_is_rejected(self):
        self.rows.append(self.row('Alpha', '2024-01-01', 999))
        with self.assertRaisesRegex(SupabaseSourceError, 'Conflicting catchment'):
            surface._read_catchments(self.snapshot, '2024-01')

    def test_dated_reader_requires_a_bounded_month(self):
        with self.assertRaisesRegex(SupabaseSourceError, 'Choose a month'):
            surface._read_catchments(self.snapshot)
        self.assertEqual(self.queries, [])

    def test_explicit_legacy_undated_source_remains_supported(self):
        self.snapshot['date']['catchments'] = None
        self.rows = [self.rows[0], self.rows[3]]
        frame = surface._read_catchments(self.snapshot)
        profile, coverage = surface._catchment_profile(frame, 'Alpha', '2024-01', ['Alpha', 'Beta'])
        self.assertEqual(profile['catchment_area_km2'], 10)
        self.assertIsNone(coverage['month'])

    def test_surface_water_table_selection_preserves_other_module_entries(self):
        tables = ','.join([*surface.DEFAULT_TABLES, '11_1_hydrogeological', '12.1_physical_water_quality_master'])
        with patch.dict('os.environ', {surface.TABLE_ENV: tables}):
            self.assertEqual(surface._configured_tables(), surface.DEFAULT_TABLES)


if __name__ == '__main__':
    unittest.main()
