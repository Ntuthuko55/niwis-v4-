"""Server-side reader for the NIWIS Supabase climate table.

The browser never receives the Supabase service-role key.  This module uses the
PostgREST API directly so the rest of the application can continue to analyse
ordinary pandas DataFrames.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from threading import Lock
from time import monotonic
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen

import pandas as pd
from app.database import postgres_enabled
from app.postgres_source import read_province_rows


ENV_FILE = Path(__file__).resolve().parents[1] / ".env"
# The forecasting studio is intentionally file-first for this project.  This
# is the same provincial dataset selected by the map; Supabase remains a
# fallback for deployments where the local source is not packaged.
LOCAL_CLIMATE_CSV = Path(__file__).resolve().parents[2] / "csv's" / "mateological.csv"
_CACHE_LOCK = Lock()
_SCHEMA_CACHE: dict[str, tuple[float, tuple[str, str | None]]] = {}
_PROVINCE_CACHE: dict[str, tuple[float, pd.DataFrame]] = {}
_CACHE_MAX_PROVINCES = 12


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


def _cache_frame(key: str, frame: pd.DataFrame) -> None:
    with _CACHE_LOCK:
        if len(_PROVINCE_CACHE) >= _CACHE_MAX_PROVINCES:
            oldest_key = min(_PROVINCE_CACHE, key=lambda item: _PROVINCE_CACHE[item][0])
            _PROVINCE_CACHE.pop(oldest_key, None)
        _PROVINCE_CACHE[key] = (monotonic() + _CACHE_TTL_SECONDS, frame.copy(deep=True))


def load_province_dataframe(province_id: str) -> pd.DataFrame:
    """Load the selected province from the project CSV, then fall back to Supabase."""
    if postgres_enabled():
        rows = read_province_rows(province_id)
        if not rows:
            raise SupabaseSourceError(f"No PostgreSQL records found for province '{province_id}'.")
        return pd.DataFrame(rows).sort_values("date", kind="stable").reset_index(drop=True)
    local_cache_key = f"local-csv:{province_id}"
    cached = _fresh_cache_entry(_PROVINCE_CACHE, local_cache_key)
    if cached is not None:
        return cached

    if LOCAL_CLIMATE_CSV.exists():
        try:
            # Read only the requested province.  This prevents selecting one
            # province in the UI while training on a national mixed series.
            province_column = "province"
            candidates = {value.casefold() for value in _province_candidates(province_id)}
            chunks = pd.read_csv(LOCAL_CLIMATE_CSV, chunksize=100_000, low_memory=False)
            matches = [
                chunk.loc[chunk[province_column].astype(str).str.casefold().isin(candidates)]
                for chunk in chunks
            ]
            matches = [chunk for chunk in matches if not chunk.empty]
            if matches:
                df = pd.concat(matches, ignore_index=True)
                if "date" in df.columns:
                    df = df.sort_values("date", kind="stable").reset_index(drop=True)
                _cache_frame(local_cache_key, df)
                return df.copy(deep=True)
        except (OSError, ValueError, KeyError, pd.errors.ParserError) as exc:
            raise SupabaseSourceError(f"Unable to read local climate CSV: {exc}") from exc

        raise SupabaseSourceError(f"No records found in local climate CSV for province '{province_id}'.")

    """Retrieve every row for one province, preserving the database schema."""
    base_url, key, table = _settings()
    table_url = f"{base_url}/rest/v1/{quote(table, safe='_')}"
    cache_key = f"{base_url}:{table}:{province_id}"
    cached = _fresh_cache_entry(_PROVINCE_CACHE, cache_key)
    if cached is not None:
        return cached

    schema = _fresh_cache_entry(_SCHEMA_CACHE, table_url)
    if schema is None:
        sample = _request_json(f"{table_url}?select=*&limit=1", key)
        if not sample:
            raise SupabaseSourceError(f"The Supabase table '{table}' is empty.")
        province_column = _column_name(list(sample[0]), "province", "province_name", "province x")
        if not province_column:
            raise SupabaseSourceError(
                "The Supabase table has no recognised province column (expected province or province_name)."
            )
        date_column = _column_name(list(sample[0]), "date", "observation_date", "record_date")
        schema = (province_column, date_column)
        with _CACHE_LOCK:
            _SCHEMA_CACHE[table_url] = (monotonic() + _CACHE_TTL_SECONDS, (province_column, date_column))
    province_column, date_column = schema

    rows: list[dict] = []
    for candidate in _province_candidates(province_id):
        encoded_filter = quote(f"eq.{candidate}", safe=".")
        page_size = 1000
        page_url = f"{table_url}?select=*&{quote(province_column, safe='_')}={encoded_filter}"
        # With the province/date index, Postgres can filter and return the
        # selected time series in chronological index order.
        if date_column:
            page_url += f"&order={quote(date_column, safe='_')}.asc"

        first_page, content_range = _request_page(
            page_url, key, 0, page_size - 1, count_exact=True
        )
        total_rows = _row_count(content_range, len(first_page))
        page_count = (total_rows + page_size - 1) // page_size
        candidate_rows = list(first_page)

        # PostgREST caps a response at 1,000 rows. Fetch the remaining pages
        # concurrently instead of paying network latency once per page.
        if page_count > 1:
            ranges = [
                (page_number * page_size, min(total_rows - 1, (page_number + 1) * page_size - 1))
                for page_number in range(1, page_count)
            ]
            workers = min(6, len(ranges))
            with ThreadPoolExecutor(max_workers=workers) as executor:
                pages = list(executor.map(lambda item: _request_json(page_url, key, *item), ranges))
            for page in pages:
                candidate_rows.extend(page)
        if candidate_rows:
            rows = candidate_rows
            break

    if not rows:
        raise SupabaseSourceError(f"No records found in Supabase for province '{province_id}'.")

    df = pd.DataFrame(rows)
    # Give downstream analysis a stable province field even if the source used
    # a slightly different database column spelling.
    if province_column != "province":
        df = df.rename(columns={province_column: "province"})
    if date_column and date_column in df.columns:
        df = df.sort_values(date_column, kind="stable").reset_index(drop=True)
    _cache_frame(cache_key, df)
    return df.copy(deep=True)


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
