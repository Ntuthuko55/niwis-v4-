import json
import unittest

import numpy as np
import pandas as pd
from fastapi import HTTPException

from app.runoff_service import CORE, DERIVED, ROOT, FILES, prepare, metadata, dashboard, daily


class RunoffTests(unittest.TestCase):
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

    def test_real_file_sums_and_annual_filter_scope(self):
        data = dashboard(region='City of Tshwane', start='2024-02', end='2024-03')
        core = pd.read_csv(ROOT / FILES[0])
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


if __name__ == '__main__':
    unittest.main()
