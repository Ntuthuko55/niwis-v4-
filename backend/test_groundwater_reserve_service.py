import unittest

from app.groundwater_reserve_service import dashboard, metadata, monthly_detail


class GroundwaterReserveTests(unittest.TestCase):
    def test_metadata_covers_section_11_files_and_districts(self):
        result = metadata()
        self.assertEqual(result['default_start'], 2000)
        self.assertEqual(result['default_end'], 2026)
        self.assertEqual(len(result['regions']), 52)
        self.assertEqual(result['rows']['hydrogeology'], 16744)
        self.assertIn('reserve_balance_million_m3_yr', [metric['key'] for metric in result['metrics']])

    def test_balance_and_map_remain_available_for_district_selection(self):
        result = dashboard(region='City of Tshwane', start=2025, end=2026)
        latest = result['latest']
        expected = (latest['dynamic_reserve_million_m3_yr']
                    - latest['total_abstraction_m3_yr'] / 1_000_000
                    + latest['storage_change_million_m3_yr'])
        self.assertAlmostEqual(latest['reserve_balance_million_m3_yr'], expected)
        self.assertEqual(len(result['map']), 52)
        self.assertTrue(all(row['reserve_balance_million_m3_yr'] is not None for row in result['map']))

    def test_monthly_detail_preserves_source_periods(self):
        result = monthly_detail(region='City of Tshwane', year=2026)
        self.assertEqual(result['year'], 2026)
        self.assertEqual(len(result['series']), 10)
        self.assertTrue(all('reserve_balance_million_m3_yr' in row for row in result['series']))


if __name__ == '__main__':
    unittest.main()
