"""WRM source scope, annual aggregation, conversions, gaps and cache recovery."""
import asyncio
import unittest
from unittest.mock import patch

from fastapi import FastAPI, HTTPException

from app.dashboard_response_cache import DashboardResponseCache
from app.supabase_source import SupabaseSourceError
from app.wrm_service import ALL_AREAS, SWSA_METRICS, WRM_METRICS, _dashboard_value, _prepare, _read_table, forecast_source, router
from scripts.asgi_probe import get_json


def observation(kind, entity="District A", year=2025, value=10):
    metrics = WRM_METRICS if kind == "matrix" else SWSA_METRICS
    row = {"district_name" if kind == "matrix" else "SWSA_Name": entity, "year": year,
           **{item[3]: value for item in metrics}}
    if kind == "swsa":
        row.update(Provinces="Province", Key_River_Systems="River", Priority_Variables="Rainfall")
    return row


def dataset(matrix=None, swsa=None):
    return {"matrix": _prepare(matrix or [observation("matrix")], "matrix", "matrix-source"),
            "swsa": _prepare(swsa or [observation("swsa", "Area A")], "swsa", "swsa-source")}


class WRMTests(unittest.TestCase):
    def tearDown(self):
        _read_table.cache_clear()

    def test_national_is_a_district_mean_and_conversions_are_only_in_volume_chart(self):
        rows = [observation("matrix", value=10), observation("matrix", "District B", value=30)]
        result = _dashboard_value(dataset(matrix=rows))["matrix"]
        self.assertEqual(result["latest"]["reported_balance"], 20)
        self.assertEqual(result["latest"]["municipal_demand"], 20)
        self.assertEqual(result["latest"]["industrial_demand"], 20)
        self.assertEqual(result["volume_comparison"][0]["industrial_demand"], 20 / 1_000_000)
        self.assertEqual(result["volume_comparison"][0]["ecological_reserve"], 20 / 1_000_000)
        self.assertEqual(result["volume_comparison"][0]["runoff"], 20)

    def test_swsa_and_district_scope_are_independent(self):
        data = dataset([observation("matrix"), observation("matrix", "District B", value=30)],
                       [observation("swsa", "Area A", value=5), observation("swsa", "Area B", value=15)])
        national = _dashboard_value(data)
        selected = _dashboard_value(data, "District B", "Area A")
        self.assertEqual(national["swsa"]["latest"]["swsa_rainfall"], 10)
        self.assertEqual(selected["swsa"]["latest"]["swsa_rainfall"], 5)
        self.assertEqual(selected["matrix"]["latest"]["precipitation"], 30)
        self.assertEqual(len(selected["matrix"]["map"]), 2)
        self.assertEqual(len(selected["swsa"]["comparison"]), 2)
        with patch("app.wrm_service._load", return_value=data):
            forecast = forecast_source("SWSA: Area A", 2025, 2025)
        self.assertEqual(forecast["frequency"], "annual")
        self.assertEqual(len(forecast["metrics"]), 6)
        self.assertNotIn("precipitation", forecast["series"][0])

    def test_missing_year_and_measurement_stay_missing_and_map_does_not_backfill(self):
        first = observation("matrix", year=2023, value=0)
        last = observation("matrix", year=2025, value=30)
        last["Municipal_Water_Demand_L_cap_day"] = None
        data = dataset([first, last, observation("matrix", "District B", year=2023)])
        result = _dashboard_value(data, start=2023, end=2025)["matrix"]
        self.assertEqual(result["series"][1]["year"], 2024)
        self.assertIsNone(result["series"][1]["precipitation"])
        self.assertIsNone(result["latest"]["municipal_demand"])
        self.assertEqual(result["missing_measurements"], 1)
        mapped = {item["entity"]: item for item in result["map"]}
        self.assertIsNone(mapped["District B"]["precipitation"])
        self.assertEqual(mapped["District A"]["year"], 2025)

    def test_duplicate_and_invalid_annual_keys_fail(self):
        for rows in ([observation("matrix"), observation("matrix")], [observation("matrix", year=2025.5)], [observation("matrix", entity="")]):
            with self.assertRaises(SupabaseSourceError):
                _prepare(rows, "matrix", "source")

    def test_invalid_filters_and_empty_years_have_explicit_errors(self):
        data = dataset()
        for region, area, start, end, status in (("Unknown", ALL_AREAS, 2025, 2025, 400), ("National", "Unknown", 2025, 2025, 400), ("National", ALL_AREAS, 2025, 2024, 400), ("National", ALL_AREAS, 1990, 1991, 404)):
            with self.assertRaises(HTTPException) as error:
                _dashboard_value(data, region, area, start, end)
            self.assertEqual(error.exception.status_code, status)

    def test_reader_respects_server_page_cap_and_rejects_incomplete_reads(self):
        rows = [observation("matrix", year=2000 + index) for index in range(7)]

        def request(url, key, start=None, end=None, count_exact=False):
            if "limit=1" in url:
                return rows[:1], None
            return rows[start:min(end + 1, start + 2)], "0-1/7" if count_exact else None

        with patch("app.wrm_service._request_page", side_effect=request):
            self.assertEqual(len(_read_table("https://example.invalid", "placeholder", "matrix", "matrix")), 7)
        _read_table.cache_clear()

        def incomplete(url, key, start=None, end=None, count_exact=False):
            if "limit=1" in url:
                return rows[:1], None
            return (rows[:2], "0-1/7") if count_exact else ([], None)

        with patch("app.wrm_service._request_page", side_effect=incomplete):
            with self.assertRaises(SupabaseSourceError):
                _read_table("https://example.invalid", "placeholder", "matrix", "matrix")
        with patch("app.wrm_service._request_page", side_effect=request):
            self.assertEqual(len(_read_table("https://example.invalid", "placeholder", "matrix", "matrix")), 7)

    def test_api_retries_failure_then_caches_success(self):
        app = FastAPI()
        app.include_router(router)
        app.add_middleware(DashboardResponseCache, ttl=86400)

        async def requests():
            return [await get_json(app, "/wrm/metadata") for _ in range(3)]

        with patch("app.wrm_service._load", side_effect=[SupabaseSourceError("offline"), dataset()]) as loader:
            first, restored, cached = asyncio.run(requests())
        self.assertEqual(first.status_code, 502)
        self.assertEqual(restored.status_code, 200)
        self.assertEqual(cached.headers["x-niwis-cache"], "HIT")
        self.assertEqual(cached.json()["cache_ttl_seconds"], 86400)
        self.assertEqual(loader.call_count, 2)


if __name__ == "__main__":
    unittest.main()
