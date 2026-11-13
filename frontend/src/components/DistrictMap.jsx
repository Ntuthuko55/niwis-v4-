import ProvinceMapLabels from './ProvinceMapLabels'
import { useEffect, useMemo, useState } from 'react'
import MunicipalityMapLabel from './MunicipalityMapLabel'
import DashboardMap from './DashboardMap'
import useDistrictBoundaries from '../services/useDistrictBoundaries'
import { districtProvince } from '../services/districtGeography'
import '../niwis/monitoring-map.css'

const DISTRICT_VALUE_COLORS = ['#235373', '#298ca5', '#46bfb5', '#9aead2']
const NO_VALUE_COLOR = '#647582'
const EMPTY = []

export function buildStandardizedIndexScale(label = 'Standardized drought index') {
  const classes = [
    { color: '#a52a35', range: '≤ −2', meaning: 'Extremely dry' },
    { color: '#d5683b', range: '> −2 to ≤ −1.5', meaning: 'Severely dry' },
    { color: '#eebc70', range: '> −1.5 to ≤ −1', meaning: 'Moderately dry' },
    { color: '#c7d9cc', range: '> −1 to < 1', meaning: 'Near normal' },
    { color: '#8fcbd1', range: '1 to < 1.5', meaning: 'Moderately wet' },
    { color: '#408fb5', range: '1.5 to < 2', meaning: 'Very wet' },
    { color: '#23568c', range: '≥ 2', meaning: 'Extremely wet' },
  ]
  return {
    color: value => classes[value <= -2 ? 0 : value <= -1.5 ? 1 : value <= -1 ? 2 : value < 1 ? 3 : value < 1.5 ? 4 : value < 2 ? 5 : 6].color,
    legend: { title: label, classes },
  }
}

export function buildDistrictMapScale(rows, valueKey, label, unit, formatValue, totalDistricts = rows.length) {
  const values = rows.map(row => row?.[valueKey]).filter(value => typeof value === 'number' && Number.isFinite(value))
  const title = `${label || valueKey}${unit ? ` (${unit})` : ''}`
  const missing = Math.max(0, totalDistricts - values.length)
  const display = value => formatValue ? formatValue(value) : Number(value).toLocaleString('en-ZA', { maximumFractionDigits: 2 })
  const noValue = missing ? [{ color: NO_VALUE_COLOR, range: 'No value', meaning: `${missing} districts have no observation` }] : []

  if (!values.length) {
    return { color: () => NO_VALUE_COLOR, legend: { title, classes: [{ color: NO_VALUE_COLOR, range: 'No values', meaning: 'No usable source observations' }] } }
  }

  const min = Math.min(...values), max = Math.max(...values)
  if (min === max) {
    return {
      color: () => DISTRICT_VALUE_COLORS[2],
      legend: { title, classes: [{ color: DISTRICT_VALUE_COLORS[2], range: display(min), meaning: `Same source value in ${values.length} districts` }, ...noValue] },
    }
  }

  const bounds = Array.from({ length: 5 }, (_, index) => min + ((max - min) * index) / 4)
  const classes = DISTRICT_VALUE_COLORS.map((color, index) => ({
    color,
    range: `${index ? `≥${display(bounds[index])}` : display(bounds[index])}–${index < 3 ? `<${display(bounds[index + 1])}` : display(bounds[index + 1])}`,
    meaning: ['Lowest values', 'Lower-middle', 'Upper-middle', 'Highest values'][index],
  }))
  return {
    color: value => DISTRICT_VALUE_COLORS[Math.min(3, Math.max(0, Math.floor(((value - min) / (max - min)) * 4)))],
    legend: { title, classes: [...classes, ...noValue] },
  }
}

export function normaliseDistrictName(name = '') { const key = String(name ?? '').toLowerCase().replace(/^city of /, '').replace(/[^a-z0-9]/g, ''); return ({ cacadu: 'sarahbaartman', eden: 'gardenroute', sisonke: 'harrygwala', uthungulu: 'kingcetshwayo', siyanda: 'zfmgcawu', greatersekhukhune: 'sekhukhune' })[key] || key }

const project = ([lon, lat]) => [((lon - 16.45) / 16.5) * 680, ((-22.12 - lat) / 12.75) * 560]
const geometryCache = new WeakMap()
function displayGeometry(geometry) {
  if (!geometry) return { path: '', centroid: null }
  if (geometryCache.has(geometry)) return geometryCache.get(geometry)
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.type === 'MultiPolygon' ? geometry.coordinates : []
  const path = polygons.flatMap(polygon => polygon.map(ring => ring.map((point, index) => {
    const [x, y] = project(point)
    return `${index ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`
  }).join(' ') + 'Z')).join(' ')
  const ring = polygons.map(polygon => polygon[0]).filter(Boolean).sort((a, b) => b.length - a.length)[0]
  const centroid = ring?.length ? ring.reduce(([x, y], point) => [x + point[0] / ring.length, y + point[1] / ring.length], [0, 0]) : null
  const result = { path, centroid }
  geometryCache.set(geometry, result)
  return result
}

export function DistrictMap({ districts: suppliedDistricts, values = {}, colorFn, valueKey = 'NDVI', onSelect, selected, legend: customLegend, markerRows = EMPTY, markerDistrictKey = 'District_Name', markerLabelKey = 'dam_name', markerValueKey, valueLabel, valueUnit, formatValue, mapId, showRegionFilters = true, fixedView }) {
  const boundaryState = useDistrictBoundaries(suppliedDistricts)
  const allDistricts = boundaryState.features
  const [province, setProvince] = useState('')
  const districts = useMemo(() => province ? allDistricts.filter(feature => districtProvince(feature.properties?.shapeName) === province) : allDistricts, [allDistricts, province])
  const provinces = useMemo(() => [...new Set(allDistricts.map(feature => districtProvince(feature.properties?.shapeName)).filter(Boolean))].sort(), [allDistricts])
  useEffect(() => { if (selected) setProvince(current => current && districtProvince(selected) !== current ? '' : current) }, [selected])
  const observationCount = districts.filter(feature => { const value = values[normaliseDistrictName(feature.properties?.shapeName)]?.[valueKey]; return typeof value === 'number' && Number.isFinite(value) }).length
  const noDataCount = districts.length - observationCount
  const automaticScale = buildDistrictMapScale(Object.values(values), valueKey, valueLabel, valueUnit, formatValue, districts.length)
  const dataColor = colorFn || automaticScale.color
  const [hovered, setHovered] = useState(null)
  const featuresByName = useMemo(() => new Map(districts.map(feature => [normaliseDistrictName(feature.properties?.shapeName), feature])), [districts])
  const selectedFeature = featuresByName.get(normaliseDistrictName(selected))
  const activeFeature = districts.find(feature => feature.properties?.shapeName === hovered) || selectedFeature
  const pathFor = geometry => displayGeometry(geometry).path
  const markerMetric = markerValueKey || valueKey
  const displayValue = value => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return 'No usable observation'
    const rendered = formatValue ? formatValue(Number(value)) : Number(value).toFixed(2)
    return `${rendered}${valueUnit ? ` ${valueUnit}` : ''}`
  }
  const markers = markerRows.filter(row => !province || districtProvince(row?.[markerDistrictKey] || row?.district_name) === province).map(row => {
    const districtName = row?.[markerDistrictKey] || row?.district_name
    const feature = featuresByName.get(normaliseDistrictName(districtName))
    const latitude = Number(row?.marker_latitude), longitude = Number(row?.marker_longitude)
    const point = row?.marker_latitude != null && row?.marker_longitude != null && Number.isFinite(latitude) && Number.isFinite(longitude) ? [longitude, latitude] : feature && displayGeometry(feature.geometry).centroid
    return point ? { row, districtName, point, label: row?.marker_label || row?.[markerLabelKey] || districtName } : null
  }).filter(Boolean)
  const legend = observationCount ? customLegend || MAP_LEGENDS[valueKey] || automaticScale.legend : { title: valueLabel || customLegend?.title || valueKey, classes: [{ color: NO_VALUE_COLOR, range: 'No observation', meaning: 'Monitoring measurements unavailable for this selection' }] }
  const featureStyle = feature => {
    const name = feature.properties?.shapeName || 'Unknown district'
    const value = values[normaliseDistrictName(name)]?.[valueKey]
    const isSelected = normaliseDistrictName(name) === normaliseDistrictName(selected)
    return { fillColor: (typeof value !== 'number' || !Number.isFinite(value)) ? NO_VALUE_COLOR : dataColor(value), fillOpacity: 0.68, color: isSelected ? 'var(--map-selection-stroke, #ffffff)' : '#0a1b25', weight: isSelected ? 2.4 : 0.8 }
  }
  const featureLabel = feature => {
    const name = feature.properties?.shapeName || 'Unknown district'
    return `${name} · ${valueLabel || valueKey}: ${displayValue(values[normaliseDistrictName(name)]?.[valueKey])}`
  }
  const geographicMarkers = markers.map(({ row, districtName, point, label }, index) => {
    const value = row?.[markerMetric]
    const precision = row?.marker_precision || 'district-centroid proxy'
    const source = row?.marker_source ? `; ${row.marker_source}` : '; source coordinates not supplied'
    return {
      id: `${districtName}-${label}-${index}`,
      longitude: point[0], latitude: point[1],
      color: (typeof value !== 'number' || !Number.isFinite(value)) ? '#72828a' : dataColor(value),
      radius: normaliseDistrictName(districtName) === normaliseDistrictName(selected) ? 6 : 4.5,
      label: `${label} · ${districtName} · ${markerMetric} ${value == null ? 'No data' : Number(value).toFixed(2)} · ${precision}${source}`,
      onSelect: () => onSelect?.(districtName),
    }
  })
  const originalMap = <svg viewBox="0 0 680 560" role="img" aria-label={`${legend.title} map`}>{districts.map((feature) => {
    const name = feature.properties?.shapeName || 'Unknown district'
    const value = values[normaliseDistrictName(name)]?.[valueKey]
    return <path key={feature.properties?.shapeID || name} d={pathFor(feature.geometry)} fill={(typeof value !== 'number' || !Number.isFinite(value)) ? NO_VALUE_COLOR : dataColor(value)} stroke={normaliseDistrictName(name) === normaliseDistrictName(selected) ? 'var(--map-selection-stroke, #ffffff)' : '#0a1b25'} strokeWidth={normaliseDistrictName(name) === normaliseDistrictName(selected) ? '2.4' : '.8'} role="button" tabIndex={0} aria-label={`${name}${valueLabel ? ` · ${valueLabel}: ${displayValue(value)}` : ''}`} aria-pressed={normaliseDistrictName(name) === normaliseDistrictName(selected)} onMouseEnter={() => setHovered(name)} onMouseLeave={() => setHovered(null)} onFocus={() => setHovered(name)} onBlur={() => setHovered(null)} onClick={() => onSelect?.(name)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect?.(name) } }}><title>{`${name} · ${valueLabel || valueKey}: ${displayValue(value)}`}</title></path>
  })}{markers.map(({ row, districtName, point, label }) => { const [x, y] = project(point); const value = row?.[markerMetric]; const selectedMarker = normaliseDistrictName(districtName) === normaliseDistrictName(selected); const fill = (typeof value !== 'number' || !Number.isFinite(value)) ? '#72828a' : dataColor(value); const precision = row?.marker_precision || 'district-centroid proxy'; const source = row?.marker_source ? `; ${row.marker_source}` : '; source coordinates not supplied'; return <circle key={`marker-${districtName}-${label}`} cx={x} cy={y} r={selectedMarker ? 6 : 4.5} fill={fill} stroke={selectedMarker ? 'var(--map-selection-stroke, #ffffff)' : '#09202d'} strokeWidth={selectedMarker ? 2 : 1.2} role="button" tabIndex={0} aria-label={`${label} in ${districtName}`} onMouseEnter={() => setHovered(districtName)} onMouseLeave={() => setHovered(null)} onFocus={() => setHovered(districtName)} onBlur={() => setHovered(null)} onClick={() => onSelect?.(districtName)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect?.(districtName) } }}><title>{`${label} · ${districtName} · ${markerMetric} ${value == null ? 'No data' : Number(value).toFixed(2)} · ${precision}${source}`}</title></circle> })}<ProvinceMapLabels project={project} /><MunicipalityMapLabel feature={activeFeature} project={project} /></svg>
  return <div className="municipality-map">
    {showRegionFilters && <div className="district-map-filters"><label>Province extent<select aria-label={`${valueLabel || valueKey} map province`} value={province} onChange={event => setProvince(event.target.value)}><option value="">All provinces</option>{provinces.map(name => <option key={name}>{name}</option>)}</select></label>{onSelect && <label>District<select aria-label={`${valueLabel || valueKey} map district`} value={districts.some(feature => normaliseDistrictName(feature.properties?.shapeName) === normaliseDistrictName(selected)) ? districts.find(feature => normaliseDistrictName(feature.properties?.shapeName) === normaliseDistrictName(selected)).properties.shapeName : ''} onChange={event => { if (event.target.value) onSelect(event.target.value) }}><option value="">Select a district</option>{districts.map(feature => <option key={feature.properties.shapeName}>{feature.properties.shapeName}</option>)}</select></label>}</div>}
    {boundaryState.error && <p className="district-map-observation-state" role="status">{boundaryState.error}<button type="button" onClick={boundaryState.retry}>Retry boundaries</button></p>}
    {!observationCount && <p className="district-map-observation-state" role="status">{districts.length ? `No ${valueLabel || valueKey} observations are available for the selected area and period. Grey boundaries remain selectable; missing values are not zero.` : boundaryState.error ? 'Map boundaries are currently unavailable.' : 'Loading district boundaries...'}</p>}
    <div className="sat-district-map dashboard-map-frame"><DashboardMap original={originalMap} features={districts} featureStyle={featureStyle} featureLabel={featureLabel} onFeatureSelect={feature => onSelect?.(feature.properties?.shapeName)} onFeatureHover={feature => setHovered(feature?.properties?.shapeName || null)} selectedFeature={selectedFeature} markers={geographicMarkers} mapLabel={`${legend.title} district map`} mapId={`${mapId || 'district'}:${valueKey}`} fixedView={fixedView} /><MapLegend {...legend} noDataCount={observationCount ? noDataCount : 0} /></div>
    <div className="municipality-map-caption" aria-live="polite">{activeFeature ? <><span>Mapped area</span><strong>{activeFeature.properties.shapeName}</strong><><span>{valueLabel || valueKey}</span><strong>{displayValue(values[normaliseDistrictName(activeFeature.properties.shapeName)]?.[valueKey])}</strong></></> : <span>Hover over or select a mapped area to see its name and source measurement.</span>}</div>
  </div>
}

function MapLegend({ title, gradient, items = [], classes, noDataCount = 0 }) {
  return <div className="map-color-legend" aria-label={`${title} color legend`} style={{ display: 'grid', alignContent: 'center', gap: 6, minWidth: 104, padding: '4px 2px', color: '#8fb7c8', fontSize: 9, lineHeight: 1.2 }}>
    <strong style={{ color: '#e4f4fa', fontSize: 10 }}>{title}</strong>
    {classes ? <ul style={{ display: 'grid', alignContent: 'center', gap: 6, margin: 0, padding: 0, listStyle: 'none' }}>{classes.map((item, index) => <li key={`${item.range}-${index}`} style={{ display: 'grid', gridTemplateColumns: '9px minmax(0, 1fr)', alignItems: 'start', gap: 5 }}><i style={{ display: 'block', width: 9, height: 9, marginTop: 1, borderRadius: 2, background: item.color, border: '1px solid rgba(255,255,255,.25)' }} aria-hidden="true" /><span style={{ display: 'grid', gap: 1 }}><b style={{ color: '#eef8fb', fontSize: 8 }}>{item.range}</b><span style={{ fontSize: 7 }}>{item.meaning}</span></span></li>)}</ul> : <div style={{ display: 'grid', gridTemplateColumns: '10px 1fr', gap: 6, minHeight: 126 }}>
      <i style={{ display: 'block', width: 10, minHeight: 126, borderRadius: 3, background: gradient, border: '1px solid rgba(255,255,255,.25)' }} aria-hidden="true" />
      <ul style={{ display: 'grid', alignContent: 'space-between', margin: 0, padding: 0, listStyle: 'none' }}>{items.map(([range, meaning], index) => <li key={`${String(range)}-${index}`} style={{ display: 'grid', gap: 1 }}><b style={{ color: '#eef8fb', fontSize: 9 }}>{range}</b><span style={{ fontSize: 8 }}>{meaning}</span></li>)}</ul>
    </div>}
    {noDataCount > 0 && <span className="district-map-legend-missing"><i aria-hidden="true" />No observation ({noDataCount})</span>}
  </div>
}

const NDVI_LEGEND = { title: 'NDVI color scale', gradient: 'linear-gradient(180deg, #64c968, #f4dc45, #fa8c25, #f04444)', items: [['0.8-1.0', 'Very high'], ['0.6-0.8', 'High'], ['0.4-0.6', 'Moderate'], ['0.2-0.4', 'Low'], ['0.0-0.2', 'Very low']] }
const MOISTURE_LEGEND = { title: 'Soil moisture (m3/m3)', gradient: 'linear-gradient(180deg, #2d97c7, #4dc7c7, #75d36a, #f6ad3c)', items: [['0.19+', 'Very wet'], ['0.13-0.19', 'Wet'], ['0.08-0.13', 'Moderate'], ['Below 0.08', 'Dry']] }
const WATER_LEGEND = { title: 'Surface water extent (km2)', gradient: 'linear-gradient(180deg, #7be3ed, #25aac9, #226f92, #1d3441)', items: [['120+', 'Extensive'], ['45-120', 'High'], ['10-45', 'Moderate'], ['Below 10', 'Low']] }
const GRACE_LEGEND = { title: 'GRACE anomaly (cm)', gradient: 'linear-gradient(180deg, #3fa6d5, #62c977, #f5df4b, #fa9037, #e9474e)', items: [['5+', 'Very wet'], ['2-5', 'Wet'], ['-1 to 2', 'Near normal'], ['-4 to -1', 'Dry'], ['Below -4', 'Very dry']] }
const MAP_LEGENDS = { spi_3: { title: 'SPI-3', gradient: 'linear-gradient(180deg, #2196c4, #64c968, #f4dc45, #fa8c25, #f04444)', items: [['Above 1', 'Wet'], ['-1 to 1', 'Near normal'], ['-1.5 to -1', 'Moderately dry'], ['-2 to -1.5', 'Severely dry'], ['Below -2', 'Extremely dry']] }, NDVI: NDVI_LEGEND, surface_soil_moisture: MOISTURE_LEGEND, rootzone_soil_moisture: MOISTURE_LEGEND, surface_water_extent_km2: WATER_LEGEND, GRACE_TWS: GRACE_LEGEND }

export function NdviLegend() {
  return <MapLegend {...NDVI_LEGEND} />
}


MAP_LEGENDS.ssi_dimensionless = { ...MAP_LEGENDS.spi_3, title: 'SSI' }
