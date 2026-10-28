import { normaliseForecastDate as normaliseDate } from '../lib/forecastDates'
import { dashboardFetch as fetch } from '../services/dashboardFetch'
import { useEffect, useMemo, useRef, useState } from 'react'
import Plot from './LazyPlot'
import {
  lstmDefaultFeatures,
  modelGroups,
  modelKey,
  preferredForecastTarget,
  requiresFeatureSelection,
} from '../lib/modelOptions'
import { getTrainingJob, registerDashboardDataset, startTraining } from '../services/api'
import LoadingProgress from './LoadingProgress'
import '../niwis/niwis-portal.css'

// All dashboards use the same registration and /models/train path as the
// drought studio. These settings only identify the source series and sensible
// first targets for each module.
const CONFIGS = {
  'water-quantity': { label: 'Water Quantity Assessment', meta: '/api/water-quantity/forecast-metadata', data: '/api/water-quantity/forecast-source', dateKey: 'period', frequency: 'monthly', monthlyRange: true, autoTrain: false, limitTargetsToMetrics: true, preferred: ['reported_balance', 'map_volume', 'runoff_volume', 'reported_demand', 'katse_vaal', 'receiving_deficit', 'donor_storage'] },
  wrm: { label: 'Water Resource Management', meta: '/api/wrm/forecast-metadata', data: '/api/wrm/forecast-source', dateKey: 'year', frequency: 'annual', annualForecast: true, defaultModel: 'Auto', autoTrain: false, limitTargetsToMetrics: true, allowedModels: ['Auto', 'Naive', 'Historic Average', 'Window Average'], preferred: ['precipitation', 'runoff', 'recharge', 'water_losses', 'swsa_rainfall', 'swsa_streamflow'] },
  rwqo: { label: 'Resource Water Quality Objectives', meta: '/api/rwqo/forecast-metadata', data: '/api/rwqo/forecast-source', dateKey: 'period', frequency: 'monthly', monthlyRange: true, autoTrain: false, limitTargetsToMetrics: true, preferred: ['sass5_score', 'dissolved_oxygen', 'low_flow', 'total_phosphorus'] },
  climate: { label: 'Climate', meta: '/api/climate/metadata', data: '/api/climate/monthly', dateKey: 'month', frequency: 'monthly', monthlyRange: true, preferred: ['Tavg_C', 'Tmax_C', 'Tmin_C', 'MAP_mm'] },
  vegetation: { label: 'Vegetation condition', meta: '/api/vegetation/metadata', data: '/api/vegetation/forecast-source', dateKey: 'month', frequency: 'monthly', forecastMonths: 36, autoTrain: false, preferred: ['NDVI_10day_composite', 'VCI_percent', 'VHI_percent'] },
  rainfall: { label: 'Rainfall', meta: '/api/rainfall/metadata', data: '/api/rainfall/forecast-source', dateKey: 'month', frequency: 'monthly', forecastMonths: 36, autoTrain: false, preferred: ['spi3', 'spei3', 'reported_rainfall', 'rainfall'] },
  runoff: { label: 'Runoff', meta: '/api/runoff/metadata', data: '/api/runoff/forecast-source', dateKey: 'month', frequency: 'monthly', forecastMonths: 36, autoTrain: false, preferred: ['ssi', 'volume', 'reported_volume', 'rainfall'] },
  surface: { label: 'Surface water', meta: '/api/surface-water/metadata', data: '/api/surface-water/forecast-source', dateKey: 'month', frequency: 'monthly', forecastMonths: 36, autoTrain: false, preferred: ['discharge', 'volume', 'water_extent', 'ndwi'] },
  groundwater: { label: 'Groundwater levels', meta: '/api/groundwater/metadata', data: '/api/groundwater/forecast-source', dateKey: 'month', frequency: 'monthly', forecastMonths: 36, autoTrain: false, preferred: ['sgi_dimensionless', 'groundwater_table_depth_m_bgl', 'hydraulic_head_amsl_m'] },
  'groundwater-reserve': { label: 'Groundwater reserve', meta: '/api/groundwater-reserve/metadata', data: '/api/groundwater-reserve/monthly', dateKey: 'period', frequency: 'monthly', monthlyRange: true, preferred: ['reserve_balance_million_m3_yr', 'dynamic_reserve_million_m3_yr', 'total_abstraction_m3_yr'] },
  'water-quality': { label: 'Water quality', meta: '/api/water-quality/metadata', data: '/api/water-quality/monthly', dateKey: 'period', frequency: 'monthly', monthlyRange: true, preferred: ['ph', 'temperature_c', 'turbidity_ntu', 'dissolved_oxygen_mg_l'] },
  wastewater: { label: 'Wastewater quality', meta: '/api/wastewater/forecast-metadata', data: '/api/wastewater/forecast-source', dateKey: 'period', frequency: 'monthly', monthlyRange: true, autoTrain: false, limitTargetsToMetrics: true, preferred: ['cod_mg_l', 'hydraulic_loading_pct', 'ecoli_cfu_100ml', 'rainfall_mm'] },
  'drinking-water': { label: 'Drinking water quality', meta: '/api/drinking-water/forecast-metadata', data: '/api/drinking-water/forecast-source', dateKey: 'period', frequency: 'monthly', monthlyRange: true, autoTrain: false, limitTargetsToMetrics: true, preferred: ['turbidity_ntu', 'free_chlorine_mg_l', 'nitrate_mg_l', 'ph'] },
  reservoirs: { label: 'Reservoirs', meta: '/api/reservoirs/metadata', data: '/api/reservoirs/dashboard', dateKey: 'date', frequency: 'daily', preferred: ['pct_fsc', 'storage', 'level', 'inflow'] },
  satellite: { label: 'Satellite drought', meta: '/api/satellite/stations', data: '/api/satellite/forecast-source', dateKey: 'date', frequency: 'monthly', preferred: ['NDVI', 'VCI', 'VHI', 'NDWI'] },
  hydrology: { label: 'Hydrological drought', meta: '/api/hydrology/metadata', data: '/api/hydrology/forecast-source', dateKey: 'date', frequency: 'monthly', preferred: ['ssi_dimensionless', 'river_discharge_m3_s', 'sgi_dimensionless'] },
}

function getJSON(url, signal) {
  return fetch(url, { signal }).then(async (response) => {
    const content = await response.text()
    let body
    try { body = JSON.parse(content) } catch {
      throw new Error(response.ok
        ? 'The forecast source returned an invalid response. Please retry.'
        : `The forecast source is unavailable (HTTP ${response.status}). Please retry.`)
    }
    if (!response.ok) throw new Error(typeof body?.detail === 'string' ? body.detail : 'Forecast source could not be loaded.')
    return body
  })
}

function regionOptions(meta, dashboard) {
  if (dashboard === 'hydrology') return ['National', ...new Set(meta?.districts || [])]
  if (dashboard === 'satellite') return ['National', ...new Set((meta?.stations || []).map((station) => station.name).filter(Boolean))]
  if (Array.isArray(meta?.regions)) {
    const values = meta.regions.map((region) => typeof region === 'string' ? region : region.district_name || region.name).filter(Boolean)
    return ['National', ...new Set(values.filter((value) => value !== 'National'))]
  }
  return []
}

function sourceParams(config, meta, region) {
  const params = { region }
  if (config.monthlyRange) {
    const years = meta?.years || []
    const isClimate = config.meta === '/api/climate/metadata'
    params.start = isClimate && years.includes(2018) ? 2018 : (meta?.default_start ?? years[0])
    params.end = isClimate && years.includes(2025) ? 2025 : (meta?.default_end ?? years.at(-1))
  } else if (config.frequency === 'annual') {
    const years = meta?.years || []
    // Climate opens with the dashboard's approved 2018–2025 window. Keep
    // the shared forecasting panel on that same bounded request instead of
    // launching a second full-history daily read at page load.
    const isClimate = config.meta === '/api/climate/metadata'
    const climateStart = isClimate && years.includes(2018) ? 2018 : (years[0] ?? meta?.default_start)
    const climateEnd = isClimate && years.includes(2025) ? 2025 : (meta?.default_end ?? years.at(-1))
    params.start = climateStart
    params.end = climateEnd
    if (config.dateKey === 'Year') params.season = 'Annual'
  } else if (config.dateKey === 'date') {
    params.start = meta?.default_start
    params.end = meta?.default_end
  } else {
    // Keep the forecasting read bounded. The LSTM needs 36 complete months;
    // the vegetation adapter exposes a compact forecast-source endpoint for
    // this path instead of reloading its dashboard comparison window.
    params.end = meta?.default_end || meta?.months?.at(-1)
    if (config.forecastMonths && params.end) {
      const first = new Date(`${params.end}-01T00:00:00`)
      first.setMonth(first.getMonth() - (config.forecastMonths - 1))
      params.start = `${first.getFullYear()}-${String(first.getMonth() + 1).padStart(2, '0')}`
    } else {
      params.start = meta?.months?.[0] || meta?.default_start
    }
  }
  return Object.fromEntries(Object.entries(params).filter(([, value]) => value != null && value !== ''))
}


function normaliseRows(rows, config) {
  return (rows || []).map((row) => {
    const sourceDate = row[config.dateKey] ?? row.date ?? row.period ?? row.month ?? row.year ?? row.Year ?? row.Date
    return { ...row, date: normaliseDate(sourceDate, config.frequency) }
  }).filter((row) => row.date && row.date !== 'undefined' && row.date !== 'null')
}

function responseRows(body) {
  if (Array.isArray(body)) return body
  // Climate monthly responses use `series`; annual climate responses expose
  // the same observations as `series` and may also provide `annual_series`.
  // Keep both shapes supported so section-specific forecast loads do not
  // mistake a valid response for an empty dataset.
  return body?.series?.length ? body.series : body?.annual_series?.length ? body.annual_series : body?.rows || body?.data || []
}

function numericValue(value) {
  if (value == null || typeof value === 'boolean' || !['number', 'string'].includes(typeof value)
    || (typeof value === 'string' && !value.trim())) return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function metricKeys(metadata, dashboard, section, config) {
  if (dashboard === 'climate' && section) return new Set((metadata?.metrics || []).filter((item) => item.section === section).map((item) => item.key))
  return config?.limitTargetsToMetrics ? new Set((metadata?.metrics || []).map((item) => item.key)) : null
}

function numericKeys(rows, preferred = [], allowed = null) {
  const keys = new Set()
  rows.forEach((row) => Object.entries(row).forEach(([key, value]) => {
    if (!['date', 'year', 'Year', 'month', 'period', 'Date', 'count'].includes(key)
      && numericValue(value) != null) keys.add(key)
  }))
  const usable = allowed ? [...keys].filter((key) => allowed.has(key)) : [...keys]
  return [...preferred.filter((key) => usable.includes(key)), ...usable.filter((key) => !preferred.includes(key))]
}

function monthPoint(dates = [], values = [], monthsAhead) {
  if (!dates.length || !values.length) return { value: null, label: `+${monthsAhead}m` }
  const target = new Date(dates[0])
  target.setDate(1)
  target.setMonth(target.getMonth() + monthsAhead)
  target.setDate(0)
  let nearest = 0
  let best = Infinity
  dates.forEach((date, index) => {
    const delta = Math.abs(new Date(date) - target)
    if (delta < best) { best = delta; nearest = index }
  })
  const value = numericValue(values[nearest])
  const stamp = String(dates[nearest] || '')
  const label = stamp ? new Date(stamp).toLocaleString('en-GB', { month: 'short', year: 'numeric' }) : `+${monthsAhead}m`
  return { value, label }
}

function formatForecastValue(value) {
  if (value == null) return '\u2014'
  return new Intl.NumberFormat('en-ZA', value !== 0 && Math.abs(value) < 1
    ? { maximumSignificantDigits: 3 }
    : { maximumFractionDigits: 2 }).format(value)
}

function spiClass(value) {
  if (value > -0.5) return '-'
  if (value > -0.8) return 'D0'
  if (value > -1.3) return 'D1'
  if (value > -1.6) return 'D2'
  if (value > -2) return 'D3'
  return 'D4'
}

export default function DashboardForecastStudio({ dashboard, section = null }) {
  const config = CONFIGS[dashboard]
  const [meta, setMeta] = useState(null)
  const [sourceRows, setSourceRows] = useState([])
  const [sourceMode, setSourceMode] = useState('')
  const [dataset, setDataset] = useState(null)
  const [region, setRegion] = useState('National')
  const [target, setTarget] = useState('')
  const [model, setModel] = useState(config?.defaultModel || 'LSTM')
  const [features, setFeatures] = useState(lstmDefaultFeatures)
  const [forecastDays, setForecastDays] = useState(config?.annualForecast ? 3 : 365)
  const [showFeatures, setShowFeatures] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [job, setJob] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [retry, setRetry] = useState(0)
  const autoStarted = useRef(null)
  const requestKey = useRef('')
  const sourceVersion = useRef(0)

  const options = regionOptions(meta, dashboard)
  const availableModelGroups = config?.allowedModels ? modelGroups.map(group => ({ ...group, items: group.items.filter(item => config.allowedModels.includes(item)) })).filter(group => group.items.length) : modelGroups
  const catalogue = useMemo(() => Object.fromEntries((meta?.metrics || []).map((item) => [item.key, item])), [meta])
  const allowedKeys = useMemo(() => metricKeys(meta, dashboard, section, config), [dashboard, section, meta, config])
  const numericColumns = useMemo(() => numericKeys(sourceRows, config?.preferred || [], allowedKeys), [sourceRows, allowedKeys, config])
  const dateColumn = dataset?.index_column || 'date'
  const multiFeatureModel = config?.limitTargetsToMetrics
    ? ['lstm', 'var', 'varmax'].includes(modelKey(model))
    : requiresFeatureSelection(model)
  const training = submitting || (job && !['completed', 'failed'].includes(job.status))
  const result = job?.result

  const loadSource = async (metadata, selectedRegion, signal) => {
    const annualClimateSection = dashboard === 'climate' && section && ['spells', 'rainfall', 'streamflow'].includes(section)
    const sourceConfig = annualClimateSection
      ? { ...config, data: '/api/climate/dashboard', dateKey: 'Year', frequency: 'annual', monthlyRange: false }
      : config
    const sourceAllowedKeys = metricKeys(metadata, dashboard, section, config)
    let rows = []
    if (dashboard === 'hydrology') {
      const params = new URLSearchParams({ region: selectedRegion })
      const body = await getJSON(`${config.data}?${params}`, signal)
      if (!signal.aborted) setSourceMode(body.source_mode || '')
      rows = responseRows(body)
    } else {
      const params = sourceParams(sourceConfig, metadata, selectedRegion)
      if (dashboard === 'climate') {
        params.include_map = 'false'
        if (section) params.section = section
      }
      const body = await getJSON(`${sourceConfig.data}?${new URLSearchParams(params)}`, signal)
      if (!signal.aborted) setSourceMode(body.source_mode || '')
      rows = responseRows(body)
    }
    const normalised = normaliseRows(rows, sourceConfig)
    const numeric = numericKeys(normalised, config.preferred, sourceAllowedKeys)
    if (!numeric.length) throw new Error(`No numeric ${config.label.toLowerCase()} variables are available for ${selectedRegion}.`)
    if (signal.aborted) return
    const registered = await registerDashboardDataset({ dashboard, region: selectedRegion, date_column: 'date', rows: normalised })
    if (signal.aborted) return
    requestKey.current = `${dashboard}:${section || ''}:${selectedRegion}`
    setSourceRows(normalised)
    setDataset(registered)
    const selectedTarget = numeric.includes(target) ? target : numeric[0] || preferredForecastTarget(numeric)
    setTarget(selectedTarget)
    setFeatures(() => {
      const defaults = [...(config.preferred || []), ...lstmDefaultFeatures]
      const valid = [...new Set(defaults)].filter((name) => numeric.includes(name) && name !== selectedTarget)
      return (valid.length ? valid : numeric.filter((name) => name !== selectedTarget)).slice(0, 8)
    })
  }

  useEffect(() => {
    if (!config) return undefined
    const controller = new AbortController()
    sourceVersion.current += 1
    setLoading(true); setError(''); setMeta(null); setDataset(null); setSourceRows([]); setJob(null); setSubmitting(false); autoStarted.current = null; requestKey.current = ''
    getJSON(config.meta, controller.signal).then(async (metadata) => {
      if (controller.signal.aborted) return
      setMeta(metadata)
      const available = regionOptions(metadata, dashboard)
      const initial = metadata.default_region || available[0] || 'National'
      setRegion(initial)
      // Mark the initial request before awaiting it so the region effect does
      // not issue the same source read a second time during this render.
      requestKey.current = `${dashboard}:${section || ''}:${initial}`
      await loadSource(metadata, initial, controller.signal)
    }).catch((err) => { if (!controller.signal.aborted) { requestKey.current = ''; if (err.name !== 'AbortError') setError(err.response?.data?.detail || err.message) } }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => { controller.abort(); sourceVersion.current += 1 }
  }, [dashboard, section, retry])

  useEffect(() => {
    if (!meta || !config || !region || requestKey.current === `${dashboard}:${section || ''}:${region}`) return undefined
    const controller = new AbortController()
    sourceVersion.current += 1
    setLoading(true); setError(''); setDataset(null); setSourceRows([]); setJob(null); setSubmitting(false); autoStarted.current = null
    loadSource(meta, region, controller.signal).catch((err) => { if (!controller.signal.aborted && err.name !== 'AbortError') setError(err.response?.data?.detail || err.message) }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => { controller.abort(); sourceVersion.current += 1 }
  }, [region])

  useEffect(() => {
    if (!job?.job_id || ['completed', 'failed'].includes(job.status)) return undefined
    let cancelled = false
    let timer
    const poll = async () => {
      try {
        const next = await getTrainingJob(job.job_id)
        if (cancelled) return
        setJob(next)
        if (next.status !== 'completed' && next.status !== 'failed') timer = setTimeout(poll, 1500)
        else if (next.status === 'failed') setError(next.message || 'Forecast training failed.')
      } catch (err) {
        if (!cancelled) { setError(err.response?.data?.detail || 'Unable to read the training result.'); setJob((current) => ({ ...current, status: 'failed' })) }
      }
    }
    timer = setTimeout(poll, 1500)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [job?.job_id])

  const train = async () => {
    if (!dataset?.dataset_id || !target || training) return
    const selectedFeatures = multiFeatureModel ? features.filter((feature) => feature !== target) : []
    if (multiFeatureModel && !selectedFeatures.length) {
      setError(`${model} needs at least one input feature. Open the inputs below and select one.`)
      return
    }
    setSubmitting(true); setError(''); setJob(null)
    const version = sourceVersion.current
    try {
      const started = await startTraining({ dataset_id: dataset.dataset_id, model_type: modelKey(model), date_column: dateColumn, target, group_column: null, features: selectedFeatures, forecast_steps: forecastDays })
      if (version === sourceVersion.current) setJob(started)
    } catch (err) { if (version === sourceVersion.current) setError(err.response?.data?.detail || 'Training could not be started.') }
    finally { if (version === sourceVersion.current) setSubmitting(false) }
  }

  useEffect(() => {
    if (!config?.autoTrain || !dataset?.dataset_id || !target || autoStarted.current === dataset.dataset_id) return
    autoStarted.current = dataset.dataset_id
    train()
  }, [dataset?.dataset_id, target])

  if (!config) return null
  const observed = (result?.history_dates?.length && result?.history_values?.length
    ? result.history_dates.map((date, index) => ({ date, value: numericValue(result.history_values[index]) }))
    : sourceRows.map((row) => ({ date: row.date, value: numericValue(row[target]) })))
    .filter((point) => point.date).slice(-18)
  const observedDates = observed.map((point) => point.date)
  const observedValues = observed.map((point) => point.value)
  const targetMetric = catalogue[target]
  const targetLabel = targetMetric?.label || target || 'Selected variable'
  const targetAxis = targetMetric?.unit ? `${targetLabel} (${targetMetric.unit})` : targetLabel
  const forecastDates = result?.forecast_dates || []
  const forecastValues = result?.forecast_values || []
  const lowerBound = result?.lower_bound || []
  const upperBound = result?.upper_bound || []
  const cards = config.annualForecast
    ? [0, 1, 2].map(index => ({ label: forecastDates[index] ? String(forecastDates[index]).slice(0, 4) : `+${index + 1}y`, value: forecastValues[index] ?? null }))
    : [1, 2, 3].map((month) => monthPoint(forecastDates, forecastValues, month))
  const droughtIndex = /(^|_)(spi|spei)/i.test(target)
  const droughtOdds = forecastValues.length ? Math.round((forecastValues.filter((value) => Number(value) <= -1.3).length / forecastValues.length) * 100) : null
  const chartData = [
    { x: observedDates, y: observedValues, type: 'scatter', mode: 'lines', name: 'Historical', line: { color: '#7aa0b0', width: 2 } },
    ...(lowerBound.length && upperBound.length ? [
      { x: forecastDates, y: lowerBound, type: 'scatter', mode: 'lines', name: 'Lower bound', line: { color: 'rgba(47,168,201,0)', width: 0 }, hoverinfo: 'skip', showlegend: false },
      { x: forecastDates, y: upperBound, type: 'scatter', mode: 'lines', name: 'Confidence range', fill: 'tonexty', fillcolor: 'rgba(47,168,201,.22)', line: { color: 'rgba(90,198,227,.45)', width: 1 } },
    ] : []),
    { x: forecastDates, y: forecastValues, type: 'scatter', mode: 'lines', name: `Forecast · ${String(result?.selected_model || model).toUpperCase()}`, line: { color: '#5ac6e3', width: 2.6 } },
  ]

  return (
    <section className="nw-panel nw-overview-forecast" aria-label={`${config.label} forecasting studio`}>
      <div className="nw-panel-header"><span>Forecasting studio · {region}</span><span className="nw-panel-link">{config.annualForecast ? 'Annual observations / year-based horizons' : 'LSTM default · selectable models, targets and horizon'}</span></div>
      <div className="nw-dash-forecast">
        {sourceMode === 'local_csv_fallback' && <p className="nw-note">Using packaged observations because the configured database source is unavailable.</p>}
        {loading && !dataset ? <LoadingProgress className="nw-forecast-loading" message={`Loading ${config.label.toLowerCase()} history for the forecast`} /> : error && !dataset ? <div className="nw-error" role="alert">{error}<button type="button" className="nw-btn" onClick={() => setRetry((value) => value + 1)}>Retry forecast source</button></div> : <>
          <div className="nw-dash-forecast-controls">
            {options.length > 1 && <label><span>Region</span><select aria-label={`${config.label} forecast region`} value={region} onChange={(event) => setRegion(event.target.value)} disabled={training}>{options.map((option) => <option key={option}>{option}</option>)}</select></label>}
            <label><span>Model</span><select aria-label="Model" value={model} onChange={(event) => { setModel(event.target.value); setJob(null) }} disabled={training}>{availableModelGroups.map((group) => <optgroup key={group.label} label={group.label}>{group.items.map((item) => <option key={item}>{item}</option>)}</optgroup>)}</select></label>
            <label><span>Target</span><select aria-label="Target" value={target} onChange={(event) => { setTarget(event.target.value); setJob(null) }} disabled={training}>{numericColumns.map((column) => <option key={column} value={column}>{catalogue[column]?.label || column}</option>)}</select></label>
            <label><span>Horizon</span><select aria-label="Horizon" value={forecastDays} onChange={(event) => { setForecastDays(Number(event.target.value)); setJob(null) }} disabled={training}>{config.annualForecast ? <><option value={1}>1 year</option><option value={3}>3 years</option><option value={5}>5 years</option></> : <><option value={180}>6 months</option><option value={365}>1 year</option><option value={730}>2 years</option></>}</select></label>
            <button className="nw-btn pri" type="button" disabled={training || !target} onClick={train}>{training ? 'Training…' : `Run ${model}`}</button>
          </div>
          {multiFeatureModel && <div className="nw-dash-features"><button type="button" className="nw-panel-link" onClick={() => setShowFeatures((open) => !open)}>{showFeatures ? 'Hide' : 'Show'} {model} inputs</button>{showFeatures && <div className="nw-dash-feature-grid">{numericColumns.filter((column) => column !== target).map((column) => <label key={column}><input type="checkbox" checked={features.includes(column)} disabled={training} onChange={() => setFeatures((values) => values.includes(column) ? values.filter((item) => item !== column) : [...values, column])} />{catalogue[column]?.label || column}</label>)}</div>}</div>}
          {error && dataset && <div className="nw-error" role="alert">{error}</div>}
          {job?.status === 'completed' && <p className="nw-note">Forecast complete · {forecastValues.length} future observations</p>}
          {result?.warnings?.map((warning) => <p className="nw-note" key={warning}>{warning}</p>)}
          {training && <p className="nw-note">{job?.message || `Fitting ${model} to ${target}…`}</p>}
          <div className="nw-dash-forecast-chart">{observedValues.length || forecastValues.length ? <Plot data={chartData} layout={{ paper_bgcolor: 'transparent', plot_bgcolor: '#0d2029', font: { color: '#93AEBB', family: 'IBM Plex Sans', size: 11 }, margin: { l: 58, r: 12, t: 28, b: 36 }, height: 250, hovermode: 'x unified', legend: { orientation: 'h', y: 1.18, font: { size: 10 } }, xaxis: { gridcolor: '#1B3A49', tickfont: { size: 10 } }, yaxis: { gridcolor: '#1B3A49', title: { text: targetAxis, standoff: 10 }, automargin: true, zeroline: true, zerolinecolor: '#2A4E5E' }, shapes: forecastDates[0] ? [{ type: 'line', x0: forecastDates[0], x1: forecastDates[0], y0: 0, y1: 1, yref: 'paper', line: { color: '#8C7BE0', width: 1, dash: 'dot' } }] : [], annotations: forecastDates[0] ? [{ x: forecastDates[0], y: 1, yref: 'paper', text: 'Forecast start', showarrow: false, font: { size: 10, color: '#8C7BE0' }, xanchor: 'left' }] : [] }} config={{ displayModeBar: false, responsive: true }} useResizeHandler style={{ width: '100%' }} /> : <div className="nw-forecast-empty">The selected dashboard history will appear here once its source series is loaded.</div>}</div>
          <div className="nw-forecast-meta">{cards.map((point, index) => <div key={index}><span>{point.label}</span><strong>{formatForecastValue(point.value)}</strong><em>{droughtIndex && point.value != null ? spiClass(point.value) : point.value != null ? targetMetric?.unit || '' : ''}</em></div>)}</div>
          {droughtIndex && <div className="nw-dash-odds"><span>Forecast points at or below -1.3</span><strong>{droughtOdds != null ? `${droughtOdds}%` : '—'}</strong><em>{droughtOdds == null ? 'Available after the forecast completes' : 'Share of projected values, not a probability estimate'}</em></div>}
        </>}
      </div>
    </section>
  )
}
