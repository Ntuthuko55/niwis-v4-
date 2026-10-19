"""Read-only live checks for all monitoring modules; record cold/warm API timing."""
import json
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from time import perf_counter
from urllib.parse import urlencode
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]
BASE = 'http://127.0.0.1:8000'


def get(path):
    started = perf_counter()
    with urlopen(BASE + path, timeout=150) as response:
        raw = response.read()
        data = json.loads(raw)
        return data, {'path': path, 'seconds': round(perf_counter() - started, 3),
                      'bytes': len(raw), 'cache': response.headers.get('X-Niwis-Cache')}


def check(module):
    meta, timing = get(f'/{module}/metadata')
    region = 'City of Tshwane'
    if module == 'climate':
        year = min(2025, meta['default_end'])
        params = {'region': region, 'start': year, 'end': year, 'season': 'Annual'}
    elif module in ('groundwater-reserve', 'water-quality'):
        params = {'region': region, 'start': meta['default_end'], 'end': meta['default_end']}
    else:
        params = {'region': region, 'start': meta['default_start'], 'end': meta['default_end']}
    data, cold = get(f'/{module}/dashboard?{urlencode(params)}')
    warm, repeat = get(cold['path'])
    assert data == warm
    assert data.get('series'), f'{module}: missing chart series'
    assert len(data.get('map', [])) >= 52, f'{module}: incomplete national map'
    return {'module': module, 'source': data.get('source', meta.get('source', 'Existing configured source')),
            'metadata': timing, 'first': cold, 'repeat': repeat,
            'map_rows': len(data['map']), 'series_rows': len(data['series'])}


def main():
    modules = ('climate', 'vegetation', 'rainfall', 'runoff', 'surface-water',
               'groundwater', 'groundwater-reserve', 'water-quality', 'reservoirs')
    results = []
    with ThreadPoolExecutor(max_workers=3) as executor:
        futures = {executor.submit(check, module): module for module in modules}
        for future in as_completed(futures):
            module = futures[future]
            try:
                item = future.result()
                print(f'PASS {module}: {item["map_rows"]} map rows; first {item["first"]["seconds"]}s; repeat {item["repeat"]["seconds"]}s', flush=True)
            except Exception as error:
                item = {'module': module, 'error': str(error)}
                print(f'FAIL {module}: {error}', flush=True)
            results.append(item)
    output = ROOT / 'output/dashboard-performance'
    output.mkdir(parents=True, exist_ok=True)
    (output / 'api-verification.json').write_text(json.dumps(results, indent=2), encoding='utf-8')
    return results


if __name__ == '__main__':
    main()
