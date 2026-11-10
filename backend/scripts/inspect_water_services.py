"""Read-only inspection of section 18; output contains no credentials."""
import json
import sys
from collections import defaultdict
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import quote, urlencode

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.supabase_source import _settings, _request_page

TABLES = ('18_1_water_access_and_coverage_master', '18_2_infrastructure_operational_master', '18_3_sansa_eo_support_for_services_masters')


def main():
    base, key, _ = _settings()
    report = {}
    for kind, table in zip(('access', 'operations', 'eo'), TABLES):
        order = 'district_name.asc,Year.asc' if kind == 'eo' else 'id.asc'
        url = f'{base}/rest/v1/{quote(table)}?{urlencode({"select": "*", "order": order})}'
        rows, count = _request_page(url, key, 0, 999, True)
        total = int(count.rsplit('/', 1)[1])
        size = len(rows)
        with ThreadPoolExecutor(4) as pool:
            pages = pool.map(lambda offset: _request_page(url, key, offset, min(offset + size - 1, total - 1))[0], range(size, total, size))
            for page in pages:
                rows.extend(page)
        assert len(rows) == total
        groups = defaultdict(list)
        for row in rows:
            identity = (row.get('Region', row.get('district_name')), row.get('Standardized_Year', row.get('Year', row.get('Time Frame'))), row.get('Category'))
            groups[identity].append(row)
        duplicates = [group for group in groups.values() if len(group) > 1]
        region = 'district_name' if kind == 'eo' else 'Region'
        time = 'Year' if kind == 'eo' else 'Time Frame'
        report[kind] = {'table': table, 'rows': len(rows), 'regions': sorted({str(r[region]) for r in rows}),
                        'periods': sorted({str(r[time]) for r in rows}),
                        'categories': sorted({str(r.get('Category')) for r in rows}),
                        'nulls': {field: sum(row.get(field) is None for row in rows) for field in rows[0]},
                        'samples': [rows[i] for i in sorted({0, len(rows)//4, len(rows)//2, len(rows)-1})]}
        report[kind]['duplicates'] = duplicates
        report[kind]['region_counts'] = {name: sum(r[region] == name for r in rows) for name in report[kind]['regions']}
        report[kind]['period_counts'] = {period: sum(str(r[time]) == period for r in rows) for period in report[kind]['periods']}
        report[kind]['category_counts'] = {c: sum(str(r.get('Category')) == c for r in rows) for c in report[kind]['categories']}
        report[kind]['first_region_rows'] = [r for r in rows if r[region] == report[kind]['regions'][0]][-4:]
    output = Path(__file__).resolve().parents[2] / 'output' / 'water-services-dashboard'
    output.mkdir(parents=True, exist_ok=True)
    (output / 'schema-inspection.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(json.dumps({k: {'rows': v['rows'], 'duplicate_groups': len(v['duplicates']), 'duplicates': v['duplicates']} for k, v in report.items()}, indent=2))


if __name__ == '__main__':
    main()
