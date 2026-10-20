"""Database source adapter for the six section 4 climate indicator tables."""
import os
from concurrent.futures import ThreadPoolExecutor
from threading import BoundedSemaphore
from time import monotonic, sleep
from urllib.parse import quote, urlencode

import pandas as pd

from app.supabase_source import _request_page, _settings, SupabaseSourceError
from app.database import postgres_enabled
from app.postgres_source import read_climate_frames as read_climate_frames_postgres, read_table_rows

ClimateSourceError = SupabaseSourceError
SECTIONS = ('temperature', 'spells', 'rainfall', 'evaporation', 'irrigation', 'streamflow')
DEFAULT_TABLES = (
    '4_1_temperature_change_master', '4_2_wet_dry_spells_master',
    '4_3_mean_annual_precipitation_master', '4_4_potential_evaporation_daily_master',
    '4_5_irrigation_demand_daily_master', '4_6_streamflow_and_climate_linkage_annual_master',
)
DAILY = {'temperature', 'evaporation', 'irrigation'}
PAGE_SIZE = 1000
# The catalogue includes this reported index, but older Supabase evaporation
# tables do not have the column. Keep it in the API response as null rather
# than rejecting the entire climate dashboard request.
OPTIONAL_COLUMNS = frozenset({'SPEI_Daily'})
_READ_SLOTS = BoundedSemaphore(12)


def source_label():
    return 'Supabase'


def query_columns(columns):
    return {
        section: [column for column in section_columns if column not in OPTIONAL_COLUMNS]
        for section, section_columns in columns.items()
    }


def worker_limit(job_count):
    """Bound concurrency so faster reads do not overwhelm PostgREST."""
    try:
        configured = int(os.getenv('NIWIS_CLIMATE_DB_WORKERS', '12'))
    except ValueError:
        configured = 12
    return max(4, min(20, configured, max(1, job_count)))


def settings():
    names = tuple(name.strip() for name in os.getenv('NIWIS_SUPABASE_TABLES_MODULE_2', ','.join(DEFAULT_TABLES)).split(','))
    if len(names) != 6 or len(set(names)) != 6 or any(
        not name or not name.replace('_', '').replace(' ', '').isalnum() for name in names
    ):
        raise SupabaseSourceError('NIWIS_SUPABASE_TABLES_MODULE_2 must list six distinct climate tables in section order 4.1–4.6.')
    if postgres_enabled():
        return '', '', dict(zip(SECTIONS, names))
    base, key, _ = _settings()
    return base, key, dict(zip(SECTIONS, names))


def signature():
    base, key, tables = settings()
    try:
        ttl = max(60, int(os.getenv('NIWIS_SUPABASE_CACHE_TTL', '900')))
    except ValueError as exc:
        raise SupabaseSourceError('NIWIS_SUPABASE_CACHE_TTL must be a number of seconds.') from exc
    return base, hash(key), tuple(tables.items()), int(monotonic() // ttl)


def table_url(base, table, params):
    return f'{base}/rest/v1/{quote(table, safe="_")}?{urlencode(params)}'


def total_count(content_range):
    try:
        return int(content_range.rsplit('/', 1)[1])
    except (AttributeError, ValueError, IndexError) as exc:
        raise SupabaseSourceError('Supabase did not return an exact climate row count; pagination cannot be verified.') from exc


def read_all(url, key):
    records, content_range = _request_page(url, key, 0, PAGE_SIZE - 1, count_exact=True)
    count = total_count(content_range)
    records = list(records)
    while len(records) < count:
        offset = len(records)
        part, returned_range = _request_page(url, key, offset, min(count - 1, offset + PAGE_SIZE - 1), count_exact=True)
        if not part or total_count(returned_range) != count:
            raise SupabaseSourceError('Climate pagination was incomplete. Retry after the database update finishes.')
        records.extend(part)
    if len(records) != count:
        raise SupabaseSourceError('Climate pagination returned an inconsistent row count.')
    return records


def read_daily_window(url, key):
    """Read one bounded daily window without an expensive exact count.

    National requests contain one row per district and can exceed one REST
    page even after the date range is bounded.  Page until the server returns
    a short page instead of rejecting the window and forcing the caller to
    split it into dozens of small requests.
    """
    records = []
    offset = 0
    max_pages = 32
    for _ in range(max_pages):
        part, _ = _request_page(
            url, key, offset, offset + PAGE_SIZE - 1, count_exact=False
        )
        records.extend(part)
        if len(part) < PAGE_SIZE:
            return records
        offset += len(part)
    raise SupabaseSourceError('A bounded climate daily window exceeded the safe pagination limit.')


def boundary_row(base, key, table, order, filters=None):
    """Read one date boundary, retrying transient PostgREST statement timeouts."""
    params = {'select': 'Date', 'order': order, 'limit': '1', **(filters or {})}
    for attempt in range(3):
        try:
            rows, _ = _request_page(table_url(base, table, params), key, 0, 0, count_exact=False)
            return rows
        except SupabaseSourceError as exc:
            if '57014' not in str(exc) or attempt == 2:
                raise
            sleep(0.25 * (attempt + 1))
    return []


def read_frames(columns, start=None, end=None, region=None, date_start=None, date_stop=None):
    """Read only requested sections, with optional exact daily date bounds."""
    requested_columns = query_columns(columns)
    base, key, tables = settings()
    if start is None or end is None:
        _, _, years = describe_tables()
        start = years[0] if start is None else start
        end = years[-1] if end is None else end
    if postgres_enabled():
        frames = read_climate_frames_postgres(requested_columns, tables, int(start), int(end), region, date_start, date_stop)
        for section, frame in frames.items():
            for column in columns[section]:
                if column not in frame.columns:
                    frame[column] = pd.NA
            frames[section] = frame[['District_Name', 'Date' if section in DAILY else 'Year', *columns[section]]]
        return frames
    jobs = []
    for section, table in tables.items():
        if section not in columns:
            continue
        time_column = 'Date' if section in DAILY else 'Year'
        params = {'select': ','.join(['District_Name', time_column, *requested_columns[section]])}
        # Stable ordering is required when a bounded window is fetched in
        # multiple Range pages; without it PostgREST may repeat or skip rows
        # between pages and create false district/date duplicates.
        params['order'] = f'District_Name.asc,{time_column}.asc'
        # Chart histories use one district; maps request a separate national
        # source-date snapshot and never rely on this filtered history.
        if region:
            params['District_Name'] = f'eq.{region}'
        if section in DAILY:
            cursor = pd.Timestamp(date_start) if date_start else pd.Timestamp(start, 1, 1)
            final_end = pd.Timestamp(date_stop) if date_stop else pd.Timestamp(end + 1, 1, 1)
            # National windows are paginated safely inside read_daily_window,
            # so use 90-day ranges instead of hundreds of 14-day requests.
            window_days = 90
            while cursor < final_end:
                next_date = min(cursor + pd.Timedelta(days=window_days), final_end)
                window = {**params, 'Date': f'gte.{cursor:%Y-%m-%d}', 'and': f'(Date.lt.{next_date:%Y-%m-%d})'}
                jobs.append((section, table_url(base, table, window)))
                cursor = next_date
        else:
            jobs.append((section, table_url(base, table, {**params, 'and': f'(Year.gte.{start},Year.lte.{end})'})))

    def fetch(job):
        section, url = job
        with _READ_SLOTS:
            return section, read_daily_window(url, key) if section in DAILY else read_all(url, key)

    rows = {section: [] for section in columns}
    # Bounded windows cap each request even on large daily tables.
    with ThreadPoolExecutor(max_workers=worker_limit(len(jobs))) as executor:
        for section, records in executor.map(fetch, jobs):
            rows[section].extend(records)
    frames = {}
    for section, records in rows.items():
        time_column = 'Date' if section in DAILY else 'Year'
        frame = pd.DataFrame(records, columns=['District_Name', time_column, *requested_columns[section]])
        if section in DAILY and not frame.empty:
            # A few source deployments contain repeated district/day rows.
            # Collapse those rows using the same numeric mean used by the
            # dashboard, rather than failing the complete request.
            frame[time_column] = pd.to_datetime(frame[time_column], errors='coerce')
            frame = frame.groupby(['District_Name', time_column], as_index=False)[requested_columns[section]].mean(numeric_only=True)
        for column in columns[section]:
            if column not in frame.columns:
                frame[column] = pd.NA
        frame = frame[['District_Name', time_column, *columns[section]]]
        frames[section] = frame
    return frames


def last_observed_date(section, month):
    """Find the actual last source day in a month without reading its history."""
    first = pd.Period(month, freq='M').to_timestamp()
    stop = first + pd.offsets.MonthBegin(1)
    base, key, tables = settings()
    if postgres_enabled():
        rows = read_table_rows(tables[section], columns=['Date'],
            filters=[('Date', ('>=', str(first.date()))), ('Date', ('<', str(stop.date())))],
            order=[('Date', 'DESC')], limit=1)
    else:
        rows = boundary_row(base, key, tables[section], 'Date.desc',
                            {'Date': f'gte.{first:%Y-%m-%d}', 'and': f'(Date.lt.{stop:%Y-%m-%d})'})
    return str(rows[0]['Date'])[:10] if rows else None


def describe_tables():
    """Use compact annual queries instead of sorting entire daily tables."""
    base, key, tables = settings()
    if postgres_enabled():
        catalogue = read_table_rows(tables['spells'], columns=['District_Name', 'Year'], order=[('District_Name', 'ASC'), ('Year', 'ASC')])
        if not catalogue:
            raise SupabaseSourceError(f'The climate table {tables["spells"]} is empty.')
        years = sorted({int(row['Year']) for row in catalogue})
        regions = sorted({row['District_Name'] for row in catalogue})
        descriptions = []
        for section in SECTIONS:
            if section in DAILY:
                first = read_table_rows(tables[section], columns=['Date'], order=[('Date', 'ASC')], limit=1)
                last = read_table_rows(tables[section], columns=['Date'], order=[('Date', 'DESC')], limit=1)
                first_date = first[0].get('Date') if first else None
                last_date = last[0].get('Date') if last else None
                descriptions.append({'section': section, 'table': tables[section], 'rows': None,
                                     'first_year': years[0], 'last_year': years[-1],
                                     'first_date': str(first_date) if first_date else None,
                                     'last_date': str(last_date) if last_date else None, 'frequency': 'Daily'})
            else:
                first = read_table_rows(tables[section], columns=['Year'], order=[('Year', 'ASC')], limit=1)
                last = read_table_rows(tables[section], columns=['Year'], order=[('Year', 'DESC')], limit=1)
                descriptions.append({'section': section, 'table': tables[section], 'rows': None,
                                     'first_year': int(first[0]['Year']) if first else years[0],
                                     'last_year': int(last[0]['Year']) if last else years[-1],
                                     'first_date': None, 'last_date': None, 'frequency': 'Annual'})
        return descriptions, regions, years
    catalogue = read_all(table_url(base, tables['spells'], {'select': 'District_Name,Year', 'order': 'District_Name.asc,Year.asc'}), key)
    if not catalogue:
        raise SupabaseSourceError(f'The climate table {tables["spells"]} is empty.')
    years = sorted({int(row['Year']) for row in catalogue})
    regions = sorted({row['District_Name'] for row in catalogue})

    def describe(section):
        if section in DAILY:
            # Boundary reads are bounded to one row and do not require an
            # exact count or a full-table sort.  The dashboard must use the
            # database snapshot's last observation rather than today's date.
            first = boundary_row(base, key, tables[section], 'Date.asc')
            last = boundary_row(base, key, tables[section], 'Date.desc')
            if not first or not last:
                raise SupabaseSourceError(f'The climate table {tables[section]} is empty.')
            return {'section': section, 'table': tables[section], 'rows': None,
                    'first_year': years[0], 'last_year': years[-1],
                    'first_date': str(first[0].get('Date')),
                    'last_date': str(last[0].get('Date')), 'frequency': 'Daily'}
        params = {'select': 'District_Name,Year', 'order': 'Year.asc', 'limit': 1}
        first, content_range = _request_page(table_url(base, tables[section], params), key, 0, 0, count_exact=True)
        last, _ = _request_page(table_url(base, tables[section], {**params, 'order': 'Year.desc'}), key, 0, 0)
        if not first or not last:
            raise SupabaseSourceError(f'The climate table {tables[section]} is empty.')
        return {'section': section, 'table': tables[section], 'rows': total_count(content_range),
                'first_year': int(first[0]['Year']), 'last_year': int(last[0]['Year']),
                'first_date': None, 'last_date': None, 'frequency': 'Annual'}

    with ThreadPoolExecutor(max_workers=6) as executor:
        descriptions = list(executor.map(describe, SECTIONS))
    return descriptions, regions, years
