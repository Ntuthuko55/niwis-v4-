import pandas as pd
import numpy as np

from app.model_training import train_model

def test_all_models():
    # Reproducible daily signals cover seasonal and multivariate models without
    # depending on a local province export or machine-specific data directory.
    dates = pd.date_range('2015-01-01', periods=365 * 6, freq='D')
    steps = np.arange(len(dates), dtype=float)
    df = pd.DataFrame({'date': dates,
                       'daily_rainfall': 3. + np.sin(steps * 2 * np.pi / 365.25) + .2 * np.cos(steps / 7),
                       'temperature': 20. + 4 * np.sin(steps * 2 * np.pi / 365.25 + .3),
                       'soil_moisture': .4 + .1 * np.cos(steps * 2 * np.pi / 365.25)})

    models = [
        'auto', 'naive', 'historicaverage', 'windowaverage', 'seasonalnaive',
        'ar', 'ma', 'arma', 'arima', 'sarima',
        'garch', 'state_space', 'lstm', 'transformer', 'prophet',
        'var', 'varmax'
    ]

    results = {}
    for m in models:
        print(f"\n--- Testing model: {m} ---")
        numeric_cols = df.select_dtypes(include='number').columns.tolist()
        target = 'daily_rainfall' if 'daily_rainfall' in df.columns else numeric_cols[0]
        extra_features = [c for c in numeric_cols if c != target][:2] if m in {'var', 'varmax'} else []
        
        config = {
            'model_type': m,
            'date_column': 'date',
            'target': target,
            'features': extra_features,
            'forecast_steps': 365,
        }
        try:
            res = train_model(df, config)
            assert res.get('forecast_values'), f'{m} produced no forecast values'
            assert np.isfinite(res['forecast_values']).all(), f'{m} produced nonfinite forecasts'
            print(f"SUCCESS: {m} -> model_type={res.get('model_type')}, forecast_len={len(res.get('forecast_values', []))}, metrics={res.get('metrics')}")
            results[m] = "OK"
        except Exception as e:
            print(f"FAILED: {m} -> {type(e).__name__}: {e}")
            import traceback
            traceback.print_exc()
            results[m] = f"FAILED: {e}"

    print("\n================ SUMMARY ================")
    for m, status in results.items():
        print(f"{m:20s}: {status}")
    failures = {model: status for model, status in results.items() if status != 'OK'}
    assert not failures, f'Model failures: {failures}'

if __name__ == '__main__':
    test_all_models()
