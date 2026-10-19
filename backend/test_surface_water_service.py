import json
import unittest
from unittest.mock import patch

import numpy as np
import pandas as pd
from fastapi import HTTPException

from app.surface_water_service import HYDRO, EO, ROOT, FILES, prepare, metadata, dashboard, daily


class SurfaceWaterTests(unittest.TestCase):
    def fixture(self):
        hydro = pd.DataFrame([{**dict.fromkeys(HYDRO, 1.), 'district_name': 'Test', 'date': f'2024-01-{day:02}',
                               'daily_mean_flow': 172800., 'river_discharge_q': 2., 'daily_sediment_load_t_day': 3.,
                               'monthly_mean_flow': 5356800., 'monthly_sediment_load_t_day': 7.} for day in range(1, 32)])
        catchments = pd.DataFrame([{'district_name': 'Test', 'catchment_area_km2': 100.}])
        eo = pd.DataFrame([{**dict.fromkeys(EO, .5), 'district_name': 'Test', 'date': '2024-01-01', 'surface_water_extent_km2': 12.}])
        return hydro, catchments, eo

    def test_cadences_units_and_missing_bfi(self):
        hydro, catchments, eo = self.fixture()
        hydro = pd.concat([hydro, hydro.iloc[[0]]], ignore_index=True)
        _, data, _ = prepare(hydro, catchments, eo)
        row = data.iloc[0]
        self.assertAlmostEqual(row.volume, 5.3568)
        self.assertEqual(row.reported_monthly_volume, 5356800.)
        self.assertEqual(row.discharge, 2.)
        self.assertEqual(row.volume_equivalent_q, 2.)
        self.assertEqual(row.sediment_total, 93.)
        self.assertEqual(row.reported_sediment_rate, 7.)
        self.assertEqual(row.water_extent, 12., 'Monthly extent must not be repeated into a sum')
        self.assertEqual(row.observed_days, 31)
        self.assertTrue(row.complete)
        self.assertEqual(row.flow_mismatch_days, 0)
        self.assertTrue(pd.isna(row.bfi))

    def test_conflicting_monthly_values_omitted_without_replacing_observations(self):
        hydro, catchments, eo = self.fixture()
        hydro.loc[0, 'monthly_mean_flow'] = 100
        hydro['river_discharge_q'] = 3.
        _, data, _ = prepare(hydro, catchments, eo)
        self.assertTrue(data.iloc[0].volume_conflict)
        self.assertTrue(pd.isna(data.iloc[0].reported_monthly_volume))
        self.assertEqual(data.iloc[0].discharge, 3.)
        self.assertEqual(data.iloc[0].flow_mismatch_days, 31)
        self.assertAlmostEqual(data.iloc[0].volume, 5.3568)

    def test_missing_daily_measurements_remain_unknown(self):
        hydro, catchments, eo = self.fixture()
        hydro['daily_mean_flow'] = np.nan
        _, data, _ = prepare(hydro, catchments, eo)
        self.assertTrue(pd.isna(data.iloc[0].volume))
        self.assertFalse(data.iloc[0].complete)
        self.assertEqual(data.iloc[0].observed_days, 0)

    def test_source_files_and_static_attributes_are_not_renormalised(self):
        meta = metadata()
        self.assertEqual(len(meta['regions']), 52)
        self.assertEqual(len(meta['metrics']), 17)
        self.assertEqual(meta['default_end'], '2026-08')
        data = dashboard(region='City of Cape Town', start='2024-02', end='2024-02')
        source = pd.read_csv(ROOT / FILES[0])
        rows = source[(source.district_name == 'City of Cape Town') & (source.year == 2024) & (source.month == 2)]
        self.assertAlmostEqual(data['summary']['volume'], rows.daily_mean_flow.sum() / 1e6, places=8)
        self.assertAlmostEqual(data['latest']['discharge'], rows.river_discharge_q.mean(), places=8)
        self.assertEqual(data['coverage']['observed_days'], 29)
        self.assertGreater(data['profile']['land_cover_sum'], 100.)
        self.assertFalse(data['profile']['land_cover_valid_partition'])
        self.assertAlmostEqual(sum(row['percent'] for row in data['land_cover']), data['profile']['land_cover_sum'])
        self.assertAlmostEqual(data['profile']['catchment_area_km2'], 2458.11)
        self.assertIsNone(data['latest']['bfi'])
        json.dumps(data, allow_nan=False)

    def test_partial_conflicting_september_and_region_rating(self):
        data = dashboard(region='City of Tshwane', start='2026-09', end='2026-09')
        self.assertEqual(data['coverage']['observed_days'], 24)
        self.assertEqual(data['coverage']['expected_days'], 30)
        self.assertEqual(data['coverage']['conflicting_district_months'], 1)
        self.assertTrue(data['latest']['volume_conflict'])
        self.assertIsNone(data['latest']['reported_monthly_volume'])
        self.assertIsNone(data['latest']['previous_discharge'])
        self.assertEqual(data['rating']['rating_r2'], 0.)
        self.assertEqual(len(daily(region='City of Tshwane', month='2026-09')['series']), 24)

    def test_national_rating_not_averaged_and_optional_weather_failure(self):
        with patch('app.rainfall_service.signature', side_effect=HTTPException(503, 'Source unavailable')):
            data = dashboard(start='2026-08', end='2026-08')
        self.assertIsNone(data['rating'])
        self.assertEqual(data['weather']['status'], 'unavailable')
        self.assertEqual(len(data['map']), 52)
        self.assertAlmostEqual(data['latest']['discharge'], np.mean([row['discharge'] for row in data['map']]), places=8)

    def test_invalid_filters(self):
        for params in [{'region': 'Unknown'}, {'start': '2027-01'}, {'start': '2026-01', 'end': '2024-01'}]:
            with self.assertRaises(HTTPException):
                dashboard(**params)

    def test_historical_names_match_rainfall_context(self):
        for name in ['Siyanda', 'Greater Sekhukhune', 'Pixley Ka Seme', 'UMgungundlovu']:
            data = dashboard(region=name, start='2026-08', end='2026-08')
            self.assertEqual(data['weather']['status'], 'available')
            self.assertEqual(len(data['weather']['series']), 1)
            self.assertIsNotNone(data['series'][0]['rainfall'])


if __name__ == '__main__':
    unittest.main()
