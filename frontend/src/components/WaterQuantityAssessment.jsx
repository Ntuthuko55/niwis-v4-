import { useEffect, useMemo, useState } from 'react'
import { Activity, AlertTriangle, ArrowLeftRight, Download, MapPin, RefreshCw, Scale, Waves } from 'lucide-react'
import { dashboardFetch as fetch } from '../services/dashboardFetch'
import { DistrictMap, normaliseDistrictName } from './DistrictMap'
import WastewaterChart, { WastewaterSparkline } from './WastewaterChart'
import LoadingProgress from './LoadingProgress'
import '../niwis/rwqo.css'
import '../niwis/water-quantity.css'

const BLUE = '#80bdff', TEAL = '#6ce0c0', GOLD = '#ecc784', PURPLE = '#c0abff', CORAL = '#ef99af'
const valid = value => typeof value === 'number' && Number.isFinite(value)
const format = (value, digits = 2) => valid(value) ? value.toLocaleString('en-ZA', { notation: Math.abs(value) >= 1_000_000 ? 'compact' : 'standard', maximumFractionDigits: value !== 0 && Math.abs(value) < 1 ? 4 : digits }) : '—'
const periodLabel = value => /^\d{4}-\d{2}$/.test(value || '') ? new Date(`${value}-15T12:00:00`).toLocaleDateString('en-ZA', { month: 'short', year: 'numeric' }) : 'No observations'

async function getJSON(url, signal) {
  const response = await fetch(url, { signal })
  const body = await response.json()
  if (!response.ok) throw new Error(typeof body.detail === 'string' ? body.detail : `Water quantity request failed (HTTP ${response.status}).`)
  return body
}

function Panel({ title, subtitle, children, className = '' }) {
  return <section className={`rq-panel ${className}`} aria-label={title}><header className="rq-panel-heading"><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div></header>{children}</section>
}

function IndicatorChart({ title, choices, rows, color }) {
  const [key, setKey] = useState(choices[0]?.key), [type, setType] = useState('area')
  const metric = choices.find(item => item.key === key) || choices[0]
  const latest = rows.filter(row => valid(row[metric?.key])).at(-1)
  return <Panel title={title} subtitle="Monthly records · supplied units retained" className="wq-indicator-panel">
    <div className="rq-chart-controls"><label>Indicator<select aria-label={`${title} indicator`} value={metric?.key || ''} onChange={event => setKey(event.target.value)}>{choices.map(item => <option key={item.key} value={item.key}>{item.label}</option>)}</select></label><label>Chart<select aria-label={`${title} chart style`} value={type} onChange={event => setType(event.target.value)}><option value="area">Area</option><option value="line">Line</option><option value="bar">Bars</option></select></label></div>
    <div className="rq-readout"><div><strong style={{ color }}>{format(latest?.[metric?.key])}<small>{metric?.unit}</small></strong><span>{latest ? periodLabel(latest.period) : 'No numeric observations'}</span></div></div>
    <WastewaterChart data={rows} metrics={metric ? [{ ...metric, color }] : []} xKey="period" type={type} height={255} yLabel={metric?.unit} />
  </Panel>
}

function exportCSV(result, meta) {
  const escape = value => `"${String(value ?? '').replaceAll('"', '""')}"`
  const rows = [
    ...result.transfers.monthly.flatMap(row => meta.transfer_indicators.map(item => [result.region === 'National' ? 'Source district mean' : result.region, 'Transfers', row.period, item.label, row[item.key], item.unit, meta.audits.transfers.table])),
    ...result.balance.monthly.flatMap(row => meta.balance_indicators.map(item => ['National', 'National balance', row.period, item.label, row[item.key], item.unit, meta.audits.balance.table])),
  ]
  const blob = new Blob(['\uFEFF' + [['Scope', 'Dataset', 'Period', 'Indicator', 'Value', 'Unit', 'Source table'], ...rows].map(row => row.map(escape).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' })
  const anchor = document.createElement('a')
  anchor.href = URL.createObjectURL(blob); anchor.download = `NIWIS-water-quantity-${result.region.replaceAll(' ', '-')}-${result.start}-${result.end}.csv`; anchor.click()
  setTimeout(() => URL.revokeObjectURL(anchor.href), 800)
}

export default function WaterQuantityAssessment() {
  const [meta, setMeta] = useState(null), [result, setResult] = useState(null), [features, setFeatures] = useState([])
  const [draft, setDraft] = useState({ region: 'National', start: '', end: '' }), [applied, setApplied] = useState(null)
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [mapError, setMapError] = useState(''), [retry, setRetry] = useState(0)
  const [tab, setTab] = useState('transfers'), [mapKey, setMapKey] = useState('donor_storage')
  const [mapSelectionNotice, setMapSelectionNotice] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    setMeta(null); setApplied(null); setResult(null); setLoading(true); setError(''); setMapError('')
    getJSON('/api/water-quantity/metadata', controller.signal).then(data => {
      if (controller.signal.aborted) return
      setMeta(data)
      const initial = { region: 'National', start: data.default_start, end: data.default_end }
      setDraft(initial); setApplied(initial)
    }).catch(err => { if (!controller.signal.aborted) { setError(err.message); setLoading(false) } })
    getJSON('/south_africa_adm2.display.geojson', controller.signal).then(data => { if (!controller.signal.aborted) setFeatures(data.features || []) }).catch(() => {
      if (!controller.signal.aborted) { setFeatures([]); setMapError('District boundaries could not be loaded. Use the transfer district selector to explore source data.') }
    })
    return () => controller.abort()
  }, [retry])

  useEffect(() => {
    if (!applied) return undefined
    const controller = new AbortController()
    setLoading(true); setError(''); setResult(null)
    getJSON(`/api/water-quantity/dashboard?${new URLSearchParams(applied)}`, controller.signal).then(data => { if (!controller.signal.aborted) setResult(data) }).catch(err => {
      if (!controller.signal.aborted) setError(err.message)
    }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [applied])

  const mapMetric = meta?.transfer_indicators.find(item => item.key === mapKey)
  const mapValues = useMemo(() => Object.fromEntries((result?.transfers.map || []).map(row => [normaliseDistrictName(row.district_name), row])), [result])
  const mapScale = useMemo(() => {
    const values = (result?.transfers.map || []).map(row => row[mapKey]).filter(valid)
    return { min: values.length ? Math.min(...values) : 0, max: values.length ? Math.max(...values) : 1 }
  }, [result, mapKey])
  const mapColor = value => {
    const fraction = mapScale.min === mapScale.max ? 0.5 : (value - mapScale.min) / (mapScale.max - mapScale.min)
    return fraction < 0.25 ? '#235373' : fraction < 0.5 ? '#298ca5' : fraction < 0.75 ? '#46bfb5' : '#9aead2'
  }
  const mapLegend = mapScale.min === mapScale.max
    ? { title: mapMetric?.unit, gradient: '#46bfb5', items: [[format(mapScale.min), 'All covered districts'], ['Grey', 'No source record']] }
    : { title: mapMetric?.unit, gradient: 'linear-gradient(180deg, #9aead2, #46bfb5, #298ca5, #235373)', items: [[format(mapScale.max), 'Higher value'], [format((mapScale.min + mapScale.max) / 2), 'Mid-range'], [format(mapScale.min), 'Lower value'], ['Grey', 'No source record']] }
  const selectDistrict = name => {
    const district = meta.regions.find(value => normaliseDistrictName(value) === normaliseDistrictName(name))
    if (district) { setMapSelectionNotice(''); const next = { ...applied, region: district }; setDraft(next); setApplied(next) }
    else setMapSelectionNotice(`No transfer records are supplied for ${name}. Select a covered district to filter the charts.`)
  }
  const current = result ? tab === 'transfers' ? result.transfers : result.balance : null
  const kpis = result ? tab === 'transfers' ? [
    ['Katse to Vaal rate', 'katse_vaal', 'm³/day', BLUE, result.transfers], ['Donor basin storage', 'donor_storage', '% FSC', TEAL, result.transfers],
    ['Pumping energy intensity', 'pumping_energy', 'kWh/ML', GOLD, result.transfers], ['Reported national balance', 'reported_balance', 'Mm³', CORAL, result.balance],
  ] : [
    ['Reported net balance', 'reported_balance', 'Mm³', CORAL, result.balance], ['Total demand incl. Reserve', 'reported_demand', 'Mm³', GOLD, result.balance],
    ['Surface storage', 'surface_storage', 'Mm³', BLUE, result.balance], ['Reported net transfers', 'net_ibt', 'Mm³', TEAL, result.balance],
  ] : []
  const checks = result?.balance.calculation_checks
  const comparison = useMemo(() => [...(result?.transfers.map || [])].sort((a, b) => (b[mapKey] ?? -Infinity) - (a[mapKey] ?? -Infinity)), [result, mapKey])

  return <div className="rwqo-dashboard water-quantity-dashboard">
    <header className="rq-heading"><span className="rq-heading-icon"><Waves size={29} /></span><div><span className="rq-eyebrow">TRANSFERS &amp; NATIONAL WATER BALANCE / SECTION 17</span><h1>Water Quantity Assessment</h1><p>Transfer-rate records, basin conditions and the supplied national water balance.</p></div><button className="rq-export" disabled={!result || loading} onClick={() => exportCSV(result, meta)}><Download size={15} />Export monthly data</button></header>
    <form className="rq-filters" onSubmit={event => { event.preventDefault(); setApplied({ ...draft }) }}>
      <label className="rq-region">Transfer district<select aria-label="Water quantity district" value={draft.region} disabled={!meta || loading} onChange={event => setDraft({ ...draft, region: event.target.value })}><option value="National">National — source district mean</option>{meta?.regions.map(name => <option key={name}>{name}</option>)}</select></label>
      {['start', 'end'].map(key => <label key={key}>{key === 'start' ? 'From year' : 'To year'}<select aria-label={`Water quantity ${key} year`} value={draft[key]} disabled={!meta || loading} onChange={event => setDraft({ ...draft, [key]: event.target.value })}>{!meta && <option value="">Loading…</option>}{meta?.years.map(year => <option key={year}>{year}</option>)}</select></label>)}
      <button className="rq-apply" disabled={!meta || loading}>Apply filters</button><span className="rq-cache"><Activity size={13} />{format((meta?.cache_ttl_seconds || 86400) / 3600, 0)}-hour retrieval cache</span>
    </form>
    {error && <div className="rq-error" role="alert"><AlertTriangle size={18} /><span>{error}</span><button onClick={() => setRetry(value => value + 1)}><RefreshCw size={14} />Retry</button></div>}
    {loading && <LoadingProgress className="rq-loading" message="Retrieving water quantity database records" />}
    {result && !loading && <>
      <div className="rq-context"><strong>Transfers: {result.region === 'National' ? 'Source district mean' : result.region} / Balance: National</strong><span>{result.start}–{result.end} · monthly source records · {meta.regions.length} transfer districts</span></div>
      <div className="rq-source-notice" role="note"><AlertTriangle size={16} /><span><strong>Monthly source data.</strong> Daily observations are not supplied. Transfer fields retain daily-rate units; national balance fields retain Mm³. The stored net-balance formula is an inferred source calculation with unverified accounting conventions.</span></div>
      <div className="rq-tabs" role="group" aria-label="Water quantity section"><button aria-pressed={tab === 'transfers'} onClick={() => setTab('transfers')} style={{ '--rq-accent': TEAL }}><ArrowLeftRight size={15} />Water transfers<span>{meta.transfer_indicators.length} indicators</span></button><button aria-pressed={tab === 'balance'} onClick={() => setTab('balance')} style={{ '--rq-accent': BLUE }}><Scale size={15} />National water balance<span>{meta.balance_indicators.length} components &amp; summaries</span></button></div>
      <div className="rq-kpis">{kpis.map(([label, key, unit, color, section]) => <article className="rq-kpi" key={label} style={{ '--rq-accent': color }}><span>{label}</span><strong>{format(section.latest[key])}<small>{unit}</small></strong><div><span>{periodLabel(section.latest_period)} · {section.scope === 'National' && key !== 'reported_balance' && tab === 'transfers' ? 'district mean' : section.scope}</span><WastewaterSparkline data={section.monthly.slice(-24)} metricKey={key} label={label} color={color} /></div></article>)}</div>
      {tab === 'transfers' ? <>
        {result.transfers.latest_all_route_zero_districts > 0 && <div className="rq-source-notice wq-zero-notice" role="note"><AlertTriangle size={16} /><span><strong>Stored zero transfer rates.</strong> {result.transfers.latest_all_route_zero_districts} selected source districts report zero in all four route columns for {periodLabel(result.transfers.latest_period)}. The table provides no zero-verification or operating-status flags.</span></div>}
        <div className="rq-primary-grid">
          <Panel title="Transfer district observations" subtitle={`${periodLabel(result.transfers.map_period)} · ${mapMetric.label}`} className="rq-map-panel">
            <label className="rq-picker">Map indicator<select aria-label="Water quantity map indicator" value={mapKey} onChange={event => setMapKey(event.target.value)}>{meta.transfer_indicators.map(item => <option key={item.key} value={item.key}>{item.label}</option>)}</select></label>
            {features.length ? <DistrictMap districts={features} values={mapValues} valueKey={mapKey} selected={result.region} onSelect={selectDistrict} colorFn={mapColor} legend={mapLegend} /> : <p className="rq-empty" role="status">{mapError || 'District boundaries are loading.'}</p>}
            <p className="rq-note"><MapPin size={12} />{meta.regions.length} districts have source records; the remaining boundary districts stay grey. Select a covered district to update transfer charts.</p>
            {mapSelectionNotice && <p className="rq-note wq-map-selection" role="status">{mapSelectionNotice}</p>}
            {result.region !== 'National' && <button className="rq-text-button" onClick={() => { const next = { ...applied, region: 'National' }; setDraft(next); setApplied(next) }}>Return to source district mean</button>}
          </Panel>
          <Panel title="Transfer rate observations" subtitle={`${result.region === 'National' ? 'Equal source district means' : result.region} · monthly reporting cadence`}>
            <WastewaterChart data={result.transfers.monthly} metrics={[
              { key: 'katse_vaal', label: 'Katse–Vaal', unit: 'm³/day', color: BLUE }, { key: 'tugela_vaal', label: 'Tugela–Vaal', unit: 'm³/day', color: TEAL },
              { key: 'orange_transfer', label: 'Orange system', unit: 'm³/day', color: GOLD }, { key: 'thukela_vaal', label: 'Thukela–Vaal', unit: 'm³/day', color: PURPLE },
            ]} type="line" xKey="period" height={345} />
            <p className="rq-note">Tugela–Vaal and Thukela–Vaal remain separate source columns. No scheme overlap rule is supplied, so these rates are not added into a transfer total.</p>
          </Panel>
        </div>
        <div className="rq-section-title"><div><span>TRANSFER OPERATIONS</span><h2>Losses, energy &amp; basin conditions</h2></div><p>{result.transfers.selected_rows.toLocaleString('en-ZA')} selected district-month records · {result.transfers.missing_measurements} missing values</p></div>
        <div className="rq-chart-grid"><IndicatorChart title="Transfer operations" choices={meta.transfer_indicators.slice(4, 6)} rows={result.transfers.monthly} color={GOLD} /><IndicatorChart title="Source & receiving basins" choices={meta.transfer_indicators.slice(6)} rows={result.transfers.monthly} color={TEAL} /></div>
        <Panel title="Covered district comparison" subtitle={`${periodLabel(result.transfers.map_period)} · follows the map indicator · ${mapMetric.unit}`} className="wq-comparison-panel"><WastewaterChart data={comparison} metrics={[{ ...mapMetric, color: BLUE }]} xKey="district_name" horizontal type="bar" height={Math.max(280, comparison.length * 27)} /><p className="rq-note">All source districts remain visible for comparison. The National balance table has no district identifiers and remains national.</p></Panel>
      </> : <>
        <div className="wq-scope-note"><Scale size={16} /><span>National balance scope stays <strong>National</strong> when the transfer district filter changes. Monthly volume and storage records are not summed into annual totals.</span></div>
        <div className="rq-primary-grid wq-balance-grid">
          <Panel title="Reported national net balance" subtitle={`National source record · latest ${periodLabel(result.balance.latest_period)}`}><WastewaterChart data={result.balance.monthly} metrics={[{ key: 'reported_balance', label: 'Reported net balance', unit: 'Mm³', color: CORAL }]} type="area" xKey="period" height={315} referenceLine={{ value: 0, label: 'Zero' }} /><p className="rq-note">Negative source values are retained. The table does not document its hydrological accounting method or provide operational deficit verification.</p></Panel>
          <Panel title="Stored calculation components" subtitle={`${periodLabel(result.balance.latest_period)} · signed terms in the inferred source expression`}><WastewaterChart data={result.balance.calculation_components} metrics={[{ key: 'signed_volume', label: 'Signed source term', unit: 'Mm³', color: BLUE }]} horizontal type="bar" xKey="component" height={315} /><p className="rq-note">This view reproduces the supplied expression; it does not redefine the national water balance. Surface storage is excluded from that expression.</p></Panel>
        </div>
        <Panel title="Source calculation checks" subtitle="Arithmetic consistency across the selected national reporting months" className="wq-calculation-panel"><div className="wq-calculation-grid">{Object.entries(checks).map(([key, check]) => <article key={key}><span>{key === 'total_demand' ? 'Total demand, including Reserve' : 'Reported net water balance'}</span><code>{check.expression}</code><strong>{check.matching_rows} / {check.complete_rows} complete records match</strong><p>Maximum difference: {format(check.max_absolute_difference_mm3)} Mm³ · tolerance {check.tolerance_mm3} Mm³{check.mismatching_rows ? ` · ${check.mismatching_rows} records need arithmetic review` : ''}</p></article>)}</div><p className="rq-note">The source demand already includes the Environmental Reserve. The reported balance subtracts MAR and recharge. These identities were inferred from source values; accounting intent requires confirmation from the data provider.</p></Panel>
        <div className="rq-chart-grid"><Panel title="Demand & Environmental Reserve" subtitle="Supplied sector values; Reserve is already included in reported total demand"><WastewaterChart data={result.balance.monthly} metrics={[{ key: 'municipal_volume', label: 'Municipal', color: BLUE }, { key: 'agricultural_volume', label: 'Agricultural', color: GOLD }, { key: 'industrial_volume', label: 'Industrial', color: PURPLE }, { key: 'environmental_reserve', label: 'Environmental Reserve', color: TEAL }].map(item => ({ ...item, unit: 'Mm³' }))} type="line" xKey="period" height={310} /></Panel><IndicatorChart title="National water components" choices={meta.balance_indicators.filter(item => !['Demand & Reserve'].includes(item.category))} rows={result.balance.monthly} color={BLUE} /></div>
        <Panel title="National water balance component matrix" subtitle={`${periodLabel(result.balance.latest_period)} · Mm³ means million cubic metres · source period convention not supplied`} className="wq-component-panel"><div className="rq-table-scroll"><table className="wq-component-table"><thead><tr><th>Component</th><th>Source value</th><th>Unit</th><th>Category</th><th>Reference agency</th></tr></thead><tbody>{result.balance.components.map(item => <tr key={item.key}><th scope="row">{item.label}</th><td>{format(item.value)}</td><td>{item.unit}</td><td>{item.category}</td><td>{item.reference_agency}</td></tr>)}</tbody></table></div></Panel>
      </>}
      <details className="rq-methods"><summary>Table inspection, coverage &amp; interpretation</summary><div className="rq-source-grid wq-source-grid">{Object.entries(meta.audits).map(([kind, audit]) => <article key={kind}><strong>{kind === 'transfers' ? 'Transfer rates & basin conditions' : 'National water balance'}</strong><code>{audit.table}</code><span>{audit.rows.toLocaleString('en-ZA')} records · {audit.scope}</span><span>{periodLabel(audit.first_period)} – {periodLabel(audit.last_period)}</span><span>{audit.duplicate_keys} duplicate keys · {audit.missing_entity_months} missing reporting rows · {audit.missing_measurements} missing measurements</span>{kind === 'transfers' && <span>{audit.entities} source districts</span>}{kind === 'balance' && <span>{audit.ranges.filter(item => item.distinct === 1).length} constant-valued fields across this source history</span>}</article>)}</div><ul>{meta.limitations.map(value => <li key={value}>{value}</li>)}</ul><p>Successful source reads, prepared data and API responses use the shared {format(meta.cache_ttl_seconds / 3600, 0)}-hour memory cache. Failed reads are retried and are not cached. Restart or cache eviction can remove entries sooner. Retrieval time does not establish a new observation date.</p></details>
    </>}
  </div>
}
