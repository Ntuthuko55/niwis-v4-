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


class PreviewRequest(BaseModel):
    dataset_id: str
    rows: Optional[int] = 10
    sheet_name: Optional[str] = None


class DateColumnRequest(BaseModel):
    dataset_id: str
    date_column: str


class PreviewResponse(BaseModel):
    dataset_id: str
    columns: List[str]
    preview: List[Dict[str, Any]]
    sheet_names: Optional[List[str]] = None
    current_sheet: Optional[str] = None
    inferred_time_columns: Optional[List[str]] = None
    index_column: Optional[str] = None
    dataset_summary: Optional[Dict[str, Any]] = None
    source: Optional[str] = None


class AnalysisRequest(BaseModel):
    dataset_id: str
    analysis_type: str
    column: str
    params: Optional[Dict[str, Any]] = None
    group_by: Optional[str] = None


class ReportRequest(AnalysisRequest):
    pass


class FeatureEngineeringRequest(BaseModel):
    dataset_id: str
    date_column: Optional[str] = None
    target_columns: Optional[List[str]] = None
    lags: Optional[List[int]] = [1, 2, 3]
    rolling_windows: Optional[List[int]] = [7, 14, 30]
    ema_spans: Optional[List[int]] = [7, 14, 30]
    include_time_features: bool = True
    include_lag_features: bool = True
    include_rolling_features: bool = True
    include_ema_features: bool = True
    include_cumulative_features: bool = True
    include_change_features: bool = True
    include_transform_features: bool = True
    normalize: bool = True
    standardize: bool = True
    sample_rows: Optional[int] = 10


class FeatureEngineeringResponse(BaseModel):
    dataset_id: str
    date_column: Optional[str] = None
    original_columns: List[str]
    generated_features: List[str]
    sample_rows: List[Dict[str, Any]]
    summary: Dict[str, Any]


class TrendAnalysisRequest(BaseModel):
    dataset_id: str
    variable: str
    province: Optional[str] = None
    analysis_method: Optional[str] = None  # 'raw', 'moving_avg', 'annual', 'regression', 'mk', 'lowess', 'all'


class TrendAnalysisResponse(BaseModel):
    dataset_id: str
    variable: str
    province: Optional[str]
    data_points: int
    methods: Dict[str, Any]


class ComparisonRequest(BaseModel):
    dataset_id: str
    variable: str
    provinces: Optional[List[str]] = None


class DashboardOverviewRequest(BaseModel):
    dataset_id: str
    date_column: str
    selected_column: str


class DashboardOverviewResponse(BaseModel):
    dataset_id: str
    column: str
    date_column: str
    summary: Dict[str, Any]  # row count, date range, missing values, feature count
    trend: Dict[str, Any]  # trend analysis results
    seasonal: Dict[str, Any]  # seasonal decomposition
    stationarity: Dict[str, Any]  # ADF/KPSS test results
    autocorrelation: Dict[str, Any]  # ACF/PACF summary
    spectral: Dict[str, Any]  # spectral analysis (dominant frequencies)
    change_points: Dict[str, Any]  # change point detection results


class AvailableVariablesResponse(BaseModel):
    variables: List[str]
    province: Optional[str]


class AnalysisResponse(BaseModel):
    analysis_type: str
    column: str
    results: Dict[str, Any]


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


class ForecastingRequest(BaseModel):
    dataset_id: str
    date_column: str
    target_column: str
    model_type: str = 'auto'  # 'arima', 'prophet', 'exponential_smoothing', 'auto'
    forecast_steps: int = 365
    include_confidence_intervals: bool = True
    confidence_level: float = 0.95


class DashboardForecastRequest(BaseModel):
    """Forecast a series already prepared by a connected dashboard."""
    rows: List[Dict[str, Any]]
    date_column: str = 'date'
    target: str
    model_type: str = 'auto'
    forecast_periods: int = 12
    frequency: str = 'monthly'
    features: List[str] = []


class DashboardDatasetRequest(BaseModel):
    """Register a dashboard's already-authorized source rows for the shared model engine."""
    dashboard: str
    region: Optional[str] = None
    rows: List[Dict[str, Any]]
    date_column: str = 'date'


class ForecastingResponse(BaseModel):
    dataset_id: str
    target_column: str
    model_type: str
    forecast_steps: int
    forecast_values: List[float]  # Predicted values
    forecast_dates: List[str]  # Forecast dates
    lower_bound: Optional[List[float]] = None  # 95% CI lower
    upper_bound: Optional[List[float]] = None  # 95% CI upper
    model_performance: Dict[str, Any]  # MAE, RMSE, etc.
    model_params: Dict[str, Any]  # Model hyperparameters used
    history_dates: List[str] = []
    history_values: List[float] = []
    details: Optional[Dict[str, Any]] = None
