import json
import unittest

from app.water_quality_service import dashboard, metadata, monthly_detail


class WaterQualityTests(unittest.TestCase):
    def test_metadata_covers_all_section_12_networks(self):
        result = metadata()
        self.assertEqual(result['default_start'], 2000)
        self.assertEqual(result['default_end'], 2026)
        self.assertEqual(len(result['regions']), 52)
        self.assertEqual(set(result['rows']), {'physical', 'chemical', 'biological', 'sansa'})
        self.assertIn('ecoli_cfu_100ml', [metric['key'] for metric in result['metrics']])
        self.assertIn('sansa_turbidity_proxy', [metric['key'] for metric in result['metrics']])

    def test_district_dashboard_keeps_all_map_districts_and_values(self):
        result = dashboard(region='City of Tshwane', start=2025, end=2026)
        self.assertEqual(len(result['map']), 52)
        self.assertEqual(result['quality']['missing_values'], 0)
        self.assertIsNotNone(result['latest']['ph'])
        self.assertIsNotNone(result['latest']['ecoli_cfu_100ml'])
        self.assertIsNotNone(result['latest']['sansa_turbidity_proxy'])
        json.dumps(result, allow_nan=False)

    def test_monthly_detail_returns_partial_latest_year(self):
        result = monthly_detail(region='City of Tshwane', year=2026)
        self.assertEqual(result['year'], 2026)
        self.assertEqual(len(result['series']), 10)


if __name__ == '__main__':
    unittest.main()
