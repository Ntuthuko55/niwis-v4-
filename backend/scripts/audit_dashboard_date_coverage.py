"""Read each NIWIS dashboard's current source metadata and record date coverage.

Run from backend with .venv\Scripts\python.exe scripts\audit_dashboard_date_coverage.py
The audit reads existing metadata/database services and writes only date bounds,
source labels, counts and redacted errors. It does not export source records.
"""
from __future__ import annotations

import importlib
import argparse
import json
import re
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from pathlib import Path
import sys
import time
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

DASHBOARDS = {
    'Drought Monitoring': (None, None),
    'Climate Dashboard': ('climate_service', 'metadata'),
    'Vegetation Condition': ('vegetation_service', 'metadata'),
    'Rainfall Status': ('rainfall_service', 'metadata'),
    'Runoff Status': ('runoff_service', 'metadata'),
    'Surface Water Network': ('surface_water_service', 'metadata'),
    'Groundwater Level Monitoring': ('groundwater_service', 'metadata'),
    'Groundwater Reserve Assessment': ('groundwater_reserve_service', 'metadata'),
    'Water Quality Monitoring': ('water_quality_service', 'metadata'),
    'Dam and Reservoir Status': ('reservoir_service', 'metadata'),
    'Wastewater Quality Compliance': (None, None),
    'Drinking Water Quality Compliance': ('drinking_water_service', 'metadata'),
    'Resource Water Quality Objectives': ('rwqo_service', 'metadata'),
    'Water Resource Management': ('wrm_service', 'metadata'),
    'Water Quantity Assessment': ('water_quantity_service', 'metadata'),
    'Water Services': ('water_services_service', 'metadata'),
    'Water Tariffs and Quality Costs': ('municipal_tariff_service', 'metadata'),
}

FIRST_KEYS = {'first_date', 'first_period', 'first_month', 'first_year', 'minimum_date',
              'min_date', 'earliest_date', 'source_start', 'coverage_start', 'start_date'}
LAST_KEYS = {'last_date', 'last_period', 'last_month', 'last_year', 'latest_date', 'latest_period',
             'max_date', 'maximum_date', 'source_end', 'coverage_end', 'end_date'}
SKIP_KEYS = {'metrics', 'indicators', 'capabilities', 'recommendations'}


def drought_coverage():
    service = importlib.import_module('app.drought_monitoring')
    source = importlib.import_module('app.drought_source')
    result = {}
    for name, table in service.TABLES.items():
        first = source.read_rows(table, {'select': 'date', 'order': 'date.asc', 'limit': '1'})
        last = source.read_rows(table, {'select': 'date', 'order': 'date.desc', 'limit': '1'})
        result[name] = {
            'source': table,
            'first_date': first[0].get('date') if first else None,
            'last_date': last[0].get('date') if last else None,
        }
    return result


def wastewater_coverage():
    service = importlib.import_module('app.wastewater_service')
    snapshot = service._snapshot_live()
    result = {}
    for item in snapshot['tables']:
        columns = item['columns']
        date_column = service._column(columns, 'date', 'sample_date', 'observation_date', 'record_date', 'timestamp')
        year_column = service._column(columns, 'year')
        month_column = service._column(columns, 'month')
        column = date_column or year_column
        if not column:
            result[item['kind']] = {'source': item['table'], 'error': 'no date field in source schema'}
            continue
        order = f'{year_column}.asc,{month_column}.asc' if not date_column and month_column else f'{column}.asc'
        first, _ = service._request_page(service._table_url(snapshot['base'], item['table'],
            {'select': column if date_column or not month_column else f'{year_column},{month_column}', 'order': order, 'limit': '1'}), snapshot['key'], 0, 0, False)
        last_order = order.replace('.asc', '.desc')
        last, _ = service._request_page(service._table_url(snapshot['base'], item['table'],
            {'select': column if date_column or not month_column else f'{year_column},{month_column}', 'order': last_order, 'limit': '1'}), snapshot['key'], 0, 0, False)
        def stamp(row):
            if not row:
                return None
            if date_column:
                return row.get(date_column)
            year = row.get(year_column)
            month = row.get(month_column) if month_column else None
            return f'{int(year):04d}-{int(month):02d}' if month is not None else year
        result[item['kind']] = {'source': item['table'], 'first_date': stamp(first[0] if first else None),
                                'last_date': stamp(last[0] if last else None)}
    return result


def source_bounds(value, path='metadata'):
    found = []
    if isinstance(value, dict):
        first = next((value[key] for key in FIRST_KEYS if key in value and value[key] not in (None, '')), None)
        last = next((value[key] for key in LAST_KEYS if key in value and value[key] not in (None, '')), None)
        years = value.get('years')
        months = value.get('months') or value.get('periods')
        if isinstance(years, list) and years:
            valid_years = sorted({int(year) for year in years if str(year).isdigit() and 1900 <= int(year) <= 2200})
            if valid_years:
                first = first or valid_years[0]
                last = last or valid_years[-1]
        if isinstance(months, list) and months:
            valid_months = sorted(str(month) for month in months if re.fullmatch(r'\d{4}-\d{2}', str(month)))
            if valid_months:
                first = first or valid_months[0]
                last = last or valid_months[-1]
        if first is not None or last is not None:
            source = next((value[key] for key in ('source_table', 'table', 'source_name', 'name', 'label')
                           if isinstance(value.get(key), str)), None)
            row_count = value.get('rows') or value.get('row_count') or value.get('records')
            found.append({
                'source': source or path,
                'first': str(first) if first is not None else None,
                'last': str(last) if last is not None else None,
                'rows': row_count if isinstance(row_count, (int, float)) else None,
            })
        for key, child in value.items():
            if key.lower() in SKIP_KEYS:
                continue
            if key.lower() in {'latest', 'summary', 'latest_values', 'metric_values'}:
                continue
            if isinstance(child, (dict, list)):
                found.extend(source_bounds(child, f'{path}.{key}'))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            if isinstance(child, (dict, list)):
                found.extend(source_bounds(child, f'{path}[{index}]'))
    return found


def inspect_dashboard(item):
    name, (module_name, function_name) = item
    try:
        if module_name is None:
            data = drought_coverage() if name == 'Drought Monitoring' else wastewater_coverage()
            return name, {'sources': data, 'date_ranges': source_bounds(data, 'sources')}
        service = importlib.import_module(f'app.{module_name}')
        data = getattr(service, function_name)()
        if hasattr(data, 'body'):
            data = json.loads(data.body.decode('utf-8'))
        if not isinstance(data, (dict, list)):
            return name, {'error': 'metadata returned an unsupported response', 'date_ranges': []}
        return name, {'date_ranges': source_bounds(data)}
    except Exception as exc:
        detail = getattr(exc, 'detail', str(exc))
        detail = re.sub(r'(?:AQ\.[A-Za-z0-9_-]{10,}|AIzaSy[A-Za-z0-9_-]{10,})', '[redacted]', str(detail))
        detail = re.sub(r'(?i)(apikey|api[_-]?key|authorization|service_role_key)[=: ]+[^ ,;&]+', r'\1=[redacted]', detail)
        return name, {'error': type(exc).__name__, 'error_detail': detail[:240], 'date_ranges': []}


def inspect_report_source(item):
    name, (module_name, _) = item
    dashboard = {
        'Drought Monitoring': 'drought-monitoring', 'Climate Dashboard': 'climate',
        'Vegetation Condition': 'vegetation', 'Rainfall Status': 'rainfall',
        'Runoff Status': 'runoff', 'Surface Water Network': 'surface-water',
        'Groundwater Level Monitoring': 'groundwater', 'Groundwater Reserve Assessment': 'groundwater-reserve',
        'Water Quality Monitoring': 'water-quality', 'Dam and Reservoir Status': 'reservoirs',
        'Wastewater Quality Compliance': 'wastewater', 'Drinking Water Quality Compliance': 'drinking-water',
        'Resource Water Quality Objectives': 'rwqo', 'Water Resource Management': 'wrm',
        'Water Quantity Assessment': 'water-quantity', 'Water Services': 'water-services',
        'Water Tariffs and Quality Costs': 'municipal-tariffs',
    }[name]
    filters = {}
    if dashboard == 'water-services':
        filters['section'] = 'access'
    elif dashboard == 'municipal-tariffs':
        filters.update(dataset='municipal', region='National')
    started = time.perf_counter()
    try:
        reports = importlib.import_module('app.report_service')
        source = reports.resolve_report_source(dashboard, filters)
        return name, {'status': 'ready', 'graphs': len(source['charts']),
                      'selected_context': source['context'], 'seconds': round(time.perf_counter() - started, 2)}
    except Exception as exc:
        detail = getattr(exc, 'detail', str(exc))
        detail = re.sub(r'(?:AQ\.[A-Za-z0-9_-]{10,}|AIzaSy[A-Za-z0-9_-]{10,})', '[redacted]', str(detail))
        detail = re.sub(r'(?i)(apikey|api[_-]?key|authorization|service_role_key)[=: ]+[^ ,;&]+', r'\1=[redacted]', detail)
        status = getattr(exc, 'status_code', None)
        return name, {'status': 'failed', 'error_type': type(exc).__name__,
                      'http_status': status, 'error_detail': detail[:240],
                      'seconds': round(time.perf_counter() - started, 2)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--check-reports', action='store_true',
                        help='Also fetch each dashboard report source and verify it produces graph series.')
    parser.add_argument('--dashboard', action='append', choices=list(DASHBOARDS),
                        help='Limit the live audit to one or more named dashboards.')
    args = parser.parse_args()
    selected = {name: item for name, item in DASHBOARDS.items()
                if not args.dashboard or name in args.dashboard}
    results = {}
    # Avoid making the audit itself trigger Supabase statement timeouts by
    # loading several large dashboards at once.
    with ThreadPoolExecutor(max_workers=1) as executor:
        futures = [executor.submit(inspect_dashboard, item) for item in selected.items()]
        for future in as_completed(futures):
            name, data = future.result()
            results[name] = data
    ordered = {name: results.get(name, {'error': 'audit did not return', 'date_ranges': []})
               for name in selected}
    report_checks = {}
    if args.check_reports:
        with ThreadPoolExecutor(max_workers=1) as executor:
            futures = [executor.submit(inspect_report_source, item) for item in selected.items()]
            for future in as_completed(futures):
                name, result = future.result()
                report_checks[name] = result
        report_checks = {name: report_checks.get(name, {'status': 'not returned'}) for name in selected}
    report = {
        'generated_at': datetime.now(ZoneInfo('Africa/Johannesburg')).isoformat(),
        'source': 'Live NIWIS dashboard metadata and database service date bounds',
        'dashboards': ordered,
        'report_source_checks': report_checks if args.check_reports else None,
    }
    destination = Path(__file__).resolve().parents[2] / 'output' / 'dashboard-date-coverage.json'
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({
        'generated_at': report['generated_at'],
        'output': str(destination),
        'dashboards': {
            name: {'date_ranges': item.get('date_ranges', []), 'error': item.get('error'),
                   'error_detail': item.get('error_detail')}
            for name, item in ordered.items()
        },
        'report_source_checks': report_checks if args.check_reports else None,
    }, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
