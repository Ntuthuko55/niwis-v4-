"""Shared server-side cache used by every NIWIS dashboard data reader.

The loader keeps source credentials server-only, caches successful reads for a
short period, copies mutable results at the boundary, and never caches source
errors. Supabase modules still keep their bounded table-specific reads; this
module gives those readers and the packaged-data dashboards one cache policy.
"""
from __future__ import annotations

import copy
import os
from concurrent.futures import Future
from functools import wraps
from threading import Lock
from time import monotonic


try:
    _TTL = max(60, int(os.getenv("NIWIS_DASHBOARD_CACHE_TTL", "300")))
except ValueError:
    _TTL = 300
_MAX_ENTRIES = 256
_CACHE: dict[tuple, tuple[float, object]] = {}
# A page can mount two components that request the same dashboard source at
# the same time.  Keep one loader in flight per cache key so concurrent misses
# share the result instead of starting duplicate Supabase reads.
_INFLIGHT: dict[tuple, Future] = {}
_LOCK = Lock()


def _freeze(value):
    if isinstance(value, dict):
        return tuple(sorted((str(key), _freeze(item)) for key, item in value.items()))
    if isinstance(value, (list, tuple, set)):
        return tuple(_freeze(item) for item in value)
    try:
        hash(value)
        return value
    except TypeError:
        return repr(value)


def cached_call(namespace: str, *key_parts, loader):
    """Run ``loader`` once per key and return a defensive copy of the result."""
    cache_key = (namespace, _freeze(key_parts))
    now = monotonic()
    cached = None
    hit = False
    with _LOCK:
        entry = _CACHE.get(cache_key)
        if entry and entry[0] > now:
            cached, hit = entry[1], True
        elif entry:
            _CACHE.pop(cache_key, None)
        if not hit:
            future = _INFLIGHT.get(cache_key)
            if future is None:
                future = Future()
                _INFLIGHT[cache_key] = future
                owner = True
            else:
                owner = False

    # Copying a large DataFrame must not block unrelated dashboard keys.
    if hit:
        return copy.deepcopy(cached)

    if not owner:
        # ``Future.result`` re-raises the original loader exception for all
        # waiters.  Errors are still not cached, matching the old behaviour.
        return copy.deepcopy(future.result())

    try:
        value = loader()
        cached = copy.deepcopy(value)
    except BaseException as exc:
        future.set_exception(exc)
        with _LOCK:
            _INFLIGHT.pop(cache_key, None)
        raise
    else:
        with _LOCK:
            if len(_CACHE) >= _MAX_ENTRIES:
                _CACHE.pop(next(iter(_CACHE)))
            _CACHE[cache_key] = (monotonic() + _TTL, cached)
            _INFLIGHT.pop(cache_key, None)
        future.set_result(cached)
        return copy.deepcopy(cached)


def cached_result(namespace: str, *key_parts):
    """Copy an available result without starting a load or waiting for one.

    Returns None on a miss. Readers can reuse a broader national summary for a
    district, while keeping district-only cold reads small.
    """
    cache_key = (namespace, _freeze(key_parts))
    with _LOCK:
        entry = _CACHE.get(cache_key)
        if not entry or entry[0] <= monotonic():
            _CACHE.pop(cache_key, None)
            return None
        value = entry[1]
    return copy.deepcopy(value)


def dashboard_cache(namespace: str):
    """Decorator for source readers with a common five-minute cache policy."""
    def decorate(function):
        @wraps(function)
        def wrapped(*args, **kwargs):
            return cached_call(namespace, args, kwargs, loader=lambda: function(*args, **kwargs))

        def cache_clear():
            with _LOCK:
                for key in [key for key in _CACHE if key[0] == namespace]:
                    _CACHE.pop(key, None)

        wrapped.cache_clear = cache_clear
        return wrapped
    return decorate


def clear_dashboard_cache():
    with _LOCK:
        _CACHE.clear()
