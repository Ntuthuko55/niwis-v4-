import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const base = process.env.NIWIS_VERIFY_URL || 'http://127.0.0.1:5173'
const output = fileURLToPath(new URL('../output/rwqo-dashboard/', import.meta.url))
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--disable-gpu', '--disable-software-rasterizer', '--disable-features=RendererCodeIntegrity'] })
const page = await browser.newPage({ viewport: { width: 1680, height: 1100 }, reducedMotion: 'reduce' })
page.setDefaultTimeout(30_000)
const errors = [], reads = [], payloads = new Map()
let failSource = false
page.on('pageerror', error => errors.push(error.message))
page.on('console', message => { if (/Encountered two children with the same key|Each child in a list should have a unique/.test(message.text())) errors.push(message.text()) })
await page.route('https://fonts.googleapis.com/**', route => route.abort())
await page.route('https://fonts.gstatic.com/**', route => route.abort())
await page.route('**/api/rwqo/**', async route => {
  const url = new URL(route.request().url())
  if (failSource && url.pathname.endsWith('/metadata')) return route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ detail: 'RWQO source unavailable during recovery verification' }) })
  const response = await route.fetch({ timeout: 120_000 })
  reads.push({ path: url.pathname + url.search, status: response.status(), cache: response.headers()['x-niwis-cache'] })
  if (response.ok()) payloads.set(url.pathname.split('/').pop(), await response.json())
  return route.fulfill({ response })
})
const dashboard = page.locator('.rwqo-dashboard')
const mapPaths = dashboard.locator('.rq-map-panel .sat-district-map>svg>path[role="button"]')
const format = value => Number(value).toLocaleString('en-ZA', { maximumFractionDigits: 2 })

async function ready(region = 'National') {
  await dashboard.locator('.rq-kpi').first().waitFor({ timeout: 120_000 })
  await page.waitForFunction(expected => document.querySelector('select[aria-label="RWQO region"]')?.value === expected && !document.querySelector('.rq-loading'), region, { timeout: 120_000 })
}

try {
  await page.goto(base + '/resource-water-quality-objectives', { waitUntil: 'domcontentloaded' })
  await page.getByRole('heading', { name: 'Resource Water Quality Objectives', exact: true }).waitFor()
  await ready()
  const meta = payloads.get('metadata'), national = payloads.get('dashboard')
  assert.equal(meta.sections.length, 3)
  assert.equal(meta.sections.flatMap(item => item.indicators).length, 18)
  assert.equal(meta.cache_ttl_seconds, 86400)
  assert.equal(meta.regions.length, 52)
  assert.equal(await mapPaths.count(), 52)
  assert.equal(await dashboard.locator('.rq-kpi').count(), 4)
  assert.equal(await dashboard.locator('.rq-kpi>strong').first().evaluate(node => node.childNodes[0].textContent), format(national.sections.ecological.latest.sass5_score))
  assert.ok((await dashboard.locator('.rq-source-notice').innerText()).includes('negative measurement'))
  assert.equal(await dashboard.locator('.rq-metric-panel .recharts-wrapper').count(), 2)
  await page.getByRole('button', { name: 'Resource Water Quality Objectives', exact: false }).first().scrollIntoViewIfNeeded()
  await page.evaluate(() => scrollTo(0, 0))
  await page.screenshot({ path: output + 'ecological-desktop.png', fullPage: true })

  const beforeControls = reads.length
  for (const [key, name, objectiveCount] of [['chemical', 'Chemical objectives', 6], ['hydrological', 'Hydrological objectives', 5], ['ecological', 'Ecological variables', 0]]) {
    await page.getByRole('group', { name: 'RWQO section', exact: true }).getByRole('button', { name: new RegExp(name) }).click()
    const section = national.sections[key]
    assert.equal(section.coverage.passed + section.coverage.failed, section.coverage.assessed)
    if (objectiveCount) assert.equal(await dashboard.locator('.rq-checks tbody tr').count(), objectiveCount)
    for (const select of await dashboard.locator('.rq-metric-panel select[aria-label$=" indicator"]').all()) {
      const values = await select.locator('option').evaluateAll(nodes => nodes.map(node => node.value))
      for (const value of values) {
        await select.selectOption(value)
        assert.equal(await select.inputValue(), value)
        await select.locator('xpath=ancestor::section').locator('.ww-chart').waitFor()
      }
    }
    for (const select of await dashboard.locator('select[aria-label$="chart style"]').all()) {
      await select.selectOption('bar')
      await select.locator('xpath=ancestor::section').locator('.recharts-bar').first().waitFor()
      await select.selectOption('line')
    }
    if (key === 'chemical') {
      await page.getByLabel('Chemical water quality indicator', { exact: true }).selectOption('ph')
      assert.equal(await dashboard.locator('.rq-metric-panel').first().locator('.recharts-reference-line-line').count(), 2)
      await page.screenshot({ path: output + 'chemical-desktop.png', fullPage: true })
    }
    if (key === 'hydrological') await page.screenshot({ path: output + 'hydrological-desktop.png', fullPage: true })
  }
  await page.getByRole('group', { name: 'RWQO trend cadence', exact: true }).getByRole('button', { name: 'Monthly', exact: true }).click()
  await page.getByLabel('RWQO map indicator', { exact: true }).selectOption('ecological_reserve_q')
  assert.equal(reads.length, beforeControls, 'Section, indicator and chart controls must reuse loaded data')
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false)

  await mapPaths.first().click()
  const districtName = await mapPaths.first().getAttribute('aria-label')
  await ready(districtName)
  assert.ok((await dashboard.locator('.rq-context').innerText()).includes(districtName))
  assert.equal(payloads.get('dashboard').sections.ecological.coverage.selected_districts, 1)
  assert.equal(await mapPaths.count(), 52)
  await dashboard.getByRole('button', { name: 'Return to National', exact: true }).click()
  await ready()

  await page.getByLabel('RWQO start year', { exact: true }).selectOption('2026')
  await page.getByLabel('RWQO end year', { exact: true }).selectOption('2025')
  await dashboard.getByRole('button', { name: 'Apply filters', exact: true }).click()
  await dashboard.getByRole('alert').waitFor()
  assert.ok((await dashboard.getByRole('alert').innerText()).includes('end year'))
  await page.getByLabel('RWQO start year', { exact: true }).selectOption('2020')
  await page.getByLabel('RWQO end year', { exact: true }).selectOption('2026')
  await dashboard.getByRole('button', { name: 'Apply filters', exact: true }).click()
  await ready()
  assert.equal(payloads.get('dashboard').start, 2020)

  const downloading = page.waitForEvent('download')
  await dashboard.getByRole('button', { name: 'Export monthly data', exact: true }).click()
  const download = await downloading
  await download.saveAs(output + 'export-verification.csv')
  const csv = await readFile(output + 'export-verification.csv', 'utf8')
  assert.ok(csv.includes('15.1_ecological_variables_master'))
  assert.ok(csv.includes('15.2_chemical_RWQO_variables_master'))
  assert.ok(csv.includes('15.3_hydrological_RWQO_variables_master'))
  assert.ok(csv.includes('"2026-10"'))

  await dashboard.locator('.rq-methods summary').click()
  assert.equal(await dashboard.locator('.rq-source-grid article').count(), 3)
  assert.ok((await dashboard.locator('.rq-methods').innerText()).includes('Ecological targets and assessment flags are not supplied'))
  await page.getByRole('button', { name: 'Open forecasting studio', exact: true }).click()
  await page.locator('.nw-dash-forecast').getByRole('button', { name: 'Run LSTM', exact: true }).waitFor({ timeout: 120_000 })
  assert.equal(payloads.get('forecast-metadata').metrics.length, 18)
  assert.equal(payloads.get('forecast-source').series.length, 118)
  assert.equal(payloads.get('forecast-source').frequency, 'monthly')

  const studio = page.getByRole('region', { name: 'Resource Water Quality Objectives forecasting studio', exact: true })
  await studio.getByLabel('Model', { exact: true }).selectOption('Auto')
  await studio.getByLabel('Target', { exact: true }).selectOption('dissolved_oxygen')
  await studio.getByLabel('Horizon', { exact: true }).selectOption('180')
  await studio.getByRole('button', { name: 'Run Auto', exact: true }).click()
  await studio.getByText(/Forecast complete/).waitFor({ timeout: 120_000 })
  assert.ok((await studio.innerText()).includes('6 future observations'))

  await page.setViewportSize({ width: 390, height: 844 })
  await page.evaluate(() => scrollTo(0, 0))
  assert.equal(await page.locator('.rwqo-shell>.nw-nav').isVisible(), false)
  await page.getByRole('button', { name: 'Toggle menu', exact: true }).click()
  assert.equal(await page.locator('.rwqo-shell>.nw-nav').isVisible(), true)
  await page.getByRole('button', { name: 'Toggle menu', exact: true }).click()
  await page.screenshot({ path: output + 'mobile.png', fullPage: true })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, 'Mobile document must not overflow horizontally')

  failSource = true
  await page.reload({ waitUntil: 'domcontentloaded' })
  await dashboard.getByRole('alert').waitFor({ timeout: 120_000 })
  assert.ok((await dashboard.getByRole('alert').innerText()).includes('source unavailable'))
  failSource = false
  await dashboard.getByRole('button', { name: 'Retry', exact: true }).click()
  await ready()
  assert.equal(await dashboard.getByRole('alert').count(), 0)
  assert.deepEqual(errors, [])
  await writeFile(output + 'browser-verification.json', JSON.stringify({ passed: true, errors, reads, checks: ['live proxy/API', '18 measurements', '52-district map', 'three sections', 'all indicator controls', 'chart styles', 'source target references', 'district filtering', 'date validation', 'CSV export', 'forecast source registration', 'Auto six-month forecast', 'mobile layout and navigation', 'source failure and retry'] }, null, 2))
  console.log('PASS RWQO live database browser verification: 18 measurements, three sections, 52 districts, filters, export, forecasting, mobile and source recovery.')
} finally {
  await browser.close()
}
