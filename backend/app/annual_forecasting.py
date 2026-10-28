"""Annual baseline forecasts for short, genuinely annual dashboard histories."""
import numpy as np
import pandas as pd

MODELS = ("naive", "historicaverage", "windowaverage")


def validate_annual_cadence(frame, date_column):
    dates = pd.to_datetime(frame[date_column], errors="coerce")
    if dates.empty or dates.isna().any():
        raise ValueError("Annual forecasting requires a valid date for every observation.")
    years = dates.dt.year
    if years.duplicated().any():
        raise ValueError("Annual forecasting requires one observation per reporting year.")
    missing = sorted(set(range(int(years.min()), int(years.max()) + 1)).difference(years))
    if missing:
        raise ValueError(f"Annual forecasting cannot compress missing reporting years ({', '.join(map(str, missing[:3]))}).")


def _predict(values, steps, model):
    if model == "naive":
        value = values[-1]
    elif model == "historicaverage":
        value = np.mean(values)
    else:
        value = np.mean(values[-5:])
    return np.full(steps, value, dtype=float)


def train_annual(data, config):
    date_column, target = config["date_column"], config["target"]
    validate_annual_cadence(data, date_column)
    requested = config["model_type"].lower()
    if requested not in ("auto", *MODELS):
        raise ValueError("Annual sources support Auto, Naive, Historic Average and Window Average. Other models require a separately validated annual adapter.")
    horizon = int(config.get("forecast_steps", 1))
    if not 1 <= horizon <= 10:
        raise ValueError("Choose an annual forecast horizon between 1 and 10 years.")
    values = pd.to_numeric(data[target], errors="coerce").to_numpy(dtype=float)
    if not np.isfinite(values).all():
        raise ValueError("Annual forecasting requires complete finite target measurements; missing years and values are not interpolated.")
    holdout = max(2, min(5, len(values) // 5))
    if len(values) - holdout < 8:
        raise ValueError("Annual forecasting requires at least ten consecutive observed years.")
    train, actual = values[:-holdout], values[-holdout:]
    candidates = MODELS if requested == "auto" else (requested,)
    comparisons = {}
    for model in candidates:
        predicted = _predict(train, holdout, model)
        error = actual - predicted
        comparisons[model] = {"status": "ok", "metrics": {"mae": float(np.mean(np.abs(error))),
                              "rmse": float(np.sqrt(np.mean(error ** 2)))}}
    winner = min(comparisons, key=lambda model: comparisons[model]["metrics"]["rmse"])
    dates = pd.to_datetime(data[date_column])
    last_year = int(dates.dt.year.max())
    future = [pd.Timestamp(year=last_year + offset, month=12, day=31).isoformat() for offset in range(1, horizon + 1)]
    return {"model_type": requested, "selected_model": winner, "frequency": "annual", "observations": len(values),
            "train_observations": len(train), "test_observations": holdout, "features_used": [],
            "metrics": comparisons[winner]["metrics"], "model_comparison": comparisons,
            "history_dates": [value.isoformat() for value in dates], "history_values": values.tolist(),
            "dates": [value.isoformat() for value in dates.iloc[-holdout:]], "actual": actual.tolist(),
            "predicted": _predict(train, holdout, winner).tolist(), "forecast_dates": future,
            "forecast_values": _predict(values, horizon, winner).tolist(), "lower_bound": None, "upper_bound": None,
            "warnings": ["Annual baseline forecast. Auto compares three baselines using chronological holdout RMSE. Window Average uses the latest five observed years; no seasonal or monthly observations are inferred."]}
