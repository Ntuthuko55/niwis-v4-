"""Spatial data paths within the NIWIS workspace."""

import os
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[3]
DATA_ROOT = Path(os.environ.get("NIWIS_SPATIAL_DATA_ROOT", PROJECT_ROOT / "spatial_data")).expanduser().resolve()
AUDIT_ROOT = DATA_ROOT / "audit"
PROVINCES_PATH = DATA_ROOT / "boundries" / "south_africa_provinces_wkt.geojson"
ROADS_PATH = DATA_ROOT / "hotosm_zaf_roads_osm_gpkg" / "roads.gpkg"
WATERWAYS_PATH = DATA_ROOT / "Waterways" / "Waterways.gpkg"
LANDCOVER_PATH = DATA_ROOT / "Land Cover" / "SA_NLC_2022_GEO.tif"
SUPPLEMENTAL_ROOT = DATA_ROOT / "data" / "supplemental"
SUPPLEMENTAL_MANIFEST_PATH = SUPPLEMENTAL_ROOT / "manifest.json"
MUNICIPALITIES_2026_PATH = SUPPLEMENTAL_ROOT / "administrative" / "municipalities_2026.geojson"
DISTRICTS_2026_PATH = SUPPLEMENTAL_ROOT / "administrative" / "districts_2026.geojson"
WARDS_2026_PATH = SUPPLEMENTAL_ROOT / "administrative" / "wards_2026.geojson"
SETTLEMENTS_GPKG_PATH = SUPPLEMENTAL_ROOT / "settlements" / "GRID3_ZAF_settlement_extents_v3_0.gpkg"
INFORMAL_SETTLEMENTS_PATH = SUPPLEMENTAL_ROOT / "settlements" / "dpme_informal_settlements.geojson"
WATERPOINTS_CSV_PATH = SUPPLEMENTAL_ROOT / "waterpoints" / "wpdx_south_africa.csv"
IRRIGATION_SCHEMES_PATH = SUPPLEMENTAL_ROOT / "agriculture" / "smallholder_irrigation_schemes.geojson"

SOURCE_FOLDERS = (
    "boundries", "hotosm_zaf_roads_osm_gpkg", "Land Cover",
    "settlement boundries", "Waterways", "data/supplemental",
)
