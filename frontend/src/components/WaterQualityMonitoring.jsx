import { dashboardFetch as fetch } from '../services/dashboardFetch'
import { useEffect, useMemo, useState } from 'react'
import { Activity, Download, Droplets, FlaskConical, Info, MapPin, RefreshCw, Satellite, ShieldCheck } from 'lucide-react'
import { Chart, Panel } from './RainfallStatus'
import { DistrictMap, normaliseDistrictName } from './DistrictMap'
import LoadingProgress from './LoadingProgress'
import '../niwis/water-quality.css'

const fmt = (value, digits = 2) => value == null || !Number.isFinite(Number(value)) ? '—' : Number(value).toLocaleString('en-ZA', { minimumFractionDigits: digits, maximumFractionDigits: digits })
const colors = ['#3c91b5', '#5ba69b', '#8ba76e', '#c48c62', '#9a78ae']

async function getJSON(url, signal) {
  const response = await fetch(url, { signal })
  const data = await response.json()
  if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : 'Water-quality data could not be loaded.')
  return data
}

function downloadCSV(name, headers, rows) {
  const esc = value => `"${String(value ?? '').replaceAll('"', '""')}"`
  const blob = new Blob(['\uFEFF' + [headers, ...rows].map(row => row.map(esc).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' })
  const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 800)
}

export default function WaterQualityMonitoring() {
  const [meta, setMeta] = useState(null), [result, setResult] = useState(null), [features, setFeatures] = useState([])
  const [draft, setDraft] = useState({ region: 'National', start: '', end: '' }), [applied, setApplied] = useState(null)
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [retry, setRetry] = useState(0), [mapYear, setMapYear] = useState(''), [mapResult, setMapResult] = useState(null)
  const [mapKey, setMapKey] = useState('ph'), [trendKey, setTrendKey] = useState('ph'), [physicalKey, setPhysicalKey] = useState('turbidity_ntu'), [chemicalKey, setChemicalKey] = useState('dissolved_oxygen_mg_l'), [biologicalKey, setBiologicalKey] = useState('ecoli_cfu_100ml'), [sansaKey, setSansaKey] = useState('sansa_turbidity_proxy')
  const [monthly, setMonthly] = useState(null), [monthlyError, setMonthlyError] = useState('')

  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError('')
    Promise.all([getJSON('/api/water-quality/metadata', controller.signal), getJSON('/south_africa_adm2.display.geojson', controller.signal).catch(() => ({ features: [] }))]).then(([data, map]) => {
      setMeta(data); setFeatures(map.features || [])
      const initial = { region: 'National', start: data.default_start, end: data.default_end }
      setDraft(initial); setApplied(initial)
    }).catch(err => { if (err.name !== 'AbortError') { setError(err.message); setLoading(false) } })
    return () => controller.abort()
  }, [retry])

  useEffect(() => {
    if (!applied) return
    const controller = new AbortController(); setLoading(true); setError(''); setResult(current => current?.region === applied.region && String(current.start) === String(applied.start) && String(current.end) === String(applied.end) ? current : null); setMapResult(null); setMonthly(null); setMapYear(String(applied.end))
    getJSON(`/api/water-quality/dashboard?${new URLSearchParams(applied)}`, controller.signal).then(setResult).catch(err => { if (err.name !== 'AbortError') (setResult(null), setError(err.message)) }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [applied])

  useEffect(() => {
    if (!applied || !mapYear || String(mapYear) === String(applied.end)) return undefined
    const controller = new AbortController()
    getJSON(`/api/water-quality/dashboard?${new URLSearchParams({ ...applied, start: mapYear, end: mapYear })}`, controller.signal).then(setMapResult).catch(err => { if (err.name !== 'AbortError') setMapResult(null) })
    return () => controller.abort()
  }, [applied, mapYear])

  useEffect(() => {
    if (!result) return
    const controller = new AbortController(); setMonthly(null); setMonthlyError('')
    getJSON(`/api/water-quality/monthly?${new URLSearchParams({ region: result.region, year: result.end })}`, controller.signal).then(setMonthly).catch(err => { if (err.name !== 'AbortError') setMonthlyError(err.message) })
    return () => controller.abort()
  }, [result])

  const catalogue = useMemo(() => Object.fromEntries((meta?.metrics || []).map(item => [item.key, item])), [meta])
  const metric = key => catalogue[key] || { key, label: key.replaceAll('_', ' '), unit: '' }
  const mapSource = mapResult || result
  const mapValues = useMemo(() => Object.fromEntries((mapSource?.map || []).map(row => [normaliseDistrictName(row.district_name), row])), [mapSource])
  const scale = useMemo(() => {
    const values = (mapSource?.map || []).map(row => Number(row[mapKey])).filter(Number.isFinite)
    const low = Math.min(...values, 0), high = Math.max(1, ...values), range = high - low || 1
    return { color: value => colors[Math.max(0, Math.min(colors.length - 1, Math.floor((Number(value) - low) / range * colors.length)))], legend: { title: metric(mapKey).label, gradient: `linear-gradient(180deg, ${[...colors].reverse().join(',')})`, items: [[fmt(high), 'Higher'], [fmt((high + low) / 2), 'Typical'], [fmt(low), 'Lower']] } }
  }, [mapSource, mapKey, catalogue])
  const selectRegion = name => {
    const canonical = meta?.regions.find(region => normaliseDistrictName(region) === normaliseDistrictName(name))
    if (canonical) { const next = { ...applied, region: canonical }; setDraft(next); setApplied(next) }
  }
  const line = (key, color, label) => ({ key, label: label || metric(key).label, unit: metric(key).unit, color })
  const latest = result?.latest || {}
  const categories = useMemo(() => Object.fromEntries(['Physical', 'Chemical', 'Biological', 'SANSA remote sensing'].map(category => [category, (meta?.metrics || []).filter(item => item.category === category)])), [meta])
  const chemicalItems = useMemo(() => ['Chemical', 'Nutrients', 'Metals', 'Organic', 'Inorganic'].flatMap(category => (meta?.metrics || []).filter(item => item.category === category)), [meta])
  const kpis = [
    ['ph', 'pH', FlaskConical, 'chemical'], ['dissolved_oxygen_mg_l', 'Dissolved oxygen', Droplets, 'chemical'], ['turbidity_ntu', 'Turbidity', Activity, 'physical'],
    ['electrical_conductivity_ms_m', 'Electrical conductivity', Activity, 'physical'], ['ecoli_cfu_100ml', 'E. coli', ShieldCheck, 'biological'], ['cyanobacterial_bloom_index', 'Cyanobacterial bloom', Satellite, 'sansa'],
  ]
  const exportData = () => { if (!result) return; const keys = result.variables; downloadCSV(`NIWIS-water-quality-${result.region.replaceAll(' ', '-')}-${result.start}-${result.end}.csv`, ['Region', 'Year', ...keys.map(key => `${metric(key).label} (${metric(key).unit})`)], result.series.map(row => [result.region, row.year, ...keys.map(key => row[key])])) }

  return <div className="rainfall-dashboard water-quality-dashboard">
    <div className="rf-heading"><span className="rf-heading-icon quality-icon"><ShieldCheck size={31} /></span><div><span className="rf-eyebrow">NIWIS / DWS SECTION 12</span><h1>Water Quality Monitoring Network</h1><p>Physical, chemical, biological and SANSA water-quality observations across South Africa</p></div><button className="rf-export" onClick={exportData} disabled={!result || loading}><Download size={15} /> Export annual data</button></div>
    <form className="rf-filters" onSubmit={event => { event.preventDefault(); setApplied({ ...draft }) }}><label className="rf-region">Region / District<select aria-label="Water quality region" disabled={!meta} value={draft.region} onChange={event => setDraft({ ...draft, region: event.target.value })}><option value="National">South Africa (district average)</option>{meta?.regions.map(region => <option key={region}>{region}</option>)}</select></label><label>From year<select aria-label="Water quality start year" value={draft.start} disabled={!meta} onChange={event => setDraft({ ...draft, start: Number(event.target.value) })}>{meta?.years.map(year => <option key={year}>{year}</option>)}</select></label><label>To year<select aria-label="Water quality end year" value={draft.end} disabled={!meta} onChange={event => setDraft({ ...draft, end: Number(event.target.value) })}>{meta?.years.map(year => <option key={year}>{year}</option>)}</select></label><button className="rf-apply" disabled={loading || !meta || draft.start > draft.end}>Apply filters</button></form>
    {loading && <LoadingProgress className="rf-loading" message="Combining physical, chemical, biological and SANSA observations" />}
    {error && <div className="rf-error" role="alert">{error}<button onClick={() => meta ? setApplied({ ...applied }) : setRetry(retry + 1)}>Retry</button></div>}
    {result && <>
      <div className="rf-context"><span><MapPin size={13} /><strong>{result.region === 'National' ? 'South Africa · district average' : result.region}</strong> · {result.start} – {result.end}</span><span>Source coverage {result.source_coverage.first_date} to {result.source_coverage.last_date}</span></div>
      <div className="wq-source-strip"><span><Activity size={15} /><strong>Physical</strong> Section 12.1</span><span><FlaskConical size={15} /><strong>Chemical</strong> Section 12.2</span><span><ShieldCheck size={15} /><strong>Biological</strong> Section 12.3</span><span><Satellite size={15} /><strong>SANSA</strong> Section 12.4</span><small>District/month observations · no station interpolation</small></div>
      <div className="wq-definition"><strong>Monitoring scope</strong><span>Laboratory and in-situ variables are shown alongside SANSA remote-sensing proxies. Values remain in their supplied units; no regulatory pass/fail status is inferred.</span></div>
      {result.warnings.map(warning => <div className="wq-warning" key={warning}><Info size={15} /><span>{warning}</span></div>)}
      <div className="rf-kpis">{kpis.map(([key, label, Icon, theme]) => <div className={`rf-kpi ${theme}`} key={key}><Icon size={25} /><div><span>{label}</span><strong>{fmt(latest[key], key.includes('ph') ? 2 : 1)}<small>{metric(key).unit}</small></strong><p>{result.end} · {metric(key).category}</p></div></div>)}</div>
      <div className="rf-primary-grid"><Panel title="Water quality across South Africa" note={`${mapYear || result.end} · district values`} className="rf-map-panel"><div className="rf-map-controls"><select aria-label="Water quality map indicator" value={mapKey} onChange={event => setMapKey(event.target.value)}>{['ph', 'turbidity_ntu', 'electrical_conductivity_ms_m', 'nitrate_mg_l', 'ecoli_cfu_100ml', 'cyanobacterial_bloom_index'].map(key => <option key={key} value={key}>{metric(key).label} ({metric(key).unit})</option>)}</select><label>Map year<select aria-label="Water quality map year" value={mapYear || result.end} onChange={event => setMapYear(event.target.value)}>{result.series.map(row => <option key={row.year}>{row.year}</option>)}</select></label></div>{features.length ? <DistrictMap districts={features} values={mapValues} valueKey={mapKey} colorFn={scale.color} selected={result.region === 'National' ? null : result.region} onSelect={selectRegion} legend={scale.legend} /> : <div className="wq-map-empty">District boundaries are unavailable. Use the region selector above.</div>}<div className="rf-map-footer"><MapPin size={12} /> Select a district to explore its water quality <span>52 districts · annual end-year values</span></div></Panel><Panel title="Selected indicator over time" note="Annual district means"><div className="wq-chart-select"><label>Indicator<select aria-label="Water quality trend indicator" value={trendKey} onChange={event => setTrendKey(event.target.value)}>{['ph', 'dissolved_oxygen_mg_l', 'turbidity_ntu', 'nitrate_mg_l', 'ecoli_cfu_100ml', 'cyanobacterial_bloom_index'].map(key => <option key={key} value={key}>{metric(key).label}</option>)}</select></label></div><Chart data={result.series} x="year" metrics={[line(trendKey, '#3c91b5')]} height={300} /></Panel></div>
      <div className="rf-three-grid"><Panel title="Physical parameters" note="Section 12.1 · supplied units"><div className="wq-chart-select"><label>Indicator<select aria-label="Physical water quality indicator" value={physicalKey} onChange={event => setPhysicalKey(event.target.value)}>{categories.Physical?.map(item => <option key={item.key} value={item.key}>{item.label}</option>)}</select></label></div><Chart data={result.series} x="year" metrics={[line(physicalKey, '#3c91b5')]} height={220} /></Panel><Panel title="Chemical parameters" note="Section 12.2 · supplied units"><div className="wq-chart-select"><label>Indicator<select aria-label="Chemical water quality indicator" value={chemicalKey} onChange={event => setChemicalKey(event.target.value)}>{chemicalItems.map(item => <option key={item.key} value={item.key}>{item.label}</option>)}</select></label></div><Chart data={result.series} x="year" metrics={[line(chemicalKey, '#6d9a72')]} height={220} /></Panel><Panel title="Biological parameters" note="Section 12.3 · supplied units"><div className="wq-chart-select"><label>Indicator<select aria-label="Biological water quality indicator" value={biologicalKey} onChange={event => setBiologicalKey(event.target.value)}>{categories.Biological?.map(item => <option key={item.key} value={item.key}>{item.label}</option>)}</select></label></div><Chart data={result.series} x="year" metrics={[line(biologicalKey, '#b27562')]} height={220} /></Panel></div>
      <div className="rf-three-grid"><Panel title="SANSA remote-sensing proxies" note="Section 12.4 · not laboratory results"><div className="wq-chart-select"><label>Indicator<select aria-label="SANSA water quality indicator" value={sansaKey} onChange={event => setSansaKey(event.target.value)}>{categories['SANSA remote sensing']?.map(item => <option key={item.key} value={item.key}>{item.label}</option>)}</select></label></div><Chart data={result.series} x="year" metrics={[line(sansaKey, '#8b78a8')]} height={220} /><p className="rf-footnote">Proxy values are retained separately from in-situ and laboratory observations.</p></Panel><Panel title="Coverage and data quality" note="Checks on Supabase relations"><div className="wq-quality"><strong>{result.source_coverage.districts}</strong><span>districts represented</span><strong>{result.quality.complete_rows.toLocaleString()}</strong><span>complete district-month rows in selection</span><strong>{result.quality.missing_values.toLocaleString()}</strong><span>missing numeric cells</span></div><p className="rf-footnote">The relations provide district averages rather than station-level provenance or coordinates.</p></Panel><Panel title="Monthly detail" note={`${result.end} · ${result.region}`}><div className="wq-monthly-status">{monthlyError ? <span role="alert">{monthlyError}</span> : monthly ? <><strong>{monthly.series.length}</strong><span>months available in the selected year</span></> : <span>Loading monthly detail…</span>}</div>{monthly && <Chart data={monthly.series} x="period" metrics={[line(trendKey, '#3c91b5')]} height={220} />}</Panel></div>
      <details className="rf-methods"><summary>Source tables, network scope and calculation notes</summary><p><strong>Section 12.1:</strong> {meta.files[0]} ({(meta.rows.physical?.toLocaleString() ?? 'Not counted')} rows) supplies physical parameters. <strong>Section 12.2:</strong> {meta.files[1]} ({(meta.rows.chemical?.toLocaleString() ?? 'Not counted')} rows) supplies chemical and nutrient parameters. <strong>Section 12.3:</strong> {meta.files[2]} ({(meta.rows.biological?.toLocaleString() ?? 'Not counted')} rows) supplies biological parameters. <strong>Section 12.4:</strong> {meta.files[3]} ({(meta.rows.sansa?.toLocaleString() ?? 'Not counted')} rows) supplies SANSA proxies.</p><p>Annual values are district means of the supplied monthly observations. National values are equal-weight district means. Repeated source variables are not converted to regulatory classifications because no threshold set, sampling-site inventory or quality standard metadata is supplied.</p></details>
      <div className="rf-footer"><strong><ShieldCheck size={15} /> NIWIS <span>Water quality intelligence</span></strong><span>52 districts · Sections 12.1–12.4 · Source through {result.source_coverage.last_date}</span></div>
    </>}
  </div>
}
