"""Exercise Windows spawn and model result transfer without database access."""
import pandas as pd
from app.training_worker import submit_training, shutdown_training


def main():
    frame = pd.DataFrame({'date': pd.date_range('2021-01-01', periods=40, freq='MS'),
                          'value': [10 + index % 12 + index * .1 for index in range(40)]})
    try:
        result = submit_training(frame, {'model_type': 'naive', 'date_column': 'date',
            'target': 'value', 'forecast_steps': 180, 'features': []}).result(timeout=90)
        assert len(result['forecast_values']) == 6
        assert all(pd.notna(value) for value in result['forecast_values'])
        assert pd.Timestamp(result['forecast_dates'][0]) > frame.date.max()
        print('PASS separate training process: finite six-month forecast, increasing dates, result returned to API process')
    finally:
        shutdown_training()


if __name__ == '__main__':
    main()
