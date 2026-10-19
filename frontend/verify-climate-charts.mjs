import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { chromium } from 'playwright'

const browser = await chromium.launch({ channel: 'msedge', headless: true })
const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } })
const errors = []
let emptyTemperature = false
page.on('pageerror', error => errors.push(error.message))
await page.route('**/api/**', async route => {
  const url = new URL(route.request().url())
  if (url.pathname.startsWith('/niwis-api/')) return route.fulfill({ json: { predictions: [] } })
  if (url.pathname.startsWith('/api/climate/')) {
    const response = await route.fetch({ url: `http://127.0.0.1:8000${url.pathname.replace(/^\/api/, '')}${url.search}`, timeout: 120000 })
    if (emptyTemperature && url.pathname === '/api/climate/dashboard') {
      const result = await response.json()
      const keys = ['Tmin_C', 'Tmax_C', 'Tavg_C', 'Temperature_Anomaly_C', 'Heat_Days', 'Heat_Duration', 'Frost_Days', 'LST_Day_C', 'LST_Night_C']
      for (const row of [...result.series, ...result.map, result.summary]) for (const key of keys) row[key] = null
      return route.fulfill({ json: result })
    }
    return route.fulfill({ response })
  }
  return route.abort()
})
try {
  await mkdir('../output/climate-charts', { recursive: true })
  await page.goto('http://127.0.0.1:5181', { waitUntil: 'domcontentloaded' })
  await page.locator('.nw-navitem').filter({ hasText: /^2\.Climate$/ }).click()
  const titles = ['Temperature Change Variables', 'Wet and Dry Spell Variables', 'Mean Annual Precipitation (MAP)', 'Potential Evaporation Variables', 'Irrigation Demand Variables', 'Streamflow and Climate Linkage']
  for (const title of titles) {
    await page.getByRole('button', { name: title, exact: true }).click()
    await page.getByRole('heading', { name: title, exact: true }).waitFor()
    await page.locator('.cl-feature-chart .recharts-surface').waitFor({ timeout: 120000 })
    const mapBounds = await page.locator('.cl-section-map').boundingBox()
    const graphBounds = await page.locator('.cl-feature-chart').boundingBox()
    assert.ok(mapBounds.x + mapBounds.width <= graphBounds.x, 'Climate map must be to the left of the main graph')
    assert.equal(await page.locator('.cl-section-kpi').count(), 4)
    assert.ok(await page.locator('.cl-section-details .cl-chart').count() >= 2)
    assert.equal(await page.locator('.cl-error').count(), 0)
    const bars = page.getByRole('button', { name: 'Bars', exact: true })
    await bars.click()
    assert.equal(await bars.getAttribute('aria-pressed'), 'true')
    assert.ok(await page.locator('.cl-feature-chart .recharts-bar').count() > 0)
    const lines = page.getByRole('button', { name: 'Lines', exact: true })
    await lines.click()
    assert.ok(await page.locator('.cl-feature-chart .recharts-line').count() > 0)
    const yearTicks = await page.locator('.cl-feature-chart .recharts-xAxis .recharts-cartesian-axis-tick-value').allTextContents()
    assert.equal(yearTicks[0], '2000')
    assert.equal(yearTicks.at(-1), '2025')
    const legend = page.locator('.cl-feature-chart .cl-chart-legend button')
    if (await legend.count() > 1) {
      await legend.first().click()
      assert.equal(await legend.first().getAttribute('aria-pressed'), 'false')
      await legend.first().click()
    }
    const units = await page.locator('.cl-feature-chart .cl-chart-meta>span').first().innerText()
    assert.ok(!units.includes(' / '), 'Comparison lines must share a unit')
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false)
    await page.screenshot({ path: `../output/climate-charts/${title.split(' ')[0].toLowerCase()}-desktop.png`, fullPage: true })
    console.log(`PASS ${title}: real data, chart controls, shared units and desktop layout`)
  }

  await page.getByRole('button', { name: titles[0], exact: true }).click()
  await page.locator('.cl-feature-chart .recharts-surface').waitFor({ timeout: 120000 })
  const options = await page.getByLabel('Climate region').locator('option').allTextContents()
  const municipality = 'City of Tshwane'
  assert.ok(options.includes(municipality))
  await page.getByLabel('Climate region').selectOption({ label: municipality })
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click()
  await page.locator('.cl-feature-chart .recharts-surface').waitFor({ timeout: 120000 })
  assert.ok((await page.locator('.cl-context').innerText()).includes(municipality))
  assert.equal(await page.locator('.cl-section-map .municipality-map-caption strong').innerText(), municipality)
  assert.equal(await page.locator('.cl-section-map .municipality-map-label text').textContent(), municipality)
  const otherDistrict = page.locator('.cl-section-map path[aria-label="City of Cape Town"]')
  await otherDistrict.focus()
  assert.equal(await page.locator('.cl-section-map .municipality-map-caption strong').innerText(), 'City of Cape Town')
  await otherDistrict.evaluate(node => node.blur())
  assert.equal(await page.locator('.cl-section-map .municipality-map-caption strong').innerText(), municipality)
  await page.screenshot({ path: '../output/climate-charts/temperature-municipality-desktop.png', fullPage: true })
  const chartBounds = await page.locator('.cl-feature-chart .recharts-wrapper').boundingBox()
  await page.mouse.move(chartBounds.x + chartBounds.width / 2, chartBounds.y + chartBounds.height / 2)
  await page.locator('.cl-chart-tooltip').waitFor()
  assert.ok((await page.locator('.cl-chart-tooltip').innerText()).includes('\u00b0C'))
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export data', exact: true }).click()
  const download = await downloadPromise
  const csv = await download.createReadStream()
  let body = ''
  for await (const chunk of csv) body += chunk.toString()
  assert.ok(body.includes('Minimum temperature'))
  assert.ok(!body.includes('Irrigation demand'), 'Section export must only contain its own indicators')
  console.log('PASS municipality labels, keyboard focus, district filter and temperature-only CSV export')

  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(500)
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false)
  assert.ok(await page.locator('.cl-feature-chart .recharts-surface').isVisible())
  assert.ok((await page.locator('.cl-filters .cl-region').boundingBox()).width > 300)
  const mobileMap = await page.locator('.cl-section-map').boundingBox()
  const mobileGraph = await page.locator('.cl-feature-chart').boundingBox()
  assert.ok(mobileMap.y + mobileMap.height <= mobileGraph.y, 'Climate map must precede the graph when stacked')
  await page.screenshot({ path: '../output/climate-charts/temperature-mobile.png', fullPage: true })
  console.log('PASS mobile layout: no horizontal overflow')

  await page.setViewportSize({ width: 1600, height: 1100 })
  await page.getByRole('button', { name: 'Climate Dashboard', exact: true }).click()
  await page.locator('.cl-primary-grid .recharts-surface').waitFor({ timeout: 120000 })
  assert.ok(await page.locator('.cl-chart').count() >= 7)
  emptyTemperature = true
  await page.getByRole('button', { name: titles[0], exact: true }).click()
  await page.locator('.cl-feature-chart .cl-empty').waitFor({ timeout: 120000 })
  assert.equal(await page.locator('.cl-feature-chart .cl-empty').innerText(), 'No observations for this selection.')
  assert.ok((await page.locator('.cl-section-kpi').first().innerText()).includes('\u2014'))
  assert.deepEqual(errors, [])
  console.log('PASS combined climate dashboard, unavailable observations and no browser errors')
} finally {
  await browser.close()
}
