import { dashboardFetch as fetch } from '../services/dashboardFetch'
import { useEffect, useMemo, useState } from 'react'
import { Activity, Download, Droplets, Gauge, Layers, MapPin, RefreshCw, ShieldCheck, Waves } from 'lucide-react'
import { Chart, Panel } from './RainfallStatus'
import { DistrictMap, normaliseDistrictName } from './DistrictMap'
import LoadingProgress from './LoadingProgress'
import '../niwis/groundwater-reserve.css'

const fmt = (value, digits = 1) => value == null || !Number.isFinite(Number(value)) ? '—' : Number(value).toLocaleString('en-ZA', { minimumFractionDigits: digits, maximumFractionDigits: digits })
const icons = { reserve: ShieldCheck, hydrogeology: Layers, recharge: Droplets, discharge: Waves, sustainability: Gauge, 'derived balance': Activity }
const palette = ['#b85d55', '#d99a6b', '#e4d99a', '#78b9aa', '#2e7894']

async function getJSON(url, signal) {
  const response = await fetch(url, { signal })
  const data = await response.json()
  if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : 'Groundwater reserve data could not be loaded.')
  return data
}

function downloadCSV(name, headers, rows) {
  const esc = value => `"${String(value ?? '').replaceAll('"', '""')}"`
  const blob = new Blob(['\uFEFF' + [headers, ...rows].map(row => row.map(esc).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' })
  const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 800)
}

export default function GroundwaterReserveAssessment({ section = null }) {
  const [snapshotLoading, setSnapshotLoading] = useState(false), [snapshotError, setSnapshotError] = useState(''), [snapshotRetry, setSnapshotRetry] = useState(0)
  const [meta, setMeta] = useState(null), [result, setResult] = useState(null), [features, setFeatures] = useState([])
  const [draft, setDraft] = useState({ region: 'National', start: '', end: '' }), [applied, setApplied] = useState(null)
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [retry, setRetry] = useState(0), [mapYear, setMapYear] = useState(''), [mapResult, setMapResult] = useState(null)
  const [mapKey, setMapKey] = useState('reserve_balance_million_m3_yr'), [trendKey, setTrendKey] = useState('reserve_balance_million_m3_yr')
  const [monthly, setMonthly] = useState(null), [monthlyError, setMonthlyError] = useState('')

  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError('')
    Promise.all([getJSON('/api/groundwater-reserve/metadata', controller.signal), getJSON('/south_africa_adm2.display.geojson', controller.signal).catch(() => ({ features: [] }))]).then(([data, map]) => {
      setMeta(data); setFeatures(map.features || [])
      const initial = { region: 'National', start: data.default_start, end: data.default_end }
      setDraft(initial); setApplied(initial)
    }).catch(err => { if (err.name !== 'AbortError') { setError(err.message); setLoading(false) } })
    return () => controller.abort()
  }, [retry])

  useEffect(() => {
    if (!applied) return
    const controller = new AbortController(); setLoading(true); setError(''); setResult(current => current?.region === applied.region && String(current.start) === String(applied.start) && String(current.end) === String(applied.end) ? current : null); setMapResult(null); setMonthly(null); setMapYear(String(applied.end))
    getJSON(`/api/groundwater-reserve/dashboard?${new URLSearchParams(applied)}`, controller.signal).then(setResult).catch(err => { if (err.name !== 'AbortError') (setResult(null), setError(err.message)) }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [applied])

  useEffect(() => {
    setMapResult(null); setSnapshotError(''); setSnapshotLoading(false)
    if (!applied || !mapYear || String(mapYear) === String(applied.end)) return undefined
    const controller = new AbortController(); setSnapshotLoading(true)
    getJSON(`/api/groundwater-reserve/dashboard?${new URLSearchParams({ ...applied, start: mapYear, end: mapYear })}`, controller.signal).then(setMapResult).catch(err => { if (err.name !== 'AbortError') setSnapshotError(err.message) }).finally(() => { if (!controller.signal.aborted) setSnapshotLoading(false) })
    return () => controller.abort()
  }, [applied, mapYear, snapshotRetry])

  useEffect(() => {
    if (!result) return
    const controller = new AbortController(); setMonthly(null); setMonthlyError('')
    getJSON(`/api/groundwater-reserve/monthly?${new URLSearchParams({ region: result.region, year: result.end })}`, controller.signal).then(setMonthly).catch(err => { if (err.name !== 'AbortError') setMonthlyError(err.message) })
    return () => controller.abort()
  }, [result])

  const catalogue = useMemo(() => Object.fromEntries((meta?.metrics || []).map(metric => [metric.key, metric])), [meta])
  const sectionKeys = {
    hydrogeology: ['water_table_depth_m_bgl', 'aquifer_extent_km2', 'saturated_thickness_m', 'depth_to_bedrock_m_bgl', 'storage_coefficient', 'permeability_m_day', 'porosity_percent', 'specific_storage', 'specific_yield', 'storativity_specific_yield', 'transmissivity_m2_day', 'borehole_yield_m3_h', 'water_quality_for_use'],
    'recharge-discharge': ['dynamic_reserve_million_m3_yr', 'rainfall_infiltration_mm_yr', 'direct_recharge_mm_yr', 'indirect_recharge_m3_yr', 'baseflow_discharge_m3_s', 'spring_discharge_l_s', 'evapotranspiration_mm', 'total_abstraction_m3_yr', 'storage_change_m3_yr', 'storage_change_million_m3_yr'],
    sustainability: ['exploitation_index_percent', 'aquifer_depletion_rate_m_yr', 'recharge_sensitivity_percent', 'storage_change_m3_yr', 'storage_change_million_m3_yr', 'reserve_balance_million_m3_yr', 'total_abstraction_m3_yr', 'borehole_yield_m3_h', 'water_quality_for_use'],
  }
  const scopedMetrics = (meta?.metrics || []).filter(item => !section || sectionKeys[section]?.includes(item.key))
  useEffect(() => { const first = scopedMetrics[0]?.key; if (section && first) { setMapKey(first); setTrendKey(first) } }, [section, meta])
  const metric = key => catalogue[key] || { key, label: key.replaceAll('_', ' '), unit: '' }
  const customSnapshot = applied && mapYear && String(mapYear) !== String(applied.end)
  const mapSource = customSnapshot ? mapResult : result
  const mapValues = useMemo(() => Object.fromEntries((mapSource?.map || []).map(row => [normaliseDistrictName(row.district_name), row])), [mapSource])
  const signed = key => key.includes('balance') || key.includes('change')
  const scale = useMemo(() => {
    const values = (mapSource?.map || []).filter(row => row[mapKey] != null).map(row => Number(row[mapKey])).filter(Number.isFinite)
    const limit = Math.max(1, ...values.map(value => Math.abs(value)))
    const low = signed(mapKey) ? -limit : 0, high = signed(mapKey) ? limit : Math.max(1, ...values)
    const range = high - low || 1
    return { color: value => palette[Math.max(0, Math.min(palette.length - 1, Math.floor((Number(value) - low) / range * palette.length)))], legend: { title: metric(mapKey).label, gradient: `linear-gradient(180deg, ${[...palette].reverse().join(',')})`, items: [[fmt(high, 0), signed(mapKey) ? 'Positive' : 'Higher'], [fmt((high + low) / 2, 0), 'Typical'], [fmt(low, 0), signed(mapKey) ? 'Deficit' : 'Lower']] } }
  }, [mapSource, mapKey, catalogue])
  const selectRegion = name => {
    const canonical = meta?.regions.find(region => normaliseDistrictName(region) === normaliseDistrictName(name))
    if (canonical) { const next = { ...applied, region: canonical }; setDraft(next); setApplied(next) }
  }
  const line = (key, color, label) => ({ key, label: label || metric(key).label, unit: metric(key).unit, color })
  const trend = (result?.series || []).map(row => ({ ...row, total_abstraction_million_m3_yr: row.total_abstraction_m3_yr == null ? null : row.total_abstraction_m3_yr / 1e6 }))
  const latest = result?.latest || {}
  const kpis = [
    ['dynamic_reserve_million_m3_yr', 'Dynamic reserve', Droplets, 'reserve'],
    ['static_reserve_million_m3', 'Static reserve', Layers, 'hydrogeology'],
    ['total_abstraction_m3_yr', 'Total abstraction', Waves, 'sustainability'],
    ['reserve_balance_million_m3_yr', 'Reserve balance', ShieldCheck, 'reserve'],
    ['exploitation_index_percent', 'Exploitation index', Gauge, 'sustainability'],
    ['recharge_sensitivity_percent', 'Recharge sensitivity', Activity, 'derived balance'],
  ]
  const exportData = () => {
    if (!result) return
    const allowed = new Set(scopedMetrics.map(item => item.key)); const keys = section ? result.variables.filter(key => allowed.has(key)) : result.variables
    downloadCSV(`NIWIS-groundwater-reserve-${result.region.replaceAll(' ', '-')}-${result.start}-${result.end}.csv`, ['Region', 'Year', ...keys.map(key => `${metric(key).label} (${metric(key).unit})`)], result.series.map(row => [result.region, row.year, ...keys.map(key => row[key])]))
  }

  return <div className="rainfall-dashboard groundwater-reserve-dashboard" data-section={section || 'all'}>
    <div className="rf-heading"><span className="rf-heading-icon reserve-icon"><ShieldCheck size={31} /></span><div><span className="rf-eyebrow">NIWIS / DWS SECTION 11</span><h1>Groundwater Reserve Assessment</h1><p>Dynamic and static reserve, recharge, abstraction and aquifer sustainability across South Africa</p></div><button className="rf-export" onClick={exportData} disabled={!result || loading}><Download size={15} /> Export annual data</button></div>
    <form className="rf-filters" onSubmit={event => { event.preventDefault(); setApplied({ ...draft }) }}><label className="rf-region">Region / District<select aria-label="Groundwater reserve region" disabled={!meta} value={draft.region} onChange={event => setDraft({ ...draft, region: event.target.value })}><option value="National">South Africa (district average)</option>{meta?.regions.map(region => <option key={region}>{region}</option>)}</select></label><label>From year<select aria-label="Groundwater reserve start year" value={draft.start} disabled={!meta} onChange={event => setDraft({ ...draft, start: Number(event.target.value) })}>{meta?.years.map(year => <option key={year}>{year}</option>)}</select></label><label>To year<select aria-label="Groundwater reserve end year" value={draft.end} disabled={!meta} onChange={event => setDraft({ ...draft, end: Number(event.target.value) })}>{meta?.years.map(year => <option key={year}>{year}</option>)}</select></label><button className="rf-apply" disabled={loading || !meta || draft.start > draft.end}>Apply filters</button></form>
    {loading && <LoadingProgress className="rf-loading" message="Combining reserve, recharge and sustainability indicators" />}
    {error && <div className="rf-error" role="alert">{error}<button onClick={() => meta ? setApplied({ ...applied }) : setRetry(retry + 1)}>Retry</button></div>}
    {!result && <Panel title="Groundwater reserve monitoring map" note={error ? 'Monitoring observations unavailable' : 'Loading monitoring observations'} className="rf-map-panel"><DistrictMap districts={features} values={{}} valueKey={mapKey} valueLabel={metric(mapKey).label} valueUnit={metric(mapKey).unit} colorFn={scale.color} selected={applied?.region} onSelect={selectRegion} legend={scale.legend} /></Panel>}
    {result && <>
      <div className="rf-context"><span><MapPin size={13} /><strong>{result.region === 'National' ? 'South Africa · district average' : result.region}</strong> · {result.start} – {result.end}</span><span>Source coverage {result.source_coverage.first_date} to {result.source_coverage.last_date}</span></div>
      <div className="rf-kpis">{kpis.map(([key, label, Icon, theme]) => <div className={`rf-kpi ${theme}`} key={key}><Icon size={25} /><div><span>{label}</span><strong>{fmt(latest[key], key.includes('percent') ? 1 : key.includes('m3') ? 1 : 2)}<small>{key === 'total_abstraction_m3_yr' ? 'm³/year' : metric(key).unit}</small></strong><p>{result.end} · {metric(key).category}</p></div></div>)}</div>
      <div className="rf-primary-grid"><Panel title="Reserve balance across South Africa" note={`${mapYear || result.end} · district values`} className="rf-map-panel"><div className="rf-map-controls"><select aria-label="Groundwater reserve map indicator" value={mapKey} onChange={event => { setMapKey(event.target.value); setTrendKey(event.target.value) }}>{scopedMetrics.map(item => <option key={item.key} value={item.key}>{item.label} ({item.unit})</option>)}</select><label>Map year<select aria-label="Groundwater reserve map year" value={mapYear || result.end} onChange={event => setMapYear(event.target.value)}>{result.series.map(row => <option key={row.year}>{row.year}</option>)}</select></label></div>{snapshotError && <div className="rf-error" role="alert">{snapshotError}<button onClick={() => setSnapshotRetry(value => value + 1)}>Retry map</button></div>}{snapshotLoading && <LoadingProgress message="Loading selected map year" />}<DistrictMap districts={features} values={mapValues} valueKey={mapKey} valueLabel={metric(mapKey).label} valueUnit={metric(mapKey).unit} colorFn={scale.color} selected={result.region === 'National' ? null : result.region} onSelect={selectRegion} legend={scale.legend} /><div className="rf-map-footer"><MapPin size={12} /> Select a district to explore its reserve <span>52 districts · annual end-year values</span></div></Panel><Panel title={`${metric(trendKey).label} over time`} note={metric(trendKey).unit}><div className="gr-chart-select"><label>Indicator<select aria-label="Groundwater reserve trend indicator" value={trendKey} onChange={event => { setTrendKey(event.target.value); setMapKey(event.target.value) }}>{scopedMetrics.map(item => <option key={item.key} value={item.key}>{item.label} ({item.unit})</option>)}</select></label></div><Chart data={trend} metrics={[line(trendKey, '#2f8092')]} height={300} /></Panel></div>
      <div className="rf-three-grid reserve-topic-panels"><Panel title="Recharge and discharge" note="Annual means · supplied units"><Chart data={trend} metrics={[line('direct_recharge_mm_yr', '#4b9b9f'), line('rainfall_infiltration_mm_yr', '#7aaf7c')]} height={235} /><p className="rf-footnote">Direct recharge and rainfall infiltration remain in the supplied mm/year units. Indirect recharge is reported separately in m³/year.</p></Panel><Panel title="Aquifer hydrogeology" note="Selected period mean"><div className="gr-fact-grid">{['aquifer_extent_km2', 'saturated_thickness_m', 'depth_to_bedrock_m_bgl', 'storage_coefficient', 'permeability_m_day', 'transmissivity_m2_day', 'porosity_percent', 'specific_yield'].map(key => <span key={key}>{metric(key).label}<strong>{fmt(latest[key], key.includes('coefficient') || key === 'specific_yield' ? 4 : 1)} <small>{metric(key).unit}</small></strong></span>)}</div></Panel><Panel title="Sustainability indicators" note="Section 11.3 · supplied values"><Chart data={trend} metrics={[line('exploitation_index_percent', '#b66e61'), line('recharge_sensitivity_percent', '#8a78a9')]} height={235} /><p className="rf-footnote">The exploitation index and recharge sensitivity are source indicators; thresholds are not imposed without a documented DWS classification.</p></Panel></div>
      <div className="rf-daily-grid"><Panel title="Monthly reserve detail" note={`${result.end} · ${result.region}`}><div className="gr-monthly-status">{monthlyError ? <span role="alert">{monthlyError}</span> : monthly ? <><strong>{monthly.series.length}</strong><span>monthly observations in the selected end year</span></> : <span>Loading monthly detail…</span>}</div>{monthly && <Chart data={monthly.series} x="period" metrics={[line('reserve_balance_million_m3_yr', '#2f8092')]} height={235} />}</Panel><Panel title="Indicator register" note="Units and source meaning"><div className="gw-register-scroll"><table><thead><tr><th>Indicator</th><th>Latest</th><th>Unit</th><th>Category</th></tr></thead><tbody>{scopedMetrics.map(item => <tr key={item.key}><td>{item.label}</td><td>{latest[item.key] == null ? 'Unavailable' : fmt(latest[item.key], 3)}</td><td>{item.unit}</td><td>{item.category}</td></tr>)}</tbody></table></div></Panel></div>
      <details className="rf-methods"><summary>Source tables, reserve equation and calculation notes</summary><p><strong>Section 11.1:</strong> {meta.files[0]} ({(meta.rows.hydrogeology?.toLocaleString() ?? 'Not counted')} rows) supplies hydrogeological geometry, aquifer properties and reserve volumes. <strong>Section 11.2:</strong> {meta.files[1]} ({(meta.rows.recharge?.toLocaleString() ?? 'Not counted')} rows) supplies recharge and discharge indicators. <strong>Section 11.3:</strong> {meta.files[2]} ({(meta.rows.sustainability?.toLocaleString() ?? 'Not counted')} rows) supplies abstraction, depletion, yield, quality and sensitivity indicators.</p><p>Reserve balance is calculated as dynamic reserve − abstraction + ΔStorage. ΔStorage is derived from month-to-month water-table depth, aquifer area and the supplied groundwater storage coefficient. Static reserve is permanent storage and is reported separately. The ecological reserve is required for a complete assessment but is not supplied as a source field.</p></details>
      <div className="rf-footer"><strong><ShieldCheck size={15} /> NIWIS <span>Groundwater reserve intelligence</span></strong><span>52 districts · Sections 11.1–11.3 · Source through {result.source_coverage.last_date}</span></div>
    </>}
  </div>
}
