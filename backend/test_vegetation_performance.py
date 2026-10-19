"""Vegetation monthly-cache, query scope and calculation parity, offline."""
import json
import unittest
from urllib.parse import parse_qs, urlparse
from unittest.mock import patch

import numpy as np
import pandas as pd
from fastapi import HTTPException

from app import vegetation_service as service
from app.dashboard_loader import cached_call, cached_result, clear_dashboard_cache


class VegetationPerformanceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        names = ['City of Tshwane', 'Vhembe']
        dates = pd.date_range('2019-01-01', '2026-09-06').difference(pd.DatetimeIndex(['2024-02-29']))
        cls.daily = pd.DataFrame([
            {'District_Name': name, 'Date': day, **{
                key: (index + 1) * .01 + day.month * .02 + day.day * .001 + day.year * .0001 + region * .1
                for index, key in enumerate(service.SAT_KEYS)}}
            for region, name in enumerate(names) for day in dates])
        cls.daily['EVI'] = np.nan
        cls.drivers = pd.DataFrame([
            {'District_Name': name, 'month': str(month), **{
                key: 10 + index + month.month * 2 + month.year * .01 + region
                for index, key in enumerate(service.DRIVER_KEYS)}}
            for region, name in enumerate(names) for month in pd.period_range('2019-01', '2026-09', freq='M')])
        cls.meta = {'regions': names, 'months': [str(month) for month in pd.period_range('2019-01', '2026-09', freq='M')],
                    'default_start': '2024-09', 'default_end': '2026-08', 'latest_daily_date': '2026-09-06',
                    'source_tables': ['satellite', 'drivers'], 'constant_metrics': [],
                    'metrics': [{'key': key} for key in service.ALL_KEYS]}
        cls.snapshot = {'base': 'https://test.invalid', 'key': 'test', 'tables': {'satellite': 'satellite', 'drivers': 'drivers'},
                        'region_columns': {'satellite': 'District_Name', 'drivers': 'District_Name'},
                        'date_column': 'Date', 'year_column': 'Year', 'month_column': 'Month',
                        'sat_keys': service.SAT_KEYS, 'driver_keys': service.DRIVER_KEYS}

    def setUp(self):
        clear_dashboard_cache()
        self.reads = []
        for item in [patch.object(service, '_snapshot', return_value=self.snapshot),
                     patch.object(service, '_metadata', return_value=self.meta),
                     patch.object(service, '_read_satellite', side_effect=self.read_satellite),
                     patch.object(service, '_read_drivers', side_effect=self.read_drivers)]:
            item.start(); self.addCleanup(item.stop)
        self.addCleanup(clear_dashboard_cache)

    def read_satellite(self, snapshot, start, end, region, keys):
        self.reads.append(('satellite' if len(keys) > 1 else 'baseline', start, end, region))
        frame = self.daily[self.daily.Date.between(pd.Period(start, 'M').start_time, pd.Period(end, 'M').end_time)]
        if region: frame = frame[frame.District_Name.eq(region)]
        return frame[['District_Name', 'Date', *keys]].copy()

    def read_drivers(self, snapshot, start, end, region, keys):
        self.reads.append(('drivers', start, end, region))
        frame = self.drivers[self.drivers.month.between(start, end)]
        if region: frame = frame[frame.District_Name.eq(region)]
        return frame[['District_Name', 'month', *keys]].copy()

    def test_compact_series_and_comparisons_match_full_daily_calculation(self):
        raw = service._combined_monthly(self.daily, self.drivers, service.SAT_KEYS, service.DRIVER_KEYS)
        for region in ['National', 'City of Tshwane']:
            expected, deltas = service.comparisons(service.regional_series(raw, region), '2024-01', '2025-12')
            actual = service.dashboard(region, '2024-01', '2025-12', lag=3)
            self.assertEqual(actual['series'], service._clean(expected.reset_index().to_dict('records')))
            self.assertEqual(actual['deltas'], service._clean(deltas))
            for key in service.ALL_KEYS:
                value = service._clean(expected[key].mean())
                self.assertEqual(actual['summary'][key], value)
            self.assertEqual(actual['coverage']['complete_months'], 23)
            self.assertTrue(all(row['pairs'] >= 12 for row in actual['correlations']))
            json.dumps(actual, allow_nan=False)

    def test_map_reads_only_selected_years_without_drivers_or_baselines(self):
        with patch.object(service, 'comparisons', side_effect=AssertionError('Map must not calculate baselines')):
            result = service.map_data(start='2025-08', end='2025-08')
        self.assertEqual(self.reads, [('satellite', '2025-01', '2025-12', None)])
        expected = service.aggregate_satellite(self.daily)
        expected = expected[expected.month.eq('2025-08')].set_index('District_Name')
        for row in result['map']:
            self.assertAlmostEqual(row[service.SAT_KEYS[0]], expected.loc[row['District_Name'], service.SAT_KEYS[0]])
        self.assertEqual(len(result['ranking']), 2)

    def test_national_cache_reused_by_district_lag_map_and_forecast(self):
        service.dashboard(start='2024-09', end='2026-08', include_map=False)
        count = len(self.reads)
        service.dashboard('City of Tshwane', '2024-09', '2026-08', lag=3, include_map=False)
        service.map_data(start='2025-01', end='2025-12')
        forecast = service.forecast_source('Vhembe', '2024-09', '2026-08')
        self.assertEqual(len(self.reads), count)
        self.assertEqual(len(forecast['series']), 24)

    def test_district_chart_can_skip_all_national_reads(self):
        result = service.dashboard('City of Tshwane', '2025-01', '2025-12', include_map=False)
        self.assertTrue(self.reads)
        self.assertTrue(all(row[3] == 'City of Tshwane' for row in self.reads))
        self.assertEqual(result['map'], [])
        self.assertEqual(result['ranking'], [])

    def test_older_baseline_years_read_only_ndvi_and_no_weather(self):
        service.dashboard(start='2024-09', end='2026-08', include_map=False)
        old = [row for row in self.reads if row[1] < '2023-01']
        self.assertTrue(old)
        self.assertTrue(all(row[0] == 'baseline' for row in old))

    def test_map_retains_missing_district_with_null_values(self):
        meta = {**self.meta, 'regions': self.meta['regions'] + ['Missing district']}
        with patch.object(service, '_metadata', return_value=meta):
            result = service.map_data(region='City of Tshwane', start='2025-01', end='2025-01')
        missing = next(row for row in result['map'] if row['District_Name'] == 'Missing district')
        self.assertIsNone(missing['NDVI_10day_composite'])
        self.assertIsNone(missing['months'])
        self.assertEqual(len(result['map']), 3)
        self.assertEqual(len(result['ranking']), 2)

    def test_partial_month_excluded_from_comparison_and_correlation(self):
        result = service.dashboard(start='2026-09', end='2026-09', include_map=False)
        self.assertEqual(result['coverage']['observed_days'], 12)
        self.assertEqual(result['coverage']['expected_days'], 60)
        self.assertEqual(result['coverage']['complete_months'], 0)
        self.assertIsNone(result['deltas']['NDVI_10day_composite']['difference'])
        self.assertIsNone(result['summary']['EVI'])
        self.assertTrue(all(row['pairs'] == 0 and row['r'] is None for row in result['correlations']))

    def test_compact_year_errors_are_not_cached(self):
        with patch.object(service, '_read_satellite', side_effect=service.SupabaseSourceError('unavailable')):
            with self.assertRaises(service.SupabaseSourceError):
                service._monthly_year(self.snapshot, 2025, None, 'satellite')
        self.assertFalse(service._monthly_year(self.snapshot, 2025, None, 'satellite').empty)

    def test_validation_before_query(self):
        for kwargs in [{'region': 'Unknown'}, {'start': '2025-13'}, {'start': '2026-01', 'end': '2020-01'}, {'lag': 9}, {'indicator': 'invented'}]:
            with self.assertRaises(HTTPException): service.map_data(**kwargs)
        self.assertFalse(self.reads)

    def test_cache_peek_is_isolated_and_does_not_load(self):
        self.assertIsNone(cached_result('vegetation-test', 1))
        cached_call('vegetation-test', 1, loader=lambda: {'rows': [1]})
        value = cached_result('vegetation-test', 1)
        value['rows'].append(2)
        self.assertEqual(cached_result('vegetation-test', 1), {'rows': [1]})

    def test_daily_query_has_date_and_district_bounds_without_count_scan(self):
        with patch.object(service, '_request_page', return_value=([], None)) as request:
            service._read_satellite_window(self.snapshot, pd.Timestamp('2025-01-01'), pd.Timestamp('2025-04-01'), 'Vhembe', service.SAT_KEYS)
        query = parse_qs(urlparse(request.call_args.args[0]).query)
        self.assertEqual(query['Date'], ['gte.2025-01-01'])
        self.assertEqual(query['and'], ['(Date.lt.2025-04-01)'])
        self.assertEqual(query['District_Name'], ['eq.Vhembe'])
        self.assertNotIn('count_exact', request.call_args.kwargs)


if __name__ == '__main__':
    unittest.main()
