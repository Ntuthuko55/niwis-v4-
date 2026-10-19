"""Groundwater cache reuse, latest-observation maps and sparse source parity."""
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

import numpy as np
import pandas as pd
from fastapi import HTTPException

from app import groundwater_service as service
from app.dashboard_loader import clear_dashboard_cache


class GroundwaterPerformanceTests(unittest.TestCase):
    long_reader = staticmethod(service._read_long_window)

    @classmethod
    def setUpClass(cls):
        cls.variables = list(service.VARIABLES)
        cls.names = ['City of Tshwane', 'Vhembe']
        rows, wide = [], []
        for region, name in enumerate(cls.names):
            for month in pd.period_range('2024-01', '2026-12', freq='M'):
                for index, key in enumerate(key for key in cls.variables if key not in service.WIDE_FIELDS):
                    if key == 'hydraulic_head_amsl_m' and month > pd.Period('2026-10', 'M'):
                        continue
                    if key == 'sgi_dimensionless' and str(month) == '2025-04':
                        continue
                    for day in ([2, 20] if index < 5 else [15]):
                        rows.append({'district_name': name, 'date': month.start_time + pd.Timedelta(days=day - 1),
                                     'variable_name': key, 'value': index + month.month / 10 + region + day / 100})
                wide.append({'district_name': name, 'date': month.end_time.normalize(),
                             **{key: index + region + month.month / 10 for index, key in enumerate(service.WIDE_FIELDS)}})
        # A repeated observation is averaged, not silently deduplicated.
        rows.append({**rows[0], 'value': rows[0]['value'] + 10})
        # Uncatalogued observations still count toward the existing raw-row audit.
        rows.append({'district_name': cls.names[0], 'date': pd.Timestamp('2026-12-31'), 'variable_name': 'uncatalogued', 'value': 1})
        cls.long = pd.DataFrame(rows)
        cls.wide = pd.DataFrame(wide)
        cls.meta = {'regions': cls.names, 'months': [str(month) for month in pd.period_range('2000-01', '2026-12', freq='M')],
                    'default_start': '2025-01', 'default_end': '2026-12', 'first_date': '2000-01-02', 'last_date': '2026-12-31',
                    'source_tables': ['long', 'wide'], 'variables': cls.variables,
                    'metrics': [{'key': key, 'unit': service.VARIABLES[key][1]} for key in cls.variables]}
        cls.snapshot = {'base': 'https://test.invalid', 'key': 'test', 'tables': {'long': 'long', 'wide': 'wide'},
                        'long_region': 'district_name', 'long_date': 'date', 'variable': 'variable_name', 'value': 'value',
                        'wide_region': 'district_name', 'wide_date': 'date', 'wide_actual': {key: key for key in service.WIDE_FIELDS}}

    def setUp(self):
        clear_dashboard_cache()
        self.reads = []
        for item in [patch.object(service, '_snapshot', return_value=self.snapshot),
                     patch.object(service, '_metadata', return_value=self.meta),
                     patch.object(service, '_read_long_window', side_effect=self.read_long),
                     patch.object(service, '_read_wide_window', side_effect=self.read_wide)]:
            item.start(); self.addCleanup(item.stop)
        self.addCleanup(clear_dashboard_cache)

    def select(self, frame, start, end, region):
        result = frame[frame.date.between(pd.Period(start, 'M').start_time, pd.Period(end, 'M').end_time)]
        return result[result.district_name.eq(region)].copy() if region else result.copy()

    def read_long(self, snapshot, start, end, region, cache_raw=True):
        self.reads.append(('long', start, end, region, cache_raw))
        return self.select(self.long, start, end, region)

    def read_wide(self, snapshot, start, end, region, cache_raw=True):
        self.reads.append(('wide', start, end, region, cache_raw))
        return self.select(self.wide, start, end, region)

    def test_monthly_means_missing_values_and_raw_quality_counts_match(self):
        raw = service._prepare(self.long, self.wide, self.variables)
        for region in ['National', *self.names]:
            selected = raw if region == 'National' else raw[raw.district_name.eq(region)]
            selected = selected[selected.period.between('2025-01', '2026-12')]
            expected = selected.groupby('period')[self.variables].mean(numeric_only=True)
            expected['month'] = expected.index
            actual = service.dashboard(region, '2025-01', '2026-12', include_map=False)
            self.assertEqual(actual['series'], service._clean(expected.reset_index(drop=True).to_dict('records')))
            self.assertEqual(actual['quality']['missing_values'], int(selected[self.variables].isna().sum().sum()))
            future = 0
            for frame in [self.long, self.wide]:
                values = self.select(frame, '2025-01', '2026-12', None if region == 'National' else region)
                future += int(values.date.gt(pd.Timestamp('2026-10-13')).sum())
            self.assertEqual(actual['quality']['future_rows_after_2026_10_13'], future)

    def test_map_stops_after_recent_year_when_all_indicators_are_resolved(self):
        result = service.map_data('2000-01', '2026-12')
        self.assertTrue(all(row[1:3] == ('2026-01', '2026-12') for row in self.reads))
        self.assertEqual(result['map_periods']['hydraulic_head_amsl_m'], '2026-10')
        self.assertEqual(len(result['map']), 2)
        self.assertTrue(all(row['hydraulic_head_amsl_m'] is not None for row in result['map']))

    def test_map_looks_back_per_district_when_a_recent_year_is_missing(self):
        missing = self.long[(self.long.district_name != 'Vhembe') | (self.long.variable_name != 'transmissivity_m2_day') | (self.long.date.dt.year != 2026)]
        with patch.object(self, 'long', missing):
            result = service.map_data('2024-01', '2026-12')
            full = service._prepare(missing, self.wide, self.variables)
            expected, periods = service._latest_map(full, self.variables, '2026-12')
        self.assertEqual(result['map'], service._clean(expected))
        self.assertEqual(result['map_periods'], periods)
        self.assertEqual({row[1] for row in self.reads}, {'2026-01', '2025-01'})

    def test_map_month_never_borrows_an_observation_before_selected_start(self):
        result = service.map_data('2026-12', '2026-12')
        self.assertIsNone(result['map_periods']['hydraulic_head_amsl_m'])
        self.assertTrue(all(row['hydraulic_head_amsl_m'] is None for row in result['map']))
        self.assertTrue(all(row['hydraulic_head_m_amsl'] is not None for row in result['map']))

    def test_national_year_summaries_reused_by_district_forecast_and_map(self):
        service.dashboard(start='2024-01', end='2026-12', include_map=False)
        count = len(self.reads)
        service.dashboard('Vhembe', '2025-01', '2026-12', include_map=False)
        service.map_data('2026-10', '2026-10')
        forecast = service.forecast_source('City of Tshwane', '2025-01', '2026-12')
        self.assertEqual(len(self.reads), count)
        self.assertEqual(len(forecast['series']), 24)
        self.assertTrue(all(not row[4] for row in self.reads), 'Raw yearly frames must not be retained')

    def test_district_only_chart_skips_national_source_reads(self):
        result = service.dashboard('Vhembe', '2025-01', '2026-12', include_map=False)
        self.assertTrue(self.reads)
        self.assertTrue(all(row[3] == 'Vhembe' for row in self.reads))
        self.assertEqual(result['map'], [])

    def test_map_and_chart_simultaneously_share_recent_year(self):
        with ThreadPoolExecutor(max_workers=2) as executor:
            mapping = executor.submit(service.map_data, '2025-01', '2026-12')
            chart = executor.submit(service.dashboard, 'National', '2025-01', '2026-12', False)
            self.assertEqual(len(mapping.result()['map']), 2)
            self.assertEqual(len(chart.result()['series']), 24)
        self.assertEqual(sum(row[:3] == ('long', '2026-01', '2026-12') for row in self.reads), 1)

    def test_support_only_year_retains_nulls_and_all_variable_names(self):
        with patch.object(self, 'long', self.long.iloc[0:0]):
            result = service.dashboard(start='2026-12', end='2026-12', include_map=False)
        self.assertIsNone(result['latest']['hydraulic_head_amsl_m'])
        self.assertIsNotNone(result['latest']['actual_evapotranspiration_mm'])
        self.assertEqual(set(result['series'][0]), {*self.variables, 'month'})
        self.assertFalse(any(key.endswith(('_x', '_y')) for key in result['series'][0]))

    def test_year_with_a_missing_indicator_does_not_crash_or_fill_zeros(self):
        missing = self.long[(self.long.variable_name != 'hydraulic_head_amsl_m') | (self.long.date.dt.year != 2025)]
        with patch.object(self, 'long', missing):
            result = service.dashboard(start='2025-01', end='2025-12', include_map=False)
        self.assertIsNone(result['latest']['hydraulic_head_amsl_m'])
        self.assertTrue(all(row['hydraulic_head_amsl_m'] is None for row in result['series']))

    def test_missing_district_remains_in_national_map_as_unavailable(self):
        with patch.object(service, '_metadata', return_value={**self.meta, 'regions': self.names + ['Missing']}):
            result = service.map_data('2026-12', '2026-12')
        missing = next(row for row in result['map'] if row['district_name'] == 'Missing')
        self.assertIsNone(missing['sgi_dimensionless'])
        self.assertEqual(len(result['map']), 3)

    def test_daily_cache_preserves_irregular_dates_and_does_not_repeat_reads(self):
        data = service.daily('City of Tshwane', '2026-10')
        count = len(self.reads)
        self.assertEqual(service.daily('City of Tshwane', '2026-10'), data)
        self.assertEqual(len(self.reads), count)
        expected_dates = set(self.select(self.long, '2026-10', '2026-10', 'City of Tshwane').date.dt.strftime('%Y-%m-%d'))
        expected_dates |= set(self.select(self.wide, '2026-10', '2026-10', 'City of Tshwane').date.dt.strftime('%Y-%m-%d'))
        self.assertEqual({row['date'] for row in data['series']}, expected_dates)
        self.assertTrue(all(row[3] == 'City of Tshwane' and row[1:3] == ('2026-10', '2026-10') for row in self.reads))

    def test_source_windows_remain_bounded_and_district_filtered(self):
        params = []
        def read(base, key, table, query):
            params.append(query)
            return []
        with patch.object(service, '_read_pages', side_effect=read):
            self.long_reader(self.snapshot, '2024-01', '2024-12', 'Vhembe', cache_raw=False)
        self.assertTrue(params)
        for query in params:
            start = pd.Timestamp(query['date'].removeprefix('gte.'))
            end = pd.Timestamp(query['and'].split('.lt.')[1].rstrip(')'))
            self.assertLessEqual((end - start).days, 90)
            self.assertEqual(query['district_name'], 'eq.Vhembe')
            self.assertEqual(query['select'], 'district_name,date,variable_name,value')

    def test_failed_summary_is_not_cached(self):
        with patch.object(service, '_read_long_window', side_effect=service.SupabaseSourceError('unavailable')):
            with self.assertRaises(service.SupabaseSourceError):
                service._year_summary(self.snapshot, self.variables, 2026, None)
        self.assertFalse(service._year_summary(self.snapshot, self.variables, 2026, None)['monthly'].empty)

    def test_invalid_filters_do_not_start_source_reads(self):
        for args in [('2026-13', '2026-13'), ('2027-01', '2027-01'), ('2026-12', '2025-01')]:
            with self.assertRaises(HTTPException): service.map_data(*args)
        with self.assertRaises(HTTPException): service.dashboard('Unknown')
        self.assertFalse(self.reads)


if __name__ == '__main__':
    unittest.main()
