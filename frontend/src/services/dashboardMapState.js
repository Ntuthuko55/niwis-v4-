export const mapViews = new Map()
export function saveMapView(key, update) {
  const previous = mapViews.get(key)
  mapViews.delete(key)
  mapViews.set(key, { ...previous, ...update })
  if (mapViews.size > 60) mapViews.delete(mapViews.keys().next().value)
}
