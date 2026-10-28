import { useEffect, useMemo, useState } from 'react'
import { Activity, AlertTriangle, BarChart3, CalendarDays, Download, Droplets, FlaskConical, MapPin, RefreshCw, ShieldCheck } from 'lucide-react'
import { dashboardFetch as fetch } from '../services/dashboardFetch'
import { DistrictMap, normaliseDistrictName } from './DistrictMap'
import WastewaterChart, { WastewaterSparkline } from './WastewaterChart'
import LoadingProgress from './LoadingProgress'
import '../niwis/climate-dashboard.css'
import '../niwis/rainfall-status.css'
import '../niwis/drinking-water.css'

const BLUE = '#76baff', TEAL = '#65dfca', GOLD = '#f5c67e', CORAL = '#f293a2', PURPLE = '#b8a5f8'
const valid = value => typeof value === 'number' && Number.isFinite(value)
const format = (value, digits = 2) => {
  if (!valid(value)) return '\u2014'
  const magnitude = Math.abs(value)
  const precision = digits > 0 && magnitude > 0 && magnitude < 1 ? Math.max(digits, Math.min(8, 2 - Math.floor(Math.log10(magnitude)))) : digits
  return value.toLocaleString('en-ZA', { maximumFractionDigits: precision })
}
const metricPoint = (rows, key) => rows.filter(row => valid(row[key])).at(-1)
const periodLabel = value => /^\d{4}-\d{2}$/.test(String(value)) ? new Date(`${value}-15T12:00:00`).toLocaleDateString('en-ZA', { month: 'short', year: 'numeric' }) : String(value ?? '')

async function getJSON(url, signal) {
  const response = await fetch(url, { signal })
  const body = await response.text()
  let data
  try { data = body ? JSON.parse(body) : {} } catch { throw new Error(body.trim().slice(0, 240) || `Drinking-water service returned HTTP ${response.status}.`) }
  if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : `Drinking-water service returned HTTP ${response.status}.`)
  return data
}

function exportCSV(result, indicators) {
  const escape = value => `"${String(value ?? '').replaceAll('"', '""')}"`
  const rows = [['Region', 'Period', 'Reported compliance score (%)', ...indicators.flatMap(item => [`${item.label} (${item.unit})`, `${item.label} checks passing (%)`])], ...result.monthly.map(row => [result.region, row.period, row.compliance_score, ...indicators.flatMap(item => [row[item.key], row[`${item.key}_pass_pct`]])])]
  const blob = new Blob(['\uFEFF' + rows.map(row => row.map(escape).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' })
  const anchor = document.createElement('a'); anchor.href = URL.createObjectURL(blob); anchor.download = `NIWIS-drinking-water-${result.region.replaceAll(' ', '-')}-${result.start}-${result.end}.csv`; anchor.click()
  setTimeout(() => URL.revokeObjectURL(anchor.href), 800)
}

function Panel({ title, subtitle, icon: Icon = Activity, children, className = '', action }) {
  return <section className={`dw-panel ${className}`} aria-label={title}><header className="dw-panel-heading"><div><span className="dw-panel-icon"><Icon size={17} /></span><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div></div>{action}</header>{children}</section>
}

function SourceTarget({ indicator }) {
  return indicator?.limit ? <span className="dw-target"><i />Source target <strong>{indicator.limit}</strong></span> : null
}

function ReferenceProps(indicator, passing) {
  if (!indicator || passing) return {}
  const min = indicator.min, max = indicator.max
  const lines = []
  if (valid(min)) lines.push({ value: min, label: min === max ? 'Source target' : 'Source minimum', color: GOLD })
  if (valid(max) && max !== min) lines.push({ value: max, label: 'Source maximum', color: GOLD })
  return { referenceLines: lines, referenceBand: valid(min) && valid(max) && min < max ? { min, max, color: TEAL } : null }
}

function ParameterPanel({ title, subtitle, choices, preferred, rows, xKey, color = BLUE, label, passing = false, allowView = false, icon }) {
  const [selected, setSelected] = useState(preferred), [view, setView] = useState('value')
  const indicator = choices.find(item => item.key === selected) || choices[0]
  const rate = passing || (allowView && view === 'passing')
  const key = rate ? `${indicator?.key}_pass_pct` : indicator?.key
  const point = metricPoint(rows, key)
  const metric = indicator ? { key, label: rate ? `${indicator.label} checks passing` : indicator.label, unit: rate ? '%' : indicator.unit, color } : null
  return <Panel title={title} subtitle={subtitle} icon={icon} className="dw-chart-panel">
    <div className="dw-parameter-controls"><label className="dw-picker"><span>Parameter</span><select aria-label={label || `${title} parameter`} value={indicator?.key || ''} onChange={event => setSelected(event.target.value)}>{choices.map(item => <option key={item.key} value={item.key}>{item.label}</option>)}</select></label>{allowView && <div className="dw-switch" role="group" aria-label="Parameter chart view"><button type="button" aria-pressed={view === 'value'} onClick={() => setView('value')}>Measured value</button><button type="button" aria-pressed={view === 'passing'} onClick={() => setView('passing')}>Checks passing</button></div>}</div>
    <div className="dw-readout"><div><strong style={{ color }}>{format(point?.[key])}<small>{metric?.unit}</small></strong><span>{point ? `${periodLabel(point[xKey])} ${xKey === 'year' ? 'mean' : 'district observation mean'}` : 'No observations in this period'}</span></div><SourceTarget indicator={indicator} /></div>
    <WastewaterChart data={rows} metrics={metric ? [metric] : []} xKey={xKey} type={rate ? 'bar' : 'area'} height={245} yLabel={metric?.unit} {...ReferenceProps(indicator, rate)} />
    <p className="dw-chart-note">{rate ? 'Passing percentage uses the stored flags for assessed district records.' : 'Dashed references use the limits stored in the supplied table.'}</p>
  </Panel>
}

function MonthlyMatrix({ monthly, indicators }) {
  const months = monthly.slice(-12)
  return <Panel title="Recent parameter checks" subtitle="Passing percentages across the last 12 available months" icon={CalendarDays} className="dw-matrix-panel">
    <div className="dw-matrix-scroll" tabIndex={0} aria-label="Monthly parameter compliance matrix"><div className="dw-matrix" style={{ '--dw-months': months.length || 1 }}><span className="dw-matrix-title">Parameter</span>{months.map(row => <span className="dw-matrix-month" key={row.period}>{periodLabel(row.period)}</span>)}{indicators.map(item => <div className="dw-matrix-row" key={item.key}><span className="dw-matrix-label">{item.label}</span>{months.map(row => {
      const value = row[`${item.key}_pass_pct`], state = !valid(value) ? 'missing' : value === 100 ? 'passed' : value > 0 ? 'mixed' : 'failed'
      const text = `${item.label}, ${periodLabel(row.period)}: ${valid(value) ? `${format(value, 1)}% of reported checks passing` : 'no assessed observations'}`
      return <span className={`dw-matrix-cell ${state}`} key={row.period} role="img" aria-label={text} title={text}>{valid(value) ? `${format(value, 0)}%` : '\u2014'}</span>
    })}</div>)}</div></div><div className="dw-matrix-legend"><span><i className="passed" />All reported checks pass</span><span><i className="mixed" />Some checks fail</span><span><i className="failed" />No reported checks pass</span><span><i className="missing" />Not assessed</span></div>
  </Panel>
}

export default function DrinkingWaterCompliance() {
  const [meta, setMeta] = useState(null), [result, setResult] = useState(null), [features, setFeatures] = useState([])
  const [draft, setDraft] = useState({ region: 'National', start: '', end: '' }), [applied, setApplied] = useState(null)
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [retry, setRetry] = useState(0)
  const [mapKey, setMapKey] = useState('compliance_score'), [cadence, setCadence] = useState('annual'), [allAlerts, setAllAlerts] = useState(false)

  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError('')
    Promise.all([getJSON('/api/drinking-water/metadata', controller.signal), getJSON('/south_africa_adm2.display.geojson', controller.signal).catch(() => ({ features: [] }))]).then(([data, boundaries]) => {
      setMeta(data); setFeatures(boundaries.features || [])
      const initial = { region: 'National', start: data.default_start, end: data.default_end }
      setDraft(initial); setApplied(initial)
    }).catch(err => { if (err.name !== 'AbortError') { setError(err.message); setLoading(false) } })
    return () => controller.abort()
  }, [retry])

  useEffect(() => {
    if (!applied) return undefined
    const controller = new AbortController(); setLoading(true); setError(''); setResult(null)
    getJSON(`/api/drinking-water/dashboard?${new URLSearchParams(applied)}`, controller.signal).then(setResult).catch(err => { if (err.name !== 'AbortError') setError(err.message) }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [applied])

  const indicators = meta?.indicators || []
  const regions = meta?.regions || []
  const rows = result ? cadence === 'annual' ? result.series : result.monthly : []
  const xKey = cadence === 'annual' ? 'year' : 'period'
  const mapOptions = [{ key: 'compliance_score', label: 'Reported compliance score', unit: '%' }, { key: 'microbial_pass_pct', label: 'Microbiological checks passing', unit: '%' }, { key: 'health_pass_pct', label: 'Health-class checks passing', unit: '%' }, ...indicators]
  const mapMetric = mapOptions.find(item => item.key === mapKey) || mapOptions[0]
  const mapValues = useMemo(() => Object.fromEntries((result?.map || []).map(row => [normaliseDistrictName(row.district_name), row])), [result])
  const mapScale = useMemo(() => {
    const values = (result?.map || []).map(row => row[mapMetric.key]).filter(valid)
    const isPercent = mapMetric.unit === '%'
    const low = isPercent ? 0 : values.length ? Math.min(...values) : 0, high = isPercent ? 100 : values.length ? Math.max(...values) : 1
    const colors = ['#233c73', '#325da0', '#4986c0', '#58b7d0', '#7cddd0']
    return { color: value => colors[Math.min(4, Math.max(0, Math.floor((value - low) / (high - low || 1) * 5)))], legend: { title: mapMetric.unit, gradient: `linear-gradient(180deg,${[...colors].reverse().join(',')})`, items: high === low ? [[format(high), 'Same source value']] : [[format(high), 'Higher'], [format((low + high) / 2), ''], [format(low), 'Lower']] } }
  }, [result, mapMetric.key, mapMetric.unit])
  const selectDistrict = name => {
    const canonical = regions.find(region => normaliseDistrictName(region) === normaliseDistrictName(name))
    if (canonical) { const filters = { ...applied, region: canonical }; setDraft(filters); setApplied(filters) }
  }
  const latest = result?.latest || {}
  const sparkRows = (result?.monthly || []).slice(-24)
  const kpis = [
    { key: 'compliance_score', title: 'Reported compliance', unit: '%', value: latest.compliance_score, color: BLUE, icon: ShieldCheck },
    { key: 'microbial_pass_pct', title: 'Microbiological checks passing', unit: '%', value: latest.microbial_pass_pct, color: PURPLE, icon: FlaskConical },
    { key: 'free_chlorine_mg_l', title: 'Free chlorine residual', unit: 'mg/L', value: latest.free_chlorine_mg_l, color: TEAL, icon: Droplets },
    { key: 'flagged_districts', title: 'Districts with screening flags', unit: `of ${result?.coverage.selected_districts ?? regions.length}`, value: result?.coverage.latest_flagged_districts, color: CORAL, icon: AlertTriangle },
  ]
  const parameterRates = (result?.parameter_compliance || []).map(item => ({ ...item, parameter: item.label })).sort((a, b) => (a.pass_pct ?? 101) - (b.pass_pct ?? 101))
  const microbiology = indicators.filter(item => item.category === 'Microbiological').map((item, index) => ({ ...item, color: index ? CORAL : PURPLE }))
  const sourceZero = microbiology.every(item => item.min === 0 && item.max === 0)
  const chlorine = indicators.filter(item => item.key === 'free_chlorine_mg_l')
  const physical = indicators.filter(item => item.category === 'Physical')
  const chemicals = indicators.filter(item => item.category === 'Chemical' && item.key !== 'free_chlorine_mg_l')
  const alerts = (result?.alerts || []).slice(0, allAlerts ? undefined : 8)

  return <div className="rainfall-dashboard drinking-water-dashboard">
    <div className="rf-heading dw-heading"><span className="rf-heading-icon dw-heading-icon"><Droplets size={29} /></span><div><span className="rf-eyebrow">NIWIS / MONITORING 12</span><h1>Drinking Water Quality Compliance</h1><p>Explore reported water-quality compliance, parameter trends and district screening flags.</p></div><button className="rf-export" onClick={() => result && exportCSV(result, indicators)} disabled={!result || loading}><Download size={15} /> Export data</button></div>
    <form className="rf-filters dw-filters" onSubmit={event => { event.preventDefault(); setApplied({ ...draft }) }}><label className="rf-region">Region / district<select aria-label="Drinking water region" value={draft.region} disabled={!meta} onChange={event => setDraft({ ...draft, region: event.target.value })}><option value="National">South Africa (district observations)</option>{regions.map(region => <option key={region}>{region}</option>)}</select></label><label>From year<select aria-label="Drinking water from year" value={draft.start} disabled={!meta} onChange={event => setDraft({ ...draft, start: Number(event.target.value) })}>{meta?.years.map(year => <option key={year}>{year}</option>)}</select></label><label>To year<select aria-label="Drinking water to year" value={draft.end} disabled={!meta} onChange={event => setDraft({ ...draft, end: Number(event.target.value) })}>{meta?.years.map(year => <option key={year}>{year}</option>)}</select></label><button className="rf-apply" disabled={loading || !meta || draft.start > draft.end}>Apply filters</button></form>
    {loading && <LoadingProgress className="rf-loading" message="Preparing drinking-water compliance graphs and district checks" />}
    {error && <div className="rf-error" role="alert">{error}<button onClick={() => meta ? setApplied({ ...applied }) : setRetry(value => value + 1)}><RefreshCw size={14} /> Retry</button></div>}
    {result && <>
      <div className="dw-context"><span><MapPin size={14} /><strong>{result.region === 'National' ? 'South Africa' : result.region}</strong><span>{result.start}–{result.end}</span></span><span><i />Source-reported flags <b>·</b> Latest {periodLabel(result.latest_period)}</span></div>
      <div className="dw-kpi-grid">{kpis.map(({ key, title, unit, value, color, icon: Icon }) => <article className="dw-kpi" key={key} style={{ '--dw-accent': color }}><div className="dw-kpi-label"><span>{title}</span><Icon size={18} /></div><div className="dw-kpi-value"><strong>{format(value, key === 'flagged_districts' ? 0 : 2)}</strong><small>{unit}</small></div><div className="dw-kpi-bottom"><span>{periodLabel(result.latest_period)}</span><WastewaterSparkline data={sparkRows} metricKey={key} color={color} label={`${title}, last 24 available months`} /></div></article>)}</div>

      <div className="dw-primary-grid"><Panel title="National drinking-water picture" subtitle="Explore all districts and choose a measurement" icon={MapPin} className="dw-map-panel"><label className="dw-picker"><span>Map indicator</span><select aria-label="Drinking water map indicator" value={mapMetric.key} onChange={event => setMapKey(event.target.value)}>{mapOptions.map(item => <option key={item.key} value={item.key}>{item.label} ({item.unit})</option>)}</select></label>{features.length && result.map.length ? <DistrictMap districts={features} values={mapValues} valueKey={mapMetric.key} colorFn={mapScale.color} selected={result.region === 'National' ? null : result.region} onSelect={selectDistrict} legend={mapScale.legend} /> : <div className="dw-empty">District boundaries or observations are unavailable.</div>}<p className="dw-chart-note">Latest available district records · Color describes the chosen source measurement.</p></Panel>
        <Panel title="Reported compliance over time" subtitle="Source score alongside stored microbiological check results" icon={ShieldCheck} className="dw-chart-panel dw-lead-panel" action={<div className="dw-switch" role="group" aria-label="Drinking water trend cadence"><button type="button" aria-pressed={cadence === 'annual'} onClick={() => setCadence('annual')}>Annual</button><button type="button" aria-pressed={cadence === 'monthly'} onClick={() => setCadence('monthly')}>Monthly</button></div>}><div className="dw-lead-summary"><div><strong>{format(metricPoint(rows, 'compliance_score')?.compliance_score)}<small>%</small></strong><span>{cadence === 'annual' ? 'Annual mean reported score' : 'Monthly mean reported score'}</span></div><span className="dw-source-badge">District observations</span></div><WastewaterChart data={rows} metrics={[{ key: 'compliance_score', label: 'Reported compliance score', unit: '%', color: BLUE }, { key: 'microbial_pass_pct', label: 'Microbiological checks passing', unit: '%', color: PURPLE }]} xKey={xKey} type="line" height={300} yLabel="%" referenceLine={{ value: 100, label: '100% of checks' }} /><p className="dw-chart-note">Percentages summarize stored district flags; the source score is shown as supplied.</p></Panel></div>

      <div className="dw-section-heading"><div><span>01 / COMPLIANCE SIGNALS</span><h2>See which checks need attention</h2></div><p>Parameter pass rates and microbiological observations in the selected period.</p></div>
      <div className="dw-chart-grid"><Panel title="Reported checks passing by parameter" subtitle="Assessed flags in the selected region and years" icon={BarChart3} className="dw-chart-panel dw-parameter-rates"><WastewaterChart data={parameterRates} metrics={[{ key: 'pass_pct', label: 'Reported checks passing', unit: '%', color: BLUE }]} xKey="parameter" type="bar" horizontal height={405} yLabel="% of assessed flags" referenceLine={100} /><p className="dw-chart-note">Missing values or unknown flags are excluded from assessed checks.</p></Panel><Panel title="Microbiological surveillance" subtitle="E. coli and total coliform observations" icon={FlaskConical} className="dw-chart-panel"><div className="dw-microbial-summary">{microbiology.map(item => { const point = metricPoint(rows, item.key); return <div key={item.key}><span>{item.label}</span><strong style={{ color: item.color }}>{format(point?.[item.key], 3)}<small>{item.unit}</small></strong></div> })}</div><WastewaterChart data={rows} metrics={microbiology} xKey={xKey} type="line" height={300} yLabel="cfu/100 mL" referenceLine={sourceZero ? { value: 0, label: 'Stored target: 0', color: GOLD } : null} /><p className="dw-chart-note">These are district observations. Stored microbiological flags drive the screening signals.</p></Panel></div>

      <div className="dw-section-heading"><div><span>02 / PARAMETER EXPLORER</span><h2>Look behind the reported score</h2></div><p>Switch measurements and compare values with the targets recorded in the source.</p></div>
      <div className="dw-chart-grid"><ParameterPanel title="Water-quality parameter explorer" subtitle="All available drinking-water measurements" choices={indicators} preferred="turbidity_ntu" rows={rows} xKey={xKey} color={BLUE} label="Drinking water parameter" allowView icon={FlaskConical} /><ParameterPanel title="Disinfection control" subtitle="Free chlorine residual against the stored operating range" choices={chlorine} preferred="free_chlorine_mg_l" rows={rows} xKey={xKey} color={TEAL} label="Disinfection parameter" icon={Droplets} /><ParameterPanel title="Physical water quality" subtitle="Turbidity, colour and temperature" choices={physical} preferred="temperature_c" rows={rows} xKey={xKey} color={GOLD} label="Physical drinking water parameter" icon={Activity} /><ParameterPanel title="Chemical water quality" subtitle="pH, conductivity, nutrients and chemical constituents" choices={chemicals} preferred="ph" rows={rows} xKey={xKey} color={PURPLE} label="Chemical drinking water parameter" icon={FlaskConical} /></div>

      <div className="dw-section-heading"><div><span>03 / RECENT MONITORING</span><h2>Follow the latest screening flags</h2></div><p>{periodLabel(result.latest_period)} · {format(result.coverage.latest_failed_checks, 0)} stored checks flagged in the selected scope.</p></div>
      <MonthlyMatrix monthly={result.monthly} indicators={indicators} />
      <Panel title="Latest priority screening flags" subtitle="Latest stored failures, with health-class parameters listed first" icon={AlertTriangle} className="dw-alert-panel" action={result.alerts.length > 8 && <button type="button" className="dw-text-button" onClick={() => setAllAlerts(value => !value)}>{allAlerts ? 'Show fewer' : `Show ${result.alerts.length} priority flags`}</button>}><div className="dw-alert-table-scroll"><table className="dw-alert-table"><thead><tr><th>District</th><th>Parameter</th><th>Reported value</th><th>Source target</th><th>Reported class</th><th>Period</th></tr></thead><tbody>{alerts.map(row => <tr key={`${row.district_name}-${row.period}-${row.key}`}><td><button type="button" onClick={() => selectDistrict(row.district_name)}>{row.district_name}</button></td><td><i />{row.label}</td><td><strong>{format(row.value, ['arsenic_mg_l', 'lead_mg_l', 'cyanide_mg_l', 'total_thms_mg_l'].includes(row.key) ? 4 : 3)}</strong> <small>{row.unit}</small></td><td>{row.limit}</td><td>{row.class}</td><td>{periodLabel(row.period)}</td></tr>)}</tbody></table>{!alerts.length && <p className="dw-empty-message">No failed flags are reported for the latest available observations.</p>}</div><p className="dw-chart-note">A screening flag identifies a source record to review. The table does not contain individual supply-system incidents or a Blue Drop audit result.</p></Panel>

      <details className="dw-methods"><summary>Source coverage, limits and Blue Drop process data</summary><div className="dw-coverage-grid"><div><span>Source coverage</span><strong>{format(meta.rows, 0)} district-month rows</strong><small>{meta.first_period} to {meta.last_period} · {regions.length} districts · {indicators.length} parameters</small></div><div><span>Individual supply systems</span><strong>No system inventory supplied</strong><small>The table identifies districts, rather than the approximately 1,025 national systems.</small></div><div><span>Blue Drop process indicators</span><strong>Not in this relation</strong><small>Process scores, dosing, sampling requirements and Blue Drop risk ratings need an additional source.</small></div></div><p>The dashboard preserves the source's parameter values, limits, classifications, compliance flags and reported score. Charts average available district-month values. Pass rates count known flags with measurements; they are not laboratory sample-compliance rates or a Blue Drop certification score.</p><p>Some stored targets differ from the published SANS 241:2015 reference, including pH, total coliforms and cyanide. Reference lines are therefore labelled as source targets. See the <a href="https://www.dws.gov.za/ghreport/reports/2.2%285120%29.pdf" target="_blank" rel="noreferrer">DWS-hosted 2015 reference table</a>. Individual THM components and current official assessment criteria are needed for a formal compliance assessment.</p><p className="dw-source-table">Supabase relation: <code>{meta.source_table}</code></p></details>
      <footer className="dw-footer"><span><ShieldCheck size={16} />NIWIS drinking-water intelligence</span><span>Monitoring 12 · Source-reported district assessments</span></footer>
    </>}
  </div>
}
