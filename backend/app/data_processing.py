"""Prepare dashboard observations for the shared forecasting models."""
from typing import Dict, List, Optional

import numpy as np
import pandas as pd


def normalize_scalar(value):
    if pd.isna(value):
        return None
    if isinstance(value, (np.integer, int)):
        return int(value)
    if isinstance(value, (np.floating, float)):
        return float(value)
    if isinstance(value, (np.bool_, bool)):
        return bool(value)
    if isinstance(value, (pd.Timestamp,)):
        return value.isoformat()
    if isinstance(value, np.generic):
        if np.issubdtype(value.dtype, np.datetime64):
            return pd.Timestamp(value).isoformat()
        return value.item()
    return value


def infer_time_columns(df: pd.DataFrame) -> List[str]:
    time_columns: List[str] = []
    for column in df.columns:
        if pd.api.types.is_datetime64_any_dtype(df[column]):
            time_columns.append(str(column))
            continue

        if pd.api.types.is_string_dtype(df[column]) or df[column].dtype == object:
            parsed = pd.to_datetime(df[column], errors='coerce')
            if parsed.notna().sum() >= len(df) * 0.8:
                df[column] = parsed
                time_columns.append(str(column))
    return time_columns


def construct_year_month_date(df: pd.DataFrame) -> pd.DataFrame:
    """Add a normalized ``date`` column when a source has year/month fields.

    Many NIWIS files are monthly tables with numeric ``year`` and ``month``
    columns rather than a timestamp.  Forecasting models require a real
    datetime index, so construct the first day of each source month without
    changing the original year/month columns.
    """
    normalized = {str(column).strip().casefold().replace('_', ''): column for column in df.columns}
    if any(key in normalized for key in ('date', 'datetime', 'timestamp', 'period')):
        return df
    year_column = next((normalized[key] for key in ('year', 'yyyy') if key in normalized), None)
    month_column = next((normalized[key] for key in ('month', 'mm') if key in normalized), None)
    if not year_column or not month_column:
        return df
    years = pd.to_numeric(df[year_column], errors='coerce')
    months = pd.to_numeric(df[month_column], errors='coerce')
    parsed = pd.to_datetime(
        pd.DataFrame({'year': years, 'month': months, 'day': 1}), errors='coerce'
    )
    if int(parsed.notna().sum()) < max(2, int(len(df) * 0.8)):
        return df
    result = df.copy()
    result['date'] = parsed
    return result


def clean_dataset(df: pd.DataFrame, date_column: Optional[str] = None) -> tuple[pd.DataFrame, List[str], Optional[str]]:
    df = df.copy()
    df = df.dropna(how='all')
    df = df.drop_duplicates()

    df = construct_year_month_date(df)
    inferred_time_columns = infer_time_columns(df)
    if date_column:
        if date_column not in df.columns:
            raise ValueError(f"Date column '{date_column}' was not found.")
        parsed_dates = pd.to_datetime(df[date_column], errors='coerce')
        valid_dates = int(parsed_dates.notna().sum())
        if valid_dates < max(2, int(len(df) * 0.8)):
            raise ValueError(f"'{date_column}' is not a valid date column. At least 80% of its values must be dates.")
        df[date_column] = parsed_dates
        if date_column not in inferred_time_columns:
            inferred_time_columns.append(date_column)
        index_column: Optional[str] = date_column
    else:
        index_column = inferred_time_columns[0] if inferred_time_columns else None

    if index_column is not None and df[index_column].is_unique:
        df = df.sort_values(by=index_column)
        numeric_cols = df.select_dtypes(include=[np.number]).columns
        if len(numeric_cols) > 0:
            temp = df.set_index(index_column)
            temp[numeric_cols] = temp[numeric_cols].interpolate(method='time', limit=3, limit_direction='both')
            df = temp.reset_index()
    else:
        numeric_cols = df.select_dtypes(include=[np.number]).columns
        if len(numeric_cols) > 0:
            df[numeric_cols] = df[numeric_cols].interpolate(method='linear', limit=3, limit_direction='both')

    return df, inferred_time_columns, index_column


def get_preview(df: pd.DataFrame, rows: int = 10) -> List[Dict[str, object]]:
    return df.head(rows).fillna('').to_dict(orient='records')


def get_columns(df: pd.DataFrame) -> List[str]:
    return [str(col) for col in df.columns]


def get_dataset_summary(df: pd.DataFrame, inferred_time_columns: Optional[List[str]] = None) -> Dict[str, object]:
    """Return a compact, JSON-safe profile for the uploaded dataset."""
    missing_by_column = {str(column): int(df[column].isna().sum()) for column in df.columns}
    numeric_columns = [str(column) for column in df.select_dtypes(include=[np.number]).columns]
    categorical_columns = [str(column) for column in df.select_dtypes(include=['object', 'category', 'bool']).columns]
    categorical_details = [
        {
            'name': column,
            'unique_values': int(df[column].nunique(dropna=True)),
            'missing_values': missing_by_column[str(column)],
        }
        for column in df.columns
        if str(column) in categorical_columns
    ]
    return {
        'rows': int(len(df)),
        'columns': int(len(df.columns)),
        'numeric_columns': numeric_columns,
        'categorical_columns': categorical_details,
        'time_columns': inferred_time_columns or [],
        'missing_values_total': int(df.isna().sum().sum()),
        'missing_by_column': missing_by_column,
    }
