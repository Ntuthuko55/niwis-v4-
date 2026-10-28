"""Source fidelity, independent scopes, inferred calculations and cache recovery."""
import asyncio
import unittest
from unittest.mock import patch

from fastapi import FastAPI, HTTPException

from app.dashboard_response_cache import DashboardResponseCache
from app.supabase_source import SupabaseSourceError
from app.water_quantity_service import (
    BALANCE_METRICS, TRANSFER_METRICS, _dashboard_value, _prepare,
    _read_table, forecast_source, router,
)
from scripts.asgi_probe import get_json


def transfer(district="District A", month=1, value=10):
    return {"district_name": district, "year": 2026, "month": month, "date": f"2026-{month:02d}",
            **{item[3]: value for item in TRANSFER_METRICS}}


def balance(month=1):
    return {"Year": 2026, "Month": month, "Date": f"2026-{month:02d}",
            "MAP_Mm3": 100, "AET_Mm3": 20, "MAR_Mm3": 15, "Groundwater_Recharge_Mm3": 5,
            "Surface_Storage_Mm3": 500, "Net_IBT_Mm3": 2, "Municipal_Demand_Mm3": 10,
            "Agricultural_Demand_Mm3": 20, "Industrial_Demand_Mm3": 5, "Environmental_Reserve_Mm3": 3,
            "Total_Demand_Mm3": 38, "Net_Water_Balance_Mm3": 24}


def dataset(transfers=None, balances=None):
    return {"transfers": _prepare(transfers or [transfer()], "transfers", "transfer-source"),
            "balance": _prepare(balances or [balance()], "balance", "balance-source")}


class WaterQuantityTests(unittest.TestCase):
    def tearDown(self):
        _read_table.cache_clear()

    def test_transfer_national_means_are_not_added_or_converted_to_monthly_volumes(self):
        data = dataset([transfer(value=10), transfer("District B", value=30)])
        result = _dashboard_value(data)
        self.assertEqual(result["transfers"]["latest"]["katse_vaal"], 20)
        self.assertEqual(result["transfers"]["latest"]["pumping_energy"], 20)
        self.assertNotIn("gross_transfers", result["transfers"]["latest"])
        self.assertEqual(data["transfers"]["indicators"][0]["unit"], "m³/day")
        self.assertEqual(len(data["transfers"]["indicators"]), 8)

    def test_national_balance_is_unchanged_by_transfer_district_selection(self):
        data = dataset([transfer(), transfer("District B", value=30)])
        national = _dashboard_value(data)
        district = _dashboard_value(data, "District B")
        self.assertEqual(district["transfers"]["latest"]["katse_vaal"], 30)
        self.assertEqual(district["transfers"]["selected_districts"], 1)
        self.assertEqual(len(district["transfers"]["map"]), 2)
        self.assertEqual(national["balance"], district["balance"])
        self.assertEqual(district["balance"]["scope"], "National")

    def test_stored_formula_includes_reserve_once_and_excludes_storage(self):
        result = _dashboard_value(dataset())["balance"]
        checks = result["calculation_checks"]
        self.assertEqual(checks["total_demand"]["matching_rows"], 1)
        self.assertEqual(checks["reported_balance"]["matching_rows"], 1)
        self.assertEqual(result["latest"]["reported_balance"], 24)
        self.assertNotIn("Surface storage", [row["component"] for row in result["calculation_components"]])
        self.assertEqual(len(result["components"]), 12)
        changed = balance()
        changed["Net_Water_Balance_Mm3"] = -999
        mismatch = _dashboard_value(dataset(balances=[changed]))["balance"]
        self.assertEqual(mismatch["latest"]["reported_balance"], -999)
        self.assertEqual(mismatch["calculation_checks"]["reported_balance"]["mismatching_rows"], 1)

    def test_zero_missing_and_gaps_remain_distinct_without_map_backfill(self):
        rows = [transfer(month=1, value=0), transfer(month=3, value=10), transfer("District B", month=1, value=20)]
        rows[1]["Transfer_Pumping_Energy_kWh_Ml"] = None
        result = _dashboard_value(dataset(rows))["transfers"]
        self.assertEqual(result["monthly"][1]["period"], "2026-02")
        self.assertIsNone(result["monthly"][1]["katse_vaal"])
        self.assertIsNone(result["latest"]["pumping_energy"])
        self.assertEqual(result["missing_measurements"], 1)
        mapped = {row["district_name"]: row for row in result["map"]}
        self.assertIsNone(mapped["District B"]["katse_vaal"])
        zero = _dashboard_value(dataset([transfer(value=0)]))["transfers"]
        self.assertEqual(zero["latest"]["katse_vaal"], 0)
        self.assertEqual(zero["latest_all_route_zero_districts"], 1)
        self.assertEqual(zero["map"][0]["katse_vaal"], 0)

    def test_partial_source_components_do_not_produce_a_calculation_check(self):
        raw = balance()
        raw["MAP_Mm3"] = None
        result = _dashboard_value(dataset(balances=[raw]))["balance"]
        self.assertEqual(result["calculation_checks"]["reported_balance"]["complete_rows"], 0)
        self.assertIsNone(result["calculation_checks"]["reported_balance"]["max_absolute_difference_mm3"])
        self.assertEqual(result["calculation_checks"]["total_demand"]["complete_rows"], 1)

    def test_invalid_date_and_duplicate_keys_fail_explicitly(self):
        invalid = transfer()
        invalid["date"] = "2025-12"
        for rows in ([invalid], [transfer(), transfer()]):
            with self.assertRaises(SupabaseSourceError):
                _prepare(rows, "transfers", "source")
        with self.assertRaises(SupabaseSourceError):
            _prepare([balance(), balance()], "balance", "source")

    def test_forecasts_keep_district_transfers_separate_from_national_balance(self):
        data = dataset([transfer(), transfer("District B", value=30)])
        with patch("app.water_quantity_service._load", return_value=data):
            national = forecast_source()
            district = forecast_source("Transfers: District B")
            overview = forecast_source("Transfers: Source district mean")
        self.assertEqual(national["frequency"], "monthly")
        self.assertEqual(len(national["metrics"]), 12)
        self.assertEqual(len(district["metrics"]), 8)
        self.assertNotIn("reported_balance", district["series"][0])
        self.assertNotIn("katse_vaal", national["series"][0])
        self.assertEqual(district["series"][0]["katse_vaal"], 30)
        self.assertEqual(overview["series"][0]["katse_vaal"], 20)

    def test_reader_adapts_to_page_caps_and_does_not_cache_truncation(self):
        rows = [transfer(month=index + 1) for index in range(7)]

        def request(url, key, start=None, end=None, count_exact=False):
            if "limit=1" in url:
                return rows[:1], None
            return rows[start:min(end + 1, start + 2)], "0-1/7" if count_exact else None

        with patch("app.water_quantity_service._request_page", side_effect=request):
            self.assertEqual(len(_read_table("https://example.invalid", "placeholder", "source", "transfers")), 7)
        _read_table.cache_clear()

        def incomplete(url, key, start=None, end=None, count_exact=False):
            if "limit=1" in url:
                return rows[:1], None
            return (rows[:2], "0-1/7") if count_exact else ([], None)

        with patch("app.water_quantity_service._request_page", side_effect=incomplete):
            with self.assertRaises(SupabaseSourceError):
                _read_table("https://example.invalid", "placeholder", "source", "transfers")
        with patch("app.water_quantity_service._request_page", side_effect=request):
            self.assertEqual(len(_read_table("https://example.invalid", "placeholder", "source", "transfers")), 7)

    def test_api_cache_retries_source_errors_and_validates_filters(self):
        app = FastAPI()
        app.include_router(router)
        app.add_middleware(DashboardResponseCache, ttl=86400)

        async def requests():
            return [await get_json(app, "/water-quantity/metadata") for _ in range(3)]

        with patch("app.water_quantity_service._load", side_effect=[SupabaseSourceError("offline"), dataset()]) as loader:
            failure, restored, cached = asyncio.run(requests())
        self.assertEqual(failure.status_code, 502)
        self.assertEqual(restored.status_code, 200)
        self.assertEqual(cached.headers["x-niwis-cache"], "HIT")
        self.assertEqual(cached.json()["cache_ttl_seconds"], 86400)
        self.assertEqual(loader.call_count, 2)
        for region, start, end, status in (("Unknown", 2026, 2026, 400), ("National", 2026, 2025, 400), ("National", 1900, 1901, 404)):
            with self.assertRaises(HTTPException) as error:
                _dashboard_value(dataset(), region, start, end)
            self.assertEqual(error.exception.status_code, status)


if __name__ == "__main__":
    unittest.main()
