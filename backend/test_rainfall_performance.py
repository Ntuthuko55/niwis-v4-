"""Offline rainfall scope, cadence, cache reuse and as-of-date coverage checks."""
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

import numpy as np
import pandas as pd
from fastapi import HTTPException

from app import rainfall_service as service
from app.dashboard_loader import clear_dashboard_cache


class RainfallPerformanceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.names = ['City of Tshwane', 'Vhembe']
        dates = pd.date_range('2023-01-01', '2026-09-06').difference(pd.DatetimeIndex(['2024-02-29']))
        cls.core = pd.DataFrame([
            {'District_Name': name, 'Date': day,
             **{key: 1 + region + day.day / 100 for key in service.DAILY},
             **{key: 10 + region + day.month for key in service.MONTHLY},
             **{key: 100 + region + day.year / 100 for key in service.ANNUAL},
             'TAMSAT_Satellite_Rainfall_Estimate_mm_dekad': 5 + (day.day - 1) // 10 if day.day <= 20 else 7}
            for region, name in enumerate(cls.names) for day in dates])
        cls.core.loc[(cls.core.Date == pd.Timestamp('2025-04-01')), 'Daily_Rainfall_Total_mm'] = np.nan
        cls.indices = pd.DataFrame([
            {'District_Name': name, 'Year': month.year, 'Month': month.month,
             **{key: region + month.month / 10 for key in service.INDICES}}
            for region, name in enumerate(cls.names) for month in pd.period_range('2023-01', '2026-09', freq='M')])
        cls.meta = {'regions': cls.names, 'months': [str(month) for month in pd.period_range('2023-01', '2026-09', freq='M')],
                    'default_start': '2024-09', 'default_end': '2026-08', 'latest_date': '2026-09-06',
                    'source_tables': ['core', 'indices', 'runoff'], 'intensity_matches_daily_div6': False,
                    'gridded_matches_daily': False, 'metrics': [{'key': row[0]} for row in service.METRICS]}
        cls.snapshot = {'base': 'https://test.invalid', 'key': 'test', 'tables': {'core': 'core', 'indices': 'indices', 'runoff': 'runoff'},
                        'region_columns': {'core': 'District_Name', 'indices': 'District_Name', 'runoff': 'District_Name'},
                        'date_column': 'Date', 'year_columns': {'indices': 'Year'}, 'month_columns': {'indices': 'Month'},
                        'core_actual': {key: key for key in service.CORE_COLUMNS},
                        'index_actual': {key: key for key in service.INDICES}, 'runoff_actual': service.RUNOFF_FIELDS}

    def setUp(self):
        clear_dashboard_cache()
        self.reads = []
        for item in [patch.object(service, '_snapshot', return_value=self.snapshot),
                     patch.object(service, '_metadata', return_value=self.meta),
                     patch.object(service, '_read_core_window', side_effect=self.read_core),
                     patch.object(service, '_read_indices', side_effect=self.read_indices),
                     patch.object(service, '_read_runoff_window', side_effect=self.read_runoff)]:
            item.start(); self.addCleanup(item.stop)
        self.addCleanup(clear_dashboard_cache)

    def read_core(self, snapshot, start, end, region, cache_raw=True):
        self.reads.append(('core', start, end, region, cache_raw))
        frame = self.core[self.core.Date.between(pd.Period(start, 'M').start_time, pd.Period(end, 'M').end_time)]
        return frame[frame.District_Name.eq(region)].copy() if region else frame.copy()

    def read_indices(self, snapshot, start, end, region):
        self.reads.append(('indices', start, end, region))
        frame = self.indices[self.indices.Year.between(int(start[:4]), int(end[:4]))]
        return frame[frame.District_Name.eq(region)].copy() if region else frame.copy()

    def read_runoff(self, snapshot, start, end, region):
        self.reads.append(('runoff', start, end, region))
        return pd.DataFrame(columns=['District_Name', 'Date'])

    def test_monthly_values_and_previous_year_match_full_daily_calculation(self):
        _, monthly, _ = service.prepare(self.core, self.indices)
        for region in ['National', *self.names]:
            full = service._region_months(monthly, region)
            expected = full.loc['2024-09':'2026-08'].copy()
            for month, row in expected.iterrows():
                previous = str(pd.Period(month, 'M') - 12)
                expected.loc[month, 'previous_year'] = full.loc[previous, 'rainfall'] if row.complete and full.loc[previous, 'complete'] else np.nan
            actual = service.dashboard(region, '2024-09', '2026-08', include_map=False, include_runoff=False)
            self.assertEqual(actual['series'], service.clean(expected.reset_index().to_dict('records')))
            self.assertAlmostEqual(actual['summary']['rainfall'], expected.rainfall.sum())

    def test_annual_and_seasonal_values_keep_original_end_month_coverage(self):
        for end in ['2024-02', '2024-12', '2025-01', '2026-08', '2026-09']:
            raw = self.core[self.core.Date.le(pd.Period(end, 'M').end_time)]
            indices = self.indices[self.indices.Year.le(int(end[:4]))]
            _, _, expected = service.prepare(raw, indices)
            _, annual_months = service._monthly_data(self.snapshot, '2023-01', end, None)
            actual = service._annual_context(annual_months)
            self.assertEqual(service.clean(actual.to_dict('records')), service.clean(expected.to_dict('records')), end)
        august = service.dashboard(start='2026-08', end='2026-08', include_map=False, include_runoff=False)
        self.assertIsNone(august['seasonal'][-1]['rainfall'])
        self.assertFalse(august['seasonal'][2]['complete'])
        self.assertEqual(august['annual'][-1]['observed_days'], 243)

    def test_map_only_reads_its_calendar_year_without_runoff_or_comparisons(self):
        with patch.object(service, '_dashboard', side_effect=AssertionError('Map must not load dashboard history')):
            result = service.map_data('2025-01')
        self.assertEqual(len(result['map']), 2)
        self.assertEqual({row[0] for row in self.reads}, {'core', 'indices'})
        self.assertTrue(all(row[1:3] == ('2025-01', '2025-12') for row in self.reads))
        self.assertTrue(all(not row[4] for row in self.reads if row[0] == 'core'), 'Do not retain large daily frames')

    def test_national_cache_reused_by_district_map_and_forecast(self):
        service.dashboard(start='2024-09', end='2026-08', include_map=False, include_runoff=False)
        count = len(self.reads)
        service.dashboard('City of Tshwane', '2025-01', '2026-08', include_map=False, include_runoff=False)
        service.map_data('2025-02')
        forecast = service.forecast_source('Vhembe', '2024-09', '2026-08')
        self.assertEqual(len(self.reads), count)
        self.assertEqual(len(forecast['series']), 24)

    def test_district_cold_chart_can_skip_all_national_and_runoff_reads(self):
        result = service.dashboard('Vhembe', '2025-01', '2025-12', include_map=False, include_runoff=False)
        self.assertTrue(all(row[3] == 'Vhembe' for row in self.reads))
        self.assertFalse(any(row[0] == 'runoff' for row in self.reads))
        self.assertEqual(result['map'], [])
        self.assertEqual(result['runoff'], {'latest': {}, 'series': []})

    def test_forecast_does_not_load_runoff_or_previous_year_history(self):
        service.forecast_source('Vhembe', '2025-01', '2025-12')
        self.assertEqual({row[0] for row in self.reads}, {'core', 'indices'})
        self.assertTrue(all(row[1:3] == ('2025-01', '2025-12') for row in self.reads))

    def test_simultaneous_map_and_history_share_the_same_year_load(self):
        with ThreadPoolExecutor(max_workers=2) as executor:
            mapping = executor.submit(service.map_data, '2026-08')
            charts = executor.submit(service.dashboard, 'National', '2024-09', '2026-08', False, False)
            self.assertEqual(len(mapping.result()['map']), 2)
            self.assertEqual(len(charts.result()['series']), 24)
        self.assertEqual(sum(row[:3] == ('core', '2026-01', '2026-12') for row in self.reads), 1)

    def test_missing_district_retained_with_null_map_values(self):
        with patch.object(service, '_metadata', return_value={**self.meta, 'regions': self.names + ['Missing']}):
            result = service.map_data('2025-01')
        missing = next(row for row in result['map'] if row['District_Name'] == 'Missing')
        self.assertIsNone(missing['rainfall'])
        self.assertIsNone(missing['spi3'])

    def test_partial_month_retains_observed_totals_and_excludes_comparisons(self):
        result = service.dashboard(start='2026-09', end='2026-09', include_map=False, include_runoff=False)
        self.assertEqual(result['coverage']['observed_days'], 12)
        self.assertEqual(result['coverage']['expected_days'], 60)
        self.assertFalse(result['latest']['complete'])
        self.assertIsNone(result['latest']['previous_year'])
        self.assertEqual(result['satellite_agreement']['months'], 0)
        self.assertIsNone(result['seasonal'][-1]['rainfall'])

    def test_daily_request_selects_only_five_measurements_and_one_month(self):
        rows = self.core[(self.core.District_Name == 'Vhembe') & self.core.Date.between('2024-02-01', '2024-02-29')].to_dict('records')
        with patch.object(service, '_read_pages', return_value=rows) as request:
            data = service.daily('Vhembe', '2024-02')
            service.daily('Vhembe', '2024-02')
        self.assertEqual(request.call_count, 1)
        params = request.call_args.args[3]
        self.assertEqual(len(params['select'].split(',')), 7)
        self.assertNotIn('Annual_Total_Precipitation_mm', params['select'])
        self.assertEqual(params['Date'], 'gte.2024-02-01')
        self.assertEqual(params['and'], '(Date.lt.2024-03-01)')
        self.assertEqual(params['District_Name'], 'eq.Vhembe')
        self.assertEqual(len(data['series']), 28)  # Deliberately missing leap day.
        self.assertEqual(len(data['dekads']), 3)

    def test_failed_year_load_is_not_cached(self):
        with patch.object(service, '_read_core_window', side_effect=service.SupabaseSourceError('unavailable')):
            with self.assertRaises(service.SupabaseSourceError): service._year_summary(self.snapshot, 2025, None)
        self.assertFalse(service._year_summary(self.snapshot, 2025, None)['monthly'].empty)

    def test_invalid_filters_fail_before_source_reads(self):
        for month in ['2025-13', '2027-01']:
            with self.assertRaises(HTTPException): service.map_data(month)
        for kwargs in [{'region': 'Unknown'}, {'start': '2026-01', 'end': '2020-01'}]:
            with self.assertRaises(HTTPException): service.dashboard(**kwargs)
        self.assertFalse(self.reads)


if __name__ == '__main__':
    unittest.main()
