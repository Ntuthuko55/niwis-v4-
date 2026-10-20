import time

import numpy as np
import pandas as pd

from app.forecasting.kzn_pipeline import sarima_forecast


def test_sarima_forecast_completes_for_daily_series():
    dates = pd.date_range('2015-01-01', periods=365 * 6, freq='D')
    steps = np.arange(len(dates), dtype=float)
    series = pd.Series(3. + np.sin(steps * 2 * np.pi / 365.25) + .2 * np.cos(steps / 7), index=dates)

    start = time.time()
    forecast = sarima_forecast(series, 6, seasonal_period=12)
    elapsed = time.time() - start

    assert len(forecast) == 6
    assert np.isfinite(forecast).all()
    assert elapsed < 15, f'SARIMA took too long: {elapsed:.2f}s'
