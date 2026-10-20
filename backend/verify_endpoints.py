"""Verify the retained monitoring and forecasting API route inventory."""
from app.main import app

paths = set(app.openapi()['paths'])
required = {'/health', '/dashboard/dataset', '/meteorological/load',
            '/models/train', '/models/jobs/{job_id}', '/provinces/series/{dataset_id}'}
retired = {'/upload', '/preview', '/analysis', '/analysis/comprehensive', '/forecast',
           '/kzn/forecast', '/dashboard/forecast', '/provinces/{province_id}/load'}
assert required <= paths, required - paths
assert not retired & paths, retired & paths
mounts = {route.path for route in app.routes if type(route).__name__ == 'Mount'}
assert mounts == {'/niwis-api'}, mounts
print(f'PASS: {len(paths)} retained API paths; standalone analysis routes removed.')
print('Shared dataset registration, model jobs and regional series remain available.')
