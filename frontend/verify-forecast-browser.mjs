import { chromium } from 'playwright'
import assert from 'node:assert/strict'

const browser = await chromium.launch({ channel: 'msedge', headless: true })
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
const errors = []
const trainingRequests = []
let simulateFailure = false
page.on('pageerror', (error) => errors.push(error.message))
page.on('request', (request) => {
  if (request.url().endsWith('/api/models/train')) trainingRequests.push(request.postDataJSON())
})
await page.route('**/api/**', async (route) => {
  const url = new URL(route.request().url())
  const path = url.pathname.replace(/^\/api/, '')
  try {
    const response = await route.fetch({ url: `http://127.0.0.1:8011${path}${url.search}`, timeout: 120000 })
    if (path.startsWith('/models/jobs/')) {
      const job = await response.json()
      delete job.job_id // The frontend must also support an older running backend.
      if (simulateFailure) Object.assign(job, { status: 'failed', message: 'Simulated training failure' })
      return await route.fulfill({ json: job })
    }
    await route.fulfill({ response })
  } catch (error) { await route.abort() }
})
try {
  await page.goto('http://127.0.0.1:5179', { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: /Mateological drought/ }).click({ timeout: 120000 })
  const studio = page.locator('.nw-overview-forecast')
  await studio.getByText(/Forecast complete/).waitFor({ timeout: 120000 })
  assert.equal(trainingRequests.length, 1, 'Initial LSTM should start only once')
  assert.equal(trainingRequests[0].model_type, 'lstm')
  assert.ok(await studio.locator('.js-plotly-plot').count(), 'Forecast chart rendered')
  console.log('PASS browser: automatic LSTM completes and chart renders')

  await studio.getByLabel('Model', { exact: true }).selectOption('Naive')
  await studio.getByLabel('Horizon', { exact: true }).selectOption('180')
  await studio.getByRole('button', { name: 'Run Naive' }).click()
  await studio.getByText(/Forecast complete.*6 future observations/).waitFor({ timeout: 60000 })
  assert.equal(trainingRequests.length, 2)
  console.log('PASS browser: model and six-month horizon selection')

  await studio.getByLabel('Model', { exact: true }).selectOption('LSTM')
  await studio.getByRole('button', { name: 'Show LSTM inputs' }).click()
  while (await studio.locator('input:checked').count()) await studio.locator('input:checked').first().uncheck()
  await studio.getByRole('button', { name: 'Run LSTM' }).click()
  await studio.getByRole('alert').filter({ hasText: 'at least one input feature' }).waitFor()
  assert.equal(trainingRequests.length, 2, 'Invalid inputs must not start a job')
  console.log('PASS browser: invalid input selection is explained')

  await page.getByLabel('Region', { exact: true }).selectOption('Amajuba')
  await studio.getByText(/Forecast complete/).waitFor({ timeout: 120000 })
  assert.equal(trainingRequests.length, 3)
  assert.notEqual(trainingRequests[0].dataset_id, trainingRequests[2].dataset_id)
  assert.ok((await studio.innerText()).includes('Amajuba'))
  assert.deepEqual(errors, [])
  console.log('PASS browser: region change loads new data, forecasts and no JavaScript errors')

  await studio.getByLabel('Model', { exact: true }).selectOption('Naive')
  await studio.getByLabel('Target', { exact: true }).selectOption('tavg_c')
  await studio.getByLabel('Horizon', { exact: true }).selectOption('730')
  await studio.getByRole('button', { name: 'Run Naive' }).click()
  await studio.getByText(/Forecast complete.*24 future observations/).waitFor({ timeout: 60000 })
  assert.equal(trainingRequests.at(-1).target, 'tavg_c')
  console.log('PASS browser: target change and two-year forecast')

  simulateFailure = true
  await studio.getByRole('button', { name: 'Run Naive' }).click()
  await studio.getByRole('alert').filter({ hasText: 'Simulated training failure' }).waitFor({ timeout: 15000 })
  assert.equal(await studio.getByRole('button', { name: 'Run Naive' }).isEnabled(), true)
  assert.deepEqual(errors, [])
  console.log('PASS browser: failed jobs display errors and allow retry; legacy polling responses supported')
} catch (error) {
  console.log((await page.locator('body').innerText()).slice(-9000))
  console.log('JavaScript errors:', errors)
  throw error
} finally { await browser.close() }
