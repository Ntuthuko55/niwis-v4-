"""Audited inventory with live file-presence and size checks."""

import json
from functools import lru_cache

from . import config


@lru_cache(maxsize=1)
def audit_sizes():
    try:
        data = json.loads((config.AUDIT_ROOT / "land_cover.json").read_text(encoding="utf-8"))
        return {entry["file"].replace("\\", "/"): entry["bytes"] for entry in data["inventory"]}
    except (OSError, ValueError, KeyError):
        return {}


@lru_cache(maxsize=1)
def supplemental_manifest():
    try:
        data = json.loads(config.SUPPLEMENTAL_MANIFEST_PATH.read_text(encoding="utf-8"))
        return {entry["file"]: entry for entry in data.get("files", [])}
    except (OSError, ValueError, KeyError):
        return {}


MDB_HUB = "https://spatialhub-mdb-sa.opendata.arcgis.com/"
MDB_WARDS = "https://services7.arcgis.com/oeoyTUJC8HEeYsRB/arcgis/rest/services/MDB_Wards_2026/FeatureServer/0"
MDB_MUNICIPALITIES = "https://services7.arcgis.com/oeoyTUJC8HEeYsRB/arcgis/rest/services/MDB_L_ocal_Municipalities_2026/FeatureServer/0"
MDB_DISTRICTS = "https://services7.arcgis.com/oeoyTUJC8HEeYsRB/arcgis/rest/services/MDB_District_Municipalities_2026/FeatureServer/0"
GRID3_METADATA = "https://www.arcgis.com/sharing/rest/content/items/943ce4a64b0848e39fb08fb7a16ef6ec/info/metadata/metadata.xml?format=default&output=html"
GRID3_EXTENTS = "https://academiccommons.columbia.edu/doi/10.7916/x6vf-4n06/download"
WPdx_ACCESS = "https://www.waterpointdata.org/access-data/"
DWS_NGA = "https://www.dws.gov.za/groundwater/nga.aspx"
DWS_NGA_REGISTER = "https://www.dws.gov.za/NGANet/"
DWS_NGA_CONTACT = "mailto:ngaur@dws.gov.za"
DWS_BOREHOLE_MAP = "https://www.dws.gov.za/groundwater/data/boreholedist.aspx"
DFFE_SANLC = "https://www.dffe.gov.za/egis"
NDA_SCHEMES = "https://ndagis.nda.agric.za/arcgis/rest/services/AGIS/Infrastructure/MapServer/42"
GEOFABRIK_ZAF = "https://download.geofabrik.de/africa/south-africa.html"
DPME_INFORMAL_SETTLEMENTS = "https://dpmegis.dpme.gov.za/arcgis/rest/services/Settlement/MapServer/7"
STATSSA_WARD_ESTIMATES = "https://www.statssa.gov.za/?p=18967"


DEFINITIONS = [
    dict(id="provinces", title="Provincial boundaries", description="Nine provincial polygons for regional context and selection.", status="available", geometry="Polygon / MultiPolygon", record_count=9, source="NDMC boundary service (supplied export)", vintage="Not supplied", issue="Historical boundary vintage has not been independently confirmed.", map_layer="provinces", files=["boundries/south_africa_provinces_wkt.geojson", "boundries/south_africa_provinces_wkt.csv"], source_links=[{"label": "National Disaster Management Centre", "url": "https://www.ndmc.gov.za/"}]),
    dict(id="municipalities", title="Municipal boundaries", description="2026 municipal polygons: 205 local municipalities and eight metros.", status="available", geometry="Polygon / MultiPolygon (generalized display copy)", record_count=213, source="Municipal Demarcation Board (MDB)", vintage="2026", issue="Map geometry is available. The local display copy was generalized by MDB's service at 0.0001 degrees (about 10 m); use the linked MDB feature service for precision-dependent boundary assignment. The older supplied attribute export still has null geometry.", map_layer="municipalities", files=["data/supplemental/administrative/municipalities_2026.geojson", "boundries/LocalMunicipalities2018_Final_4965988329489850293.geojson", "boundries/LocalMunicipalities2018_Final_4965988329489850293.csv"], source_links=[{"label": "MDB 2026 municipal boundaries", "url": MDB_MUNICIPALITIES}, {"label": "MDB Spatial Knowledge Hub", "url": MDB_HUB}]),
    dict(id="districts", title="District boundaries", description="2026 district and metro polygons for administrative reporting.", status="available", geometry="Polygon / MultiPolygon (generalized display copy)", record_count=52, source="Municipal Demarcation Board (MDB)", vintage="2026", issue="Map geometry is available. The local display copy was generalized by MDB's service at 0.0001 degrees (about 10 m); use the linked MDB feature service for precision-dependent boundary assignment. There are 44 districts and eight metros.", map_layer="districts", files=["data/supplemental/administrative/districts_2026.geojson", "boundries/MDB_District_Municipal_Boundary_2018.geojson", "boundries/MDB_District_Municipal_Boundary_2018.csv"], source_links=[{"label": "MDB 2026 district boundaries", "url": MDB_DISTRICTS}, {"label": "MDB Spatial Knowledge Hub", "url": MDB_HUB}]),
    dict(id="wards", title="Ward boundaries", description="2026 ward polygons with municipality associations.", status="available", geometry="Polygon / MultiPolygon (generalized display copy)", record_count=4485, source="Municipal Demarcation Board (MDB)", vintage="2026", issue="Map geometry is available. The local display copy was generalized by MDB's service at 0.0001 degrees (about 10 m); use the linked MDB feature service for precision-dependent boundary assignment. The previous supplied 2020/2021 export has null geometry.", map_layer="wards", files=["data/supplemental/administrative/wards_2026.geojson", "boundries/MDB_Wards_2020_5092533428106744935.geojson", "boundries/MDB_Wards_2020_5092533428106744935.csv"], source_links=[{"label": "MDB 2026 wards", "url": MDB_WARDS}, {"label": "MDB Spatial Knowledge Hub", "url": MDB_HUB}]),
    dict(id="settlements", title="Settlement locations", description="GRID3 2024 settlement extent polygons and their building-count attributes.", status="partial", geometry="MultiPolygon", record_count=447359, source="GRID3 / CIESIN, Columbia University", vintage="2024", issue="Built-up area, small settlement area and hamlet classes do not identify formal or informal status. Building counts are not population. Licensed CC BY-SA 4.0; retain attribution and share-alike terms for derivatives.", map_layer="settlements", files=["data/supplemental/settlements/GRID3_ZAF_settlement_extents_v3_0.gpkg", "settlement boundries/GRID3_ZAF_Settlement_Extents_v3_0_-50302581206100767.csv"], source_links=[{"label": "GRID3 / CIESIN source metadata and licence", "url": GRID3_METADATA}, {"label": "Download GRID3 settlement polygons (473 MB ZIP)", "url": GRID3_EXTENTS}, {"label": "DPME GIS - DHS informal-settlement layer (verify date and coverage)", "url": DPME_INFORMAL_SETTLEMENTS}, {"label": "Stats SA 2022 ward-level population estimates", "url": STATSSA_WARD_ESTIMATES}]),
    dict(id="informal-settlements", title="DPME informal settlements (DHS)", description="Public DHS informal-settlement polygons, shown as a separate reference layer.", status="partial", geometry="Polygon", record_count=2088, source="Department of Planning, Monitoring and Evaluation (DPME) GIS service, layer 7", vintage="Not supplied", issue="The service has no useful dataset description, date or licence metadata. It may not be complete or current; verify with DHS or the relevant municipality before analysis or redistribution.", map_layer="informal-settlements", files=["data/supplemental/settlements/dpme_informal_settlements.geojson"], source_links=[{"label": "DPME GIS informal-settlement layer", "url": DPME_INFORMAL_SETTLEMENTS}]),
    dict(id="roads", title="Road network", description="OSM road-related features; line features are displayed for the current view.", status="available", geometry="Mixed; lines displayed", record_count=2198639, source="OpenStreetMap / Geofabrik · ODbL", vintage="2026-10-15", issue="The source includes non-road and non-drivable features; vehicle restrictions, road condition and tanker suitability are not validated.", map_layer="roads", files=["hotosm_zaf_roads_osm_gpkg/roads.gpkg", "hotosm_zaf_roads_osm_gpkg/roads_full_mapped.csv", "hotosm_zaf_roads_osm_gpkg/metadata.json", "hotosm_zaf_roads_osm_gpkg/config.yaml", "hotosm_zaf_roads_osm_gpkg/README.txt"], source_links=[{"label": "Download current South Africa OSM extract", "url": GEOFABRIK_ZAF}, {"label": "OpenStreetMap licence and attribution", "url": "https://www.openstreetmap.org/copyright"}]),
    dict(id="waterways", title="Rivers & waterways", description="Streams, rivers, canals and drains for surface-water context.", status="available", geometry="LineString", record_count=107714, source="OpenStreetMap-derived supplied export", vintage="Observation date not supplied", issue="The file named boreholes.geojson is another waterways export. Waterways do not establish safe water access or functioning water points.", map_layer="waterways", files=["Waterways/Waterways.gpkg", "Waterways/boreholes.geojson"], source_links=[{"label": "DWS water information services", "url": "https://www.dws.gov.za/"}]),
    dict(id="landcover", title="National land cover", description="Classified 2022 raster, read in small windows and displayed as map tiles.", status="available", geometry="Raster · nominal 20 m source", record_count=None, source="DFFE / SANSA · SANLC 2022", vintage="2022", issue="All land-cover classes are present, not agriculture alone. Use the official 2022 legend for class-based area analysis. Irrigation sites below are points, not scheme-area boundaries.", map_layer="landcover", files=["Land Cover/SA_NLC_2022_GEO.tif"], source_links=[{"label": "DFFE EGIS: SANLC geospatial data and legend", "url": DFFE_SANLC}]),
    dict(id="waterpoints", title="Reported water points (WPdx)", description="Open, third-party reported South African water-point records; not a national asset inventory.", status="partial", geometry="Point", record_count=15, source="Water Point Data Exchange (WPdx-Basic)", vintage="Reports through 2020", issue="Only 15 records were returned for South Africa, with historical reports and some records marked non-functional. Treat these as leads to verify, not current or complete water infrastructure.", map_layer="waterpoints", files=["data/supplemental/waterpoints/wpdx_south_africa.csv"], source_links=[{"label": "WPdx free country data download", "url": WPdx_ACCESS}, {"label": "DWS access-to-water dashboard (aggregated service statistics)", "url": "https://www.dws.gov.za/niwis2/AccessToWaterID"}]),
    dict(id="groundwater", title="Boreholes & springs", description="Groundwater geosites and assessment records.", status="missing", geometry="Points required", record_count=None, source="DWS National Groundwater Archive (NGA)", vintage="Not supplied", issue="Register as an NGA Inquirer, extract the required geosite and assessment fields, then retain source dates and status. The public borehole-distribution map is not a complete point inventory.", map_layer=None, files=[], source_links=[{"label": "DWS NGA overview and data extraction", "url": DWS_NGA}, {"label": "Register for NGA access", "url": DWS_NGA_REGISTER}, {"label": "Contact DWS NGA enquiries", "url": DWS_NGA_CONTACT}, {"label": "DWS stored borehole distribution map", "url": DWS_BOREHOLE_MAP}]),
    dict(id="irrigation-schemes", title="Smallholder irrigation schemes", description="Public point locations with scheme name, build year, farmer count and irrigated area attributes.", status="partial", geometry="Point", record_count=310, source="National Department of Agriculture GIS / AGIS Infrastructure", vintage="Source date not supplied", issue="310 scheme point locations are mapped. Point locations and reported area attributes are not scheme-boundary polygons or proof of current irrigation activity.", map_layer="irrigation", files=["data/supplemental/agriculture/smallholder_irrigation_schemes.geojson"], source_links=[{"label": "Agriculture GIS smallholder irrigation schemes layer", "url": NDA_SCHEMES}]),
    dict(id="agricultural-export", title="Agricultural polygon export", description="Oversized multi-class polygon export excluded from the map and working dataset.", status="excluded", geometry="Incomplete GeoJSON", record_count=None, source="Derived export; conversion provenance unavailable", vintage="Not verified", issue="67.81 GB export appears incomplete and includes non-agricultural classes. Use the compact source raster and official legend instead.", map_layer=None, files=["Land Cover/Agricultural Land.geojson"], source_links=[{"label": "DFFE SANLC source and 2022 legend", "url": DFFE_SANLC}]),
]


INDICATORS = [
    dict(id="administrative-boundaries", title="Administrative boundaries", status="partial", description="Province, district, municipality and ward context.", missing=["Local 2026 map copies are generalized by about 10 m; use the official full-resolution MDB service for precision-dependent assignment"], sources=[{"label": "MDB Spatial Knowledge Hub — official municipal and ward GIS", "url": MDB_HUB}, {"label": "2026 municipal boundaries", "url": MDB_MUNICIPALITIES}, {"label": "2026 district boundaries", "url": MDB_DISTRICTS}, {"label": "2026 ward boundaries", "url": MDB_WARDS}]),
    dict(id="settlement-locations", title="Settlement locations", status="partial", description="Locate communities and map settlement extents.", missing=["The 2,088 DPME polygons are an undated informal-settlement reference layer; verify completeness, date and licence with DHS or the municipality. They do not classify every GRID3 settlement as formal or informal.", "Add population estimates if analysing demand; GRID3 building counts are not population. Stats SA's 2022 estimates use 2020 wards and need a documented crosswalk to 2026 wards."], sources=[{"label": "GRID3 / CIESIN settlement metadata and licence", "url": GRID3_METADATA}, {"label": "Download 2024 settlement polygons", "url": GRID3_EXTENTS}, {"label": "DPME GIS - DHS informal-settlement polygons (local copy included)", "url": DPME_INFORMAL_SETTLEMENTS, "note": "Source metadata provides no meaningful dataset description, date or licence. Verify with DHS or the relevant municipality before analysis or redistribution."}, {"label": "Stats SA ward-level Small Area Population Estimates (2022)", "url": STATSSA_WARD_ESTIMATES, "note": "Estimates use 2020 ward boundaries; create and document a boundary crosswalk before joining them to 2026 MDB wards."}]),
    dict(id="water-proximity", title="Water infrastructure proximity", status="missing", description="Distance from settlements to verified functioning water points.", missing=["Current, geolocated water-asset inventory from DWS, a Water Services Authority or municipalities", "Verify status and location of the 15 historical WPdx reports before using them for proximity analysis"], sources=[{"label": "WPdx-Basic free country downloads", "url": WPdx_ACCESS, "note": "Only 15 South African records were available in the downloaded snapshot."}, {"label": "DWS access-to-water dashboard", "url": "https://www.dws.gov.za/niwis2/AccessToWaterID", "note": "Aggregated population and household service-access statistics, not point locations."}, {"label": "DWS Water Services Knowledge System context", "url": "https://www.dws.gov.za/niwis2/"}]),
    dict(id="road-network", title="Road network", status="partial", description="Access context and future candidate tanker delivery routes.", missing=["Vehicle weight, height and axle restrictions", "Current road-condition and seasonal-access confirmation", "Tanker routes require validation by the responsible road authority"], sources=[{"label": "South Africa OSM extract", "url": GEOFABRIK_ZAF}, {"label": "OpenStreetMap attribution and terms", "url": "https://www.openstreetmap.org/copyright"}, {"label": "SANRAL", "url": "https://www.nra.co.za/", "note": "Request current national-route restrictions and road-condition data from SANRAL and local road authorities."}]),
    dict(id="agricultural-land", title="Agricultural land", status="partial", description="Mapped agricultural cover and irrigation context.", missing=["Use the official SANLC 2022 class legend before calculating agriculture from raster codes", "Scheme point locations do not provide full irrigation-area boundaries or current operational status"], sources=[{"label": "DFFE EGIS — 2022 SANLC raster, change data and legend", "url": DFFE_SANLC}, {"label": "Agriculture GIS smallholder irrigation schemes", "url": NDA_SCHEMES}]),
    dict(id="boreholes-springs", title="Boreholes / springs", status="missing", description="Locate and assess alternative groundwater sources.", missing=["Register with DWS NGA and export borehole and spring geosite coordinates", "Include source status, yield, water quality and assessment dates"], sources=[{"label": "DWS National Groundwater Archive", "url": DWS_NGA}, {"label": "NGA registration portal", "url": DWS_NGA_REGISTER}, {"label": "Contact DWS NGA enquiries", "url": DWS_NGA_CONTACT}, {"label": "Published borehole distribution map (incomplete inventory)", "url": DWS_BOREHOLE_MAP}]),
]


def get_catalog():
    expected = audit_sizes()
    downloaded = supplemental_manifest()
    datasets = []
    for definition in DEFINITIONS:
        item = dict(definition)
        item["files"] = list(definition["files"])
        item["source_links"] = [dict(link) for link in definition["source_links"]]
        present = {}
        for relative in item["files"]:
            path = config.DATA_ROOT / relative
            try:
                if path.is_file():
                    present[relative] = path.stat().st_size
            except OSError:
                pass
        item["size_bytes"] = sum(present.values())
        primary = item["files"][0] if item["files"] else None
        item["audit_status"] = "not_supplied"
        if primary:
            if primary not in present:
                status = "excluded" if item["status"] == "excluded" else "missing"
                item.update(status=status, record_count=None, map_layer=None, audit_status="source_missing")
                item["issue"] = "The primary source file is unavailable in the configured data folder. " + (item["issue"] or "")
            else:
                manifest_entry = downloaded.get(primary)
                expected_bytes = expected.get(primary)
                check_label = "size_matches_audit"
                if manifest_entry:
                    expected_bytes = manifest_entry.get("bytes")
                    check_label = "size_matches_manifest"
                if expected_bytes is not None and expected_bytes != present[primary]:
                    item.update(status="partial" if item["status"] != "excluded" else "excluded", record_count=None, map_layer=None, audit_status="recheck_required")
                    item["issue"] = "The file size no longer matches its source manifest (or audit evidence). Recheck geometry and counts before use. " + (item["issue"] or "")
                elif expected_bytes is None and primary.startswith("data/supplemental/"):
                    item["audit_status"] = "source_present_manifest_unavailable"
                else:
                    item["audit_status"] = check_label if expected_bytes is not None else "source_present"
        datasets.append(item)

    source_files = []
    for folder in config.SOURCE_FOLDERS:
        directory = config.DATA_ROOT / folder
        if directory.is_dir():
            source_files.extend(path for path in directory.rglob("*") if path.is_file())
    total = sum(path.stat().st_size for path in source_files)
    excluded = next(item["size_bytes"] for item in datasets if item["id"] == "agricultural-export")
    indicators = [dict(item, missing=list(item["missing"]), sources=[dict(source) for source in item["sources"]]) for item in INDICATORS]
    mapping = {"administrative-boundaries": ("municipalities", "districts", "wards"), "road-network": ("roads",), "agricultural-land": ("landcover", "irrigation-schemes"), "settlement-locations": ("settlements", "informal-settlements")}
    by_id = {item["id"]: item for item in datasets}
    for indicator in indicators:
        source_ids = mapping.get(indicator["id"], ())
        if source_ids and not any(by_id[source_id]["map_layer"] for source_id in source_ids):
            indicator["status"] = "missing"
            indicator["missing"].insert(0, "Primary local spatial source unavailable or changed since its manifest")
    return {
        "datasets": datasets,
        "indicators": indicators,
        "storage": {"total_bytes": total, "working_bytes": total - excluded, "excluded_bytes": excluded, "file_count": len(source_files)},
        "verification": "Counts come from the source audit or downloaded service metadata. File presence and byte sizes are checked live; a size match is not a content checksum. Supplemental checksums are recorded in data/supplemental/manifest.json.",
    }
