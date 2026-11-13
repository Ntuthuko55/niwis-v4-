import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import L from 'leaflet'
import { AlertTriangle, Database, MapPinned, RefreshCw } from 'lucide-react'
import { Bar, BarChart, CartesianGrid, Cell, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { PROVINCES } from './ProvinceMapLabels'
import DashboardMap from './DashboardMap'
import '../niwis/monitoring-map.css'
import MonitoringMapPanel from './MonitoringMapPanel'
import { chartColor } from '../lib/chartTheme'
import { dashboardFetch as fetch } from '../services/dashboardFetch'
import '../niwis/municipal-tariffs.css'

const NO_VALUE = '#465b6c'
const VALUE_COLORS = ['#164f71', '#167c91', '#22a79c', '#70c9a3', '#d1e89b']
const DROUGHT_COLORS = { D0: '#f6dd79', D1: '#f4ad55', D2: '#e97845', D3: '#d94d48', D4: '#a92d48' }
const DROUGHT_LABELS = { D0: 'Abnormally dry', D1: 'Moderate drought', D2: 'Severe drought', D3: 'Extreme drought', D4: 'Exceptional drought' }

async function getJSON(url, signal) {
  const options = { signal }
  if (url.endsWith('/metadata') || url.endsWith('/map-tiles/status')) options.cache = 'no-store'
  const response = await fetch(url, options)
  const data = await response.json()
  if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : `Request failed (HTTP ${response.status}).`)
  return data
}

function normaliseMunicipalityName(name = '') {
  return String(name).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('en-ZA').trim()
    .replace(/^(?:city\s+of|local\s+municipality\s+of|municipality\s+of|the)\s+/, '')
    .replace(/\b(?:metropolitan|local)\s+municipality\b/g, '')
    .replace(/\bmunicipality\b/g, '')
    .replace(/[^a-z0-9]/g, '')
}

const CITY_REGION_CODE_OVERRIDES = new Map([['emalahleni', 'MP312']])
const CITY_REGION_LABELS = new Map([['MP312', 'eMalahleni, Mpumalanga']])

function displayRegionName(name = '') {
  return CITY_REGION_LABELS.get(CITY_REGION_CODE_OVERRIDES.get(normaliseMunicipalityName(name))) || name
}

function formatValue(value, unit = '') {
  if (value === null || value === undefined || value === '') return 'No value'
  const formatted = typeof value === 'number'
    ? value.toLocaleString('en-ZA', { maximumFractionDigits: 2 })
    : String(value)
  return unit ? `${formatted} ${unit}` : formatted
}

function formatAxisValue(value) {
  return Number(value).toLocaleString('en-ZA', { maximumFractionDigits: 2 })
}

function SourceTrendTooltip({ active, payload, label, unit }) {
  const point = payload?.[0]?.payload
  if (!active || !point) return null
  return <div className="mt-chart-tooltip"><strong>{label}</strong><span>{formatValue(point.value, unit)}</span><small>Source period: {point.source_period || 'not supplied'}</small></div>
}

function IndicatorTrendCard({ indicator, selected, selectedYear, region, onSelect }) {
  const validValues = indicator.coverage.valid_values
  const yearPoint = indicator.points.find(point => point.year === Number(selectedYear))
  return <article className={`mt-indicator-card${selected ? ' is-selected' : ''}`}>
    <button type="button" className="mt-indicator-card-title" onClick={() => onSelect(indicator.key)} aria-pressed={selected}>
      <span>{indicator.label}</span><small>{indicator.unit} · {validValues} of {indicator.points.length} years with values</small>
      <strong>{formatValue(yearPoint?.value, indicator.unit)}</strong><em>{selectedYear} source value for {region === 'National' ? 'National' : displayRegionName(region)}</em>
    </button>
    {indicator.type === 'category' ? <div className="mt-mini-category" role="img" aria-label={`${indicator.label} category history`}>
      {indicator.points.map(point => <div key={point.year} title={`${point.year}: ${point.value ? `${point.value} · ${DROUGHT_LABELS[point.value]}` : 'No valid category recorded'}${point.source_period ? ` · ${point.source_period}` : ''}`}>
        <i style={{ background: point.value ? DROUGHT_COLORS[point.value] : NO_VALUE }} /><span>{point.year}</span><b>{point.value || '—'}</b>
      </div>)}
    </div> : validValues > 0 ? <div className="mt-indicator-sparkline" role="img" aria-label={`${indicator.label} trend in ${indicator.unit}`}>
      <ResponsiveContainer width="100%" height="100%"><LineChart data={indicator.points} margin={{ top: 8, right: 7, bottom: 1, left: 7 }}>
        <CartesianGrid stroke="#29485e" strokeDasharray="3 5" vertical={false} />
        <XAxis dataKey="year" tick={{ fill: '#8ba8ba', fontSize: 8 }} tickLine={false} axisLine={false} minTickGap={24} />
        <YAxis hide domain={['auto', 'auto']} />
        <Tooltip content={<SourceTrendTooltip unit={indicator.unit} />} />
        <Line type="linear" dataKey="value" stroke={chartColor(selected ? '#7ee1cc' : '#5ca9c0')} strokeWidth={2} dot={false} activeDot={{ r: 4 }} connectNulls={false} isAnimationActive={false} />
      </LineChart></ResponsiveContainer>
    </div> : <div className="mt-indicator-no-data">No valid numeric values in the available years.</div>}
    <footer>{validValues > 0 ? `${validValues} source years · gaps retained` : 'No valid values reported'}</footer>
  </article>
}

function metricSnapshot(metric, result) {
  const values = result.rows.map(row => row.values?.[metric.key]).filter(value => value !== null && value !== undefined && (metric.type === 'category' || (typeof value === 'number' && Number.isFinite(value))))
  const valid = values.length
  const national = result.national?.values?.[metric.key]
  let spread = 'No valid source values for this year'
  if (metric.type === 'category' && valid) {
    const counts = values.reduce((map, value) => map.set(value, (map.get(value) || 0) + 1), new Map())
    spread = [...counts].sort((a, b) => b[1] - a[1]).map(([value, count]) => `${value}: ${count}`).join(' · ')
  } else if (valid) {
    const min = Math.min(...values)
    const max = Math.max(...values)
    spread = min === max ? `Same reported value: ${formatValue(min, metric.unit)}` : `Reported range: ${formatValue(min, metric.unit)} to ${formatValue(max, metric.unit)}`
  }
  return { valid, national, spread }
}

function coverageColor(valid, total) {
  if (!total || !valid) return NO_VALUE
  const pct = valid / total
  if (pct < 0.25) return '#24506a'
  if (pct < 0.5) return '#18788a'
  if (pct < 0.75) return '#1e9e9b'
  if (pct < 1) return '#66c3a8'
  return '#c6e58e'
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character])
}

function numericScale(rows, metricKey) {
  const values = rows.map(row => row.values?.[metricKey]).filter(value => typeof value === 'number' && Number.isFinite(value)).sort((a, b) => a - b)
  if (!values.length) return { color: () => NO_VALUE, legend: [] }
  const display = value => value.toLocaleString('en-ZA', { maximumFractionDigits: 2 })
  if (values[0] === values[values.length - 1]) {
    return { color: () => VALUE_COLORS[2], legend: [{ color: VALUE_COLORS[2], range: `Same reported value: ${display(values[0])}` }] }
  }
  const cuts = []
  for (let part = 1; part < 5; part += 1) {
    const candidate = values[Math.floor(((values.length - 1) * part) / 5)]
    if (candidate > values[0] && candidate < values[values.length - 1] && candidate > (cuts.at(-1) ?? values[0])) cuts.push(candidate)
  }
  const edges = cuts.length
    ? [...cuts, values[values.length - 1]]
    : VALUE_COLORS.map((_color, index) => values[0] + ((values[values.length - 1] - values[0]) * (index + 1)) / VALUE_COLORS.length)
  const legend = edges.map((upper, index) => ({
    color: VALUE_COLORS[index],
    range: index === 0 ? `≤ ${display(upper)}` : `> ${display(edges[index - 1])} to ${display(upper)}`,
  }))
  return {
    color: value => {
      if (typeof value !== 'number' || !Number.isFinite(value)) return NO_VALUE
      const index = edges.findIndex(upper => value <= upper)
      return VALUE_COLORS[Math.max(0, index)] || NO_VALUE
    },
    legend,
  }
}

function categoryColor(value) { return DROUGHT_COLORS[value] || NO_VALUE }

function buildMunicipalityMatches(features, rows) {
  const byName = new Map()
  for (const feature of features) {
    const name = normaliseMunicipalityName(feature.properties?.MUNICNAME)
    const matches = byName.get(name) || []
    matches.push(feature)
    byName.set(name, matches)
  }
  const byCode = new Map()
  const unmatched = []
  const ambiguous = []
  const conflicts = new Set()
  const matchedSourceRegions = new Set()
  const displayNameByCode = new Map()
  const sourceAliasByCode = new Map()
  const cityAliases = []
  for (const row of rows) {
    const normalized = normaliseMunicipalityName(row.region)
    const overrideCode = CITY_REGION_CODE_OVERRIDES.get(normalized)
    if (overrideCode) {
      const feature = features.find(item => item.properties?.CAT_B === overrideCode)
      if (feature) {
        byCode.set(overrideCode, row)
        matchedSourceRegions.add(row.region)
        displayNameByCode.set(overrideCode, CITY_REGION_LABELS.get(overrideCode) || feature.properties?.MUNICNAME || row.region)
        sourceAliasByCode.set(overrideCode, row.region)
        cityAliases.push({ source: row.region, display: CITY_REGION_LABELS.get(overrideCode) || feature.properties?.MUNICNAME || row.region, code: overrideCode })
        continue
      }
    }
    const matches = byName.get(normalized) || []
    if (matches.length === 0) {
      unmatched.push(row.region)
      continue
    }
    if (matches.length > 1) {
      ambiguous.push({ region: row.region, names: matches.map(feature => feature.properties?.MUNICNAME || '') })
      unmatched.push(row.region)
      continue
    }
    const code = matches[0].properties?.CAT_B
    if (!code) {
      unmatched.push(row.region)
      continue
    }
    if (byCode.has(code)) {
      conflicts.add(code)
      unmatched.push(row.region, byCode.get(code).region)
    } else {
      byCode.set(code, row)
      matchedSourceRegions.add(row.region)
      displayNameByCode.set(code, matches[0].properties?.MUNICNAME || row.region)
    }
  }
  for (const code of conflicts) byCode.delete(code)
  return {
    byCode,
    displayNameByCode,
    sourceAliasByCode,
    cityAliases,
    unmatched: [...new Set(unmatched)],
    ambiguous,
    matchedPolygons: byCode.size,
    matchedSourceRegionCount: matchedSourceRegions.size,
  }
}

function legendItems(metric, rows, scale) {
  if (metric?.type === 'category') {
    const observed = new Set(rows.map(row => row.values?.[metric.key]).filter(Boolean))
    const levels = ['D0', 'D1', 'D2', 'D3', 'D4'].filter(level => observed.has(level))
    return [...levels.map(level => ({ color: DROUGHT_COLORS[level], range: `${level} · ${DROUGHT_LABELS[level]}` })), { color: NO_VALUE, range: 'No valid source value / no source match' }]
  }
  return [...scale.legend, { color: NO_VALUE, range: 'No valid source value / no source match' }]
}

export default function MunicipalTariffs({ section: navigationSection = null }) {
  const [metadata, setMetadata] = useState(null)
  const [result, setResult] = useState(null)
  const [features, setFeatures] = useState([])
  const [datasetKey, setDatasetKey] = useState('municipal')
  const [year, setYear] = useState('')
  const [metricKey, setMetricKey] = useState('')
  const [trendRegion, setTrendRegion] = useState('National')
  const [analytics, setAnalytics] = useState(null)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState('')
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [boundaryError, setBoundaryError] = useState('')
  const [mapTilerConfigured, setMapTilerConfigured] = useState(false)
  const [mapTilerError, setMapTilerError] = useState('')
  const [mapTileRetry, setMapTileRetry] = useState(0)
  const [retry, setRetry] = useState(0)
  const [mapElement, setMapElement] = useState(null)
  const [mapToolbarTarget, setMapToolbarTarget] = useState(null)
  const mapRef = useRef(null)
  const layerRef = useRef(null)
  const tileLayerRef = useRef(null)
  const hasCurrentResult = result?.dataset === datasetKey
  const mapMatches = useMemo(() => buildMunicipalityMatches(features, hasCurrentResult ? result?.rows || [] : []), [features, hasCurrentResult, result?.rows])
  const metrics = metadata?.datasets?.[datasetKey]?.metrics || result?.metrics || []
  const metric = metrics.find(item => item.key === metricKey) || metrics[0]
  const trendRegions = hasCurrentResult ? [...(result.national ? ['National'] : []), ...result.rows.map(row => row.region)] : []
  const activeTrendRegion = trendRegions.includes(trendRegion) ? trendRegion : trendRegions[0] || ''
  const focusedTrend = analytics?.indicators?.find(item => item.key === metric?.key)
  const hasMapData = Boolean(hasCurrentResult && metric)
  const mappedSourceRows = useMemo(() => [...new Map([...mapMatches.byCode.values()].map(row => [row.region, row])).values()], [mapMatches])
  const selectedRows = useMemo(() => {
    if (!metric || !hasCurrentResult) return []
    return result.rows.map(row => ({ ...row, value: row.values?.[metric.key] }))
  }, [metric, hasCurrentResult, result])
  const renderedFeatures = useMemo(() => features.filter(feature => {
    const row = mapMatches.byCode.get(feature.properties?.CAT_B)
    const value = row?.values?.[metric?.key]
    return metric?.type === 'category' ? typeof value === 'string' : typeof value === 'number' && Number.isFinite(value)
  }), [features, mapMatches, metric])
  const scale = useMemo(() => numericScale(mappedSourceRows, metric?.key), [mappedSourceRows, metric?.key])
  const mapFeatureStyle = useCallback(feature => {
    const row = mapMatches.byCode.get(feature.properties?.CAT_B)
    const isSelected = activeTrendRegion !== 'National' && row?.region?.toLocaleLowerCase('en-ZA') === activeTrendRegion.toLocaleLowerCase('en-ZA')
    return {
      color: isSelected ? '#ffffff' : '#597286',
      weight: isSelected ? 1.8 : 0.65,
      opacity: 0.9,
      fillColor: metric?.type === 'category' ? categoryColor(row?.values?.[metric?.key]) : scale.color(row?.values?.[metric?.key]),
      fillOpacity: isSelected ? 0.64 : 0.48,
    }
  }, [mapMatches, activeTrendRegion, metric, scale])
  const mapFeatureLabel = useCallback(feature => {
    const code = feature.properties?.CAT_B
    const name = mapMatches.displayNameByCode.get(code) || feature.properties?.MUNICNAME || 'Unknown municipality'
    const row = mapMatches.byCode.get(code)
    const sourceAlias = mapMatches.sourceAliasByCode.get(code)
    return `${name} · ${metric?.label || 'Source value'}: ${formatValue(row?.values?.[metric?.key], metric?.unit)} · ${result?.year || ''}${sourceAlias ? ` · Source region: ${sourceAlias}` : ''}`
  }, [mapMatches, metric, result?.year])
  const selectMapFeature = useCallback(feature => {
    const row = mapMatches.byCode.get(feature.properties?.CAT_B)
    if (row?.region) setTrendRegion(row.region)
  }, [mapMatches])
  const selectedMapFeature = useMemo(() => renderedFeatures.find(feature => mapMatches.byCode.get(feature.properties?.CAT_B)?.region === activeTrendRegion) || null, [renderedFeatures, mapMatches, activeTrendRegion])
  const districtOptions = useMemo(() => [...new Set(renderedFeatures.map(feature => mapMatches.displayNameByCode.get(feature.properties?.CAT_B) || feature.properties?.MUNICNAME).filter(Boolean))].sort((a, b) => a.localeCompare(b)), [renderedFeatures, mapMatches])
  const selectMapDistrict = name => {
    const feature = renderedFeatures.find(item => (mapMatches.displayNameByCode.get(item.properties?.CAT_B) || item.properties?.MUNICNAME) === name)
    if (feature) selectMapFeature(feature)
  }
  const legend = useMemo(() => legendItems(metric, mappedSourceRows, scale), [metric, mappedSourceRows, scale])
  const mappedValues = useMemo(() => new Set([...mapMatches.byCode.values()].filter(row => {
    const value = row.values?.[metric?.key]
    return metric?.type === 'category' ? typeof value === 'string' : typeof value === 'number' && Number.isFinite(value)
  }).map(row => row.region)).size, [mapMatches, metric])
  const nationalValue = result?.national?.values?.[metric?.key]
  const visibleRows = useMemo(() => selectedRows.filter(row => `${row.region} ${displayRegionName(row.region)}`.toLocaleLowerCase('en-ZA').includes(query.trim().toLocaleLowerCase('en-ZA')))
    .sort((a, b) => {
      const aNumeric = typeof a.value === 'number' && Number.isFinite(a.value)
      const bNumeric = typeof b.value === 'number' && Number.isFinite(b.value)
      const aHasValue = a.value !== null && a.value !== undefined
      const bHasValue = b.value !== null && b.value !== undefined
      if (aHasValue !== bHasValue) return aHasValue ? -1 : 1
      if (aNumeric && bNumeric) return b.value - a.value
      if (aNumeric !== bNumeric) return aNumeric ? -1 : 1
      return String(a.value ?? '').localeCompare(String(b.value ?? ''))
    }), [selectedRows, query])
  const comparisonData = useMemo(() => {
    if (!result || !metric) return []
    if (metric.type === 'category') {
      const counts = new Map(['D0', 'D1', 'D2', 'D3', 'D4'].map(category => [category, 0]))
      result.rows.forEach(row => {
        const value = row.values?.[metric.key]
        if (counts.has(value)) counts.set(value, counts.get(value) + 1)
      })
      const selectedCategory = result.rows.find(row => row.region === activeTrendRegion)?.values?.[metric.key]
      return [...counts].filter(([, count]) => count > 0).map(([category, count]) => ({ region: category, count, selected: category === selectedCategory }))
    }
    const rankedRows = result.rows
      .filter(row => typeof row.values?.[metric.key] === 'number' && Number.isFinite(row.values[metric.key]))
      .sort((a, b) => b.values[metric.key] - a.values[metric.key] || a.region.localeCompare(b.region))
    const topRows = rankedRows.slice(0, 10)
    const selectedRow = rankedRows.find(row => row.region === activeTrendRegion)
    if (selectedRow && !topRows.some(row => row.region === selectedRow.region)) topRows.push(selectedRow)
    return topRows.map(row => ({ region: displayRegionName(row.region), value: row.values[metric.key], selected: row.region === activeTrendRegion }))
  }, [result, metric, activeTrendRegion])
  const snapshots = useMemo(() => hasCurrentResult ? metrics.map(item => ({ metric: item, ...metricSnapshot(item, result) })) : [], [hasCurrentResult, metrics, result])

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError('')
    setMetadata(null)
    setResult(null)
    getJSON('/api/municipal-tariffs/metadata', controller.signal).then(data => {
      if (controller.signal.aborted) return
      setMetadata(data)
      const first = data.datasets?.municipal
      setDatasetKey('municipal')
      setYear(first?.latest_year || '')
      setMetricKey(first?.default_metric || first?.metrics?.[0]?.key || '')
    }).catch(requestError => {
      if (!controller.signal.aborted) setError(requestError.message || 'The database metadata could not be loaded.')
    }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [retry])

  useEffect(() => {
    const controller = new AbortController()
    getJSON('/sa_local_municipalities_2026_simplified.geojson', controller.signal).then(data => {
      if (!controller.signal.aborted) setFeatures(data.features || [])
    }).catch(requestError => {
      if (!controller.signal.aborted) setBoundaryError(requestError.message || 'The municipality boundaries could not be loaded.')
    })
    return () => controller.abort()
  }, [retry])

  useEffect(() => {
    const controller = new AbortController()
    getJSON('/api/municipal-tariffs/map-tiles/status', controller.signal).then(data => {
      if (!controller.signal.aborted) setMapTilerConfigured(Boolean(data.configured))
    }).catch(() => { if (!controller.signal.aborted) setMapTilerConfigured(false) })
    return () => controller.abort()
  }, [retry])

  useEffect(() => {
    const source = metadata?.datasets?.[datasetKey]
    if (!source || year === '') return undefined
    const controller = new AbortController()
    setLoading(true)
    setError('')
    setResult(null)
    getJSON(`/api/municipal-tariffs/dashboard?${new URLSearchParams({ dataset: datasetKey, year: String(year) })}`, controller.signal)
      .then(data => {
        if (controller.signal.aborted) return
        setResult(data)
        if (!data.metrics.some(item => item.key === metricKey) || !data.coverage.usable_by_metric[metricKey]) {
          const available = data.metrics.find(item => data.coverage.usable_by_metric[item.key] > 0)
          setMetricKey(available?.key || '')
        }
      }).catch(requestError => {
        if (!controller.signal.aborted) setError(requestError.message || 'The selected database records could not be loaded.')
      }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [metadata, datasetKey, year, retry])

  useEffect(() => {
    if (!hasCurrentResult || !activeTrendRegion) return undefined
    const controller = new AbortController()
    setAnalytics(null)
    setHistoryLoading(true)
    setHistoryError('')
    const params = new URLSearchParams({ dataset: datasetKey, region: activeTrendRegion })
    getJSON(`/api/municipal-tariffs/analytics?${params}`, controller.signal).then(data => {
      if (!controller.signal.aborted) setAnalytics(data)
    }).catch(requestError => {
      if (!controller.signal.aborted) setHistoryError(requestError.message || 'The historical source values could not be loaded.')
    }).finally(() => { if (!controller.signal.aborted) setHistoryLoading(false) })
    return () => controller.abort()
  }, [hasCurrentResult, result, datasetKey, activeTrendRegion, retry])

  useEffect(() => {
    if (!mapElement || !features.length || !hasMapData || mapRef.current) return undefined
    const map = L.map(mapElement, { minZoom: 4, maxZoom: 13, zoomControl: false, maxBounds: [[-39, 12], [-19, 36]], maxBoundsViscosity: 0.8 })
    map.setView([-29, 24], 5)
    L.control.zoom({ position: 'topright' }).addTo(map)
    PROVINCES.forEach(([name, longitude, latitude]) => {
      const icon = L.divIcon({
        className: 'mt-province-label-marker',
        html: `<span class="mt-province-label">${escapeHtml(name)}</span>`,
        iconSize: [126, 18],
        iconAnchor: [63, 9],
      })
      L.marker([latitude, longitude], { icon, interactive: false, keyboard: false, zIndexOffset: 1000 }).addTo(map)
    })
    mapRef.current = map
    let frame = 0
    const resize = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        if (mapRef.current === map) map.invalidateSize({ pan: false })
      })
    }
    const observer = new ResizeObserver(resize)
    observer.observe(mapElement)
    document.addEventListener('fullscreenchange', resize)
    resize()
    return () => {
      observer.disconnect()
      document.removeEventListener('fullscreenchange', resize)
      cancelAnimationFrame(frame)
      layerRef.current = null
      tileLayerRef.current = null
      mapRef.current = null
      map.remove()
    }
  }, [features, hasMapData, mapElement])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !hasMapData) return undefined
    if (tileLayerRef.current) {
      map.removeLayer(tileLayerRef.current)
      tileLayerRef.current = null
    }
    if (mapTilerConfigured) {
      const tiles = L.tileLayer('/api/municipal-tariffs/map-tiles/{z}/{x}/{y}.jpg', {
        maxZoom: 13,
        attribution: '&copy; <a href="https://www.maptiler.com/copyright/">MapTiler</a> satellite imagery',
        keepBuffer: 2,
      })
      let loaded = 0
      let failed = 0
      let timer
      const finish = (timedOut = false) => {
        if (timer) clearTimeout(timer)
        setMapTilerError(failed > 0 || timedOut
          ? loaded > 0 ? 'Some satellite tiles could not load. Municipality values remain available.' : 'Satellite imagery is unavailable. Municipality values remain available.'
          : '')
      }
      const begin = () => {
        loaded = 0
        failed = 0
        setMapTilerError('')
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => finish(true), 15000)
      }
      tiles.on('loading', begin)
      tiles.on('tileload', () => { loaded += 1 })
      tiles.on('tileerror', () => { failed += 1 })
      tiles.on('load', () => finish())
      begin()
      tiles.addTo(map)
      tileLayerRef.current = tiles
      return () => {
        if (timer) clearTimeout(timer)
        tiles.off()
        if (map.hasLayer(tiles)) map.removeLayer(tiles)
        if (tileLayerRef.current === tiles) tileLayerRef.current = null
      }
    }
    return undefined
  }, [mapTilerConfigured, mapTileRetry, features, hasMapData, mapElement])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !features.length || !hasMapData || !result || !metric) return undefined
    if (layerRef.current) map.removeLayer(layerRef.current)
    const byCode = mapMatches.byCode
    const geoLayer = L.geoJSON(features, {
      style: mapFeatureStyle,
      onEachFeature: (feature, layer) => {
        const code = feature.properties?.CAT_B
        const name = mapMatches.displayNameByCode?.get(code) || feature.properties?.MUNICNAME || 'Unknown municipality'
        const sourceAlias = mapMatches.sourceAliasByCode?.get(code)
        const row = byCode?.get(code)
        let valueText = 'No source record for this municipality and year.'
        if (sourceAlias && row) {
          const sourceValue = row.values?.[metric.key]
          const valueLabel = sourceValue === null || sourceValue === undefined
            ? 'The source has no valid value for this indicator and year.'
            : `${escapeHtml(metric.label)}: <strong>${escapeHtml(formatValue(sourceValue, metric.unit))}</strong>`
          valueText = `Database region “${escapeHtml(sourceAlias)}” is mapped to ${escapeHtml(name)} (${escapeHtml(code)}) using the city-name crosswalk. ${valueLabel}`
        }
        else if (row && row.values?.[metric.key] === null) valueText = 'The source has no valid value for this indicator and year.'
        else if (row) valueText = `${escapeHtml(metric.label)}: <strong>${escapeHtml(formatValue(row.values?.[metric.key], metric.unit))}</strong>`
        layer.bindPopup(`<div class="mt-popup"><strong>${escapeHtml(name)}</strong><div>${escapeHtml(metric.label)} · ${result.year}</div><p>${valueText}</p></div>`)
        layer.bindTooltip(`${escapeHtml(name)} · click to update regional charts`, { sticky: true, direction: 'top', className: 'mt-map-tooltip' })
        layer.on('click', () => {
          if (row?.region) setTrendRegion(row.region)
        })
        layer.on('mouseover', event => event.target.setStyle({ color: '#f1faff', weight: 1.8, fillOpacity: 0.72 }))
        layer.on('mouseout', event => geoLayer.resetStyle(event.target))
        layer.on('add', () => {
          const element = layer.getElement?.()
          if (!element) return
          element.setAttribute('tabindex', '0')
          element.setAttribute('role', 'button')
          element.setAttribute('aria-label', mapFeatureLabel(feature))
          element.setAttribute('aria-pressed', String(row?.region === activeTrendRegion))
          L.DomEvent.on(element, 'focus', () => layer.setStyle({ color: '#f1faff', weight: 2.2, fillOpacity: 0.72 }))
          L.DomEvent.on(element, 'blur', () => geoLayer.resetStyle(layer))
          L.DomEvent.on(element, 'keydown', event => {
            if (event.key === 'Enter' || event.key === ' ') {
              L.DomEvent.preventDefault(event)
              L.DomEvent.stopPropagation(event)
              if (row?.region) setTrendRegion(row.region)
            }
          })
        })
      },
    }).addTo(map)
    layerRef.current = geoLayer
    if (!map._niwisMunicipalityBoundsFit && geoLayer.getBounds().isValid()) {
      map.fitBounds(geoLayer.getBounds(), { padding: [8, 8] })
      map._niwisMunicipalityBoundsFit = true
    }
    const frame = requestAnimationFrame(() => {
      if (mapRef.current === map) map.invalidateSize()
    })
    return () => cancelAnimationFrame(frame)
  }, [features, renderedFeatures, result, metric, mapMatches, mapFeatureStyle, hasMapData, activeTrendRegion, mapElement])

  const selectDataset = key => {
    const next = metadata?.datasets?.[key]
    setDatasetKey(key)
    setYear(next?.latest_year || '')
    setMetricKey(next?.default_metric || next?.metrics?.[0]?.key || '')
    setTrendRegion('National')
    setQuery('')
  }
  useEffect(() => {
    if (navigationSection && metadata?.datasets?.[navigationSection] && navigationSection !== datasetKey) selectDataset(navigationSection)
  }, [metadata, navigationSection, datasetKey])

  const summary = metadata?.datasets?.[datasetKey]
  const datasetTabs = Object.entries(metadata?.datasets || {})
  const nationalText = formatValue(nationalValue, metric?.unit)
  const selectedAudit = hasCurrentResult ? result?.audit?.metrics?.[metric?.key] : null

  return <div className="municipal-tariffs-dashboard">
    <header className="mt-heading">
      <div>
        <div className="mt-eyebrow">DASHBOARD 17 · DATABASE-DRIVEN MUNICIPAL VIEW</div>
        <h1>Water Tariffs &amp; Water Quality Costs</h1>
        <p>Explore raw-water tariffs, municipal pricing inputs and water-quality costs from the three source tables. Compare reported values by year and region, with each chart kept in the field's own unit.</p>
      </div>
      <div className="mt-source-badge"><Database size={15} aria-hidden="true" /> Three Supabase tables</div>
    </header>

    {error && <div className="mt-error" role="alert"><AlertTriangle size={17} /><span>{error}</span><button type="button" onClick={() => setRetry(value => value + 1)}><RefreshCw size={14} /> Retry</button></div>}
    {loading && !result && <div className="mt-loading" role="status">Loading database rows and reporting years…</div>}
    {error && !loading && <MonitoringMapPanel title="Water tariffs and treatment costs map" indicators={metrics} indicator={metric?.key} onIndicatorChange={setMetricKey} geographyAvailable={false} noDataReason="Tariff and treatment-cost observations could not be loaded. Geographic boundaries remain available without price values." />}

    {!error && metadata && <>
      <nav className="mt-tabs" aria-label="Dataset">
        {datasetTabs.map(([key, item]) => <button type="button" key={key} aria-pressed={datasetKey === key} onClick={() => selectDataset(key)}>{item.label}</button>)}
      </nav>

      <section className="mt-controls" aria-label="Dataset filters">
        <label>Reporting year<select value={year} onChange={event => setYear(event.target.value)}>{(summary?.years || []).slice().reverse().map(value => <option key={value} value={value}>{value}</option>)}</select></label>
        <div className="mt-control-note">{summary?.description}</div>
      </section>

      {hasCurrentResult && metric && <>
        <section className="mt-summary-grid" aria-label="Selected source value summary">
          <article><span>Source region records</span><strong>{result.coverage.source_municipality_rows.toLocaleString('en-ZA')}</strong><small>Database rows for {result.year}; National is shown separately</small></article>
          <article><span>Source regions with a valid map value</span><strong>{mappedValues.toLocaleString('en-ZA')}</strong><small>Each mapped source region is assigned to one municipality</small></article>
          <article className="mt-national-card"><span>National source row</span><strong>{nationalText}</strong><small>{metric.label} · kept separate from municipality polygons</small></article>
        </section>

        <section className="mt-panel mt-indicator-snapshot" aria-label="All indicator values for selected year">
          <header className="mt-panel-heading"><div><h2>Indicator snapshot · {result.year}</h2><p>Every field in {summary?.table}; choose a card to update the map and regional comparison.</p></div><code>{summary?.table}</code></header>
          <div className="mt-snapshot-grid">{snapshots.map(({ metric: item, valid, national, spread }) => <button type="button" key={item.key} disabled={!valid && (national === null || national === undefined)} aria-pressed={metric.key === item.key} className={`mt-snapshot-card${metric.key === item.key ? ' is-selected' : ''}`} onClick={() => setMetricKey(item.key)}>
            <span>{item.label}</span><small>{item.unit}</small><strong>{formatValue(national, item.unit)}</strong><em>National source value</em><code>{item.source_column}</code><footer>{valid} / {result.coverage.source_municipality_rows} source regions have a value</footer><p>{spread}</p>
          </button>)}</div>
        </section>

        <div className="mt-main-grid">
          <section className="mt-panel mt-map-panel" aria-label="Municipality map">
            <header className="mt-panel-heading">
              <div><h2>{summary?.label} by municipality</h2><p>Click a municipality to update regional charts · {metric.label} · {result.year} · {metric.unit}</p></div>
              <span className="mt-map-count"><MapPinned size={14} /> {renderedFeatures.length} polygons shaded · {mapMatches.matchedSourceRegionCount} source regions</span>
            </header>
            <div className="district-map-controls">
              <label className="district-map-control"><span>Map indicator</span><select aria-label="Map indicator" value={metric?.key || ''} onChange={event => setMetricKey(event.target.value)}>{metrics.map(item => <option key={item.key} value={item.key} disabled={Boolean(hasCurrentResult && !result.coverage.usable_by_metric[item.key])}>{item.label}{item.unit ? ` (${item.unit})` : ''}{hasCurrentResult && !result.coverage.usable_by_metric[item.key] ? ' · no values for this year' : ''}</option>)}</select></label>
              <div className="district-map-view-slot" ref={setMapToolbarTarget} />
              <label className="district-map-control"><span>District</span><select aria-label="Map district" value={selectedMapFeature ? (mapMatches.displayNameByCode.get(selectedMapFeature.properties?.CAT_B) || selectedMapFeature.properties?.MUNICNAME || '') : ''} onChange={event => selectMapDistrict(event.target.value)}><option value="">Select a district</option>{districtOptions.map(name => <option key={name}>{name}</option>)}</select></label>
            </div>
            <div className="mt-map-layout">
              <DashboardMap
                original={<div ref={setMapElement} className="mt-map" style={{ width: '100%' }} aria-label={`${metric.label} municipality choropleth for ${result.year}`} />}
                features={features}
                featureStyle={mapFeatureStyle}
                featureLabel={mapFeatureLabel}
                onFeatureSelect={selectMapFeature}
                selectedFeature={selectedMapFeature}
                mapLabel={`${metric.label} municipality map for ${result.year}`}
                height={600}
                toolbarTarget={mapToolbarTarget}
              />
              <aside className="mt-legend" aria-label={`${metric.label} map legend`}>
                <h3>What the colors mean</h3>
                <p>{metric.type === 'category' ? 'Colors identify the drought category recorded in the source.' : 'Ranges are calculated from valid municipality values for this indicator and year.'}</p>
                <ul>{legend.map(item => <li key={item.range}><i style={{ backgroundColor: item.color }} /><span>{item.range}</span></li>)}</ul>
                <small>{metric.type === 'category' ? 'D0 through D4 follow the drought categories recorded in the source.' : 'Colors show recorded values; interpret them using the indicator unit and source context.'} Grey boundaries have no valid measurement or no verified source match; missing values are not zero.</small>
              </aside>
            </div>
            {!mapTilerConfigured && <p className="mt-map-notice">Satellite imagery is not configured yet. Municipality data colors still work; add a server-side MapTiler key to show the imagery.</p>}
            {mapTilerError && <p className="mt-map-notice" role="status">{mapTilerError} <button type="button" onClick={() => setMapTileRetry(value => value + 1)}>Retry satellite</button></p>}
            {boundaryError && <p className="mt-map-notice" role="alert">{boundaryError}</p>}
            {!boundaryError && renderedFeatures.length === 0 && <p className="mt-map-notice">No municipality has a valid value for this indicator and year. Boundaries remain available without measurement shading. Choose another year or indicator.</p>}
            {mapMatches.cityAliases.map(alias => <p className="mt-map-notice" key={alias.code}>City-name crosswalk: source region “{alias.source}” is shown at {alias.display} ({alias.code}).</p>)}
            {(mapMatches.ambiguous.length > 0 || mapMatches.unmatched.length > 0) && <p className="mt-map-notice">{mapMatches.ambiguous.length > 0 && <>Names with multiple municipality matches and no city crosswalk: {mapMatches.ambiguous.map(item => item.region).join(', ')}. </>}{mapMatches.unmatched.length > 0 && <>No boundary match for: {mapMatches.unmatched.join(', ')}.</>}</p>}
            <div className="mt-attribution">Boundary source: <a href={metadata.boundaries.source_url} target="_blank" rel="noreferrer">{metadata.boundaries.label}</a>. Historic records use current boundaries because the source has no boundary-year code.</div>
          </section>

          <section className="mt-panel mt-register" aria-label="Source region values">
            <header className="mt-panel-heading"><div><h2>Source region values</h2><p>Recorded values for {result.year}</p></div></header>
            <label className="mt-search">Find a source region<input value={query} onChange={event => setQuery(event.target.value)} placeholder="Type a region or municipality" /></label>
            <div className="mt-register-head"><span>Source region</span><span>{metric.label}</span></div>
            <div className="mt-register-list">
              {visibleRows.map(row => <div className="mt-register-row" key={row.region}><span title={`Source name: ${row.region}`}>{displayRegionName(row.region)}{displayRegionName(row.region) !== row.region && <small>Source name: {row.region}</small>}</span><strong>{formatValue(row.value, metric.unit)}</strong></div>)}
              {!visibleRows.length && <p className="mt-no-results">No source regions match that search.</p>}
            </div>
          </section>
        </div>

        <section className="mt-visualization-grid" aria-label="Tariff and water-quality visualizations">
          <section className="mt-panel mt-trend-panel">
            <header className="mt-panel-heading">
              <div><h2>Reported value over time</h2><p>{metric.label} · one source region · years and periods as reported</p></div>
              <label className="mt-trend-region">Source region<select aria-label="Trend source region" value={activeTrendRegion} onChange={event => setTrendRegion(event.target.value)}>{trendRegions.map(region => <option key={region} value={region}>{region === 'National' ? 'National source row' : displayRegionName(region)}</option>)}</select></label>
            </header>
            {historyLoading && <div className="mt-chart-empty" role="status">Loading historical source records…</div>}
            {historyError && <div className="mt-chart-empty" role="alert">{historyError}</div>}
            {!historyLoading && !historyError && focusedTrend?.coverage?.valid_values > 0 && metric.type === 'numeric' && <>
              <div className="mt-chart-meta"><span>{metric.unit}</span><span>{focusedTrend.coverage.valid_values} valid values · blank years are left as gaps</span></div>
              <div className="mt-chart" role="img" aria-label={`${metric.label} by year for ${analytics.region}`}>
                <ResponsiveContainer width="100%" height="100%"><LineChart data={focusedTrend.points} margin={{ top: 12, right: 15, left: 6, bottom: 8 }}>
                  <CartesianGrid stroke="#29485e" strokeDasharray="3 5" vertical={false} />
                  <XAxis dataKey="year" tick={{ fill: '#9bb6c7', fontSize: 10 }} tickLine={false} axisLine={{ stroke: '#45647a' }} minTickGap={25} />
                  <YAxis tick={{ fill: '#9bb6c7', fontSize: 9 }} tickFormatter={formatAxisValue} width={62} tickLine={false} axisLine={false} domain={['auto', 'auto']} />
                  <Tooltip content={<SourceTrendTooltip unit={metric.unit} />} cursor={{ stroke: '#91b7c5', strokeDasharray: '4 4' }} />
                  <Line type="linear" dataKey="value" name={metric.label} stroke={chartColor('#62ceb9')} strokeWidth={2.5} dot={{ r: 3, fill: chartColor('#62ceb9'), stroke: 'var(--dashboard-surface-solid, #0c263a)', strokeWidth: 1.5 }} activeDot={{ r: 5 }} connectNulls={false} isAnimationActive={false} />
                </LineChart></ResponsiveContainer>
              </div>
            </>}
            {!historyLoading && !historyError && focusedTrend?.coverage?.valid_values > 0 && metric.type === 'category' && <>
              <p className="mt-chart-meta"><span>Drought categories recorded by source</span><span>{focusedTrend.coverage.valid_values} valid category records</span></p>
              <div className="mt-category-timeline" role="img" aria-label={`${metric.label} history for ${analytics.region}`}>
                {focusedTrend.points.map(point => <div key={point.year} title={`${point.year}: ${point.value ? `${point.value} · ${DROUGHT_LABELS[point.value]}` : 'No valid category recorded'}${point.source_period ? ` · ${point.source_period}` : ''}`}>
                  <i style={{ background: point.value ? DROUGHT_COLORS[point.value] : NO_VALUE }} /><span>{point.year}</span><small>{point.value || 'No record'}</small>
                </div>)}
              </div>
              <p className="mt-chart-note">D0–D4 are shown as named categories; gaps mean the source has no valid category for that year.</p>
            </>}
            {!historyLoading && !historyError && focusedTrend?.coverage?.valid_values === 0 && <div className="mt-chart-empty">The selected source region has no valid values for this indicator.</div>}
            {!analytics && !historyLoading && !historyError && <div className="mt-chart-empty">Choose a source region to view its yearly records.</div>}
          </section>

          <section className="mt-panel mt-comparison-panel">
            <header className="mt-panel-heading"><div><h2>{metric.type === 'category' ? 'Reported category counts' : activeTrendRegion === 'National' ? 'Highest reported region values' : 'Highest values + selected municipality'}</h2><p>{metric.type === 'category' ? `Valid source rows · ${result.year}` : `${metric.label} · ${result.year} · ${metric.unit}`}</p></div></header>
            {comparisonData.length > 0 && <>
              <div className="mt-chart-meta"><span>{metric.type === 'category' ? 'Number of source regions' : 'Source region values'}</span><span>{activeTrendRegion === 'National' ? 'National source row is kept separate' : `${displayRegionName(activeTrendRegion)} is highlighted`}</span></div>
              <div className="mt-chart mt-comparison-chart" role="img" aria-label={metric.type === 'category' ? `${metric.label} category counts for ${result.year}` : `Highest ${metric.label} source region values in ${result.year}`}>
                <ResponsiveContainer width="100%" height="100%"><BarChart data={comparisonData} layout="vertical" margin={{ top: 5, right: 18, left: 8, bottom: 5 }}>
                  <CartesianGrid stroke="#29485e" strokeDasharray="3 5" horizontal={false} />
                  <XAxis type="number" tick={{ fill: '#9bb6c7', fontSize: 9 }} tickFormatter={formatAxisValue} tickLine={false} axisLine={{ stroke: '#45647a' }} />
                  <YAxis type="category" dataKey="region" width={125} tick={{ fill: '#b9ceda', fontSize: 9 }} tickLine={false} axisLine={false} />
                  <Tooltip formatter={(value, _name, item) => [metric.type === 'category' ? `${value} source regions` : formatValue(value, metric.unit), item.payload.region]} contentStyle={{ border: '1px solid #45647a', borderRadius: 6, background: '#0b2237', color: '#e5f2fa' }} />
                  <Bar dataKey={metric.type === 'category' ? 'count' : 'value'} fill={chartColor('#49bca9')} radius={[0, 4, 4, 0]} maxBarSize={22} isAnimationActive={false}>
                    {comparisonData.map(item => <Cell key={item.region} fill={chartColor(item.selected ? '#f2d879' : '#49bca9')} />)}
                  </Bar>
                </BarChart></ResponsiveContainer>
              </div>
            </>}
            {comparisonData.length === 0 && <div className="mt-chart-empty">No valid values are available to compare for this year.</div>}
            <p className="mt-chart-note">{metric.type === 'category' ? 'Counts include only source regions with a valid recorded category.' : 'Each bar is a source region. Values are ranked as reported and are not combined into a tariff total.'}</p>
          </section>
        </section>

        <section className="mt-panel mt-history-gallery" aria-label="Historical indicator charts">
          <header className="mt-panel-heading"><div><h2>Historical trends · every indicator</h2><p>Charts follow the selected map region. Select an indicator name to focus it on the map.</p></div><span className="mt-gallery-region">{activeTrendRegion === 'National' ? 'National source row' : displayRegionName(activeTrendRegion)}</span></header>
          {historyLoading && <div className="mt-chart-empty" role="status">Loading indicator histories…</div>}
          {historyError && <div className="mt-chart-empty" role="alert">{historyError}</div>}
          {!historyLoading && !historyError && analytics && <div className="mt-indicator-grid">{analytics.indicators.map(item => <IndicatorTrendCard key={item.key} indicator={item} selected={item.key === metric.key} selectedYear={year} region={activeTrendRegion} onSelect={setMetricKey} />)}</div>}
        </section>

        <section className="mt-panel mt-coverage-panel" aria-label="Source data coverage by indicator and year">
          <header className="mt-panel-heading"><div><h2>Source coverage by year</h2><p>Color shows the share of source-region rows with a valid value for each indicator. Click a year to update the whole dashboard.</p></div></header>
          {historyLoading ? <div className="mt-chart-empty" role="status">Loading year-by-indicator coverage…</div> : historyError ? <div className="mt-chart-empty" role="alert">{historyError}</div> : analytics?.coverage_by_year?.length > 0 ? <>
            <div className="mt-coverage-legend" aria-label="Coverage legend">
              {[['#24506a', '1–24%'], ['#18788a', '25–49%'], ['#1e9e9b', '50–74%'], ['#66c3a8', '75–99%'], ['#c6e58e', '100%'], [NO_VALUE, 'No valid value']].map(([color, label]) => <span key={label}><i style={{ background: color }} />{label}</span>)}
            </div>
            <div className="mt-coverage-scroll"><table className="mt-coverage-table"><thead><tr><th scope="col">Indicator</th>{analytics.coverage_by_year.map(row => <th scope="col" key={row.year}>{row.year}</th>)}</tr></thead><tbody>{metrics.map(item => <tr key={item.key}><th scope="row">{item.label}<small>{item.unit}</small></th>{analytics.coverage_by_year.map(row => {
              const valid = row.valid_by_metric[item.key] || 0
              const total = row.source_region_rows
              const percent = total ? Math.round((valid / total) * 100) : 0
              return <td key={row.year}><button type="button" aria-label={`${item.label}, ${row.year}: ${valid} of ${total} source regions with valid values (${percent}%). Select year.`} aria-pressed={Number(year) === row.year} title={`${item.label} · ${row.year}: ${valid}/${total} valid source regions (${percent}%)`} style={{ backgroundColor: coverageColor(valid, total) }} onClick={() => setYear(String(row.year))} /></td>
            })}</tr>)}</tbody></table></div>
            <p className="mt-chart-note">The denominator is source-region records present in that year; National is excluded. A gray cell means no source region has a valid value for that field.</p>
          </> : <div className="mt-chart-empty">Yearly coverage is not available for this source selection.</div>}
        </section>

        <details className="mt-methods">
          <summary>How to read this map and the source values</summary>
          <ul>{metadata.notes.map(note => <li key={note}>{note}</li>)}
            <li>Null, malformed, non-finite and out-of-range percentage values are not colored. Their source quality counts appear below.</li>
            <li>For water-quality costs, the tables do not state measurement units, so no unit is inferred.</li>
          </ul>
          <div className="mt-quality-grid">{metric && selectedAudit ? <article><b>{metric.label}</b><span>{(selectedAudit.usable ?? 0).toLocaleString('en-ZA')} valid · {(selectedAudit.missing ?? 0).toLocaleString('en-ZA')} missing · {(selectedAudit.invalid ?? 0).toLocaleString('en-ZA')} invalid across all years</span><code>{metric.source_column}</code></article> : <p>Source quality counts are unavailable for this selection.</p>}</div>
        </details>
      </>}
    </>}
  </div>
}
