import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const base = process.env.NIWIS_VERIFY_URL || 'http://localhost:5173'
const output = fileURLToPath(new URL('../output/water-services-dashboard/', import.meta.url))
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--disable-gpu', '--disable-software-rasterizer', '--disable-features=RendererCodeIntegrity'] })
const page = await browser.newPage({ viewport: { width: 1680, height: 1050 }, reducedMotion: 'reduce', acceptDownloads: true })
page.setDefaultTimeout(45_000)
const errors = [], responses = []
page.on('pageerror', error => errors.push(error.message))
page.on('response', response => { if (response.url().includes('/api/water-services/')) responses.push({ path: new URL(response.url()).pathname, status: response.status(), cache: response.headers()['x-niwis-cache'] }) })
await page.route('https://fonts.googleapis.com/**', route => route.abort())
await page.route('https://fonts.gstatic.com/**', route => route.abort())

try {
  await page.goto(`${base}/water-services`, { waitUntil: 'domcontentloaded' })
  const dashboard = page.locator('.water-services-dashboard')
  await dashboard.getByRole('heading', { name: 'Water Services, Infrastructure Access and Supply Reliability', exact: true }).waitFor()
  await dashboard.locator('.rq-kpi').first().waitFor()
  const tabs = dashboard.getByRole('group', { name: 'Water services sections' })
  assert.equal(await tabs.getByRole('button').count(), 4)
  assert.ok(await dashboard.getByText('Covered-region mean (unweighted)', { exact: true }).count())
  assert.ok(responses.some(item => item.path.endsWith('/metadata') && item.status === 200))
  assert.ok(responses.some(item => item.path.endsWith('/dashboard') && item.status === 200))
  await page.screenshot({ path: `${output}access-desktop.png`, fullPage: true })

  await tabs.getByRole('button', { name: 'Supply Reliability' }).click()
  await dashboard.locator('.ws-reliability-card').first().waitFor()
  assert.equal(await dashboard.locator('.ws-reliability-card').count(), 5)
  assert.equal(await dashboard.locator('.ws-reliability-card .ws-unavailable').allTextContents().then(values => values.every(value => value === 'Unavailable')), true)

  await tabs.getByRole('button', { name: 'Infrastructure Operations' }).click()
  await dashboard.locator('.ws-register').waitFor()
  await dashboard.getByRole('heading', { name: 'Pipe age profile' }).waitFor()
  assert.ok(await dashboard.getByText(/pressure units remain unresolved/i).count())
  await page.screenshot({ path: `${output}operations-desktop.png`, fullPage: true })

  await tabs.getByRole('button', { name: 'SANSA Support' }).click()
  const paths = dashboard.locator('.rq-map-panel .sat-district-map > svg > path[role="button"]')
  await paths.first().waitFor()
  assert.equal(await paths.count(), 52)
  const before = await dashboard.locator('.rq-context').innerText()
  await paths.first().click()
  await dashboard.locator('.rq-loading').waitFor({ state: 'hidden' })
  await page.waitForFunction(previous => document.querySelector('.water-services-dashboard .rq-context')?.innerText !== previous, before)
  const after = await dashboard.locator('.rq-context').innerText()
  assert.notEqual(after, before)
  const selectedRegion = after.split(' · ')[0]
  const districtBoundaries = await paths.count()
  const downloadPromise = page.waitForEvent('download')
  await dashboard.getByRole('button', { name: /Export data/ }).click()
  const download = await downloadPromise
  assert.ok(download.suggestedFilename().startsWith(`NIWIS-water-services-eo-${selectedRegion.trim().replaceAll(/\s+/g, '-')}-`))
  await page.screenshot({ path: `${output}sansa-district-desktop.png`, fullPage: true })

  await tabs.getByRole('button', { name: 'Access & Coverage' }).click()
  const category = dashboard.getByLabel('Water services category', { exact: true })
  await category.selectOption('Rural')
  await dashboard.getByRole('button', { name: 'Apply filters' }).click()
  await dashboard.locator('.ws-register').waitFor()
  assert.equal(await category.inputValue(), 'Rural')
  await page.screenshot({ path: `${output}rural-access-desktop.png`, fullPage: true })

  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: `${output}rural-access-mobile.png`, fullPage: true })
  const mobileWidth = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, content: document.documentElement.scrollWidth }))
  assert.ok(mobileWidth.content <= mobileWidth.viewport + 2, `Unexpected horizontal page overflow: ${JSON.stringify(mobileWidth)}`)
  assert.deepEqual(errors, [])
  const report = {
    route: '/water-services', desktop_title: 'Water Services, Infrastructure Access and Supply Reliability',
    sections: ['Access & Coverage', 'Infrastructure Operations', 'SANSA Support', 'Supply Reliability'],
    reliability_indices: 5, district_boundaries: districtBoundaries, selected_region: selectedRegion, export: download.suggestedFilename(),
    mobile_width: mobileWidth, api_responses: responses, page_errors: errors,
  }
  await writeFile(`${output}browser-verification.json`, JSON.stringify(report, null, 2), 'utf8')
  console.log(JSON.stringify(report, null, 2))
} finally {
  await browser.close()
}
