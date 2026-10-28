import { dashboardFetch as fetch } from '../services/dashboardFetch'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Droplets, Waves, Activity, Calendar, MapPin,
  AlertTriangle, CheckCircle2, ChevronRight
} from 'lucide-react'
import '../niwis/hydrology.css'
import { DistrictMap, normaliseDistrictName } from './DistrictMap'
import LoadingProgress from './LoadingProgress'

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

const HYDRO_MAP_OPTIONS = [
  { key: 'ssi', label: 'Streamflow drought index (SSI)', type: 'ssi' },
  { key: 'sgi', label: 'Groundwater drought index (SGI)', type: 'sgi' },
  { key: 'discharge_change_pct', label: 'River discharge vs same-month mean (%)', type: 'anomaly' },
  { key: 'dam_level_pct_fsc', label: 'Reservoir level (% full)', type: 'storage' },
  { key: 'river_discharge_m3_s', label: 'River discharge (m3/s)', type: 'relative' },
  { key: 'surface_runoff_m3_s', label: 'Surface runoff (m3/s)', type: 'relative' },
  { key: 'baseflow_m3_s', label: 'Baseflow (m3/s)', type: 'relative' },
]

const HYDRO_MAP_COLORS = ['#e94f63', '#f58b48', '#f0c85b', '#58c99a', '#279fd3']
const HYDRO_MAP_GRADIENT = `linear-gradient(180deg, ${[...HYDRO_MAP_COLORS].reverse().join(', ')})`
const mapNumber = value => Number(value).toLocaleString('en-ZA', { maximumFractionDigits: 2 })

function hydrologyMapStyle(metric, stations) {
  if (metric.type === 'ssi') return {
    color: value => value <= -1.5 ? HYDRO_MAP_COLORS[0] : value <= -1 ? HYDRO_MAP_COLORS[1] : value <= -0.5 ? HYDRO_MAP_COLORS[2] : value <= 0.5 ? HYDRO_MAP_COLORS[3] : HYDRO_MAP_COLORS[4],
    legend: { title: 'SSI - drought condition', gradient: HYDRO_MAP_GRADIENT, items: [['> 0.5', 'Wetter than normal'], ['-0.5 to 0.5', 'Near normal'], ['-1 to -0.5', 'Mild dryness'], ['-1.5 to -1', 'Moderate drought'], ['<= -1.5', 'Severe / extreme drought']] },
  }
  if (metric.type === 'sgi') return {
    color: value => value <= -1.5 ? HYDRO_MAP_COLORS[0] : value <= -1 ? HYDRO_MAP_COLORS[1] : value <= -0.5 ? HYDRO_MAP_COLORS[2] : value <= 0.5 ? HYDRO_MAP_COLORS[3] : HYDRO_MAP_COLORS[4],
    legend: { title: 'SGI - groundwater condition', gradient: HYDRO_MAP_GRADIENT, items: [['> 0.5', 'Above normal'], ['-0.5 to 0.5', 'Near normal'], ['-1 to -0.5', 'Below normal'], ['-1.5 to -1', 'Moderate drought'], ['<= -1.5', 'Severe drought']] },
  }
  if (metric.type === 'anomaly') return {
    color: value => value <= -50 ? HYDRO_MAP_COLORS[0] : value <= -25 ? HYDRO_MAP_COLORS[1] : value < -10 ? HYDRO_MAP_COLORS[2] : value <= 10 ? HYDRO_MAP_COLORS[3] : HYDRO_MAP_COLORS[4],
    legend: { title: 'Discharge vs same-month mean', gradient: HYDRO_MAP_GRADIENT, items: [['> 10%', 'Above mean'], ['-10% to 10%', 'Near mean'], ['-25% to -10%', 'Slightly lower'], ['-50% to -25%', 'Lower'], ['<= -50%', 'Much lower']] },
  }
  if (metric.type === 'storage') return {
    color: value => value < 20 ? HYDRO_MAP_COLORS[0] : value < 40 ? HYDRO_MAP_COLORS[1] : value < 60 ? HYDRO_MAP_COLORS[2] : value < 80 ? HYDRO_MAP_COLORS[3] : HYDRO_MAP_COLORS[4],
    legend: { title: 'Reservoir level - % full', gradient: HYDRO_MAP_GRADIENT, items: [['80%+', 'Very high'], ['60-80%', 'High'], ['40-60%', 'Mid range'], ['20-40%', 'Low'], ['0-20%', 'Very low']] },
  }
  const values = stations.map(row => Number(row[metric.key])).filter(Number.isFinite).sort((a, b) => a - b)
  if (values.length && values[0] === values[values.length - 1]) return {
    color: () => HYDRO_MAP_COLORS[2],
    legend: { title: `${metric.label} - national range`, gradient: HYDRO_MAP_GRADIENT, items: [[mapNumber(values[0]), 'Same value across reporting districts']] },
  }
  const breaks = [0.2, 0.4, 0.6, 0.8].map(fraction => values[Math.min(values.length - 1, Math.floor((values.length - 1) * fraction))])
  const band = value => breaks.findIndex(limit => value <= limit) < 0 ? 4 : breaks.findIndex(limit => value <= limit)
  const ranges = values.length ? [
    [`> ${mapNumber(breaks[3])}`, 'Highest district range'],
    [`${mapNumber(breaks[2])} - ${mapNumber(breaks[3])}`, 'Upper district range'],
    [`${mapNumber(breaks[1])} - ${mapNumber(breaks[2])}`, 'Middle district range'],
    [`${mapNumber(breaks[0])} - ${mapNumber(breaks[1])}`, 'Lower district range'],
    [`<= ${mapNumber(breaks[0])}`, 'Lowest district range'],
  ] : [['No values', 'Unavailable']]
  return {
    color: value => HYDRO_MAP_COLORS[band(Number(value))],
    legend: { title: `${metric.label} - national range`, gradient: HYDRO_MAP_GRADIENT, items: ranges },
  }
}

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

function exportHydrologyCsv(rows, district) {
  if (!rows.length) return
  const columns = Object.keys(rows[0])
  const quote = value => `"${String(value ?? '').replaceAll('"', '""')}"`
  const csv = [columns.map(quote).join(','), ...rows.map(row => columns.map(column => quote(row[column])).join(','))].join('\r\n')
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `hydrology-${district.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.csv`
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
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
  const [mapStations, setMapStations] = useState([])
  const [mapDates, setMapDates] = useState([])
  const [mapDate, setMapDate] = useState('')
  const [mapMetric, setMapMetric] = useState('ssi')
  const [mapLoading, setMapLoading] = useState(true)
  const [mapError, setMapError] = useState('')
  const skipInitialMapDateFetch = useRef(true)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)

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
    const controller = new AbortController()
    fetch('/api/hydrology/stations', { signal: controller.signal }).then(async response => {
      const payload = await response.json()
      if (!response.ok) throw new Error(payload.detail || 'Unable to load district hydrology map values.')
      return payload
    }).then(payload => {
      if (controller.signal.aborted) return
      setMapStations(payload.stations || [])
      setMapDates(payload.available_dates || [])
      setMapDate(payload.date || '')
      setMapError('')
    }).catch(error => { if (!controller.signal.aborted) setMapError(error.message) })
      .finally(() => { if (!controller.signal.aborted) setMapLoading(false) })
    return () => controller.abort()
  }, [])

  useEffect(() => {
    if (!mapDate) return undefined
    if (skipInitialMapDateFetch.current) {
      skipInitialMapDateFetch.current = false
      return undefined
    }
    const controller = new AbortController()
    setMapLoading(true)
    setMapError('')
    fetch(`/api/hydrology/stations?${new URLSearchParams({ date: mapDate })}`, { signal: controller.signal }).then(async response => {
      const payload = await response.json()
      if (!response.ok) throw new Error(payload.detail || 'Unable to load district hydrology map values.')
      return payload
    }).then(payload => {
      if (!controller.signal.aborted) setMapStations(payload.stations || [])
    }).catch(error => { if (!controller.signal.aborted) setMapError(error.message) })
      .finally(() => { if (!controller.signal.aborted) setMapLoading(false) })
    return () => controller.abort()
  }, [mapDate])

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
  const mapValues = useMemo(() => Object.fromEntries(mapStations.map(row => [normaliseDistrictName(row.name), {
    ...row,
    ...Object.fromEntries(HYDRO_MAP_OPTIONS.map(option => [option.key, isValidNumber(row[option.key]) ? Number(row[option.key]) : null])),
  }])), [mapStations])
  const selectedMapMetric = HYDRO_MAP_OPTIONS.find(option => option.key === mapMetric) || HYDRO_MAP_OPTIONS[0]
  const mapStyle = useMemo(() => hydrologyMapStyle(selectedMapMetric, mapStations), [selectedMapMetric, mapStations])
  const selectMapDistrict = name => setSelectedDistrict(districts.find(district => normaliseDistrictName(district) === normaliseDistrictName(name)) || name)

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
  const provinceName = Object.entries(DISTRICT_PROVINCES).find(([name]) => normaliseDistrictName(name) === normaliseDistrictName(districtName))?.[1] || 'South Africa'
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


  const recommendations = useMemo(() => {
    if (!latestRow) return [{ text: `No data available for ${selectedDistrict}.` }]
    return [
      { text: `Continue monitoring river discharge (${displayMetric(latest.river_discharge)} m³/s) in ${districtName}.` },
      { text: isValidNumber(latest.dam_storage) ? `Evaluate reservoir balance: dam storage is ${formatMetric(latest.dam_storage)} Mm³ (${displayMetric(latest.dam_level_pct)}% FSC).` : 'Dam Storage: No data available' },
      { text: `Compare baseflow (${displayMetric(latest.baseflow)} m³/s) with applicable ecological reserve targets.` },
      { text: `Maintain drought preparedness in ${districtName} (${provinceName}).` },
    ]
  }, [latestRow, selectedDistrict, districtName, provinceName, latest.river_discharge, latest.dam_storage, latest.dam_level_pct, latest.baseflow])

  const variablesTable = [
    { variable: 'River Discharge', value: latest.river_discharge, unit: 'm³/s', status: !isValidNumber(latest.river_discharge) ? 'No data available' : dischargeChange < -10 ? 'Below Normal' : dischargeChange > 10 ? 'Above Normal' : 'Normal', tone: dischargeChange < -10 ? 'warning' : 'info' },
    { variable: 'SSI (Streamflow)', value: latest.ssi, unit: '(dimensionless)', status: ssiClass.label, tone: ['severe', 'extreme'].includes(ssiClass.severity) ? 'danger' : ['mild', 'moderate'].includes(ssiClass.severity) ? 'warning' : 'info' },
    { variable: 'Dam Inflow', value: latest.dam_inflow, unit: 'm³/s', status: !isValidNumber(latest.dam_inflow) ? 'No data available' : latest.dam_inflow > 0 ? 'Active' : 'Recorded', tone: 'info' },
    { variable: 'Dam Outflow', value: latest.dam_outflow, unit: 'm³/s', status: !isValidNumber(latest.dam_outflow) ? 'No data available' : latest.dam_outflow > 0 ? 'Active' : 'Recorded', tone: 'info' },
    { variable: 'Surface Runoff', value: latest.surface_runoff, unit: 'm³/s', status: !isValidNumber(latest.surface_runoff) ? 'No data available' : runoffChange < -10 ? 'Below Normal' : 'Normal', tone: runoffChange < -10 ? 'warning' : 'info' },
    { variable: 'Baseflow Separation', value: latest.baseflow, unit: 'm³/s', status: !isValidNumber(latest.baseflow) ? 'No data available' : baseflowChange < -10 ? 'Below Normal' : 'Normal', tone: baseflowChange < -10 ? 'warning' : 'info' },
    { variable: 'Dam Storage', value: latest.dam_storage, unit: 'million m³', status: !isValidNumber(latest.dam_storage) ? 'No data available' : 'Recorded', tone: 'info' },
    { variable: 'Borehole Water Level', value: latest.borehole, unit: 'm bgl', status: !isValidNumber(latest.borehole) ? 'No data available' : 'Recorded', tone: 'info' },
    { variable: 'SGI (Groundwater)', value: latest.sgi, unit: '(dimensionless)', status: sgiClass.label, tone: 'info' },
  ]


  if (loading) {
    return (
      <div className="hydro-container hydro-dashboard hydro-loading-state">
        <LoadingProgress className="hydro-loading" message="Reading hydrological observations from Supabase" />
      </div>
    )
  }

  if (loadError) {
    return (
      <div className="hydro-container hydro-dashboard">
        <section className="hydro-error-card" role="alert">
          <span className="hydro-panel-kicker">DATA SOURCE UNAVAILABLE</span>
          <h1>Hydrological data could not be loaded</h1>
          <p>{loadError}</p>
          <button type="button" className="hydro-btn-report" onClick={() => window.location.reload()}>Reload dashboard</button>
        </section>
      </div>
    )
  }

  return (
    <div className="hydro-container hydro-dashboard">
      <header className="hydro-page-header">
        <div className="hydro-page-title">
          <div className="hydro-eyebrow"><Droplets size={15} /> WATER SYSTEM MONITORING <span>·</span> SUPABASE DATA</div>
          <h1>Hydrological drought</h1>
          <p>Streamflow conditions and related water indicators for South Africa’s districts.</p>
        </div>
        <div className="hydro-header-controls">
          <label className="hydro-region-control">
            <span><MapPin size={14} /> District</span>
            <select value={selectedDistrict} onChange={(event) => setSelectedDistrict(event.target.value)} aria-label="Select South African district">
              {districts.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
          </label>
          <div className="hydro-latest-date"><Calendar size={15} /><span><small>Latest observation</small><strong>{latest.date || 'No observation date'}</strong></span></div>
        </div>
      </header>

      <section className={`hydro-status-banner ${ssiClass.severity}`} aria-label={`Streamflow status: ${ssiClass.status}`}>
        <div className="hydro-status-copy">
          <span className="hydro-status-label"><i /> STREAMFLOW STATUS</span>
          <h2>{ssiClass.label}</h2>
          <p>{isValidNumber(latest.ssi) ? `Based on the latest Streamflow Standardised Index observation for ${districtName}.` : `No SSI observation is available for ${districtName} in the selected source records.`}</p>
        </div>
        <div className="hydro-status-index"><strong>{isValidNumber(latest.ssi) ? Number(latest.ssi).toFixed(2) : '—'}</strong><span>SSI · dimensionless</span></div>
        <div className="hydro-status-trend"><span>SSI category</span><strong>{ssiClass.status}</strong><small>{latest.date || 'Date unavailable'}</small></div>
      </section>

      <section className="hydro-kpi-bar" aria-label="Latest hydrological indicators">
        <article className="hydro-kpi-cell"><div className="hydro-kpi-top"><span className="hydro-kpi-title">River discharge</span><Waves size={16} className="hydro-kpi-icon" /></div><div className="hydro-kpi-val-row"><MetricValue value={latest.river_discharge} unit="m³/s" /></div><div className="hydro-kpi-note">{isValidNumber(dischargeChange) ? `${Math.abs(dischargeChange).toFixed(0)}% ${dischargeChange < 0 ? 'below' : 'above'} historical mean` : 'Historical comparison unavailable'}</div></article>
        <article className="hydro-kpi-cell"><div className="hydro-kpi-top"><span className="hydro-kpi-title">Dam inflow</span><Activity size={16} className="hydro-kpi-icon" /></div><div className="hydro-kpi-val-row"><MetricValue value={latest.dam_inflow} unit="m³/s" /></div><div className="hydro-kpi-note">Period mean: {displayMetric(inflowMean)} m³/s</div></article>
        <article className="hydro-kpi-cell"><div className="hydro-kpi-top"><span className="hydro-kpi-title">Dam outflow</span><Activity size={16} className="hydro-kpi-icon" /></div><div className="hydro-kpi-val-row"><MetricValue value={latest.dam_outflow} unit="m³/s" /></div><div className="hydro-kpi-note">Period mean: {displayMetric(outflowMean)} m³/s</div></article>
        <article className="hydro-kpi-cell"><div className="hydro-kpi-top"><span className="hydro-kpi-title">Surface runoff</span><Waves size={16} className="hydro-kpi-icon" /></div><div className="hydro-kpi-val-row"><MetricValue value={latest.surface_runoff} unit="m³/s" /></div><div className="hydro-kpi-note">{isValidNumber(runoffChange) ? `${Math.abs(runoffChange).toFixed(0)}% ${runoffChange < 0 ? 'below' : 'above'} period mean` : 'Historical comparison unavailable'}</div></article>
        <article className="hydro-kpi-cell"><div className="hydro-kpi-top"><span className="hydro-kpi-title">Baseflow</span><Waves size={16} className="hydro-kpi-icon" /></div><div className="hydro-kpi-val-row"><MetricValue value={latest.baseflow} unit="m³/s" /></div><div className="hydro-kpi-note">Period mean: {displayMetric(baseflowMean)} m³/s</div></article>
      </section>

      <div className="hydro-primary-grid">
        <section className="hydro-panel hydro-map-panel">
          <div className="hydro-panel-head"><div><span className="hydro-panel-kicker">DISTRICT INDICATOR MAP</span><h2 className="hydro-panel-title">{selectedMapMetric.label}</h2><p>Choose an indicator and date; select a district to update the dashboard below.</p></div><MapPin size={18} className="hydro-map-icon" /></div>
          <div className="hydro-map-controls">
            <label><span>Map indicator</span><select aria-label="Hydrological map indicator" value={mapMetric} onChange={event => setMapMetric(event.target.value)}>{HYDRO_MAP_OPTIONS.map(option => <option value={option.key} key={option.key}>{option.label}</option>)}</select></label>
            <label><span>Map date</span><select aria-label="Hydrological map date" value={mapDate} onChange={event => setMapDate(event.target.value)} disabled={!mapDates.length}>{mapDates.map(date => <option value={date} key={date}>{date}</option>)}</select></label>
          </div>
          {mapError ? <div className="hydro-map-message" role="alert">{mapError}</div> : mapLoading ? <LoadingProgress className="hydro-map-loading" message="Loading district indicator values" /> : districtsGeoJson.length && mapStations.length ? <div className="hydro-map-wrap"><DistrictMap districts={districtsGeoJson} values={mapValues} valueKey={mapMetric} colorFn={mapStyle.color} selected={selectedDistrict} onSelect={selectMapDistrict} legend={mapStyle.legend} /></div> : <div className="hydro-map-message">District boundaries or hydrological map values are unavailable for {mapDate || 'the latest available date'}.</div>}
          <p className="hydro-map-caption">{mapStations.length} districts with observations on {mapDate || 'the latest available date'} - {districtName}, {provinceName} selected.</p>
        </section>

        <section className="hydro-panel hydro-primary-chart">
          <div className="hydro-panel-head"><div><span className="hydro-panel-kicker">STREAMFLOW HISTORY</span><h2 className="hydro-panel-title">River discharge</h2><p>Observed daily values for {districtName}</p></div><span className="hydro-chart-unit">m³/s</span></div>
          <div className="hydro-chart-canvas" key={`discharge-${selectedDistrict}`}><SmoothSeriesChart series={riverDischargeData} gradId={`dg-${selectedDistrict.replace(/[^a-z0-9]/gi, '')}`} meanValue={dischargeMean} yLabel="Discharge (m³/s)" unit="m³/s" /></div>
          <div className="hydro-chart-stats-row"><div className="hydro-stat-col"><small>Latest</small><strong>{displayMetric(latest.river_discharge)} m³/s</strong></div><div className="hydro-stat-col"><small>Period mean</small><strong>{displayMetric(dischargeMean)} m³/s</strong></div><div className="hydro-stat-col"><small>Records</small><strong>{riverDischargeData.filter(point => isValidNumber(point.value)).length.toLocaleString()}</strong></div></div>
        </section>
      </div>

      <div className="hydro-chart-grid">
        <section className="hydro-panel">
          <div className="hydro-panel-head"><div><span className="hydro-panel-kicker">DROUGHT INDEX</span><h2 className="hydro-panel-title">Streamflow Standardised Index</h2><p>Negative values indicate drier-than-normal streamflow.</p></div><span className={`hydro-status-chip ${ssiClass.severity}`}>{ssiClass.status}</span></div>
          <div className="hydro-chart-canvas" key={`ssi-${selectedDistrict}`}><SsiChart series={ssiData} /></div>
          <div className="hydro-chart-stats-row hydro-two-stats"><div className="hydro-stat-col"><small>Latest SSI</small><strong>{displayMetric(latest.ssi, 2)}</strong></div><div className="hydro-stat-col"><small>Observed series</small><strong>{ssiData.filter(point => isValidNumber(point.value)).length.toLocaleString()} values</strong></div></div>
        </section>

        <section className="hydro-panel">
          <div className="hydro-panel-head"><div><span className="hydro-panel-kicker">RESERVOIR FLOWS</span><h2 className="hydro-panel-title">Dam inflow and outflow</h2><p>Compare observed flow rates over time.</p></div><span className="hydro-chart-unit">m³/s</span></div>
          <div className="hydro-chart-canvas" key={`dams-${selectedDistrict}`}><DualSeriesChart seriesA={inflowData} seriesB={outflowData} labelA="Inflow" labelB="Outflow" colorA="#22d3ee" colorB="#f59e0b" gradIdA="dam-in" gradIdB="dam-out" yLabel="Dam flow (m³/s)" /></div>
          <div className="hydro-chart-stats-row"><div className="hydro-stat-col"><small>Latest inflow</small><strong>{displayMetric(latest.dam_inflow)} m³/s</strong></div><div className="hydro-stat-col"><small>Latest outflow</small><strong>{displayMetric(latest.dam_outflow)} m³/s</strong></div><div className="hydro-stat-col"><small>Mean inflow</small><strong>{displayMetric(inflowMean)} m³/s</strong></div></div>
        </section>

        <section className="hydro-panel">
          <div className="hydro-panel-head"><div><span className="hydro-panel-kicker">CATCHMENT RESPONSE</span><h2 className="hydro-panel-title">Runoff and baseflow</h2><p>Surface runoff and baseflow contribution.</p></div><span className="hydro-chart-unit">m³/s</span></div>
          <div className="hydro-chart-canvas" key={`contrib-${selectedDistrict}`}><DualSeriesChart seriesA={runoffData} seriesB={baseflowData} labelA="Surface runoff" labelB="Baseflow" colorA="#38bdf8" colorB="#a78bfa" gradIdA="run-a" gradIdB="run-b" yLabel="Water flow (m³/s)" /></div>
          <div className="hydro-chart-stats-row hydro-two-stats"><div className="hydro-stat-col"><small>Latest runoff</small><strong>{displayMetric(latest.surface_runoff)} m³/s</strong></div><div className="hydro-stat-col"><small>Latest baseflow</small><strong>{displayMetric(latest.baseflow)} m³/s</strong></div></div>
        </section>
      </div>

      <div className="hydro-detail-grid">
        <section className="hydro-panel hydro-variables-panel">
          <div className="hydro-panel-head"><div><span className="hydro-panel-kicker">OBSERVATION SUMMARY</span><h2 className="hydro-panel-title">Latest hydrological variables</h2><p>Values recorded for {districtName} on {latest.date || 'the latest available date'}.</p></div></div>
          <div className="hydro-table-shell"><table className="hydro-table"><thead><tr><th>Indicator</th><th>Observed value</th><th>Unit</th><th>Interpretation</th></tr></thead><tbody>
            {variablesTable.map(row => <tr key={row.variable}><td>{row.variable}</td><td>{isValidNumber(row.value) ? (row.variable.includes('SSI') || row.variable.includes('SGI') ? Number(row.value).toFixed(2) : formatMetric(row.value)) : 'No data'}</td><td>{row.unit}</td><td><span className={`hydro-tag-pill ${row.tone}`}>{row.status}</span></td></tr>)}
          </tbody></table></div>
        </section>

        <section className="hydro-panel hydro-alert-panel">
          <div className="hydro-panel-head"><div><span className="hydro-panel-kicker">THRESHOLD CHECKS</span><h2 className="hydro-panel-title">Alerts and observations</h2><p>Rule-based signals from the latest available readings.</p></div><AlertTriangle size={18} className="hydro-map-icon" /></div>
          <div className="hydro-insights-list">{alerts.map((alert, index) => <div key={`${alert.level}-${index}`} className={`hydro-insight-item ${alert.level === 'Severe' ? 'danger' : alert.level === 'Warning' ? 'warning' : 'info'}`}><span className="hydro-alert-level">{alert.level}</span><span>{alert.text}</span></div>)}</div>
        </section>

        <section className="hydro-panel hydro-recommend-panel">
          <div className="hydro-panel-head"><div><span className="hydro-panel-kicker">NEXT STEPS</span><h2 className="hydro-panel-title">Monitoring guidance</h2><p>Operational prompts based on available indicators.</p></div></div>
          <div className="hydro-recom-list">{recommendations.map((rec, index) => <div key={`${index}-${rec.text}`} className="hydro-recom-item"><CheckCircle2 size={16} className="check-icon" /><span>{rec.text}</span></div>)}</div>
          <button type="button" className="hydro-btn-report" onClick={() => exportHydrologyCsv(filteredData, districtName)} disabled={!filteredData.length}>Download district CSV <ChevronRight size={14} /></button>
        </section>
      </div>

      <footer className="hydro-footer-strip"><span><strong>Source</strong> Supabase · hydrological_drought_master</span><span>{filteredData.length.toLocaleString()} records · {firstRow?.date || '—'} to {latest.date || '—'}</span></footer>
    </div>
  )
}
