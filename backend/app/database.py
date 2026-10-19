"""Server-side PostgreSQL engine and session management.

The browser never receives this connection string.  PostgreSQL is opt-in via
``NIWIS_DB_BACKEND=postgres`` so existing Supabase REST deployments remain
available during migration and parity testing.
"""
from __future__ import annotations

import os
from contextlib import contextmanager
from functools import lru_cache
from typing import Iterator
from urllib.parse import urlparse, urlunparse


class DatabaseConfigurationError(RuntimeError):
    """Raised when PostgreSQL is requested but cannot be configured safely."""


def _load_local_env() -> None:
    env_file = os.path.join(os.path.dirname(os.path.dirname(__file__)), ".env")
    if not os.path.exists(env_file):
        return
    with open(env_file, encoding="utf-8") as handle:
        for raw in handle:
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            name, value = line.split("=", 1)
            os.environ.setdefault(name.strip(), value.strip().strip('"').strip("'"))


_load_local_env()


def postgres_enabled() -> bool:
    return os.getenv("NIWIS_DB_BACKEND", "supabase").strip().lower() in {"postgres", "postgresql"}


def _database_url() -> str:
    value = (os.getenv("DATABASE_URL") or os.getenv("SUPABASE_DB_URL") or "").strip()
    if not value:
        raise DatabaseConfigurationError(
            "PostgreSQL is enabled but DATABASE_URL is not configured on the backend."
        )
    parsed = urlparse(value)
    if parsed.scheme not in {"postgresql", "postgres"}:
        raise DatabaseConfigurationError("DATABASE_URL must use the PostgreSQL scheme.")
    # psycopg 3 is the supported synchronous SQLAlchemy driver.  Do not log or
    # return this URL; it contains the database password.
    parsed = parsed._replace(scheme="postgresql+psycopg")
    return urlunparse(parsed)


def _int_setting(name: str, default: int, minimum: int, maximum: int) -> int:
    try:
        value = int(os.getenv(name, str(default)))
    except ValueError as exc:
        raise DatabaseConfigurationError(f"{name} must be an integer.") from exc
    return max(minimum, min(maximum, value))


@lru_cache(maxsize=1)
def engine():
    """Create one process-wide pooled SQLAlchemy engine lazily."""
    if not postgres_enabled():
        raise DatabaseConfigurationError("PostgreSQL is not enabled for this process.")
    try:
        from sqlalchemy import create_engine
    except ImportError as exc:  # pragma: no cover - exercised in deployments
        raise DatabaseConfigurationError(
            "SQLAlchemy and psycopg are required when NIWIS_DB_BACKEND=postgres."
        ) from exc
    return create_engine(
        _database_url(),
        pool_pre_ping=True,
        pool_size=_int_setting("NIWIS_DB_POOL_SIZE", 10, 1, 50),
        max_overflow=_int_setting("NIWIS_DB_MAX_OVERFLOW", 10, 0, 100),
        pool_timeout=_int_setting("NIWIS_DB_POOL_TIMEOUT", 30, 1, 300),
        pool_recycle=_int_setting("NIWIS_DB_POOL_RECYCLE", 1800, 60, 86400),
        future=True,
    )


@lru_cache(maxsize=1)
def session_factory():
    try:
        from sqlalchemy.orm import sessionmaker
    except ImportError as exc:  # pragma: no cover
        raise DatabaseConfigurationError("SQLAlchemy is required for PostgreSQL sessions.") from exc
    return sessionmaker(bind=engine(), autoflush=False, expire_on_commit=False)


@contextmanager
def session_scope(*, write: bool = False) -> Iterator[object]:
    """Yield a short-lived session and always rollback/close safely."""
    session = session_factory()()
    try:
        yield session
        if write:
            session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


def dispose() -> None:
    """Dispose pooled connections during controlled shutdown/tests."""
    if engine.cache_info().currsize:
        engine().dispose()
        engine.cache_clear()
        session_factory.cache_clear()
