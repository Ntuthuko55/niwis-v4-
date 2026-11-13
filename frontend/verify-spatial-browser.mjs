import assert from 'node:assert/strict'
import { existsSync, readdirSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const base = process.env.NIWIS_VERIFY_URL || 'http://127.0.0.1:5173'
const output = fileURLToPath(new URL('../output/spatial-dashboard/', import.meta.url))
await mkdir(output, { recursive: true })
const browserRoot = join(process.env.LOCALAPPDATA || '', 'ms-playwright')
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || (existsSync(browserRoot)
  ? readdirSync(browserRoot).filter(name => /^chromium-\d+$/.test(name)).sort().reverse()
    .map(name => join(browserRoot, name, 'chrome-win64', 'chrome.exe')).find(existsSync)
  : undefined)
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : { channel: 'msedge' }) })
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true, reducedMotion: 'reduce' })
page.setDefaultTimeout(30000)
const errors = [], localFailures = [], checks = {}
page.on('pageerror', error => errors.push(error.message))
page.on('response', response => {
  if (response.url().includes('/spatial-api/') && response.status() >= 400) localFailures.push({ path: new URL(response.url()).pathname, status: response.status() })
})
await page.route('https://fonts.googleapis.com/**', route => route.abort())
await page.route('https://fonts.gstatic.com/**', route => route.abort())

try {
  await page.goto(`${base}/spatial`, { waitUntil: 'domcontentloaded' })
  const workspace = page.locator('iframe[title="NIWIS Spatial Intelligence workspace"]')
  const ui = page.frameLocator('iframe[title="NIWIS Spatial Intelligence workspace"]')
  await ui.getByText('Local API connected', { exact: true }).waitFor()
  assert.equal(await page.locator('.nw-topbar').count(), 1)
  await ui.locator('.map-statusbar').filter({ hasText: '61 loaded vector features' }).waitFor()
  checks.nationalFeatures = 61

  const districtResponse = await page.request.get(`${base}/spatial-api/layers/districts/features?bbox=15,-36,34,-21&zoom=5&limit=1200`)
  assert.equal(districtResponse.status(), 200)
  const districts = await districtResponse.json()
  assert.equal(districts.features.length, 52)
  assert.equal(districts.metadata.returned, districts.features.length)
  assert.ok(districts.features.every(feature => feature.geometry?.coordinates?.length))
  checks.districts = districts.features.length

  const frame = page.frames().find(item => item.url().includes('spatial-workspace.html'))
  assert.ok(frame)
  const satelliteConfigured = (await (await page.request.get(`${base}/spatial-api/basemap/status`)).json()).configured
  if (satelliteConfigured) {
    await ui.getByLabel('Select basemap').selectOption('satellite')
    await frame.waitForFunction(() => [...document.querySelectorAll('img.leaflet-tile')].some(image => image.src.includes('/basemap/tiles/') && image.complete && image.naturalWidth > 0))
    checks.satelliteTilesRendered = true
  }
  await workspace.screenshot({ path: join(output, 'map-desktop.png') })

  const downloadPromise = page.waitForEvent('download')
  await ui.getByRole('button', { name: 'Export loaded features' }).click()
  const download = await downloadPromise
  const exported = JSON.parse(await readFile(await download.path(), 'utf8'))
  assert.equal(exported.features.length, 61)
  checks.exportedFeatures = exported.features.length

  await ui.getByLabel('Select province').selectOption('GT')
  await ui.locator('.map-statusbar').filter({ hasText: /Zoom [89]/ }).waitFor()
  const municipalResponse = page.waitForResponse(response => response.url().includes('/layers/municipalities/features') && response.status() === 200)
  await ui.locator('.layer-toggle').filter({ hasText: 'Municipal boundaries' }).click()
  const municipalities = await (await municipalResponse).json()
  assert.ok(municipalities.features.length > 0)
  assert.equal(municipalities.features.length, municipalities.metadata.returned)
  checks.municipalityFeatures = municipalities.features.length

  const rasterResponse = page.waitForResponse(response => response.url().includes('/land-cover/tiles/') && response.status() === 200)
  await ui.locator('.layer-toggle').filter({ hasText: 'Land cover - 2022' }).click()
  assert.match((await rasterResponse).headers()['content-type'], /image\/png/)
  await frame.waitForFunction(() => [...document.querySelectorAll('img.leaflet-tile')].some(image => image.src.includes('/land-cover/tiles/') && image.complete && image.naturalWidth === 256))
  checks.landcoverTilesRendered = true

  await ui.getByRole('button', { name: 'Expand map', exact: true }).click()
  await frame.waitForFunction(() => document.fullscreenElement?.classList.contains('map-shell'))
  const fullscreenBounds = await ui.locator('.leaflet-container').boundingBox()
  assert.ok(fullscreenBounds.width >= 1400 && fullscreenBounds.height >= 900)
  checks.fullscreen = fullscreenBounds
  await frame.evaluate(() => document.exitFullscreen())

  await ui.getByRole('button', { name: /Data catalogue/ }).click()
  await ui.locator('.dataset-card').first().waitFor()
  assert.equal(await ui.locator('.dataset-card').count(), 13)
  await ui.getByLabel('Search datasets').fill('road')
  assert.equal(await ui.locator('.dataset-card').count(), 1)
  await ui.getByRole('button', { name: /Data readiness/ }).click()
  assert.equal(await ui.locator('.indicator-card').count(), 6)
  checks.catalogueAndReadiness = true

  await ui.getByRole('button', { name: /Map explorer/ }).click()
  await ui.getByLabel('Select basemap').selectOption('local')
  await ui.getByLabel('Select province').selectOption('all')
  await page.setViewportSize({ width: 390, height: 844 })
  await page.locator('.nw-nav').waitFor({ state: 'hidden' })
  await page.getByRole('button', { name: 'Toggle menu', exact: true }).click()
  await page.locator('.nw-nav.open').waitFor({ state: 'visible' })
  await page.getByRole('button', { name: 'Toggle menu', exact: true }).click()
  await page.locator('.nw-nav').waitFor({ state: 'hidden' })
  await ui.getByLabel('Select province').waitFor()
  await ui.locator('.map-statusbar').filter({ hasText: /loaded vector features/ }).waitFor()
  assert.equal(await frame.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false)
  await ui.locator('.map-shell').scrollIntoViewIfNeeded()
  await workspace.screenshot({ path: join(output, 'map-mobile.png') })
  checks.mobileNoOverflow = true
  checks.mobilePortalMenu = true

  assert.deepEqual(errors, [])
  assert.deepEqual(localFailures, [])
  await writeFile(join(output, 'browser-verification.json'), JSON.stringify({ base, checks, errors, localFailures }, null, 2))
  console.log(JSON.stringify({ checks, errors, localFailures, output }, null, 2))
} catch (error) {
  await page.screenshot({ path: join(output, 'failure.png'), fullPage: true }).catch(() => {})
  const frames = []
  for (const frame of page.frames()) {
    frames.push({ url: frame.url(), status: await frame.locator('.map-statusbar').allTextContents().catch(() => []), tiles: await frame.locator('img.leaflet-tile').evaluateAll(images => images.slice(0, 8).map(image => ({ src: image.src, width: image.naturalWidth, complete: image.complete }))).catch(() => []) })
  }
  console.error(JSON.stringify({ checks, errors, localFailures, frames }, null, 2))
  throw error
} finally {
  await browser.close()
}
