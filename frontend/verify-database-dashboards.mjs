import { chromium } from 'playwright'
import assert from 'node:assert/strict'

const browser = await chromium.launch({ channel: 'msedge', headless: true })
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
const csvRequests = []
const errors = []
const sources = new Set()
let unavailable = false
page.on('request', (request) => { if (/\.csv(?:\?|$)/i.test(request.url())) csvRequests.push(request.url()) })
page.on('pageerror', (error) => errors.push(error.message))
await page.route('**/api/**', async (route) => {
  const url = new URL(route.request().url())
  if (url.pathname.startsWith('/niwis-api/')) return route.fulfill({ json: { predictions: [] } })
  if (unavailable) return route.fulfill({ status: 502, json: { detail: 'Database unavailable for test' } })
  const path = url.pathname.replace(/^\/api/, '')
  try {
    const response = await route.fetch({ url: `http://127.0.0.1:8011${path}${url.search}`, timeout: 120000 })
    const data = await response.json()
    if (data.source) sources.add(data.source)
    await route.fulfill({ response, json: data })
  } catch { await route.abort() }
})
try {
  await page.goto('http://127.0.0.1:5179', { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: /Hydrological Drought/ }).click()
  const select = page.getByLabel('Select South African District')
  await select.waitFor({ timeout: 120000 })
  assert.equal(await select.locator('option').count(), 52)
  await select.selectOption('Alfred Nzo')
  await page.waitForFunction(() => window.__hydrologyDebug?.selectedDistrict === 'Alfred Nzo')
  assert.ok((await page.locator('.hydro-container').innerText()).includes('2025-12-01'))
  assert.ok((await page.locator('.hydro-container').innerText()).includes('Supabase hydrological_drought_master'))
  console.log('PASS hydrology: database data, 52 district options and selection')

  await page.getByRole('button', { name: /Satellite & Remote Sensing Drought/ }).click()
  const satellite = page.getByLabel('Satellite region')
  await satellite.waitFor({ timeout: 60000 })
  await page.getByText(/300 database observations/).waitFor({ timeout: 60000 })
  assert.equal(await satellite.locator('option').count(), 53)
  await satellite.selectOption('amajuba')
  await page.getByText('300 database observations for amajuba.').waitFor({ timeout: 60000 })
  assert.ok((await page.locator('.nw-main').innerText()).includes('2025-12-01'))
  console.log('PASS satellite: database snapshot, district history and region changes')

  unavailable = true
  await page.getByRole('button', { name: /Hydrological Drought/ }).click()
  await page.getByText('Database unavailable for test', { exact: true }).waitFor()
  assert.equal(await page.locator('.hydro-kpi-bar').count(), 0)
  await page.getByRole('button', { name: /Satellite & Remote Sensing Drought/ }).click()
  await page.getByRole('alert').filter({ hasText: 'Database unavailable for test' }).waitFor()
  assert.equal(await page.locator('.sat-kpi-strip').count(), 0)
  assert.deepEqual(csvRequests, [])
  assert.deepEqual(errors, [])
  assert.ok(sources.has('hydrological_drought_master'))
  assert.ok(sources.has('satellite_remote_sensing'))
  console.log('PASS both dashboards: visible database errors, no fabricated readings, no CSV requests, no JavaScript errors')
} catch (error) {
  console.log((await page.locator('body').innerText()).slice(-4000))
  console.log({ csvRequests, errors })
  throw error
} finally { await browser.close() }
