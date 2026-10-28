"""RWQO data fidelity, assessment denominators and reader recovery checks."""
import asyncio
import json
import unittest
from unittest.mock import patch

from fastapi import FastAPI, HTTPException
from scripts.asgi_probe import get_json

from app.dashboard_response_cache import DashboardResponseCache
from app.rwqo_service import METRICS, SCORES, TABLES, _dashboard_value, _prepare, _read_table, router
from app.supabase_source import SupabaseSourceError


def observation(kind, district="District A", month=1, value=1):
    row = {"district_name": district, "shapeID": district, "year": 2026, "month": month}
    for _, _, _, field, prefix, agency in METRICS[kind]:
        row[field] = value
        if prefix:
            row.update({f"{prefix}_Compliant": True, f"{prefix}_Limit": ">= 0.5", f"{prefix}_Source": agency})
    if kind in SCORES:
        row[SCORES[kind]] = 72
    return row


def dataset(rows=None):
    return {kind: _prepare((rows or {}).get(kind, [observation(kind)]), kind, table) for kind, table, _ in TABLES}


async def requests(app, paths):
    return [await get_json(app, path) for path in paths]


class RWQOTests(unittest.TestCase):
    def tearDown(self):
        _read_table.cache_clear()

    def test_shared_nutrient_assessment_is_counted_once_and_missing_is_unassessed(self):
        row = observation("chemical", value=0)
        row["DO_Compliant"] = False
        row["Nutrient_Compliant"] = False
        row["Toxicant_Value_ugL"] = None
        row["Toxicant_Compliant"] = False
        row["pH_Range_Compliant"] = None
        section = _dashboard_value(dataset({"chemical": [row]}), start=2026, end=2026)["sections"]["chemical"]
        self.assertEqual(len(section["compliance"]), 6)
        self.assertEqual(section["coverage"]["assessed"], 4)
        self.assertEqual(section["coverage"]["failed"], 2)
        self.assertEqual(section["coverage"]["passed"], 2)
        self.assertEqual(len(section["alerts"]), 2)
        self.assertEqual(len(next(item for item in section["alerts"] if item["objective"] == "Nutrient")["values"]), 2)
        self.assertEqual(section["latest"]["dissolved_oxygen"], 0)
        self.assertEqual(section["latest"]["reported_score"], 72)
        json.dumps(section, allow_nan=False)

    def test_partial_nutrient_observation_does_not_enter_denominator(self):
        row = observation("chemical")
        row["Nutrient_Value_TP"] = None
        data = dataset({"chemical": [row]})
        result = _dashboard_value(data)["sections"]["chemical"]
        self.assertEqual(result["coverage"]["assessed"], 5)
        nutrient = next(item for item in result["compliance"] if item["key"] == "Nutrient")
        self.assertEqual(nutrient["assessed"], 0)
        self.assertIsNone(nutrient["pass_pct"])

    def test_annual_means_weight_districts_equally_and_keep_month_gaps(self):
        rows = [observation("ecological", month=1, value=10), observation("ecological", month=3, value=30),
                observation("ecological", district="District B", month=1, value=100)]
        data = dataset({"ecological": rows})
        result = _dashboard_value(data, start=2026, end=2026)["sections"]["ecological"]
        self.assertEqual(result["series"][0]["sass5_score"], 60)
        self.assertEqual(result["monthly"][0]["sass5_score"], 55)
        self.assertEqual(result["monthly"][1]["period"], "2026-02")
        self.assertIsNone(result["monthly"][1]["sass5_score"])
        self.assertEqual(result["compliance"], [])
        # A January value is not silently used for a district absent in March.
        mapped = {item["district_name"]: item for item in result["map"]}
        self.assertIsNone(mapped["District B"]["sass5_score"])
        district = _dashboard_value(data, region="District A")["sections"]["ecological"]
        self.assertEqual(len(district["map"]), 2)
        self.assertEqual(district["coverage"]["selected_districts"], 1)

    def test_duplicate_or_invalid_source_keys_fail_explicitly(self):
        for rows in ([observation("ecological"), observation("ecological")], [observation("ecological", month=13)]):
            with self.assertRaises(SupabaseSourceError):
                _prepare(rows, "ecological", "source")

    def test_source_targets_are_checked_across_rows_and_din_is_not_applied_to_tn(self):
        first, second = observation("chemical"), observation("chemical", month=2)
        first["Nutrient_Limit"] = second["Nutrient_Limit"] = "DIN <= 1.5, TP <= 0.12 mg/L"
        first["pH_Range_Limit"] = "6.5–8.5"
        second["pH_Range_Limit"] = "6.0–9.0"
        prepared = _prepare([first, second], "chemical", "source")
        metrics = {item["key"]: item for item in prepared["indicators"]}
        self.assertIsNone(metrics["total_nitrogen"]["max"])
        self.assertEqual(metrics["ph"]["limit"], "Multiple source targets")
        self.assertIsNone(metrics["ph"]["min"])

    def test_server_page_size_is_respected_and_truncation_is_not_cached(self):
        rows = [observation("ecological", month=index + 1) for index in range(7)]

        def request(url, key, start=None, end=None, count_exact=False):
            if "limit=1" in url:
                return rows[:1], None
            return rows[start:min(end + 1, start + 2)], "0-1/7" if count_exact else None

        with patch("app.rwqo_service._request_page", side_effect=request):
            self.assertEqual(len(_read_table("https://example.invalid", "placeholder", "source", "ecological")), 7)
        _read_table.cache_clear()
        calls = 0

        def truncated(url, key, start=None, end=None, count_exact=False):
            nonlocal calls
            calls += 1
            return (rows[:1], None) if "limit=1" in url else (rows[:1], "0-0/7") if count_exact else ([], None)

        with patch("app.rwqo_service._request_page", side_effect=truncated):
            for _ in range(2):
                with self.assertRaises(SupabaseSourceError):
                    _read_table("https://example.invalid", "placeholder", "source", "ecological")
        self.assertGreaterEqual(calls, 6)

    def test_api_caches_success_for_24_hours_and_retries_outages(self):
        app = FastAPI()
        app.include_router(router)
        app.add_middleware(DashboardResponseCache, ttl=86400)
        with patch("app.rwqo_service._load", side_effect=[SupabaseSourceError("offline"), dataset()]) as loader:
            failure, restored, cached = asyncio.run(requests(app, ["/rwqo/metadata"] * 3))
            self.assertEqual(failure.status_code, 502)
            self.assertEqual(restored.status_code, 200)
            self.assertEqual(cached.headers["x-niwis-cache"], "HIT")
            self.assertEqual(cached.json()["cache_ttl_seconds"], 86400)
            self.assertEqual(loader.call_count, 2)

    def test_selection_errors(self):
        data = dataset()
        for region, start, end, status in (("Unknown", 2026, 2026, 400), ("National", 2026, 2025, 400), ("National", 1900, 1901, 404)):
            with self.assertRaises(HTTPException) as error:
                _dashboard_value(data, region, start, end)
            self.assertEqual(error.exception.status_code, status)


if __name__ == "__main__":
    unittest.main()
