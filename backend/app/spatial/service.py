"""Ally spatial health and catalogue endpoints mounted in the NIWIS API."""

from fastapi import APIRouter, Request, Response

from app.municipal_tariff_service import map_tile_status

from .catalog import get_catalog
from .basemap import tile_response

router = APIRouter(prefix="/spatial-api", tags=["Spatial catalogue"])


@router.get("/health")
def health():
    return {"status": "ok", "service": "NIWIS Spatial GIS", "mode": "read-only", "version": "0.1.0"}


@router.get("/catalog")
def catalog():
    return get_catalog()


@router.get("/summary")
def summary():
    inventory = get_catalog()
    return {
        "storage": inventory["storage"],
        "available_layers": sum(bool(item["map_layer"]) for item in inventory["datasets"]),
        "dataset_count": len(inventory["datasets"]),
        "indicators": inventory["indicators"],
        "verification": inventory["verification"],
    }


@router.get("/basemap/status")
def basemap_status():
    """Describe the existing NIWIS basemap without returning its credential."""
    status = map_tile_status()
    return {
        **status,
        "name": "MapTiler satellite",
        "url": "/spatial-api/basemap/tiles/{z}/{x}/{y}.jpg",
        "attribution": '&copy; <a href="https://www.maptiler.com/copyright/">MapTiler</a> satellite imagery',
        "max_zoom": 20,
        "street_url": "/spatial-api/basemap/streets/{z}/{x}/{y}.png",
        "street_attribution": ('&copy; <a href="https://www.maptiler.com/copyright/">MapTiler</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' if status["configured"] else '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'),
    }


@router.get("/basemap/tiles/{z}/{x}/{y}.jpg", response_class=Response)
def basemap_tile(z: int, x: int, y: int):
    """Reuse NIWIS's server-side satellite proxy for the Spatial workspace."""
    return tile_response("satellite", z, x, y)


@router.get("/basemap/streets/{z}/{x}/{y}.png", response_class=Response)
def street_tile(z: int, x: int, y: int, request: Request):
    """Serve street tiles from the backend, keeping credentials server-side."""
    return tile_response("streets", z, x, y, referer=request.headers.get("referer"))
