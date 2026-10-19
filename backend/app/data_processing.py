import io
import textwrap
from typing import Dict, List, Optional

import numpy as np
import pandas as pd
import pywt
from reportlab.lib.pagesizes import letter
from reportlab.lib.units import inch
from reportlab.pdfgen import canvas
from reportlab.lib.utils import ImageReader
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from scipy import signal
from scipy.stats import linregress
from statsmodels.tsa.stattools import adfuller, acf, kpss, pacf
from statsmodels.tsa.seasonal import STL, seasonal_decompose
from statsmodels.tsa.filters.hp_filter import hpfilter
from statsmodels.tsa.filters.bk_filter import bkfilter
from statsmodels.tsa.filters.cf_filter import cffilter
from arch.unitroot import PhillipsPerron

try:
    from statsmodels.nonparametric.smoothers_lowess import lowess
    HAS_LOWESS = True
except ImportError:
    HAS_LOWESS = False


def load_dataset(file_bytes: bytes, filename: str, sheet_name: Optional[str] = None):
    lower_name = filename.lower()
    if lower_name.endswith('.csv'):
        df = pd.read_csv(io.BytesIO(file_bytes))
        return df, None, None
    elif lower_name.endswith(('.xls', '.xlsx')):
        excel_file = pd.ExcelFile(io.BytesIO(file_bytes))
        sheet_names = excel_file.sheet_names
        if sheet_name is None:
            sheet_name = sheet_names[0]
        if sheet_name not in sheet_names:
            raise ValueError(f"Sheet '{sheet_name}' not found in workbook.")
        df = pd.read_excel(io.BytesIO(file_bytes), sheet_name=sheet_name)
        return df, sheet_names, sheet_name
    else:
        raise ValueError('Unsupported file type. Use CSV, XLS, or XLSX.')


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


def safe_json_list(values):
    return [normalize_scalar(x) for x in values]


def series_index_values(series: pd.Series) -> List[Optional[str]]:
    return [normalize_scalar(x) for x in series.index]


def _performance_metrics(y: np.ndarray, y_pred: np.ndarray) -> Dict[str, float]:
    residuals = y - y_pred
    mae = float(np.mean(np.abs(residuals)))
    rmse = float(np.sqrt(np.mean(residuals ** 2)))
    ss_res = np.sum(residuals ** 2)
    ss_tot = np.sum((y - np.mean(y)) ** 2)
    r2 = float(1 - ss_res / ss_tot) if ss_tot > 0 else 0.0
    return {
        'mae': mae,
        'rmse': rmse,
        'r_squared': r2,
    }


def _trend_interpretation(slope: float, r_squared: float) -> Dict[str, str]:
    if abs(slope) < 1e-8:
        direction = 'Stable'
    elif slope > 0:
        direction = 'Increasing'
    else:
        direction = 'Decreasing'

    if r_squared >= 0.8:
        strength = 'Strong'
    elif r_squared >= 0.4:
        strength = 'Moderate'
    else:
        strength = 'Weak'

    return {
        'direction': direction,
        'strength': strength,
        'summary': f"The trend is {direction.lower()} with {strength.lower()} explanatory power (R² = {r_squared:.2f})."
    }


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


def select_numeric_column(df: pd.DataFrame, column: str) -> pd.Series:
    if column not in df.columns:
        raise KeyError(f"Column '{column}' not found.")
    series = pd.to_numeric(df[column], errors='coerce')
    series = series.dropna()
    if len(series) == 0:
        raise ValueError(f"Column '{column}' has no numeric values.")
    time_columns = [c for c in df.columns if pd.api.types.is_datetime64_any_dtype(df[c])]
    if not time_columns:
        for c in df.columns:
            if c != column and (pd.api.types.is_string_dtype(df[c]) or df[c].dtype == object):
                parsed = pd.to_datetime(df[c], errors='coerce')
                if parsed.notna().sum() >= len(df) * 0.7:
                    df[c] = parsed
                    time_columns.append(c)
                    break
    if len(time_columns) > 0:
        date_values = pd.to_datetime(df.loc[series.index, time_columns[0]], errors='coerce')
        if date_values.notna().sum() > 0:
            series.index = date_values
    return series


def trend_analysis(
    df: pd.DataFrame,
    column: str,
    method: str = 'all',
    windows: Optional[List[int]] = None,
    degree: int = 2,
    lowess_frac: float = 0.05,
) -> Dict[str, object]:
    series = select_numeric_column(df, column)
    if len(series) < 3:
        raise ValueError('Not enough data for trend analysis.')

    if windows is None:
        windows = [7, 30, 90]

    index = series_index_values(series)
    raw_values = safe_json_list(series.tolist())

    x = np.arange(len(series))
    y = series.values

    linear_trend_line = linregress(x, y)
    linear_values = linear_trend_line.intercept + linear_trend_line.slope * x
    linear_metrics = _performance_metrics(y, linear_values)
    growth_rate = float(linear_trend_line.slope / np.mean(y)) if np.mean(y) != 0 else float(linear_trend_line.slope)
    interpretation = _trend_interpretation(linear_trend_line.slope, linear_metrics['r_squared'])

    rolling_means = {}
    rolling_medians = {}
    moving_averages = {}
    for window in windows:
        if len(series) >= 1:
            rolling_series = series.rolling(window, min_periods=1)
            rolling_means[f'{window}d'] = safe_json_list(rolling_series.mean().tolist())
            rolling_medians[f'{window}d'] = safe_json_list(rolling_series.median().tolist())
            moving_averages[f'{window}d'] = safe_json_list(rolling_series.mean().tolist())

    exponential_trend = None
    if np.all(y > 0):
        log_y = np.log(y)
        exp_slope, exp_intercept, exp_r, exp_p, exp_std_err = linregress(x, log_y)
        exp_line = np.exp(exp_intercept + exp_slope * x)
        exponential_metrics = _performance_metrics(y, exp_line)
        exponential_trend = {
            'values': safe_json_list(exp_line.tolist()),
            'slope': float(exp_slope),
            'intercept': float(exp_intercept),
            **exponential_metrics,
        }
    else:
        exponential_trend = {'error': 'Exponential fit requires strictly positive values.'}

    polynomial_trend = None
    if len(series) >= degree + 1:
        coeffs = np.polyfit(x, y, degree)
        poly_values = np.polyval(coeffs, x)
        poly_metrics = _performance_metrics(y, poly_values)
        polynomial_trend = {
            'degree': degree,
            'values': safe_json_list(poly_values.tolist()),
            'coefficients': [float(c) for c in coeffs.tolist()],
            **poly_metrics,
        }
    else:
        polynomial_trend = {'error': f'Polynomial trend requires at least {degree + 1} points.'}

    lowess_trend = None
    if HAS_LOWESS:
        lowess_fit = lowess(y, x, frac=lowess_frac)
        lowess_trend = {
            'values': safe_json_list(lowess_fit[:, 1].tolist()),
            'frac': lowess_frac,
        }
    else:
        lowess_trend = {'error': 'LOWESS unavailable; install statsmodels.'}

    result = {
        'index': index,
        'values': raw_values,
        'trend': safe_json_list(linear_values.tolist()),
        'linear_regression': {
            'slope': float(linear_trend_line.slope),
            'intercept': float(linear_trend_line.intercept),
            'r_squared': linear_metrics['r_squared'],
            'rmse': linear_metrics['rmse'],
            'mae': linear_metrics['mae'],
            'p_value': float(linear_trend_line.pvalue),
            'growth_rate': growth_rate,
        },
        'rolling_mean': rolling_means,
        'rolling_median': rolling_medians,
        'moving_average': moving_averages,
        'polynomial_trend': polynomial_trend,
        'exponential_trend': exponential_trend,
        'lowess_trend': lowess_trend,
        'interpretation': interpretation,
        'trend_method': method,
        'summary': {
            'start': float(series.iloc[0]),
            'end': float(series.iloc[-1]),
            'mean': float(series.mean()),
        },
    }

    return result


def decomposition(df: pd.DataFrame, column: str, period: Optional[int] = None, method: str = 'additive') -> Dict[str, object]:
    series = select_numeric_column(df, column)
    if period is None:
        period = max(2, min(12, len(series) // 5))
    if period < 2 or len(series) < period * 2:
        raise ValueError(f"Decomposition needs at least {period * 2} numeric observations for period {period}.")
    method = (method or 'additive').lower()
    if method == 'multiplicative':
        if (series <= 0).any():
            raise ValueError('Multiplicative decomposition requires all values to be greater than zero.')
        result = seasonal_decompose(series, period=period, model='multiplicative', extrapolate_trend='freq')
        method_name = 'Classical Multiplicative'
    elif method == 'stl':
        result = STL(series, period=period, robust=True).fit()
        method_name = 'STL Decomposition'
    elif method == 'additive':
        result = seasonal_decompose(series, period=period, model='additive', extrapolate_trend='freq')
        method_name = 'Classical Additive'
    else:
        raise ValueError('Choose Classical Additive, Classical Multiplicative, or STL Decomposition.')
    resid = result.resid
    residual_std = float(np.nanstd(resid))
    return {
        'index': series_index_values(series),
        'observed': safe_json_list(result.observed.tolist()),
        'trend': safe_json_list(result.trend.tolist()),
        'seasonal': safe_json_list(result.seasonal.tolist()),
        'resid': safe_json_list(resid.tolist()),
        'period': period,
        'method': method,
        'method_name': method_name,
        'component_explanations': {
            'observed': 'The original values before they are separated into underlying patterns.',
            'trend': 'The long-term direction after short-term and recurring variation are smoothed out.',
            'seasonal': f'The repeating pattern that occurs every {period} observations.',
            'residual': f'The remaining irregular variation not explained by trend or seasonality (standard deviation {residual_std:.2f}).',
        },
    }


def stationarity_test(df: pd.DataFrame, column: str) -> Dict[str, object]:
    series = select_numeric_column(df, column).sort_index()
    if len(series) < 12:
        raise ValueError('Stationarity testing needs at least 12 numeric observations.')

    def run_tests(values: pd.Series) -> Dict[str, object]:
        adf = adfuller(values, autolag='AIC')
        kpss_stat, kpss_pvalue, kpss_lags, kpss_critical = kpss(values, regression='c', nlags='auto')
        pp = PhillipsPerron(values)
        tests = {
            'adf': {'name': 'ADF Test', 'statistic': float(adf[0]), 'p_value': float(adf[1]), 'critical_values': {k: float(v) for k, v in adf[4].items()}, 'decision': 'Stationary' if adf[1] < .05 else 'Non-stationary', 'null_hypothesis': 'The series has a unit root (is non-stationary).'},
            'kpss': {'name': 'KPSS Test', 'statistic': float(kpss_stat), 'p_value': float(kpss_pvalue), 'critical_values': {k: float(v) for k, v in kpss_critical.items()}, 'lags': int(kpss_lags), 'decision': 'Stationary' if kpss_pvalue > .05 else 'Non-stationary', 'null_hypothesis': 'The series is stationary.'},
            'phillips_perron': {'name': 'Phillips-Perron Test', 'statistic': float(pp.stat), 'p_value': float(pp.pvalue), 'critical_values': {k: float(v) for k, v in pp.critical_values.items()}, 'decision': 'Stationary' if pp.pvalue < .05 else 'Non-stationary', 'null_hypothesis': 'The series has a unit root (is non-stationary).'},
        }
        return tests

    tests = run_tests(series)
    stationary_votes = sum(test['decision'] == 'Stationary' for test in tests.values())
    stationary = stationary_votes >= 2
    differenced = series.diff().dropna()
    after_tests = run_tests(differenced) if len(differenced) >= 12 else None
    suggestions = [] if stationary else [
        {'method': 'First differencing', 'description': 'Subtract each value from the previous value to remove a changing level.', 'recommended': True},
        {'method': 'Log transform', 'description': 'Use log(values) to stabilise increasing variance before differencing.', 'recommended': bool((series > 0).all())},
        {'method': 'Seasonal differencing', 'description': 'Subtract the value from the same season in the prior cycle (typically 12 observations).', 'recommended': len(series) >= 24},
    ]
    return {
        'index': series_index_values(series),
        'values': safe_json_list(series.tolist()),
        'tests': tests, 'stationary': stationary,
        'decision': 'Stationary' if stationary else 'Non-stationary',
        'explanation': ('Stationary series have a stable average and variability over time, which lets forecasting models learn repeatable relationships. ' + ('The majority of tests indicate this series is stationary.' if stationary else 'The tests indicate that transformation is advisable before modelling.')),
        'suggestions': suggestions,
        'after_differencing': {'index': series_index_values(differenced), 'values': safe_json_list(differenced.tolist()), 'tests': after_tests, 'decision': ('Stationary' if sum(test['decision'] == 'Stationary' for test in after_tests.values()) >= 2 else 'Non-stationary') if after_tests else None},
    }


def autocorrelation(df: pd.DataFrame, column: str, nlags: int = 20) -> Dict[str, object]:
    series = select_numeric_column(df, column).sort_index()
    nlags = min(max(1, int(nlags)), len(series) - 1)
    acf_values, confidence_intervals = acf(series, nlags=nlags, fft=True, alpha=.05)
    significant_lags = [
        int(lag) for lag in range(1, len(acf_values))
        if confidence_intervals[lag][0] > 0 or confidence_intervals[lag][1] < 0
    ]
    lag_table = [
        {'lag': int(lag), 'correlation': float(acf_values[lag]), 'lower_confidence': float(confidence_intervals[lag][0]), 'upper_confidence': float(confidence_intervals[lag][1]), 'significant': int(lag) in significant_lags}
        for lag in range(1, len(acf_values))
    ]
    rolling_window = min(max(8, len(series) // 8), 30)
    rolling = series.rolling(rolling_window).corr(series.shift(1))
    lag_one = float(acf_values[1])
    if lag_one >= .5:
        persistence = 'strong positive persistence'
    elif lag_one >= .2:
        persistence = 'moderate positive persistence'
    elif lag_one <= -.2:
        persistence = 'negative autocorrelation (a tendency to alternate)'
    else:
        persistence = 'little short-term persistence'
    return {
        'index': list(range(len(acf_values))),
        'acf': safe_json_list(acf_values.tolist()),
        'nlags': nlags,
        'confidence_intervals': [{'lower': float(pair[0]), 'upper': float(pair[1])} for pair in confidence_intervals],
        'lag_table': lag_table, 'significant_lags': significant_lags,
        'rolling_correlation': {'index': series_index_values(rolling), 'values': safe_json_list(rolling.tolist()), 'window': rolling_window},
        'persistence': persistence,
        'explanation': f'The lag-one correlation is {lag_one:.2f}, indicating {persistence}. Positive autocorrelation means nearby observations tend to move in the same direction; negative autocorrelation means they tend to alternate above and below the recent level.',
    }


def partial_autocorrelation(df: pd.DataFrame, column: str, nlags: int = 20) -> Dict[str, object]:
    series = select_numeric_column(df, column).sort_index()
    if len(series) < 4:
        raise ValueError('Partial autocorrelation needs at least 4 numeric observations.')
    nlags = min(max(1, int(nlags)), len(series) // 2 - 1)
    pacf_values, confidence_intervals = pacf(series, nlags=nlags, method='ywmle', alpha=.05)
    significant_lags = [
        int(lag) for lag in range(1, len(pacf_values))
        if confidence_intervals[lag][0] > 0 or confidence_intervals[lag][1] < 0
    ]
    # AR order is most interpretable when it is the initial uninterrupted run.
    suggested_order = 0
    for lag in range(1, len(pacf_values)):
        if lag in significant_lags:
            suggested_order = lag
        else:
            break
    if suggested_order == 0 and significant_lags:
        suggested_order = significant_lags[0]
    interpretation = (
        f"Significant partial correlations occur at lags {', '.join(map(str, significant_lags)) or 'none'}. "
        + (f"This supports testing an AR({suggested_order}) model, because PACF measures each lag's direct relationship after earlier lags are accounted for." if suggested_order else 'No direct lag relationship is clearly significant, so an AR term may not be necessary.')
    )
    return {
        'index': list(range(len(pacf_values))),
        'pacf': safe_json_list(pacf_values.tolist()),
        'nlags': nlags,
        'confidence_intervals': [{'lower': float(pair[0]), 'upper': float(pair[1])} for pair in confidence_intervals],
        'significant_lags': significant_lags,
        'suggested_ar_order': suggested_order,
        'interpretation': interpretation,
    }


def spectral_analysis(df: pd.DataFrame, column: str) -> Dict[str, object]:
    series = select_numeric_column(df, column).sort_index()
    centered = series.dropna().values - series.dropna().mean()
    freqs, power = signal.periodogram(centered)
    fft_values = np.fft.rfft(centered)
    fft_frequencies = np.fft.rfftfreq(len(centered))
    fft_magnitude = np.abs(fft_values)
    peak_indices, _ = signal.find_peaks(power)
    peak_indices = [int(index) for index in peak_indices if freqs[index] > 0]
    peak_indices.sort(key=lambda index: power[index], reverse=True)
    dominant_peaks = [
        {'frequency': float(freqs[index]), 'power': float(power[index]), 'estimated_period': float(1 / freqs[index]), 'rank': rank + 1}
        for rank, index in enumerate(peak_indices[:5])
    ]
    if not dominant_peaks and len(freqs) > 1:
        index = int(np.argmax(power[1:]) + 1)
        dominant_peaks = [{'frequency': float(freqs[index]), 'power': float(power[index]), 'estimated_period': float(1 / freqs[index]), 'rank': 1}]
    dominant = dominant_peaks[0] if dominant_peaks else None
    explanation = (
        f"The strongest hidden cycle repeats about every {dominant['estimated_period']:.1f} observations "
        f"(frequency {dominant['frequency']:.4f}). High spectral power at this frequency indicates a recurring pattern beyond the visible trend."
        if dominant else 'No dominant repeating cycle could be isolated from this series.'
    )
    return {
        'frequencies': safe_json_list(freqs.tolist()),
        'power': safe_json_list(power.tolist()),
        'fft_frequencies': safe_json_list(fft_frequencies.tolist()),
        'fft_magnitude': safe_json_list(fft_magnitude.tolist()),
        'dominant_peaks': dominant_peaks,
        'dominant_frequency': dominant['frequency'] if dominant else None,
        'estimated_period': dominant['estimated_period'] if dominant else None,
        'explanation': explanation,
    }


def wavelet_analysis(df: pd.DataFrame, column: str) -> Dict[str, object]:
    series = select_numeric_column(df, column).sort_index()
    values = series.values.astype(float)
    values = (values - values.mean()) / (values.std() or 1)
    scales = np.arange(1, min(64, max(2, len(series) // 2)) + 1)
    coeffs, frequencies = pywt.cwt(values, scales=scales, wavelet='morl')
    power_matrix = np.abs(coeffs) ** 2
    power = power_matrix.mean(axis=1)
    time_power = power_matrix.max(axis=0)
    threshold = float(np.quantile(time_power, .95))
    event_indices = signal.find_peaks(time_power, height=threshold, distance=max(1, len(series) // 20))[0]
    transient_events = [
        {'index': int(index), 'date': normalize_scalar(series.index[index]), 'power': float(time_power[index]), 'dominant_scale': int(scales[np.argmax(power_matrix[:, index])])}
        for index in event_indices
    ]
    start_scale = int(scales[np.argmax(power_matrix[:, :max(1, len(series) // 3)].mean(axis=1))])
    end_scale = int(scales[np.argmax(power_matrix[:, -max(1, len(series) // 3):].mean(axis=1))])
    change_text = 'remains broadly stable' if start_scale == end_scale else f'shifts from scale {start_scale} early in the series to scale {end_scale} later on'
    explanation = (
        f"Wavelet power shows localized periodicity across short and long time scales. The most prominent scale is {int(scales[np.argmax(power)])}. "
        f"The dominant frequency {change_text}. High-power patches mark transient events or short-lived cycles."
    )
    display_indices = np.linspace(0, len(series) - 1, min(240, len(series)), dtype=int)
    return {
        'scales': safe_json_list(scales.tolist()),
        'mean_power': safe_json_list(power.tolist()),
        'frequencies': safe_json_list(frequencies.tolist()),
        'index': series_index_values(series.iloc[display_indices]),
        'scalogram': power_matrix[:, display_indices].tolist(),
        'transient_events': transient_events,
        'dominant_scale': int(scales[np.argmax(power)]),
        'start_dominant_scale': start_scale, 'end_dominant_scale': end_scale,
        'explanation': explanation,
    }


def _segment_stats(series: pd.Series, point: int) -> Dict[str, float]:
    before = series.iloc[:point]
    after = series.iloc[point:]
    return {
        'before_mean': float(before.mean()),
        'before_std': float(before.std()),
        'before_count': int(len(before)),
        'after_mean': float(after.mean()),
        'after_std': float(after.std()),
        'after_count': int(len(after)),
        'mean_change': float(after.mean() - before.mean()),
        'std_change': float(after.std() - before.std()),
    }


def _cusum_change_points(series: pd.Series, threshold: float = 4.0, drift: float = 0.0) -> List[int]:
    mean = series.mean()
    std = series.std() if series.std() != 0 else 1.0
    s_pos = 0.0
    s_neg = 0.0
    points = []
    for i, value in enumerate(series - mean - drift):
        s_pos = max(0, s_pos + value)
        s_neg = min(0, s_neg + value)
        if s_pos > threshold * std:
            points.append(i)
            s_pos = 0
            s_neg = 0
        elif s_neg < -threshold * std:
            points.append(i)
            s_pos = 0
            s_neg = 0
    return sorted(set(points))


def _window_change_points(series: pd.Series, window: int = 10, threshold: float = 2.0) -> List[int]:
    points = []
    n = len(series)
    if n < window * 2 + 1:
        return points
    for i in range(window, n - window):
        left = series.iloc[i - window:i]
        right = series.iloc[i:i + window]
        if left.std() == 0 and right.std() == 0:
            continue
        diff = abs(left.mean() - right.mean())
        scale = max(left.std(), right.std(), 1e-8)
        if diff > threshold * scale:
            points.append(i)
    return sorted(set(points))


def _binary_segmentation(series: pd.Series, min_size: int = 10, threshold: float = 2.0) -> List[int]:
    points = []

    def split_segment(start: int, end: int):
        if end - start < min_size * 2:
            return
        best_score = 0.0
        best_point = None
        for split in range(start + min_size, end - min_size + 1):
            left = series.iloc[start:split]
            right = series.iloc[split:end]
            diff = abs(left.mean() - right.mean())
            pooled_std = np.sqrt(((left.size - 1) * left.var() + (right.size - 1) * right.var()) / max(left.size + right.size - 2, 1))
            score = diff / max(pooled_std, 1e-8)
            if score > best_score:
                best_score = score
                best_point = split
        if best_point is not None and best_score > threshold:
            points.append(best_point)
            split_segment(start, best_point)
            split_segment(best_point, end)

    split_segment(0, len(series))
    return sorted(set(points))


def _pelt_change_points(series: pd.Series, min_size: int = 10, penalty: float = 3.0) -> List[int]:
    n = len(series)
    if n < min_size * 2:
        return []

    x = series.values.astype(float)
    cumsum = np.concatenate([[0.0], np.cumsum(x)])
    cumsum_sq = np.concatenate([[0.0], np.cumsum(x * x)])

    def segment_cost(start: int, end: int) -> float:
        length = end - start
        if length <= 0:
            return 0.0
        total = cumsum[end] - cumsum[start]
        total_sq = cumsum_sq[end] - cumsum_sq[start]
        mean = total / length
        return total_sq - 2 * mean * total + mean * mean * length

    F = np.zeros(n + 1)
    cp = [-1] * (n + 1)
    F[0] = -penalty
    for t in range(1, n + 1):
        candidates = [s for s in range(max(0, t - 200), t - min_size + 1)]
        costs = []
        for s in candidates:
            if t - s < min_size:
                continue
            costs.append(F[s] + segment_cost(s, t) + penalty)
        if costs:
            best = np.argmin(costs)
            F[t] = costs[best]
            cp[t] = candidates[best]
        else:
            F[t] = np.inf
            cp[t] = 0

    change_points = []
    t = n
    while t > 0 and cp[t] > 0:
        change_points.append(cp[t])
        t = cp[t]
    return sorted(set(change_points))


def _bayesian_change_point_detection(series: pd.Series, hazard: float = 0.02) -> Dict[str, object]:
    from scipy.special import gammaln

    x = series.values.astype(float)
    n = len(x)
    if n < 8:
        return {'posterior_probabilities': [], 'change_points': [], 'method': 'bayesian', 'confidence': 0.0}

    def log_marginal_likelihood(values: np.ndarray) -> float:
        n = len(values)
        mean = values.mean()
        ss = np.sum((values - mean) ** 2)
        alpha0 = 1.0
        beta0 = 1.0
        kappa0 = 1.0
        mu0 = 0.0
        alpha_n = alpha0 + n / 2.0
        kappa_n = kappa0 + n
        beta_n = beta0 + 0.5 * ss + 0.5 * kappa0 * n * (mean - mu0) ** 2 / kappa_n
        return (
            gammaln(alpha_n)
            - gammaln(alpha0)
            + 0.5 * np.log(kappa0 / kappa_n)
            + alpha0 * np.log(beta0)
            - alpha_n * np.log(beta_n)
            - 0.5 * n * np.log(np.pi)
        )

    log_probs = []
    for cp in range(3, n - 3):
        left = x[:cp]
        right = x[cp:]
        logp_left = log_marginal_likelihood(left)
        logp_right = log_marginal_likelihood(right)
        logp_cp = logp_left + logp_right + np.log(hazard)
        logp_no_cp = log_marginal_likelihood(x) + np.log(1 - hazard)
        log_probs.append((cp, logp_cp - logp_no_cp))

    if not log_probs:
        return {'posterior_probabilities': [], 'change_points': [], 'method': 'bayesian', 'confidence': 0.0}

    max_diff = max(diff for _, diff in log_probs)
    probs = [1 / (1 + np.exp(-(diff - max_diff))) for _, diff in log_probs]
    change_points = [cp for (cp, _), p in zip(log_probs, probs) if p > 0.7]
    return {
        'posterior_probabilities': [float(p) for p in probs],
        'change_points': sorted(set(change_points)),
        'method': 'bayesian',
        'confidence': float(np.mean(probs)) if probs else 0.0,
    }


def change_point_detection(df: pd.DataFrame, column: str, params: Optional[Dict[str, object]] = None) -> Dict[str, object]:
    series = select_numeric_column(df, column).sort_index()
    params = params or {}
    methods = params.get('methods', ['cusum', 'pelt', 'binary', 'window', 'bayesian'])
    thresholds = {
        'cusum': float(params.get('cusum_threshold', 4.0)),
        'window': float(params.get('window_threshold', 2.0)),
        'binary': float(params.get('binary_threshold', 2.0)),
        'pelt': float(params.get('pelt_penalty', 3.0)),
        'bayesian': float(params.get('bayesian_hazard', 0.02)),
    }
    windows = int(params.get('window_size', 10))
    min_size = int(params.get('min_size', 10))

    method_results = {}
    change_points = set()

    try:
        cusum_points = _cusum_change_points(series, threshold=thresholds['cusum'])
        method_results['cusum'] = {
            'change_points': cusum_points,
            'confidence': len(cusum_points) / max(len(series), 1),
            'description': 'Cumulative sum change detection identifies sustained shifts in the level of the series.',
            'segments': [_segment_stats(series, cp) for cp in cusum_points],
        }
        change_points.update(cusum_points)
    except Exception as exc:
        method_results['cusum'] = {'error': str(exc)}

    try:
        window_points = _window_change_points(series, window=windows, threshold=thresholds['window'])
        method_results['window'] = {
            'change_points': window_points,
            'confidence': len(window_points) / max(len(series), 1),
            'description': 'Window-based detection compares adjacent windows for sudden shifts in mean or variability.',
            'segments': [_segment_stats(series, cp) for cp in window_points],
        }
        change_points.update(window_points)
    except Exception as exc:
        method_results['window'] = {'error': str(exc)}

    try:
        binary_points = _binary_segmentation(series, min_size=min_size, threshold=thresholds['binary'])
        method_results['binary'] = {
            'change_points': binary_points,
            'confidence': len(binary_points) / max(len(series), 1),
            'description': 'Binary segmentation recursively splits the series where the mean shows the strongest shift.',
            'segments': [_segment_stats(series, cp) for cp in binary_points],
        }
        change_points.update(binary_points)
    except Exception as exc:
        method_results['binary'] = {'error': str(exc)}

    try:
        pelt_points = _pelt_change_points(series, min_size=min_size, penalty=thresholds['pelt'])
        method_results['pelt'] = {
            'change_points': pelt_points,
            'confidence': len(pelt_points) / max(len(series), 1),
            'description': 'PELT finds multiple change points by optimizing a penalized cost over possible segmentations.',
            'segments': [_segment_stats(series, cp) for cp in pelt_points],
        }
        change_points.update(pelt_points)
    except Exception as exc:
        method_results['pelt'] = {'error': str(exc)}

    try:
        bayesian = _bayesian_change_point_detection(series, hazard=thresholds['bayesian'])
        method_results['bayesian'] = {
            'change_points': bayesian.get('change_points', []),
            'confidence': bayesian.get('confidence', 0.0),
            'description': 'Bayesian detection estimates the posterior probability of a structural break at each point.',
            'posterior_probabilities': bayesian.get('posterior_probabilities', []),
        }
        change_points.update(bayesian.get('change_points', []))
    except Exception as exc:
        method_results['bayesian'] = {'error': str(exc)}

    sorted_changes = sorted(change_points)
    causes = [
        'Abrupt event or regime change in the underlying system.',
        'Data collection or measurement process change.',
        'Seasonal or periodic shift that alters the series mean or volatility.',
        'Policy, operational, or structural change affecting behavior.',
        'Anomaly, instrument drift, or data quality issue.'
    ]

    return {
        'index': series_index_values(series),
        'values': safe_json_list(series.tolist()),
        'change_points': safe_json_list(sorted_changes),
        'methods': method_results,
        'timeline': {
            'detected_change_points': safe_json_list(sorted_changes),
            'count': len(sorted_changes),
        },
        'confidence': float(np.mean([m.get('confidence', 0.0) for m in method_results.values() if isinstance(m, dict)])) if method_results else 0.0,
        'before_after_comparisons': {
            str(cp): _segment_stats(series, cp) for cp in sorted_changes
        },
        'possible_causes': causes,
        'explanation': 'Detected structural breaks may be caused by regime shifts, measurement changes, or sudden external events. Review before/after statistics and compare with external context for interpretation.',
    }


def seasonal_analysis(df: pd.DataFrame, column: str, period: Optional[int] = None) -> Dict[str, object]:
    """Describe calendar seasonality for a dated numeric series.

    This intentionally does not require a full decomposition: monthly and
    calendar patterns remain useful for shorter data sets as well.
    """
    series = select_numeric_column(df, column).sort_index()
    if not isinstance(series.index, pd.DatetimeIndex):
        raise ValueError('Seasonal analysis needs a date/time column. Select a time axis before running it.')
    if len(series) < 8:
        raise ValueError('Seasonal analysis needs at least 8 numeric observations.')

    frame = pd.DataFrame({'value': series})
    frame['month'] = frame.index.month
    frame['weekday'] = frame.index.dayofweek
    frame['quarter'] = frame.index.quarter
    frame['year'] = frame.index.year

    def summaries(group_column, periods):
        grouped = frame.groupby(group_column)['value']
        return [
            {
                'period': int(item), 'average': float(grouped.mean().get(item, np.nan)),
                'count': int(grouped.count().get(item, 0)), 'min': float(grouped.min().get(item, np.nan)),
                'q1': float(grouped.quantile(.25).get(item, np.nan)),
                'median': float(grouped.median().get(item, np.nan)),
                'q3': float(grouped.quantile(.75).get(item, np.nan)),
                'max': float(grouped.max().get(item, np.nan)),
            }
            for item in periods if item in grouped.groups
        ]

    monthly = summaries('month', range(1, 13))
    weekly = summaries('weekday', range(0, 7))
    quarterly = summaries('quarter', range(1, 5))
    yearly = summaries('year', sorted(frame['year'].unique()))
    monthly_average = np.array([item['average'] for item in monthly], dtype=float)
    overall_mean = float(series.mean())
    seasonal_variance = float(np.var(monthly_average)) if len(monthly_average) else 0.0
    total_variance = float(np.var(series.values))
    variance_explained = max(0.0, min(1.0, seasonal_variance / total_variance)) if total_variance else 0.0
    seasonal_strength = float(np.sqrt(variance_explained))
    seasonality_index = float(np.std(monthly_average) / abs(overall_mean)) if overall_mean else 0.0
    peak = max(monthly, key=lambda item: item['average'])
    low = min(monthly, key=lambda item: item['average'])
    strength_label = 'strong' if seasonal_strength >= .6 else 'moderate' if seasonal_strength >= .3 else 'weak'
    explanation = (
        f"{column} shows {strength_label} calendar seasonality: month-to-month differences explain "
        f"{variance_explained:.0%} of the observed variance. The average peaks in month {peak['period']} "
        f"({peak['average']:.2f}) and is lowest in month {low['period']} ({low['average']:.2f})."
    )

    calendar = [
        {'date': timestamp.strftime('%Y-%m-%d'), 'year': int(timestamp.year), 'month': int(timestamp.month), 'value': float(value)}
        for timestamp, value in series.items()
    ]
    return {
        'monthly_pattern': monthly, 'weekly_pattern': weekly, 'quarterly_pattern': quarterly,
        'yearly_pattern': yearly, 'calendar': calendar, 'average_seasonal_cycle': monthly,
        'statistics': {
            'seasonal_strength': seasonal_strength, 'peak_month': peak['period'], 'lowest_month': low['period'],
            'seasonality_index': seasonality_index, 'variance_explained': variance_explained,
            'observations': int(len(series)), 'years_covered': int(frame['year'].nunique()),
        },
        'explanation': explanation,
    }


def cycle_analysis(df: pd.DataFrame, column: str, period: Optional[int] = None, method: str = 'hp') -> Dict[str, object]:
    """Extract long-run cycles and identify their turning points."""
    series = select_numeric_column(df, column).sort_index()
    if len(series) < 12:
        raise ValueError('Cycle analysis needs at least 12 numeric observations.')
    period = max(2, int(period or 12))
    method = (method or 'hp').lower()

    if method == 'hp':
        # 1600 is standard for quarterly observations; scale gently for other data.
        cycle, trend = hpfilter(series, lamb=1600 * (period / 4) ** 4)
        filter_name = 'HP Filter'
    elif method == 'baxter_king':
        cycle = bkfilter(series, low=max(2, period // 2), high=max(period + 1, period * 3), K=min(12, max(2, len(series) // 8)))
        trend = series.loc[cycle.index] - cycle
        filter_name = 'Baxter-King Filter'
    elif method == 'christiano_fitzgerald':
        cycle, trend = cffilter(series, low=max(2, period // 2), high=max(period + 1, period * 3), drift=True)
        filter_name = 'Christiano-Fitzgerald Filter'
    elif method == 'rolling':
        window = min(len(series) if len(series) % 2 else len(series) - 1, max(3, period * 2 + 1))
        trend = series.rolling(window=window, center=True, min_periods=max(2, window // 3)).mean().bfill().ffill()
        cycle = series - trend
        filter_name = 'Rolling Cycle'
    else:
        raise ValueError('Choose HP, Baxter-King, Christiano-Fitzgerald, or Rolling Cycles.')

    cycle = pd.Series(cycle).dropna()
    trend = pd.Series(trend).reindex(cycle.index)
    peak_indices, _ = signal.find_peaks(cycle.values)
    trough_indices, _ = signal.find_peaks(-cycle.values)
    peaks = [{'index': int(i), 'date': normalize_scalar(cycle.index[i]), 'value': float(cycle.iloc[i])} for i in peak_indices]
    troughs = [{'index': int(i), 'date': normalize_scalar(cycle.index[i]), 'value': float(cycle.iloc[i])} for i in trough_indices]
    intervals = np.diff(peak_indices)
    average_duration = float(np.mean(intervals)) if len(intervals) else None
    amplitude = float((cycle.max() - cycle.min()) / 2)
    frequencies, power = signal.periodogram(cycle.values)
    valid = frequencies > 0
    detected_length = float(1 / frequencies[valid][np.argmax(power[valid])]) if valid.any() else None
    interpretation = (
        f"{filter_name} found {len(peaks)} peaks and {len(troughs)} troughs. "
        f"The cycle amplitude is {amplitude:.2f}. "
        + (f"The dominant cycle repeats about every {detected_length:.1f} observations. " if detected_length else '')
        + (f"Peak-to-peak duration averages {average_duration:.1f} observations." if average_duration else 'More turning points are needed to estimate average cycle duration.')
    )
    return {
        'method': method, 'filter_name': filter_name, 'period': period,
        'index': series_index_values(cycle), 'values': safe_json_list(series.reindex(cycle.index).tolist()),
        'trend': safe_json_list(trend.tolist()), 'cycle_component': safe_json_list(cycle.tolist()),
        'rolling_cycle': safe_json_list((series - series.rolling(min(len(series), max(3, period)), min_periods=1).mean()).reindex(cycle.index).tolist()),
        'peaks': peaks, 'troughs': troughs,
        'statistics': {'average_cycle_duration': average_duration, 'cycle_amplitude': amplitude, 'detected_cycle_length': detected_length, 'peak_count': len(peaks), 'trough_count': len(troughs)},
        'interpretation': interpretation,
    }


def _wrap_text(text: str, width: int = 90) -> List[str]:
    return textwrap.wrap(str(text), width=width)


def _draw_text(cnv: canvas.Canvas, lines: List[str], x: float, y: float, line_height: float) -> float:
    for line in lines:
        cnv.drawString(x, y, line)
        y -= line_height
    return y


def _new_page(cnv: canvas.Canvas, margin: float) -> float:
    cnv.showPage()
    cnv.setFont('Helvetica', 10)
    return letter[1] - margin


def make_pdf_report(report_data: Dict[str, object]) -> bytes:
    buffer = io.BytesIO()
    cnv = canvas.Canvas(buffer, pagesize=letter)
    margin = inch
    y = letter[1] - margin

    cnv.setFont('Helvetica-Bold', 16)
    cnv.drawString(margin, y, 'Predictive Analysis Report')
    y -= 24

    cnv.setFont('Helvetica-Bold', 11)
    y = _draw_text(cnv, _wrap_text('Dataset metadata:'), margin, y, 14)
    cnv.setFont('Helvetica', 10)
    y -= 4

    meta_lines = [
        f"Dataset ID: {report_data.get('dataset_id')}",
        f"Filename: {report_data.get('filename')}",
        f"Sheet: {report_data.get('sheet')}",
        f"Rows: {report_data.get('row_count')}",
        f"Index column: {report_data.get('index_column')}",
        f"Time columns: {', '.join(report_data.get('time_columns', [])) or 'none'}",
        f"Analysis type: {report_data.get('analysis_type')}",
        f"Column: {report_data.get('column')}",
        f"Parameters: {report_data.get('params')}",
    ]

    for line in meta_lines:
        if y < margin + 40:
            y = _new_page(cnv, margin)
        y = _draw_text(cnv, _wrap_text(line), margin, y, 12)
        y -= 2

    y -= 10
    cnv.setFont('Helvetica-Bold', 11)
    if y < margin + 40:
        y = _new_page(cnv, margin)
    y = _draw_text(cnv, _wrap_text('Analysis results summary:'), margin, y, 14)
    cnv.setFont('Helvetica', 10)
    y -= 4

    results = report_data.get('results', {})
    for key, value in results.items():
        if y < margin + 40:
            y = _new_page(cnv, margin)
        if isinstance(value, dict):
            y = _draw_text(cnv, _wrap_text(f'{key}:'), margin, y, 12)
            y -= 2
            for sub_key, sub_value in value.items():
                if y < margin + 40:
                    y = _new_page(cnv, margin)
                text = f'  {sub_key}: {sub_value}'
                y = _draw_text(cnv, _wrap_text(text), margin + 12, y, 12)
                y -= 2
        elif isinstance(value, (list, tuple)):
            # Show a short summary of lists/tuples to avoid overly long lines
            try:
                total_len = len(value)
            except Exception:
                total_len = None
            summary = value if (total_len is None or total_len <= 20) else list(value)[:20]
            text = f"{key}: {summary}"
            if total_len and total_len > 20:
                text += f" ... (total {total_len})"
            y = _draw_text(cnv, _wrap_text(text), margin, y, 12)
            y -= 2
        else:
            # Scalars or other types
            text = f"{key}: {normalize_scalar(value)}"
            y = _draw_text(cnv, _wrap_text(text), margin, y, 12)
            y -= 2

    # Attempt to add a simple plot if results contain series-like data
    try:
        plot_added = False
        # Prefer keys named 'values' with matching 'index' or 'observed'
        if isinstance(results, dict):
            x = None
            yvals = None
            if 'values' in results and 'index' in results:
                x = results.get('index')
                yvals = results.get('values')
            elif 'observed' in results and 'index' in results:
                x = results.get('index')
                yvals = results.get('observed')
            else:
                # look for the first dict entry that looks like a series
                for k, v in results.items():
                    if isinstance(v, dict) and 'values' in v and 'index' in v:
                        x = v.get('index')
                        yvals = v.get('values')
                        break

            if x is not None and yvals is not None and len(yvals) >= 2:
                try:
                    # normalize numeric y values for plotting
                    plot_x = list(range(len(yvals))) if x and not all(isinstance(xx, (int, float)) for xx in x) else [normalize_scalar(xx) for xx in x]
                    plot_y = [float(el) for el in yvals]
                    fig, ax = plt.subplots(figsize=(6, 2.5), dpi=100)
                    ax.plot(plot_x, plot_y, marker='o')
                    ax.set_title(f"{report_data.get('analysis_type')} — {report_data.get('column')}")
                    ax.set_xlabel('Index')
                    ax.set_ylabel('Value')
                    fig.tight_layout()
                    img_buf = io.BytesIO()
                    fig.savefig(img_buf, format='png', bbox_inches='tight')
                    plt.close(fig)
                    img_buf.seek(0)
                    img = ImageReader(img_buf)
                    img_w = letter[0] - 2 * margin
                    img_h = 2.5 * inch
                    if y - img_h < margin:
                        y = _new_page(cnv, margin)
                    cnv.drawImage(img, margin, y - img_h, width=img_w, height=img_h)
                    y -= img_h + 8
                    plot_added = True
                except Exception:
                    plot_added = False
        # If no plot added, optionally add a small table of key metrics
        if not plot_added:
            # render a small key:value block if available
            metrics = []
            # try to extract summary or top-level numeric scalars
            if isinstance(results, dict):
                # prefer `summary` keys
                if 'summary' in results and isinstance(results['summary'], dict):
                    for sk, sv in results['summary'].items():
                        metrics.append((str(sk), normalize_scalar(sv)))
                else:
                    # take up to 6 scalar items
                    for k, v in results.items():
                        if len(metrics) >= 6:
                            break
                        if isinstance(v, (int, float, str)):
                            metrics.append((str(k), normalize_scalar(v)))
            if metrics:
                if y < margin + 80:
                    y = _new_page(cnv, margin)
                cnv.setFont('Helvetica-Bold', 11)
                y = _draw_text(cnv, _wrap_text('Key metrics:'), margin, y, 14)
                cnv.setFont('Helvetica', 10)
                y -= 4
                for k, v in metrics:
                    if y < margin + 40:
                        y = _new_page(cnv, margin)
                    t = f"{k}: {v}"
                    y = _draw_text(cnv, _wrap_text(t), margin + 6, y, 12)
                    y -= 2
    except Exception:
        # ignore plotting errors and continue
        pass

    # finalize PDF and return bytes
    cnv.save()
    buffer.seek(0)
    return buffer.getvalue()


def make_multi_pdf_report(report_data: Dict[str, object]) -> bytes:
    """Create a multipage PDF: one page per analysis in report_data['results'].

    Expects `results` to be a dict mapping analysis_name -> result dict.
    """
    buffer = io.BytesIO()
    cnv = canvas.Canvas(buffer, pagesize=letter)
    margin = inch

    results = report_data.get('results', {})

    # Header page with metadata
    y = letter[1] - margin
    cnv.setFont('Helvetica-Bold', 18)
    cnv.drawString(margin, y, 'Predictive Analysis Report (Multi)')
    y -= 28
    cnv.setFont('Helvetica', 10)
    meta_lines = [
        f"Dataset ID: {report_data.get('dataset_id')}",
        f"Filename: {report_data.get('filename')}",
        f"Sheet: {report_data.get('sheet')}",
        f"Rows: {report_data.get('row_count')}",
        f"Index column: {report_data.get('index_column')}",
        f"Time columns: {', '.join(report_data.get('time_columns', [])) or 'none'}",
        f"Column: {report_data.get('column')}",
    ]
    for line in meta_lines:
        cnv.drawString(margin, y, line)
        y -= 14

    cnv.showPage()

    # For each analysis, render a page with a plot (or panels) and a small table
    for analysis_name, res in results.items():
        y = letter[1] - margin
        # Header
        cnv.setFont('Helvetica-Bold', 16)
        cnv.drawCentredString(letter[0] / 2.0, y, f"Analysis: {analysis_name.title()}")
        y -= 22

        # If error, show message and continue
        if isinstance(res, dict) and res.get('error'):
            cnv.setFont('Helvetica', 10)
            cnv.drawString(margin, y, f"Error: {res.get('error')}")
            cnv.showPage()
            continue

        plotted = False

        # Decomposition: render 4-panel plot (observed, trend, seasonal, resid)
        if analysis_name in ('decomposition', 'seasonal', 'cycle') and isinstance(res, dict):
            try:
                obs = res.get('observed')
                tr = res.get('trend')
                sea = res.get('seasonal')
                rid = res.get('resid')
                if obs and tr and sea and rid:
                    fig, axes = plt.subplots(4, 1, figsize=(6.5, 6.0), dpi=100, sharex=True)
                    x = list(range(len(obs)))
                    axes[0].plot(x, [float(v) for v in obs], color='black')
                    axes[0].set_ylabel('Observed')
                    axes[1].plot(x, [float(v) for v in tr], color='blue')
                    axes[1].set_ylabel('Trend')
                    axes[2].plot(x, [float(v) for v in sea], color='green')
                    axes[2].set_ylabel('Seasonal')
                    axes[3].plot(x, [float(v) for v in rid], color='red')
                    axes[3].set_ylabel('Resid')
                    axes[3].set_xlabel('Index')
                    fig.suptitle(f"Decomposition — {report_data.get('column')}")
                    fig.tight_layout(rect=[0, 0, 1, 0.96])
                    img_buf = io.BytesIO()
                    fig.savefig(img_buf, format='png', bbox_inches='tight')
                    plt.close(fig)
                    img_buf.seek(0)
                    img = ImageReader(img_buf)
                    img_w = letter[0] - 2 * margin
                    img_h = 6.0 * inch
                    cnv.drawImage(img, margin, y - img_h, width=img_w, height=img_h)
                    y -= img_h + 8
                    plotted = True
            except Exception:
                plotted = False

        # Combined ACF + PACF page: if both analyses exist, draw them side-by-side
        elif analysis_name == 'autocorrelation' and isinstance(res, dict):
            try:
                pacf_res = results.get('partial_autocorrelation')
                acf_vals = res.get('acf')
                acf_idx = res.get('index')
                pacf_vals = pacf_res.get('pacf') if isinstance(pacf_res, dict) else None
                pacf_idx = pacf_res.get('index') if isinstance(pacf_res, dict) else None
                if acf_vals is not None and pacf_vals is not None:
                    fig, axes = plt.subplots(1, 2, figsize=(10, 3.5), dpi=100)
                    axes[0].stem(acf_idx, [float(v) for v in acf_vals], use_line_collection=True)
                    axes[0].set_title('ACF')
                    axes[1].stem(pacf_idx, [float(v) for v in pacf_vals], use_line_collection=True)
                    axes[1].set_title('PACF')
                    fig.suptitle(f"Autocorrelation / Partial Autocorrelation — {report_data.get('column')}")
                    fig.tight_layout(rect=[0, 0, 1, 0.95])
                    img_buf = io.BytesIO()
                    fig.savefig(img_buf, format='png', bbox_inches='tight')
                    plt.close(fig)
                    img_buf.seek(0)
                    img = ImageReader(img_buf)
                    img_w = letter[0] - 2 * margin
                    img_h = 3.5 * inch
                    cnv.drawImage(img, margin, y - img_h, width=img_w, height=img_h)
                    y -= img_h + 8
                    plotted = True
                else:
                    # fallback to single ACF plot
                    if acf_vals is not None:
                        fig, ax = plt.subplots(figsize=(6.5, 3.5), dpi=100)
                        ax.stem(acf_idx, [float(v) for v in acf_vals], use_line_collection=True)
                        ax.set_title('ACF')
                        fig.tight_layout()
                        img_buf = io.BytesIO()
                        fig.savefig(img_buf, format='png', bbox_inches='tight')
                        plt.close(fig)
                        img_buf.seek(0)
                        img = ImageReader(img_buf)
                        img_w = letter[0] - 2 * margin
                        img_h = 3 * inch
                        cnv.drawImage(img, margin, y - img_h, width=img_w, height=img_h)
                        y -= img_h + 8
                        plotted = True
            except Exception:
                plotted = False

        else:
            # default rendering for single-series analyses
            px = None
            py = None
            title = analysis_name
            if isinstance(res, dict):
                if 'observed' in res and 'index' in res:
                    px = res.get('index')
                    py = res.get('observed')
                elif 'values' in res and 'index' in res:
                    px = res.get('index')
                    py = res.get('values')
                elif 'acf' in res:
                    px = res.get('index')
                    py = res.get('acf')
                    title = 'Autocorrelation'
                elif 'pacf' in res:
                    px = res.get('index')
                    py = res.get('pacf')
                    title = 'Partial Autocorrelation'
                elif 'frequencies' in res and 'power' in res:
                    px = res.get('frequencies')
                    py = res.get('power')
                    title = 'Spectral Power'
                elif 'scales' in res and 'mean_power' in res:
                    px = res.get('scales')
                    py = res.get('mean_power')
                    title = 'Wavelet Mean Power'

            if px is not None and py is not None:
                try:
                    plot_x = list(range(len(py))) if not all(isinstance(xx, (int, float)) for xx in px) else [normalize_scalar(xx) for xx in px]
                    plot_y = [float(v) for v in py]
                    fig, ax = plt.subplots(figsize=(6.5, 3.5), dpi=100)
                    ax.plot(plot_x, plot_y, marker='o')
                    ax.set_title(title)
                    ax.set_xlabel('Index')
                    ax.set_ylabel('Value')
                    fig.tight_layout()
                    img_buf = io.BytesIO()
                    fig.savefig(img_buf, format='png', bbox_inches='tight')
                    plt.close(fig)
                    img_buf.seek(0)
                    img = ImageReader(img_buf)
                    img_w = letter[0] - 2 * margin
                    img_h = 3 * inch
                    cnv.drawImage(img, margin, y - img_h, width=img_w, height=img_h)
                    y -= img_h + 8
                    plotted = True
                except Exception:
                    plotted = False

        # Render a few key values under the plot (improved layout)
        cnv.setFont('Helvetica', 10)
        if isinstance(res, dict):
            metrics = []
            if 'summary' in res and isinstance(res['summary'], dict):
                for sk, sv in res['summary'].items():
                    metrics.append((sk, normalize_scalar(sv)))
            else:
                for k, v in res.items():
                    if isinstance(v, (int, float, str)) and not isinstance(v, bool):
                        metrics.append((k, normalize_scalar(v)))
                    if len(metrics) >= 8:
                        break

            # Draw metrics in two columns if many
            col_x = [margin, letter[0] / 2 + 10]
            row_h = 14
            row = 0
            for i, (k, v) in enumerate(metrics):
                cx = col_x[i % 2]
                cy = y - (row * row_h)
                cnv.drawString(cx, cy, f"{k}: {v}")
                if i % 2 == 1:
                    row += 1
            y = y - ((row + 1) * row_h)

        # Footer with page number-like info
        cnv.setFont('Helvetica-Oblique', 8)
        cnv.drawRightString(letter[0] - margin, 0.75 * inch, f"Column: {report_data.get('column')} — Analysis: {analysis_name}")
        cnv.showPage()

    cnv.save()
    buffer.seek(0)
    return buffer.getvalue()
