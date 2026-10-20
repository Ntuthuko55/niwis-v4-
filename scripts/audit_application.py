"""Trace NIWIS entry points without importing the app or exposing environment values."""
from __future__ import annotations

import ast
import json
import re
from collections import deque
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'output' / 'deployment-audit'
JS_EXTENSIONS = ('.mjs', '.js', '.mts', '.ts', '.jsx', '.tsx', '.json', '.css')
RUNTIME_DATA = {}  # Default database configuration has no required runtime CSVs.


def relative(path):
    return path.relative_to(ROOT).as_posix()


def js_resolve(source, specifier):
    base = source.parent / specifier
    candidates = [base, *[Path(str(base) + ext) for ext in JS_EXTENSIONS],
                  *[base / ('index' + ext) for ext in JS_EXTENSIONS]]
    return next((p.resolve() for p in candidates if p.is_file()), None)


def walk_frontend():
    entry = ROOT / 'frontend/src/main.jsx'
    pattern = re.compile(r'''(?:\b(?:import|export)\s+(?:[^;'"`]*?\s+from\s*)?|\bimport\s*\(\s*)['"]([^'"]+)['"]''')
    queue, seen, edges, external, unresolved, public = deque([entry]), set(), [], set(), [], set()
    while queue:
        path = queue.popleft().resolve()
        if path in seen: continue
        seen.add(path)
        text = path.read_text(encoding='utf-8-sig')
        for specifier in pattern.findall(text):
            if specifier.startswith('.'):
                target = js_resolve(path, specifier)
                if target:
                    edges.append({'from': relative(path), 'to': relative(target), 'kind': 'frontend import'})
                    queue.append(target)
                else:
                    unresolved.append({'file': relative(path), 'import': specifier})
            elif not specifier.startswith('/'):
                external.add('/'.join(specifier.split('/')[:2]) if specifier.startswith('@') else specifier.split('/')[0])
        for asset in re.findall(r'''['"`](\/[^'"`\s]+\.(?:csv|json|geojson|png|jpg|jpeg|svg|css|ico))['"`]''', text):
            candidate = ROOT / 'frontend/public' / asset.lstrip('/')
            if candidate.is_file(): public.add(candidate.resolve())
    packages = json.loads((ROOT / 'frontend/package.json').read_text(encoding='utf-8'))
    return {'entry': relative(entry), 'files': sorted(relative(p) for p in seen), 'edges': edges,
            'public_assets': sorted(relative(p) for p in public), 'external_imports': sorted(external),
            'unresolved_local_imports': unresolved,
            'dependencies_without_direct_imports': sorted(set(packages['dependencies']) - external)}


def module_file(module):
    if not module.startswith('app'): return None
    base = ROOT / 'backend' / module.replace('.', '/')
    return next((p for p in [base.with_suffix('.py'), base / '__init__.py'] if p.is_file()), None)


def walk_backend():
    entry = ROOT / 'backend/app/main.py'
    queue, seen, edges, external = deque([entry]), set(), [], set()
    while queue:
        path = queue.popleft().resolve()
        if path in seen: continue
        seen.add(path)
        tree = ast.parse(path.read_text(encoding='utf-8-sig'), filename=str(path))
        module = path.relative_to(ROOT / 'backend').with_suffix('').as_posix().replace('/', '.')
        package = module.rsplit('.', 1)[0]
        if path.name == '__init__.py': package = module.removesuffix('.__init__')
        targets = []
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                targets.extend((alias.name, node.lineno, 'python import') for alias in node.names)
            elif isinstance(node, ast.ImportFrom):
                base = node.module or ''
                if node.level:
                    parts = package.split('.')
                    base = '.'.join(parts[:len(parts) - node.level + 1] + ([base] if base else []))
                targets.append((base, node.lineno, 'python import'))
                targets.extend((base + '.' + alias.name, node.lineno, 'python import') for alias in node.names)
            elif isinstance(node, ast.Constant) and isinstance(node.value, str) and node.value.startswith('app.'):
                # The multivariate class registry contains lazy module paths.
                if re.fullmatch(r'app(?:\.[A-Za-z_][A-Za-z_0-9]*)+', node.value):
                    value = node.value if module_file(node.value) else node.value.rsplit('.', 1)[0]
                    targets.append((value, node.lineno, 'dynamic registry'))
        for name, line, kind in targets:
            target = module_file(name)
            if target:
                edges.append({'from': relative(path), 'to': relative(target), 'line': line, 'kind': kind})
                queue.append(target)
                parent = target.parent
                while parent != ROOT / 'backend':
                    init = parent / '__init__.py'
                    if init.is_file(): queue.append(init)
                    parent = parent.parent
            elif name and not name.startswith(('app', '__future__')):
                external.add(name.split('.')[0])
    return {'entry': relative(entry), 'files': sorted(relative(p) for p in seen), 'edges': edges,
            'external_import_roots': sorted(external)}


def audit():
    frontend, backend = walk_frontend(), walk_backend()
    all_frontend = {relative(p) for p in (ROOT / 'frontend/src').rglob('*') if p.is_file() and p.suffix in JS_EXTENSIONS}
    all_backend = {relative(p) for p in (ROOT / 'backend/app').rglob('*.py')}
    required = [{'path': path, 'bytes': (ROOT / path).stat().st_size if (ROOT / path).exists() else None, 'reason': reason}
                for path, reason in RUNTIME_DATA.items()]
    result = {'frontend': frontend, 'backend': backend,
              'frontend_outside_entry_graph': sorted(all_frontend - set(frontend['files'])),
              'backend_outside_entry_graph': sorted(all_backend - set(backend['files'])),
              'required_runtime_data': required,
              'runtime_data_bytes': sum(item['bytes'] or 0 for item in required),
              'note': 'Reachability is evidence for review, not permission to discard tests, build inputs, reference data or dynamic plugins.'}
    OUTPUT.mkdir(parents=True, exist_ok=True)
    (OUTPUT / 'file-connections.json').write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'frontend_files': len(frontend['files']), 'backend_files': len(backend['files']),
                      'public_assets': frontend['public_assets'], 'unresolved_imports': frontend['unresolved_local_imports'],
                      'frontend_outside_graph': result['frontend_outside_entry_graph'],
                      'backend_outside_graph': result['backend_outside_entry_graph'],
                      'dependencies_without_direct_imports': frontend['dependencies_without_direct_imports'],
                      'runtime_data_mib': round(result['runtime_data_bytes'] / 1048576, 2)}, indent=2))
    return result


if __name__ == '__main__':
    audit()
