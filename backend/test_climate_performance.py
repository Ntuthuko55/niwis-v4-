"""Climate query scope, compact-cache reuse and observation parity, offline."""
import unittest
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import parse_qs, urlparse
from unittest.mock import patch

import numpy as np
import pandas as pd

from app import climate_service as service, climate_source as source
from app.dashboard_loader import clear_dashboard_cache


class ClimatePerformanceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.names = ['City of Tshwane', 'Vhembe']
        cls.raw = {}
        dates = pd.date_range('2023-12-28', '2025-02-05').difference(pd.DatetimeIndex(['2024-01-31']))
        for section, columns in service.source_columns(source.SECTIONS).items():
            rows = []
            for region_index, name in enumerate(cls.names):
                for date in dates if section in source.DAILY else pd.to_datetime(['2023-01-01', '2024-01-01', '2025-01-01']):
                    row = {'District_Name': name, 'Year': date.year}
                    if section in source.DAILY:
                        row['Date'] = date
                    row.update({key: float(10 + region_index * 30 + date.month + date.day / 100) for key in columns})
                    if section == 'temperature':
                        row['Tmax_C'] = 38.0 if date.day in (29, 30, 31, 1, 2) else 25.0
                        row['Tmin_C'] = -1.0 if date.day == 1 else 15.0
                    if section == 'evaporation':
                        row['SPEI_Daily'] = np.nan
                    rows.append(row)
            cls.raw[section] = pd.DataFrame(rows)
        cls.meta = {'regions': cls.names, 'years': [2023, 2024, 2025], 'baseline_available': False,
                    'latest_daily_date': '2025-02-05', 'latest_month': '2025-02',
                    'annual_months': ['2023-12', '2024-12', '2025-12'],
                    'months': [str(value) for value in pd.period_range('2023-01', '2025-12', freq='M')]}

    def setUp(self):
        clear_dashboard_cache()
        self.reads = []
        patches = [patch.object(service, 'signature', return_value='fixture'),
                   patch.object(service, 'metadata_for', return_value=self.meta),
                   patch.object(source, 'source_label', return_value='Supabase'),
                   patch.object(source, 'read_frames', side_effect=self.read_frames),
                   patch.object(source, 'last_observed_date', side_effect=self.last_date)]
        for item in patches:
            item.start(); self.addCleanup(item.stop)
        self.addCleanup(clear_dashboard_cache)

    def read_frames(self, columns, start, end, region, date_start=None, date_stop=None):
        self.reads.append({'sections': tuple(columns), 'start': start, 'end': end, 'region': region,
                           'date_start': date_start, 'date_stop': date_stop})
        result = {}
        for section in columns:
            frame = self.raw[section]
            frame = frame[frame.Year.between(start, end)]
            if region: frame = frame[frame.District_Name.eq(region)]
            if section in source.DAILY:
                if date_start: frame = frame[frame.Date.ge(pd.Timestamp(date_start))]
                if date_stop: frame = frame[frame.Date.lt(pd.Timestamp(date_stop))]
            result[section] = frame[['District_Name', 'Date' if section in source.DAILY else 'Year', *columns[section]]].copy()
        return result

    def last_date(self, section, month):
        frame = self.raw[section]
        dates = frame.loc[frame.Date.dt.strftime('%Y-%m').eq(month), 'Date']
        return str(dates.max().date()) if len(dates) else None

    def test_one_section_shared_by_year_and_month_charts_without_national_history(self):
        annual = service.dashboard(region=self.names[0], start=2024, end=2024, section='temperature', include_map=False)
        monthly = service.monthly(region=self.names[0], start='2024-01', end='2024-12', section='temperature', include_map=False)
        self.assertEqual(len(self.reads), 1)
        self.assertEqual(self.reads[0]['sections'], ('temperature',))
        self.assertEqual(self.reads[0]['region'], self.names[0])
        self.assertEqual(annual['map'], [])
        self.assertEqual(monthly['map'], [])
        raw = self.raw['temperature']
        raw = raw[raw.Year.eq(2024) & raw.District_Name.eq(self.names[0])]
        self.assertAlmostEqual(annual['summary']['Tavg_C'], raw.Tavg_C.mean(), places=8)
        self.assertEqual(annual['summary']['Heat_Days'], int(raw.Tmax_C.gt(35).sum()))
        self.assertEqual(annual['summary']['Frost_Days'], int(raw.Tmin_C.lt(0).sum()))
        longest = run = 0
        previous = None
        for row in raw.itertuples():
            run = run + 1 if row.Tmax_C > 35 and previous is not None and row.Date - previous == pd.Timedelta(days=1) else int(row.Tmax_C > 35)
            longest = max(longest, run)
            previous = row.Date
        self.assertEqual(annual['summary']['Heat_Duration'], longest)
        self.assertEqual(annual['coverage'][0]['observed'], len(raw))
        self.assertEqual(annual['coverage'][0]['expected'], 366)
        expected = raw.groupby(raw.Date.dt.strftime('%Y-%m')).Tavg_C.mean()
        for row in monthly['series']:
            self.assertAlmostEqual(row['Tavg_C'], expected[row['month']], places=8)
        self.assertNotIn('Daily_ET0_mm', monthly['variables'])

    def test_overlapping_ranges_reuse_year_rollups(self):
        service.dashboard(start=2023, end=2024, section='temperature', include_map=False)
        service.dashboard(start=2024, end=2025, section='temperature', include_map=False)
        self.assertEqual(sorted(item['start'] for item in self.reads), [2023, 2024, 2025])

    def test_overview_and_section_pages_reuse_the_same_compact_source_cache(self):
        service.dashboard(start=2024, end=2024, include_map=False)
        self.assertEqual(len(self.reads), 6)
        service.dashboard(start=2024, end=2024, section='temperature', include_map=False)
        service.monthly(start='2024-01', end='2024-12', section='temperature', include_map=False)
        self.assertEqual(len(self.reads), 6, 'Section changes must not reread the overview history')

    def test_simultaneous_chart_requests_share_one_source_read(self):
        with ThreadPoolExecutor(max_workers=2) as executor:
            annual = executor.submit(service.dashboard, start=2024, end=2024, section='temperature', include_map=False)
            monthly = executor.submit(service.monthly, start='2024-01', end='2024-12', section='temperature', include_map=False)
            self.assertTrue(annual.result()['series'])
            self.assertTrue(monthly.result()['series'])
        self.assertEqual(len(self.reads), 1)

    def test_annual_only_section_never_reads_daily_tables(self):
        result = service.dashboard(start=2024, end=2024, section='rainfall', include_map=False)
        self.assertEqual(self.reads[0]['sections'], ('rainfall',))
        self.assertEqual(result['coverage'], [])
        self.assertIn('MAP_mm', result['summary'])
        self.assertNotIn('Tavg_C', result['summary'])
        with patch.object(source, 'last_observed_date', side_effect=AssertionError('Daily probe forbidden')):
            mapped = service.map_view(month='2024-02', section='rainfall')
        self.assertEqual(len(mapped['map']), 2)
        self.assertEqual(mapped['variables'], [])
        self.assertTrue(all(row['MAP_mm'] is not None for row in mapped['map']))

    def test_map_reads_actual_source_day_only_and_retains_all_districts(self):
        result = service.map_view(month='2025-02', section='temperature')
        self.assertEqual(result['map_date'], '2025-02-05')
        self.assertEqual(len(result['map']), 2)
        self.assertEqual(self.reads, [{'sections': ('temperature',), 'start': 2025, 'end': 2025,
                                     'region': None, 'date_start': '2025-02-05', 'date_stop': '2025-02-06'}])
        for row in result['map']:
            expected = self.raw['temperature']
            expected = expected[expected.District_Name.eq(row['District_Name']) & expected.Date.eq(pd.Timestamp('2025-02-05'))]
            self.assertAlmostEqual(row['Tavg_C'], expected.Tavg_C.iloc[0], places=8)

    def test_compact_results_match_legacy_monthly_values_and_keep_nulls(self):
        legacy = service._legacy_monthly(region=self.names[0], start='2024-01', end='2024-12', month='2024-02')
        compact = service.monthly(region=self.names[0], start='2024-01', end='2024-12', include_map=False)
        for key in ('series', 'summary', 'annual_series', 'variables', 'annual_variables'):
            self.assertEqual(legacy[key], compact[key], key)
        self.assertTrue(all(row['SPEI_Daily'] is None for row in compact['series']))
        mapped = service.map_view(month='2024-02')
        self.assertEqual(legacy['map'], mapped['map'])

    def test_legacy_annual_map_and_seasons_remain_complete(self):
        for season in service.SEASONS:
            result = service.dashboard(region=self.names[0], start=2024, end=2024, season=season)
            self.assertEqual(len(result['map']), 2)
            for row in result['map']:
                raw = self.raw['temperature']
                selected = raw[raw.Year.eq(2024) & raw.District_Name.eq(row['District_Name']) & raw.Date.dt.month.isin(service.SEASONS[season])]
                self.assertAlmostEqual(row['Tavg_C'], selected.Tavg_C.mean(), places=8)


class ClimateAdapterScopeTests(unittest.TestCase):
    def test_rest_source_limits_table_region_columns_and_day(self):
        requests = []
        def read(url, key):
            requests.append(parse_qs(urlparse(url).query))
            return [{'District_Name': 'Vhembe', 'Date': '2024-02-29', 'Tavg_C': 24.5}]
        with patch.object(source, 'postgres_enabled', return_value=False), \
                patch.object(source, 'settings', return_value=('https://test.invalid', 'test', dict(zip(source.SECTIONS, source.DEFAULT_TABLES)))), \
                patch.object(source, 'read_daily_window', side_effect=read), \
                patch.object(source, 'read_all', side_effect=AssertionError('Unrequested table read')):
            result = source.read_frames({'temperature': ['Tavg_C']}, 2024, 2024, 'Vhembe', '2024-02-29', '2024-03-01')
        self.assertEqual(list(result), ['temperature'])
        self.assertEqual(len(requests), 1)
        self.assertEqual(requests[0]['Date'], ['gte.2024-02-29'])
        self.assertEqual(requests[0]['and'], ['(Date.lt.2024-03-01)'])
        self.assertEqual(requests[0]['District_Name'], ['eq.Vhembe'])
        self.assertEqual(requests[0]['select'], ['District_Name,Date,Tavg_C'])

    def test_old_csv_setting_cannot_enable_file_reads(self):
        with patch.dict('os.environ', {'NIWIS_CLIMATE_SOURCE': 'csv'}), \
                patch('pandas.read_csv', side_effect=AssertionError('CSV reads forbidden')), \
                patch.object(source, 'settings', return_value=('https://test.invalid', 'test', dict(zip(source.SECTIONS, source.DEFAULT_TABLES)))):
            self.assertEqual(source.source_label(), 'Supabase')
            self.assertNotEqual(source.signature()[0], 'csv')


if __name__ == '__main__':
    unittest.main()
