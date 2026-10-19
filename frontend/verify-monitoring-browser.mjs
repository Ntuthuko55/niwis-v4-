import { chromium } from 'playwright'
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'

const browser = await chromium.launch({ channel: 'msedge', headless: true })
const page = await browser.newPage({ viewport: { width: 1720, height: 1080 } })
const errors = [], csv = [], jobs = []
let partialFailure = false
page.on('pageerror', (e) => errors.push(e.message))
page.on('request', (r) => {
  if (/\.csv(?:\?|$)/.test(r.url())) csv.push(r.url())
  if (r.url().endsWith('/api/models/train')) jobs.push(r.postDataJSON())
})
await page.route('**/api/**', async (route) => {
  const url = new URL(route.request().url())
  if (url.pathname.startsWith('/niwis-api/')) return route.fulfill({ json: { predictions: [] } })
  try {
    const response = await route.fetch({ url: `http://127.0.0.1:8011${url.pathname.replace(/^\/api/, '')}${url.search}`, timeout: 120000 })
    if (partialFailure && url.pathname === '/api/drought-monitoring/region') {
      const json = await response.json()
      json.sources.satellite = { status: 'error', error: 'Satellite source unavailable for test', monthly: [], latest: null, records: 0 }
      json.alignment = { month: null, signals: [], available_signals: 0, dry_count: 0, spi_ssi_correlation: null, paired_months: 0 }
      json.comparisons.satellite = null
      return route.fulfill({ json })
    }
    await route.fulfill({ response })
  } catch { await route.abort() }
})
try {
  await page.goto('http://127.0.0.1:5179', { waitUntil: 'domcontentloaded' })
  await page.getByRole('heading', { name: 'Drought monitoring', exact: true }).waitFor()
  await page.getByRole('heading', { name: 'Converging drought signals' }).waitFor({ timeout: 120000 })
  assert.equal(await page.getByLabel('Monitoring region').locator('option').count(), 52)
  assert.equal(await page.getByLabel('Monitoring region').inputValue(), 'City Of Tshwane')
  assert.equal(await page.locator('.dm-metric').count(), 6)
  assert.ok((await page.locator('.dm-signals').innerText()).includes('Nov 2025'))
  assert.ok((await page.locator('.dm-source-dates').innerText()).includes('2026-09-06'))
  assert.ok((await page.locator('.dm-source-dates').innerText()).includes('2025-12-01'))
  const forecast = page.locator('.dm-forecast')
  await forecast.getByText(/Forecast complete/).waitFor({ timeout: 120000 })
  assert.equal(jobs.length, 1)
  assert.equal(new Set(await forecast.locator('.nw-forecast-meta span').allTextContents()).size, 3, 'Forecast month cards must show three different months')
  assert.ok((await forecast.locator('.nw-dash-odds').innerText()).includes('not a probability estimate'))
  console.log('PASS combined data, explicit source dates, aligned month and real LSTM forecast')
  await page.locator('.dm-map-panel').getByRole('button', { name: 'SSI', exact: true }).click()
  await page.getByRole('img', { name: 'SSI map', exact: true }).waitFor()
  await page.locator('.dm-map-panel').getByRole('button', { name: 'NDVI', exact: true }).click()
  await page.getByLabel('Chart history').selectOption('60')
  await page.getByRole('button', { name: 'Tmax', exact: true }).click()
  await page.getByRole('button', { name: 'ET₀', exact: true }).click()
  assert.equal(jobs.length, 1, 'Chart controls should not rerun the forecast')
  await page.locator('.dm-map-panel').getByRole('button', { name: 'SPI-3', exact: true }).click()
  await mkdir('output', { recursive: true })
  await page.screenshot({ path: 'output/drought-monitoring-desktop.png', fullPage: true })
  console.log('PASS map layers and chart controls')
  await page.getByLabel('Monitoring region').selectOption('Alfred Nzo')
  await page.getByRole('heading', { name: 'Forecasting studio · Alfred Nzo', exact: true }).waitFor({ timeout: 120000 })
  await forecast.getByText(/Forecast complete/).waitFor({ timeout: 120000 })
  assert.equal(jobs.length, 2)
  assert.notEqual(jobs[0].dataset_id, jobs[1].dataset_id)
  console.log('PASS region switch updates data and forecast dataset')
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: 'output/drought-monitoring-mobile.png', fullPage: true })
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2), 'Mobile page overflows horizontally')
  partialFailure = true
  await page.getByRole('button', { name: 'Refresh drought monitoring' }).click()
  await page.getByRole('alert').filter({ hasText: 'Satellite source unavailable for test' }).waitFor({ timeout: 120000 })
  assert.ok((await page.locator('.dm-metric').last().innerText()).includes('—'))
  assert.equal(await page.getByRole('heading', { name: 'Hydrological response' }).count(), 1)
  assert.deepEqual(errors, [])
  assert.deepEqual(csv, [])
  console.log('PASS mobile layout, partial source failure, no CSV reads or JavaScript errors')
} catch (error) {
  console.log((await page.locator('body').innerText()).slice(-6000))
  console.log({ errors, csv })
  throw error
} finally { await browser.close() }
