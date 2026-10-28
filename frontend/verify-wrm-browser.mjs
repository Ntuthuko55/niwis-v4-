import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const base = process.env.NIWIS_VERIFY_URL || 'http://127.0.0.1:5173'
const output = fileURLToPath(new URL('../output/wrm-dashboard/', import.meta.url))
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
await page.route('**/api/wrm/**', async route => {
  const url = new URL(route.request().url())
  if (failSource && url.pathname.endsWith('/metadata')) return route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ detail: 'WRM source unavailable during recovery verification' }) })
  const response = await route.fetch({ timeout: 120_000 })
  reads.push({ path: url.pathname + url.search, status: response.status(), cache: response.headers()['x-niwis-cache'] })
  if (response.ok()) payloads.set(url.pathname.split('/').pop(), await response.json())
  return route.fulfill({ response })
})
const dashboard = page.locator('.wrm-dashboard')
const mapPaths = dashboard.locator('.rq-map-panel .sat-district-map>svg>path[role="button"]')
const tabs = dashboard.getByRole('group', { name: 'WRM section', exact: true })
const format = value => Number(value).toLocaleString('en-ZA', { maximumFractionDigits: 2 })

async function ready(region = 'National', area = 'All SWSAs') {
  await dashboard.locator('.rq-kpi').first().waitFor({ timeout: 120_000 })
  await page.waitForFunction(({ region, area }) => document.querySelector('select[aria-label="WRM district"]')?.value === region && document.querySelector('select[aria-label="WRM source area"]')?.value === area && !document.querySelector('.wrm-dashboard .rq-loading'), { region, area }, { timeout: 120_000 })
}

try {
  await page.goto(base + '/water-resource-management', { waitUntil: 'domcontentloaded' })
  await page.getByRole('heading', { name: 'Water Resource Management', exact: true }).waitFor()
  await ready()
  const meta = payloads.get('metadata'), national = payloads.get('dashboard')
  assert.equal(meta.frequency, 'annual')
  assert.equal(meta.indicators.length, 16)
  assert.equal(meta.swsa_indicators.length, 6)
  assert.equal(meta.regions.length, 52)
  assert.equal(meta.areas.length, 5)
  assert.equal(meta.audits.matrix.rows, 1352)
  assert.equal(meta.audits.swsa.rows, 130)
  assert.equal(meta.default_end, 2025)
  assert.equal(meta.cache_ttl_seconds, 86400)
  assert.equal(await mapPaths.count(), 52)
  assert.equal(await mapPaths.evaluateAll(nodes => nodes.filter(node => node.getAttribute('fill') !== '#254251').length), 52)
  assert.equal(await dashboard.locator('.wr-variable-table tbody tr').count(), 16)
  assert.equal(await dashboard.locator('.rq-kpi>strong').first().evaluate(node => node.childNodes[0].textContent), format(national.matrix.latest.precipitation))
  assert.ok((await dashboard.locator('.rq-source-notice').innerText()).includes('equal district means'))
  await page.screenshot({ path: output + 'wrm-desktop.png', fullPage: true })

  const beforeControls = reads.length
  for (const select of await dashboard.locator('.wr-indicator-panel select[aria-label$=" indicator"]').all()) {
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
  for (const value of await page.getByLabel('WRM map indicator', { exact: true }).locator('option').evaluateAll(nodes => nodes.map(node => node.value))) {
    await page.getByLabel('WRM map indicator', { exact: true }).selectOption(value)
    assert.equal(await mapPaths.count(), 52)
  }
  assert.equal(reads.length, beforeControls)
  await mapPaths.first().click()
  await dashboard.locator('.rq-loading').waitFor({ state: 'hidden' })
  const district = payloads.get('dashboard').region
  await ready(district)
  assert.equal(payloads.get('dashboard').matrix.selected_entities, 1)
  assert.equal(payloads.get('dashboard').swsa.selected_entities, 5)
  assert.equal(await mapPaths.count(), 52)
  await dashboard.getByRole('button', { name: 'Return to National', exact: true }).click()
  await ready()

  await tabs.getByRole('button', { name: /Strategic Water Source Areas/ }).click()
  assert.equal(await dashboard.locator('.wr-area-card').count(), 5)
  const beforeAreaControls = reads.length
  for (const select of await dashboard.locator('.wr-indicator-panel select[aria-label$=" indicator"]').all()) {
    for (const value of await select.locator('option').evaluateAll(nodes => nodes.map(node => node.value))) {
      await select.selectOption(value)
      await select.locator('xpath=ancestor::section').locator('.ww-chart').waitFor()
    }
  }
  for (const value of await page.getByLabel('SWSA comparison indicator', { exact: true }).locator('option').evaluateAll(nodes => nodes.map(node => node.value))) await page.getByLabel('SWSA comparison indicator', { exact: true }).selectOption(value)
  assert.equal(reads.length, beforeAreaControls)
  assert.ok((await dashboard.innerText()).includes('Land-use change and wetlands'))
  await page.screenshot({ path: output + 'swsa-desktop.png', fullPage: true })
  await dashboard.locator('.wr-area-card').filter({ hasText: 'Cape Fold Mountains' }).click()
  await ready('National', 'Cape Fold Mountains')
  assert.equal(payloads.get('dashboard').swsa.selected_entities, 1)
  assert.equal(payloads.get('dashboard').matrix.selected_entities, 52)
  assert.ok((await dashboard.locator('.wr-selected-profile').innerText()).includes('Berg, Breede, Gouritz'))
  await dashboard.getByRole('button', { name: 'Show all SWSAs', exact: true }).click()
  await ready()

  await page.getByLabel('WRM start year', { exact: true }).selectOption('2025')
  await page.getByLabel('WRM end year', { exact: true }).selectOption('2024')
  await dashboard.getByRole('button', { name: 'Apply filters', exact: true }).click()
  await dashboard.getByRole('alert').waitFor()
  assert.ok((await dashboard.getByRole('alert').innerText()).includes('end year'))
  await page.getByLabel('WRM start year', { exact: true }).selectOption('2000')
  await page.getByLabel('WRM end year', { exact: true }).selectOption('2025')
  await dashboard.getByRole('button', { name: 'Apply filters', exact: true }).click()
  await ready()
  assert.equal(payloads.get('dashboard').matrix.series.length, 26)
  const downloading = page.waitForEvent('download')
  await dashboard.getByRole('button', { name: 'Export annual data', exact: true }).click()
  const download = await downloading
  await download.saveAs(output + 'export-verification.csv')
  const csv = await readFile(output + 'export-verification.csv', 'utf8')
  assert.ok(csv.includes('16_1_complete_wrm_matrix_master'))
  assert.ok(csv.includes('16_2_swsa_strategic_water_matrix_master'))
  assert.equal(csv.trim().split('\r\n').length, 26 * 22 + 1)
  await dashboard.locator('.rq-methods summary').click()
  assert.ok((await dashboard.locator('.rq-methods').innerText()).includes('district rows'))

  await page.getByRole('button', { name: 'Open forecasting studio', exact: true }).click()
  const studio = page.getByRole('region', { name: 'Water Resource Management forecasting studio', exact: true })
  await studio.getByRole('button', { name: 'Run Auto', exact: true }).waitFor({ timeout: 120_000 })
  assert.equal(payloads.get('forecast-source').series.length, 26)
  assert.equal(payloads.get('forecast-source').frequency, 'annual')
  assert.equal(await studio.getByLabel('Target', { exact: true }).locator('option').count(), 16)
  assert.deepEqual(await studio.getByLabel('Horizon', { exact: true }).locator('option').allTextContents(), ['1 year', '3 years', '5 years'])
  assert.equal(await studio.getByLabel('Model', { exact: true }).locator('option').count(), 4)
  async function runAnnualForecast() {
    const completion = page.waitForResponse(async response => response.url().includes('/models/jobs/') && response.ok() && (await response.json()).status === 'completed', { timeout: 120_000 })
    await studio.getByRole('button', { name: 'Run Auto', exact: true }).click()
    const body = await (await completion).json()
    assert.equal(body.result.frequency, 'annual')
    assert.equal(body.result.observations, 26)
    assert.deepEqual(body.result.forecast_dates.map(value => value.slice(0, 4)), ['2026', '2027', '2028'])
    forecasts.push({ frequency: body.result.frequency, observations: body.result.observations, dates: body.result.forecast_dates, model: body.result.selected_model })
  }
  await runAnnualForecast()
  await studio.getByLabel('Water Resource Management forecast region', { exact: true }).selectOption('SWSA: Cape Fold Mountains')
  await page.waitForFunction(() => document.querySelector('select[aria-label="Target"]')?.options.length === 6)
  assert.equal(payloads.get('forecast-source').source_table, '16_2_swsa_strategic_water_matrix_master')
  await runAnnualForecast()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.evaluate(() => scrollTo(0, 0))
  assert.equal(await page.locator('.wrm-shell>.nw-nav').isVisible(), false)
  await page.getByRole('button', { name: 'Toggle menu', exact: true }).click()
  assert.equal(await page.locator('.wrm-shell>.nw-nav').isVisible(), true)
  await page.getByRole('button', { name: 'Toggle menu', exact: true }).click()
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false)
  await page.screenshot({ path: output + 'swsa-mobile.png', fullPage: true })
  await tabs.getByRole('button', { name: /Complete WRM matrix/ }).click()
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false)
  await page.screenshot({ path: output + 'wrm-mobile.png', fullPage: true })

  failSource = true
  await page.reload({ waitUntil: 'domcontentloaded' })
  await dashboard.getByRole('alert').waitFor({ timeout: 120_000 })
  assert.ok((await dashboard.getByRole('alert').innerText()).includes('source unavailable'))
  failSource = false
  await dashboard.getByRole('button', { name: 'Retry', exact: true }).click()
  await ready()
  assert.deepEqual(errors, [])
  await writeFile(output + 'browser-verification.json', JSON.stringify({ passed: true, errors, reads, forecasts, checks: ['live API through proxy', '16 district variables', '6 SWSA variables', '52-district map', 'five area profiles', 'all indicator controls', 'independent area/district scope', 'date validation', 'annual CSV export', 'district and SWSA annual Auto forecasts', 'mobile layout and navigation', 'source outage and retry'] }, null, 2))
  console.log('PASS WRM browser checks: 22 indicators, 52 districts, five SWSAs, annual forecasts for both sources, export, mobile and error recovery.')
} catch (error) {
  await page.screenshot({ path: output + 'browser-failure.png', fullPage: true }).catch(() => {})
  throw error
} finally {
  await browser.close()
}
