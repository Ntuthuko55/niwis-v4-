# Section 20.3 Spatial GIS Variables — file review

Reviewed 9 November 2026 against the supplied spatial GIS source files.

**Recommendation:** keep this as a separate Spatial GIS project. The supplied files can support useful maps and some environmental analysis, but they do not yet support all six proposed indicators. Missing geometry and mislabeled files are more immediate problems than application integration.

The 18 supplied files occupy **70.78 GB (decimal)**. `Agricultural Land.geojson` alone occupies **67.81 GB**, about 95.8% of that total. The existing files other than this export total **2.97 GB**. This is a possible working-set reduction, not space already recovered: no supplied files were deleted or changed.

## What was checked

- Full record scans of all boundary and settlement files, including geometry presence, identifiers, fields and dates.
- Read-only GeoPackage schema, counts, category summaries, coordinate systems and spatial indexes; roads provenance/configuration documents and road CSV headers/sample records.
- All 107,714 features in `boreholes.geojson`, including geometry types and property comparison with the waterways GeoPackage; four geometries compared exactly between formats.
- TIFF metadata, all tile byte-range references and 25 decoded sample tiles. The complete national image was not decompressed.
- Header, end of file and six 4 MiB windows of the 67.81 GB GeoJSON. This was a bounded inspection, not a full parse, feature count or geometry-validity assessment.
- Official dataset descriptions to interpret land-cover and settlement categories.

Polygon topology, road-network connectivity, real-world completeness, operational water-source status and field accuracy were not validated. File timestamps and export dates do not establish observation dates.

## How the files support your six indicators

| Indicator | What is present | How it can help | What is still needed |
|---|---|---|---|
| Administrative boundaries | Actual polygons for nine provinces; names/codes for 213 municipalities, 52 district/metro records and 4,468 wards | Group and map results by province now; finer boundaries would support reporting and spatial assignment to responsible authorities | Municipality, district and ward geometries are entirely absent. Obtain genuine polygon exports and choose a documented boundary vintage |
| Settlement locations | 447,359 GRID3/CIESIN settlement attribute records, with building counts, settlement type and other fields | With geometry, locate settlements and assess which communities are remote from services | Original settlement polygons or suitable point layer. The CSV has no coordinates/WKT. Formal/informal classification requires another source |
| Water infrastructure proximity | No verified water-point inventory | Once settlement geometry and operational water points are available, calculate nearest-source distances and flag poorly served areas | Standpipe, tap, water-point or other relevant asset coordinates, identifiers and service/status information. Rivers cannot substitute for functioning water points |
| Road network | OSM road-related GeoPackage with 2,198,639 features, including 2,072,972 lines | Show access roads and develop candidate delivery routes | Filter drivable lines, build/validate network connectivity and directions, obtain truck access/weight/height and operational restrictions. Current data cannot establish tanker suitability |
| Agricultural land | Compact national 2022 land-cover GeoTIFF and a problematic, oversized polygon export | Extract agricultural classes and calculate mapped cropland/irrigated-class area by region, in hectares or square kilometres | Verified 2022 legend/class selection and appropriate area calculations. Named irrigation schemes, farmer identities, ownership and actual water demand require additional data |
| Borehole / spring locations | No actual borehole/spring point layer. The file named `boreholes.geojson` contains waterways | The waterways help show rivers, streams, canals and drainage context | Genuine DWS NGA or other documented point inventory. Yield, water quality, working condition and access are needed before treating a location as an available alternative supply |

## File-by-file inventory

Sizes below use decimal MB/GB, matching the totals above.

| Folder and file | Size | Verified finding |
|---|---:|---|
| `boundries/LocalMunicipalities2018_Final_4965988329489850293.csv` | 0.037 MB | 213 attribute rows; no coordinates or WKT |
| `boundries/LocalMunicipalities2018_Final_4965988329489850293.geojson` | 0.092 MB | 213 features; every geometry is null |
| `boundries/MDB_District_Municipal_Boundary_2018.csv` | 0.004 MB | 52 attribute rows; no coordinates or WKT |
| `boundries/MDB_District_Municipal_Boundary_2018.geojson` | 0.014 MB | 52 features; every geometry is null |
| `boundries/MDB_Wards_2020_5092533428106744935.csv` | 0.661 MB | 4,468 attribute rows; no coordinates or WKT |
| `boundries/MDB_Wards_2020_5092533428106744935.geojson` | 1.680 MB | 4,468 features; every geometry is null |
| `boundries/south_africa_provinces_wkt.csv` | 16.555 MB | Nine province records with real EPSG:4326 WKT geometry |
| `boundries/south_africa_provinces_wkt.geojson` | 35.516 MB | Nine geometries: seven Polygon and two MultiPolygon; duplicates long WKT text in properties |
| `hotosm_zaf_roads_osm_gpkg/config.yaml` | 0.002 MB | Extract configuration; provenance/schema support, not a separate spatial layer |
| `hotosm_zaf_roads_osm_gpkg/metadata.json` | 0.013 MB | OSM source/snapshot and geometry/field completeness metadata |
| `hotosm_zaf_roads_osm_gpkg/README.txt` | 0.001 MB | Source and licensing notes |
| `hotosm_zaf_roads_osm_gpkg/roads.gpkg` | 1.131 GB | Indexed EPSG:4326 dataset; 2,198,639 non-null geometries; mixed feature types |
| `hotosm_zaf_roads_osm_gpkg/roads_full_mapped.csv` | 1.029 GB | Road attributes and WKT; sampled rows repeat GeoPackage data. Full row-for-row equality not established |
| `Land Cover/Agricultural Land.geojson` | 67.812 GB | Polygonized multi-class land cover; sampled records use a `DN` class field. File ends without collection closing delimiters |
| `Land Cover/SA_NLC_2022_GEO.tif` | 461.265 MB | Compressed, tiled single-band classified national raster; 92,927 × 71,248 pixels; EPSG:4326 |
| `settlement boundries/GRID3_ZAF_Settlement_Extents_v3_0_-50302581206100767.csv` | 58.371 MB | 447,359 attribute rows; no point coordinates or polygon geometry |
| `Waterways/boreholes.geojson` | 130.793 MB | 107,714 LineStrings representing waterways; zero borehole/spring point features |
| `Waterways/Waterways.gpkg` | 99.979 MB | Indexed waterways layer with matching feature properties and sampled geometries |

## Important interpretation and quality issues

### Administrative data

The 213 municipal rows are 205 local municipalities plus eight metros. The 52 district-level rows are 44 districts plus the same eight metros. Do not count metros twice when combining levels.

The municipality and district filenames mention 2018, while their date fields show June 2019. Ward date fields mainly show 2020, with 15 records dated 2021 and 319 blank dates. These are historical vintages, not verified current boundaries. Existing `Shape__Area` and `Shape__Length` attributes cannot recreate a missing boundary.

The province GeoJSON has 423,504 coordinate vertices and repeats about 16.55 million WKT characters in its properties, alongside its actual geometry. A derived display layer can omit that duplicate text and use suitable geometric simplification; analysis should retain adequate detail. The local province source field points to an NDMC ArcGIS service, not explicitly to Stats SA/DWS.

### Settlements

All 447,359 records carry `date=2024` and `source=CIESIN`. Types are 420,119 Hamlet, 25,774 Small Settlement Area and 1,466 Built-up Area. These are settlement-size/type categories, not a formal/informal classification.

The fields are `OBJECTID`, `country`, `iso3`, `building_count`, `building_area`, `type`, `probability`, `date`, `source`, `mgrs_code`, `Shape__Area`, `Shape__Length`. Building counts are not population counts. The CSV does not state area/length units or explain probability. An MGRS-related identifier is not the actual settlement extent and should not silently replace it with an approximate location.

The original GRID3 ZAF v3.0 product includes polygon extents and a separate approximately 100 m settled-grid centroid layer. Recover the intended geospatial layer from that source rather than treating this attributes-only export as complete. [CIESIN metadata](https://www.arcgis.com/sharing/rest/content/items/943ce4a64b0848e39fb08fb7a16ef6ec/info/metadata/metadata.xml?format=default&output=html)

### Roads

The recorded source is OpenStreetMap via Geofabrik, snapshot **2026-10-15**, with ODbL licensing, not SANRAL/DWS. Retain source attribution when publishing derived maps.

Metadata lists 2,072,972 LineStrings, 119,092 points, 6,572 polygons and three multipolygons. Features include paths, footways, traffic signals and street lamps as well as roads. All 2,198,639 records have `adm0_name=Prince Edward Islands (SA)` and `adm0_pcode=ZAF_2`, including mainland features. Recompute spatial administrative membership from trusted boundaries before using these administrative labels.

Surface is missing in 57.12% of records according to supplied metadata; width and smoothness are much less complete. The schema lacks `access`, `hgv`, `maxweight`, `maxheight` and `maxspeed`. Absence of a restriction field is not evidence that a tanker may pass. A road map is useful now; validated delivery routing is further work.

### Land cover and storage

SANLC 2022 is a national **73-class** product derived from 20 m Sentinel-2 imagery collected during January–December 2022. It is not solely agricultural land. [Official SANSA/DFFE metadata](https://saeoss.sansa.org.za/dataset/south_african_national_landcover_2022)

The local TIFF has one classified band, 256 × 256 tiles, Deflate compression and geographic EPSG:4326 coordinates. Its pixel spacing is approximately 0.000179663 degrees; hectares must not be calculated by treating those angular units as metres. All referenced compressed tile ranges were within the file, and 25 selected tiles decoded successfully. No additional image directories or SubIFD overview references were found.

The 67.81 GB GeoJSON has a `FeatureCollection` header, layer name `ally`, CRS84 and polygon features with numerical `DN` values. Samples contain many land-cover classes. It ends inside the collection, with a completed feature object but without the closing feature-array/collection delimiters. It therefore appears to be an incomplete export. Adding closing characters would not prove that all intended features were exported. No full feature count or equivalence with the TIFF was established.

Its size is approximately 147 times the TIFF's size. This is consistent with converting fine-resolution classified raster patches into verbose text polygons; the exact conversion history is not available. Prefer the original raster and derive only the selected agricultural classes/region needed for a particular analysis.

DFFE's published 2022 layer includes irrigated commercial crops, rain-fed/dryland crops and subsistence/small-scale annual crops. Confirm the exact 2022 DN-to-class legend before extracting them. Those categories do not supply irrigation scheme names, farm ownership, irrigation functionality or measured water use. [DFFE 2022 land-cover layer](https://paca.environment.gov.za/par/rest/services/Remote_Sensing_of_Private_Nature_Reserves_Using_Land_Cover/FeatureServer/2)

### Waterways and missing water infrastructure

Both waterways files describe 84,386 streams, 10,378 rivers, 8,570 canals and 4,380 drains. Every feature in `boreholes.geojson` is a LineString; all feature properties matched the GeoPackage by ID, and four sampled geometries matched exactly. This is a misleadingly named waterways export, not NGA groundwater locations.

The waterways extent also includes remote southern island coordinates. Clip/filter to the intended study area rather than assuming all features are on the South African mainland. The GeoPackage modification timestamp is not evidence of the underlying OSM observation date.

No inspected file establishes the locations of functioning public water points, boreholes or springs. Water-source proximity and alternative supply indicators remain unavailable until suitable data is obtained. Distance to a river is a different measure and does not establish safe drinking-water access.

## A practical standalone project

Start with an independent QGIS project for inspection, cleaning and analysis. Reference the original TIFF and indexed GeoPackages. Separate processing keeps the GIS workload independent of NIWIS; compact storage and limited derived outputs control disk use.

1. Obtain complete administrative polygons and GRID3 settlement geometry; keep source, version and coordinate system with each layer.
2. Obtain genuine water-point, borehole and spring data appropriate to the indicators, including status and quality fields where available.
3. Prepare one province or municipality first. Use the original land-cover raster, verify its legend and select agricultural classes. Avoid another national all-class polygon export.
4. Keep vectors in an indexed GeoPackage for local work. Use a dedicated PostGIS database if concurrent access or repeated national spatial queries justify it.
5. Build raster overviews on a derived copy or externally, using categorical-data-appropriate resampling. Overviews improve zoomed-out rendering but add storage. [QGIS raster guidance](https://documentation.qgis.org/3.44/en/docs/user_manual/working_with_raster/raster_properties.html#pyramids-properties)
6. For a separate web dashboard, use a separate GIS API/map service that returns clipped features, map tiles and small summaries. GeoServer/GeoWebCache is one documented option. Tile caching needs a disk quota because storage is already a concern. [GeoWebCache documentation](https://docs.geoserver.org/latest/en/user/geowebcache/index.html)
7. Publish the separate viewer at its own URL. If wanted later, NIWIS can link to it or consume selected summaries without holding the raw GIS datasets.

The working viewer could provide province/municipality filters; settlement, road, land-cover and water-source toggles; settlement-to-source distance in metres/kilometres; mapped agricultural area in hectares; and candidate delivery routes. Features dependent on missing data should visibly remain unavailable until that data exists.

For proximity, define whether distance means straight-line distance, walking distance or drivable network distance. Use geodesic calculations or an appropriate projected CRS for distances, and an appropriate area method for agricultural statistics. A settlement representative point, polygon boundary and road entrance are different origins; document the chosen method.

For example, after the missing layers are supplied, a district planner could find settlements far from confirmed working water points, inspect candidate road access and nearby assessed boreholes, and compare the agricultural footprint. That supports service prioritisation; it does not by itself establish population demand, water availability or tanker feasibility.

## Recommended next step

Repair the data inputs before building the full standalone dashboard: recover missing polygon/settlement geometry, obtain actual water assets and confirm the land-cover legend. A first map can already use the provinces, roads, waterways and raster, clearly showing the unavailable indicators.

Evidence files: `boundaries_settlements.json`, `roads_water.json`, `land_cover.json`. The bounded land-cover inspection can be rerun with `python audit\inspect_land_cover.py` in this environment, which already has Pillow and NumPy installed.

## Supplemental acquisition update - 10 November 2026

The preceding inventory records the state of the supplied files before the public downloads below. The standalone GIS application now reads the supplemental layers from `data/supplemental/`; its runtime catalogue checks their presence and expected file sizes. The SHA-256 values and exact URLs are in `data/supplemental/manifest.json`. Raw source files stay outside Git, and the application uses bounded map-viewport queries rather than loading national layers into the browser at once.

| Section 20.3 input | Downloaded local copy | Coverage and caveat |
| --- | --- | --- |
| Municipal boundaries | `administrative/municipalities_2026.geojson` - 213 polygons | MDB 2026; service-generalized display geometry, approximately 10 m. Full-resolution MDB service is linked in the app for precision-dependent assignment. |
| District boundaries | `administrative/districts_2026.geojson` - 52 polygons | MDB 2026; same display generalization. |
| Ward boundaries | `administrative/wards_2026.geojson` - 4,485 polygons | MDB 2026; same display generalization. |
| Settlement extents | `settlements/GRID3_ZAF_settlement_extents_v3_0.gpkg` - 447,359 polygons, 1,076,064,256 bytes | GRID3 / CIESIN 2024, EPSG:4326, CC BY-SA 4.0. Types describe built-up areas, small settlement areas and hamlets, not formal/informal status; building counts are not population. |
| Informal settlements | `settlements/dpme_informal_settlements.geojson` - 2,088 polygons | DPME GIS / DHS public layer, saved in EPSG:4326. No useful source description, date or licence metadata; displayed separately as an unverified reference, not a complete classification. |
| Reported water points | `waterpoints/wpdx_south_africa.csv` - 15 point records | WPdx-Basic snapshot. These are third-party historical reports; verify location and status before use. |
| Smallholder irrigation schemes | `agriculture/smallholder_irrigation_schemes.geojson` - 310 points | National Department of Agriculture GIS / AGIS Infrastructure. Scheme locations and attributes are supplied, not boundary polygons or current operation status. |

Official source pages: [MDB Spatial Knowledge Hub](https://spatialhub-mdb-sa.opendata.arcgis.com/), [GRID3 settlement metadata and licence](https://www.arcgis.com/sharing/rest/content/items/943ce4a64b0848e39fb08fb7a16ef6ec/info/metadata/metadata.xml?format=default&output=html), [WPdx download access](https://www.waterpointdata.org/access-data/), [NDA AGIS irrigation layer](https://ndagis.nda.agric.za/arcgis/rest/services/AGIS/Infrastructure/MapServer/42), and [DFFE EGIS / SANLC](https://www.dffe.gov.za/egis).

For settlement classification and population, the DPME GIS DHS informal-settlement layer is now present locally as a separate reference layer. Its service has a placeholder description and no dataset date or licence, so confirm its completeness and terms with DHS or municipalities before analysis or redistribution. [Stats SA's 2022 ward-level population estimates](https://www.statssa.gov.za/?p=18967) remain a linked source, not a local dataset; the official download was unavailable during this update. The estimates use 2020 ward boundaries, so a documented crosswalk is needed before joining to the 2026 MDB layer.

## Remaining source requirements

- Obtain a current, geolocated drinking-water infrastructure register from DWS, the relevant Water Services Authorities or municipalities. WPdx's 15 historical records do not establish national operational coverage.
- Register as an NGA Inquirer and export relevant borehole/spring geosite and assessment records from the [DWS National Groundwater Archive](https://www.dws.gov.za/groundwater/nga.aspx) / [NGA registration portal](https://www.dws.gov.za/NGANet/). Retain assessment dates, yield, water-quality and functionality fields where available.
- Confirm the official DFFE/SANLC 2022 class legend before calculating agricultural area. Obtain irrigation boundary polygons and current operational status if those analyses are required.
- For tanker access, supplement OSM roads with vehicle restrictions and current condition/access information from SANRAL and local road authorities, then validate routes.
