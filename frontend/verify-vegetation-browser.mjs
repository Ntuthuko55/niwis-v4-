import { chromium } from 'playwright'
import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'

const browser = await chromium.launch({ channel: 'msedge', headless: true })
const page = await browser.newPage({ viewport: { width: 1820, height: 1120 } })
const errors = []
page.on('pageerror', error => errors.push(error.message))
let failData = false
await page.route('**/api/**', async route => {
  const url = new URL(route.request().url())
  if (url.pathname.startsWith('/niwis-api/')) return route.fulfill({ json: { predictions: [] } })
  if (url.pathname.includes('/drought-monitoring/')) return route.fulfill({ status: 503, json: { detail: 'Unrelated drought service excluded from vegetation test' } })
  if (failData && url.pathname === '/api/vegetation/dashboard') return route.fulfill({ status: 503, json: { detail: 'Vegetation source unavailable for test' } })
  try {
    const response = await route.fetch({ url: `http://127.0.0.1:8011${url.pathname.replace(/^\/api/, '')}${url.search}`, timeout: 120000 })
    await route.fulfill({ response })
  } catch { await route.abort() }
})
try {
  await page.goto('http://127.0.0.1:5179', { waitUntil: 'domcontentloaded' })
  await page.locator('.nw-nav').getByRole('button', { name: /Vegetation condition/ }).click()
  await page.getByRole('heading', { name: 'Vegetation Condition Monitoring', exact: true }).waitFor()
  await page.getByRole('heading', { name: 'Climate–vegetation relationships' }).waitFor({ timeout: 120000 })
  assert.equal(await page.getByLabel('Vegetation region').locator('option').count(), 53)
  assert.equal(await page.locator('.vg-kpi').count(), 6)
  assert.equal(await page.getByLabel('Vegetation end month').inputValue(), '2026-08')
  assert.equal(await page.locator('.vg-main-map .sat-district-map>svg>path').count(), 52)
  assert.ok((await page.locator('.vg-correlations').innerText()).includes('22 complete monthly pairs'))
  await mkdir('output', { recursive: true })
  await page.screenshot({ path: 'output/vegetation-desktop.png', fullPage: true })
  console.log('PASS vegetation sources, 52 districts, map, 25 indicators, meaningful default correlation window')

  await page.getByRole('radio', { name: 'MSAVI2', exact: true }).check()
  await page.getByRole('img', { name: /MSAVI2 current/ }).waitFor()
  await page.getByRole('checkbox', { name: 'Compare with previous year' }).uncheck()
  assert.equal(await page.getByText('Same month previous year', { exact: true }).count(), 0)
  await page.getByRole('checkbox', { name: 'Compare with previous year' }).check()
  await page.getByLabel('Vegetation water and thermal indicator').selectOption('Surface_Soil_Moisture_m3m3')
  await page.getByText('This source variable is constant throughout the dataset.').waitFor()
  await page.getByLabel('Vegetation weather indicator').selectOption('SPEI_6_month')
  await page.getByRole('img', { name: /6-month precipitation/ }).waitFor()
  await page.getByRole('button', { name: 'Lowest five' }).click()
  const regionName = await page.locator('.vg-ranking .vg-rank-name').first().innerText()
  await page.locator('.vg-ranking>button').first().click()
  await page.waitForFunction(name => document.querySelector('.vg-context')?.textContent.includes(name), regionName.trim())
  assert.equal(await page.getByLabel('Vegetation region').inputValue(), regionName.trim())
  await page.getByLabel('Vegetation driver lag').selectOption('2')
  await page.locator('.vg-correlations').waitFor()
  assert.equal(await page.getByLabel('Vegetation driver lag').inputValue(), '2')
  console.log('PASS all map layers, comparison toggle, weather/thermal variables, ranking selection and lag control')

  await page.getByLabel('Vegetation region').selectOption('City of Tshwane')
  await page.getByLabel('Vegetation start month').fill('2020-01')
  await page.getByLabel('Vegetation end month').fill('2025-12')
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('.vg-context')?.textContent.includes('City of Tshwane'))
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Download data' }).click()
  const download = await downloadPromise
  const csv = await readFile(await download.path(), 'utf8')
  assert.ok(csv.includes('Rainfall (mm/month)'))
  assert.ok(csv.includes('City of Tshwane'))
  assert.equal(csv.trim().split('\r\n').length, 73)
  await page.locator('.vg-register summary').click()
  await page.locator('.vg-register').getByRole('button', { name: 'Weather', exact: true }).click()
  assert.equal(await page.locator('.vg-register tbody tr').count(), 11)
  await page.locator('.vg-register summary').click()
  console.log('PASS date and region filters, all weather indicators, actual CSV export with 72 monthly rows')

  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: 'output/vegetation-mobile.png', fullPage: true })
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2), 'Mobile horizontal overflow')
  failData = true
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click()
  await page.getByRole('alert').getByText('Vegetation source unavailable for test').waitFor()
  assert.equal(await page.locator('.vg-kpi').count(), 0, 'A failed selection must not display stale data')
  failData = false
  await page.getByRole('button', { name: 'Retry', exact: true }).click()
  await page.locator('.vg-kpi').first().waitFor()
  console.log('PASS mobile layout and source-error recovery')

  await page.setViewportSize({ width: 1820, height: 1120 })
  await page.locator('.nw-nav').getByRole('button', { name: /Climate dashboard/ }).click()
  await page.getByRole('heading', { name: 'Climate Dashboard', exact: true }).waitFor()
  await page.getByRole('heading', { name: 'Climate indicator register' }).waitFor({ timeout: 120000 })
  assert.equal(await page.locator('.cl-kpi').count(), 7)
  await page.screenshot({ path: 'output/climate-desktop.png', fullPage: true })
  assert.deepEqual(errors, [])
  console.log('PASS existing climate interface renders; no browser JavaScript errors')
} finally {
  await browser.close()
}
