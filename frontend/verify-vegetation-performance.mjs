import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'

const base = process.env.NIWIS_VERIFY_URL || 'http://127.0.0.1:5185'
const mode = process.env.NIWIS_VERIFY_MODE || 'development'
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
const errors = [], requests = [], report = { mode }
let releaseCharts, gate = new Promise(resolve => { releaseCharts = resolve })
let holdCharts = true, failCharts = false, failMap = false
page.on('pageerror', error => errors.push(error.message))
page.on('request', request => requests.push(new URL(request.url())))
await page.route('**/niwis-api/api/predictions/latest', route => route.fulfill({ json: { predictions: [] } }))
await page.route('https://fonts.googleapis.com/**', route => route.abort())
await page.route('https://fonts.gstatic.com/**', route => route.abort())
await page.route('**/api/vegetation/**', async route => {
  const url = new URL(route.request().url())
  if (failCharts && url.pathname === '/api/vegetation/dashboard') return route.fulfill({ status: 503, json: { detail: 'Vegetation test source unavailable' } })
  if (failMap && url.pathname === '/api/vegetation/map') return route.fulfill({ status: 503, json: { detail: 'Vegetation test map unavailable' } })
  if (holdCharts && url.pathname === '/api/vegetation/dashboard') {
    const response = await route.fetch({ timeout: 150000 })
    await gate
    return route.fulfill({ response })
  }
  return route.continue()
})
const chartCalls = () => requests.filter(url => url.pathname === '/api/vegetation/dashboard')
const mapCalls = () => requests.filter(url => url.pathname === '/api/vegetation/map')
const paths = () => page.locator('.vg-main-map path[role="button"]')
const fills = () => paths().evaluateAll(nodes => nodes.map(node => node.getAttribute('fill')))
const curves = () => page.locator('.vg-chart-stack .recharts-line-curve').evaluateAll(nodes => nodes.map(node => node.getAttribute('d')))
async function chartsReady() {
  await page.locator('.vg-kpi').first().waitFor({ timeout: 150000 })
  await page.waitForFunction(() => !document.querySelector('.vegetation-dashboard .vg-loading'), null, { timeout: 150000 })
  assert.equal(await page.locator('.vg-kpi').count(), 6)
  assert.deepEqual(errors, [])
}
async function mapReady() {
  await page.locator('.vg-main-map .municipality-map').waitFor({ timeout: 90000 })
  assert.equal(await paths().count(), 52)
}

try {
  await mkdir('../output/dashboard-performance', { recursive: true })
  const started = Date.now()
  await page.goto(base + '/vegetation', { waitUntil: 'domcontentloaded' })
  await mapReady()
  report.early_map_milliseconds = Date.now() - started
  assert.equal(await page.locator('.vg-kpi').count(), 0, 'Map must render before held chart history')
  assert.equal(await page.locator('.vg-chart-stack .recharts-surface').count(), 0)
  holdCharts = false; releaseCharts()
  await chartsReady()
  report.initial_ready_milliseconds = Date.now() - started
  assert.equal(await page.getByLabel('Vegetation region').locator('option').count(), 53)
  assert.equal(await page.getByLabel('Vegetation map month').inputValue(), '')
  assert.equal(await mapCalls().length, 1)
  for (const url of chartCalls()) assert.equal(url.searchParams.get('include_map'), 'false')
  assert.ok(!requests.some(url => /training\/datasets|forecast-source|react-plotly|plotly\.js/.test(url.pathname)), 'Forecasting must remain deferred')
  console.log(`PASS ${mode}: early map ${report.early_map_milliseconds}ms, chart history ${report.initial_ready_milliseconds}ms`)

  const nationalFills = await fills()
  const mapsBefore = mapCalls().length
  let began = Date.now()
  await page.getByLabel('Vegetation region').selectOption('City of Tshwane')
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click()
  await chartsReady()
  await page.locator('.vg-context').filter({ hasText: 'City of Tshwane' }).waitFor()
  report.district_milliseconds = Date.now() - began
  assert.equal(mapCalls().length, mapsBefore, 'District selection must reuse the national map')
  assert.deepEqual(await fills(), nationalFills)
  began = Date.now()
  await page.getByLabel('Vegetation driver lag').selectOption('2')
  await chartsReady()
  assert.equal(await page.getByLabel('Vegetation driver lag').inputValue(), '2')
  report.lag_milliseconds = Date.now() - began
  assert.equal(mapCalls().length, mapsBefore, 'Lag changes must not refetch maps')
  assert.deepEqual(await fills(), nationalFills)
  console.log('PASS district and lag changes reuse all 52 national map values')

  const dataBefore = chartCalls().length, curvesBefore = await curves()
  const rankingBefore = await page.locator('.vg-ranking').innerText()
  await page.getByLabel('Vegetation map month').selectOption('2025-01')
  await mapReady()
  assert.equal(chartCalls().length, dataBefore, 'Map months must not reload comparison histories')
  assert.deepEqual(await curves(), curvesBefore)
  assert.equal(await page.locator('.vg-ranking').innerText(), rankingBefore, 'Ranking stays on the selected chart period')
  assert.ok((await page.locator('.vg-main-map .vg-map-title').innerText()).includes('25'))
  await page.getByLabel('Vegetation map month').selectOption('')
  await mapReady()
  assert.equal(mapCalls().length, mapsBefore + 1, 'Returning to selected period reuses its loaded map')
  assert.deepEqual(await fills(), nationalFills)
  console.log('PASS map month and selected-period switch leave charts and period ranking unchanged')

  await page.getByRole('radio', { name: 'MSAVI2', exact: true }).check()
  await page.getByRole('img', { name: /MSAVI2 current/ }).waitFor()
  await page.getByRole('checkbox', { name: 'Compare with previous year' }).uncheck()
  assert.equal(await page.getByText('Same month previous year', { exact: true }).count(), 0)
  await page.getByRole('checkbox', { name: 'Compare with previous year' }).check()
  await page.getByLabel('Vegetation weather indicator').selectOption('SPEI_6_month')
  await page.getByRole('img', { name: /6-month precipitation/ }).waitFor()
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Download data', exact: true }).click()
  const download = await downloadPromise
  const csv = await readFile(await download.path(), 'utf8')
  assert.equal(csv.trim().split('\r\n').length, 25)
  assert.ok(csv.includes('City of Tshwane'))
  assert.ok(csv.includes('Rainfall (mm/month)'))
  await page.locator('.vg-register summary').click()
  await page.locator('.vg-register').getByRole('button', { name: 'Weather', exact: true }).click()
  assert.equal(await page.locator('.vg-register tbody tr').count(), 11)
  await page.locator('.vg-register summary').click()
  console.log('PASS indicator layers, previous-year toggle, weather register and real 24-month CSV export')

  failMap = true
  await page.getByLabel('Vegetation map month').selectOption('2025-02')
  await page.getByText('Vegetation test map unavailable', { exact: true }).first().waitFor()
  assert.equal(await paths().count(), 0, 'Failed maps must not retain values from another period')
  assert.equal(await page.locator('.vg-kpi').count(), 6)
  failMap = false
  await page.getByRole('button', { name: 'Retry map', exact: true }).click()
  await mapReady()
  assert.equal(chartCalls().length, dataBefore)
  failCharts = true
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click()
  await page.getByText('Vegetation test source unavailable', { exact: false }).first().waitFor()
  assert.equal(await page.locator('.vg-kpi').count(), 0)
  await mapReady()
  failCharts = false
  await page.getByRole('button', { name: 'Retry', exact: true }).click()
  await chartsReady()
  console.log('PASS independent map/chart failures clear stale values and recover on retry')

  await page.getByLabel('Vegetation start month').fill('2025-01')
  await page.getByLabel('Vegetation end month').fill('2025-12')
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click()
  await chartsReady(); await mapReady()
  await page.getByRole('button', { name: 'Lowest five', exact: true }).click()
  const rankName = (await page.locator('.vg-rank-name').first().innerText()).trim()
  const mapCountBeforeRank = mapCalls().length
  await page.locator('.vg-ranking>button').first().click()
  await chartsReady()
  assert.equal(await page.getByLabel('Vegetation region').inputValue(), rankName)
  assert.equal(mapCalls().length, mapCountBeforeRank)
  await page.screenshot({ path: `../output/dashboard-performance/vegetation-${mode}-desktop.png`, fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  // Recharts' ResizeObserver updates its SVGs after the viewport changes.
  await page.waitForFunction(() => document.documentElement.scrollWidth <= innerWidth + 2, null, { timeout: 5000 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 2), false)
  await page.screenshot({ path: `../output/dashboard-performance/vegetation-${mode}-mobile.png`, fullPage: true })
  assert.deepEqual(errors, [])
  report.status = 'passed'
  report.map_districts = 52
  report.errors = errors
  report.checks = ['early independent national map', 'district and lag reuse', 'map-month isolation', 'truthful period labels', 'CSV export and units', '25 indicators', 'independent failures and retries', 'date filters and ranking selection', 'mobile layout', 'forecast remains deferred']
  await writeFile(`../output/dashboard-performance/vegetation-${mode}-verification.json`, JSON.stringify(report, null, 2) + '\n')
  console.log(`PASS ${mode}: filters, ranking selection, mobile layout; no JavaScript errors`)
} finally {
  releaseCharts?.()
  await browser.close()
}
