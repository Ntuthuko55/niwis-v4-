"""Check the configured NIWIS data source for startup and readiness probes."""

from concurrent.futures import ThreadPoolExecutor

from app.database import postgres_enabled


class DatabaseReadinessError(RuntimeError):
    """Raised when a required NIWIS database check cannot be completed."""


def check_database_readiness() -> str:
    """Verify the active database backend and return its public display name.

    Supabase checks go directly to PostgREST, bypassing the dashboard cache so
    an old cached response cannot mask an outage. PostgreSQL runs a lightweight
    query against the configured connection. Error details are intentionally
    omitted so callers cannot expose connection settings.
    """
    if postgres_enabled():
        try:
            from sqlalchemy import text

            from app.database import engine

            with engine().connect() as connection:
                connection.execute(text("SELECT 1"))
        except Exception as exc:
            raise DatabaseReadinessError("PostgreSQL connection check failed.") from exc
        return "PostgreSQL"

    from app.drought_source import TABLES
    from app.supabase_source import _request_page, _settings

    try:
        base, key, _ = _settings()
    except Exception as exc:
        raise DatabaseReadinessError("Supabase connection settings are not configured.") from exc

    def check_table(table: str) -> None:
        url = f"{base}/rest/v1/{table}?select=date&limit=1"
        _request_page(url, key, 0, 0, timeout=5)

    tables = sorted(TABLES)
    with ThreadPoolExecutor(max_workers=max(1, len(tables))) as executor:
        checks = {table: executor.submit(check_table, table) for table in tables}
        for table, check in checks.items():
            try:
                check.result()
            except Exception as exc:
                raise DatabaseReadinessError(
                    f"Supabase connection check failed for required table {table}."
                ) from exc
    return "Supabase"
