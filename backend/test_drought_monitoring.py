import json
import unittest
from unittest.mock import patch

from app.drought_monitoring import source_analysis, seasonal_comparison, aligned_analysis, overview
from app.supabase_source import SupabaseSourceError


class MonitoringTests(unittest.TestCase):
    def test_daily_totals_exclude_partial_month_and_duplicates(self):
        rows = [{'id': day, 'date': f'2025-01-{day:02}', 'daily_rainfall_mm_day': 2,
                 'monthly_rainfall_mm_month': 62, 'tavg_c': 20, 'tmax_c': 36, 'tmin_c': -1}
                for day in range(1, 32)]
        rows += [{'id': 40, 'date': '2025-01-31', 'daily_rainfall_mm_day': 2,
                  'tavg_c': 20, 'tmax_c': 36, 'tmin_c': -1},
                 {'id': 41, 'date': '2025-02-01', 'daily_rainfall_mm_day': 2}]
        result = source_analysis('meteorological', rows)
        jan, feb = result['monthly']
        self.assertEqual(jan['rainfall_mm'], 62)
        self.assertEqual(jan['hot_days'], 31)
        self.assertEqual(jan['frost_days'], 31)
        self.assertFalse(feb['complete'])
        self.assertIsNone(feb['rainfall_mm'])
        self.assertEqual(result['records'], 32)
        json.dumps(result, allow_nan=False)

    def test_seasonal_baseline_excludes_current_and_other_months(self):
        points = [{'month': f'{year}-01', 'rainfall_mm': value, 'complete': True}
                  for year, value in [(2021, 10), (2022, 20), (2023, 30), (2024, 30)]]
        points.insert(2, {'month': '2022-02', 'rainfall_mm': 999, 'complete': True})
        result = seasonal_comparison(points, 'rainfall_mm')
        self.assertEqual(result['baseline'], 20)
        self.assertEqual(result['change_pct'], 50)
        self.assertEqual(result['baseline_years'], 3)

    def test_alignment_uses_shared_complete_month(self):
        sources = {
            'meteorological': {'monthly': [{'month': '2025-12', 'complete': True, 'spi_3': -1.2}, {'month': '2026-01', 'complete': True, 'spi_3': 2}]},
            'hydrological': {'monthly': [{'month': '2025-12', 'complete': True, 'ssi_dimensionless': -.2}]},
            'satellite': {'monthly': [{'month': '2025-12', 'complete': True, 'vhi': 35}]},
        }
        result = aligned_analysis(sources)
        self.assertEqual(result['month'], '2025-12')
        self.assertEqual(result['dry_count'], 2)
        self.assertIsNone(result['spi_ssi_correlation'])
        sources['satellite']['monthly'] = []
        result = aligned_analysis(sources)
        self.assertIsNone(result['month'])
        self.assertEqual(result['available_signals'], 0)

    def test_partial_source_outage_is_explicit(self):
        def history(table, region):
            if table == 'satellite_remote_sensing':
                raise SupabaseSourceError('Unavailable')
            return []
        with patch('app.drought_monitoring.region_history', side_effect=history):
            result = overview('Test')
        self.assertEqual(result['sources']['satellite']['status'], 'error')
        self.assertEqual(result['sources']['hydrological']['status'], 'empty')


if __name__ == '__main__':
    unittest.main()
