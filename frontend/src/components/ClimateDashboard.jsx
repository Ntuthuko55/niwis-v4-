import { dashboardFetch as fetch } from '../services/dashboardFetch'
import { useEffect, useMemo, useState } from 'react'
import { Sun, Thermometer, CloudRain, CalendarDays, Wind, Leaf, Waves, Download, MapPin, ArrowUpRight, Info, RefreshCw } from 'lucide-react'
import { ResponsiveContainer, BarChart, Bar, CartesianGrid, XAxis, YAxis, Tooltip, Cell } from 'recharts'
import Chart from './ClimateChart'
import ClimateSectionCharts from './ClimateSectionCharts'
import LoadingProgress from './LoadingProgress'
import { DistrictMap, normaliseDistrictName } from './DistrictMap'
import '../niwis/climate-dashboard.css'

const SECTIONS = { temperature: 'Temperature', spells: 'Wet & dry spells', rainfall: 'Mean annual precipitation', evaporation: 'Evaporation', irrigation: 'Irrigation demand', streamflow: 'Streamflow & climate' }
const fmt = (value, digits = 1) => value == null || !Number.isFinite(value) ? '—' : Number(value).toLocaleString('en-ZA', { maximumFractionDigits: digits, minimumFractionDigits: digits })
const compact = value => Math.abs(value) >= 1e9 ? `${fmt(value / 1e9)}bn` : Math.abs(value) >= 1e6 ? `${fmt(value / 1e6)}m` : Math.abs(value) >= 1e3 ? `${fmt(value / 1e3)}k` : fmt(value)

async function getJSON(url, signal) {
  const response = await fetch(url, { signal })
  const result = await response.json()
  if (!response.ok) throw new Error(typeof result.detail === 'string' ? result.detail : 'Climate data could not be loaded.')
  return result
}

function Panel({ title, subtitle, children, className = '', id }) {
  return <section id={id} className={`cl-panel ${className}`}><div className="cl-panel-heading"><h2>{title}</h2>{subtitle && <span>{subtitle}</span>}</div>{children}</section>
}

function MetricPanel({ title, subtitle, options, data, catalogue, bars, color, id }) {
  const [active, setActive] = useState(options[0][0])
  const metric = catalogue[active]
  return <Panel title={title} subtitle={subtitle} id={id}>
    <div className="cl-tabs" role="group" aria-label={`${title} indicators`}>{options.map(([key, label]) => <button type="button" key={key} aria-pressed={active === key} onClick={() => setActive(key)}>{label}</button>)}</div>
    <div className="cl-axis-caption">{metric.label} · {metric.unit}</div>
    <Chart key={active} data={data} metrics={[metric]} bars={bars} colors={[color]} />
  </Panel>
}

function IndexDial({ label, value, min, max, caption, color }) {
  const percentage = value == null ? 0 : Math.max(0, Math.min(100, (value - min) / (max - min) * 100))
  return <div className="cl-index"><h3>{label}</h3><strong style={{ color }}>{fmt(value, 2)}</strong><div className="cl-index-track"><i style={{ left: `${percentage}%` }} /></div><div className="cl-index-scale"><span>{min}</span><span>0</span><span>{max}</span></div><p>{caption}</p></div>
}

const SECTION_TITLES = { temperature: 'Temperature Change Variables', spells: 'Wet and Dry Spell Variables', rainfall: 'Mean Annual Precipitation (MAP)', evaporation: 'Potential Evaporation Variables', irrigation: 'Irrigation Demand Variables', streamflow: 'Streamflow and Climate Linkage' }
const dataMonth = (candidate, year, month) => candidate || (year == null ? '' : `${String(year).padStart(4, '0')}-${month}`)

export default function ClimateDashboard({ section = null }) {
  const [metadata, setMetadata] = useState(null)
  // Climate source files are daily for the operational sections. Keep the
  // filter bounds at month precision so the map and charts never invent a
  // value for today's date after the file snapshot ends.
  const [draft, setDraft] = useState({ region: 'National', start: '2018-01', end: '2025-12', season: 'Annual' })
  const [applied, setApplied] = useState(null)
  const [result, setResult] = useState(null)
  const [monthlyResult, setMonthlyResult] = useState(null)
  const [mapResult, setMapResult] = useState(null)
  const [mapLoading, setMapLoading] = useState(false)
  const [mapDataError, setMapDataError] = useState('')
  const [mapRetry, setMapRetry] = useState(0)
  const [mapMonth, setMapMonth] = useState('')
  const [monthlyLoading, setMonthlyLoading] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const [districts, setDistricts] = useState([])
  const [mapError, setMapError] = useState(false)
  const [mapKey, setMapKey] = useState({ temperature: 'Tavg_C', spells: 'CDD_Days', rainfall: 'MAP_mm', evaporation: 'Daily_ET0_mm', irrigation: 'Irrigation_Water_Demand_mm', streamflow: 'MAR_m3_year' }[section] || 'Tavg_C')
  const [trend, setTrend] = useState(section || 'temperature')
  const [registerSection, setRegisterSection] = useState(section || 'temperature')

  useEffect(() => {
    const controller = new AbortController()
    setError(''); setLoading(true)
    getJSON('/api/climate/metadata', controller.signal).then(meta => {
      setMetadata(meta)
      // Use the last observed month in the source snapshot. This must come
      // from the file/database catalogue, never from the browser's clock.
      const sourceStart = meta.daily_months?.includes('2018-01') ? '2018-01' : dataMonth(meta.default_start_month, meta.years?.[0], '01')
      const defaults = {
        region: 'National',
        start: sourceStart,
        end: dataMonth(meta.default_end_month, meta.default_end || meta.years?.at(-1), '12'),
        season: 'Annual',
      }
      const latestMonth = meta.default_end_month || meta.latest_month || dataMonth(null, meta.default_end || meta.years?.at(-1), '12')
      setMapMonth(latestMonth)
      setDraft(defaults); setApplied(defaults)
    }).catch(err => { if (err.name !== 'AbortError') { setError(err.message); setLoading(false) } })
    return () => controller.abort()
  }, [retry])

  useEffect(() => {
    const controller = new AbortController()
    getJSON('/south_africa_adm2.display.geojson', controller.signal).then(geo => setDistricts(geo.features || [])).catch(err => { if (err.name !== 'AbortError') setMapError(true) })
    return () => controller.abort()
  }, [])

  useEffect(() => {
    if (!applied) return
    const controller = new AbortController()
    setLoading(true); setError(''); setResult(current => current?.region === applied.region && String(current.start) === String(applied.start).slice(0, 4) && String(current.end) === String(applied.end).slice(0, 4) && current.season === applied.season ? current : null)
    const year = value => Number(String(value).slice(0, 4))
    const annualParams = { ...applied, start: year(applied.start), end: year(applied.end), include_map: 'false', ...(section ? { section } : {}) }
    getJSON(`/api/climate/dashboard?${new URLSearchParams(annualParams)}`, controller.signal).then(setResult).catch(err => { if (err.name !== 'AbortError') (setResult(null), setError(err.message)) }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [applied, section])

  useEffect(() => {
    if (!applied) return
    if (section && !['temperature', 'evaporation', 'irrigation'].includes(section)) {
      setMonthlyResult(null); setMonthlyLoading(false)
      return undefined
    }
    const controller = new AbortController()
    setMonthlyLoading(true)
    setMonthlyResult(current => current?.region === applied.region && current.start === applied.start && current.end === applied.end ? current : null)
    const params = new URLSearchParams({ region: applied.region, start: applied.start, end: applied.end, include_map: 'false', ...(section ? { section } : {}) })
    getJSON(`/api/climate/monthly?${params}`, controller.signal).then(data => {
      setMonthlyResult(data)
    }).catch(err => { if (err.name !== 'AbortError') setError(err.message) }).finally(() => { if (!controller.signal.aborted) setMonthlyLoading(false) })
    return () => controller.abort()
  }, [applied, section])

  useEffect(() => {
    if (!mapMonth) return undefined
    const controller = new AbortController()
    setMapLoading(true); setMapDataError(''); setMapResult(null)
    const params = new URLSearchParams({ month: mapMonth, ...(section ? { section } : {}) })
    getJSON(`/api/climate/map?${params}`, controller.signal).then(setMapResult)
      .catch(err => { if (err.name !== 'AbortError') setMapDataError(err.message) })
      .finally(() => { if (!controller.signal.aborted) setMapLoading(false) })
    return () => controller.abort()
  }, [mapMonth, section, mapRetry])

  const catalogue = useMemo(() => Object.fromEntries((metadata?.metrics || []).map(m => [m.key, m])), [metadata])
  const monthlyMetric = Boolean(mapResult?.map_variables?.includes(mapKey))
  const dateMetric = Boolean(mapResult?.variables?.includes(mapKey))
  const mapValues = useMemo(() => Object.fromEntries((mapResult?.map || []).map(row => [normaliseDistrictName(row.District_Name || row.district_name), row])), [mapResult])
  const mapScale = useMemo(() => {
    const values = (mapResult?.map || []).map(row => row[mapKey]).filter(v => v != null && Number.isFinite(Number(v))).map(Number)
    const low = values.length ? Math.min(...values) : 0, high = values.length ? Math.max(...values) : 1
    const palette = ['#2379ba', '#80c8db', '#f6e79d', '#f5a661', '#df6350']
    const color = value => palette[Math.min(4, Math.max(0, Math.floor((value - low) / (high - low || 1) * 5)))]
    return { color, legend: { title: catalogue[mapKey]?.unit || '', gradient: `linear-gradient(180deg, ${[...palette].reverse().join(',')})`, items: Array.from({ length: 5 }, (_, i) => [compact(high - (high - low) * i / 4), i === 0 ? 'Higher' : i === 4 ? 'Lower' : '']) } }
  }, [mapResult, mapKey, catalogue])
  const selectMapMetric = key => {
    setMapKey(key)
    const metric = catalogue[key]
    const available = (metadata?.months || []).filter(value => value >= applied.start && value <= applied.end)
    const candidates = metric?.aggregation === 'annual'
      ? available.filter(value => value.endsWith('-12'))
      : available.filter(value => (metadata?.daily_months || available).includes(value))
    if (candidates.length) setMapMonth(candidates.at(-1))
  }

  const selectDistrict = name => {
    const canonical = metadata.regions.find(region => normaliseDistrictName(region) === normaliseDistrictName(name))
    if (canonical) { const selection = { ...applied, region: canonical }; setDraft(selection); setApplied(selection) }
  }
  const exportData = () => {
    const fields = ['Year', ...metadata.metrics.filter(m => !section || m.section === section).map(m => m.key)]
    const escape = value => `"${String(value ?? '').replaceAll('"', '""')}"`
    const rows = [['Region', 'Season (daily variables only)', ...fields.map(key => key === 'Year' ? key : `${catalogue[key].label} (${catalogue[key].unit})`)], ...result.series.map(row => [result.region, result.season, ...fields.map(key => row[key])])]
    const blob = new Blob(['\uFEFF' + rows.map(row => row.map(escape).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob), link = document.createElement('a')
    link.href = url; link.download = `NIWIS-climate-${result.region.replaceAll(' ', '-')}-${result.start}-${result.end}-${result.season}.csv`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  const scope = result?.season === 'Annual' ? 'Annual' : `${result?.season} · daily variables`
  const period = result ? `${result.start}–${result.end}` : ''
  const summary = result?.summary || {}
  const displaySummary = { ...summary, ...(monthlyResult?.summary || {}) }
  const stats = result?.rainfall_statistics || {}
  const trendKeys = { temperature: ['Tmax_C', 'Tavg_C', 'Tmin_C'], rainfall: ['MAP_mm'], evaporation: ['Daily_ET0_mm', 'Daily_PET_mm', 'Daily_AET_mm'], irrigation: ['Irrigation_Water_Demand_mm', 'Rainfall_Deficit_mm'], streamflow: ['MAR_m3_year', 'Q90_LowFlow_m3_year', 'Q10_FloodFlow_m3_year'] }
  const trendUsesMonthly = Boolean(monthlyResult?.variables?.includes(trendKeys[trend]?.[0]))
  const trendData = trendUsesMonthly ? monthlyResult.series : result?.series
  const kpis = [
    ['Tavg_C', 'Mean temperature', Thermometer, 'rose'], ['Heat_Days', 'Heatwave days', Sun, 'peach'], ['MAP_mm', 'Annual rainfall', CloudRain, 'blue'],
    ['CDD_Days', 'Consecutive dry days', CalendarDays, 'sky'], ['Daily_ET0_mm', 'Reference ET₀', Wind, 'green'],
    ['Irrigation_Water_Demand_mm', 'Irrigation demand', Leaf, 'gold'], ['MAR_m3_year', 'Mean annual runoff', Waves, 'purple'],
  ]

  const mapContent = mapError ? <div className="cl-empty">District boundaries could not be loaded. Use the region filter above.</div>
    : mapDataError ? <div className="cl-empty" role="alert">{mapDataError}<button type="button" onClick={() => setMapRetry(value => value + 1)}>Retry map</button></div>
    : mapLoading ? <LoadingProgress message="Loading the national climate map" />
    : <DistrictMap districts={districts} values={mapValues} valueKey={mapKey} colorFn={mapScale.color} selected={applied?.region || result?.region} onSelect={selectDistrict} legend={mapScale.legend} />

  return <div className={`climate-dashboard ${section ? 'cl-section-dashboard' : ''}`}>
    <div className="cl-heading"><div className="cl-title"><span className="cl-title-icon"><Sun size={32} /></span><div><span className="cl-eyebrow">NIWIS · CLIMATE INTELLIGENCE</span><h1>{SECTION_TITLES[section] || 'Climate Dashboard'}</h1><p>{section ? `${SECTIONS[section]} / District indicators and monthly trends` : 'Temperature / Precipitation / Evaporation / Agriculture / Streamflow'}</p></div></div><button className="cl-export" onClick={exportData} disabled={!result || loading}><Download size={15} /> Export data</button></div>
    <form className="cl-filters" onSubmit={event => {
      event.preventDefault()
      const next = { ...draft }
      setApplied(next)
      const options = metadata?.daily_months?.length ? metadata.daily_months : (metadata?.months || [])
      const inRange = options.filter(value => value >= next.start && value <= next.end)
      if (inRange.length && !inRange.includes(mapMonth)) setMapMonth(inRange[inRange.length - 1])
    }}>
      <label className="cl-region">Region / District<select aria-label="Climate region" value={draft.region} disabled={!metadata} onChange={e => setDraft({ ...draft, region: e.target.value })}><option value="National">South Africa (district average)</option>{metadata?.regions.map(region => <option key={region}>{region}</option>)}</select></label>
      <label>From month<select aria-label="Climate start month" value={draft.start} onChange={e => setDraft({ ...draft, start: e.target.value })}>{((metadata?.daily_months?.length ? metadata.daily_months : (metadata?.months?.length ? metadata.months : monthlyResult?.months)) || []).map(value => <option key={value}>{value}</option>)}</select></label>
      <label>To month<select aria-label="Climate end month" value={draft.end} onChange={e => setDraft({ ...draft, end: e.target.value })}>{((metadata?.daily_months?.length ? metadata.daily_months : (metadata?.months?.length ? metadata.months : monthlyResult?.months)) || []).map(value => <option key={value}>{value}</option>)}</select></label>
      <label>Season<select aria-label="Climate season" value={draft.season} onChange={e => setDraft({ ...draft, season: e.target.value })}>{['Annual', 'MAM', 'JJA', 'SON', 'DJF'].map(season => <option key={season}>{season}</option>)}</select></label>
      <button className="cl-apply" disabled={!metadata || loading || draft.start > draft.end}>Apply filters</button>
      <span className="cl-data-date"><i />{metadata ? (metadata.latest_daily_date ? `Database observations through ${metadata.latest_daily_date}` : 'Database observations through the latest available year') : 'Connecting climate sources…'}</span>
      {draft.start > draft.end && <span role="alert">Choose an end month on or after the start month.</span>}
    </form>
    {!section && <div className="cl-section-links"><a href="#cl-overview">Overview</a>{Object.entries(SECTIONS).map(([key, label]) => <a key={key} href={`#cl-${key}`}>{label}</a>)}<a href="#cl-sources">Data & sources</a></div>}
    {error && <div className="cl-error" role="alert">{error}<button onClick={() => metadata ? setApplied({ ...applied }) : setRetry(retry + 1)}><RefreshCw size={14} /> Retry</button></div>}
    {loading && <LoadingProgress className="cl-loading" message={`Loading climate indicators from ${metadata?.source || 'the climate source'}`} />}
    {monthlyLoading && result && <LoadingProgress className="cl-loading" message="Loading monthly climate trends" />}
    {!result && metadata && applied && <div className={section ? 'cl-section-primary' : 'cl-primary-grid'}>
      <Panel title={section ? 'District patterns' : 'Climate overview'} subtitle="National source snapshot" className={`cl-map-panel ${section ? 'cl-section-map' : ''}`}>
        {mapContent}
        {mapResult && <div className="cl-map-note">{dateMetric ? `Source observations for ${mapResult.map_date}.` : `Annual source values for ${String(mapResult.map_month).slice(0, 4)}.`} Select a district to explore its history.</div>}
      </Panel>
      <Panel title="Climate history" subtitle="Selected date range">
        <div className="cl-empty" role="status">{loading || monthlyLoading ? 'Loading the selected chart history…' : 'Chart history is unavailable. Use Retry above.'}</div>
      </Panel>
    </div>}
    {result && <>
      {section && <ClimateSectionCharts section={section} catalogue={catalogue} result={result} monthlyResult={monthlyResult} map={<>
        <div className="cl-map-controls">
          <select aria-label="Climate map indicator" className="cl-map-selector" value={mapKey} onChange={e => selectMapMetric(e.target.value)}>{metadata.metrics.filter(m => m.section === section).map(m => <option key={m.key} value={m.key}>{m.label} ({m.unit})</option>)}</select>
          <label>Map month<select aria-label="Climate map month" value={mapMonth} onChange={e => setMapMonth(e.target.value)}>{((metadata?.daily_months?.length ? metadata.daily_months : (metadata?.months?.length ? metadata.months : monthlyResult?.months)) || []).filter(value => value >= applied.start && value <= applied.end).map(value => <option key={value}>{value}</option>)}</select></label>
        </div>
        {mapContent}
        <div className="cl-map-note">{monthlyMetric ? (dateMetric ? `Map shows source observations for ${mapResult?.map_date || mapResult?.map_month || mapMonth}.` : `Annual source values matched to source year ${String(mapResult?.map_month || mapMonth).slice(0, 4)}.`) : 'This indicator is unavailable in the source-date map.'} Use the region filter or select a district on the map.</div>
      </>} />}
      {section && <div className="cl-notes"><Info size={17} /><div>{result.warnings.map(warning => <p key={warning}>{warning}</p>)}<p>Daily temperature, evaporation and irrigation charts use monthly source observations. Wet/dry, rainfall and streamflow indicators remain annual because those source files are annual.</p></div></div>}
      {!section && <>
      <div className="cl-context" id="cl-overview"><span><MapPin size={14} /><strong>{result.region === 'National' ? 'South Africa' : result.region}</strong> · {trendUsesMonthly ? `${monthlyResult.start}–${monthlyResult.end}` : period} · {trendUsesMonthly ? 'Monthly source observations' : scope}</span><span>Period means · {result.aggregation.toLowerCase()}</span></div>
      <div className="cl-kpis">{kpis.map(([key, label, Icon, theme]) => <div className={`cl-kpi ${theme}`} key={key}><Icon size={27} /><div><span>{label}</span><strong>{key === 'MAR_m3_year' && displaySummary[key] != null ? fmt(displaySummary[key] / 1e9, 2) : fmt(displaySummary[key])}<small>{key === 'MAR_m3_year' ? 'bn m³/yr' : catalogue[key].unit}</small></strong><p>{['MAP_mm', 'CDD_Days', 'MAR_m3_year'].includes(key) ? 'Annual source · period mean' : trendUsesMonthly ? 'Observed monthly mean' : result.season === 'Annual' ? 'Observed annual · period mean' : `${result.season} · period mean`}</p></div></div>)}</div>
      <div className="cl-primary-grid">
        <Panel title="Climate overview" subtitle="District patterns · selected source month" className="cl-map-panel">
          <div className="cl-map-controls">
            <select aria-label="Climate map indicator" className="cl-map-selector" value={mapKey} onChange={e => selectMapMetric(e.target.value)}>{['Tavg_C', 'MAP_mm', 'CDD_Days', 'Daily_ET0_mm', 'Irrigation_Water_Demand_mm', 'MAR_m3_year', 'LST_Day_C'].map(key => <option value={key} key={key}>{catalogue[key].label} ({catalogue[key].unit})</option>)}</select>
          <label>Map month<select aria-label="Climate map month" value={mapMonth} onChange={e => setMapMonth(e.target.value)}>{((metadata?.daily_months?.length ? metadata.daily_months : (metadata?.months?.length ? metadata.months : monthlyResult?.months)) || []).filter(value => value >= applied.start && value <= applied.end).map(value => <option key={value}>{value}</option>)}</select></label>
          </div>
          {mapContent}
          <div className="cl-map-note"><MapPin size={13} /> {monthlyMetric ? (dateMetric ? `Source observations for ${mapResult?.map_date || mapResult?.map_month || mapMonth}.` : `Annual source values matched to source year ${String(mapResult?.map_month || mapMonth).slice(0, 4)}.`) : 'This indicator is unavailable in the source-date map.'} Select a district to explore its climate <span>52 district boundaries</span></div>
        </Panel>
        <Panel title={trend === 'temperature' ? `Temperature trends of ${result.region === 'National' ? 'South Africa' : result.region}` : 'Climate trends'} subtitle={`${result.region === 'National' ? 'Equal-weight district average' : result.region} · ${period}`} id="cl-temperature">
          <div className="cl-tabs" role="group" aria-label="Climate trend category">{Object.keys(trendKeys).map(key => <button key={key} aria-pressed={trend === key} onClick={() => setTrend(key)}>{key === 'rainfall' ? 'Precipitation' : SECTIONS[key].split(' &')[0]}</button>)}</div>
          <div className="cl-axis-caption">{catalogue[trendKeys[trend][0]].unit} · {trendUsesMonthly ? 'Monthly source observations' : ['rainfall', 'streamflow'].includes(trend) ? 'Annual source values' : scope}</div>
          <Chart key={`${trend}-${trendUsesMonthly ? 'monthly' : 'annual'}`} data={trendData} metrics={trendKeys[trend].map(key => catalogue[key])} type="line" height={310} />
        </Panel>
      </div>
      <div className="cl-detail-grid">
        <MetricPanel title="Precipitation extremes" subtitle="Annual source indices" options={[[ 'Rx1day_mm', 'Rx1day'], ['Rx5day_mm', 'Rx5day'], ['R10mm_Days', 'R10mm'], ['R20mm_Days', 'R20mm'], ['PRCPTOT_mm', 'PRCPTOT'], ['SDII_mm_per_wet_day', 'SDII']]} data={result.series} catalogue={catalogue} bars color="#328cce" />
        <MetricPanel title="Wet and dry spells" subtitle="Annual source indices" id="cl-spells" options={[[ 'CWD_Days', 'CWD'], ['CDD_Days', 'CDD']]} data={result.series} catalogue={catalogue} bars color="#24aa70" />
        <Panel title="Seasonal rainfall (MAP)" subtitle={`Mean seasonal totals · ${period}`} id="cl-rainfall"><div className="cl-axis-caption">Rainfall (mm) · seasons as reported in source</div><div className="cl-chart" style={{ height: 250 }}><ResponsiveContainer width="100%" height="100%"><BarChart data={['MAM', 'JJA', 'SON', 'DJF'].map(season => ({ season, rainfall: summary[`Precip_${season}_mm`] }))} margin={{ top: 22, right: 12, left: 0, bottom: 2 }}><CartesianGrid stroke="#e7edf3" vertical={false} /><XAxis dataKey="season" tick={{ fill: '#65788d', fontSize: 10 }} /><YAxis tick={{ fill: '#65788d', fontSize: 10 }} width={45} /><Tooltip formatter={v => [`${fmt(v)} mm`, 'Rainfall']} contentStyle={{ color: '#17334d' }} /><Bar dataKey="rainfall" radius={[4, 4, 0, 0]} maxBarSize={48} isAnimationActive={false}>{['#27ad70', '#f7a356', '#bc7654', '#378bd1'].map(color => <Cell key={color} fill={color} />)}</Bar></BarChart></ResponsiveContainer></div></Panel>
        <MetricPanel title="Evaporation & atmosphere" subtitle="Monthly source observations" id="cl-evaporation" options={[[ 'Daily_ET0_mm', 'ET₀'], ['Daily_PET_mm', 'PET'], ['Daily_AET_mm', 'AET'], ['Daily_Pan_Evap_mm', 'Pan'], ['Daily_VPD_kPa', 'VPD']]} data={monthlyResult?.series || result.series} catalogue={catalogue} color="#8854d3" />
      </div>
      <div className="cl-bottom-grid">
        <MetricPanel title="Irrigation demand" subtitle="Monthly source observations" id="cl-irrigation" options={[[ 'Irrigation_Water_Demand_mm', 'Demand'], ['CWR_mm_day', 'CWR'], ['Rainfall_Deficit_mm', 'Rain deficit'], ['Soil_Moisture_Deficit_m3m3', 'Soil deficit'], ['Growing_Season_Temp_C', 'Growth temp'], ['Irrigation_Return_Flow_mm', 'Return flow']]} data={monthlyResult?.series || result.series} catalogue={catalogue} color="#20a36c" />
        <MetricPanel title="Streamflow & climate linkage" subtitle="Annual district values · volumes, not flow rates" id="cl-streamflow" options={[[ 'MAR_m3_year', 'MAR'], ['Streamflow_Anomaly_percent', 'Anomaly'], ['Q90_LowFlow_m3_year', 'Q90'], ['Q10_FloodFlow_m3_year', 'Q10'], ['Rainfall_Runoff_Ratio', 'Runoff ratio'], ['Climate_Streamflow_Elasticity', 'Elasticity']]} data={result.series} catalogue={catalogue} bars color="#358bcc" />
        <Panel title="Climate indices" subtitle="Evidence from the selected period"><div className="cl-indices"><IndexDial label="Reported SPEI" value={summary.SPEI_Daily} min={-2} max={2} color="#147c9c" caption="Mean of supplied daily index; accumulation window is not documented." /><IndexDial label="ENSO–rainfall r" value={stats.enso_r} min={-1} max={1} color="#8056b5" caption={`Niño 3.4 · ${stats.enso_pairs} paired annual values. Correlation does not establish causation.`} /></div><div className="cl-stat-strip"><span>Rainfall CV<strong>{fmt(stats.cv_percent)}%</strong></span><span>Sen’s slope<strong>{fmt(stats.sens_slope, 2)} <small>mm/yr</small></strong></span><span>Kendall p<strong>{fmt(stats.kendall_p, 3)}</strong></span></div></Panel>
      </div>
      <div className="cl-bottom-grid cl-analysis-grid">
        <MetricPanel title="Heat, frost & surface temperature" subtitle="Source heat/frost counts and surface temperature" options={[[ 'Heat_Days', 'Heat days'], ['Heat_Duration', 'Duration'], ['Frost_Days', 'Frost'], ['Temperature_Anomaly_C', 'Anomaly'], ['LST_Day_C', 'LST day'], ['LST_Night_C', 'LST night']]} data={result.series} catalogue={catalogue} color="#e7774d" />
        <Panel title="Climate interpretation" subtitle="Calculated for your selection" className="cl-insights"><div><ArrowUpRight size={19} /><p><strong>Rainfall direction</strong>{stats.sens_slope == null ? 'Select at least three years to estimate a trend.' : `Sen’s slope is ${fmt(stats.sens_slope, 2)} mm/year. ${stats.kendall_p == null ? 'Trend significance is unavailable.' : stats.kendall_p < .05 ? 'The ordinary Kendall trend test gives p < 0.05.' : 'The ordinary Kendall trend test does not give p < 0.05.'}`}</p></div><div><CloudRain size={19} /><p><strong>Year-to-year variability</strong>{stats.cv_percent == null ? 'Select at least two years to estimate rainfall variability.' : `Annual rainfall has a coefficient of variation of ${fmt(stats.cv_percent)}% over ${stats.years} years.`}</p></div><div><Info size={19} /><p><strong>Interpretation matters</strong>National values are district averages, not area-weighted national estimates. Runoff and Q90/Q10 retain the source’s volume units.</p></div></Panel>
        <Panel title="Observation coverage" subtitle="Quality accompanies every indicator" className="cl-coverage">{result.coverage.map(item => <div key={item.section}><span>{SECTIONS[item.section]}<b>{fmt(item.observed / item.expected * 100, 1)}%</b></span><progress value={item.observed} max={item.expected} /><small>{item.observed.toLocaleString()} / {item.expected.toLocaleString()} expected district-days</small></div>)}<p>Coverage measures dates present. Missing metric values remain unavailable. {result.latest_daily_date && result.end >= Number(result.latest_daily_date.slice(0, 4)) ? 'The latest temperature record may cover a partial year.' : 'The latest complete temperature year is selected by default.'}</p></Panel>
      </div>
      <div className="cl-notes"><Info size={17} /><div>{result.warnings.map(warning => <p key={warning}>{warning}</p>)}<p>Season filters apply to daily temperature, evaporation and irrigation. Wet/dry indices and streamflow remain annual; seasonal rainfall retains all four reported seasons. DJF daily summaries use January, February and December within each calendar year.</p></div></div>
      </>}
      <Panel title="Climate indicator register" subtitle={section ? 'Selected-period mean / selected category' : 'Selected-period mean / all six sections'} className="cl-register"><div className="cl-tabs">{Object.entries(SECTIONS).filter(([key]) => !section || key === section).map(([key, label]) => <button key={key} aria-pressed={registerSection === key} onClick={() => setRegisterSection(key)}>{label}</button>)}</div><div className="cl-table-scroll"><table><thead><tr><th>Indicator</th><th>Value</th><th>Unit</th><th>Within-year aggregation</th></tr></thead><tbody>{metadata.metrics.filter(metric => metric.section === registerSection).map(metric => <tr key={metric.key}><td>{metric.label}</td><td>{fmt(displaySummary[metric.key], metric.unit === 'm³/m³' ? 4 : 2)}</td><td>{metric.unit}</td><td>{metric.aggregation === 'annual' ? 'Reported annual / seasonal source value' : `${metric.aggregation === 'sum' ? 'Observed-day sum' : metric.aggregation === 'max' ? 'Maximum observed run' : 'Observed-day mean'} · ${result.season}`}</td></tr>)}</tbody></table></div></Panel>
      <details className="cl-sources" id="cl-sources"><summary>Data sources & calculation notes / {section ? SECTIONS[section] : 'six connected climate tables'}</summary><p>The connected database tables contain district datasets. Source organisations below follow your indicator specification; the tables do not include station-level provenance or a 1 km interpolated grid.</p><div className="cl-table-scroll"><table><thead><tr><th>Section</th><th>Database table</th><th>Rows</th><th>Cadence</th><th>Source attribution supplied</th></tr></thead><tbody>{metadata.sources.filter(source => !section || source.section === section).map(source => <tr key={source.section}><td>{SECTIONS[source.section]}</td><td>{source.table}</td><td>{source.rows == null ? '—' : source.rows.toLocaleString()}</td><td>{source.frequency}</td><td>{{ temperature: 'SAWS / CSIR / SANSA / MODIS', spells: 'SAWS / derived', rainfall: 'SAWS / derived', evaporation: 'SAWS / DWS / derived', irrigation: 'SAWS / DWS / NDA / SANSA', streamflow: 'DWS / derived' }[source.section]}</td></tr>)}</tbody></table></div><p>Headline cards average the yearly values in the selected period. Daily means use available observations. Annual heat and frost counts are recomputed from Tmax &gt; 35°C and Tmin &lt; 0°C; missing dates break heat spells. Supplied annual heatwave totals are not summed across repeated daily rows. Period totals are not corrected for missing days.</p><p>{metadata.baseline_available ? 'The temperature record spans the 1981–2010 reference period; individual district and metric completeness still needs verification. ' : 'The temperature record does not span the full 1981–2010 reference period. '}Reported temperature and streamflow anomalies are retained from the source. The connected tables currently begin in 2000, so a complete 1981–2010 baseline cannot be independently established. Rainfall CV uses the sample standard deviation. Sen’s slope, ordinary Kendall rank-test p-value and Pearson ENSO correlation are recalculated for selected years; serial correlation is not corrected. Source-wide trend statistics are not reused for a shorter selected period. Q90/Q10 are source-provided annual-volume thresholds, not m³/s or event frequencies. SOI is not supplied.</p></details>
      <div className="cl-footer"><strong>NIWIS <span>Climate intelligence</span></strong><span>{metadata.regions.length} districts / {section ? SECTIONS[section] : 'Six climate datasets'} / {period}</span></div>
    </>}
  </div>
}
