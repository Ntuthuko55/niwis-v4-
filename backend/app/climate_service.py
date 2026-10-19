"""District climate summaries from the six Supabase climate indicator tables."""
import calendar
import json
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import pandas as pd
from fastapi import APIRouter, HTTPException
from scipy.stats import kendalltau, theilslopes

from app import climate_source
from app.climate_source import ClimateSourceError
from app.dashboard_loader import dashboard_cache

router = APIRouter(prefix='/climate', tags=['Climate'])
SEASONS = {'Annual': list(range(1, 13)), 'MAM': [3, 4, 5], 'JJA': [6, 7, 8], 'SON': [9, 10, 11], 'DJF': [12, 1, 2]}
# key, display name, unit, section, within-year reducer. Annual tables are already aggregated.
METRICS = [
    ('Tmin_C', 'Minimum temperature', '°C', 'temperature', 'mean'),
    ('Tmax_C', 'Maximum temperature', '°C', 'temperature', 'mean'),
    ('Tavg_C', 'Mean temperature', '°C', 'temperature', 'mean'),
    ('Temperature_Anomaly_C', 'Reported temperature anomaly', '°C', 'temperature', 'mean'),
    ('Heat_Days', 'Heatwave days (Tmax > 35°C)', 'days', 'temperature', 'sum'),
    ('Heat_Duration', 'Longest observed heat spell', 'days', 'temperature', 'max'),
    ('Frost_Days', 'Frost days (Tmin < 0°C)', 'days', 'temperature', 'sum'),
    ('LST_Day_C', 'Daytime land surface temperature', '°C', 'temperature', 'mean'),
    ('LST_Night_C', 'Nighttime land surface temperature', '°C', 'temperature', 'mean'),
    ('CWD_Days', 'Consecutive wet days', 'days', 'spells', 'annual'),
    ('CDD_Days', 'Consecutive dry days', 'days', 'spells', 'annual'),
    ('Rx1day_mm', 'Maximum 1-day rainfall', 'mm', 'spells', 'annual'),
    ('Rx5day_mm', 'Maximum 5-day rainfall', 'mm', 'spells', 'annual'),
    ('PRCPTOT_mm', 'Wet-day precipitation total', 'mm', 'spells', 'annual'),
    ('R10mm_Days', 'Days with rainfall ≥ 10 mm', 'days', 'spells', 'annual'),
    ('R20mm_Days', 'Days with rainfall ≥ 20 mm', 'days', 'spells', 'annual'),
    ('SDII_mm_per_wet_day', 'Wet-day rainfall intensity', 'mm/wet day', 'spells', 'annual'),
    ('MAP_mm', 'Annual rainfall', 'mm/year', 'rainfall', 'annual'),
    ('Precip_MAM_mm', 'Autumn rainfall (MAM)', 'mm', 'rainfall', 'annual'),
    ('Precip_JJA_mm', 'Winter rainfall (JJA)', 'mm', 'rainfall', 'annual'),
    ('Precip_SON_mm', 'Spring rainfall (SON)', 'mm', 'rainfall', 'annual'),
    ('Precip_DJF_mm', 'Summer rainfall (DJF)', 'mm', 'rainfall', 'annual'),
    ('Nino34_Annual_Mean', 'Niño 3.4 annual index', '°C', 'rainfall', 'annual'),
    ('Daily_ET0_mm', 'Reference ET₀', 'mm/day', 'evaporation', 'mean'),
    ('Daily_PET_mm', 'Potential evapotranspiration', 'mm/day', 'evaporation', 'mean'),
    ('Daily_AET_mm', 'Actual evapotranspiration', 'mm/day', 'evaporation', 'mean'),
    ('Daily_Pan_Evap_mm', 'Pan evaporation', 'mm/day', 'evaporation', 'mean'),
    ('Daily_VPD_kPa', 'Vapour pressure deficit', 'kPa', 'evaporation', 'mean'),
    ('SPEI_Daily', 'Reported daily SPEI', 'index', 'evaporation', 'mean'),
    ('CWR_mm_day', 'Crop water requirement', 'mm/day', 'irrigation', 'mean'),
    ('Irrigation_Water_Demand_mm', 'Irrigation demand (observed total)', 'mm', 'irrigation', 'sum'),
    ('Rainfall_Deficit_mm', 'Rainfall deficit (observed total)', 'mm', 'irrigation', 'sum'),
    ('Soil_Moisture_Deficit_m3m3', 'Soil moisture deficit', 'm³/m³', 'irrigation', 'mean'),
    ('Growing_Season_Temp_C', 'Growing season temperature', '°C', 'irrigation', 'mean'),
    ('Irrigation_Return_Flow_mm', 'Irrigation return flow (observed total)', 'mm', 'irrigation', 'sum'),
    ('MAR_m3_year', 'Mean annual runoff', 'm³/year', 'streamflow', 'annual'),
    ('Streamflow_Anomaly_percent', 'Reported streamflow anomaly', '%', 'streamflow', 'annual'),
    ('Q90_LowFlow_m3_year', 'Q90 low-flow volume', 'm³/year', 'streamflow', 'annual'),
    ('Q10_FloodFlow_m3_year', 'Q10 flood-flow volume', 'm³/year', 'streamflow', 'annual'),
    ('Rainfall_Runoff_Ratio', 'Rainfall–runoff ratio', 'ratio', 'streamflow', 'annual'),
    ('Climate_Streamflow_Elasticity', 'Climate–streamflow elasticity', 'ratio', 'streamflow', 'annual'),
]


def signature():
    try:
        return climate_source.signature()
    except ClimateSourceError as exc:
        raise HTTPException(503, str(exc)) from exc


def selected_sections(section=None):
    if section is not None and section not in climate_source.SECTIONS:
        raise HTTPException(422, 'Choose a valid climate section.')
    return (section,) if section else climate_source.SECTIONS


def source_columns(sections):
    derived = {'Heat_Days', 'Heat_Duration', 'Frost_Days'}
    return {section: [key for key, _, _, group, _ in METRICS if group == section and key not in derived]
            for section in sections}


def _read_sources(start, end, region, sections, date_start=None, date_stop=None):
    columns = source_columns(sections)
    try:
        raw = climate_source.read_frames(columns, start, end, region, date_start, date_stop)
    except ClimateSourceError as exc:
        raise HTTPException(503, str(exc)) from exc
    frames = {}
    try:
        for section, frame in raw.items():
            for column in columns[section]:
                frame[column] = pd.to_numeric(frame[column], errors='raise')
            if 'Date' in frame:
                frame['Date'] = pd.to_datetime(frame.Date, errors='raise')
                frame['Year'] = frame.Date.dt.year
            else:
                frame['Year'] = pd.to_numeric(frame.Year, errors='raise').astype(int)
            time = 'Date' if section in climate_source.DAILY else 'Year'
            if frame[['District_Name', time]].isna().any().any():
                raise ValueError(f'Missing district or {time} in {section}.')
            if frame.duplicated(['District_Name', time]).any():
                raise ValueError(f'Duplicate district/{time} observations in {section}.')
            frames[section] = frame.sort_values(['District_Name', time])
    except (ValueError, KeyError, TypeError) as exc:
        raise HTTPException(503, f'Invalid climate database observations: {exc}') from exc
    return frames


@dashboard_cache('climate.sources')
def sources(version, start, end, region, sections=None):
    return _read_sources(start, end, region, sections or climate_source.SECTIONS)


def aggregate_daily(frame, section, season):
    frame = frame[frame.Date.dt.month.isin(SEASONS[season])].copy()
    if section == 'temperature':
        # Source heatwave frequency is an annual count repeated on daily rows.
        # Compute counts and contiguous runs from observations instead of summing it.
        frame['Heat_Days'] = (frame.Tmax_C > 35).astype(float).where(frame.Tmax_C.notna())
        frame['Frost_Days'] = (frame.Tmin_C < 0).astype(float).where(frame.Tmin_C.notna())
        hot = frame.Heat_Days.eq(1)
        breaks = (~hot | frame.Date.diff().ne(pd.Timedelta(days=1)) |
                  frame.District_Name.ne(frame.District_Name.shift()) | frame.Year.ne(frame.Year.shift()))
        frame['Heat_Duration'] = hot.groupby(breaks.cumsum()).cumsum().astype(float).where(frame.Tmax_C.notna())
    reducers = {key: reducer for key, _, _, group, reducer in METRICS if group == section}
    # min_count preserves unknown totals rather than turning all-null data into zero.
    reducers = {key: (lambda x: x.sum(min_count=1)) if value == 'sum' else value for key, value in reducers.items()}
    grouped = frame.groupby(['District_Name', 'Year'])
    result = grouped.agg(reducers)
    result[f'{section}_days'] = grouped.Date.nunique()
    result[f'{section}_expected'] = [sum(calendar.monthrange(int(y), m)[1] for m in SEASONS[season]) for _, y in result.index]
    return result


@dashboard_cache('climate.annual')
def annual_data(version, season, start, end, region, sections=None):
    packs = _year_rollups(version, start, end, region, sections or climate_source.SECTIONS)
    return pd.concat([pack['annual'][season] for pack in packs], ignore_index=True)


@dashboard_cache('climate.year-section')
def section_year_rollup(version, year, region, section):
    """One compact cache entry serves the overview and this section's pages."""
    frame = _read_sources(year, year, region, (section,))[section]
    annual = {season: (aggregate_daily(frame, section, season) if section in climate_source.DAILY
                       else frame.set_index(['District_Name', 'Year'])).reset_index() for season in SEASONS}
    monthly = _monthly_district_frame(frame, section) if section in climate_source.DAILY else pd.DataFrame(columns=['District_Name', 'month'])
    return {'annual': annual, 'monthly': monthly}


@dashboard_cache('climate.year-rollup')
def year_rollup(version, year, region, sections):
    """Join section summaries without retaining the larger daily source frames."""
    with ThreadPoolExecutor(max_workers=min(3, len(sections))) as executor:
        packs = list(executor.map(lambda section: section_year_rollup(version, year, region, section), sections))
    annual = {season: pd.concat([pack['annual'][season].set_index(['District_Name', 'Year']) for pack in packs], axis=1).reset_index()
              for season in SEASONS}
    monthly_parts = [pack['monthly'] for section, pack in zip(sections, packs) if section in climate_source.DAILY]
    monthly = pd.DataFrame(columns=['District_Name', 'month'])
    if monthly_parts:
        monthly = monthly_parts[0]
        for part in monthly_parts[1:]:
            monthly = monthly.merge(part, on=['District_Name', 'month'], how='outer')
    return {'annual': annual, 'monthly': monthly}


def _year_rollups(version, start, end, region, sections):
    # The source adapter also caps total upstream concurrency across requests.
    with ThreadPoolExecutor(max_workers=min(2, end - start + 1)) as executor:
        return list(executor.map(lambda year: year_rollup(version, year, region, sections), range(start, end + 1)))


def clean(value):
    # pandas JSON handles numpy scalars, NaN and infinities without nonstandard JSON.
    return json.loads(pd.Series([value]).to_json(orient='values', force_ascii=False))[0]


@router.get('/metadata')
def metadata():
    return metadata_for(signature())


@dashboard_cache('climate.metadata')
def metadata_for(version):
    try:
        descriptions, regions, years = climate_source.describe_tables()
    except ClimateSourceError as exc:
        raise HTTPException(503, str(exc)) from exc
    temperature = next(source for source in descriptions if source['section'] == 'temperature')
    daily_sources = [source for source in descriptions if source.get('frequency') == 'Daily']
    daily_first = [pd.Timestamp(source['first_date']) for source in daily_sources if source.get('first_date')]
    daily_last = [pd.Timestamp(source['last_date']) for source in daily_sources if source.get('last_date')]
    # Use the common daily boundary.  If one source ends earlier than another,
    # exposing the earliest end prevents a default request from manufacturing
    # values for a metric whose source has already stopped.
    first = max(daily_first) if daily_first else None
    latest = min(daily_last) if daily_last else None
    month_sets = [set(source.get('months', [])) for source in daily_sources if source.get('months')]
    observed_months = sorted(set.intersection(*month_sets)) if month_sets else []
    if not observed_months and first is not None and latest is not None:
        observed_months = [str(period) for period in pd.period_range(first, latest, freq='M')]
    # The source adapter provides the observed month catalogue.  A
    # database deployment may only provide boundaries, so derive the compact
    # month list from those boundaries without consulting today's date.
    daily_months = observed_months
    annual_months = sorted({f'{year:04d}-12' for year in years})
    observed_months = sorted(set(daily_months).union(annual_months))
    first_month = observed_months[0] if observed_months else (first.strftime('%Y-%m') if first is not None else None)
    # The default map month must be the last observed daily month. Annual
    # tables are exposed at December only and must not force daily indicators
    # to appear as if they continued beyond the daily source boundary.
    latest_month = daily_months[-1] if daily_months else (observed_months[-1] if observed_months else (latest.strftime('%Y-%m') if latest is not None else None))
    available_end = int(latest.year) if latest is not None else int(years[-1])
    return {
        'source': climate_source.source_label(),
        'regions': regions,
        'years': years,
        'default_end': int(available_end),
        'first_daily_date': first.strftime('%Y-%m-%d') if first is not None else None,
        'months': observed_months,
        'daily_months': daily_months,
        'annual_months': annual_months,
        'default_start_month': first_month,
        'default_end_month': latest_month,
        'latest_month': latest_month,
        'latest_daily_date': latest.strftime('%Y-%m-%d') if latest is not None else None,
        'sources': descriptions,
        'baseline_available': temperature['first_year'] <= 1981 and temperature['last_year'] >= 2010,
        'metrics': [{'key': k, 'label': label, 'unit': unit, 'section': section, 'aggregation': agg} for k, label, unit, section, agg in METRICS],
    }


def rainfall_statistics(series):
    if 'MAP_mm' not in series or 'Nino34_Annual_Mean' not in series:
        return {'years': 0, 'cv_percent': None, 'sens_slope': None, 'kendall_p': None, 'enso_r': None, 'enso_pairs': 0}
    pairs = series[['Year', 'MAP_mm', 'Nino34_Annual_Mean']].dropna(subset=['MAP_mm'])
    rainfall = pairs.MAP_mm
    result = {'years': len(pairs), 'cv_percent': None, 'sens_slope': None, 'kendall_p': None, 'enso_r': None, 'enso_pairs': 0}
    if len(rainfall) >= 2 and rainfall.mean() != 0:
        result['cv_percent'] = rainfall.std(ddof=1) / rainfall.mean() * 100
    if len(rainfall) >= 3:
        result['sens_slope'] = theilslopes(rainfall, pairs.Year).slope
        result['kendall_p'] = kendalltau(pairs.Year, rainfall).pvalue
    enso = pairs.dropna(subset=['Nino34_Annual_Mean'])
    result['enso_pairs'] = len(enso)
    if len(enso) >= 3 and enso.MAP_mm.std() > 0 and enso.Nino34_Annual_Mean.std() > 0:
        result['enso_r'] = enso.MAP_mm.corr(enso.Nino34_Annual_Mean)
    return result


@router.get('/dashboard')
def dashboard(region: str = 'National', start: int = 2000, end: int = 2025, season: str = 'Annual',
              section: str | None = None, include_map: bool = True):
    if season not in SEASONS:
        raise HTTPException(422, 'Choose Annual, MAM, JJA, SON or DJF.')
    if start > end:
        raise HTTPException(422, 'The start year must not exceed the end year.')
    version = signature()
    meta = metadata_for(version)
    sections = selected_sections(section)
    if start not in meta['years'] or end not in meta['years']:
        raise HTTPException(422, 'Choose years within the climate source record.')
    if region != 'National' and region not in meta['regions']:
        raise HTTPException(404, 'Climate district not found.')
    # A district selection controls the chart series, but it must not shrink
    # the data used to paint the district map.  Daily sources are intentionally
    # narrowed for a district request in ``climate_source.read_frames``; if we
    # reused that frame for the map, daily indicators (temperature, ET and
    # irrigation) would be null for every other district and render as the
    # map's no-data colour.  The national frame is already cached after the
    # initial dashboard load and gives the map a complete set of district
    # values for the same period and season.
    data = annual_data(version, season, start, end, region if region != 'National' else None, sections)
    selected = data[data.Year.between(start, end)]
    if selected.empty:
        raise HTTPException(422, 'No climate observations fall within this time period.')
    numeric = [key for key, _, _, group, _ in METRICS if group in sections]
    map_rows = pd.DataFrame(columns=['District_Name', *numeric])
    if include_map:
        map_data = data if region == 'National' else annual_data(version, season, start, end, None, sections)
        map_rows = map_data[map_data.Year.between(start, end)].groupby('District_Name')[numeric].mean().reset_index()
    region_data = selected if region == 'National' else selected[selected.District_Name == region]
    if region_data.empty:
        raise HTTPException(422, 'No climate observations for this district fall within this time period.')
    # Equal district weights, including flow volumes: never imply a national catchment sum.
    series = region_data.groupby('Year').mean(numeric_only=True).reset_index()
    stats = rainfall_statistics(series)
    coverage = []
    for section in ('temperature', 'evaporation', 'irrigation'):
        if section not in sections:
            continue
        observed = region_data[f'{section}_days'].fillna(0)
        expected = region_data.Year.map(lambda year: sum(calendar.monthrange(int(year), month)[1] for month in SEASONS[season]))
        coverage.append({'section': section, 'observed': int(observed.sum()), 'expected': int(expected.sum()),
                         'incomplete_district_years': int((observed < expected).sum())})
    warnings = []
    if len(series) < 30:
        warnings.append(f'This selection contains {len(series)} years of observations. At least 30 years are required for the specified long-term climate baseline; shorter-period trends are exploratory.')
    if not meta['baseline_available']:
        warnings.append('The temperature table does not span the full 1981–2010 baseline. Reported anomalies are retained; that baseline cannot be independently established from these records.')
    if any(c['incomplete_district_years'] for c in coverage):
        warnings.append('Daily records have gaps. Heat/frost counts, heat duration and irrigation totals describe observed days; missing days are not filled or annualised.')
    if 'SPEI_Daily' in series and series['SPEI_Daily'].notna().sum() == 0:
        warnings.append('SPEI_Daily is not present in the connected evaporation table for this selection; the index is shown as unavailable.')
    latest = pd.Timestamp(meta['latest_daily_date']) if meta['latest_daily_date'] else None
    if latest is not None and end >= latest.year and (latest.month, latest.day) != (12, 31):
        warnings.append(f'{latest.year} is incomplete: daily data stops on {latest:%d %b %Y}. Annual source rows for this year may also be provisional.')
    return clean({'source': climate_source.source_label(), 'region': region, 'start': start, 'end': end, 'season': season,
                  'series': series.to_dict('records'), 'summary': series[numeric].mean().to_dict(),
                  'map': map_rows.to_dict('records'), 'rainfall_statistics': stats,
                  'coverage': coverage, 'warnings': warnings,
                  'aggregation': 'Equal-weight district mean' if region == 'National' else 'District observations',
                  'latest_daily_date': latest.strftime('%Y-%m-%d') if latest is not None else None})


def _monthly_district_frame(frame, section):
    """Aggregate one daily source to district/month without annualising it."""
    if frame.empty:
        return pd.DataFrame(columns=['District_Name', 'month'])
    frame = frame.copy()
    frame['month'] = frame['Date'].dt.to_period('M').astype(str)
    keys = [key for key, _, _, group, _ in METRICS
            if group == section and key not in {'Heat_Days', 'Heat_Duration', 'Frost_Days'}]
    grouped = frame.groupby(['District_Name', 'month'], sort=False)
    parts = []
    for key in keys:
        reducer = next(item[-1] for item in METRICS if item[0] == key)
        values = grouped[key].sum(min_count=1) if reducer == 'sum' else grouped[key].mean()
        parts.append(values.rename(key))
    if section == 'temperature':
        heat = frame.assign(Heat_Days=(frame['Tmax_C'] > 35).astype(float).where(frame['Tmax_C'].notna()),
                            Frost_Days=(frame['Tmin_C'] < 0).astype(float).where(frame['Tmin_C'].notna()))
        heat_grouped = heat.groupby(['District_Name', 'month'], sort=False)
        parts.extend([
            heat_grouped['Heat_Days'].sum(min_count=1).rename('Heat_Days'),
            heat_grouped['Frost_Days'].sum(min_count=1).rename('Frost_Days'),
        ])
    if not parts:
        return frame[['District_Name', 'month']].drop_duplicates()
    return pd.concat(parts, axis=1).reset_index()


def _annual_district_frame(frames):
    """Join annual source rows; keep them separate from monthly observations."""
    parts = []
    for section in ('spells', 'rainfall', 'streamflow'):
        frame = frames.get(section)
        if frame is None or frame.empty:
            continue
        keys = [key for key, _, _, group, _ in METRICS if group == section]
        parts.append(frame[['District_Name', 'Year', *keys]])
    if not parts:
        return pd.DataFrame(columns=['District_Name', 'Year'])
    result = parts[0]
    for part in parts[1:]:
        result = result.merge(part, on=['District_Name', 'Year'], how='outer')
    return result


def _map_rows_for_date(frames, annual_frames, date):
    """Return district map rows for an exact observed date.

    Daily indicators use the requested day.  Annual-only indicators are
    attached for that day's year and are never copied into every month.
    """
    date = pd.Timestamp(date).normalize()
    daily_parts = []
    for section in ('temperature', 'evaporation', 'irrigation'):
        frame = frames.get(section)
        if frame is None or frame.empty:
            continue
        keys = [key for key, _, _, group, _ in METRICS
                if group == section and key not in {'Heat_Days', 'Heat_Duration', 'Frost_Days'}]
        selected = frame[frame['Date'].dt.normalize().eq(date)]
        if selected.empty:
            continue
        daily_parts.append(selected.groupby('District_Name', as_index=False)[keys].mean(numeric_only=True))
    if daily_parts:
        result = daily_parts[0]
        for part in daily_parts[1:]:
            result = result.merge(part, on='District_Name', how='outer')
    else:
        result = pd.DataFrame(columns=['District_Name'])
    annual = _annual_district_frame(annual_frames)
    if not annual.empty:
        annual = annual[annual['Year'].eq(int(date.year))].drop(columns='Year')
        result = annual if result.empty else result.merge(annual, on='District_Name', how='outer')
    return result


def _legacy_monthly(region: str = 'National', start: str = '2000', end: str = '2025', month: str | None = None,
            map_date: str | None = None):
    """Return monthly climate drivers for the shared LSTM forecasting studio.

    The dashboard endpoint intentionally returns annual indicators. Forecasting
    needs the native monthly cadence, so aggregate the daily temperature,
    evaporation and irrigation tables by district/month before taking the
    equal-weight national mean.
    """
    def as_period(value, boundary):
        text = str(value)
        try:
            if len(text) == 7 and text[4] == '-':
                return pd.Period(text, freq='M')
            year = int(text)
            return pd.Period(f'{year:04d}-{boundary}', freq='M')
        except (TypeError, ValueError) as exc:
            raise HTTPException(422, 'Climate monthly bounds must be YYYY or YYYY-MM.') from exc

    start_period = as_period(start, '01')
    end_period = as_period(end, '12')
    if start_period > end_period:
        raise HTTPException(422, 'The start month must not exceed the end month.')
    start_year, end_year = start_period.year, end_period.year
    version = signature()
    meta = metadata_for(version)
    if region != 'National' and region not in meta['regions']:
        raise HTTPException(404, 'Climate district not found.')
    frames = sources(version, start_year, end_year, region if region != 'National' else None)
    parts = [_monthly_district_frame(frames[section], section)
             for section in ('temperature', 'evaporation', 'irrigation')
             if not frames[section].empty]
    if not parts:
        raise HTTPException(422, 'No monthly climate observations are available for this period.')
    district_series = parts[0]
    for part in parts[1:]:
        district_series = district_series.merge(part, on=['District_Name', 'month'], how='outer')
    district_series['month_period'] = pd.PeriodIndex(district_series['month'], freq='M')
    district_series = district_series[district_series.month_period.between(start_period, end_period)].drop(columns='month_period')
    if district_series.empty:
        raise HTTPException(422, 'No monthly climate observations are available for this period.')
    # Keep daily variables in the monthly series. Annual-only source fields
    # are returned separately below so a yearly value is never repeated for
    # every month.
    variables = [key for key, _, _, group, _ in METRICS
                 if group in {'temperature', 'evaporation', 'irrigation'}
                 and key not in {'Heat_Days', 'Heat_Duration', 'Frost_Days'}]
    variables.extend(key for key in ('Heat_Days', 'Frost_Days') if key in district_series.columns)
    series = district_series.groupby('month', as_index=False)[variables].mean(numeric_only=True)
    series = series.sort_values('month').reset_index(drop=True)
    # A district selection filters the chart, but the map remains a complete
    # national frame. This mirrors the annual dashboard's map behaviour.
    daily_months = sorted(series['month'].dropna().astype(str).unique().tolist())
    annual_months = [month_value for month_value in (meta.get('annual_months') or [])
                     if str(start_period) <= month_value <= str(end_period)]
    available_months = sorted(set(daily_months).union(annual_months))

    # The map remains national when a district chart is selected.  If the map
    # date falls outside the chart window, load only that source year rather
    # than silently substituting today's date or a repeated last chart value.
    if map_date:
        try:
            requested_date = pd.Timestamp(map_date).normalize()
        except (TypeError, ValueError) as exc:
            raise HTTPException(422, 'Climate map date must be YYYY-MM-DD.') from exc
    elif month:
        try:
            requested_period = pd.Period(str(month), freq='M')
        except (TypeError, ValueError) as exc:
            raise HTTPException(422, 'Climate map month must be YYYY-MM.') from exc
        if str(requested_period) not in set(available_months):
            raise HTTPException(422, f'No monthly climate observations are available for {requested_period}.')
        # Pick the last observed day in the requested month, not an invented
        # month-end date (the supplied files end on the 30th in full years).
        observed = frames['temperature'].loc[frames['temperature']['Date'].dt.to_period('M').eq(requested_period), 'Date']
        if observed.empty:
            if str(requested_period) in annual_months:
                # Annual tables are represented at December year-end; do not
                # fabricate a daily observation for that source cadence.
                requested_date = requested_period.to_timestamp('M')
            else:
                raise HTTPException(422, f'No daily climate observations are available for {requested_period}.')
        else:
            # Pick the last observed day in the requested month, not an
            # invented month-end date (the supplied files end on the 30th in
            # full years).
            requested_date = observed.max().normalize()
    else:
        latest = pd.Timestamp(meta['latest_daily_date']) if meta.get('latest_daily_date') else None
        if latest is None:
            requested_date = pd.Period(available_months[-1], freq='M').to_timestamp('M')
        else:
            requested_date = latest.normalize()

    map_year = int(requested_date.year)
    map_frames = frames if start_year <= map_year <= end_year and region == 'National' else sources(version, map_year, map_year, None)
    annual_frames = frames if start_year <= map_year <= end_year and region == 'National' else sources(version, map_year, map_year, None)
    # For a district chart, use the complete national map frame; for a
    # national chart the already-loaded frames are complete as well.
    # The date map needs only its source year, even when the chart spans decades.
    observed_dates = pd.DatetimeIndex(map_frames['temperature']['Date'].dropna().dt.normalize().unique())
    is_annual_snapshot = requested_date.strftime('%Y-%m') in set(meta.get('annual_months') or [])
    if requested_date not in observed_dates and not is_annual_snapshot:
        raise HTTPException(422, f'No daily climate observations are available for {requested_date:%Y-%m-%d}.')
    map_rows = _map_rows_for_date(map_frames, annual_frames, requested_date)
    annual_district = _annual_district_frame(frames)
    annual_series = annual_district.groupby('Year', as_index=False)[[key for key, *_ in METRICS if key in annual_district.columns]].mean(numeric_only=True) if region == 'National' else annual_district.drop(columns='District_Name', errors='ignore')
    annual_variables = [key for key, *_ in METRICS if key in annual_series.columns and key not in {'Year'}]
    return clean({'source': climate_source.source_label(), 'region': region, 'start': str(start_period), 'end': str(end_period),
                  'series': series.to_dict('records'), 'summary': series[variables].mean(numeric_only=True).to_dict(), 'variables': variables,
                  'map_variables': [*variables, *annual_variables],
                  'annual_series': annual_series.to_dict('records'), 'annual_variables': annual_variables,
                  'map': map_rows.to_dict('records'), 'map_date': requested_date.strftime('%Y-%m-%d'),
                  'map_month': requested_date.strftime('%Y-%m'), 'months': available_months,
                  'available_months': meta.get('months') or available_months,
                  'latest_month': meta.get('latest_month') or available_months[-1],
                  'latest_daily_date': meta.get('latest_daily_date'),
                  'aggregation': 'Equal-weight district monthly mean' if region == 'National' else 'District monthly observations'})


def _monthly_bounds(start, end, meta):
    def as_period(value, boundary):
        text = str(value)
        try:
            return pd.Period(text if len(text) == 7 else f'{int(text):04d}-{boundary}', freq='M')
        except (TypeError, ValueError) as exc:
            raise HTTPException(422, 'Climate monthly bounds must be YYYY or YYYY-MM.') from exc
    first, last = as_period(start, '01'), as_period(end, '12')
    if first > last or first.year not in meta['years'] or last.year not in meta['years']:
        raise HTTPException(422, 'Choose ordered months within the climate source record.')
    return first, last


@dashboard_cache('climate.map')
def map_for(version, section, month, map_date):
    meta = metadata_for(version)
    sections = selected_sections(section)
    try:
        requested = pd.Timestamp(map_date).normalize() if map_date else None
        period = pd.Period(requested if requested is not None else month or meta['latest_month'], freq='M')
        if str(period) not in meta['months']:
            raise ValueError('Month outside the source record')
    except (TypeError, ValueError) as exc:
        raise HTTPException(422, 'Choose a valid observed climate map month or date.') from exc
    daily = [name for name in sections if name in climate_source.DAILY]
    actual_date = None
    if daily:
        reference = 'temperature' if 'temperature' in daily else daily[0]
        try:
            actual_date = climate_source.last_observed_date(reference, str(period))
        except ClimateSourceError as exc:
            raise HTTPException(503, str(exc)) from exc
        if requested is None:
            requested = pd.Timestamp(actual_date) if actual_date else period.to_timestamp('M')
        if actual_date is None and str(period) not in meta.get('annual_months', []):
            raise HTTPException(422, 'No daily climate map observations are available for this month.')
    requested = requested if requested is not None else period.to_timestamp('M')
    stop = requested + pd.Timedelta(days=1)
    frames = _read_sources(requested.year, requested.year, None, sections,
                           str(requested.date()), str(stop.date()))
    if daily and map_date and not any(not frames[name].empty for name in daily):
        raise HTTPException(422, 'No daily climate observations are available for this source date.')
    rows = _map_rows_for_date(frames, frames, requested)
    # A missing measurement never removes the district boundary or becomes zero.
    rows = pd.DataFrame({'District_Name': meta['regions']}).merge(rows, on='District_Name', how='left')
    variables = [key for key, _, _, group, _ in METRICS
                 if group in daily and key not in {'Heat_Days', 'Heat_Duration', 'Frost_Days'}]
    annual_variables = [key for key, _, _, group, _ in METRICS
                        if group in sections and group not in climate_source.DAILY]
    return clean({'source': climate_source.source_label(), 'map': rows.to_dict('records'),
                  'map_date': requested.strftime('%Y-%m-%d'), 'map_month': str(period),
                  'variables': variables, 'map_variables': [*variables, *annual_variables],
                  'annual_variables': annual_variables,
                  'source_day': requested.strftime('%Y-%m-%d') if daily and actual_date else None,
                  'aggregation': 'National district source snapshot'})


@router.get('/map')
def map_view(month: str | None = None, map_date: str | None = None, section: str | None = None):
    return map_for(signature(), section, month, map_date)


@router.get('/monthly')
def monthly(region: str = 'National', start: str = '2000', end: str = '2025', month: str | None = None,
            map_date: str | None = None, section: str | None = None, include_map: bool = True):
    # Keep the existing complete response for callers that have not opted into
    # independent chart and map reads. Monitoring pages use the compact path.
    if include_map and section is None:
        return _legacy_monthly(region, start, end, month, map_date)
    version = signature()
    meta = metadata_for(version)
    sections = selected_sections(section)
    first, last = _monthly_bounds(start, end, meta)
    if region != 'National' and region not in meta['regions']:
        raise HTTPException(404, 'Climate district not found.')
    packs = _year_rollups(version, first.year, last.year, None if region == 'National' else region, sections)
    district_series = pd.concat([pack['monthly'] for pack in packs], ignore_index=True)
    variables = [key for key, _, _, group, _ in METRICS
                 if group in sections and group in climate_source.DAILY
                 and key not in {'Heat_Days', 'Heat_Duration', 'Frost_Days'}]
    variables.extend(key for key in ('Heat_Days', 'Frost_Days') if key in district_series)
    if variables:
        district_series = district_series[district_series.month.between(str(first), str(last))]
        if district_series.empty:
            raise HTTPException(422, 'No monthly climate observations are available for this period.')
        series = district_series.groupby('month', as_index=False)[variables].mean(numeric_only=True).sort_values('month')
    else:
        series = pd.DataFrame(columns=['month'])
    annual_variables = [key for key, _, _, group, _ in METRICS
                        if group in sections and group not in climate_source.DAILY]
    annual_rows = pd.concat([pack['annual']['Annual'] for pack in packs], ignore_index=True)
    annual_series = annual_rows.groupby('Year', as_index=False)[annual_variables].mean(numeric_only=True) if annual_variables else pd.DataFrame(columns=['Year'])
    map_result = map_view(month, map_date, section) if include_map else {'map': [], 'map_date': None, 'map_month': None}
    months = sorted(set(district_series.month.tolist()).union(value for value in meta['annual_months'] if str(first) <= value <= str(last)))
    return clean({'source': climate_source.source_label(), 'region': region, 'start': str(first), 'end': str(last),
                  'series': series.to_dict('records'), 'summary': series[variables].mean(numeric_only=True).to_dict() if variables else {},
                  'variables': variables, 'annual_series': annual_series.to_dict('records'),
                  'annual_variables': annual_variables, 'map_variables': [*variables, *annual_variables],
                  'months': months, 'available_months': meta['months'], 'latest_month': meta['latest_month'],
                  'latest_daily_date': meta['latest_daily_date'],
                  'aggregation': 'Equal-weight district monthly mean' if region == 'National' else 'District monthly observations',
                  **{key: value for key, value in map_result.items() if key != 'variables'}})
