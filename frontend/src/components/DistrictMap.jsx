import ProvinceMapLabels from './ProvinceMapLabels'
import { useMemo, useState } from 'react'
import MunicipalityMapLabel from './MunicipalityMapLabel'

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

export function DistrictMap({ districts, values, colorFn, valueKey = 'NDVI', onSelect, selected, legend: customLegend, markerRows = [], markerDistrictKey = 'District_Name', markerLabelKey = 'dam_name', markerValueKey }) {
  const [hovered, setHovered] = useState(null)
  const featuresByName = useMemo(() => new Map(districts.map(feature => [normaliseDistrictName(feature.properties?.shapeName), feature])), [districts])
  const selectedFeature = featuresByName.get(normaliseDistrictName(selected))
  const activeFeature = districts.find(feature => feature.properties?.shapeName === hovered) || selectedFeature
  const pathFor = geometry => displayGeometry(geometry).path
  const markerMetric = markerValueKey || valueKey
  const markers = markerRows.map(row => {
    const districtName = row?.[markerDistrictKey] || row?.district_name
    const feature = featuresByName.get(normaliseDistrictName(districtName))
    const latitude = Number(row?.marker_latitude), longitude = Number(row?.marker_longitude)
    const point = row?.marker_latitude != null && row?.marker_longitude != null && Number.isFinite(latitude) && Number.isFinite(longitude) ? [longitude, latitude] : feature && displayGeometry(feature.geometry).centroid
    return point ? { row, districtName, point, label: row?.marker_label || row?.[markerLabelKey] || districtName } : null
  }).filter(Boolean)
  const legend = customLegend || MAP_LEGENDS[valueKey] || NDVI_LEGEND
  return <div className="municipality-map"><div className="sat-district-map"><svg viewBox="0 0 680 560" role="img" aria-label={`${legend.title} map`}>{districts.map((feature) => {
    const name = feature.properties?.shapeName || 'Unknown district'
    const value = values[normaliseDistrictName(name)]?.[valueKey]
    return <path key={feature.properties?.shapeID || name} d={pathFor(feature.geometry)} fill={value == null ? '#254251' : colorFn(value)} stroke={normaliseDistrictName(name) === normaliseDistrictName(selected) ? '#ffffff' : '#0a1b25'} strokeWidth={normaliseDistrictName(name) === normaliseDistrictName(selected) ? '2.4' : '.8'} role="button" tabIndex={0} aria-label={name} aria-pressed={normaliseDistrictName(name) === normaliseDistrictName(selected)} onMouseEnter={() => setHovered(name)} onMouseLeave={() => setHovered(null)} onFocus={() => setHovered(name)} onBlur={() => setHovered(null)} onClick={() => onSelect(name)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(name) } }}><title>{`${name} · ${valueKey} ${value == null ? 'No data' : value.toFixed(2)}`}</title></path>
  })}{markers.map(({ row, districtName, point, label }) => { const [x, y] = project(point); const value = row?.[markerMetric]; const selectedMarker = normaliseDistrictName(districtName) === normaliseDistrictName(selected); const fill = value == null ? '#72828a' : colorFn(value); const precision = row?.marker_precision || 'district-centroid proxy'; const source = row?.marker_source ? `; ${row.marker_source}` : '; source coordinates not supplied'; return <circle key={`marker-${districtName}-${label}`} cx={x} cy={y} r={selectedMarker ? 6 : 4.5} fill={fill} stroke={selectedMarker ? '#ffffff' : '#09202d'} strokeWidth={selectedMarker ? 2 : 1.2} role="button" tabIndex={0} aria-label={`${label} in ${districtName}`} onMouseEnter={() => setHovered(districtName)} onMouseLeave={() => setHovered(null)} onFocus={() => setHovered(districtName)} onBlur={() => setHovered(null)} onClick={() => onSelect?.(districtName)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect?.(districtName) } }}><title>{`${label} · ${districtName} · ${markerMetric} ${value == null ? 'No data' : Number(value).toFixed(2)} · ${precision}${source}`}</title></circle> })}<ProvinceMapLabels project={project} /><MunicipalityMapLabel feature={activeFeature} project={project} /></svg><MapLegend {...legend} /></div>
    <div className="municipality-map-caption" aria-live="polite">{activeFeature ? <><span>Municipality / district</span><strong>{activeFeature.properties.shapeName}</strong></> : <span>Hover over or select a municipality to see its name.</span>}</div>
  </div>
}

function MapLegend({ title, gradient, items }) {
  return <div className="map-color-legend" aria-label={`${title} color legend`} style={{ display: 'grid', alignContent: 'center', gap: 6, minWidth: 104, padding: '4px 2px', color: '#8fb7c8', fontSize: 9, lineHeight: 1.2 }}>
    <strong style={{ color: '#e4f4fa', fontSize: 10 }}>{title}</strong>
    <div style={{ display: 'grid', gridTemplateColumns: '10px 1fr', gap: 6, minHeight: 126 }}>
      <i style={{ display: 'block', width: 10, minHeight: 126, borderRadius: 3, background: gradient, border: '1px solid rgba(255,255,255,.25)' }} aria-hidden="true" />
      <ul style={{ display: 'grid', alignContent: 'space-between', margin: 0, padding: 0, listStyle: 'none' }}>{items.map(([range, meaning], index) => <li key={`${String(range)}-${index}`} style={{ display: 'grid', gap: 1 }}><b style={{ color: '#eef8fb', fontSize: 9 }}>{range}</b><span style={{ fontSize: 8 }}>{meaning}</span></li>)}</ul>
    </div>
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
