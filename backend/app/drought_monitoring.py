"""Observed, date-aligned analysis for the combined drought dashboard."""
from concurrent.futures import ThreadPoolExecutor
import calendar
import math

import pandas as pd
from fastapi import APIRouter, Query

from app.drought_source import latest_rows, rows_at_date, region_history, normalise_region

router = APIRouter(prefix='/drought-monitoring')
TABLES = {'meteorological': 'meteorological_drought_master',
          'hydrological': 'hydrological_drought_master', 'satellite': 'satellite_remote_sensing'}
FIELDS = {
    'meteorological': [
        'tavg_c', 'tmin_c', 'tmax_c', 'pet_mm_day', 'et0_mm_day', 'relative_humidity_pct',
        'spi_1', 'spi_3', 'spi_6', 'spi_12', 'spi_24',
        'spei_1', 'spei_3', 'spei_6', 'spei_12', 'spei_24',
    ],
    'hydrological': ['river_discharge_m3_s', 'ssi_dimensionless', 'dam_level_pct_fsc', 'sgi_dimensionless', 'baseflow_separation_m3_s'],
    'satellite': ['ndvi', 'vhi', 'lst', 'surface_soil_moisture', 'rootzone_soil_moisture', 'grace_tws'],
}


def safe(value):
    if value is None or pd.isna(value):
        return None
    number = float(value)
    return round(number, 5) if math.isfinite(number) else None


def source_analysis(kind, rows):
    if not rows:
        return {'status': 'empty', 'latest': None, 'monthly': [], 'records': 0}
    frame = pd.DataFrame(rows).sort_values(['date', 'id'] if 'id' in rows[0] else ['date'])
    frame = frame.drop_duplicates('date', keep='last')
    monthly_source = bool(frame.get('_monthly_observation', pd.Series(dtype=bool)).fillna(False).any())
    frame['stamp'] = pd.to_datetime(frame['date'])
    frame['month_key'] = frame['stamp'].dt.strftime('%Y-%m')
    monthly = []
    for month, group in frame.groupby('month_key', sort=True):
        point = {'month': month}
        for field in FIELDS[kind]:
            point[field] = safe(pd.to_numeric(group[field], errors='coerce').mean()) if field in group else None
        if kind == 'meteorological':
            expected = calendar.monthrange(int(month[:4]), int(month[5:]))[1]
            point['observed_days'] = None if monthly_source else len(group)
            point['complete'] = True if monthly_source else len(group) == expected
            # Monthly fallback rows already contain a monthly total. Never
            # sum that value once per row as if it were a daily observation.
            if monthly_source and 'monthly_rainfall_mm_month' in group:
                point['rainfall_mm'] = safe(pd.to_numeric(group['monthly_rainfall_mm_month'], errors='coerce').mean())
            else:
                point['rainfall_mm'] = safe(pd.to_numeric(group['daily_rainfall_mm_day'], errors='coerce').sum(min_count=expected)) if 'daily_rainfall_mm_day' in group and point['complete'] else None
            for source, output, comparison in [('tmax_c', 'hot_days', lambda v: v > 35), ('tmin_c', 'frost_days', lambda v: v < 0)]:
                values = pd.to_numeric(group[source], errors='coerce') if source in group else pd.Series(dtype=float)
                point[output] = int(comparison(values).sum()) if not monthly_source and point['complete'] and values.notna().sum() == expected else None
        else:
            point['complete'] = True
        monthly.append(point)
    latest = {k: v if isinstance(v, str) else safe(v) for k, v in frame.iloc[-1].to_dict().items()
              if k not in {'id', 'stamp', 'month_key'} and not k.startswith('_')}
    annual = []
    if kind == 'meteorological':
        for year, group in frame.groupby(frame['stamp'].dt.year):
            expected = 12 if monthly_source else (366 if calendar.isleap(year) else 365)
            high = pd.to_numeric(group['tmax_c'], errors='coerce') if 'tmax_c' in group else pd.Series(dtype=float)
            low = pd.to_numeric(group['tmin_c'], errors='coerce') if 'tmin_c' in group else pd.Series(dtype=float)
            annual.append({'month': str(year), 'hot_days': None if monthly_source else (int((high > 35).sum()) if high.notna().any() else None),
                           'frost_days': None if monthly_source else (int((low < 0).sum()) if low.notna().any() else None),
                           'observed_days': int(group['month_key'].nunique()) if monthly_source else len(group), 'expected_days': expected,
                           'complete': bool(group['month_key'].nunique() == expected) if monthly_source else bool(high.notna().sum() == expected and low.notna().sum() == expected)})
    return {'status': 'ok', 'latest': latest, 'monthly': monthly, 'annual': annual, 'records': len(frame),
            'source': 'local_csv_fallback' if any(row.get('_niwis_source') == 'local_csv_fallback' for row in rows) else 'database',
            'start': str(frame.iloc[0]['date']), 'end': str(frame.iloc[-1]['date'])}


def load_source(kind, region):
    try:
        return source_analysis(kind, region_history(TABLES[kind], region))
    except Exception as exc:
        return {'status': 'error', 'error': str(exc), 'latest': None, 'monthly': [], 'records': 0}


def aligned_analysis(sources):
    lookup = {kind: {p['month']: p for p in source['monthly'] if p['complete']} for kind, source in sources.items()}
    common = sorted(set.intersection(*(set(points) for points in lookup.values())))
    month = common[-1] if common else None
    rows = {kind: points.get(month, {}) for kind, points in lookup.items()}
    specs = [('meteorological', 'spi_3', 'SPI-3', -1, '≤ −1'),
             ('hydrological', 'ssi_dimensionless', 'SSI', -1, '≤ −1'),
             ('satellite', 'vhi', 'Vegetation health', 40, '< 40')]
    signals = []
    for kind, field, name, threshold, label in specs:
        value = safe(rows[kind].get(field))
        dry = None if value is None else (value < threshold if field == 'vhi' else value <= threshold)
        signals.append({'source': kind, 'name': name, 'value': value, 'dry': dry, 'threshold': label})
    pairs = [(lookup['meteorological'][m].get('spi_3'), lookup['hydrological'][m].get('ssi_dimensionless')) for m in common]
    pairs = [(a, b) for a, b in pairs if a is not None and b is not None]
    correlation = safe(pd.DataFrame(pairs).corr().iloc[0, 1]) if len(pairs) >= 12 else None
    return {'month': month, 'signals': signals, 'dry_count': sum(s['dry'] is True for s in signals),
            'available_signals': sum(s['dry'] is not None for s in signals),
            'spi_ssi_correlation': correlation, 'paired_months': len(pairs)}


def seasonal_comparison(points, field):
    complete = [p for p in points if p.get('complete') and p.get(field) is not None]
    if not complete:
        return None
    current = complete[-1]
    past = [p for p in complete[:-1] if p['month'][5:] == current['month'][5:]]
    baseline = sum(p[field] for p in past) / len(past) if len(past) >= 3 else None
    delta = (current[field] - baseline) / abs(baseline) * 100 if baseline is not None and abs(baseline) > 1e-9 else None
    return {'month': current['month'], 'current': current[field], 'baseline': safe(baseline),
            'change_pct': safe(delta), 'baseline_years': len(past),
            'baseline_start': past[0]['month'] if past else None, 'baseline_end': past[-1]['month'] if past else None}


@router.get('/regions')
def regions(date: str | None = None):
    result, errors = {}, {}
    source_modes = set()
    def read(kind):
        try:
            return (rows_at_date(TABLES[kind], date) if date else latest_rows(TABLES[kind])), None
        except Exception as exc:
            return [], str(exc)
    with ThreadPoolExecutor(max_workers=3) as pool:
        for kind, (rows, error) in zip(TABLES, pool.map(read, TABLES)):
            if error:
                errors[kind] = error
            for row in rows:
                source_modes.add(row.get('_niwis_source', 'database'))
                key = normalise_region(row['district_name'])
                item = result.setdefault(key, {'key': key, 'name': row['district_name'].title(), 'sources': {}})
                item['sources'][kind] = {key: value for key, value in row.items() if not key.startswith('_')}
    source = 'local_csv_fallback' if 'local_csv_fallback' in source_modes else 'database'
    return {'regions': sorted(result.values(), key=lambda item: item['name']), 'errors': errors, 'source': source}


@router.get('/region')
def overview(region: str = Query(..., min_length=1)):
    with ThreadPoolExecutor(max_workers=3) as pool:
        sources = dict(zip(TABLES, pool.map(lambda kind: load_source(kind, region), TABLES)))
    comparisons = {kind: seasonal_comparison(sources[kind]['monthly'], field) for kind, field in
                   [('meteorological', 'rainfall_mm'), ('hydrological', 'river_discharge_m3_s'), ('satellite', 'ndvi')]}
    return {'region': region, 'sources': sources, 'alignment': aligned_analysis(sources), 'comparisons': comparisons}
