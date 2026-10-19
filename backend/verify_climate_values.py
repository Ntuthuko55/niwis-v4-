"""Read-only live check of national/district climate values (no CSV fallback)."""
import json
from pathlib import Path
from time import perf_counter
from unittest.mock import patch

from app import climate_source, climate_service


def main():
    started = perf_counter()
    with patch('pandas.read_csv', side_effect=AssertionError('CSV fallback is forbidden')):
        meta = climate_service.metadata()
        print(f"Metadata: latest {meta['latest_daily_date']}, default {meta['default_end']}", flush=True)
        year = meta['default_end']
        national = climate_service.dashboard(start=year, end=year)
        for key in ('Tavg_C', 'Heat_Days', 'MAP_mm', 'Daily_ET0_mm', 'Irrigation_Water_Demand_mm', 'MAR_m3_year'):
            assert national['summary'][key] is not None, f'{key} is unavailable in the national view'
        assert len(national['map']) == len(meta['regions'])
        assert all(row['Tavg_C'] is not None for row in national['map'])
        assert all(row['observed'] > 0 and row['expected'] > 0 for row in national['coverage'])
        print('National values: ' + json.dumps(national['summary']), flush=True)

        # Independently read a district's source rows and check the national
        # map's aggregation, not just that the API returns non-null values.
        district = 'City of Tshwane'
        derived = {'Heat_Days', 'Heat_Duration', 'Frost_Days'}
        columns = {section: [key for key, _, _, group, _ in climate_service.METRICS if group == section and key not in derived]
                   for section in climate_source.SECTIONS}
        frames = climate_source.read_frames(columns, year, year, district)
        temperature = frames['temperature']
        expected = {
            'Tavg_C': temperature.Tavg_C.mean(),
            'Heat_Days': float((temperature.Tmax_C > 35).sum()),
            'Daily_ET0_mm': frames['evaporation'].Daily_ET0_mm.mean(),
            'Irrigation_Water_Demand_mm': frames['irrigation'].Irrigation_Water_Demand_mm.sum(),
        }
        mapped = next(row for row in national['map'] if row['District_Name'] == district)
        for key, value in expected.items():
            assert abs(mapped[key] - value) < 1e-7, (key, mapped[key], value)
        print(f'PASS {district}: national map matches independent daily means, counts and totals', flush=True)

        output = Path(__file__).resolve().parents[1] / 'output' / 'climate-values'
        output.mkdir(parents=True, exist_ok=True)
        (output / 'metadata.json').write_text(json.dumps(meta), encoding='utf-8')
        (output / 'national.json').write_text(json.dumps(national), encoding='utf-8')
        district_result = climate_service.dashboard(region=district, start=year, end=year)
        for key, value in expected.items():
            assert abs(district_result['summary'][key] - value) < 1e-7
        assert len(district_result['map']) == len(meta['regions'])
        assert all(row['Tavg_C'] is not None for row in district_result['map']), \
            'District selection must keep daily temperature colours for every map district'
        (output / 'district.json').write_text(json.dumps(district_result), encoding='utf-8')
        print(f'PASS six database-backed sections, national/district agreement, coverage; {perf_counter() - started:.1f}s', flush=True)


if __name__ == '__main__':
    main()
