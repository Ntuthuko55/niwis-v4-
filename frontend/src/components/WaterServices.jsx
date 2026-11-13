import { chartColor } from '../lib/chartTheme'
import { useEffect, useMemo, useState } from 'react'
import { Activity, AlertTriangle, Building2, Download, Droplets, RefreshCw, Satellite, ShieldCheck } from 'lucide-react'
import { dashboardFetch as fetch } from '../services/dashboardFetch'
import { buildDistrictMapScale, DistrictMap, normaliseDistrictName } from './DistrictMap'
import WastewaterChart, { WastewaterSparkline } from './WastewaterChart'
import LoadingProgress from './LoadingProgress'
import MonitoringMapPanel from './MonitoringMapPanel'
import '../niwis/rwqo.css'
import '../niwis/water-services.css'

const ALL = '__all__'
const COLORS = ['#6ce0c0', '#80bdff', '#ecc784', '#c0abff']
const TABS = [['access', 'Access & Coverage', Droplets], ['operations', 'Infrastructure Operations', Building2], ['eo', 'SANSA Support', Satellite], ['reliability', 'Supply Reliability', ShieldCheck]]
const valid = value => typeof value === 'number' && Number.isFinite(value)
const format = value => valid(value) ? value.toLocaleString('en-ZA', { maximumFractionDigits: 2 }) : '—'
const defaultFilters = (meta, section, reliability = false) => ({ section, region: meta.default_region, category: section === 'access' ? reliability && meta.categories.includes('Urban') ? 'Urban' : 'Total' : 'All', start: meta.default_start, end: meta.default_end })

async function getJSON(url, signal) {
  const response = await fetch(url, { signal, ...(url.endsWith('/metadata') ? { cache: 'no-store' } : {}) })
  const body = await response.json()
  if (!response.ok) throw new Error(typeof body.detail === 'string' ? body.detail : `Water services request failed (HTTP ${response.status}).`)
  return body
}

function Panel({ title, subtitle, children, className = '' }) {
  return <section className={`rq-panel ${className}`} aria-label={title}><header className="rq-panel-heading"><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div></header>{children}</section>
}

function IndicatorChart({ title, choices, result, color }) {
  const [key, setKey] = useState(choices[0]?.key), [type, setType] = useState('line')
  const metric = choices.find(item => item.key === key) || choices[0]
  return <Panel title={title} subtitle={result.scope} className="ws-indicator-panel">
    <div className="rq-chart-controls"><label>Indicator<select aria-label={`${title} indicator`} value={metric?.key || ''} onChange={event => setKey(event.target.value)}>{choices.map(item => <option key={item.key} value={item.key}>{item.label} ({item.unit})</option>)}</select></label><label>Chart<select aria-label={`${title} chart style`} value={type} onChange={event => setType(event.target.value)}><option value="line">Line</option><option value="area">Area</option><option value="bar">Bars</option></select></label></div>
    <div className="rq-readout"><div><strong style={{ color: chartColor(color) }}>{format(result.latest[metric?.key])}<small>{metric?.unit}</small></strong><span>{result.end} · {result.latest_counts[metric?.key] || 0} usable regional values</span></div></div>
    <WastewaterChart data={result.series} metrics={metric ? [{ ...metric, color }] : []} type={type} height={250} yLabel={metric?.unit} />
  </Panel>
}

function Comparison({ result, meta }) {
  const [key, setKey] = useState(meta.indicators[0]?.key), [search, setSearch] = useState(''), [page, setPage] = useState(0)
  const metric = meta.indicators.find(item => item.key === key) || meta.indicators[0]
  const rows = useMemo(() => result.comparison.filter(row => row.region.toLowerCase().includes(search.toLowerCase())).sort((a, b) => (b[metric.key] ?? -Infinity) - (a[metric.key] ?? -Infinity) || a.region.localeCompare(b.region)), [result, search, metric])
  const last = Math.max(0, Math.ceil(rows.length / 10) - 1), current = Math.min(page, last)
  return <Panel title="Regional comparison" subtitle={`${result.end} · ${result.category} · source regions kept separate`} className="ws-comparison">
    <div className="ws-comparison-controls"><label className="rq-picker">Compare indicator<select aria-label="Water services comparison indicator" value={metric.key} onChange={event => { setKey(event.target.value); setPage(0) }}>{meta.indicators.map(item => <option key={item.key} value={item.key}>{item.label} ({item.unit})</option>)}</select></label><label className="rq-picker">Find a source region<input aria-label="Find a source region" value={search} placeholder="Search regions…" onChange={event => { setSearch(event.target.value); setPage(0) }} /></label></div>
    <div className="rq-table-scroll"><table><thead><tr><th>Source region</th><th>{metric.label}</th><th>Reporting label</th></tr></thead><tbody>{rows.slice(current * 10, current * 10 + 10).map(row => <tr key={row.region}><td>{row.region}</td><td>{format(row[metric.key])} <span className="ws-unit">{metric.unit}</span></td><td>{row.source_period || 'Not supplied for selected year'}</td></tr>)}</tbody></table></div>
    {!rows.length && <p className="rq-empty">No regions match this search.</p>}
    <div className="ws-pagination"><span>{rows.length} source regions · {result.comparison_note}</span><button disabled={current === 0} onClick={() => setPage(current - 1)}>Previous</button><span>{current + 1} / {last + 1}</span><button disabled={current >= last} onClick={() => setPage(current + 1)}>Next</button></div>
  </Panel>
}

function exportCSV(result, meta) {
  const escape = value => `"${String(value ?? '').replaceAll('"', '""')}"`
  const rows = result.series.flatMap(row => meta.indicators.map(metric => [result.scope, result.category, row.year, row.source_periods, metric.label, row[metric.key], metric.unit, result.coverage.find(item => item.year === row.year)?.[metric.key], result.table, metric.source_column, result.aggregation]))
  const content = [['Scope', 'Category', 'Year', 'Source reporting labels', 'Indicator', 'Value', 'Unit', 'Usable regional values', 'Source table', 'Source column', 'Aggregation'], ...rows].map(row => row.map(escape).join(',')).join('\r\n')
  const url = URL.createObjectURL(new Blob(['\uFEFF' + content], { type: 'text/csv;charset=utf-8' }))
  const anchor = document.createElement('a')
  const scope = result.region === ALL ? 'all-regions' : result.region.trim().replaceAll(/\s+/g, '-')
  anchor.href = url; anchor.download = `NIWIS-water-services-${result.section}-${scope}-${result.category}-${result.start}-${result.end}.csv`; anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 800)
}

export default function WaterServices({ section: navigationSection = null }) {
  const [meta, setMeta] = useState(null), [result, setResult] = useState(null), [features, setFeatures] = useState([])
  const [tab, setTab] = useState('access'), [draft, setDraft] = useState(null), [applied, setApplied] = useState(null)
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [retry, setRetry] = useState(0), [mapError, setMapError] = useState('')
  const [mapKey, setMapKey] = useState('reservoir'), [mapYear, setMapYear] = useState(''), [mapNotice, setMapNotice] = useState('')
  const section = tab === 'reliability' ? 'access' : tab
  const source = meta?.sections[section]

  useEffect(() => {
    const controller = new AbortController()
    setMeta(null); setResult(null); setApplied(null); setLoading(true); setError('')
    getJSON('/api/water-services/metadata', controller.signal).then(data => {
      if (controller.signal.aborted) return
      setMeta(data)
      const first = data.sections.access ? 'access' : Object.keys(data.sections)[0]
      setTab(first)
      const initial = defaultFilters(data.sections[first], first)
      setDraft(initial); setApplied(initial)
    }).catch(err => { if (!controller.signal.aborted) { setError(err.message); setLoading(false) } })
    return () => controller.abort()
  }, [retry])

  useEffect(() => {
    const controller = new AbortController()
    getJSON('/south_africa_adm2.display.geojson', controller.signal).then(data => { if (!controller.signal.aborted) setFeatures(data.features || []) }).catch(() => {
      if (!controller.signal.aborted) setMapError('District boundaries could not be loaded. The district selector and comparisons remain available.')
    })
    return () => controller.abort()
  }, [retry])

  useEffect(() => {
    if (!applied) return undefined
    const controller = new AbortController()
    setLoading(true); setError(''); setResult(null)
    getJSON(`/api/water-services/dashboard?${new URLSearchParams(applied)}`, controller.signal).then(data => { if (!controller.signal.aborted) setResult(data) }).catch(err => {
      if (!controller.signal.aborted) setError(err.message)
    }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [applied])

  const changeTab = next => {
    setTab(next); setMapNotice(''); setResult(null); setError('')
    const kind = next === 'reliability' ? 'access' : next
    if (!meta?.sections[kind]) { setApplied(null); setLoading(false); return }
    const initial = defaultFilters(meta.sections[kind], kind, next === 'reliability')
    setDraft(initial); setApplied(initial)
  }
  useEffect(() => {
    if (!meta || !navigationSection) return
    const target = navigationSection === 'sansa' ? 'eo' : navigationSection
    if (['access', 'operations', 'eo', 'reliability'].includes(target) && target !== tab) changeTab(target)
  }, [meta, navigationSection])
  const mapIndicators = (source?.indicators || []).filter(item => tab !== 'reliability' || item.group === 'Reliability')
  const mapMetric = mapIndicators.find(item => item.key === mapKey) || mapIndicators[0]
  const mapHistory = result?.map_history || {}
  const mapYears = Object.keys(mapHistory).sort((a, b) => Number(a) - Number(b))
  const activeMapYear = mapYears.includes(mapYear) ? mapYear : String(result?.end || '')
  const mapRows = mapHistory[activeMapYear] || result?.comparison || []
  const mapValues = useMemo(() => Object.fromEntries(mapRows.map(row => [normaliseDistrictName(row.region), row])), [mapRows])
  const mapScale = useMemo(() => buildDistrictMapScale(mapRows, mapKey, mapMetric?.label, mapMetric?.unit, format, features.length), [mapRows, mapKey, mapMetric, features.length])
  const selectDistrict = name => {
    const region = source.regions.find(item => normaliseDistrictName(item) === normaliseDistrictName(name))
    if (!region) { setMapNotice(`No source records match ${name}.`); return }
    const next = { ...applied, region }; setDraft(next); setApplied(next); setMapNotice('')
  }
  const kpiKeys = tab === 'access' ? ['dwelling_pct', 'yard_pct', 'standpipe_pct', 'backlog_households'] : tab === 'operations' ? ['production', 'nrw_pct', 'interruptions', 'outage_duration'] : tab === 'eo' ? ['settlement', 'informal', 'reservoir', 'deficit'] : ['reliable_pct', 'reliable_households', 'rdp_pct', 'backlog_pct']
  const chartGroups = source ? [...new Set(source.indicators.map(item => item.group))].filter(group => tab === 'reliability' ? group === 'Reliability' : tab === 'access' ? group !== 'Reliability' : true) : []
  const chartMetrics = keys => source.indicators.filter(item => keys.includes(item.key)).map((item, index) => ({ ...item, color: COLORS[index % COLORS.length] }))
  const scopeLabel = result?.scope || ''
  const coverage = source?.category_coverage.find(item => item.category === draft?.category)

  return <div className="rwqo-dashboard water-services-dashboard">
    <header className="rq-heading"><span className="rq-heading-icon"><Droplets size={29} /></span><div><span className="rq-eyebrow">WATER SERVICES / SECTION 18</span><h1>Water Services, Infrastructure Access and Supply Reliability</h1><p>Household access, operational records and earth observation support for service delivery.</p></div><button className="rq-export" disabled={!result || loading || result.empty} onClick={() => exportCSV(result, source)}><Download size={15} />Export data</button></header>
    <div className="rq-tabs" role="group" aria-label="Water services sections">{TABS.map(([key, label, Icon], index) => <button key={key} aria-pressed={tab === key} onClick={() => changeTab(key)} disabled={!meta || loading} style={{ '--rq-accent': chartColor(COLORS[index]) }}><Icon size={16} />{label}</button>)}</div>
    {source && draft && <form className="rq-filters" onSubmit={event => { event.preventDefault(); setApplied({ ...draft }) }}>
      <label className="rq-region">{section === 'eo' ? 'District' : 'Source region'}<select aria-label="Water services region" value={draft.region} disabled={loading} onChange={event => setDraft({ ...draft, region: event.target.value })}><option value={ALL}>Covered-region mean (unweighted)</option>{source.regions.map(name => <option key={name}>{name}</option>)}</select></label>
      {section === 'access' && <label>Access category<select aria-label="Water services category" value={draft.category} disabled={loading} onChange={event => setDraft({ ...draft, category: event.target.value })}>{source.categories.map(name => <option key={name}>{name}</option>)}</select></label>}
      {['start', 'end'].map(key => <label key={key}>{key === 'start' ? 'From year' : 'To year'}<select aria-label={`Water services ${key} year`} value={draft[key]} disabled={loading} onChange={event => setDraft({ ...draft, [key]: event.target.value })}>{source.years.map(year => <option key={year}>{year}</option>)}</select></label>)}
      <button className="rq-apply" disabled={loading}>Apply filters</button><span className="rq-cache"><Activity size={13} />{format(meta.cache_ttl_seconds / 3600)}-hour retrieval cache</span>
      {section === 'access' && coverage && <p className="ws-filter-note">{draft.category}: {coverage.regions} source regions · {coverage.first_year}–{coverage.last_year}. Categories have different coverage.</p>}
    </form>}
    {(error || (meta && !source)) && <div className="rq-error" role="alert"><AlertTriangle size={18} /><span>{error || meta.errors[section] || 'This source is unavailable.'}</span><button onClick={() => setRetry(value => value + 1)}><RefreshCw size={14} />Retry</button></div>}
    {meta && Object.keys(meta.errors).length > 0 && source && <p className="rq-source-notice" role="status">Some sources are unavailable: {Object.keys(meta.errors).join(', ')}. Available sections remain usable. <button onClick={() => setRetry(value => value + 1)}>Retry sources</button></p>}
    {loading && <LoadingProgress className="rq-loading" message="Retrieving water services database records" />}
    {(error || (meta && !source)) && !loading && <MonitoringMapPanel title="Water services monitoring map" description="The geographic workspace remains available while the selected source is unavailable." indicators={mapIndicators} indicator={mapMetric?.key} onIndicatorChange={setMapKey} features={features.length ? features : undefined} geographyAvailable={false} noDataReason="Water services observations could not be loaded. Boundaries provide geographic context; no service values are displayed." />}
    {result && source && !loading && <>
      <div className="rq-context"><strong>{scopeLabel} · {result.category}</strong><span>{result.start}–{result.end} · {format(result.selected_rows)} source rows · {result.selected_regions} regions</span></div>
      <div className="rq-source-notice" role="note"><AlertTriangle size={16} /><span><strong>Source coverage matters.</strong> {result.aggregation} {section === 'access' ? 'Access categories are not a reconciled household distribution.' : section === 'operations' ? 'Yearly records retain daily-rate units. Missing values stay blank; pressure units remain unresolved.' : 'District summaries do not locate individual pipes, reservoirs or settlements.'}</span></div>
      {result.empty && <p className="rq-empty" role="status">No observations for this region, category and year range. Change the filters to view available records.</p>}
      <div className="rq-kpis">{kpiKeys.map((key, index) => { const metric = source.indicators.find(item => item.key === key); return <article className="rq-kpi" key={key} style={{ '--rq-accent': chartColor(COLORS[index]) }}><span>{metric.label}</span><strong>{format(result.latest[key])}<small>{metric.unit}</small></strong><div><span>{result.end} · {result.latest_counts[key]} usable regional values</span><WastewaterSparkline data={result.series} metricKey={key} label={metric.label} color={COLORS[index]} /></div></article> })}</div>
      <p className="ws-summary-note">Cards show the selected end year ({result.end}); — means no usable measurement. {result.region === ALL ? 'Counts and percentages are regional means, not national totals.' : 'Values retain the selected source region and category.'} {result.latest_source_periods.length ? `Source reporting labels: ${result.latest_source_periods.join(', ')}.` : 'The source reporting label is absent for this selection.'}</p>
      {tab !== 'eo' && <MonitoringMapPanel title={tab === 'operations' ? 'Infrastructure operations map' : tab === 'reliability' ? 'Water supply reliability map' : 'Household water access map'} description={`${result.end} · ${mapMetric?.label || 'Source observations'} · ${result.category}`} indicators={mapIndicators} indicator={mapMetric?.key} onIndicatorChange={setMapKey} period={String(result.end)} features={features.length ? features : undefined} geographyAvailable={false} noDataReason={tab === 'operations' ? 'Operational source regions have no verified boundary identifiers or facility coordinates. Infrastructure values are available in the charts and register; district shading and facility locations are unavailable.' : tab === 'reliability' ? 'Reported reliable-water observations are not linked to verified WSA boundaries. Reliability scores and service interruption indices are not supplied, so no geographic reliability classification is inferred.' : 'Access records mix municipalities and districts without stable boundary identifiers or a verified crosswalk. Household observations remain in the charts and source-region selector; geographic access values are unavailable.'} />}
      {tab === 'reliability' ? <>
        <div className="rq-section-title"><div><span>INDICATOR READINESS</span><h2>Supply reliability indicators</h2></div><p>Reported reliable households remain separate from these indices.</p></div>
        <div className="ws-reliability-grid">{meta.reliability.map(item => <article className="rq-panel ws-reliability-card" key={item.key}><span className="ws-unavailable">{item.status}</span><h2>{item.label}</h2><p className="ws-unit">{item.unit}</p><p>{item.reason}</p></article>)}</div>
        <p className="rq-source-notice">The selected access category contains reported reliable-water observations where supplied. These records do not establish Constitutional or SDG 6 compliance, and no composite reliability score has been inferred.</p>
      </> : tab === 'eo' ? <div className="rq-primary-grid">
        <Panel title="SANSA district observations" subtitle={`${activeMapYear} · ${mapMetric?.label}`} className="rq-map-panel">
          <DistrictMap districts={features.length ? features : undefined} values={mapValues} valueKey={mapKey} indicatorOptions={source.indicators} indicatorValue={mapKey} onIndicatorChange={setMapKey} selected={result.region} onSelect={selectDistrict} colorFn={mapScale.color} legend={mapScale.legend} valueLabel={mapMetric?.label} valueUnit={mapMetric?.unit} formatValue={format} />
          <p className="rq-note">All 52 district boundaries remain visible. Four equal-width numeric bands use that year’s observed minimum and maximum; one band means districts report the same value. The legend gives units and the caption shows each district value. The source does not supply risk thresholds, so this is not a service or drought classification.</p>{mapNotice && <p role="status">{mapNotice}</p>}
          {result.region !== ALL && <button className="rq-text-button" onClick={() => { const next = { ...applied, region: ALL }; setDraft(next); setApplied(next) }}>Return to covered-region mean</button>}
        </Panel><Panel title="Settlement extent over time" subtitle={`${scopeLabel} · km²`}><WastewaterChart data={result.series} metrics={chartMetrics(['settlement', 'informal'])} type="line" height={340} /><p className="rq-note">Informal extent is shown as a separate series; areas are not added together.</p></Panel>
      </div> : <Panel title={tab === 'access' ? 'Household water access over time' : 'Production and physical losses'} subtitle={`${scopeLabel} · ${tab === 'access' ? 'source percentages' : 'm³/day in yearly reporting rows'}`} className="ws-overview-chart"><WastewaterChart data={result.series} metrics={chartMetrics(tab === 'access' ? ['dwelling_pct', 'yard_pct', 'standpipe_pct', 'backlog_pct'] : ['production', 'physical_losses'])} type="line" height={300} /><p className="rq-note">Gaps remain missing. {tab === 'access' ? 'Categories are plotted independently; they may overlap or disagree with household totals.' : 'Reported physical losses are retained as supplied. Recent absent production values are not carried forward.'}</p></Panel>}
      <div className="rq-section-title"><div><span>{tab === 'reliability' ? 'REPORTED HOUSEHOLD RELIABILITY' : 'EXPLORE SOURCE INDICATORS'}</span><h2>{tab === 'reliability' ? 'Available reliability observations' : 'Measurements and trends'}</h2></div><p>Change indicators and chart styles without another source request.</p></div>
      <div className="rq-chart-grid">{chartGroups.map((group, index) => <IndicatorChart key={`${tab}-${group}`} title={group} choices={source.indicators.filter(item => item.group === group)} result={result} color={COLORS[index % COLORS.length]} />)}</div>
      {tab === 'operations' && <Panel title="Pipe age profile" subtitle="Source installation bands for the selected end year; condition ratings are not supplied" className="ws-pipe-panel"><div className="rq-table-scroll"><table><thead><tr><th>Source installation bands</th><th>Regional records</th></tr></thead><tbody>{Object.entries(result.profiles.reduce((groups, row) => { const profile = row.pipe_profile || 'Not supplied'; groups[profile] = (groups[profile] || 0) + 1; return groups }, {})).map(([profile, count]) => <tr key={profile}><td>{profile}</td><td>{count}</td></tr>)}</tbody></table></div>{!result.profiles.length && <p className="rq-empty">No pipe profiles for this selection.</p>}<p className="rq-note">Grouped source text is preserved. Broad bands are not split into invented decade percentages.</p></Panel>}
      {tab !== 'reliability' && <Comparison key={`${section}-${result.category}`} result={result} meta={source} />}
      <Panel title="Selected-year indicator register" subtitle={`${result.end} · ${scopeLabel} · ${result.category}`} className="ws-register"><div className="rq-table-scroll"><table><thead><tr><th>Indicator</th><th>Value</th><th>Unit</th><th>Usable regions</th><th>Reference agency</th></tr></thead><tbody>{source.indicators.map(item => <tr key={item.key}><td>{item.label}</td><td>{format(result.latest[item.key])}</td><td>{item.unit}</td><td>{result.latest_counts[item.key]}</td><td>{item.reference_agency}</td></tr>)}</tbody></table></div><p className="rq-note">Agencies are references from the supplied requirements; field-level provenance and measured versus estimated status are not verified.</p></Panel>
      <details className="ws-audit"><summary>Source coverage, data quality and interpretation</summary><p className="ws-source-name">{source.audit.table}</p><p>{format(source.audit.raw_rows)} source rows · {format(source.audit.rows)} usable reporting rows · {source.audit.regions} regions · {source.audit.first_year}–{source.audit.last_year}</p><p>{source.audit.excluded_description_rows} embedded descriptive rows excluded · {format(source.audit.invalid_measurements)} invalid measurements omitted · {format(source.audit.missing_measurements)} absent measurements across the full source.</p>
        {section === 'access' && <p>{format(source.audit.access_counts_exceed_total_rows)} rows have access counts exceeding total households; {format(source.audit.access_counts_disagree_with_piped_rows)} disagree with the piped-infrastructure count. Values are not forced into a reconciled distribution.</p>}
        {section === 'operations' && <p>{format(source.audit.legacy_nrw_out_of_range_rows)} original NRW percentages fall outside 0–100. Computed NRW is used instead. {format(source.audit.missing_source_period_rows)} rows lack a source reporting label.</p>}
        <ul>{source.notes.map(note => <li key={note}>{note}</li>)}</ul><div className="rq-table-scroll"><table><thead><tr><th>Indicator</th><th>Missing</th><th>Invalid</th><th>Usable</th><th>Last usable year in source</th></tr></thead><tbody>{source.audit.quality.map(item => <tr key={item.key}><td>{item.label}</td><td>{format(item.missing)}</td><td>{format(item.invalid)}</td><td>{format(item.usable)}</td><td>{item.last_year || 'None'}</td></tr>)}</tbody></table></div>
      </details>
    </>}
  </div>
}
