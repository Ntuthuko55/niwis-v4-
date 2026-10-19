import { dashboardFetch as fetch } from '../services/dashboardFetch'
import { useEffect, useMemo, useState } from 'react'
import { Activity, Download, Droplets, Gauge, Info, Layers, MapPin, RefreshCw, Sprout, Waves } from 'lucide-react'
import { Chart, Panel } from './RainfallStatus'
import { DistrictMap, normaliseDistrictName } from './DistrictMap'
import LoadingProgress from './LoadingProgress'
import '../niwis/groundwater-level-monitoring.css'

const fmt = (value, digits = 2) => value == null || !Number.isFinite(Number(value)) ? '—' : Number(value).toLocaleString('en-ZA', { minimumFractionDigits: digits, maximumFractionDigits: digits })
const monthName = value => new Date(`${value}-15T12:00:00`).toLocaleDateString('en-ZA', { month: 'short', year: 'numeric' })
const icons = { level: Gauge, recharge: Droplets, abstraction: Waves, aquifer: Layers, 'recharge support': Sprout }
const colors = ['#2d7da5', '#59a6ae', '#79a98e', '#ba9b68', '#9b87bd']

async function getJSON(url, signal) {
  const response = await fetch(url, { signal })
  const data = await response.json()
  if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : 'Groundwater source could not be loaded.')
  return data
}

function downloadCSV(name, headers, rows) {
  const esc = value => `"${String(value ?? '').replaceAll('"', '""')}"`
  const blob = new Blob(['\uFEFF' + [headers, ...rows].map(row => row.map(esc).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' })
  const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 800)
}

export default function GroundwaterLevelMonitoring() {
  const [meta, setMeta] = useState(null), [result, setResult] = useState(null), [features, setFeatures] = useState([])
  const [draft, setDraft] = useState({ region: 'National', start: '', end: '' }), [applied, setApplied] = useState(null)
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [retry, setRetry] = useState(0), [mapMonth, setMapMonth] = useState(''), [mapResult, setMapResult] = useState(null)
  const [levelKey, setLevelKey] = useState('groundwater_table_depth_m_bgl'), [rechargeKey, setRechargeKey] = useState('annual_recharge_rate_mm_yr'), [mapKey, setMapKey] = useState('sgi_dimensionless')
  const [dailyMonth, setDailyMonth] = useState(''), [daily, setDaily] = useState(null), [dailyError, setDailyError] = useState('')
  const [dailyRetry, setDailyRetry] = useState(0), [mapRetry, setMapRetry] = useState(0)
  const [mapLoading, setMapLoading] = useState(false), [mapError, setMapError] = useState('')
  const [monthResult, setMonthResult] = useState(null), [monthLoading, setMonthLoading] = useState(false), [monthError, setMonthError] = useState('')
  const [boundariesLoading, setBoundariesLoading] = useState(true), [boundaryError, setBoundaryError] = useState(''), [boundaryRetry, setBoundaryRetry] = useState(0)
  const effectiveMapMonth = mapMonth && applied && mapMonth >= applied.start && mapMonth <= applied.end ? mapMonth : ''
  const effectiveDailyMonth = dailyMonth || applied?.end || ''

  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError('')
    getJSON('/api/groundwater/metadata', controller.signal).then(data => {
      setMeta(data); const initial = { region: 'National', start: data.default_start, end: data.default_end }; setDraft(initial); setApplied(initial)
    }).catch(err => { if (err.name !== 'AbortError') { setError(err.message); setLoading(false) } })
    return () => controller.abort()
  }, [retry])

  useEffect(() => {
    const controller = new AbortController(); setBoundariesLoading(true); setBoundaryError('')
    getJSON('/south_africa_adm2.display.geojson', controller.signal).then(data => {
      if (!data.features?.length) throw new Error('District boundaries are unavailable. Use the region selector above.')
      setFeatures(data.features)
    }).catch(err => { if (err.name !== 'AbortError') { setFeatures([]); setBoundaryError('District boundaries are unavailable. Use the region selector above.') } }).finally(() => { if (!controller.signal.aborted) setBoundariesLoading(false) })
    return () => controller.abort()
  }, [boundaryRetry])

  useEffect(() => {
    if (!applied) return
    const controller = new AbortController(); setLoading(true); setError(''); setResult(current => current?.region === applied.region && String(current.start) === String(applied.start) && String(current.end) === String(applied.end) ? current : null)
    getJSON(`/api/groundwater/dashboard?${new URLSearchParams({ ...applied, include_map: false })}`, controller.signal).then(setResult).catch(err => { if (err.name !== 'AbortError') (setResult(null), setError(err.message)) }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [applied])

  useEffect(() => {
    if (!result || !effectiveDailyMonth) return
    const controller = new AbortController(); setDaily(null); setDailyError('')
    getJSON(`/api/groundwater/daily?${new URLSearchParams({ region: result.region, month: effectiveDailyMonth })}`, controller.signal).then(setDaily).catch(err => { if (err.name !== 'AbortError') setDailyError(err.message) })
    return () => controller.abort()
  }, [result?.region, effectiveDailyMonth, dailyRetry])
  useEffect(() => {
    if (!applied) return undefined
    const controller = new AbortController()
    setMapLoading(true); setMapError(''); setMapResult(null)
    getJSON(`/api/groundwater/map?${new URLSearchParams({ start: applied.start, end: applied.end })}`, controller.signal).then(setMapResult).catch(err => { if (err.name !== 'AbortError') setMapError(err.message) }).finally(() => { if (!controller.signal.aborted) setMapLoading(false) })
    return () => controller.abort()
  }, [applied?.start, applied?.end, mapRetry])
  useEffect(() => {
    if (!effectiveMapMonth) return undefined
    const controller = new AbortController()
    setMonthLoading(true); setMonthError(''); setMonthResult(null)
    getJSON(`/api/groundwater/map?${new URLSearchParams({ start: effectiveMapMonth, end: effectiveMapMonth })}`, controller.signal).then(setMonthResult).catch(err => { if (err.name !== 'AbortError') setMonthError(err.message) }).finally(() => { if (!controller.signal.aborted) setMonthLoading(false) })
    return () => controller.abort()
  }, [effectiveMapMonth, mapRetry])

  const catalogue = useMemo(() => Object.fromEntries((meta?.metrics || []).map(metric => [metric.key, metric])), [meta])
  const metric = key => catalogue[key] || { key, label: key.replaceAll('_', ' '), unit: '' }
  const trendMetrics = useMemo(() => [levelKey, rechargeKey].filter(Boolean).map((key, i) => ({ key, label: metric(key).label, unit: metric(key).unit, color: colors[i] })), [levelKey, rechargeKey, catalogue])
  const mapSource = effectiveMapMonth ? monthResult : mapResult
  const activeMapLoading = effectiveMapMonth ? monthLoading : mapLoading
  const activeMapError = effectiveMapMonth ? monthError : mapError
  const dailyData = daily?.region === result?.region && daily?.month === effectiveDailyMonth ? daily : null
  const mapValues = useMemo(() => Object.fromEntries((mapSource?.map || []).map(row => [normaliseDistrictName(row.district_name), row])), [mapSource])
  const scale = useMemo(() => {
    const numbers = (mapSource?.map || []).filter(row => row[mapKey] != null).map(row => Number(row[mapKey])).filter(Number.isFinite); const low = mapKey === 'sgi_dimensionless' ? -3 : Math.min(0, ...numbers); const high = mapKey === 'sgi_dimensionless' ? 3 : Math.max(1, ...numbers); const range = high - low || 1
    const color = value => colors[Math.max(0, Math.min(colors.length - 1, Math.floor(((Number(value) - low) / range) * colors.length)))]
    return { color, legend: { title: metric(mapKey).label, gradient: `linear-gradient(180deg, ${[...colors].reverse().join(',')})`, items: [[fmt(high, 1), 'Higher'], [fmt((high + low) / 2, 1), 'Typical'], [fmt(low, 1), 'Lower']] } }
  }, [mapSource, mapKey, catalogue])
  const selectRegion = name => { const canonical = meta?.regions.find(region => normaliseDistrictName(region) === normaliseDistrictName(name)); if (canonical) { const next = { ...applied, region: canonical }; setDraft(next); setApplied(next) } }
  const exportMonthly = () => { if (!result) return; const keys = ['month', ...result.variables]; downloadCSV(`NIWIS-groundwater-${result.region.replaceAll(' ', '-')}-${result.start}-${result.end}.csv`, ['Region', ...keys.map(key => key === 'month' ? 'Month' : `${metric(key).label} (${metric(key).unit})`)], result.series.map(row => [result.region, ...keys.map(key => row[key])])) }
  const exportDaily = () => { if (!dailyData) return; const keys = Object.keys(dailyData.series[0] || {}); downloadCSV(`NIWIS-groundwater-daily-${dailyData.region.replaceAll(' ', '-')}-${dailyData.month}.csv`, ['Region', ...keys], dailyData.series.map(row => [dailyData.region, ...keys.map(key => row[key])])) }
  const latest = result?.latest || {}
  const mapObservation = mapSource?.map_periods?.[mapKey]
  const mapNote = activeMapLoading || !mapSource ? 'Loading map observations' : mapObservation ? `${monthName(mapObservation)} · latest available · select a district` : `No observation in selected ${effectiveMapMonth ? 'month' : 'period'}`
  const kpis = [levelKey, 'hydraulic_head_amsl_m', 'sgi_dimensionless', 'annual_recharge_rate_mm_yr', 'recharge_fraction_percent', 'annual_abstraction_volume_m3_yr']
  const mapPanel = meta && applied && <Panel title="Groundwater district overview" note={mapNote} className="rf-map-panel"><div className="rf-map-controls"><select aria-label="Groundwater map indicator" value={mapKey} onChange={event => setMapKey(event.target.value)}>{['sgi_dimensionless', 'groundwater_table_depth_m_bgl', 'hydraulic_head_amsl_m', 'water_table_rise_wtf_m'].filter(key => catalogue[key]).map(key => <option key={key} value={key}>{metric(key).label} ({metric(key).unit})</option>)}</select><label>Map period<select aria-label="Groundwater map month" value={effectiveMapMonth} onChange={event => setMapMonth(event.target.value)}><option value="">Selected period</option>{meta.months.filter(month => month >= applied.start && month <= applied.end).map(month => <option key={month}>{month}</option>)}</select></label></div>{boundaryError || activeMapError ? <div className="rf-error" role="alert">{boundaryError || activeMapError}<button onClick={() => boundaryError ? setBoundaryRetry(value => value + 1) : setMapRetry(value => value + 1)}>Retry map</button></div> : activeMapLoading || !mapSource || boundariesLoading ? <LoadingProgress message="Loading national groundwater map" /> : <DistrictMap districts={features} values={mapValues} valueKey={mapKey} colorFn={scale.color} selected={applied.region === 'National' ? null : applied.region} onSelect={selectRegion} legend={scale.legend} />}</Panel>

  return <div className="rainfall-dashboard groundwater-dashboard">
    <div className="rf-heading"><span className="rf-heading-icon groundwater-icon"><Gauge size={31} /></span><div><span className="rf-eyebrow">NIWIS / DWS NATIONAL GROUNDWATER ARCHIVE</span><h1>Groundwater Level Monitoring Network</h1><p>Borehole levels, recharge, abstraction and aquifer indicators across South Africa</p></div><button className="rf-export" onClick={exportMonthly} disabled={!result || loading}><Download size={15} /> Export monthly data</button></div>
    <form className="rf-filters" onSubmit={event => { event.preventDefault(); if (draft.end !== applied?.end) setDailyMonth(''); setApplied({ ...draft }) }}><label className="rf-region">Region / District<select aria-label="Groundwater region" disabled={!meta} value={draft.region} onChange={event => setDraft({ ...draft, region: event.target.value })}><option value="National">South Africa (district average)</option>{meta?.regions.map(region => <option key={region}>{region}</option>)}</select></label><label>From month<input aria-label="Groundwater start month" type="month" min={meta?.months[0]} max={meta?.months.at(-1)} required value={draft.start} onChange={event => setDraft({ ...draft, start: event.target.value })} /></label><label>To month<input aria-label="Groundwater end month" type="month" min={meta?.months[0]} max={meta?.months.at(-1)} required value={draft.end} onChange={event => setDraft({ ...draft, end: event.target.value })} /></label><button className="rf-apply" disabled={loading || draft.start > draft.end}>Apply filters</button></form>
    {loading && <LoadingProgress className="rf-loading" message="Combining groundwater levels, aquifer parameters and recharge support data" />}
    {error && <div className="rf-error" role="alert">{error}<button onClick={() => meta ? setApplied({ ...applied }) : setRetry(retry + 1)}>Retry</button></div>}
    {!result && mapPanel}
    {result && <>
      <div className="rf-context"><span><MapPin size={13} /><strong>{result.region === 'National' ? 'South Africa · district average' : result.region}</strong> · {monthName(result.start)} – {monthName(result.end)}</span><span>Source coverage {result.source_coverage.first_date} to {result.source_coverage.last_date}</span></div>
      <div className="gw-source-strip"><span><Gauge size={15} /><strong>{result.source_coverage.districts} districts</strong> section 10.1</span><span><Sprout size={15} /><strong>Recharge support</strong> section 10.2</span><span><Info size={15} /><strong>Supplied values</strong> no interpolation</span><small>District averages preserve source units and cadence.</small></div>
      {result.warnings.map(warning => <div className="gw-warning" key={warning}><Info size={15} /><span>{warning}</span></div>)}
      <div className="rf-kpis">{kpis.map((key, index) => { const item = metric(key); const Icon = icons[item.category?.toLowerCase()] || Activity; return <div className={`rf-kpi ${index % 3 === 1 ? 'aqua' : index % 3 === 2 ? 'mint' : 'blue'}`} key={key}><Icon size={25} /><div><span>{item.label}</span><strong>{fmt(latest[key], key.includes('sgi') ? 2 : 1)}<small>{item.unit}</small></strong><p>{monthName(result.end)} · {item.category}</p></div></div> })}</div>
      <div className="rf-primary-grid">{mapPanel}<Panel title="Level and recharge trend" note="Monthly mean of supplied observations"><div className="gw-chart-selects"><label>Level / condition<select aria-label="Groundwater level indicator" value={levelKey} onChange={event => setLevelKey(event.target.value)}>{(meta.metrics || []).filter(item => item.category === 'Level').map(item => <option key={item.key} value={item.key}>{item.label}</option>)}</select></label><label>Recharge indicator<select aria-label="Groundwater recharge indicator" value={rechargeKey} onChange={event => setRechargeKey(event.target.value)}>{(meta.metrics || []).filter(item => item.category === 'Recharge' || item.category === 'Recharge support').map(item => <option key={item.key} value={item.key}>{item.label}</option>)}</select></label></div><Chart data={result.series} metrics={trendMetrics} height={300} /></Panel></div>
      <div className="rf-three-grid"><Panel title="Recharge supporting variables" note="Section 10.2 · monthly"><Chart data={result.series} metrics={['monthly_catchment_rainfall_mm', 'actual_evapotranspiration_mm', 'water_table_rise_wtf_m'].filter(key => catalogue[key]).map((key, i) => ({ key, label: metric(key).label, unit: metric(key).unit, color: colors[i] }))} height={210} /><p className="rf-footnote">Rainfall, soil moisture, actual ET, baseflow, land use and WTF recharge are supporting indicators; they are not treated as direct recharge measurements.</p></Panel><Panel title="Aquifer parameters" note="Source aquifer tests"><div className="gw-aquifer-grid">{['saturated_thickness_m', 'transmissivity_m2_day', 'hydraulic_conductivity_m_day', 'storativity_specific_yield_dimensionless'].map(key => <span key={key}>{metric(key).label}<strong>{fmt(latest[key], key.includes('storativity') ? 4 : 1)} <small>{metric(key).unit}</small></strong></span>)}</div><p className="rf-footnote">Aquifer parameters are reported at district/year granularity in the long file and are not inferred from level changes.</p></Panel><Panel title="Coverage & quality" note="Checks on supplied files"><div className="gw-quality"><strong>{result.source_coverage.districts}</strong><span>districts represented</span><strong>{result.quality.missing_values.toLocaleString()}</strong><span>missing numeric cells</span><strong>{result.quality.future_rows_after_2026_10_13.toLocaleString()}</strong><span>rows dated after 13 Oct 2026</span></div><p className="rf-footnote">Dates beyond the current dashboard date are retained because they are present in the supplied 2000–2026 files.</p></Panel></div>
      <div className="rf-daily-grid"><Panel title="Daily / irregular level observations" note="Select a month to inspect source dates"><div className="gw-daily-controls"><label>Month<select aria-label="Groundwater daily month" value={effectiveDailyMonth} onChange={event => setDailyMonth(event.target.value)}>{meta.months.map(month => <option key={month}>{month}</option>)}</select></label><button className="sw-daily-export" onClick={exportDaily} disabled={!dailyData}><Download size={13} /> Daily CSV</button></div>{dailyError && <div className="rf-error" role="alert">{dailyError}<button onClick={() => setDailyRetry(value => value + 1)}>Retry daily detail</button></div>}{!dailyError && !dailyData && <LoadingProgress message="Loading daily groundwater observations" />}{dailyData && <Chart data={dailyData.series} metrics={[levelKey, 'hydraulic_head_amsl_m'].filter(key => dailyData.series.some(row => row[key] != null)).map((key, i) => ({ key, label: metric(key).label, unit: metric(key).unit, color: colors[i] }))} x="date" height={235} />}</Panel><Panel title="Indicator register" note="Units and source meaning"><div className="gw-register-scroll"><table><thead><tr><th>Indicator</th><th>Latest</th><th>Unit</th><th>Category</th></tr></thead><tbody>{meta.metrics.map(item => <tr key={item.key}><td>{item.label}</td><td>{latest[item.key] == null ? 'Unavailable' : fmt(latest[item.key], 3)}</td><td>{item.unit}</td><td>{item.category}</td></tr>)}</tbody></table></div></Panel></div>
      <details className="rf-methods"><summary>Source files and calculation notes</summary><p><strong>Section 10.1:</strong> {meta.files[0]} ({(meta.rows[0]?.toLocaleString() ?? 'Not counted')} rows) supplies long-form borehole and aquifer variables. <strong>Section 10.2:</strong> {meta.files[1]} ({(meta.rows[1]?.toLocaleString() ?? 'Not counted')} rows) supplies monthly recharge-support variables.</p><p>Monthly series are district means of available values. Repeated seasonal entries are averaged; no missing values are filled. National values are equal-weight district averages, and exported values retain the supplied units.</p>{result.warnings.map(warning => <p key={warning}>{warning}</p>)}</details>
    </>}
  </div>
}
