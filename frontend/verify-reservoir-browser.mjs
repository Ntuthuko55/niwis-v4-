import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { chromium } from 'playwright'

const browser = await chromium.launch({ channel: 'msedge', headless: true })
const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } })
const errors = []
let failReservoir = false
page.on('pageerror', error => errors.push(error.message))
await page.route('https://fonts.googleapis.com/**', route => route.abort())
await page.route('https://fonts.gstatic.com/**', route => route.abort())
await page.route('**/api/**', async route => {
  const url = new URL(route.request().url())
  if (url.pathname.startsWith('/niwis-api/')) return route.fulfill({ json: { predictions: [] } })
  if (url.pathname.startsWith('/api/reservoirs/')) {
    if (failReservoir) return route.fulfill({ status: 503, json: { detail: 'Reservoir test source unavailable' } })
    const response = await route.fetch({ url: `http://127.0.0.1:8000${url.pathname.replace(/^\/api/, '')}${url.search}`, timeout: 120000 })
    return route.fulfill({ response })
  }
  return route.abort()
})

async function waitForRegion(region) {
  await page.locator('.rs-main-chart .rf-panel-heading h2').filter({ hasText: region }).waitFor({ timeout: 120000 })
  await page.locator('.rs-main-chart .recharts-surface').waitFor()
}

try {
  await mkdir('../output/reservoir-dashboard', { recursive: true })
  await page.goto((process.env.NIWIS_VERIFY_URL || 'http://127.0.0.1:5181') + '/reservoirs', { waitUntil: 'domcontentloaded' })
  await page.locator('.nw-navitem').filter({ hasText: /^10\.Dam and Reservoir Status$/ }).click()
  await waitForRegion('City of Tshwane')
  assert.equal(await page.getByLabel('Reservoir group').locator('option').count(), 54)
  assert.equal(await page.getByLabel('Reservoir map indicator').locator('option').count(), 12)
  assert.equal(await page.locator('.rf-kpi').count(), 6)
  assert.equal(await page.locator('.rs-chart-grid .cl-chart').count(), 4)
  assert.equal(await page.locator('.rf-error').count(), 0)
  assert.equal(await page.locator('.rf-map-panel .municipality-map-caption strong').innerText(), 'City of Tshwane')
  assert.equal(await page.locator('.rf-map-panel .municipality-map-label text').textContent(), 'City of Tshwane')
  assert.equal(await page.locator('.rs-indicators>div').last().locator('strong').innerText(), 'Unavailable')
  const priorities = page.locator('.rf-panel').filter({ has: page.getByRole('heading', { name: 'Priority national dams', exact: true }) })
  assert.equal(await priorities.locator('tbody tr').count(), 8)
  assert.equal(await priorities.getByText('Not in database table', { exact: true }).count(), 2)
  assert.equal(await priorities.locator('.rs-group-link').count(), 6)
  const mapBounds = await page.locator('.rf-map-panel').boundingBox()
  const graphBounds = await page.locator('.rs-main-chart').boundingBox()
  assert.ok(mapBounds.x + mapBounds.width <= graphBounds.x, 'The map must remain on the left')
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false)
  const background = await page.locator('.nw-main').evaluate(node => getComputedStyle(node).backgroundImage)
  assert.ok(background.includes('radial-gradient'), 'Use the shared drought background')
  for (const panel of await page.locator('.rs-main-chart, .rs-chart-grid .rf-panel').all()) {
    const ticks = await panel.locator('.recharts-yAxis .recharts-cartesian-axis-tick-value').allTextContents()
    assert.ok(ticks.length >= 2)
    assert.equal(new Set(ticks).size, ticks.length, 'Each axis tick must have a distinct readable label')
  }
  await page.screenshot({ path: '../output/reservoir-dashboard/tshwane-desktop.png', fullPage: true })
  console.log('PASS dashboard 10, 53 groups, 12 variables, DIR unavailable, inventory and desktop layout')

  await page.getByRole('button', { name: 'Water level / FSL', exact: true }).click()
  assert.equal(await page.locator('.rs-main-chart .recharts-line').count(), 2)
  assert.equal(await page.locator('.rs-main-chart .cl-chart-meta>span').first().innerText(), 'm amsl')
  await page.getByRole('button', { name: '% FSC', exact: true }).click()
  assert.equal(await page.locator('.rs-main-chart .cl-chart-meta>span').first().innerText(), '% FSC')
  await page.getByRole('button', { name: 'Storage volume', exact: true }).click()
  await page.getByRole('button', { name: 'Seepage / leakage', exact: true }).click()
  assert.equal(await page.locator('.rs-chart-grid .rf-panel').nth(2).locator('.cl-chart-meta>span').first().innerText(), 'm\u00b3/day')
  await page.getByRole('button', { name: 'NDWI', exact: true }).click()
  assert.equal(await page.locator('.rs-chart-grid .rf-panel').nth(3).locator('.cl-chart-meta>span').first().innerText(), 'index')
  await page.getByLabel('Reservoir map indicator').selectOption('fsl')
  assert.equal(await page.locator('.rf-map-panel .map-color-legend').getByText('Same source value').count(), 1)
  await page.getByLabel('Reservoir map indicator').selectOption('pct_fsc')
  console.log('PASS storage, level, FSC, seepage and NDWI tabs with correct units and constant-value map')

  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export data', exact: true }).click()
  const download = await downloadPromise
  const stream = await download.createReadStream()
  let csv = ''
  for await (const chunk of stream) csv += chunk.toString()
  const lines = csv.trim().split('\r\n')
  assert.equal(lines.length, 366)
  assert.ok(lines[0].includes('Storage volume (million m\u00b3)'))
  assert.ok(lines[0].includes('Reservoir NDWI (index)'))
  assert.ok(lines[1].includes('"City of Tshwane"'))
  const fields = lines[1].replace(/^"|"$/g, '').split('","')
  assert.equal(fields.length, 14)
  assert.ok(Number(fields[2]) > 250 && Number(fields[2]) < 253, 'Stock is converted to million m3')
  console.log('PASS export: 365 daily observations, 12 metric columns and stock conversion')

  await page.getByLabel('Reservoir group').selectOption('National')
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click()
  await waitForRegion('source group average')
  const alertTable = page.locator('.rf-panel').filter({ has: page.getByRole('heading', { name: /^Critical level alerts/ }) })
  assert.ok((await alertTable.innerText()).includes('Level 1'))
  await alertTable.getByRole('button', { name: 'Vhembe', exact: true }).click()
  await waitForRegion('Vhembe')
  assert.equal(await page.locator('.rf-map-panel .municipality-map-caption strong').innerText(), 'Vhembe')
  await page.locator('.rf-map-panel path[aria-label="City of Cape Town"]').focus()
  await page.keyboard.press('Enter')
  await waitForRegion('City of Cape Town')
  assert.equal(await page.getByLabel('Reservoir group').inputValue(), 'City of Cape Town')
  assert.equal(await page.locator('.rf-map-panel path[role="button"]').count(), 52)
  assert.equal(await page.locator('.rf-map-panel path[role="button"]').evaluateAll(nodes => nodes.filter(node => node.getAttribute('fill') !== '#254251').length), 52, 'Selecting a district retains national map values')
  await page.getByLabel('Reservoir group').selectOption('National')
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click()
  await waitForRegion('source group average')
  assert.ok((await page.locator('.rs-source-group').innerText()).includes('not national totals'))
  await page.getByLabel('Reservoir group').selectOption('City of Tshwane')
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click()
  await waitForRegion('City of Tshwane')
  const max = await page.getByLabel('Reservoir end date').getAttribute('max')
  assert.ok(max < '2026-12-31', 'Future dates must be excluded from monitoring')
  console.log('PASS critical alert selection, keyboard map selection, national average and date limit')

  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(500)
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false)
  const mobileMap = await page.locator('.rf-map-panel').boundingBox()
  const mobileGraph = await page.locator('.rs-main-chart').boundingBox()
  assert.ok(mobileMap.y + mobileMap.height <= mobileGraph.y)
  await page.screenshot({ path: '../output/reservoir-dashboard/tshwane-mobile.png', fullPage: true })
  console.log('PASS mobile layout: map first and no horizontal overflow')

  await page.setViewportSize({ width: 1600, height: 1100 })
  failReservoir = true
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: 'Reservoir test source unavailable' }).waitFor()
  assert.equal(await page.locator('.rs-main-chart').count(), 0, 'A failed load must not display invented values')
  failReservoir = false
  await page.getByRole('button', { name: 'Retry', exact: true }).click()
  await waitForRegion('City of Tshwane')
  assert.deepEqual(errors, [])
  console.log('PASS source failure, retry recovery and no browser errors')
} finally {
  await browser.close()
}
