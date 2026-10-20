"""Exercise regional loading, asynchronous training, polling and forecast results.

Run with --live to read Supabase; otherwise use deterministic climate observations.
"""
import argparse
import asyncio
import json
import time
from unittest.mock import patch

import numpy as np
import pandas as pd

from app import main
from app.schemas import ModelTrainingRequest

FEATURES = ['monthly_rainfall_mm_month', 'tavg_c', 'pet_mm_day',
            'relative_humidity_pct', 'solar_radiation_wm2', 'wind_speed_2m_ms']


async def check(models, live):
    if live:
        loaded = main.load_meteorological_dataset('Alfred Nzo')
    else:
        dates = pd.date_range('2010-01-01', periods=120, freq='MS')
        rows = [{'date': str(date.date()), 'district_name': 'Test region',
                 'spi_3': float(np.sin(i / 6) + i / 1000),
                 **{name: float(10 + np.sin(i / (j + 2)) + i / 100) for j, name in enumerate(FEATURES)}}
                for i, date in enumerate(dates)]
        with patch.object(main, 'meteorological_history', return_value={'history': rows}):
            loaded = main.load_meteorological_dataset('Test region')
    print(f'Loaded {loaded.row_count} regional observations; date column={loaded.index_column}', flush=True)
    series = await main.province_time_series(loaded.dataset_id, 'spi_3')
    assert len(series['points']) >= 36
    failures = []
    for model in models:
        started = time.monotonic()
        queued = await main.start_training(ModelTrainingRequest(
            dataset_id=loaded.dataset_id, model_type=model, date_column=loaded.index_column,
            target='spi_3', features=FEATURES if model in {'lstm', 'var', 'varmax', 'transformer', 'state_space', 'garch'} else [],
            forecast_steps=365,
        ))
        polls = 0
        while True:
            status = await main.training_status(queued.job_id)
            assert status['job_id'] == queued.job_id, 'Polling lost the job ID'
            json.dumps(status, allow_nan=False)
            polls += 1
            if status['status'] in {'completed', 'failed'}:
                break
            if time.monotonic() - started > 240:
                raise AssertionError(f'{model}: training exceeded four minutes')
            await asyncio.sleep(0.2)
        if status['status'] == 'failed':
            failures.append(f"{model}: {status['message']}")
            print('FAIL', failures[-1], flush=True)
            continue
        result = status['result']
        values = result['forecast_values']
        dates = pd.to_datetime(result['forecast_dates'])
        assert len(values) == len(dates) and len(values) > 0
        assert np.isfinite(values).all()
        assert dates.is_monotonic_increasing and dates.is_unique
        assert dates.min() > pd.to_datetime(result['history_dates']).max()
        assert len(result['history_dates']) == len(result['history_values'])
        for bound in ['lower_bound', 'upper_bound']:
            if result.get(bound):
                assert len(result[bound]) == len(values) and np.isfinite(result[bound]).all()
        print(f'PASS {model}: {len(values)} forecast points, {polls} polls, {time.monotonic()-started:.1f}s', flush=True)
    # A failed job must retain its failure message after the progress timer wakes.
    failed = await main.start_training(ModelTrainingRequest(
        dataset_id=loaded.dataset_id, model_type='lstm', date_column=loaded.index_column,
        target='spi_3', features=[], forecast_steps=365))
    deadline = time.monotonic() + 90
    while True:
        status = await main.training_status(failed.job_id)
        if status['status'] in {'completed', 'failed'} or time.monotonic() >= deadline:
            break
        await asyncio.sleep(.2)
    assert status['status'] == 'failed' and 'input feature' in status['message'], status
    await asyncio.sleep(3)
    status = await main.training_status(failed.job_id)
    assert status['status'] == 'failed' and 'input feature' in status['message'], status
    assert status['progress'] == 100
    print('PASS failure reporting and progress cleanup', flush=True)
    assert not failures, '\n'.join(failures)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--live', action='store_true')
    parser.add_argument('--models', nargs='+', default=['lstm', 'naive'])
    args = parser.parse_args()
    asyncio.run(check(args.models, args.live))
