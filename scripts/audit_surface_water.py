"""Reproducible, read-only audit of the three supplied surface-water CSVs."""
from pathlib import Path
import hashlib
import json
import itertools
import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'Surface Water Monitoring Network'
OUT = ROOT / 'output' / 'surface-water-data-report'
OUT.mkdir(parents=True, exist_ok=True)
files = [SOURCE / name for name in ['section_9_1_complete_unified_master_2000_2026.csv',
    'section_9_2_catchment_characteristics_master.csv',
    'section_9_3_sansa_earth_observation_master_2000_2026.csv']]
frames = [pd.read_csv(path) for path in files]
h, c, e = frames
summary = {}
profiles = []
for path, df in zip(files, frames):
    keys = ['district_name'] + (['date'] if 'date' in df else [])
    summary[path.name] = {'rows': len(df), 'districts': df.district_name.nunique(),
        'duplicate_keys': int(df.duplicated(keys).sum()), 'duplicate_rows': int(df.duplicated().sum()),
        'missing_cells': int(df.isna().sum().sum()), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}
    if 'date' in df:
        summary[path.name].update(start=df.date.min(), end=df.date.max(), dates=df.date.nunique())
    for col in df:
        s = df[col]
        profiles.append({'file': path.name, 'column': col, 'missing': s.isna().sum(), 'unique': s.nunique(),
                         'min': s.min(), 'max': s.max(), 'zero_count': int(s.eq(0).sum()),
                         'negative_count': int(s.lt(0).sum()) if pd.api.types.is_numeric_dtype(s) else None})
pd.DataFrame(profiles).to_csv(OUT / 'column-profile.csv', index=False)
h['period'] = h.date.str[:7]
numeric_h = [x for x in h.select_dtypes('number') if x not in ['year', 'month']]
numeric_e = [x for x in e.select_dtypes('number') if x not in ['year', 'month']]
month_groups = h.groupby(['district_name', 'period'])
cadence = month_groups[numeric_h].nunique()
summary['hydro_cadence'] = {col: {'district_months': len(cadence), 'constant_within_month': int(cadence[col].eq(1).sum()),
                               'constant_within_district_entire_record': int(h.groupby('district_name')[col].nunique().eq(1).sum())} for col in numeric_h}
series_sets = {'hydro_daily': (h, numeric_h, 'date'), 'eo_monthly': (e, numeric_e, 'date')}
duplicate_series = []
for name, (df, cols, date) in series_sets.items():
    for col in cols:
        wide = df.pivot(index=date, columns='district_name', values=col)
        groups = {}
        for district in wide:
            digest = hashlib.sha256(wide[district].to_numpy().tobytes()).hexdigest()
            groups.setdefault(digest, []).append(district)
        for districts in groups.values():
            if len(districts) > 1:
                duplicate_series.append({'dataset': name, 'variable': col, 'districts': districts, 'count': len(districts)})
summary['identical_district_series'] = duplicate_series
summary['eo_year_repetition'] = {}
for col in numeric_e:
    groups = e.groupby(['district_name', 'month'])[col]
    summary['eo_year_repetition'][col] = {'district_calendar_month_groups': groups.ngroups,
        'identical_across_years': int(groups.nunique().eq(1).sum())}

monthly = month_groups[numeric_h].mean().join(e.assign(period=e.date.str[:7]).set_index(['district_name', 'period'])[numeric_e])
monthly['daily_derived_volume'] = month_groups.daily_mean_flow.sum()
monthly['daily_derived_sediment_total'] = month_groups.daily_sediment_load_t_day.sum()
correlations = []
for level, df in [('raw_hydro', h[numeric_h]), ('raw_eo', e[numeric_e]), ('district_month', monthly), ('national_month', monthly.groupby('period').mean())]:
    df.corr().to_csv(OUT / f'correlations-{level}.csv')
    for a, b in itertools.combinations(df.columns, 2):
        pair = df[[a, b]].dropna()
        if pair[a].std() < 1e-12 or pair[b].std() < 1e-12:
            continue
        r = pair[a].corr(pair[b])
        if abs(r) >= .95:
            slope, intercept = np.polyfit(pair[a], pair[b], 1)
            residual = pair[b] - (pair[a] * slope + intercept)
            correlations.append({'level': level, 'x': a, 'y': b, 'pearson_r': r, 'slope': slope,
                'intercept': intercept, 'max_abs_residual': residual.abs().max(), 'n': len(pair)})
pd.DataFrame(correlations).to_csv(OUT / 'high-correlations.csv', index=False)

land = ['water_bodies_pct', 'tree_cover_pct', 'shrubland_fynbos_pct', 'grassland_pct', 'cropland_agri_pct', 'wetland_pct', 'builtup_urban_pct', 'bare_soil_mining_pct']
c['land_total_pct'] = c[land].sum(axis=1)
c.to_csv(OUT / 'catchment-checks.csv', index=False)
summary['catchment'] = {'constant_columns': {col: c[col].iloc[0] for col in c if c[col].nunique() == 1},
    'grass_equals_crop': int(c.grassland_pct.eq(c.cropland_agri_pct).sum()),
    'land_total_min': c.land_total_pct.min(), 'land_total_max': c.land_total_pct.max(), 'land_total_mean': c.land_total_pct.mean(),
    'invalid_land_totals': int((c.land_total_pct - 100).abs().gt(.1).sum()),
    'soil_percentage_vectors': c[['hsg_a_pct', 'hsg_b_pct', 'hsg_c_pct', 'hsg_d_pct']].drop_duplicates().to_dict('records')}

def agreement(observed, expected, rtol=.01, atol=.0001):
    mask = observed.notna() & expected.notna()
    match = np.isclose(observed[mask], expected[mask], rtol=rtol, atol=atol)
    return {'paired_rows': int(mask.sum()), 'matching_rows': int(match.sum()), 'match_pct': float(match.mean()*100),
            'max_abs_difference': float((observed[mask]-expected[mask]).abs().max())}

summary['consistency'] = {
    'q_vs_daily_volume_div86400': agreement(h.river_discharge_q, h.daily_mean_flow/86400),
    'daily_sediment_vs_volume_times_concentration_div1e6': agreement(h.daily_sediment_load_t_day, h.daily_mean_flow*h.suspended_sediment_concentration/1e6),
    'monthly_sediment_rate_vs_Q_times_concentration_times0.0864': agreement(h.monthly_sediment_load_t_day, h.river_discharge_q*h.suspended_sediment_concentration*.0864),
    'reported_monthly_volume_vs_q_times_days_times86400': agreement(h.monthly_mean_flow, h.river_discharge_q*pd.to_datetime(h.date).dt.days_in_month*86400),
}
checks = month_groups.agg(days=('date', 'nunique'), reported_volume_unique=('monthly_mean_flow', 'nunique'),
                           reported_monthly_volume=('monthly_mean_flow', 'first'), daily_derived_volume=('daily_mean_flow', 'sum'))
checks['expected_days'] = pd.PeriodIndex(checks.index.get_level_values('period'), freq='M').days_in_month
checks['complete'] = checks.days.eq(checks.expected_days)
checks['reported_to_daily_volume_ratio'] = checks.reported_monthly_volume / checks.daily_derived_volume
checks.to_csv(OUT / 'monthly-volume-checks.csv')
valid = checks[checks.complete & checks.reported_volume_unique.eq(1)]
summary['monthly_volume_consistency'] = agreement(valid.reported_monthly_volume, valid.daily_derived_volume)
summary['monthly_volume_ratio'] = valid.reported_to_daily_volume_ratio.describe(percentiles=[.01,.5,.99]).to_dict()
summary['incomplete_months'] = checks[~checks.complete].reset_index().groupby('period').agg(districts=('district_name','size'), days=('days','first')).to_dict('index')
summary['conflicting_months'] = checks[checks.reported_volume_unique.gt(1)].reset_index().groupby('period').agg(districts=('district_name','size'), distinct_values=('reported_volume_unique','max')).to_dict('index')
summary['rating'] = h.groupby('district_name')[['a_coeff','b_exponent','r_squared']].first().describe().to_dict()
summary['rating']['zero_r2_districts'] = int(h.groupby('district_name').r_squared.first().eq(0).sum())
summary['peak_constant_district_years'] = int(h.groupby(['district_name','year']).peak_instantaneous_flow.nunique().eq(1).sum())
summary['district_years'] = h.groupby(['district_name','year']).ngroups
summary['eo_distinct_values_per_district'] = {col: {'min': int(e.groupby('district_name')[col].nunique().min()),
    'max': int(e.groupby('district_name')[col].nunique().max())} for col in numeric_e}
summary['q_volume_by_era'] = {name: agreement(part.river_discharge_q, part.daily_mean_flow/86400)
    for name, part in [('2000-2025', h[h.year.lt(2026)]), ('2026', h[h.year.eq(2026)])]}
summary['eo_within_district_correlation'] = {}
for a, b in [('surface_water_extent_km2','ndwi_mean'), ('surface_water_extent_km2','turbidity_proxy_ratio'), ('chlorophyll_a_mg_m3','sediment_plume_pct')]:
    rs = [part[a].corr(part[b]) for _, part in e.groupby('district_name')]
    summary['eo_within_district_correlation'][a + ' vs ' + b] = {'min': min(rs), 'max': max(rs), 'districts': len(rs)}
summary['calendar_field_errors'] = {path.name: int(((pd.to_datetime(df.date).dt.year != df.year) |
    (pd.to_datetime(df.date).dt.month != df.month)).sum()) for path, df in [(files[0], h), (files[2], e)]}
e[(e.district_name == 'City of Cape Town') & e.year.isin([2000, 2025, 2026]) & e.month.isin([1, 7])].to_csv(OUT / 'repeated-satellite-examples.csv', index=False)

# A standalone plot for the report; values rescaled only to compare shapes.
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
national = e.groupby('date')[numeric_e].mean()
recent = national.loc['2023-01-01':'2025-12-01']
plt.rcParams.update({'font.size': 10, 'axes.spines.top': False, 'axes.spines.right': False})
fig, axes = plt.subplots(3, 1, figsize=(12, 11), constrained_layout=True)
colors = ['#1460a8', '#18a478', '#d88c18']
for ax, cols, title in [(axes[0], numeric_e[:3], 'Water extent, NDWI and turbidity: the same repeated shape'),
                       (axes[1], numeric_e[3:5], 'Chlorophyll-a and sediment plume: another repeated shape')]:
    for i, col in enumerate(cols):
        s = recent[col]
        ax.plot(pd.to_datetime(s.index), (s-s.min())/(s.max()-s.min()), label=col,
                color=colors[i], linewidth=4-i, linestyle=['-', '--', ':'][i])
    ax.set(title=title, ylabel='Rescaled 0-1 (shape only)', ylim=(-.1, 1.3))
    ax.legend(loc='upper right', fontsize=8, ncol=1)
    ax.grid(alpha=.15)
match = np.isclose(h.river_discharge_q, h.daily_mean_flow/86400, rtol=.01, atol=.0001)
yearly = h.assign(match=match).groupby('year').match.mean()*100
axes[2].bar(yearly.index, yearly, color=['#1460a8']*26+['#d88c18'])
axes[2].set(title='Flow fields change relationship in 2026', ylabel='District-days agreeing (%)',
            xlabel='Year (2026 through 24 September)', ylim=(0,110))
axes[2].text(2000, 90, 'Reported Q vs daily_mean_flow / 86,400\nTolerance: 1% relative + 0.0001 m3/s', fontsize=10)
axes[2].grid(axis='y', alpha=.15)
fig.suptitle('Surface water source-data audit | 6 October 2026\nNational equal-weight district means; original files unchanged', fontsize=15)
fig.savefig(OUT / 'data-quality-evidence.png', dpi=160)
fig.savefig(OUT / 'data-quality-evidence.pdf')
plt.close(fig)
(OUT / 'audit-summary.json').write_text(json.dumps(summary, indent=2, default=lambda x: x.item() if hasattr(x, 'item') else str(x)), encoding='utf-8')
print(json.dumps({k:v for k,v in summary.items() if k not in ['identical_district_series', 'rating']}, indent=2, default=str))
print('IDENTICAL SERIES GROUPS', len(duplicate_series))
print(pd.DataFrame(correlations).to_string(index=False))
