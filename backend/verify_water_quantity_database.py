"""Read-only source operation audit, value comparisons and API cache checks."""
import asyncio
import json
import math
from pathlib import Path
from time import perf_counter
from unittest.mock import patch

from fastapi import FastAPI

from app.dashboard_response_cache import DashboardResponseCache
from app.water_quantity_service import _dashboard_value, _load, _metadata, forecast_source, router
from scripts.asgi_probe import get_json


async def verify_api():
    app = FastAPI()
    app.include_router(router)
    app.add_middleware(DashboardResponseCache)
    first = await get_json(app, "/water-quantity/dashboard")
    started = perf_counter()
    cached = await get_json(app, "/water-quantity/dashboard")
    elapsed = perf_counter() - started
    assert first.status_code == cached.status_code == 200
    assert cached.headers["x-niwis-cache"] == "HIT"
    assert first.json() == cached.json()
    assert (await get_json(app, "/water-quantity/dashboard?region=Unknown")).status_code == 400
    return elapsed


def main():
    started = perf_counter()
    data = _load()
    cold = perf_counter() - started
    meta = _metadata(data)
    national = _dashboard_value(data)
    district = _dashboard_value(data, meta["regions"][0])
    assert district["balance"] == national["balance"]
    assert district["transfers"]["selected_districts"] == 1
    for kind, section in data.items():
        frame = section["frame"]
        latest = frame[frame.period == national[kind]["latest_period"]]
        for item in section["indicators"]:
            expected = latest[item["key"]].mean()
            actual = national[kind]["latest"].get(item["key"])
            assert (actual is None and math.isnan(expected)) or math.isclose(actual, expected, rel_tol=1e-10, abs_tol=1e-10)
    with patch("app.water_quantity_service._load", return_value=data):
        balance_forecast = forecast_source()
        transfer_forecast = forecast_source("Transfers: " + meta["regions"][0])
    assert len(balance_forecast["metrics"]) == 12 and len(transfer_forecast["metrics"]) == 8
    assert balance_forecast["frequency"] == transfer_forecast["frequency"] == "monthly"
    elapsed = asyncio.run(verify_api())
    report = {"source": "Supabase", "frequency": "monthly", "audits": meta["audits"], "districts": meta["regions"],
              "cold_source_seconds": round(cold, 3), "cached_api_seconds": round(elapsed, 5), "cache": "HIT",
              "cache_ttl_seconds": meta["cache_ttl_seconds"], "latest_national_balance": national["balance"]["latest"],
              "transfer_forecast_months": len(transfer_forecast["series"]), "balance_forecast_months": len(balance_forecast["series"]),
              "national_scope_independent_of_transfer_district": True, "limitations": meta["limitations"]}
    output = Path(__file__).resolve().parents[1] / "output" / "water-quantity-dashboard"
    output.mkdir(parents=True, exist_ok=True)
    (output / "database-verification.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps({**{key: value for key, value in report.items() if key not in {"audits", "districts", "limitations", "latest_national_balance"}},
                      "coverage": {key: {field: audit[field] for field in ("rows", "entities", "first_period", "last_period", "missing_entity_months", "missing_measurements")} for key, audit in meta["audits"].items()},
                      "calculation_checks": meta["audits"]["balance"]["calculation_checks"]}, indent=2))


if __name__ == "__main__":
    main()
