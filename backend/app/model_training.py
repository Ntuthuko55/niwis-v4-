"""Preprocessing and model runners for the NIWIS forecasting workspace."""
from __future__ import annotations

from typing import Any, Dict
import warnings

import numpy as np
import pandas as pd

warnings.filterwarnings("ignore")

# Models that expect daily observations and forecast in days.
_DAILY_PIPELINE_MODELS = frozenset({
    'auto', 'prophet', 'sarimax', 'ets', 'ml', 'state_space', 'garch',
})

# Models trained on monthly aggregates; horizon is expressed in months.
_MONTHLY_MODELS = frozenset({
    'ar', 'ma', 'arma', 'arima', 'sarima', 'prophet',
    'state_space', 'garch', 'lstm', 'transformer',
    'naive', 'historicaverage', 'windowaverage', 'seasonalnaive',
})


def _forecast_horizon_months(steps: int) -> int:
    """Convert UI day-based forecast range to monthly step count."""
    steps = max(1, int(steps))
    if steps <= 60:
        return steps
    return max(1, round(steps / 30.437))


def _forecast_horizon_days(steps: int) -> int:
    """Normalize forecast horizon for the daily pipeline."""
    steps = max(1, int(steps))
    if steps <= 60:
        return max(30, steps * 30)
    return steps


def prepare_training_data(df: pd.DataFrame, config: Dict[str, Any]) -> tuple[pd.DataFrame, list[str]]:
    date_column, target = config['date_column'], config['target']
    group_column = config.get('group_column') or None
    features = config.get('features') or []
    required = [date_column, target] + ([group_column] if group_column else []) + features
    missing = [name for name in required if name not in df.columns]
    if missing:
        raise ValueError(f"Columns not found: {', '.join(missing)}")

    data = df.copy()
    data[date_column] = pd.to_datetime(data[date_column], errors='coerce')
    data = data.dropna(subset=[date_column]).sort_values(([group_column] if group_column else []) + [date_column])
    numeric_cols = data.select_dtypes(include='number').columns.tolist()
    if config.get('missing_strategy') == 'group_linear_bfill_ffill' and numeric_cols:
        if group_column:
            data[numeric_cols] = data.groupby(group_column, group_keys=False)[numeric_cols].transform(
                lambda values: values.interpolate(method='linear').bfill().ffill()
            )
        else:
            data[numeric_cols] = data[numeric_cols].interpolate(method='linear').bfill().ffill()
    data = data.dropna(subset=[target])
    if len(data) < 12:
        raise ValueError('At least 12 valid observations are required to train a time-series model.')
    return data, numeric_cols


def _metrics(actual, predicted) -> Dict[str, float]:
    actual, predicted = np.asarray(actual, dtype=float), np.asarray(predicted, dtype=float)
    return {
        'mae': float(np.mean(np.abs(actual - predicted))),
        'rmse': float(np.sqrt(np.mean((actual - predicted) ** 2))),
        'mape': float(np.mean(np.abs((actual - predicted) / np.maximum(np.abs(actual), 1e-8))) * 100),
    }


def _monthly_series(data: pd.DataFrame, date_column: str, target: str) -> pd.DataFrame:
    series = data[[date_column, target]].copy()
    series[date_column] = pd.to_datetime(series[date_column], errors='coerce')
    series = series.dropna(subset=[date_column, target]).sort_values(date_column)
    if series.empty:
        return series
    monthly = (series.set_index(date_column)[target].resample('ME').mean().dropna().reset_index())
    monthly.columns = [date_column, target]
    return monthly


def _split(data: pd.DataFrame, target: str, test_size: float):
    """Chronological split — never random."""
    test_count = max(2, int(len(data) * min(max(test_size, 0.05), 0.4)))
    train, test = data.iloc[:-test_count], data.iloc[-test_count:]
    if len(train) < 8:
        raise ValueError('Not enough observations remain after the test split.')
    return train, test


def _future_dates(dates: pd.Series, steps: int) -> list[str]:
    """Continue the source time index instead of restarting at an arbitrary date."""
    last_date = pd.to_datetime(dates.iloc[-1])
    frequency = pd.infer_freq(pd.to_datetime(dates).drop_duplicates()) if len(dates) >= 3 else None
    return [value.isoformat() for value in pd.date_range(last_date, periods=steps + 1, freq=frequency or 'D')[1:]]


def _train_prophet_monthly(data: pd.DataFrame, date_column: str, target: str, forecast_steps: int) -> Dict[str, Any]:
    """Run Prophet with the same monthly ``ds`` / ``y`` flow used in the notebook.

    Fitting Prophet on every daily climate record makes the interactive job look
    stuck and is not the workflow used for the project's SPI forecasts.  The
    source is therefore aggregated to one observation per month, held out
    chronologically, evaluated against matching monthly dates, then refit on all
    available months for the requested future horizon.
    """
    from prophet import Prophet

    monthly = _monthly_series(data, date_column, target)
    if len(monthly) < 24:
        raise ValueError('Prophet requires at least 24 monthly observations.')

    horizon = _forecast_horizon_months(forecast_steps)
    test_points = min(max(2, horizon), 12, max(2, len(monthly) // 5))
    small_train = monthly.iloc[:-test_points].copy()
    test = monthly.iloc[-test_points:].copy()

    prophet_train = small_train[[date_column, target]].rename(columns={date_column: 'ds', target: 'y'})
    prophet_test = test[[date_column, target]].rename(columns={date_column: 'ds', target: 'y'})
    prophet_train['ds'] = pd.to_datetime(prophet_train['ds'])
    prophet_test['ds'] = pd.to_datetime(prophet_test['ds'])

    # This deliberately mirrors the user's proven notebook configuration.
    validation_model = Prophet(yearly_seasonality=True)
    validation_model.fit(prophet_train)
    validation_future = validation_model.make_future_dataframe(periods=test_points, freq='ME')
    validation_predictions = validation_model.predict(validation_future)[['ds', 'yhat']].tail(test_points)
    prophet_eval = prophet_test.merge(validation_predictions, on='ds', how='inner')
    if prophet_eval.empty:
        raise ValueError('Prophet validation produced no monthly dates matching the holdout.')
    validation_metrics = _metrics(prophet_eval['y'].to_numpy(), prophet_eval['yhat'].to_numpy())

    # Refit with every observed month before producing the dashboard forecast.
    full_train = monthly[[date_column, target]].rename(columns={date_column: 'ds', target: 'y'})
    full_train['ds'] = pd.to_datetime(full_train['ds'])
    final_model = Prophet(yearly_seasonality=True, interval_width=0.95)
    final_model.fit(full_train)
    future = final_model.make_future_dataframe(periods=horizon, freq='ME')
    forecast = final_model.predict(future).tail(horizon)

    return {
        'model_type': 'prophet',
        'observations': len(monthly),
        'train_observations': len(small_train),
        'test_observations': len(prophet_eval),
        'features_used': ['yearly seasonality'],
        'metrics': validation_metrics,
        'actual': [float(value) for value in prophet_eval['y']],
        'predicted': [float(value) for value in prophet_eval['yhat']],
        'dates': [value.isoformat() for value in prophet_eval['ds']],
        'history_dates': [value.isoformat() for value in full_train['ds']],
        'history_values': [float(value) for value in full_train['y']],
        'forecast_dates': [value.isoformat() for value in forecast['ds']],
        'forecast_values': [float(value) for value in forecast['yhat']],
        'lower_bound': [float(value) for value in forecast['yhat_lower']],
        'upper_bound': [float(value) for value in forecast['yhat_upper']],
        'selected_model': 'prophet',
        'warnings': [],
    }


def _train_lstm_monthly(data: pd.DataFrame, date_column: str, target: str, features: list[str], forecast_steps: int) -> Dict[str, Any]:
    """Multivariate monthly LSTM matching the project's notebook workflow.

    The notebook uses monthly means, MinMax feature/target scalers, a 12-month
    lookback and two LSTM layers (64 then 32) with dropout.  TensorFlow is not a
    dependency of this application; the equivalent architecture below uses the
    installed PyTorch runtime, so the Forecasting Studio stays deployable.
    """
    from sklearn.preprocessing import MinMaxScaler
    import torch
    from torch import nn

    selected_features = list(dict.fromkeys(feature for feature in features if feature != target))
    if not selected_features:
        raise ValueError('LSTM needs at least one input feature. Select the climate features to use with the target.')
    required = [date_column, target, *selected_features]
    missing = [column for column in required if column not in data.columns]
    if missing:
        raise ValueError(f'LSTM feature columns not found: {", ".join(missing)}')

    # Same monthly aggregation as the notebook: numeric monthly means, sorted
    # chronologically, then drop rows where a selected input or target is absent.
    frame = data[required].copy()
    frame[date_column] = pd.to_datetime(frame[date_column], errors='coerce')
    frame = frame.dropna(subset=[date_column]).sort_values(date_column)
    monthly = frame.set_index(date_column)[[target, *selected_features]].resample('ME').mean().dropna().reset_index()
    if len(monthly) < 36:
        raise ValueError(
            f'LSTM needs at least 36 complete monthly observations after feature cleaning; '
            f'only {len(monthly)} were available. Check that the source has a real date '
            'column or year/month fields and that the selected inputs are populated.'
        )

    split_index = int(len(monthly) * 0.80)
    train_data, test_data = monthly.iloc[:split_index].copy(), monthly.iloc[split_index:].copy()
    lookback = 12
    if len(train_data) <= lookback or len(test_data) < 2:
        raise ValueError('Not enough monthly data for a 12-month LSTM lookback and test set.')

    def fit_lstm(x_values: np.ndarray, y_values: np.ndarray):
        """Train 64→32 LSTM with dropout and chronological early stopping."""
        x_seq = np.asarray([x_values[i - lookback:i] for i in range(lookback, len(x_values))], dtype=np.float32)
        y_seq = np.asarray([y_values[i] for i in range(lookback, len(y_values))], dtype=np.float32)
        if len(x_seq) < 12:
            raise ValueError('LSTM has too few training sequences after applying the 12-month lookback.')
        validation_count = max(1, int(len(x_seq) * 0.20))
        train_x, valid_x = x_seq[:-validation_count], x_seq[-validation_count:]
        train_y, valid_y = y_seq[:-validation_count], y_seq[-validation_count:]

        class LSTMNetwork(nn.Module):
            def __init__(self, feature_count: int):
                super().__init__()
                self.lstm_one = nn.LSTM(feature_count, 64, batch_first=True)
                self.dropout_one = nn.Dropout(0.2)
                self.lstm_two = nn.LSTM(64, 32, batch_first=True)
                self.dropout_two = nn.Dropout(0.2)
                self.output = nn.Linear(32, 1)

            def forward(self, values):
                values, _ = self.lstm_one(values)
                values = self.dropout_one(values)
                values, _ = self.lstm_two(values)
                values = self.dropout_two(values[:, -1, :])
                return self.output(values)

        torch.manual_seed(42)
        torch.set_num_threads(1)
        model = LSTMNetwork(x_values.shape[1])
        optimiser = torch.optim.Adam(model.parameters())
        loss_fn = nn.MSELoss()
        train_tensor = torch.tensor(train_x)
        train_target = torch.tensor(train_y).view(-1, 1)
        valid_tensor = torch.tensor(valid_x)
        valid_target = torch.tensor(valid_y).view(-1, 1)
        best_state, best_loss, waiting = None, float('inf'), 0
        for _ in range(100):
            model.train()
            optimiser.zero_grad()
            loss = loss_fn(model(train_tensor), train_target)
            loss.backward()
            optimiser.step()
            model.eval()
            with torch.no_grad():
                val_loss = float(loss_fn(model(valid_tensor), valid_target).item())
            if val_loss < best_loss - 1e-7:
                best_loss, waiting = val_loss, 0
                best_state = {key: value.detach().clone() for key, value in model.state_dict().items()}
            else:
                waiting += 1
                if waiting >= 10:  # identical patience to the notebook
                    break
        if best_state is not None:
            model.load_state_dict(best_state)
        model.eval()
        return model

    feature_scaler, target_scaler = MinMaxScaler(), MinMaxScaler()
    x_train_scaled = feature_scaler.fit_transform(train_data[selected_features])
    x_test_scaled = feature_scaler.transform(test_data[selected_features])
    y_train_scaled = target_scaler.fit_transform(train_data[[target]]).reshape(-1)
    validation_model = fit_lstm(x_train_scaled, y_train_scaled)

    # The test input begins with the final training lookback, exactly as in the
    # notebook. This produces one prediction for every held-out month.
    test_input = np.vstack([x_train_scaled[-lookback:], x_test_scaled])
    x_test = np.asarray([test_input[i - lookback:i] for i in range(lookback, len(test_input))], dtype=np.float32)
    with torch.no_grad():
        y_pred_scaled = validation_model(torch.tensor(x_test)).numpy()
    y_pred = target_scaler.inverse_transform(y_pred_scaled).reshape(-1)
    y_actual = test_data[target].to_numpy(dtype=float)

    # Refit on all known months before a recursive future projection. Future
    # exogenous climate inputs are not known yet, so their latest observed
    # monthly values are held constant; this is explicit rather than silently
    # discarding the feature variables.
    full_x_scaled = feature_scaler.fit_transform(monthly[selected_features])
    full_y_scaled = target_scaler.fit_transform(monthly[[target]]).reshape(-1)
    final_model = fit_lstm(full_x_scaled, full_y_scaled)
    horizon = _forecast_horizon_months(forecast_steps)
    history_features = [row.copy() for row in full_x_scaled]
    future_scaled = []
    with torch.no_grad():
        for _ in range(horizon):
            window = np.asarray(history_features[-lookback:], dtype=np.float32).reshape(1, lookback, len(selected_features))
            prediction = float(final_model(torch.tensor(window)).item())
            future_scaled.append(prediction)
            history_features.append(history_features[-1].copy())
    future_values = target_scaler.inverse_transform(np.asarray(future_scaled).reshape(-1, 1)).reshape(-1)
    residual_scale = max(float(np.std(y_actual - y_pred)), 1e-6)
    spread = 1.96 * residual_scale * np.sqrt(np.arange(1, horizon + 1))
    future_dates = pd.date_range(pd.to_datetime(monthly[date_column].iloc[-1]) + pd.offsets.MonthEnd(1), periods=horizon, freq='ME')

    return {
        'model_type': 'lstm',
        'observations': len(monthly),
        'train_observations': len(train_data),
        'test_observations': len(test_data),
        'features_used': selected_features,
        'metrics': _metrics(y_actual, y_pred),
        'actual': [float(value) for value in y_actual],
        'predicted': [float(value) for value in y_pred],
        'dates': [value.isoformat() for value in test_data[date_column]],
        'history_dates': [value.isoformat() for value in monthly[date_column]],
        'history_values': [float(value) for value in monthly[target]],
        'forecast_dates': [value.isoformat() for value in future_dates],
        'forecast_values': [float(value) for value in future_values],
        'lower_bound': [float(value) for value in future_values - spread],
        'upper_bound': [float(value) for value in future_values + spread],
        'selected_model': 'lstm',
        'warnings': ['Future feature values use the latest observed monthly climate inputs until external future climate scenarios are supplied.'],
    }


def _monthly_model_result(data: pd.DataFrame, date_column: str, target: str, forecast_steps: int, model_type: str) -> Dict[str, Any]:
    """Fit non-Prophet advanced models on monthly provincial series.

    This keeps State Space, GARCH, LSTM and Transformer responsive and makes
    their validation and future projection use the same frequency.  Previously
    these options either entered the generic auto pipeline or used a legacy
    daily path whose future projection did not support the selected method.
    """
    monthly = _monthly_series(data, date_column, target)
    if len(monthly) < 24:
        raise ValueError(f'{model_type} requires at least 24 monthly observations.')

    horizon = _forecast_horizon_months(forecast_steps)
    test_points = min(max(2, horizon), 12, max(2, len(monthly) // 5))
    series = pd.Series(monthly[target].astype(float).to_numpy(), index=pd.to_datetime(monthly[date_column]))
    train, test = series.iloc[:-test_points], series.iloc[-test_points:]

    def state_space(values: pd.Series, steps: int):
        from statsmodels.tsa.statespace.sarimax import SARIMAX
        fit = SARIMAX(
            values.astype(float), order=(1, 1, 1), seasonal_order=(0, 0, 0, 0),
            enforce_stationarity=False, enforce_invertibility=False,
        ).fit(disp=False, maxiter=80)
        result = fit.get_forecast(steps=steps)
        ci = result.conf_int(alpha=0.05)
        lower = np.asarray(ci.iloc[:, 0] if hasattr(ci, 'iloc') else ci[:, 0], dtype=float)
        upper = np.asarray(ci.iloc[:, 1] if hasattr(ci, 'iloc') else ci[:, 1], dtype=float)
        return np.asarray(result.predicted_mean, dtype=float), lower, upper

    def garch(values: pd.Series, steps: int):
        from arch import arch_model
        changes = values.diff().dropna()
        if len(changes) < 20 or changes.std() < 1e-8:
            raise ValueError('GARCH needs variation in at least 20 monthly changes.')
        fit = arch_model(changes, mean='AR', lags=1, vol='GARCH', p=1, q=1, dist='normal', rescale=True).fit(disp='off')
        projection = fit.forecast(horizon=steps, reindex=False)
        mean_changes = np.asarray(projection.mean.iloc[-1], dtype=float)
        variance = np.asarray(projection.variance.iloc[-1], dtype=float)
        values_out = float(values.iloc[-1]) + np.cumsum(mean_changes)
        # Error accumulation gives an honest widening level interval.
        spread = 1.96 * np.sqrt(np.cumsum(np.maximum(variance, 0)))
        return values_out, values_out - spread, values_out + spread

    def sequence(values: pd.Series, steps: int):
        preds = _train_torch_sequence(values.to_numpy(), steps, model_type)
        residual_scale = max(float(values.diff().dropna().std()), 1e-6)
        spread = 1.96 * residual_scale * np.sqrt(np.arange(1, steps + 1))
        return np.asarray(preds, dtype=float), np.asarray(preds, dtype=float) - spread, np.asarray(preds, dtype=float) + spread

    runners = {
        'state_space': state_space,
        'garch': garch,
        'lstm': sequence,
        'transformer': sequence,
    }
    runner = runners[model_type]
    validation_pred, _, _ = runner(train, len(test))
    forecast_values, lower, upper = runner(series, horizon)
    future_dates = pd.date_range(series.index[-1] + pd.offsets.MonthEnd(1), periods=horizon, freq='ME')

    return {
        'model_type': model_type,
        'observations': len(series),
        'train_observations': len(train),
        'test_observations': len(test),
        'features_used': [],
        'metrics': _metrics(test.to_numpy(), validation_pred),
        'actual': [float(value) for value in test],
        'predicted': [float(value) for value in validation_pred],
        'dates': [value.isoformat() for value in test.index],
        'history_dates': [value.isoformat() for value in series.index],
        'history_values': [float(value) for value in series],
        'forecast_dates': [value.isoformat() for value in future_dates],
        'forecast_values': [float(value) for value in forecast_values],
        'lower_bound': [float(value) for value in lower],
        'upper_bound': [float(value) for value in upper],
        'selected_model': model_type,
        'warnings': [],
    }


def _niwis_forecast(data: pd.DataFrame, config: Dict[str, Any], numeric_cols: list[str]) -> Dict[str, Any]:
    """Run the new NIWIS forecasting pipeline."""
    from app.forecasting.forecaster import forecast_time_series

    date_column = config['date_column']
    target = config['target']
    horizon = _forecast_horizon_days(int(config.get('forecast_steps', 365)))

    # Build the raw dataframe for the forecaster
    raw = data[[date_column, target]].copy()
    raw.columns = ['date', 'value']

    from threadpoolctl import threadpool_limits
    with threadpool_limits(limits=1):
        result = forecast_time_series(
            df=raw,
            date_column='date',
            target_column='value',
            horizon=horizon,
            validation_cutoffs=[2021, 2022, 2023, 2024],
            preferred_model=config.get('model_type'),
        )

    # Build future dates from the result
    forecast_dates = result.get('forecast_dates', [])
    forecast_values = result.get('forecast', [])
    lower = result.get('lower_bound')
    upper = result.get('upper_bound')
    history_dates = result.get('history_dates', [])
    history_values = result.get('history_values', [])

    # Out-of-sample validation metrics come from the pipeline's chronological holdout.
    vm = result.get('metrics', {}) or {}
    metrics = {
        'mae': float(vm.get('mae', 0.0) or 0.0),
        'rmse': float(vm.get('rmse', 0.0) or 0.0),
        'r_squared': float(vm.get('r_squared', 0.0) or 0.0),
        'mase': vm.get('mase'),
        'mape': 0.0,
    }

    return {
        'model_type': result.get('model', 'niwis_auto'),
        'observations': len(history_values),
        'train_observations': len(history_values) - horizon,
        'test_observations': horizon,
        'features_used': ['calendar', 'lags', 'rolling'],
        'metrics': metrics,
        'actual': [],
        'predicted': [],
        'dates': history_dates[-min(horizon, len(history_dates)):],
        'history_dates': history_dates,
        'history_values': history_values,
        'forecast_dates': forecast_dates,
        'forecast_values': forecast_values,
        'lower_bound': lower,
        'upper_bound': upper,
        'diagnostics': result.get('diagnostics', {}),
        'validation_results': result.get('validation_results', {}),
        'model_comparison': result.get('model_comparison', {}),
        'warnings': result.get('warnings', []),
        'seasonality_detected': result.get('seasonality_detected', False),
        'comparison_table': result.get('comparison_table', []),
        'forecast_table': result.get('forecast_table', []),
        'selected_model': result.get('model_label', result.get('model', 'auto')),
        'backtest_average': result.get('backtest_average', {}),
    }


def _future_projection(data: pd.DataFrame, config: Dict[str, Any], numeric_cols: list[str]) -> np.ndarray:
    """Fit the selected model on all available observations and project forward."""
    model_type = config['model_type'].lower()

    # Route every univariate model (including legacy AR/ARIMA) through the seasonal
    # pipeline so the forecast cannot collapse to the historical mean.
    if model_type in {'prophet', 'sarimax', 'ets', 'ml', 'auto',
                      'ar', 'ma', 'arma', 'arima', 'sarima', 'state_space', 'garch'}:
        result = _niwis_forecast(data, config, numeric_cols)
        return np.asarray(result['forecast_values'], dtype=float)

    target = config['target']
    steps = int(config.get('forecast_steps', 365))
    y = data[target].astype(float)
    order = tuple(config.get('order', [1, 1, 1]))
    seasonal_order = tuple(config.get('seasonal_order', [1, 0, 1, 12]))
    features = [f for f in config.get('features', []) if f != target and f in numeric_cols]

    if model_type == 'ar':
        from statsmodels.tsa.ar_model import AutoReg
        # WARNING: AutoReg with lags=1 and trend='c' produces flat forecasts
        # because it has no seasonal terms. For daily climate data, this
        # converges toward the historical mean after a few steps.
        return np.asarray(AutoReg(y, lags=max(1, order[0]), trend='c').fit().predict(len(y), len(y) + steps - 1))
    if model_type in {'ma', 'arma', 'arima'}:
        from statsmodels.tsa.arima.model import ARIMA
        fitted_order = (0, 0, max(1, order[2])) if model_type == 'ma' else (max(1, order[0]), 0, max(1, order[2])) if model_type == 'arma' else order
        # WARNING: ARIMA without seasonal_order cannot capture annual cycles.
        # Use 'sarimax' or 'prophet' for daily climate data.
        return np.asarray(ARIMA(y, order=fitted_order).fit().forecast(steps))
    if model_type in {'sarima', 'state_space'}:
        from statsmodels.tsa.statespace.sarimax import SARIMAX
        exog = data[features] if model_type == 'state_space' and features else None
        # WARNING: Default seasonal_order=(1,0,1,12) is for monthly data.
        # For daily data with annual seasonality, use sarimax with Fourier
        # exogenous features instead (handled by the new pipeline).
        fit = SARIMAX(y, exog=exog, order=order, seasonal_order=seasonal_order if model_type == 'sarima' else (0, 0, 0, 0), enforce_stationarity=False).fit(disp=False)
        return np.asarray(fit.forecast(steps, exog=None if exog is None else np.repeat(exog.iloc[[-1]].values, steps, axis=0)))
    if model_type == 'var':
        from statsmodels.tsa.api import VAR
        targets = [target] + features
        # Validate requested target/feature columns exist in the prepared DataFrame
        missing = [c for c in targets if c not in data.columns]
        if missing:
            raise ValueError(f"VAR features not found in input data: {missing}")
        if len(targets) < 2:
            raise ValueError('VAR requires the target plus at least one additional numeric feature.')
        fitted = VAR(data[targets]).fit(maxlags=max(1, order[0]))
        return fitted.forecast(data[targets].values[-fitted.k_ar:], steps)[:, 0]
    if model_type == 'varmax':
        from statsmodels.tsa.statespace.varmax import VARMAX
        targets = [target] + features
        # Validate requested target/feature columns exist in the prepared DataFrame
        missing = [c for c in targets if c not in data.columns]
        if missing:
            raise ValueError(f"VARMAX features not found in input data: {missing}")
        if len(targets) < 2:
            raise ValueError('VARMAX requires the target plus at least one additional numeric feature.')
        return np.asarray(VARMAX(data[targets], order=(max(1, order[0]), max(0, order[2])), trend='c').fit(disp=False, maxiter=100).forecast(steps).iloc[:, 0])
    if model_type == 'prophet':
        from prophet import Prophet
        model_data = data[[config['date_column'], target]].rename(columns={config['date_column']: 'ds', target: 'y'})
        fitted = Prophet().fit(model_data)
        frequency = pd.infer_freq(pd.to_datetime(data[config['date_column']]).drop_duplicates()) if len(data) >= 3 else None
        future = fitted.make_future_dataframe(periods=steps, freq=frequency or 'D', include_history=False)
        return fitted.predict(future)['yhat'].to_numpy()
    if model_type in {'lstm', 'transformer'}:
        return _train_torch_sequence(y.values, steps, model_type)
    if model_type == 'garch':
        from arch import arch_model
        diffs = y.diff().dropna()
        if len(diffs) < 10 or diffs.std() < 1e-8:
            return np.full(steps, float(y.iloc[-1]))
        try:
            fit = arch_model(diffs, vol='Garch', p=max(1, order[0]), q=max(1, order[2]), rescale=True).fit(disp='off')
            vol = np.sqrt(fit.forecast(horizon=steps).variance.iloc[-1].values)
            return np.full(steps, float(y.iloc[-1])) + vol
        except Exception:
            return np.full(steps, float(y.iloc[-1]))
    raise ValueError('Future projection is not supported for this model type.')


def _train_multivariate_monthly(data: pd.DataFrame, config: Dict[str, Any]) -> Dict[str, Any]:
    """Fit multivariate models on scaled monthly climate inputs."""
    from statsmodels.tsa.api import VAR
    from statsmodels.tsa.statespace.varmax import VARMAX

    target, date_column = config['target'], config['date_column']
    model_type = config['model_type'].lower()
    features = list(dict.fromkeys(f for f in config.get('features', []) if f != target))
    monthly = data.set_index(date_column)[[target, *features]].resample('ME').mean().dropna()
    if len(monthly) < 36:
        raise ValueError(f'{model_type.upper()} requires at least 36 complete monthly observations.')
    split = int(len(monthly) * .8)
    train, test = monthly.iloc[:split], monthly.iloc[split:]
    usable = [f for f in features if train[f].std() > 1e-8]
    if not usable:
        raise ValueError(f'{model_type.upper()} requires at least one input feature that varies over time.')
    if train[target].std() <= 1e-8:
        raise ValueError('The selected target is constant; choose a target that varies over time.')
    columns = [target, *usable]
    order = config.get('order', [1, 1, 1])

    def project(frame, steps):
        mean, scale = frame[columns].mean(), frame[columns].std()
        scaled = (frame[columns] - mean) / scale
        if model_type == 'var':
            fit = VAR(scaled).fit(maxlags=max(1, min(order[0], len(frame) // 10)))
            predicted = fit.forecast(scaled.values[-fit.k_ar:], steps)[:, 0]
        else:
            fit = VARMAX(scaled, order=(max(1, order[0]), max(0, order[2])), trend='c').fit(disp=False, maxiter=50)
            predicted = fit.forecast(steps).iloc[:, 0].to_numpy()
        return np.asarray(predicted) * scale[target] + mean[target]

    from threadpoolctl import threadpool_limits
    horizon = _forecast_horizon_months(config.get('forecast_steps', 365))
    # Small state-space matrices run faster without BLAS thread oversubscription.
    with threadpool_limits(limits=1):
        prediction = project(train, len(test))
        future = project(monthly, horizon)
    dates = pd.date_range(monthly.index[-1] + pd.offsets.MonthEnd(1), periods=horizon, freq='ME')
    omitted = [f for f in features if f not in usable]
    return {
        'model_type': model_type, 'selected_model': model_type,
        'observations': len(monthly), 'train_observations': len(train), 'test_observations': len(test),
        'features_used': usable, 'metrics': _metrics(test[target], prediction),
        'actual': test[target].tolist(), 'predicted': prediction.tolist(),
        'dates': [d.isoformat() for d in test.index],
        'history_dates': [d.isoformat() for d in monthly.index], 'history_values': monthly[target].tolist(),
        'forecast_dates': [d.isoformat() for d in dates], 'forecast_values': future.tolist(),
        'warnings': [f'Excluded constant inputs: {", ".join(omitted)}.'] if omitted else [],
    }


def train_model(df: pd.DataFrame, config: Dict[str, Any]) -> Dict[str, Any]:
    """Train a forecasting model and return results."""
    data, numeric_cols = prepare_training_data(df, config)
    model_type = config['model_type'].lower()
    target = config['target']
    date_column = config['date_column']

    if model_type in {'var', 'varmax'}:
        return _train_multivariate_monthly(data, config)

    # LSTM keeps the selected feature columns through monthly aggregation; it
    # must run before the univariate monthly-preparation branch below.
    if model_type == 'lstm':
        return _train_lstm_monthly(data, date_column, target, config.get('features', []), config.get('forecast_steps', 365))

    # Keep daily resolution for the NIWIS daily pipeline; aggregate to monthly only
    # for classical monthly models (SARIMA, naive baselines, etc.).
    if (
        model_type in _MONTHLY_MODELS
        and len(data) >= 30
        and (pd.api.types.is_numeric_dtype(data[target]) or target in data.columns)
    ):
        monthly = _monthly_series(data, date_column, target)
        if len(monthly) >= 12:
            data = monthly
            date_column = data.columns[0]
            target = data.columns[1]

    if model_type == 'prophet':
        return _train_prophet_monthly(data, date_column, target, config.get('forecast_steps', 365))

    if model_type in {'state_space', 'garch', 'lstm', 'transformer'}:
        return _monthly_model_result(data, date_column, target, config.get('forecast_steps', 365), model_type)

    if model_type in {'auto', 'sarimax', 'ets', 'ml',
                      'ar', 'ma', 'arma', 'arima', 'sarima'}:
        if model_type in {'ar', 'ma', 'arma', 'arima', 'sarima'}:
            from app.forecasting.kzn_pipeline import (
                naive_forecast,
                historic_average_forecast,
                window_average_forecast,
                seasonal_naive,
                ar_forecast,
                ma_forecast,
                arma_forecast,
                arima_forecast,
                sarima_forecast,
            )

            horizon = _forecast_horizon_months(config.get('forecast_steps', 365))
            series = pd.Series(data[target].astype(float).to_numpy(), index=pd.to_datetime(data[date_column]))
            if model_type == 'ar':
                forecast_values = ar_forecast(series, horizon)
            elif model_type == 'ma':
                forecast_values = ma_forecast(series, horizon)
            elif model_type == 'arma':
                forecast_values = arma_forecast(series, horizon)
            elif model_type == 'arima':
                forecast_values = arima_forecast(series, horizon)
            elif model_type == 'sarima':
                forecast_values = sarima_forecast(series, horizon, seasonal_period=12)
            else:
                forecast_values = naive_forecast(series, horizon)

            test_points = min(12, max(2, len(series) // 5))
            train_series = series.iloc[:-test_points]
            test_series = series.iloc[-test_points:]
            if model_type == 'ar':
                holdout_pred = ar_forecast(train_series, len(test_series))
            elif model_type == 'ma':
                holdout_pred = ma_forecast(train_series, len(test_series))
            elif model_type == 'arma':
                holdout_pred = arma_forecast(train_series, len(test_series))
            elif model_type == 'arima':
                holdout_pred = arima_forecast(train_series, len(test_series))
            elif model_type == 'sarima':
                holdout_pred = sarima_forecast(train_series, len(test_series), seasonal_period=12)
            else:
                holdout_pred = naive_forecast(train_series, len(test_series))

            full_dates = pd.date_range(series.index.min(), periods=len(series), freq='ME')
            future_dates = pd.date_range(series.index.max() + pd.offsets.MonthEnd(1), periods=horizon, freq='ME')
            return {
                'model_type': model_type,
                'observations': len(series),
                'train_observations': len(train_series),
                'test_observations': len(test_series),
                'features_used': [],
                'metrics': _metrics(test_series.values, holdout_pred),
                'actual': [float(v) for v in test_series.values],
                'predicted': [float(v) for v in np.asarray(holdout_pred)],
                'dates': [value.isoformat() for value in test_series.index],
                'history_dates': [value.isoformat() for value in series.index],
                'history_values': [float(value) for value in series.values],
                'forecast_dates': [value.isoformat() for value in future_dates],
                'forecast_values': [float(value) for value in np.asarray(forecast_values)],
                'lower_bound': None,
                'upper_bound': None,
                'selected_model': model_type,
            }
        return _niwis_forecast(data, config, numeric_cols)

    if model_type in {'naive', 'historicaverage', 'windowaverage', 'seasonalnaive'}:
        from app.forecasting.kzn_pipeline import (
            naive_forecast,
            historic_average_forecast,
            window_average_forecast,
            seasonal_naive,
        )
        horizon = _forecast_horizon_months(config.get('forecast_steps', 365))
        series = pd.Series(data[target].astype(float).to_numpy(), index=pd.to_datetime(data[date_column]))
        if model_type == 'naive':
            forecast_values = naive_forecast(series, horizon)
        elif model_type == 'historicaverage':
            forecast_values = historic_average_forecast(series, horizon)
        elif model_type == 'windowaverage':
            forecast_values = window_average_forecast(series, horizon, window=12)
        else:
            forecast_values = seasonal_naive(series, horizon, seasonal_period=12)

        test_points = min(12, max(2, len(series) // 5))
        train_series = series.iloc[:-test_points]
        test_series = series.iloc[-test_points:]
        if model_type == 'naive':
            holdout_pred = naive_forecast(train_series, len(test_series))
        elif model_type == 'historicaverage':
            holdout_pred = historic_average_forecast(train_series, len(test_series))
        elif model_type == 'windowaverage':
            holdout_pred = window_average_forecast(train_series, len(test_series), window=12)
        else:
            holdout_pred = seasonal_naive(train_series, len(test_series), seasonal_period=12)

        future_dates = pd.date_range(series.index.max() + pd.offsets.MonthEnd(1), periods=horizon, freq='ME')
        return {
            'model_type': model_type,
            'observations': len(series),
            'train_observations': len(train_series),
            'test_observations': len(test_series),
            'features_used': [],
            'metrics': _metrics(test_series.values, holdout_pred),
            'actual': [float(v) for v in test_series.values],
            'predicted': [float(v) for v in np.asarray(holdout_pred)],
            'dates': [value.isoformat() for value in test_series.index],
            'history_dates': [value.isoformat() for value in series.index],
            'history_values': [float(value) for value in series.values],
            'forecast_dates': [value.isoformat() for value in future_dates],
            'forecast_values': [float(value) for value in np.asarray(forecast_values)],
            'lower_bound': None,
            'upper_bound': None,
            'selected_model': model_type,
        }

    # Legacy model path for backward compatibility
    train, test = _split(data, target, config.get('test_size', .2))
    y_train, y_test = train[target].astype(float), test[target].astype(float)
    order = tuple(config.get('order', [1, 1, 1]))
    seasonal_order = tuple(config.get('seasonal_order', [1, 0, 1, 12]))
    features = [f for f in config.get('features', []) if f != target and f in numeric_cols]

    if model_type in {'ar', 'ma', 'arma', 'arima', 'sarima', 'state_space'}:
        from statsmodels.tsa.ar_model import AutoReg
        from statsmodels.tsa.arima.model import ARIMA
        from statsmodels.tsa.statespace.sarimax import SARIMAX
        if model_type == 'ar':
            fit = AutoReg(y_train, lags=max(1, order[0]), trend='c').fit()
            prediction = fit.predict(len(y_train), len(y_train) + len(y_test) - 1)
        elif model_type == 'ma':
            fit = ARIMA(y_train, order=(0, 0, max(1, order[2]))).fit()
            prediction = fit.forecast(len(y_test))
        elif model_type == 'arma':
            fit = ARIMA(y_train, order=(max(1, order[0]), 0, max(1, order[2]))).fit()
            prediction = fit.forecast(len(y_test))
        elif model_type == 'sarima':
            fit = SARIMAX(y_train, order=order, seasonal_order=seasonal_order, enforce_stationarity=False).fit(disp=False)
            prediction = fit.forecast(len(y_test))
        elif model_type == 'state_space':
            exog_train = train[features] if features else None
            exog_test = test[features] if features else None
            fit = SARIMAX(y_train, exog=exog_train, order=order, seasonal_order=(0, 0, 0, 0), enforce_stationarity=False).fit(disp=False)
            prediction = fit.forecast(len(y_test), exog=exog_test)
        else:
            fit = ARIMA(y_train, order=order).fit()
            prediction = fit.forecast(len(y_test))
    elif model_type == 'var':
        from statsmodels.tsa.api import VAR
        targets = [target] + [x for x in features if x in numeric_cols]
        if len(targets) < 2:
            available_extra = [c for c in numeric_cols if c != target and c in train.columns]
            if available_extra:
                targets = [target, available_extra[0]]
            else:
                raise ValueError('VAR needs the target plus at least one additional numeric feature.')
        fit = VAR(train[targets]).fit(maxlags=max(1, min(order[0], len(train) // 10)))
        prediction = fit.forecast(train[targets].values[-fit.k_ar:], len(test))[:, 0]
    elif model_type == 'varmax':
        from statsmodels.tsa.statespace.varmax import VARMAX
        targets = [target] + [x for x in features if x in numeric_cols]
        if len(targets) < 2:
            available_extra = [c for c in numeric_cols if c != target and c in train.columns]
            if available_extra:
                targets = [target, available_extra[0]]
            else:
                raise ValueError('VARMAX needs the target plus at least one additional numeric feature.')
        fit = VARMAX(train[targets], order=(max(1, order[0]), max(0, order[2])), trend='c').fit(disp=False, maxiter=50)
        prediction = fit.forecast(len(test)).iloc[:, 0]
    elif model_type == 'garch':
        from arch import arch_model
        diffs = y_train.diff().dropna()
        if len(diffs) < 10 or diffs.std() < 1e-8:
            prediction = np.full(len(y_test), float(y_train.iloc[-1]))
        else:
            try:
                fit = arch_model(diffs, vol='Garch', p=max(1, order[0]), q=max(1, order[2]), rescale=True).fit(disp='off')
                prediction = np.repeat(float(np.sqrt(fit.forecast(horizon=1).variance.iloc[-1, 0])), len(y_test))
            except Exception:
                prediction = np.full(len(y_test), float(y_train.iloc[-1]))
    elif model_type == 'prophet':
        from prophet import Prophet
        model_data = train[[date_column, target]].rename(columns={date_column: 'ds', target: 'y'})
        fit = Prophet().fit(model_data)
        future = pd.DataFrame({'ds': test[date_column]})
        prediction = fit.predict(future)['yhat'].values
    elif model_type in {'lstm', 'transformer'}:
        prediction = _train_torch_sequence(y_train.values, len(y_test), model_type)
    else:
        raise ValueError('Unsupported model type.')

    future_values = _future_projection(data, config, numeric_cols)
    future_dates = _future_dates(data[date_column], len(future_values))
    return {
        'model_type': model_type,
        'observations': len(data),
        'train_observations': len(train),
        'test_observations': len(test),
        'features_used': features,
        'metrics': _metrics(y_test.values, prediction),
        'actual': [float(v) for v in y_test.values],
        'predicted': [float(v) for v in np.asarray(prediction)],
        'dates': [value.isoformat() for value in test[date_column]],
        'history_dates': [value.isoformat() for value in data[date_column]],
        'history_values': [float(value) for value in data[target]],
        'forecast_dates': future_dates,
        'forecast_values': [float(value) for value in future_values],
    }


def _train_torch_sequence(values, test_length: int, model_type: str):
    import torch
    from torch import nn
    values = np.asarray(values, dtype=np.float32)
    mean, std = float(values.mean()), max(float(values.std()), 1e-6)
    scaled = (values - mean) / std
    window = min(12, max(3, len(scaled) // 5))
    if len(scaled) <= window:
        return np.full(test_length, mean)
    inputs = torch.tensor([scaled[i:i + window] for i in range(len(scaled) - window)], dtype=torch.float32).unsqueeze(-1)
    labels = torch.tensor(scaled[window:], dtype=torch.float32).unsqueeze(-1)
    if model_type == 'lstm':
        class Network(nn.Module):
            def __init__(self):
                super().__init__()
                self.layer = nn.LSTM(1, 24, batch_first=True)
                self.out = nn.Linear(24, 1)
            def forward(self, x):
                return self.out(self.layer(x)[0][:, -1, :])
    else:
        class Network(nn.Module):
            def __init__(self):
                super().__init__()
                self.embed = nn.Linear(1, 24)
                self.encoder = nn.TransformerEncoder(nn.TransformerEncoderLayer(24, 4, batch_first=True), 1)
                self.out = nn.Linear(24, 1)
            def forward(self, x):
                return self.out(self.encoder(self.embed(x))[:, -1, :])
    network = Network()
    optimizer = torch.optim.Adam(network.parameters(), lr=.01)
    for _ in range(30):
        optimizer.zero_grad()
        loss = nn.MSELoss()(network(inputs), labels)
        loss.backward()
        optimizer.step()
    history = list(scaled[-window:])
    output = []
    network.eval()
    with torch.no_grad():
        for _ in range(test_length):
            x_in = torch.tensor(history[-window:], dtype=torch.float32).view(1, window, 1)
            value = float(network(x_in).item())
            output.append(value)
            history.append(value)
    return np.asarray(output) * std + mean
