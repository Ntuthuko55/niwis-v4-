import { dashboardFetch as fetch } from '../services/dashboardFetch'
import { useEffect, useMemo, useState } from 'react'
import { CloudRain, Droplets, CalendarDays, Activity, Download, RefreshCw, MapPin, Satellite, Info, ArrowDownRight, Gauge } from 'lucide-react'
import { ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ReferenceLine, Cell } from 'recharts'
import { DistrictMap, normaliseDistrictName } from './DistrictMap'
import LoadingProgress from './LoadingProgress'
import '../niwis/climate-dashboard.css'
import '../niwis/rainfall-status.css'

const fmt = (v, n = 1) => v == null || !Number.isFinite(v) ? '—' : v.toLocaleString('en-ZA', { maximumFractionDigits: n, minimumFractionDigits: n })
const monthName = month => new Date(`${month}-15T12:00:00`).toLocaleDateString('en-ZA', { month: 'short', year: 'numeric' })
const INDEX_KEYS = ['spi1', 'spi3', 'spi6', 'spi12', 'spi24', 'spei3', 'spei12', 'rai']
const INDEX_USES = ['One month', 'Three months', 'Six months', 'Twelve months', 'Twenty-four months', 'Three months + ET', 'Twelve months + ET', 'Rainfall anomaly']
async function getJSON(url, signal) {
  const response = await fetch(url, { signal }), data = await response.json()
  if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : 'Rainfall observations could not be loaded.')
  return data
}
export function Panel({ title, note, children, className = '' }) {
  return <section className={`rf-panel ${className}`}><div className="rf-panel-heading"><h2>{title}</h2>{note && <span>{note}</span>}</div>{children}</section>
}
export function Chart({ data, metrics, height = 235, x = 'month', bars = false, zero = false }) {
  if (!data?.length || !metrics.some(m => data.some(row => row[m.key] != null))) return <div className="rf-empty">No observations for this selection.</div>
  // Modules share this chart but do not all use the same time-field name.
  // Prefer the requested key, then fall back to the native period/year/date
  // field so monthly and annual source rows never render "Invalid Date".
  const first = data[0] || {}
  const xKey = first[x] != null ? x : first.period != null ? 'period' : first.month != null ? 'month' : first.year != null ? 'year' : first.Year != null ? 'Year' : first.date != null ? 'date' : x
  const formatX = value => {
    if (value == null) return ''
    if (xKey === 'period' || xKey === 'month') {
      const parsed = new Date(`${String(value).slice(0, 7)}-15T12:00:00`)
      return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toLocaleDateString('en-ZA', { month: 'short', year: 'numeric' })
    }
    if (xKey === 'date') return String(value).slice(0, 10)
    return String(value)
  }
  return <div className="rf-chart" role="img" aria-label={`${metrics.map(m => m.label).join(', ')} chart`} style={{ height }}><ResponsiveContainer width="100%" height="100%"><ComposedChart data={data} margin={{ top: 15, right: 10, left: -8, bottom: 0 }}>
    <CartesianGrid stroke="#e9eff5" vertical={false} /><XAxis dataKey={xKey} tickFormatter={formatX} tick={{ fill: '#7990a3', fontSize: 9 }} tickLine={false} axisLine={{ stroke: '#d4e1eb' }} minTickGap={25} /><YAxis tick={{ fill: '#7990a3', fontSize: 9 }} tickFormatter={v => fmt(v, Math.abs(v) < 5 ? 1 : 0)} tickLine={false} axisLine={false} width={52} domain={zero || bars ? undefined : ['auto', 'auto']} />
    <Tooltip labelFormatter={formatX} formatter={(v, name) => [`${fmt(v, 2)} ${metrics.find(m => m.label === name)?.unit || ''}`, name]} contentStyle={{ border: '1px solid #d6e4ef', borderRadius: 7, fontSize: 11, color: '#234c69' }} /><Legend wrapperStyle={{ fontSize: 9, paddingTop: 7 }} iconType="plainline" iconSize={12} />
    {zero && <ReferenceLine y={0} stroke="#9db3c3" />}
    {metrics.map((metric, index) => bars && index === 0 ? <Bar key={metric.key} dataKey={metric.key} name={metric.label} fill={metric.color} maxBarSize={26} radius={[3, 3, 0, 0]} isAnimationActive={false}>{data.map((row, i) => <Cell key={i} fill={row[metric.key] < 0 ? '#e5a276' : metric.color} />)}</Bar> : <Line key={metric.key} dataKey={metric.key} name={metric.label} stroke={metric.color} strokeWidth={2} strokeDasharray={metric.dash} dot={data.length < 40 ? { r: 2, strokeWidth: 0 } : false} connectNulls={false} isAnimationActive={false} />)}
  </ComposedChart></ResponsiveContainer></div>
}

export default function RainfallStatus() {
  const [meta, setMeta] = useState(null), [result, setResult] = useState(null)
  const [draft, setDraft] = useState({ region: 'National', start: '', end: '' }), [applied, setApplied] = useState(null)
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [retry, setRetry] = useState(0), [mapMonth, setMapMonth] = useState(''), [mapResult, setMapResult] = useState(null)
  const [features, setFeatures] = useState([]), [mapError, setMapError] = useState('')
  const [mapLoading, setMapLoading] = useState(false), [mapDataError, setMapDataError] = useState(''), [mapRetry, setMapRetry] = useState(0)
  const [selectedMap, setSelectedMap] = useState(null), [selectedMapLoading, setSelectedMapLoading] = useState(false), [selectedMapError, setSelectedMapError] = useState('')
  const [mapKey, setMapKey] = useState('rainfall'), [indexKey, setIndexKey] = useState('spi3'), [anomalyKey, setAnomalyKey] = useState('anomaly_percent')
  const [compare, setCompare] = useState(true), [rank, setRank] = useState('dry')
  const [dailyMonth, setDailyMonth] = useState(''), [dailyResult, setDailyResult] = useState(null), [dailyError, setDailyError] = useState(''), [dailyKey, setDailyKey] = useState('rainfall')
  const [dailyRetry, setDailyRetry] = useState(0)
  const effectiveMapMonth = mapMonth && applied && mapMonth >= applied.start && mapMonth <= applied.end ? mapMonth : applied?.end || ''
  const effectiveDailyMonth = dailyMonth && applied && dailyMonth >= applied.start && dailyMonth <= applied.end ? dailyMonth : applied?.end || ''
  useEffect(() => {
    const controller = new AbortController(); setError(''); setLoading(true)
    getJSON('/api/rainfall/metadata', controller.signal).then(data => { setMeta(data); const filters = { region: 'National', start: data.default_start, end: data.default_end }; setDraft(filters); setApplied(filters) }).catch(err => { if (err.name !== 'AbortError') { setError(err.message); setLoading(false) } })
    return () => controller.abort()
  }, [retry])
  useEffect(() => {
    const controller = new AbortController()
    getJSON('/south_africa_adm2.display.geojson', controller.signal).then(data => setFeatures(data.features || [])).catch(err => { if (err.name !== 'AbortError') setMapError('District boundaries could not be loaded. Use the region selector above.') })
    return () => controller.abort()
  }, [])
  useEffect(() => {
    if (!applied) return
    const controller = new AbortController(); setLoading(true); setError(''); setResult(current => current?.region === applied.region && current.start === applied.start && current.end === applied.end ? current : null)
    getJSON(`/api/rainfall/dashboard?${new URLSearchParams({ ...applied, include_map: false, include_runoff: false })}`, controller.signal).then(setResult).catch(err => { if (err.name !== 'AbortError') (setResult(null), setError(err.message)) }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [applied])
  useEffect(() => {
    if (!result || !effectiveDailyMonth) return
    const controller = new AbortController(); setDailyResult(null); setDailyError('')
    getJSON(`/api/rainfall/daily?${new URLSearchParams({ region: result.region, month: effectiveDailyMonth })}`, controller.signal).then(setDailyResult).catch(err => { if (err.name !== 'AbortError') setDailyError(err.message) })
    return () => controller.abort()
  }, [result?.region, effectiveDailyMonth, dailyRetry])
  useEffect(() => {
    if (!applied) return undefined
    const controller = new AbortController()
    setMapLoading(true); setMapDataError(''); setMapResult(null)
    getJSON(`/api/rainfall/map?${new URLSearchParams({ month: applied.end })}`, controller.signal).then(setMapResult).catch(err => { if (err.name !== 'AbortError') setMapDataError(err.message) }).finally(() => { if (!controller.signal.aborted) setMapLoading(false) })
    return () => controller.abort()
  }, [applied?.end, mapRetry])
  useEffect(() => {
    if (!applied || !effectiveMapMonth || effectiveMapMonth === applied.end) return undefined
    const controller = new AbortController()
    setSelectedMapLoading(true); setSelectedMapError(''); setSelectedMap(null)
    getJSON(`/api/rainfall/map?${new URLSearchParams({ month: effectiveMapMonth })}`, controller.signal).then(setSelectedMap).catch(err => { if (err.name !== 'AbortError') setSelectedMapError(err.message) }).finally(() => { if (!controller.signal.aborted) setSelectedMapLoading(false) })
    return () => controller.abort()
  }, [effectiveMapMonth, applied?.end, mapRetry])
  const catalogue = useMemo(() => Object.fromEntries((meta?.metrics || []).map(m => [m.key, m])), [meta])
  const mapSource = effectiveMapMonth === applied?.end ? mapResult : selectedMap
  const activeMapLoading = effectiveMapMonth === applied?.end ? mapLoading : selectedMapLoading
  const activeMapError = effectiveMapMonth === applied?.end ? mapDataError : selectedMapError
  const dailyData = dailyResult?.region === result?.region && dailyResult?.month === effectiveDailyMonth ? dailyResult : null
  const mapValues = useMemo(() => Object.fromEntries((mapSource?.map || []).map(row => [normaliseDistrictName(row.District_Name), row])), [mapSource])
  const scale = useMemo(() => {
    const signed = mapKey.startsWith('anomaly') || INDEX_KEYS.includes(mapKey)
    const numbers = (mapSource?.map || []).map(row => row[mapKey]).filter(v => v != null)
    const limit = INDEX_KEYS.includes(mapKey) ? 3 : signed ? Math.max(1, ...numbers.map(Math.abs)) : Math.max(1, ...numbers)
    const low = signed ? -limit : 0, high = limit
    const colors = signed ? ['#d08a63', '#edc8a7', '#f2f0df', '#86c4d6', '#26769f'] : ['#eef6fa', '#bbdce9', '#7ebad3', '#388db5', '#155983']
    return { color: v => colors[Math.max(0, Math.min(4, Math.floor((v - low) / (high - low) * 5)))], legend: { title: catalogue[mapKey]?.unit || '', gradient: `linear-gradient(180deg, ${[...colors].reverse().join(',')})`, items: Array.from({ length: 5 }, (_, i) => [fmt(high - (high - low) * i / 4, high <= 5 ? 1 : 0), i === 0 ? 'Higher' : i === 4 ? 'Lower' : '']) } }
  }, [mapKey, mapSource, catalogue])
  const selectRegion = name => {
    const canonical = meta.regions.find(region => normaliseDistrictName(region) === normaliseDistrictName(name))
    if (canonical) { const selection = { ...applied, region: canonical }; setDraft(selection); setApplied(selection) }
  }
  const exportMonthly = () => {
    const fields = ['month', ...meta.metrics.map(m => m.key), 'complete', 'observed_days', 'expected_days', 'dekads']
    const esc = value => `"${String(value ?? '').replaceAll('"', '""')}"`
    const rows = [['Region', ...fields.map(key => catalogue[key] ? `${catalogue[key].label} (${catalogue[key].unit})` : key)], ...result.series.map(row => [result.region, ...fields.map(key => row[key])])]
    const url = URL.createObjectURL(new Blob(['\uFEFF' + rows.map(row => row.map(esc).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8;' })), link = document.createElement('a')
    link.href = url; link.download = `NIWIS-rainfall-${result.region.replaceAll(' ', '-')}-${result.start}-${result.end}.csv`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  const regionName = result?.region === 'National' ? 'South Africa · district average' : result?.region
  const latestLabel = result ? monthName(result.end) : ''
  const ranking = (mapResult?.map || []).filter(row => row.anomaly_percent != null).sort((a, b) => rank === 'dry' ? a.anomaly_percent - b.anomaly_percent : b.anomaly_percent - a.anomaly_percent).slice(0, 5)
  const line = (key, color, label) => ({ key, label: label || catalogue[key]?.label || key, unit: catalogue[key]?.unit, color })
  const mapPanel = meta && applied && <Panel title="Rainfall across South Africa" note={`${effectiveMapMonth} · district values`} className="rf-map-panel"><div className="rf-map-controls"><select aria-label="Rainfall map indicator" value={mapKey} onChange={e => setMapKey(e.target.value)}>{['rainfall', 'anomaly_percent', 'rainy_days', 'spi1', 'spi3', 'spi6', 'spi12', 'spi24', 'spei3', 'spei12', 'rai'].map(key => <option value={key} key={key}>{catalogue[key].label} ({catalogue[key].unit})</option>)}</select><label>Map month<select aria-label="Rainfall map month" value={effectiveMapMonth} onChange={e => setMapMonth(e.target.value)}>{meta.months.filter(month => month >= applied.start && month <= applied.end).map(month => <option key={month}>{month}</option>)}</select></label></div>{mapError || activeMapError ? <div className="rf-error" role="alert">{mapError || activeMapError}{activeMapError && <button onClick={() => setMapRetry(value => value + 1)}>Retry map</button>}</div> : activeMapLoading || !mapSource ? <LoadingProgress message="Loading national rainfall map" /> : <DistrictMap districts={features} values={mapValues} valueKey={mapKey} colorFn={scale.color} selected={applied.region} onSelect={selectRegion} legend={scale.legend} />}<div className="rf-map-footer"><MapPin size={12} /> Select a district to explore its rainfall <span>52 districts · no station or raster layer</span></div></Panel>
  return <div className="rainfall-dashboard">
    <div className="rf-heading"><span className="rf-heading-icon"><CloudRain size={31} /></span><div><span className="rf-eyebrow">NIWIS / PRECIPITATION INTELLIGENCE</span><h1>Rainfall Status Monitoring</h1><p>Rainfall observations, satellite estimates and drought signals in one view</p></div><button className="rf-export" onClick={exportMonthly} disabled={!result || loading}><Download size={15} /> Export monthly data</button></div>
    <form className="rf-filters" onSubmit={event => { event.preventDefault(); setApplied({ ...draft }) }}><label className="rf-region">Region / District<select aria-label="Rainfall region" value={draft.region} disabled={!meta} onChange={e => setDraft({ ...draft, region: e.target.value })}><option value="National">South Africa (district average)</option>{meta?.regions.map(region => <option key={region}>{region}</option>)}</select></label><label>From month<input aria-label="Rainfall start month" type="month" required value={draft.start} min={meta?.months[0]} max={meta?.months.at(-1)} onChange={e => setDraft({ ...draft, start: e.target.value })} /></label><label>To month<input aria-label="Rainfall end month" type="month" required value={draft.end} min={meta?.months[0]} max={meta?.months.at(-1)} onChange={e => setDraft({ ...draft, end: e.target.value })} /></label><button className="rf-apply" disabled={loading || !meta || draft.start > draft.end}>Apply filters</button><label className="rf-compare"><input type="checkbox" checked={compare} onChange={e => setCompare(e.target.checked)} /> Compare previous year</label>{draft.start > draft.end && <span role="alert">End month must be on or after start month.</span>}</form>
    {loading && <LoadingProgress className="rf-loading" message="Preparing daily rainfall and monthly drought indices" />}
    {error && <div className="rf-error" role="alert">{error}<button onClick={() => meta ? setApplied({ ...applied }) : setRetry(retry + 1)}>Retry</button></div>}
    {!result && mapPanel}
    {result && <>
      <div className="rf-context"><span><MapPin size={13} /><strong>{regionName}</strong> · {monthName(result.start)} – {latestLabel}</span><span>File observations through {result.latest_date} · historical snapshot</span></div>
      {!result.latest.complete && <div className="rf-warning"><Info size={16} /><span><strong>{latestLabel} is incomplete.</strong> Totals cover observed days only. Comparisons exclude this month.</span></div>}
      <div className="rf-kpis">{[
        ['Period rainfall', result.summary.rainfall, 'mm', 'Sum across selected months', CloudRain, 'blue'],
        [`Rainfall · ${latestLabel}`, result.latest.rainfall, 'mm', result.latest.complete ? 'Complete calendar month' : 'Partial month · observed total', Droplets, 'aqua'],
        ['Rainy days', result.summary.rainy_days, 'days', 'Rainfall ≥ 1 mm · selected period', CalendarDays, 'blue'],
        ['Reported anomaly', result.latest.anomaly_percent, '%', `${latestLabel} · source reference`, Activity, 'sand'],
        ['SPI-3', result.latest.spi3, 'index', `${latestLabel} · supplied index`, Gauge, 'purple'],
        ['Observation coverage', result.coverage.observed_days / result.coverage.expected_days * 100, '%', `${result.coverage.complete_months}/${result.coverage.months} complete months`, CalendarDays, 'mint'],
      ].map(([label, value, unit, note, Icon, theme]) => <div className={`rf-kpi ${theme}`} key={label}><Icon size={26} /><div><span>{label}</span><strong>{fmt(value, unit === 'index' ? 2 : 1)}<small>{unit}</small></strong><p>{note}</p></div></div>)}</div>
      <div className="rf-primary-grid">{mapPanel}<Panel title="Monthly rainfall history" note="Monthly totals · mm"><Chart data={result.series} bars height={303} metrics={[line('rainfall', '#3495c5'), ...(compare ? [{ key: 'previous_year', label: 'Same month previous year', color: '#90bac7', dash: '5 3', unit: 'mm' }] : [])]} /><div className="rf-chart-note"><Info size={13} /> Monthly totals are calculated from daily observations, not summed from repeated monthly fields.</div></Panel></div>
      <div className="rf-three-grid"><Panel title="Rainfall anomaly" note="Reported source reference"><div className="rf-tabs"><button aria-pressed={anomalyKey === 'anomaly_percent'} onClick={() => setAnomalyKey('anomaly_percent')}>Percent (%)</button><button aria-pressed={anomalyKey === 'anomaly_mm'} onClick={() => setAnomalyKey('anomaly_mm')}>Depth (mm)</button></div><Chart data={result.series} bars zero metrics={[line(anomalyKey, '#559cba')]} /><p className="rf-footnote">1981–2010 normals cannot be independently verified from a record beginning in 2000.</p></Panel><Panel title="Drought index evolution" note="Source indices · dimensionless"><select aria-label="Rainfall drought index" value={indexKey} onChange={e => setIndexKey(e.target.value)}>{INDEX_KEYS.map(key => <option key={key} value={key}>{catalogue[key].label}</option>)}</select><Chart data={result.series} zero metrics={[line(indexKey, '#8b7bbe')]} /><p className="rf-footnote">National values average district indices; they are not a separately fitted national SPI/SPEI.</p></Panel><Panel title="Rainy-day frequency" note="Observed days with rainfall ≥ 1 mm"><Chart data={result.series} bars height={266} metrics={[line('rainy_days', '#54a8ad')]} /><p className="rf-footnote">National values represent average rainy days per district, not distinct national rain days.</p></Panel></div>
      <div className="rf-index-strip"><div><span className="rf-eyebrow">DROUGHT TIMESCALES</span><strong>{latestLabel}</strong><small>Reported index values</small></div>{INDEX_KEYS.map((key, i) => <button key={key} className={indexKey === key ? 'active' : ''} onClick={() => setIndexKey(key)}><span>{catalogue[key].label}</span><strong className={result.latest[key] < 0 ? 'negative' : ''}>{fmt(result.latest[key], 2)}</strong><small>{INDEX_USES[i]}</small></button>)}</div>
      <div className="rf-daily-grid"><Panel title="Daily rainfall detail" note={regionName}><div className="rf-daily-controls"><label>Inspect month<select aria-label="Rainfall daily month" value={effectiveDailyMonth} onChange={e => setDailyMonth(e.target.value)}>{result.series.map(row => <option key={row.month} value={row.month}>{monthName(row.month)}</option>)}</select></label><div className="rf-tabs"><button aria-pressed={dailyKey === 'rainfall'} onClick={() => setDailyKey('rainfall')}>Rainfall & CHIRPS</button><button aria-pressed={dailyKey === 'intensity'} onClick={() => setDailyKey('intensity')}>Reported intensity</button><button aria-pressed={dailyKey === 'gridded'} onClick={() => setDailyKey('gridded')}>Gridded value</button></div></div>{dailyError ? <div className="rf-error" role="alert">{dailyError}<button onClick={() => setDailyRetry(value => value + 1)}>Retry daily detail</button></div> : dailyData ? <Chart data={dailyData.series} x="date" bars height={235} metrics={dailyKey === 'rainfall' ? [line('rainfall', '#388fba', 'Daily rainfall'), line('chirps', '#d49d65', 'CHIRPS daily')] : [line(dailyKey, '#589fc0')]} /> : <LoadingProgress message="Loading daily rainfall observations" />}<p className="rf-footnote">Rainfall and CHIRPS: mm/day. Intensity: reported mm/h, with no hourly timestamps supplied.</p></Panel><Panel title="TAMSAT dekadal estimates" note={effectiveDailyMonth ? monthName(effectiveDailyMonth) : ''}>{dailyData ? <Chart data={dailyData.dekads} x="label" bars height={280} metrics={[{ key: 'tamsat', label: 'TAMSAT', color: '#6baeb3', unit: 'mm/dekad' }]} /> : <div className="rf-empty">{dailyError || <LoadingProgress message="Loading dekadal estimates" />}</div>}<p className="rf-footnote">Day ranges: 1–10, 11–20, 21–month end. Each repeated estimate is counted once per dekad; a partial final dekad is not a complete-period total.</p></Panel></div>
      <div className="rf-three-grid"><Panel title="Satellite rainfall comparison" note="Monthly totals on a common mm scale"><Chart data={result.series} metrics={[line('rainfall', '#288ab7', 'Daily-derived rainfall'), line('chirps', '#d4a371', 'CHIRPS'), line('tamsat', '#70a9a0', 'TAMSAT dekad sum')]} /><div className="rf-stats"><span>CHIRPS mean bias<strong>{fmt(result.satellite_agreement.bias_mm, 2)} mm</strong></span><span>CHIRPS RMSE<strong>{fmt(result.satellite_agreement.rmse_mm, 2)} mm</strong></span></div><p className="rf-footnote">Across {result.satellite_agreement.months} complete months. Agreement with this supplied rainfall series is not independent station validation.</p></Panel><Panel title="Annual rainfall context" note="Full calendar-year source totals"><Chart data={result.annual} x="year" bars metrics={[{ key: 'annual_rainfall', label: 'Reported annual rainfall', color: '#639cb9', unit: 'mm' }]} /><p className="rf-footnote">Calendar years intersecting the selected range. {result.annual.filter(row => !row.complete).map(row => row.year).join(', ') || 'No years'} incomplete in the source; incomplete-year bars are totals to the latest source date.</p></Panel><Panel title={`Seasonal distribution · ${result.end.slice(0, 4)}`} note="Full calendar-year context · source values"><Chart data={result.seasonal} x="season" bars metrics={[line('rainfall', '#6dacc0', 'Seasonal rainfall')]} /><div className="rf-season-status">{result.seasonal.map(row => <span key={row.season}>{row.season}<b>{row.rainfall == null ? 'Unavailable' : row.complete ? 'Complete' : 'Partial'}</b></span>)}</div><p className="rf-footnote">JFM: Jan–Mar · AMJ: Apr–Jun · JAS: Jul–Sep · OND: Oct–Dec. Unobserved future seasons are unavailable, not zero rainfall.</p></Panel></div>
      <div className="rf-analysis-grid"><Panel title={`District rainfall departures · ${latestLabel}`} note="Ranked by reported anomaly"><div className="rf-tabs"><button aria-pressed={rank === 'dry'} onClick={() => setRank('dry')}>Lowest five</button><button aria-pressed={rank === 'wet'} onClick={() => setRank('wet')}>Highest five</button></div><div className="rf-ranking">{mapLoading && <p role="status">Loading district ranking...</p>}{mapDataError && <p role="alert">{mapDataError}</p>}{ranking.map((row, i) => <button key={row.District_Name} onClick={() => selectRegion(row.District_Name)}><span>{i + 1}</span><strong>{row.District_Name}</strong><b>{fmt(row.anomaly_percent)}%</b><small>{fmt(row.rainfall)} mm</small></button>)}</div></Panel><Panel title="Reading the rainfall signals" note="Scope and data quality"><div className="rf-insight"><ArrowDownRight size={20} /><p><strong>Selected-period water input</strong>{fmt(result.summary.rainfall)} mm over {result.coverage.months} months. {result.region === 'National' ? 'This is an equal-weight district average, not a national volume or area-weighted estimate.' : 'Totals describe this district’s supplied observations.'}</p></div><div className="rf-insight"><Satellite size={20} /><p><strong>Satellite estimates at the right frequency</strong>CHIRPS is summed from daily rows. TAMSAT is counted once per dekad before monthly comparison.</p></div><div className="rf-insight"><Info size={20} /><p><strong>Source checks</strong>{result.warnings.slice(0, 2).join(' ')}</p></div></Panel></div>
      <details className="rf-register"><summary>Indicator register · latest selected month and units</summary><div className="rf-table-scroll"><table><thead><tr><th>Indicator</th><th>{latestLabel}</th><th>Unit</th><th>Method</th></tr></thead><tbody>{meta.metrics.map(metric => <tr key={metric.key}><td>{metric.label}</td><td>{fmt(result.latest[metric.key], 2)}</td><td>{metric.unit}</td><td>{metric.method}</td></tr>)}</tbody></table></div></details>
      <details className="rf-methods"><summary>Sources, update status & calculation notes</summary><p>The Supabase module 4 tables supply this historical snapshot. There is no separate live SAWS station feed connected to this module. Latest daily observation: {meta.latest_date}.</p><div className="rf-table-scroll"><table><thead><tr><th>Supabase table</th><th>Rows</th><th>Frequency</th></tr></thead><tbody><tr><td>{meta.files[0]}</td><td>{meta.core_rows == null ? "\u2014" : meta.core_rows.toLocaleString()}</td><td>Daily records with repeated monthly / seasonal / annual values</td></tr><tr><td>{meta.files[1]}</td><td>{meta.index_rows == null ? "\u2014" : meta.index_rows.toLocaleString()}</td><td>Monthly drought indices</td></tr></tbody></table></div>{result.warnings.map(warning => <p key={warning}>{warning}</p>)}<p>Repeated monthly and annual values are read once per reporting period. Conflicting repeated values cause a source error instead of silent aggregation. Rainy days are recomputed using the ≥ 1 mm threshold. Missing measurements are not filled with zeros. Partial-month totals are shown as observed; year-on-year comparisons require complete months in both years.</p><p>National displays average district values, giving districts equal weight. Daily and monthly averages can use different available observations if coverage changes. All eight drought indices are displayed as supplied, including their original estimation choices. SAWS, CHIRPS, TAMSAT and SANSA attribution follows your indicator specification; the files do not verify 800+ individual stations or contain a 1 km rainfall raster.</p></details>
      <div className="rf-footer"><strong><CloudRain size={15} /> NIWIS <span>Rainfall intelligence</span></strong><span>52 districts · Daily rainfall + monthly drought indices · Source through {meta.latest_date}</span></div>
    </>}
  </div>
}
