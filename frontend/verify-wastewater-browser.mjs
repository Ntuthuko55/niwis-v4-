import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const frontendURL = process.env.NIWIS_VERIFY_URL || 'http://127.0.0.1:5173'
const backendURL = process.env.NIWIS_VERIFY_API || 'http://127.0.0.1:8001'
const outputDir = fileURLToPath(new URL('../output/wastewater-dashboard/', import.meta.url))
await mkdir(outputDir, { recursive: true })

const browser = await chromium.launch({
  channel: 'msedge',
  headless: true,
  args: ['--disable-gpu', '--disable-software-rasterizer', '--disable-features=RendererCodeIntegrity'],
})
const page = await browser.newPage({ viewport: { width: 1820, height: 1120 }, reducedMotion: 'reduce' })
const errors = []
const apiReads = []
const payloads = new Map()
let failDashboard = false
page.on('pageerror', error => errors.push(error.message))
page.on('console', message => {
  if (/Encountered two children with the same key|Each child in a list should have a unique/.test(message.text())) errors.push(message.text())
})
await page.route('https://fonts.googleapis.com/**', route => route.abort())
await page.route('https://fonts.gstatic.com/**', route => route.abort())
await page.route('**/api/wastewater/**', async route => {
  const url = new URL(route.request().url())
  if (failDashboard && url.pathname.endsWith('/dashboard')) {
    return route.fulfill({ status: 503, contentType: 'text/plain', body: 'Wastewater source unavailable for browser verification' })
  }
  const response = await route.fetch({ url: backendURL + url.pathname.replace(/^\/api/, '') + url.search, timeout: 120_000 })
  apiReads.push({ path: url.pathname + url.search, status: response.status() })
  if (response.ok()) {
    const payload = await response.json()
    const endpoint = url.pathname.split('/').pop()
    payloads.set(endpoint, payload)
    if (endpoint === 'dashboard') payloads.set(`dashboard:${payload.region}`, payload)
  }
  return route.fulfill({ response })
})

const mapPaths = () => page.locator('.ww-primary-grid .rf-map-panel .sat-district-map>svg>path[role="button"]')
const format = (value, digits = 2) => Number(value).toLocaleString('en-ZA', { maximumFractionDigits: digits })

async function waitForDashboard(region) {
  await page.locator('.ww-kpi').first().waitFor({ timeout: 120_000 })
  await page.waitForFunction(name => {
    const context = document.querySelector('.ww-context')
    return context?.textContent.includes(name === 'National' ? 'South Africa' : name)
  }, region, { timeout: 120_000 })
  await page.waitForFunction(() => !document.querySelector('.rf-loading'), null, { timeout: 120_000 })
  await page.locator('.ww-chart .recharts-wrapper>svg.recharts-surface').first().waitFor()
}

async function changeIndicator(label) {
  const select = page.getByLabel(label, { exact: true })
  const options = await select.locator('option').evaluateAll(nodes => nodes.map(node => ({ value: node.value, text: node.textContent })))
  assert.ok(options.length > 1, `${label} must offer more than one actual source indicator`)
  const current = await select.inputValue()
  const next = options.find(option => option.value !== current)
  const panel = select.locator('xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " ww-trend-panel ")][1]')
  await select.selectOption(next.value)
  assert.equal(await select.inputValue(), next.value)
  const currentPayload = payloads.get(`dashboard:${await page.getByLabel('Wastewater region', { exact: true }).inputValue()}`)
  const expected = format(currentPayload.indicators[next.value].latest)
  await page.waitForFunction(({ name, expectedValue }) => {
    const input = document.querySelector(`select[aria-label="${name}"]`)
    return input?.closest('.ww-trend-panel')?.querySelector('.ww-readout strong')?.textContent.includes(expectedValue)
  }, { name: label, expectedValue: expected })
  await panel.locator('.ww-chart .recharts-wrapper>svg.recharts-surface').waitFor()
  assert.ok(await panel.locator('.ww-chart .recharts-wrapper>svg.recharts-surface').count(), `${label} must keep its graph rendered`)
  return next.text
}

async function assertUniqueNumericTicks() {
  for (const chart of await page.locator('.ww-chart').all()) {
    const horizontal = await chart.evaluate(node => Boolean(node.closest('.ww-district-panel')))
    const axis = chart.locator(horizontal ? '.recharts-xAxis' : '.recharts-yAxis')
    await axis.locator('.recharts-cartesian-axis-tick-value').first().waitFor()
    const labels = (await axis.locator('.recharts-cartesian-axis-tick-value').allTextContents()).map(value => value.trim())
    const name = await chart.getAttribute('aria-label')
    assert.ok(labels.length >= 2, `${name} must have a readable numeric axis`)
    assert.equal(new Set(labels).size, labels.length, `${name} must use enough precision for distinct numeric tick labels: ${labels.join(', ')}`)
  }
}

try {
  await page.goto(frontendURL + '/wastewater-compliance', { waitUntil: 'domcontentloaded' })
  await page.getByRole('heading', { name: 'Wastewater Quality Compliance', exact: true }).waitFor()
  await waitForDashboard('National')
  const metadata = payloads.get('metadata')
  const national = payloads.get('dashboard:National')
  assert.equal(metadata.source, 'Supabase')
  assert.equal(metadata.source_tables.length, 3)
  assert.ok(national.series.length >= 2, 'Source data needs multiple years for its trend graphs')
  assert.equal(national.map.length, 52)
  assert.equal(await page.locator('.ww-kpi').count(), 4)
  assert.equal(await page.locator('.ww-kpi svg.ww-sparkline').count(), 4)
  assert.ok(await page.locator('.ww-trend-panel').count() >= 4)
  assert.ok(await page.locator('.ww-chart .recharts-wrapper>svg.recharts-surface').count() >= 4)
  assert.equal(await page.locator('.wastewater-groups').count(), 0, 'The old text list grid must be replaced by graphs')
  assert.equal(await page.locator('.rf-error').count(), 0)
  assert.equal(await mapPaths().count(), 52)
  assert.equal(await mapPaths().evaluateAll(nodes => nodes.filter(node => node.getAttribute('fill') !== '#254251').length), 52)
  assert.equal(await page.getByLabel('Wastewater region', { exact: true }).locator('option').count(), 53)
  const mapBounds = await page.locator('.ww-primary-grid .rf-map-panel').boundingBox()
  const graphBounds = await page.locator('.ww-primary-grid .ww-trend-panel').first().boundingBox()
  assert.ok(mapBounds.x + mapBounds.width <= graphBounds.x + 2, 'The district map must remain at the top left')
  assert.ok(Math.abs(mapBounds.y - graphBounds.y) <= 2, 'The map and primary trend must share the first row')
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false)
  const kpiKeys = ['cod_mg_l', 'ecoli_cfu_100ml', 'hydraulic_loading_pct', 'influent_flow_m3_day']
  for (const [index, key] of kpiKeys.entries()) assert.equal(await page.locator('.ww-kpi .ww-kpi-value strong').nth(index).innerText(), format(national.indicators[key].latest, key === 'influent_flow_m3_day' ? 0 : 2), `${key} KPI must match the actual annual source value`)
  await assertUniqueNumericTicks()
  await page.screenshot({ path: outputDir + 'national-desktop.png', fullPage: true })
  console.log('PASS real Supabase API reads, four KPI sparklines, graph panels, 52 filled districts and top-left map')

  const changed = []
  changed.push(await changeIndicator('Effluent indicator'))
  changed.push(await changeIndicator('Physical indicator'))
  changed.push(await changeIndicator('Biological indicator'))
  changed.push(await changeIndicator('Operational indicator'))
  changed.push(await changeIndicator('Weather indicator'))
  const category = page.getByLabel('Effluent category', { exact: true })
  const categoryOptions = await category.locator('option').evaluateAll(nodes => nodes.map(node => node.value))
  if (categoryOptions.length > 1) {
    const currentCategory = await category.inputValue()
    await category.selectOption(categoryOptions.find(value => value !== currentCategory))
    assert.ok(await page.getByLabel('Effluent indicator', { exact: true }).locator('option').count())
  }
  const comparison = page.getByLabel('District comparison indicator', { exact: true })
  const comparisonOptions = await comparison.locator('option').evaluateAll(nodes => nodes.map(node => node.value))
  assert.ok(comparisonOptions.length > 1)
  await comparison.selectOption(comparisonOptions.at(-1))
  const styleButtons = page.getByRole('group', { name: 'Effluent chart style', exact: true })
  await styleButtons.getByRole('button', { name: 'Bars', exact: true }).click()
  await page.locator('.ww-lead-panel .recharts-bar').first().waitFor()
  await styleButtons.getByRole('button', { name: 'Trend', exact: true }).click()
  await page.locator('.ww-lead-panel .recharts-area').first().waitFor()
  const nutrientControls = page.getByRole('group', { name: 'Nutrient chart series', exact: true })
  const nutrientPanel = nutrientControls.locator('..')
  const nutrientLines = await nutrientPanel.locator('.recharts-line').count()
  await nutrientControls.getByRole('button').first().click()
  assert.equal(await nutrientPanel.locator('.recharts-line').count(), nutrientLines - 1)
  await nutrientControls.getByRole('button').first().click()
  assert.equal(await nutrientPanel.locator('.recharts-line').count(), nutrientLines)
  await assertUniqueNumericTicks()
  console.log('PASS effluent category, biological, operational, weather and district comparison controls: ' + changed.join('; '))

  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export data', exact: true }).click()
  const download = await downloadPromise
  const csv = await readFile(await download.path(), 'utf8')
  const lines = csv.replace(/^\uFEFF/, '').trim().split(/\r?\n/)
  assert.equal(lines.length, national.series.length + 1)
  assert.ok(lines[0].includes('Year'))
  for (const metric of metadata.indicators) assert.ok(lines[0].includes(metric.label.replaceAll('"', '""')), `Export must contain ${metric.label}`)
  assert.ok(lines[1].startsWith('"National","' + national.series[0].year + '"'))
  await writeFile(outputDir + 'national-export.csv', csv)
  console.log('PASS CSV export with all available source indicators and annual observations')

  const nationalPaths = await mapPaths().evaluateAll(nodes => nodes.map(node => node.getAttribute('d')))
  const regionName = await page.getByLabel('Wastewater region', { exact: true }).locator('option').nth(1).textContent()
  await page.getByLabel('Wastewater region', { exact: true }).selectOption({ label: regionName })
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click()
  await waitForDashboard(regionName)
  assert.equal(payloads.get(`dashboard:${regionName}`).region, regionName)
  assert.equal(payloads.get('dashboard:National').map.length, 52)
  assert.deepEqual(await mapPaths().evaluateAll(nodes => nodes.map(node => node.getAttribute('d'))), nationalPaths)
  assert.equal(await mapPaths().evaluateAll(nodes => nodes.filter(node => node.getAttribute('fill') !== '#254251').length), 52)
  console.log('PASS district filtering preserves all 52 national map geometries and indicator values')

  await page.setViewportSize({ width: 390, height: 844 })
  await page.evaluate(() => scrollTo(0, 0))
  await page.waitForFunction(() => document.querySelectorAll('.ww-chart .recharts-wrapper>svg.recharts-surface').length >= 4)
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, 'Mobile dashboard must not overflow horizontally')
  const mobileMap = await page.locator('.ww-primary-grid .rf-map-panel').boundingBox()
  const mobileGraph = await page.locator('.ww-primary-grid .ww-trend-panel').first().boundingBox()
  assert.ok(mobileMap.y + mobileMap.height <= mobileGraph.y + 2, 'The map must appear before primary trend on mobile')
  await assertUniqueNumericTicks()
  await page.screenshot({ path: outputDir + 'district-mobile.png', fullPage: true })
  console.log('PASS mobile graphs, map order and no horizontal overflow at 390px')

  failDashboard = true
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: 'Wastewater source unavailable for browser verification' }).waitFor()
  assert.equal(await page.locator('.ww-kpi').count(), 0)
  failDashboard = false
  await page.getByRole('button', { name: 'Retry', exact: true }).click()
  await waitForDashboard(regionName)
  assert.deepEqual(errors, [])
  assert.ok(apiReads.every(item => item.status === 200))
  await writeFile(outputDir + 'verification.json', JSON.stringify({
    checkedAt: new Date().toISOString(), frontendURL, backendURL, apiReads,
    sourceTables: metadata.source_tables, years: national.series.length, districts: national.map.length,
    charts: await page.locator('.ww-chart .recharts-wrapper>svg.recharts-surface').count(), runtimeErrors: errors,
    checks: ['actual API values', 'graph selectors', 'four sparklines', 'unique numeric tick labels', 'chart style switches', 'nutrient legend toggle', 'national map frame', 'export', 'mobile width', 'plain-text 503 recovery'],
  }, null, 2))
  console.log('PASS plain-text 503 handling, retry recovery and no runtime or duplicate-key errors')
} finally {
  await browser.close()
}
