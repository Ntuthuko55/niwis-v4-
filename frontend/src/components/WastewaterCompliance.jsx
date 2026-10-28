import { useEffect, useMemo, useState } from 'react'
import { Activity, ArrowDownRight, ArrowUpRight, BarChart3, CloudRain, Download, Droplets, Factory, FlaskConical, MapPin, RefreshCw, ShieldCheck } from 'lucide-react'
import { dashboardFetch as fetch } from '../services/dashboardFetch'
import { DistrictMap, normaliseDistrictName } from './DistrictMap'
import LoadingProgress from './LoadingProgress'
import WastewaterChart, { WastewaterSparkline } from './WastewaterChart'
import '../niwis/climate-dashboard.css'
import '../niwis/rainfall-status.css'
import '../niwis/wastewater.css'

const PALETTE = ['#54d9cb', '#65b5ff', '#f2bf73', '#b69cff', '#ee92b6']
const MAP_COLORS = ['#14394f', '#19617a', '#248ca0', '#46b9b4', '#8ce6ca']
const EFFLUENT = ['Physical', 'Chemical', 'Nutrients', 'Biological', 'Metals']
const valid = value => typeof value === 'number' && Number.isFinite(value)
const number = (value, digits = 2) => valid(value) ? value.toLocaleString('en-ZA', { maximumFractionDigits: digits }) : '\u2014'
const lastPoints = (series, key) => series.filter(row => valid(row[key])).slice(-2)

async function getJSON(url, signal) {
  const response = await fetch(url, { signal })
  const body = await response.text()
  let payload
  try { payload = body ? JSON.parse(body) : {} } catch {
    throw new Error(body.trim().slice(0, 240) || `Wastewater service returned HTTP ${response.status}.`)
  }
  if (!response.ok) {
    throw new Error(typeof payload.detail === 'string' ? payload.detail : Array.isArray(payload.detail) ? payload.detail.map(item => item.msg).join('; ') : `Wastewater service returned HTTP ${response.status}.`)
  }
  return payload
}

function saveCSV(result, metrics) {
  const esc = value => `"${String(value ?? '').replaceAll('"', '""')}"`
  const rows = [['Region', 'Year', ...metrics.map(item => `${item.label} (${item.unit})`)], ...result.series.map(row => [result.region, row.year, ...metrics.map(item => row[item.key])])]
  const blob = new Blob(['\uFEFF' + rows.map(row => row.map(esc).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' })
  const link = document.createElement('a')
  link.href = URL.createObjectURL(blob); link.download = `NIWIS-wastewater-${result.region.replaceAll(' ', '-')}-${result.start}-${result.end}.csv`; link.click()
  setTimeout(() => URL.revokeObjectURL(link.href), 800)
}

function Change({ series, metricKey }) {
  const points = lastPoints(series, metricKey)
  if (points.length < 2) return <span className="ww-change">No earlier annual observation</span>
  const [previous, current] = points
  const difference = current[metricKey] - previous[metricKey]
  const percentage = previous[metricKey] === 0 ? null : difference / Math.abs(previous[metricKey]) * 100
  const Arrow = difference < 0 ? ArrowDownRight : ArrowUpRight
  return <span className="ww-change">{difference !== 0 && <Arrow size={13} />}{difference === 0 ? 'Unchanged' : percentage == null ? `${difference > 0 ? '+' : ''}${number(difference)}` : `${percentage > 0 ? '+' : ''}${number(percentage, 1)}%`} <span>vs {previous.year}</span></span>
}

function Panel({ title, subtitle, icon: Icon = Activity, children, className = '', action }) {
  return <section className={`ww-panel ${className}`} aria-label={title}>
    <header className="ww-panel-header"><div><span className="ww-panel-icon"><Icon size={17} /></span><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div></div>{action}</header>
    {children}
  </section>
}

function Readout({ metric, series, color }) {
  const point = lastPoints(series, metric?.key).at(-1)
  return <div className="ww-readout"><div><strong style={{ color }}>{number(point?.[metric?.key])}<small>{metric?.unit}</small></strong><span>{point ? `${point.year} annual mean` : 'No observations in this period'}</span></div>{metric && <Change series={series} metricKey={metric.key} />}</div>
}

function TrendPanel({ title, subtitle, choices, preferred, result, color = PALETTE[0], type = 'area', label, icon, compareKeys, referenceLine }) {
  const [selectedKey, setSelectedKey] = useState(preferred)
  const selected = choices.find(item => item.key === selectedKey) || choices[0]
  const comparison = compareKeys?.includes(selected?.key) ? choices.filter(item => compareKeys.includes(item.key) && item.unit === selected.unit) : []
  const metrics = (comparison.length > 1 ? comparison : selected ? [selected] : []).map((item, index) => ({ ...item, color: index === 0 ? color : PALETTE[2] }))
  return <Panel title={title} subtitle={subtitle} icon={icon} className="ww-trend-panel">
    {choices.length > 1 && <label className="ww-picker"><span>Indicator</span><select aria-label={label || `${title} indicator`} value={selected?.key || ''} onChange={event => setSelectedKey(event.target.value)}>{choices.map(item => <option key={item.key} value={item.key}>{item.label}</option>)}</select></label>}
    <Readout metric={selected} series={result.series} color={color} />
    <WastewaterChart data={result.series} metrics={metrics} type={type} height={240} yLabel={selected?.unit} referenceLine={referenceLine} />
    <p className="ww-chart-caption">{comparison.length > 1 ? 'Flow and capacity share the same units.' : 'Annual means of the available district observations.'}</p>
  </Panel>
}

function NutrientPanel({ choices, result }) {
  const [hidden, setHidden] = useState([])
  const metrics = choices.filter(item => !hidden.includes(item.key)).map((item, index) => ({ ...item, color: PALETTE[choices.indexOf(item) % PALETTE.length] }))
  return <Panel title="Nutrient concentrations" subtitle="Ammonia, inorganic nitrogen and phosphorus" icon={Droplets} className="ww-trend-panel">
    <div className="ww-series-controls" role="group" aria-label="Nutrient chart series">{choices.map((item, index) => <button key={item.key} type="button" aria-pressed={!hidden.includes(item.key)} style={{ '--series-color': PALETTE[index] }} onClick={() => setHidden(current => current.includes(item.key) ? current.filter(key => key !== item.key) : current.length < choices.length - 1 ? [...current, item.key] : current)}><i />{item.label}</button>)}</div>
    <WastewaterChart data={result.series} metrics={metrics} type="line" height={300} yLabel="mg/L" />
    <p className="ww-chart-caption">Select a legend button to focus the comparison. All series use mg/L.</p>
  </Panel>
}

export default function WastewaterCompliance() {
  const [meta, setMeta] = useState(null), [features, setFeatures] = useState([]), [result, setResult] = useState(null), [national, setNational] = useState(null)
  const [draft, setDraft] = useState({ region: 'National', start: 2000, end: new Date().getFullYear() }), [applied, setApplied] = useState(null)
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [retry, setRetry] = useState(0)
  const [mapKey, setMapKey] = useState('hydraulic_loading_pct'), [category, setCategory] = useState('Chemical'), [leadKey, setLeadKey] = useState('cod_mg_l'), [leadType, setLeadType] = useState('area')
  const [rankingKey, setRankingKey] = useState('hydraulic_loading_pct')

  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError('')
    Promise.all([getJSON('/api/wastewater/metadata', controller.signal), getJSON('/south_africa_adm2.display.geojson', controller.signal).catch(() => ({ features: [] }))]).then(([data, map]) => {
      setMeta(data); setFeatures(map.features || [])
      const initial = { region: 'National', start: 2000, end: new Date().getFullYear() }
      setDraft(initial); setApplied(initial)
    }).catch(err => { if (err.name !== 'AbortError') { setError(err.message); setLoading(false) } })
    return () => controller.abort()
  }, [retry])

  useEffect(() => {
    if (!applied) return undefined
    const controller = new AbortController(); setLoading(true); setError(''); setResult(null)
    const selectedURL = `/api/wastewater/dashboard?${new URLSearchParams(applied)}`
    const nationalURL = `/api/wastewater/dashboard?${new URLSearchParams({ ...applied, region: 'National' })}`
    Promise.all([getJSON(selectedURL, controller.signal), applied.region === 'National' ? Promise.resolve(null) : getJSON(nationalURL, controller.signal)]).then(([data, mapData]) => {
      setResult(data); setNational(mapData || data)
    }).catch(err => { if (err.name !== 'AbortError') setError(err.message) }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [applied])

  const indicators = meta?.indicators || []
  const metric = key => indicators.find(item => item.key === key)
  const byCategory = name => indicators.filter(item => item.category === name)
  const categories = EFFLUENT.filter(name => byCategory(name).length)
  const activeCategory = categories.includes(category) ? category : categories[0] || ''
  const leadChoices = byCategory(activeCategory)
  const leadMetric = leadChoices.find(item => item.key === leadKey) || leadChoices[0]
  const leadMetrics = leadMetric ? [leadMetric] : []
  const mapSource = national || result
  const districts = useMemo(() => [...new Set((mapSource?.map || []).map(row => row.district_name))].sort(), [mapSource])
  const mapValues = useMemo(() => Object.fromEntries((mapSource?.map || []).map(row => [normaliseDistrictName(row.district_name), row])), [mapSource])
  const mapMetric = metric(mapKey) || indicators[0]
  const rankingMetric = metric(rankingKey) || indicators[0]
  const ranked = (mapSource?.map || []).filter(row => valid(row[rankingMetric?.key])).sort((a, b) => b[rankingMetric.key] - a[rankingMetric.key]).slice(0, 8)
  const scale = useMemo(() => {
    const values = (mapSource?.map || []).map(row => row[mapMetric?.key]).filter(valid)
    const low = values.length ? Math.min(...values) : 0, high = values.length ? Math.max(...values) : 1, range = high - low || 1
    return { color: value => MAP_COLORS[Math.min(4, Math.max(0, Math.floor((value - low) / range * 5)))], legend: { title: mapMetric?.unit || '', gradient: `linear-gradient(180deg,${[...MAP_COLORS].reverse().join(',')})`, items: high === low ? [[number(high), 'Same source value']] : [[number(high), 'Higher'], [number((low + high) / 2), ''], [number(low), 'Lower']] } }
  }, [mapSource, mapMetric])

  const selectDistrict = name => {
    const canonical = districts.find(value => normaliseDistrictName(value) === normaliseDistrictName(name))
    if (canonical) { const next = { ...applied, region: canonical }; setDraft(next); setApplied(next) }
  }
  const kpis = [
    ['cod_mg_l', 'Chemical oxygen demand', FlaskConical, PALETTE[0]],
    ['ecoli_cfu_100ml', 'E. coli', Droplets, PALETTE[3]],
    ['hydraulic_loading_pct', 'Hydraulic loading', Activity, PALETTE[2]],
    ['influent_flow_m3_day', 'Influent flow', Factory, PALETTE[1]],
  ].filter(([key]) => metric(key))

  return <div className="rainfall-dashboard wastewater-dashboard">
    <div className="rf-heading ww-heading"><span className="rf-heading-icon wastewater-icon"><Factory size={29} /></span><div><span className="rf-eyebrow">NIWIS / MONITORING 11</span><h1>Wastewater Quality Compliance</h1><p>Explore effluent quality, treatment performance and the conditions shaping wastewater management.</p></div><button className="rf-export" onClick={() => result && saveCSV(result, indicators)} disabled={!result || loading}><Download size={15} /> Export data</button></div>
    <form className="rf-filters wastewater-filters" onSubmit={event => { event.preventDefault(); setApplied({ ...draft }) }}>
      <label className="rf-region">Region / district<select aria-label="Wastewater region" disabled={!meta} value={draft.region} onChange={event => setDraft({ ...draft, region: event.target.value })}><option value="National">South Africa (district average)</option>{districts.map(item => <option key={item}>{item}</option>)}</select></label>
      <label>From year<input aria-label="From year" type="number" required min="1900" max="2100" value={draft.start} onChange={event => setDraft({ ...draft, start: Number(event.target.value) })} /></label>
      <label>To year<input aria-label="To year" type="number" required min="1900" max="2100" value={draft.end} onChange={event => setDraft({ ...draft, end: Number(event.target.value) })} /></label>
      <button className="rf-apply" disabled={loading || !meta || draft.start > draft.end}>Apply filters</button>
    </form>
    {loading && <LoadingProgress className="rf-loading" message="Preparing wastewater maps and indicator trends" />}
    {error && <div className="rf-error" role="alert">{error}<button onClick={() => meta ? setApplied({ ...applied }) : setRetry(retry + 1)}><RefreshCw size={14} /> Retry</button></div>}
    {result && <>
      <div className="ww-context"><span><MapPin size={14} /><strong>{result.region === 'National' ? 'South Africa' : result.region}</strong><span>{result.start}–{result.end}</span></span><span><i /> Annual observations<span className="ww-context-divider" />{districts.length} districts on the national map</span></div>
      <div className="ww-kpi-grid">{kpis.map(([key, label, Icon, color]) => {
        const item = metric(key), point = lastPoints(result.series, key).at(-1)
        return <article className="ww-kpi" key={key} style={{ '--ww-accent': color }}><div className="ww-kpi-title"><span>{label}</span><Icon size={18} /></div><div className="ww-kpi-value"><strong>{number(point?.[key], key === 'influent_flow_m3_day' ? 0 : 2)}</strong><small>{item.unit}</small></div><div className="ww-kpi-bottom"><div><Change series={result.series} metricKey={key} /><span className="ww-kpi-year">{point ? `${point.year} annual mean` : 'No observations'}</span></div><WastewaterSparkline data={result.series} metricKey={key} color={color} label={`${label} annual trend`} /></div></article>
      })}</div>

      <div className="ww-primary-grid">
        <Panel title="National wastewater landscape" subtitle="Select an indicator, then choose a district" icon={MapPin} className="rf-map-panel ww-map-panel">
          <label className="ww-picker"><span>Map indicator</span><select aria-label="Wastewater map indicator" value={mapMetric?.key || ''} onChange={event => setMapKey(event.target.value)}>{indicators.map(item => <option key={item.key} value={item.key}>{item.label} ({item.unit})</option>)}</select></label>
          {features.length && mapSource?.map.length ? <DistrictMap districts={features} values={mapValues} valueKey={mapMetric?.key} colorFn={scale.color} selected={result.region === 'National' ? null : result.region} onSelect={selectDistrict} legend={scale.legend} /> : <div className="ww-chart-empty">District boundaries or observations are unavailable.</div>}
          <p className="ww-chart-caption"><span className="ww-map-dot" />District values in the latest available year. Colors show relative values.</p>
        </Panel>
        <Panel title="Effluent quality explorer" subtitle="Follow a selected measurement through time" icon={FlaskConical} className="ww-trend-panel ww-lead-panel" action={<div className="ww-chart-switch" role="group" aria-label="Effluent chart style"><button type="button" aria-pressed={leadType === 'area'} onClick={() => setLeadType('area')} title="Area chart"><Activity size={16} /><span>Trend</span></button><button type="button" aria-pressed={leadType === 'bar'} onClick={() => setLeadType('bar')} title="Bar chart"><BarChart3 size={16} /><span>Bars</span></button></div>}>
          <div className="ww-explorer-controls"><label className="ww-picker"><span>Measurement group</span><select aria-label="Effluent category" value={activeCategory} onChange={event => { setCategory(event.target.value); setLeadKey(byCategory(event.target.value)[0]?.key || '') }}>{categories.map(item => <option key={item}>{item}</option>)}</select></label><label className="ww-picker"><span>Indicator</span><select aria-label="Effluent indicator" value={leadMetric?.key || ''} onChange={event => setLeadKey(event.target.value)}>{leadChoices.map(item => <option key={item.key} value={item.key}>{item.label}</option>)}</select></label></div>
          <Readout metric={leadMetric} series={result.series} color={PALETTE[0]} />
          <WastewaterChart data={result.series} metrics={leadMetrics.map(item => ({ ...item, color: PALETTE[0] }))} type={leadType} height={290} yLabel={leadMetric?.unit} />
          <p className="ww-chart-caption">Annual means · {result.region === 'National' ? 'South Africa district observations' : result.region}</p>
        </Panel>
      </div>

      <div className="ww-section-heading"><div><span>01 / EFFLUENT QUALITY</span><h2>What is leaving the treatment works?</h2></div><p>Physical, nutrient, biological and metal indicators over time.</p></div>
      <div className="ww-chart-grid">
        <TrendPanel title="Physical measurements" subtitle="Temperature, turbidity, conductivity and solids" choices={byCategory('Physical')} preferred="temperature_c" result={result} color={PALETTE[1]} label="Physical indicator" icon={Droplets} />
        <NutrientPanel choices={byCategory('Nutrients').filter(item => item.unit === 'mg/L')} result={result} />
        <TrendPanel title="Biological measurements" subtitle="Microbiological observations in the effluent" choices={byCategory('Biological')} preferred="ecoli_cfu_100ml" result={result} color={PALETTE[3]} type="bar" label="Biological indicator" icon={FlaskConical} />
        <TrendPanel title="Heavy metal concentrations" subtitle="Combined heavy metal measurement supplied by the source" choices={byCategory('Metals')} preferred="heavy_metals_ug_l" result={result} color={PALETTE[2]} icon={ShieldCheck} />
      </div>

      <div className="ww-section-heading"><div><span>02 / TREATMENT PERFORMANCE</span><h2>How are treatment systems operating?</h2></div><p>Explore flow, capacity, energy use and other operational measurements.</p></div>
      <div className="ww-chart-grid">
        <TrendPanel title="Treatment works operations" subtitle="Compare incoming flow with the available design capacity" choices={byCategory('Operations')} preferred="influent_flow_m3_day" result={result} color={PALETTE[1]} label="Operational indicator" compareKeys={['influent_flow_m3_day', 'design_capacity_m3_day']} icon={Factory} />
        <TrendPanel title="Hydraulic loading" subtitle="Reported loading as a percentage of design capacity" choices={indicators.filter(item => item.key === 'hydraulic_loading_pct')} preferred="hydraulic_loading_pct" result={result} color={PALETTE[2]} referenceLine={{ value: 100, label: 'Design capacity' }} icon={Activity} />
      </div>

      <div className="ww-section-heading"><div><span>03 / REGIONAL CONTEXT</span><h2>Compare districts and weather conditions</h2></div><p>National context stays visible when exploring a single district.</p></div>
      <div className="ww-chart-grid">
        <Panel title="District comparison" subtitle="Eight highest reported values in the national map data" icon={BarChart3} className="ww-trend-panel ww-district-panel">
          <label className="ww-picker"><span>Compare indicator</span><select aria-label="District comparison indicator" value={rankingMetric?.key || ''} onChange={event => setRankingKey(event.target.value)}>{indicators.map(item => <option key={item.key} value={item.key}>{item.label} ({item.unit})</option>)}</select></label>
          <WastewaterChart data={ranked} metrics={rankingMetric ? [{ ...rankingMetric, color: PALETTE[0] }] : []} type="bar" horizontal xKey="district_name" height={310} yLabel={rankingMetric?.unit} />
          <p className="ww-chart-caption">Rankings describe the selected measurement; they are not Green Drop grades.</p>
        </Panel>
        <TrendPanel title="Weather and treatment conditions" subtitle="Rainfall, temperature, evaporation and the flood event proxy" choices={byCategory('Meteorological')} preferred="rainfall_mm" result={result} color={PALETTE[1]} type="bar" label="Weather indicator" icon={CloudRain} />
      </div>

      <details className="ww-methods"><summary>Data sources and calculation notes</summary><div className="ww-source-grid">{meta.tables.map(item => <div key={item.kind}><strong>{item.label}</strong><span>{item.table}</span><small>{number(item.rows, 0)} source rows</small></div>)}</div><p>Charts show annual means of available observations. National values describe district observations, rather than a plant inventory. The map shows the latest year with data in the chosen period. Source variables are displayed in their supplied units.</p><p>Green Drop certification scores, regulatory limits and receiving-water measurements are not included in the supplied relations.</p></details>
      <footer className="ww-footer"><span><ShieldCheck size={16} /> NIWIS wastewater intelligence</span><span>Monitoring 11 · Supabase observations</span></footer>
    </>}
  </div>
}
