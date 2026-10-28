"""Fail fast when the configured drought database cannot be reached."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.database import postgres_enabled


def main() -> int:
    # The PostgreSQL deployment has its own connection configuration and is
    # checked by its deployment environment. This guard targets the Supabase
    # REST source used by the local NIWIS development server.
    if postgres_enabled():
        return 0

    from app.drought_source import TABLES, read_rows

    for table in sorted(TABLES):
        try:
            read_rows(table, {"select": "date", "limit": "1"})
        except Exception as exc:
            print(
                f"Database preflight failed for {table}: {exc}\n"
                "The backend cannot reach Supabase. Start it from a normal, "
                "network-enabled PowerShell session using backend\\start.ps1.",
                file=sys.stderr,
            )
            return 1

    print("Supabase preflight passed for all drought tables.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
