"""Verify that annual forecasts never create monthly observations or fill gaps."""
import asyncio
import unittest
from unittest.mock import patch

import pandas as pd

from app.annual_forecasting import validate_annual_cadence
from app.model_training import train_model


def annual_frame():
    return pd.DataFrame({"date": [f"{year}-12-31" for year in range(2000, 2026)], "rainfall": list(range(100, 126))})


class AnnualForecastTests(unittest.TestCase):
    def config(self, **changes):
        return {"date_column": "date", "target": "rainfall", "frequency": "annual", "missing_strategy": "reject", "model_type": "auto", "forecast_steps": 3, **changes}

    def test_auto_is_annual_and_has_chronological_holdout(self):
        result = train_model(annual_frame(), self.config())
        self.assertEqual(result["frequency"], "annual")
        self.assertEqual(result["observations"], 26)
        self.assertEqual(len(result["model_comparison"]), 3)
        self.assertEqual([date[:4] for date in result["forecast_dates"]], ["2026", "2027", "2028"])
        self.assertLess(result["dates"][-1], result["forecast_dates"][0])
        self.assertEqual(result["selected_model"], "naive")
        self.assertEqual(result["forecast_values"], [125, 125, 125])
        # Validation uses the final training value, not the final history value.
        self.assertEqual(result["predicted"], [120] * 5)

    def test_missing_years_or_values_are_rejected(self):
        missing_year = annual_frame().drop(index=10)
        with self.assertRaisesRegex(ValueError, "missing reporting years"):
            train_model(missing_year, self.config())
        missing_value = annual_frame()
        missing_value.loc[10, "rainfall"] = None
        with self.assertRaisesRegex(ValueError, "missing or nonfinite"):
            train_model(missing_value, self.config())

    def test_duplicate_year_and_unsupported_models_or_horizons_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "one observation"):
            validate_annual_cadence(pd.concat([annual_frame(), annual_frame().iloc[:1]]), "date")
        for changes in ({"model_type": "lstm"}, {"forecast_steps": 365}):
            with self.assertRaises(ValueError):
                train_model(annual_frame(), self.config(**changes))

    def test_registered_wrm_policy_forces_annual_training_and_preserves_missing(self):
        from app.main import DATASETS, TRAINING_JOBS, register_dashboard_dataset, start_training
        from app.schemas import DashboardDatasetRequest, ModelTrainingRequest
        frame = annual_frame()
        frame.loc[10, "rainfall"] = None
        uploaded = asyncio.run(register_dashboard_dataset(DashboardDatasetRequest(dashboard="wrm", rows=frame.to_dict("records"))))
        try:
            stored = DATASETS[uploaded.dataset_id]
            self.assertEqual(stored["forecast_frequency"], "annual")
            self.assertTrue(pd.isna(stored["df"].iloc[10].rainfall))
            with patch("app.main.threading.Thread") as thread:
                job = asyncio.run(start_training(ModelTrainingRequest(dataset_id=uploaded.dataset_id, model_type="auto", target="rainfall", date_column="date", forecast_steps=3)))
            config = thread.call_args.kwargs["args"][2]
            self.assertEqual(config["frequency"], "annual")
            self.assertEqual(config["missing_strategy"], "reject")
            TRAINING_JOBS.pop(job.job_id, None)
        finally:
            DATASETS.pop(uploaded.dataset_id, None)


if __name__ == "__main__":
    unittest.main()
