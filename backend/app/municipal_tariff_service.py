"""Municipal water tariff and water-quality cost source tables.

The database contains municipality names but no municipality codes or geometry.
Map joins are therefore performed in the browser only when a source name matches
one current MDB municipality unambiguously. National rows stay outside the map.
"""
from __future__ import annotations

import math
import os
import re
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import quote, urlencode

from fastapi import APIRouter, HTTPException
from starlette.responses import Response

from app.dashboard_loader import dashboard_cache
from app.supabase_source import SupabaseSourceError, _request_page, _settings

router = APIRouter(prefix='/municipal-tariffs', tags=['Municipal Tariffs and Water Quality Costs'])

TABLES = ('19_1_raw_water_tariff_master', '19_2_municipal_water_tariff_master', '19_3_water_quality_cost_master')
DATASETS = {
    'raw': {
        'label': 'Raw water tariffs',
        'description': 'Source-reported abstraction charges, surcharges, recovery charges and related water-supply indicators.',
        'default_metric': 'raw_tariff',
        'table_index': 0,
        'metrics': (
            ('raw_tariff', 'Raw water abstraction tariff', 'R/m³', 'Raw water abstraction tariff (R/m³)', 'numeric'),
            ('drought_surcharge', 'Drought-season surcharge', 'R/m³', 'Drought-season surcharge (R/m³)', 'numeric'),
            ('capital_recovery', 'Capital investment recovery charge', 'R/m³', 'Capital investment recovery charge (R/m³)', 'numeric'),
            ('reservoir_storage', 'Reservoir storage scarcity trigger', '% FSC', 'Reservoir storage % (scarcity trigger) (% FSC)', 'numeric'),
            ('interbasin_cost', 'Inter-basin transfer cost component', 'R/Ml', 'Inter-basin transfer cost component (R/Ml)', 'numeric'),
            ('energy_cost', 'Energy cost per Ml transferred', 'R/Ml', 'Energy cost per Ml transferred (R/Ml)', 'numeric'),
            ('mar_demand_ratio', 'MAR demand ratio', 'source ratio', 'MAR_demand_ratio', 'numeric'),
            ('spi_spei_category', 'SPI/SPEI pricing category', 'D0–D4 category', 'SPI/SPEI category (D0–D4 affects pricing) (dimensionless)', 'category'),
        ),
    },
    'municipal': {
        'label': 'Municipal water tariffs',
        'description': 'Municipal tariff blocks, free basic-water allocation, treatment and operating costs, losses and demand-planning values.',
        'default_metric': 'block_tariff',
        'table_index': 1,
        'metrics': (
            ('block_tariff', 'Block tariff rate', 'R/kL per consumption block', 'Block tariff rates (R/kL per consumption block)', 'numeric'),
            ('free_allocation', 'Free basic-water allocation', 'L/household/month', '6 kL/month free allocation status (L/household/month)', 'numeric'),
            ('treatment_cost', 'Average treatment cost', 'R/kL', 'Average treatment cost per kL produced (R/kL)', 'numeric'),
            ('electricity_cost', 'Electricity cost for pumping and treatment', 'R/kWh', 'Electricity cost for pumping and treatment (R/kWh)', 'numeric'),
            ('non_revenue_water', 'Non-revenue water', '% of production', 'Non-revenue water reducing revenue efficiency (% of production)', 'numeric'),
            ('infrastructure_cost', 'Infrastructure replacement and maintenance', 'R/year', 'Infrastructure replacement and maintenance cost (R/year)', 'numeric'),
            ('demand_projection', 'Demand projection for tariff planning', 'capita', 'Demand projections for tariff planning (capita)', 'numeric'),
            ('cpi_ppi', 'CPI/PPI operational-cost input', '%', 'CPI and PPI affecting operational costs (%)', 'numeric'),
        ),
    },
    'quality': {
        'label': 'Water quality costs',
        'description': 'Source-water, chemical dosing, algal-bloom treatment and wastewater-compliance cost fields.',
        'default_metric': 'chemical_dosing',
        'table_index': 2,
        'metrics': (
            ('source_water', 'Source water: turbidity and contamination', 'unit not supplied', 'Source water (Turbidity and contamination)', 'numeric'),
            ('chemical_dosing', 'Chemical dosing cost', 'unit not supplied', 'Chemical dosing cost', 'numeric'),
            ('algal_bloom', 'Algal-bloom treatment', 'unit not supplied', 'Algal bloom treatment', 'numeric'),
            ('compliance_penalty', 'WWTW compliance penalty', 'unit not supplied', 'WWTW compliance penalty', 'numeric'),
        ),
    },
}

DROUGHT_CATEGORIES = {'D0', 'D1', 'D2', 'D3', 'D4'}


def _configured_tables() -> tuple[str, ...]:
    raw = os.getenv('NIWIS_SUPABASE_TABLES_MODULE_19', '').strip()
    names = tuple(name.strip() for name in raw.split(',')) if raw else TABLES
    if len(names) != 3 or any(not re.fullmatch(r'[A-Za-z0-9_. ]+', name) for name in names):
        raise SupabaseSourceError('NIWIS_SUPABASE_TABLES_MODULE_19 requires the three section 19 relation names in order.')
    return names


@dashboard_cache('municipal-tariffs.source')
def _read_table(base: str, key: str, table: str) -> list[dict]:
    url = f'{base}/rest/v1/{quote(table, safe="._")}?{urlencode({"select": "*", "order": "Region.asc,Standardized_Year.asc"})}'
    rows, content_range = _request_page(url, key, 0, 999, True)
    if not rows:
        raise SupabaseSourceError(f"Municipal tariff relation '{table}' has no observations.")
    try:
        total = int((content_range or '').rsplit('/', 1)[1])
    except (ValueError, IndexError) as exc:
        raise SupabaseSourceError(f"Municipal tariff relation '{table}' did not return a complete row count.") from exc
    page_size = len(rows)
    offsets = list(range(page_size, total, page_size))
    if offsets:
        with ThreadPoolExecutor(max_workers=4) as pool:
            pages = list(pool.map(lambda offset: _request_page(url, key, offset, min(total - 1, offset + page_size - 1))[0], offsets))
        for offset, page in zip(offsets, pages):
            if len(page) != min(page_size, total - offset):
                raise SupabaseSourceError(f"Municipal tariff relation '{table}' returned an incomplete page. Please retry.")
            rows.extend(page)
    if len(rows) != total:
        raise SupabaseSourceError(f"Municipal tariff relation '{table}' returned an incomplete dataset.")
    return rows


def _missing(value) -> bool:
    return value is None or (isinstance(value, str) and value.strip().casefold() in {'', 'null', 'none', 'nan'})


def _number(value) -> float | None:
    if _missing(value) or isinstance(value, bool):
        return None
    text = str(value).strip().replace('\u00c2', '').replace('\ufffd', '').replace('\u00a0', '').replace('\u202f', '').replace('\u2212', '-')
    text = re.sub(r'[\s,]', '', text).replace('%', '')
    try:
        number = float(text)
    except (TypeError, ValueError, OverflowError):
        return None
    return number if math.isfinite(number) else None


def _year(value) -> int | None:
    number = _number(value)
    if number is None or not number.is_integer():
        return None
    return int(number)


def _metric_rows(kind: str) -> list[dict]:
    return [
        {'key': key, 'label': label, 'unit': unit, 'source_column': column, 'type': metric_type}
        for key, label, unit, column, metric_type in DATASETS[kind]['metrics']
    ]


def _prepare(rows: list[dict], kind: str, table: str) -> dict:
    metric_defs = DATASETS[kind]['metrics']
    if not rows:
        raise SupabaseSourceError(f"Municipal tariff relation '{table}' has no observations.")
    available = set(rows[0])
    required = {'Region', 'Standardized_Year', 'Time Frame', *(metric[3] for metric in metric_defs)}
    absent = sorted(required - available)
    if absent:
        raise SupabaseSourceError(f"Municipal tariff relation '{table}' is missing expected source columns: {', '.join(absent)}")

    parsed = []
    invalid_keys = 0
    seen = set()
    audit = {metric[0]: {'usable': 0, 'missing': 0, 'invalid': 0} for metric in metric_defs}
    for source in rows:
        region = str(source.get('Region') or '').strip()
        year = _year(source.get('Standardized_Year'))
        if not region or year is None:
            invalid_keys += 1
            continue
        identity = (region.casefold(), year)
        if identity in seen:
            raise SupabaseSourceError(f"Municipal tariff relation '{table}' contains duplicate region/year rows; aggregation stopped.")
        seen.add(identity)

        values = {}
        for metric_key, _label, unit, column, metric_type in metric_defs:
            value = source.get(column)
            if _missing(value):
                parsed_value = None
                audit[metric_key]['missing'] += 1
            elif metric_type == 'category':
                category = str(value).strip().upper()
                if category in DROUGHT_CATEGORIES:
                    parsed_value = category
                    audit[metric_key]['usable'] += 1
                else:
                    parsed_value = None
                    audit[metric_key]['invalid'] += 1
            else:
                parsed_value = _number(value)
                if parsed_value is None or (unit in {'%', '% of production', '% FSC'} and not 0 <= parsed_value <= 100):
                    parsed_value = None
                    audit[metric_key]['invalid'] += 1
                else:
                    audit[metric_key]['usable'] += 1
            values[metric_key] = parsed_value
        parsed.append({
            'region': region,
            'year': year,
            'source_period': str(source.get('Time Frame') or '').strip(),
            'values': values,
        })

    if not parsed:
        raise SupabaseSourceError(f"Municipal tariff relation '{table}' has no valid region/year rows.")
    regions = sorted({row['region'] for row in parsed if row['region'].casefold() != 'national'}, key=str.casefold)
    years = sorted({row['year'] for row in parsed})
    national_years = {row['year'] for row in parsed if row['region'].casefold() == 'national'}
    return {
        'rows': parsed,
        'years': years,
        'regions': regions,
        'metrics': _metric_rows(kind),
        'table': table,
        'audit': {
            'source_rows': len(rows),
            'valid_rows': len(parsed),
            'invalid_region_or_year_rows': invalid_keys,
            'municipality_name_count': len(regions),
            'national_year_count': len(national_years),
            'metrics': audit,
        },
    }


def _load(kind: str) -> dict:
    if kind not in DATASETS:
        raise HTTPException(400, 'Choose raw, municipal or quality data.')
    base, key, _ = _settings()
    table = _configured_tables()[DATASETS[kind]['table_index']]
    return _prepare(_read_table(base, key, table), kind, table)


def _summary(kind: str, prepared: dict) -> dict:
    config = DATASETS[kind]
    return {
        'key': kind,
        'label': config['label'],
        'description': config['description'],
        'default_metric': config['default_metric'],
        'table': prepared['table'],
        'years': prepared['years'],
        'latest_year': prepared['years'][-1],
        'municipality_name_count': prepared['audit']['municipality_name_count'],
        'national_year_count': prepared['audit']['national_year_count'],
        'metrics': prepared['metrics'],
        'audit': prepared['audit'],
    }


@router.get('/metadata')
def metadata():
    """Return table fields, reporting years and source-data quality counts."""
    try:
        with ThreadPoolExecutor(max_workers=3) as pool:
            prepared = list(pool.map(_load, DATASETS.keys()))
        datasets = {kind: _summary(kind, item) for kind, item in zip(DATASETS, prepared)}
        return {
            'datasets': datasets,
            'boundaries': {
                'label': 'MDB Local Municipalities 2026',
                'source_url': 'https://spatialhub-mdb-sa.opendata.arcgis.com/datasets/82c7a6d178454ddcb4dc1ef6bf2a4303_0/explore',
                'geojson': '/sa_local_municipalities_2026_simplified.geojson',
                'feature_count': 213,
                'matching': 'Normalized municipality names plus a documented city-name override for Emalahleni to eMalahleni, Mpumalanga (MP312).',
                'city_name_crosswalk': [{'source_region': 'Emalahleni', 'municipality': 'eMalahleni, Mpumalanga', 'municipality_code': 'MP312'}],
            },
            'notes': [
                'National records are shown separately and are never drawn as municipality polygons.',
                'The database has region names but no municipality codes. The city-name crosswalk maps source region Emalahleni to eMalahleni, Mpumalanga (MP312), the municipality associated with the eMalahleni city name.',
                'Historic values use current 2026 municipal boundaries because the source tables do not include boundary-version codes.',
                'Municipalities with a valid value for the selected field and year are coloured; areas without a value retain grey reference boundaries and are not treated as zero.',
                'When a source name matches more than one official municipality, the same source value is shown on each matching polygon and the ambiguity is identified.',
                'Water-quality cost fields do not provide units; they are shown as source values without an inferred unit.',
            ],
        }
    except SupabaseSourceError as exc:
        raise HTTPException(503, str(exc)) from exc


@router.get('/dashboard')
def dashboard(dataset: str = 'raw', year: int | None = None):
    """Return one reporting year, keeping source rows and National separate."""
    try:
        prepared = _load(dataset)
    except SupabaseSourceError as exc:
        raise HTTPException(503, str(exc)) from exc
    selected_year = prepared['years'][-1] if year is None else year
    if selected_year not in prepared['years']:
        raise HTTPException(400, 'Choose a year available in this database table.')
    selected = [row for row in prepared['rows'] if row['year'] == selected_year]
    municipality_rows = [row for row in selected if row['region'].casefold() != 'national']
    national_rows = [row for row in selected if row['region'].casefold() == 'national']
    return {
        'dataset': dataset,
        'label': DATASETS[dataset]['label'],
        'table': prepared['table'],
        'year': selected_year,
        'years': prepared['years'],
        'metrics': prepared['metrics'],
        'rows': municipality_rows,
        'national': national_rows[0] if national_rows else None,
        'coverage': {
            'source_municipality_rows': len(municipality_rows),
            'national_row_available': bool(national_rows),
            'usable_by_metric': {key: sum(row['values'][key] is not None for row in municipality_rows) for key, *_ in DATASETS[dataset]['metrics']},
        },
        'audit': prepared['audit'],
    }


@router.get('/analytics')
def analytics(dataset: str = 'municipal', region: str = 'National'):
    """Return per-indicator histories and year/indicator source coverage for dashboard views."""
    try:
        prepared = _load(dataset)
    except SupabaseSourceError as exc:
        raise HTTPException(503, str(exc)) from exc

    selected_region = str(region or '').strip()
    if not selected_region:
        raise HTTPException(400, 'Choose a source region for the historical charts.')
    region_rows = {
        row['year']: row for row in prepared['rows']
        if row['region'].strip().casefold() == selected_region.casefold()
    }
    if not region_rows:
        raise HTTPException(404, 'No yearly records were found for this source region.')

    source_rows_by_year = {}
    for row in prepared['rows']:
        if row['region'].casefold() != 'national':
            source_rows_by_year.setdefault(row['year'], []).append(row)

    coverage_by_year = []
    for year in prepared['years']:
        source_rows = source_rows_by_year.get(year, [])
        coverage_by_year.append({
            'year': year,
            'source_region_rows': len(source_rows),
            'valid_by_metric': {
                metric['key']: sum(row['values'][metric['key']] is not None for row in source_rows)
                for metric in prepared['metrics']
            },
        })

    indicators = []
    for metric in prepared['metrics']:
        points = []
        for year in prepared['years']:
            row = region_rows.get(year)
            points.append({
                'year': year,
                'value': row['values'][metric['key']] if row else None,
                'source_period': row['source_period'] if row else None,
            })
        indicators.append({
            **metric,
            'points': points,
            'coverage': {
                'valid_values': sum(point['value'] is not None for point in points),
                'year_count': len(points),
            },
        })

    return {
        'dataset': dataset,
        'table': prepared['table'],
        'region': next(iter(region_rows.values()))['region'],
        'years': prepared['years'],
        'indicators': indicators,
        'coverage_by_year': coverage_by_year,
    }


@router.get('/map-tiles/{z}/{x}/{y}.jpg', response_class=Response)
def map_tile(z: int, x: int, y: int):
    """Serve the shared cached satellite proxy without exposing its key."""
    from app.spatial.basemap import tile_response
    return tile_response('satellite', z, x, y)


@router.get('/map-tiles/status')
def map_tile_status():
    """Report whether a server-side key is configured, without returning it."""
    return {'configured': bool(os.getenv('MAPTILER_API_KEY', '').strip())}
