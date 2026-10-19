"""Runoff summaries preserve volumes, rates, depths and source reporting periods."""
import json
from pathlib import Path

import numpy as np
import pandas as pd
from fastapi import APIRouter, HTTPException
from app.dashboard_loader import dashboard_cache

router = APIRouter(prefix='/runoff', tags=['Runoff status'])
ROOT = Path(__file__).resolve().parents[2] / 'Runoff Status Monitoring'
FILES = ['7.1_runoff_variables_master.csv', '7.2_derived_runoff_indicators_master.csv']
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
    try:
        return tuple((ROOT / file).stat().st_mtime_ns for file in FILES)
    except FileNotFoundError as exc:
        raise HTTPException(503, 'Both configured runoff source files are required. A runoff file is missing.') from exc


def unique_period(frame, columns):
    groups = frame.groupby(['District_Name', 'month'])
    if groups[columns].nunique().gt(1).any().any():
        raise HTTPException(503, 'Conflicting repeated runoff values within a reporting month. Check the source file.')
    return groups[columns].first()


def prepare(core, indicators):
    core = core.rename(columns=CORE).copy()
    core['Date'] = pd.to_datetime(core.Date, errors='raise')
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
    monthly['expected_days'] = pd.PeriodIndex(monthly.index.get_level_values('month'), freq='M').days_in_month
    monthly['complete'] = monthly.observed_days.eq(monthly.expected_days)
    monthly = monthly.join(unique_period(core, ['reported_volume']))
    monthly['land_cover'] = grouped.land_cover.agg(lambda values: ' | '.join(sorted(set(values.dropna()))))
    indicators = indicators.rename(columns=DERIVED).copy()
    indicators['month'] = pd.to_datetime(dict(year=indicators.Year, month=indicators.Month, day=1)).dt.strftime('%Y-%m')
    monthly = monthly.join(unique_period(indicators, list(DERIVED.values())), how='outer')
    monthly['complete'] = monthly.complete.fillna(False).astype(bool)
    return core, monthly.reset_index()


@dashboard_cache('runoff.dataset')
def dataset(version):
    core_raw, derived_raw = [pd.read_csv(ROOT / file) for file in FILES]
    core, monthly = prepare(core_raw, derived_raw)
    constants = {key: monthly[key].dropna().iloc[0] for key in ['area', 'curve_number', 'impervious', 'response_time', 'reported_trend', 'land_cover'] if monthly[key].nunique() == 1}
    mean_rate = core.daily_volume / 86400
    return core, monthly, {'core_rows': len(core_raw), 'indicator_rows': len(derived_raw),
                           'first_date': str(core_raw.Date.min()), 'latest_date': str(core_raw.Date.max()),
                           'constants': constants,
                           'peak_scaled': bool(np.allclose(core.peak_flow, mean_rate * 1.85, atol=.000051, equal_nan=True)),
                           'baseflow_scaled': bool(np.allclose(core.baseflow, mean_rate * .32, atol=.000051, equal_nan=True))}


@router.get('/metadata')
def metadata():
    _, monthly, info = dataset(signature())
    months = sorted(monthly.month.unique().tolist())
    complete = monthly.groupby('month').complete.all()
    end = complete[complete].index.max() if complete.any() else months[-1]
    return clean({'regions': sorted(monthly.District_Name.unique().tolist()), 'months': months,
                  'default_start': max(months[0], str(pd.Period(end, freq='M') - 23)), 'default_end': end,
                  'files': FILES, 'metrics': [{'key': k, 'label': label, 'unit': unit, 'method': method} for k, label, unit, method in METRICS], **info})


def validate(monthly, region, start, end):
    if region != 'National' and region not in set(monthly.District_Name):
        raise HTTPException(404, 'Runoff district not found.')
    if start not in set(monthly.month) or end not in set(monthly.month) or start > end:
        raise HTTPException(422, 'Choose a valid start and end month from the runoff record.')


def regional(monthly, region):
    rows = monthly if region == 'National' else monthly[monthly.District_Name.eq(region)]
    series = rows.groupby('month').mean(numeric_only=True)
    series['complete'] = rows.groupby('month').complete.all()
    return series


@router.get('/dashboard')
def dashboard(region: str = 'National', start: str = '2024-09', end: str = '2026-08'):
    core, monthly, info = dataset(signature())
    validate(monthly, region, start, end)
    full = regional(monthly, region)
    selected = full.loc[start:end].copy()
    for month, row in selected.iterrows():
        prior = str(pd.Period(month, freq='M') - 12)
        selected.loc[month, 'previous_volume'] = full.loc[prior, 'volume'] if row.complete and prior in full.index and full.loc[prior, 'complete'] else np.nan
    district_rows = monthly[monthly.month.between(start, end)]
    core_rows = core[core.month.between(start, end)]
    if region != 'National':
        district_rows = district_rows[district_rows.District_Name.eq(region)]
        core_rows = core_rows[core_rows.District_Name.eq(region)]
    # National totals remain district averages. A ratio is computed within each district first.
    sums = district_rows.groupby('District_Name')[['volume', 'rainfall', 'et', 'runoff_depth', 'paired_runoff', 'paired_rainfall']].sum(min_count=1)
    ratios = sums.paired_runoff / sums.paired_rainfall.where(sums.paired_rainfall > 0)
    summary = sums[['volume', 'rainfall', 'et', 'runoff_depth']].mean().to_dict()
    summary.update(weighted_ratio=ratios.mean(), peak_flow=core_rows.groupby('District_Name').peak_flow.max().mean(),
                   baseflow=core_rows.groupby('District_Name').baseflow.mean().mean())
    latest = selected.iloc[-1].to_dict()
    latest_rows = monthly[monthly.month.eq(end)]
    years = selected.assign(year=selected.index.str[:4]).groupby('year')
    annual = years[['volume', 'rainfall', 'et', 'runoff_depth']].sum(min_count=1)
    annual['selected_months'] = years.size()
    annual['complete'] = years.complete.all() & annual.selected_months.eq(12)
    flood = [{'period': year, 'flow': latest[f'flood_{year}']} for year in PERIODS]
    warnings = []
    if not selected.complete.all():
        warnings.append('Incomplete months show observed runoff only. Year-on-year comparisons exclude incomplete months in either year.')
    if info['constants']:
        warnings.append('Several source attributes are identical across every district and date. They are supplied attributes, not evidence of spatial differences in catchment condition.')
    if info['peak_scaled'] and info['baseflow_scaled']:
        warnings.append('Peak flow and baseflow match fixed multiples of daily runoff / 86,400 (1.85 and 0.32 respectively, within rounding). They are not independent subdaily gauge observations in this file.')
    warnings.append('Return-period flows vary by source month; the distribution, fitting period and uncertainty are not supplied. They are source estimates, not a new flood-frequency fit or operational flood forecast.')
    return clean({'region': region, 'start': start, 'end': end, 'latest_date': info['latest_date'],
                  'series': selected.reset_index().to_dict('records'), 'summary': summary, 'latest': latest,
                  'map': latest_rows.to_dict('records'), 'flood': flood, 'annual': annual.reset_index().to_dict('records'),
                  'land_cover': sorted(district_rows.land_cover.dropna().unique().tolist()),
                  'coverage': {'observed_days': district_rows.observed_days.sum(), 'expected_days': district_rows.expected_days.sum(),
                               'complete_months': int(selected.complete.sum()), 'months': len(selected)}, 'warnings': warnings})


@router.get('/forecast-source')
def forecast_source(region: str = 'National', start: str | None = None, end: str | None = None):
    """Return only the compact monthly series used by the forecast studio."""
    _, monthly, info = dataset(signature())
    months = sorted(monthly.month.unique().tolist())
    end = end or months[-1]
    start = start or max(months[0], str(pd.Period(end, freq='M') - 35))
    validate(monthly, region, start, end)
    series = regional(monthly, region).loc[start:end].reset_index()
    if series.empty:
        raise HTTPException(404, 'No runoff observations are available for this forecast selection.')
    return clean({'source': 'Packaged runoff observations', 'region': region, 'start': start, 'end': end,
                  'series': series.to_dict('records'),
                  'metrics': [{'key': k, 'label': label, 'unit': unit, 'method': method} for k, label, unit, method in METRICS]})


@router.get('/daily')
def daily(region: str = 'National', month: str = '2026-08'):
    core, monthly, _ = dataset(signature())
    validate(monthly, region, month, month)
    selected = core[core.month.eq(month)]
    if region != 'National':
        selected = selected[selected.District_Name.eq(region)]
    rows = selected.groupby('Date')[['daily_volume', 'rainfall', 'et', 'runoff_depth', 'coefficient', 'soil_moisture', 'peak_flow', 'baseflow']].mean().reset_index()
    rows['date'] = rows.Date.dt.strftime('%Y-%m-%d')
    return clean({'region': region, 'month': month, 'series': rows.drop(columns='Date').to_dict('records')})
