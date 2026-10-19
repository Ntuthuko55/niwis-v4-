import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'

const base = process.env.NIWIS_VERIFY_URL || 'http://127.0.0.1:5185'
const mode = process.env.NIWIS_VERIFY_MODE || 'development'
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
const errors = [], requests = [], report = { mode }
let releaseCharts, gate = new Promise(resolve => { releaseCharts = resolve })
let holdCharts = true, failCharts = false, failMap = false, failDaily = false
page.on('pageerror', error => errors.push(error.message))
page.on('request', request => requests.push(new URL(request.url())))
await page.route('**/niwis-api/api/predictions/latest', route => route.fulfill({ json: { predictions: [] } }))
await page.route('https://fonts.googleapis.com/**', route => route.abort())
await page.route('https://fonts.gstatic.com/**', route => route.abort())
await page.route('**/api/rainfall/**', async route => {
  const url = new URL(route.request().url())
  if (failCharts && url.pathname === '/api/rainfall/dashboard') return route.fulfill({ status: 503, json: { detail: 'Rainfall test source unavailable' } })
  if (failMap && url.pathname === '/api/rainfall/map') return route.fulfill({ status: 503, json: { detail: 'Rainfall test map unavailable' } })
  if (failDaily && url.pathname === '/api/rainfall/daily') return route.fulfill({ status: 503, json: { detail: 'Rainfall test daily detail unavailable' } })
  if (holdCharts && url.pathname === '/api/rainfall/dashboard') {
    const response = await route.fetch({ timeout: 180000 })
    await gate
    return route.fulfill({ response })
  }
  return route.continue()
})
const chartCalls = () => requests.filter(url => url.pathname === '/api/rainfall/dashboard')
const mapCalls = () => requests.filter(url => url.pathname === '/api/rainfall/map')
const dailyCalls = () => requests.filter(url => url.pathname === '/api/rainfall/daily')
const paths = () => page.locator('.rf-map-panel path[role="button"]')
const fills = () => paths().evaluateAll(nodes => nodes.map(node => node.getAttribute('fill')))
const curves = () => page.locator('.rf-primary-grid .rf-panel:last-child .recharts-layer.recharts-bar-rectangle, .rf-primary-grid .rf-panel:last-child .recharts-line-curve').evaluateAll(nodes => nodes.map(node => node.getAttribute('d') || node.innerHTML))
async function chartsReady() {
  await page.locator('.rf-kpi').first().waitFor({ timeout: 180000 })
  await page.waitForFunction(() => !document.querySelector('.rainfall-dashboard .rf-loading'), null, { timeout: 180000 })
  assert.equal(await page.locator('.rf-kpi').count(), 6)
  assert.deepEqual(errors, [])
}
async function mapReady() {
  await page.locator('.rf-map-panel .municipality-map').waitFor({ timeout: 90000 })
  assert.equal(await paths().count(), 52)
}
async function dailyReady() {
  await page.locator('.rf-daily-grid .rf-panel:first-child .recharts-wrapper > .recharts-surface').waitFor({ timeout: 90000 })
  await page.locator('.rf-daily-grid .rf-panel:last-child .recharts-wrapper > .recharts-surface').waitFor({ timeout: 90000 })
}
try {
  await mkdir('../output/dashboard-performance', { recursive: true })
  const started = Date.now()
  await page.goto(base + '/rainfall', { waitUntil: 'domcontentloaded' })
  await mapReady()
  report.early_map_milliseconds = Date.now() - started
  assert.equal(await page.locator('.rf-kpi').count(), 0, 'Map must render before held chart history')
  assert.equal(dailyCalls().length, 0, 'Daily detail waits for the initial main history')
  holdCharts = false; releaseCharts()
  await chartsReady(); await dailyReady()
  report.initial_ready_milliseconds = Date.now() - started
  assert.equal(await page.getByLabel('Rainfall region').locator('option').count(), 53)
  assert.equal(await page.locator('.rf-index-strip>button').count(), 8)
  for (const url of chartCalls()) {
    assert.equal(url.searchParams.get('include_map'), 'false')
    assert.equal(url.searchParams.get('include_runoff'), 'false')
  }
  assert.ok(!requests.some(url => /training\/datasets|forecast-source|react-plotly|plotly\.js/.test(url.pathname)), 'Forecast remains deferred')
  console.log(`PASS ${mode}: early map ${report.early_map_milliseconds}ms, history and daily detail ${report.initial_ready_milliseconds}ms`)

  const nationalFills = await fills(), mapsBefore = mapCalls().length
  const began = Date.now()
  await page.getByLabel('Rainfall region').selectOption('City of Tshwane')
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click()
  await chartsReady(); await dailyReady()
  await page.locator('.rf-context').filter({ hasText: 'City of Tshwane' }).waitFor()
  report.district_milliseconds = Date.now() - began
  assert.equal(mapCalls().length, mapsBefore)
  assert.deepEqual(await fills(), nationalFills)
  const dataBefore = chartCalls().length, dailyBefore = dailyCalls().length, beforeCurves = await curves()
  const rankingBefore = await page.locator('.rf-ranking').innerText()
  await page.getByLabel('Rainfall map month').selectOption('2025-01')
  await mapReady()
  assert.equal(chartCalls().length, dataBefore)
  assert.equal(dailyCalls().length, dailyBefore)
  assert.deepEqual(await curves(), beforeCurves)
  assert.equal(await page.locator('.rf-ranking').innerText(), rankingBefore, 'Ranking stays on chart end month')
  await page.getByLabel('Rainfall map indicator').selectOption('spi24')
  await page.getByLabel('Rainfall drought index').selectOption('spei12')
  await page.getByRole('img', { name: 'SPEI-12 chart', exact: true }).waitFor()
  await page.getByRole('button', { name: 'Depth (mm)', exact: true }).click()
  await page.getByRole('checkbox', { name: 'Compare previous year' }).uncheck()
  assert.equal(await page.getByText('Same month previous year', { exact: true }).count(), 0)
  await page.getByRole('checkbox', { name: 'Compare previous year' }).check()
  console.log('PASS district selection preserves national colors; map month/indicator changes leave chart and daily requests unchanged')

  failMap = true
  await page.getByLabel('Rainfall map month').selectOption('2025-02')
  await page.locator('.rf-map-panel [role="alert"]').filter({ hasText: 'Rainfall test map unavailable' }).waitFor()
  assert.equal(await paths().count(), 0)
  assert.equal(await page.locator('.rf-kpi').count(), 6)
  failMap = false
  await page.getByRole('button', { name: 'Retry map', exact: true }).click()
  await mapReady()
  failDaily = true
  await page.getByLabel('Rainfall daily month').selectOption('2025-03')
  await page.locator('.rf-daily-grid [role="alert"]').filter({ hasText: 'Rainfall test daily detail unavailable' }).waitFor()
  assert.equal(await page.locator('.rf-daily-grid .recharts-surface').count(), 0)
  assert.equal(await page.locator('.rf-kpi').count(), 6)
  failDaily = false
  await page.getByRole('button', { name: 'Retry daily detail', exact: true }).click()
  await dailyReady()
  assert.equal(chartCalls().length, dataBefore)
  failCharts = true
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click()
  await page.getByText('Rainfall test source unavailable', { exact: false }).first().waitFor()
  assert.equal(await page.locator('.rf-kpi').count(), 0)
  await mapReady()
  failCharts = false
  await page.getByRole('button', { name: 'Retry', exact: true }).click()
  await chartsReady(); await dailyReady()
  console.log('PASS map, daily and chart failures clear stale values and recover independently')

  await page.getByLabel('Rainfall start month').fill('2024-01')
  await page.getByLabel('Rainfall end month').fill('2024-12')
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click()
  await chartsReady(); await mapReady(); await dailyReady()
  const febResponse = page.waitForResponse(response => {
    const url = new URL(response.url())
    return url.pathname === '/api/rainfall/daily' && url.searchParams.get('month') === '2024-02'
  })
  const beforeDailyChange = chartCalls().length
  await page.getByLabel('Rainfall daily month').selectOption('2024-02')
  const feb = await (await febResponse).json()
  assert.equal(feb.series.length, 29)
  assert.equal(feb.dekads.length, 3)
  await dailyReady()
  assert.equal(chartCalls().length, beforeDailyChange)
  await page.getByRole('button', { name: 'Reported intensity', exact: true }).click()
  await page.getByRole('img', { name: 'Mean reported intensity chart', exact: true }).waitFor()
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export monthly data', exact: true }).click()
  const download = await downloadPromise
  const csv = await readFile(await download.path(), 'utf8')
  assert.equal(csv.trim().split('\r\n').length, 13)
  assert.ok(csv.includes('SPI-24 (index)') && csv.includes('City of Tshwane'))
  await page.locator('.rf-register summary').click()
  assert.equal(await page.locator('.rf-register tbody tr').count(), 19)
  await page.locator('.rf-register summary').click()
  await page.getByRole('button', { name: 'Highest five', exact: true }).click()
  const chosen = await page.locator('.rf-ranking strong').first().innerText()
  const beforeRank = mapCalls().length
  await page.locator('.rf-ranking>button').first().click()
  await chartsReady(); await dailyReady()
  assert.equal(await page.getByLabel('Rainfall region').inputValue(), chosen)
  assert.equal(mapCalls().length, beforeRank)
  console.log('PASS leap-day daily detail, three dekads, 19 indicators, real CSV export and ranking selection')

  await page.getByLabel('Rainfall start month').fill('2026-09')
  await page.getByLabel('Rainfall end month').fill('2026-09')
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click()
  await chartsReady(); await mapReady(); await dailyReady()
  assert.ok((await page.locator('.rf-warning').innerText()).includes('incomplete'))
  assert.ok((await page.locator('.rf-season-status').innerText()).includes('Unavailable'))
  await page.screenshot({ path: `../output/dashboard-performance/rainfall-${mode}-desktop.png`, fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForFunction(() => document.documentElement.scrollWidth <= innerWidth + 2, null, { timeout: 5000 })
  await page.screenshot({ path: `../output/dashboard-performance/rainfall-${mode}-mobile.png`, fullPage: true })
  assert.deepEqual(errors, [])
  report.status = 'passed'
  report.map_districts = 52
  report.errors = errors
  report.checks = ['early independent map', 'district reuses national colors', 'map and daily month isolation', 'ranking retains chart end month', 'independent failures and retries', 'leap-day and dekadal detail', '19 indicators and CSV units', 'partial month and unavailable future seasons', 'mobile layout', 'forecast remains deferred']
  await writeFile(`../output/dashboard-performance/rainfall-${mode}-verification.json`, JSON.stringify(report, null, 2) + '\n')
  console.log(`PASS ${mode}: partial-month warning, unavailable seasons, mobile layout; no JavaScript errors`)
} finally {
  releaseCharts?.()
  await browser.close()
}
