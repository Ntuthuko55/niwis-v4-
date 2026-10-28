import assert from 'node:assert/strict'
import { dashboardFetch, clearDashboardFetchCache } from '../src/services/dashboardFetch.js'
import { normaliseForecastDate } from '../src/lib/forecastDates.js'

let calls = 0
globalThis.fetch = async (url, options = {}) => {
  calls++
  await new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, 20)
    options.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')) })
  })
  return new Response(JSON.stringify({ url, value: 7 }), { headers: { 'content-type': 'application/json' } })
}
const first = new AbortController()
const second = new AbortController()
const one = dashboardFetch('/api/climate/metadata', { signal: first.signal }).catch(error => error.name)
const two = dashboardFetch('/api/climate/metadata', { signal: second.signal })
first.abort()
assert.equal(await one, 'AbortError')
assert.equal((await (await two).json()).value, 7)
assert.equal(calls, 1, 'One cancelled subscriber must not cancel its peer')
assert.equal((await (await dashboardFetch('/api/climate/metadata')).json()).value, 7)
assert.equal(calls, 1, 'Metadata should be reused during navigation')
clearDashboardFetchCache()
globalThis.fetch = async () => { calls++; return new Response('{"detail":"offline"}', { status: 503 }) }
await dashboardFetch('/api/climate/metadata')
await dashboardFetch('/api/climate/metadata')
assert.equal(calls, 3, 'Errors must never be cached')
globalThis.fetch = async () => new Response('', { status: 500 })
await assert.rejects(dashboardFetch('/api/climate/metadata'), /HTTP 500.*empty response/)
globalThis.fetch = async () => new Response('<html>Proxy error</html>', { status: 502 })
await assert.rejects(dashboardFetch('/api/climate/metadata'), /HTTP 502.*invalid JSON/)
globalThis.fetch = async () => new Response('{"detail":"Database unavailable"}', { status: 503 })
assert.equal((await (await dashboardFetch('/api/climate/metadata')).json()).detail, 'Database unavailable')
console.log('PASS empty and invalid API responses have actionable errors; database errors remain intact')
console.log('PASS shared browser reads: coalescing, independent cancellation, metadata reuse and error retry')
assert.equal(normaliseForecastDate('2025-07', 'monthly'), '2025-07-01')
assert.equal(normaliseForecastDate('2025', 'annual'), '2025-12-31')
assert.equal(normaliseForecastDate('2025-07-31', 'daily'), '2025-07-31')
assert.equal(normaliseForecastDate(null, 'monthly'), '')
assert.ok(Number.isFinite(Date.parse(normaliseForecastDate('2025-07', 'monthly'))))
console.log('PASS native monthly, annual and daily forecasting dates')
