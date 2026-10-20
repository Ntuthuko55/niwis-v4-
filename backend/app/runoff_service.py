"""Database-backed runoff summaries with bounded reads and unchanged units."""
import json
import os
import re
from concurrent.futures import ThreadPoolExecutor
from functools import wraps
from threading import BoundedSemaphore
from urllib.parse import quote, urlencode

import numpy as np
import pandas as pd
from fastapi import APIRouter, HTTPException
from app.dashboard_loader import cached_call, cached_result, dashboard_cache
from app.supabase_source import SupabaseSourceError, _request_page, _settings

router = APIRouter(prefix='/runoff', tags=['Runoff status'])
TABLE_ENV = 'NIWIS_SUPABASE_TABLES_RUNOFF'
DEFAULT_TABLES = ('runoff_variables_master', '7.2_derived_runoff_indicators_master')
PAGE_SIZE = 1000
_READ_SLOTS = BoundedSemaphore(8)
CORE = {'Catchment_Area_km2': 'area', 'Mean_Catchment_Rainfall_mm': 'rainfall', 'Actual_ET_from_Catchment_mm': 'et',
        'Daily_Surface_Runoff_Volume_m3_day': 'daily_volume', 'Monthly_Runoff_Totals_Million_m3_month': 'reported_volume',
        'Runoff_Coefficient_dimensionless': 'coefficient', 'Soil_Moisture_Prior_m3m3': 'soil_moisture',
        'Curve_Number_CN': 'curve_number', 'Peak_Flow_Rates_m3s': 'peak_flow', 'Baseflow_Component_m3s': 'baseflow',
        'Dominant_LandCover_Class': 'land_cover', 'Impervious_Surface_Fraction_percent': 'impervious'}
PERIODS = [2, 5, 10, 20, 50, 100]
DERIVED = {'Runoff_Anomaly_percent': 'anomaly', 'Runoff_Ratio_Trend_percent_per_yr': 'reported_trend',
           'SSI_Standardized_Streamflow_Index': 'ssi', 'Hydrological_Response_Time_hours': 'response_time',
           **{f'Flood_Flow_{year}yr_m3s': f'flood_{year}' for year in PERIODS}}
METRICS = [
    ('volume', 'Runoff volume', 'million m³', 'Sum of daily runoff volumes divided by 1,000,000'),
    ('reported_volume', 'Reported monthly runoff', 'million m³', 'One source value per district/month'),
    ('rainfall', 'Catchment rainfall', 'mm', 'Sum of daily rainfall depths'),
    ('et', 'Actual evapotranspiration', 'mm', 'Sum of daily actual ET depths'),
    ('runoff_depth', 'Runoff depth', 'mm', 'Daily runoff volume divided by catchment area × 1,000, then summed'),
    ('weighted_ratio', 'Rainfall-weighted runoff ratio', 'ratio', 'Total runoff volume / total rainfall volume; undefined when rainfall is zero'),
    ('coefficient', 'Reported runoff coefficient', 'ratio', 'Mean of daily source coefficients'),
    ('area', 'Catchment area', 'km²', 'Mean source area; not independently verified catchment geometry'),
    ('soil_moisture', 'Antecedent soil moisture', 'm³/m³', 'Mean of daily source values'),
    ('curve_number', 'Curve number', 'CN', 'Mean of daily source values'),
    ('impervious', 'Impervious fraction', '%', 'Mean source percentage'),
    ('peak_flow', 'Monthly peak flow', 'm³/s', 'Maximum supplied daily peak within each district/month'),
    ('baseflow', 'Mean baseflow', 'm³/s', 'Mean of supplied daily baseflow rates; never summed as volume'),
    ('anomaly', 'Reported runoff anomaly', '%', 'One supplied value per district/month'),
    ('reported_trend', 'Reported runoff ratio trend', '%/year', 'Source trend; not re-fitted to the selected window'),
    ('ssi', 'Standardized Streamflow Index', 'index', 'Supplied monthly SSI; accumulation window not documented'),
    ('response_time', 'Hydrological response time', 'hours', 'Supplied response time; no subdaily event timestamps available'),
    *[(f'flood_{year}', f'{year}-year return-period flow', 'm³/s', 'Source estimate for the selected month; fitting method not provided') for year in PERIODS],
]


def clean(value):
    return json.loads(pd.Series([value]).to_json(orient='values', force_ascii=False))[0]


def signature():
    base, key, _ = _settings()
    tables = tuple(name.strip() for name in os.getenv(TABLE_ENV, ','.join(DEFAULT_TABLES)).split(',') if name.strip())
    if len(tables) != 2 or len(set(tables)) != 2 or any(not re.fullmatch(r'[A-Za-z0-9_. ]+', name) for name in tables):
        raise SupabaseSourceError(f'{TABLE_ENV} must list the core and derived runoff tables, in that order.')
    return base, hash(key), tables


def database_endpoint(function):
    @wraps(function)
    def wrapped(*args, **kwargs):
        try:
            return function(*args, **kwargs)
        except SupabaseSourceError as exc:
            raise HTTPException(502, str(exc)) from exc
    return wrapped


def _workers():
    try:
        return max(1, min(8, int(os.getenv('NIWIS_RUNOFF_DB_WORKERS', '8'))))
    except ValueError:
        return 8


def _url(snapshot, table, params):
    return f"{snapshot['base']}/rest/v1/{quote(table, safe='._')}?{urlencode(params)}"


def _pages(snapshot, table, params):
    rows = []
    for offset in range(0, PAGE_SIZE * 128, PAGE_SIZE):
        with _READ_SLOTS:
            page, _ = _request_page(_url(snapshot, table, params), snapshot['key'], offset, offset + PAGE_SIZE - 1)
        rows.extend(page)
        if len(page) < PAGE_SIZE:
            return rows
    raise SupabaseSourceError('A bounded runoff query exceeded its safe pagination limit.')


@dashboard_cache('runoff.snapshot')
def _snapshot(version):
    base, key, _ = _settings()
    snapshot = {'base': base, 'key': key, 'tables': version[2]}
    descriptors = []
    for index, configured in enumerate(version[2]):
        candidates = list(dict.fromkeys([configured, configured.replace('7_2_', '7.2_', 1), configured.replace('7.2_', '7_2_', 1)]))
        for candidate in candidates:
            try:
                rows = _pages(snapshot, candidate, {'select': '*', 'limit': '1'})
                break
            except SupabaseSourceError as exc:
                if not ('PGRST205' in str(exc) or 'Could not find the table' in str(exc)) or candidate == candidates[-1]:
                    raise
        if not rows:
            raise SupabaseSourceError(f"The runoff table '{candidate}' is empty.")
        required = ['District_Name', 'Date', *CORE] if index == 0 else ['District_Name', 'Year', 'Month', *DERIVED]
        missing = sorted(set(required) - set(rows[0]))
        if missing:
            raise SupabaseSourceError(f"Runoff table '{candidate}' is missing required columns: {', '.join(missing)}")
        descriptors.append({'table': candidate, 'configured_table': configured, 'columns': list(rows[0])})
    snapshot['tables'] = tuple(item['table'] for item in descriptors)
    snapshot['schema'] = descriptors
    return snapshot


def _core_month(snapshot, month, region):
    period = pd.Period(month, freq='M')
    params = {'select': ','.join(['District_Name', 'Date', *CORE]),
              'Date': f'gte.{period.start_time:%Y-%m-%d}',
              'and': f'(Date.lt.{(period + 1).start_time:%Y-%m-%d})',
              'order': 'District_Name.asc,Date.asc'}
    if region != 'National':
        params['District_Name'] = f'eq.{region}'
    return pd.DataFrame(_pages(snapshot, snapshot['tables'][0], params), columns=['District_Name', 'Date', *CORE])


def _indicator_month(snapshot, month, region):
    period = pd.Period(month, freq='M')
    # The supplied date is the 25th, not the reporting-month boundary.
    params = {'select': ','.join(['District_Name', 'Year', 'Month', *DERIVED]),
              'Year': f'eq.{period.year}', 'Month': f'eq.{period.month}',
              'order': 'District_Name.asc,Year.asc,Month.asc'}
    if region != 'National':
        params['District_Name'] = f'eq.{region}'
    return pd.DataFrame(_pages(snapshot, snapshot['tables'][1], params), columns=['District_Name', 'Year', 'Month', *DERIVED])


def _summarize(core_raw, derived_raw):
    core, monthly = prepare(core_raw, derived_raw)
    constants = {key: monthly[key].dropna().iloc[0] for key in ['area', 'curve_number', 'impervious', 'response_time', 'reported_trend', 'land_cover'] if monthly[key].nunique() == 1}
    mean_rate = core.daily_volume / 86400
    return monthly, {'core_rows': len(core_raw), 'indicator_rows': len(derived_raw), 'constants': constants,
                     'peak_scaled': bool(core.daily_volume.notna().any() and np.allclose(core.peak_flow, mean_rate * 1.85, atol=.000051, equal_nan=True)),
                     'baseflow_scaled': bool(core.daily_volume.notna().any() and np.allclose(core.baseflow, mean_rate * .32, atol=.000051, equal_nan=True))}


def _month(version, month, region='National'):
    if region != 'National':
        national = cached_result('runoff.month', version, month, 'National')
        if national is not None:
            frame, info = national
            selected = frame[frame.District_Name.eq(region)].copy()
            if not selected.empty:
                return selected, info
    def load():
        snapshot = _snapshot(version)
        try:
            return _summarize(_core_month(snapshot, month, region), _indicator_month(snapshot, month, region))
        except (ValueError, KeyError, TypeError) as exc:
            raise SupabaseSourceError(f'Runoff source observations could not be normalized: {exc}') from exc
    return cached_call('runoff.month', version, month, region, loader=load)


def _monthly(version, start, end, region='National'):
    periods = pd.period_range(start, end, freq='M').astype(str).tolist()
    with ThreadPoolExecutor(max_workers=min(_workers(), len(periods))) as executor:
        parts = list(executor.map(lambda month: _month(version, month, region), periods))
    frames = [frame for frame, _ in parts if not frame.empty]
    if not frames:
        raise HTTPException(404, 'No runoff observations are available for this selection.')
    monthly = pd.concat(frames, ignore_index=True)
    constants = {key: monthly[key].dropna().iloc[0] for key in ['area', 'curve_number', 'impervious', 'response_time', 'reported_trend', 'land_cover'] if monthly[key].nunique() == 1}
    return monthly, {'constants': constants, 'peak_scaled': all(info['peak_scaled'] for _, info in parts),
                     'baseflow_scaled': all(info['baseflow_scaled'] for _, info in parts)}


def unique_period(frame, columns):
    groups = frame.groupby(['District_Name', 'month'])
    if groups[columns].nunique().gt(1).any().any():
        raise HTTPException(503, 'Conflicting repeated runoff values within a reporting month. Check the source table.')
    return groups[columns].first()


def prepare(core, indicators):
    core = core.rename(columns=CORE).copy()
    core['Date'] = pd.to_datetime(core.Date, errors='raise')
    for column in set(CORE.values()) - {'land_cover'}:
        core[column] = pd.to_numeric(core[column], errors='coerce')
    core = core.sort_values(['District_Name', 'Date']).drop_duplicates(['District_Name', 'Date'], keep='last')
    core['month'] = core.Date.dt.strftime('%Y-%m')
    core['volume'] = core.daily_volume / 1e6
    core['runoff_depth'] = core.daily_volume / (core.area.where(core.area > 0) * 1000)
    core['rainfall_volume'] = core.rainfall * core.area.where(core.area > 0) * 1000
    core['paired_runoff'] = core.daily_volume.where(core.rainfall_volume.notna())
    core['paired_rainfall'] = core.rainfall_volume.where(core.daily_volume.notna())
    grouped = core.groupby(['District_Name', 'month'])
    monthly = grouped[['volume', 'runoff_depth', 'rainfall', 'et', 'paired_runoff', 'paired_rainfall']].sum(min_count=1)
    monthly = monthly.join(grouped[['area', 'coefficient', 'soil_moisture', 'curve_number', 'impervious', 'baseflow']].mean())
    monthly['peak_flow'] = grouped.peak_flow.max()
    monthly['weighted_ratio'] = monthly.paired_runoff / monthly.paired_rainfall.where(monthly.paired_rainfall > 0)
    monthly['observed_days'] = grouped.daily_volume.count()
    monthly['baseflow_days'] = grouped.baseflow.count()
    monthly['expected_days'] = pd.PeriodIndex(monthly.index.get_level_values('month'), freq='M').days_in_month
    monthly['complete'] = monthly.observed_days.eq(monthly.expected_days)
    monthly = monthly.join(unique_period(core, ['reported_volume']))
    monthly['land_cover'] = grouped.land_cover.agg(lambda values: ' | '.join(sorted(set(values.dropna()))))
    indicators = indicators.rename(columns=DERIVED).copy()
    for column in DERIVED.values():
        indicators[column] = pd.to_numeric(indicators[column], errors='coerce')
    indicators['month'] = pd.to_datetime(dict(year=indicators.Year, month=indicators.Month, day=1)).dt.strftime('%Y-%m')
    monthly = monthly.join(unique_period(indicators, list(DERIVED.values())), how='outer')
    monthly['observed_days'] = monthly.observed_days.fillna(0)
    monthly['expected_days'] = pd.PeriodIndex(monthly.index.get_level_values('month'), freq='M').days_in_month
    monthly['complete'] = monthly.complete.fillna(False).astype(bool)
    return core, monthly.reset_index()


@dashboard_cache('runoff.metadata')
def _metadata(version):
    snapshot = _snapshot(version)
    core_table, derived_table = snapshot['tables']
    requests = [(core_table, {'select': 'Date', 'order': f'Date.{direction}', 'limit': '1'}) for direction in ('asc', 'desc')]
    requests += [(derived_table, {'select': 'Year,Month', 'order': f'Year.{direction},Month.{direction}', 'limit': '1'}) for direction in ('asc', 'desc')]
    with ThreadPoolExecutor(max_workers=4) as executor:
        bounds = list(executor.map(lambda spec: _pages(snapshot, *spec), requests))
    if any(not rows for rows in bounds):
        raise SupabaseSourceError('The runoff tables have no date coverage.')
    first_date, latest_date = bounds[0][0]['Date'], bounds[1][0]['Date']
    years = range(int(bounds[2][0]['Year']), int(bounds[3][0]['Year']) + 1)
    def catalogue(year):
        return _pages(snapshot, derived_table, {'select': 'District_Name,Year,Month', 'Year': f'eq.{year}', 'order': 'District_Name.asc,Year.asc,Month.asc'})
    with ThreadPoolExecutor(max_workers=_workers()) as executor:
        entries = [row for rows in executor.map(catalogue, years) for row in rows]
    months = sorted({f"{int(row['Year']):04}-{int(row['Month']):02}" for row in entries} | {first_date[:7], latest_date[:7]})
    regions = {row['District_Name'] for row in entries}
    latest, _ = _month(version, latest_date[:7])
    regions.update(latest.District_Name)
    end = latest_date[:7]
    assessed = latest
    # Inspect only the latest two reported months; metadata must not scan the
    # daily history when the supplied record has no complete observations.
    for month in [month for month in months if month <= latest_date[:7]][-2:][::-1]:
        candidate, _ = _month(version, month)
        if not candidate.empty and set(candidate.District_Name) == regions and candidate.complete.all():
            end, assessed = month, candidate
            break
    constants = {key: assessed[key].dropna().iloc[0] for key in ['area', 'curve_number', 'impervious', 'response_time', 'reported_trend', 'land_cover'] if assessed[key].nunique() == 1}
    start_bound = max(months[0], str(pd.Period(end, freq='M') - 23))
    default_start = next(month for month in months if start_bound <= month <= end)
    return {'source': 'Supabase', 'source_mode': 'database', 'source_tables': list(snapshot['tables']),
            'schema': snapshot['schema'], 'regions': sorted(regions), 'months': months,
            'default_start': default_start, 'default_end': end,
            'files': list(snapshot['tables']), 'core_rows': None, 'indicator_rows': len(entries),
            'first_date': first_date, 'latest_date': latest_date, 'constants': constants, 'constant_scope': end,
            'metrics': [{'key': k, 'label': label, 'unit': unit, 'method': method} for k, label, unit, method in METRICS]}


@router.get('/metadata')
@database_endpoint
def metadata():
    return clean(_metadata(signature()))


def validate(monthly, region, start, end):
    if region != 'National' and region not in monthly['regions']:
        raise HTTPException(404, 'Runoff district not found.')
    if start not in monthly['months'] or end not in monthly['months'] or start > end:
        raise HTTPException(422, 'Choose a valid start and end month from the runoff record.')


def regional(monthly, region):
    rows = monthly if region == 'National' else monthly[monthly.District_Name.eq(region)]
    series = rows.groupby('month').mean(numeric_only=True)
    series['complete'] = rows.groupby('month').complete.all()
    return series


@router.get('/dashboard')
@database_endpoint
def dashboard(region: str = 'National', start: str | None = None, end: str | None = None):
    version = signature()
    meta = _metadata(version)
    start, end = start or meta['default_start'], end or meta['default_end']
    validate(meta, region, start, end)
    history_start = max(meta['months'][0], str(pd.Period(start, freq='M') - 12))
    monthly, info = _monthly(version, history_start, end, region)
    full = regional(monthly, region)
    selected = full.loc[start:end].copy()
    for month, row in selected.iterrows():
        prior = str(pd.Period(month, freq='M') - 12)
        selected.loc[month, 'previous_volume'] = full.loc[prior, 'volume'] if row.complete and prior in full.index and full.loc[prior, 'complete'] else np.nan
    district_rows = monthly[monthly.month.between(start, end)]
    if region != 'National':
        district_rows = district_rows[district_rows.District_Name.eq(region)]
    # National totals remain district averages. A ratio is computed within each district first.
    sums = district_rows.groupby('District_Name')[['volume', 'rainfall', 'et', 'runoff_depth', 'paired_runoff', 'paired_rainfall']].sum(min_count=1)
    ratios = sums.paired_runoff / sums.paired_rainfall.where(sums.paired_rainfall > 0)
    summary = sums[['volume', 'rainfall', 'et', 'runoff_depth']].mean().to_dict()
    rates = district_rows.groupby('District_Name')
    rate_days = district_rows.baseflow_days.where(district_rows.baseflow.notna())
    baseflow = (district_rows.baseflow * rate_days).groupby(district_rows.District_Name).sum(min_count=1) / rate_days.groupby(district_rows.District_Name).sum(min_count=1)
    summary.update(weighted_ratio=ratios.mean(), peak_flow=rates.peak_flow.max().mean(), baseflow=baseflow.mean())
    latest = selected.iloc[-1].to_dict()
    latest_rows, _ = _month(version, end, 'National')
    years = selected.assign(year=selected.index.str[:4]).groupby('year')
    annual = years[['volume', 'rainfall', 'et', 'runoff_depth']].sum(min_count=1)
    annual['selected_months'] = years.size()
    annual['complete'] = years.complete.all() & annual.selected_months.eq(12)
    flood = [{'period': year, 'flow': latest[f'flood_{year}']} for year in PERIODS]
    warnings = []
    if not selected.complete.all():
        warnings.append('Incomplete months show observed runoff only. Year-on-year comparisons exclude incomplete months in either year.')
    if info['constants']:
        warnings.append('Several source attributes are identical within the loaded observations. They are supplied attributes, not evidence of spatial differences in catchment condition.')
    if info['peak_scaled'] and info['baseflow_scaled']:
        warnings.append('Peak flow and baseflow match fixed multiples of daily runoff / 86,400 (1.85 and 0.32 respectively, within rounding). They are not independent subdaily gauge observations in this table.')
    warnings.append('Return-period flows vary by source month; the distribution, fitting period and uncertainty are not supplied. They are source estimates, not a new flood-frequency fit or operational flood forecast.')
    return clean({'source': 'Supabase', 'source_mode': 'database', 'source_tables': meta['source_tables'],
                  'region': region, 'start': start, 'end': end, 'latest_date': meta['latest_date'],
                  'series': selected.reset_index().to_dict('records'), 'summary': summary, 'latest': latest,
                  'map': latest_rows.to_dict('records'), 'flood': flood, 'annual': annual.reset_index().to_dict('records'),
                  'land_cover': sorted(district_rows.land_cover.dropna().unique().tolist()),
                  'coverage': {'observed_days': district_rows.observed_days.sum(), 'expected_days': district_rows.expected_days.sum(),
                               'complete_months': int(selected.complete.sum()), 'months': len(selected)}, 'warnings': warnings})


@router.get('/forecast-source')
@database_endpoint
def forecast_source(region: str = 'National', start: str | None = None, end: str | None = None):
    """Return only the compact monthly series used by the forecast studio."""
    version = signature()
    meta = _metadata(version)
    months = meta['months']
    end = end or months[-1]
    start = start or max(months[0], str(pd.Period(end, freq='M') - 35))
    validate(meta, region, start, end)
    monthly, _ = _monthly(version, start, end, region)
    series = regional(monthly, region).loc[start:end].reset_index()
    if series.empty:
        raise HTTPException(404, 'No runoff observations are available for this forecast selection.')
    return clean({'source': 'Supabase', 'source_mode': 'database', 'source_tables': meta['source_tables'], 'region': region, 'start': start, 'end': end,
                  'series': series.to_dict('records'),
                  'metrics': [{'key': k, 'label': label, 'unit': unit, 'method': method} for k, label, unit, method in METRICS]})


@router.get('/daily')
@database_endpoint
def daily(region: str = 'National', month: str = '2026-08'):
    version = signature()
    meta = _metadata(version)
    validate(meta, region, month, month)
    raw = cached_call('runoff.daily', version, month, region, loader=lambda: _core_month(_snapshot(version), month, region))
    selected, _ = prepare(raw, pd.DataFrame(columns=['District_Name', 'Year', 'Month', *DERIVED]))
    rows = selected.groupby('Date')[['daily_volume', 'rainfall', 'et', 'runoff_depth', 'coefficient', 'soil_moisture', 'peak_flow', 'baseflow']].mean().reset_index()
    rows['date'] = rows.Date.dt.strftime('%Y-%m-%d')
    return clean({'source': 'Supabase', 'source_mode': 'database', 'source_tables': meta['source_tables'],
                  'region': region, 'month': month, 'series': rows.drop(columns='Date').to_dict('records')})
