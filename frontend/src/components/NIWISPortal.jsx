import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { dashboardFetch as fetch } from '../services/dashboardFetch'
import DeferredPanel from './DeferredPanel'
import DataFreshness from './DataFreshness'
import DashboardReport from './DashboardReport'
import LoadingProgress from './LoadingProgress'
import ThemeSelector from './ThemeSelector'
import { useTheme } from '../contexts/ThemeContext'
import { ChevronDown, Droplets, Home, Menu } from 'lucide-react'
import Plot from './LazyPlot'
import { modelGroups, modelKey, preferredForecastTarget, requiresFeatureSelection } from '../lib/modelOptions'
import { BALANCE, BLUEDROP, BOREHOLES, DCLASS, GREENDROP, INDICES, NAV, ROADMAP, SETTLEMENTS, SOURCES, STATIONS, TARIFFS, WQSITES, liveProvinces } from '../niwis/demoData'
import { getProvinceSeries, getTrainingJob, loadMeteorologicalRegion, startTraining } from '../services/api'
import { DTag, MapSVG } from '../niwis/svgCharts'
import '../niwis/niwis-portal.css'
import '../niwis/dashboard-theme.css'
import '../niwis/light-theme.css'
import '../niwis/map-theme.css'
import '../niwis/chart-theme.css'
import '../niwis/main-dashboard-consistency.css'

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
const WaterServices = lazy(() => import('./WaterServices'))
const MunicipalTariffs = lazy(() => import('./MunicipalTariffs'))
const SpatialDashboard = lazy(() => import('./SpatialDashboard'))
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
  'water-services': ['Water Services, Infrastructure Access and Supply Reliability', 'Household access, infrastructure operations and source reliability coverage.', 'Monitoring'],
  'water-tariffs': ['Water Tariffs & Water Quality Costs', 'Municipality-level source values for raw-water tariffs, municipal water tariffs and water-quality costs.', 'Monitoring'],
  spatial: ['Spatial intelligence', 'South African administrative boundaries, settlement references and spatial data readiness.', 'Monitoring'],
  pipeline: ['Data integration', 'The connected data catalogue and the operational ingestion pipeline.', 'Platform'],
  roadmap: ['Implementation roadmap', 'A phased delivery plan for the National Integrated Water Information System.', 'Platform'],
}

function Panel({ title, source, children }) { return <section className="nw-panel"><div className="nw-phead"><h3>{title}</h3>{source && <span className="src">{source}</span>}</div>{children}</section> }
function Kpi({ label, value, unit, note, tone }) { return <article className={`nw-kpi ${tone || ''}`}><div className="lab">{label}</div><div className="val">{value}<small>{unit}</small></div>{note && <div className="delta">{note}</div>}</article> }
function Heading({ view }) { const [title, lede, crumb] = descriptions[view] || [view.replace(/\b\w/g, (v) => v.toUpperCase()), 'This NIWIS module is ready for its operational data connection.', 'NIWIS']; return <><div className="nw-crumb">{crumb} / {title}</div><h1 className="page">{title}</h1><p className="nw-lede">{lede}</p></> }

// Each monitoring module keeps its existing dashboard component and map. The
// sidebar section entries point back to that module while carrying a section
// label for contextual navigation and deep links.
const MODULE_SECTION_KEY_BY_VIEW = {
  'reserve-hydrogeology': 'hydrogeology',
  'reserve-recharge-discharge': 'recharge-discharge',
  'reserve-sustainability': 'sustainability',
  'reservoir-operational': 'operational',
  'reservoir-derived': 'derived',
  'reservoir-national-dams': 'national-dams',
}

const MODULE_SECTION_ENTRIES = NAV.flatMap(([, items]) => items.flatMap(([parentView, , , , children]) =>
  children && !['monitoring', 'climate'].includes(parentView)
    ? children.filter(([childView]) => childView !== parentView).map(([childView, label]) => [childView, { parentView, label, sectionKey: MODULE_SECTION_KEY_BY_VIEW[childView] || childView.slice(parentView.length + 1) }])
    : []
))
const MODULE_SECTION_META = Object.fromEntries(MODULE_SECTION_ENTRIES)
const MODULE_SECTION_ROUTES = Object.fromEntries(MODULE_SECTION_ENTRIES.map(([view]) => [view, `/sections/${view}`]))
const MODULE_SECTION_VIEWS = Object.fromEntries(MODULE_SECTION_ENTRIES.map(([view]) => [`/sections/${view}`, view]))

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
  'water-services': '/water-services',
  'water-tariffs': '/water-tariffs-and-quality-costs',
  ...MODULE_SECTION_ROUTES,
  spatial: '/spatial',
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
  '/water-services': 'water-services', '/water-services-infrastructure-access-and-supply-reliability': 'water-services',
  '/water-tariffs-and-quality-costs': 'water-tariffs',
  ...MODULE_SECTION_VIEWS,
  '/spatial': 'spatial',
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
  const { theme } = useTheme()
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
  const forecastChartColors = theme === 'light'
    ? { historical: '#587387', forecast: '#0879ae', range: 'rgba(8,108,170,.16)', grid: '#dce6ee', text: '#425e73', plot: '#f5f9fc', zero: '#b6c8d6' }
    : { historical: '#7aa0b0', forecast: '#5ac6e3', range: 'rgba(47,168,201,.22)', grid: '#1B3A49', text: '#93AEBB', plot: '#0d2029', zero: '#2A4E5E' }

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

  const resultHistory = (Array.isArray(result?.history_dates) && Array.isArray(result?.history_values)
    ? result.history_dates.map((date, index) => ({ date, value: result.history_values[index] == null ? NaN : Number(result.history_values[index]) }))
    : []).filter((point) => point.date && Number.isFinite(point.value))
  const observed = (resultHistory.length
    ? resultHistory
    : history.map((point) => ({ date: point.date, value: Number(point.value) })).filter((point) => point.date && Number.isFinite(point.value)))
    .slice(-18)
  const observedDates = observed.map((point) => point.date)
  const observedValues = observed.map((point) => point.value)
  const forecastPoints = (Array.isArray(result?.forecast_dates) && Array.isArray(result?.forecast_values)
    ? result.forecast_dates.map((date, index) => ({ date, value: result.forecast_values[index] == null ? NaN : Number(result.forecast_values[index]), index }))
    : []).filter((point) => point.date && Number.isFinite(point.value))
  const forecastDates = forecastPoints.map((point) => point.date)
  const forecastValues = forecastPoints.map((point) => point.value)
  const lowerBound = forecastPoints.map((point) => { const value = result?.lower_bound?.[point.index]; const number = value == null ? null : Number(value); return Number.isFinite(number) ? number : null })
  const upperBound = forecastPoints.map((point) => { const value = result?.upper_bound?.[point.index]; const number = value == null ? null : Number(value); return Number.isFinite(number) ? number : null })
  const threeMonth = [1, 2, 3].map((month) => monthPoint(forecastDates, forecastValues, month))
  const isDroughtIndex = /^(spi|spei)_/i.test(target)
  const droughtOdds = forecastValues.length ? Math.round((forecastValues.filter((value) => Number(value) <= -1.3).length / forecastValues.length) * 100) : null
  const chartData = [
    { x: observedDates, y: observedValues, type: 'scatter', mode: 'lines', name: 'Historical', line: { color: forecastChartColors.historical, width: 2 } },
    ...(lowerBound.some(Number.isFinite) && upperBound.some(Number.isFinite) ? [
      { x: forecastDates, y: lowerBound, type: 'scatter', mode: 'lines', name: 'Lower bound', line: { color: 'rgba(47,168,201,0)', width: 0 }, hoverinfo: 'skip', showlegend: false },
      { x: forecastDates, y: upperBound, type: 'scatter', mode: 'lines', name: 'Confidence range', fill: 'tonexty', fillcolor: forecastChartColors.range, line: { color: forecastChartColors.forecast, width: 1 } },
    ] : []),
    { x: forecastDates, y: forecastValues, type: 'scatter', mode: 'lines', name: `Forecast - ${String(result?.selected_model || model).toUpperCase()}`, line: { color: forecastChartColors.forecast, width: 2.6 } },
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
      {job?.status === 'completed' && !forecastValues.length && <p className="nw-forecast-unavailable" role="status">The model returned no usable forecast values. The chart still shows the available history.</p>}
      {result?.warnings?.map((warning) => <p className="nw-note" key={warning}>{warning}</p>)}
      {training && <p className="nw-note">{job?.message || `Fitting ${model} to ${target}...`}</p>}
      <div className="nw-dash-forecast-chart">
        {observedValues.length || forecastValues.length ? (
          <Plot
            data={chartData}
            layout={{
              paper_bgcolor: 'transparent', plot_bgcolor: forecastChartColors.plot, autosize: true, font: { color: forecastChartColors.text, family: 'IBM Plex Sans', size: 11 },
              margin: { l: 42, r: 12, t: 28, b: 36 }, height: 250, hovermode: 'x unified',
              legend: { orientation: 'h', y: 1.18, font: { size: 10 } },
              xaxis: { gridcolor: forecastChartColors.grid, tickfont: { size: 10 } },
              yaxis: { gridcolor: forecastChartColors.grid, title: target || 'SPI-3', zeroline: true, zerolinecolor: forecastChartColors.zero },
              shapes: forecastDates[0] ? [{ type: 'line', x0: forecastDates[0], x1: forecastDates[0], y0: 0, y1: 1, yref: 'paper', line: { color: '#8C7BE0', width: 1, dash: 'dot' } }] : [],
              annotations: forecastDates[0] ? [{ x: forecastDates[0], y: 1, yref: 'paper', text: 'Forecast start', showarrow: false, font: { size: 10, color: '#8C7BE0' }, xanchor: 'left' }] : [],
            }}
            config={{ displayModeBar: false, responsive: true }}
            useResizeHandler
            style={{ width: '100%', minHeight: 250 }}
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
function Drought({ provinces, selected, selectProvince }) {
  const p = provinces.find(item => item.id === selected) || provinces[0]
  const observed = (province, key) => {
    const value = key === 'spi' ? province.bundle?.consensus_spi : province.inputs?.[key]
    return typeof value === 'number' && Number.isFinite(value) ? value : null
  }
  const display = (value, digits = 1) => value == null ? 'Unavailable' : value.toFixed(digits)
  const status = province => province.live && province.bundle?.drought_code ? <DTag d={province.bundle.drought_code} /> : <span className="nw-psub">No observation</span>
  return <><Heading view="drought" /><div className="nw-grid nw-gmap"><Panel title="Classification by province"><MapSVG provinces={provinces} selected={p.id} onSelect={selectProvince} colorFn={item => item.live && item.bundle?.drought_code ? (DCLASS[item.bundle.drought_code] || DCLASS['-']).c : '#647582'} valueFn={item => observed(item, 'spi') == null ? 'No source observation' : `SPI ${display(observed(item, 'spi'), 2)}`} /><p className="nw-psub">Grey provinces have no connected observation. Boundaries are generalized for display.</p></Panel><Panel title={p.name} source={p.live ? 'Connected prediction' : 'Source observation unavailable'}>{status(p)}<div className="nw-grid nw-g2" style={{ marginTop: 14 }}><Kpi label="Consensus SPI" value={display(observed(p, 'spi'), 2)} /><Kpi label="Rainfall" value={display(observed(p, 'rainfall'))} unit="mm" /></div><p className="nw-psub" style={{ marginTop: 14 }}>Catchment authority: {p.cma}. Select a province to inspect its connected source record.</p></Panel></div><div style={{ marginTop: 14 }}><Panel title="Provincial drought table"><div className="nw-tscroll nw-province-drought-scroll"><table><thead><tr><th>Province</th><th>Classification</th><th className="nw-num">SPI</th><th className="nw-num">6-month rainfall</th></tr></thead><tbody>{provinces.map(item => <tr key={item.id}><td>{item.name}</td><td>{status(item)}</td><td className="nw-num">{display(observed(item, 'spi'), 2)}</td><td className="nw-num">{display(observed(item, 'seasonal_rainfall_6m'), 0)}{observed(item, 'seasonal_rainfall_6m') == null ? '' : ' mm'}</td></tr>)}</tbody></table></div></Panel></div></>
}

function Alerts() { return <><Heading view="alerts" /><Panel title="Open alerts" source="Operations"><div>{[['Critical', 'Nqweba Dam has fallen below 8% full supply capacity.', 'Eastern Cape', 'var(--d4)'], ['Severe', 'Persistent rainfall deficit across the lower Orange catchment.', 'Northern Cape', 'var(--d2)'], ['Watch', 'Model confidence indicates worsening conditions within the next 30 days.', 'Western Cape', 'var(--d1)'], ['Information', 'Climate warehouse prediction refresh completed successfully.', 'National', 'var(--river)']].map(([level, text, area, color]) => <div className="nw-alertrow" key={text}><i className="sev" style={{ background: color }} /><div><b>{level} ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â· {area}</b><p>{text}</p></div><time>Today</time></div>)}</div></Panel></> }
function Pipeline() { return <><Heading view="pipeline" /><div className="nw-grid nw-g4"><Kpi label="Sources registered" value={SOURCES.length} /><Kpi label="Connected now" value={SOURCES.filter((s) => s.live).length} /><Kpi label="Ingestion health" value="99.1" unit="%" /><Kpi label="Model outputs" value="9" unit="provinces" /></div><div style={{ marginTop: 14 }}><Panel title="Source registry"><table><thead><tr><th>Source</th><th>Protocol</th><th>Frequency</th><th>Status</th></tr></thead><tbody>{SOURCES.map((s) => <tr key={s.n}><td>{s.n}</td><td>{s.proto}</td><td>{s.freq}</td><td><span className={`nw-tag ${s.live ? 't-ok' : 't-mute'}`}>{s.live ? 'Connected' : 'Pending connection'}</span></td></tr>)}</tbody></table></Panel></div></> }

function RoadmapView() { return <><Heading view="roadmap" /><div className="nw-grid nw-g3">{ROADMAP.map((p) => <Panel key={p.ph} title={p.ph} source={p.mo}><ul className="nw-tl">{p.items.map(([x, st]) => <li key={x} className={st === 'done' ? 'done' : st === 'now' ? 'now' : ''}>{x}<br /><span className="nw-note">{st === 'done' ? 'Complete' : st === 'now' ? 'In progress' : 'Planned'}</span></li>)}</ul></Panel>)}</div></> }

const catalogue = {
  rainfall: { title: 'Rainfall monitoring', intro: 'Latest provincial climate inputs used by the connected NIWIS prediction service.', cols: ['Province', 'Daily rainfall', '3-month accumulation', 'Data state'], rows: [['Eastern Cape', '42.5 mm', '130 mm', 'Connected model input'], ['Free State', '31.8 mm', '116 mm', 'Connected model input'], ['Gauteng', '28.6 mm', '124 mm', 'Connected model input'], ['KwaZulu-Natal', '51.3 mm', '182 mm', 'Connected model input']] },
  vegetation: { title: 'Vegetation condition', intro: 'Vegetation-condition products become available when the SANSA earth-observation feed is connected.', cols: ['Product', 'Resolution', 'Update cycle', 'State'], rows: [['Vegetation Condition Index', '10ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã…â€œ30 m', 'Dekadal', 'Awaiting SANSA feed'], ['Vegetation Health Index', '1 km', 'Weekly', 'Awaiting SANSA feed'], ['Soil-moisture anomaly', '1 km', 'Daily', 'Awaiting SANSA feed']] },
  runoff: { title: 'Runoff monitoring', intro: 'Indicative river-flow conditions from the national gauging network.', cols: ['Station', 'Flow', 'Percentile', 'State'], rows: STATIONS.map((s) => [s.n, `${s.q} mÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â³/s`, `${s.pct}%`, s.state]) },
  surface: { title: 'Surface water network', intro: 'Priority streamflow stations currently represented in the NIWIS catalogue.', cols: ['ID', 'Station', 'Discharge', 'State'], rows: STATIONS.map((s) => [s.id, s.n, `${s.q} mÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â³/s`, s.state]) },
  groundwater: { title: 'Groundwater status', intro: 'Strategic boreholes and their current groundwater stress indicator.', cols: ['Borehole', 'Depth', 'SGI', 'Telemetry'], rows: BOREHOLES.map((s) => [s.n, `${s.depth} m bgl`, s.sgi.toFixed(2), s.tele ? 'Reporting' : 'Manual']) },
  climate: { title: 'Climate change', intro: 'Climate indicators and scenario products for long-range water-resource planning.', cols: ['Indicator', 'Baseline', 'Planning use', 'State'], rows: [['Temperature anomaly', '1981ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã…â€œ2010', 'Heat and evaporation stress', 'Model input connected'], ['Rainfall anomaly', '1981ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã…â€œ2010', 'Drought monitoring', 'Model input connected'], ['CMIP6 scenarios', 'SSP pathways', 'Long-term planning', 'Catalogue ready']] },
  quality: { title: 'Water quality', intro: 'National water-quality monitoring sites in the prototype catalogue.', cols: ['Site', 'Province', 'pH', 'Status'], rows: WQSITES.map((s) => [s.n, s.prov, s.ph.toFixed(1), s.st]) },
  bluedrop: { title: 'Drinking water ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â Blue Drop', intro: 'Drinking-water compliance overview for representative systems.', cols: ['Water services authority', 'Province', 'Compliance', 'Status'], rows: BLUEDROP.map((s) => [s.n, s.prov, `${s.comp}%`, s.st]) },
  greendrop: { title: 'Wastewater ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â Green Drop', intro: 'Wastewater works risk and load assessment.', cols: ['Works', 'Province', 'Load', 'Status'], rows: GREENDROP.map((s) => [s.n, s.prov, `${s.load}%`, s.st]) },
  balance: { title: 'Water balance and transfers', intro: 'National water balance inputs from the NIWIS prototype catalogue.', cols: ['Component', 'Code', 'Volume', 'Source'], rows: BALANCE.map((s) => [s[0], s[1], `${s[2].toLocaleString()} MmÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â³`, s[3]]) },
  tariffs: { title: 'Raw water tariffs', intro: 'Indicative charges by national water-resource scheme.', cols: ['Scheme', 'Raw water', 'Annual change', 'Users'], rows: TARIFFS.map((s) => [s.sch, `R ${s.raw.toFixed(2)}/mÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â³`, `${s.d}%`, s.users]) },
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
  const rows = item?.rows || [['Operational data connection', 'Pending', 'ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â', 'Available in future feed']]
  const cols = item?.cols || ['Module', 'State', 'Last update', 'Next action']
  return <><Heading view={view} /><Panel title={title} source="NIWIS catalogue"><p className="nw-psub">{item?.intro || 'This operational module is represented in the NIWIS prototype catalogue.'}</p><div className="nw-tscroll"><table><thead><tr>{cols.map((col) => <th key={col}>{col}</th>)}</tr></thead><tbody>{rows.map((row, i) => <tr key={`${row[0]}-${i}`}>{row.map((cell, j) => <td key={j}>{cell}</td>)}</tr>)}</tbody></table></div></Panel></>
}

export default function NIWISPortal() {
  const [view, setViewState] = useState(viewFromLocation), [navOpen, setNavOpen] = useState(false), [selected, setSelected] = useState('GP'), [predictions, setPredictions] = useState([])
  const [expandedGroups, setExpandedGroups] = useState(() => {
    const initialView = viewFromLocation()
    return Object.fromEntries(NAV.flatMap(([, items]) => items
      .filter(([, , , , children]) => children?.some(([childView]) => childView === initialView))
      .map(([parentView]) => [parentView, true])))
  })
  const moduleSection = MODULE_SECTION_META[view] || null
  const moduleView = moduleSection?.parentView || view
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
  useEffect(() => {
    if (view !== 'drought') return undefined
    const controller = new AbortController()
    setPredictions([])
    fetch('/niwis-api/api/predictions/latest', { signal: controller.signal })
      .then((response) => response.ok ? response.json() : Promise.reject(new Error(`Prediction source returned HTTP ${response.status}.`)))
      .then((response) => { if (!controller.signal.aborted) setPredictions(response.predictions || []) })
      .catch(() => {})
    return () => controller.abort()
  }, [view])
  const provinces = useMemo(() => liveProvinces(predictions), [predictions])
  useEffect(() => {
    if (moduleSection) setExpandedGroups(current => ({ ...current, [moduleSection.parentView]: true }))
  }, [moduleSection, view])
  const selectProvince = (id) => { setSelected(id); setView('drought') }
  const selectSatelliteProvince = (id) => setSelected(id)
  const section = moduleSection?.sectionKey || null
  const content = moduleView === 'spatial' ? <SpatialDashboard /> : moduleView === 'water-services' ? <WaterServices section={section} /> : moduleView === 'water-tariffs' ? <MunicipalTariffs section={section} /> : moduleView === 'water-quantity' ? <WaterQuantityAssessment section={section} /> : moduleView === 'wrm' ? <WaterResourceManagement section={section} /> : moduleView === 'rwqo' ? <ResourceWaterQualityObjectives navigationSection={section} /> : moduleView === 'groundwater' ? <GroundwaterLevelMonitoring section={section} /> : moduleView === 'groundwater-reserve' ? <GroundwaterReserveAssessment section={section} /> : moduleView === 'water-quality' ? <WaterQualityMonitoring section={section} /> : moduleView === 'wastewater' ? <WastewaterCompliance section={section} /> : moduleView === 'drinking-water' ? <DrinkingWaterCompliance section={section} /> : moduleView === 'dams' ? <ReservoirStatus section={section} /> : moduleView === 'surface' ? <SurfaceWaterNetwork section={section} /> : moduleView === 'runoff' ? <RunoffStatus section={section} /> : moduleView === 'rainfall' ? <RainfallStatus section={section} /> : moduleView === 'vegetation' ? <VegetationCondition section={section} /> : (view === 'climate' || view.startsWith('climate-')) ? <ClimateDashboard key={`climate-dashboard-${view}`} section={view.startsWith('climate-') ? view.slice(8) : null} /> : view === 'monitoring' ? <DroughtMonitoring /> : view === 'overview' ? <MeteorologicalDrought renderForecast={(region) => <DeferredPanel key={region}><OverviewForecastStudio region={region} /></DeferredPanel>} /> : view === 'drought' ? <Drought provinces={provinces} selected={selected} selectProvince={selectProvince} /> : view === 'alerts' ? <Alerts /> : view === 'pipeline' ? <Pipeline /> : view === 'roadmap' ? <RoadmapView /> : view === 'satellite' ? <Satellite provinces={provinces} selected={selected} selectProvince={selectSatelliteProvince} /> : view === 'hydrology' ? <HydrologyDrought /> : <CatalogueView view={view} />
  // Forecasting belongs to a selected topic. Keep the meteorological,
  // hydrological and satellite drought routes as their own topic views.
  const climateSubtopic = view.startsWith('climate-')
  const forecastDashboard = moduleSection
    ? ({ dams: 'reservoirs' }[moduleSection.parentView] || moduleSection.parentView)
    : climateSubtopic ? 'climate' : ['hydrology', 'satellite'].includes(view) ? view : null
  const forecastSection = moduleSection?.sectionKey || (climateSubtopic ? view.slice(8) : null)
  const forecastSectionLabel = moduleSection?.label || (climateSubtopic ? NAV.flatMap(([, items]) => items).find(([id]) => id === 'climate')?.[4]?.find(([id]) => id === view)?.[1] : null)
  const isSubtopicDashboard = Boolean(moduleSection) || climateSubtopic || ['hydrology', 'satellite'].includes(view)
  const shellClasses = {
    monitoring: 'dm-shell', climate: 'climate-shell', vegetation: 'climate-shell vegetation-shell',
    rainfall: 'climate-shell rainfall-shell', runoff: 'climate-shell runoff-shell',
    surface: 'climate-shell surface-water-shell', groundwater: 'climate-shell groundwater-shell',
    'groundwater-reserve': 'climate-shell groundwater-reserve-shell', 'water-quality': 'climate-shell water-quality-shell',
    wastewater: 'climate-shell wastewater-shell', 'drinking-water': 'climate-shell drinking-water-shell',
    rwqo: 'climate-shell rwqo-shell', wrm: 'climate-shell wrm-shell', spatial: 'climate-shell spatial-shell',
    'water-services': 'climate-shell water-services-shell', 'water-tariffs': 'climate-shell water-tariffs-shell',
    'water-quantity': 'climate-shell water-quantity-shell', dams: 'climate-shell reservoir-shell',
  }
  const [statusTitle, statusDescription] = descriptions[moduleView] || ['NIWIS WATER INTELLIGENCE', 'Dashboard overview']
  const sourceStatus = moduleView === 'spatial' ? 'Local GIS files' : ['water-services', 'water-tariffs'].includes(moduleView) ? 'Supabase records' : ['monitoring', 'overview', 'hydrology', 'satellite', 'climate', 'vegetation', 'rainfall', 'runoff', 'surface', 'groundwater', 'groundwater-reserve', 'water-quality', 'wastewater', 'drinking-water', 'rwqo', 'wrm', 'water-quantity', 'dams'].includes(moduleView) ? 'Supabase observations' : 'NIWIS portal'

  return <div className="nw nw-unified-theme">
    <div className={'nw-app ' + (shellClasses[moduleView] || '')}>
      <header className="nw-topbar">
        <button className="nw-iconbtn" onClick={() => setNavOpen(value => !value)} aria-label="Toggle menu"><Menu size={16} /></button>
        <a className="nw-brand nw-brand-home" href="/" aria-label="NIWIS home"><img className="nw-logo nw-logo-topbar nw-logo-light" src="/dws-logo.svg" alt="Department of Water and Sanitation logo" /><img className="nw-logo nw-logo-topbar nw-logo-dark" src="/dws-logo-dark.svg" alt="" aria-hidden="true" /> NIWIS</a>
        <div className="nw-statusstrip">
          <div className="nw-sstat"><em>{statusTitle}</em><b>{statusDescription}</b></div>
          <div className="nw-sstat"><em>DATA SOURCE</em><b>{sourceStatus}</b></div>
        </div>
        <div className="nw-topactions"><ThemeSelector /><span className="nw-pill live"><i className="nw-dot" />{sourceStatus}</span><a className="nw-home-link" href="/" aria-label="Return to NIWIS home"><Home size={16} aria-hidden="true" /><span>Home</span></a></div>
      </header>
      <nav className={'nw-nav ' + (navOpen ? 'open' : '')}>
        {NAV.map(([group, items]) => <div key={group}>
          <div className="nw-navgroup">{group}</div>
          {items.map(([id, label, num, live, children]) => {
            const groupOpen = expandedGroups[id] ?? !!children?.some(([childId]) => childId === view)
            const active = view === id || children?.some(([childId]) => childId === view) || (id === 'monitoring' && view === 'drought')
            return <div key={id}>
              <button className={'nw-navitem ' + (active ? 'sel' : '')} aria-expanded={children ? groupOpen : undefined} aria-controls={children ? 'nw-' + id + '-subgroups' : undefined} onClick={() => {
                if (children) { setExpandedGroups(current => ({ ...current, [id]: !current[id] })); setView(id) }
                else { setView(id); setNavOpen(false) }
              }}>{num && <span className="nw-nid">{num}.</span>}<span className="nw-nav-label">{label}</span>{live && <span className="nw-live">Live</span>}{children && <ChevronDown size={16} className={'nw-nav-chevron ' + (groupOpen ? 'expanded' : '')} />}</button>
              {children && groupOpen && <div id={'nw-' + id + '-subgroups'} className="nw-nav-subgroups">{children.map(([childId, childLabel]) => <button key={childId} className={'nw-navitem nw-nav-child ' + (view === childId ? 'sel' : '')} onClick={() => { setExpandedGroups(current => ({ ...current, [id]: true })); setView(childId); setNavOpen(false) }}>{childLabel}</button>)}</div>}
            </div>
          })}
        </div>)}
        <div className="nw-nav-brand-card"><div className="nw-brand-water-icon"><Droplets size={20} aria-hidden="true" /></div><div className="nw-brand-tagline"><strong>Reliable Water Data.</strong><span>Informed Decisions.</span><em>A Resilient South Africa.</em></div></div>
      </nav>
      <main className="nw-main">
        <DataFreshness view={moduleView} />
        {moduleSection && <section className="nw-module-section-context" aria-label="Selected dashboard section"><span>{NAV.flatMap(([, items]) => items).find(([parentView]) => parentView === moduleSection.parentView)?.[1]} / {moduleSection.label}</span><strong>{moduleSection.label}</strong><small>Maps, graphs, and forecast variables are limited to this topic and its available observations.</small></section>}
        {!moduleSection && <DashboardReport key={moduleView} view={moduleView} />}
        <div className="nw-dashboard-content" data-dashboard-scope={isSubtopicDashboard ? 'subtopic' : 'main'}>
          <Suspense fallback={<LoadingProgress message="Loading dashboard" />}>{content}</Suspense>
        </div>
        {forecastDashboard && <DeferredPanel key={'deferred-' + forecastDashboard + '-' + (forecastSection || 'all')}><DashboardForecastStudio key={'forecast-' + forecastDashboard + '-' + (forecastSection || 'all')} dashboard={forecastDashboard} section={forecastSection} sectionLabel={forecastSectionLabel} /></DeferredPanel>}
      </main>
    </div>
  </div>
}
