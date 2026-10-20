"""Server-side reader for the NIWIS Supabase climate table.

The browser never receives the Supabase service-role key.  This module uses the
PostgREST API directly so the rest of the application can continue to analyse
ordinary pandas DataFrames.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from threading import Lock
from time import monotonic
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen

import pandas as pd
from app.database import postgres_enabled
from app.postgres_source import read_province_rows


ENV_FILE = Path(__file__).resolve().parents[1] / ".env"
_CACHE_LOCK = Lock()
_SCHEMA_CACHE: dict[str, tuple[float, tuple[str, str | None]]] = {}


def _load_local_env() -> None:
    """Load the backend .env without adding a runtime dependency."""
    if not ENV_FILE.exists():
        return
    for raw_line in ENV_FILE.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, value = line.split("=", 1)
        os.environ.setdefault(name.strip(), value.strip().strip('"').strip("'"))


_load_local_env()
_CACHE_TTL_SECONDS = max(60, int(os.getenv("NIWIS_SUPABASE_CACHE_TTL", "900")))


class SupabaseSourceError(RuntimeError):
    """A configuration or read error from the NIWIS data source."""


def _settings() -> tuple[str, str, str]:
    url = os.getenv("SUPABASE_URL", "").strip().rstrip("/")
    # The service role is deliberately server-only.  The anon key is a safe
    # fallback for deployments that grant read access through RLS.
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("SUPABASE_ANON_KEY")
    table = os.getenv("NIWIS_SUPABASE_TABLE", "niwis_daily_climate_v2").strip()
    if not url or not key:
        raise SupabaseSourceError(
            "Supabase is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in backend/.env."
        )
    if not table.replace("_", "").isalnum():
        raise SupabaseSourceError("NIWIS_SUPABASE_TABLE contains unsupported characters.")
    return url, key, table


def _request_page(
    url: str,
    key: str,
    start: int | None = None,
    end: int | None = None,
    count_exact: bool = False,
) -> tuple[list[dict], str | None]:
    headers = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Accept": "application/json",
    }
    if count_exact:
        headers["Prefer"] = "count=exact"
    if start is not None and end is not None:
        headers["Range"] = f"{start}-{end}"
    request = Request(url, headers=headers)
    try:
        with urlopen(request, timeout=45) as response:
            payload = json.loads(response.read().decode("utf-8"))
            content_range = response.headers.get("Content-Range")
    except HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:500]
        raise SupabaseSourceError(f"Supabase returned HTTP {exc.code}: {detail}") from exc
    except (URLError, TimeoutError) as exc:
        raise SupabaseSourceError(f"Could not reach Supabase: {exc}") from exc
    if not isinstance(payload, list):
        raise SupabaseSourceError("Supabase returned an unexpected response format.")
    return payload, content_range


def _request_json(url: str, key: str, start: int | None = None, end: int | None = None) -> list[dict]:
    return _request_page(url, key, start, end)[0]


def _row_count(content_range: str | None, fallback: int) -> int:
    """Extract the exact PostgREST count from e.g. ``0-999/9343``."""
    if not content_range or "/" not in content_range:
        return fallback
    try:
        return int(content_range.rsplit("/", 1)[1])
    except ValueError:
        return fallback


def _column_name(columns: list[str], *choices: str) -> str | None:
    normalized = {column.lower().replace("_", "").replace("-", " "): column for column in columns}
    for choice in choices:
        found = normalized.get(choice.lower().replace("_", " ").replace("-", " "))
        if found:
            return found
    return None


def _province_candidates(province_id: str) -> list[str]:
    canonical = province_id.replace("-", " ").title()
    aliases = {
        "Kwa Zulu Natal": "KwaZulu-Natal",
        "North West": "North West",
    }
    canonical = aliases.get(canonical, canonical)
    # Support tables that use display labels, slugs, or title-cased labels.
    return list(dict.fromkeys([canonical, province_id, province_id.replace("-", " ")]))


def _fresh_cache_entry(cache: dict, key: str):
    """Return a valid cache value without ever exposing a mutable cached frame."""
    with _CACHE_LOCK:
        entry = cache.get(key)
        if not entry or monotonic() >= entry[0]:
            cache.pop(key, None)
            return None
        value = entry[1]
        return value.copy(deep=True) if isinstance(value, pd.DataFrame) else value






def load_latest_province_record(province_id: str) -> dict:
    """Read only the newest observation for a province (one indexed row)."""
    if postgres_enabled():
        rows = read_province_rows(province_id, latest=True)
        if not rows:
            raise SupabaseSourceError(f"No PostgreSQL records found for province '{province_id}'.")
        return rows[0]
    base_url, key, table = _settings()
    table_url = f"{base_url}/rest/v1/{quote(table, safe='_')}"
    schema = _fresh_cache_entry(_SCHEMA_CACHE, table_url)
    if schema is None:
        sample = _request_json(f"{table_url}?select=*&limit=1", key)
        if not sample:
            raise SupabaseSourceError(f"The Supabase table '{table}' is empty.")
        province_column = _column_name(list(sample[0]), "province", "province_name", "province x")
        date_column = _column_name(list(sample[0]), "date", "observation_date", "record_date")
        if not province_column or not date_column:
            raise SupabaseSourceError("The Supabase table requires province and date columns.")
        schema = (province_column, date_column)
        with _CACHE_LOCK:
            _SCHEMA_CACHE[table_url] = (monotonic() + _CACHE_TTL_SECONDS, schema)
    province_column, date_column = schema

    for candidate in _province_candidates(province_id):
        encoded_filter = quote(f"eq.{candidate}", safe=".")
        query = (
            f"{table_url}?select=*&{quote(province_column, safe='_')}={encoded_filter}"
            f"&order={quote(date_column, safe='_')}.desc&limit=1"
        )
        records = _request_json(query, key)
        if records:
            return records[0]
    raise SupabaseSourceError(f"No records found in Supabase for province '{province_id}'.")
