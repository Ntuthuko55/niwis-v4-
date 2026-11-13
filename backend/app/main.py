import logging
import os
import threading
import time
import uuid
from datetime import datetime, timezone
from typing import Dict, Any, Optional
from urllib.parse import urlsplit

import pandas as pd
from fastapi import FastAPI, HTTPException, Query
import numpy as np
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.gzip import GZipMiddleware
from app.dashboard_response_cache import DashboardResponseCache
from app.training_worker import submit_training, shutdown_training
from starlette.middleware.wsgi import WSGIMiddleware

from app.data_processing import clean_dataset, get_columns, get_dataset_summary, get_preview, validate_monthly_cadence
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
from app.wastewater_service import router as wastewater_router
from app.drinking_water_service import router as drinking_water_router
from app.rwqo_service import router as rwqo_router
from app.wrm_service import router as wrm_router
from app.water_quantity_service import router as water_quantity_router
from app.water_services_service import router as water_services_router
from app.municipal_tariff_service import router as municipal_tariff_router
from app.report_service import router as reports_router
from app.annual_forecasting import validate_annual_cadence
from app.hydrology_dashboard import router as hydrology_dashboard_router
from app.spatial.service import router as spatial_service_router
from app.spatial.vectors import router as spatial_vector_router
from app.spatial.raster import router as spatial_raster_router
from app.readiness import DatabaseReadinessError, check_database_readiness
from app.schemas import ModelTrainingRequest, TrainingJobResponse, UploadResponse, DashboardDatasetRequest
from app.niwis_flask import app as niwis_app

_QUALITY_FORECAST_DASHBOARDS = frozenset({'wastewater', 'drinking-water', 'rwqo', 'water-quantity'})
_ANNUAL_FORECAST_DASHBOARDS = frozenset({'wrm'})
_LOGGER = logging.getLogger(__name__)


def _cors_origins() -> list[str]:
    """Resolve exact browser origins; production never falls back to wildcard."""
    production = os.getenv('NIWIS_ENV', 'development').strip().lower() in {'prod', 'production'}
    configured = os.getenv('NIWIS_CORS_ORIGINS', '').strip()
    if not configured:
        if production:
            # Same-origin reverse-proxy deployments need no CORS permission.
            return []
        return [
            'http://localhost:5173', 'http://127.0.0.1:5173',
            'http://localhost:4174', 'http://127.0.0.1:4174',
        ]

    origins = []
    for raw_origin in configured.split(','):
        origin = raw_origin.strip().rstrip('/')
        parsed = urlsplit(origin)
        if (
            not origin or origin == '*' or parsed.scheme not in {'http', 'https'}
            or not parsed.netloc or parsed.username or parsed.password
            or parsed.path or parsed.query or parsed.fragment
        ):
            raise RuntimeError(
                'NIWIS_CORS_ORIGINS must be a comma-separated list of exact HTTP(S) origins.'
            )
        if production and parsed.scheme != 'https':
            raise RuntimeError('Production NIWIS_CORS_ORIGINS entries must use HTTPS.')
        origins.append(origin)
    return list(dict.fromkeys(origins))

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
    allow_origins=_cors_origins(),
    allow_credentials=False,
    allow_methods=['GET', 'POST', 'OPTIONS'],
    allow_headers=[
        'Accept', 'Authorization', 'Content-Type', 'Range',
        'X-Requested-With', 'apikey',
    ],
    expose_headers=['Content-Disposition', 'X-NIWIS-Cache', 'X-NIWIS-Cached-At'],
)
app.add_middleware(DashboardResponseCache)
app.add_middleware(GZipMiddleware, minimum_size=1500, compresslevel=4)


@app.middleware('http')
async def add_security_headers(request, call_next):
    """Set safe defaults on API responses without assuming a TLS proxy."""
    response = await call_next(request)
    response.headers.setdefault('X-Content-Type-Options', 'nosniff')
    response.headers.setdefault('Referrer-Policy', 'strict-origin-when-cross-origin')
    if request.url.path in {'/health', '/ready'}:
        response.headers['Cache-Control'] = 'no-store'
    return response


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
app.include_router(wastewater_router)
app.include_router(drinking_water_router)
app.include_router(rwqo_router)
app.include_router(wrm_router)
app.include_router(water_quantity_router)
app.include_router(water_services_router)
app.include_router(municipal_tariff_router)
app.include_router(reports_router)
app.include_router(hydrology_dashboard_router)
app.include_router(spatial_service_router)
app.include_router(spatial_vector_router)
app.include_router(spatial_raster_router)

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

# Forecast inputs and job status are process-local. Keep the API on one worker
# until this state is moved to shared storage.
DATASETS: Dict[str, dict] = {}
TRAINING_JOBS: Dict[str, dict] = {}
_STATE_LOCK = threading.RLock()


def _int_setting(name: str, default: int, minimum: int, maximum: int) -> int:
    """Read a bounded positive integer setting and fail early on bad config."""
    try:
        value = int(os.getenv(name, str(default)))
    except ValueError as exc:
        raise RuntimeError(f'{name} must be an integer.') from exc
    if not minimum <= value <= maximum:
        raise RuntimeError(f'{name} must be between {minimum} and {maximum}.')
    return value


_MAX_DATASETS = _int_setting('NIWIS_DATASET_MAX_ENTRIES', 32, 1, 256)
_DATASET_TTL_SECONDS = _int_setting('NIWIS_DATASET_TTL_SECONDS', 3600, 60, 86400)
_MAX_DATASET_MEMORY_BYTES = 64 * 1024 * 1024
_MAX_DATASET_STORE_BYTES = _int_setting('NIWIS_DATASET_MAX_MEMORY_MB', 256, 64, 4096) * 1024 * 1024
_MAX_ACTIVE_TRAINING_JOBS = _int_setting('NIWIS_TRAINING_MAX_ACTIVE_JOBS', 2, 1, 4)
_MAX_RETAINED_TRAINING_JOBS = _int_setting('NIWIS_TRAINING_MAX_RETAINED_JOBS', 128, 16, 1024)


def _prune_expired_datasets(now: float) -> None:
    """Drop expired forecast data while preserving datasets used by active jobs."""
    active_dataset_ids = {
        job.get('_dataset_id') for job in TRAINING_JOBS.values()
        if job.get('status') in {'queued', 'running'}
    }
    expired = [
        dataset_id for dataset_id, dataset in DATASETS.items()
        if dataset_id not in active_dataset_ids
        and now - dataset.get('_created_at', now) >= _DATASET_TTL_SECONDS
    ]
    for dataset_id in expired:
        DATASETS.pop(dataset_id, None)


def _dataset_store_bytes() -> int:
    """Return the approximate memory used by the retained forecast frames."""
    return sum(dataset.get('_memory_bytes', 0) for dataset in DATASETS.values())


def _register_dataset(dataset_id: str, dataset: dict) -> None:
    """Store bounded forecast inputs, evicting stale/old unreferenced entries."""
    frame = dataset['df']
    memory_bytes = int(frame.memory_usage(index=True, deep=True).sum())
    if memory_bytes > _MAX_DATASET_MEMORY_BYTES:
        raise HTTPException(status_code=413, detail='The forecast dataset exceeds the 64 MiB limit.')

    now = time.monotonic()
    dataset['_created_at'] = now
    dataset['_memory_bytes'] = memory_bytes
    with _STATE_LOCK:
        _prune_expired_datasets(now)
        while (
            len(DATASETS) >= _MAX_DATASETS
            or _dataset_store_bytes() + memory_bytes > _MAX_DATASET_STORE_BYTES
        ):
            active_dataset_ids = {
                job.get('_dataset_id') for job in TRAINING_JOBS.values()
                if job.get('status') in {'queued', 'running'}
            }
            candidates = [
                (item.get('_created_at', 0), key) for key, item in DATASETS.items()
                if key not in active_dataset_ids
            ]
            if not candidates:
                raise HTTPException(
                    status_code=503,
                    detail='Forecast memory is busy; retry after an active job finishes.',
                )
            _, oldest_id = min(candidates)
            DATASETS.pop(oldest_id, None)
        DATASETS[dataset_id] = dataset


def _prune_training_history() -> bool:
    """Keep recent job results and preserve every queued or running job."""
    with _STATE_LOCK:
        while len(TRAINING_JOBS) >= _MAX_RETAINED_TRAINING_JOBS:
            completed = [
                (job.get('_created_at', 0), job_id)
                for job_id, job in TRAINING_JOBS.items()
                if job.get('status') not in {'queued', 'running'}
            ]
            if not completed:
                return False
            _, oldest_id = min(completed)
            TRAINING_JOBS.pop(oldest_id, None)
        return True


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
    _register_dataset(dataset_id, {
        'df': df, 'filename': f'supabase:meteorological:{region}',
        'sheet_names': None, 'current_sheet': None,
        'inferred_time_columns': inferred_time_columns, 'index_column': index_column,
        'dataset_summary': summary, 'region': region,
    })
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
    quality_forecast = request.dashboard in _QUALITY_FORECAST_DASHBOARDS
    annual_forecast = request.dashboard in _ANNUAL_FORECAST_DASHBOARDS
    try:
        if quality_forecast:
            validate_monthly_cadence(raw_df, request.date_column)
        if annual_forecast:
            validate_annual_cadence(raw_df, request.date_column)
        df, inferred_time_columns, index_column = clean_dataset(
            raw_df, request.date_column, interpolate_missing=not (quality_forecast or annual_forecast),
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    if index_column is None:
        raise HTTPException(status_code=422, detail='The dashboard history did not contain a usable date column.')
    dataset_id = str(uuid.uuid4())
    summary = get_dataset_summary(raw_df, inferred_time_columns)
    _register_dataset(dataset_id, {
        'df': df,
        'filename': f"dashboard:{request.dashboard}:{request.region or 'National'}",
        'sheet_names': None,
        'current_sheet': None,
        'inferred_time_columns': inferred_time_columns,
        'index_column': index_column,
        'dataset_summary': summary,
        'dashboard': request.dashboard,
        'region': request.region,
        'forecast_frequency': 'annual' if annual_forecast else 'monthly' if quality_forecast else None,
        'forecast_missing_strategy': 'reject' if quality_forecast or annual_forecast else None,
    })
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
    with _STATE_LOCK:
        _prune_expired_datasets(time.monotonic())
        dataset = DATASETS.get(dataset_id)
    if dataset is None:
        raise HTTPException(status_code=404, detail='Dataset not found or expired')
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

        threading.Thread(target=_progress_worker, daemon=True).start()

        job.update(progress=25, message=f"Training {config['model_type'].upper()} model…")
        with _STATE_LOCK:
            dataset = DATASETS.get(dataset_id)
            if dataset is None:
                raise RuntimeError('The forecast dataset expired before training started.')
            training_frame = dataset['df'].copy(deep=True)
        result = submit_training(training_frame, config).result()

        # Stop the smoother and finalize
        stop_progress.set()
        job.update(status='completed', progress=100, message='Training complete.', result=result, completed_at=time.time())
    except Exception as exc:
        job.update(status='failed', progress=100, message=str(exc), completed_at=time.time())
    finally:
        stop_progress.set()


@app.post('/models/train', response_model=TrainingJobResponse)
async def start_training(request: ModelTrainingRequest):
    config = request.model_dump()
    job_id = str(uuid.uuid4())
    estimated_minutes = 3 if request.model_type.lower() in {'lstm', 'transformer', 'prophet'} else 1
    with _STATE_LOCK:
        _prune_expired_datasets(time.monotonic())
        dataset = DATASETS.get(request.dataset_id)
        if dataset is None:
            raise HTTPException(status_code=404, detail='Dataset not found or expired')
        active_jobs = sum(job.get('status') in {'queued', 'running'} for job in TRAINING_JOBS.values())
        if active_jobs >= _MAX_ACTIVE_TRAINING_JOBS:
            raise HTTPException(
                status_code=429,
                detail='Forecast capacity is busy; retry after an active job finishes.',
            )
        if not _prune_training_history():
            raise HTTPException(status_code=503, detail='Forecast job history is full; retry later.')
        if dataset.get('dashboard') in _QUALITY_FORECAST_DASHBOARDS:
            # Quality histories are district-month data; callers cannot weaken
            # the source-specific cadence or missing-observation policy.
            config.update(frequency='monthly', missing_strategy='reject', group_column=None)
        if dataset.get('dashboard') in _ANNUAL_FORECAST_DASHBOARDS:
            config.update(frequency='annual', missing_strategy='reject', group_column=None, features=[])
        TRAINING_JOBS[job_id] = {
            'status': 'queued', 'progress': 0, 'message': 'Training job queued.',
            'estimated_minutes': estimated_minutes, '_dataset_id': request.dataset_id,
            '_created_at': time.monotonic(),
        }
        worker = threading.Thread(target=_run_training_job, args=(job_id, request.dataset_id, config), daemon=True)
        try:
            worker.start()
        except RuntimeError as exc:
            TRAINING_JOBS.pop(job_id, None)
            raise HTTPException(status_code=503, detail='The forecast worker could not be started.') from exc
    return TrainingJobResponse(job_id=job_id, status='queued', message='Training started.', estimated_minutes=estimated_minutes)


@app.get('/models/jobs/{job_id}')
async def training_status(job_id: str):
    with _STATE_LOCK:
        job = TRAINING_JOBS.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail='Training job not found or expired')
        public_job = {key: value for key, value in job.items() if not key.startswith('_')}
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

    return _json_safe({**public_job, 'job_id': job_id})


@app.get('/ready', tags=['operations'])
def readiness_check():
    """Report readiness only after the configured database answers a query."""
    try:
        database = check_database_readiness()
    except DatabaseReadinessError as exc:
        _LOGGER.warning('Database readiness check failed: %s', exc)
        raise HTTPException(status_code=503, detail='The configured database is not ready.') from exc
    return {'status': 'ready', 'database': database}


@app.get("/health")
async def health_check():
    """Liveness check; use /ready when the database must also be available."""
    return {
        'status': 'healthy',
        'timestamp': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
        'datasets_loaded': len(DATASETS),
        'training_jobs': len(TRAINING_JOBS)
    }
