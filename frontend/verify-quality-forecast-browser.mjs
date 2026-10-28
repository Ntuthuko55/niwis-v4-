import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const frontendURL = process.env.NIWIS_VERIFY_URL || 'http://127.0.0.1:5173'
const backendURL = process.env.NIWIS_VERIFY_API || 'http://127.0.0.1:8001'
const outputDir = fileURLToPath(new URL('../output/quality-forecast/', import.meta.url))
await mkdir(outputDir, { recursive: true })
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--disable-gpu', '--disable-software-rasterizer', '--disable-features=RendererCodeIntegrity'] })
const page = await browser.newPage({ viewport: { width: 1600, height: 1100 }, reducedMotion: 'reduce' })
const runtimeErrors = []
const apiReads = []
const metadata = new Map()
const sources = new Map()
const registrations = []
const trainingRequests = []
const jobs = new Map()
const forecasts = []
let failSource = ''
page.on('pageerror', error => runtimeErrors.push(error.message))
page.on('console', message => {
  if (/Encountered two children with the same key|Each child in a list should have a unique/.test(message.text())) runtimeErrors.push(message.text())
})
await page.route('https://fonts.googleapis.com/**', route => route.abort())
await page.route('https://fonts.gstatic.com/**', route => route.abort())
await page.route('**/api/**', async route => {
  const request = route.request()
  const url = new URL(request.url())
  const path = url.pathname.replace(/^\/api/, '')
  if (!/^\/(?:wastewater|drinking-water)\//.test(path) && path !== '/dashboard/dataset' && !path.startsWith('/models/')) return route.continue()
  const module = path.split('/')[1]
  if (failSource === module && path.endsWith('/forecast-source')) return route.fulfill({ status: 503, contentType: 'text/plain', body: 'Quality forecasting source unavailable for browser verification' })
  const response = await route.fetch({ url: backendURL + path + url.search, timeout: 120_000 })
  apiReads.push({ method: request.method(), path: path + url.search, status: response.status() })
  let payload
  if (response.ok()) {
    payload = await response.json()
    if (path.endsWith('/forecast-metadata')) metadata.set(module, payload)
    if (path.endsWith('/forecast-source')) sources.set(`${module}:${url.searchParams.get('region') || 'National'}`, payload)
    if (path === '/dashboard/dataset') registrations.push({ request: request.postDataJSON(), response: payload })
    if (path === '/models/train') trainingRequests.push({ request: request.postDataJSON(), response: payload })
    if (path.startsWith('/models/jobs/')) jobs.set(path.split('/').pop(), payload)
  }
  return route.fulfill({ response })
})

const modules = [
  { id: 'wastewater', route: '/wastewater-compliance', label: 'Wastewater quality', targets: 27, heading: 'Wastewater Quality Compliance' },
  { id: 'drinking-water', route: '/drinking-water-compliance', label: 'Drinking water quality', targets: 15, heading: 'Drinking Water Quality Compliance' },
]
const sourceRows = payload => payload.series || payload.rows || payload.data || []
const rowDate = row => row.date ?? row.period ?? row.month
const catalogue = meta => meta.metrics || meta.indicators || []
const studioFor = module => page.locator(`section.nw-overview-forecast[aria-label="${module.label} forecasting studio"]`)

async function waitForSource(module, region) {
  const studio = studioFor(module)
  await studio.getByLabel('Model', { exact: true }).waitFor({ timeout: 120_000 })
  await page.waitForFunction(({ label, region }) => {
    const section = document.querySelector(`section[aria-label="${label} forecasting studio"]`)
    return section?.querySelector(`select[aria-label="${label} forecast region"]`)?.value === region && !section.querySelector('.nw-forecast-loading')
  }, { label: module.label, region }, { timeout: 120_000 })
  await studio.locator('.js-plotly-plot').waitFor({ timeout: 120_000 })
  const payload = sources.get(`${module.id}:${region}`)
  assert.ok(payload, `Expected a real ${module.id} source response for ${region}`)
  const rows = sourceRows(payload)
  assert.ok(rows.length >= 36, 'The forecasting history must contain enough actual monthly observations for LSTM')
  assert.ok(rows.every(row => rowDate(row)), 'Every source observation must have its own reporting period')
  assert.equal(new Set(rows.map(row => String(rowDate(row)).slice(0, 7))).size, rows.length, 'The forecast adapter must return one record per month')
  const registration = registrations.filter(item => item.request.dashboard === module.id && item.request.region === region).at(-1)
  assert.ok(registration?.response.dataset_id, 'The source must be registered in the shared training registry')
  assert.equal(registration.request.rows.length, rows.length)
  assert.equal(registration.response.row_count, rows.length)
  assert.equal(String(registration.request.rows.at(-1).date).slice(0, 7), String(rowDate(rows.at(-1))).slice(0, 7))
  return { studio, payload, rows, registration }
}

async function assertPlottedResult(module, forecastCount, expectedModel, region) {
  const studio = studioFor(module)
  await studio.getByText(new RegExp(`Forecast complete.*${forecastCount} future observations`)).waitFor({ timeout: 180_000 })
  const submitted = trainingRequests.at(-1)
  assert.ok(submitted?.response.job_id, 'Training must return a real job ID')
  const job = jobs.get(submitted.response.job_id)
  assert.equal(job?.status, 'completed')
  assert.equal(job.job_id, submitted.response.job_id)
  assert.equal(submitted.request.model_type, expectedModel)
  const registration = registrations.find(item => item.response.dataset_id === submitted.request.dataset_id)
  assert.ok(registration, 'The training job must use a dataset registered by this browser session')
  assert.equal(registration.request.dashboard, module.id)
  assert.equal(registration.request.region, region)
  const result = job.result
  assert.equal(result.forecast_dates.length, forecastCount)
  assert.equal(result.forecast_values.length, forecastCount)
  assert.ok(result.forecast_values.every(value => typeof value === 'number' && Number.isFinite(value)))
  const latest = Math.max(...registration.request.rows.map(row => Date.parse(row.date)))
  assert.ok(result.forecast_dates.every(date => Date.parse(date) > latest), 'Every predicted timestamp must follow the source history')
  assert.equal(new Set(result.forecast_dates).size, forecastCount)
  if (expectedModel === 'naive') {
    const latestTarget = registration.request.rows.filter(row => typeof row[submitted.request.target] === 'number').at(-1)[submitted.request.target]
    assert.ok(result.forecast_values.every(value => Math.abs(value - latestTarget) < 1e-7), 'Naive must forecast the actual selected source series')
  }
  await page.waitForFunction(({ label, count }) => {
    const plot = document.querySelector(`section[aria-label="${label} forecasting studio"] .js-plotly-plot`)
    return plot?.data?.some(trace => /^Forecast/.test(trace.name || '') && trace.y?.length === count)
  }, { label: module.label, count: forecastCount })
  const plotted = await studio.locator('.js-plotly-plot').evaluate(node => {
    const trace = node.data.find(item => /^Forecast/.test(item.name || ''))
    return { dates: Array.from(trace.x), values: Array.from(trace.y) }
  })
  assert.deepEqual(plotted.values, result.forecast_values)
  assert.deepEqual(plotted.dates, result.forecast_dates)
  forecasts.push({ dashboard: module.id, region, model: expectedModel, target: submitted.request.target, dataset_id: submitted.request.dataset_id, job_id: submitted.response.job_id, history_end: new Date(latest).toISOString(), dates: result.forecast_dates, values: result.forecast_values, features: submitted.request.features })
  return submitted
}

try {
  for (const module of modules) {
    const previousTrainingCount = trainingRequests.length
    await page.setViewportSize({ width: 1600, height: 1100 })
    await page.goto(frontendURL + module.route, { waitUntil: 'domcontentloaded' })
    await page.getByRole('heading', { name: module.heading, exact: true }).waitFor()
    const open = page.getByRole('button', { name: 'Open forecasting studio', exact: true })
    await open.waitFor()
    assert.equal(await page.locator('.nw-overview-forecast').count(), 0, 'The forecasting studio stays deferred until opened')
    await open.click()
    const national = await waitForSource(module, 'National')
    const studio = national.studio
    assert.equal(await page.locator('.nw-overview-forecast').count(), 1)
    assert.equal(await studio.getByLabel(`${module.label} forecast region`, { exact: true }).locator('option').count(), 53)
    assert.equal(await studio.getByLabel('Model', { exact: true }).inputValue(), 'LSTM')
    assert.equal(trainingRequests.length, previousTrainingCount, 'Opening the studio must not train automatically')
    const targets = await studio.getByLabel('Target', { exact: true }).locator('option').evaluateAll(nodes => nodes.map(node => node.value))
    assert.equal(targets.length, module.targets)
    const allowed = new Set(catalogue(metadata.get(module.id)).map(item => item.key))
    assert.ok(targets.every(target => allowed.has(target)), 'Targets must come from actual source measurement descriptors')
    assert.ok(targets.every(target => !/compliant|_pass_pct|shape|year|count|flagged|failed|assessed|minimum|maximum/i.test(target)), 'Flags, identifiers and counts cannot become forecast targets')
    assert.ok(targets.every(target => national.rows.some(row => typeof row[target] === 'number' && Number.isFinite(row[target]))))
    await studio.getByLabel('Model', { exact: true }).selectOption('Naive')
    await studio.getByLabel('Horizon', { exact: true }).selectOption('180')
    await studio.getByRole('button', { name: 'Run Naive', exact: true }).click()
    const nationalTraining = await assertPlottedResult(module, 6, 'naive', 'National')
    console.log(`PASS ${module.id}: deferred manual studio, ${targets.length} true targets, national source and six-month real Naive job`)

    const currentTarget = await studio.getByLabel('Target', { exact: true }).inputValue()
    const nextTarget = targets.find(target => target !== currentTarget && !/chlorine|rainfall|evaporation|flood/i.test(target))
    await studio.getByLabel('Target', { exact: true }).selectOption(nextTarget)
    assert.equal(await studio.getByText(/Forecast complete/).count(), 0, 'Changing the target clears the previous forecast')
    await studio.getByLabel(`${module.label} forecast region`, { exact: true }).selectOption('Alfred Nzo')
    const district = await waitForSource(module, 'Alfred Nzo')
    assert.notEqual(district.registration.response.dataset_id, nationalTraining.request.dataset_id)
    assert.notDeepEqual(district.rows.map(row => row[nextTarget]), national.rows.map(row => row[nextTarget]), 'District history must differ from national history for the selected measurement')
    await studio.getByLabel('Horizon', { exact: true }).selectOption('365')
    await studio.getByRole('button', { name: 'Run Naive', exact: true }).click()
    const districtTraining = await assertPlottedResult(module, 12, 'naive', 'Alfred Nzo')
    assert.notEqual(districtTraining.request.dataset_id, nationalTraining.request.dataset_id)
    assert.equal(districtTraining.request.target, nextTarget)
    assert.equal(districtTraining.request.forecast_steps, 365)
    await studio.scrollIntoViewIfNeeded()
    await studio.screenshot({ path: outputDir + `${module.id}-desktop.png` })
    console.log(`PASS ${module.id}: changed target, district dataset isolation, one-year horizon and plotted future values`)

    if (module.id === 'wastewater') {
      await studio.getByLabel('Model', { exact: true }).selectOption('LSTM')
      await studio.getByLabel('Horizon', { exact: true }).selectOption('180')
      await studio.getByRole('button', { name: 'Show LSTM inputs', exact: true }).click()
      assert.equal(await studio.locator('.nw-dash-feature-grid input').count(), targets.length - 1)
      while (await studio.locator('.nw-dash-feature-grid input:checked').count()) await studio.locator('.nw-dash-feature-grid input:checked').first().uncheck()
      const beforeInvalid = trainingRequests.length
      await studio.getByRole('button', { name: 'Run LSTM', exact: true }).click()
      await studio.getByRole('alert').filter({ hasText: 'at least one input feature' }).waitFor()
      assert.equal(trainingRequests.length, beforeInvalid, 'Missing features must not start a training job')
      await studio.locator('.nw-dash-feature-grid input').first().check()
      await studio.getByRole('button', { name: 'Run LSTM', exact: true }).click()
      const lstm = await assertPlottedResult(module, 6, 'lstm', 'Alfred Nzo')
      assert.ok(lstm.request.features.length > 0)
      assert.ok(!lstm.request.features.includes(lstm.request.target))
      await studio.screenshot({ path: outputDir + 'wastewater-lstm-desktop.png' })
      console.log('PASS wastewater: invalid LSTM inputs explained, actual selected-feature LSTM training completes')
    }

    await page.setViewportSize({ width: 390, height: 844 })
    await studio.scrollIntoViewIfNeeded()
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `${module.label} forecasting studio must not overflow on mobile`)
    await studio.screenshot({ path: outputDir + `${module.id}-mobile.png` })
    console.log(`PASS ${module.id}: mobile forecast controls and chart at390px`)
  }

  const drinking = modules[1]
  const studio = studioFor(drinking)
  failSource = drinking.id
  await studio.getByLabel(`${drinking.label} forecast region`, { exact: true }).selectOption('Amajuba')
  await studio.getByRole('alert').filter({ hasText: 'Quality forecasting source unavailable for browser verification' }).waitFor({ timeout: 120_000 })
  failSource = ''
  const retry = studio.getByRole('button', { name: /retry/i })
  assert.ok(await retry.count(), 'A forecast source failure needs a visible retry action')
  await retry.click()
  await waitForSource(drinking, 'Amajuba')
  assert.equal(await studio.getByRole('alert').count(), 0)
  assert.deepEqual(runtimeErrors, [])
  assert.ok(apiReads.every(item => item.status === 200))
  await writeFile(outputDir + 'verification.json', JSON.stringify({ checkedAt: new Date().toISOString(), frontendURL, backendURL, apiReads, forecasts, runtimeErrors, checks: ['deferred manual load', 'true source targets', 'real dataset registration', 'real jobs and polling', 'future-only forecast dates', 'national/district dataset isolation', 'target/model/horizon changes', 'LSTM feature validation and training', 'mobile390', 'plain-text source503 and retry'] }, null, 2))
  console.log('PASS source503 recovery, job polling and no browser runtime/duplicate-key errors in both quality studios')
} catch (error) {
  await writeFile(outputDir + 'failure.txt', (await page.locator('body').innerText()).slice(-14_000) + '\n\n' + error.stack)
  throw error
} finally {
  await browser.close()
}
