import { dashboardFetch as fetch } from '../services/dashboardFetch'
import { useEffect, useMemo, useState } from 'react'
import { Waves, Download, RefreshCw, Info, AlertTriangle, MapPin } from 'lucide-react'
import { DistrictMap, normaliseDistrictName } from './DistrictMap'
import LoadingProgress from './LoadingProgress'
import ClimateChart, { climateNumber } from './ClimateChart'
import { Panel } from './RainfallStatus'
import { reservoirReferenceLocations } from '../lib/reservoirLocations'
import '../niwis/reservoir-status.css'

const METRIC_COLORS = ['#47a9de', '#5ecab1', '#eda965', '#a68adc']
function monitoringDate() {
  const parts = new Intl.DateTimeFormat('en', { timeZone: 'Africa/Johannesburg', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date())
  const part = type => parts.find(item => item.type === type).value
  return `${part('year')}-${part('month')}-${part('day')}`
}
async function getJSON(url, signal) {
  const response = await fetch(url, { signal })
  const result = await response.json()
  if (!response.ok) throw new Error(typeof result.detail === 'string' ? result.detail : 'Reservoir data could not be loaded.')
  return result
}
const dateLabel = value => new Date(`${value}T12:00:00`).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' })

function ReservoirChart({ data, catalogue, keys, bars = false, height = 265 }) {
  const observations = data.flatMap(row => keys.map(key => row[key])).filter(value => value != null && Number.isFinite(value))
  const low = observations.length ? Math.min(...observations) : 0, high = observations.length ? Math.max(...observations) : 1
  const padding = high > low ? (high - low) * .1 : Math.max(Math.abs(low) * .025, low === 0 ? 1 : .0001)
  const domain = [low >= 0 ? Math.max(0, low - padding) : low - padding, high + padding]
  const magnitude = Math.max(...domain.map(Math.abs))
  const factor = magnitude >= 1e6 ? 1e6 : magnitude >= 1e3 ? 1e3 : 1
  const suffix = factor === 1e6 ? 'M' : factor === 1e3 ? 'k' : ''
  const step = (domain[1] - domain[0]) / 5 / factor
  const digits = Math.max(0, Math.min(6, Math.ceil(-Math.log10(step))))
  return <ClimateChart key={keys.join('-')} data={data} metrics={keys.map(key => catalogue[key])} type={bars ? 'bar' : 'line'} xKey="date" height={height} colors={METRIC_COLORS} yDomain={domain} yTickFormatter={value => `${climateNumber(value / factor, digits)}${suffix}`} />
}

export default function ReservoirStatus() {
  const [meta, setMeta] = useState(null), [result, setResult] = useState(null)
  const [draft, setDraft] = useState({ region: '', start: '', end: '', as_of: monitoringDate() })
  const [applied, setApplied] = useState(null), [retry, setRetry] = useState(0)
  const [loading, setLoading] = useState(true), [error, setError] = useState('')
  const [districts, setDistricts] = useState([]), [mapError, setMapError] = useState('')
  const [mapKey, setMapKey] = useState('pct_fsc'), [storageKey, setStorageKey] = useState('pct_fsc'), [mapDate, setMapDate] = useState(''), [mapResult, setMapResult] = useState(null)
  const [fullAudit, setFullAudit] = useState(null), [auditLoading, setAuditLoading] = useState(false), [auditError, setAuditError] = useState('')
  const [lossKey, setLossKey] = useState('runoff'), [satelliteKey, setSatelliteKey] = useState('area')

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setError('')
    const as_of = monitoringDate()
    getJSON(`/api/reservoirs/metadata?as_of=${as_of}`, controller.signal).then(data => {
      setMeta(data)
      const defaults = { region: data.default_region, start: data.default_start, end: data.default_end, as_of }
      setDraft(defaults); setApplied(defaults)
    }).catch(err => { if (err.name !== 'AbortError') { setError(err.message); setLoading(false) } })
    return () => controller.abort()
  }, [retry])
  useEffect(() => {
    const controller = new AbortController()
    getJSON('/south_africa_adm2.display.geojson', controller.signal).then(data => setDistricts(data.features || [])).catch(err => { if (err.name !== 'AbortError') setMapError('District boundaries are unavailable. Use the reservoir selector above.') })
    return () => controller.abort()
  }, [])
  useEffect(() => {
    if (!applied) return
    const controller = new AbortController()
    setLoading(true); setError(''); setResult(current => current?.region === applied.region && String(current.start) === String(applied.start) && String(current.end) === String(applied.end) ? current : null); setMapResult(null); setMapDate(applied.end)
    getJSON(`/api/reservoirs/dashboard?${new URLSearchParams(applied)}`, controller.signal).then(setResult).catch(err => { if (err.name !== 'AbortError') (setResult(null), setError(err.message)) }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [applied])

  useEffect(() => {
    if (!applied || !mapDate || mapDate === applied.end) return undefined
    const controller = new AbortController()
    getJSON(`/api/reservoirs/dashboard?${new URLSearchParams({ ...applied, start: mapDate, end: mapDate })}`, controller.signal).then(setMapResult).catch(err => { if (err.name !== 'AbortError') setMapResult(null) })
    return () => controller.abort()
  }, [applied, mapDate])

  const catalogue = useMemo(() => Object.fromEntries((meta?.metrics || []).map(metric => [metric.key, metric])), [meta])
  const mapSource = mapResult || result
  const mapValues = useMemo(() => {
    const values = {}
    for (const row of mapSource?.map || []) {
      const key = normaliseDistrictName(row.District_Name)
      // The file includes old and current names for this same geography.
      if (!values[key] || row.District_Name === 'Z F Mgcawu') values[key] = row
    }
    return values
  }, [mapSource])
  const mapMarkers = useMemo(() => Object.values(mapValues).flatMap(row => {
    const references = reservoirReferenceLocations(row.dam_name)
    return references.length ? references.map(reference => ({ ...row, marker_latitude: reference.latitude, marker_longitude: reference.longitude, marker_precision: 'reference coordinate', marker_source: reference.source, marker_label: reference.label })) : [row]
  }), [mapValues])
  const scale = useMemo(() => {
    if (mapKey === 'pct_fsc') return {
      color: value => value < 15 ? '#de6262' : value < 30 ? '#ed9465' : value < 50 ? '#d8b050' : '#4fbf9a',
      legend: { title: '% FSC', gradient: 'linear-gradient(180deg,#4fbf9a,#d8b050,#ed9465,#de6262)', items: [['50% and above', 'Outside alert levels'], ['30% to <50%', 'Level 1'], ['15% to <30%', 'Level 2'], ['Below 15%', 'Level 3']] },
    }
    const values = Object.values(mapValues).map(row => row[mapKey]).filter(value => value != null)
    const low = values.length ? Math.min(...values) : 0, high = values.length ? Math.max(...values) : 1
    const colors = ['#367dab', '#66b9cd', '#b9d2b4', '#dfb571', '#d77e66']
    return {
      color: value => colors[Math.min(4, Math.max(0, Math.floor((value - low) / (high - low || 1) * 5)))],
      legend: { title: catalogue[mapKey]?.unit || '', gradient: `linear-gradient(180deg,${[...colors].reverse().join(',')})`, items: high === low ? [[climateNumber(low, 2), 'Same source value']] : Array.from({ length: 5 }, (_, index) => [climateNumber(high - (high - low) * index / 4, 2), index === 0 ? 'Higher' : index === 4 ? 'Lower' : '']) },
    }
  }, [mapValues, mapKey, catalogue])
  function selectRegion(region) {
    const match = meta?.regions.find(item => normaliseDistrictName(item.district_name) === normaliseDistrictName(region))
    if (!match) return
    const filters = { ...applied, region: match.district_name }
    setDraft(filters); setApplied(filters)
  }
  function exportData() {
    const fields = meta.metrics.map(metric => metric.key)
    const escape = value => `"${String(value ?? '').replaceAll('"', '""')}"`
    const rows = [['Reservoir group / district', 'Date', ...meta.metrics.map(metric => `${metric.label} (${metric.unit})`)], ...result.series.map(row => [result.region, row.date, ...fields.map(key => row[key])])]
    const url = URL.createObjectURL(new Blob(['\uFEFF' + rows.map(row => row.map(escape).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8;' }))
    const link = document.createElement('a'); link.href = url; link.download = `NIWIS-reservoir-${result.region.replaceAll(' ', '-')}-${result.start}-${result.end}.csv`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  const region = result?.region === 'National' ? 'all source groups' : result?.region
  const chartRegion = result?.region === 'National' ? 'the source group average' : `${result?.region} reservoirs`
  const indicators = result?.indicators || {}
  const audit = result?.audit || meta || {}
  const count = value => value == null ? 'Not scanned' : value.toLocaleString()
  const loadAudit = event => {
    if (!event.currentTarget.open || fullAudit || auditLoading) return
    setAuditLoading(true); setAuditError('')
    getJSON('/api/reservoirs/audit').then(setFullAudit).catch(err => setAuditError(err.message)).finally(() => setAuditLoading(false))
  }
  const cards = ['storage', 'pct_fsc', 'level', 'inflow', 'outflow', 'evaporation']
  const alertBreakdown = useMemo(() => {
    const alerts = result?.alerts || []
    return { level3: alerts.filter(row => row.alert_level === 3).length, level2: alerts.filter(row => row.alert_level === 2).length, level1: alerts.filter(row => row.alert_level === 1).length, total: alerts.length }
  }, [result])
  const coveragePercent = result?.coverage?.expected ? result.coverage.observed / result.coverage.expected * 100 : null
  const latestAlert = result?.alert || {}
  const alertScope = result?.region === 'National' ? 'network' : result?.region
  const networkFsc = useMemo(() => {
    const values = (result?.map || []).map(row => Number(row.pct_fsc)).filter(Number.isFinite).sort((a, b) => a - b)
    if (!values.length) return null
    const quantile = position => values[Math.min(values.length - 1, Math.max(0, Math.round((values.length - 1) * position)))]
    return { median: quantile(.5), p10: quantile(.1), p90: quantile(.9) }
  }, [result])

  return <div className="rainfall-dashboard reservoir-dashboard">
    <div className="rf-heading"><span className="rf-heading-icon"><Waves size={30} /></span><div><span className="rf-eyebrow">NIWIS / RESERVOIR MONITORING</span><h1>Dam and Reservoir Status</h1><p>Operational storage status, alert levels, inflows and source-quality evidence</p></div><button className="rf-export" disabled={!result || loading} onClick={exportData}><Download size={14} /> Export data</button></div>
    <form className="rf-filters" onSubmit={event => { event.preventDefault(); setApplied({ ...draft }) }}>
      <label className="rf-region">Reservoir group / district<select aria-label="Reservoir group" value={draft.region} disabled={!meta} onChange={event => setDraft({ ...draft, region: event.target.value })}><option value="National">All groups (equal-weight mean)</option>{meta?.regions.map(item => <option key={item.district_name} value={item.district_name} title={item.dam_name}>{item.district_name}</option>)}</select></label>
      <label>From<input type="date" aria-label="Reservoir start date" min={meta?.first_date} max={meta?.default_end} value={draft.start} onChange={event => setDraft({ ...draft, start: event.target.value })} /></label>
      <label>To<input type="date" aria-label="Reservoir end date" min={meta?.first_date} max={meta?.default_end} value={draft.end} onChange={event => setDraft({ ...draft, end: event.target.value })} /></label>
      <button className="rf-apply" disabled={!meta || loading || !draft.start || !draft.end || draft.start > draft.end}>Apply filters</button>
      <span className="rs-snapshot">Supabase table snapshot{meta && ` / View through ${dateLabel(meta.default_end)}`}</span>
    </form>
    {loading && <LoadingProgress className="rf-loading" message="Loading reservoir records" />}
    {error && <div className="rf-error" role="alert">{error}<button onClick={() => meta ? setApplied({ ...applied }) : setRetry(retry + 1)}>Retry</button></div>}
    {result && <>
      <div className="rf-context"><span><MapPin size={12} /><strong>{region}</strong> / {dateLabel(result.start)} - {dateLabel(result.end)}</span><span>{result.aggregation}</span></div>
      <div className="rs-source-group rf-panel"><span>Mapped reservoir names</span><strong>{result.group?.dam_name || `${meta.groups} database reservoir groups`}</strong><small>{result.group ? `${result.group.province} / ${result.group.river}` : 'Group means; storage and flow are not national totals.'}</small></div>
      <div className="rs-command-strip" aria-label="Reservoir operational summary">
        <div className={`rs-command-card ${latestAlert.level > 0 ? 'alert' : 'normal'}`}><span>Latest FSC status</span><strong>{latestAlert.label || 'Unavailable'}</strong><small>{result.region === 'National' ? 'Equal-weight source-group mean' : 'Selected source group'} / {dateLabel(result.end)}</small></div>
        <div className="rs-command-card"><span>Network FSC distribution</span><strong>{networkFsc == null ? '—' : `${climateNumber(networkFsc.median, 1)}% median`}</strong><small>{networkFsc == null ? 'No current group values' : `P10 ${climateNumber(networkFsc.p10, 1)}% / P90 ${climateNumber(networkFsc.p90, 1)}% / ${alertBreakdown.total} below 50%`}</small></div>
        <div className="rs-command-card"><span>Observed coverage</span><strong>{coveragePercent == null ? '—' : `${climateNumber(coveragePercent, 1)}%`}</strong><small>{result.coverage.observed.toLocaleString()} observed group-days in the selected window</small></div>
        <div className="rs-command-card"><span>Source status</span><strong>{meta.source || 'Supabase'}</strong><small>{meta.groups} groups / {meta.first_date} to {meta.source_end}; table values are not independently verified live telemetry</small></div>
      </div>
      <div className="rs-integrity-note"><Info size={15} /><span><strong>How to read this dashboard:</strong> % FSC is the primary operational signal. National values are equal-weight averages of mapped source groups. Inflow relationships and constant storage are checked for the selected window; these values are evidence from the database snapshot, not live dam telemetry.</span></div>
      <Panel title="Dataset audit" note="Quality checks for the selected chart window" className="rs-audit-panel"><div className="rs-audit-grid"><div><span>Source completeness</span><strong>{audit.missing_values === 0 ? 'Complete fields' : `${audit.missing_values.toLocaleString()} missing cells`}</strong><small>{count(audit.rows)} selected rows / {audit.groups} groups</small></div><div><span>Constant storage histories</span><strong>{audit.constant_storage_groups} / {audit.groups} groups</strong><small>Only variable groups should be interpreted as storage trends</small></div><div><span>Inflow provenance</span><strong>{audit.inflow_from_runoff ? 'Runoff-derived' : 'Not confirmed'}</strong><small>{audit.inflow_from_runoff ? 'Runoff × district area ÷ 86,400' : 'Relationship not confirmed'}</small></div><div><span>Level provenance</span><strong>{audit.level_from_pct ? 'Formula-derived' : 'Not confirmed'}</strong><small>{audit.level_from_pct ? 'FSL and % FSC relationship is exact in the table' : 'Relationship not confirmed'}</small></div><div><span>Identity limitation</span><strong>{audit.id_collisions ? `${audit.id_collisions} ID collision${audit.id_collisions === 1 ? '' : 's'}` : 'Unique IDs'}</strong><small>District names identify histories; some IDs are reused</small></div><div><span>Geospatial limitation</span><strong>No dam coordinates</strong><small>Map shows district polygons and grouped source records</small></div></div></Panel>
      <div className="rf-kpis">{cards.map(key => <div className="rf-kpi" key={key}><div><span>{catalogue[key].label}{result.region === 'National' ? ' / mean' : ''}</span><strong>{climateNumber(result.latest[key], 2)}<small>{catalogue[key].unit}</small></strong><p>Latest selected day: {dateLabel(result.end)}</p></div></div>)}</div>
      <div className="rs-primary-grid">
        <Panel title="Reservoir group locations" note={`${mapDate || result.end} · reference points for named dams; district-centroid proxies for other groups`} className="rf-map-panel"><div className="rf-map-controls"><select aria-label="Reservoir map indicator" value={mapKey} onChange={event => setMapKey(event.target.value)}>{meta.metrics.map(metric => <option key={metric.key} value={metric.key}>{metric.label} ({metric.unit})</option>)}</select><label>Map day<select aria-label="Reservoir map day" value={mapDate || result.end} onChange={event => setMapDate(event.target.value)}>{result.series.map(row => <option key={row.date}>{row.date}</option>)}</select></label></div>{mapError ? <div className="rf-empty">{mapError}</div> : <DistrictMap districts={districts} values={mapValues} markerRows={mapMarkers} markerValueKey={mapKey} selected={result.region} onSelect={selectRegion} valueKey={mapKey} colorFn={scale.color} legend={scale.legend} />}<div className="rf-map-footer">● Named dams use DWS reference coordinates where matched. Other dots mark the district centroid because the source record has no surveyed dam coordinates; use the tooltip for the precision.</div></Panel>
        <Panel title={`${storageKey === 'pct_fsc' ? 'FSC' : storageKey === 'level' ? 'Water level' : 'Storage'} trends of ${chartRegion}`} note="Daily source values" className="rs-main-chart"><div className="rf-tabs" role="group" aria-label="Reservoir storage indicators">{[['storage', 'Storage volume'], ['pct_fsc', '% FSC'], ['level', 'Water level / FSL']].map(([key, label]) => <button key={key} type="button" aria-pressed={storageKey === key} onClick={() => setStorageKey(key)}>{label}</button>)}</div><ReservoirChart catalogue={catalogue} data={result.series} keys={storageKey === 'level' ? ['level', 'fsl'] : [storageKey]} height={320} />{result.warnings.some(warning => warning.startsWith('Storage is constant')) && <p className="rf-footnote">Storage is constant in this source history; no artificial trend is added.</p>}</Panel>
      </div>
      <div className="rs-chart-grid">
        <Panel title={`Inflows and releases of ${chartRegion}`} note="Rates in m³/s; inflow is runoff-derived in this source"><ReservoirChart catalogue={catalogue} data={result.series} keys={['inflow', 'outflow']} /></Panel>
        <Panel title={`Rainfall and evaporation of ${chartRegion}`} note="Daily depths; never added to flow rates"><ReservoirChart catalogue={catalogue} data={result.series} keys={['rainfall', 'evaporation']} /></Panel>
        <Panel title={`Runoff and losses of ${chartRegion}`} note="Explore each variable on its own scale"><div className="rf-tabs">{[['runoff', 'Estimated runoff'], ['seepage', 'Seepage / leakage']].map(([key, label]) => <button key={key} aria-pressed={lossKey === key} onClick={() => setLossKey(key)}>{label}</button>)}</div><ReservoirChart catalogue={catalogue} data={result.series} keys={[lossKey]} /><p className="rf-footnote">Runoff volume uses district area as a catchment proxy.</p></Panel>
        <Panel title={`Satellite reservoir indicators of ${chartRegion}`} note="Source area and NDWI; no footprint imagery supplied"><div className="rf-tabs">{[['area', 'Surface area'], ['ndwi', 'NDWI']].map(([key, label]) => <button key={key} aria-pressed={satelliteKey === key} onClick={() => setSatelliteKey(key)}>{label}</button>)}</div><ReservoirChart catalogue={catalogue} data={result.series} keys={[satelliteKey]} /></Panel>
      </div>
      <Panel title={`Conditional indicators of ${region}`} note="Secondary calculations; not operational forecasts"><div className="rs-indicators rs-secondary">
        <div><span>Weekly water-level change</span><strong>{climateNumber(indicators.weekly_level_change, 3)} <small>m/week</small></strong><p>Exact seven-day comparison</p></div>
        <div><span>Monthly storage change</span><strong>{climateNumber(indicators.monthly_storage_change, 2)} <small>%/month</small></strong><p>Relative change from one calendar month earlier</p></div>
        <div><span>Conditional days-to-empty</span><strong>{climateNumber(indicators.days_to_empty, 0)} <small>days</small></strong><p>{indicators.drawdown_status}; derived from a complete 30-day drawdown, not a forecast</p></div>
        <div><span>Reservoir storage index (RSI)</span><strong>{climateNumber(indicators.rsi, 2)}</strong><p>{indicators.rsi == null ? 'Unavailable: select a group with a variable historical baseline' : `${indicators.rsi_years} prior same-month years; storage z-score`}</p></div>
        <div><span>Drought Impact on Reservoirs (DIR)</span><strong>Unavailable</strong><p>No source values or calculation formula supplied</p></div>
      </div></Panel>
      <Panel title={`Critical level alerts / ${alertScope} / ${dateLabel(result.end)}`} note="Level 1 below 50%; Level 2 below 30%; Level 3 below 15%"><div className="rs-alert-summary"><AlertTriangle size={18} /><span>{result.alerts.length ? `${result.alerts.length} source group${result.alerts.length === 1 ? '' : 's'} below 50% FSC` : 'No source groups below the specified thresholds'}</span></div><div className="rf-table-scroll"><table><thead><tr><th>District group</th><th>Mapped reservoirs</th><th>% FSC</th><th>Alert</th></tr></thead><tbody>{result.alerts.map(row => <tr key={row.District_Name}><td><button className="rs-group-link" onClick={() => selectRegion(row.District_Name)}>{row.District_Name}</button></td><td>{row.dam_name}</td><td>{climateNumber(row.pct_fsc, 2)}%</td><td><span className={`rs-alert-level level-${row.alert_level}`}>Level {row.alert_level}</span></td></tr>)}</tbody></table></div></Panel>
      <Panel title="Priority national dams" note="Reference inventory supplied in your specification"><p className="rf-footnote">Capacity is a reference inventory value. Mapped records combine reservoirs and do not provide independent measurements for each named dam.</p><div className="rf-table-scroll"><table><thead><tr><th>Dam</th><th>Province / transfer</th><th>River</th><th>Capacity (million m3)</th><th>Supply area</th><th>Source mapping</th></tr></thead><tbody>{result.priority.map(dam => <tr key={dam.name}><td><strong>{dam.name}</strong></td><td>{dam.province}</td><td>{dam.river}</td><td>{climateNumber(dam.capacity, 0)}</td><td>{dam.supply}</td><td>{dam.groups.length ? dam.groups.map(group => <button className="rs-group-link" key={group} onClick={() => selectRegion(group)}>{group} / grouped record</button>) : <span className="rs-unavailable">Not in database table</span>}</td></tr>)}</tbody></table></div></Panel>
      <details className="rf-register"><summary>Operational variable register / all 12 indicators</summary><div className="rf-table-scroll"><table><thead><tr><th>Category</th><th>Variable</th><th>Latest value</th><th>Unit</th><th>Specification source</th></tr></thead><tbody>{meta.metrics.map(metric => <tr key={metric.key}><td>{metric.category}</td><td>{metric.label}</td><td>{climateNumber(result.latest[metric.key], metric.key === 'ndwi' ? 4 : 2)}</td><td>{metric.unit}</td><td>{metric.attribution}</td></tr>)}</tbody></table></div></details>
      <details className="rf-methods" onToggle={loadAudit}><summary>Full source audit, coverage and calculation notes</summary>{auditLoading && <p>Loading the full database audit on request?</p>}{auditError && <p role="alert">{auditError}</p>}<p>{count(fullAudit?.rows)} source rows / {meta.groups} district reservoir groups / {meta.first_date} to {meta.source_end}. {fullAudit ? fullAudit.constant_storage_groups : 'Not assessed'} full-history storage groups are constant. Future-dated rows are excluded from monitoring; a full count is not requested on page load. The table does not establish live Hydstra, telemetry or satellite connectivity.</p><p>Selected storage observations: {result.coverage.observed.toLocaleString()} / {result.coverage.expected.toLocaleString()} expected group-days. Missing values are not filled with zero. District names identify histories because D_UNMAPPED is reused across three groups. The map prefers Z F Mgcawu over the overlapping Siyanda source alias.</p>{result.warnings.map(warning => <p key={warning}><Info size={12} /> {warning}</p>)}<p>Weekly change compares dates seven days apart. Monthly change is a relative storage percentage, not an FSC percentage-point change. Days-to-empty uses current storage divided by the observed 30-day mean daily drawdown and is unavailable without a complete declining window. RSI uses prior years' same-calendar-month means, a sample standard deviation and at least three baseline years. A zero-variance baseline is unavailable. DIR remains unavailable until a formula is supplied.</p><p>The database table also contains soil_moisture_m3_m3; it remains outside the 12-variable operational register because no separate interpretation or threshold is supplied for this dashboard.</p><p>Source organisations and priority inventory values follow your specification; the table does not establish independent station provenance, supply links, dam coordinates, bathymetry or rating relationships.</p><div className="rf-table-scroll"><table><thead><tr><th>Variable</th><th>Display / calculation</th></tr></thead><tbody>{meta.metrics.map(metric => <tr key={metric.key}><td>{metric.label}</td><td>{metric.method}</td></tr>)}</tbody></table></div></details>
      <div className="rf-footer"><strong><Waves size={15} /> NIWIS <span>Dam and reservoir intelligence</span></strong><span>{meta.groups} database groups / Supabase table snapshot / Reviewed dataset</span></div>
    </>}
  </div>
}
