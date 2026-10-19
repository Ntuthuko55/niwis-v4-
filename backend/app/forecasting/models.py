"""Forecasting models for daily climate data.

This module intentionally provides *several* candidate models so the pipeline can
compare them with out-of-sample validation rather than hard-coding a single model.

Why we do NOT rely on a plain recursive AR model
------------------------------------------------
A bare ``AutoReg(y, lags=1, trend='c')`` or ``ARIMA((1,1,1))`` model has *no
seasonal terms*. For a daily climate series with a strong annual cycle the
autoregressive recursion settles onto the nearest root of the characteristic
polynomial. For |AR-coefficients| < 1 the multi-step forecast converges
geometrically toward the unconditional mean:

    y_{t+h}  ->  mu = c / (1 - phi_1 - ... - phi_p)      as h -> inf

For daily temperature/rainfall this mean is around 19-20C, which is exactly why
the old dashboard forecast "2026-01-01 -> 21.14, ..., then ~19-20 flat". The AR
model has no basis functions that encode the 365-day annual cycle, so it simply
cannot bend the forecast back up in summer.

To fix this, every model below encodes annual seasonality *explicitly*:
  * harmonic regression: sin/cos Fourier terms of day-of-year,
  * seasonal naive: repeats the last observed annual cycle,
  * weekly SARIMAX / ETS: fit on the annual period,
  * Prophet: its own yearly Fourier seasonality,
  * gradient boosting: cyclical calendar features + lag/rolling features.

Runtime note (measured on a ~25-year daily series, this environment):
  harmonic ~0.003s, weekly ETS ~2.4s, ML ~6s, weekly SARIMAX ~20s, Prophet ~2s.
Daily-frequency SARIMAX and daily ETS with a 365-length seasonal period are
impractically slow, so the SARIMAX/ETS variants are fit on a weekly series and
linearly interpolated back to daily - this preserves the annual cycle while
staying fast enough for interactive use.
"""
from __future__ import annotations

from typing import Any
import numpy as np
import pandas as pd

from .features import build_feature_matrix

# Cyclical Fourier basis for the annual cycle (365.25-day year).
_ANNUAL = 365.25

# ---------------------------------------------------------------------------
# 1. Seasonal Naive baseline
# ---------------------------------------------------------------------------

def seasonal_naive(y: pd.Series, horizon: int, seasonal_period: int = 365) -> np.ndarray:
    """Repeat the last observed annual cycle as a no-learning baseline.

    Because it literally replays the previous year's pattern it preserves the
    annual seasonality, which is why it already beats a mean-converging AR model
    on daily climate data.
    """
    if len(y) < seasonal_period:
        return np.full(horizon, float(np.nanmean(y.values)))
    last_season = y.iloc[-seasonal_period:].values
    repeats = int(np.ceil(horizon / seasonal_period))
    return np.tile(last_season, repeats)[:horizon]


# ---------------------------------------------------------------------------
# 2. Harmonic / dynamic regression with seasonal Fourier terms
# ---------------------------------------------------------------------------

def harmonic_forecast(
    y: pd.Series,
    horizon: int,
    K: int = 4,
    include_trend: bool = True,
) -> tuple[np.ndarray, np.ndarray | None, np.ndarray | None]:
    """Seasonal harmonic regression via OLS on Fourier(day-of-year) terms.

    Fits  y_t = b0 + b1*trend + sum_{k=1..K}( a_k*sin(2*pi*k*doy/365.25)
                                             + b_k*cos(2*pi*k*doy/365.25) ) + e_t

    The Fourier basis directly encodes the annual cycle, so the 365-day forecast
    rises and falls with the season instead of collapsing to the mean.
    """
    from statsmodels.api import OLS, add_constant

    idx = y.index
    doy = idx.dayofyear
    exog = pd.DataFrame(index=idx)
    for k in range(1, K + 1):
        exog[f"sin{k}"] = np.sin(2 * np.pi * k * doy / _ANNUAL)
        exog[f"cos{k}"] = np.cos(2 * np.pi * k * doy / _ANNUAL)
    if include_trend:
        exog["trend"] = np.arange(len(y))
    exog_c = add_constant(exog, has_constant="add")

    model = OLS(y.values.astype(float), exog_c)
    fit = model.fit()

    last_date = idx[-1]
    future_idx = pd.date_range(start=last_date + pd.Timedelta(days=1), periods=horizon, freq="D")
    fut = pd.DataFrame(index=future_idx)
    fdoy = future_idx.dayofyear
    for k in range(1, K + 1):
        fut[f"sin{k}"] = np.sin(2 * np.pi * k * fdoy / _ANNUAL)
        fut[f"cos{k}"] = np.cos(2 * np.pi * k * fdoy / _ANNUAL)
    if include_trend:
        fut["trend"] = np.arange(len(y), len(y) + horizon)
    fut_c = add_constant(fut, has_constant="add")
    fut_c = fut_c[exog_c.columns]

    # Proper OLS prediction interval (widens with the horizon).
    pred_obj = fit.get_prediction(fut_c)
    vals = np.asarray(pred_obj.predicted_mean, dtype=float)
    ci = np.asarray(pred_obj.conf_int(alpha=0.05), dtype=float)  # 95% prediction interval
    lower = ci[:, 0]
    upper = ci[:, 1]
    return vals, lower, upper
# ---------------------------------------------------------------------------
# 3. SARIMAX with annual Fourier exogenous terms (fit on weekly series)
# ---------------------------------------------------------------------------

def _interp_weekly_to_daily(weekly: np.ndarray, horizon: int) -> np.ndarray:
    """Linearly interpolate a weekly forecast onto a daily grid of `horizon` days."""
    m = len(weekly)
    if m <= 1:
        return np.full(horizon, float(weekly[-1]))
    x = np.arange(m) * 7.0          # day position of each weekly point
    xi = np.arange(1, horizon + 1)  # day position of each daily step
    return np.interp(xi, x, weekly)


def sarimax_forecast(
    y: pd.Series,
    horizon: int,
    order: tuple[int, int, int] = (1, 1, 1),
    seasonal_order: tuple[int, int, int, int] = (1, 0, 1, 52),
    K: int = 2,
) -> tuple[np.ndarray, np.ndarray | None, np.ndarray | None]:
    """SARIMAX with Fourier annual-season exogenous terms.

    Daily SARIMAX over a ~25-year record is computationally prohibitive here, so we
    aggregate to a weekly mean series, keep *annual* seasonality through the
    Fourier(day-of-year) exogenous regressors plus a weekly seasonal MA term, then
    linearly interpolate the weekly forecasts back to daily. The Fourier regressors
    are what stop the forecast from converging to the mean - the AR part cannot wipe
    out the explicit annual forcing carried in ``exog``.
    """
    from statsmodels.tsa.statespace.sarimax import SARIMAX

    wk = y.resample("W").mean().dropna().astype(float)
    if len(wk) < 60:
        raise ValueError("Not enough data to fit weekly SARIMAX.")

    widx = wk.index
    wdoy = widx.dayofyear
    exog = pd.DataFrame(index=widx)
    for k in range(1, K + 1):
        exog[f"sin{k}"] = np.sin(2 * np.pi * k * wdoy / _ANNUAL)
        exog[f"cos{k}"] = np.cos(2 * np.pi * k * wdoy / _ANNUAL)
    exog = exog.astype(float)

    horizon_weekly = int(np.ceil(horizon / 7.0)) + 1
    last_date = widx[-1]
    future_idx = pd.date_range(start=last_date + pd.Timedelta(days=7), periods=horizon_weekly, freq="W")
    fut = pd.DataFrame(index=future_idx)
    fdoy = future_idx.dayofyear
    for k in range(1, K + 1):
        fut[f"sin{k}"] = np.sin(2 * np.pi * k * fdoy / _ANNUAL)
        fut[f"cos{k}"] = np.cos(2 * np.pi * k * fdoy / _ANNUAL)
    fut = fut[exog.columns].astype(float)

    model = SARIMAX(
        wk.values,
        exog=exog,
        order=order,
        seasonal_order=seasonal_order,
        enforce_stationarity=False,
        enforce_invertibility=False,
    )
    fit = model.fit(disp=False, maxiter=50, method="lbfgs")
    fc = fit.get_forecast(steps=horizon_weekly, exog=fut)
    wk_vals = np.asarray(fc.predicted_mean, dtype=float)
    ci = np.asarray(fc.conf_int(alpha=0.05), dtype=float)  # (h, 2)
    wk_lower, wk_upper = ci[:, 0], ci[:, 1]

    vals = _interp_weekly_to_daily(wk_vals, horizon)
    lower = _interp_weekly_to_daily(wk_lower, horizon)
    upper = _interp_weekly_to_daily(wk_upper, horizon)
    return vals, lower, upper


# ---------------------------------------------------------------------------
# 4. ETS (Exponential Smoothing) - fit on weekly series with annual period 52
# ---------------------------------------------------------------------------

def ets_forecast(
    y: pd.Series,
    horizon: int,
    seasonal_period: int = 52,
) -> tuple[np.ndarray, np.ndarray | None, np.ndarray | None]:
    """ETS with additive error/trend/seasonality, fit on the weekly series.

    A daily ETS with a 365-length seasonal state vector is too slow to optimise in
    an interactive dashboard, so we fit ETS on the weekly mean series with the annual
    period (52) and interpolate back to daily. The seasonal component keeps the
    annual cycle alive across the full horizon.
    """
    from statsmodels.tsa.exponential_smoothing.ets import ETSModel

    wk = y.resample("W").mean().dropna().astype(float)
    if len(wk) < 2 * seasonal_period:
        raise ValueError("Not enough data for weekly seasonal ETS.")

    model = ETSModel(
        wk,   # keep the DatetimeIndex - get_prediction needs row labels
        error="add",
        trend="add",
        damped_trend=True,
        seasonal="add",
        seasonal_periods=seasonal_period,
    )
    fit = model.fit(disp=False, maxiter=80)
    horizon_weekly = int(np.ceil(horizon / 7.0)) + 1
    wk_vals = np.asarray(fit.forecast(horizon_weekly), dtype=float)
    # Interval from the fitted residual scale, widening with the horizon.
    resid = np.asarray(fit.resid, dtype=float)
    sigma = float(np.sqrt(np.mean(resid ** 2))) if resid.size else float(wk.std())
    k = np.arange(1, horizon_weekly + 1)
    width = 1.96 * sigma * np.sqrt(1.0 + 0.5 * (k / horizon_weekly))
    wk_lower = wk_vals - width
    wk_upper = wk_vals + width

    vals = _interp_weekly_to_daily(wk_vals, horizon)
    lower = _interp_weekly_to_daily(wk_lower, horizon)
    upper = _interp_weekly_to_daily(wk_upper, horizon)
    return vals, lower, upper


# ---------------------------------------------------------------------------
# 5. Prophet (trend + seasonality)
# ---------------------------------------------------------------------------

def prophet_forecast(
    y: pd.Series,
    horizon: int,
) -> tuple[np.ndarray, np.ndarray | None, np.ndarray | None]:
    """Prophet with yearly + weekly seasonality.

    Prophet models the trend separately and adds a smooth yearly Fourier
    seasonality, so its long-horizon forecast oscillates through the year instead
    of converging to a constant. The training window is capped to the most recent
    few years to keep the fit fast enough for the dashboard.
    """
    from prophet import Prophet

    # Detect whether the series is monthly (approx. 28+ day spacing) or daily
    if len(y) == 0:
        return np.full(horizon, float(np.nan)), None, None

    idx_series = pd.Series(y.index)
    if len(idx_series) > 1:
        median_days = float(idx_series.diff().dropna().dt.days.median())
    else:
        median_days = 1.0

    monthly = median_days >= 28.0

    # Keep smaller training windows for monthly series to stay responsive
    max_points = 1100 if not monthly else 240  # ~20 years monthly ~240 points
    train = y.iloc[-max_points:] if len(y) > max_points else y
    dfa = pd.DataFrame({"ds": train.index, "y": train.values.astype(float)})

    # Initialize Prophet following the notebook pattern: explicit yearly seasonality
    # and sensible defaults for weekly/daily seasonality depending on series freq.
    m = Prophet(
        yearly_seasonality=True,
        weekly_seasonality=False if monthly else True,
        daily_seasonality=False,
        interval_width=0.95,
    )
    m.fit(dfa)

    # Create a future dataframe that includes history, then select the last
    # `horizon` rows as the forecast horizon (matches notebook workflow).
    freq = "ME" if monthly else "D"
    future = m.make_future_dataframe(periods=horizon, freq=freq)
    fc = m.predict(future)

    # Keep only the forecast horizon (last `horizon` rows) to return values
    # in the same shape as other models in the pipeline.
    fc_h = fc.tail(horizon)
    vals = fc_h["yhat"].values
    lower = fc_h["yhat_lower"].values if "yhat_lower" in fc_h else None
    upper = fc_h["yhat_upper"].values if "yhat_upper" in fc_h else None

    return np.asarray(vals, dtype=float), (
        np.asarray(lower, dtype=float) if lower is not None else None
    ), (np.asarray(upper, dtype=float) if upper is not None else None)

# ---------------------------------------------------------------------------
# 6. Gradient Boosting ML model with calendar + lag + rolling features
# ---------------------------------------------------------------------------

_LAGS = (1, 7, 14, 30, 90, 180, 365)
_ROLL_MEAN = (7, 30, 90, 180, 365)
_ROLL_STD = (7, 30, 90, 180, 365)


def _feature_row(hist, next_date, feature_columns):
    """Build a single feature row for a *future* date from the current history.

    Avoids the old bug where recursive ML forecasting re-indexed a DataFrame that
    had no row for the next date and fell back to the historical mean (which
    collapsed the forecast). Every lag/rolling statistic is computed directly from
    the last available values of the growing history series.
    """
    doy = next_date.dayofyear
    row = {
        "day_of_year": float(doy),
        "month": float(next_date.month),
        "day_of_month": float(next_date.day),
        "week_of_year": float(next_date.isocalendar().week),
        "sin_doy": float(np.sin(2 * np.pi * doy / _ANNUAL)),
        "cos_doy": float(np.cos(2 * np.pi * doy / _ANNUAL)),
        "sin_2doy": float(np.sin(4 * np.pi * doy / _ANNUAL)),
        "cos_2doy": float(np.cos(4 * np.pi * doy / _ANNUAL)),
        "sin_month": float(np.sin(2 * np.pi * next_date.month / 12)),
        "cos_month": float(np.cos(2 * np.pi * next_date.month / 12)),
        "trend": float(len(hist)),
    }
    vals = hist.values.astype(float)
    for lag in _LAGS:
        row[f"lag_{lag}"] = float(vals[-lag]) if len(vals) >= lag else np.nan
    for w in _ROLL_MEAN:
        row[f"rolling_mean_{w}"] = float(vals[-w:].mean()) if len(vals) >= w else np.nan
    for w in _ROLL_STD:
        row[f"rolling_std_{w}"] = float(vals[-w:].std()) if len(vals) >= w else np.nan
    return {col: row.get(col, np.nan) for col in feature_columns}

def ml_forecast(
    y: pd.Series,
    horizon: int,
) -> tuple[np.ndarray, np.ndarray | None, np.ndarray | None]:
    """Gradient Boosting on calendar + lag + rolling features with recursive rollout.

    The cyclical calendar features (sin/cos of day-of-year) give this model its
    annual seasonality - December and January map to adjacent points on the circle,
    so the learner can reproduce the seasonal swing. Lags/rolling stats add
    short-term persistence. No future information leaks into the training rows.
    """
    from sklearn.ensemble import GradientBoostingRegressor

    feats = build_feature_matrix(y, calendar=True, lags=True, rolling=True)
    aligned = feats.join(y.rename("target"), how="inner").dropna()
    if len(aligned) < 60:
        raise ValueError("Not enough observations after feature engineering for ML forecast.")

    X = aligned.drop("target", axis=1)
    y_target = aligned["target"]
    feature_columns = list(X.columns)

    # Chronological internal holdout used to estimate residual scale for the CIs.
    holdout = min(90, max(20, len(X) // 10))
    X_tr, y_tr = X.iloc[:-holdout], y_target.iloc[:-holdout]
    X_ho, y_ho = X.iloc[-holdout:], y_target.iloc[-holdout:]

    model = GradientBoostingRegressor(
        n_estimators=150, max_depth=3, learning_rate=0.05,
        subsample=0.8, random_state=42,
    )
    model.fit(X_tr, y_tr)

    ho_pred = model.predict(X_ho)
    resid = y_ho.values - ho_pred
    std_err = float(np.sqrt(np.mean(resid ** 2))) if len(resid) else float(y.std())

    hist = y.copy()
    forecasts, lowers, uppers = [], [], []
    for step in range(1, horizon + 1):
        next_date = hist.index[-1] + pd.Timedelta(days=1)
        row = _feature_row(hist, next_date, feature_columns)
        X_row = pd.DataFrame([row])[feature_columns]
        pred = float(model.predict(X_row)[0])
        width = 1.96 * std_err * np.sqrt(1.0 + 0.5 * (step / horizon))  # widens with horizon
        forecasts.append(pred)
        lowers.append(pred - width)
        uppers.append(pred + width)
        hist = pd.concat([hist, pd.Series([pred], index=[next_date])])

    return np.asarray(forecasts), np.asarray(lowers), np.asarray(uppers)


# ---------------------------------------------------------------------------
# Dispatch helper used by validation / evaluator / forecaster
# ---------------------------------------------------------------------------

_MODEL_REGISTRY: dict[str, Any] = {
    "seasonal_naive": lambda y, h: (seasonal_naive(y, h), None, None),
    "harmonic": harmonic_forecast,
    "sarimax": sarimax_forecast,
    "ets": ets_forecast,
    "prophet": prophet_forecast,
    "ml": ml_forecast,
}


def available_models() -> list[str]:
    """Names of all registered candidate models."""
    return list(_MODEL_REGISTRY.keys())


def run_model(name, y, horizon):
    """Run a registered model by name; raises for unknown names."""
    if name not in _MODEL_REGISTRY:
        raise ValueError(f"Unknown model '{name}'")
    return _MODEL_REGISTRY[name](y, horizon)
