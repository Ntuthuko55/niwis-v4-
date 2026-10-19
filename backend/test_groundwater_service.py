import unittest

from app.groundwater_service import dashboard


class GroundwaterLevelTests(unittest.TestCase):
    def test_hydraulic_head_map_uses_latest_available_observations(self):
        result = dashboard(start="2000-01", end="2026-12")

        self.assertEqual(len(result["map"]), 52)
        self.assertEqual(result["map_periods"]["hydraulic_head_amsl_m"], "2026-10")
        self.assertTrue(all(row["hydraulic_head_amsl_m"] is not None for row in result["map"]))

    def test_district_selection_keeps_complete_network_map(self):
        result = dashboard(region="City of Tshwane", start="2025-01", end="2026-12")

        self.assertEqual(len(result["map"]), 52)
        self.assertTrue(all("district_name" in row for row in result["map"]))


if __name__ == "__main__":
    unittest.main()
