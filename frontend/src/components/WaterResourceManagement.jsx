import { useEffect, useMemo, useState } from 'react'
import { Activity, AlertTriangle, Download, MapPin, Mountain, RefreshCw, Waves } from 'lucide-react'
import { dashboardFetch as fetch } from '../services/dashboardFetch'
import { DistrictMap, normaliseDistrictName } from './DistrictMap'
import WastewaterChart, { WastewaterSparkline } from './WastewaterChart'
import LoadingProgress from './LoadingProgress'
import '../niwis/rwqo.css'
import '../niwis/wrm.css'

const TEAL = '#6ce0c0', BLUE = '#80bdff', GOLD = '#ecc784', PURPLE = '#c0abff'
const valid = value => typeof value === 'number' && Number.isFinite(value)
const format = (value, digits = 2) => valid(value) ? value.toLocaleString('en-ZA', { notation: Math.abs(value) >= 1_000_000 ? 'compact' : 'standard', maximumFractionDigits: value !== 0 && Math.abs(value) < 1 ? 4 : digits }) : '—'
const ALL_AREAS = 'All SWSAs'

async function getJSON(url, signal) {
  const response = await fetch(url, { signal })
  const body = await response.json()
  if (!response.ok) throw new Error(typeof body.detail === 'string' ? body.detail : `Water resource data request failed (HTTP ${response.status}).`)
  return body
}

function Panel({ title, subtitle, children, className = '' }) {
  return <section className={`rq-panel ${className}`} aria-label={title}><header className="rq-panel-heading"><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div></header>{children}</section>
}

function IndicatorChart({ title, choices, rows, color }) {
  const [key, setKey] = useState(choices[0]?.key), [type, setType] = useState('area')
  const metric = choices.find(item => item.key === key) || choices[0]
  const latest = rows.filter(row => valid(row[metric?.key])).at(-1)
  return <Panel title={title} subtitle="Annual observations · source units retained" className="wr-indicator-panel">
    <div className="rq-chart-controls"><label>Indicator<select aria-label={`${title} indicator`} value={metric?.key || ''} onChange={event => setKey(event.target.value)}>{choices.map(item => <option key={item.key} value={item.key}>{item.label}</option>)}</select></label><label>Chart<select aria-label={`${title} chart style`} value={type} onChange={event => setType(event.target.value)}><option value="area">Area</option><option value="line">Line</option><option value="bar">Bars</option></select></label></div>
    <div className="rq-readout"><div><strong style={{ color }}>{format(latest?.[metric?.key])}<small>{metric?.unit}</small></strong><span>{latest ? `${latest.year} · ${latest.entity || 'mean of selected source records'}` : 'No numeric observations'}</span></div></div>
    <WastewaterChart data={rows} metrics={metric ? [{ ...metric, color }] : []} xKey="year" type={type} height={245} yLabel={metric?.unit} />
  </Panel>
}

function exportCSV(result, meta) {
  const escape = value => `"${String(value ?? '').replaceAll('"', '""')}"`
  const rows = [
    ...result.matrix.series.flatMap(row => meta.indicators.map(metric => [result.region, 'WRM district matrix', row.year, metric.label, row[metric.key], metric.unit, meta.audits.matrix.table])),
    ...result.swsa.series.flatMap(row => meta.swsa_indicators.map(metric => [result.area, 'SWSA', row.year, metric.label, row[metric.key], metric.unit, meta.audits.swsa.table])),
  ]
  const blob = new Blob(['\uFEFF' + [['Scope', 'Dataset', 'Year', 'Indicator', 'Value', 'Unit', 'Source table'], ...rows].map(row => row.map(escape).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' })
  const anchor = document.createElement('a')
  anchor.href = URL.createObjectURL(blob); anchor.download = `NIWIS-WRM-${result.region.replaceAll(' ', '-')}-${result.start}-${result.end}.csv`; anchor.click()
  setTimeout(() => URL.revokeObjectURL(anchor.href), 800)
}

export default function WaterResourceManagement() {
  const [meta, setMeta] = useState(null), [result, setResult] = useState(null), [features, setFeatures] = useState([])
  const [draft, setDraft] = useState({ region: 'National', area: ALL_AREAS, start: '', end: '' }), [applied, setApplied] = useState(null)
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [mapError, setMapError] = useState(''), [retry, setRetry] = useState(0)
  const [tab, setTab] = useState('matrix'), [mapKey, setMapKey] = useState('runoff'), [swsaKey, setSwsaKey] = useState('swsa_streamflow')

  useEffect(() => {
    const controller = new AbortController()
    setMeta(null); setApplied(null); setResult(null); setLoading(true); setError(''); setMapError('')
    getJSON('/api/wrm/metadata', controller.signal).then(data => {
      if (controller.signal.aborted) return
      setMeta(data)
      const initial = { region: 'National', area: ALL_AREAS, start: data.default_start, end: data.default_end }
      setDraft(initial); setApplied(initial)
    }).catch(err => { if (!controller.signal.aborted) { setError(err.message); setLoading(false) } })
    getJSON('/south_africa_adm2.display.geojson', controller.signal).then(data => { if (!controller.signal.aborted) setFeatures(data.features || []) }).catch(() => {
      if (!controller.signal.aborted) { setFeatures([]); setMapError('District boundaries could not be loaded. The district selector remains available.') }
    })
    return () => controller.abort()
  }, [retry])

  useEffect(() => {
    if (!applied) return undefined
    const controller = new AbortController()
    setLoading(true); setError(''); setResult(null)
    getJSON(`/api/wrm/dashboard?${new URLSearchParams(applied)}`, controller.signal).then(data => { if (!controller.signal.aborted) setResult(data) }).catch(err => {
      if (!controller.signal.aborted) setError(err.message)
    }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [applied])

  const mapMetric = meta?.indicators.find(item => item.key === mapKey)
  const swsaMetric = meta?.swsa_indicators.find(item => item.key === swsaKey)
  const mapValues = useMemo(() => Object.fromEntries((result?.matrix.map || []).map(row => [normaliseDistrictName(row.district_name), row])), [result])
  const mapScale = useMemo(() => {
    const values = (result?.matrix.map || []).map(row => row[mapKey]).filter(valid)
    return { min: values.length ? Math.min(...values) : 0, max: values.length ? Math.max(...values) : 1 }
  }, [result, mapKey])
  const mapColor = value => {
    const ratio = mapScale.min === mapScale.max ? 0.5 : (value - mapScale.min) / (mapScale.max - mapScale.min)
    return ratio < 0.25 ? '#235373' : ratio < 0.5 ? '#298ca5' : ratio < 0.75 ? '#46bfb5' : '#9aead2'
  }
  const applyPatch = patch => { const next = { ...applied, ...patch }; setDraft(next); setApplied(next) }
  const selectDistrict = name => {
    const region = meta.regions.find(value => normaliseDistrictName(value) === normaliseDistrictName(name))
    if (region) applyPatch({ region })
  }
  const current = result ? tab === 'matrix' ? result.matrix : result.swsa : null
  const kpis = result ? tab === 'matrix' ? [
    ['Annual rainfall (MAP)', 'precipitation', 'mm/year', BLUE], ['Annual runoff (MAR)', 'runoff', 'million m³/year', TEAL],
    ['System water losses', 'water_losses', '% of production', GOLD], ['Groundwater dependency', 'groundwater_dependency', '% of supply', PURPLE],
  ] : [
    ['Source-area rainfall', 'swsa_rainfall', 'mm/year', BLUE], ['Source-area streamflow', 'swsa_streamflow', 'million m³/year', TEAL],
    ['Vegetation (NDVI)', 'swsa_ndvi', 'index', GOLD], ['Snow cover', 'swsa_snow', '%', PURPLE],
  ] : []
  const profiles = result?.swsa.profiles || []
  const selectedProfile = profiles.find(item => item.entity === result?.area)
  const wrmGroups = meta ? [
    ['Climate inputs', meta.indicators.filter(item => item.category === 'Climate'), BLUE],
    ['Surface water & groundwater', meta.indicators.filter(item => ['Surface Water', 'Groundwater'].includes(item.category)), TEAL],
    ['Demand & system losses', meta.indicators.filter(item => ['Demand', 'Losses'].includes(item.category)), GOLD],
    ['Transfers, balance & ecological reserve', meta.indicators.filter(item => ['Water Transfers', 'Water Balance', 'Ecology', 'Policy'].includes(item.category)), PURPLE],
  ] : []

  return <div className="rwqo-dashboard wrm-dashboard">
    <header className="rq-heading"><span className="rq-heading-icon"><Waves size={29} /></span><div><span className="rq-eyebrow">INTEGRATED WATER RESOURCE MANAGEMENT / SECTION 16</span><h1>Water Resource Management</h1><p>Annual climate, water availability, demand and ecological requirements, with strategic source-area monitoring.</p></div><button className="rq-export" disabled={!result || loading} onClick={() => exportCSV(result, meta)}><Download size={15} />Export annual data</button></header>
    <form className="rq-filters wr-filters" onSubmit={event => { event.preventDefault(); setApplied({ ...draft }) }}>
      <label className="rq-region">District<select aria-label="WRM district" value={draft.region} disabled={!meta || loading} onChange={event => setDraft({ ...draft, region: event.target.value })}><option value="National">National — district means</option>{meta?.regions.map(name => <option key={name}>{name}</option>)}</select></label>
      <label className="wr-area-filter">Strategic source area<select aria-label="WRM source area" value={draft.area} disabled={!meta || loading} onChange={event => setDraft({ ...draft, area: event.target.value })}><option>{ALL_AREAS}</option>{meta?.areas.map(name => <option key={name}>{name}</option>)}</select></label>
      {['start', 'end'].map(key => <label key={key}>{key === 'start' ? 'From year' : 'To year'}<select aria-label={`WRM ${key} year`} value={draft[key]} disabled={!meta || loading} onChange={event => setDraft({ ...draft, [key]: event.target.value })}>{!meta && <option value="">Loading…</option>}{meta?.years.map(year => <option key={year}>{year}</option>)}</select></label>)}
      <button className="rq-apply" disabled={!meta || loading}>Apply filters</button><span className="rq-cache"><Activity size={13} />{format((meta?.cache_ttl_seconds || 86400) / 3600, 0)}-hour cache</span>
    </form>
    {error && <div className="rq-error" role="alert"><AlertTriangle size={18} /><span>{error}</span><button onClick={() => setRetry(value => value + 1)}><RefreshCw size={14} />Retry</button></div>}
    {loading && <LoadingProgress className="rq-loading" message="Retrieving annual water resource observations" />}
    {result && !loading && <>
      <div className="rq-context"><strong>{result.region === 'National' ? 'South Africa · District means' : result.region} / {result.area}</strong><span>{result.start}–{result.end} · annual source data · {meta.regions.length} districts · {meta.areas.length} source areas</span></div>
      <div className="rq-source-notice" role="note"><Activity size={16} /><span><strong>Annual source observations.</strong> National charts show equal district means. SWSA overviews average the named areas. Demand intensities and overlapping water components are kept in their source units; a reconciled national water balance is unavailable.</span></div>
      <div className="rq-tabs" role="group" aria-label="WRM section"><button aria-pressed={tab === 'matrix'} onClick={() => setTab('matrix')} style={{ '--rq-accent': TEAL }}><Waves size={15} />Complete WRM matrix<span>{meta.indicators.length} variables</span></button><button aria-pressed={tab === 'swsa'} onClick={() => setTab('swsa')} style={{ '--rq-accent': BLUE }}><Mountain size={15} />Strategic Water Source Areas<span>{meta.areas.length} areas · {meta.swsa_indicators.length} variables</span></button></div>
      <div className="rq-kpis">{kpis.map(([label, key, unit, color]) => <article className="rq-kpi" key={key} style={{ '--rq-accent': color }}><span>{label}</span><strong>{format(current.latest[key])}<small>{unit}</small></strong><div><span>{current.latest_year || 'No source year'} · {tab === 'matrix' ? result.region === 'National' ? 'district mean' : 'district value' : result.area === ALL_AREAS ? 'source-area mean' : 'source-area value'}</span><WastewaterSparkline data={current.series} metricKey={key} label={label} color={color} /></div></article>)}</div>
      <div className="rq-primary-grid">
        {tab === 'matrix' ? <Panel title="District resource map" subtitle={`${result.matrix.comparison_year || 'No source year'} · ${mapMetric.label}`} className="rq-map-panel">
          <label className="rq-picker">Map indicator<select aria-label="WRM map indicator" value={mapKey} onChange={event => setMapKey(event.target.value)}>{meta.indicators.map(item => <option key={item.key} value={item.key}>{item.label}</option>)}</select></label>
          {features.length ? <DistrictMap districts={features} values={mapValues} valueKey={mapKey} selected={result.region} onSelect={selectDistrict} colorFn={mapColor} legend={{ title: mapMetric.unit, gradient: 'linear-gradient(180deg, #9aead2, #46bfb5, #298ca5, #235373)', items: [[format(mapScale.max), 'Higher value'], [format((mapScale.min + mapScale.max) / 2), 'Mid-range'], [format(mapScale.min), 'Lower value'], ['Grey', 'No observation']] }} /> : <p className="rq-empty" role="status">{mapError || 'District boundaries are loading.'}</p>}
          <p className="rq-note"><MapPin size={12} />Select a district to update WRM charts. The map retains national district coverage. Colours show magnitude.</p>
          {result.region !== 'National' && <button className="rq-text-button" onClick={() => applyPatch({ region: 'National' })}>Return to National</button>}
        </Panel> : <Panel title="Source-area comparison" subtitle={`${result.swsa.comparison_year || 'No source year'} · all ${meta.areas.length} source areas`}>
          <label className="rq-picker">Comparison indicator<select aria-label="SWSA comparison indicator" value={swsaKey} onChange={event => setSwsaKey(event.target.value)}>{meta.swsa_indicators.map(item => <option key={item.key} value={item.key}>{item.label}</option>)}</select></label>
          <WastewaterChart data={result.swsa.comparison} metrics={[{ ...swsaMetric, color: TEAL }]} horizontal type="bar" xKey="entity" height={320} yLabel={swsaMetric.unit} />
          <p className="rq-note">SWSA boundaries and district links are not supplied. These named-area comparisons use the SWSA table directly.</p>
        </Panel>}
        <Panel title={tab === 'matrix' ? 'Climate input trends' : 'Rainfall & groundwater recharge'} subtitle={`${tab === 'matrix' ? result.region : result.area} · annual observations`}>
          <WastewaterChart data={current.series} metrics={tab === 'matrix' ? [{ key: 'precipitation', label: 'Precipitation (MAP)', unit: 'mm/year', color: BLUE }, { key: 'evapotranspiration', label: 'Evapotranspiration (MAE)', unit: 'mm/year', color: GOLD }] : [{ key: 'swsa_rainfall', label: 'Rainfall', unit: 'mm/year', color: BLUE }, { key: 'swsa_recharge', label: 'Groundwater recharge', unit: 'mm/year', color: TEAL }]} type="line" xKey="year" height={340} />
          <p className="rq-note">Missing observations stay as gaps. Annual source values are not expanded into monthly records.</p>
        </Panel>
      </div>
      {tab === 'matrix' ? <>
        <div className="rq-section-title"><div><span>COMPLETE VARIABLE MATRIX</span><h2>Resources, demand &amp; ecological needs</h2></div><p>{result.matrix.selected_rows} selected district-year records · {result.matrix.missing_measurements} missing values</p></div>
        <div className="rq-chart-grid">{wrmGroups.map(([title, choices, color]) => <IndicatorChart key={title} title={title} choices={choices} rows={result.matrix.series} color={color} />)}</div>
        <Panel title="Annual water volume comparison" subtitle="Source components shown together in million m³/year" className="wr-volume-panel"><WastewaterChart data={result.matrix.volume_comparison} metrics={[{ key: 'runoff', label: 'Runoff', color: BLUE }, { key: 'transfers', label: 'Transfers', color: PURPLE }, { key: 'return_flows', label: 'Return flows', color: TEAL }, { key: 'industrial_demand', label: 'Industrial demand (converted)', color: GOLD }, { key: 'ecological_reserve', label: 'Ecological Reserve (converted)', color: '#ef99af' }].map(item => ({ ...item, unit: 'million m³/year' }))} type="line" xKey="year" height={300} /><p className="rq-note">Industrial demand and the Ecological Reserve are divided by 1,000,000 for this comparison. Components can overlap; these lines are not an additive water balance. Transfer direction and total municipal/agricultural demand volumes are not supplied.</p></Panel>
        <Panel title="WRM variable matrix" subtitle={`Latest selected year: ${result.matrix.latest_year || 'none'} · supplied values and requirement reference agencies`} className="wr-matrix-panel"><div className="rq-table-scroll"><table className="wr-variable-table"><thead><tr><th>Category</th><th>Variable</th><th>Latest value</th><th>Unit</th><th>Reference agency</th></tr></thead><tbody>{meta.indicators.map(item => <tr key={item.key}><td>{item.category}</td><th scope="row">{item.label}</th><td>{format(result.matrix.latest[item.key])}</td><td>{item.unit}</td><td>{item.source}</td></tr>)}</tbody></table></div></Panel>
      </> : <>
        <div className="rq-section-title"><div><span>STRATEGIC SOURCE-AREA MONITORING</span><h2>{result.area}</h2></div><p>{result.swsa.selected_rows} selected area-year records · {result.swsa.missing_measurements} missing values</p></div>
        {selectedProfile && <div className="wr-selected-profile"><Mountain size={22} /><div><strong>{selectedProfile.entity}</strong><span>{selectedProfile.provinces}</span><p>Rivers: {selectedProfile.rivers} · Priorities: {selectedProfile.priorities}</p></div></div>}
        <div className="rq-chart-grid"><IndicatorChart title="SWSA climate & water inputs" choices={meta.swsa_indicators.slice(0, 3)} rows={result.swsa.series} color={BLUE} /><IndicatorChart title="SWSA vegetation, snow & soil" choices={meta.swsa_indicators.slice(3)} rows={result.swsa.series} color={TEAL} /></div>
        <div className="rq-source-notice" role="note"><AlertTriangle size={16} /><span>Land-use change and wetlands are listed as priorities without measured fields. Soil-moisture units and SWSA boundary geometry are not provided in this source.</span></div>
        <div className="wr-area-grid">{profiles.map(profile => <button key={profile.entity} className={`wr-area-card ${result.area === profile.entity ? 'selected' : ''}`} onClick={() => applyPatch({ area: profile.entity })}><Mountain size={19} /><strong>{profile.entity}</strong><span>{profile.provinces}</span><p><b>River systems</b>{profile.rivers}</p><p><b>Monitoring priorities</b>{profile.priorities}</p><em>View annual observations →</em></button>)}</div>
        {result.area !== ALL_AREAS && <button className="rq-text-button wr-all-areas" onClick={() => applyPatch({ area: ALL_AREAS })}>Show all SWSAs</button>}
      </>}
      <details className="rq-methods"><summary>Source tables, coverage &amp; aggregation method</summary><div className="rq-source-grid wr-source-grid">{Object.entries(meta.audits).map(([key, audit]) => <article key={key}><strong>{key === 'matrix' ? 'District WRM matrix' : 'Strategic Water Source Areas'}</strong><code>{audit.table}</code><span>{audit.rows.toLocaleString('en-ZA')} records · {audit.entities} {key === 'matrix' ? 'districts' : 'source areas'} · {audit.first_year}–{audit.last_year}</span><span>{audit.duplicate_entity_years} duplicate keys · {audit.missing_entity_years} missing entity-years · {audit.missing_measurements} missing measurements</span></article>)}</div><p>{meta.aggregation}</p><ul>{meta.limitations.map(value => <li key={value}>{value}</li>)}</ul><p>Successful source reads, prepared data and API responses use the shared {format(meta.cache_ttl_seconds / 3600, 0)}-hour memory cache. Failed reads are not cached. Restart or capacity eviction can remove entries earlier.</p></details>
    </>}
  </div>
}
