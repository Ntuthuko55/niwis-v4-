import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'

const base = process.env.NIWIS_VERIFY_URL || 'http://127.0.0.1:5184'
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
const errors = [], requests = [], results = []
page.on('pageerror', error => errors.push(error.message))
page.on('request', request => requests.push(request.url()))
await page.route('**/niwis-api/api/predictions/latest', route => route.fulfill({ json: { predictions: [] } }))
// Reproduce offline font services: dashboard chunks must still load.
await page.route('https://fonts.googleapis.com/**', route => route.abort())
await page.route('https://fonts.gstatic.com/**', route => route.abort())
const routes = [
  ['/reservoirs', '.rs-main-chart .recharts-surface'],
  ['/climate', '.cl-primary-grid .recharts-surface'],
  ...['temperature', 'spells', 'rainfall', 'evaporation', 'irrigation', 'streamflow'].map(section => [`/climate/${section}`, '.cl-feature-chart .recharts-surface']),
  ['/vegetation', '.vg-map-body .municipality-map svg'],
  ['/rainfall', '.rf-primary-grid .recharts-surface'],
  ['/runoff', '.rf-primary-grid .recharts-surface'],
  ['/surface-water', '.rf-primary-grid .recharts-surface'],
  ['/groundwater', '.rf-primary-grid .recharts-surface'],
  ['/groundwater-reserve', '.rf-primary-grid .recharts-surface'],
  ['/water-quality', '.rf-primary-grid .recharts-surface'],
  ['/hydrological-drought', '.hydro-kpi-bar'],
  ['/satellite-drought', '.sat-kpi-strip'],
  ['/meteorological', '.municipality-map svg'],
  ['/drought', '.dm-metric'],
]
const selectedRoutes = process.env.NIWIS_VERIFY_PATHS ? new Set(process.env.NIWIS_VERIFY_PATHS.split(',')) : null

try {
  await mkdir('../output/dashboard-performance', { recursive: true })
  await page.goto(base + routes[0][0], { waitUntil: 'domcontentloaded' })
  for (let index = 0; index < routes.length; index++) {
    const [path, selector] = routes[index]
    if (selectedRoutes && !selectedRoutes.has(path)) continue
    const started = Date.now()
    if (index) await page.evaluate(path => {
      history.pushState({}, '', path)
      dispatchEvent(new PopStateEvent('popstate'))
    }, path)
    try {
      await page.waitForTimeout(100)
      let rejectOnError
      const runtimeError = new Promise((resolve, reject) => { rejectOnError = reject; page.once('pageerror', rejectOnError) })
      await Promise.race([page.locator(selector).first().waitFor({ timeout: 150000 }), runtimeError])
        .finally(() => page.off('pageerror', rejectOnError))
      await page.waitForTimeout(250)
      const alerts = await page.locator('.rf-error, .cl-error, .vg-error, .nw-error').allTextContents()
      assert.deepEqual(alerts, [], `${path}: visible load errors`)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `${path}: horizontal overflow`)
      const paths = page.locator('.municipality-map').first().locator('path[role="button"]')
      const mapPaths = await paths.count()
      if (mapPaths) {
        assert.equal(mapPaths, 52, `${path}: every district boundary remains available`)
        const before = await paths.evaluateAll(nodes => nodes.map(node => node.getAttribute('fill')))
        await paths.first().focus()
        await paths.first().evaluate(node => node.blur())
        assert.deepEqual(await paths.evaluateAll(nodes => nodes.map(node => node.getAttribute('fill'))), before, `${path}: hovering preserves colours`)
      }
      if (path === '/reservoirs') {
        assert.ok(!requests.some(url => url.includes('react-plotly-')), 'Reservoirs must not download Plotly')
        assert.ok(!requests.some(url => url.includes('/reservoirs/audit')), 'Full audit must wait until opened')
        await page.screenshot({ path: '../output/dashboard-performance/reservoir-desktop.png', fullPage: true })
      }
      if (path === '/climate') {
        assert.ok(!requests.some(url => url.endsWith('/api/dashboard/dataset')), 'Forecast source registration must wait until opened')
      }
      let nationalPaths = mapPaths
      if (path === '/hydrological-drought') {
        await page.getByRole('button', { name: 'National (52)', exact: true }).click()
        const map = page.locator('.hydro-map-svg-area svg')
        const frame = await map.getAttribute('viewBox')
        assert.equal(await map.locator('path').count(), 52)
        await page.getByLabel('Select South African District').selectOption('Vhembe')
        await page.locator('.hydro-panel-title').filter({ hasText: /Vhembe/ }).first().waitFor({ timeout: 60000 })
        assert.equal(await map.locator('path').count(), 52)
        assert.equal(await map.getAttribute('viewBox'), frame, 'District selection preserves the national map frame')
        nationalPaths = 52
      }
      const item = { path, status: 'passed', milliseconds: Date.now() - started, map_paths: nationalPaths }
      results.push(item)
      await writeFile('../output/dashboard-performance/browser-progress.json', JSON.stringify({ results, errors }, null, 2))
      console.log(`PASS ${path}: ${item.milliseconds}ms, ${item.map_paths} district paths`)
    } catch (error) {
      results.push({ path, status: 'failed', error: error.message })
      await writeFile('../output/dashboard-performance/browser-progress.json', JSON.stringify({ results, errors }, null, 2))
      console.log(`FAIL ${path}: ${error.message}`)
      await page.screenshot({ path: `../output/dashboard-performance/failure-${index}.png`, fullPage: true })
      // A runtime failure unmounts React; reload before checking another page.
      if (errors.length) await page.goto(base + path, { waitUntil: 'domcontentloaded' })
    }
  }
  assert.ok(!requests.some(url => url.includes('/api/hydrology/dataset')), 'Hydrology must not fetch all districts\' full histories')
  assert.ok(!requests.some(url => /south_africa_adm2\.geojson/.test(url)), 'Use the smaller display map')
  assert.deepEqual(errors, [], 'No JavaScript runtime errors')
} finally {
  await writeFile('../output/dashboard-performance/browser-verification.json', JSON.stringify({ results, errors, requests }, null, 2))
  await browser.close()
}
if (results.some(result => result.status === 'failed')) process.exitCode = 1
