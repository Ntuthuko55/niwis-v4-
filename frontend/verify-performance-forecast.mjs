import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'

const browser = await chromium.launch({ channel: 'msedge', headless: true })
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
const errors = [], registrations = [], jobs = []
let lastJob
page.on('pageerror', error => errors.push(error.message))
page.on('request', request => {
  if (request.url().endsWith('/api/dashboard/dataset')) registrations.push(request.postDataJSON())
  if (request.url().endsWith('/api/models/train')) jobs.push(request.postDataJSON())
})
page.on('response', async response => {
  if (response.url().includes('/api/models/jobs/')) lastJob = await response.json().catch(() => null)
})
await page.route('**/niwis-api/api/predictions/latest', route => route.fulfill({ json: { predictions: [] } }))
await page.route('https://fonts.googleapis.com/**', route => route.abort())
await page.route('https://fonts.gstatic.com/**', route => route.abort())
try {
  await page.goto((process.env.NIWIS_VERIFY_URL || 'http://127.0.0.1:5184') + '/climate/temperature', { waitUntil: 'domcontentloaded' })
  await page.locator('.cl-feature-chart .recharts-surface').first().waitFor({ timeout: 150000 })
  assert.equal(registrations.length, 0, 'No forecast history registration before the studio is opened')
  assert.equal(jobs.length, 0, 'No training before the studio is opened')
  await page.getByRole('button', { name: 'Open forecasting studio', exact: true }).click()
  const studio = page.getByRole('region', { name: 'Climate forecasting studio' })
  await studio.getByLabel('Target', { exact: true }).waitFor({ timeout: 150000 })
  assert.equal(registrations.length, 1)
  assert.ok(registrations[0].rows.length > 24)
  assert.ok(registrations[0].rows.every(row => /^\d{4}-\d{2}-\d{2}$/.test(row.date) && Number.isFinite(Date.parse(row.date))))
  const targets = await studio.getByLabel('Target', { exact: true }).locator('option').evaluateAll(nodes => nodes.map(node => node.value))
  assert.ok(targets.includes('Tavg_C'))
  assert.ok(!targets.includes('MAP_mm'), 'Temperature section retains its own target catalogue')
  await studio.getByLabel('Model', { exact: true }).selectOption('Naive')
  await studio.getByLabel('Horizon', { exact: true }).selectOption('180')
  await studio.getByRole('button', { name: 'Run Naive', exact: true }).click()
  await studio.getByText(/Forecast complete.*6 future observations/).waitFor({ timeout: 90000 })
  await studio.locator('.js-plotly-plot').waitFor({ timeout: 30000 })
  assert.equal(jobs.length, 1)
  assert.equal(lastJob.status, 'completed')
  assert.equal(lastJob.result.forecast_values.length, 6)
  assert.ok(lastJob.result.forecast_values.every(Number.isFinite))
  assert.ok(Date.parse(lastJob.result.forecast_dates[0]) > Date.parse(registrations[0].rows.at(-1).date))
  // A region change must register a distinct history and clear the old result.
  const previousId = jobs[0].dataset_id
  await studio.getByLabel('Climate forecast region').selectOption('City of Tshwane')
  await page.waitForFunction(() => !document.querySelector('.nw-forecast-loading'), null, { timeout: 150000 })
  await studio.getByLabel('Target', { exact: true }).waitFor({ timeout: 150000 })
  assert.equal(registrations.length, 2)
  await studio.getByRole('button', { name: 'Run Naive', exact: true }).click()
  await studio.getByText(/Forecast complete.*6 future observations/).waitFor({ timeout: 90000 })
  assert.notEqual(jobs[1].dataset_id, previousId)
  assert.equal(lastJob.status, 'completed')
  assert.deepEqual(errors, [])
  await page.screenshot({ path: '../output/dashboard-performance/forecast.png', fullPage: true })
  await writeFile('../output/dashboard-performance/forecast-verification.json', JSON.stringify({
    status: 'passed', registrations: registrations.map(item => ({ region: item.region, rows: item.rows.length })),
    jobs: jobs.map(item => ({ model: item.model_type, horizon: item.forecast_steps, target: item.target })),
    future_observations: lastJob.result.forecast_values.length, errors,
  }, null, 2))
  console.log('PASS forecasting: deferred load, valid dates, section targets, process-worker job polling, six future values and independent district history')
} catch (error) {
  console.log('Browser errors:', errors)
  console.log((await page.locator('body').innerText()).slice(-3500))
  throw error
} finally { await browser.close() }
