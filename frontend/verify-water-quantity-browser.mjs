import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const base = process.env.NIWIS_VERIFY_URL || 'http://127.0.0.1:5173'
const output = fileURLToPath(new URL('../output/water-quantity-dashboard/', import.meta.url))
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--disable-gpu', '--disable-software-rasterizer', '--disable-features=RendererCodeIntegrity'] })
const page = await browser.newPage({ viewport: { width: 1680, height: 1100 }, reducedMotion: 'reduce' })
page.setDefaultTimeout(30_000)
const errors = [], reads = [], payloads = new Map(), forecasts = []
let failSource = false
page.on('pageerror', error => errors.push(error.message))
page.on('console', message => { if (/Encountered two children with the same key|Each child in a list should have a unique/.test(message.text())) errors.push(message.text()) })
await page.route('https://fonts.googleapis.com/**', route => route.abort())
await page.route('https://fonts.gstatic.com/**', route => route.abort())
await page.route('**/api/water-quantity/**', async route => {
  const url = new URL(route.request().url())
  if (failSource && url.pathname.endsWith('/metadata')) return route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ detail: 'Water quantity source unavailable during recovery verification' }) })
  const response = await route.fetch({ timeout: 120_000 })
  reads.push({ path: url.pathname + url.search, status: response.status(), cache: response.headers()['x-niwis-cache'] })
  if (response.ok()) payloads.set(url.pathname.split('/').pop(), await response.json())
  return route.fulfill({ response })
})
const dashboard = page.locator('.water-quantity-dashboard')
const tabs = dashboard.getByRole('group', { name: 'Water quantity section', exact: true })
const mapPaths = dashboard.locator('.rq-map-panel .sat-district-map>svg>path[role="button"]')
const format = value => Number(value).toLocaleString('en-ZA', { maximumFractionDigits: 2 })

async function ready(region = 'National') {
  await dashboard.locator('.rq-kpi').first().waitFor({ timeout: 120_000 })
  await page.waitForFunction(expected => document.querySelector('select[aria-label="Water quantity district"]')?.value === expected && !document.querySelector('.water-quantity-dashboard .rq-loading'), region, { timeout: 120_000 })
}

try {
  await page.goto(base + '/water-quantity-assessment', { waitUntil: 'domcontentloaded' })
  await page.getByRole('heading', { name: 'Water Quantity Assessment', exact: true }).waitFor()
  await ready()
  const meta = payloads.get('metadata'), national = payloads.get('dashboard')
  assert.equal(meta.frequency, 'monthly')
  assert.equal(meta.transfer_indicators.length, 8)
  assert.equal(meta.balance_indicators.length, 12)
  assert.equal(meta.regions.length, 16)
  assert.equal(meta.audits.transfers.rows, 5152)
  assert.equal(meta.audits.balance.rows, 322)
  assert.equal(meta.cache_ttl_seconds, 86400)
  assert.equal(meta.first_period, '2000-01')
  assert.equal(meta.last_period, '2026-10')
  assert.equal(await mapPaths.count(), 52)
  assert.equal(await mapPaths.evaluateAll(nodes => nodes.filter(node => node.getAttribute('fill') !== '#254251').length), 16)
  assert.equal(await dashboard.locator('.rq-kpi>strong').first().evaluate(node => node.childNodes[0].textContent), '0')
  assert.ok((await dashboard.locator('.wq-zero-notice').innerText()).includes('16 selected source districts'))
  await page.screenshot({ path: output + 'transfers-desktop.png', fullPage: true })

  const beforeControls = reads.length
  for (const value of await page.getByLabel('Water quantity map indicator', { exact: true }).locator('option').evaluateAll(nodes => nodes.map(node => node.value))) {
    await page.getByLabel('Water quantity map indicator', { exact: true }).selectOption(value)
    assert.equal(await mapPaths.evaluateAll(nodes => nodes.filter(node => node.getAttribute('fill') !== '#254251').length), 16, 'Source zero values must remain present; uncovered districts must remain grey')
  }
  for (const select of await dashboard.locator('.wq-indicator-panel select[aria-label$=" indicator"]').all()) {
    for (const value of await select.locator('option').evaluateAll(nodes => nodes.map(node => node.value))) {
      await select.selectOption(value)
      await select.locator('xpath=ancestor::section').locator('.ww-chart').waitFor()
    }
  }
  for (const select of await dashboard.locator('select[aria-label$="chart style"]').all()) {
    await select.selectOption('bar')
    await select.locator('xpath=ancestor::section').locator('.recharts-bar').first().waitFor()
    await select.selectOption('line')
  }
  await dashboard.locator('.rq-map-panel path[role="button"][fill="#254251"]').first().click()
  assert.ok((await dashboard.locator('.wq-map-selection').innerText()).includes('No transfer records'))
  assert.equal(reads.length, beforeControls)
  await dashboard.locator('.rq-map-panel path[role="button"]:not([fill="#254251"])').first().click()
  await dashboard.locator('.rq-loading').waitFor({ state: 'hidden' })
  const district = payloads.get('dashboard').region
  await ready(district)
  assert.equal(payloads.get('dashboard').transfers.selected_districts, 1)
  assert.deepEqual(payloads.get('dashboard').balance, national.balance, 'Changing a transfer district must not change the separate national source')
  await dashboard.getByRole('button', { name: 'Return to source district mean', exact: true }).click()
  await ready()

  const beforeTab = reads.length
  await tabs.getByRole('button', { name: /National water balance/ }).click()
  assert.equal(reads.length, beforeTab)
  assert.equal(await dashboard.locator('.wq-component-table tbody tr').count(), 12)
  assert.ok((await dashboard.locator('.wq-scope-note').innerText()).includes('National'))
  assert.equal(await dashboard.locator('.rq-kpi>strong').first().evaluate(node => node.childNodes[0].textContent), format(national.balance.latest.reported_balance))
  assert.ok((await dashboard.locator('.wq-calculation-panel').innerText()).includes('MAP - AET - MAR - groundwater recharge + net IBT - total demand'))
  for (const check of Object.values(national.balance.calculation_checks)) assert.equal(check.matching_rows, check.complete_rows)
  const selector = page.getByLabel('National water components indicator', { exact: true })
  for (const value of await selector.locator('option').evaluateAll(nodes => nodes.map(node => node.value))) {
    await selector.selectOption(value)
    await selector.locator('xpath=ancestor::section').locator('.ww-chart').waitFor()
  }
  await page.screenshot({ path: output + 'national-balance-desktop.png', fullPage: true })

  await page.getByLabel('Water quantity start year', { exact: true }).selectOption('2026')
  await page.getByLabel('Water quantity end year', { exact: true }).selectOption('2025')
  await dashboard.getByRole('button', { name: 'Apply filters', exact: true }).click()
  await dashboard.getByRole('alert').waitFor()
  assert.ok((await dashboard.getByRole('alert').innerText()).includes('end year'))
  await page.getByLabel('Water quantity start year', { exact: true }).selectOption('2000')
  await page.getByLabel('Water quantity end year', { exact: true }).selectOption('2026')
  await dashboard.getByRole('button', { name: 'Apply filters', exact: true }).click()
  await ready()
  assert.equal(payloads.get('dashboard').balance.monthly.length, 322)
  assert.equal(payloads.get('dashboard').transfers.monthly.length, 322)
  const downloading = page.waitForEvent('download')
  await dashboard.getByRole('button', { name: 'Export monthly data', exact: true }).click()
  const download = await downloading
  await download.saveAs(output + 'export-verification.csv')
  const csv = await readFile(output + 'export-verification.csv', 'utf8')
  assert.ok(csv.includes('17_1_water_quantity_assessment_transfers_master'))
  assert.ok(csv.includes('17_2_national_water_balance_master'))
  assert.equal(csv.trim().split('\r\n').length, 322 * 20 + 1)
  await dashboard.locator('.rq-methods summary').click()
  assert.equal(await dashboard.locator('.rq-source-grid article').count(), 2)
  assert.ok((await dashboard.locator('.rq-methods').innerText()).includes('Daily timestamps'))

  await page.getByRole('button', { name: 'Open forecasting studio', exact: true }).click()
  const studio = page.getByRole('region', { name: 'Water Quantity Assessment forecasting studio', exact: true })
  await studio.getByRole('button', { name: 'Run LSTM', exact: true }).waitFor({ timeout: 120_000 })
  assert.equal(payloads.get('forecast-source').metrics.length, 12)
  assert.equal(payloads.get('forecast-source').series.length, 118)
  assert.equal(payloads.get('forecast-source').frequency, 'monthly')
  await studio.getByLabel('Model', { exact: true }).selectOption('Auto')
  await studio.getByLabel('Horizon', { exact: true }).selectOption('180')
  async function runMonthlyForecast() {
    const completion = page.waitForResponse(async response => response.url().includes('/models/jobs/') && response.ok() && (await response.json()).status === 'completed', { timeout: 120_000 })
    await studio.getByRole('button', { name: 'Run Auto', exact: true }).click()
    const body = await (await completion).json()
    assert.equal(body.result.observations, 118)
    assert.deepEqual(body.result.forecast_dates.map(value => value.slice(0, 7)), ['2026-11', '2026-12', '2027-01', '2027-02', '2027-03', '2027-04'])
    forecasts.push({ observations: body.result.observations, dates: body.result.forecast_dates, model: body.result.selected_model })
  }
  await runMonthlyForecast()
  await studio.getByLabel('Water Quantity Assessment forecast region', { exact: true }).selectOption('Transfers: Amajuba')
  await page.waitForFunction(() => document.querySelector('select[aria-label="Target"]')?.options.length === 8)
  assert.equal(payloads.get('forecast-source').source_table, '17_1_water_quantity_assessment_transfers_master')
  await runMonthlyForecast()

  await page.setViewportSize({ width: 390, height: 844 })
  await page.evaluate(() => scrollTo(0, 0))
  assert.equal(await page.locator('.water-quantity-shell>.nw-nav').isVisible(), false)
  await page.getByRole('button', { name: 'Toggle menu', exact: true }).click()
  assert.equal(await page.locator('.water-quantity-shell>.nw-nav').isVisible(), true)
  await page.getByRole('button', { name: 'Toggle menu', exact: true }).click()
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false)
  await page.screenshot({ path: output + 'national-balance-mobile.png', fullPage: true })
  await tabs.getByRole('button', { name: /Water transfers/ }).click()
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false)
  await page.screenshot({ path: output + 'transfers-mobile.png', fullPage: true })

  failSource = true
  await page.reload({ waitUntil: 'domcontentloaded' })
  await dashboard.getByRole('alert').waitFor({ timeout: 120_000 })
  assert.ok((await dashboard.getByRole('alert').innerText()).includes('source unavailable'))
  failSource = false
  await dashboard.getByRole('button', { name: 'Retry', exact: true }).click()
  await ready()
  assert.deepEqual(errors, [])
  await writeFile(output + 'browser-verification.json', JSON.stringify({ passed: true, errors, reads, forecasts, checks: ['real API through proxy', '8 transfer indicators', '12 national components and summaries', '16 covered and 36 uncovered districts', 'zero values retained', 'uncovered district message', 'independent national scope', 'stored formula audit', 'all indicator and style controls', 'monthly CSV export', 'both source Auto forecasts', 'mobile layout and menu', 'source outage and retry'] }, null, 2))
  console.log('PASS water quantity browser verification: monthly source records, 16 covered districts, independent national balance, 20 indicators, source calculations, both forecasts, export and recovery.')
} catch (error) {
  await page.screenshot({ path: output + 'browser-failure.png', fullPage: true }).catch(() => {})
  throw error
} finally {
  await browser.close()
}
