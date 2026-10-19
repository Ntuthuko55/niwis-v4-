import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'

const base = process.env.NIWIS_VERIFY_URL || 'http://127.0.0.1:5184'
const mode = process.env.NIWIS_VERIFY_MODE || 'production'
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
const errors = [], requests = [], results = []
let holdCharts = false
let releaseCharts
let chartGate
page.on('pageerror', error => errors.push(error.message))
page.on('request', request => requests.push(new URL(request.url())))
await page.route('**/niwis-api/api/predictions/latest', route => route.fulfill({ json: { predictions: [] } }))
await page.route('https://fonts.googleapis.com/**', route => route.abort())
await page.route('https://fonts.gstatic.com/**', route => route.abort())
await page.route('**/api/climate/**', async route => {
  const url = new URL(route.request().url())
  if (holdCharts && ['/api/climate/dashboard', '/api/climate/monthly'].includes(url.pathname)) {
    const response = await route.fetch({ timeout: 150000 })
    await chartGate
    return route.fulfill({ response })
  }
  return route.continue()
})

async function ready(section) {
  const selector = section ? '.cl-feature-chart .recharts-surface' : '.cl-primary-grid .recharts-surface'
  await page.waitForFunction(selector => document.querySelector(selector) || document.querySelector('.cl-error'), selector, { timeout: 150000 })
  assert.deepEqual(await page.locator('.cl-error').allTextContents(), [])
  await page.waitForFunction(() => !document.querySelector('.climate-dashboard .cl-loading'), null, { timeout: 150000 })
  await page.locator('.cl-map-panel .municipality-map').waitFor({ timeout: 60000 })
  assert.equal(await page.locator('.cl-map-panel path[role="button"]').count(), 52)
  assert.deepEqual(errors, [])
}

const chartCalls = () => requests.filter(url => ['/api/climate/dashboard', '/api/climate/monthly'].includes(url.pathname))
const mapCalls = () => requests.filter(url => url.pathname === '/api/climate/map')

try {
  await mkdir('../output/dashboard-performance', { recursive: true })
  for (const section of [null, 'temperature', 'spells', 'rainfall', 'evaporation', 'irrigation', 'streamflow']) {
    const before = requests.length
    const started = Date.now()
    const path = section ? `/climate/${section}` : '/climate'
    if (!section) {
      holdCharts = true
      chartGate = new Promise(resolve => { releaseCharts = resolve })
    }
    await page.goto(base + path, { waitUntil: 'domcontentloaded' })
    let earlyMapMilliseconds
    if (!section) {
      // Hold real chart responses to verify the map renders independently.
      await page.locator('.cl-map-panel .municipality-map').waitFor({ timeout: 60000 })
      assert.equal(await page.locator('.recharts-surface').count(), 0)
      assert.equal(await page.locator('.cl-map-panel path[role="button"]').count(), 52)
      earlyMapMilliseconds = Date.now() - started
      holdCharts = false
      releaseCharts()
      console.log(`PASS early national map: ${earlyMapMilliseconds}ms before chart history arrives`)
    }
    await ready(section)
    const own = requests.slice(before).filter(url => url.pathname.startsWith('/api/climate/'))
    const dataCalls = own.filter(url => ['/api/climate/dashboard', '/api/climate/monthly'].includes(url.pathname))
    assert.ok(dataCalls.length)
    for (const url of dataCalls) {
      assert.equal(url.searchParams.get('include_map'), 'false')
      assert.equal(url.searchParams.get('section'), section)
    }
    if (['spells', 'rainfall', 'streamflow'].includes(section)) {
      assert.ok(!own.some(url => url.pathname === '/api/climate/monthly'), 'Annual sections must not request daily/monthly histories')
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false)
    const item = { path, status: 'passed', milliseconds: Date.now() - started, early_map_milliseconds: earlyMapMilliseconds, map_paths: 52,
                   chart_requests: dataCalls.length, map_requests: own.filter(url => url.pathname === '/api/climate/map').length }
    results.push(item)
    console.log(`PASS ${mode} ${path}: ${item.milliseconds}ms, ${dataCalls.length} chart requests, 52 map districts`)

    if (section === 'temperature') {
      const paths = page.locator('.cl-map-panel path[role="button"]')
      const fills = await paths.evaluateAll(nodes => nodes.map(node => node.getAttribute('fill')))
      const mapsBefore = mapCalls().length
      await page.getByLabel('Climate region').selectOption('Vhembe')
      await page.getByRole('button', { name: 'Apply filters', exact: true }).click()
      await page.locator('.cl-feature-chart h2').filter({ hasText: 'Vhembe' }).waitFor({ timeout: 90000 })
      await ready(section)
      assert.equal(mapCalls().length, mapsBefore, 'District changes must reuse the independent national map')
      assert.deepEqual(await paths.evaluateAll(nodes => nodes.map(node => node.getAttribute('fill'))), fills)
      const dataBefore = chartCalls().length
      const curves = page.locator('.cl-feature-chart .recharts-line-curve')
      const beforeCurves = await curves.evaluateAll(nodes => nodes.map(node => node.getAttribute('d')))
      const response = page.waitForResponse(response => {
        const url = new URL(response.url())
        return url.pathname === '/api/climate/map' && url.searchParams.get('month') === '2025-01'
      })
      await page.getByLabel('Climate map month').selectOption('2025-01')
      assert.equal((await response).status(), 200)
      await page.locator('.cl-map-panel .municipality-map').waitFor({ timeout: 60000 })
      assert.equal(chartCalls().length, dataBefore, 'Changing the map month must not reload chart histories')
      assert.deepEqual(await curves.evaluateAll(nodes => nodes.map(node => node.getAttribute('d'))), beforeCurves)
      assert.equal(await paths.count(), 52)
      await page.screenshot({ path: `../output/dashboard-performance/climate-${mode}.png`, fullPage: true })
      console.log('PASS district switching preserves map colours; map-month changes leave chart history untouched')
    }
  }
  assert.ok(!requests.some(url => url.pathname === '/api/dashboard/dataset'), 'Forecasting must wait until explicitly opened')
  assert.ok(!requests.some(url => url.href.includes('react-plotly-')), 'Monitoring must not download Plotly')
  assert.deepEqual(errors, [])
} catch (error) {
  console.log((await page.locator('body').innerText()).slice(-3500))
  console.log('Browser errors:', errors)
  throw error
} finally {
  releaseCharts?.()
  await writeFile(`../output/dashboard-performance/climate-${mode}-verification.json`, JSON.stringify({ mode, results, errors, requests: requests.map(url => url.href) }, null, 2))
  await browser.close()
}
