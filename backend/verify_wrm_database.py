"""Read-only WRM and SWSA audit, API comparison and cache verification."""
import asyncio
import json
import math
from pathlib import Path
from time import perf_counter
from unittest.mock import patch

from fastapi import FastAPI

from app.dashboard_response_cache import DashboardResponseCache
from app.wrm_service import _dashboard_value, _load, _metadata, forecast_source, router
from scripts.asgi_probe import get_json


async def verify_api():
    app = FastAPI()
    app.include_router(router)
    app.add_middleware(DashboardResponseCache)
    first = await get_json(app, "/wrm/dashboard")
    started = perf_counter()
    cached = await get_json(app, "/wrm/dashboard")
    elapsed = perf_counter() - started
    assert first.status_code == cached.status_code == 200
    assert cached.headers["x-niwis-cache"] == "HIT"
    assert first.json() == cached.json()
    assert (await get_json(app, "/wrm/dashboard?region=Unknown")).status_code == 400
    return elapsed


def main():
    started = perf_counter()
    data = _load()
    cold = perf_counter() - started
    meta = _metadata(data)
    national = _dashboard_value(data)
    selected = _dashboard_value(data, meta["regions"][0], meta["areas"][0])
    for kind, section in data.items():
        latest = section["frame"][section["frame"].year == national[kind]["latest_year"]]
        for item in section["indicators"]:
            assert math.isclose(national[kind]["latest"][item["key"]], latest[item["key"]].mean(), rel_tol=1e-10)
        assert selected[kind]["selected_entities"] == 1
        assert len(national[kind]["comparison"]) == section["audit"]["entities"]
    with patch("app.wrm_service._load", return_value=data):
        forecast = forecast_source()
        area_forecast = forecast_source("SWSA: " + meta["areas"][0])
    assert forecast["frequency"] == area_forecast["frequency"] == "annual"
    assert len(forecast["metrics"]) == 16 and len(area_forecast["metrics"]) == 6
    assert len(forecast["series"]) == len(meta["years"])
    cached_seconds = asyncio.run(verify_api())
    report = {"source": "Supabase", "frequency": "annual", "audits": meta["audits"], "profiles": meta["profiles"],
              "cold_source_seconds": round(cold, 3), "cached_api_seconds": round(cached_seconds, 5),
              "cache": "HIT", "cache_ttl_seconds": meta["cache_ttl_seconds"], "district_forecast_years": len(forecast["series"]),
              "swsa_forecast_years": len(area_forecast["series"]), "aggregation": meta["aggregation"], "limitations": meta["limitations"]}
    output = Path(__file__).resolve().parents[1] / "output" / "wrm-dashboard"
    output.mkdir(parents=True, exist_ok=True)
    (output / "database-verification.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps({**{key: value for key, value in report.items() if key not in {"audits", "profiles", "limitations"}},
                      "coverage": {key: {field: audit[field] for field in ("rows", "entities", "first_year", "last_year", "missing_entity_years", "missing_measurements")} for key, audit in meta["audits"].items()}}, indent=2))


if __name__ == "__main__":
    main()
