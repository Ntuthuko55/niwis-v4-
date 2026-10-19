import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'

const base = process.env.NIWIS_VERIFY_URL || 'http://127.0.0.1:5185'
const mode = process.env.NIWIS_VERIFY_MODE || 'development'
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
const errors = [], requests = [], report = { mode }
let releaseCharts, gate = new Promise(resolve => { releaseCharts = resolve })
let holdCharts = true, failCharts = false, failMap = false, failDaily = false, failBoundaries = false
page.on('pageerror', error => errors.push(error.message))
page.on('request', request => requests.push(new URL(request.url())))
await page.route('**/niwis-api/api/predictions/latest', route => route.fulfill({ json: { predictions: [] } }))
await page.route('https://fonts.googleapis.com/**', route => route.abort())
await page.route('https://fonts.gstatic.com/**', route => route.abort())
await page.route('**/south_africa_adm2.display.geojson', route => failBoundaries ? route.fulfill({ status: 503, json: { detail: 'Boundary test unavailable' } }) : route.continue())
await page.route('**/api/groundwater/**', async route => {
  const url = new URL(route.request().url())
  if (failCharts && url.pathname === '/api/groundwater/dashboard') return route.fulfill({ status: 503, json: { detail: 'Groundwater test source unavailable' } })
  if (failMap && url.pathname === '/api/groundwater/map') return route.fulfill({ status: 503, json: { detail: 'Groundwater test map unavailable' } })
  if (failDaily && url.pathname === '/api/groundwater/daily') return route.fulfill({ status: 503, json: { detail: 'Groundwater test daily detail unavailable' } })
  if (holdCharts && url.pathname === '/api/groundwater/dashboard') {
    const response = await route.fetch({ timeout: 180000 })
    await gate
    return route.fulfill({ response })
  }
  return route.continue()
})
const chartCalls = () => requests.filter(url => url.pathname === '/api/groundwater/dashboard')
const mapCalls = () => requests.filter(url => url.pathname === '/api/groundwater/map')
const dailyCalls = () => requests.filter(url => url.pathname === '/api/groundwater/daily')
const paths = () => page.locator('.rf-map-panel path[role="button"]')
const fills = () => paths().evaluateAll(nodes => nodes.map(node => node.getAttribute('fill')))
const curves = () => page.locator('.rf-primary-grid .rf-panel:last-child .recharts-line-curve').evaluateAll(nodes => nodes.map(node => node.getAttribute('d')))
async function chartsReady() {
  await page.locator('.groundwater-dashboard .rf-kpi').first().waitFor({ timeout: 180000 })
  await page.waitForFunction(() => !document.querySelector('.groundwater-dashboard .rf-loading'), null, { timeout: 180000 })
  assert.equal(await page.locator('.groundwater-dashboard .rf-kpi').count(), 6)
  assert.deepEqual(errors, [])
}
async function mapReady() {
  await page.locator('.rf-map-panel .municipality-map').waitFor({ timeout: 90000 })
  assert.equal(await paths().count(), 52)
}
async function dailyReady() {
  await page.locator('.rf-daily-grid .rf-panel:first-child .recharts-wrapper > .recharts-surface').waitFor({ timeout: 90000 })
  await page.getByRole('button', { name: 'Daily CSV', exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: 'Daily CSV', exact: true }).isEnabled(), true)
}
try {
  await mkdir('../output/dashboard-performance', { recursive: true })
  const started = Date.now()
  await page.goto(base + '/groundwater', { waitUntil: 'domcontentloaded' })
  await mapReady()
  report.early_map_milliseconds = Date.now() - started
  assert.equal(await page.locator('.rf-kpi').count(), 0, 'Map must render before held chart history')
  assert.equal(dailyCalls().length, 0, 'Daily observations wait for the initial chart result')
  holdCharts = false; releaseCharts()
  await chartsReady(); await dailyReady()
  report.initial_ready_milliseconds = Date.now() - started
  assert.equal(await page.getByLabel('Groundwater region').locator('option').count(), 53)
  assert.equal(await page.locator('.gw-register-scroll tbody tr').count(), 19)
  assert.equal(await page.getByLabel('Groundwater map month').inputValue(), '')
  assert.ok(chartCalls().every(url => url.searchParams.get('include_map') === 'false'))
  assert.ok(!requests.some(url => /training\/datasets|forecast-source|react-plotly|plotly\.js/.test(url.pathname)), 'Forecast remains deferred')
  console.log(`PASS ${mode}: early national map ${report.early_map_milliseconds}ms, history and daily detail ${report.initial_ready_milliseconds}ms`)

  const nationalFills = await fills(), mapCount = mapCalls().length
  let began = Date.now()
  await page.getByLabel('Groundwater region').selectOption('City of Tshwane')
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click()
  await chartsReady(); await dailyReady()
  await page.locator('.rf-context').filter({ hasText: 'City of Tshwane' }).waitFor()
  report.district_milliseconds = Date.now() - began
  assert.equal(mapCalls().length, mapCount)
  assert.deepEqual(await fills(), nationalFills)
  await page.getByLabel('Groundwater map indicator').selectOption('hydraulic_head_amsl_m')
  assert.ok((await page.locator('.rf-map-panel').innerText()).includes('Oct 2026'))
  assert.equal((await fills()).filter(fill => fill === '#254251').length, 0)
  const beforeCurves = await curves(), chartCount = chartCalls().length, dailyCount = dailyCalls().length
  const quality = await page.locator('.gw-quality').innerText()
  await page.getByLabel('Groundwater map month').selectOption('2026-12')
  await mapReady()
  assert.equal((await fills()).filter(fill => fill === '#254251').length, 52, 'December cannot borrow October hydraulic-head readings')
  assert.ok((await page.locator('.rf-map-panel').innerText()).includes('No observation in selected month'))
  assert.equal(chartCalls().length, chartCount)
  assert.equal(dailyCalls().length, dailyCount)
  assert.deepEqual(await curves(), beforeCurves)
  assert.equal(await page.locator('.gw-quality').innerText(), quality)
  await page.getByLabel('Groundwater map month').selectOption('')
  await mapReady()
  assert.equal((await fills()).filter(fill => fill === '#254251').length, 0)
  assert.ok((await page.locator('.rf-map-panel').innerText()).includes('Oct 2026'))
  console.log('PASS district keeps all national values; sparse hydraulic-head months retain truthful dates and nulls')

  failMap = true
  await page.getByLabel('Groundwater map month').selectOption('2026-09')
  await page.locator('.rf-map-panel [role="alert"]').filter({ hasText: 'Groundwater test map unavailable' }).waitFor()
  assert.equal(await paths().count(), 0)
  assert.equal(await page.locator('.rf-kpi').count(), 6)
  failMap = false
  await page.getByRole('button', { name: 'Retry map', exact: true }).click()
  await mapReady()
  failDaily = true
  await page.getByLabel('Groundwater daily month').selectOption('2026-10')
  await page.locator('.rf-daily-grid [role="alert"]').filter({ hasText: 'Groundwater test daily detail unavailable' }).waitFor()
  assert.equal(await page.getByRole('button', { name: 'Daily CSV', exact: true }).isEnabled(), false)
  assert.equal(await page.locator('.rf-daily-grid .rf-panel:first-child .recharts-wrapper').count(), 0)
  failDaily = false
  await page.getByRole('button', { name: 'Retry daily detail', exact: true }).click()
  await dailyReady()
  assert.equal(chartCalls().length, chartCount)
  failCharts = true
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click()
  await page.locator('.groundwater-dashboard > [role="alert"]').filter({ hasText: 'Groundwater test source unavailable' }).waitFor()
  assert.equal(await page.locator('.rf-kpi').count(), 0)
  await mapReady()
  failCharts = false
  await page.getByRole('button', { name: 'Retry', exact: true }).click()
  await chartsReady(); await dailyReady()
  console.log('PASS independent map, chart and daily failures clear stale values and recover on retry')

  await page.getByLabel('Groundwater daily month').selectOption('2026-11')
  await dailyReady()
  const beforeDailyChange = chartCalls().length, mapsBeforeDailyChange = mapCalls().length
  const dailyResponse = page.waitForResponse(response => {
    const url = new URL(response.url())
    return url.pathname === '/api/groundwater/daily' && url.searchParams.get('month') === '2026-10'
  })
  await page.getByLabel('Groundwater daily month').selectOption('2026-10')
  const observed = await (await dailyResponse).json()
  assert.ok(observed.series.every(row => row.date.startsWith('2026-10')))
  assert.ok(observed.series.some(row => row.hydraulic_head_amsl_m != null))
  await dailyReady()
  assert.equal(chartCalls().length, beforeDailyChange)
  assert.equal(mapCalls().length, mapsBeforeDailyChange)
  let downloaded = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Daily CSV', exact: true }).click()
  let file = await downloaded
  let csv = await readFile(await file.path(), 'utf8')
  assert.equal(csv.trim().split('\r\n').length, observed.series.length + 1)
  assert.ok(csv.includes('hydraulic_head_amsl_m') && csv.includes('City of Tshwane'))
  downloaded = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export monthly data', exact: true }).click()
  file = await downloaded
  csv = await readFile(await file.path(), 'utf8')
  assert.equal(csv.trim().split('\r\n').length, 25)
  assert.ok(csv.includes('m amsl') && csv.includes('m bgl'))
  assert.ok(csv.includes('City of Tshwane'))
  await page.getByLabel('Groundwater level indicator').selectOption('hydraulic_head_m_amsl')
  await page.getByLabel('Groundwater recharge indicator').selectOption('actual_evapotranspiration_mm')
  assert.deepEqual(errors, [])
  console.log('PASS irregular observation dates, independent daily month, monthly/daily CSVs and distinct hydraulic-head units')

  // Boundary errors must not block the independent chart/history requests.
  failBoundaries = true
  await page.reload({ waitUntil: 'domcontentloaded' })
  await chartsReady(); await dailyReady()
  await page.locator('.rf-map-panel [role="alert"]').filter({ hasText: 'District boundaries are unavailable' }).waitFor()
  const chartsBeforeBoundaryRetry = chartCalls().length, mapsBeforeBoundaryRetry = mapCalls().length
  failBoundaries = false
  await page.getByRole('button', { name: 'Retry map', exact: true }).click()
  await mapReady()
  assert.equal(chartCalls().length, chartsBeforeBoundaryRetry)
  assert.equal(mapCalls().length, mapsBeforeBoundaryRetry)
  await page.getByLabel('Groundwater start month').fill('2026-12')
  await page.getByLabel('Groundwater end month').fill('2026-12')
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click()
  await chartsReady(); await mapReady(); await dailyReady()
  assert.ok((await page.locator('.rf-kpi').nth(1).innerText()).includes('—'))
  assert.equal(await page.locator('.gw-register-scroll tbody tr').count(), 19)
  await page.screenshot({ path: `../output/dashboard-performance/groundwater-${mode}-desktop.png`, fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForFunction(() => document.documentElement.scrollWidth <= innerWidth + 2, null, { timeout: 5000 })
  await page.screenshot({ path: `../output/dashboard-performance/groundwater-${mode}-mobile.png`, fullPage: true })
  assert.deepEqual(errors, [])
  report.status = 'passed'
  report.map_districts = 52
  report.errors = errors
  report.checks = ['early independent map', 'district preserves national colors', 'latest-observation map dates and selected-period bounds', 'map/daily month isolation', 'independent errors and retries', 'boundary failure isolation', '19 indicators', 'monthly/daily CSV exports and units', 'sparse December selection', 'mobile layout', 'forecast remains deferred']
  await writeFile(`../output/dashboard-performance/groundwater-${mode}-verification.json`, JSON.stringify(report, null, 2) + '\n')
  console.log(`PASS ${mode}: boundary failure isolation, sparse-month filters, mobile layout; no JavaScript errors`)
} finally {
  releaseCharts?.()
  await browser.close()
}
