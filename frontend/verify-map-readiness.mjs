import assert from 'node:assert/strict'
import { existsSync, readdirSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const base = process.env.NIWIS_VERIFY_URL || 'http://localhost:5173'
const output = fileURLToPath(new URL('../output/spatial-dashboard/map-readiness.json', import.meta.url))
const browserRoot = join(process.env.LOCALAPPDATA || '', 'ms-playwright')
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || (existsSync(browserRoot)
  ? readdirSync(browserRoot).filter(name => /^chromium-\d+$/.test(name)).sort().reverse()
    .map(name => join(browserRoot, name, 'chrome-win64', 'chrome.exe')).find(existsSync)
  : undefined)
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : { channel: 'msedge' }) })
const checks = {}
const errors = []
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' })
page.setDefaultTimeout(30000)
page.on('pageerror', error => errors.push(error.message))

async function waitForTiles(container, style) {
  await container.locator(`img.leaflet-tile[src*="/basemap/${style === 'satellite' ? 'tiles/' : 'streets/'}"]`).first().waitFor()
  await page.waitForFunction(({ selector, style }) => [...document.querySelectorAll(`${selector} img.leaflet-tile`)]
    .some(image => image.src.includes(`/basemap/${style === 'satellite' ? 'tiles/' : 'streets/'}`) && image.complete && image.naturalWidth > 0),
  { selector: '.dashboard-map-interactive', style })
}

try {
  for (const [name, path] of [['province', '/drought-status'], ['district', '/rainfall'], ['municipality', '/water-tariffs-and-quality-costs']]) {
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.goto(`${base}${path}`, { waitUntil: 'domcontentloaded' })
    const map = page.locator('.dashboard-map').first()
    const choice = map.getByLabel('Map view')
    await choice.waitFor()
    await choice.locator('option[value="satellite"]:enabled').waitFor({ state: 'attached' })
    if (name === 'municipality') {
      const standardAreas = page.locator('.mt-map .leaflet-overlay-pane path[role="button"]')
      await standardAreas.first().waitFor()
      await standardAreas.first().focus()
      await standardAreas.first().press('Enter')
      await page.waitForFunction(() => document.querySelector('.mt-map path[aria-pressed="true"]') && document.querySelector('select[aria-label="Trend source region"]')?.value !== 'National')
      checks.originalMunicipalityKeyboardSelection = true
    }
    await choice.selectOption('boundaries')
    const interactive = map.locator('.dashboard-map-interactive')
    const areas = interactive.locator('.leaflet-overlay-pane path[role="button"]')
    await areas.first().waitFor()
    const count = await areas.count()
    await areas.first().focus()
    const regionResponse = name === 'district' ? page.waitForResponse(response => response.url().includes('/api/rainfall/dashboard?') && !new URL(response.url()).searchParams.get('region')?.includes('National')) : null
    await areas.first().press('Enter')
    if (regionResponse) {
      assert.equal((await regionResponse).status(), 200)
      await page.locator('.rf-loading').waitFor({ state: 'hidden' })
      assert.equal(await choice.inputValue(), 'boundaries', 'Regional loading discarded the selected map view')
    }
    await page.waitForFunction(() => document.querySelector('.dashboard-map-interactive path[aria-pressed="true"]'))
    await interactive.locator('.leaflet-control-zoom-in').click()
    await page.waitForTimeout(350)
    const zoomedArea = await areas.first().boundingBox()
    await page.setViewportSize({ width: 1200, height: 900 })
    await page.waitForTimeout(350)
    // Return to the same viewport so Leaflet's path clipping is comparable.
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.waitForTimeout(350)
    const resizedArea = await areas.first().boundingBox()
    assert.ok(Math.abs(zoomedArea.width - resizedArea.width) < 1, `${name} zoom changed on resize: ${zoomedArea.width} -> ${resizedArea.width}`)
    await choice.selectOption('satellite')
    await waitForTiles(interactive, 'satellite')
    await choice.selectOption('streets')
    await waitForTiles(interactive, 'streets')
    await choice.selectOption('existing')
    await map.locator('.dashboard-map-original').waitFor()
    await page.setViewportSize({ width: 390, height: 844 })
    await page.waitForTimeout(350)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `${name} mobile overflow`)
    checks[name] = { areas: count, keyboardSelection: true, resizePreservesZoom: true, satellite: true, streets: true, originalMapRestored: true, mobileNoOverflow: true }
    console.log(`Verified ${name} map`)
  }

  // Deliberately fail one tile, then verify that the map distinguishes partial
  // coverage and that retry restores imagery without losing source polygons.
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto(`${base}/drought-status`, { waitUntil: 'domcontentloaded' })
  const map = page.locator('.dashboard-map').first()
  await map.getByLabel('Map view').locator('option[value="satellite"]:enabled').waitFor({ state: 'attached' })
  let failTile = true
  const tileRoute = '**/spatial-api/basemap/tiles/**'
  await page.route(tileRoute, route => {
    if (failTile) { failTile = false; return route.abort('failed') }
    return route.continue()
  })
  await map.getByLabel('Map view').selectOption('satellite')
  await map.getByText('Some background tiles could not load.', { exact: false }).waitFor()
  assert.ok(await map.locator('.leaflet-overlay-pane path').count() > 0)
  await map.getByRole('button', { name: 'Retry background', exact: true }).click()
  await waitForTiles(map, 'satellite')
  await map.locator('.dashboard-map-message').waitFor({ state: 'hidden' })
  await page.unroute(tileRoute)
  checks.partialFailureAndRetry = true

  // Use SPA navigation so the map display state survives dashboard remounts.
  const navigate = path => page.evaluate(path => {
    window.history.pushState({}, '', path)
    window.dispatchEvent(new PopStateEvent('popstate'))
  }, path)
  await navigate('/satellite-drought')
  await page.waitForFunction(() => document.querySelectorAll('.dashboard-map-choice select').length === 6)
  const currentSatellite = page.locator('.sat-map-wrap').getByLabel('Map view')
  const satelliteIndices = page.locator('.sat-bottom-grid .nw-panel').filter({ hasText: 'Satellite Indices' }).getByLabel('Map view')
  await currentSatellite.selectOption('boundaries')
  await satelliteIndices.selectOption('streets')
  await navigate('/drought-status')
  await page.locator('.dashboard-map-province').waitFor()
  await navigate('/satellite-drought')
  await page.waitForFunction(() => document.querySelectorAll('.dashboard-map-choice select').length === 6)
  await currentSatellite.waitFor()
  assert.equal(await currentSatellite.inputValue(), 'boundaries')
  assert.equal(await satelliteIndices.inputValue(), 'streets')
  checks.independentSatellitePanelChoices = true
  assert.deepEqual(errors, [])
  await mkdir(fileURLToPath(new URL('../output/spatial-dashboard/', import.meta.url)), { recursive: true })
  await writeFile(output, JSON.stringify({ base, checkedAt: new Date().toISOString(), checks, errors }, null, 2))
  console.log(JSON.stringify({ checks, errors, output }, null, 2))
} finally {
  await browser.close()
}
