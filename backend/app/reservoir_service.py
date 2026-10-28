"""Database-backed dam and reservoir monitoring.

The dashboard reads the configured module 5 Supabase relation.
"""
import json
import os
import re
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from time import monotonic, sleep
from urllib.parse import quote, urlencode

import numpy as np
import pandas as pd
from fastapi import APIRouter, HTTPException
from app.dashboard_loader import dashboard_cache
from app.supabase_source import SupabaseSourceError, _request_page, _settings

router = APIRouter(prefix='/reservoirs', tags=['Dam and reservoir status'])
TABLE_ENV = 'NIWIS_SUPABASE_TABLES_MODULE_5'
DEFAULT_TABLE = '8_1_reservoir_operational_master'
PAGE_SIZE = 1000
SCHEMA_TTL_SECONDS = 900
METRICS = [
    ('storage', 'Storage volume', 'million m\u00b3', 'Storage', 'DWS Hydstra', 'Source storage_volume_m3 / 1,000,000; a stock, never summed over time'),
    ('pct_fsc', 'Full supply capacity', '% FSC', 'Storage', 'DWS Hydstra', 'Source percentage; priority reference capacities are not substituted'),
    ('fsl', 'Full supply level', 'm amsl', 'Storage', 'DWS Hydstra', 'Source fsl_m_amsl'),
    ('level', 'Water surface level', 'm amsl', 'Storage', 'DWS telemetry', 'Source water_level_m_amsl'),
    ('inflow', 'Daily mean inflow', 'm\u00b3/s', 'Inflow', 'DWS gauging', 'Source daily rate; not a daily volume'),
    ('outflow', 'Daily mean release', 'm\u00b3/s', 'Outflow', 'DWS telemetry', 'Source outflow_m3_s; gate and spill components are not separated'),
    ('evaporation', 'Surface evaporation', 'mm/day', 'Evaporation', 'SAWS / derived', 'Source evaporation_mm_day'),
    ('seepage', 'Seepage / leakage', 'm\u00b3/day', 'Seepage', 'DWS monitoring', 'Source seepage_m3_day'),
    ('rainfall', 'Catchment rainfall', 'mm/day', 'Catchment', 'SAWS', 'Source rainfall_mm_day'),
    ('runoff', 'Estimated runoff volume', 'm\u00b3/day', 'Catchment', 'DWS / modelled', 'runoff_mm_day x district_area_km2 x 1,000; district area is a catchment proxy'),
    ('area', 'Reservoir surface area', 'km\u00b2', 'Satellite', 'SANSA', 'Source water_area_km2; no reservoir footprint geometry supplied'),
    ('ndwi', 'Reservoir NDWI', 'index', 'Satellite', 'SANSA', 'Source mean_ndwi, within -1 to +1'),
]
RENAME = {'storage_volume_m3': 'storage', 'water_level_m_amsl': 'level', 'fsl_m_amsl': 'fsl',
          'inflow_m3_s': 'inflow', 'outflow_m3_s': 'outflow', 'evaporation_mm_day': 'evaporation',
          'seepage_m3_day': 'seepage', 'rainfall_mm_day': 'rainfall', 'water_area_km2': 'area', 'mean_ndwi': 'ndwi'}
SOURCE_ALIASES = {
    'district_id': ('district_id', 'district_code', 'districtid', 'id'),
    'district_name': ('district_name', 'district', 'region', 'region_name'),
    'province': ('province', 'province_name'),
    'dam_name': ('dam_name', 'dam', 'reservoir_name', 'reservoir'),
    'river': ('river', 'river_name', 'catchment', 'catchment_name'),
    'date': ('date', 'observation_date', 'record_date'),
    'storage_volume_m3': ('storage_volume_m3', 'storage_volume', 'storage'),
    'pct_fsc': ('pct_fsc', 'percentage_fsc', 'full_supply_capacity_percent', 'full_supply_capacity'),
    'fsl_m_amsl': ('fsl_m_amsl', 'fsl', 'full_supply_level_m_amsl'),
    'water_level_m_amsl': ('water_level_m_amsl', 'water_level', 'level', 'level_m_amsl'),
    'inflow_m3_s': ('inflow_m3_s', 'inflow', 'inflow_rate_m3_s'),
    'outflow_m3_s': ('outflow_m3_s', 'outflow', 'release_m3_s', 'release'),
    'evaporation_mm_day': ('evaporation_mm_day', 'evaporation', 'surface_evaporation_mm_day'),
    'seepage_m3_day': ('seepage_m3_day', 'seepage', 'leakage_m3_day', 'leakage'),
    'rainfall_mm_day': ('rainfall_mm_day', 'rainfall', 'catchment_rainfall_mm_day'),
    'runoff_mm_day': ('runoff_mm_day', 'runoff', 'estimated_runoff_mm_day'),
    'district_area_km2': ('district_area_km2', 'district_area', 'catchment_area_km2'),
    'water_area_km2': ('water_area_km2', 'water_area', 'surface_area_km2'),
    'mean_ndwi': ('mean_ndwi', 'ndwi', 'reservoir_ndwi'),
}
SOURCE_COLUMNS = tuple(SOURCE_ALIASES)
PRIORITY = [
    ('Gariep', 'Free State', 'Orange River', 5341, 'National'),
    ('Vanderkloof', 'Northern Cape', 'Orange River', 3171, 'National'),
    ('Sterkfontein', 'Free State', 'Nuwejaarspruit', 2617, 'Gauteng / Mpumalanga'),
    ('Vaal', 'Gauteng / Free State', 'Vaal River', 2536, 'Gauteng Metro'),
    ('Theewaterskloof', 'Western Cape', 'Theewaterskloof', 480, 'Cape Town'),
    ('Katse', 'Lesotho / transfer to SA', 'Malibamatso', 1950, 'Gauteng'),
    ('Pongolapoort', 'KwaZulu-Natal', 'Phongolo', 2448, 'KZN / Maputo'),
    ('Bloemhof', 'North West / Free State / Northern Cape', 'Vaal River', 1232, 'North West'),
]


def clean(value):
    return json.loads(pd.Series([value]).to_json(orient='values', force_ascii=False))[0]


def _normalise(value):
    return re.sub(r'[^a-z0-9]', '', str(value).lower())


def _configured_table():
    names = tuple(part.strip() for part in os.getenv(TABLE_ENV, DEFAULT_TABLE).split(',') if part.strip())
    if len(names) != 1 or not re.fullmatch(r'[A-Za-z0-9_. ]+', names[0]):
        raise SupabaseSourceError(f'{TABLE_ENV} must contain one valid reservoir table name.')
    return names[0]


def _table_url(base, table, params):
    return f'{base}/rest/v1/{quote(table, safe="._")}?{urlencode(params)}'


def _find_column(columns, aliases):
    lookup = {_normalise(column): column for column in columns}
    return next((lookup[_normalise(alias)] for alias in aliases if _normalise(alias) in lookup), None)


def _snapshot_signature():
    base, key, _ = _settings()
    try:
        epoch = int(monotonic() // max(60, int(os.getenv('NIWIS_SUPABASE_CACHE_TTL', '86400'))))
    except ValueError as exc:
        raise SupabaseSourceError('NIWIS_SUPABASE_CACHE_TTL must be a number of seconds.') from exc
    return base, key, _configured_table(), epoch


def signature():
    """Return a cache key without reading any reservoir rows."""
    base, key, table, epoch = _snapshot_signature()
    return 'Supabase', base, hash(key), table, epoch


@dashboard_cache('reservoir.snapshot')
def _snapshot(version):
    del version
    base, key, table, epoch = _snapshot_signature()
    del epoch
    sample_rows, _ = _request_page(_table_url(base, table, {'select': '*', 'limit': '1'}), key, 0, 0)
    sample = sample_rows[0] if sample_rows else {}
    if not sample:
        raise SupabaseSourceError(f'The configured reservoir table {table} is empty.')
    actual = {canonical: _find_column(list(sample), aliases) for canonical, aliases in SOURCE_ALIASES.items()}
    missing = [name for name, column in actual.items() if column is None]
    if missing:
        raise SupabaseSourceError(f'Reservoir table {table} is missing required columns: {", ".join(missing)}')
    return {'base': base, 'key': key, 'table': table, 'columns': actual}


def _row_count(content_range):
    try:
        return int((content_range or '').rsplit('/', 1)[1])
    except (AttributeError, ValueError, IndexError):
        return None


def _read_all(snapshot):
    """Read the configured relation with bounded, concurrent REST pages."""
    columns = snapshot['columns']
    selected = [columns[name] for name in SOURCE_COLUMNS]
    params = {
        'select': ','.join(selected),
        'order': f'{columns["district_name"]}.asc,{columns["date"]}.asc',
    }
    first, content_range = _request_page(
        _table_url(snapshot['base'], snapshot['table'], params),
        snapshot['key'], 0, PAGE_SIZE - 1, count_exact=True,
    )
    total = _row_count(content_range)
    rows = list(first)
    if total is None:
        offset = len(rows)
        while len(first) == PAGE_SIZE:
            first, _ = _request_page(
                _table_url(snapshot['base'], snapshot['table'], params),
                snapshot['key'], offset, offset + PAGE_SIZE - 1,
            )
            rows.extend(first)
            offset += len(first)
        return pd.DataFrame(rows).rename(columns={column: name for name, column in columns.items()})
    if len(rows) >= total:
        return pd.DataFrame(rows[:total]).rename(columns={column: name for name, column in columns.items()})
    ranges = [
        (offset, min(total - 1, offset + PAGE_SIZE - 1))
        for offset in range(PAGE_SIZE, total, PAGE_SIZE)
    ]
    try:
        workers = max(4, min(16, len(ranges)))
        with ThreadPoolExecutor(max_workers=workers) as executor:
            pages = executor.map(
                lambda bounds: _request_page(
                    _table_url(snapshot['base'], snapshot['table'], params),
                    snapshot['key'], bounds[0], bounds[1],
                )[0],
                ranges,
            )
            for page in pages:
                rows.extend(page)
    except SupabaseSourceError:
        raise
    if len(rows) != total:
        raise SupabaseSourceError(f'Reservoir pagination was incomplete: expected {total} rows, received {len(rows)}.')
    return pd.DataFrame(rows).rename(columns={column: name for name, column in columns.items()})


def prepare(raw):
    required = {'district_id', 'district_name', 'province', 'dam_name', 'river', 'date',
                'pct_fsc', 'runoff_mm_day', 'district_area_km2', *RENAME}
    missing = sorted(required - set(raw.columns))
    if missing:
        raise HTTPException(503, f'Reservoir source columns are missing: {", ".join(missing)}')
    frame = raw.copy()
    frame['date'] = pd.to_datetime(frame.date, errors='coerce')
    if frame.empty or frame.date.isna().any() or frame[['district_name', 'dam_name']].isna().any().any():
        raise HTTPException(503, 'The reservoir source has missing identifiers, invalid dates or no records.')
    # D_UNMAPPED is reused by different districts. Names, not that ID, identify series.
    if frame.duplicated(['district_name', 'date']).any():
        raise HTTPException(503, 'Duplicate reservoir district/date records require source reconciliation.')
    for key in [*RENAME, 'pct_fsc', 'runoff_mm_day', 'district_area_km2']:
        frame[key] = pd.to_numeric(frame[key], errors='coerce').replace([np.inf, -np.inf], np.nan)
    frame = frame.rename(columns=RENAME)
    frame['storage'] /= 1e6
    frame['runoff'] = frame.runoff_mm_day * frame.district_area_km2 * 1000
    return frame.sort_values(['district_name', 'date'])


@dashboard_cache('reservoir.dataset')
def dataset(version):
    try:
        snapshot = _snapshot(version)
        frame = prepare(_read_all(snapshot))
    except SupabaseSourceError as exc:
        raise HTTPException(503, f'Reservoir database source unavailable: {exc}') from exc
    groups = frame.groupby('district_name')
    catalogue = groups[['district_id', 'province', 'dam_name', 'river']].first().reset_index()
    info = {'source': 'Supabase', 'table': snapshot['table'], 'file': snapshot['table'],
            'rows': len(frame), 'groups': len(catalogue),
            'first_date': frame.date.min().strftime('%Y-%m-%d'), 'source_end': frame.date.max().strftime('%Y-%m-%d'),
            'constant_storage_groups': int(groups.storage.nunique().le(1).sum()),
            'id_collisions': int(frame.groupby('district_id').district_name.nunique().gt(1).sum()),
            'missing_values': int(frame[[key for key, *_ in METRICS]].isna().sum().sum()),
            'inflow_from_runoff': bool(np.allclose(frame.inflow, frame.runoff / 86400, equal_nan=True)),
            'level_from_pct': bool(np.allclose(frame.level, frame.fsl - (100 - frame.pct_fsc) * .05, equal_nan=True)),
            'has_overlapping_alias': bool({'Siyanda', 'Z F Mgcawu'} <= set(catalogue.district_name))}
    return frame, catalogue, info


def cutoff(as_of=None):
    today = datetime.now(timezone(timedelta(hours=2))).date()
    try:
        chosen = datetime.strptime(as_of, '%Y-%m-%d').date() if as_of else today
    except ValueError as exc:
        raise HTTPException(422, 'Use YYYY-MM-DD for the monitoring date.') from exc
    return pd.Timestamp(min(chosen, today))


def period_date(value):
    if not re.fullmatch(r'\d{4}-\d{2}-\d{2}', value):
        raise ValueError('A date must use YYYY-MM-DD')
    return pd.Timestamp(datetime.strptime(value, '%Y-%m-%d').date())


def critical_level(value):
    if value is None or pd.isna(value):
        return {'level': None, 'label': 'Unavailable'}
    return {'level': 3, 'label': 'Level 3'} if value < 15 else {'level': 2, 'label': 'Level 2'} if value < 30 else {'level': 1, 'label': 'Level 1'} if value < 50 else {'level': 0, 'label': 'Above alert thresholds'}


def priority_inventory(catalogue):
    result = []
    for name, province, river, capacity, supply in PRIORITY:
        matches = catalogue[catalogue.dam_name.str.contains(rf'\b{re.escape(name)}\b', case=False, regex=True, na=False)]
        result.append({'name': name, 'province': province, 'river': river, 'capacity': capacity, 'supply': supply,
                       'groups': matches.district_name.tolist(), 'status': 'Mapped reservoir group' if len(matches) else 'Not in database table'})
    return result


def _read_pages(snapshot, params):
    rows = []
    for offset in range(0, PAGE_SIZE * 128, PAGE_SIZE):
        page, _ = _request_page(_table_url(snapshot['base'], snapshot['table'], params),
                                snapshot['key'], offset, offset + PAGE_SIZE - 1)
        rows.extend(page)
        if len(page) < PAGE_SIZE:
            return rows
    raise SupabaseSourceError('A bounded reservoir query exceeded its pagination limit.')


def _boundary_rows(snapshot, params):
    """Retry only the small date-boundary query after transient DB timeouts."""
    for attempt in range(3):
        try:
            return _request_page(_table_url(snapshot['base'], snapshot['table'], params),
                                 snapshot['key'], 0, 0)[0]
        except SupabaseSourceError as exc:
            if '57014' not in str(exc) or attempt == 2:
                raise
            sleep(.25 * (attempt + 1))


@dashboard_cache('reservoir.bounds')
def _bounds(version, through=None):
    snapshot = _snapshot(version)
    date = snapshot['columns']['date']
    params = {'select': date, 'limit': '1'}
    if through:
        params[date] = f'lte.{through}'
    first = [{date: _bounds(version)[0]}] if through else _boundary_rows(snapshot, {**params, 'order': f'{date}.asc'})
    last = _boundary_rows(snapshot, {**params, 'order': f'{date}.desc'})
    if not first or not last:
        raise HTTPException(422, 'There are no reservoir records on or before this monitoring date.')
    return str(first[0][date])[:10], str(last[0][date])[:10]


@dashboard_cache('reservoir.window')
def _read_window(version, start, end, region=None):
    snapshot = _snapshot(version)
    columns = snapshot['columns']
    cursor, final = pd.Timestamp(start), pd.Timestamp(end) + pd.Timedelta(days=1)
    windows = []
    # Keep national windows below a REST page; a district needs far fewer rows.
    step = pd.Timedelta(days=365 if region else 14)
    while cursor < final:
        following = min(cursor + step, final)
        windows.append((cursor, following))
        cursor = following

    def read(bounds):
        first, last = bounds
        date, district = columns['date'], columns['district_name']
        params = {'select': ','.join(columns[name] for name in SOURCE_COLUMNS),
                  'order': f'{district}.asc,{date}.asc', date: f'gte.{first:%Y-%m-%d}',
                  'and': f'({date}.lt.{last:%Y-%m-%d})'}
        if region:
            params[district] = f'eq.{region}'
        return _read_pages(snapshot, params)

    rows = []
    with ThreadPoolExecutor(max_workers=min(8, max(1, len(windows)))) as executor:
        for page in executor.map(read, windows):
            rows.extend(page)
    frame = pd.DataFrame(rows, columns=list(columns.values())).rename(
        columns={actual: name for name, actual in columns.items()})
    return prepare(frame) if not frame.empty else frame


@dashboard_cache('reservoir.overview')
def _overview(version, through):
    first, source_end = _bounds(version)
    _, observed_end = _bounds(version, through)
    snapshot = _read_window(version, observed_end, observed_end)
    catalogue = snapshot[['district_name', 'district_id', 'province', 'dam_name', 'river']].to_dict('records')
    return {'source': 'Supabase', 'table': _snapshot(version)['table'],
            'file': _snapshot(version)['table'], 'rows': None, 'groups': len(catalogue),
            'first_date': first, 'source_end': source_end, 'observed_end': observed_end,
            'regions': catalogue, 'future_rows_excluded': None,
            'has_future_records': source_end > through,
            'catalogue_scope': 'Groups observed on the latest monitoring day',
            'constant_storage_groups': None, 'id_collisions': None, 'missing_values': None,
            'inflow_from_runoff': None, 'level_from_pct': None}


@router.get('/metadata')
def metadata(as_of: str = None):
    try:
        info = _overview(signature(), cutoff(as_of).strftime('%Y-%m-%d'))
        names = [row['district_name'] for row in info['regions']]
        end = pd.Timestamp(info['observed_end'])
        start = max(pd.Timestamp(info['first_date']), end - pd.Timedelta(days=364))
        catalogue = pd.DataFrame(info['regions'])
        return clean({**info, 'default_region': 'City of Tshwane' if 'City of Tshwane' in names else names[0],
                      'default_start': start.strftime('%Y-%m-%d'), 'default_end': str(end.date()),
                      'metrics': [{'key': k, 'label': label, 'unit': unit, 'category': group,
                                   'attribution': source, 'method': method}
                                  for k, label, unit, group, source, method in METRICS],
                      'priority': priority_inventory(catalogue)})
    except SupabaseSourceError as exc:
        raise HTTPException(503, f'Reservoir database source unavailable: {exc}') from exc


@dashboard_cache('reservoir.indicator-history')
def _indicator_history(version, region, end, first_year):
    snapshot = _snapshot(version)
    columns = snapshot['columns']
    date, district = columns['date'], columns['district_name']
    end = pd.Timestamp(end)
    trailing = min(end - pd.Timedelta(days=30), end - pd.DateOffset(months=1))
    intervals = [f'and({date}.gte.{trailing:%Y-%m-%d},{date}.lte.{end:%Y-%m-%d})']
    for year in range(first_year, end.year):
        first = pd.Timestamp(year=year, month=end.month, day=1)
        last = first + pd.offsets.MonthBegin(1)
        intervals.append(f'and({date}.gte.{first:%Y-%m-%d},{date}.lt.{last:%Y-%m-%d})')
    params = {'select': ','.join(columns[name] for name in ('date', 'storage_volume_m3', 'water_level_m_amsl')),
              district: f'eq.{region}', 'order': f'{date}.asc', 'or': '(' + ','.join(intervals) + ')'}
    rows = _read_pages(snapshot, params)
    frame = pd.DataFrame(rows).rename(columns={columns['date']: 'date',
        columns['storage_volume_m3']: 'storage', columns['water_level_m_amsl']: 'level'})
    if frame.empty:
        return pd.DataFrame(columns=['date', 'storage', 'level'])
    frame['date'] = pd.to_datetime(frame['date'], errors='raise')
    frame['storage'] = pd.to_numeric(frame['storage'], errors='coerce') / 1e6
    frame['level'] = pd.to_numeric(frame['level'], errors='coerce')
    return frame.sort_values('date')


@router.get('/audit')
def audit():
    # A full source audit is explicit and separate from normal chart/map reads.
    return clean(dataset(signature())[2])


def derived_indicators(history, end):
    series = history.set_index('date').sort_index()
    latest = series.loc[end]
    previous_week = series.loc[end - pd.Timedelta(days=7)] if end - pd.Timedelta(days=7) in series.index else None
    previous_month_date = end - pd.DateOffset(months=1)
    previous_month = series.loc[previous_month_date] if previous_month_date in series.index else None
    weekly = latest.level - previous_week.level if previous_week is not None else np.nan
    monthly = (latest.storage / previous_month.storage - 1) * 100 if previous_month is not None and previous_month.storage > 0 else np.nan
    trailing = series.loc[end - pd.Timedelta(days=30):end]
    daily_dates = pd.date_range(end - pd.Timedelta(days=30), end)
    complete = len(trailing) == 31 and trailing.index.equals(daily_dates) and trailing.storage.notna().all()
    drawdown = (trailing.storage.iloc[0] - latest.storage) / 30 if complete else np.nan
    days = latest.storage / drawdown if pd.notna(drawdown) and drawdown > 0 and latest.storage >= 0 else np.nan
    # Use prior years' same-month mean storage, excluding the monitored year.
    baseline = series[(series.index.month == end.month) & (series.index.year < end.year)].groupby(lambda date: date.year).storage.mean().dropna()
    deviation = baseline.std(ddof=1)
    rsi = (latest.storage - baseline.mean()) / deviation if len(baseline) >= 3 and deviation > max(abs(baseline.mean()) * 1e-12, 1e-10) else np.nan
    return {'weekly_level_change': weekly, 'monthly_storage_change': monthly, 'drawdown': drawdown, 'days_to_empty': days,
            'drawdown_status': 'Declining storage' if pd.notna(drawdown) and drawdown > 0 else 'No observed drawdown' if complete else 'Insufficient 30-day history',
            'rsi': rsi, 'rsi_years': len(baseline), 'dir': None,
            'dir_status': 'Unavailable: no source values or calculation formula supplied'}


def _selected_audit(frame):
    groups = frame.groupby('district_name')
    return {'scope': 'Selected chart window', 'rows': len(frame), 'groups': len(groups),
            'constant_storage_groups': int(groups.storage.nunique().le(1).sum()),
            'id_collisions': int(frame.groupby('district_id').district_name.nunique().gt(1).sum()),
            'missing_values': int(frame[[key for key, *_ in METRICS]].isna().sum().sum()),
            'inflow_from_runoff': bool(np.allclose(frame.inflow, frame.runoff / 86400, equal_nan=True)),
            'level_from_pct': bool(np.allclose(frame.level, frame.fsl - (100 - frame.pct_fsc) * .05, equal_nan=True))}


@router.get('/dashboard')
def dashboard(region: str = 'City of Tshwane', start: str = None, end: str = None, as_of: str = None):
    through = cutoff(as_of)
    try:
        version = signature()
        info = _overview(version, through.strftime('%Y-%m-%d'))
        catalogue = pd.DataFrame(info['regions'])
        try:
            last = period_date(end) if end else pd.Timestamp(info['observed_end'])
            first = period_date(start) if start else max(pd.Timestamp(info['first_date']), last - pd.Timedelta(days=364))
        except (ValueError, TypeError) as exc:
            raise HTTPException(422, 'Choose valid start and end dates.') from exc
        if first > last or last > through:
            raise HTTPException(422, 'Choose a valid period ending on or before the monitoring date.')
        if region != 'National' and region not in set(catalogue.district_name):
            raise HTTPException(404, 'Reservoir record group not found.')
        selected = _read_window(version, str(first.date()), str(last.date()), None if region == 'National' else region)
        if selected.empty:
            raise HTTPException(422, 'There are no reservoir observations in the selected period.')
        keys = [key for key, *_ in METRICS]
        series = selected.groupby('date')[keys].mean().reset_index()
        actual_end = series.date.max()
        latest = series.iloc[-1].to_dict()
        map_frame = _read_window(version, str(actual_end.date()), str(actual_end.date()))
        rows = map_frame[['district_name', 'dam_name', *keys]].rename(columns={'district_name': 'District_Name'}).copy()
        rows['alert_level'] = rows.pct_fsc.map(lambda value: critical_level(value)['level'])
        alert_rows = rows if region == 'National' else rows[rows.District_Name.eq(region)]
        if region == 'National':
            indicators = dict.fromkeys(('weekly_level_change', 'monthly_storage_change', 'drawdown', 'days_to_empty', 'rsi', 'dir'))
            indicators.update(drawdown_status='Select a reservoir group', dir_status='No supplied DIR formula', rsi_years=0)
        else:
            history = _indicator_history(version, region, str(actual_end.date()), pd.Timestamp(info['first_date']).year)
            indicators = derived_indicators(history, actual_end)
        profile = _selected_audit(selected)
        source_group = catalogue[catalogue.district_name.eq(region)].iloc[0].to_dict() if region != 'National' else None
        warnings = ['Records represent district reservoir groups, often multiple named reservoirs; they are not independently verified individual-dam telemetry.',
                    'The database table has no dam coordinates; reference coordinates and district-centroid proxies are labelled on the map.',
                    'Source-quality checks describe the selected chart window; a full-source scan is not performed on page load.']
        if region == 'National':
            warnings.append('National charts average source groups equally; storage and flow are not national totals. Siyanda and Z F Mgcawu overlap geographically.')
        elif selected.storage.nunique() <= 1:
            warnings.append('Storage is constant in this selected source history; no artificial trend is added.')
        if profile['inflow_from_runoff']:
            warnings.append('Inflow equals district runoff volume / 86,400 in this selected window; independent gauging provenance is not supplied.')
        if profile['level_from_pct']:
            warnings.append('Water levels follow FSL - (100 - % FSC) x 0.05 in this selected window.')
        inventory = priority_inventory(catalogue)
        for item in inventory:
            item['group_observations'] = rows[rows.District_Name.isin(item['groups'])][['District_Name', 'pct_fsc']].to_dict('records')
        series['date'] = series.date.dt.strftime('%Y-%m-%d')
        latest['date'] = actual_end.strftime('%Y-%m-%d')
        return clean({'source': info['source'], 'table': info['table'], 'file': info['file'],
                      'region': region, 'group': source_group, 'start': str(first.date()), 'end': str(actual_end.date()),
                      'series': series.to_dict('records'), 'latest': latest, 'indicators': indicators,
                      'alert': critical_level(latest['pct_fsc']), 'map': rows.to_dict('records'),
                      'alerts': alert_rows[alert_rows.alert_level.gt(0)].sort_values('pct_fsc').to_dict('records'),
                      'priority': inventory, 'warnings': warnings, 'audit': profile,
                      'coverage': {'observed': int(selected.storage.count()),
                                   'expected': ((last - first).days + 1) * int(selected.district_name.nunique())},
                      'aggregation': 'Equal-weight source group mean' if region == 'National' else 'Selected source reservoir group',
                      'future_rows_excluded': info['future_rows_excluded'], 'has_future_records': info['has_future_records']})
    except SupabaseSourceError as exc:
        raise HTTPException(503, f'Reservoir database source unavailable: {exc}') from exc
