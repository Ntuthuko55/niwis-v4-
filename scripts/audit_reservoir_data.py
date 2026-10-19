"""Profile the supplied reservoir CSV before exposing its operational fields."""
import argparse
import hashlib
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'Dam and Reservoir Status' / 'south_africa_reservoir_master_12vars_mapped.csv'


def audit(as_of):
    frame = pd.read_csv(SOURCE)
    dates = pd.to_datetime(frame.date, errors='coerce')
    grouped = frame.groupby('district_name')
    numeric = frame.select_dtypes('number')
    eligible = frame[dates.le(pd.Timestamp(as_of))]
    latest = eligible.sort_values('date').groupby('district_name').tail(1)
    profiles = {key: {'min': float(numeric[key].min()), 'max': float(numeric[key].max()),
                      'missing': int(numeric[key].isna().sum()), 'distinct': int(numeric[key].nunique()),
                      'constant_groups': int(grouped[key].nunique().le(1).sum())} for key in numeric}
    result = {'file': SOURCE.name, 'sha256': hashlib.sha256(SOURCE.read_bytes()).hexdigest(),
              'bytes': SOURCE.stat().st_size, 'rows': len(frame), 'columns': list(frame.columns), 'as_of': as_of,
              'first_date': str(frame.date.min()), 'last_date': str(frame.date.max()),
              'groups': int(frame.district_name.nunique()), 'invalid_dates': int(dates.isna().sum()),
              'duplicate_name_date_rows': int(frame.duplicated(['district_name', 'date']).sum()),
              'identifier_collisions': frame.groupby('district_id').district_name.nunique().loc[lambda values: values.gt(1)].to_dict(),
              'future_rows': int(dates.gt(pd.Timestamp(as_of)).sum()), 'missing_cells': int(frame.isna().sum().sum()),
              'numeric': profiles, 'group_rows': grouped.size().to_dict(),
              'constant_storage_groups': int(grouped.storage_volume_m3.nunique().le(1).sum()),
              'inflow_equals_district_runoff_rate': bool(np.allclose(frame.inflow_m3_s, frame.runoff_mm_day * frame.district_area_km2 * 1000 / 86400)),
              'level_equals_fixed_fsc_transform': bool(np.allclose(frame.water_level_m_amsl, frame.fsl_m_amsl - (100 - frame.pct_fsc) * .05)),
              'latest': latest[['district_name', 'dam_name', 'province', 'date', 'storage_volume_m3', 'pct_fsc']].to_dict('records')}
    output = ROOT / 'output' / 'reservoir-data-report'
    output.mkdir(parents=True, exist_ok=True)
    (output / 'reservoir-data-audit.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
    lines = ['# Dam and Reservoir Dataset Review', '', f'Monitoring cutoff: **{as_of}**.', '',
             f'Source: `{SOURCE.name}` ({SOURCE.stat().st_size:,} bytes).', '',
             f'The file contains **{len(frame):,} daily rows**, **{len(frame.columns)} columns** and **{frame.district_name.nunique()} district reservoir groups**, from **{frame.date.min()}** to **{frame.date.max()}**.', '',
             '## Findings that affect the dashboard', '',
             f'- There are {result["invalid_dates"]} invalid dates, {result["missing_cells"]} missing cells and {result["duplicate_name_date_rows"]} duplicate district-name/date rows.',
             '- The identifier `D_UNMAPPED` is reused by John Taolo Gaetsewe, Siyanda and Ugu. Use district names as series identifiers so these records remain separate.',
             '- Siyanda and Z F Mgcawu refer to the same mapped geography. Both source histories remain selectable; the map uses the current Z F Mgcawu group for that polygon. National charts average source groups and are not national totals.',
             f'- {result["future_rows"]:,} rows occur after the monitoring cutoff. Default operational views exclude them; the source file remains unchanged.',
             f'- Storage is constant throughout {result["constant_storage_groups"]} of {result["groups"]} group histories. Only Vhembe changes. Flat charts therefore reflect the file.',
             '- All FSL values are 1,200 m amsl. Water level exactly follows FSL - (100 - % FSC) x 0.05. All inflow rates exactly equal district runoff depth x district area / 86,400. These relationships do not establish independent telemetry or gauging provenance.',
             '- Most dam names join multiple reservoirs with `/`; data cannot be attributed separately to either named dam. No dam coordinates or reservoir footprint polygons are supplied.',
             '- Six priority dam names occur within grouped mappings. Vanderkloof and Katse do not occur in the file. Reference capacities from the supplied specification are inventory values, not measured group capacities.',
             '- RSI can be computed only where a same-month historical storage baseline has nonzero variability. Constant histories produce an unavailable RSI, rather than zero.',
             '- Days-to-empty is conditional on a complete 30-day observed drawdown window. No decline produces an unavailable projection, not an assertion of unlimited supply.',
             '- DIR has no supplied values or formula and remains unavailable.', '',
             '## Units and numerical ranges', '', '| Source column | Minimum | Maximum | Missing | Constant groups |', '| --- | ---: | ---: | ---: | ---: |']
    for key, values in profiles.items():
        lines.append(f'| {key} | {values["min"]:.6g} | {values["max"]:.6g} | {values["missing"]} | {values["constant_groups"]} |')
    lines += ['', '## Display and calculation rules', '',
              'Storage converts m3 to million m3 and is never summed across days. Rates stay in m3/s; seepage stays in m3/day. Daily rainfall and evaporation remain mm/day. Estimated runoff converts depth using the supplied district area, which is a catchment proxy.', '',
              'Weekly level change compares exact dates seven days apart (m/week). Monthly relative storage change compares the latest date with the corresponding date one calendar month earlier (%/month). Days-to-empty divides current storage by the observed 30-day mean daily drawdown. RSI standardises the latest storage against prior years\' same-calendar-month mean storage, using sample standard deviation and at least three years.', '',
              'Critical FSC thresholds use the supplied strict limits: Level 3 below 15%, Level 2 below 30%, Level 1 below 50%; 50% and above are outside those alert levels. Missing values remain unavailable.', '',
              f'Source SHA-256: `{result["sha256"]}`.', '']
    (output / 'Reservoir-Data-Report.md').write_text('\n'.join(lines), encoding='utf-8')
    print(json.dumps({key: result[key] for key in ['rows', 'groups', 'first_date', 'last_date', 'future_rows', 'duplicate_name_date_rows', 'constant_storage_groups']}, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--as-of', default=datetime.now(timezone(timedelta(hours=2))).strftime('%Y-%m-%d'))
    audit(parser.parse_args().as_of)
