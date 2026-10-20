import json
import unittest
from unittest.mock import patch

import numpy as np
import pandas as pd
from fastapi import HTTPException

from app import reservoir_service as reservoirs


class ReservoirTests(unittest.TestCase):
    def raw_row(self, name='Test', date='2024-01-01'):
        return {'district_id': 'D_UNMAPPED', 'district_name': name, 'province': 'Test province',
                'dam_name': 'Test reservoir', 'river': 'Test river', 'date': date,
                'storage_volume_m3': 250000000., 'pct_fsc': 50., 'fsl_m_amsl': 1200.,
                'water_level_m_amsl': 1197.5, 'inflow_m3_s': 3., 'outflow_m3_s': 2.,
                'evaporation_mm_day': 5., 'seepage_m3_day': 6., 'rainfall_mm_day': 7.,
                'runoff_mm_day': 2., 'district_area_km2': 100., 'water_area_km2': 10., 'mean_ndwi': -.25}

    def history(self, declining=True):
        dates = pd.date_range('2024-01-01', '2024-01-31')
        return pd.DataFrame({'date': dates, 'storage': 100. - np.arange(31) if declining else 100.,
                             'level': 1200. - np.arange(31) / 10})

    def test_units_and_reused_id_do_not_merge_histories(self):
        raw = pd.DataFrame([self.raw_row('One'), self.raw_row('Two')])
        data = reservoirs.prepare(raw)
        self.assertEqual(len(data), 2)
        self.assertEqual(data.storage.tolist(), [250., 250.])
        self.assertEqual(data.runoff.tolist(), [200000., 200000.])
        self.assertEqual(data.inflow.tolist(), [3., 3.])
        self.assertEqual(data.seepage.tolist(), [6., 6.])
        self.assertEqual(data.ndwi.tolist(), [-.25, -.25])
        with self.assertRaises(HTTPException) as error:
            reservoirs.prepare(pd.concat([raw, raw.iloc[[0]]]))
        self.assertEqual(error.exception.status_code, 503)

    def test_missing_source_values_stay_unknown(self):
        row = self.raw_row()
        row.update(storage_volume_m3=None, inflow_m3_s='invalid', runoff_mm_day=np.inf)
        data = reservoirs.prepare(pd.DataFrame([row]))
        self.assertTrue(data[['storage', 'inflow', 'runoff']].iloc[0].isna().all())
        self.assertEqual(reservoirs.clean(data.iloc[0][['storage', 'inflow', 'runoff']].to_dict()),
                         {'storage': None, 'inflow': None, 'runoff': None})

    def test_exact_alert_thresholds(self):
        for value, expected in [(0, 3), (14.999, 3), (15, 2), (29.999, 2), (30, 1), (49.999, 1), (50, 0), (100, 0)]:
            self.assertEqual(reservoirs.critical_level(value)['level'], expected)
        for missing in [None, np.nan]:
            self.assertIsNone(reservoirs.critical_level(missing)['level'])

    def test_drawdown_requires_complete_declining_window(self):
        end = pd.Timestamp('2024-01-31')
        result = reservoirs.derived_indicators(self.history(), end)
        self.assertAlmostEqual(result['weekly_level_change'], -.7)
        self.assertEqual(result['drawdown'], 1.)
        self.assertEqual(result['days_to_empty'], 70.)
        self.assertIsNone(result['dir'])
        for history in [self.history(False), self.history().drop(index=10)]:
            result = reservoirs.clean(reservoirs.derived_indicators(history, end))
            self.assertIsNone(result['days_to_empty'])
        missing = self.history()
        missing.loc[10, 'storage'] = np.nan
        self.assertIsNone(reservoirs.clean(reservoirs.derived_indicators(missing, end))['days_to_empty'])

    def test_monthly_change_is_relative_storage_and_rsi_uses_prior_years(self):
        history = pd.concat([self.history(), pd.DataFrame([
            {'date': pd.Timestamp('2023-12-31'), 'storage': 100., 'level': 1200.},
            *[{'date': pd.Timestamp(f'{year}-01-01'), 'storage': stock, 'level': 1200.}
              for year, stock in [(2021, 10.), (2022, 20.), (2023, 30.)]],
            {'date': pd.Timestamp('2025-01-01'), 'storage': 999999., 'level': 1200.},
        ])], ignore_index=True)
        result = reservoirs.derived_indicators(history, pd.Timestamp('2024-01-31'))
        self.assertAlmostEqual(result['monthly_storage_change'], -30.)
        self.assertEqual(result['rsi_years'], 3)
        self.assertAlmostEqual(result['rsi'], 5.)
        history.loc[history.date.dt.year.lt(2024), 'storage'] = 100.
        result = reservoirs.clean(reservoirs.derived_indicators(history, pd.Timestamp('2024-01-31')))
        self.assertIsNone(result['rsi'], 'A constant historical baseline is undefined, not zero')

    def test_future_rows_filtered_and_no_timezone_or_invalid_periods(self):
        rows = [self.raw_row(date='2024-01-01'), self.raw_row(date='2024-01-02'), self.raw_row(date='2024-01-03')]
        rows[-1]['storage_volume_m3'] = 999999999.
        frame = reservoirs.prepare(pd.DataFrame(rows))
        catalogue = frame.groupby('district_name')[['district_id', 'province', 'dam_name', 'river']].first().reset_index()
        info = {'source': 'Supabase', 'table': 'test', 'file': 'test', 'first_date': '2024-01-01',
                'observed_end': '2024-01-02', 'regions': catalogue.to_dict('records'),
                'future_rows_excluded': 1, 'has_future_records': True}
        def window(version, start, end, region=None):
            return frame[frame.date.between(pd.Timestamp(start), pd.Timestamp(end)) &
                         (frame.district_name.eq(region) if region else True)].copy()
        with patch.object(reservoirs, 'signature', return_value=1), \
             patch.object(reservoirs, '_overview', return_value=info), \
             patch.object(reservoirs, '_read_window', side_effect=window), \
             patch.object(reservoirs, '_indicator_history', return_value=frame[frame.date.le('2024-01-02')]):
            result = reservoirs.dashboard(region='Test', start='2024-01-01', end='2024-01-02', as_of='2024-01-02')
            self.assertEqual(result['latest']['storage'], 250.)
            self.assertEqual(len(result['series']), 2)
            self.assertEqual(result['future_rows_excluded'], 1)
            json.dumps(result, allow_nan=False)
            for filters in [{'end': '2024-01-03'}, {'start': '2024-01-02', 'end': '2024-01-01'},
                            {'end': '2024-01-02T00:00:00Z'}, {'start': 'bad'}, {'region': 'Unknown'}]:
                with self.assertRaises(HTTPException):
                    reservoirs.dashboard(region=filters.get('region', 'Test'), as_of='2024-01-02',
                                         **{key: value for key, value in filters.items() if key != 'region'})

    def test_source_profile_inventory_and_national_stock_mean(self):
        rows = []
        for index, name in enumerate(['City of Tshwane', 'Siyanda', 'Z F Mgcawu']):
            for day in ('2024-06-29', '2024-06-30'):
                row = self.raw_row(name, day)
                row['storage_volume_m3'] = (index + 1) * 100000000.
                row['dam_name'] = 'Gariep' if index == 0 else 'Test reservoir'
                rows.append(row)
        raw = pd.DataFrame(rows)
        snapshot = {'table': reservoirs.DEFAULT_TABLE}
        with patch.object(reservoirs, '_snapshot', return_value=snapshot), \
             patch.object(reservoirs, '_read_all', return_value=raw):
            frame, catalogue, meta = reservoirs.dataset('offline-reference')
        self.assertEqual(meta['rows'], 6)
        self.assertEqual(meta['groups'], 3)
        self.assertEqual(meta['constant_storage_groups'], 3)
        self.assertEqual(meta['missing_values'], 0)
        self.assertTrue(meta['has_overlapping_alias'])
        self.assertEqual(meta['id_collisions'], 1)
        info = {**meta, 'observed_end': '2024-06-30', 'regions': catalogue.to_dict('records'),
                'future_rows_excluded': None, 'has_future_records': True}
        def window(version, start, end, region=None):
            return frame[frame.date.between(pd.Timestamp(start), pd.Timestamp(end))].copy()
        with patch.object(reservoirs, 'signature', return_value=1), \
             patch.object(reservoirs, '_overview', return_value=info), \
             patch.object(reservoirs, '_read_window', side_effect=window):
            metadata = reservoirs.metadata(as_of='2024-06-30')
            self.assertEqual(metadata['default_end'], '2024-06-30')
            self.assertEqual(len(metadata['metrics']), 12)
            inventory = {item['name']: item['groups'] for item in metadata['priority']}
            self.assertEqual(inventory['Gariep'], ['City of Tshwane'])
            self.assertEqual(inventory['Vanderkloof'], [])
            self.assertEqual(inventory['Katse'], [])
            data = reservoirs.dashboard(region='National', start='2024-06-30', end='2024-06-30', as_of='2024-06-30')
        self.assertEqual(len(data['map']), 3)
        self.assertAlmostEqual(data['latest']['storage'], np.mean([row['storage'] for row in data['map']]), places=6)
        self.assertIsNone(data['indicators']['rsi'])
        self.assertIsNone(data['indicators']['dir'])
        self.assertIn('not national totals', ' '.join(data['warnings']))
        json.dumps(data, allow_nan=False)


if __name__ == '__main__':
    unittest.main()
