"""Run CPU-heavy model fitting outside the API process, on demand."""
import os
from concurrent.futures import ProcessPoolExecutor
from multiprocessing import get_context
from threading import Lock

_pool = None
_lock = Lock()


def _configure_worker():
    # A single training job must not consume every numerical thread on the host.
    for name in ('OMP_NUM_THREADS', 'MKL_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'NUMEXPR_NUM_THREADS'):
        os.environ[name] = os.getenv('NIWIS_TRAINING_THREADS', '2')


def fit_model(frame, config):
    from app.model_training import train_model
    from threadpoolctl import threadpool_limits
    with threadpool_limits(limits=max(1, int(os.getenv('NIWIS_TRAINING_THREADS', '2')))):
        return train_model(frame, config)


def submit_training(frame, config):
    global _pool
    with _lock:
        if _pool is None:
            _pool = ProcessPoolExecutor(
                max_workers=max(1, min(4, int(os.getenv('NIWIS_TRAINING_WORKERS', '1')))),
                mp_context=get_context('spawn'), initializer=_configure_worker,
            )
        return _pool.submit(fit_model, frame, config)


def shutdown_training():
    global _pool
    with _lock:
        if _pool is not None:
            _pool.shutdown(wait=False, cancel_futures=True)
            _pool = None
