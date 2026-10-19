"""Build a small display-only boundary asset; retain the original for analysis."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'frontend/public/south_africa_adm2.geojson'
TARGET = ROOT / 'frontend/public/south_africa_adm2.display.geojson'


def area(ring):
    return sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(ring, ring[1:])) / 2


def simplify(ring, tolerance=0.0015):
    if len(ring) < 6:
        return ring
    keep = {0, len(ring) - 1}
    pending = [(0, len(ring) - 1)]
    while pending:
        first, last = pending.pop()
        ax, ay = ring[first][:2]
        bx, by = ring[last][:2]
        dx, dy = bx - ax, by - ay
        denominator = dx * dx + dy * dy
        best, index = tolerance * tolerance, None
        for cursor in range(first + 1, last):
            x, y = ring[cursor][:2]
            position = max(0, min(1, ((x - ax) * dx + (y - ay) * dy) / denominator)) if denominator else 0
            distance = (x - ax - position * dx) ** 2 + (y - ay - position * dy) ** 2
            if distance > best:
                best, index = distance, cursor
        if index is not None:
            keep.add(index)
            pending.extend(((first, index), (index, last)))
    result = [[round(float(value), 5) for value in ring[index][:2]] for index in sorted(keep)]
    original_area = area(ring)
    if (len(result) < 4 or area(result) * original_area <= 0
            or abs(area(result) - original_area) > max(abs(original_area) * 0.001, 1e-10)):
        return [[round(float(value), 5) for value in point[:2]] for point in ring]
    return result


def build():
    document = json.loads(SOURCE.read_text(encoding='utf-8'))
    identities = [feature['properties'] for feature in document['features']]
    before = after = 0
    for feature in document['features']:
        geometry = feature['geometry']
        polygons = [geometry['coordinates']] if geometry['type'] == 'Polygon' else geometry['coordinates']
        for polygon in polygons:
            for index, ring in enumerate(polygon):
                before += len(ring)
                polygon[index] = simplify(ring)
                after += len(polygon[index])
                assert len(polygon[index]) >= 4 and polygon[index][0] == polygon[index][-1]
    assert [feature['properties'] for feature in document['features']] == identities
    TARGET.write_text(json.dumps(document, separators=(',', ':'), ensure_ascii=False), encoding='utf-8')
    print(f'Display map: {len(identities)} districts; {before:,} -> {after:,} vertices; '
          f'{SOURCE.stat().st_size:,} -> {TARGET.stat().st_size:,} bytes')


if __name__ == '__main__':
    build()
