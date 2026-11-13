"""Fail fast when the configured drought database cannot be reached."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.readiness import DatabaseReadinessError, check_database_readiness


def main() -> int:
    """Stop startup unless every required table or the active DB responds."""
    try:
        source = check_database_readiness()
    except DatabaseReadinessError as exc:
        print(
            f"Database preflight failed: {exc}\n"
            "Check the backend connection settings and database availability.",
            file=sys.stderr,
        )
        return 1

    print(f"{source} preflight passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
