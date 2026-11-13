"""Bounded, server-side map tiles shared by every NIWIS dashboard."""

from concurrent.futures import Future
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
import os
import re
import threading
import time
from collections import OrderedDict
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import Request, urlopen

from fastapi import HTTPException, Response

_tiles = OrderedDict()
_inflight = {}
_tile_lock = threading.Lock()
_cache_bytes = 0
_cache_limit = 32 * 1024 * 1024
_OSM_MINIMUM_CACHE_SECONDS = 7 * 24 * 60 * 60


def _public_referer(referer):
    """Pass a clean site origin to OSM without forwarding the current route/query."""
    if not referer:
        return None
    try:
        parts = urlsplit(referer)
        if parts.scheme not in {"http", "https"} or not parts.hostname or parts.username or parts.password:
            return None
        _ = parts.port  # Reject malformed ports before constructing the header.
    except ValueError:
        return None
    return f"{parts.scheme}://{parts.netloc}/"


def _cache_policy(cache_control, expires, default_ttl, age=None):
    directives = {item.strip().lower() for item in (cache_control or "").split(",")}
    if "no-store" in directives or "no-cache" in directives:
        return 0, cache_control or "no-cache"

    match = re.search(r"(?:^|,)\s*max-age\s*=\s*\"?(\d+)", cache_control or "", re.IGNORECASE)
    if match:
        ttl = int(match.group(1))
        if age and str(age).isdigit():
            ttl = max(0, ttl - int(age))
        cache_control = re.sub(r'((?:^|,)\s*max-age\s*=\s*)"?\d+"?', lambda item: f'{item.group(1)}{ttl}', cache_control, flags=re.IGNORECASE)
    elif expires:
        try:
            expiry = parsedate_to_datetime(expires)
            if expiry.tzinfo is None:
                expiry = expiry.replace(tzinfo=timezone.utc)
            ttl = max(0, int((expiry - datetime.now(timezone.utc)).total_seconds()))
        except (TypeError, ValueError, OverflowError):
            ttl = default_ttl
    else:
        ttl = default_ttl

    if not cache_control:
        cache_control = f"public, max-age={ttl}"
    return ttl, cache_control


def _street_tile(z, x, y, referer):
    api_key = os.getenv("MAPTILER_API_KEY", "").strip()
    if api_key:
        query = urlencode({"key": api_key})
        url = f"https://api.maptiler.com/maps/streets-v4/256/{z}/{x}/{y}.png?{query}"
        default_ttl = 3600
    else:
        site_referer = _public_referer(referer)
        if not site_referer:
            raise HTTPException(400, "A valid site referrer is required for OpenStreetMap tiles.")
        url = f"https://tile.openstreetmap.org/{z}/{x}/{y}.png"
        default_ttl = _OSM_MINIMUM_CACHE_SECONDS

    headers = {"Accept": "image/png", "User-Agent": "NIWIS/1.0 dashboard map (local water information system)"}
    if not api_key:
        headers["Referer"] = site_referer
    request = Request(url, headers=headers)
    try:
        with urlopen(request, timeout=12) as upstream:
            data = upstream.read(2 * 1024 * 1024 + 1)
            cache_control = upstream.headers.get("Cache-Control")
            expires = upstream.headers.get("Expires")
            age = upstream.headers.get("Age")
    except HTTPError as exc:
        raise HTTPException(502, "The street-map provider could not supply this tile.") from exc
    except (URLError, TimeoutError, OSError) as exc:
        raise HTTPException(502, "The street-map provider is temporarily unreachable.") from exc
    if len(data) > 2 * 1024 * 1024 or not data.startswith(b"\x89PNG\r\n\x1a\n"):
        raise HTTPException(502, "The street-map provider returned an invalid image.")
    ttl, cache_control = _cache_policy(cache_control, expires, default_ttl, age)
    return data, "image/png", cache_control, ttl


def _satellite_tile(z, x, y):
    api_key = os.getenv("MAPTILER_API_KEY", "").strip()
    if not api_key:
        raise HTTPException(503, "MapTiler is not configured. Set MAPTILER_API_KEY in backend/.env and restart the API.")
    query = urlencode({"key": api_key})
    url = f"https://api.maptiler.com/tiles/satellite-v2/{z}/{x}/{y}.jpg?{query}"
    request = Request(url, headers={"Accept": "image/jpeg", "User-Agent": "NIWIS/1.0 map tiles"})
    try:
        with urlopen(request, timeout=12) as upstream:
            data = upstream.read(2 * 1024 * 1024 + 1)
            cache_control = upstream.headers.get("Cache-Control")
            expires = upstream.headers.get("Expires")
            age = upstream.headers.get("Age")
    except HTTPError as exc:
        if exc.code in (401, 403):
            raise HTTPException(502, "MapTiler did not accept the configured server-side key.") from exc
        raise HTTPException(502, "MapTiler could not supply this map tile.") from exc
    except (URLError, TimeoutError, OSError) as exc:
        raise HTTPException(502, "MapTiler is temporarily unreachable.") from exc
    if len(data) > 2 * 1024 * 1024 or not data.startswith(b"\xff\xd8"):
        raise HTTPException(502, "MapTiler returned an invalid satellite tile.")
    ttl, cache_control = _cache_policy(cache_control, expires, 3600, age)
    return data, "image/jpeg", cache_control, ttl


def _tile_result(style, z, x, y, referer):
    if style == "satellite":
        return _satellite_tile(z, x, y)
    if style == "streets":
        return _street_tile(z, x, y, referer)
    raise HTTPException(404, "Unknown basemap style.")


def _response(data, media, cache_control, state, remaining=None):
    if remaining is not None:
        cache_control = f"private, max-age={max(1, remaining)}"
    return Response(data, media_type=media, headers={
        "Cache-Control": cache_control,
        "X-NIWIS-Map-Cache": state,
        "X-Content-Type-Options": "nosniff",
    })


def tile_response(style, z, x, y, referer=None):
    """Cache successful provider tiles and coalesce simultaneous identical requests."""
    global _cache_bytes
    if not 0 <= z <= 20 or not 0 <= x < 2 ** z or not 0 <= y < 2 ** z:
        raise HTTPException(422, "Invalid map tile coordinates.")
    configured = bool(os.getenv("MAPTILER_API_KEY", "").strip())
    key = (style, configured, z, x, y)
    now = time.monotonic()
    with _tile_lock:
        entry = _tiles.get(key)
        if entry and entry[0] > now:
            _tiles.move_to_end(key)
            return _response(entry[1], entry[2], entry[3], "HIT", int(entry[0] - now))
        if entry:
            _cache_bytes -= len(entry[1])
            del _tiles[key]
        future = _inflight.get(key)
        is_leader = future is None
        if is_leader:
            future = Future()
            _inflight[key] = future

    if not is_leader:
        try:
            data, media, cache_control, ttl = future.result(timeout=15)
        except TimeoutError as exc:
            raise HTTPException(503, "The map tile is still being fetched; retry shortly.") from exc
        return _response(data, media, cache_control, "COALESCED", ttl if ttl > 0 else None)

    try:
        data, media, cache_control, ttl = _tile_result(style, z, x, y, referer)
        if ttl > 0 and len(data) <= _cache_limit:
            with _tile_lock:
                previous = _tiles.pop(key, None)
                if previous:
                    _cache_bytes -= len(previous[1])
                while _tiles and _cache_bytes + len(data) > _cache_limit:
                    _, expired = _tiles.popitem(last=False)
                    _cache_bytes -= len(expired[1])
                _tiles[key] = (time.monotonic() + ttl, data, media, cache_control)
                _cache_bytes += len(data)
        result = (data, media, cache_control, ttl)
        return _response(data, media, cache_control, "MISS")
    except Exception as exc:
        future.set_exception(exc)
        raise
    finally:
        if not future.done():
            future.set_result(result)
        with _tile_lock:
            if _inflight.get(key) is future:
                _inflight.pop(key, None)
