import assert from 'node:assert/strict'
import { existsSync, readdirSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const base = process.env.NIWIS_VERIFY_URL || 'http://localhost:5173'
const output = fileURLToPath(new URL('../output/interactive-map-verification/', import.meta.url))
await mkdir(output, { recursive: true })
const browserRoot = join(process.env.LOCALAPPDATA || '', 'ms-playwright')
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || (existsSync(browserRoot)
  ? readdirSync(browserRoot).filter(name => /^chromium-\d+$/.test(name)).sort().reverse().map(name => join(browserRoot, name, 'chrome-win64', 'chrome.exe')).find(existsSync)
  : undefined)
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : { channel: 'msedge' }) })
const errors = [], failures = [], checks = []
const routeFilter = process.env.NIWIS_MAP_ROUTES?.split(',').filter(Boolean)
const specifications = [
  ['/vegetation', 'Vegetation region', null, 'Vegetation map month'],
  ['/rainfall', 'Rainfall region', 'Rainfall map indicator', 'Rainfall map month'],
  ['/runoff', 'Runoff region', 'Runoff map indicator', 'Runoff map month'],
  ['/reservoirs', 'Reservoir group', 'Reservoir map indicator', 'Reservoir map day'],
  ['/surface-water', 'Surface water region', 'Surface water map indicator', 'Surface water map month'],
  ['/groundwater', 'Groundwater region', 'Groundwater map indicator', 'Groundwater map month'],
  ['/groundwater-reserve', 'Groundwater reserve region', 'Groundwater reserve map indicator', 'Groundwater reserve map year'],
  ['/water-quality', 'Water quality region', 'Water quality map indicator', 'Water quality map year'],
  ['/wastewater-compliance', 'Wastewater region', 'Wastewater map indicator'],
  ['/drinking-water-compliance', 'Drinking water region', 'Drinking water map indicator'],
  ['/resource-water-quality-objectives', 'RWQO region', 'RWQO map indicator'],
  ['/water-resource-management', 'WRM district', 'WRM map indicator'],
  ['/water-quantity-assessment', 'Water quantity district', 'District map measure', 'District map reporting month'],
  ['/water-services', null, null],
  ['/water-tariffs-and-quality-costs', 'Trend source region', 'Map indicator', 'Reporting year'],
  ['/drought', 'Monitoring region', 'Drought map indicator', 'Drought map month'],
  ['/meteorological', 'Region', 'Meteorological map indicator', 'Meteorological map date'],
  ['/hydrological-drought', 'Select South African district', 'Hydrological map indicator', 'Hydrological map date'],
  ['/satellite-drought', 'Satellite region', null, 'Satellite map date'],
  ...['', '/temperature', '/spells', '/rainfall', '/evaporation', '/irrigation', '/streamflow'].map(suffix => [`/climate${suffix}`, 'Climate region', 'Climate map indicator', 'Climate map month']),
].filter(([route]) => !routeFilter || routeFilter.includes(route))

const normalise = value => String(value || '').toLowerCase().replace(/city of |district municipality|municipality|metropolitan|district/g, '').replace(/[^a-z0-9]/g, '')
const areaSelector = '.dashboard-map-interactive .leaflet-overlay-pane path[role="button"]'
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' })
page.setDefaultTimeout(60000)
page.on('pageerror', error => errors.push({ route: new URL(page.url()).pathname, message: error.message, stack: error.stack }))
await page.addInitScript(() => localStorage.setItem('niwis-color-theme', 'light'))

async function persist() {
  await writeFile(join(output, 'verification.json'), JSON.stringify({ base, checks, failures, errors }, null, 2))
}

async function visibleFeatureCount(map, areas, resetIfEmpty = false) {
  let count = await areas.count()
  if (count || !resetIfEmpty) return count
  const reset = map.locator('.dashboard-map-actions button[aria-label="Show all map areas"]')
  if (await reset.count()) await reset.click()
  for (let attempt = 0; attempt < 20 && !count; attempt += 1) {
    await page.waitForTimeout(100)
    count = await areas.count()
  }
  return count
}

async function inspectMap(label, { expectedUnavailable = false } = {}) {
  const map = page.locator('.nw-main .dashboard-map').filter({ visible: true }).filter({ has: page.locator('.dashboard-map-interactive') }).first()
  await map.getByLabel('Map view', { exact: true }).waitFor()
  assert.equal(await map.getByLabel('Map view', { exact: true }).inputValue(), 'boundaries', `${label}: interactive boundaries should be the default`)
  await map.locator('.leaflet-control-zoom-in').waitFor()
  const areas = map.locator(areaSelector).filter({ visible: true })
  await areas.first().waitFor({ state: 'visible' })
  const count = await visibleFeatureCount(map, areas, true)
  assert.ok(count > 0, `${label}: no geographic features`)
  assert.ok(await map.getByLabel('Map view', { exact: true }).locator('option[value="existing"]').count(), `${label}: standard map option was lost`)
  const result = { featureCount: count, panZoomControls: true, standardMapPreserved: true }
  if (expectedUnavailable) {
    const state = page.locator('.nw-main .district-map-observation-state').first()
    await state.waitFor()
    assert.match(await state.textContent(), /No .*observations|unavailable|missing values/i, `${label}: missing unavailable-data explanation`)
    const fills = await areas.evaluateAll(nodes => [...new Set(nodes.map(node => node.getAttribute('fill')))])
    assert.deepEqual(fills, ['#647582'], `${label}: unavailable source must not have valid measurement shading`)
    result.noData = true
  }
  return { map, areas, result }
}

async function changeChoice(control, label) {
  const available = await control.locator('option:not(:disabled)').evaluateAll(nodes => nodes.map(node => ({ value: node.value, label: node.textContent })))
  const initial = await control.inputValue()
  const next = available.find(item => item.value && item.value !== initial)
  if (!next) return { choices: available.length, changed: false }
  await control.selectOption(next.value)
  assert.equal(await control.inputValue(), next.value, `${label}: choice did not change`)
  await page.locator(areaSelector).filter({ visible: true }).first().waitFor({ state: 'visible' })
  return { choices: available.length, changed: true, selected: next.value }
}

async function checkRoute([route, regionLabel, indicatorLabel, dateLabel]) {
  await page.goto(`${base}${route}`, { waitUntil: 'domcontentloaded' })
  if (indicatorLabel) await page.getByLabel(indicatorLabel, { exact: true }).waitFor()
  else if (route === '/vegetation') {
    await page.getByLabel('Vegetation map product', { exact: true }).waitFor()
    await page.getByLabel('Vegetation map indicator', { exact: true }).waitFor()
  }
  else if (route === '/drought') {
    await page.locator('.dm-kpis').waitFor()
    await page.waitForTimeout(500)
  }
  else if (route === '/satellite-drought') await page.locator('.sat-top-grid').waitFor()
  else if (route === '/water-services') await page.getByRole('group', { name: 'Water services sections', exact: true }).waitFor()
  const { map, areas, result } = await inspectMap(route)
  result.route = route
  const mapWorkspace = map.locator('xpath=../..')
  const province = mapWorkspace.locator('.district-map-filters label').filter({ hasText: 'Province extent' }).first().locator('select')
  if (await province.count()) {
    const before = await visibleFeatureCount(map, areas, true)
    const options = await province.locator('option').evaluateAll(nodes => nodes.map(node => node.value).filter(Boolean))
    assert.equal(options.length, 9, `${route}: province catalogue should cover South Africa`)
    await province.selectOption('Eastern Cape')
    let after = await areas.count()
    for (let attempt = 0; attempt < 30 && after >= before; attempt += 1) {
      await page.waitForTimeout(100)
      after = await areas.count()
    }
    assert.ok(after < before, `${route}: province extent did not filter geographic features (${before} -> ${after}; selected=${await province.inputValue()}; map=${(await map.locator('.dashboard-map-interactive').getAttribute('aria-label')) || ''}; globalPaths=${await page.locator(areaSelector).count()})`)
    await province.selectOption('')
    result.provinceExtent = { before, after }
  }
  if (regionLabel) {
    const region = page.getByLabel(regionLabel, { exact: true })
    await region.waitFor()
    const available = await region.locator('option').evaluateAll(nodes => nodes.map(node => node.value).filter(value => value && !/national|all |all$|covered/i.test(value)))
    const before = await region.inputValue()
    let selected
    for (const candidate of available) {
      if (normalise(candidate) === normalise(before)) continue
      const paths = await areas.evaluateAll((nodes, candidate) => nodes.findIndex(node => {
        const norm = value => value.toLowerCase().replace(/city of |district municipality|municipality|metropolitan|district/g, '').replace(/[^a-z0-9]/g, '')
        const name = (node.getAttribute('aria-label') || '').split(/\s*[^\w\s]+\s*/)[0]
        return norm(name) === norm(candidate)
      }), candidate)
      if (paths >= 0) {
        await areas.nth(paths).focus()
        await areas.nth(paths).press('Enter')
        await page.waitForFunction(({ label, candidate }) => {
          const norm = value => String(value).toLowerCase().replace(/city of |district municipality|municipality|metropolitan|district/g, '').replace(/[^a-z0-9]/g, '')
          return norm(document.querySelector(`select[aria-label="${label}"]`)?.value) === norm(candidate)
        }, { label: regionLabel, candidate })
        selected = candidate
        break
      }
    }
    if (route !== '/water-tariffs-and-quality-costs') assert.ok(selected, `${route}: no source district could be selected using a map feature`)
    result.districtSelectsDashboard = selected || 'Municipal aliases checked in existing map-readiness suite'
    await areas.first().waitFor({ state: 'visible' })
  }
  if (indicatorLabel) result.indicators = await changeChoice(page.getByLabel(indicatorLabel, { exact: true }), `${route} indicator`)
  else if (route === '/vegetation') {
    result.indicators = await changeChoice(page.getByLabel('Vegetation map indicator', { exact: true }), `${route} indicator`)
    const product = page.getByLabel('Vegetation map product', { exact: true })
    await product.selectOption('land_degradation')
    await page.locator('.monitoring-map-source-state').waitFor()
    assert.match(await page.locator('.monitoring-map-source-state').textContent(), /unavailable|not supplied/i)
    await product.selectOption('observations')
  }
  if (dateLabel) {
    const dateControl = route === '/water-tariffs-and-quality-costs'
      ? page.locator('.mt-controls label').filter({ hasText: 'Reporting year' }).locator('select')
      : page.getByLabel(dateLabel, { exact: true })
    result.period = await changeChoice(dateControl, `${route} period`)
  }
  await map.locator('.leaflet-control-zoom-in').click()
  await page.waitForTimeout(250)
  result.zoom = true
  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(250)
  const overflow = await page.evaluate(() => {
    if (document.documentElement.scrollWidth <= innerWidth + 1) return []
    return Array.from(document.querySelectorAll('body *')).map(element => {
      const rect = element.getBoundingClientRect()
      return { tag: element.tagName, className: typeof element.className === 'string' ? element.className : '', text: element.textContent?.trim().slice(0, 45), right: Math.round(rect.right), width: Math.round(rect.width), scrollWidth: element.scrollWidth }
    }).filter(item => item.right > innerWidth + 1 && item.width > 0).sort((a, b) => b.right - a.right).slice(0, 8)
  })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `${route}: mobile page overflows horizontally: ${JSON.stringify(overflow)}`)
  const mobile = await map.locator('.dashboard-map-interactive').evaluate(element => {
    const mapRect = element.getBoundingClientRect()
    const controls = Array.from(element.querySelectorAll('.dashboard-map-actions button, .leaflet-control-zoom a')).map(node => {
      const rect = node.getBoundingClientRect()
      return { name: node.getAttribute('aria-label') || node.title, x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height }
    })
    const overlaps = controls.flatMap((a, index) => controls.slice(index + 1).filter(b => Math.min(a.right, b.right) - Math.max(a.x, b.x) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y) > 1).map(b => [a.name, b.name]))
    return { width: mapRect.width, controls, overlaps }
  })
  assert.ok(mobile.width >= 240, `${route}: phone map is only ${mobile.width}px wide`)
  assert.deepEqual(mobile.overlaps, [], `${route}: mobile map controls overlap`)
  result.mobile = mobile
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.waitForTimeout(150)
  await page.screenshot({ path: join(output, `${route.slice(1).replaceAll('/', '-')}.png`) })
  checks.push(result)
  console.log(`${route}: map, available filters and selection verified`)
}

async function checkSubmodules() {
  const groups = [
    ['/resource-water-quality-objectives', 'RWQO section'],
    ['/water-resource-management', 'WRM section'],
    ['/water-services', 'Water services sections'],
    ['/water-tariffs-and-quality-costs', 'Dataset'],
  ].filter(([route]) => !routeFilter || routeFilter.includes(route))
  for (const [route, name] of groups) {
    await page.goto(`${base}${route}`, { waitUntil: 'domcontentloaded' })
    const group = name === 'Dataset' ? page.getByRole('navigation', { name, exact: true }) : page.getByRole('group', { name, exact: true })
    await group.waitFor()
    const buttons = group.locator('button')
    const labels = await buttons.allTextContents()
    for (let index = 0; index < labels.length; index += 1) {
      await buttons.nth(index).click()
      await page.locator(areaSelector).first().waitFor()
      const record = await inspectMap(`${route}: ${labels[index]}`)
      checks.push({ route, submodule: labels[index].trim(), ...record.result })
      console.log(`${route}: ${labels[index].trim()} has an interactive map`)
    }
  }
  if (!routeFilter || routeFilter.includes('/water-quantity-assessment')) {
    await page.goto(`${base}/water-quantity-assessment`, { waitUntil: 'domcontentloaded' })
    await page.getByLabel('Water quantity map source', { exact: true }).selectOption('balance')
    const record = await inspectMap('National water balance', { expectedUnavailable: true })
    assert.match(await page.locator('.monitoring-map-source-state').textContent(), /national observation.*without district|subnational/i)
    checks.push({ route: '/water-quantity-assessment', submodule: 'National water balance', ...record.result })
  }
}

try {
  if (!process.env.NIWIS_MAP_ERRORS_ONLY) {
    for (const specification of specifications) {
      try { await checkRoute(specification) } catch (error) { failures.push({ route: specification[0], phase: 'observations', message: error.message }); console.log(`FAILED ${specification[0]}: ${error.message.slice(0, 180)}`) }
      await persist()
    }
    try { await checkSubmodules() } catch (error) { failures.push({ phase: 'submodules', message: error.message }) }
    await persist()
  }
  if (!process.env.NIWIS_MAP_SKIP_ERRORS) {
    const errorPage = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' })
    errorPage.setDefaultTimeout(30000)
    errorPage.on('pageerror', error => errors.push({ phase: 'unavailable', route: new URL(errorPage.url()).pathname, message: error.message }))
    await errorPage.route('**/api/**', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ detail: 'Monitoring source unavailable for map verification.' }) }))
    for (const [route] of specifications) {
      try {
        await errorPage.goto(`${base}${route}`, { waitUntil: 'domcontentloaded' })
        const map = errorPage.locator('.nw-main .dashboard-map').filter({ visible: true }).filter({ has: errorPage.locator('.dashboard-map-interactive') }).first()
        await map.locator(areaSelector).filter({ visible: true }).first().waitFor({ state: 'visible' })
        const state = errorPage.locator('.district-map-observation-state').first()
        await state.waitFor()
        assert.match(await state.textContent(), /No .*observations|unavailable|missing values/i)
        const fills = await map.locator(areaSelector).filter({ visible: true }).evaluateAll(nodes => [...new Set(nodes.map(node => node.getAttribute('fill')))])
        assert.deepEqual(fills, ['#647582'])
        await map.locator('.leaflet-control-zoom-in').click()
        checks.push({ route, sourceUnavailable: true, features: await map.locator(areaSelector).count(), missingValuesNotZero: true, zoom: true })
        console.log(`${route}: unavailable-source boundaries preserved`)
      } catch (error) { failures.push({ route, phase: 'unavailable', message: error.message }); console.log(`FAILED unavailable ${route}: ${error.message.slice(0, 160)}`) }
      await persist()
    }
    await errorPage.close()
  }
  assert.deepEqual(errors, [], 'Browser errors occurred')
  assert.deepEqual(failures, [], 'Some map requirements failed; see verification.json')
  console.log(JSON.stringify({ checks: checks.length, errors, failures, output }, null, 2))
} finally {
  await persist()
  await browser.close()
}
