"""Section 18 database observations, with independent geographic/reporting scopes.

No national totals or reliability indices are inferred from incompatible regions,
annual rates, or undocumented indicator definitions. Source errors are not cached.
"""
from __future__ import annotations

import json
import math
import os
import re
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import quote, urlencode

import pandas as pd
from fastapi import APIRouter, HTTPException

from app.dashboard_loader import dashboard_cache, dashboard_cache_ttl
from app.supabase_source import SupabaseSourceError, _request_page, _settings

router = APIRouter(prefix='/water-services', tags=['Water Services, Infrastructure Access and Supply Reliability'])
ALL = '__all__'
KINDS = ('access', 'operations', 'eo')
TABLES = ('18_1_water_access_and_coverage_master', '18_2_infrastructure_operational_master', '18_3_sansa_eo_support_for_services_masters')
# key, label, unit, exact source field, group, reference agency
METRICS = {
    'access': (
        ('total_households', 'Total households', 'households', 'Total Households', 'Household counts', 'Stats SA / DWS'),
        ('rdp_households', 'At or above RDP', 'households', 'At or Above RDP Households', 'Household counts', 'Stats SA / DWS'),
        ('rdp_pct', 'At or above RDP', '%', 'At or Above RDP Percentage', 'Coverage', 'Stats SA / DWS'),
        ('piped_households', 'Piped infrastructure', 'households', 'Piped Infrastructure Households', 'Household counts', 'Stats SA / DWS'),
        ('reliable_households', 'Reported reliable water', 'households', 'Reliable Water Households', 'Reliability', 'DWS'),
        ('reliable_pct', 'Reported reliable water', '%', 'Reliable Water Percentage', 'Reliability', 'DWS'),
        ('backlog_households', 'Below RDP / access backlog', 'households', 'Households Below RDP / Backlog (#)', 'Backlog & delivery', 'DWS'),
        ('backlog_pct', 'Below RDP / access backlog', '%', 'Households Below RDP / Backlog (%)', 'Coverage', 'DWS'),
        ('connections', 'Annual new connections', 'households/year', 'Annual New Connections Installed (#/year)', 'Backlog & delivery', 'Municipalities'),
        ('dwelling_households', 'Piped water inside dwelling', 'households', 'Piped Water Inside Dwelling (#)', 'Household counts', 'Stats SA / DWS'),
        ('yard_households', 'Piped water on site / yard tap', 'households', 'Piped Water On Site / Yard Tap (#)', 'Household counts', 'Stats SA / DWS'),
        ('standpipe_households', 'Communal standpipe < 200 m', 'households', 'Communal Standpipe < 200m (#)', 'Household counts', 'Stats SA / DWS'),
        ('dwelling_pct', 'Piped water inside dwelling', '%', 'Piped Water Inside Dwelling (%)', 'Coverage', 'Stats SA / DWS'),
        ('yard_pct', 'Piped water on site / yard tap', '%', 'Piped Water On Site / Yard Tap (%)', 'Coverage', 'Stats SA / DWS'),
        ('standpipe_pct', 'Communal standpipe < 200 m', '%', 'Communal Standpipe < 200m (%)', 'Coverage', 'Stats SA / DWS'),
        ('distance', 'Distance to water point for unserved households', 'km', 'Distance to Nearest Water Point for Unserved HH (km)', 'Institutions & distance', 'GIS / Stats SA'),
        ('schools_pct', 'Schools with piped water', '%', 'Schools with Piped Water (%)', 'Institutions & distance', 'EMIS / DWS'),
        ('clinics_pct', 'Clinics with piped water', '%', 'Clinics with Piped Water (%)', 'Institutions & distance', 'DHIS / DWS'),
    ),
    'operations': (
        ('production', 'Daily water production rate', 'm³/day', 'Daily_Water_Production_Volume_m3_day', 'Production & losses', 'Municipal SCADA'),
        ('pressure', 'System supply pressure (unit unresolved)', 'kPa / bar: source ambiguous', 'System_Supply_Pressure_kPa_bar', 'Distribution', 'Municipal SCADA'),
        ('nrw_pct', 'Computed NRW (source)', '%', 'Computed_NRW_Percentage', 'Production & losses', 'Municipalities'),
        ('physical_losses', 'Reported physical losses', 'm³/day', 'Physical_Losses_Real_Losses_m3_day', 'Production & losses', 'Municipalities'),
        ('interruptions', 'Unplanned interruption rate', 'events/day', 'Daily_Unplanned_Supply_Interruptions_events_per_day', 'Outages', 'Municipal call centre'),
        ('outage_duration', 'Average outage duration', 'hours/event', 'Average_Duration_Of_Outages_hours_per_event', 'Outages', 'Municipal SCADA'),
        ('energy', 'Pump station energy intensity', 'kWh/ML', 'Pump_Station_Energy_Consumption_kWh_Ml', 'Energy', 'Municipal SCADA'),
        ('load_shedding', 'Load shedding interruptions', 'hours/day', 'Load_Shedding_Induced_Interruptions_hours_per_day', 'Energy', 'Eskom / municipalities'),
        ('pipe_failure', 'Pipe failure rate', 'breaks/100 km/year', 'Pipe_Failure_Rate_breaks_per_100km_year', 'Infrastructure', 'Municipalities'),
    ),
    'eo': (
        ('settlement', 'Built-up settlement extent', 'km²', 'Settlement_Extent_Built_km2', 'Settlement extent', 'SANSA / Sentinel-2'),
        ('informal', 'Informal settlement extent', 'km²', 'Informal_Settlements_Extent_km2', 'Settlement extent', 'SANSA'),
        ('reservoir', 'Mapped reservoir extent', 'km²', 'Water_Infrastructure_Reservoir_Extent_km2', 'Water infrastructure', 'SANSA'),
        ('pdsi', 'Reported PDSI field (unvalidated scale)', 'source index', 'Drought_Severity_PDSI', 'Drought exposure', 'SANSA / derived'),
        ('deficit', 'Climatic water deficit', 'mm', 'Climatic_Water_Deficit_mm', 'Drought exposure', 'SANSA / derived'),
        ('precipitation', 'Catchment precipitation', 'mm', 'Catchment_Precipitation_mm', 'Drought exposure', 'SANSA / derived'),
    ),
}
RELIABILITY = [
    {'key': 'wsa', 'label': 'WSA reliability score', 'unit': 'composite score', 'status': 'Unavailable', 'reason': 'No documented score, components, weights or verified WSA identifiers are supplied.'},
    {'key': 'sifi', 'label': 'Service interruption frequency index (SIFI)', 'unit': 'interruptions / 1,000 connections / month', 'status': 'Unavailable', 'reason': 'Requires monthly interruption counts and active service connections for the same supply system. Annual records of daily rates and new household connections do not provide these inputs.'},
    {'key': 'wci', 'label': 'Water supply coverage index (WCI)', 'unit': '% population receiving > 25 L/person/day', 'status': 'Unavailable', 'reason': 'Population served and delivered litres per person per day are absent. Household piped access is a different measure.'},
    {'key': 'ici', 'label': 'Infrastructure condition index (ICI)', 'unit': 'average pipe condition rating', 'status': 'Unavailable', 'reason': 'Pipe condition ratings, rating scale and weighting are absent. Age bands and break rates do not establish a condition rating.'},
    {'key': 'dvi', 'label': 'Drought vulnerability index (DVI)', 'unit': 'WSA vulnerability index', 'status': 'Unavailable', 'reason': 'Requires linked WSA storage and climate exposure data with a defined method. District EO fields alone do not establish WSA vulnerability.'},
]
NOTES = {
    'access': [
        'April snapshots. Total, Urban and Rural categories stay separate; subcategories are never added to Total.',
        'Regions mix municipalities and districts without stable identifiers or a verified boundary crosswalk. Overview values are equal means of available source regions, not national totals or population-weighted coverage.',
        'Household access categories can overlap or disagree with totals in the source. They are shown separately, not as a 100% distribution. Out-of-range individual percentages are omitted and counted in the audit.',
        'Reported reliable-water fields are sparse and do not define a WSA reliability score, WCI or independently verified SDG compliance.',
    ],
    'operations': [
        'Standardized_Year is the reporting axis; supplied Time Frame labels are retained, including financial years. Annual rows containing daily rates are not a daily SCADA feed.',
        'National uses the explicitly supplied National row. Covered-region means exclude that row and never sum overlapping geographies.',
        'NRW uses Computed_NRW_Percentage. The original NRW percentage field contains malformed or out-of-range values; it is not silently rescaled.',
        'Non-finite, negative physical rates and percentages outside 0–100 are omitted and counted. Missing recent production and NRW values are not replaced with older observations.',
        'Pressure units cannot be distinguished between kPa and bar from the column metadata. No conversion or pressure classification is applied.',
        'The pipe-age profile contains broad installation bands, not a per-decade inventory. Measurement provenance and observed versus modelled flags are not supplied.',
    ],
    'eo': [
        'Annual district values remain separate from access and operational regions. No municipality-to-district join is inferred.',
        'Settlement areas and reservoir extents are numeric summaries. Pipe routes, infrastructure coordinates, settlement polygons and detection confidence are absent.',
        'The source PDSI field has an unvalidated scale. Values are preserved without drought severity classes or a derived WSA vulnerability score.',
        'Repeated values and stored zeros do not establish current field conditions. Observation methods and measured versus estimated status are not supplied.',
    ],
}


def _number(value):
    if value is None or isinstance(value, bool):
        return None
    try:
        number = float(re.sub(r'\s+', '', value) if isinstance(value, str) else value)
    except (TypeError, ValueError, OverflowError):
        return None
    return number if math.isfinite(number) else None


def _records(frame):
    return json.loads(frame.to_json(orient='records', double_precision=15))


def _configured_tables():
    raw = os.getenv('NIWIS_SUPABASE_TABLES_MODULE_18', '').strip()
    names = tuple(x.strip() for x in raw.split(',')) if raw else TABLES
    if len(names) != 3 or any(not re.fullmatch(r'[A-Za-z0-9_. ]+', name) for name in names):
        raise SupabaseSourceError('NIWIS_SUPABASE_TABLES_MODULE_18 requires access, operations and SANSA relation names, in that order.')
    return names


@dashboard_cache('water-services.source')
def _read_table(base, key, table, kind):
    order = 'district_name.asc,Year.asc' if kind == 'eo' else 'id.asc'
    url = f'{base}/rest/v1/{quote(table, safe="._")}?{urlencode({"select": "*", "order": order})}'
    rows, content_range = _request_page(url, key, 0, 999, True)
    if not rows:
        raise SupabaseSourceError(f"Water services relation '{table}' has no observations.")
    try:
        total = int((content_range or '').rsplit('/', 1)[1])
    except (ValueError, IndexError) as exc:
        raise SupabaseSourceError(f"Water services relation '{table}' did not return a complete row count.") from exc
    size = len(rows)
    offsets = list(range(size, total, size))
    if offsets:
        with ThreadPoolExecutor(max_workers=4) as pool:
            pages = list(pool.map(lambda offset: _request_page(url, key, offset, min(total - 1, offset + size - 1))[0], offsets))
        for offset, page in zip(offsets, pages):
            if len(page) != min(size, total - offset):
                raise SupabaseSourceError(f"Water services relation '{table}' returned an incomplete page. Please retry.")
            rows.extend(page)
    if len(rows) != total:
        raise SupabaseSourceError(f"Water services relation '{table}' returned an incomplete dataset.")
    return rows


def _prepare(rows, kind, table):
    raw = pd.DataFrame(rows)
    entity = 'district_name' if kind == 'eo' else 'Region'
    time_field = {'access': 'Time Frame', 'operations': 'Standardized_Year', 'eo': 'Year'}[kind]
    required = {entity, time_field, *[m[3] for m in METRICS[kind]]}
    required.update({'Category'} if kind == 'access' else {'Time Frame', 'Pipe_Age_Profile_pct_by_decade'} if kind == 'operations' else set())
    missing = required.difference(raw.columns)
    if missing:
        raise SupabaseSourceError(f"Water services relation '{table}' is missing columns: {', '.join(sorted(missing))}.")
    # A known embedded description has no period or household denominator. Never render HTML as geography.
    text_rows = raw[entity].astype(str).str.contains(r'<[^>]+>', regex=True) & raw[time_field].isna()
    excluded = int(text_rows.sum())
    raw = raw.loc[~text_rows].copy().reset_index(drop=True)
    if raw.empty:
        raise SupabaseSourceError(f"Water services relation '{table}' has no usable reporting rows.")
    if kind == 'access':
        years = pd.to_numeric(raw[time_field].astype(str).str.extract(r'^April (\d{4})$', expand=False), errors='coerce')
    else:
        years = pd.to_numeric(raw[time_field], errors='coerce')
    names = raw[entity].map(lambda value: value.strip() if isinstance(value, str) else '')
    if not (years.between(1900, 2200) & years.mod(1).eq(0) & names.ne('') & ~names.str.contains('[<>]', regex=True)).all():
        raise SupabaseSourceError(f"Water services relation '{table}' contains invalid geography or reporting years.")
    frame = pd.DataFrame({'region': names, 'year': years.astype(int)})
    if kind == 'access':
        if not raw.Category.isin(['Total', 'Urban', 'Rural']).all():
            raise SupabaseSourceError(f"Water services relation '{table}' has an unrecognised access category.")
        frame['category'] = raw.Category
    else:
        frame['category'] = 'All'
    if frame.duplicated(['region', 'year', 'category']).any():
        raise SupabaseSourceError(f"Water services relation '{table}' has duplicate region/year/category keys; aggregation stopped.")
    frame['source_period'] = raw['Time Frame'] if kind != 'eo' else raw.Year.astype(str)
    frame['pipe_profile'] = raw['Pipe_Age_Profile_pct_by_decade'] if kind == 'operations' else None
    indicators, quality = [], []
    for name, label, unit, field, group, agency in METRICS[kind]:
        parsed = raw[field].map(_number).astype(float)
        malformed = raw[field].notna() & parsed.isna()
        invalid = parsed.notna() & ((~parsed.between(0, 100)) if unit == '%' else parsed.lt(0) if name != 'pdsi' else False)
        frame[name] = parsed.mask(invalid)
        quality.append({'key': name, 'label': label, 'missing': int(raw[field].isna().sum()),
                        'invalid': int((malformed | invalid).sum()), 'usable': int(frame[name].notna().sum()),
                        'first_year': _number(frame.loc[frame[name].notna(), 'year'].min()),
                        'last_year': _number(frame.loc[frame[name].notna(), 'year'].max()),
                        'min': _number(frame[name].min()), 'max': _number(frame[name].max())})
        indicators.append({'key': name, 'label': label, 'unit': unit, 'source_column': field, 'group': group,
                           'reference_agency': agency, 'provenance': 'requirements reference; field provenance not verified'})
    audit = {'table': table, 'raw_rows': len(rows), 'rows': len(frame), 'excluded_description_rows': excluded,
             'regions': int(frame.region.nunique()), 'first_year': int(frame.year.min()), 'last_year': int(frame.year.max()),
             'missing_measurements': sum(x['missing'] for x in quality), 'invalid_measurements': sum(x['invalid'] for x in quality),
             'quality': quality, 'duplicate_keys': 0}
    if kind == 'access':
        parts = frame[['dwelling_households', 'yard_households', 'standpipe_households']].sum(axis=1, min_count=3)
        audit['access_counts_exceed_total_rows'] = int(parts.gt(frame.total_households).sum())
        audit['access_counts_disagree_with_piped_rows'] = int(parts.sub(frame.piped_households).abs().gt(1).sum())
    if kind == 'operations':
        legacy = raw.get('Non_Revenue_Water_Percentage_pct', pd.Series(index=raw.index, dtype=object)).map(_number)
        audit['legacy_nrw_out_of_range_rows'] = int((legacy.notna() & ~legacy.between(0, 100)).sum())
        audit['missing_source_period_rows'] = int(raw['Time Frame'].isna().sum())
        if {'System input volume (litres)', 'Non-Revenue water (litres)'}.issubset(raw):
            supplied = raw['System input volume (litres)'].map(_number).astype(float)
            losses = raw['Non-Revenue water (litres)'].map(_number).astype(float)
            calculated = 100 * losses / supplied.where(supplied.gt(0))
            difference = (calculated - frame.nrw_pct).abs()
            audit['nrw_volume_check'] = {'comparable_rows': int(difference.notna().sum()), 'mismatch_rows': int(difference.gt(.01).sum()), 'tolerance_percentage_points': .01}
    return {'frame': frame, 'indicators': indicators, 'audit': audit}


@dashboard_cache('water-services.prepared')
def _snapshot(base, key, table, kind):
    return _prepare(_read_table(base, key, table, kind), kind, table)


def _load(kind):
    if kind not in KINDS:
        raise HTTPException(400, 'Unknown water services section.')
    base, key, _ = _settings()
    return _snapshot(base, key, _configured_tables()[KINDS.index(kind)], kind)


def _section_metadata(data, kind):
    frame = data['frame']
    years = sorted(int(year) for year in frame.year.unique())
    return {'regions': sorted(frame.region.unique()), 'years': years, 'categories': sorted(frame.category.unique()),
            'default_region': 'National' if kind == 'operations' and 'National' in set(frame.region) else ALL,
            'default_start': max(years[0], years[-1] - 9), 'default_end': years[-1],
            'indicators': data['indicators'], 'audit': data['audit'], 'notes': NOTES[kind],
            'category_coverage': [{'category': name, 'rows': len(group), 'regions': int(group.region.nunique()),
                                   'first_year': int(group.year.min()), 'last_year': int(group.year.max())}
                                  for name, group in frame.groupby('category')]}


def _dashboard_value(data, kind, region=ALL, category='Total', start=None, end=None):
    meta, frame = _section_metadata(data, kind), data['frame']
    start = meta['default_start'] if start is None else start
    end = meta['default_end'] if end is None else end
    if region != ALL and region not in meta['regions']:
        raise HTTPException(400, 'The selected region is not available in this source.')
    category = category if kind == 'access' else 'All'
    if category not in meta['categories']:
        raise HTTPException(400, 'The selected category is not available in this source.')
    if start > end or start < meta['years'][0] or end > meta['years'][-1]:
        raise HTTPException(400, 'Choose a valid year range within this source coverage.')
    keys = [m['key'] for m in data['indicators']]
    window = frame[frame.year.between(start, end) & frame.category.eq(category)]
    selected = window[window.region.ne('National')] if region == ALL else window[window.region.eq(region)]
    # Include every selected year, including completely missing intervals.
    series = selected.groupby('year')[keys].mean().reindex(range(start, end + 1))
    counts = selected.groupby('year')[keys].count().reindex(range(start, end + 1), fill_value=0)
    series.index.name = counts.index.name = 'year'
    labels = selected.groupby('year').source_period.apply(lambda values: '; '.join(sorted(values.dropna().unique())))
    series['source_periods'] = labels.reindex(series.index, fill_value='')
    latest = {'year': end, **{name: _number(series.loc[end, name]) for name in keys}}
    latest_rows = window[window.year.eq(end) & window.region.ne('National')]
    values = {row['region']: row for row in _records(latest_rows)}
    comparison = [values.get(name, {'region': name, 'year': end, 'category': category, **dict.fromkeys(keys)}) for name in meta['regions'] if name != 'National']
    map_history = {}
    if kind == 'eo':
        for year, year_rows in window[window.region.ne('National')].groupby('year', sort=True):
            by_name = {row['region']: row for row in _records(year_rows)}
            map_history[str(int(year))] = [by_name.get(name, {'region': name, 'year': int(year), 'category': category, **dict.fromkeys(keys)})
                                           for name in meta['regions'] if name != 'National']
    profiles = _records(selected[selected.year.eq(end)][['region', 'year', 'source_period', 'pipe_profile']])
    national_supplied = 'National' in set(frame.region)
    aggregation = ('Equal mean of available regional values; supplied National row excluded. Not a national total or population-weighted rate.' if national_supplied
                   else 'Equal mean of available source regions. No national row, population weights or boundary crosswalk is supplied; this is not a national total.')
    comparison_note = ('National source row is omitted from the regional comparison.' if national_supplied
                       else 'No national aggregate is supplied; source regions are shown separately.')
    return {'source': 'Supabase', 'section': kind, 'region': region, 'category': category, 'start': start, 'end': end,
            'scope': 'Covered-region mean (unweighted)' if region == ALL else region,
            'aggregation': aggregation if region == ALL else 'Source values for this region and category; no cross-source join.',
            'comparison_note': comparison_note,
            'series': _records(series.reset_index()), 'coverage': _records(counts.reset_index()), 'latest': latest,
            'latest_counts': {name: int(counts.loc[end, name]) for name in keys}, 'comparison': comparison,
            'map_history': map_history,
            'profiles': profiles, 'selected_rows': len(selected), 'selected_regions': int(selected.region.nunique()),
            'missing_measurements': int(selected[keys].isna().sum().sum()), 'empty': selected.empty,
            'latest_source_periods': sorted(selected.loc[selected.year.eq(end), 'source_period'].dropna().unique()),
            'table': data['audit']['table'], 'notes': NOTES[kind]}


@router.get('/metadata')
def metadata():
    def describe(kind):
        try:
            return kind, _section_metadata(_load(kind), kind), None
        except SupabaseSourceError as exc:
            return kind, None, str(exc)
    with ThreadPoolExecutor(max_workers=3) as pool:
        outcomes = list(pool.map(describe, KINDS))
    sections = {kind: result for kind, result, error in outcomes if result is not None}
    errors = {kind: error for kind, result, error in outcomes if error}
    if not sections:
        raise HTTPException(502, 'Water services sources are unavailable. ' + ' '.join(errors.values()))
    return {'source': 'Supabase', 'sections': sections, 'errors': errors, 'reliability': RELIABILITY, 'cache_ttl_seconds': dashboard_cache_ttl()}


@router.get('/dashboard')
def dashboard(section: str = 'access', region: str = ALL, category: str = 'Total', start: int | None = None, end: int | None = None):
    try:
        return _dashboard_value(_load(section), section, region, category, start, end)
    except SupabaseSourceError as exc:
        raise HTTPException(502, str(exc)) from exc
