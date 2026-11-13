"""Bounded, read-only viewport queries for local GIS layers."""

import csv
import json
import math
import sqlite3
import struct
import time
from functools import lru_cache
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query
from shapely import STRtree, from_wkb, get_num_coordinates, make_valid, union_all
from shapely.errors import GEOSException
from shapely.geometry import Point, box, mapping, shape

from . import config

router = APIRouter(prefix="/spatial-api", tags=["Spatial map layers"])
MAX_GEOMETRY_BYTES = 2_000_000
MAX_VERTICES = 100_000
MAX_FEATURES = 2_000


def parse_bbox(value: str):
    try:
        coordinates = tuple(float(part) for part in value.split(","))
    except (TypeError, ValueError):
        raise HTTPException(422, "bbox must contain west,south,east,north numeric coordinates.")
    if len(coordinates) != 4 or not all(math.isfinite(v) for v in coordinates):
        raise HTTPException(422, "bbox must contain four finite coordinates.")
    west, south, east, north = coordinates
    if not (-180 <= west < east <= 180 and -90 <= south < north <= 90):
        raise HTTPException(422, "bbox must be ordered west < east and south < north within longitude/latitude bounds.")
    return coordinates


def gpkg_wkb(blob: bytes):
    if not blob or len(blob) < 13 or blob[:2] != b"GP":
        raise ValueError("Invalid GeoPackage geometry header")
    flags = blob[3]
    envelope = (flags >> 1) & 7
    sizes = {0: 0, 1: 32, 2: 48, 3: 48, 4: 64}
    if envelope not in sizes or flags & 0x10:
        raise ValueError("Empty or unsupported GeoPackage geometry")
    offset = 8 + sizes[envelope]
    if len(blob) < offset + 5:
        raise ValueError("Truncated GeoPackage geometry")
    return blob[offset:]


def gpkg_geometry_type(blob):
    try:
        data = gpkg_wkb(blob)
        code = struct.unpack("<I" if data[0] == 1 else ">I", data[1:5])[0]
        return int(code & 0x0FFFFFFF) % 1000
    except (ValueError, TypeError, struct.error):
        return 0


@lru_cache(maxsize=2)
def _provinces(path_text: str, modified_ns: int, size: int):
    document = json.loads(Path(path_text).read_text(encoding="utf-8"))
    features = []
    for feature in document.get("features", []):
        if feature.get("geometry") is None:
            continue
        geometry = shape(feature["geometry"])
        if geometry.geom_type not in {"Polygon", "MultiPolygon"} or geometry.is_empty:
            continue
        properties = feature.get("properties", {})
        simplified = geometry.simplify(0.003, preserve_topology=True)
        features.append({
            "type": "Feature",
            "id": properties.get("province_code"),
            "properties": {"province": properties.get("province"), "province_code": properties.get("province_code"), "source": "NDMC supplied export", "layer": "provinces"},
            "geometry": mapping(simplified),
            "bbox": list(geometry.bounds),
        })
    return {"type": "FeatureCollection", "features": features, "metadata": {"returned": len(features), "source": "NDMC supplied export", "simplified": True, "message": "Simplified display geometry; boundary vintage not independently confirmed."}}


@router.get("/provinces")
def provinces():
    try:
        stat = config.PROVINCES_PATH.stat()
        return _provinces(str(config.PROVINCES_PATH), stat.st_mtime_ns, stat.st_size)
    except (OSError, ValueError, KeyError, GEOSException) as exc:
        raise HTTPException(503, "Provincial boundary data is unavailable or unreadable.") from exc


GEOJSON_SPECS = {
    "municipalities": dict(path=config.MUNICIPALITIES_2026_PATH, min_zoom=6, max_span=40, source="MDB 2026 municipal boundaries; display copy generalized at 0.0001 degrees (~10 m)", display_note="Local boundary geometry is generalized for display; use the MDB source for precision-dependent assignment."),
    "districts": dict(path=config.DISTRICTS_2026_PATH, min_zoom=5, max_span=60, source="MDB 2026 district boundaries; display copy generalized at 0.0001 degrees (~10 m)", display_note="Local boundary geometry is generalized for display; use the MDB source for precision-dependent assignment."),
    "wards": dict(path=config.WARDS_2026_PATH, min_zoom=8, max_span=10, source="MDB 2026 ward boundaries; display copy generalized at 0.0001 degrees (~10 m)", display_note="Local boundary geometry is generalized for display; use the MDB source for precision-dependent assignment."),
    "irrigation": dict(path=config.IRRIGATION_SCHEMES_PATH, min_zoom=5, max_span=40, source="National Department of Agriculture GIS / AGIS Infrastructure smallholder irrigation schemes"),
    "informal-settlements": dict(path=config.INFORMAL_SETTLEMENTS_PATH, min_zoom=8, max_span=10, source="DPME GIS - Informal Settlements (DHS); source date and licence not supplied in service metadata", display_note="Reference layer only. Coverage, date and licence are undocumented; verify with DHS or the municipality before analysis."),
}

GPKG_SPECS = {
    "roads": dict(path=config.ROADS_PATH, table="roads", index="rtree_roads_geom", id_column="fid", geometry_column="geom", columns=["fid", "id", "name", "highway", "surface", "oneway", "bridge"], min_zoom=10, max_span=8, family="line", source="OpenStreetMap / Geofabrik, 2026-10-15 · ODbL"),
    "waterways": dict(path=config.WATERWAYS_PATH, table="southafrica__gis_osm_waterways_free", index="rtree_southafrica__gis_osm_waterways_free_geom", id_column="fid", geometry_column="geom", columns=["fid", "osm_id", "name", "fclass", "width"], min_zoom=8, max_span=20, family="line", source="OpenStreetMap-derived supplied waterways export"),
    "settlements": dict(path=config.SETTLEMENTS_GPKG_PATH, table="GRID3_ZAF_Settlement_Extents_v3_0", index="rtree_GRID3_ZAF_Settlement_Extents_v3_0_Shape", id_column="OBJECTID", geometry_column="Shape", columns=["OBJECTID", "country", "iso3", "building_count", "building_area", "type", "probability", "date", "source", "mgrs_code"], min_zoom=8, max_span=8, family="polygon", source="GRID3 ZAF Settlement Extents v3.0 · CIESIN / Columbia University · CC BY-SA 4.0"),
}

POINT_SPECS = {
    "waterpoints": dict(path=config.WATERPOINTS_CSV_PATH, min_zoom=5, max_span=40, source="WPdx-Basic South Africa export; 15 third-party reports, observation dates through 2020"),
}


@lru_cache(maxsize=8)
def _indexed_geojson(path_text: str, modified_ns: int, size: int):
    document = json.loads(Path(path_text).read_text(encoding="utf-8-sig"))
    features = []
    geometries = []
    for feature in document.get("features", []):
        geometry_json = feature.get("geometry")
        if geometry_json is None:
            continue
        try:
            geometry = shape(geometry_json)
            if not geometry.is_valid:
                # The supplied generalized MDB copies contain self-intersecting
                # rings. Repair a display geometry in memory so clipping does
                # not silently omit a district; never rewrite the source file.
                polygonal = geometry.geom_type in {"Polygon", "MultiPolygon"}
                geometry = make_valid(geometry)
                if polygonal and geometry.geom_type == "GeometryCollection":
                    geometry = union_all([part for part in geometry.geoms if part.geom_type in {"Polygon", "MultiPolygon"}])
                feature = dict(feature, properties=dict(feature.get("properties") or {}, display_geometry_repaired=True))
            if geometry.is_empty:
                continue
            features.append(feature)
            geometries.append(geometry)
        except (TypeError, GEOSException):
            continue
    return tuple(features), tuple(geometries), STRtree(geometries)


@lru_cache(maxsize=2)
def _waterpoints(path_text: str, modified_ns: int, size: int):
    features = []
    with Path(path_text).open("r", encoding="utf-8-sig", newline="") as source:
        for row in csv.DictReader(source):
            try:
                longitude = float(row["lon_deg"])
                latitude = float(row["lat_deg"])
            except (KeyError, TypeError, ValueError):
                continue
            if not (-180 <= longitude <= 180 and -90 <= latitude <= 90):
                continue
            properties = {
                "report_id": row.get("row_id"),
                "reported_by": row.get("source"),
                "assessment_date": row.get("report_date"),
                "reported_status": row.get("status_clean"),
                "water_present_when_assessed": row.get("status_id"),
                "water_source": row.get("water_source_clean") or row.get("water_source"),
                "technology": row.get("water_tech_clean") or row.get("water_tech"),
                "province": row.get("clean_adm1"),
                "district": row.get("clean_adm2"),
                "dataset": row.get("dataset_title"),
                "source_url": row.get("data_lnk"),
            }
            features.append({"type": "Feature", "id": row.get("row_id"), "properties": properties, "geometry": mapping(Point(longitude, latitude))})
    return tuple(features)


def layer_spec(layer: str):
    if layer in GEOJSON_SPECS:
        return dict(GEOJSON_SPECS[layer], kind="geojson")
    if layer in GPKG_SPECS:
        return dict(GPKG_SPECS[layer], kind="gpkg")
    if layer in POINT_SPECS:
        return dict(POINT_SPECS[layer], kind="points")
    raise HTTPException(404, "Unknown vector layer.")


def _query_local_geojson(layer, spec, bounds, zoom, limit):
    path = spec["path"]
    stat = path.stat()
    features, geometries, tree = _indexed_geojson(str(path), stat.st_mtime_ns, stat.st_size)
    clip = box(*bounds)
    candidate_indices = sorted(int(index) for index in tree.query(clip))
    tolerance = 360 / (2 ** zoom) / 256 * 0.6
    output = []
    vertices = 0
    skipped = 0
    truncated = False
    for index in candidate_indices:
        feature = features[index]
        geometry = geometries[index]
        if not geometry.intersects(clip):
            continue
        try:
            display_geometry = geometry.intersection(clip).simplify(tolerance, preserve_topology=True)
            if display_geometry.is_empty:
                continue
            count = int(get_num_coordinates(display_geometry))
            if count > 5000 or vertices + count > MAX_VERTICES:
                skipped += 1
                truncated = True
                continue
            if len(output) >= limit:
                truncated = True
                break
            vertices += count
            output.append({"type": "Feature", "id": feature.get("id"), "properties": dict(feature.get("properties") or {}, layer=layer), "geometry": mapping(display_geometry)})
        except GEOSException:
            skipped += 1
    return output, truncated, skipped


def _query_points(layer, spec, bounds, limit):
    path = spec["path"]
    stat = path.stat()
    west, south, east, north = bounds
    candidates = _waterpoints(str(path), stat.st_mtime_ns, stat.st_size)
    selected = [feature for feature in candidates if west <= feature["geometry"]["coordinates"][0] <= east and south <= feature["geometry"]["coordinates"][1] <= north]
    return [dict(feature, properties=dict(feature["properties"], layer=layer)) for feature in selected[:limit]], len(selected) > limit, 0


def _query_gpkg(layer, spec, bounds, zoom, limit):
    path = spec["path"]
    if not path.is_file():
        raise HTTPException(503, "The requested layer's source file is unavailable.")
    west, south, east, north = bounds
    columns = ", ".join(f'f."{column}"' for column in spec["columns"])
    geometry_column = spec["geometry_column"]
    sql = f'''SELECT {columns}, f."{geometry_column}" AS geom FROM "{spec['index']}" r
              JOIN "{spec['table']}" f ON f."{spec['id_column']}" = r.id
              WHERE r.minx <= ? AND r.maxx >= ? AND r.miny <= ? AND r.maxy >= ?
              AND length(f."{geometry_column}") <= ? LIMIT ?'''
    connection = None
    try:
        connection = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True, timeout=5)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA query_only=ON")
        deadline = time.monotonic() + 8
        connection.set_progress_handler(lambda: int(time.monotonic() > deadline), 1000)
        rows = connection.execute(sql, (east, west, north, south, MAX_GEOMETRY_BYTES, limit + 1)).fetchall()
    except sqlite3.Error as exc:
        raise HTTPException(503, "The spatial query could not complete. Try a smaller area and check the source GeoPackage.") from exc
    finally:
        if connection is not None:
            connection.close()
    truncated = len(rows) > limit
    clip = box(west, south, east, north)
    tolerance = 360 / (2 ** zoom) / 256 * 0.6
    expected_type = "line" if spec["family"] == "line" else "polygon"
    output = []
    vertices = 0
    skipped = 0
    for row in rows[:limit]:
        blob = row["geom"]
        if len(blob) > MAX_GEOMETRY_BYTES:
            skipped += 1
            continue
        try:
            geometry = from_wkb(gpkg_wkb(blob))
            if expected_type == "line" and geometry.geom_type not in {"LineString", "MultiLineString"}:
                continue
            if expected_type == "polygon" and geometry.geom_type not in {"Polygon", "MultiPolygon"}:
                continue
            if not geometry.intersects(clip):
                continue
            display_geometry = geometry.intersection(clip).simplify(tolerance, preserve_topology=True)
            if display_geometry.is_empty:
                continue
            count = int(get_num_coordinates(display_geometry))
            if count > 5000 or vertices + count > MAX_VERTICES:
                skipped += 1
                truncated = True
                continue
            vertices += count
            properties = {column: row[column] for column in spec["columns"] if column != "Shape"}
            properties["layer"] = layer
            output.append({"type": "Feature", "id": row[spec["id_column"]], "properties": properties, "geometry": mapping(display_geometry)})
        except (ValueError, TypeError, GEOSException):
            skipped += 1
    return output, truncated, skipped


@router.get("/layers/{layer}/features")
def features(layer: str, bbox: str, zoom: int = Query(default=10, ge=0, le=22), limit: int = Query(default=1200, ge=1, le=MAX_FEATURES)):
    spec = layer_spec(layer)
    bounds = parse_bbox(bbox)
    west, south, east, north = bounds
    metadata = {"returned": 0, "limit": limit, "truncated": False, "min_zoom": spec["min_zoom"], "message": "", "source": spec["source"], "display_note": spec.get("display_note"), "skipped": 0, "bbox": list(bounds)}
    result = {"type": "FeatureCollection", "features": [], "metadata": metadata}
    path = spec["path"]
    if not path.is_file():
        raise HTTPException(503, "The requested layer's source file is unavailable.")
    if zoom < spec["min_zoom"]:
        metadata["message"] = f"Zoom to level {spec['min_zoom']} or closer to load {layer}."
        return result
    if east - west > spec["max_span"] or north - south > spec["max_span"]:
        raise HTTPException(422, "The requested area is too large. Zoom in to query this layer.")
    try:
        if spec["kind"] == "geojson":
            output, truncated, skipped = _query_local_geojson(layer, spec, bounds, zoom, limit)
        elif spec["kind"] == "points":
            output, truncated, skipped = _query_points(layer, spec, bounds, limit)
        else:
            output, truncated, skipped = _query_gpkg(layer, spec, bounds, zoom, limit)
    except (OSError, ValueError, KeyError, json.JSONDecodeError, GEOSException) as exc:
        raise HTTPException(503, "The local GIS layer is unavailable or unreadable.") from exc
    result["features"] = output
    metadata["returned"] = len(output)
    metadata["truncated"] = truncated
    metadata["skipped"] = skipped
    if truncated:
        metadata["message"] = f"Showing a bounded subset of {metadata['returned']:,} features. Zoom in for more detail."
    elif not output:
        metadata["message"] = "No features were found in this view."
    else:
        metadata["message"] = f"{metadata['returned']:,} features in the current view."
    if skipped:
        metadata["message"] += f" {skipped:,} complex or unreadable features were omitted."
    if layer in {"municipalities", "districts", "wards"}:
        metadata["precision_note"] = "MDB supplied the local copy generalized at 0.0001 degrees (~10 m) for display. Use the linked full-resolution MDB service for precision-dependent boundary analysis."
    return result
