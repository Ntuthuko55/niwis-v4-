// Share the server's public basemap capabilities across dashboard maps. Secrets
// remain on the API; failed checks are never kept as a successful capability.
let saved = null
let pending = null
const STATUS_TTL = 5 * 60 * 1000

export function loadBasemapConfig({ refresh = false } = {}) {
  if (!refresh && saved && saved.expires > Date.now()) return Promise.resolve(saved.value)
  if (pending) return pending
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15_000)
  pending = fetch('/spatial-api/basemap/status', { signal: controller.signal, cache: 'no-store', headers: { Accept: 'application/json' } })
    .then(async response => {
      if (!response.ok) throw new Error('Map background options are temporarily unavailable.')
      const value = await response.json()
      if (typeof value.configured !== 'boolean') throw new Error('The map background service returned an invalid response.')
      saved = { value, expires: Date.now() + STATUS_TTL }
      return value
    })
    .finally(() => { clearTimeout(timer); pending = null })
  return pending
}

export function basemapDefinition(view, config = {}) {
  if (view === 'satellite') return {
    url: '/spatial-api/basemap/tiles/{z}/{x}/{y}.jpg',
    attribution: config.attribution || '&copy; <a href="https://www.maptiler.com/copyright/">MapTiler</a> satellite imagery',
    maxZoom: 20,
  }
  if (view === 'streets') return {
    url: config.street_url || '/spatial-api/basemap/streets/{z}/{x}/{y}.png',
    attribution: config.street_attribution || `${config.configured ? '&copy; <a href="https://www.maptiler.com/copyright/">MapTiler</a> ' : ''}&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors`,
    maxZoom: 19,
  }
  return null
}
