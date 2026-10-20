import json
import unittest
from urllib.parse import parse_qs, unquote, urlparse
from unittest.mock import patch

import numpy as np
import pandas as pd
from fastapi import HTTPException
from app import runoff_service as runoff
from app.dashboard_loader import clear_dashboard_cache
from app.supabase_source import SupabaseSourceError

from app.runoff_service import CORE, DERIVED, prepare, metadata, dashboard, daily


class RunoffTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Deterministic source rows exercise REST pagination, leap years and
        # partial coverage without depending on an archived data export.
        regions = ['City of Tshwane', *[f'District {index:02}' for index in range(1, 52)]]
        periods = [str(period) for period in pd.period_range('2023-02', '2026-09', freq='M')]
        rows, indicators = [], []
        for index, region in enumerate(regions):
            for month in periods:
                period = pd.Period(month, freq='M')
                days = 6 if month == '2026-09' else period.days_in_month
                volume = 86400. * (index + 1)
                rows.extend({'District_Name': region, 'Date': f'{month}-{day:02}',
                             'Year': period.year, 'Month': period.month, **dict.fromkeys(CORE, 1.),
                             'Catchment_Area_km2': 6500., 'Dominant_LandCover_Class': 'Grassland',
                             'Daily_Surface_Runoff_Volume_m3_day': volume,
                             'Monthly_Runoff_Totals_Million_m3_month': volume * days / 1e6,
                             'Peak_Flow_Rates_m3s': (index + 1) * 1.85,
                             'Baseflow_Component_m3s': (index + 1) * .32}
                            for day in range(1, days + 1))
                indicators.append({'District_Name': region, 'Year': period.year, 'Month': period.month,
                                   **dict.fromkeys(DERIVED, 1.),
                                   **{f'Flood_Flow_{year}yr_m3s': (index + 1) * year for year in runoff.PERIODS},
                                   'date': f'{month}-25'})
        cls.core_fixture = pd.DataFrame(rows)
        cls.derived_fixture = pd.DataFrame(indicators)
        cls.core_months = dict(tuple(cls.core_fixture.groupby(cls.core_fixture.Date.str[:7])))

    def setUp(self):
        clear_dashboard_cache()
        self.queries = []
        self.settings = patch.object(runoff, '_settings', return_value=('https://runoff.test.invalid', 'test-key', 'unused'))
        self.transport = patch.object(runoff, '_request_page', side_effect=self.request_page)
        self.settings.start(); self.transport.start()
        self.addCleanup(self.settings.stop); self.addCleanup(self.transport.stop)
        self.addCleanup(clear_dashboard_cache)

    def request_page(self, url, key, start=0, end=999, count_exact=False):
        parsed = urlparse(url)
        table = unquote(parsed.path.rsplit('/', 1)[1])
        params = {name: value[0] for name, value in parse_qs(parsed.query).items()}
        self.queries.append((table, params, start, end, count_exact))
        self.assertIn(table, runoff.DEFAULT_TABLES)
        rows = self.core_fixture if table == runoff.DEFAULT_TABLES[0] else self.derived_fixture
        if 'Date' in params:
            # Every daily read is constrained to one calendar month.
            self.assertTrue(params['Date'].startswith('gte.'))
            self.assertIn('Date.lt.', params.get('and', ''))
            month = params['Date'][4:11]
            rows = self.core_months.get(month, rows.iloc[:0])
        for column in ('District_Name', 'Year', 'Month'):
            if column in params:
                op, value = params[column].split('.', 1)
                self.assertEqual(op, 'eq')
                rows = rows[rows[column].astype(str).eq(value)]
        for part in reversed(params.get('order', '').split(',')):
            if part:
                column, direction = part.split('.')[:2]
                rows = rows.sort_values(column, ascending=direction != 'desc', kind='stable')
        if 'limit' in params:
            rows = rows.iloc[:int(params['limit'])]
        rows = rows.iloc[start:end + 1]
        if params['select'] != '*':
            rows = rows[params['select'].split(',')]
        return json.loads(rows.to_json(orient='records', double_precision=15)), None

    def fixture(self):
        rows = [{**dict.fromkeys(CORE, 1.0), 'District_Name': 'Test', 'Date': f'2024-01-{day:02}',
                 'Catchment_Area_km2': 2.0, 'Mean_Catchment_Rainfall_mm': 10.0,
                 'Actual_ET_from_Catchment_mm': 3.0, 'Daily_Surface_Runoff_Volume_m3_day': 4000.0,
                 'Monthly_Runoff_Totals_Million_m3_month': .124, 'Baseflow_Component_m3s': 5.0,
                 'Peak_Flow_Rates_m3s': day, 'Dominant_LandCover_Class': 'Grassland'} for day in range(1, 32)]
        indicators = pd.DataFrame([{'District_Name': 'Test', 'Year': 2024, 'Month': 1, **dict.fromkeys(DERIVED, 1.0)}])
        return pd.DataFrame(rows), indicators

    def test_units_depths_rates_and_repeated_monthly_volume(self):
        core, derived = self.fixture()
        core = pd.concat([core, core.iloc[[0]]], ignore_index=True)
        _, monthly = prepare(core, derived)
        row = monthly.iloc[0]
        self.assertAlmostEqual(row.volume, .124)
        self.assertEqual(row.reported_volume, .124)
        self.assertEqual(row.rainfall, 310)
        self.assertEqual(row.et, 93)
        self.assertEqual(row.runoff_depth, 62)
        self.assertAlmostEqual(row.weighted_ratio, .2)
        self.assertEqual(row.baseflow, 5, 'Rates must be averaged, not summed')
        self.assertEqual(row.peak_flow, 31)
        self.assertEqual(row.observed_days, 31)
        self.assertTrue(row.complete)

    def test_weighted_ratio_uses_volume_pairs_not_mean_coefficients(self):
        core, derived = self.fixture()
        core = core.iloc[:2].copy()
        core['Catchment_Area_km2'] = [1., 2.]
        core['Mean_Catchment_Rainfall_mm'] = [10., 20.]
        core['Daily_Surface_Runoff_Volume_m3_day'] = [1000., 8000.]
        _, monthly = prepare(core, derived)
        self.assertAlmostEqual(monthly.iloc[0].weighted_ratio, 9000 / 50000)
        self.assertEqual(monthly.iloc[0].runoff_depth, 5)

    def test_missing_data_and_zero_rainfall_do_not_create_ratios(self):
        core, derived = self.fixture()
        core['Mean_Catchment_Rainfall_mm'] = 0
        _, monthly = prepare(core, derived)
        self.assertTrue(pd.isna(monthly.iloc[0].weighted_ratio))
        core['Daily_Surface_Runoff_Volume_m3_day'] = np.nan
        _, monthly = prepare(core, derived)
        self.assertTrue(pd.isna(monthly.iloc[0].volume))
        self.assertFalse(monthly.iloc[0].complete)

    def test_conflicting_source_monthly_values_rejected(self):
        core, derived = self.fixture()
        core.loc[0, 'Monthly_Runoff_Totals_Million_m3_month'] = 999
        with self.assertRaises(HTTPException) as error:
            prepare(core, derived)
        self.assertEqual(error.exception.status_code, 503)

    def test_source_row_sums_and_annual_filter_scope(self):
        data = dashboard(region='City of Tshwane', start='2024-02', end='2024-03')
        core = self.core_fixture
        rows = core[(core.District_Name == 'City of Tshwane') & (core.Year == 2024) & core.Month.isin([2, 3])]
        self.assertAlmostEqual(data['summary']['volume'], rows.Daily_Surface_Runoff_Volume_m3_day.sum() / 1e6, places=7)
        self.assertAlmostEqual(data['summary']['baseflow'], rows.Baseflow_Component_m3s.mean(), places=7)
        self.assertEqual(data['summary']['peak_flow'], rows.Peak_Flow_Rates_m3s.max())
        self.assertEqual(data['annual'][0]['selected_months'], 2)
        self.assertFalse(data['annual'][0]['complete'])
        self.assertEqual(data['coverage']['observed_days'], 60)
        self.assertEqual(len(daily(region='City of Tshwane', month='2024-02')['series']), 29)
        json.dumps(data, allow_nan=False)

    def test_national_averages_source_constants_and_partial_month(self):
        meta = metadata()
        self.assertEqual(len(meta['regions']), 52)
        self.assertEqual(meta['constants']['area'], 6500)
        self.assertEqual(meta['default_end'], '2026-08')
        self.assertEqual(len(meta['metrics']), 23)
        data = dashboard(start='2026-09', end='2026-09')
        self.assertAlmostEqual(data['summary']['volume'], np.mean([row['volume'] for row in data['map']]), places=7)
        self.assertEqual(data['coverage']['observed_days'], 52 * 6)
        self.assertFalse(data['latest']['complete'])
        self.assertIsNone(data['latest']['previous_volume'])
        self.assertEqual([row['period'] for row in data['flood']], [2, 5, 10, 20, 50, 100])
        self.assertTrue(any('fixed multiples' in warning for warning in data['warnings']))

    def test_input_validation(self):
        for params in [{'region': 'Unknown'}, {'start': '2027-01'}, {'start': '2026-01', 'end': '2024-01'}]:
            with self.assertRaises(HTTPException):
                dashboard(**params)
        with self.assertRaises(HTTPException):
            daily(month='2024-13')

    def test_database_routes_never_read_packaged_sources(self):
        with patch.object(pd, 'read_csv', side_effect=AssertionError('Runtime CSV read forbidden')):
            meta = metadata()
            data = dashboard(region='City of Tshwane', start='2024-02', end='2024-03')
            forecast = runoff.forecast_source(region='City of Tshwane', start='2024-02', end='2024-03')
            detail = daily(region='City of Tshwane', month='2024-02')
        for result in (meta, data, forecast, detail):
            self.assertEqual(result['source'], 'Supabase')
            self.assertEqual(result['source_mode'], 'database')
            self.assertEqual(result['source_tables'], list(runoff.DEFAULT_TABLES))
            json.dumps(result, allow_nan=False)
        self.assertEqual(len(forecast['series']), 2)
        self.assertEqual(len(data['map']), 52)
        self.assertFalse(any(count for _, _, _, _, count in self.queries))

    def test_paginated_national_map_and_previous_year_survive_district_selection(self):
        data = dashboard(region='City of Tshwane', start='2024-02', end='2024-03')
        previous = self.core_fixture[(self.core_fixture.District_Name == 'City of Tshwane') & self.core_fixture.Date.str.startswith('2023-02')]
        self.assertAlmostEqual(data['series'][0]['previous_volume'], previous.Daily_Surface_Runoff_Volume_m3_day.sum() / 1e6, places=7)
        self.assertEqual(len(data['map']), 52)
        self.assertTrue(any(table == runoff.DEFAULT_TABLES[0] and start == 1000 for table, _, start, _, _ in self.queries))
        daily_reads = [params for table, params, _, _, _ in self.queries if table == runoff.DEFAULT_TABLES[0] and 'Date' in params]
        self.assertTrue(any(params.get('District_Name') == 'eq.City of Tshwane' for params in daily_reads))
        self.assertTrue(any(params.get('Date') == 'gte.2024-03-01' and 'District_Name' not in params for params in daily_reads))

    def test_database_failure_is_an_error_without_csv_fallback(self):
        with patch.object(runoff, '_request_page', side_effect=SupabaseSourceError('database unavailable')), patch.object(pd, 'read_csv', side_effect=AssertionError('CSV fallback forbidden')):
            with self.assertRaises(HTTPException) as error:
                metadata()
        self.assertEqual(error.exception.status_code, 502)
        self.assertIn('database unavailable', error.exception.detail)

    def test_missing_required_database_columns_are_reported(self):
        with patch.object(runoff, '_request_page', return_value=([{'District_Name': 'Test', 'Date': '2024-01-01'}], None)):
            with self.assertRaises(HTTPException) as error:
                metadata()
        self.assertEqual(error.exception.status_code, 502)
        self.assertIn('missing required columns', error.exception.detail)

    def test_derived_table_alias_resolves_to_the_actual_dotted_relation(self):
        def request(url, *args, **kwargs):
            if '/7_2_derived_runoff_indicators_master?' in url:
                raise SupabaseSourceError('PGRST205: Could not find the table')
            return self.request_page(url, *args, **kwargs)
        with patch.dict('os.environ', {runoff.TABLE_ENV: 'runoff_variables_master,7_2_derived_runoff_indicators_master'}), patch.object(runoff, '_request_page', side_effect=request):
            self.assertEqual(metadata()['source_tables'], list(runoff.DEFAULT_TABLES))

    def test_malformed_or_duplicate_table_configuration_is_rejected(self):
        for value in ['runoff_variables_master', 'runoff_variables_master,runoff_variables_master', 'runoff_variables_master,bad;table']:
            with patch.dict('os.environ', {runoff.TABLE_ENV: value}), self.assertRaises(HTTPException) as error:
                metadata()
            self.assertEqual(error.exception.status_code, 502)

    def test_derived_only_month_keeps_missing_volumes_and_day_counts(self):
        core, derived = self.fixture()
        _, monthly = prepare(core.iloc[:0], derived)
        self.assertTrue(pd.isna(monthly.iloc[0].volume))
        self.assertEqual(monthly.iloc[0].observed_days, 0)
        self.assertEqual(monthly.iloc[0].expected_days, 31)
        self.assertFalse(monthly.iloc[0].complete)


if __name__ == '__main__':
    unittest.main()
