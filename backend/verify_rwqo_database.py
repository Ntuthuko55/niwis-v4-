"""Read-only source audit and API/value/cache verification against Supabase."""
import asyncio
import json
import math
from pathlib import Path
from time import perf_counter
from unittest.mock import patch

from fastapi import FastAPI
from scripts.asgi_probe import get_json

from app.dashboard_response_cache import DashboardResponseCache
from app.rwqo_service import _dashboard_value, _load, _metadata, forecast_source, router


async def verify_api(app):
    first = await get_json(app, "/rwqo/dashboard")
    started = perf_counter()
    repeat = await get_json(app, "/rwqo/dashboard")
    repeat_seconds = perf_counter() - started
    assert first.status_code == repeat.status_code == 200
    assert repeat.headers.get("x-niwis-cache") == "HIT"
    assert first.json() == repeat.json()
    assert (await get_json(app, "/rwqo/dashboard?region=Unknown")).status_code == 400
    return repeat, repeat_seconds


def main():
    started = perf_counter()
    data = _load()
    cold_seconds = perf_counter() - started
    meta = _metadata(data)
    result = _dashboard_value(data)
    district = _dashboard_value(data, meta["regions"][0])
    keys = [set(zip(section["frame"].district_name, section["frame"].period)) for section in data.values()]
    for kind, section in data.items():
        frame = section["frame"]
        payload = result["sections"][kind]
        latest = frame[frame.period == payload["latest_period"]]
        for metric in section["indicators"]:
            expected = latest[metric["key"]].mean()
            actual = payload["latest"].get(metric["key"])
            assert (actual is None and math.isnan(expected)) or math.isclose(actual, expected, rel_tol=1e-10)
        assert len(payload["map"]) == section["audit"]["districts"]
        assert payload["coverage"]["passed"] + payload["coverage"]["failed"] == payload["coverage"]["assessed"]
        assert district["sections"][kind]["coverage"]["selected_districts"] == 1
    with patch("app.rwqo_service._load", return_value=data):
        forecast = forecast_source()
    assert len(forecast["metrics"]) == 18
    assert len(forecast["series"]) == len(result["sections"]["ecological"]["monthly"])
    app = FastAPI()
    app.include_router(router)
    app.add_middleware(DashboardResponseCache)
    repeat, repeat_seconds = asyncio.run(verify_api(app))
    output = Path(__file__).resolve().parents[1] / "output" / "rwqo-dashboard"
    output.mkdir(parents=True, exist_ok=True)
    report = {"source": "Supabase", "audits": [section["audit"] for section in data.values()],
              "matching_district_month_keys": all(key == keys[0] for key in keys),
              "cold_source_seconds": round(cold_seconds, 3), "cached_api_seconds": round(repeat_seconds, 4),
              "cache": repeat.headers.get("x-niwis-cache"), "forecast_metrics": len(forecast["metrics"]),
              "forecast_months": len(forecast["series"]), "warnings": meta["warnings"]}
    (output / "database-verification.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps({**{key: value for key, value in report.items() if key not in {"audits", "warnings"}},
                      "tables": [{key: audit[key] for key in ("table", "rows", "districts", "first_period", "last_period", "missing_values", "missing_district_months")} for audit in report["audits"]]}, indent=2))


if __name__ == "__main__":
    main()
