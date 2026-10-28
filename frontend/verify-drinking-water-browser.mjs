import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const frontendURL = process.env.NIWIS_VERIFY_URL || 'http://127.0.0.1:5173'
const backendURL = process.env.NIWIS_VERIFY_API || 'http://127.0.0.1:8001'
const outputDir = fileURLToPath(new URL('../output/drinking-water-dashboard/', import.meta.url))
await mkdir(outputDir, { recursive: true })

const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--disable-gpu', '--disable-software-rasterizer', '--disable-features=RendererCodeIntegrity'] })
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
await page.route('**/api/drinking-water/**', async route => {
  const url = new URL(route.request().url())
  if (failDashboard && url.pathname.endsWith('/dashboard')) return route.fulfill({ status: 503, contentType: 'text/plain', body: 'Drinking water source unavailable for browser verification' })
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

const dashboard = () => page.locator('.drinking-water-dashboard')
const charts = () => dashboard().locator('.dw-chart-panel .recharts-wrapper>svg.recharts-surface')
const mapPaths = () => dashboard().locator('.dw-primary-grid .dw-map-panel .sat-district-map>svg>path[role="button"]')
const format = (value, digits = 2) => Number(value).toLocaleString('en-ZA', { maximumFractionDigits: digits })

async function waitForDashboard(region) {
  await dashboard().locator('.dw-kpi').first().waitFor({ timeout: 120_000 })
  await page.waitForFunction(expectedRegion => {
    const select = document.querySelector('select[aria-label="Drinking water region"]')
    const context = document.querySelector('.dw-context strong')
    return select?.value === expectedRegion && context?.textContent.includes(expectedRegion === 'National' ? 'South Africa' : expectedRegion) && !document.querySelector('.drinking-water-dashboard .rf-loading')
  }, region, { timeout: 120_000 })
  await charts().first().waitFor()
}

function assertComplianceCounts(payload) {
  const coverage = payload.coverage
  assert.equal(coverage.passed + coverage.failed, coverage.assessed, 'Only assessed source flags belong in the pass-rate denominator')
  assert.equal(coverage.systems, null, 'A district aggregate table cannot report a system inventory count')
  assert.ok(coverage.selected_rows > 0)
  assert.ok(coverage.assessed <= coverage.selected_rows * 14)
  const parameters = Array.isArray(payload.parameter_compliance) ? payload.parameter_compliance : Object.values(payload.parameter_compliance)
  assert.equal(parameters.length, 14)
  for (const item of parameters) {
    assert.equal(item.passed + item.failed, item.assessed)
    if (item.assessed) assert.ok(Math.abs(item.pass_pct - item.passed / item.assessed * 100) < 0.01, 'Parameter pass rates must use assessed source flags')
  }
  assert.equal(parameters.reduce((total, item) => total + item.assessed, 0), coverage.assessed)
}

async function assertUniqueNumericTicks() {
  for (const chart of await charts().all()) {
    const axisLabels = await chart.locator('.recharts-yAxis .recharts-cartesian-axis-tick-value').allTextContents()
    const numericY = axisLabels.length > 1 && axisLabels.every(label => /[0-9]/.test(label) && !/[a-z]/i.test(label.replace(/[kmbt]/gi, '')))
    const numericAxis = chart.locator(numericY ? '.recharts-yAxis' : '.recharts-xAxis')
    const labels = (await numericAxis.locator('.recharts-cartesian-axis-tick-value').allTextContents()).map(label => label.trim())
    if (!labels.length) continue // Radial or pie diagrams do not have numeric Cartesian axes.
    assert.ok(labels.length >= 2, 'Each numeric chart axis needs at least two readable ticks')
    assert.equal(new Set(labels).size, labels.length, `Numeric chart ticks must be distinct: ${labels.join(', ')}`)
  }
}

try {
  await page.goto(frontendURL + '/drinking-water-compliance', { waitUntil: 'domcontentloaded' })
  await page.getByRole('heading', { name: 'Drinking Water Quality Compliance', exact: true }).waitFor()
  await waitForDashboard('National')
  const metadata = payloads.get('metadata')
  const national = payloads.get('dashboard:National')
  const indicators = metadata.indicators || metadata.parameters
  assert.equal(metadata.source, 'Supabase')
  assert.equal(metadata.source_table, '14.1_SANS_241_compliance_master')
  assert.equal(indicators.length, 14)
  for (const indicator of indicators.filter(item => item.category === 'Microbiological')) {
    assert.equal(indicator.min, 0)
    assert.equal(indicator.max, 0)
  }
  assert.ok(national.series.length >= 2)
  assert.ok(national.monthly.length >= 12)
  assert.equal(national.map.length, 52)
  assertComplianceCounts(national)
  assert.equal(await dashboard().locator('.dw-kpi').count(), 4)
  const expectedKPIs = [national.latest.compliance_score, national.latest.microbial_pass_pct, national.latest.free_chlorine_mg_l, national.coverage.latest_flagged_districts]
  for (const [index, value] of expectedKPIs.entries()) assert.equal(await dashboard().locator('.dw-kpi-value strong').nth(index).innerText(), format(value, index === 3 ? 0 : 2), 'KPI must match the latest monthly source payload')
  assert.ok(await dashboard().locator('.dw-chart-panel').count() >= 6)
  assert.ok(await charts().count() >= 6)
  assert.equal(await dashboard().locator('.dw-matrix-row').count(), 14)
  assert.equal(await dashboard().locator('.dw-matrix-cell').count(), Math.min(12, national.monthly.length) * 14)
  if (national.alerts.length) {
    const firstAlert = dashboard().locator('.dw-alert-table tbody tr').first()
    assert.ok((await firstAlert.innerText()).includes(national.alerts[0].label))
    assert.ok((await firstAlert.innerText()).includes(national.alerts[0].district_name))
    assert.ok((await firstAlert.innerText()).includes(national.alerts[0].limit))
  }
  assert.equal(await dashboard().locator('.rf-error').count(), 0)
  assert.equal(await mapPaths().count(), 52)
  assert.equal(await mapPaths().evaluateAll(nodes => nodes.filter(node => node.getAttribute('fill') !== '#254251').length), 52)
  assert.equal(await page.getByLabel('Drinking water region', { exact: true }).locator('option').count(), 53)
  const mapBounds = await dashboard().locator('.dw-primary-grid .dw-map-panel').boundingBox()
  const graphBounds = await dashboard().locator('.dw-primary-grid .dw-chart-panel').first().boundingBox()
  assert.ok(mapBounds.x + mapBounds.width <= graphBounds.x + 2, 'National district map must stay at the top left')
  assert.ok(Math.abs(mapBounds.y - graphBounds.y) <= 2)
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false)
  assert.equal(/1[ ,]?025\s*(?:registered\s+)?(?:systems|water supply systems)/i.test(await dashboard().innerText()), false, 'The dashboard cannot invent a count of water supply systems')
  await dashboard().locator('.dw-methods summary').click()
  assert.ok((await dashboard().locator('.dw-coverage-grid').innerText()).includes('No system inventory supplied'))
  assert.ok((await dashboard().locator('.dw-coverage-grid').innerText()).includes('Not in this relation'))
  assert.ok((await dashboard().locator('.dw-methods').innerText()).includes('Blue Drop process indicators'))
  await dashboard().locator('.dw-methods summary').click()
  await assertUniqueNumericTicks()
  await page.evaluate(() => new Promise(resolve => { scrollTo(0, 0); requestAnimationFrame(() => requestAnimationFrame(resolve)) }))
  await page.screenshot({ path: outputDir + 'national-desktop.png', fullPage: true })
  console.log('PASS live Supabase data, 14 parameters, assessed flag denominators, 4 KPIs, 6+ graphs and 52-district national map')

  const parameter = page.getByLabel('Drinking water parameter', { exact: true })
  const options = await parameter.locator('option').evaluateAll(nodes => nodes.map(node => ({ value: node.value, text: node.textContent })))
  assert.equal(options.length, 14)
  const current = await parameter.inputValue()
  const next = options.find(item => item.value !== current)
  await parameter.selectOption(next.value)
  assert.equal(await parameter.inputValue(), next.value)
  const parameterPanel = parameter.locator('xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " dw-chart-panel ")][1]')
  const annualPoint = national.series.filter(row => typeof row[next.value] === 'number').at(-1)
  await page.waitForFunction(({ key, expected }) => document.querySelector('select[aria-label="Drinking water parameter"]')?.closest('.dw-chart-panel')?.querySelector('.dw-readout strong')?.textContent.includes(expected), { key: next.value, expected: format(annualPoint[next.value]) })
  const viewButtons = page.getByRole('group', { name: 'Parameter chart view', exact: true })
  await viewButtons.getByRole('button', { name: 'Checks passing', exact: true }).click()
  await parameterPanel.locator('.recharts-bar').first().waitFor()
  const ratePoint = national.series.filter(row => typeof row[`${next.value}_pass_pct`] === 'number').at(-1)
  assert.ok((await parameterPanel.locator('.dw-readout>div>strong').innerText()).includes(format(ratePoint[`${next.value}_pass_pct`])))
  await viewButtons.getByRole('button', { name: 'Measured value', exact: true }).click()
  await parameter.selectOption('ecoli_cfu_100ml')
  await parameterPanel.locator('.recharts-reference-line-line').waitFor({ state: 'attached' })
  assert.equal(await parameterPanel.locator('.recharts-reference-line-line').count(), 1, 'A zero source target must render as a reference line')
  assert.equal(await parameterPanel.locator('.recharts-reference-line-line').getAttribute('y'), '0')
  assert.ok(await parameterPanel.locator('.recharts-reference-line-line').evaluate(node => Number.isFinite(Number(node.getAttribute('y1'))) && Number(node.getAttribute('x2')) > Number(node.getAttribute('x1'))))
  assert.ok((await parameterPanel.innerText()).includes('Source target'))
  await parameter.selectOption('ph')
  await parameterPanel.locator('.recharts-reference-area').waitFor({ state: 'attached' })
  assert.equal(await parameterPanel.locator('.recharts-reference-line-line').count(), 2, 'The source pH minimum and maximum both need references')
  assert.equal(await parameterPanel.locator('.recharts-reference-area').count(), 1)
  assert.equal(await dashboard().locator('[aria-label="Disinfection control"] .recharts-reference-area').count(), 1, 'The chlorine source operating range must render')
  await parameter.selectOption('total_thms_mg_l')
  const traceExpected = national.series.filter(row => typeof row.total_thms_mg_l === 'number').at(-1).total_thms_mg_l
  const traceText = await parameterPanel.locator('.dw-readout>div>strong').evaluate(node => [...node.childNodes].filter(child => child.nodeType === Node.TEXT_NODE).map(child => child.textContent).join(''))
  const traceShown = Number(traceText.replace(/[\s\u00a0\u202f]/g, '').replace(',', '.'))
  assert.ok(traceShown > 0, 'A nonzero trace chemical measurement must not be rounded to zero')
  assert.ok(Math.abs(traceShown - traceExpected) / Math.abs(traceExpected) < 0.01, 'Trace chemical readout must preserve at least three significant digits')
  for (const name of ['Physical drinking water parameter', 'Chemical drinking water parameter']) {
    const control = page.getByLabel(name, { exact: true })
    const values = await control.locator('option').evaluateAll(nodes => nodes.map(node => node.value))
    assert.ok(values.length > 1)
    await control.selectOption(values.at(-1))
  }
  const cadence = page.getByRole('group', { name: 'Drinking water trend cadence', exact: true })
  await cadence.getByRole('button', { name: 'Monthly', exact: true }).click()
  assert.ok((await dashboard().locator('.dw-lead-summary').innerText()).includes('Monthly mean reported score'))
  await cadence.getByRole('button', { name: 'Annual', exact: true }).click()
  await charts().first().waitFor()
  const mapIndicator = page.getByLabel('Drinking water map indicator', { exact: true })
  const mapOptions = await mapIndicator.locator('option').evaluateAll(nodes => nodes.map(node => node.value))
  assert.ok(mapOptions.length > 1)
  await mapIndicator.selectOption(mapOptions.at(-1))
  assert.equal(await mapPaths().count(), 52)
  await assertUniqueNumericTicks()
  console.log('PASS parameter explorer, map indicator controls and distinct numeric tick labels')

  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export data', exact: true }).click()
  const download = await downloadPromise
  const csv = await readFile(await download.path(), 'utf8')
  const lines = csv.replace(/^\uFEFF/, '').trim().split(/\r?\n/)
  assert.equal(lines.length, national.monthly.length + 1)
  for (const item of indicators) assert.ok(lines[0].includes(item.label.replaceAll('"', '""')), `Export must contain ${item.label}`)
  assert.ok(lines[1].startsWith(`"National","${national.monthly[0].period}"`))
  assert.ok(lines[0].includes('checks passing (%)'))
  await writeFile(outputDir + 'national-export.csv', csv)
  console.log('PASS export contains the actual available drinking water measurements')

  const nationalPaths = await mapPaths().evaluateAll(nodes => nodes.map(node => node.getAttribute('d')))
  const regionName = await page.getByLabel('Drinking water region', { exact: true }).locator('option').nth(1).textContent()
  await page.getByLabel('Drinking water region', { exact: true }).selectOption({ label: regionName })
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click()
  await waitForDashboard(regionName)
  assertComplianceCounts(payloads.get(`dashboard:${regionName}`))
  assert.equal(payloads.get(`dashboard:${regionName}`).region, regionName)
  assert.deepEqual(await mapPaths().evaluateAll(nodes => nodes.map(node => node.getAttribute('d'))), nationalPaths)
  assert.equal(await mapPaths().evaluateAll(nodes => nodes.filter(node => node.getAttribute('fill') !== '#254251').length), 52)
  console.log('PASS district filtering and preserved national map frame')

  await page.setViewportSize({ width: 390, height: 844 })
  await page.evaluate(() => scrollTo(0, 0))
  await charts().first().waitFor()
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, 'Mobile dashboard must not overflow horizontally')
  const mobileMap = await dashboard().locator('.dw-primary-grid .dw-map-panel').boundingBox()
  const mobileGraph = await dashboard().locator('.dw-primary-grid .dw-chart-panel').first().boundingBox()
  assert.ok(mobileMap.y + mobileMap.height <= mobileGraph.y + 2, 'The map must appear before the primary trend on mobile')
  await assertUniqueNumericTicks()
  await page.evaluate(() => new Promise(resolve => { scrollTo(0, 0); requestAnimationFrame(() => requestAnimationFrame(resolve)) }))
  await page.screenshot({ path: outputDir + 'district-mobile.png', fullPage: true })
  console.log('PASS mobile map order, graphs and no horizontal overflow at 390px')

  failDashboard = true
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: 'Drinking water source unavailable for browser verification' }).waitFor()
  assert.equal(await dashboard().locator('.dw-kpi').count(), 0)
  failDashboard = false
  await page.getByRole('button', { name: 'Retry', exact: true }).click()
  await waitForDashboard(regionName)
  assert.deepEqual(errors, [])
  assert.ok(apiReads.every(item => item.status === 200))
  await writeFile(outputDir + 'verification.json', JSON.stringify({
    checkedAt: new Date().toISOString(), frontendURL, backendURL, apiReads,
    sourceTable: metadata.source_table, years: national.series.length, months: national.monthly.length, districts: national.map.length,
    graphs: await charts().count(), assessed: national.coverage.assessed, passed: national.coverage.passed, failed: national.coverage.failed,
    runtimeErrors: errors, checks: ['latest-month KPI source values', 'assessed source flag denominators', '14 parameter controls', 'annual and monthly cadence', 'source zero target and range bands', 'nonzero trace chemical precision', 'national map frame', 'unique numeric ticks', 'monthly parameter matrix', 'CSV export', '390px mobile', 'plain-text 503 recovery'],
  }, null, 2))
  console.log('PASS plain-text 503 handling, retry recovery and no runtime or duplicate-key errors')
} finally {
  await browser.close()
}
