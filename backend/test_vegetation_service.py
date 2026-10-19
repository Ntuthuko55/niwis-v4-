import json
import unittest

import numpy as np
import pandas as pd
from fastapi import HTTPException

from app.vegetation_service import (ALL_KEYS, SAT_KEYS, ROOT, FILES, aggregate_satellite,
                                    comparisons, dashboard, metadata)


class VegetationTests(unittest.TestCase):
    def test_daily_aggregation_deduplicates_and_marks_missing_days(self):
        rows = [{**dict.fromkeys(SAT_KEYS, None), 'District_Name': 'Test',
                 'Date': f'2024-01-{day:02}', 'NDVI_10day_composite': .2} for day in range(1, 32)]
        rows += [rows[0].copy(), {**rows[0], 'Date': '2024-02-01', 'NDVI_10day_composite': .8}]
        result = aggregate_satellite(pd.DataFrame(rows))
        self.assertEqual(result.observed_days.tolist(), [31, 1])
        self.assertEqual(result.expected_days.tolist(), [31, 29])
        self.assertEqual(result.complete.tolist(), [True, False])
        self.assertAlmostEqual(result.NDVI_10day_composite.iloc[0], .2)
        self.assertTrue(pd.isna(result.EVI.iloc[0]), 'Missing observations must not become zeros')

    def test_baseline_uses_only_prior_same_month_complete_years(self):
        full = pd.DataFrame([{**dict.fromkeys(ALL_KEYS, value), 'month': month, 'complete': complete}
                             for month, value, complete in [('2019-01', 99, True), ('2020-01', .1, True),
                                 ('2021-01', .2, True), ('2022-01', 88, False), ('2023-01', .3, True),
                                 ('2024-01', .4, True), ('2024-02', 77, True), ('2025-01', .5, True), ('2026-01', 66, True)]]).set_index('month')
        selected, changes = comparisons(full, '2025-01', '2025-01')
        self.assertEqual(selected.baseline_years.iloc[0], 4)
        self.assertAlmostEqual(selected.ndvi_baseline.iloc[0], .25)
        self.assertAlmostEqual(selected.ndvi_anomaly_percent.iloc[0], 100)
        self.assertAlmostEqual(changes['NDVI_10day_composite']['difference'], .1)
        full.loc['2025-01', 'complete'] = False
        _, changes = comparisons(full, '2025-01', '2025-01')
        self.assertIsNone(changes['NDVI_10day_composite']['difference'])
        self.assertEqual(changes['NDVI_10day_composite']['paired_months'], 0)

    def test_actual_sources_units_join_and_comparison(self):
        meta = metadata()
        self.assertEqual(len(meta['regions']), 52)
        self.assertEqual(len(meta['metrics']), 25)
        self.assertEqual(meta['default_end'], '2026-08')
        data = dashboard(region='City of Tshwane', start='2024-01', end='2024-12')
        source = pd.read_csv(ROOT / FILES[1])
        source = source[(source.District_Name == 'City of Tshwane') & (source.Year == 2024)]
        self.assertAlmostEqual(data['summary']['Monthly_Rainfall_mm'], source.Monthly_Rainfall_mm.mean(), places=8)
        self.assertAlmostEqual(data['series'][0]['Potential_Evapotranspiration_ET0_mm'], source.iloc[0].Potential_Evapotranspiration_ET0_mm, places=8)
        self.assertEqual(data['coverage']['complete_months'], 11)
        self.assertEqual(data['deltas']['NDVI_10day_composite']['paired_months'], 11)
        json.dumps(data, allow_nan=False)

    def test_national_values_are_district_means_and_short_correlations_unavailable(self):
        data = dashboard(start='2026-08', end='2026-08')
        self.assertAlmostEqual(data['summary']['NDVI_10day_composite'], np.mean([row['NDVI_10day_composite'] for row in data['map']]), places=8)
        self.assertTrue(all(row['r'] is None for row in data['correlations']))
        self.assertEqual(len(data['ranking']), 52)
        scores = [row['VHI_percent'] for row in data['ranking']]
        self.assertEqual(scores, sorted(scores, reverse=True))

    def test_driver_correlations_and_partial_latest_month(self):
        data = dashboard(start='2024-09', end='2026-08', lag=1)
        self.assertTrue(any(row['r'] is not None for row in data['correlations']))
        self.assertTrue(all(row['pairs'] >= 12 for row in data['correlations']))
        partial = dashboard(start='2026-09', end='2026-09')
        self.assertEqual(partial['coverage']['complete_months'], 0)
        self.assertEqual(partial['coverage']['observed_days'], 6 * 52)
        self.assertEqual(partial['coverage']['expected_days'], 30 * 52)
        self.assertTrue(any('incomplete' in warning for warning in partial['warnings']))
        self.assertIsNone(partial['deltas']['NDVI_10day_composite']['difference'])

    def test_request_validation(self):
        for kwargs in [{'region': 'Unknown'}, {'start': '2025-13'}, {'start': '2026-01', 'end': '2020-01'}, {'lag': 9}]:
            with self.assertRaises(HTTPException):
                dashboard(**kwargs)


if __name__ == '__main__':
    unittest.main()
