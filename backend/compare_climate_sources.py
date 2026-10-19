"""Compare database climate rows with local CSVs without changing either source."""
import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
from time import perf_counter
from unittest.mock import patch

import numpy as np
import pandas as pd

from app import climate_source, climate_csv_source, climate_service

OUTPUT = Path(__file__).resolve().parents[1] / 'output' / 'climate-data-comparison'
ATOL, RTOL = 1e-8, 1e-12


def compare(section, database, csv):
    keys = ['District_Name', 'Date' if section in climate_source.DAILY else 'Year']
    for frame in (database, csv):
        if 'Date' in frame:
            frame['Date'] = pd.to_datetime(frame.Date, errors='raise')
        else:
            frame['Year'] = pd.to_numeric(frame.Year, errors='raise').astype(int)
        if frame.duplicated(keys).any():
            raise ValueError(f'{section} has duplicate district/time rows; comparison would multiply observations.')
    joined = database.merge(csv, on=keys, how='outer', suffixes=('_database', '_csv'), indicator=True)
    missing = joined[joined._merge != 'both'][keys + ['_merge']].copy()
    missing['status'] = missing._merge.map({'left_only': 'database_only', 'right_only': 'csv_only'})
    missing.drop(columns='_merge').to_csv(OUTPUT / f'{section}-missing-rows.csv', index=False)
    paired = joined[joined._merge == 'both']
    metrics = []
    samples = []
    for key in database.columns:
        if key in keys:
            continue
        left = paired[f'{key}_database']
        right = paired[f'{key}_csv']
        if key == 'MK_Trend':
            different = ~(left.eq(right) | (left.isna() & right.isna()))
            max_delta = None
        else:
            left = pd.to_numeric(left, errors='raise')
            right = pd.to_numeric(right, errors='raise')
            different = ~np.isclose(left, right, atol=ATOL, rtol=RTOL, equal_nan=True)
            delta = (left - right).abs()
            max_delta = float(delta.max()) if delta.notna().any() else None
        null_difference = int((left.isna() != right.isna()).sum())
        metrics.append({'key': key, 'different_cells': int(np.sum(different)),
                        'null_mismatches': null_difference, 'max_absolute_delta': max_delta})
        for index in paired.index[np.asarray(different)][:5]:
            row = paired.loc[index]
            samples.append({**{name: str(row[name]) for name in keys}, 'metric': key,
                            'database': None if pd.isna(row[f'{key}_database']) else row[f'{key}_database'],
                            'csv': None if pd.isna(row[f'{key}_csv']) else row[f'{key}_csv']})
    return {'section': section, 'database_rows': len(database), 'csv_rows': len(csv),
            'paired_rows': len(paired), 'database_only': int((joined._merge == 'left_only').sum()),
            'csv_only': int((joined._merge == 'right_only').sum()), 'metrics': metrics,
            'different_cells': sum(metric['different_cells'] for metric in metrics), 'examples': samples}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--start', type=int, help='First daily year; defaults to the dashboard year')
    parser.add_argument('--end', type=int, help='Last daily year; defaults to --start')
    args = parser.parse_args()
    OUTPUT.mkdir(parents=True, exist_ok=True)
    started = perf_counter()
    with patch('pandas.read_csv', side_effect=AssertionError('Dashboard must not read CSVs')):
        metadata = climate_service.metadata()
    first = args.start if args.start is not None else metadata['default_end']
    last = args.end if args.end is not None else first
    if first > last:
        parser.error('--start must be on or before --end')
    base, key, tables = climate_source.settings()
    columns, absent = {}, {}
    for section in climate_source.SECTIONS:
        header = pd.read_csv(climate_csv_source.FILES[section], nrows=0).columns.tolist()
        # Inspect the actual database schema instead of assuming every CSV
        # field survived import. Report absent columns explicitly.
        sample, _ = climate_source._request_page(climate_source.table_url(base, tables[section], {'select': '*', 'limit': 1}), key, 0, 0)
        if not sample:
            raise ValueError(f'{tables[section]} is empty')
        keys = {'District_Name', 'Date' if section in climate_source.DAILY else 'Year'}
        columns[section] = [name for name in header if name not in keys and name in sample[0]]
        absent[section] = [name for name in header if name not in sample[0]]
    print(f'Comparing daily rows {first}–{last} for all {len(metadata["regions"])} districts; all annual years.', flush=True)
    database = climate_source.read_frames(columns, first, last)
    csv = climate_csv_source.read_frames(columns, first, last)
    comparisons = []
    for section in climate_source.SECTIONS:
        if section not in climate_source.DAILY:
            params = {'select': ','.join(['District_Name', 'Year', *columns[section]]), 'order': 'District_Name.asc,Year.asc'}
            database[section] = pd.DataFrame(climate_source.read_all(climate_source.table_url(base, tables[section], params), key))
            csv[section] = pd.read_csv(climate_csv_source.FILES[section], usecols=['District_Name', 'Year', *columns[section]])
        # Derived Year on local daily frames is a helper, not a source metric.
        if section in climate_source.DAILY:
            csv[section] = csv[section].drop(columns='Year', errors='ignore')
        result = compare(section, database[section], csv[section])
        result['table'], result['file'] = tables[section], climate_csv_source.FILES[section].name
        result['missing_database_columns'] = absent[section]
        comparisons.append(result)
        print(f'{section}: DB {result["database_rows"]}, CSV {result["csv_rows"]}, missing in DB {result["csv_only"]}, changed cells {result["different_cells"]}', flush=True)

    # Compare the complete user-facing aggregation too, with isolated caches
    # and independently loaded source rows, using identical reducer semantics.
    derived = {'Heat_Days', 'Heat_Duration', 'Frost_Days'}
    dashboard_columns = {section: [metric[0] for metric in climate_service.METRICS if metric[3] == section and metric[0] not in derived]
                         for section in climate_source.SECTIONS}
    def dashboard_frames(rows):
        return {section: frame[['District_Name', 'Date' if section in climate_source.DAILY else 'Year', *dashboard_columns[section]]].copy()
                for section, frame in rows.items()}
    metadata_snapshot = dict(metadata)
    dashboards = {}
    for name, rows in [('database', database), ('csv', csv)]:
        climate_service.sources.cache_clear()
        climate_service.annual_data.cache_clear()
        with patch.object(climate_source, 'read_frames', return_value=dashboard_frames(rows)):
            dashboards[name] = climate_service.dashboard(start=first, end=last)
    climate_service.sources.cache_clear()
    climate_service.annual_data.cache_clear()
    summary = []
    for metric in climate_service.METRICS:
        field = metric[0]
        left, right = dashboards['database']['summary'][field], dashboards['csv']['summary'][field]
        summary.append({'metric': field, 'unit': metric[2], 'database': left, 'csv': right,
                        'delta': left - right if left is not None and right is not None else None})
    report = {'checked_at_utc': datetime.now(timezone.utc).isoformat(), 'daily_start': first, 'daily_end': last,
              'scope': 'All annual rows; all districts for the specified daily years.',
              'absolute_tolerance': ATOL, 'relative_tolerance': RTOL, 'comparisons': comparisons, 'summary': summary}
    (OUTPUT / 'comparison.json').write_text(json.dumps(report, indent=2, default=str, allow_nan=False), encoding='utf-8')
    pd.DataFrame(summary).to_csv(OUTPUT / 'dashboard-values.csv', index=False)
    (OUTPUT / 'metadata.json').write_text(json.dumps(metadata_snapshot), encoding='utf-8')
    (OUTPUT / 'national.json').write_text(json.dumps(dashboards['database']), encoding='utf-8')
    lines = ['# Climate database / CSV comparison', '',
             f'Daily tables: {first}–{last}, all {len(metadata["regions"])} districts. Annual tables: complete source history.', '',
             'The climate dashboard reads Supabase. CSVs are used only by this separate comparison; neither source is changed.', '',
             f'Numeric comparisons use absolute tolerance {ATOL:g} and relative tolerance {RTOL:g}. Nulls match only nulls.', '',
             '| Section | Database rows | CSV rows | CSV-only rows | DB-only rows | Different paired cells |',
             '| --- | ---: | ---: | ---: | ---: | ---: |']
    for result in comparisons:
        lines.append(f'| {result["section"]} | {result["database_rows"]:,} | {result["csv_rows"]:,} | {result["csv_only"]:,} | {result["database_only"]:,} | {result["different_cells"]:,} |')
    lines.extend(['', '## Dashboard period means', '', '| Indicator | Database | CSV | Difference | Unit |', '| --- | ---: | ---: | ---: | --- |'])
    def number(value):
        return 'Unavailable' if value is None else f'{value:,.8g}'
    for row in summary:
        lines.append(f'| {row["metric"]} | {number(row["database"])} | {number(row["csv"])} | {number(row["delta"])} | {row["unit"]} |')
    for result in comparisons:
        lines.extend(['', f'## {result["section"]}', '', f'Database table: `{result["table"]}`. CSV: `{result["file"]}`.'])
        if result['missing_database_columns']:
            lines.extend(['', 'CSV columns absent from database: ' + ', '.join(result['missing_database_columns']) + '.'])
        differences = [row for row in result['metrics'] if row['different_cells']]
        if differences:
            lines.extend(['', '| Metric | Different paired cells | Null differences | Largest absolute difference |', '| --- | ---: | ---: | ---: |'])
            for row in differences:
                lines.append(f'| {row["key"]} | {row["different_cells"]:,} | {row["null_mismatches"]:,} | {number(row["max_absolute_delta"])} |')
        missing = pd.read_csv(OUTPUT / f'{result["section"]}-missing-rows.csv')
        if len(missing) and 'Date' in missing:
            date_counts = missing.groupby(['status', 'Date']).size().reset_index(name='districts')
            lines.extend(['', 'Missing-date examples (full list in the accompanying CSV):', ''])
            for row in date_counts.head(12).itertuples(index=False):
                lines.append(f'- {row.status}: {str(row.Date)[:10]}, {row.districts} districts.')
    lines.extend(['', '## Evidence and limits', '',
                  'Raw rows are matched by district and date/year before comparing values. Missing rows are counted separately from changed values.',
                  'Dashboard values use equal-weight district/year means; daily sums use observed rows and never fill missing dates.',
                  'Annual tables are fully compared. Daily years outside the stated interval are not compared; rerun with --start and --end to widen the interval.',
                  'See comparison.json for field-level deltas and example records, dashboard-values.csv for all 41 indicators, and *-missing-rows.csv for missing keys.'])
    (OUTPUT / 'Climate-Data-Comparison.md').write_text('\n'.join(lines) + '\n', encoding='utf-8')
    print(f'Comparison saved to {OUTPUT}; {perf_counter() - started:.1f}s', flush=True)


if __name__ == '__main__':
    main()
