from typing import Any, Dict, List, Optional

from pydantic import BaseModel


class UploadResponse(BaseModel):
    dataset_id: str
    columns: List[str]
    preview: List[Dict[str, Any]]
    row_count: int
    sheet_names: Optional[List[str]] = None
    current_sheet: Optional[str] = None
    inferred_time_columns: Optional[List[str]] = None
    index_column: Optional[str] = None
    dataset_summary: Optional[Dict[str, Any]] = None
    source: Optional[str] = None


class ModelTrainingRequest(BaseModel):
    dataset_id: str
    model_type: str
    date_column: str
    target: str
    group_column: Optional[str] = None
    features: List[str] = []
    missing_strategy: str = 'group_linear_bfill_ffill'
    test_size: float = 0.2
    forecast_steps: int = 365
    order: List[int] = [1, 1, 1]
    seasonal_order: List[int] = [1, 0, 1, 12]


class TrainingJobResponse(BaseModel):
    job_id: str
    status: str
    message: str
    estimated_minutes: int


class DashboardDatasetRequest(BaseModel):
    """Register a dashboard's already-authorized source rows for the shared model engine."""
    dashboard: str
    region: Optional[str] = None
    rows: List[Dict[str, Any]]
    date_column: str = 'date'
