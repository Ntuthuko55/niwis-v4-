"""Safe PostgreSQL equivalents for the existing server-side REST reads."""
from __future__ import annotations

import re
import os
from typing import Any, Iterable

from app.database import DatabaseConfigurationError, postgres_enabled, session_scope

_IDENTIFIER = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_TABLES = {
    "meteorological_drought_master", "hydrological_drought_master", "satellite_remote_sensing",
    "niwis_daily_climate_v2",
    "4_1_temperature_change_master", "4_2_wet_dry_spells_master",
    "4_3_mean_annual_precipitation_master", "4_4_potential_evaporation_daily_master",
    "4_5_irrigation_demand_daily_master", "4_6_streamflow_and_climate_linkage_annual_master",
    "8_1_reservoir_operational_master",
}


def _identifier(value: str) -> str:
    if not _IDENTIFIER.fullmatch(value):
        raise ValueError(f"Unsafe PostgreSQL identifier: {value!r}")
    return value


def _table(value: str) -> str:
    if not re.fullmatch(r'[A-Za-z0-9_]+', value):
        raise ValueError('Unsafe PostgreSQL table name.')
    if value not in _TABLES and not value.startswith("niwis_"):
        raise ValueError(f"PostgreSQL table is not allowlisted: {value}")
    return value


def _require_sqlalchemy():
    try:
        from sqlalchemy import text
    except ImportError as exc:  # pragma: no cover
        raise DatabaseConfigurationError("SQLAlchemy is required for PostgreSQL reads.") from exc
    return text


def read_table_rows(
    table: str,
    *,
    columns: Iterable[str] | None = None,
    filters: dict[str, tuple[str, Any]] | Iterable[tuple[str, tuple[str, Any]]] | None = None,
    order: Iterable[tuple[str, str]] | None = None,
    limit: int | None = None,
    offset: int = 0,
) -> list[dict[str, Any]]:
    """Read a bounded, parameterized result set from an allowlisted table."""
    text = _require_sqlalchemy()
    table = _table(table)
    selected = "*" if columns is None else ", ".join(f'"{_identifier(column)}"' for column in columns)
    clauses: list[str] = []
    values: dict[str, Any] = {}
    conditions = filters.items() if isinstance(filters, dict) else filters or []
    for index, (column, condition) in enumerate(conditions):
        operator, value = condition
        column = _identifier(column)
        if operator not in {"=", ">=", "<", "<=", ">", "<>", "IS NULL", "IS NOT NULL"}:
            raise ValueError(f"Unsupported PostgreSQL filter operator: {operator}")
        if operator in {"IS NULL", "IS NOT NULL"}:
            clauses.append(f'"{column}" {operator}')
        else:
            parameter = f"filter_{index}"
            clauses.append(f'"{column}" {operator} :{parameter}')
            values[parameter] = value
    statement = f'SELECT {selected} FROM public."{table}"'
    if clauses:
        statement += " WHERE " + " AND ".join(clauses)
    if order:
        order_parts = []
        for column, direction in order:
            direction = direction.upper()
            if direction not in {"ASC", "DESC"}:
                raise ValueError("Order direction must be ASC or DESC.")
            order_parts.append(f'"{_identifier(column)}" {direction}')
        statement += " ORDER BY " + ", ".join(order_parts)
    if limit is not None:
        values["limit_value"] = max(0, min(int(limit), 10000))
        values["offset_value"] = max(0, int(offset))
        statement += " LIMIT :limit_value OFFSET :offset_value"
    with session_scope() as session:
        return [dict(row) for row in session.execute(text(statement), values).mappings().all()]


def insert_rows(table: str, rows: list[dict[str, Any]]) -> int:
    """Insert trusted server-side rows with bound parameters; never accept SQL from clients."""
    if not rows:
        return 0
    text = _require_sqlalchemy()
    table = _table(table)
    columns = sorted(set().union(*(row.keys() for row in rows)))
    if not columns or any(not _IDENTIFIER.fullmatch(column) for column in columns):
        raise ValueError("Insert columns must be safe PostgreSQL identifiers.")
    column_sql = ", ".join(f'"{column}"' for column in columns)
    value_sql = ", ".join(f":insert_{index}_{column}" for index, column in enumerate(columns))
    statement = text(f'INSERT INTO public."{table}" ({column_sql}) VALUES ({value_sql})')
    parameters = [{f"insert_{index}_{column}": row.get(column) for index, column in enumerate(columns)} for row in rows]
    with session_scope(write=True) as session:
        session.execute(statement, parameters)
    return len(rows)


def read_rows_from_rest_params(table: str, params: dict[str, str]) -> list[dict[str, Any]]:
    """Preserve the old PostgREST-style reader contract on PostgreSQL."""
    select = params.get("select", "*")
    columns = None if select == "*" else [column.strip() for column in select.split(",")]
    filters = []
    reserved = {"select", "order", "limit", "offset", "and"}
    for column, raw in params.items():
        if column in reserved or not isinstance(raw, str) or "." not in raw:
            continue
        operator, value = raw.split(".", 1)
        if operator in {"eq", "gte", "lt", "lte", "gt", "neq"}:
            filters.append((column, ({"eq": "=", "gte": ">=", "lt": "<", "lte": "<=", "gt": ">", "neq": "<>"}[operator], value)))
    if params.get('and'):
        expression = params['and']
        if not expression.startswith('(') or not expression.endswith(')'):
            raise ValueError('Unsupported PostgreSQL conjunction.')
        for clause in expression[1:-1].split(','):
            parts = clause.split('.', 2)
            if len(parts) != 3 or parts[1] not in {'eq', 'gte', 'lt', 'lte', 'gt', 'neq'}:
                raise ValueError('Unsupported PostgreSQL conjunction.')
            column, operator, value = parts
            filters.append((_identifier(column), ({'eq': '=', 'gte': '>=', 'lt': '<', 'lte': '<=', 'gt': '>', 'neq': '<>'}[operator], value)))
    order = []
    if params.get("order"):
        for part in params["order"].split(","):
            bits = part.split(".")
            order.append((bits[0], "DESC" if len(bits) > 1 and bits[1].lower() == "desc" else "ASC"))
    return read_table_rows(
        table,
        columns=columns,
        filters=filters,
        order=order,
        limit=int(params["limit"]) if params.get("limit") else None,
        offset=int(params.get("offset", 0)),
    )


def read_latest_rows(table: str) -> list[dict[str, Any]]:
    newest = read_table_rows(table, columns=["date"], order=[("date", "DESC")], limit=1)
    if not newest:
        return []
    return read_table_rows(table, filters={"date": ("=", newest[0]["date"])}, order=[("district_name", "ASC"), ("id", "ASC")])


def read_province_rows(province_id: str, *, latest: bool = False) -> list[dict[str, Any]]:
    table = os.getenv("NIWIS_SUPABASE_TABLE", "niwis_daily_climate_v2")
    sample = read_table_rows(table, limit=1)
    if not sample:
        return []
    available = set(sample[0])
    province_column = next((column for column in ("province", "province_name") if column in available), None)
    date_column = next((column for column in ("date", "observation_date", "record_date") if column in available), None)
    if not province_column or not date_column:
        raise DatabaseConfigurationError("PostgreSQL climate table requires province and date columns.")
    candidates = [province_id, province_id.replace("-", " "), province_id.replace("-", " ").title()]
    for candidate in dict.fromkeys(candidates):
        rows = read_table_rows(
            table,
            filters={province_column: ("=", candidate)},
            order=[(date_column, "DESC" if latest else "ASC")],
            limit=1 if latest else None,
        )
        if rows:
            return rows
    return []


def read_region_history(table: str, region: str) -> list[dict[str, Any]]:
    latest = read_latest_rows(table)
    canonical = next((row["district_name"] for row in latest if str(row.get("district_name", "")).casefold() == region.casefold()), region)
    return read_table_rows(table, filters={"district_name": ("=", canonical)}, order=[("date", "ASC"), ("id", "ASC")])


def read_climate_frames(columns: dict[str, list[str]], tables: dict[str, str], start: int, end: int, region: str | None = None,
                        date_start: str | None = None, date_stop: str | None = None):
    """Read the six climate tables with bounded predicates and pooled sessions."""
    frames = {}
    for section, table in tables.items():
        if section not in columns:
            continue
        daily = section in {"temperature", "evaporation", "irrigation"}
        time_column = "Date" if daily else "Year"
        selected = ["District_Name", time_column, *columns[section]]
        filters = {time_column: (">=", f"{start}-01-01" if daily else start)}
        # Date upper bounds are exclusive; annual bounds are inclusive.
        if daily:
            filters["__upper__"] = ("<", f"{end + 1}-01-01")
        else:
            filters["__upper__"] = ("<=", end)
        filters = {key: value for key, value in filters.items() if key != "__upper__"}
        # Keep both date bounds parameterized and preserve column case.
        text = _require_sqlalchemy()
        table_name = _table(table)
        lower_name, upper_name = "climate_lower", "climate_upper"
        upper_operator = "<" if daily else "<="
        column_sql = ', '.join(f'"{_identifier(column)}"' for column in selected)
        statement = f'SELECT {column_sql} FROM public."{table_name}" WHERE "{time_column}" >= :{lower_name} AND "{time_column}" {upper_operator} :{upper_name}'
        values = {lower_name: (date_start or f"{start}-01-01") if daily else start,
                  upper_name: (date_stop or f"{end + 1}-01-01") if daily else end}
        if region:
            statement += ' AND "District_Name" = :climate_region'
            values["climate_region"] = region
        statement += f' ORDER BY "District_Name" ASC, "{time_column}" ASC'
        with session_scope() as session:
            rows = [dict(row) for row in session.execute(text(statement), values).mappings().all()]
        frames[section] = __import__("pandas").DataFrame(rows, columns=selected)
    return frames


def postgres_available() -> bool:
    return postgres_enabled()
