// Reference coordinates for named dams that can be matched to a grouped CSV
// record. The operational CSV itself has no latitude/longitude columns. Rows
// that do not match this small DWS reference inventory remain district-centroid
// proxies in the map.
const LOCATIONS = [
  { match: ['gariep dam'], label: 'Gariep Dam', latitude: -30.62306, longitude: 25.50722, source: 'DWS WMS reference' },
  { match: ['bloemhof dam'], label: 'Bloemhof Dam', latitude: -27.67083, longitude: 25.61694, source: 'DWS resource-management-plan reference' },
  { match: ['theewaterskloof dam'], label: 'Theewaterskloof Dam', latitude: -34.05806, longitude: 19.27667, source: 'DWS WMS reference' },
  { match: ['pongolapoort dam', 'pongolapoort'], label: 'Pongolapoort Dam', latitude: -27.402113, longitude: 31.958586, source: 'DWS reservoir reference' },
  { match: ['kouga dam'], label: 'Kouga Dam', latitude: -33.74, longitude: 24.58806, source: 'DWS WMS reference' },
  { match: ['brandvlei dam'], label: 'Brandvlei Dam', latitude: -33.693611, longitude: 19.433189, source: 'DWS major-dams reference' },
  { match: ['grootdraai dam'], label: 'Grootdraai Dam', latitude: -26.9187, longitude: 29.2953, source: 'DWS WMS reference' },
  { match: ['heyshope dam'], label: 'Heyshope Dam', latitude: -26.99535, longitude: 30.5216, source: 'DWS WMS reference' },
  { match: ['sterkfontein dam'], label: 'Sterkfontein Dam', latitude: -28.38722, longitude: 29.01667, source: 'DWS WMS reference' },
  { match: ['vaal dam'], label: 'Vaal Dam', latitude: -26.8834, longitude: 28.1167, source: 'DWS WMS reference' },
]

export function reservoirReferenceLocations(value = '') {
  const text = String(value).toLowerCase()
  return LOCATIONS.filter(location => location.match.some(token => text.includes(token)))
}

export function reservoirReferenceLocation(value = '') {
  return reservoirReferenceLocations(value)[0] || null
}
