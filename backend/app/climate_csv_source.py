"""Local CSV reader for the six NIWIS climate indicator tables."""
from pathlib import Path
from threading import Lock

import pandas as pd

SECTIONS = ('temperature', 'spells', 'rainfall', 'evaporation', 'irrigation', 'streamflow')
DAILY = {'temperature', 'evaporation', 'irrigation'}
ROOT = Path(__file__).resolve().parents[2] / 'climate'
FILES = {
    'temperature': ROOT / 'section_4_1_temperature_change_master.csv',
    'spells': ROOT / 'section_4_2_wet_dry_spells_master.csv',
    'rainfall': ROOT / 'section_4_3_Mean Annual Precipitation (MAP)_master.csv',
    'evaporation': ROOT / 'section_4_4_evaporation_daily_master.csv',
    'irrigation': ROOT / 'section_4_5_irrigation_daily_master.csv',
    'streamflow': ROOT / 'section_4_6_streamflow_annual_master.csv',
}

class ClimateSourceError(RuntimeError):
    """A missing or invalid local climate source."""

_CACHE = {}
_CACHE_LOCK = Lock()

def _check_files():
    missing = [str(path) for path in FILES.values() if not path.exists()]
    if missing:
        raise ClimateSourceError(f'Missing climate CSV source(s): {", ".join(missing)}')

def signature():
    _check_files()
    return tuple((section, str(path), path.stat().st_mtime_ns, path.stat().st_size)
                 for section, path in FILES.items())

def _load(section, columns):
    key = (section, tuple(columns))
    current = signature()
    with _CACHE_LOCK:
        entry = _CACHE.get(key)
        if entry and entry[0] == current:
            return entry[1].copy(deep=True)
    path = FILES[section]
    time_column = 'Date' if section in DAILY else 'Year'
    try:
        frame = pd.read_csv(path, usecols=['District_Name', time_column, *columns], low_memory=False)
    except (OSError, ValueError, KeyError, pd.errors.ParserError) as exc:
        raise ClimateSourceError(f'Unable to read {path.name}: {exc}') from exc
    if time_column == 'Date':
        frame['Date'] = pd.to_datetime(frame['Date'], errors='raise')
        frame['Year'] = frame['Date'].dt.year
    else:
        frame['Year'] = pd.to_numeric(frame['Year'], errors='raise').astype(int)
    frame = frame.dropna(subset=['District_Name']).sort_values(['District_Name', time_column])
    with _CACHE_LOCK:
        _CACHE[key] = (current, frame.copy(deep=True))
    return frame

def read_frames(columns, start=None, end=None, region=None, date_start=None, date_stop=None):
    """Read requested columns from the local CSV sources."""
    _check_files()
    result = {}
    for section in columns:
        frame = _load(section, columns[section])
        if start is not None:
            frame = frame[frame.Year >= int(start)]
        if end is not None:
            frame = frame[frame.Year <= int(end)]
        if section in DAILY and date_start:
            frame = frame[frame.Date >= pd.Timestamp(date_start)]
        if section in DAILY and date_stop:
            frame = frame[frame.Date < pd.Timestamp(date_stop)]
        if region:
            frame = frame[frame.District_Name == region]
        result[section] = frame.reset_index(drop=True)
    return result

def describe_tables():
    """Return source metadata from the compact annual catalogue.

    Daily climate files are the source of truth for the monthly dashboard.  We
    expose their actual date boundaries (and observed months) here instead of
    deriving a range from the current system date.  This keeps the UI pinned
    to the file snapshot when a CSV ends before today.
    """
    _check_files()
    catalogue = pd.read_csv(FILES['spells'], usecols=['District_Name', 'Year'])
    catalogue['Year'] = pd.to_numeric(catalogue['Year'], errors='raise').astype(int)
    years = sorted(catalogue['Year'].unique().tolist())
    regions = sorted(catalogue['District_Name'].dropna().unique().tolist())
    descriptions = []
    for section in SECTIONS:
        path = FILES[section]
        if section in DAILY:
            date_values = pd.read_csv(path, usecols=['Date'], low_memory=False)['Date']
            dates = pd.to_datetime(date_values, errors='raise')
            first_date = dates.min()
            last_date = dates.max()
            first_year, last_year, rows = int(first_date.year), int(last_date.year), int(len(dates))
            observed_months = sorted(dates.dt.to_period('M').astype(str).unique().tolist())
        else:
            first_year, last_year, rows = int(catalogue.Year.min()), int(catalogue.Year.max()), int(len(pd.read_csv(path, usecols=['District_Name', 'Year'])))
            first_date = last_date = None
            observed_months = []
        descriptions.append({'section': section, 'table': path.name, 'rows': rows,
                             'first_year': first_year, 'last_year': last_year,
                             'first_date': first_date.strftime('%Y-%m-%d') if first_date is not None else None,
                             'last_date': last_date.strftime('%Y-%m-%d') if last_date is not None else None,
                             'months': observed_months,
                             'frequency': 'Daily' if section in DAILY else 'Annual'})
    return descriptions, regions, years
