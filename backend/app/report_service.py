"""Source-grounded dashboard reports and graph-rich PDF downloads."""
from __future__ import annotations

import asyncio
import importlib
import io
import json
import logging
import math
import os
import re
import secrets
from collections import OrderedDict
from collections import defaultdict, deque
from datetime import datetime
from threading import BoundedSemaphore, Lock
from time import monotonic, sleep
from zoneinfo import ZoneInfo
from urllib.error import HTTPError, URLError
from urllib.request import Request as UrlRequest, urlopen

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import mm
from reportlab.platypus import (Image, PageBreak, Paragraph, SimpleDocTemplate,
                                Spacer, Table, TableStyle)

from app.supabase_source import _load_local_env

_load_local_env()
router = APIRouter(tags=['NIWIS reports'])
_LOGGER = logging.getLogger('niwis.reports')

_DASHBOARDS = {
    'drought-monitoring': ('Drought Monitoring', 'drought_monitoring', 'region'),
    'climate': ('Climate Dashboard', 'climate_service', 'dashboard'),
    'vegetation': ('Vegetation Condition', 'vegetation_service', 'dashboard'),
    'rainfall': ('Rainfall Status', 'rainfall_service', 'dashboard'),
    'runoff': ('Runoff Status', 'runoff_service', 'dashboard'),
    'surface-water': ('Surface Water Network', 'surface_water_service', 'dashboard'),
    'groundwater': ('Groundwater Level Monitoring', 'groundwater_service', 'dashboard'),
    'groundwater-reserve': ('Groundwater Reserve Assessment', 'groundwater_reserve_service', 'dashboard'),
    'water-quality': ('Water Quality Monitoring', 'water_quality_service', 'dashboard'),
    'reservoirs': ('Dam and Reservoir Status', 'reservoir_service', 'dashboard'),
    'wastewater': ('Wastewater Quality Compliance', 'wastewater_service', 'dashboard'),
    'drinking-water': ('Drinking Water Quality Compliance', 'drinking_water_service', 'dashboard'),
    'rwqo': ('Resource Water Quality Objectives', 'rwqo_service', 'dashboard'),
    'wrm': ('Water Resource Management', 'wrm_service', 'dashboard'),
    'water-quantity': ('Water Quantity Assessment', 'water_quantity_service', 'dashboard'),
    'water-services': ('Water Services', 'water_services_service', 'dashboard'),
    'municipal-tariffs': ('Water Tariffs and Quality Costs', 'municipal_tariff_service', 'dashboard'),
}
_FILTERS = {'region', 'start', 'end', 'season', 'section', 'area', 'category', 'dataset', 'year', 'as_of', 'lag'}
_TIME_KEYS = ('period', 'month', 'year', 'date', 'timestamp', 'time', 'reporting_period', 'reporting_year', 'observation_date')
_METRIC_KEYS = ('key', 'name', 'metric', 'indicator', 'variable', 'field', 'column', 'title', 'label')
_MISSING = object()
_LOCK = Lock()
_GENERATION_LIMIT = BoundedSemaphore(2)
_REPORTS: OrderedDict[str, tuple[float, bytes, str]] = OrderedDict()
_REQUESTS = defaultdict(deque)
_REQUESTS_LOCK = Lock()
_RATE_LIMIT = 6
_RATE_WINDOW = 10 * 60
_REPORT_LIMIT = 48
_REPORT_TTL = 30 * 60
_REPORT_REQUEST_SCHEMA = {
    'type': 'object',
    'properties': {
        'summary': {'type': 'string'},
        'findings': {'type': 'array', 'items': {'type': 'string'}},
        'recommendations': {'type': 'array', 'items': {'type': 'string'}},
        'limitations': {'type': 'array', 'items': {'type': 'string'}},
    },
    'required': ['summary', 'findings', 'recommendations', 'limitations'],
}


class GenerateReportRequest(BaseModel):
    dashboard: str = Field(min_length=1, max_length=48)
    filters: dict[str, str | int | float | bool | None] = Field(default_factory=dict)


def _native(value):
    if value is None or isinstance(value, (str, bool, int, float)):
        return value
    if hasattr(value, 'item'):
        try:
            return _native(value.item())
        except (ValueError, TypeError):
            return None
    if isinstance(value, dict):
        return {str(k): _native(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_native(v) for v in value]
    if hasattr(value, 'to_dict'):
        try:
            return _native(value.to_dict(orient='records'))
        except TypeError:
            try:
                return _native(value.to_dict())
            except Exception:
                return str(value)
    return str(value)


def _settings(dashboard: str, supplied: dict) -> dict:
    if dashboard not in _DASHBOARDS:
        raise ValueError('Choose one of the available NIWIS dashboards.')
    if not isinstance(supplied, dict) or len(supplied) > 12 or set(supplied) - _FILTERS:
        raise ValueError('The report contains unsupported dashboard filters.')
    filters = dict(supplied)
    for key in ('region', 'season', 'section', 'area', 'category', 'dataset', 'as_of'):
        if key in filters and filters[key] is not None:
            value = filters[key]
            if not isinstance(value, str) or len(value) > 90 or any(ord(c) < 32 for c in value):
                raise ValueError(f'The {key} report filter is invalid.')
    for key in ('start', 'end', 'year', 'lag'):
        if key in filters and filters[key] is not None:
            try:
                filters[key] = int(filters[key])
            except (TypeError, ValueError):
                raise ValueError(f'The {key} report filter must be a whole number.') from None
    for key in ('start', 'end', 'year'):
        if key in filters and filters[key] is not None and not 1900 <= filters[key] <= 2200:
            raise ValueError(f'The {key} report filter is outside the supported range.')
    if 'start' in filters and 'end' in filters and filters['start'] > filters['end']:
        raise ValueError('The report start year must be before its end year.')
    if dashboard == 'climate' and filters.get('section'):
        allowed = {'temperature', 'spells', 'rainfall', 'evaporation', 'irrigation', 'streamflow'}
        if filters['section'] not in allowed:
            raise ValueError('Choose a supported climate section.')
    if dashboard == 'water-services' and filters.get('section'):
        if filters['section'] not in {'access', 'operations', 'eo'}:
            raise ValueError('Choose Access, Infrastructure Operations or Earth Observation.')
    if dashboard == 'municipal-tariffs' and filters.get('dataset'):
        if filters['dataset'] not in {'raw', 'municipal', 'quality'}:
            raise ValueError('Choose raw, municipal or quality tariff data.')
    return filters


def _source_payload(dashboard: str, filters: dict):
    title, module_name, endpoint_name = _DASHBOARDS[dashboard]
    service = importlib.import_module(f'app.{module_name}')
    if dashboard == 'drought-monitoring':
        region = filters.get('region', 'National')
        if region.casefold() == 'national':
            # Drought source rows are district-scoped. Build the national report
            # series from the same observed rows, averaging each indicator by
            # observation date instead of asking for a non-existent National district.
            from app import drought_source
            import pandas as pd
            from datetime import date
            end_year = filters.get('end', date.today().year)
            start_year = filters.get('start', end_year - 4)
            end_date = min(date.today(), date(end_year, 12, 31))
            start_date = date(start_year, 1, 1)
            filters.setdefault('start', start_year)
            filters.setdefault('end', end_year)
            source_regions = []
            for kind in ('meteorological', 'hydrological', 'satellite'):
                rows = drought_source.bounded_rows(service.TABLES[kind], start_date, end_date)
                if rows:
                    frame = pd.DataFrame(rows)
                    numeric = [field for field in service.FIELDS[kind] if field in frame]
                    frame['date'] = pd.to_datetime(frame['date'], errors='coerce')
                    frame = frame.dropna(subset=['date']).groupby('date', as_index=False)[numeric].mean(numeric_only=True)
                    national_rows = frame.assign(date=frame['date'].dt.strftime('%Y-%m-%d')).to_dict('records')
                else:
                    national_rows = []
                source_regions.append(service.source_analysis(kind, national_rows))
        else:
            source_regions = [service.load_source(kind, region) for kind in ('meteorological', 'hydrological', 'satellite')]
        sources = {'meteorological': source_regions[0], 'hydrological': source_regions[1], 'satellite': source_regions[2]}
        payload = {'sources': sources, 'region': region, 'source': 'database'}
        return title, payload, None
    if dashboard == 'municipal-tariffs':
        query = getattr(service, 'analytics', None)
        if query is None:
            raise ValueError('Tariff history is not available for report generation.')
        dataset = filters.get('dataset', 'raw')
        region = filters.get('region', 'National')
        payload = _native(query(dataset=dataset, region=region))
        indicator_series = {}
        for indicator in payload.get('indicators', []):
            key = indicator.get('key')
            if key:
                indicator_series[key] = [{'year': point.get('year'), key: point.get('value')}
                                         for point in indicator.get('points', [])]
        payload['report_series'] = indicator_series
        label = {'raw': 'Raw Water Tariffs', 'municipal': 'Municipal Water Tariffs',
                 'quality': 'Water Quality Costs'}.get(dataset, title)
        return label, payload, service
    endpoint = getattr(service, endpoint_name, None)
    if endpoint is None:
        raise ValueError('This dashboard does not have a report data source yet.')
    # Only fields used by the selected service's public dashboard function reach it.
    import inspect
    accepted = inspect.signature(endpoint).parameters
    arguments = {key: value for key, value in filters.items() if key in accepted}
    if dashboard in {'groundwater-reserve', 'water-quality'}:
        # These monthly sources span decades. Reports default to a useful
        # recent window so PostgREST does not need to scan the entire history.
        report_end = int(arguments.get('end', 2026))
        arguments.setdefault('end', report_end)
        arguments.setdefault('start', max(2000, report_end - 4))
        filters.setdefault('start', arguments['start'])
        filters.setdefault('end', arguments['end'])
    if 'include_map' in accepted:
        arguments['include_map'] = False
    if dashboard == 'climate':
        # The report builder's empty date fields mean "recent useful window",
        # while the interactive dashboard may still default to its full history.
        if 'start' not in arguments and 'end' not in arguments:
            arguments.update(start=2018, end=2025)
        elif 'end' not in arguments:
            arguments['end'] = 2025
        elif 'start' not in arguments:
            arguments['start'] = max(2000, int(arguments['end']) - 7)
        arguments['include_map'] = False
    if dashboard == 'rainfall' and 'include_runoff' in accepted:
        arguments['include_runoff'] = False
    try:
        response = endpoint(**arguments)
    except HTTPException as exc:
        # PostgREST 57014 is transient under concurrent dashboard reads. Retry
        # this read once; persistent timeouts are surfaced clearly to the user.
        if exc.status_code < 500 or '57014' not in str(exc.detail):
            raise
        sleep(0.25)
        response = endpoint(**arguments)
    payload = _native(response)
    return title, payload, service


def _metric_catalogue(value, result=None):
    result = result or {}
    if isinstance(value, dict):
        key = next((value.get(candidate) for candidate in _METRIC_KEYS if isinstance(value.get(candidate), str)), None)
        unit = value.get('unit') or value.get('units')
        if key and isinstance(unit, str) and len(unit) < 60:
            label = value.get('label') or value.get('name') or value.get('title') or key
            result[str(key)] = (str(label)[:100], unit[:60])
        for child in value.values():
            _metric_catalogue(child, result)
    elif isinstance(value, list):
        for child in value[:500]:
            _metric_catalogue(child, result)
    return result


def _is_number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(float(value))


def _series(value, path=(), filters=None):
    filters = filters or {}
    if isinstance(value, dict):
        for key, child in value.items():
            if isinstance(child, list) and len(child) >= 2 and all(isinstance(row, dict) for row in child[:min(8, len(child))]):
                rows = child
                time_key = next((candidate for candidate in _TIME_KEYS
                                 if any(candidate in {str(field).lower() for field in row} for row in rows[:12])), None)
                if time_key:
                    time_key = next((field for field in rows[0] if str(field).lower() == time_key), time_key)
                    start = filters.get('start')
                    end = filters.get('end')
                    if start is not None or end is not None:
                        def in_selected_year(row):
                            raw = str(row.get(time_key, ''))[:4]
                            try:
                                year = int(raw)
                            except ValueError:
                                return True
                            return (start is None or year >= start) and (end is None or year <= end)
                        rows = [row for row in rows if in_selected_year(row)]
                numeric_keys = []
                for row in rows:
                    for field, number in row.items():
                        if str(field).lower() not in _TIME_KEYS and not any(part in str(field).lower() for part in ('latitude', 'longitude', '_id', 'count', 'expected_days')) and _is_number(number):
                            if field not in numeric_keys:
                                numeric_keys.append(field)
                if time_key and numeric_keys:
                    yield (path + (str(key),), time_key, rows, numeric_keys)
            yield from _series(child, path + (str(key),), filters)
    elif isinstance(value, list):
        for index, child in enumerate(value[:160]):
            if isinstance(child, (dict, list)):
                yield from _series(child, path + (str(index),), filters)


def _display_title(key, catalogue):
    if key in catalogue:
        return catalogue[key][0], catalogue[key][1]
    return re.sub(r'(?<!^)(?=[A-Z])', ' ', key.replace('_', ' ')).strip().capitalize(), 'Source unit unspecified'


def _report_points(rows, time_key, key, *, max_points=72):
    selected = []
    for row in rows:
        label = row.get(time_key)
        if label is None:
            continue
        raw = row.get(key)
        number = float(raw) if _is_number(raw) else None
        if number is not None and not math.isfinite(number):
            number = None
        selected.append({'label': str(label)[:35], 'value': number})
    if len(selected) > max_points:
        stride = (len(selected) - 1) / (max_points - 1)
        selected = [selected[round(i * stride)] for i in range(max_points)]
    return selected


def _summarise(title: str, payload, service, filters: dict):
    # The report payload already includes source and metric metadata. Calling
    # every dashboard's metadata endpoint here duplicates costly database reads.
    catalogue = _metric_catalogue(payload)
    for key in ('sources', 'source_summaries', 'summary'):
        if key in payload:
            catalogue.update(_metric_catalogue(payload[key]))
    if isinstance(payload.get('metrics'), list):
        for metric in payload['metrics']:
            key = metric.get('key') if isinstance(metric, dict) else None
            if key and metric.get('unit'):
                catalogue[str(key)] = (str(metric.get('label') or key), str(metric['unit']))
    catalogue.update({
        'spi_1': ('SPI-1', 'dimensionless index'), 'spi_3': ('SPI-3', 'dimensionless index'),
        'spi_6': ('SPI-6', 'dimensionless index'), 'spi_12': ('SPI-12', 'dimensionless index'),
        'spi_24': ('SPI-24', 'dimensionless index'), 'spei_1': ('SPEI-1', 'dimensionless index'),
        'spei_3': ('SPEI-3', 'dimensionless index'), 'spei_6': ('SPEI-6', 'dimensionless index'),
        'spei_12': ('SPEI-12', 'dimensionless index'), 'spei_24': ('SPEI-24', 'dimensionless index'),
        'ssi_dimensionless': ('Streamflow Standardized Index', 'dimensionless index'),
        'sgi_dimensionless': ('Groundwater Standardized Index', 'dimensionless index'),
        'ndvi': ('Normalized Difference Vegetation Index', 'dimensionless index'),
        'vhi': ('Vegetation Health Index', 'source index'),
    })
    charts, stats, warnings, sources = [], [], [], []
    def walk_for_messages(obj):
        if isinstance(obj, dict):
            for key, value in obj.items():
                if key == 'status' and value == 'error':
                    warnings.append('A connected data source reported an error; check its source status on the dashboard.')
                if key in {'warnings', 'errors'} and isinstance(value, (list, dict)):
                    warnings.extend(str(item)[:300] for item in (value.values() if isinstance(value, dict) else value) if item)
                if key in {'source', 'source_table', 'source_tables', 'table', 'sources'}:
                    if isinstance(value, str): sources.append(value[:180])
                    elif isinstance(value, list): sources.extend(str(item)[:180] for item in value[:8])
                    elif isinstance(value, dict):
                        sources.extend(str(item)[:180] for item in value.values() if isinstance(item, str))
                walk_for_messages(value)
        elif isinstance(obj, list):
            for item in obj[:500]: walk_for_messages(item)
    walk_for_messages(payload)
    seen = set()
    for path, time_key, rows, keys in _series(payload, filters=filters):
        path_name = ' / '.join(path[-2:]) if path else title
        for key in keys:
            points = _report_points(rows, time_key, key)
            valid = [point['value'] for point in points if point['value'] is not None]
            if len(valid) < 2:
                continue
            label, unit = _display_title(key, catalogue)
            unique = (path_name, key, unit)
            if unique in seen:
                continue
            seen.add(unique)
            charts.append({'title': f'{label} — {path_name}'[:120], 'metric': label, 'unit': unit,
                           'time_label': time_key.replace('_', ' ').capitalize(), 'points': points})
            values = np.asarray(valid, dtype=float)
            delta = float(values[-1] - values[0])
            observed_points = [point for point in points if point['value'] is not None]
            first_point, last_point = observed_points[0], observed_points[-1]
            stats.append({'metric': label, 'unit': unit, 'first': float(values[0]), 'last': float(values[-1]),
                          'minimum': float(values.min()), 'maximum': float(values.max()), 'mean': float(values.mean()),
                          'observations': int(len(values)), 'periods': len(points),
                          'first_period': first_point['label'], 'last_period': last_point['label'], 'change': delta,
                          'direction': 'increased' if delta > 0 else 'decreased' if delta < 0 else 'unchanged'})
            charts[-1].update({'first': float(values[0]), 'last': float(values[-1]),
                               'minimum': float(values.min()), 'maximum': float(values.max()),
                               'mean': float(values.mean()), 'observations': int(len(values)),
                               'first_period': first_point['label'], 'last_period': last_point['label'],
                               'change': delta})
            if len(charts) >= 8:
                break
        if len(charts) >= 8:
            break
    if payload.get('source') == 'database':
        sources.append('Connected NIWIS database service')
    warnings = list(dict.fromkeys(warnings))[:12]
    sources = list(dict.fromkeys(sources))[:10]
    if not charts:
        raise ValueError('This dashboard selection does not have enough time-series observations to make a graph report yet.')
    if len(charts) < 2:
        warnings.append(f'Only {len(charts)} chartable source indicator was available for this selection.')
    if any(any(point['value'] is None for point in chart['points']) for chart in charts):
        warnings.append('Some source periods have missing measurements. Graphs leave those values blank.')
    coverage = payload.get('coverage') or payload.get('source_coverage')
    if isinstance(coverage, dict):
        available = coverage.get('period') or coverage.get('start') or coverage.get('first_period')
        if available:
            filters['source_coverage'] = str(available)[:100]
    context_keys = ('region', 'start', 'end', 'season', 'section', 'area', 'category', 'dataset', 'year', 'as_of')
    context = {key: filters[key] for key in context_keys if key in filters}
    for key in ('region', 'start', 'end', 'year'):
        if key not in context and payload.get(key) is not None:
            context[key] = payload[key]
    return {'title': title, 'context': context, 'sources': sources or ['Connected NIWIS dashboard source'],
            'warnings': warnings, 'charts': charts, 'statistics': stats,
            'records_in_graphs': sum(chart['points'].__len__() for chart in charts)}


def resolve_report_source(dashboard: str, filters: dict):
    filters = _settings(dashboard, filters)
    title, payload, service = _source_payload(dashboard, filters)
    if not isinstance(payload, dict) or payload.get('error'):
        raise ValueError('The selected dashboard data could not be read from its source.')
    if payload.get('errors') and not any(isinstance(value, dict) for value in payload.get('sources', {}).values()):
        errors = payload.get('errors')
        values = errors.values() if isinstance(errors, dict) else errors if isinstance(errors, list) else [errors]
        text = ' '.join(str(value) for value in values if value)
        if '57014' in text or 'statement timeout' in text.casefold():
            raise ValueError('The dashboard database query timed out. Retry the report, or choose a shorter reporting period.')
        raise ValueError('The selected dashboard data source is unavailable. Check its dashboard source status and try again.')
    return _summarise(title, payload, service, filters)


def _narrative(source):
    date_spans = [f"{chart['first_period']} to {chart['last_period']}" for chart in source['charts']]
    span = date_spans[0] if date_spans and len(set(date_spans)) == 1 else 'the periods stated under each graph'
    summary = (f"{source['title']} covers {source['context'].get('region', 'the selected NIWIS reporting area')} "
               f"from {span}. "
               f"The report contains {len(source['charts'])} source-series chart(s), with "
               f"{source['records_in_graphs']} plotted periods. Counts include source series, so a period may appear in more than one graph.")
    findings, recommendations, limitations = [], [], []
    for item in source['statistics'][:5]:
        unit = '' if item['unit'] == 'Source unit unspecified' else f" {item['unit']}"
        findings.append(f"{item['metric']} ranged from {item['minimum']:,.3g} to {item['maximum']:,.3g}{unit} across {item['observations']} valid observations, from {item['first_period']} to {item['last_period']}. It {item['direction']} by {item['change']:+,.3g}{unit}, from {item['first']:,.3g} to {item['last']:,.3g}{unit}.")
        recommendations.append(f"Review the {item['metric']} source series with the dashboard period, regional coverage and measurement definition before using it for an operational decision.")
    limitations.extend(source['warnings'])
    limitations.append('This statistical summary describes the supplied observations; association and change do not establish cause or impact.')
    return {'summary': summary, 'findings': findings, 'recommendations': recommendations[:5],
            'limitations': limitations[:8]}


def _gemini_analysis(source):
    key = os.getenv('GEMINI_API_KEY', '').strip()
    if not key:
        return _narrative(source), 'statistical', 'Gemini analysis is not configured. This report contains source-derived statistical analysis.'
    model = os.getenv('GEMINI_MODEL', 'gemini-3.5-flash').strip()
    if not re.fullmatch(r'gemini-[A-Za-z0-9.-]{1,60}', model):
        return _narrative(source), 'statistical', 'The configured Gemini model name is invalid. This report contains source-derived statistical analysis.'
    evidence = {
        'dashboard': source['title'], 'selected_filters': source['context'], 'connected_sources': source['sources'],
        'computed_observation_statistics': source['statistics'],
        'series_points': [{'title': chart['title'], 'unit': chart['unit'], 'points': chart['points']}
                          for chart in source['charts'][:8]],
        'source_warnings': source['warnings'],
    }
    prompt = ('Write a careful NIWIS water-information report from this supplied source evidence. '
              'Treat every number as evidence rather than a prediction. Do not invent causes, risks, '
              'certification, targets, local impacts or advice not directly supported by the data. '
              'Distinguish source gaps and units. In recommendations ask readers to review or verify '
              'where needed. Return concise JSON using exactly the supplied schema. Evidence: ' +
              json.dumps(evidence, ensure_ascii=False, separators=(',', ':'))[:26000])
    body = {
        'system_instruction': {'parts': [{'text': 'You are a cautious water data analyst. Make no unsupported claims.'}]},
        'contents': [{'role': 'user', 'parts': [{'text': prompt}]}],
        'generationConfig': {'responseMimeType': 'application/json', 'responseJsonSchema': _REPORT_REQUEST_SCHEMA,
                             'temperature': 0.2, 'maxOutputTokens': 1200},
    }
    request = UrlRequest(f'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent',
                         data=json.dumps(body, ensure_ascii=False).encode(),
                         headers={'Content-Type': 'application/json', 'x-goog-api-key': key}, method='POST')
    try:
        with urlopen(request, timeout=32) as response:
            response_body = json.loads(response.read(160_000).decode())
        candidate = response_body.get('candidates', [{}])[0]
        text = ''.join(part.get('text', '') for part in candidate.get('content', {}).get('parts', []))
        value = json.loads(text)
        for field in ('summary', 'findings', 'recommendations', 'limitations'):
            if field not in value or (field == 'summary' and not isinstance(value[field], str)):
                raise ValueError('invalid analysis schema')
        clean = {'summary': _clean(value['summary'], 1800),
                 'findings': _clean_list(value['findings']), 'recommendations': _clean_list(value['recommendations']),
                 'limitations': _clean_list(value['limitations'])}
        if not clean['summary']:
            raise ValueError('empty analysis')
        return clean, 'gemini', f'AI analysis generated with Google Gemini ({model}) from the listed source statistics and graph values.'
    except (HTTPError, URLError, TimeoutError, OSError, UnicodeDecodeError, json.JSONDecodeError, ValueError, KeyError, IndexError, TypeError):
        return _narrative(source), 'statistical', 'Gemini analysis is currently unavailable. This report contains source-derived statistical analysis.'


def _clean(value, limit):
    if not isinstance(value, str):
        return ''
    text = re.sub(r'\s+', ' ', value).strip()
    return text[:limit]


def _clean_list(value):
    if not isinstance(value, list):
        return []
    return [_clean(item, 600) for item in value[:8] if _clean(item, 600)]


def _paragraph_text(value):
    from xml.sax.saxutils import escape
    return escape(str(value)).replace('\n', '<br/>')


def _make_graph(chart):
    points = chart['points']
    fig, ax = plt.subplots(figsize=(8.6, 3.1), dpi=125)
    fig.patch.set_facecolor('#ffffff')
    ax.set_facecolor('#f6faf9')
    x = np.arange(len(points))
    values = np.array([np.nan if point['value'] is None else point['value'] for point in points], dtype=float)
    ax.plot(x, values, color='#08796d', linewidth=2.15, marker='o', markersize=3.0,
            markerfacecolor='#ffffff', markeredgewidth=1.25, markeredgecolor='#08796d')
    ax.fill_between(x, values, [np.nanmin(values) if np.isfinite(values).any() else 0] * len(values),
                    where=np.isfinite(values), alpha=.075, color='#08796d')
    ax.grid(axis='y', color='#dce7e4', linewidth=.75)
    ax.spines[['top', 'right', 'left']].set_visible(False)
    ax.spines['bottom'].set_color('#c7d7d3')
    ax.tick_params(axis='y', colors='#536a70', labelsize=8, length=0, pad=8)
    ax.tick_params(axis='x', colors='#536a70', labelsize=8, length=0, pad=7)
    count = len(points)
    chosen = np.unique(np.linspace(0, count - 1, min(count, 12), dtype=int))
    ax.set_xticks(chosen, [points[i]['label'][:14] for i in chosen], rotation=0, ha='center')
    ax.set_ylabel(chart['unit'], color='#536a70', fontsize=8, labelpad=9)
    if not np.isfinite(values).any():
        ax.text(.5, .5, 'No usable numeric observations for this graph', ha='center', va='center', transform=ax.transAxes, color='#607770')
    fig.tight_layout(pad=1.45)
    output = io.BytesIO()
    fig.savefig(output, format='png', bbox_inches='tight', facecolor='white')
    plt.close(fig)
    output.seek(0)
    return output


def _pdf(source, analysis, method, notice, generated_at):
    output = io.BytesIO()
    doc = SimpleDocTemplate(output, pagesize=A4, leftMargin=20 * mm, rightMargin=20 * mm,
                            topMargin=19 * mm, bottomMargin=18 * mm, title=f"NIWIS | {source['title']} report",
                            author='National Integrated Water Information System')
    styles = getSampleStyleSheet()
    styles.add(ParagraphStyle(name='NiwisTitle', parent=styles['Title'], fontName='Helvetica-Bold',
                              fontSize=22, leading=27, textColor=colors.HexColor('#0a3442'), alignment=0, spaceAfter=8))
    styles.add(ParagraphStyle(name='NiwisSub', parent=styles['Normal'], fontSize=9, leading=14,
                              textColor=colors.HexColor('#506773'), spaceAfter=6))
    styles.add(ParagraphStyle(name='NiwisSection', parent=styles['Heading2'], fontSize=12,
                              textColor=colors.HexColor('#0c6158'), spaceBefore=13, spaceAfter=7))
    styles.add(ParagraphStyle(name='NiwisBody', parent=styles['BodyText'], fontSize=9, leading=14,
                              textColor=colors.HexColor('#263f4a'), spaceAfter=7))
    styles.add(ParagraphStyle(name='NiwisSmall', parent=styles['BodyText'], fontSize=7.5, leading=11,
                              textColor=colors.HexColor('#5c7278'), spaceAfter=5))
    story = [Paragraph('NIWIS  |  WATER INFORMATION REPORT', styles['NiwisSub']),
             Paragraph(_paragraph_text(source['title']), styles['NiwisTitle']),
             Paragraph('National Integrated Water Information System · Department of Water and Sanitation · Republic of South Africa', styles['NiwisSub']),
             Paragraph(f'Generated {generated_at.strftime("%d %B %Y, %H:%M SAST")} · Analysis: {"Google Gemini" if method == "gemini" else "Source-derived statistics"}', styles['NiwisSub']),
             Spacer(1, 7)]
    context_rows = [['REPORT CONTEXT', 'SELECTED VALUE']]
    context_labels = {'region': 'Area', 'start': 'Start year', 'end': 'End year', 'season': 'Season', 'section': 'Section',
                      'area': 'Source area', 'category': 'Category', 'dataset': 'Dataset', 'year': 'Reporting year', 'as_of': 'As of'}
    for key, value in source['context'].items():
        if value is not None:
            context_rows.append([context_labels.get(key, key.replace('_', ' ').title()), str(value)])
    context_table = Table(context_rows, colWidths=[45 * mm, 125 * mm], repeatRows=1)
    context_table.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#123947')),
        ('TEXTCOLOR', (0, 0), (-1, 0), colors.white), ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
        ('FONTNAME', (0, 1), (-1, -1), 'Helvetica'), ('FONTSIZE', (0, 0), (-1, -1), 8),
        ('TEXTCOLOR', (0, 1), (0, -1), colors.HexColor('#536974')),
        ('TEXTCOLOR', (1, 1), (1, -1), colors.HexColor('#193b48')),
        ('BACKGROUND', (0, 1), (-1, -1), colors.HexColor('#f1f6f5')),
        ('GRID', (0, 0), (-1, -1), .35, colors.HexColor('#d7e4e1')),
        ('LEFTPADDING', (0, 0), (-1, -1), 9), ('RIGHTPADDING', (0, 0), (-1, -1), 9),
        ('TOPPADDING', (0, 0), (-1, -1), 6), ('BOTTOMPADDING', (0, 0), (-1, -1), 6),
    ]))
    story.extend([context_table, Paragraph('Executive analysis', styles['NiwisSection']),
                  Paragraph(_paragraph_text(analysis['summary']), styles['NiwisBody']),
                  Paragraph('Analysis source', styles['NiwisSection']),
                  Paragraph(_paragraph_text(notice), styles['NiwisSmall'])])
    story.append(Paragraph('Indicator overview', styles['NiwisSection']))
    overview = [['Indicator', 'Observed period', 'Valid / plotted', 'Minimum', 'Maximum', 'First to last']]
    for stat in source['statistics'][:8]:
        unit = '' if stat['unit'] == 'Source unit unspecified' else f" {stat['unit']}"
        overview.append([
            Paragraph(_paragraph_text(stat['metric']), styles['NiwisSmall']),
            Paragraph(f"{_paragraph_text(stat['first_period'])} to {_paragraph_text(stat['last_period'])}", styles['NiwisSmall']),
            f"{stat['observations']} / {stat['periods']}",
            f"{stat['minimum']:,.4g}{unit}", f"{stat['maximum']:,.4g}{unit}",
            Paragraph(f"{stat['first']:,.4g} to {stat['last']:,.4g}{unit}", styles['NiwisSmall']),
        ])
    overview_table = Table(overview, colWidths=[35 * mm, 37 * mm, 20 * mm, 25 * mm, 25 * mm, 28 * mm], repeatRows=1)
    overview_table.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#123947')),
        ('TEXTCOLOR', (0, 0), (-1, 0), colors.white), ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
        ('FONTNAME', (0, 1), (-1, -1), 'Helvetica'), ('FONTSIZE', (0, 0), (-1, -1), 7),
        ('BACKGROUND', (0, 1), (-1, -1), colors.HexColor('#f1f6f5')),
        ('GRID', (0, 0), (-1, -1), .35, colors.HexColor('#d7e4e1')),
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ('LEFTPADDING', (0, 0), (-1, -1), 4), ('RIGHTPADDING', (0, 0), (-1, -1), 4),
        ('TOPPADDING', (0, 0), (-1, -1), 5), ('BOTTOMPADDING', (0, 0), (-1, -1), 5),
    ]))
    story.extend([overview_table, Paragraph('Observation counts show valid values versus plotted periods. Missing periods remain blank and are not treated as zero.', styles['NiwisSmall'])])
    for title, section_key in [('Key findings', 'findings'), ('Recommended review', 'recommendations'), ('Limitations and interpretation', 'limitations')]:
        values = analysis[section_key]
        if not values:
            continue
        story.append(Paragraph(title, styles['NiwisSection']))
        story.extend(Paragraph(f'•&nbsp; {_paragraph_text(item)}', styles['NiwisBody']) for item in values[:7])
    story.append(PageBreak())
    story.extend([Paragraph('Source observations', styles['NiwisTitle']),
                  Paragraph('Each chart shows a single source indicator and its supplied unit. Missing values are left blank. Longer series are displayed at up to 72 evenly spaced periods; plotted values are not imputed.', styles['NiwisSmall'])])
    for index, chart in enumerate(source['charts'][:8], start=1):
        graph_note = (f"Observed range: {chart['minimum']:,.4g} to {chart['maximum']:,.4g}. "
                      f"Mean: {chart['mean']:,.4g}. First-to-last: {chart['first']:,.4g} to "
                      f"{chart['last']:,.4g}; absolute change: {chart['change']:+,.4g} ({chart['direction']}).")
        story.extend([Paragraph(f'{index:02d}  {_paragraph_text(chart["title"])}', styles['NiwisSection']),
                      Image(_make_graph(chart), width=165 * mm, height=59 * mm),
                      Paragraph(f'{_paragraph_text(chart["time_label"])} · {_paragraph_text(chart["first_period"])} to {_paragraph_text(chart["last_period"])} · Unit: {_paragraph_text(chart["unit"])} · {chart["observations"]} valid of {len(chart["points"])} plotted periods', styles['NiwisSmall']),
                      Paragraph(_paragraph_text(graph_note), styles['NiwisSmall']),
                      Spacer(1, 2)])
    story.extend([Paragraph('Source notes', styles['NiwisSection']),
                  Paragraph('Sources: ' + _paragraph_text('; '.join(source['sources'])), styles['NiwisSmall'])])
    doc.build(story, onFirstPage=_page_chrome, onLaterPages=_page_chrome)
    return output.getvalue()


def _sum_available(chart):
    return sum(point['value'] is not None for point in chart['points'])


def _page_chrome(canvas, doc):
    canvas.saveState()
    width, height = A4
    canvas.setStrokeColor(colors.HexColor('#dce7e4'))
    canvas.setLineWidth(.6)
    canvas.line(20 * mm, 14 * mm, width - 20 * mm, 14 * mm)
    canvas.setFillColor(colors.HexColor('#637b80'))
    canvas.setFont('Helvetica', 7)
    canvas.drawString(20 * mm, 9 * mm, 'NIWIS · National Integrated Water Information System')
    canvas.drawRightString(width - 20 * mm, 9 * mm, f'Page {doc.page}')
    canvas.restoreState()


def _prune():
    now = monotonic()
    for report_id, (created, _, _) in tuple(_REPORTS.items()):
        if now - created > _REPORT_TTL:
            _REPORTS.pop(report_id, None)


def _check_rate_limit(client: str):
    now = monotonic()
    with _REQUESTS_LOCK:
        requests = _REQUESTS[client]
        while requests and now - requests[0] > _RATE_WINDOW:
            requests.popleft()
        if len(requests) >= _RATE_LIMIT:
            return False
        requests.append(now)
        if len(_REQUESTS) > 2048:
            for key, entries in tuple(_REQUESTS.items()):
                while entries and now - entries[0] > _RATE_WINDOW:
                    entries.popleft()
                if not entries:
                    _REQUESTS.pop(key, None)
        return True


def _generate(dashboard, filters):
    if not _GENERATION_LIMIT.acquire(blocking=False):
        raise RuntimeError('Two reports are being prepared. Wait a moment and try again.')
    try:
        source = resolve_report_source(dashboard, filters)
        analysis, method, notice = _gemini_analysis(source)
        generated_at = datetime.now(ZoneInfo('Africa/Johannesburg'))
        pdf_bytes = _pdf(source, analysis, method, notice, generated_at)
        report_id = secrets.token_urlsafe(32)
        with _LOCK:
            _prune()
            while len(_REPORTS) >= _REPORT_LIMIT:
                _REPORTS.popitem(last=False)
            _REPORTS[report_id] = (monotonic(), pdf_bytes, f"{dashboard}-{generated_at.strftime('%Y%m%d-%H%M')}.pdf")
        return {'report_id': report_id, 'title': source['title'], 'summary': analysis['summary'],
                'findings': analysis['findings'], 'recommendations': analysis['recommendations'],
                'limitations': analysis['limitations'], 'chart_count': len(source['charts']),
                'indicators': source['statistics'][:8],
                'observed_periods': list(dict.fromkeys(
                    f"{chart['first_period']} to {chart['last_period']}" for chart in source['charts'])),
                'generated_at': generated_at.isoformat(), 'analysis_method': method, 'ai_notice': notice,
                'sources': source['sources'], 'pdf_url': f'/reports/{report_id}/pdf'}
    finally:
        _GENERATION_LIMIT.release()


@router.post('/reports/generate')
async def generate_report(body: GenerateReportRequest, request: Request):
    client = request.client.host if request.client else 'unknown'
    if not _check_rate_limit(client):
        raise HTTPException(status_code=429, detail='Report limit reached. Wait a few minutes, then try again.')
    try:
        return await asyncio.to_thread(_generate, body.dashboard, body.filters)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except HTTPException as exc:
        if exc.status_code < 500:
            raise HTTPException(status_code=422, detail=str(exc.detail)) from exc
        detail = str(exc.detail)
        if '57014' in detail or 'statement timeout' in detail.casefold():
            raise HTTPException(status_code=503, detail='The dashboard database query timed out. Retry the report, or choose a shorter reporting period.') from exc
        if 'Could not reach Supabase' in detail or 'Connection refused' in detail or 'WinError 10013' in detail:
            raise HTTPException(status_code=503, detail='The NIWIS database is unreachable from the backend. Restore the backend database connection, then retry the report.') from exc
        if 'Supabase is not configured' in detail:
            raise HTTPException(status_code=503, detail='The NIWIS database connection is not configured for the backend.') from exc
        _LOGGER.error('Report source returned HTTP %s for dashboard %s.', exc.status_code, body.dashboard)
        raise HTTPException(status_code=503, detail=f'The {body.dashboard} report source is unavailable (HTTP {exc.status_code}). Check its dashboard source status and backend logs.') from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=429, detail=str(exc)) from exc
    except Exception as exc:
        # Never echo implementation details or the upstream provider response.
        _LOGGER.exception('Report generation failed for dashboard %s (%s).', body.dashboard, type(exc).__name__)
        raise HTTPException(status_code=503, detail=f'The {body.dashboard} report could not be prepared ({type(exc).__name__}). Check the backend log for this request.') from exc


@router.get('/reports/{report_id}/pdf')
def download_report(report_id: str):
    if len(report_id) != 43 or not re.fullmatch(r'[A-Za-z0-9_-]+', report_id):
        raise HTTPException(status_code=404, detail='Report not found or expired.')
    with _LOCK:
        _prune()
        item = _REPORTS.get(report_id)
    if item is None:
        raise HTTPException(status_code=404, detail='Report not found or expired. Generate a new report.')
    _, content, filename = item
    safe_filename = re.sub(r'[^A-Za-z0-9._-]', '-', filename)
    from fastapi.responses import Response
    return Response(content=content, media_type='application/pdf', headers={
        'Content-Disposition': f'attachment; filename="{safe_filename}"',
        'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
    })
