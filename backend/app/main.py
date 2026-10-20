import uuid
import threading
import time
from datetime import datetime
from typing import Dict, Any, Optional

import pandas as pd
from fastapi import FastAPI, HTTPException, Query
import numpy as np
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.gzip import GZipMiddleware
from app.dashboard_response_cache import DashboardResponseCache
from app.training_worker import submit_training, shutdown_training
from starlette.middleware.wsgi import WSGIMiddleware

from app.data_processing import clean_dataset, get_columns, get_dataset_summary, get_preview
from app.supabase_source import SupabaseSourceError
from app.meteorological_service import router as meteorological_router, history as meteorological_history
from app.drought_monitoring import router as drought_monitoring_router
from app.climate_service import router as climate_router
from app.vegetation_service import router as vegetation_router
from app.rainfall_service import router as rainfall_router
from app.runoff_service import router as runoff_router
from app.surface_water_service import router as surface_water_router
from app.reservoir_service import router as reservoir_router
from app.groundwater_service import router as groundwater_router
from app.groundwater_reserve_service import router as groundwater_reserve_router
from app.water_quality_service import router as water_quality_router
from app.hydrology_dashboard import router as hydrology_dashboard_router
from app.schemas import ModelTrainingRequest, TrainingJobResponse, UploadResponse, DashboardDatasetRequest
from app.niwis_flask import app as niwis_app

# FastAPI app with enhanced metadata for Swagger UI
app = FastAPI(
    title="NIWIS Monitoring API",
    description="Climate, drought and water monitoring with regional dashboard forecasts",
    version="2.0",
    docs_url="/api/docs",
    redoc_url="/api/redoc",
    openapi_url="/api/openapi.json"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(DashboardResponseCache)
app.add_middleware(GZipMiddleware, minimum_size=1500, compresslevel=4)


@app.on_event('shutdown')
def stop_training_workers():
    shutdown_training()

app.include_router(meteorological_router)
app.include_router(drought_monitoring_router)
app.include_router(climate_router)
app.include_router(vegetation_router)
app.include_router(rainfall_router)
app.include_router(runoff_router)
app.include_router(surface_water_router)
app.include_router(reservoir_router)
app.include_router(groundwater_router)
app.include_router(groundwater_reserve_router)
app.include_router(water_quality_router)
app.include_router(hydrology_dashboard_router)

# Shared provincial drought summaries used by the Drought Status route.
app.mount("/niwis-api", WSGIMiddleware(niwis_app))

from app.satellite_service import stations as satellite_stations, history as satellite_history
from app.satellite_service import forecast_source as satellite_forecast_source


@app.get('/satellite/forecast-source')
def get_satellite_forecast_source(region: str = 'National'):
    try:
        return satellite_forecast_source(region)
    except SupabaseSourceError as exc:
        raise HTTPException(503, str(exc)) from exc


@app.get('/satellite/stations')
def get_satellite_stations(date: Optional[str] = Query(None)):
    try:
        return satellite_stations(date)
    except SupabaseSourceError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.get('/satellite/history')
def get_satellite_history(district: str = Query(..., min_length=1)):
    try:
        return satellite_history(district)
    except SupabaseSourceError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


from app.hydrology_service import get_all_stations, get_district_hydrology_history, get_hydrology_dataset

@app.get("/hydrology/stations")
def get_hydrology_stations(date: Optional[str] = Query(None)):
    """Return station summaries and latest indicators for all 52 districts in Supabase hydrological_drought_master."""
    try:
        return get_all_stations(target_date=date)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))

@app.get("/hydrology/history")
def get_hydrology_history(district: str = Query(..., min_length=1), date: Optional[str] = Query(None)):
    """Return complete hydrological time series, FDC, groundwater, runoff and insights for one district."""
    try:
        return get_district_hydrology_history(district_name=district, target_date=date)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))

@app.get("/hydrology/dataset")
def get_hydrology_full_dataset():
    """Return all database hydrological observations so the dashboard can filter by district_name client-side."""
    try:
        return get_hydrology_dataset()
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))

# Global state
DATASETS: Dict[str, dict] = {}
TRAINING_JOBS: Dict[str, dict] = {}


@app.post('/meteorological/load', response_model=UploadResponse)
def load_meteorological_dataset(region: str = Query(..., min_length=1)):
    """Register the selected region's observations for dashboard forecasting."""
    rows = meteorological_history(region)['history']
    if not rows:
        raise HTTPException(status_code=404, detail='No observations found for this region')
    raw_df = pd.DataFrame(rows).drop(columns=['id', 'year', 'month'], errors='ignore')
    df, inferred_time_columns, index_column = clean_dataset(raw_df)
    dataset_id = str(uuid.uuid4())
    summary = get_dataset_summary(raw_df, inferred_time_columns)
    DATASETS[dataset_id] = {
        'df': df, 'filename': f'supabase:meteorological:{region}',
        'sheet_names': None, 'current_sheet': None,
        'inferred_time_columns': inferred_time_columns, 'index_column': index_column,
        'dataset_summary': summary, 'region': region,
    }
    return UploadResponse(
        dataset_id=dataset_id, columns=get_columns(df), preview=get_preview(df, rows=10),
        row_count=len(df), sheet_names=None, current_sheet=None,
        inferred_time_columns=inferred_time_columns, index_column=index_column,
        dataset_summary=summary,
    )


@app.post('/dashboard/dataset', response_model=UploadResponse)
async def register_dashboard_dataset(request: DashboardDatasetRequest):
    """Register dashboard rows in the same in-memory dataset registry used by /models/train.

    Dashboard APIs already apply their source filtering and aggregation.  This
    endpoint only normalizes those returned rows server-side before handing the
    dataset to the existing forecasting engine; it never accepts database
    credentials or calls a client-supplied table name.
    """
    if not request.rows:
        raise HTTPException(status_code=422, detail='The selected dashboard has no observations to forecast.')
    if len(request.rows) > 100_000:
        raise HTTPException(status_code=413, detail='The dashboard history is too large to register in one request.')
    raw_df = pd.DataFrame(request.rows)
    if request.date_column not in raw_df.columns:
        raise HTTPException(status_code=422, detail=f"Date column '{request.date_column}' was not found in dashboard rows.")
    try:
        df, inferred_time_columns, index_column = clean_dataset(raw_df, request.date_column)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    if index_column is None:
        raise HTTPException(status_code=422, detail='The dashboard history did not contain a usable date column.')
    dataset_id = str(uuid.uuid4())
    summary = get_dataset_summary(raw_df, inferred_time_columns)
    DATASETS[dataset_id] = {
        'df': df,
        'filename': f"dashboard:{request.dashboard}:{request.region or 'National'}",
        'sheet_names': None,
        'current_sheet': None,
        'inferred_time_columns': inferred_time_columns,
        'index_column': index_column,
        'dataset_summary': summary,
        'dashboard': request.dashboard,
        'region': request.region,
    }
    return UploadResponse(
        dataset_id=dataset_id,
        columns=get_columns(df),
        preview=get_preview(df, rows=10),
        row_count=len(df),
        sheet_names=None,
        current_sheet=None,
        inferred_time_columns=inferred_time_columns,
        index_column=index_column,
        dataset_summary=summary,
        source='dashboard',
    )


@app.get('/provinces/series/{dataset_id}')
async def province_time_series(dataset_id: str, column: str, frequency: str = 'monthly'):
    """Return chart-ready provincial observations, aggregated for a readable long-term graph."""
    if dataset_id not in DATASETS:
        raise HTTPException(status_code=404, detail='Dataset not found')
    dataset = DATASETS[dataset_id]
    date_column, df = dataset.get('index_column'), dataset['df']
    if not date_column or column not in df.columns or not pd.api.types.is_numeric_dtype(df[column]):
        raise HTTPException(status_code=400, detail='Choose a numeric variable and a valid date column')
    series = df[[date_column, column]].dropna().copy().set_index(date_column)[column].sort_index()
    rule = {'daily': 'D', 'monthly': 'MS', 'annual': 'YS'}.get(frequency, 'MS')
    series = series.resample(rule).mean().dropna()
    return {'date_column': date_column, 'column': column, 'frequency': frequency,
            'points': [{'date': timestamp.isoformat(), 'value': float(value)} for timestamp, value in series.items()]}


def _run_training_job(job_id: str, dataset_id: str, config: dict):
    job = TRAINING_JOBS[job_id]
    stop_progress = threading.Event()
    try:
        job.update(status='running', progress=5, message='Preparing and cleaning the time series…', started_at=time.time())

        # Start a background progress smoother that increments progress
        # while the actual training work runs. This gives the UI feedback
        # so long-running models (Prophet, LSTM, Transformer) show activity.

        def _progress_worker():
            p = 10
            while not stop_progress.wait(2) and p < 95:
                try:
                    p = min(95, p + (1 + int((100 - p) * 0.05)))
                    job.update(progress=p, message=f"Training {config.get('model_type','model').upper()}... ({p}%)")
                except Exception:
                    pass

        import threading as _thr
        _thr.Thread(target=_progress_worker, daemon=True).start()

        job.update(progress=25, message=f"Training {config['model_type'].upper()} model…")
        result = submit_training(DATASETS[dataset_id]['df'].copy(deep=True), config).result()

        # Stop the smoother and finalize
        stop_progress.set()
        job.update(status='completed', progress=100, message='Training complete.', result=result, completed_at=time.time())
    except Exception as exc:
        job.update(status='failed', progress=100, message=str(exc), completed_at=time.time())
    finally:
        stop_progress.set()


@app.post('/models/train', response_model=TrainingJobResponse)
async def start_training(request: ModelTrainingRequest):
    if request.dataset_id not in DATASETS:
        raise HTTPException(status_code=404, detail='Dataset not found')
    config = request.model_dump()
    job_id = str(uuid.uuid4())
    estimated_minutes = 3 if request.model_type.lower() in {'lstm', 'transformer', 'prophet'} else 1
    TRAINING_JOBS[job_id] = {'status': 'queued', 'progress': 0, 'message': 'Training job queued.', 'estimated_minutes': estimated_minutes}
    threading.Thread(target=_run_training_job, args=(job_id, request.dataset_id, config), daemon=True).start()
    return TrainingJobResponse(job_id=job_id, status='queued', message='Training started.', estimated_minutes=estimated_minutes)


@app.get('/models/jobs/{job_id}')
async def training_status(job_id: str):
    if job_id not in TRAINING_JOBS:
        raise HTTPException(status_code=404, detail='Training job not found')
    def _json_safe(obj):
        # Recursively convert numpy types and sanitize NaN/Inf
        if isinstance(obj, dict):
            return {k: _json_safe(v) for k, v in obj.items()}
        if isinstance(obj, list):
            return [_json_safe(v) for v in obj]
        if isinstance(obj, tuple):
            return tuple(_json_safe(v) for v in obj)
        # numpy arrays -> lists
        if hasattr(obj, 'tolist') and not isinstance(obj, (str, bytes, bytearray)):
            try:
                return _json_safe(obj.tolist())
            except Exception:
                pass
        if isinstance(obj, (pd.Timestamp, datetime)):
            return obj.isoformat()
        if isinstance(obj, (np.bool_, bool)):
            return bool(obj)
        # numbers
        if isinstance(obj, (np.floating, float)):
            if np.isnan(obj) or np.isinf(obj):
                return None
            return float(obj)
        if isinstance(obj, (np.integer, int)):
            return int(obj)
        return obj

    return _json_safe({**TRAINING_JOBS[job_id], 'job_id': job_id})


# Advanced Trend Analysis Endpoints


# Dashboard Overview Endpoint


# Export & Download Endpoints


# Forecasting Endpoint


# ---------------------------------------------------------------------------
# KZN Multivariate Forecasting Endpoint
# ---------------------------------------------------------------------------


# Health Check

@app.get("/health")
async def health_check():
    """API health check"""
    return {
        'status': 'healthy',
        'timestamp': datetime.now().isoformat(),
        'datasets_loaded': len(DATASETS),
        'training_jobs': len(TRAINING_JOBS)
    }
