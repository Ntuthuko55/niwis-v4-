import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { dashboardFetch as fetch } from '../services/dashboardFetch'
import DeferredPanel from './DeferredPanel'
import DataFreshness from './DataFreshness'
import LoadingProgress from './LoadingProgress'
import { ChevronDown, Droplets, Menu, SlidersHorizontal } from 'lucide-react'
import Plot from './LazyPlot'
import { modelGroups, modelKey, preferredForecastTarget, requiresFeatureSelection } from '../lib/modelOptions'
import { BALANCE, BLUEDROP, BOREHOLES, DCLASS, GREENDROP, INDICES, NAV, ROADMAP, ROLES, SETTLEMENTS, SOURCES, STATIONS, TARIFFS, WQSITES, liveProvinces } from '../niwis/demoData'
import { getProvinceSeries, getTrainingJob, loadMeteorologicalRegion, startTraining } from '../services/api'
import { DTag, MapSVG } from '../niwis/svgCharts'
import '../niwis/niwis-portal.css'
import '../niwis/dashboard-theme.css'

const DroughtMonitoring = lazy(() => import('./DroughtMonitoring'))
const ClimateDashboard = lazy(() => import('./ClimateDashboard'))
const VegetationCondition = lazy(() => import('./VegetationCondition'))
const RainfallStatus = lazy(() => import('./RainfallStatus'))
const RunoffStatus = lazy(() => import('./RunoffStatus'))
const SurfaceWaterNetwork = lazy(() => import('./SurfaceWaterNetwork'))
const GroundwaterLevelMonitoring = lazy(() => import('./GroundwaterLevelMonitoring'))
const GroundwaterReserveAssessment = lazy(() => import('./GroundwaterReserveAssessment'))
const WaterQualityMonitoring = lazy(() => import('./WaterQualityMonitoring'))
const WastewaterCompliance = lazy(() => import('./WastewaterCompliance'))
const DrinkingWaterCompliance = lazy(() => import('./DrinkingWaterCompliance'))
const ResourceWaterQualityObjectives = lazy(() => import('./ResourceWaterQualityObjectives'))
const WaterResourceManagement = lazy(() => import('./WaterResourceManagement'))
const WaterQuantityAssessment = lazy(() => import('./WaterQuantityAssessment'))
const ReservoirStatus = lazy(() => import('./ReservoirStatus'))
const Satellite = lazy(() => import('./SatelliteDrought'))
const DashboardForecastStudio = lazy(() => import('./DashboardForecastStudio'))
const HydrologyDrought = lazy(() => import('./HydrologyDrought'))
const MeteorologicalDrought = lazy(() => import('./MeteorologicalDrought'))

const descriptions = {
  overview: ['Meteorological drought', 'A single operational picture of rainfall, drought, storage and water-security risk.', 'Situation'],
  drought: ['Drought status', 'Drought classification combines the latest available provincial climate observations.', 'Situation'],
  alerts: ['Alerts and early warning', 'Priority operational alerts requiring monitoring or response.', 'Situation'],
  satellite: ['Satellite & Remote Sensing Drought', 'Overview of satellite-derived drought indicators (NDVI, VHI, soil moisture).', 'Situation'],
  hydrology: ['Hydrological Drought Monitoring', 'Rivers | Reservoirs | Groundwater | Runoff | Baseflow', 'Situation'],
  rainfall: ['Rainfall', 'Observed rainfall conditions and departures from the seasonal baseline.', 'Monitoring'],
  dams: ['Dams and reservoirs', 'Storage status for strategic national reservoirs.', 'Monitoring'],
  groundwater: ['Groundwater Level Monitoring Network', 'Borehole levels, recharge, abstraction and aquifer indicators across South Africa.', 'Monitoring'],
  'groundwater-reserve': ['Groundwater Reserve Assessment', 'Dynamic and static reserve, recharge, abstraction and aquifer sustainability across South Africa.', 'Monitoring'],
  'water-quality': ['Water Quality Monitoring Network', 'Physical, chemical, biological and SANSA water-quality observations across South Africa.', 'Monitoring'],
  wastewater: ['Wastewater Quality Compliance', 'Effluent quality, treatment works operations and SAWS conditions for South African wastewater treatment works.', 'Monitoring'],
  'drinking-water': ['Drinking Water Quality Compliance', 'Reported district drinking-water measurements, source compliance flags and quality trends.', 'Monitoring'],
  rwqo: ['Resource Water Quality Objectives', 'Ecological measurements, chemical source targets and hydrological objectives.', 'Monitoring'],
  wrm: ['Water Resource Management', 'Annual water resource variables and Strategic Water Source Area observations.', 'Monitoring'],
  'water-quantity': ['Water Quantity Assessment', 'Monthly transfer-rate records and the source national water balance.', 'Monitoring'],
  pipeline: ['Data integration', 'The connected data catalogue and the operational ingestion pipeline.', 'Platform'],
  roadmap: ['Implementation roadmap', 'A phased delivery plan for the National Integrated Water Information System.', 'Platform'],
}

function Panel({ title, source, children }) { return <section className="nw-panel"><div className="nw-phead"><h3>{title}</h3>{source && <span className="src">{source}</span>}</div>{children}</section> }
function Kpi({ label, value, unit, note, tone }) { return <article className={`nw-kpi ${tone || ''}`}><div className="lab">{label}</div><div className="val">{value}<small>{unit}</small></div>{note && <div className="delta">{note}</div>}</article> }
function Heading({ view }) { const [title, lede, crumb] = descriptions[view] || [view.replace(/\b\w/g, (v) => v.toUpperCase()), 'This NIWIS module is ready for its operational data connection.', 'NIWIS']; return <><div className="nw-crumb">{crumb} / {title}</div><h1 className="page">{title}</h1><p className="nw-lede">{lede}</p></> }

// Keep navigation shareable without adding a router dependency to the portal.
// Vite serves index.html for these paths, while this map restores the selected
// dashboard on direct load and browser back/forward navigation.
const VIEW_ROUTES = {
  monitoring: '/drought', drought: '/drought-status', overview: '/meteorological',
  hydrology: '/hydrological-drought', satellite: '/satellite-drought',
  climate: '/climate', 'climate-temperature': '/climate/temperature',
  'climate-spells': '/climate/spells', 'climate-rainfall': '/climate/rainfall',
  'climate-evaporation': '/climate/evaporation', 'climate-irrigation': '/climate/irrigation',
  'climate-streamflow': '/climate/streamflow', vegetation: '/vegetation', rainfall: '/rainfall',
  runoff: '/runoff', surface: '/surface-water', groundwater: '/groundwater',
  'groundwater-reserve': '/groundwater-reserve', 'water-quality': '/water-quality', wastewater: '/wastewater-compliance',
  'drinking-water': '/drinking-water-compliance', dams: '/reservoirs', alerts: '/alerts',
  rwqo: '/resource-water-quality-objectives',
  wrm: '/water-resource-management',
  'water-quantity': '/water-quantity-assessment',
  pipeline: '/pipeline', roadmap: '/roadmap', admin: '/admin',
}

const ROUTE_VIEWS = {
  '/': 'monitoring', '/drought': 'monitoring', '/drought-monitoring': 'monitoring',
  '/drought-status': 'drought', '/meteorological': 'overview', '/hydrological-drought': 'hydrology',
  '/satellite-drought': 'satellite', '/climate': 'climate', '/climate/temperature': 'climate-temperature',
  '/climate/spells': 'climate-spells', '/climate/rainfall': 'climate-rainfall',
  '/climate/evaporation': 'climate-evaporation', '/climate/irrigation': 'climate-irrigation',
  '/climate/streamflow': 'climate-streamflow', '/vegetation': 'vegetation', '/rainfall': 'rainfall',
  '/runoff': 'runoff', '/surface-water': 'surface', '/groundwater': 'groundwater',
  '/groundwater-reserve': 'groundwater-reserve', '/water-quality': 'water-quality', '/wastewater-compliance': 'wastewater',
  '/drinking-water-compliance': 'drinking-water', '/reservoirs': 'dams', '/alerts': 'alerts',
  '/resource-water-quality-objectives': 'rwqo', '/rwqo': 'rwqo',
  '/water-resource-management': 'wrm', '/wrm': 'wrm',
  '/water-quantity-assessment': 'water-quantity', '/water-quantity': 'water-quantity',
  '/pipeline': 'pipeline', '/roadmap': 'roadmap', '/admin': 'admin',
}

function viewFromLocation() {
  if (typeof window === 'undefined') return 'monitoring'
  const path = window.location.pathname.replace(/\/+$/, '') || '/'
  return ROUTE_VIEWS[path] || 'monitoring'
}


function columnNames(dataset) {
  return (dataset?.columns || []).map((column) => (typeof column === 'string' ? column : column.name)).filter(Boolean)
}

function numericColumnNames(dataset) {
  const typed = (dataset?.columns || []).filter((column) => column?.type === 'numeric').map((column) => column.name)
  return typed.length ? typed : (dataset?.dataset_summary?.numeric_columns || columnNames(dataset))
}

function spiClass(spi) {
  if (spi > -0.5) return '-'
  if (spi > -0.8) return 'D0'
  if (spi > -1.3) return 'D1'
  if (spi > -1.6) return 'D2'
  if (spi > -2) return 'D3'
  return 'D4'
}

function monthPoint(dates = [], values = [], monthsAhead) {
  if (!dates.length || !values.length) return { value: null, label: `+${monthsAhead}m` }
  const start = new Date(dates[0])
  const target = new Date(start)
  target.setDate(1)
  target.setMonth(target.getMonth() + monthsAhead)
  target.setDate(0)
  let nearest = 0
  let best = Infinity
  dates.forEach((date, index) => {
    const delta = Math.abs(new Date(date) - target)
    if (delta < best) {
      best = delta
      nearest = index
    }
  })
  const value = Number(values[nearest])
  const stamp = String(dates[nearest] || '')
  const label = stamp ? new Date(stamp).toLocaleString('en-GB', { month: 'short', year: 'numeric' }) : `+${monthsAhead}m`
  return { value: Number.isFinite(value) ? value : null, label }
}

const regionalForecastFeatures = ['monthly_rainfall_mm_month', 'tavg_c', 'pet_mm_day', 'relative_humidity_pct', 'solar_radiation_wm2', 'wind_speed_2m_ms']

function OverviewForecastStudio({ region }) {
  const [dataset, setDataset] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [model, setModel] = useState('LSTM')
  const [target, setTarget] = useState('spi_3')
  const [features, setFeatures] = useState(regionalForecastFeatures)
  const [forecastDays, setForecastDays] = useState(365)
  const [showFeatures, setShowFeatures] = useState(false)
  const [history, setHistory] = useState([])
  const [job, setJob] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const autoStarted = useRef(null)

  const numericColumns = numericColumnNames(dataset)
  const dateColumn = dataset?.index_column || dataset?.inferred_time_columns?.[0] || 'date'
  const multiFeatureModel = requiresFeatureSelection(model)
  const training = submitting || (job && !['completed', 'failed'].includes(job.status))
  const result = job?.result

  useEffect(() => {
    let cancelled = false
    if (!region) return undefined
    setLoading(true)
    setError('')
    setDataset(null)
    setHistory([])
    setJob(null)
    const datasetRequest = loadMeteorologicalRegion(region)
    datasetRequest.then(async (loaded) => {
        if (cancelled) return
        setDataset(loaded)
        const numeric = numericColumnNames(loaded)
        const resolvedTarget = preferredForecastTarget(numeric)
        setTarget(resolvedTarget)
        setFeatures(regionalForecastFeatures.filter((feature) => numeric.includes(feature) && feature !== resolvedTarget))

      })
      .catch((requestError) => {
        if (!cancelled) setError(requestError.response?.data?.detail || 'Unable to load the selected area data.')
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [region])

  useEffect(() => {
    if (!dataset?.dataset_id || !target) return
    let cancelled = false
    setHistory([])
    getProvinceSeries(dataset.dataset_id, target, 'monthly')
      .then((series) => { if (!cancelled) setHistory((series.points || []).slice(-24)) })
      .catch((err) => { if (!cancelled) setError(err.response?.data?.detail || 'Unable to load target history.') })
    return () => { cancelled = true }
  }, [dataset?.dataset_id, target])

  useEffect(() => {
    if (!job?.job_id || ['completed', 'failed'].includes(job.status)) return undefined
    let cancelled = false
    let timer
    const poll = async () => {
      try {
        const next = await getTrainingJob(job.job_id)
        if (cancelled) return
        setJob(next)
        if (next.status === 'failed') setError(next.message || 'Forecast training failed.')
        else timer = setTimeout(poll, 1500)
      } catch (err) {
        if (cancelled) return
        setError(err.response?.data?.detail || 'Unable to read the training result. Please run the forecast again.')
        setJob((current) => ({ ...current, status: 'failed' }))
      }
    }
    timer = setTimeout(poll, 1500)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [job?.job_id])

  useEffect(() => {
    if (!dataset?.dataset_id || autoStarted.current === dataset.dataset_id || !target) return
    autoStarted.current = dataset.dataset_id
    train()
  }, [dataset?.dataset_id, target])

  const train = async () => {
    if (!dataset?.dataset_id || !target || training) return
    const selectedFeatures = multiFeatureModel ? features.filter((feature) => feature !== target) : []
    if (['LSTM', 'VAR', 'VARMAX'].includes(model) && !selectedFeatures.length) {
      setError(`${model} needs at least one input feature. Open the inputs below and select one.`)
      return
    }
    setSubmitting(true)
    setError('')
    setJob(null)
        try {
      setJob(await startTraining({
        dataset_id: dataset.dataset_id,
        model_type: modelKey(model),
        date_column: dateColumn,
        target,
        group_column: null,
        features: selectedFeatures,
        forecast_steps: forecastDays,
      }))
    } catch (err) {
      setError(err.response?.data?.detail || 'Training could not be started.')
    } finally {
      setSubmitting(false)
    }
  }

  const toggleFeature = (name) => setFeatures((values) => values.includes(name) ? values.filter((item) => item !== name) : [...values, name])

  const observedDates = result?.history_dates?.length ? result.history_dates.slice(-18) : history.map((point) => point.date)
  const observedValues = result?.history_values?.length ? result.history_values.slice(-18) : history.map((point) => point.value)
  const forecastDates = result?.forecast_dates || []
  const forecastValues = result?.forecast_values || []
  const lowerBound = result?.lower_bound || []
  const upperBound = result?.upper_bound || []
  const threeMonth = [1, 2, 3].map((month) => monthPoint(forecastDates, forecastValues, month))
  const isDroughtIndex = /^(spi|spei)_/i.test(target)
  const droughtOdds = forecastValues.length ? Math.round((forecastValues.filter((value) => Number(value) <= -1.3).length / forecastValues.length) * 100) : null
  const chartData = [
    { x: observedDates, y: observedValues, type: 'scatter', mode: 'lines', name: 'Historical', line: { color: '#7aa0b0', width: 2 } },
    ...(lowerBound.length && upperBound.length ? [
      { x: forecastDates, y: lowerBound, type: 'scatter', mode: 'lines', name: 'Lower bound', line: { color: 'rgba(47,168,201,0)', width: 0 }, hoverinfo: 'skip', showlegend: false },
      { x: forecastDates, y: upperBound, type: 'scatter', mode: 'lines', name: 'Confidence range', fill: 'tonexty', fillcolor: 'rgba(47,168,201,.22)', line: { color: 'rgba(90,198,227,.45)', width: 1 } },
    ] : []),
    { x: forecastDates, y: forecastValues, type: 'scatter', mode: 'lines', name: `Forecast - ${String(result?.selected_model || model).toUpperCase()}`, line: { color: '#5ac6e3', width: 2.6 } },
  ]

  if (loading) return <div className="nw-forecast-loading">Loading {region} SPI-3 series for the LSTM forecast...</div>
  if (error && !dataset) return <div className="nw-error">{error}</div>

  return (
    <div className="nw-dash-forecast">
      <div className="nw-dash-forecast-controls">
        <label><span>Model</span>
          <select aria-label="Model" value={model} onChange={(e) => { setModel(e.target.value); setJob(null) }} disabled={training}>
            {modelGroups.map((group) => (
              <optgroup key={group.label} label={group.label}>
                {group.items.map((item) => <option key={item}>{item}</option>)}
              </optgroup>
            ))}
          </select>
        </label>
        <label><span>Target</span>
          <select aria-label="Target" value={target} onChange={(e) => { setTarget(e.target.value); setJob(null) }} disabled={training}>
            {numericColumns.map((column) => <option key={column}>{column}</option>)}
          </select>
        </label>
        <label><span>Horizon</span>
          <select aria-label="Horizon" value={forecastDays} onChange={(e) => { setForecastDays(Number(e.target.value)); setJob(null) }} disabled={training}>
            <option value={180}>6 months</option>
            <option value={365}>1 year</option>
            <option value={730}>2 years</option>
          </select>
        </label>
        <button className="nw-btn pri" type="button" disabled={training || !target} onClick={train}>{training ? 'Training...' : `Run ${model}`}</button>
      </div>
      {multiFeatureModel && (
        <div className="nw-dash-features">
          <button type="button" className="nw-panel-link" onClick={() => setShowFeatures((open) => !open)}>{showFeatures ? 'Hide' : 'Show'} {model} inputs</button>
          {showFeatures && (
            <div className="nw-dash-feature-grid">
              {numericColumns.filter((column) => column !== target).map((column) => (
                <label key={column}><input type="checkbox" checked={features.includes(column)} disabled={training} onChange={() => toggleFeature(column)} />{column}</label>
              ))}
            </div>
          )}
        </div>
      )}
      {error && <div className="nw-error" role="alert">{error}</div>}
      {job?.status === 'completed' && <p className="nw-note">Forecast complete - {forecastValues.length} future observations</p>}
      {result?.warnings?.map((warning) => <p className="nw-note" key={warning}>{warning}</p>)}
      {training && <p className="nw-note">{job?.message || `Fitting ${model} to ${target}...`}</p>}
      <div className="nw-dash-forecast-chart">
        {observedValues.length || forecastValues.length ? (
          <Plot
            data={chartData}
            layout={{
              paper_bgcolor: 'transparent', plot_bgcolor: '#0d2029', font: { color: '#93AEBB', family: 'IBM Plex Sans', size: 11 },
              margin: { l: 42, r: 12, t: 28, b: 36 }, height: 250, hovermode: 'x unified',
              legend: { orientation: 'h', y: 1.18, font: { size: 10 } },
              xaxis: { gridcolor: '#1B3A49', tickfont: { size: 10 } },
              yaxis: { gridcolor: '#1B3A49', title: target || 'SPI-3', zeroline: true, zerolinecolor: '#2A4E5E' },
              shapes: forecastDates[0] ? [{ type: 'line', x0: forecastDates[0], x1: forecastDates[0], y0: 0, y1: 1, yref: 'paper', line: { color: '#8C7BE0', width: 1, dash: 'dot' } }] : [],
              annotations: forecastDates[0] ? [{ x: forecastDates[0], y: 1, yref: 'paper', text: 'Forecast start', showarrow: false, font: { size: 10, color: '#8C7BE0' }, xanchor: 'left' }] : [],
            }}
            config={{ displayModeBar: false, responsive: true }}
            useResizeHandler
            style={{ width: '100%' }}
          />
        ) : <div className="nw-forecast-empty">SPI-3 history will appear here once the selected area series is loaded.</div>}
      </div>
      <div className="nw-forecast-meta">
        {threeMonth.map((point) => (
          <div key={point.label}><span>{point.label}</span><strong>{point.value != null ? point.value.toFixed(2) : '-'}</strong><em>{isDroughtIndex && point.value != null ? spiClass(point.value) : ''}</em></div>
        ))}
      </div>
      {isDroughtIndex && <div className="nw-dash-odds">
        <span>Forecast points at or below -1.3</span>
        <strong>{droughtOdds != null ? `${droughtOdds}%` : '-'}</strong>
        <em>{droughtOdds == null ? 'Available after the forecast completes' : 'Share of projected values, not a probability estimate'}</em>
      </div>}
    </div>
  )
}

// Attempt to provide region-level meteorological data to portal modules
function Drought({ provinces, selected, selectProvince }) { const p = provinces.find((x) => x.id === selected) || provinces[0]; return <><Heading view="drought" /><div className="nw-grid nw-gmap"><Panel title="Classification by province"><MapSVG provinces={provinces} selected={p.id} onSelect={selectProvince} colorFn={(x) => (DCLASS[x.d] || DCLASS['-']).c} /></Panel><Panel title={p.name} source={p.live ? 'Connected prediction' : 'Sample baseline'}><DTag d={p.d} /><div className="nw-grid nw-g2" style={{ marginTop: 14 }}><Kpi label="Consensus SPI" value={p.spi.toFixed(2)} /><Kpi label="Rainfall" value={p.rain.toFixed(1)} unit="mm" /></div><p className="nw-psub" style={{ marginTop: 14 }}>Catchment authority: {p.cma}. Select another province on the map to inspect its current classification.</p></Panel></div><div style={{ marginTop: 14 }}><Panel title="Provincial drought table"><table><thead><tr><th>Province</th><th>Classification</th><th className="nw-num">SPI</th><th className="nw-num">6-month rainfall</th></tr></thead><tbody>{provinces.map((x) => <tr key={x.id}><td>{x.name}</td><td><DTag d={x.d} /></td><td className="nw-num">{x.spi.toFixed(2)}</td><td className="nw-num">{x.rain6.toFixed(0)} mm</td></tr>)}</tbody></table></Panel></div></> }

function Alerts() { return <><Heading view="alerts" /><Panel title="Open alerts" source="Operations"><div>{[['Critical', 'Nqweba Dam has fallen below 8% full supply capacity.', 'Eastern Cape', 'var(--d4)'], ['Severe', 'Persistent rainfall deficit across the lower Orange catchment.', 'Northern Cape', 'var(--d2)'], ['Watch', 'Model confidence indicates worsening conditions within the next 30 days.', 'Western Cape', 'var(--d1)'], ['Information', 'Climate warehouse prediction refresh completed successfully.', 'National', 'var(--river)']].map(([level, text, area, color]) => <div className="nw-alertrow" key={text}><i className="sev" style={{ background: color }} /><div><b>{level} Ãƒâ€šÃ‚Â· {area}</b><p>{text}</p></div><time>Today</time></div>)}</div></Panel></> }
function Pipeline() { return <><Heading view="pipeline" /><div className="nw-grid nw-g4"><Kpi label="Sources registered" value={SOURCES.length} /><Kpi label="Connected now" value={SOURCES.filter((s) => s.live).length} /><Kpi label="Ingestion health" value="99.1" unit="%" /><Kpi label="Model outputs" value="9" unit="provinces" /></div><div style={{ marginTop: 14 }}><Panel title="Source registry"><table><thead><tr><th>Source</th><th>Protocol</th><th>Frequency</th><th>Status</th></tr></thead><tbody>{SOURCES.map((s) => <tr key={s.n}><td>{s.n}</td><td>{s.proto}</td><td>{s.freq}</td><td><span className={`nw-tag ${s.live ? 't-ok' : 't-mute'}`}>{s.live ? 'Connected' : 'Pending connection'}</span></td></tr>)}</tbody></table></Panel></div></> }

function RoadmapView() { return <><Heading view="roadmap" /><div className="nw-grid nw-g3">{ROADMAP.map((p) => <Panel key={p.ph} title={p.ph} source={p.mo}><ul className="nw-tl">{p.items.map(([x, st]) => <li key={x} className={st === 'done' ? 'done' : st === 'now' ? 'now' : ''}>{x}<br /><span className="nw-note">{st === 'done' ? 'Complete' : st === 'now' ? 'In progress' : 'Planned'}</span></li>)}</ul></Panel>)}</div></> }

const catalogue = {
  rainfall: { title: 'Rainfall monitoring', intro: 'Latest provincial climate inputs used by the connected NIWIS prediction service.', cols: ['Province', 'Daily rainfall', '3-month accumulation', 'Data state'], rows: [['Eastern Cape', '42.5 mm', '130 mm', 'Connected model input'], ['Free State', '31.8 mm', '116 mm', 'Connected model input'], ['Gauteng', '28.6 mm', '124 mm', 'Connected model input'], ['KwaZulu-Natal', '51.3 mm', '182 mm', 'Connected model input']] },
  vegetation: { title: 'Vegetation condition', intro: 'Vegetation-condition products become available when the SANSA earth-observation feed is connected.', cols: ['Product', 'Resolution', 'Update cycle', 'State'], rows: [['Vegetation Condition Index', '10ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Å“30 m', 'Dekadal', 'Awaiting SANSA feed'], ['Vegetation Health Index', '1 km', 'Weekly', 'Awaiting SANSA feed'], ['Soil-moisture anomaly', '1 km', 'Daily', 'Awaiting SANSA feed']] },
  runoff: { title: 'Runoff monitoring', intro: 'Indicative river-flow conditions from the national gauging network.', cols: ['Station', 'Flow', 'Percentile', 'State'], rows: STATIONS.map((s) => [s.n, `${s.q} mÃƒâ€šÃ‚Â³/s`, `${s.pct}%`, s.state]) },
  surface: { title: 'Surface water network', intro: 'Priority streamflow stations currently represented in the NIWIS catalogue.', cols: ['ID', 'Station', 'Discharge', 'State'], rows: STATIONS.map((s) => [s.id, s.n, `${s.q} mÃƒâ€šÃ‚Â³/s`, s.state]) },
  groundwater: { title: 'Groundwater status', intro: 'Strategic boreholes and their current groundwater stress indicator.', cols: ['Borehole', 'Depth', 'SGI', 'Telemetry'], rows: BOREHOLES.map((s) => [s.n, `${s.depth} m bgl`, s.sgi.toFixed(2), s.tele ? 'Reporting' : 'Manual']) },
  climate: { title: 'Climate change', intro: 'Climate indicators and scenario products for long-range water-resource planning.', cols: ['Indicator', 'Baseline', 'Planning use', 'State'], rows: [['Temperature anomaly', '1981ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Å“2010', 'Heat and evaporation stress', 'Model input connected'], ['Rainfall anomaly', '1981ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Å“2010', 'Drought monitoring', 'Model input connected'], ['CMIP6 scenarios', 'SSP pathways', 'Long-term planning', 'Catalogue ready']] },
  quality: { title: 'Water quality', intro: 'National water-quality monitoring sites in the prototype catalogue.', cols: ['Site', 'Province', 'pH', 'Status'], rows: WQSITES.map((s) => [s.n, s.prov, s.ph.toFixed(1), s.st]) },
  bluedrop: { title: 'Drinking water ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â Blue Drop', intro: 'Drinking-water compliance overview for representative systems.', cols: ['Water services authority', 'Province', 'Compliance', 'Status'], rows: BLUEDROP.map((s) => [s.n, s.prov, `${s.comp}%`, s.st]) },
  greendrop: { title: 'Wastewater ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â Green Drop', intro: 'Wastewater works risk and load assessment.', cols: ['Works', 'Province', 'Load', 'Status'], rows: GREENDROP.map((s) => [s.n, s.prov, `${s.load}%`, s.st]) },
  balance: { title: 'Water balance and transfers', intro: 'National water balance inputs from the NIWIS prototype catalogue.', cols: ['Component', 'Code', 'Volume', 'Source'], rows: BALANCE.map((s) => [s[0], s[1], `${s[2].toLocaleString()} MmÃƒâ€šÃ‚Â³`, s[3]]) },
  tariffs: { title: 'Raw water tariffs', intro: 'Indicative charges by national water-resource scheme.', cols: ['Scheme', 'Raw water', 'Annual change', 'Users'], rows: TARIFFS.map((s) => [s.sch, `R ${s.raw.toFixed(2)}/mÃƒâ€šÃ‚Â³`, `${s.d}%`, s.users]) },
  settlements: { title: 'Affected settlements', intro: 'Settlements requiring focused water-security monitoring.', cols: ['Settlement', 'Province', 'Days remaining', 'Risk'], rows: SETTLEMENTS.map((s) => [s.n, s.prov, s.days ? `${s.days} days` : 'Emergency', `${s.risk}%`]) },
  services: { title: 'Water services', intro: 'Water-services security signals linked to municipal and settlement reporting.', cols: ['Area', 'Supply source', 'Risk', 'Response'], rows: SETTLEMENTS.slice(0, 4).map((s) => [s.n, s.src, `${s.risk}%`, s.tank ? 'Tankering active' : 'Monitor']) },
  indices: { title: 'Index workbench', intro: 'The drought and water-resource indicators available in the NIWIS framework.', cols: ['Index', 'Name', 'Input', 'Use'], rows: INDICES },
  governance: { title: 'Data governance', intro: 'Quality, ownership, standards and access controls for operational NIWIS data.', cols: ['Control', 'Standard', 'Application', 'State'], rows: [['Metadata', 'ISO 19115', 'Published layers', 'Applied'], ['Geospatial services', 'OGC WMS/WFS', 'Data distribution', 'Applied'], ['Personal information', 'POPIA', 'Service data', 'Controlled'], ['Audit trail', '7-year retention', 'Platform actions', 'Applied']] },
  api: { title: 'Open data API', intro: 'Programmatic access to the NIWIS catalogue; endpoints are enabled as source systems connect.', cols: ['Endpoint', 'Output', 'Access', 'State'], rows: [['GET /api/predictions/latest', 'Provincial drought prediction', 'Portal proxy', 'Connected'], ['GET /v1/dams/{id}/storage', 'Storage series', 'Open', 'Catalogue ready'], ['GET /v1/indices/{index}', 'Drought indices', 'Open', 'Catalogue ready'], ['GET /wms', 'Map layers', 'Open', 'Catalogue ready']] },
  admin: { title: 'Administration', intro: 'Operational controls for source connections, roles and platform readiness.', cols: ['Area', 'Current state', 'Owner', 'Action'], rows: [['Prediction service', 'Connected', 'NIWIS model team', 'Monitor'], ['Climate warehouse', 'Connected', 'Data engineering', 'Monitor'], ['Hydrology feeds', 'Onboarding', 'DWS', 'Complete integration'], ['User roles', 'Prototype gate', 'Platform admin', 'Configure identity provider']] },
}

function CatalogueView({ view }) {
  const item = catalogue[view]
  const title = item?.title || view.replace(/\b\w/g, (letter) => letter.toUpperCase())
  const rows = item?.rows || [['Operational data connection', 'Pending', 'ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â', 'Available in future feed']]
  const cols = item?.cols || ['Module', 'State', 'Last update', 'Next action']
  return <><Heading view={view} /><Panel title={title} source="NIWIS catalogue"><p className="nw-psub">{item?.intro || 'This operational module is represented in the NIWIS prototype catalogue.'}</p><div className="nw-tscroll"><table><thead><tr>{cols.map((col) => <th key={col}>{col}</th>)}</tr></thead><tbody>{rows.map((row, i) => <tr key={`${row[0]}-${i}`}>{row.map((cell, j) => <td key={j}>{cell}</td>)}</tr>)}</tbody></table></div></Panel></>
}

export default function NIWISPortal() {
  const [entered, setEntered] = useState(true), [view, setViewState] = useState(viewFromLocation), [navOpen, setNavOpen] = useState(false), [selected, setSelected] = useState('GP'), [predictions, setPredictions] = useState([])
  const [expandedGroups, setExpandedGroups] = useState({})
  const setView = (nextView) => {
    setViewState(nextView)
    if (typeof window !== 'undefined') {
      const nextPath = VIEW_ROUTES[nextView] || '/drought'
      if (window.location.pathname !== nextPath) window.history.pushState({ view: nextView }, '', nextPath)
    }
  }
  useEffect(() => {
    const onPopState = () => setViewState(viewFromLocation())
    window.addEventListener('popstate', onPopState)
    // Unknown and retired bookmarks open the normal monitoring dashboard.
    const path = window.location.pathname.replace(/\/+$/, '') || '/'
    if (path === '/' || !ROUTE_VIEWS[path]) window.history.replaceState({ view: 'monitoring' }, '', '/drought')
    return () => window.removeEventListener('popstate', onPopState)
  }, [])
  useEffect(() => { document.body.classList.add('nw-body'); return () => document.body.classList.remove('nw-body') }, [])
  useEffect(() => {
    // Every module is a new dashboard context. Do not leave the user halfway
    // down the previous module when a navigation item is selected.
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' })
  }, [view])
  useEffect(() => { fetch('/niwis-api/api/predictions/latest').then((r) => r.ok ? r.json() : Promise.reject()).then((r) => setPredictions(r.predictions || [])).catch(() => {}) }, [])
  const provinces = useMemo(() => liveProvinces(predictions), [predictions])
  const selectProvince = (id) => { setSelected(id); setView('drought') }
  const selectSatelliteProvince = (id) => setSelected(id)
  const content = view === 'water-quantity' ? <WaterQuantityAssessment /> : view === 'wrm' ? <WaterResourceManagement /> : view === 'rwqo' ? <ResourceWaterQualityObjectives /> : view === 'groundwater' ? <GroundwaterLevelMonitoring /> : view === 'groundwater-reserve' ? <GroundwaterReserveAssessment /> : view === 'water-quality' ? <WaterQualityMonitoring /> : view === 'wastewater' ? <WastewaterCompliance /> : view === 'drinking-water' ? <DrinkingWaterCompliance /> : view === 'surface' ? <SurfaceWaterNetwork /> : view === 'runoff' ? <RunoffStatus /> : view === 'rainfall' ? <RainfallStatus /> : view === 'vegetation' ? <VegetationCondition /> : (view === 'climate' || view.startsWith('climate-')) ? <ClimateDashboard key={`climate-dashboard-${view}`} section={view.startsWith('climate-') ? view.slice(8) : null} /> : view === 'monitoring' ? <DroughtMonitoring renderForecast={(region) => <DeferredPanel key={region}><OverviewForecastStudio region={region} /></DeferredPanel>} /> : view === 'overview' ? <MeteorologicalDrought renderForecast={(region) => <DeferredPanel key={region}><OverviewForecastStudio region={region} /></DeferredPanel>} /> : view === 'drought' ? <Drought provinces={provinces} selected={selected} selectProvince={selectProvince} /> : view === 'alerts' ? <Alerts /> : view === 'dams' ? <ReservoirStatus /> : view === 'pipeline' ? <Pipeline /> : view === 'roadmap' ? <RoadmapView /> : view === 'satellite' ? <Satellite provinces={provinces} selected={selected} selectProvince={selectSatelliteProvince} /> : view === 'hydrology' ? <HydrologyDrought /> : <CatalogueView view={view} />
  // Water quality remains scoped to its monitoring page. Vegetation also
  // exposes the shared forecasting studio with its compact source endpoint.
  const forecastDashboard = view.startsWith('climate') ? 'climate' : ({ 'water-quantity': 'water-quantity', wrm: 'wrm', rwqo: 'rwqo', vegetation: 'vegetation', rainfall: 'rainfall', runoff: 'runoff', surface: 'surface', groundwater: 'groundwater', 'groundwater-reserve': 'groundwater-reserve', wastewater: 'wastewater', 'drinking-water': 'drinking-water', satellite: 'satellite', hydrology: 'hydrology' }[view] || null)
  const forecastSection = view.startsWith('climate-') ? view.slice(8) : null
  if (!entered) return <div className="nw nw-unified-theme"><div className="nw-gate"><div className="nw-gate-card"><div className="nw-gate-left"><div className="nw-crest"><img className="nw-logo" src="/Water-and-Sanitation.png" alt="Department of Water and Sanitation logo" /><div><b>NIWIS</b><div className="nw-note">Department of Water and Sanitation</div></div></div><h1 className="nw-gate-title">National Integrated Water Information System</h1><p className="nw-gate-sub">One view of South AfricaÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢s water: rainfall, dams, rivers, groundwater, quality and services ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â updated continuously and forecast ahead.</p><div className="nw-role-list">{ROLES.map((r) => <button className="nw-role" key={r.id} onClick={() => setEntered(true)}><i className="nw-role-key">{r.k}</i><div><b>{r.n}</b><span>{r.d}</span></div></button>)}</div><p className="nw-gate-note">Prototype portal. Live climate and prediction data are shown where the connected NIWIS service is available.</p></div><div className="nw-gate-right"><div className="nw-note">Platform status ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â 15 Sep 2026, 06:00 SAST</div>{[['Data sources registered', `${SOURCES.length}`], ['Telemetry stations reporting', '4 118'], ['Records ingested, last 24 h', '12.4 M'], ['Forecast models in production', '1'], ['Open alerts', '17']].map(([l, v]) => <div className="nw-gate-stat" key={l}><span>{l}</span><b className="mono">{v}</b></div>)}</div></div></div></div>
    return <div className="nw nw-unified-theme"><div className={`nw-app ${view === 'monitoring' ? 'dm-shell' : (view === 'climate' || view.startsWith('climate-')) ? 'climate-shell' : view === 'vegetation' ? 'climate-shell vegetation-shell' : view === 'rainfall' ? 'climate-shell rainfall-shell' : view === 'runoff' ? 'climate-shell runoff-shell' : view === 'surface' ? 'climate-shell surface-water-shell' : view === 'groundwater' ? 'climate-shell groundwater-shell' : view === 'groundwater-reserve' ? 'climate-shell groundwater-reserve-shell' : view === 'water-quality' ? 'climate-shell water-quality-shell' : view === 'wastewater' ? 'climate-shell wastewater-shell' : view === 'drinking-water' ? 'climate-shell drinking-water-shell' : view === 'rwqo' ? 'climate-shell rwqo-shell' : view === 'wrm' ? 'climate-shell wrm-shell' : view === 'water-quantity' ? 'climate-shell water-quantity-shell' : view === 'dams' ? 'climate-shell reservoir-shell' : ''}`}><header className="nw-topbar"><button className="nw-iconbtn" onClick={() => setNavOpen(!navOpen)} aria-label="Toggle menu"><Menu size={16} /></button><div className="nw-brand"><img className="nw-logo nw-logo-topbar" src="/Water-and-Sanitation.png" alt="Department of Water and Sanitation logo" /> NIWIS</div>{view === 'groundwater' ? <div className="nw-statusstrip"><div className="nw-sstat"><em>GROUNDWATER LEVEL NETWORK</em><b>Levels / Recharge / Aquifers</b></div><div className="nw-sstat"><em>COVERAGE</em><b>52 districts</b></div></div> : view === 'groundwater-reserve' ? <div className="nw-statusstrip"><div className="nw-sstat"><em>GROUNDWATER RESERVE ASSESSMENT</em><b>Recharge / Abstraction / Storage</b></div><div className="nw-sstat"><em>COVERAGE</em><b>52 districts</b></div></div> : view === 'water-quality' ? <div className="nw-statusstrip"><div className="nw-sstat"><em>WATER QUALITY MONITORING</em><b>Physical / Chemical / Biological / SANSA</b></div><div className="nw-sstat"><em>COVERAGE</em><b>52 districts</b></div></div> : view === 'wastewater' ? <div className="nw-statusstrip"><div className="nw-sstat"><em>WASTEWATER QUALITY COMPLIANCE</em><b>Effluent / Operations / SAWS</b></div><div className="nw-sstat"><em>SOURCE</em><b>Three Supabase relations</b></div></div> : view === 'drinking-water' ? <div className="nw-statusstrip"><div className="nw-sstat"><em>DRINKING WATER QUALITY COMPLIANCE</em><b>Parameters / Reported flags / Trends</b></div><div className="nw-sstat"><em>SOURCE</em><b>Supabase district observations</b></div></div> : view === 'water-quantity' ? <div className="nw-statusstrip"><div className="nw-sstat"><em>WATER QUANTITY ASSESSMENT</em><b>Transfer rates / National balance</b></div><div className="nw-sstat"><em>CADENCE</em><b>Monthly source records</b></div></div> : view === 'wrm' ? <div className="nw-statusstrip"><div className="nw-sstat"><em>WATER RESOURCE MANAGEMENT</em><b>Annual matrix / Strategic source areas</b></div><div className="nw-sstat"><em>SOURCE</em><b>Two Supabase relations</b></div></div> : view === 'rwqo' ? <div className="nw-statusstrip"><div className="nw-sstat"><em>RESOURCE WATER QUALITY OBJECTIVES</em><b>Ecological / Chemical / Hydrological</b></div><div className="nw-sstat"><em>SOURCE</em><b>Three Supabase relations</b></div></div> : view === 'dams' ? <div className="nw-statusstrip"><div className="nw-sstat"><em>DAM AND RESERVOIR STATUS</em><b>Storage / Releases / Catchment conditions</b></div><div className="nw-sstat"><em>SOURCE</em><b>Supabase table: 8_1_reservoir_operational_master</b></div></div> : view === 'surface' ? <div className="nw-statusstrip"><div className="nw-sstat"><em>SURFACE WATER NETWORK</em><b>Hydrology / Catchments / Earth observation</b></div><div className="nw-sstat"><em>COVERAGE</em><b>52 districts</b></div></div> : view === 'runoff' ? <div className="nw-statusstrip"><div className="nw-sstat"><em>RUNOFF STATUS</em><b>Catchment response / Flows / Water balance</b></div><div className="nw-sstat"><em>COVERAGE</em><b>52 districts</b></div></div> : view === 'rainfall' ? <div className="nw-statusstrip"><div className="nw-sstat"><em>RAINFALL STATUS</em><b>Observations / Satellite estimates / Indices</b></div><div className="nw-sstat"><em>COVERAGE</em><b>52 districts</b></div></div> : view === 'vegetation' ? <div className="nw-statusstrip"><div className="nw-sstat"><em>VEGETATION CONDITION</em><b>Satellite indices / Climate drivers</b></div><div className="nw-sstat"><em>COVERAGE</em><b>52 districts</b></div></div> : (view === 'climate' || view.startsWith('climate-')) ? <div className="nw-statusstrip"><div className="nw-sstat"><em>CLIMATE DASHBOARD</em><b>Six connected climate datasets</b></div><div className="nw-sstat"><em>COVERAGE</em><b>52 districts</b></div></div> : view === 'monitoring' ? <div className="nw-statusstrip"><div className="nw-sstat"><em>DROUGHT MONITORING</em><b>Climate / Water / Vegetation</b></div><div className="nw-sstat"><em>DATA SOURCE</em><b>Supabase observations</b></div></div> : view === 'overview' ? <div className="nw-statusstrip"><div className="nw-sstat"><em>METEOROLOGICAL DROUGHT</em><b>Rainfall / SPI / SPEI</b></div><div className="nw-sstat"><em>DATA SOURCE</em><b>Supabase observations</b></div></div> : view === 'hydrology' ? <div className="nw-statusstrip"><div className="nw-sstat"><em>HYDROLOGICAL DROUGHT</em><b>Streamflow / SSI / Groundwater</b></div><div className="nw-sstat"><em>DATA SOURCE</em><b>Supabase observations</b></div></div> : view === 'satellite' ? <div className="nw-statusstrip"><div className="nw-sstat"><em>SATELLITE &amp; REMOTE SENSING</em><b>Vegetation / Soil moisture / Water storage</b></div><div className="nw-sstat"><em>DATA SOURCE</em><b>Supabase observations</b></div></div> : (<div className="nw-statusstrip"><div className="nw-sstat"><em>NIWIS WATER INTELLIGENCE</em><b>Dashboard overview</b></div><div className="nw-sstat"><em>PLATFORM</em><b>Water information system</b></div></div>)}<div className="nw-topactions"><span className="nw-pill live"><i className="nw-dot" />{(view === 'climate' || view.startsWith('climate-')) ? 'Supabase observations' : view === 'vegetation' ? 'Supabase observations' : view === 'rainfall' ? 'Supabase observations' : view === 'runoff' ? 'Supabase observations' : view === 'surface' ? 'Supabase observations' : view === 'groundwater' ? 'Supabase observations' : view === 'groundwater-reserve' ? 'Supabase observations' : view === 'water-quality' ? 'Supabase observations' : view === 'wastewater' ? 'Supabase observations' : view === 'drinking-water' ? 'Supabase observations' : view === 'rwqo' ? 'Supabase observations' : view === 'wrm' ? 'Supabase observations' : view === 'water-quantity' ? 'Supabase observations' : view === 'dams' || view === 'overview' || view === 'hydrology' || view === 'satellite' ? 'Supabase observations' : 'Live'}</span><button className="nw-iconbtn" onClick={() => setEntered(false)}><SlidersHorizontal size={15} /></button></div></header><nav className={`nw-nav ${navOpen ? 'open' : ''}`}>{NAV.map(([group, items]) => <div key={group}><div className="nw-navgroup">{group}</div>{items.map(([id, label, num, live, children]) => {
    const groupOpen = !!expandedGroups[id]
    const active = view === id || children?.some(([childId]) => childId === view) || (id === 'monitoring' && view === 'drought')
    return <div key={id}>
      <button className={`nw-navitem ${active ? 'sel' : ''}`} aria-expanded={children ? groupOpen : undefined} aria-controls={children ? `nw-${id}-subgroups` : undefined} onClick={() => {
        if (children) { setExpandedGroups(current => ({ ...current, [id]: !current[id] })); setView(id) }
        else { setView(id); setNavOpen(false) }
      }}>{num && <span className="nw-nid">{num}.</span>}<span className="nw-nav-label">{label}</span>{live && <span className="nw-live">Live</span>}{children && <ChevronDown size={16} className={`nw-nav-chevron ${groupOpen ? 'expanded' : ''}`} />}</button>
      {children && groupOpen && <div id={`nw-${id}-subgroups`} className="nw-nav-subgroups">{children.map(([childId, childLabel]) => <button key={childId} className={`nw-navitem nw-nav-child ${view === childId ? 'sel' : ''}`} onClick={() => { setView(childId); setNavOpen(false) }}>{childLabel}</button>)}</div>}
    </div>
  })}</div>)}<div className="nw-nav-brand-card"><div className="nw-brand-water-icon"><Droplets size={20} aria-hidden="true" /></div><div className="nw-brand-tagline"><strong>Reliable Water Data.</strong><span>Informed Decisions.</span><em>A Resilient South Africa.</em></div></div></nav><main className="nw-main"><DataFreshness view={view} /><Suspense fallback={<LoadingProgress message="Loading dashboard" />}>{content}</Suspense>{forecastDashboard && <DeferredPanel key={`deferred-${forecastDashboard}-${forecastSection || 'all'}`}><DashboardForecastStudio key={`forecast-${forecastDashboard}-${forecastSection || 'all'}`} dashboard={forecastDashboard} section={forecastSection} /></DeferredPanel>}</main></div></div>
}
