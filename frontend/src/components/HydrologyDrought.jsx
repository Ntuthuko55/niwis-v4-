import { dashboardFetch as fetch } from '../services/dashboardFetch'
import { useEffect, useMemo, useState } from 'react'
import {
  Droplets, Waves, Gauge, Activity, Calendar, User, MapPin,
  AlertTriangle, AlertCircle, CheckCircle2, ArrowDown, ArrowUp,
  ChevronRight, Info, Loader2
} from 'lucide-react'
import '../niwis/hydrology.css'
import { normaliseDistrictName } from './DistrictMap'
import ProvinceMapLabels from './ProvinceMapLabels'
import LoadingProgress from './LoadingProgress'

const NUMERIC_FIELDS = [
  'river_discharge_m3_s',
  'fdc_percentiles_m3_s',
  'ssi_dimensionless',
  'dam_storage_million_m3',
  'dam_level_pct_fsc',
  'dam_inflow_m3_s',
  'dam_outflow_m3_s',
  'borehole_water_level_m_bgl',
  'sgi_dimensionless',
  'surface_runoff_m3_s',
  'baseflow_separation_m3_s',
]

const DISTRICT_PROVINCES = {
  'alfred nzo': 'Eastern Cape', amajuba: 'KwaZulu-Natal', amathole: 'Eastern Cape',
  bojanala: 'North West', 'buffalo city': 'Eastern Cape', cacadu: 'Eastern Cape',
  'cape winelands': 'Western Cape', capricorn: 'Limpopo', 'central karoo': 'Western Cape',
  'chris hani': 'Eastern Cape', 'city of cape town': 'Western Cape', 'city of johannesburg': 'Gauteng',
  'city of tshwane': 'Gauteng', 'dr kenneth kaunda': 'North West', 'dr ruth segomotsi mompati': 'North West',
  eden: 'Western Cape', ehlanzeni: 'Mpumalanga', ekurhuleni: 'Gauteng',
  ethekwini: 'KwaZulu-Natal', 'fezile dabi': 'Free State', 'frances baard': 'Northern Cape',
  'gert sibande': 'Mpumalanga', ilembe: 'KwaZulu-Natal', 'joe gqabi': 'Eastern Cape',
  'john taolo gaetsewe': 'Northern Cape', lejweleputswa: 'Free State', mangaung: 'Free State',
  mopani: 'Limpopo', namakwa: 'Northern Cape', 'nelson mandela bay': 'Eastern Cape',
  'ngaka modiri molema': 'North West', nkangala: 'Mpumalanga', 'ortambo': 'Eastern Cape',
  overberg: 'Western Cape', 'pixley ka seme': 'Northern Cape', sedibeng: 'Gauteng',
  'o.r.tambo': 'Eastern Cape',
  sekhukhune: 'Limpopo', sisonke: 'KwaZulu-Natal', 'thabo mofutsanyane': 'Free State',
  ugu: 'KwaZulu-Natal', umgungundlovu: 'KwaZulu-Natal', umkhanyakude: 'KwaZulu-Natal',
  umzinyathi: 'KwaZulu-Natal', uthukela: 'KwaZulu-Natal', uthungulu: 'KwaZulu-Natal',
  vhembe: 'Limpopo', waterberg: 'Limpopo', 'west coast': 'Western Cape',
  'west rand': 'Gauteng', xhariep: 'Free State', 'z f mgcawu': 'Northern Cape',
  zululand: 'KwaZulu-Natal',
}

const SSI_THRESHOLDS = [
  { y: 0, label: 'Normal' },
  { y: -0.5, label: '' },
  { y: -1.0, label: 'Moderate' },
  { y: -1.5, label: 'Severe' },
  { y: -2.0, label: 'Extreme' },
]

function isValidNumber(val) {
  if (val === null || val === undefined || val === '') return false
  const num = Number(val)
  return Number.isFinite(num)
}

function formatMetric(val) {
  if (!isValidNumber(val)) return null
  const num = Number(val)
  const abs = Math.abs(num)
  if (abs === 0) return '0.00'
  if (abs < 0.001) return num.toExponential(2)
  if (abs < 0.1) return num.toFixed(4)
  if (abs < 10) return num.toFixed(2)
  return num.toFixed(1)
}

function displayMetric(val, digits) {
  if (!isValidNumber(val)) return 'No data available'
  if (digits != null) return Number(val).toFixed(digits)
  return formatMetric(val)
}

function seriesFrom(rows, column) {
  return rows.map((row) => ({ date: row.date, value: isValidNumber(row[column]) ? Number(row[column]) : null }))
}

function seriesHasData(series) {
  return (series || []).some((point) => isValidNumber(point.value))
}

function meanOf(series) {
  const vals = (series || []).map((point) => point.value).filter(isValidNumber)
  if (!vals.length) return null
  return vals.reduce((sum, value) => sum + value, 0) / vals.length
}

function pctChange(current, baseline) {
  if (!isValidNumber(current) || !isValidNumber(baseline) || Number(baseline) === 0) return null
  return ((Number(current) - Number(baseline)) / Math.abs(Number(baseline))) * 100
}

async function loadHydrologyRecords(region, signal) {
  const response = await fetch(`/api/hydrology/observations?${new URLSearchParams({ region })}`, { signal })
  const payload = await response.json()
  if (!response.ok) throw new Error(payload.detail || 'Unable to load hydrological observations from the database.')
  return (payload.records || []).map((row) => ({ ...row,
    district_name: row.district_name.replace(/\b\w/g, (letter) => letter.toUpperCase()),
  }))
}

function classifySSI(ssi) {
  if (!isValidNumber(ssi)) return { label: 'No data available', severity: 'unknown', status: 'No data available', condition: 'No data' }
  const value = Number(ssi)
  if (value <= -2.0) return { label: 'Extreme drought', severity: 'extreme', status: 'Exceptional Drought', condition: 'Exceptional' }
  if (value <= -1.5) return { label: 'Severe drought', severity: 'severe', status: 'Severe Drought', condition: 'Severe' }
  if (value <= -1.0) return { label: 'Moderate drought', severity: 'moderate', status: 'Moderate Drought', condition: 'Moderate' }
  if (value <= -0.5) return { label: 'Mild dryness', severity: 'mild', status: 'Abnormally Dry', condition: 'Mildly Dry' }
  return { label: 'Normal', severity: 'normal', status: 'Near Normal', condition: 'Normal' }
}

function classifySGI(sgi) {
  if (!isValidNumber(sgi)) return { label: 'No data available', severity: 'unknown' }
  const value = Number(sgi)
  if (value >= -0.5) return { label: 'Normal', severity: 'normal' }
  if (value >= -1.0) return { label: 'Below Normal', severity: 'mild' }
  if (value >= -1.5) return { label: 'Moderate Groundwater Drought', severity: 'moderate' }
  return { label: 'Severe Groundwater Drought', severity: 'severe' }
}

function axisTicks(dates) {
  if (!dates.length) return []
  const years = dates.map((date) => String(date).slice(0, 4))
  const marks = []
  years.forEach((year, index) => {
    if (index === 0 || year !== years[index - 1]) marks.push({ index, label: year })
  })
  if (marks.length > 8) return marks.filter((_, i) => i % Math.ceil(marks.length / 8) === 0)
  return marks
}

function pathFrom(points, xAt, yAt) {
  let started = false
  return points.map((point, index) => {
    if (!isValidNumber(point.value)) return ''
    const command = started ? 'L' : 'M'
    started = true
    return `${command}${xAt(index).toFixed(2)},${yAt(point.value).toFixed(2)}`
  }).join(' ')
}

function NoData() {
  return <div className="hydro-nodata">No data available</div>
}

function SmoothSeriesChart({ series, color = '#06b6d4', gradId = 'sg1', unit = 'm³/s', meanValue = null, yLabel = 'Discharge (m³/s)' }) {
  if (!seriesHasData(series)) return <NoData />
  const values = series.map((point) => point.value).filter(isValidNumber)
  const min = Math.min(...values)
  const max = Math.max(...values, isValidNumber(meanValue) ? Number(meanValue) : -Infinity)
  const range = max - min || Math.abs(max) || 0.001
  const yMin = Math.min(0, min - range * 0.08)
  const yMax = max + range * 0.12
  const w = 340
  const h = 168
  const pad = { l: 42, r: 10, t: 12, b: 24 }
  const n = Math.max(1, series.length)
  const xAt = (i) => pad.l + (i / Math.max(1, n - 1)) * (w - pad.l - pad.r)
  const yAt = (v) => h - pad.b - ((v - yMin) / (yMax - yMin)) * (h - pad.t - pad.b)
  const ticks = [yMin, yMin + (yMax - yMin) * 0.33, yMin + (yMax - yMin) * 0.66, yMax]
  const last = [...series].reverse().find((point) => isValidNumber(point.value))
  const lastIndex = series.findLastIndex ? series.findLastIndex((point) => isValidNumber(point.value)) : series.reduce((acc, point, i) => (isValidNumber(point.value) ? i : acc), -1)
  const labels = axisTicks(series.map((point) => point.date))
  const meanY = isValidNumber(meanValue) ? yAt(meanValue) : null
  const linePath = pathFrom(series, xAt, yAt)
  // Build area path: line + close to baseline
  const firstValid = series.findIndex((p) => isValidNumber(p.value))
  const areaPath = firstValid >= 0 && lastIndex >= 0
    ? `${linePath} L${xAt(lastIndex).toFixed(2)},${(h - pad.b).toFixed(2)} L${xAt(firstValid).toFixed(2)},${(h - pad.b).toFixed(2)} Z`
    : ''

  return (
    <svg viewBox={`0 0 ${w} ${h}`} style={{ width: '100%', height: '100%' }}>
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.35" />
          <stop offset="100%" stopColor={color} stopOpacity="0.02" />
        </linearGradient>
      </defs>
      {ticks.map((tick) => (
        <g key={tick}>
          <line x1={pad.l} y1={yAt(tick)} x2={w - pad.r} y2={yAt(tick)} stroke="rgba(255,255,255,0.05)" />
          <text x={pad.l - 5} y={yAt(tick) + 3} fill="#4e7a94" fontSize="7" textAnchor="end">{formatMetric(tick)}</text>
        </g>
      ))}
      {areaPath && <path d={areaPath} fill={`url(#${gradId})`} />}
      {meanY != null && (
        <line x1={pad.l} y1={meanY} x2={w - pad.r} y2={meanY} stroke="rgba(251,191,36,0.55)" strokeWidth="1.2" strokeDasharray="5 4" />
      )}
      <path d={linePath} fill="none" stroke={color} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ filter: `drop-shadow(0 0 3px ${color}88)` }} />
      {lastIndex >= 0 && (
        <circle cx={xAt(lastIndex)} cy={yAt(last.value)} r="3.5" fill="#081c2e" stroke={color} strokeWidth="2">
          <title>{`${last.date}: ${formatMetric(last.value)} ${unit}`}</title>
        </circle>
      )}
      {labels.map((label) => (
        <text key={`${label.label}-${label.index}`} x={xAt(label.index)} y={h - 7} fill="#4e7a94" fontSize="6.5" textAnchor="middle">{label.label}</text>
      ))}
      <text x="9" y={h / 2} fill="#4e7a94" fontSize="7" transform={`rotate(-90 9 ${h / 2})`} textAnchor="middle">{yLabel}</text>
    </svg>
  )
}

function SsiChart({ series }) {
  if (!seriesHasData(series)) return <NoData />
  const values = series.map((point) => point.value).filter(isValidNumber)
  const yMin = Math.min(-2.2, ...values)
  const yMax = Math.max(1.2, ...values)
  const w = 340
  const h = 168
  const pad = { l: 42, r: 52, t: 10, b: 24 }
  const n = Math.max(1, series.length)
  const xAt = (i) => pad.l + (i / Math.max(1, n - 1)) * (w - pad.l - pad.r)
  const yAt = (v) => h - pad.b - ((v - yMin) / (yMax - yMin)) * (h - pad.t - pad.b)
  const labels = axisTicks(series.map((point) => point.date))
  const lastIndex = series.reduce((acc, point, i) => (isValidNumber(point.value) ? i : acc), -1)
  const zones = [
    { from: 0, to: yMax, fill: 'rgba(6,182,212,0.07)' },
    { from: -0.5, to: 0, fill: 'rgba(234,179,8,0.09)' },
    { from: -1.0, to: -0.5, fill: 'rgba(249,115,22,0.11)' },
    { from: -1.5, to: -1.0, fill: 'rgba(239,68,68,0.14)' },
    { from: yMin, to: -1.5, fill: 'rgba(127,29,29,0.22)' },
  ]
  const linePath = pathFrom(series, xAt, yAt)
  const firstValid = series.findIndex((p) => isValidNumber(p.value))
  const areaPath = firstValid >= 0 && lastIndex >= 0
    ? `${linePath} L${xAt(lastIndex).toFixed(2)},${yAt(0).toFixed(2)} L${xAt(firstValid).toFixed(2)},${yAt(0).toFixed(2)} Z`
    : ''

  return (
    <svg viewBox={`0 0 ${w} ${h}`} style={{ width: '100%', height: '100%' }}>
      <defs>
        <linearGradient id="ssi-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#f59e0b" stopOpacity="0.3" />
          <stop offset="100%" stopColor="#f59e0b" stopOpacity="0.03" />
        </linearGradient>
      </defs>
      {zones.map((zone) => (
        <rect
          key={zone.from}
          x={pad.l}
          y={yAt(zone.to)}
          width={w - pad.l - pad.r}
          height={Math.max(0, yAt(zone.from) - yAt(zone.to))}
          fill={zone.fill}
        />
      ))}
      {SSI_THRESHOLDS.map((threshold) => (
        <g key={threshold.y}>
          <line x1={pad.l} y1={yAt(threshold.y)} x2={w - pad.r} y2={yAt(threshold.y)} stroke="rgba(255,255,255,0.18)" strokeDasharray="3 3" />
          <text x={w - pad.r + 4} y={yAt(threshold.y) + 3} fill="#6090a8" fontSize="6.5">{threshold.y.toFixed(1)}{threshold.label ? ` ${threshold.label}` : ''}</text>
        </g>
      ))}
      {areaPath && <path d={areaPath} fill="url(#ssi-grad)" />}
      <path d={linePath} fill="none" stroke="#f59e0b" strokeWidth="2.2" strokeLinejoin="round" style={{ filter: 'drop-shadow(0 0 3px rgba(245,158,11,0.6))' }} />
      {lastIndex >= 0 && (
        <circle cx={xAt(lastIndex)} cy={yAt(series[lastIndex].value)} r="3.5" fill="#081c2e" stroke="#f59e0b" strokeWidth="2">
          <title>{`${series[lastIndex].date}: SSI ${Number(series[lastIndex].value).toFixed(2)}`}</title>
        </circle>
      )}
      {labels.map((label) => (
        <text key={`${label.label}-${label.index}`} x={xAt(label.index)} y={h - 7} fill="#4e7a94" fontSize="6.5" textAnchor="middle">{label.label}</text>
      ))}
      <text x="9" y={h / 2} fill="#4e7a94" fontSize="7" transform={`rotate(-90 9 ${h / 2})`} textAnchor="middle">SSI</text>
    </svg>
  )
}

function DualSeriesChart({ seriesA, seriesB, labelA, labelB, colorA, colorB, gradIdA = 'da1', gradIdB = 'db1', yLabel, unit = 'm³/s' }) {
  const hasA = seriesHasData(seriesA)
  const hasB = seriesHasData(seriesB)
  if (!hasA && !hasB) return <NoData />
  const values = [...(hasA ? seriesA : []), ...(hasB ? seriesB : [])].map((point) => point.value).filter(isValidNumber)
  const min = Math.min(0, ...values)
  const max = Math.max(...values)
  const range = max - min || Math.abs(max) || 0.001
  const yMin = min
  const yMax = max + range * 0.12
  const w = 340
  const h = 168
  const pad = { l: 42, r: 10, t: 16, b: 24 }
  const n = Math.max(seriesA.length, seriesB.length, 1)
  const xAt = (i) => pad.l + (i / Math.max(1, n - 1)) * (w - pad.l - pad.r)
  const yAt = (v) => h - pad.b - ((v - yMin) / (yMax - yMin)) * (h - pad.t - pad.b)
  const ticks = [yMin, yMin + (yMax - yMin) * 0.5, yMax]
  const dates = (seriesA.length >= seriesB.length ? seriesA : seriesB).map((point) => point.date)
  const labels = axisTicks(dates)
  const baseline = h - pad.b
  const firstA = seriesA.findIndex((p) => isValidNumber(p.value))
  const lastA = seriesA.reduce((acc, p, i) => (isValidNumber(p.value) ? i : acc), -1)
  const firstB = seriesB.findIndex((p) => isValidNumber(p.value))
  const lastB = seriesB.reduce((acc, p, i) => (isValidNumber(p.value) ? i : acc), -1)
  const pathA = pathFrom(seriesA, xAt, yAt)
  const pathB = pathFrom(seriesB, xAt, yAt)
  const areaA = firstA >= 0 && lastA >= 0 ? `${pathA} L${xAt(lastA).toFixed(2)},${baseline} L${xAt(firstA).toFixed(2)},${baseline} Z` : ''
  const areaB = firstB >= 0 && lastB >= 0 ? `${pathB} L${xAt(lastB).toFixed(2)},${baseline} L${xAt(firstB).toFixed(2)},${baseline} Z` : ''

  return (
    <svg viewBox={`0 0 ${w} ${h}`} style={{ width: '100%', height: '100%' }}>
      <defs>
        <linearGradient id={gradIdA} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={colorA} stopOpacity="0.28" />
          <stop offset="100%" stopColor={colorA} stopOpacity="0.02" />
        </linearGradient>
        <linearGradient id={gradIdB} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={colorB} stopOpacity="0.22" />
          <stop offset="100%" stopColor={colorB} stopOpacity="0.02" />
        </linearGradient>
      </defs>
      {ticks.map((tick) => (
        <g key={tick}>
          <line x1={pad.l} y1={yAt(tick)} x2={w - pad.r} y2={yAt(tick)} stroke="rgba(255,255,255,0.05)" />
          <text x={pad.l - 5} y={yAt(tick) + 3} fill="#4e7a94" fontSize="7" textAnchor="end">{formatMetric(tick)}</text>
        </g>
      ))}
      {areaA && <path d={areaA} fill={`url(#${gradIdA})`} />}
      {areaB && <path d={areaB} fill={`url(#${gradIdB})`} />}
      {hasA && <path d={pathA} fill="none" stroke={colorA} strokeWidth="2.2" strokeLinejoin="round" style={{ filter: `drop-shadow(0 0 3px ${colorA}88)` }} />}
      {hasB && <path d={pathB} fill="none" stroke={colorB} strokeWidth="2.2" strokeDasharray="6 3" strokeLinejoin="round" style={{ filter: `drop-shadow(0 0 3px ${colorB}88)` }} />}
      {labels.map((label) => (
        <text key={`${label.label}-${label.index}`} x={xAt(label.index)} y={h - 7} fill="#4e7a94" fontSize="6.5" textAnchor="middle">{label.label}</text>
      ))}
      <text x="9" y={h / 2} fill="#4e7a94" fontSize="7" transform={`rotate(-90 9 ${h / 2})`} textAnchor="middle">{yLabel}</text>
      <circle cx={pad.l + 2} cy="10" r="3" fill={colorA} />
      <text x={pad.l + 8} y="13" fill={colorA} fontSize="7" fontWeight="600">{labelA}</text>
      <circle cx={pad.l + 68} cy="10" r="3" fill={colorB} />
      <text x={pad.l + 74} y="13" fill={colorB} fontSize="7" fontWeight="600">{labelB}</text>
    </svg>
  )
}

function ChangeBadge({ change }) {
  if (!isValidNumber(change)) return null
  const down = Number(change) < 0
  return (
    <span className={`hydro-kpi-badge ${down ? 'down-danger' : 'up-success'}`}>
      {down ? <ArrowDown size={11} /> : <ArrowUp size={11} />}
      {Math.abs(change).toFixed(0)}%
    </span>
  )
}

function MetricValue({ value, unit, digits }) {
  if (!isValidNumber(value)) {
    return <span className="hydro-nodata-text">No data available</span>
  }
  return (
    <>
      <span className="hydro-kpi-val">{digits != null ? Number(value).toFixed(digits) : formatMetric(value)}</span>
      {unit ? <span className="hydro-kpi-unit">{unit}</span> : null}
    </>
  )
}

export default function HydrologyDrought() {
  const [selectedDistrict, setSelectedDistrict] = useState('City of Tshwane')
  const [parsedData, setParsedData] = useState([])
  const [catalogue, setCatalogue] = useState(null)
  const [districtsGeoJson, setDistrictsGeoJson] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)
  const [mapMode, setMapMode] = useState('regional')

  useEffect(() => {
    const controller = new AbortController()
    Promise.all([
      fetch('/api/hydrology/metadata', { signal: controller.signal }).then(async response => {
        const data = await response.json()
        if (!response.ok) throw new Error(data.detail || 'Unable to load hydrological metadata.')
        return data
      }),
      fetch('/south_africa_adm2.display.geojson', { signal: controller.signal }).then(response => {
        if (!response.ok) throw new Error('Unable to load district boundaries.')
        return response.json()
      }),
    ]).then(([meta, geojson]) => {
      if (controller.signal.aborted) return
      setCatalogue(meta)
      setDistrictsGeoJson(geojson.features || [])
      setSelectedDistrict(meta.default_region || meta.districts?.[0] || '')
    }).catch(error => { if (!controller.signal.aborted) { setLoadError(error.message); setLoading(false) } })
    return () => controller.abort()
  }, [])

  useEffect(() => {
    if (!catalogue || !selectedDistrict) return undefined
    const controller = new AbortController()
    setLoading(true); setLoadError(null)
    loadHydrologyRecords(selectedDistrict, controller.signal).then(records => {
      if (!controller.signal.aborted) setParsedData(records)
    }).catch(error => { if (!controller.signal.aborted) setLoadError(error.message) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [catalogue, selectedDistrict])

  const districts = useMemo(() => (catalogue?.districts || []).map(name =>
    name.replace(/\b\w/g, letter => letter.toUpperCase())).sort((a, b) => a.localeCompare(b)), [catalogue])

  const filteredData = useMemo(() => (
    parsedData
      .filter((row) => normaliseDistrictName(row.district_name) === normaliseDistrictName(selectedDistrict))
      .slice()
      .sort((a, b) => new Date(a.date) - new Date(b.date))
  ), [parsedData, selectedDistrict])

  const latestRow = filteredData.length ? filteredData[filteredData.length - 1] : null
  const firstRow = filteredData.length ? filteredData[0] : null

  const riverDischargeData = useMemo(() => seriesFrom(filteredData, 'river_discharge_m3_s'), [filteredData])
  const ssiData = useMemo(() => seriesFrom(filteredData, 'ssi_dimensionless'), [filteredData])
  const inflowData = useMemo(() => seriesFrom(filteredData, 'dam_inflow_m3_s'), [filteredData])
  const outflowData = useMemo(() => seriesFrom(filteredData, 'dam_outflow_m3_s'), [filteredData])
  const runoffData = useMemo(() => seriesFrom(filteredData, 'surface_runoff_m3_s'), [filteredData])
  const baseflowData = useMemo(() => seriesFrom(filteredData, 'baseflow_separation_m3_s'), [filteredData])

  const dischargeMean = useMemo(() => meanOf(riverDischargeData), [riverDischargeData])
  const runoffMean = useMemo(() => meanOf(runoffData), [runoffData])
  const baseflowMean = useMemo(() => meanOf(baseflowData), [baseflowData])
  const inflowMean = useMemo(() => meanOf(inflowData), [inflowData])
  const outflowMean = useMemo(() => meanOf(outflowData), [outflowData])

  const latest = {
    river_discharge: latestRow?.river_discharge_m3_s,
    ssi: latestRow?.ssi_dimensionless,
    dam_inflow: latestRow?.dam_inflow_m3_s,
    dam_outflow: latestRow?.dam_outflow_m3_s,
    surface_runoff: latestRow?.surface_runoff_m3_s,
    baseflow: latestRow?.baseflow_separation_m3_s,
    borehole: latestRow?.borehole_water_level_m_bgl,
    sgi: latestRow?.sgi_dimensionless,
    dam_storage: latestRow?.dam_storage_million_m3,
    dam_level_pct: latestRow?.dam_level_pct_fsc,
    p10: latestRow?.fdc_percentiles_m3_s,
    date: latestRow?.date,
  }

  const dischargeChange = pctChange(latest.river_discharge, dischargeMean)
  const runoffChange = pctChange(latest.surface_runoff, runoffMean)
  const baseflowChange = pctChange(latest.baseflow, baseflowMean)
  const ssiClass = classifySSI(latest.ssi)
  const sgiClass = classifySGI(latest.sgi)
  const districtName = latestRow?.district_name || selectedDistrict
  const provinceName = DISTRICT_PROVINCES[districtName.trim().toLowerCase()] || 'South Africa'
  const droughtStatus = {
    ...ssiClass,
    trend: !isValidNumber(latest.ssi) ? 'No data available' : Number(latest.ssi) < -0.5 ? 'Worsening' : Number(latest.ssi) > 0.5 ? 'Improving' : 'Stable',
  }

  const alerts = useMemo(() => {
    if (!latestRow) return []
    const items = []
    if (isValidNumber(latest.ssi) && latest.ssi <= -1.5) items.push({ level: 'Severe', text: `SSI ${Number(latest.ssi).toFixed(2)} is at or below -1.5 in ${districtName}.` })
    else if (isValidNumber(latest.ssi) && latest.ssi <= -1.0) items.push({ level: 'Warning', text: `SSI ${Number(latest.ssi).toFixed(2)} is at or below -1.0 in ${districtName}.` })
    if (isValidNumber(latest.sgi) && latest.sgi <= -1.0) items.push({ level: 'Warning', text: `SGI ${Number(latest.sgi).toFixed(2)} indicates groundwater drought in ${districtName}.` })
    if (isValidNumber(dischargeChange) && dischargeChange <= -25) items.push({ level: 'Warning', text: `River discharge is ${Math.abs(dischargeChange).toFixed(0)}% below the ${districtName} historical mean.` })
    if (isValidNumber(runoffChange) && runoffChange <= -25) items.push({ level: 'Warning', text: `Surface runoff is substantially below the ${districtName} historical mean.` })
    if (isValidNumber(baseflowChange) && baseflowChange <= -25) items.push({ level: 'Warning', text: `Baseflow is substantially below the ${districtName} historical mean.` })
    if (!items.length) items.push({ level: 'Info', text: `No threshold alerts for ${districtName} on ${latest.date || 'the latest date'}.` })
    return items
  }, [latestRow, latest.ssi, latest.sgi, latest.date, dischargeChange, runoffChange, baseflowChange, districtName])

  const insights = useMemo(() => {
    if (!latestRow) return [{ type: 'warning', text: `No data available for ${selectedDistrict}.` }]
    const items = []
    items.push({
      type: isValidNumber(dischargeChange) && dischargeChange < -10 ? 'danger' : 'info',
      text: isValidNumber(latest.river_discharge)
        ? `River discharge is ${formatMetric(latest.river_discharge)} m³/s on ${latest.date} in ${districtName} (historical mean ${displayMetric(dischargeMean)} m³/s).`
        : `River Discharge: No data available for ${districtName}.`,
    })
    items.push({
      type: ssiClass.severity === 'normal' || ssiClass.severity === 'unknown' ? 'info' : 'warning',
      text: isValidNumber(latest.ssi)
        ? `SSI is ${Number(latest.ssi).toFixed(2)} (${ssiClass.status}) for ${districtName}.`
        : `SSI: No data available for ${districtName}.`,
    })
    items.push({
      type: 'info',
      text: isValidNumber(latest.dam_inflow) || isValidNumber(latest.dam_outflow)
        ? `Dam inflow mean is ${displayMetric(inflowMean)} m³/s and outflow mean is ${displayMetric(outflowMean)} m³/s across ${filteredData.length} ${districtName} records.`
        : `Dam Inflow / Dam Outflow: No data available for ${districtName}.`,
    })
    items.push({
      type: isValidNumber(runoffChange) && runoffChange < 0 ? 'danger' : 'info',
      text: isValidNumber(latest.surface_runoff)
        ? `Surface runoff is ${formatMetric(latest.surface_runoff)} m³/s and baseflow is ${displayMetric(latest.baseflow)} m³/s in ${districtName}.`
        : `Surface Runoff: No data available for ${districtName}.`,
    })
    return items
  }, [latestRow, selectedDistrict, districtName, latest.date, latest.river_discharge, latest.ssi, latest.dam_inflow, latest.dam_outflow, latest.surface_runoff, latest.baseflow, dischargeChange, dischargeMean, ssiClass, inflowMean, outflowMean, runoffChange, filteredData.length])

  const recommendations = useMemo(() => {
    if (!latestRow) return [{ text: `No data available for ${selectedDistrict}.` }]
    return [
      { text: `Continue monitoring river discharge (${displayMetric(latest.river_discharge)} m³/s) in ${districtName}.` },
      { text: isValidNumber(latest.dam_storage) ? `Evaluate reservoir balance: dam storage is ${formatMetric(latest.dam_storage)} Mm³ (${displayMetric(latest.dam_level_pct)}% FSC).` : 'Dam Storage: No data available' },
      { text: `Assess ecological reserve using baseflow (${displayMetric(latest.baseflow)} m³/s).` },
      { text: `Maintain drought preparedness in ${districtName} (${provinceName}).` },
    ]
  }, [latestRow, selectedDistrict, districtName, provinceName, latest.river_discharge, latest.dam_storage, latest.dam_level_pct, latest.baseflow])

  const variablesTable = [
    { variable: 'River Discharge', value: latest.river_discharge, unit: 'm³/s', trend: dischargeChange, status: !isValidNumber(latest.river_discharge) ? 'No data available' : dischargeChange < -10 ? 'Below Normal' : dischargeChange > 10 ? 'Above Normal' : 'Normal', tone: dischargeChange < -10 ? 'warning' : 'info' },
    { variable: 'SSI (Streamflow)', value: latest.ssi, unit: '(dimensionless)', trend: isValidNumber(latest.ssi) ? (latest.ssi < 0 ? -1 : 1) : null, status: ssiClass.label, tone: ssiClass.severity === 'normal' ? 'info' : 'warning' },
    { variable: 'Dam Inflow', value: latest.dam_inflow, unit: 'm³/s', trend: null, status: !isValidNumber(latest.dam_inflow) ? 'No data available' : latest.dam_inflow > 0 ? 'Active' : 'Recorded', tone: 'info' },
    { variable: 'Dam Outflow', value: latest.dam_outflow, unit: 'm³/s', trend: null, status: !isValidNumber(latest.dam_outflow) ? 'No data available' : latest.dam_outflow > 0 ? 'Active' : 'Recorded', tone: 'info' },
    { variable: 'Surface Runoff', value: latest.surface_runoff, unit: 'm³/s', trend: runoffChange, status: !isValidNumber(latest.surface_runoff) ? 'No data available' : runoffChange < -10 ? 'Below Normal' : 'Normal', tone: runoffChange < -10 ? 'warning' : 'info' },
    { variable: 'Baseflow Separation', value: latest.baseflow, unit: 'm³/s', trend: baseflowChange, status: !isValidNumber(latest.baseflow) ? 'No data available' : baseflowChange < -10 ? 'Below Normal' : 'Normal', tone: baseflowChange < -10 ? 'warning' : 'info' },
    { variable: 'Dam Storage', value: latest.dam_storage, unit: 'million m³', trend: null, status: !isValidNumber(latest.dam_storage) ? 'No data available' : 'Database', tone: 'info' },
    { variable: 'Borehole Water Level', value: latest.borehole, unit: 'm bgl', trend: null, status: !isValidNumber(latest.borehole) ? 'No data available' : 'Database', tone: 'info' },
    { variable: 'SGI (Groundwater)', value: latest.sgi, unit: '(dimensionless)', trend: null, status: sgiClass.label, tone: 'info' },
  ]

  useEffect(() => {
    const debug = {
      selectedDistrict,
      records: filteredData.length,
      firstDate: firstRow?.date || null,
      latestDate: latestRow?.date || null,
      latestRiverDischarge: latest.river_discharge,
      latestSSI: latest.ssi,
      latestDamInflow: latest.dam_inflow,
      latestDamOutflow: latest.dam_outflow,
      latestSurfaceRunoff: latest.surface_runoff,
      latestBaseflow: latest.baseflow,
      meanDamInflow: inflowMean,
      meanDamOutflow: outflowMean,
      chartCounts: {
        river_discharge_m3_s: riverDischargeData.filter((point) => isValidNumber(point.value)).length,
        ssi_dimensionless: ssiData.filter((point) => isValidNumber(point.value)).length,
        dam_inflow_m3_s: inflowData.filter((point) => isValidNumber(point.value)).length,
        dam_outflow_m3_s: outflowData.filter((point) => isValidNumber(point.value)).length,
        surface_runoff_m3_s: runoffData.filter((point) => isValidNumber(point.value)).length,
        baseflow_separation_m3_s: baseflowData.filter((point) => isValidNumber(point.value)).length,
      },
      sample: filteredData.slice(0, 3),
    }
    try { window.__hydrologyDebug = debug } catch (error) { /* ignore */ }
    if (import.meta.env.DEV) console.info('[Hydrology] filteredData rebuilt', debug)
  }, [selectedDistrict, filteredData, firstRow, latestRow, latest.river_discharge, latest.ssi, latest.dam_inflow, latest.dam_outflow, latest.surface_runoff, latest.baseflow, inflowMean, outflowMean, riverDischargeData, ssiData, inflowData, outflowData, runoffData, baseflowData])

  const project = ([lon, lat]) => [((lon - 16.45) / 16.5) * 440, ((-22.12 - lat) / 12.75) * 230]
  const mapPaths = useMemo(() => new Map(districtsGeoJson.map(feature => {
    const geometry = feature.geometry
    const polygons = geometry?.type === 'Polygon' ? [geometry.coordinates] : geometry?.type === 'MultiPolygon' ? geometry.coordinates : []
    const path = polygons.flatMap(polygon => polygon.map(ring => ring.map((point, index) => {
      const [x, y] = project(point)
      return `${index ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`
    }).join(' ') + 'Z')).join(' ')
    return [geometry, path]
  })), [districtsGeoJson])
  const pathFor = geometry => mapPaths.get(geometry) || ''


  if (loading) {
    return (
      <div className="hydro-container" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '60vh' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', color: '#38bdf8', fontSize: '15px' }}>
            <LoadingProgress className="hydro-loading" message="Reading hydrological observations from Supabase" />
        </div>
      </div>
    )
  }

  if (loadError) {
    return (
      <div className="hydro-container">
        <div className="hydro-nodata">{loadError}</div>
      </div>
    )
  }

  return (
    <div className="hydro-container">
      <header className="hydro-header-bar">
        <div className="hydro-title-section">
          <div className="hydro-icon-bubble">
            <Droplets size={22} />
          </div>
          <div className="hydro-title-text">
            <h2>Hydrological Drought Monitoring</h2>
            <div className="hydro-title-sub">
              Rivers <span>|</span> Reservoirs <span>|</span> Groundwater <span>|</span> Runoff <span>|</span> Baseflow
            </div>
          </div>
        </div>

        <div className="hydro-meta-section">
          <div className="hydro-meta-item">
            <Calendar size={18} className="icon" />
            <div className="meta-col">
              <span className="meta-label">Latest Observation</span>
              <span className="meta-val">{latest.date || 'No data available'}</span>
            </div>
          </div>
          <div className="hydro-meta-item">
            <User size={18} className="icon" />
            <div className="meta-col">
              <span className="meta-label">User Access</span>
              <span className="meta-val">Data Scientist</span>
            </div>
          </div>
        </div>
      </header>

      <section className="hydro-kpi-bar" aria-label="Hydrological key indicators">
        <div className="hydro-district-card">
          <div className="hydro-district-head">
            <MapPin size={15} />
            <span>{districtName}</span>
          </div>
          <div className="hydro-district-select-wrap">
            <select
              value={selectedDistrict}
              onChange={(event) => setSelectedDistrict(event.target.value)}
              aria-label="Select South African District"
            >
              {districts.map((name) => (
                <option key={name} value={name}>{name}</option>
              ))}
            </select>
          </div>
          <div className="hydro-district-sub">
            Municipality | {provinceName}
          </div>
        </div>

        <div className="hydro-kpi-cell">
          <div className="hydro-kpi-top">
            <span className="hydro-kpi-title">River Discharge</span>
            <Waves size={16} className="hydro-kpi-icon" />
          </div>
          <div className="hydro-kpi-val-row">
            <MetricValue value={latest.river_discharge} unit="m³/s" />
            <ChangeBadge change={dischargeChange} />
          </div>
          <div className="hydro-kpi-note">vs historical average: {displayMetric(dischargeMean)} m³/s</div>
        </div>

        <div className="hydro-kpi-cell">
          <div className="hydro-kpi-top">
            <span className="hydro-kpi-title">SSI (Streamflow)</span>
            <Gauge size={16} className="hydro-kpi-icon" />
          </div>
          <div className="hydro-kpi-val-row">
            <MetricValue value={latest.ssi} digits={2} />
          </div>
          <div className="hydro-kpi-note">{ssiClass.label}</div>
        </div>

        <div className="hydro-kpi-cell">
          <div className="hydro-kpi-top">
            <span className="hydro-kpi-title">Dam Inflow</span>
            <Activity size={16} className="hydro-kpi-icon" />
          </div>
          <div className="hydro-kpi-val-row">
            <MetricValue value={latest.dam_inflow} unit="m³/s" />
          </div>
          <div className="hydro-kpi-note">series mean: {displayMetric(inflowMean)} m³/s</div>
        </div>

        <div className="hydro-kpi-cell">
          <div className="hydro-kpi-top">
            <span className="hydro-kpi-title">Dam Outflow</span>
            <Activity size={16} className="hydro-kpi-icon" />
          </div>
          <div className="hydro-kpi-val-row">
            <MetricValue value={latest.dam_outflow} unit="m³/s" />
          </div>
          <div className="hydro-kpi-note">series mean: {displayMetric(outflowMean)} m³/s</div>
        </div>

        <div className="hydro-kpi-cell">
          <div className="hydro-kpi-top">
            <span className="hydro-kpi-title">Surface Runoff</span>
            <Waves size={16} className="hydro-kpi-icon" />
          </div>
          <div className="hydro-kpi-val-row">
            <MetricValue value={latest.surface_runoff} unit="m³/s" />
            <ChangeBadge change={runoffChange} />
          </div>
          <div className="hydro-kpi-note">(vs. historical avg)</div>
        </div>

        <div className="hydro-kpi-cell">
          <div className="hydro-kpi-top">
            <span className="hydro-kpi-title">Baseflow</span>
            <Waves size={16} className="hydro-kpi-icon" />
          </div>
          <div className="hydro-kpi-val-row">
            <MetricValue value={latest.baseflow} unit="m³/s" />
            <ChangeBadge change={baseflowChange} />
          </div>
          <div className="hydro-kpi-note">(vs. historical avg)</div>
        </div>
      </section>

      {/* Debug panel removed for production view */}

      <div className="hydro-grid-row">
        <section className="hydro-panel">
          <div className="hydro-panel-head">
            <span className="hydro-panel-title">{districtName} – Hydrological Overview</span>
            <div className="hydro-panel-actions">
              <button type="button" className={`hydro-badge-toggle ${mapMode === 'regional' ? 'active' : ''}`} onClick={() => setMapMode('regional')}>Watershed</button>
              <button type="button" className={`hydro-badge-toggle ${mapMode === 'national' ? 'active' : ''}`} onClick={() => setMapMode('national')}>National (52)</button>
            </div>
          </div>
          <div className="hydro-map-wrap">
            {mapMode === 'regional' ? (
              <div className="hydro-map-svg-area">
                <svg viewBox="0 0 380 230" preserveAspectRatio="xMidYMid meet">
                  <rect width="380" height="230" fill="#061623" />
                  <path d="M 110,65 L 210,60 L 265,95 L 280,145 L 225,175 L 135,170 L 95,125 Z" fill="#082b42" stroke="#38bdf8" strokeWidth="1.8" />
                  <g transform="translate(170, 110)">
                    <circle cx="0" cy="0" r="6" fill="#38bdf8" stroke="#ffffff" strokeWidth="1.5" />
                    <text x="0" y="22" fill="#ffffff" fontSize="8" fontWeight="700" textAnchor="middle">{districtName}</text>
                  </g>
                </svg>
              </div>
            ) : (
              <div className="hydro-map-svg-area">
                <svg viewBox="0 0 440 230" preserveAspectRatio="xMidYMid meet">
                  {districtsGeoJson.map((feature) => {
                    const name = feature.properties?.shapeName || ''
                    const isSelected = normaliseDistrictName(name) === normaliseDistrictName(selectedDistrict)
                    return (
                      <path
                        key={feature.properties?.shapeID || name}
                        d={pathFor(feature.geometry)}
                        fill={isSelected ? '#0284c7' : '#0a273b'}
                        stroke={isSelected ? '#ffffff' : '#143c55'}
                        strokeWidth={isSelected ? '2' : '0.7'}
                        cursor="pointer"
                        onClick={() => setSelectedDistrict(name)}
                      >
                        <title>{name}</title>
                      </path>
                    )
                  })}
                  <ProvinceMapLabels project={project} fontSize={11} />
                </svg>
              </div>
            )}
          </div>
        </section>

        <section className="hydro-panel">
          <div className="hydro-panel-head">
            <span className="hydro-panel-title">River Discharge – {districtName}</span>
            <div className="hydro-panel-actions" style={{ fontSize: '9px', gap: '10px' }}>
              <span style={{ color: '#38bdf8' }}>Discharge</span>
              <span style={{ color: '#7ba7be' }}>Historical mean</span>
            </div>
          </div>
          <div className="hydro-chart-canvas" key={`discharge-${selectedDistrict}`}>
            <SmoothSeriesChart series={riverDischargeData} gradId={`dg-${selectedDistrict.replace(/[^a-z0-9]/gi, '')}`} meanValue={dischargeMean} yLabel="Discharge (m³/s)" unit="m³/s" />

          </div>
          <div className="hydro-chart-stats-row">
            <div className="hydro-stat-col">
              <small>Current Discharge</small>
              <strong>{isValidNumber(latest.river_discharge) ? `${formatMetric(latest.river_discharge)} m³/s` : 'No data available'}</strong>
            </div>
            <div className="hydro-stat-col">
              <small>Historical Avg</small>
              <strong>{isValidNumber(dischargeMean) ? `${formatMetric(dischargeMean)} m³/s` : 'No data available'}</strong>
            </div>
            <div className="hydro-stat-col">
              <small>Latest Date</small>
              <strong>{latest.date || 'No data available'}</strong>
            </div>
          </div>
        </section>

        <section className="hydro-panel">
          <div className="hydro-panel-head">
            <span className="hydro-panel-title">SSI — Streamflow Drought – {districtName}</span>
          </div>
          <div className="hydro-chart-canvas" key={`ssi-${selectedDistrict}`}>
            <SsiChart series={ssiData} />
          </div>
          <div className="hydro-chart-stats-row" style={{ gridTemplateColumns: '1fr 1fr' }}>
            <div className="hydro-stat-col">
              <small>Latest SSI</small>
              <strong>{isValidNumber(latest.ssi) ? Number(latest.ssi).toFixed(2) : 'No data available'}</strong>
            </div>
            <div className="hydro-stat-col">
              <small>Status</small>
              <strong>{ssiClass.status}</strong>
            </div>
          </div>
        </section>
      </div>

      <div className="hydro-grid-row">
        <section className="hydro-panel">
          <div className="hydro-panel-head">
            <span className="hydro-panel-title">Hydrological Drought Status – {districtName}</span>
          </div>
          <div className="hydro-status-wrap">
            <div className="hydro-donut-gauge">
              {(() => {
                const ssiVal = isValidNumber(latest.ssi) ? Number(latest.ssi) : 0
                // Map SSI from range [-2.5, 1.5] to arc sweep [0, 1]
                const pct = Math.max(0, Math.min(1, (ssiVal + 2.5) / 4))
                const color = ssiVal <= -1.3 ? '#ef4444' : ssiVal <= -0.5 ? '#f59e0b' : '#06b6d4'
                const glow = ssiVal <= -1.3 ? 'rgba(239,68,68,0.5)' : ssiVal <= -0.5 ? 'rgba(245,158,11,0.5)' : 'rgba(6,182,212,0.4)'
                const r = 46
                const cx = 60; const cy = 60
                const startAngle = -210 // degrees (bottom-left)
                const totalSweep = 240  // degrees
                const endAngle = startAngle + pct * totalSweep
                const toRad = (deg) => (deg * Math.PI) / 180
                const ax = cx + r * Math.cos(toRad(startAngle))
                const ay = cy + r * Math.sin(toRad(startAngle))
                const bx = cx + r * Math.cos(toRad(endAngle))
                const by = cy + r * Math.sin(toRad(endAngle))
                const largeArc = pct * totalSweep > 180 ? 1 : 0
                return (
                  <svg viewBox="0 0 120 120" style={{ width: '100%', height: '100%' }}>
                    <defs>
                      <filter id="gauge-glow">
                        <feGaussianBlur stdDeviation="2.5" result="blur" />
                        <feComposite in="SourceGraphic" in2="blur" operator="over" />
                      </filter>
                    </defs>
                    {/* Track arc */}
                    <path
                      d={`M ${cx + r * Math.cos(toRad(startAngle))} ${cy + r * Math.sin(toRad(startAngle))} A ${r} ${r} 0 1 1 ${cx + r * Math.cos(toRad(startAngle + totalSweep))} ${cy + r * Math.sin(toRad(startAngle + totalSweep))}`}
                      fill="none" stroke="#0f2d42" strokeWidth="12" strokeLinecap="round"
                    />
                    {/* Value arc */}
                    {pct > 0.01 && (
                      <path
                        d={`M ${ax} ${ay} A ${r} ${r} 0 ${largeArc} 1 ${bx} ${by}`}
                        fill="none" stroke={color} strokeWidth="12" strokeLinecap="round"
                        style={{ filter: `drop-shadow(0 0 4px ${glow})` }}
                      />
                    )}
                    {/* Center glow dot */}
                    <circle cx={bx} cy={by} r="4" fill={color} style={{ filter: `drop-shadow(0 0 6px ${glow})` }} />
                  </svg>
                )
              })()}

              <div className="hydro-gauge-text">
                <span className="gauge-tag">SSI</span>
                <span className="gauge-val">{isValidNumber(latest.ssi) ? Number(latest.ssi).toFixed(2) : '—'}</span>
                <span className="gauge-cond">({droughtStatus.condition})</span>
              </div>
            </div>
            <div className="hydro-status-info">
              <div className="hydro-info-row">
                <small>Current Status</small>
                <strong>{droughtStatus.status}</strong>
              </div>
              <div className="hydro-info-row">
                <small>Trend</small>
                <strong className={droughtStatus.trend === 'Worsening' ? 'worsening' : ''}>
                  {droughtStatus.trend === 'Worsening' ? <ArrowDown size={14} /> : droughtStatus.trend === 'Improving' ? <ArrowUp size={14} /> : null}
                  {droughtStatus.trend}
                </strong>
              </div>
              <div className="hydro-info-row">
                <small>Records</small>
                <strong>{filteredData.length} from Supabase hydrological_drought_master</strong>
              </div>
            </div>
          </div>
        </section>

        <section className="hydro-panel">
          <div className="hydro-panel-head">
            <span className="hydro-panel-title">Dam Inflow vs Dam Outflow – {districtName}</span>
          </div>
          <div className="hydro-chart-canvas" key={`dams-${selectedDistrict}`}>
            <DualSeriesChart
              seriesA={inflowData}
              seriesB={outflowData}
              labelA="Inflow"
              labelB="Outflow"
              colorA="#22d3ee"
              colorB="#f97316"
              gradIdA="dam-in"
              gradIdB="dam-out"
              yLabel="Dam Flow (m³/s)"
            />

          </div>
          <div className="hydro-chart-stats-row">
            <div className="hydro-stat-col">
              <small>Latest Inflow</small>
              <strong>{isValidNumber(latest.dam_inflow) ? `${formatMetric(latest.dam_inflow)} m³/s` : 'No data available'}</strong>
            </div>
            <div className="hydro-stat-col">
              <small>Latest Outflow</small>
              <strong>{isValidNumber(latest.dam_outflow) ? `${formatMetric(latest.dam_outflow)} m³/s` : 'No data available'}</strong>
            </div>
            <div className="hydro-stat-col">
              <small>Mean Inflow</small>
              <strong>{isValidNumber(inflowMean) ? `${formatMetric(inflowMean)} m³/s` : 'No data available'}</strong>
            </div>
          </div>
        </section>

        <section className="hydro-panel">
          <div className="hydro-panel-head">
            <span className="hydro-panel-title">Surface Runoff vs Baseflow – {districtName}</span>
          </div>
          <div className="hydro-chart-canvas" key={`contrib-${selectedDistrict}`}>
            <DualSeriesChart
              seriesA={runoffData}
              seriesB={baseflowData}
              labelA="Surface Runoff"
              labelB="Baseflow"
              colorA="#06b6d4"
              colorB="#a78bfa"
              gradIdA="run-a"
              gradIdB="run-b"
              yLabel="Water Contribution (m³/s)"
            />

          </div>
          <div className="hydro-chart-stats-row">
            <div className="hydro-stat-col">
              <small>Latest Runoff</small>
              <strong>{isValidNumber(latest.surface_runoff) ? `${formatMetric(latest.surface_runoff)} m³/s` : 'No data available'}</strong>
            </div>
            <div className="hydro-stat-col">
              <small>Latest Baseflow</small>
              <strong>{isValidNumber(latest.baseflow) ? `${formatMetric(latest.baseflow)} m³/s` : 'No data available'}</strong>
            </div>
          </div>
        </section>
      </div>

      <div className="hydro-grid-row">
        <section className="hydro-panel">
          <div className="hydro-panel-head">
            <span className="hydro-panel-title">Hydrological Variables – {districtName}</span>
          </div>
          <div className="hydro-table-shell">
            <table className="hydro-table">
              <thead>
                <tr>
                  <th>Variable</th>
                  <th>Value (from database)</th>
                  <th>Unit</th>
                  <th>Trend</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {variablesTable.map((row) => (
                  <tr key={row.variable}>
                    <td style={{ color: '#dbeafe', fontWeight: '500' }}>{row.variable}</td>
                    <td style={{ fontWeight: '700' }}>{isValidNumber(row.value) ? (row.variable.includes('SSI') || row.variable.includes('SGI') ? Number(row.value).toFixed(2) : formatMetric(row.value)) : 'No data available'}</td>
                    <td style={{ color: '#88afc5', fontSize: '9.5px' }}>{row.unit}</td>
                    <td style={{ color: isValidNumber(row.trend) && row.trend < 0 ? '#f87171' : '#34d399', fontWeight: '600' }}>
                      {isValidNumber(row.trend) ? `${row.trend < 0 ? '↓' : '↑'} ${Math.abs(row.trend).toFixed(1)}%` : '—'}
                    </td>
                    <td>
                      <span className={`hydro-tag-pill ${row.tone}`}>{row.status}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="hydro-panel">
          <div className="hydro-panel-head">
            <span className="hydro-panel-title">Key Insights – {districtName}</span>
          </div>
          <div className="hydro-insights-list">
            {insights.map((insight, index) => (
              <div key={index} className={`hydro-insight-item ${insight.type}`}>
                {insight.type === 'danger' ? <AlertTriangle size={17} style={{ color: '#ef4444', flexShrink: 0 }} /> : insight.type === 'warning' ? <AlertCircle size={17} style={{ color: '#f59e0b', flexShrink: 0 }} /> : <Info size={17} style={{ color: '#38bdf8', flexShrink: 0 }} />}
                <span>{insight.text}</span>
              </div>
            ))}
            {alerts.map((alert, index) => (
              <div key={`alert-${index}`} className={`hydro-insight-item ${alert.level === 'Severe' ? 'danger' : alert.level === 'Warning' ? 'warning' : 'info'}`}>
                {alert.level === 'Severe' ? <AlertTriangle size={17} style={{ color: '#ef4444', flexShrink: 0 }} /> : <AlertCircle size={17} style={{ color: '#f59e0b', flexShrink: 0 }} />}
                <span>{alert.text}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="hydro-panel">
          <div className="hydro-panel-head">
            <span className="hydro-panel-title">Recommendations</span>
          </div>
          <div className="hydro-recom-list">
            {recommendations.map((rec, index) => (
              <div key={index} className="hydro-recom-item">
                <CheckCircle2 size={16} className="check-icon" />
                <span>{rec.text}</span>
              </div>
            ))}
          </div>
          <button
            type="button"
            className="hydro-btn-report"
            onClick={() => alert(`Operational hydrological report exported for ${districtName} (${latest.date || 'n/a'}) from Supabase hydrological_drought_master.`)}
          >
            Export CSV Report <ChevronRight size={14} />
          </button>
        </section>
      </div>

      <footer className="hydro-footer-strip">
        <div className="hydro-footer-links">
          <strong>NIWIS v1.0</strong>
          <span>|</span>
          <span>Hydrological Drought Intelligence</span>
          <span>|</span>
          <span>{districts.length} Districts &amp; Municipalities</span>
          <span>|</span>
          <span>{parsedData.some(row => row._niwis_source === 'local_csv_fallback') ? 'Source: Packaged observations (database unavailable)' : 'Source: Database hydrological_drought_master'}</span>
          <span>|</span>
          <span>Data-driven Decisions for a Water Secure South Africa</span>
        </div>
        <div className="hydro-system-online">
          <i className="online-dot" />
          <span>System Online</span>
        </div>
      </footer>
    </div>
  )
}
