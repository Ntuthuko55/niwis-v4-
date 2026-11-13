"""Bounded categorical raster tiles. Original source files are never modified."""

import io
import math
import os
import threading
from functools import lru_cache
from pathlib import Path

import numpy as np
import rasterio
from fastapi import APIRouter, HTTPException, Response
from PIL import Image
from rasterio.enums import Resampling
from rasterio.env import set_proj_data_search_path
from rasterio.transform import from_bounds
from rasterio.vrt import WarpedVRT

from . import config

# Rasterio wheels include the PROJ database matching their GDAL runtime. On this
# machine a PostgreSQL installation sets PROJ_LIB globally to an incompatible
# version. Keep Rasterio's configuration inside this Python process; every
# worker's Rasterio Env must resolve the matching bundled database as well.
_bundled_proj = Path(rasterio.__file__).resolve().parent / "proj_data"
if (_bundled_proj / "proj.db").is_file():
    os.environ["PROJ_DATA"] = str(_bundled_proj)
    os.environ["PROJ_LIB"] = str(_bundled_proj)
    set_proj_data_search_path(str(_bundled_proj))
elif os.environ.get("PROJ_DATA"):
    set_proj_data_search_path(os.environ["PROJ_DATA"])

router = APIRouter(prefix="/spatial-api/land-cover", tags=["Spatial land cover"])
TILE_SIZE = 256
WORLD_HALF = 20037508.342789244
MAX_ZOOM = 17
CACHE_ROOT = config.PROJECT_ROOT / "backend" / ".cache"
_tile_workers = threading.BoundedSemaphore(2)


def source_signature():
    try:
        stat = config.LANDCOVER_PATH.stat()
    except OSError as exc:
        raise HTTPException(503, "The land-cover source raster is unavailable.") from exc
    return str(config.LANDCOVER_PATH), stat.st_size, stat.st_mtime_ns


def overview_path(signature=None):
    path, size, modified = signature or source_signature()
    # Source identity is part of the name; an overview is never silently reused
    # after the source has changed. It is a derived display file, not analysis data.
    import hashlib
    key = hashlib.sha256(f"{path}|{size}|{modified}".encode()).hexdigest()[:16]
    return CACHE_ROOT / f"landcover-preview-{key}.tif"


@lru_cache(maxsize=2)
def source_metadata(signature):
    with rasterio.open(signature[0]) as source:
        palette = source.colormap(1)
        bounds = list(source.bounds)
        return palette, bounds


@router.get("/legend")
def legend():
    signature = source_signature()
    try:
        palette, bounds = source_metadata(signature)
    except (rasterio.errors.RasterioError, ValueError) as exc:
        raise HTTPException(503, "The land-cover colour palette could not be read.") from exc
    return {
        "title": "SANLC 2022 · source class colours",
        "description": "National land cover. DN codes use the source raster palette; class names await the verified 2022 legend. Zoomed-out tiles are a nearest-neighbour display preview, not area statistics.",
        "items": [{"value": value, "label": f"DN {value}", "color": "#{:02x}{:02x}{:02x}".format(*palette[value][:3])} for value in range(1, 74) if value in palette],
        "verified_labels": False,
        "bounds": bounds,
        "preview_ready": overview_path(signature).is_file(),
    }


def tile_bounds(z, x, y):
    span = WORLD_HALF * 2 / (2 ** z)
    west = -WORLD_HALF + x * span
    north = WORLD_HALF - y * span
    return west, north - span, west + span, north


@lru_cache(maxsize=256)
def render_tile(signature, preview_signature, z, x, y):
    source_file = preview_signature[0] if z <= 8 else signature[0]
    palette, source_bounds = source_metadata(signature)
    west, south, east, north = tile_bounds(z, x, y)
    longitude_west, longitude_east = west / WORLD_HALF * 180, east / WORLD_HALF * 180
    latitude_south = math.degrees(math.atan(math.sinh(south / WORLD_HALF * math.pi)))
    latitude_north = math.degrees(math.atan(math.sinh(north / WORLD_HALF * math.pi)))
    if longitude_east < source_bounds[0] or longitude_west > source_bounds[2] or latitude_north < source_bounds[1] or latitude_south > source_bounds[3]:
        rgba = np.zeros((TILE_SIZE, TILE_SIZE, 4), dtype=np.uint8)
    else:
        with _tile_workers, rasterio.Env(GDAL_CACHEMAX=64 * 1024 * 1024):
            with rasterio.open(source_file) as source:
                with WarpedVRT(source, crs="EPSG:3857", transform=from_bounds(west, south, east, north, TILE_SIZE, TILE_SIZE), width=TILE_SIZE, height=TILE_SIZE, resampling=Resampling.nearest, src_nodata=0, nodata=0, warp_mem_limit=32) as vrt:
                    pixels = vrt.read(1)
        colours = np.zeros((256, 4), dtype=np.uint8)
        for value, colour in palette.items():
            if 0 < value < 256:
                colours[value] = colour
        rgba = colours[pixels]
    output = io.BytesIO()
    Image.fromarray(rgba).save(output, format="PNG")
    return output.getvalue()


@router.get("/tiles/{z}/{x}/{y}.png")
def tile(z: int, x: int, y: int):
    if not 0 <= z <= MAX_ZOOM or not (0 <= x < 2 ** z and 0 <= y < 2 ** z):
        raise HTTPException(422, "Tile coordinates must be valid XYZ coordinates at zoom 0–17.")
    signature = source_signature()
    preview = overview_path(signature)
    if z <= 8 and not preview.is_file():
        raise HTTPException(503, "The small land-cover display preview is not prepared. Run python -m app.spatial.prepare_landcover from the backend directory, or use backend/start.ps1.")
    preview_signature = (str(preview), preview.stat().st_mtime_ns) if preview.is_file() else ("", 0)
    try:
        data = render_tile(signature, preview_signature, z, x, y)
    except (OSError, ValueError, rasterio.errors.RasterioError) as exc:
        raise HTTPException(503, "This land-cover tile could not be read from the source raster.") from exc
    return Response(data, media_type="image/png", headers={"Cache-Control": "private, max-age=3600", "X-Ally-Raster": "display-preview" if z <= 8 else "source-raster"})
