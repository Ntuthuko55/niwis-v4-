import { useEffect, useMemo, useState } from 'react'
import { Activity, AlertTriangle, Download, Leaf, MapPin, RefreshCw, Waves } from 'lucide-react'
import { dashboardFetch as fetch } from '../services/dashboardFetch'
import { DistrictMap, normaliseDistrictName } from './DistrictMap'
import WastewaterChart, { WastewaterSparkline } from './WastewaterChart'
import LoadingProgress from './LoadingProgress'
import '../niwis/rwqo.css'

const COLORS = { ecological: '#64dfbc', chemical: '#80bdff', hydrological: '#c0abff' }
const valid = value => typeof value === 'number' && Number.isFinite(value)
const format = (value, digits = 2) => valid(value) ? value.toLocaleString('en-ZA', { maximumFractionDigits: Math.abs(value) > 0 && Math.abs(value) < 1 ? Math.min(8, 2 - Math.floor(Math.log10(Math.abs(value)))) : digits }) : '—'
const period = value => /^\d{4}-\d{2}$/.test(value || '') ? new Date(`${value}-15T12:00:00`).toLocaleDateString('en-ZA', { month: 'short', year: 'numeric' }) : value || 'No observations'

async function getJSON(url, signal) {
  const response = await fetch(url, { signal })
  const body = await response.json()
  if (!response.ok) throw new Error(typeof body.detail === 'string' ? body.detail : `RWQO request failed (HTTP ${response.status}).`)
  return body
}

function Panel({ title, subtitle, children, className = '', action }) {
  return <section className={`rq-panel ${className}`} aria-label={title}><header className="rq-panel-heading"><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>{action}</header>{children}</section>
}

function MetricChart({ title, choices, preferred, rows, xKey, color }) {
  const [selected, setSelected] = useState(preferred || choices[0]?.key)
  const [type, setType] = useState('area')
  const metric = choices.find(item => item.key === selected) || choices[0]
  const latest = rows.filter(row => valid(row[metric?.key])).at(-1)
  const lines = []
  if (valid(metric?.min)) lines.push({ value: metric.min, label: 'Source minimum' })
  if (valid(metric?.max)) lines.push({ value: metric.max, label: 'Source maximum' })
  return <Panel title={title} subtitle="Source measurements in their supplied units" className="rq-metric-panel">
    <div className="rq-chart-controls"><label>Indicator<select aria-label={`${title} indicator`} value={metric?.key || ''} onChange={event => setSelected(event.target.value)}>{choices.map(item => <option key={item.key} value={item.key}>{item.label}</option>)}</select></label><label>Chart<select aria-label={`${title} chart style`} value={type} onChange={event => setType(event.target.value)}><option value="area">Area</option><option value="line">Line</option><option value="bar">Bars</option></select></label></div>
    <div className="rq-readout"><div><strong style={{ color }}>{format(latest?.[metric?.key])}<small>{metric?.unit}</small></strong><span>{latest ? `${period(String(latest[xKey]))} ${xKey === 'year' ? 'mean' : 'mean observation'}` : 'No numeric observations'}</span></div>{metric?.limit && <span className="rq-target">Source target: {metric.limit}</span>}</div>
    <WastewaterChart data={rows} metrics={metric ? [{ ...metric, color }] : []} xKey={xKey} type={type} height={250} yLabel={metric?.unit} referenceLines={lines} referenceBand={valid(metric?.min) && valid(metric?.max) ? { min: metric.min, max: metric.max } : null} />
    <p className="rq-note">{metric?.objective === 'Nutrient' ? 'TN and TP share one stored nutrient flag. The DIN limit is not applied to TN.' : metric?.limit ? 'Reference lines use the target stored in the source, where a single numeric rule is available.' : 'No ecological target or compliance flag is supplied. Source indices retain their original scale.'}</p>
  </Panel>
}

function exportCSV(result, meta) {
  const escape = value => `"${String(value ?? '').replaceAll('"', '""')}"`
  const header = ['Region', 'Section', 'Period', 'Indicator', 'Value', 'Unit', 'Source target', 'Source table']
  const rows = meta.sections.flatMap(section => result.sections[section.key].monthly.flatMap(row => section.indicators.map(item => [result.region, section.label, row.period, item.label, row[item.key], item.unit, item.limit, section.audit.table])))
  const blob = new Blob(['\uFEFF' + [header, ...rows].map(row => row.map(escape).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' })
  const anchor = document.createElement('a')
  anchor.href = URL.createObjectURL(blob); anchor.download = `NIWIS-RWQO-${result.region.replaceAll(' ', '-')}-${result.start}-${result.end}.csv`; anchor.click()
  setTimeout(() => URL.revokeObjectURL(anchor.href), 800)
}

export default function ResourceWaterQualityObjectives() {
  const [meta, setMeta] = useState(null), [result, setResult] = useState(null), [features, setFeatures] = useState([])
  const [draft, setDraft] = useState({ region: 'National', start: '', end: '' }), [applied, setApplied] = useState(null)
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [retry, setRetry] = useState(0)
  const [sectionKey, setSectionKey] = useState('ecological'), [cadence, setCadence] = useState('annual')
  const [mapKey, setMapKey] = useState('sass5_score'), [mapError, setMapError] = useState(''), [showAll, setShowAll] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setError(''); setMeta(null); setResult(null); setApplied(null); setMapError('')
    getJSON('/api/rwqo/metadata', controller.signal).then(data => {
      if (controller.signal.aborted) return
      setMeta(data)
      const initial = { region: 'National', start: data.default_start, end: data.default_end }
      setDraft(initial); setApplied(initial)
    }).catch(err => { if (!controller.signal.aborted) { setError(err.message); setLoading(false) } })
    getJSON('/south_africa_adm2.display.geojson', controller.signal).then(data => { if (!controller.signal.aborted) setFeatures(data.features || []) }).catch(() => {
      if (!controller.signal.aborted) { setFeatures([]); setMapError('District boundaries could not be loaded. Use the district selector to explore the data.') }
    })
    return () => controller.abort()
  }, [retry])

  useEffect(() => {
    if (!applied) return undefined
    const controller = new AbortController()
    setLoading(true); setError(''); setResult(null)
    getJSON(`/api/rwqo/dashboard?${new URLSearchParams(applied)}`, controller.signal).then(data => { if (!controller.signal.aborted) setResult(data) }).catch(err => {
      if (!controller.signal.aborted) setError(err.message)
    }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [applied])

  const section = meta?.sections.find(item => item.key === sectionKey)
  const selected = result?.sections[sectionKey]
  const mapMetric = section?.indicators.find(item => item.key === mapKey) || section?.indicators[0]
  const mapValues = useMemo(() => Object.fromEntries((selected?.map || []).map(row => [normaliseDistrictName(row.district_name), row])), [selected])
  const mapScale = useMemo(() => {
    const values = (selected?.map || []).map(row => row[mapMetric?.key]).filter(valid)
    const min = values.length ? Math.min(...values) : 0, max = values.length ? Math.max(...values) : 1
    return { min, max }
  }, [selected, mapMetric])
  const mapColor = value => {
    const fraction = mapScale.max === mapScale.min ? 0.5 : (value - mapScale.min) / (mapScale.max - mapScale.min)
    return fraction < 0.25 ? '#235373' : fraction < 0.5 ? '#298ca5' : fraction < 0.75 ? '#46bfb5' : '#9aead2'
  }
  const selectDistrict = name => {
    const matched = meta.regions.find(item => normaliseDistrictName(item) === normaliseDistrictName(name))
    if (matched) { const next = { ...applied, region: matched }; setDraft(next); setApplied(next) }
  }
  const changeSection = key => { setSectionKey(key); setMapKey(meta.sections.find(item => item.key === key).indicators[0].key); setShowAll(false) }
  const rows = selected ? cadence === 'annual' ? selected.series : selected.monthly : []
  const xKey = cadence === 'annual' ? 'year' : 'period'
  const scoreRows = useMemo(() => {
    const points = new Map()
    for (const [kind, section] of Object.entries(result?.sections || {})) {
      if (kind === 'ecological') continue
      for (const row of cadence === 'annual' ? section.series : section.monthly) {
        const point = points.get(row[xKey]) || { [xKey]: row[xKey] }
        point[`${kind}_score`] = row.reported_score
        points.set(row[xKey], point)
      }
    }
    return [...points.values()].sort((a, b) => String(a[xKey]).localeCompare(String(b[xKey])))
  }, [result, cadence, xKey])
  const alerts = selected?.alerts || []
  const chemical = result?.sections.chemical, hydro = result?.sections.hydrological, eco = result?.sections.ecological
  const negativeValues = (meta?.sections || []).reduce((sum, item) => sum + (item.audit.negative_measurements || 0), 0)
  const kpis = result ? [
    { label: 'SASS5 score', value: eco.latest.sass5_score, unit: 'score', note: period(eco.latest_period), rows: eco.monthly, key: 'sass5_score', color: COLORS.ecological },
    { label: 'Reported chemical score', value: chemical.latest.reported_score, unit: '%', note: period(chemical.latest_period), rows: chemical.monthly, key: 'reported_score', color: COLORS.chemical },
    { label: 'Reported hydrological score', value: hydro.latest.reported_score, unit: '%', note: period(hydro.latest_period), rows: hydro.monthly, key: 'reported_score', color: COLORS.hydrological },
    { label: 'Districts with failed flags', value: new Set([...chemical.alerts, ...hydro.alerts].map(item => item.district_name)).size, unit: 'districts', note: `Chemical ${period(chemical.latest_period)} · hydrological ${period(hydro.latest_period)}`, color: '#f0bd7e' },
  ] : []

  return <div className="rwqo-dashboard">
    <header className="rq-heading"><span className="rq-heading-icon"><Waves size={29} /></span><div><span className="rq-eyebrow">RESOURCE DIRECTED MEASURES / SECTION 15</span><h1>Resource Water Quality Objectives</h1><p>Ecological condition, chemical targets and flow requirements across South Africa.</p></div><button className="rq-export" disabled={!result || loading} onClick={() => exportCSV(result, meta)}><Download size={15} />Export monthly data</button></header>
    <form className="rq-filters" onSubmit={event => { event.preventDefault(); setApplied({ ...draft }) }}>
      <label className="rq-region">District<select aria-label="RWQO region" value={draft.region} disabled={!meta || loading} onChange={event => setDraft({ ...draft, region: event.target.value })}><option value="National">National — South Africa</option>{meta?.regions.map(name => <option key={name}>{name}</option>)}</select></label>
      <label>From year<select aria-label="RWQO start year" value={draft.start} disabled={!meta || loading} onChange={event => setDraft({ ...draft, start: event.target.value })}>{!meta && <option value="">Loading…</option>}{meta?.years.map(year => <option key={year}>{year}</option>)}</select></label>
      <label>To year<select aria-label="RWQO end year" value={draft.end} disabled={!meta || loading} onChange={event => setDraft({ ...draft, end: event.target.value })}>{!meta && <option value="">Loading…</option>}{meta?.years.map(year => <option key={year}>{year}</option>)}</select></label>
      <button className="rq-apply" disabled={!meta || loading}>Apply filters</button><span className="rq-cache"><Activity size={13} />{format((meta?.cache_ttl_seconds || 86400) / 3600, 1)}-hour source &amp; API cache</span>
    </form>
    {error && <div className="rq-error" role="alert"><AlertTriangle size={18} /><span>{error}</span><button onClick={() => setRetry(value => value + 1)}><RefreshCw size={14} />Retry</button></div>}
    {loading && <LoadingProgress className="rq-loading" message="Retrieving RWQO database observations" />}
    {result && !loading && <>
      <div className="rq-context"><strong>{result.region === 'National' ? 'South Africa · National' : result.region}</strong><span>{result.start}–{result.end} · {meta.regions.length} source districts · Supabase district-month records</span></div>
      <div className="rq-source-notice" role="note"><AlertTriangle size={16} /><span><strong>Source data review.</strong> {negativeValues > 0 && `${format(negativeValues, 0)} negative measurement values occur across the full source history. `}The nutrient target names DIN while the measurement column names TN. Values and reported flags are retained as supplied; confirm source units and calibration before interpreting resource compliance.</span></div>
      <div className="rq-kpis">{kpis.map(item => <article className="rq-kpi" key={item.label} style={{ '--rq-accent': item.color }}><span>{item.label}</span><strong>{format(item.value)}<small>{item.unit}</small></strong><div><span>{item.note}</span>{item.rows && <WastewaterSparkline data={item.rows.slice(-24)} metricKey={item.key} label={item.label} color={item.color} />}</div></article>)}</div>
      <div className="rq-tabs" role="group" aria-label="RWQO section">{meta.sections.map(item => <button key={item.key} aria-pressed={sectionKey === item.key} onClick={() => changeSection(item.key)} style={{ '--rq-accent': COLORS[item.key] }}>{item.key === 'ecological' ? <Leaf size={15} /> : item.key === 'hydrological' ? <Waves size={15} /> : <Activity size={15} />}{item.label}<span>{item.indicators.length} measurements</span></button>)}</div>
      <div className="rq-primary-grid">
        <Panel title="District observation map" subtitle={`${period(selected.map_period)} · ${mapMetric.label}`} className="rq-map-panel">
          <label className="rq-picker">Map indicator<select aria-label="RWQO map indicator" value={mapMetric.key} onChange={event => setMapKey(event.target.value)}>{section.indicators.map(item => <option key={item.key} value={item.key}>{item.label}</option>)}</select></label>
          {features.length ? <DistrictMap districts={features} values={mapValues} valueKey={mapMetric.key} selected={result.region} onSelect={selectDistrict} colorFn={mapColor} legend={{ title: mapMetric.unit, gradient: 'linear-gradient(180deg, #9aead2, #46bfb5, #298ca5, #235373)', items: [[format(mapScale.max), 'Higher value'], [format((mapScale.max + mapScale.min) / 2), 'Mid-range'], [format(mapScale.min), 'Lower value'], ['Grey', 'No observation']] }} /> : <p className="rq-empty" role="status">{mapError || 'District boundaries are loading.'}</p>}
          <p className="rq-note"><MapPin size={12} />Select a district to update the charts. The map keeps national coverage. Colour shows measurement magnitude.</p>
          {result.region !== 'National' && <button className="rq-text-button" onClick={() => { const next = { ...applied, region: 'National' }; setDraft(next); setApplied(next) }}>Return to National</button>}
        </Panel>
        <Panel title={sectionKey === 'ecological' ? 'Ecological condition over time' : 'Reported objective scores'} subtitle={sectionKey === 'ecological' ? 'SASS5 and FIBI retain their source score scales' : 'Scores are supplied by each source table'}>
          <div className="rq-cadence" role="group" aria-label="RWQO trend cadence">{['annual', 'monthly'].map(value => <button key={value} aria-pressed={cadence === value} onClick={() => setCadence(value)}>{value === 'annual' ? 'Annual' : 'Monthly'}</button>)}</div>
          <WastewaterChart data={sectionKey === 'ecological' ? rows : scoreRows} metrics={sectionKey === 'ecological' ? [{ key: 'sass5_score', label: 'SASS5', unit: 'score', color: COLORS.ecological }, { key: 'fibi', label: 'FIBI', unit: 'score', color: COLORS.hydrological }] : [{ key: 'chemical_score', label: 'Reported chemical score', unit: '%', color: COLORS.chemical }, { key: 'hydrological_score', label: 'Reported hydrological score', unit: '%', color: COLORS.hydrological }]} type="line" height={315} xKey={xKey} />
          <p className="rq-note">National months give each district equal weight. Annual means first average each district’s available months. Missing months remain gaps.</p>
        </Panel>
      </div>
      <div className="rq-section-title"><div><span>INDICATOR EXPLORER</span><h2>{section.label}</h2></div><p>{format(selected.coverage.selected_rows, 0)} selected records · {format(selected.coverage.missing_values, 0)} missing measurements</p></div>
      <div className="rq-chart-grid">{sectionKey === 'ecological' ? <>
        <MetricChart title="Macroinvertebrates & fish" choices={section.indicators.filter(item => ['sass5_score', 'aspt', 'fibi'].includes(item.key))} rows={rows} xKey={xKey} color={COLORS.ecological} />
        <MetricChart title="Habitat & ecological reserve" choices={section.indicators.filter(item => ['riparian_vegetation', 'aquatic_habitat_integrity', 'ecological_reserve_q'].includes(item.key))} rows={rows} xKey={xKey} color={COLORS.hydrological} />
      </> : sectionKey === 'chemical' ? <>
        <MetricChart title="Chemical water quality" choices={section.indicators.filter(item => !['total_nitrogen', 'total_phosphorus'].includes(item.key))} rows={rows} xKey={xKey} color={COLORS.chemical} />
        <MetricChart title="Nutrient objectives" choices={section.indicators.filter(item => ['total_nitrogen', 'total_phosphorus'].includes(item.key))} rows={rows} xKey={xKey} color="#e6be7c" />
      </> : <>
        <MetricChart title="Ecological flow requirements" choices={section.indicators.filter(item => ['low_flow', 'high_flow', 'dilution_flow'].includes(item.key))} rows={rows} xKey={xKey} color={COLORS.hydrological} />
        <MetricChart title="Seasonality & assimilation" choices={section.indicators.filter(item => ['seasonality', 'assimilation_capacity'].includes(item.key))} rows={rows} xKey={xKey} color={COLORS.ecological} />
      </>}</div>
      {selected.compliance.length > 0 && <div className="rq-chart-grid rq-assessment-grid">
        <Panel title="Source flags passing" subtitle="Selected period · one assessment per objective and district-month"><WastewaterChart data={selected.compliance.map(item => ({ ...item, name: item.label.replace(' (shared TN/TP flag)', '') }))} metrics={[{ key: 'pass_pct', label: 'Assessed flags passing', unit: '%', color: COLORS[sectionKey] }]} type="bar" horizontal xKey="name" height={300} /><p className="rq-note">{format(selected.coverage.passed, 0)} passing / {format(selected.coverage.assessed, 0)} assessed flags. Unknown flags or missing measurements are excluded. The nutrient objective counts once.</p></Panel>
        <Panel title="Recent objective checks" subtitle="Passing flags across the last six available calendar months"><div className="rq-table-scroll"><table className="rq-checks"><thead><tr><th>Objective</th>{selected.monthly.slice(-6).map(row => <th key={row.period}>{period(row.period)}</th>)}</tr></thead><tbody>{section.objectives.map(item => <tr key={item.key}><th scope="row">{item.label}</th>{selected.monthly.slice(-6).map(row => { const value = row[`${item.key}_pass_pct`]; return <td key={row.period}><span className={`rq-check ${!valid(value) ? 'missing' : value === 100 ? 'passed' : value === 0 ? 'failed' : 'mixed'}`}>{valid(value) ? `${format(value, 0)}%` : '—'}</span></td> })}</tr>)}</tbody></table></div></Panel>
      </div>}
      {selected.compliance.length > 0 && <Panel title="Latest source-reported failures" subtitle={`${period(selected.latest_period)} · ${alerts.length} failed objective flags`} className="rq-alerts">
        {alerts.length ? <><div className="rq-table-scroll"><table><thead><tr><th>District</th><th>Objective</th><th>Source measurement</th><th>Stored target</th></tr></thead><tbody>{(showAll ? alerts : alerts.slice(0, 10)).map(item => <tr key={`${item.district_name}-${item.objective}`}><td>{item.district_name}</td><td>{item.label}</td><td>{item.values.map(value => `${value.label}: ${format(value.value)} ${value.unit}`).join('; ')}</td><td>{item.limit || 'Not supplied'}</td></tr>)}</tbody></table></div>{alerts.length > 10 && <button className="rq-text-button" onClick={() => setShowAll(value => !value)}>{showAll ? 'Show first 10' : `Show all ${alerts.length} failures`}</button>}</> : <p className="rq-empty">No failed assessed flags in the latest available month. This does not certify reach-level compliance.</p>}
      </Panel>}
      <details className="rq-methods"><summary>Source tables, data checks &amp; assessment method</summary><div className="rq-source-grid">{meta.sections.map(item => <article key={item.key}><strong>{item.label}</strong><code>{item.audit.table}</code><span>{format(item.audit.rows, 0)} records · {item.audit.districts} districts</span><span>{period(item.audit.first_period)} – {period(item.audit.last_period)}</span><span>{item.audit.duplicate_district_months} duplicate keys · {item.audit.missing_district_months} missing district-months · {item.audit.missing_values} missing values</span><span>{format(item.audit.negative_measurements, 0)} negative measurements</span></article>)}</div><ul>{meta.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul><p>Successful data and API results use the shared {format(meta.cache_ttl_seconds / 3600, 0)}-hour memory cache. Restarts and capacity eviction can clear it sooner. Source failures are retried and are not cached.</p><p>Habitat and vegetation columns do not identify a calibrated IHAS protocol or index scale. Toxicant rows contain an aggregate value without individual compound identifiers. Reference agencies for ecological variables come from the supplied requirements.</p></details>
    </>}
  </div>
}
