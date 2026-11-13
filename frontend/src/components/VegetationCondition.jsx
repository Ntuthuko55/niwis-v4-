import { dashboardFetch as fetch } from '../services/dashboardFetch'
import { useEffect, useMemo, useState } from 'react'
import { Leaf, Sprout, HeartPulse, Droplets, Thermometer, CloudRain, Download, RefreshCw, MapPin, Info, ArrowUpRight } from 'lucide-react'
import { ResponsiveContainer, ComposedChart, Area, Line, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ReferenceLine, Cell } from 'recharts'
import { DistrictMap, normaliseDistrictName, buildStandardizedIndexScale } from './DistrictMap'
import LoadingProgress from './LoadingProgress'
import { chartColor } from '../lib/chartTheme'
import '../niwis/climate-dashboard.css'
import '../niwis/vegetation-condition.css'

const NDVI = 'NDVI_10day_composite'
const format = (value, digits = 2) => value == null || !Number.isFinite(value) ? '—' : value.toLocaleString('en-ZA', { minimumFractionDigits: digits, maximumFractionDigits: digits })
const monthLabel = month => new Date(`${month}-15T12:00:00`).toLocaleDateString('en-ZA', { month: 'short', year: '2-digit' })
const signed = value => value == null ? 'Unavailable' : `${value > 0 ? '+' : ''}${format(value)}`
const GROUPS = ['Greenness', 'Condition', 'Water content', 'Thermal', 'Moisture', 'Weather']
const kpis = [[NDVI, 'Mean NDVI', Leaf, 'green'], ['VHI_percent', 'Vegetation health', HeartPulse, 'green'], ['VCI_percent', 'Vegetation condition', Sprout, 'mint'], ['ASI_percent', 'Agricultural stress', Leaf, 'amber'], ['NDWI', 'Canopy water index', Droplets, 'blue'], ['LST_Land_Surface_Temperature_C', 'Surface temperature', Thermometer, 'rose']]
const METRIC_PRESENTATION = {
  NDVI_10day_composite: { description: 'Normalized Difference Vegetation Index', format: '\u22121 to +1, 10-day composite', source: 'SANSA / MODIS / Sentinel-2' },
  EVI: { description: 'Enhanced Vegetation Index', format: '\u22121 to +1', source: 'SANSA / MODIS' },
  SAVI: { description: 'Soil-Adjusted Vegetation Index', format: '\u22121 to +1', source: 'SANSA / Landsat' },
  MSAVI2: { description: 'Modified SAVI', format: '\u22121 to +1', source: 'SANSA / Landsat' },
  VCI_percent: { description: 'Vegetation Condition Index', format: '0\u2013100%', source: 'SANSA / derived' },
  VHI_percent: { description: 'Vegetation Health Index', format: '0\u2013100%', source: 'SANSA / derived' },
  TCI_percent: { description: 'Temperature Condition Index', format: '0\u2013100%', source: 'SANSA / derived' },
  VPI_percent: { description: 'Vegetation Productivity Index', format: '0\u2013100%', source: 'SANSA / derived' },
  ASI_percent: { description: 'Agricultural Stress Index', format: '0\u2013100%', source: 'FAO / SANSA' },
  SVI_standardised: { description: 'Standard Vegetation Index', format: 'Standardised', source: 'SANSA / derived' },
  NDWI: { description: 'Normalized Difference Water Index', format: '\u22121 to +1', source: 'SANSA' },
  NDII: { description: 'Normalized Difference Infrared Index', format: '\u22121 to +1', source: 'SANSA' },
  LST_Land_Surface_Temperature_C: { description: 'Land Surface Temperature', format: '\u00b0C', source: 'SANSA / MODIS', unit: '\u00b0C' },
  Surface_Soil_Moisture_m3m3: { description: 'Surface soil moisture', format: 'm\u00b3/m\u00b3', source: 'SANSA / Sentinel-1', unit: 'm\u00b3/m\u00b3' },
  Monthly_Rainfall_mm: { description: 'Total monthly precipitation', format: 'Monthly total, mm', source: 'SAWS', unit: 'mm/month' },
  Rainfall_Anomaly_percent: { description: 'Deviation from long-term monthly mean', format: '% from long-term monthly mean', source: 'SAWS / derived' },
  SPI_1_month: { format: 'Standardised index, 1 month', source: 'SAWS / derived' },
  SPI_3_month: { format: 'Standardised index, 3 months', source: 'SAWS / derived' },
  SPI_6_month: { format: 'Standardised index, 6 months', source: 'SAWS / derived' },
  SPEI_1_month: { format: 'Standardised index, 1 month', source: 'SAWS / derived' },
  SPEI_3_month: { format: 'Standardised index, 3 months', source: 'SAWS / derived' },
  SPEI_6_month: { format: 'Standardised index, 6 months', source: 'SAWS / derived' },
  Mean_Temperature_C: { format: 'Monthly mean, \u00b0C', source: 'SAWS', unit: '\u00b0C' },
  Potential_Evapotranspiration_ET0_mm: { format: 'ET\u2080 monthly, mm', source: 'SAWS / derived', label: 'ET\u2080', description: 'Potential evapotranspiration', unit: 'mm/month' },
  Growing_Degree_Days_GDD_C: { description: 'Heat units accumulated above base temperature', format: 'Heat units above base temperature, \u00b0C\u00b7days', source: 'SAWS / derived', unit: '\u00b0C\u00b7days' },
}

async function fetchJSON(url, signal) {
  const response = await fetch(url, { signal })
  const json = await response.json()
  if (!response.ok) throw new Error(typeof json.detail === 'string' ? json.detail : 'Vegetation data could not be loaded.')
  return json
}

function Plot({ data, lines, height = 190, bars = false, band = false, spark = false, unit = '' }) {
  lines = lines.map(line => ({ ...line, color: chartColor(line.color) }))
  if (!data?.length) return <div className="vg-empty">No observations for this selection.</div>
  return <div className="vg-plot" role={spark ? undefined : 'img'} aria-label={spark ? undefined : `${lines.map(line => line.label).join(', ')} chart`} style={{ height }}><ResponsiveContainer width="100%" height="100%"><ComposedChart data={data} margin={spark ? { top: 3, right: 1, left: 1, bottom: 3 } : { top: 12, right: 10, left: -13, bottom: 0 }}>
    {!spark && <CartesianGrid stroke="#e8f0ef" vertical={false} />}
    {!spark && <XAxis dataKey="month" tickFormatter={monthLabel} tick={{ fontSize: 9, fill: '#7e929b' }} axisLine={{ stroke: '#dbe7e7' }} tickLine={false} minTickGap={30} />}
    <YAxis hide={spark} domain={['auto', 'auto']} tick={{ fontSize: 9, fill: '#7e929b' }} tickFormatter={v => format(v, Math.abs(v) < 10 ? 1 : 0)} axisLine={false} tickLine={false} width={50} />
    {!spark && <Tooltip labelFormatter={monthLabel} formatter={(v, label) => [Array.isArray(v) ? `${format(v[0])}–${format(v[1])}` : `${format(v)} ${unit}`, label]} contentStyle={{ border: '1px solid #dce8e5', borderRadius: 8, fontSize: 11, color: '#294e48' }} />}
    {!spark && <Legend wrapperStyle={{ fontSize: 9, paddingTop: 5 }} iconType="plainline" iconSize={12} />}
    {band && <Area dataKey="baseline_band" name="Prior 5 years: min–max" stroke="none" fill="#ccecdc" fillOpacity={.7} isAnimationActive={false} connectNulls={false} />}
    {bars && <ReferenceLine y={0} stroke="#b3cac3" />}
    {lines.map(line => bars ? <Bar key={line.key} dataKey={line.key} name={line.label} fill={line.color} maxBarSize={20} radius={[2, 2, 0, 0]} isAnimationActive={false}>{data.map((row, i) => <Cell key={i} fill={row[line.key] < 0 ? chartColor('#eb7978') : line.color} />)}</Bar> : <Line key={line.key} dataKey={line.key} name={line.label} stroke={line.color} strokeWidth={spark ? 1.4 : 2} strokeDasharray={line.dash} dot={!spark && data.length < 40 ? { r: 2, strokeWidth: 0 } : false} connectNulls={false} isAnimationActive={false} />)}
  </ComposedChart></ResponsiveContainer></div>
}

function Panel({ title, note, children, className = '' }) {
  return <section className={`vg-panel ${className}`}><div className="vg-panel-head"><h2>{title}</h2>{note && <span>{note}</span>}</div>{children}</section>
}

function metricScale(key) {
  if (['VCI_percent', 'VHI_percent', 'TCI_percent', 'VPI_percent', 'ASI_percent'].includes(key)) {
    const colors = key === 'ASI_percent' ? ['#16844e', '#64b87b', '#d2d963', '#efa953', '#e16855'] : ['#e16855', '#efa953', '#d2d963', '#64b87b', '#16844e']
    return { min: 0, max: 100, colors, unit: '%' }
  }
  if (key === 'LST_Land_Surface_Temperature_C') return { min: 0, max: 40, colors: ['#569cd6', '#87c7ce', '#ebd97c', '#edab62', '#da6c54'], unit: '°C' }
  if (key === 'Surface_Soil_Moisture_m3m3') return { min: 0, max: .5, colors: ['#e4c779', '#b9cf8a', '#72c3a4', '#3d9eb0', '#256d9d'], unit: 'm³/m³' }
  if (key === 'SVI_standardised') return { min: -3, max: 3, colors: ['#e16855', '#efa953', '#d2d963', '#64b87b', '#16844e'], unit: 'standardised' }
  return { min: -1, max: 1, colors: ['#abafa8', '#d7c387', '#e4cf65', '#8dbd54', '#198c4f'], unit: 'index' }
}

function VegMap({ features, values, metric, selected, onSelect, indicatorOptions, onMetricChange }) {
  const observations = Object.values(values).map(row => row?.[metric.key]).filter(value => typeof value === 'number' && Number.isFinite(value))
  const scale = metricScale(metric.key)
  if (metric.category === 'Weather') {
    const signed = metric.key.startsWith('SPI_') || metric.key.startsWith('SPEI_') || metric.key.includes('Anomaly')
    scale.min = signed ? -Math.max(1, ...observations.map(Math.abs)) : Math.min(0, ...observations)
    scale.max = signed ? -scale.min : Math.max(1, ...observations)
    scale.colors = signed ? ['#b35806', '#e08214', '#f7f7f7', '#80cdc1', '#018571'] : ['#eff3ff', '#bdd7e7', '#6baed6', '#3182bd', '#08519c']
  }
  const standardized = /^(SPI_|SPEI_)/.test(metric.key) ? buildStandardizedIndexScale(metric.label) : null
  const color = standardized?.color || (v => scale.colors[Math.min(4, Math.max(0, Math.floor((v - scale.min) / (scale.max - scale.min) * 5)))])
  const items = Array.from({ length: 5 }, (_, i) => [format(scale.max - (scale.max - scale.min) * i / 4, scale.max > 3 ? 0 : 2), i === 0 ? 'Higher values' : i === 4 ? 'Lower values' : ''])
  return <div className="vg-map"><DistrictMap districts={features} values={values} valueKey={metric.key} valueLabel={metric.label} valueUnit={metric.unit} indicatorOptions={indicatorOptions} indicatorValue={metric.key} onIndicatorChange={onMetricChange} colorFn={color} selected={selected} onSelect={onSelect} mapId="vegetation-main" legend={standardized?.legend || { title: `${metric.label} (${metric.unit})`, gradient: `linear-gradient(180deg, ${[...scale.colors].reverse().join(',')})`, items }} /></div>
}

export default function VegetationCondition({ section = null }) {
  const [meta, setMeta] = useState(null), [result, setResult] = useState(null)
  const [draft, setDraft] = useState({ region: 'National', start: '', end: '', lag: 0 }), [applied, setApplied] = useState(null)
  const [error, setError] = useState(''), [loading, setLoading] = useState(true), [retry, setRetry] = useState(0), [mapMonth, setMapMonth] = useState(''), [mapResult, setMapResult] = useState(null)
  const [features, setFeatures] = useState([]), [mapError, setMapError] = useState('')
  const [periodMapLoading, setPeriodMapLoading] = useState(false), [periodMapError, setPeriodMapError] = useState('')
  const [monthResult, setMonthResult] = useState(null), [monthLoading, setMonthLoading] = useState(false), [monthError, setMonthError] = useState(''), [mapRetry, setMapRetry] = useState(0)
  const [metricKey, setMetricKey] = useState(NDVI), [compare, setCompare] = useState(true)
  const [waterKey, setWaterKey] = useState('NDWI'), [weatherKey, setWeatherKey] = useState('Monthly_Rainfall_mm')
  const [rankOrder, setRankOrder] = useState('highest'), [register, setRegister] = useState('Greenness')
  const [weatherMapResult, setWeatherMapResult] = useState(null), [weatherMapLoading, setWeatherMapLoading] = useState(false), [weatherMapError, setWeatherMapError] = useState('')
  const scopedMetrics = (meta?.metrics || []).filter(item => section === 'satellite' ? item.category !== 'Weather' : section === 'meteorological' ? item.category === 'Weather' : section === 'derived' ? item.category === 'Condition' : true)
  const activeMetricKey = scopedMetrics.some(item => item.key === metricKey) ? metricKey : scopedMetrics[0]?.key || metricKey
  const weatherMapIndicator = meta?.metrics.find(item => item.key === activeMetricKey)?.category === 'Weather' ? activeMetricKey : ''
  useEffect(() => {
    const sections = {
      satellite: { metric: NDVI, register: 'All satellite' },
      meteorological: { metric: 'Monthly_Rainfall_mm', register: 'Weather' },
      derived: { metric: 'VCI_percent', register: 'Condition' },
    }
    const selection = sections[section]
    if (!selection) { setMetricKey(NDVI); setRegister('Greenness'); return }
    setMetricKey(selection.metric)
    setRegister(selection.register)
  }, [section])
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError('')
    fetchJSON('/api/vegetation/metadata', controller.signal).then(data => { setMeta(data); const initial = { region: 'National', start: data.default_start, end: data.default_end, lag: 0 }; setDraft(initial); setApplied(initial) }).catch(err => { if (err.name !== 'AbortError') { setError(err.message); setLoading(false) } })
    return () => controller.abort()
  }, [retry])
  useEffect(() => {
    const controller = new AbortController()
    fetchJSON('/south_africa_adm2.display.geojson', controller.signal).then(data => setFeatures(data.features || [])).catch(err => { if (err.name !== 'AbortError') setMapError('District boundaries are unavailable. Use the region selector to explore observations.') })
    return () => controller.abort()
  }, [])
  useEffect(() => {
    if (!applied) return
    const controller = new AbortController(); setLoading(true); setError(''); setResult(current => current?.region === applied.region && current.start === applied.start && current.end === applied.end && current.lag === applied.lag ? current : null)
    fetchJSON(`/api/vegetation/dashboard?${new URLSearchParams({ ...applied, include_map: false })}`, controller.signal).then(setResult).catch(err => { if (err.name !== 'AbortError') (setResult(null), setError(err.message)) }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [applied])
  useEffect(() => {
    if (!applied) return undefined
    const controller = new AbortController()
    setPeriodMapLoading(true); setPeriodMapError(''); setMapResult(null)
    fetchJSON(`/api/vegetation/map?${new URLSearchParams({ start: applied.start, end: applied.end })}`, controller.signal).then(setMapResult).catch(err => { if (err.name !== 'AbortError') setPeriodMapError(err.message) }).finally(() => { if (!controller.signal.aborted) setPeriodMapLoading(false) })
    return () => controller.abort()
  }, [applied?.start, applied?.end, mapRetry])
  const effectiveMapMonth = mapMonth && applied && mapMonth >= applied.start && mapMonth <= applied.end ? mapMonth : ''
  useEffect(() => {
    if (!effectiveMapMonth) return undefined
    const controller = new AbortController()
    setMonthLoading(true); setMonthError(''); setMonthResult(null)
    fetchJSON(`/api/vegetation/map?${new URLSearchParams({ start: effectiveMapMonth, end: effectiveMapMonth })}`, controller.signal).then(setMonthResult).catch(err => { if (err.name !== 'AbortError') setMonthError(err.message) }).finally(() => { if (!controller.signal.aborted) setMonthLoading(false) })
    return () => controller.abort()
  }, [effectiveMapMonth, mapRetry])
  useEffect(() => {
    setWeatherMapResult(null); setWeatherMapError(''); setWeatherMapLoading(false)
    if (!applied || !weatherMapIndicator) return undefined
    const controller = new AbortController(); setWeatherMapLoading(true)
    fetchJSON(`/api/vegetation/map?${new URLSearchParams({ start: effectiveMapMonth || applied.start, end: effectiveMapMonth || applied.end, indicator: weatherMapIndicator })}`, controller.signal).then(setWeatherMapResult).catch(err => { if (err.name !== 'AbortError') setWeatherMapError(err.message) }).finally(() => { if (!controller.signal.aborted) setWeatherMapLoading(false) })
    return () => controller.abort()
  }, [applied?.start, applied?.end, effectiveMapMonth, weatherMapIndicator, mapRetry])
  const catalogue = useMemo(() => Object.fromEntries((meta?.metrics || []).map(metric => [metric.key, { ...metric, ...METRIC_PRESENTATION[metric.key] }])), [meta])
  const registerOptions = section === 'satellite' ? ['All satellite', ...GROUPS.filter(group => group !== 'Weather')] : section === 'meteorological' ? ['Weather'] : section === 'derived' ? ['Condition'] : GROUPS
  const registerMetrics = (meta?.metrics || []).filter(item => section === 'satellite' && register === 'All satellite' ? item.category !== 'Weather' : item.category === register)
  const satelliteMapSource = effectiveMapMonth ? monthResult : mapResult
  const satelliteMapLoading = effectiveMapMonth ? monthLoading : periodMapLoading
  const mapSource = weatherMapIndicator ? weatherMapResult : satelliteMapSource
  const mapLoading = weatherMapIndicator ? weatherMapLoading : satelliteMapLoading
  const mapDataError = weatherMapIndicator ? weatherMapError : effectiveMapMonth ? monthError : periodMapError
  const values = useMemo(() => Object.fromEntries((mapSource?.map || []).map(row => [normaliseDistrictName(row.District_Name), row])), [mapSource])
  const series = useMemo(() => (result?.series || []).map(row => ({ ...row, baseline_band: row.ndvi_low == null ? null : [row.ndvi_low, row.ndvi_high] })), [result])
  const selectRegion = name => {
    const canonical = meta?.regions.find(region => normaliseDistrictName(region) === normaliseDistrictName(name))
    if (canonical) { const selection = { ...applied, region: canonical }; setDraft(selection); setApplied(selection) }
  }
  const download = () => {
    const exportMetrics = section ? scopedMetrics : meta.metrics
    const keys = ['month', ...exportMetrics.map(metric => metric.key), 'complete', 'observed_days', 'expected_days', ...(section === 'satellite' ? ['ndvi_baseline', 'baseline_years', 'ndvi_anomaly_percent'] : [])]
    const escape = value => `"${String(value ?? '').replaceAll('"', '""')}"`
    const rows = [['Region', ...keys.map(key => catalogue[key] ? `${catalogue[key].label} (${catalogue[key].unit})` : key)], ...result.series.map(row => [result.region, ...keys.map(key => row[key])])]
    const url = URL.createObjectURL(new Blob(['\uFEFF' + rows.map(row => row.map(escape).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8;' }))
    const suffix = section ? `-${section}` : ''
    const link = document.createElement('a'); link.href = url; link.download = `NIWIS-vegetation${suffix}-${result.region.replaceAll(' ', '-')}-${result.start}-${result.end}.csv`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  const metric = catalogue[activeMetricKey] || { key: activeMetricKey, label: 'Vegetation condition', unit: '', description: 'District observations' }
  const selectedName = result?.region === 'National' ? 'South Africa · district average' : result?.region
  const period = result ? `${monthLabel(result.start)} – ${monthLabel(result.end)}` : ''
  const ranking = mapResult ? (rankOrder === 'highest' ? mapResult.ranking : [...mapResult.ranking].reverse()).slice(0, 5) : []
  const invalidDates = draft.start > draft.end
  const mapPeriod = effectiveMapMonth ? monthLabel(effectiveMapMonth) : applied ? `${monthLabel(applied.start)} – ${monthLabel(applied.end)}` : ''
  const mapStatus = mapError || mapDataError
  const mapPanel = <Panel title={`${section === 'meteorological' ? 'SAWS driver map' : section === 'derived' ? 'Vegetation condition map' : 'Vegetation across South Africa'}`} note={`${effectiveMapMonth ? 'Monthly' : 'Selected-period'} district means`} className="vg-main-map">
    <div className="vg-map-layout"><div className="vg-map-body"><div className="vg-map-title"><strong>{metric.label}</strong><span>{metric.description} · {mapPeriod}</span></div>{mapStatus && <div className="vg-error" role="alert">{mapStatus}{mapDataError && <button onClick={() => setMapRetry(value => value + 1)}>Retry map</button>}</div>}{mapLoading && <LoadingProgress message="Loading national vegetation map" />}<VegMap features={features} values={mapStatus || mapLoading ? {} : values} metric={metric} indicatorOptions={scopedMetrics} onMetricChange={key => { setMetricKey(key); if (catalogue[key]?.category === 'Weather') setWeatherKey(key) }} selected={applied?.region} onSelect={selectRegion} /><p className="vg-map-caption"><MapPin size={12} /> Click a district to update all charts</p></div></div>
  </Panel>
  if (section) return <div className="vegetation-dashboard vegetation-section-dashboard">
    <div className="vg-heading"><div className="vg-heading-mark"><Leaf size={30} /></div><div><span className="vg-eyebrow">NIWIS / EARTH OBSERVATION</span><h1>Vegetation Condition Monitoring</h1><p>{section === 'satellite' ? 'Primary Satellite Vegetation' : section === 'meteorological' ? 'Meteorological Drivers (SAWS)' : 'Vegetation Monitoring Derived Products'}</p></div><button className="vg-download" onClick={download} disabled={!result || loading}><Download size={15} /> Download data</button></div>
    <form className="vg-filters" onSubmit={event => { event.preventDefault(); setApplied({ ...draft }) }}>
      <label className="vg-region"><span><MapPin size={12} /> Region / District</span><select aria-label="Vegetation region" value={draft.region} onChange={event => setDraft({ ...draft, region: event.target.value })} disabled={!meta}><option value="National">South Africa (district average)</option>{meta?.regions.map(region => <option key={region}>{region}</option>)}</select></label>
      <label>From month<input aria-label="Vegetation start month" type="month" required min={meta?.months[0]} max={meta?.months.at(-1)} value={draft.start} onChange={event => setDraft({ ...draft, start: event.target.value })} /></label>
      <label>To month<input aria-label="Vegetation end month" type="month" required min={meta?.months[0]} max={meta?.months.at(-1)} value={draft.end} onChange={event => setDraft({ ...draft, end: event.target.value })} /></label>
      <button className="vg-apply" disabled={!meta || loading || invalidDates}>Apply filters</button>
      {invalidDates && <span role="alert">End month must be on or after start month.</span>}
    </form>
    {error && <div className="vg-error" role="alert">{error}<button onClick={() => meta ? setApplied({ ...applied }) : setRetry(retry + 1)}><RefreshCw size={14} /> Retry</button></div>}
    {loading && <LoadingProgress className="vg-loading" message={`Loading ${section === 'meteorological' ? 'meteorological drivers' : 'satellite vegetation indicators'}`} />}
    {!result && mapPanel}
    {result && <>
      <div className="vg-context"><span><i /><strong>{selectedName}</strong> · {period}</span><span>{scopedMetrics.length} indicators · source observations only</span></div>
      <div className={`vg-section-grid ${section === 'meteorological' ? 'meteorological' : ''}`}>
        {mapPanel}
        <Panel title={section === 'meteorological' ? 'Meteorological driver trend' : section === 'derived' ? 'Vegetation condition trend' : 'Satellite vegetation trend'} note={`${metric.label} · ${METRIC_PRESENTATION[activeMetricKey]?.format || metric.unit}`}>
          <label className="vg-section-indicator">{section === 'meteorological' ? 'SAWS variable' : section === 'derived' ? 'Condition index' : 'Satellite indicator'}<select aria-label={`${section} chart indicator`} value={activeMetricKey} onChange={event => { setMetricKey(event.target.value); if (section === 'meteorological') setWeatherKey(event.target.value) }}>{scopedMetrics.map(item => <option key={item.key} value={item.key}>{catalogue[item.key].label} — {catalogue[item.key].description}</option>)}</select></label>
          <Plot data={series} unit={metric.unit} band={section === 'satellite' && activeMetricKey === NDVI} bars={section === 'meteorological' && activeMetricKey === 'Monthly_Rainfall_mm'} height={330} lines={[{ key: activeMetricKey, label: metric.label, color: section === 'meteorological' ? '#469bbc' : section === 'derived' ? '#7b8e39' : '#17845e' }, ...(section !== 'meteorological' && compare ? [{ key: `${activeMetricKey}_previous`, label: 'Same months previous year', color: '#75b582', dash: '4 3' }] : []), ...(section === 'satellite' && activeMetricKey === NDVI ? [{ key: 'ndvi_baseline', label: 'Prior 5-year mean', color: '#799986', dash: '2 4' }] : [])]} />
          <p className="vg-footnote">{metric.description}. {METRIC_PRESENTATION[activeMetricKey]?.source || (section === 'meteorological' ? 'SAWS / derived' : 'SANSA source field')}.</p>
        </Panel>
      </div>
      <details className="vg-register" open><summary>{section === 'satellite' ? 'Primary satellite vegetation indicators' : section === 'meteorological' ? 'Meteorological drivers (SAWS)' : 'Vegetation monitoring derived condition indicators'} · {scopedMetrics.length} connected fields</summary><div className="vg-table-scroll"><table><thead><tr><th>Category</th><th>Variable / indicator</th><th>Period mean</th><th>Unit / format</th><th>Primary source</th></tr></thead><tbody>{scopedMetrics.map(item => { const sourceMetric = catalogue[item.key]; const presentation = METRIC_PRESENTATION[item.key]; return <tr key={item.key}><td>{item.category}</td><td>{sourceMetric.label} – {sourceMetric.description}</td><td>{format(result.summary[item.key], sourceMetric.unit === 'm³/m³' ? 3 : 2)}</td><td>{presentation?.format || sourceMetric.unit}</td><td>{presentation?.source || (item.category === 'Weather' ? 'SAWS / derived' : 'SANSA / source dataset')}</td></tr> })}</tbody></table></div></details>
      {result.warnings.length > 0 && <details className="vg-methods"><summary>Source notes</summary>{result.warnings.map(warning => <p key={warning}><Info size={13} /> {warning}</p>)}</details>}
    </>}
  </div>
  return <div className="vegetation-dashboard">
    <div className="vg-heading"><div className="vg-heading-mark"><Leaf size={30} /></div><div><span className="vg-eyebrow">NIWIS / EARTH OBSERVATION</span><h1>Vegetation Condition Monitoring</h1><p>Satellite vegetation indices and the climate conditions that accompany them</p>{section && <small className="vg-section-context">{section === 'satellite' ? 'Primary Satellite Vegetation' : section === 'meteorological' ? 'Meteorological Drivers (SAWS)' : 'Vegetation Monitoring Derived Products'}</small>}</div><button className="vg-download" onClick={download} disabled={!result || loading}><Download size={15} /> Download data</button></div>
    <form className="vg-filters" onSubmit={event => { event.preventDefault(); setApplied({ ...draft }) }}>
      <label className="vg-region"><span><MapPin size={12} /> Region / District</span><select aria-label="Vegetation region" value={draft.region} onChange={e => setDraft({ ...draft, region: e.target.value })} disabled={!meta}><option value="National">South Africa (district average)</option>{meta?.regions.map(region => <option key={region}>{region}</option>)}</select></label>
      <label>From month<input aria-label="Vegetation start month" type="month" required min={meta?.months[0]} max={meta?.months.at(-1)} value={draft.start} onChange={e => setDraft({ ...draft, start: e.target.value })} /></label>
      <label>To month<input aria-label="Vegetation end month" type="month" required min={meta?.months[0]} max={meta?.months.at(-1)} value={draft.end} onChange={e => setDraft({ ...draft, end: e.target.value })} /></label>
      <button className="vg-apply" disabled={!meta || loading || invalidDates}>Apply filters</button><label className="vg-compare"><input type="checkbox" checked={compare} onChange={e => setCompare(e.target.checked)} /> Compare with previous year</label>
      {invalidDates && <span role="alert">End month must be on or after start month.</span>}
    </form>
    {error && <div className="vg-error" role="alert">{error}<button onClick={() => meta ? setApplied({ ...applied }) : setRetry(retry + 1)}><RefreshCw size={14} /> Retry</button></div>}
    {loading && <LoadingProgress className="vg-loading" message="Preparing satellite observations and monthly climate drivers" />}
    {!result && mapPanel}
    {result && <>
      <div className="vg-context"><span><i /><strong>{selectedName}</strong> · {period}</span><span>Monthly means · latest daily source {result.latest_daily_date}</span></div>
      <div className="vg-kpis">{kpis.map(([key, label, Icon, theme]) => <div className={`vg-kpi ${theme}`} key={key}><div className="vg-kpi-top"><span className="vg-kpi-icon"><Icon size={23} /></span><div><span>{label}</span><strong>{format(result.summary[key], key === NDVI || key === 'NDWI' ? 2 : 1)}<small>{catalogue[key].unit === 'index' ? '' : catalogue[key].unit}</small></strong></div></div><div className="vg-kpi-change">{compare ? <><b>{signed(result.deltas[key].difference)} {catalogue[key].unit === '%' ? 'pp' : catalogue[key].unit === 'index' ? '' : catalogue[key].unit}</b><span>vs same months last year · {result.deltas[key].paired_months} pairs</span></> : <span>Selected-period mean</span>}</div><Plot data={series} lines={[{ key, label, color: theme === 'amber' ? '#d59a43' : theme === 'rose' ? '#e28a78' : theme === 'blue' ? '#419ec0' : '#30a16b' }]} height={36} spark /></div>)}</div>
      <div className="vg-top-grid">
        {mapPanel}
        <div className="vg-chart-stack"><Panel title="Vegetation index trends" note={period}><div className="vg-tabs" role="group" aria-label="Vegetation trend indicator">{[NDVI, 'VCI_percent', 'VHI_percent', 'SAVI', 'EVI'].map(key => <button key={key} aria-pressed={key === metricKey} onClick={() => setMetricKey(key)}>{catalogue[key].label}</button>)}</div><p className="vg-chart-caption">{metric.description} · {metric.unit}</p><Plot data={series} unit={metric.unit} height={185} band={metricKey === NDVI} lines={[{ key: metricKey, label: `${metric.label} current`, color: '#17845e' }, ...(compare ? [{ key: `${metricKey}_previous`, label: 'Same month previous year', color: '#75b582', dash: '4 3' }] : []), ...(metricKey === NDVI ? [{ key: 'ndvi_baseline', label: 'Prior 5-year mean', color: '#799986', dash: '2 4' }] : [])]} /></Panel><Panel title="NDVI departure from seasonal history" note="Same calendar month · previous 5 years"><Plot data={series} bars unit="%" height={165} lines={[{ key: 'ndvi_anomaly_percent', label: 'NDVI anomaly (%)', color: '#32a67a' }]} /><p className="vg-footnote">At least 3 complete historical months required. Band above is historical min–max, not forecast uncertainty.</p></Panel></div>
        <div className="vg-chart-stack"><Panel title="District vegetation health" note="Ranked by period-mean VHI"><div className="vg-tabs"><button aria-pressed={rankOrder === 'highest'} onClick={() => setRankOrder('highest')}>Highest five</button><button aria-pressed={rankOrder === 'lowest'} onClick={() => setRankOrder('lowest')}>Lowest five</button></div><div className="vg-ranking">{periodMapLoading && <p role="status">Loading district ranking...</p>}{periodMapError && <p role="alert">{periodMapError}</p>}{ranking.map((row, index) => <button key={row.District_Name} onClick={() => selectRegion(row.District_Name)}><span className="vg-rank-number">{index + 1}</span><span className="vg-rank-name">{row.District_Name}<i><b style={{ width: `${Math.max(0, Math.min(100, row.VHI_percent))}%` }} /></i></span><strong>{format(row.VHI_percent, 1)}<small>VHI</small></strong></button>)}</div></Panel><Panel title="What the observations show" className="vg-insight"><ArrowUpRight size={20} /><strong>{format(result.ndvi_anomaly_percent, 1)}%</strong><p>Mean monthly NDVI departure from its preceding five-year seasonal reference, across {result.anomaly_months} eligible months.</p><div><Info size={14} /><span>VCI/VHI percentages are index values, not the percentage of South Africa’s land that is healthy.</span></div></Panel></div>
      </div>
      <div className="vg-bottom-grid">
        <Panel title="Water & thermal conditions" note={selectedName}><select aria-label="Vegetation water and thermal indicator" value={waterKey} onChange={e => setWaterKey(e.target.value)}>{['NDWI', 'NDII', 'Surface_Soil_Moisture_m3m3', 'LST_Land_Surface_Temperature_C'].map(key => <option key={key} value={key}>{catalogue[key].description} ({catalogue[key].unit})</option>)}</select><Plot data={series} unit={catalogue[waterKey].unit} height={216} lines={[{ key: waterKey, label: catalogue[waterKey].label, color: '#389faf' }]} />{meta.constant_metrics.includes(waterKey) && <p className="vg-footnote">This source variable is constant throughout the dataset.</p>}</Panel>
      </div>
      <div className="vg-weather-grid">
        <Panel title="Meteorological drivers" note="SAWS · monthly source values"><select aria-label="Vegetation weather indicator" value={weatherKey} onChange={e => setWeatherKey(e.target.value)}>{meta.metrics.filter(item => item.category === 'Weather').map(item => <option key={item.key} value={item.key}>{item.label} · {item.unit}</option>)}</select><Plot data={series} bars={weatherKey === 'Monthly_Rainfall_mm'} unit={catalogue[weatherKey].unit} height={240} lines={[{ key: weatherKey, label: catalogue[weatherKey].description, color: '#469bbc' }]} /></Panel>
        <Panel title="Climate–vegetation relationships" note="Pearson correlation with monthly NDVI"><label className="vg-lag">Climate driver leads vegetation by<select aria-label="Vegetation driver lag" value={result.lag} onChange={e => { const selection = { ...applied, lag: Number(e.target.value) }; setDraft(selection); setApplied(selection) }}>{[0, 1, 2, 3].map(lag => <option key={lag} value={lag}>{lag} month{lag === 1 ? '' : 's'}</option>)}</select></label><div className="vg-correlations">{result.correlations.map(row => <div key={row.key}><CloudRain size={15} /><span>{catalogue[row.key].label}<small>{row.pairs} complete monthly pairs</small></span><div className="vg-correlation-track"><i style={{ left: row.r < 0 ? `${50 + row.r * 50}%` : '50%', width: `${Math.abs(row.r || 0) * 50}%`, background: row.r < 0 ? '#e7a072' : '#62b59c' }} /></div><b>{format(row.r)}</b></div>)}</div><p className="vg-footnote">At least 12 pairs and variable inputs required. Raw monthly correlations can reflect shared seasonality; they do not establish causation or predict future vegetation.</p></Panel>
        <Panel title="Data confidence" note="Coverage for this selection" className="vg-quality"><div className="vg-coverage-number">{format(result.coverage.observed_days / result.coverage.expected_days * 100, 1)}<small>% of expected days</small></div><progress value={result.coverage.observed_days} max={result.coverage.expected_days} /><p>{result.coverage.complete_months} / {result.coverage.months} complete monthly periods</p><div><Info size={16} /><span>Soil moisture is 0.22 m³/m³ in every supplied row; no moisture change can be inferred.</span></div><div><Leaf size={16} /><span>Land cover, biomass, fire risk, protected areas and catchment boundaries are not supplied.</span></div><div><MapPin size={16} /><span>National summaries give each district equal weight. No area weighting is available.</span></div></Panel>
      </div>
      <details className="vg-register" open={section ? true : undefined}><summary>{section === 'satellite' ? 'Explore all primary satellite indicators' : section === 'meteorological' ? 'Explore meteorological drivers' : section === 'derived' ? 'Explore derived condition indicators' : 'Explore all 25 indicators'} · values, units and sources</summary><div className="vg-tabs">{registerOptions.map(group => <button key={group} aria-pressed={register === group} onClick={() => setRegister(group)}>{group}</button>)}</div><div className="vg-table-scroll"><table><thead><tr><th>Category</th><th>Variable / indicator</th><th>Period mean</th><th>Unit / format</th><th>Primary source</th>{compare && <><th>Change vs previous year</th><th>Matched months</th></>}</tr></thead><tbody>{registerMetrics.map(item => { const metric = catalogue[item.key]; const presentation = METRIC_PRESENTATION[item.key]; return <tr key={item.key}><td>{item.category}</td><td>{metric.label} – {metric.description}</td><td>{format(result.summary[item.key], metric.unit === 'm³/m³' ? 3 : 2)}</td><td>{presentation?.format || metric.unit}</td><td>{presentation?.source || 'Source attribution unavailable'}</td>{compare && <><td>{signed(result.deltas[item.key].difference)} {metric.unit === '%' ? 'pp' : metric.unit}</td><td>{result.deltas[item.key].paired_months}</td></>}</tr> })}</tbody></table></div></details>
      <details className="vg-methods"><summary>Data sources, coverage and calculation notes</summary>{result.warnings.map(warning => <p key={warning}><Info size={13} /> {warning}</p>)}<div className="vg-table-scroll"><table><thead><tr><th>Supabase table</th><th>Rows</th><th>Frequency</th><th>Attribution</th></tr></thead><tbody>{meta.sources.map(source => <tr key={source.file}><td>{source.file}</td><td>{source.rows == null ? "\u2014" : source.rows.toLocaleString()}</td><td>{source.cadence}</td><td>{source.attribution}</td></tr>)}</tbody></table></div><p>Satellite values are averaged within district and calendar month. Weather rows are joined once per district/month, so rainfall and ET₀ totals are never multiplied by the number of satellite days. Cards and maps average monthly values over the selected period; rainfall and ET₀ therefore retain mm/month units.</p><p>Previous-year differences use the same calendar months, paired only where both satellite months have complete daily coverage. Index changes in percent units are percentage-point differences. NDVI baselines use only the preceding five years for each calendar month, with at least three complete years. Monthly source anomalies, SPI, SPEI and GDD are shown as supplied; their original baseline and GDD base temperature are not documented here.</p><p>Source organisation names follow your dataset specification, not independently verified acquisition metadata. No area-at-risk estimates, land-cover classes or fire-risk scores are inferred from these district averages.</p></details>
      <footer className="vg-footer"><strong><Leaf size={15} /> NIWIS <span>Vegetation intelligence</span></strong><span>52 districts · Satellite observations + climate drivers · {period}</span></footer>
    </>}
  </div>
}
