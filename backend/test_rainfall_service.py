import json
import unittest

import numpy as np
import pandas as pd
from fastapi import HTTPException

from app.rainfall_service import (DAILY, MONTHLY, ANNUAL, INDICES, FILES, ROOT,
                                  prepare, metadata, dashboard, daily)


class RainfallTests(unittest.TestCase):
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

    def test_real_file_totals_indices_and_year_context(self):
        result = dashboard(region='City of Tshwane', start='2024-01', end='2024-12')
        core = pd.read_csv(ROOT / FILES[0])
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
