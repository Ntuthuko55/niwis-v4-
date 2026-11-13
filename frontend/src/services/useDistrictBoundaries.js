import { useEffect, useState } from 'react'

let cached
let pending
let listeners = 0
let requestController
function load() {
  if (cached) return Promise.resolve(cached)
  if (!pending) {
    const controller = new AbortController()
    requestController = controller
    pending = fetch('/south_africa_adm2.display.geojson', { signal: controller.signal })
      .then(response => {
        if (!response.ok) throw new Error('District boundaries could not be loaded.')
        return response.json()
      }).then(data => {
        if (!Array.isArray(data.features) || !data.features.length) throw new Error('District boundaries are unavailable.')
        cached = data.features
        return cached
      }).finally(() => { if (requestController === controller) { pending = null; requestController = null } })
  }
  return pending
}
export default function useDistrictBoundaries(supplied) {
  const hasSupplied = Boolean(supplied?.length)
  const [features, setFeatures] = useState(cached || [])
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    if (hasSupplied) return undefined
    let active = true
    listeners += 1
    setError('')
    load().then(value => { if (active) setFeatures(value) }).catch(err => {
      if (active && err.name !== 'AbortError') setError(err.message || 'District boundaries could not be loaded.')
    })
    return () => {
      active = false
      listeners -= 1
      // A new route can reuse an in-flight boundary request. Abort only when
      // no active map still needs it, after React's synchronous remount.
      queueMicrotask(() => {
        if (!listeners && requestController) {
          requestController.abort()
          pending = null
          requestController = null
        }
      })
    }
  }, [hasSupplied, retry])
  return { features: hasSupplied ? supplied : features, error, retry: () => setRetry(value => value + 1) }
}
