import { useEffect, useMemo, useState } from 'react'
import { Activity, AlertTriangle, ArrowLeftRight, Download, Droplets, Gauge, MapPin, Mountain, RefreshCw, Waves, Zap } from 'lucide-react'
import { dashboardFetch as fetch } from '../services/dashboardFetch'
import { buildDistrictMapScale, DistrictMap, normaliseDistrictName } from './DistrictMap'
import WastewaterChart, { WastewaterSparkline } from './WastewaterChart'
import LoadingProgress from './LoadingProgress'
import '../niwis/rwqo.css'
import '../niwis/water-quantity.css'

const BLUE = '#80bdff', TEAL = '#6ce0c0', GOLD = '#ecc784', PURPLE = '#c0abff', CORAL = '#ef99af'
const KPI_COLORS = [BLUE, TEAL, GOLD, PURPLE, CORAL, GOLD, BLUE, CORAL]
const KPI_ICONS = [ArrowLeftRight, ArrowLeftRight, ArrowLeftRight, ArrowLeftRight, Droplets, Zap, Mountain, Gauge]
const ROUTE_GUIDE = {
  katse_vaal: 'Katse to the Vaal system; this source column is associated with the Lesotho Highlands Water Project.',
  tugela_vaal: 'The Tugela-to-Vaal transfer, named by the source table.',
  orange_transfer: 'The database calls this the Orange River System transfer; Orange–Vaal is the route name used here.',
  thukela_vaal: 'The Thukela-to-Vaal source column combines emergency and regular transfers.',
}
const SCHEMATIC_ROUTES = [
  { key: 'katse_vaal', source: 'Lesotho Highlands (Katse)' },
  { key: 'orange_transfer', source: 'Orange River System' },
  { key: 'tugela_vaal', source: 'Tugela System' },
  { key: 'thukela_vaal', source: 'Thukela System' },
]
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

function IndicatorChart({ title, choices, rows, color, className = '' }) {
  const [key, setKey] = useState(choices[0]?.key), [type, setType] = useState('area')
  const metric = choices.find(item => item.key === key) || choices[0]
  const latest = rows.filter(row => valid(row[metric?.key])).at(-1)
  return <Panel title={title} subtitle="Monthly records · supplied units retained" className={`wq-indicator-panel ${className}`}>
    <div className="rq-chart-controls"><label>Indicator<select aria-label={`${title} indicator`} value={metric?.key || ''} onChange={event => setKey(event.target.value)}>{choices.map(item => <option key={item.key} value={item.key}>{item.label}</option>)}</select></label><label>Chart<select aria-label={`${title} chart style`} value={type} onChange={event => setType(event.target.value)}><option value="area">Area</option><option value="line">Line</option><option value="bar">Bars</option></select></label></div>
    <div className="rq-readout"><div><strong style={{ color }}>{format(latest?.[metric?.key])}<small>{metric?.unit}</small></strong><span>{latest ? periodLabel(latest.period) : 'No numeric observations'}</span></div></div>
    <WastewaterChart data={rows} metrics={metric ? [{ ...metric, color }] : []} xKey="period" type={type} height={255} yLabel={metric?.unit} />
  </Panel>
}

function DemandDistribution({ latest }) {
  const sectors = [
    { key: 'agricultural_volume', label: 'Agricultural', color: TEAL },
    { key: 'municipal_volume', label: 'Municipal', color: BLUE },
    { key: 'industrial_volume', label: 'Industrial', color: GOLD },
    { key: 'environmental_reserve', label: 'Environmental Reserve', color: PURPLE },
  ].map(item => ({ ...item, value: latest[item.key] }))
  const total = latest.reported_demand
  let offset = 0
  const stops = sectors.filter(item => valid(item.value) && item.value > 0 && valid(total) && total > 0).map(item => {
    const start = offset
    offset += item.value / total * 100
    return `${item.color} ${start}% ${offset}%`
  })
  const gradient = stops.length ? `conic-gradient(${stops.join(', ')})` : '#23445b'

  return <Panel title="Water demand (monthly)" subtitle={`${periodLabel(latest.period)} · source sector values`} className="wq-demand-panel">
    <div className="wq-demand-layout">
      <div className="wq-demand-donut" style={{ '--wq-demand-gradient': gradient }} aria-label={`Reported total demand ${format(total)} million cubic metres`}>
        <div><span>Reported total demand</span><strong>{format(total)}</strong><small>Mm³</small></div>
      </div>
      <div className="wq-demand-legend">{sectors.map(item => <div className="wq-demand-row" key={item.key}><i style={{ background: item.color }} /><span>{item.label}</span><strong>{format(item.value)} <small>{valid(item.value) && valid(total) && total > 0 ? `${format(item.value / total * 100, 1)}%` : '—'}</small></strong></div>)}</div>
    </div>
    <p className="rq-note">Shares use the reported total demand as denominator. Environmental Reserve is already included in that total.</p>
  </Panel>
}

function BalanceFlow({ result }) {
  const entries = result.balance.calculation_components || []
  const inflows = entries.filter(item => item.component === '+ MAP' || item.component === '+ Net IBT')
  const deductions = entries.filter(item => item.component.startsWith('−'))
  const reported = entries.find(item => item.component === 'Reported balance')
  const check = result.balance.calculation_checks?.reported_balance
  const renderTerms = (rows, kind) => rows.map(item => <div className={`wq-flow-term ${kind}`} key={item.component}><span>{item.component}</span><strong>{format(item.signed_volume)} <small>Mm³</small></strong></div>)

  return <Panel title="Water balance flow" subtitle={`${periodLabel(result.balance.latest_period)} · inferred source arithmetic`} className="wq-flow-panel">
    <div className="wq-flow-groups">
      <div className="wq-flow-group"><span>Source inputs</span>{renderTerms(inflows, 'inflow')}</div>
      <b className="wq-flow-arrow" aria-hidden="true">→</b>
      <div className="wq-flow-group"><span>Source deductions</span>{renderTerms(deductions, 'deduction')}</div>
      <b className="wq-flow-arrow" aria-hidden="true">→</b>
      <div className="wq-flow-group wq-flow-result"><span>Reported balance</span><strong>{format(reported?.signed_volume)} <small>Mm³</small></strong></div>
    </div>
    <p className="rq-note">{check ? `${check.matching_rows} of ${check.complete_rows} complete source months match within ${format(check.tolerance_mm3)} Mm³.` : 'Source arithmetic check unavailable.'} This is an inferred calculation, not a verified hydraulic flow model.</p>
  </Panel>
}

function TransferSystemDiagram({ metrics, values }) {
  const routes = SCHEMATIC_ROUTES.map(route => {
    const index = metrics.findIndex(item => item.key === route.key)
    return { ...route, metric: metrics[index], color: KPI_COLORS[index] }
  }).filter(route => route.metric)

  return <div className="wq-system-map" aria-label="Schematic of named transfer systems flowing to the Vaal System">
    <div className="wq-system-routes">{routes.map(route => <article className="wq-system-route" key={route.key} style={{ '--wq-accent': route.color }}>
      <span className="wq-system-source">{route.source}</span>
      <strong>{format(values[route.key])}<small>{route.metric.unit}</small></strong>
      <span className="wq-system-route-name">{route.metric.label}</span>
    </article>)}</div>
    <div className="wq-system-connectors" aria-hidden="true">{routes.map(route => <span key={route.key} style={{ '--wq-accent': route.color }} />)}</div>
    <div className="wq-system-receiving"><span>RECEIVING SYSTEM</span><strong>Vaal System</strong><p>Receives the transfers shown by the route columns.</p></div>
  </div>
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
  const [mapKey, setMapKey] = useState('donor_storage'), [mapPeriod, setMapPeriod] = useState('')
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
  const mapPeriods = result?.transfers.map_periods || []
  const activeMapPeriod = mapPeriods.includes(mapPeriod) ? mapPeriod : result?.transfers.map_period
  const mapRows = result?.transfers.map_history?.[activeMapPeriod] || result?.transfers.map || []
  const mapValues = useMemo(() => Object.fromEntries(mapRows.map(row => [normaliseDistrictName(row.district_name), row])), [mapRows])
  const mapScale = useMemo(() => buildDistrictMapScale(mapRows, mapKey, mapMetric?.label, mapMetric?.unit, value => format(value), features.length), [mapRows, mapKey, mapMetric, features.length])
  const selectDistrict = name => {
    const district = meta.regions.find(value => normaliseDistrictName(value) === normaliseDistrictName(name))
    if (district) { setMapSelectionNotice(''); const next = { ...applied, region: district }; setDraft(next); setApplied(next) }
    else setMapSelectionNotice(`No transfer records are supplied for ${name}. Select a covered district to filter the charts.`)
  }
  const transferAtMapPeriod = result?.transfers.monthly.find(row => row.period === activeMapPeriod) || result?.transfers.latest || {}
  const latestBalance = result?.balance.latest || {}
  const storageRows = (result?.balance.monthly || []).filter(row => valid(row.surface_storage))
  const previousStorage = storageRows.length > 1 ? storageRows[storageRows.length - 2] : null
  const storageChange = previousStorage && valid(latestBalance.surface_storage) ? latestBalance.surface_storage - previousStorage.surface_storage : null
  const comparison = useMemo(() => [...mapRows].sort((a, b) => (b[mapKey] ?? -Infinity) - (a[mapKey] ?? -Infinity)), [mapRows, mapKey])

  return <div className="rwqo-dashboard water-quantity-dashboard">
    <header className="rq-heading"><span className="rq-heading-icon"><Waves size={29} /></span><div><span className="rq-eyebrow">WATER TRANSFERS &amp; NATIONAL WATER BALANCE</span><h1>Water Quantity Assessment</h1><p>See which transfer systems are reported, how much water they carry, and how the national water figures compare.</p></div><button className="rq-export" disabled={!result || loading} onClick={() => exportCSV(result, meta)}><Download size={15} />Export monthly data</button></header>
    <form className="rq-filters" onSubmit={event => { event.preventDefault(); setApplied({ ...draft }) }}>
      <label className="rq-region">Transfer district<select aria-label="Water quantity district" value={draft.region} disabled={!meta || loading} onChange={event => setDraft({ ...draft, region: event.target.value })}><option value="National">National mean (reporting districts)</option>{meta?.regions.map(name => <option key={name}>{name}</option>)}</select></label>
      {['start', 'end'].map(key => <label key={key}>{key === 'start' ? 'From year' : 'To year'}<select aria-label={'Water quantity ' + key + ' year'} value={draft[key]} disabled={!meta || loading} onChange={event => setDraft({ ...draft, [key]: event.target.value })}>{!meta && <option value="">Loading…</option>}{meta?.years.map(year => <option key={year}>{year}</option>)}</select></label>)}
      <button className="rq-apply" disabled={!meta || loading}>Apply filters</button><span className="rq-cache"><Activity size={13} />{format((meta?.cache_ttl_seconds || 86400) / 3600, 0)}-hour retrieval cache</span>
    </form>
    {error && <div className="rq-error" role="alert"><AlertTriangle size={18} /><span>{error}</span><button onClick={() => setRetry(value => value + 1)}><RefreshCw size={14} />Retry</button></div>}
    {loading && <LoadingProgress className="rq-loading" message="Retrieving water quantity database records" />}
    {result && !loading && <>
      <div className="rq-context"><strong>Transfers: {result.region === 'National' ? 'National mean across reporting districts' : result.region} / Balance: National</strong><span>{result.start}–{result.end} · monthly source records · {meta.regions.length} transfer districts</span></div>
      <div className="rq-source-notice" role="note"><AlertTriangle size={16} /><span><strong>Monthly source data.</strong> Daily observations are not supplied. Transfer fields retain daily-rate units; national balance fields retain Mm³. The stored net-balance formula is an inferred source calculation with unverified accounting conventions.</span></div>
      {result.transfers.latest_all_route_zero_districts > 0 && <div className="rq-source-notice wq-zero-notice" role="note"><AlertTriangle size={16} /><span><strong>Stored zero transfer rates.</strong> {result.transfers.latest_all_route_zero_districts} selected source districts report zero in all four route columns for {periodLabel(result.transfers.latest_period)}. The source provides no zero-verification or operating-status flags.</span></div>}
      <section className="wq-reading-guide" aria-label="Plain-language guide">
        <strong>How to read this dashboard</strong>
        <p>The first four indicators are named water-transfer systems. Their m³/day values are rates in monthly records, not monthly totals. The map shades districts by the selected measurement; it does not trace canals or tunnels. Source basins are where transfers start, and receiving systems are where water goes.</p>
        <p><b>Terms:</b> FSC means full supply capacity; ML is one million litres; Mm³ is one million cubic metres. MAP is precipitation, AET is water returned to the air by evaporation and plants, MAR is runoff, and IBT means water transferred between river basins.</p>
      </section>

      <section className="wq-key-indicators" aria-label="Key water quantity indicators">
        <div className="wq-overview-heading"><div><span>DATABASE VALUES / SELECTED TRANSFER SYSTEM</span><h2>Key Water Quantity Indicators</h2></div><p>{periodLabel(result.transfers.latest_period)} · {result.region === 'National' ? 'average across reporting districts' : result.region} · monthly source records</p></div>
        <div className="wq-indicator-grid">{meta.transfer_indicators.map((metric, index) => {
          const Icon = KPI_ICONS[index % KPI_ICONS.length], color = KPI_COLORS[index % KPI_COLORS.length]
          return <article className="wq-indicator-card" key={metric.key} style={{ '--wq-accent': color }}>
            <div className="wq-indicator-label"><Icon size={16} /><span>{metric.label}</span></div>
            <strong>{format(result.transfers.latest[metric.key])}<small>{metric.unit}</small></strong>
            <div className="wq-indicator-history"><span>{periodLabel(result.transfers.latest_period)} · source value</span><WastewaterSparkline data={result.transfers.monthly.slice(-18)} metricKey={metric.key} label={metric.label} color={color} height={28} /></div>
          </article>
        })}</div>
      </section>

      <div className="wq-overview-grid">
        <Panel title="Transfer systems — sources to Vaal" subtitle={periodLabel(activeMapPeriod) + ' · schematic route view from the supplied transfer records'} className="wq-transfer-panel">
          <div className="wq-basin-grid">
            <div className="wq-map-block">
              <div className="rq-chart-controls wq-period-controls"><label className="rq-picker">Reported month<select aria-label="Transfer-system reporting month" value={activeMapPeriod || ''} onChange={event => setMapPeriod(event.target.value)}>{mapPeriods.map(period => <option key={period} value={period}>{periodLabel(period)}</option>)}</select></label></div>
              <TransferSystemDiagram metrics={meta.transfer_indicators.slice(0, 4)} values={transferAtMapPeriod} />
              <p className="rq-note"><MapPin size={12} />Schematic, not to geographic scale. Arrows show the named source-to-Vaal routes; colors identify each system and do not encode volume. Values come from the selected month’s database records.</p>
            </div>
            <div className="wq-transfer-details">
              <div className="wq-subheading"><div><span>NAMED TRANSFER SYSTEMS</span><h3>Routes and reported rates</h3></div><small>{periodLabel(transferAtMapPeriod.period)}</small></div>
              <div className="rq-table-scroll"><table className="wq-route-table"><thead><tr><th>System / route</th><th>Reported rate</th><th>Data source</th></tr></thead><tbody>{meta.transfer_indicators.slice(0, 4).map((metric, index) => <tr key={metric.key}><th scope="row" style={{ '--wq-accent': KPI_COLORS[index] }}><span>{metric.label}</span><small className="wq-route-description">{ROUTE_GUIDE[metric.key]}</small></th><td>{format(transferAtMapPeriod[metric.key])}<small>{metric.unit}</small></td><td>{metric.reference_agency}</td></tr>)}</tbody></table></div>
              <p className="rq-note">Tugela–Vaal and Thukela–Vaal are separate source columns. The source does not explain scheme overlap, so their rates are not added together.</p>
            </div>
          </div>
        </Panel>

        <div className="wq-right-stack">
          <Panel title="National water balance (monthly)" subtitle={periodLabel(result.balance.latest_period) + ' · source values in Mm³; accumulation basis not specified'} className="wq-balance-table-panel">
            <div className="rq-table-scroll"><table className="wq-balance-table"><thead><tr><th>Component</th><th>Symbol</th><th>Source value</th><th>Source</th></tr></thead><tbody>{meta.balance_indicators.filter(item => ['map_volume', 'aet_volume', 'runoff_volume', 'recharge_volume', 'surface_storage', 'net_ibt', 'reported_demand', 'reported_balance'].includes(item.key)).map(metric => <tr key={metric.key}><th scope="row">{metric.label}</th><td>{metric.key === 'map_volume' ? 'MAP' : metric.key === 'aet_volume' ? 'AET' : metric.key === 'runoff_volume' ? 'MAR' : metric.key === 'recharge_volume' ? 'R' : metric.key === 'surface_storage' ? 'Storage' : metric.key === 'net_ibt' ? 'IBT' : metric.key === 'reported_demand' ? 'Demand' : 'Balance'}</td><td>{format(latestBalance[metric.key])}</td><td>{metric.reference_agency}</td></tr>)}</tbody></table></div>
          </Panel>
          <DemandDistribution latest={latestBalance} />
        </div>
      </div>

      <div className="wq-bottom-grid">
        <BalanceFlow result={result} />
        <Panel title="National surface storage" subtitle={periodLabel(result.balance.latest_period) + ' · reported stock'} className="wq-storage-panel">
          <div className="wq-storage-readout"><strong>{format(latestBalance.surface_storage)}<small>Mm³</small></strong><span>National source value</span></div>
          <div className={'wq-storage-change ' + (storageChange == null ? '' : storageChange >= 0 ? 'positive' : 'negative')}><span>Change from prior available month</span><strong>{storageChange == null ? '—' : (storageChange > 0 ? '+' : '') + format(storageChange) + ' Mm³'}</strong>{previousStorage && <small>{periodLabel(previousStorage.period)}</small>}</div>
          <WastewaterSparkline data={result.balance.monthly.slice(-24)} metricKey="surface_storage" label="National surface storage" color={BLUE} height={72} />
          <p className="rq-note">The source supplies an absolute storage value, not reservoir capacity or % full.</p>
        </Panel>
        <IndicatorChart title="Recent trends (National)" choices={meta.balance_indicators.filter(item => ['map_volume', 'aet_volume', 'runoff_volume', 'recharge_volume', 'surface_storage', 'reported_demand', 'reported_balance'].includes(item.key))} rows={result.balance.monthly} color={BLUE} className="wq-trend-panel" />
      </div>

      <details className="rq-methods wq-detail-methods"><summary>District map, monthly trends, calculations and comparisons</summary>
        <div className="wq-detail-grid">
          <Panel title="Transfer route trends" subtitle="Monthly source rates; routes remain separate"><WastewaterChart data={result.transfers.monthly} metrics={meta.transfer_indicators.slice(0, 4).map((item, index) => ({ ...item, color: KPI_COLORS[index] }))} type="line" xKey="period" height={290} /><p className="rq-note">Daily-rate units are retained in monthly reporting rows. No monthly transfer volume is generated.</p></Panel>
          <Panel title="District source coverage map" subtitle={periodLabel(activeMapPeriod) + ' · selected transfer measure by reporting district'}>
            <div className="rq-chart-controls wq-map-controls"><label className="rq-picker">District measure<select aria-label="District map measure" value={mapKey} onChange={event => setMapKey(event.target.value)}>{meta.transfer_indicators.map(item => <option key={item.key} value={item.key}>{item.label} ({item.unit})</option>)}</select></label><label className="rq-picker">Reporting month<select aria-label="District map reporting month" value={activeMapPeriod || ''} onChange={event => setMapPeriod(event.target.value)}>{mapPeriods.map(period => <option key={period} value={period}>{periodLabel(period)}</option>)}</select></label></div>
            {features.length ? <DistrictMap districts={features} values={mapValues} valueKey={mapKey} selected={result.region} onSelect={selectDistrict} colorFn={mapScale.color} legend={mapScale.legend} valueLabel={mapMetric.label} valueUnit={mapMetric.unit} formatValue={value => format(value)} /> : <p className="rq-empty" role="status">{mapError || 'District boundaries are loading.'}</p>}
            <p className="rq-note"><MapPin size={12} />Colors show four equal-width value bands for the selected measure. Grey districts have no matching source value. This is district coverage, separate from the named system schematic above.</p>
            {mapSelectionNotice && <p className="rq-note wq-map-selection" role="status">{mapSelectionNotice}</p>}
            {result.region !== 'National' && <button className="rq-text-button" onClick={() => { const next = { ...applied, region: 'National' }; setDraft(next); setApplied(next) }}>Return to national district mean</button>}
          </Panel>
          <IndicatorChart title="Transfer losses and energy" choices={meta.transfer_indicators.slice(4, 6)} rows={result.transfers.monthly} color={GOLD} />
          <IndicatorChart title="Source storage and receiving-system shortfall" choices={meta.transfer_indicators.slice(6)} rows={result.transfers.monthly} color={TEAL} />
          <Panel title="Covered district comparison" subtitle={periodLabel(activeMapPeriod) + ' · follows the map indicator'}><WastewaterChart data={comparison} metrics={[{ ...mapMetric, color: BLUE }]} xKey="district_name" horizontal type="bar" height={Math.max(270, comparison.length * 24)} /><p className="rq-note">All supplied source districts remain available. National balance records have no district identifiers.</p></Panel>
          <Panel title="Reported national net balance" subtitle={'National monthly source record · ' + periodLabel(result.balance.latest_period)}><WastewaterChart data={result.balance.monthly} metrics={[{ key: 'reported_balance', label: 'Reported net balance', unit: 'Mm³', color: CORAL }]} type="area" xKey="period" height={270} referenceLine={{ value: 0, label: 'Zero' }} /><p className="rq-note">Negative source values are retained. The source does not document an operational deficit classification.</p></Panel>
          <Panel title="Source calculation checks" subtitle="Arithmetic consistency across national reporting months"><div className="wq-check-list">{Object.entries(result.balance.calculation_checks || {}).map(([key, check]) => <article key={key}><span>{key === 'total_demand' ? 'Total demand, including Reserve' : 'Reported net balance'}</span><code>{check.expression}</code><strong>{check.matching_rows} / {check.complete_rows} complete records match</strong><small>Maximum difference {format(check.max_absolute_difference_mm3)} Mm³ · tolerance {check.tolerance_mm3} Mm³</small></article>)}</div><p className="rq-note">These are inferred source identities, not independently verified accounting methods.</p></Panel>
          <Panel title="National water balance component register" subtitle={periodLabel(result.balance.latest_period) + ' · source fields and reference agencies'} className="wq-component-panel"><div className="rq-table-scroll"><table className="wq-component-table"><thead><tr><th>Component</th><th>Source value</th><th>Unit</th><th>Reference agency</th></tr></thead><tbody>{result.balance.components.map(item => <tr key={item.key}><th scope="row">{item.label}</th><td>{format(item.value)}</td><td>{item.unit}</td><td>{item.reference_agency}</td></tr>)}</tbody></table></div><p className="rq-note">Total demand already includes the Environmental Reserve.</p></Panel>
        </div>
      </details>

      <details className="rq-methods"><summary>Table inspection, coverage &amp; interpretation</summary><div className="rq-source-grid wq-source-grid">{Object.entries(meta.audits).map(([kind, audit]) => <article key={kind}><strong>{kind === 'transfers' ? 'Transfer rates & basin conditions' : 'National water balance'}</strong><code>{audit.table}</code><span>{audit.rows.toLocaleString('en-ZA')} records · {audit.scope}</span><span>{periodLabel(audit.first_period)} – {periodLabel(audit.last_period)}</span><span>{audit.duplicate_keys} duplicate keys · {audit.missing_entity_months} missing reporting rows · {audit.missing_measurements} missing measurements</span>{kind === 'transfers' && <span>{audit.entities} source districts</span>}{kind === 'balance' && <span>{audit.ranges.filter(item => item.distinct === 1).length} constant-valued fields across this source history</span>}</article>)}</div><ul>{meta.limitations.map(value => <li key={value}>{value}</li>)}</ul><p>Successful source reads, prepared data and API responses use the shared {format(meta.cache_ttl_seconds / 3600, 0)}-hour memory cache. Failed reads are retried and are not cached. Restart or cache eviction can remove entries sooner. Retrieval time does not establish a new observation date.</p></details>
    </>}
  </div>
}
