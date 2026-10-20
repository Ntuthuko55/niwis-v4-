import { dashboardFetch as fetch } from '../services/dashboardFetch'
import { useEffect, useMemo, useState } from 'react'
import { Activity, ArrowDownRight, ArrowUpRight, CloudRain, Database, Droplets, Leaf, MapPin, RefreshCw, ShieldCheck, Thermometer, Waves } from 'lucide-react'
import { ResponsiveContainer, ComposedChart, Line, Bar, Area, CartesianGrid, XAxis, YAxis, Tooltip, Legend, ReferenceLine } from 'recharts'
import { DistrictMap, normaliseDistrictName } from './DistrictMap'
import LoadingProgress from './LoadingProgress'
import '../niwis/drought-monitoring.css'

const names = { meteorological: 'Meteorological', hydrological: 'Hydrological', satellite: 'Satellite' }
const mapOptions = {
  meteorological: [
    ['spi_1', 'SPI-1'], ['spi_3', 'SPI-3'], ['spi_6', 'SPI-6'], ['spi_12', 'SPI-12'], ['spi_24', 'SPI-24'],
    ['spei_1', 'SPEI-1'], ['spei_3', 'SPEI-3'], ['spei_6', 'SPEI-6'], ['spei_12', 'SPEI-12'], ['spei_24', 'SPEI-24'],
  ],
  hydrological: [['ssi_dimensionless', 'SSI']],
  satellite: [['ndvi', 'NDVI']],
}
const number = (v, digits = 2) => v == null || !Number.isFinite(Number(v)) ? '—' : Number(v).toLocaleString('en-ZA', { maximumFractionDigits: digits, minimumFractionDigits: digits })
const spiColor = (v) => v <= -2 ? '#f45b72' : v <= -1.5 ? '#ff944d' : v <= -1 ? '#f8ce65' : v <= 1 ? '#58cda0' : '#26b9f5'
const ndviColor = (v) => v < .2 ? '#f04444' : v < .4 ? '#fa8c25' : v < .6 ? '#f4dc45' : v < .8 ? '#80cf8c' : '#28b588'
const monthName = (m) => new Date(`${m}-15T00:00:00`).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })
async function read(url, signal) {
  const response = await fetch(url, { signal })
  const body = await response.json()
  if (!response.ok) throw new Error(body.detail || 'Unable to read dashboard observations.')
  return body
}
function Panel({ title, subtitle, children, className = '', action }) {
  return <section className={`dm-panel ${className}`}><header><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>{action}</header>{children}</section>
}
function Chart({ data, lines, bars = [], unit = '', zero = false, domain, height = 195 }) {
  if (!data?.length) return <div className="dm-empty">No observations available for this period.</div>
  return <div className="dm-chart" style={{ height }}><ResponsiveContainer width="100%" height="100%"><ComposedChart data={data} margin={{ top: 8, right: 10, left: -13, bottom: 0 }}>
    <CartesianGrid stroke="#15374d" vertical={false} strokeDasharray="3 4" />
    <XAxis dataKey="month" tick={{ fill: '#80a4bb', fontSize: 10 }} tickLine={false} axisLine={false} minTickGap={35} tickFormatter={(v) => v.length === 7 ? v.slice(0, 4) + '/' + v.slice(5) : v} />
    <YAxis tick={{ fill: '#80a4bb', fontSize: 10 }} tickLine={false} axisLine={false} domain={domain || ['auto', 'auto']} width={55} />
    <Tooltip contentStyle={{ background: '#08253b', border: '1px solid #226081', borderRadius: 8, color: '#e8f8ff', fontSize: 12 }} labelFormatter={(v) => v?.length === 7 ? monthName(v) : v} formatter={(v, name) => [`${number(v)} ${unit}`, name]} />
    <Legend iconType="plainline" wrapperStyle={{ fontSize: 10, paddingTop: 5 }} />
    {zero && <ReferenceLine y={0} stroke="#7299af" strokeDasharray="3 3" />}
    {bars.map(([key, label, color]) => <Bar key={key} dataKey={key} name={label} fill={color} radius={[2, 2, 0, 0]} maxBarSize={15} isAnimationActive={false} />)}
    {lines?.map(([key, label, color, area]) => area ? <Area key={key} dataKey={key} name={label} stroke={color} fill={color} fillOpacity={.1} strokeWidth={1.8} dot={false} connectNulls={false} isAnimationActive={false} /> : <Line key={key} dataKey={key} name={label} stroke={color} strokeWidth={1.8} dot={false} connectNulls={false} isAnimationActive={false} />)}
  </ComposedChart></ResponsiveContainer></div>
}
function Metric({ icon: Icon, label, value, unit, date, accent }) {
  return <article className="dm-metric" style={{ '--accent': accent }}><span className="dm-metric-icon"><Icon size={22} /></span><div><span>{label}</span><strong>{number(value, label === 'Dam storage' ? 1 : 2)} <small>{unit}</small></strong><em>{date || 'No observation'}</em></div></article>
}
function Comparison({ title, data, unit }) {
  if (!data) return <div className="dm-comparison"><span>{title}</span><strong>No complete observations</strong></div>
  const Icon = data.change_pct < 0 ? ArrowDownRight : ArrowUpRight
  return <div className="dm-comparison"><span>{title} · {monthName(data.month)}</span><strong>{number(data.current)} <small>{unit}</small></strong><p>{data.change_pct == null ? 'Insufficient comparable history' : <><Icon size={14} /> {number(Math.abs(data.change_pct), 1)}% {data.change_pct < 0 ? 'below' : 'above'} same-month mean</>}</p><small>{data.baseline_years} prior years{data.baseline_start ? ` · ${data.baseline_start.slice(0, 4)}–${data.baseline_end.slice(0, 4)}` : ''}</small></div>
}

export default function DroughtMonitoring({ renderForecast }) {
  const [regions, setRegions] = useState([])
  const [mapRegions, setMapRegions] = useState([])
  const [geometry, setGeometry] = useState([])
  const [selected, setSelected] = useState('')
  const [payload, setPayload] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [catalogError, setCatalogError] = useState('')
  const [mapLayer, setMapLayer] = useState('meteorological')
  const [mapMetric, setMapMetric] = useState('spi_3')
  const [windowMonths, setWindowMonths] = useState(120)
  const [temperature, setTemperature] = useState('tavg_c')
  const [evaporation, setEvaporation] = useState('pet_mm_day')
  const [revision, setRevision] = useState(0)
  const [mapDate, setMapDate] = useState('')
  const [mapLoading, setMapLoading] = useState(false)
  const [mapError, setMapError] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    setCatalogError('')
    Promise.all([read('/api/drought-monitoring/regions', controller.signal), read('/south_africa_adm2.display.geojson', controller.signal)])
      .then(([catalog, geo]) => {
        if (controller.signal.aborted) return
        const availableRegions = Array.isArray(catalog.regions) ? catalog.regions : []
        setRegions(availableRegions)
        setMapRegions(availableRegions)
        setGeometry(geo.features || [])
        setSelected((current) => availableRegions.find((r) => r.key === normaliseDistrictName(current))?.name || availableRegions.find((r) => r.key === 'tshwane')?.name || availableRegions[0]?.name || '')
        if (!availableRegions.length) {
          setLoading(false)
          const sourceErrors = Object.values(catalog.errors || {}).filter(Boolean)
          setCatalogError(sourceErrors.length ? `Drought data source unavailable: ${sourceErrors.join(' ')}` : 'No regional observations are available from the database.')
        }
        else if (Object.keys(catalog.errors || {}).length) setCatalogError(`Some map sources are unavailable: ${Object.keys(catalog.errors).map((k) => names[k]).join(', ')}.`)
      }).catch((e) => { if (!controller.signal.aborted) { setCatalogError(e.message); setLoading(false) } })
    return () => controller.abort()
  }, [revision])
  useEffect(() => {
    if (!mapDate) return undefined
    const controller = new AbortController()
    setMapLoading(true)
    setMapError('')
    read(`/api/drought-monitoring/regions?date=${encodeURIComponent(mapDate)}`, controller.signal)
      .then((catalog) => { if (!controller.signal.aborted) setMapRegions(Array.isArray(catalog.regions) ? catalog.regions : []) })
      .catch((e) => { if (!controller.signal.aborted) setMapError(e.message) })
      .finally(() => { if (!controller.signal.aborted) setMapLoading(false) })
    return () => controller.abort()
  }, [mapDate])
  useEffect(() => {
    if (!selected) return
    const controller = new AbortController()
    setLoading(true)
    setPayload(null)
    setError('')
    read(`/api/drought-monitoring/region?region=${encodeURIComponent(selected)}`, controller.signal)
      .then((data) => { if (!controller.signal.aborted) { setPayload(data); setMapDate('') } }).catch((e) => { if (!controller.signal.aborted) setError(e.message) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [selected, revision])
  const source = payload?.sources || {}
  const met = source.meteorological?.latest || {}, hydro = source.hydrological?.latest || {}, sat = source.satellite?.latest || {}
  const climate = source.meteorological?.monthly || [], water = source.hydrological?.monthly || [], vegetation = source.satellite?.monthly || []
  const slice = (rows) => windowMonths ? rows.slice(-windowMonths) : rows
  const aligned = payload?.alignment
  const values = useMemo(() => Object.fromEntries(mapRegions.map((r) => [r.key, r.sources[mapLayer] || {}])), [mapRegions, mapLayer])
  const selectedMapOption = mapOptions[mapLayer].find(([key]) => key === mapMetric) || mapOptions[mapLayer][0]
  const mapKey = selectedMapOption[0]
  const mapLabel = selectedMapOption[1]
  const mapValues = values
  const mapDates = [...new Set(Object.values(values).map((r) => r.date).filter(Boolean))].sort()
  const mapDateOptions = useMemo(() => {
    const sets = [climate, water, vegetation].map(rows => new Set(rows.map(point => point.month).filter(Boolean))).filter(set => set.size)
    if (!sets.length) return []
    return [...sets.slice(1).reduce((common, set) => new Set([...common].filter(month => set.has(month))), sets[0])].sort()
  }, [climate, water, vegetation])
  useEffect(() => {
    if (!mapDate && mapDateOptions.length) setMapDate(mapDateOptions.at(-1))
  }, [mapDate, mapDateOptions])
  const completeClimate = climate.filter((p) => p.complete)
  const currentYear = completeClimate.at(-1)?.month.slice(0, 4)
  const previousYear = currentYear ? String(Number(currentYear) - 1) : ''
  const rainfall = Array.from({ length: 12 }, (_, i) => {
    const month = String(i + 1).padStart(2, '0')
    return { month: new Date(2020, i, 1).toLocaleString('en', { month: 'short' }), current: completeClimate.find((p) => p.month === `${currentYear}-${month}`)?.rainfall_mm, previous: completeClimate.find((p) => p.month === `${previousYear}-${month}`)?.rainfall_mm }
  })
  const annual = (source.meteorological?.annual || []).slice(-10).map((point) => ({ ...point, month: `${point.month}${point.complete ? '' : '*'}` }))
  const indicatorRows = [
    ...mapOptions.meteorological.map(([key, label]) => [label, met[key], '', met.date, 'Meteorological']),
    ['Streamflow index · SSI', hydro.ssi_dimensionless, '', hydro.date, 'Hydrological'], ['Groundwater index · SGI', hydro.sgi_dimensionless, '', hydro.date, 'Hydrological'],
    ['Vegetation health · VHI', sat.vhi, '%', sat.date, 'Satellite'], ['Land surface temperature', sat.lst, '°C', sat.date, 'Satellite'], ['Surface soil moisture', sat.surface_soil_moisture, 'm³/m³', sat.date, 'Satellite'], ['GRACE water storage', sat.grace_tws, 'cm', sat.date, 'Satellite'],
  ]
  const titleRegion = selected || 'South Africa'
  return <div className="dm-dashboard">
    <div className="dm-heading"><div><span className="dm-eyebrow">NIWIS / INTEGRATED WATER INTELLIGENCE</span><h1>Drought monitoring</h1><p>Climate, water and vegetation. One regional picture.</p></div><div className="dm-heading-actions"><span className="dm-source-pill"><Database size={13} /> Supabase observations</span><button className="dm-refresh" onClick={() => setRevision((v) => v + 1)} aria-label="Refresh drought monitoring"><RefreshCw size={16} /></button></div></div>
    <div className="dm-controls"><label className="dm-region"><MapPin size={23} /><div><span>REGION / MUNICIPALITY</span><select aria-label="Monitoring region" value={selected} onChange={(e) => setSelected(e.target.value)}>{regions.map((r) => <option key={r.key}>{r.name}</option>)}</select></div></label><div className="dm-source-dates">{Object.entries(names).map(([kind, label]) => <div key={kind}><i className={source[kind]?.status === 'ok' ? 'ok' : ''} /><span>{label}<strong>{loading ? 'Loading…' : source[kind]?.end || 'Unavailable'}</strong></span></div>)}</div><label className="dm-range">Chart history<select aria-label="Chart history" value={windowMonths} onChange={(e) => setWindowMonths(Number(e.target.value))}><option value={60}>Last 5 years</option><option value={120}>Last 10 years</option><option value={0}>All observations</option></select></label></div>
    {catalogError && <p className="dm-warning" role="alert">{catalogError}</p>}{error && <p className="dm-warning" role="alert">{error}</p>}
    {loading && <LoadingProgress className="dm-loading" message="Assembling the regional drought picture" />}
    {!loading && payload && <>
      {Object.entries(source).filter(([, s]) => s.status !== 'ok').map(([kind, s]) => <p className="dm-warning" role="alert" key={kind}>{names[kind]}: {s.error || 'No observations for this region.'} Other available sources remain visible.</p>)}
      <div className="dm-kpis">
        <Metric icon={Thermometer} label="Mean temperature" value={met.tavg_c} unit="°C" date={met.date} accent="#49c8ff" />
        <Metric icon={CloudRain} label="Daily rainfall" value={met.daily_rainfall_mm_day} unit="mm" date={met.date} accent="#35b0ff" />
        <Metric icon={Droplets} label="Evapotranspiration · PET" value={met.pet_mm_day} unit="mm/day" date={met.date} accent="#a397ff" />
        <Metric icon={Waves} label="River discharge" value={hydro.river_discharge_m3_s} unit="m³/s" date={hydro.date} accent="#36d5e6" />
        <Metric icon={Database} label="Dam storage" value={hydro.dam_level_pct_fsc} unit="% full" date={hydro.date} accent="#5aa3ff" />
        <Metric icon={Leaf} label="Vegetation · NDVI" value={sat.ndvi} unit="" date={sat.date} accent="#66dca6" />
      </div>
      <div className="dm-grid">
        <Panel title="National drought picture" subtitle={`${names[mapLayer]} · ${mapLabel} · ${mapDate || mapDates.join(' / ') || 'No observations'}`} className="dm-map-panel">
          <div className="dm-tabs">{[['meteorological', 'SPI / SPEI'], ['hydrological', 'SSI'], ['satellite', 'NDVI']].map(([key, label]) => <button key={key} className={mapLayer === key ? 'active' : ''} onClick={() => { setMapLayer(key); setMapMetric(mapOptions[key][0][0]) }}>{label}</button>)}</div>
          <div className="dm-map-controls"><label className="dm-map-selector">Map indicator<select aria-label="Drought map indicator" value={mapKey} onChange={(event) => setMapMetric(event.target.value)}>{mapOptions[mapLayer].map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label><label className="dm-map-selector">Map month<select aria-label="Drought map month" value={mapDate || mapDateOptions.at(-1) || ''} onChange={(event) => setMapDate(event.target.value)}>{mapDateOptions.map(date => <option key={date}>{date}</option>)}</select></label></div>
          {mapError ? <div className="dm-empty" role="alert">{mapError}</div> : mapLoading ? <LoadingProgress className="dm-loading" message="Loading map observations" /> : <DistrictMap districts={geometry} values={values} selected={selected} onSelect={(name) => setSelected(regions.find((r) => r.key === normaliseDistrictName(name))?.name || name)} valueKey={mapKey} colorFn={mapLayer === 'satellite' ? ndviColor : spiColor} />}
          <div className="dm-map-footer"><MapPin size={14} /><strong>{titleRegion}</strong><span>{mapDate || 'Latest'} · {mapRegions.length} regions · click to explore</span></div>
        </Panel>
        <Panel title="Temperature trends" subtitle="Monthly means · °C" action={<Thermometer size={16} />}>
          <div className="dm-tabs">{[['tmin_c', 'Tmin'], ['tmax_c', 'Tmax'], ['tavg_c', 'Tavg']].map(([key, label]) => <button className={temperature === key ? 'active' : ''} key={key} onClick={() => setTemperature(key)}>{label}</button>)}</div>
          <Chart data={slice(climate)} lines={[[temperature, 'Temperature', '#39d7ef', true]]} unit="°C" />
          <p className="dm-footnote">Observed means; the most recent month may be incomplete.</p>
        </Panel>
        <Panel title="Monthly precipitation" subtitle="Daily observations summed over complete months · mm">
          <Chart data={currentYear ? rainfall : []} bars={[[ 'previous', previousYear, '#17669e'], ['current', currentYear, '#2ecbff']]} unit="mm" domain={[0, 'auto']} height={224} />
          <p className="dm-footnote">Blank months are incomplete or unavailable; they are not zero rainfall.</p>
        </Panel>
        <Panel title="Hydrological response" subtitle="Monthly river discharge · m³/s"><Chart data={slice(water)} lines={[[ 'river_discharge_m3_s', 'Discharge', '#42d5e8', true], ['baseflow_separation_m3_s', 'Baseflow', '#688cff']]} unit="m³/s" /><Comparison title="River discharge" data={payload.comparisons.hydrological} unit="m³/s" /></Panel>
        <Panel title="Vegetation & water stress" subtitle="Monthly vegetation greenness · NDVI"><Chart data={slice(vegetation)} lines={[[ 'ndvi', 'NDVI', '#6ee6ae', true]]} domain={[-1, 1]} /><Comparison title="Vegetation greenness" data={payload.comparisons.satellite} unit="NDVI" /></Panel>
        <Panel title="Drought indices" subtitle="Monthly means · precipitation and climatic water balance"><Chart data={slice(climate)} lines={[[ 'spi_3', 'SPI-3', '#3fbcff'], ['spei_3', 'SPEI-3', '#79e2ad']]} zero /><Comparison title="Monthly rainfall" data={payload.comparisons.meteorological} unit="mm" /></Panel>
        <Panel title="Heat & frost exposure" subtitle="Hot days: Tmax > 35°C · frost days: Tmin < 0°C"><Chart data={annual} bars={[[ 'hot_days', 'Hot days', '#ff9861'], ['frost_days', 'Frost days', '#53b7ff']]} unit="days" domain={[0, 'auto']} /><p className="dm-footnote">Observed days only; * marks incomplete years. Hot-day counts do not measure heatwave duration.</p></Panel>
        <Panel title="Evapotranspiration" subtitle="Monthly daily mean · mm/day"><div className="dm-tabs">{[['pet_mm_day', 'PET'], ['et0_mm_day', 'ET₀']].map(([key, label]) => <button key={key} className={evaporation === key ? 'active' : ''} onClick={() => setEvaporation(key)}>{label}</button>)}</div><Chart data={slice(climate)} lines={[[evaporation, evaporation === 'pet_mm_day' ? 'PET' : 'ET₀', '#a599ff', true]]} unit="mm/day" height={166} /></Panel>
        <Panel title="Reservoir & groundwater condition" subtitle="Monthly storage and groundwater index"><Chart data={slice(water)} lines={[[ 'dam_level_pct_fsc', 'Dam storage (% full)', '#52a5ff']]} unit="%" height={110} /><Chart data={slice(water)} lines={[[ 'sgi_dimensionless', 'Groundwater index · SGI', '#72dcbf']]} zero height={110} /></Panel>
        <Panel title="Regional indicator register" subtitle="Latest reading from each source" className="dm-register"><div className="dm-table-wrap"><table><thead><tr><th>Indicator</th><th>Value</th><th>Observed</th><th>Source</th></tr></thead><tbody>{indicatorRows.map(([label, value, unit, date, provider]) => <tr key={label}><td>{label}</td><td>{number(value)} <small>{unit}</small></td><td>{date || '—'}</td><td>{provider}</td></tr>)}</tbody></table></div></Panel>
        <Panel title="Converging drought signals" subtitle={aligned?.month ? `Aligned comparison · ${monthName(aligned.month)}` : 'No common complete observation month'} className="dm-signals" action={<Activity size={17} />}>
          <div className="dm-signal-count"><strong>{aligned?.dry_count ?? '—'}<small> / {aligned?.available_signals ?? 0}</small></strong><span>available indicators exceed<br />their dryness threshold</span></div>
          {aligned?.signals.map((signal) => <div className="dm-signal" key={signal.source}><i className={signal.dry == null ? '' : signal.dry ? 'dry' : 'normal'} /><span>{signal.name}<small>Watch threshold {signal.threshold}</small></span><strong>{number(signal.value)}</strong></div>)}
          <p className="dm-footnote">An indicator count, not a drought probability. Latest source dates differ; this comparison uses their shared complete month.</p>
        </Panel>
        <Panel title="Evidence & priorities" subtitle={titleRegion} className="dm-insights" action={<ShieldCheck size={17} />}>
          <div className="dm-insight"><CloudRain size={18} /><p>{payload.comparisons.meteorological?.change_pct != null ? `Rainfall in ${monthName(payload.comparisons.meteorological.month)} was ${number(Math.abs(payload.comparisons.meteorological.change_pct), 1)}% ${payload.comparisons.meteorological.change_pct < 0 ? 'below' : 'above'} its observed same-month historical mean.` : 'Insufficient complete rainfall history for a seasonal comparison.'}</p></div>
          <div className="dm-insight"><Waves size={18} /><p>{aligned?.spi_ssi_correlation != null ? `Monthly SPI-3 and SSI correlation: ${number(aligned.spi_ssi_correlation)} across ${aligned.paired_months} shared months. Association does not establish cause.` : 'At least 12 paired months are needed to compare precipitation and streamflow indices.'}</p></div>
          <div className="dm-insight"><ShieldCheck size={18} /><p>{!aligned?.month ? 'Restore missing source coverage before making a combined drought assessment.' : aligned.dry_count >= 2 ? 'Multiple indicators show dryness in the aligned month. Review local water availability and conservation planning alongside newer field observations.' : aligned.dry_count === 1 ? 'One indicator shows dryness in the aligned month. Monitor whether the signal also appears in streamflow and vegetation.' : 'No available indicator exceeds the selected dryness thresholds in the aligned month. Continue routine monitoring and review newer observations.'}</p></div>
        </Panel>
        <Panel title={`Forecasting studio · ${titleRegion}`} subtitle="Regional meteorological history · LSTM default · selectable models, targets and horizon" className="dm-forecast nw-overview-forecast"><span className="dm-forecast-badge">FORWARD OUTLOOK</span>{source.meteorological?.status === 'ok' ? renderForecast(met.district_name || selected) : <p className="dm-empty">Meteorological observations are required to run a regional forecast.</p>}</Panel>
      </div>
      <details className="dm-method"><summary>How this overview is calculated</summary><p>All observations come from the three Supabase drought tables. Climate charts use monthly means; rainfall uses daily sums only where every day of the month is present. Seasonal comparisons use complete observations from the same calendar month in prior years, with at least three years required. They are not a 1981–2010 reference climatology. Heat and frost counts use available daily observations; incomplete years are marked with an asterisk. SSI, SPI and VHI signals are aligned to the latest complete month shared by all three sources. Forecasts reuse the existing regional forecasting service; historical comparisons and thresholds are observational indicators, not validated impact predictions.</p></details>
      <footer className="dm-footer"><span><Droplets size={16} /> NIWIS <b>Drought intelligence</b></span><span>{Object.values(source).reduce((n, s) => n + s.records, 0).toLocaleString()} regional observations · Database observations</span></footer>
    </>}
  </div>
}
