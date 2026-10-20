import json
import unittest
from unittest.mock import patch

import numpy as np
import pandas as pd
from fastapi import HTTPException

from app import rainfall_service as rainfall
from app.dashboard_loader import clear_dashboard_cache
from app.rainfall_service import (DAILY, MONTHLY, ANNUAL, INDICES,
                                  prepare, metadata, dashboard, daily)


class RainfallTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.regions = ['City of Tshwane', *[f'District {index:02}' for index in range(1, 52)]]
        rows, indices = [], []
        months = [str(period) for period in pd.period_range('2024-01', '2024-12', freq='M')] + ['2026-08', '2026-09']
        for index, region in enumerate(cls.regions):
            for month in months:
                period = pd.Period(month, freq='M')
                count = 6 if month == '2026-09' else period.days_in_month
                value = float(index + 1)
                rows.extend({'District_Name': region, 'Date': pd.Timestamp(f'{month}-{day:02}'),
                             'Year': period.year, 'Month': period.month,
                             **dict.fromkeys(DAILY, value), **dict.fromkeys(MONTHLY, 0.),
                             **dict.fromkeys(ANNUAL, 366. * value),
                             'Hourly_Rainfall_Intensity_mm_h': value / 6,
                             'Monthly_Total_Precipitation_mm': period.days_in_month * value,
                             'TAMSAT_Satellite_Rainfall_Estimate_mm_dekad': 10.}
                            for day in range(1, count + 1))
                indices.append({'District_Name': region, 'Year': period.year, 'Month': period.month,
                                **dict.fromkeys(INDICES, -1.2)})
        cls.source = pd.DataFrame(rows)
        cls.indices = pd.DataFrame(indices)
        cls.meta = {'regions': cls.regions, 'months': months, 'default_start': '2024-01', 'default_end': '2026-08',
                    'source': 'Supabase', 'source_tables': list(rainfall.DEFAULT_TABLES),
                    'latest_date': '2026-09-06', 'gridded_matches_daily': True, 'intensity_matches_daily_div6': True}

    def setUp(self):
        clear_dashboard_cache()
        snapshot = {'base': 'https://rainfall.test.invalid', 'key': 'test-key',
                    'tables': dict(zip(('core', 'indices', 'runoff'), rainfall.DEFAULT_TABLES)),
                    'core_actual': {key: key for key in rainfall.CORE_COLUMNS},
                    'index_actual': {key: key for key in INDICES}}
        for name, value in [('_snapshot', {'return_value': snapshot}), ('_metadata', {'return_value': self.meta}),
                            ('_read_core_window', {'side_effect': self.read_core}),
                            ('_read_indices', {'side_effect': self.read_indices}),
                            ('_read_runoff_window', {'return_value': pd.DataFrame()}),
                            ('_daily_rows', {'side_effect': lambda snapshot, month, region: self.read_core(snapshot, month, month, region)})]:
            mock = patch.object(rainfall, name, **value)
            mock.start()
            self.addCleanup(mock.stop)
        self.addCleanup(clear_dashboard_cache)

    def read_core(self, snapshot, start, end, region, **kwargs):
        frame = self.source
        selected = frame.Date.dt.strftime('%Y-%m').between(start, end)
        if region:
            selected &= frame.District_Name.eq(region)
        return frame[selected].copy()

    def read_indices(self, snapshot, start, end, region):
        frame = self.indices
        selected = pd.to_datetime(dict(year=frame.Year, month=frame.Month, day=1)).dt.strftime('%Y-%m').between(start, end)
        if region:
            selected &= frame.District_Name.eq(region)
        return frame[selected].copy()

    def fixture(self):
        rows = []
        for day in range(1, 32):
            rows.append({'District_Name': 'Test', 'Date': f'2024-01-{day:02}',
                         **dict.fromkeys(DAILY, 2.0), **dict.fromkeys(MONTHLY, 62.0),
                         **dict.fromkeys(ANNUAL, 100.0), 'TAMSAT_Satellite_Rainfall_Estimate_mm_dekad': 10.0})
        indices = pd.DataFrame([{'District_Name': 'Test', 'Year': 2024, 'Month': 1, **dict.fromkeys(INDICES, -1.2)}])
        return pd.DataFrame(rows), indices

    def test_cadences_not_multiplied_and_duplicate_daily_rows_not_counted(self):
        core, indices = self.fixture()
        core = pd.concat([core, core.iloc[[0]]], ignore_index=True)
        _, monthly, annual = prepare(core, indices)
        row = monthly.iloc[0]
        self.assertEqual(row.rainfall, 62)
        self.assertEqual(row.reported_rainfall, 62)
        self.assertEqual(row.rainy_days, 31)
        self.assertEqual(row.tamsat, 30, 'Repeated dekadal estimates must be counted three times, not 31 times')
        self.assertEqual(row.dekads, 3)
        self.assertTrue(row.complete)
        self.assertEqual(annual.iloc[0].annual_rainfall, 100)
        self.assertTrue(pd.isna(annual.iloc[0].OND), 'An unobserved season must not be zero')
        self.assertFalse(annual.iloc[0].JFM_complete)

    def test_missing_measurements_are_not_dry_days_or_zero_totals(self):
        core, indices = self.fixture()
        core['Daily_Rainfall_Total_mm'] = np.nan
        _, monthly, _ = prepare(core, indices)
        self.assertTrue(pd.isna(monthly.iloc[0].rainfall))
        self.assertTrue(pd.isna(monthly.iloc[0].rainy_days))
        self.assertFalse(monthly.iloc[0].complete)
        self.assertEqual(monthly.iloc[0].observed_days, 0)

    def test_inconsistent_repeated_totals_rejected(self):
        core, indices = self.fixture()
        core.loc[0, 'Monthly_Total_Precipitation_mm'] = 999
        with self.assertRaises(HTTPException) as error:
            prepare(core, indices)
        self.assertEqual(error.exception.status_code, 503)

    def test_source_row_totals_indices_and_year_context(self):
        result = dashboard(region='City of Tshwane', start='2024-01', end='2024-12')
        core = self.source
        source = core[(core.District_Name == 'City of Tshwane') & (core.Year == 2024)]
        self.assertAlmostEqual(result['summary']['rainfall'], source.Daily_Rainfall_Total_mm.sum(), places=7)
        self.assertEqual(result['summary']['rainy_days'], (source.Daily_Rainfall_Total_mm >= 1).sum())
        self.assertEqual(result['annual'][0]['annual_rainfall'], source.Annual_Total_Precipitation_mm.iloc[0])
        self.assertEqual(result['coverage']['complete_months'], 12)
        self.assertEqual(result['coverage']['observed_days'], 366)
        self.assertEqual(len(result['map']), 52)
        json.dumps(result, allow_nan=False)

    def test_partial_latest_month_and_satellite_alignment(self):
        partial = dashboard(start='2026-09', end='2026-09')
        self.assertFalse(partial['latest']['complete'])
        self.assertIsNone(partial['latest']['previous_year'])
        self.assertEqual(partial['coverage']['observed_days'], 6 * 52)
        self.assertEqual(partial['coverage']['expected_days'], 30 * 52)
        self.assertEqual(partial['satellite_agreement']['months'], 0)
        self.assertIsNone(partial['satellite_agreement']['bias_mm'])
        self.assertIsNone(partial['seasonal'][-1]['rainfall'])
        series = daily(region='City of Tshwane', month='2026-09')
        self.assertEqual(len(series['series']), 6)
        self.assertEqual(len(series['dekads']), 1)

    def test_national_average_and_metadata(self):
        meta = metadata()
        self.assertEqual(len(meta['regions']), 52)
        self.assertEqual(meta['default_end'], '2026-08')
        self.assertTrue(meta['gridded_matches_daily'])
        data = dashboard(start='2026-08', end='2026-08')
        self.assertAlmostEqual(data['latest']['rainfall'], np.mean([row['rainfall'] for row in data['map']]), places=8)
        self.assertTrue(all(key in data['latest'] for key in INDICES.values()))

    def test_validation(self):
        for params in [{'region': 'Unknown'}, {'start': '2027-01'}, {'start': '2026-01', 'end': '2024-01'}]:
            with self.assertRaises(HTTPException):
                dashboard(**params)
        with self.assertRaises(HTTPException):
            daily(month='2026-13')


if __name__ == '__main__':
    unittest.main()
