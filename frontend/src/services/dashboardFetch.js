// Share identical reads across dashboards without sharing a caller's abort signal.
// API chart results are revalidated on each explicit load; static boundaries and
// metadata have short browser-memory caches. Failed responses are never cached.
const pending = new Map()
const cache = new Map()
const MAX_ENTRIES = 64
const nativeFetch = (...args) => globalThis.fetch(...args)

function requestKey(url) {
  const parsed = new URL(url, globalThis.location?.origin || 'http://localhost')
  parsed.searchParams.sort()
  return parsed.pathname + parsed.search
}

function cancelled(signal) {
  return signal?.reason || new DOMException('The request was aborted.', 'AbortError')
}

function subscribe(entry, signal) {
  if (signal?.aborted) return Promise.reject(cancelled(signal))
  entry.users += 1
  return new Promise((resolve, reject) => {
    let finished = false
    const finish = (callback, value) => {
      if (finished) return
      finished = true
      entry.users -= 1
      signal?.removeEventListener('abort', abort)
      callback(value)
      // React may immediately resubscribe during development's effect cleanup.
      if (!entry.users && !entry.done) setTimeout(() => {
        if (!entry.users && !entry.done) entry.controller.abort()
      }, 0)
    }
    const abort = () => finish(reject, cancelled(signal))
    signal?.addEventListener('abort', abort, { once: true })
    entry.promise.then(value => finish(resolve, value), error => finish(reject, error))
  })
}

export async function dashboardFetch(url, options = {}) {
  if (options.signal?.aborted) throw cancelled(options.signal)
  const method = (options.method || 'GET').toUpperCase()
  if (method !== 'GET' || typeof url !== 'string' || options.headers || options.cache === 'no-store') {
    return nativeFetch(url, options)
  }
  const key = requestKey(url)
  const isMap = key.startsWith('/south_africa_adm2')
  const ttl = isMap ? 24 * 60 * 60 * 1000 : /\/metadata(?:\?|$)/.test(key) ? 30_000 : 0
  const previous = cache.get(key)
  if (previous && previous.expires > Date.now() && options.cache !== 'reload') {
    if (options.signal?.aborted) throw cancelled(options.signal)
    return new Response(previous.bytes.slice(0), previous.init)
  }
  cache.delete(key)
  let entry = pending.get(key)
  if (entry?.controller.signal.aborted) { pending.delete(key); entry = null }
  if (!entry) {
    entry = { controller: new AbortController(), users: 0, done: false }
    entry.promise = (async () => {
      const response = await nativeFetch(url, { ...options, signal: entry.controller.signal })
      const bytes = await response.arrayBuffer()
      if (key.startsWith('/api/') || key.startsWith('/niwis-api/')) {
        const body = new TextDecoder().decode(bytes).trim()
        const context = `API request ${key} (HTTP ${response.status})`
        if (!body) throw new Error(`${context} returned an empty response. Check that the backend is running and the frontend proxy points to its port, then restart the frontend.`)
        try { JSON.parse(body) } catch {
          throw new Error(`${context} returned invalid JSON. Check the backend logs and frontend proxy configuration.`)
        }
      }
      const init = { status: response.status, statusText: response.statusText, headers: [...response.headers] }
      const value = { bytes, init }
      if (response.ok && ttl && bytes.byteLength < 5_000_000) {
        if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value)
        cache.set(key, { ...value, expires: Date.now() + ttl })
      }
      return value
    })().finally(() => { entry.done = true; if (pending.get(key) === entry) pending.delete(key) })
    pending.set(key, entry)
  }
  const value = await subscribe(entry, options.signal)
  if (value.init.status >= 200 && value.init.status < 300 && key.startsWith('/api/')) {
    const headers = new Headers(value.init.headers)
    globalThis.dispatchEvent?.(new CustomEvent('niwis:data-loaded', { detail: {
      path: key, cached: headers.get('x-niwis-cache') === 'HIT',
      loadedAt: headers.get('x-niwis-cached-at') || new Date().toISOString(),
    } }))
  }
  return new Response(value.bytes.slice(0), value.init)
}

export function clearDashboardFetchCache() { cache.clear() }
