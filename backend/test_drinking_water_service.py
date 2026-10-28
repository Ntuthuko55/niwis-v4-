"""Checks for observation-based compliance, independent of a live database."""
import json
import unittest
from unittest.mock import patch

from fastapi import HTTPException

from app.drinking_water_service import (
    INDICATORS,
    _dashboard_value,
    _limit_bounds,
    _read_source,
)


def observation(district="District A", month=1, score=80.0):
    row = {"district_name": district, "shapeID": district.replace(" ", "-"),
           "year": 2026, "month": month, "SANS_241_Compliance_Score": score}
    for _, label, _, category, prefix in INDICATORS:
        classification = "Health" if category == "Microbiological" or prefix in {"Nitrate", "Fluoride", "Arsenic", "Lead", "Cyanide", "Total_THMs"} else "Aesthetic"
        limit = "0 cfu/100 mL" if category == "Microbiological" else "<= 1 mg/L"
        if prefix == "pH":
            limit = "6.0–9.0"
        if prefix == "Free_Chlorine":
            limit = "0.2–5.0 mg/L"
            classification = "Treatment"
        row.update({f"{prefix}_Category": category, f"{prefix}_Parameter": label,
                    f"{prefix}_Limit": limit, f"{prefix}_Class": classification,
                    f"{prefix}_Source": "WTP", f"{prefix}_Value": 0.5,
                    f"{prefix}_Compliant": True})
    return row


def source(rows):
    return {"table": "14.1_SANS_241_compliance_master", "sample": rows[0], "rows": rows}


class DrinkingWaterServiceTests(unittest.TestCase):
    def test_missing_observations_are_unassessed_and_zero_is_retained(self):
        first = observation()
        first["E_coli_Value"] = 0
        first["E_coli_Compliant"] = False
        first["Lead_Value"] = None
        first["Lead_Compliant"] = False
        first["Cyanide_Compliant"] = None
        second = observation("District B")
        second["E_coli_Compliant"] = None
        result = _dashboard_value(source([first, second]), "National", 2026, 2026)
        parameters = {item["key"]: item for item in result["parameter_compliance"]}
        self.assertEqual(parameters["ecoli_cfu_100ml"]["assessed"], 1)
        self.assertEqual(parameters["ecoli_cfu_100ml"]["failed"], 1)
        self.assertEqual(parameters["ecoli_cfu_100ml"]["pass_pct"], 0)
        self.assertEqual(parameters["lead_mg_l"]["assessed"], 1)
        self.assertEqual(parameters["lead_mg_l"]["failed"], 0)
        self.assertEqual(result["coverage"]["assessed"], 25)
        self.assertEqual(result["coverage"]["missing_values"], 1)
        self.assertEqual(result["coverage"]["missing_flags"], 2)
        self.assertEqual(result["coverage"]["latest_failed_checks"], 1)
        self.assertEqual(result["alerts"][0]["value"], 0)
        # A raw value of zero does not override the source's explicit failed flag.
        self.assertEqual(result["map"][0]["ecoli_cfu_100ml_pass_pct"], 0)
        json.dumps(result, allow_nan=False)

    def test_source_score_is_preserved_and_district_means_have_equal_weight(self):
        rows = [observation(score=20), observation(score=40), observation("District B", score=100)]
        result = _dashboard_value(source(rows), "National", 2026, 2026)
        self.assertEqual(result["latest"]["compliance_score"], 65)
        self.assertEqual(result["series"][0]["compliance_score"], 65)

    def test_annual_district_weight_does_not_depend_on_available_month_count(self):
        rows = [observation(month=1, score=20), observation(month=2, score=40),
                observation("District B", month=1, score=100)]
        result = _dashboard_value(source(rows), "National", 2026, 2026)
        self.assertEqual(result["series"][0]["compliance_score"], 65)
        self.assertEqual(result["monthly"][0]["compliance_score"], 60)
        self.assertEqual(result["monthly"][1]["compliance_score"], 40)

    def test_selected_district_keeps_national_map_and_actual_last_period(self):
        rows = [observation(), observation(month=2), observation("District B")]
        rows[1]["pH_Compliant"] = False
        result = _dashboard_value(source(rows), "District A", 2026, 2026)
        self.assertEqual(len(result["map"]), 2)
        self.assertEqual(result["coverage"]["selected_districts"], 1)
        self.assertEqual(result["latest_period"], "2026-02")
        self.assertEqual(result["monthly"][1]["flagged_districts"], 1)
        self.assertEqual(result["monthly"][1]["failed_checks"], 1)
        self.assertEqual(result["series"][0]["flagged_districts"], 1)
        mapped = {item["district_name"]: item for item in result["map"]}
        self.assertEqual(mapped["District B"]["period"], "2026-01")
        self.assertIn("health_pass_pct", mapped["District B"])

    def test_invalid_region_and_empty_or_reversed_windows_are_json_errors(self):
        data = source([observation()])
        for region, start, end, status in (("Unknown", 2026, 2026, 400), ("National", 2026, 2025, 400), ("National", 1990, 1991, 404)):
            with self.subTest(region=region, start=start, end=end):
                with self.assertRaises(HTTPException) as context:
                    _dashboard_value(data, region, start, end)
                self.assertEqual(context.exception.status_code, status)

    def test_limits_do_not_confuse_microbiological_sample_volume_with_a_range(self):
        self.assertEqual(_limit_bounds("0 cfu/100 mL"), (0, 0))
        self.assertEqual(_limit_bounds("6.0–9.0"), (6, 9))
        self.assertEqual(_limit_bounds("0.2–5.0 mg/L"), (0.2, 5))
        self.assertEqual(_limit_bounds("<= 1 NTU (Class 1)"), (None, 1))
        self.assertEqual(_limit_bounds("unknown"), (None, None))

    def test_pagination_adapts_to_server_page_size_without_truncation(self):
        rows = [observation(month=index + 1) for index in range(7)]
        _read_source.cache_clear()

        def request(url, key, start=None, end=None, count_exact=False):
            if "limit=1" in url:
                return rows[:1], None
            return rows[start:min(end + 1, start + 2)], "0-1/7" if count_exact else None

        with patch("app.drinking_water_service._request_page", side_effect=request):
            result = _read_source("https://example.invalid", "placeholder", "14.1_SANS_241_compliance_master")
        self.assertEqual(len(result["rows"]), 7)
        self.assertEqual([row["month"] for row in result["rows"]], list(range(1, 8)))
        _read_source.cache_clear()


if __name__ == "__main__":
    unittest.main()
