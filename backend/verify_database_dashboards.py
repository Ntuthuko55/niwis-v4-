"""Live database regression check: fail immediately if either dashboard reads CSV."""
from unittest.mock import patch
import json

from app import drought_source
from app.hydrology_service import get_hydrology_dataset, get_all_stations, get_district_hydrology_history
from app.satellite_service import stations, history
from app.supabase_source import SupabaseSourceError
from app.dashboard_loader import clear_dashboard_cache


with patch('pandas.read_csv', side_effect=AssertionError('CSV reads are forbidden')):
    dataset = get_hydrology_dataset()
    assert dataset['source'] == 'hydrological_drought_master'
    assert len(dataset['records']) > 1000, 'Database pagination did not return full history'
    latest = get_all_stations()
    assert latest['station_count'] == len(dataset['districts'])
    assert latest['date'] == max(row['date'] for row in dataset['records'])
    district = dataset['districts'][0]
    hydro = get_district_hydrology_history(district.upper())
    expected = [r for r in dataset['records'] if r['district_name'] == district]
    assert hydro['records'] == expected
    assert hydro['date'] == expected[-1]['date']
    assert hydro['metrics']['river_discharge'] == expected[-1]['river_discharge_m3_s']
    json.dumps(hydro, allow_nan=False)
    print(f"PASS hydrology: {len(dataset['districts'])} districts, {len(dataset['records'])} database rows, latest {latest['date']}", flush=True)

    satellite = stations()
    assert satellite['source'] == 'satellite_remote_sensing'
    assert satellite['station_count'] == 52
    first = satellite['stations'][0]
    satellite_history = history(first['name'].upper())
    assert len(satellite_history['history']) > 12
    assert satellite_history['history'][-1]['NDVI'] == first['NDVI']
    assert satellite_history['history'][-1]['date'] == satellite['date']
    assert all(key in first for key in ['NDVI', 'LST', 'VCI', 'TCI', 'VHI', 'GRACE_TWS'])
    json.dumps(satellite_history, allow_nan=False)
    print(f"PASS satellite: {satellite['station_count']} districts, {len(satellite_history['history'])} history rows, latest {satellite['date']}", flush=True)

    clear_dashboard_cache()
    with patch.object(drought_source, '_request_page', side_effect=SupabaseSourceError('Database unavailable')):
        for call in [get_hydrology_dataset, stations, lambda: history('Alfred Nzo')]:
            try:
                call()
            except SupabaseSourceError:
                pass
            else:
                raise AssertionError('Database errors must not fall back to local data')
    print('PASS database failures propagate; no CSV fallback', flush=True)
