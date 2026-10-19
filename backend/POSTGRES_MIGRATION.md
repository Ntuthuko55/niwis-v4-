# PostgreSQL migration

The server now has an opt-in PostgreSQL path. Set `NIWIS_DB_BACKEND=postgres`
and configure `DATABASE_URL` only in the backend environment. The URL is never
returned by an API response and is not read by the frontend.

The pooled SQLAlchemy engine is defined in `app/database.py`. Sessions are
short-lived, non-autocommitting for reads, rolled back on errors, and closed in
a `finally` block. Pool sizing is controlled by `NIWIS_DB_POOL_SIZE`,
`NIWIS_DB_MAX_OVERFLOW`, `NIWIS_DB_POOL_TIMEOUT`, and `NIWIS_DB_POOL_RECYCLE`.

The existing REST operations were identified as follows:

- `app/drought_source.py`: meteorological, hydrological, and satellite drought reads.
- `app/climate_source.py`: the six Module 2 climate table reads.
- `app/supabase_source.py`: provincial climate reads and latest-row reads used by forecasting and the Flask compatibility endpoints.
- `app/meteorological_service.py` and `app/hydrology_service.py`: compatibility paths built on those readers.

No existing Supabase REST write operation was found in Modules 1–5; the
application currently registers in-memory analysis/forecast jobs rather than
writing dashboard observations. `app/postgres_source.py` includes a bounded,
parameterized `insert_rows` helper for future server-authorized writes without
accepting SQL or table names from clients.

Those readers route to parameterized PostgreSQL queries when the feature flag is
set. The old PostgREST implementation remains available as the default and as
the rollback path. CSV-backed monitoring services were not migrated because
they do not perform Supabase REST database operations.

`sql/postgres_indexes.sql` contains prepared, non-executed index statements for
province/district/date and climate table access patterns. Review table names and
apply them with database-change approval; the application does not change the
schema automatically.

For parity validation, run the existing endpoint tests with the REST backend,
then repeat them with `NIWIS_DB_BACKEND=postgres` against a staging database
loaded from the same Supabase tables. Compare status codes, JSON keys, row
counts, dates, and numeric values before switching production traffic.
