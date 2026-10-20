import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { preview } from 'vite'
import { chromium } from 'playwright'
import config from './vite.config.js'

const frontend = dirname(fileURLToPath(import.meta.url))
const backend = resolve(frontend, '../backend')
const output = resolve(frontend, '../output/drought-database')
await mkdir(output, { recursive: true })
async function freePort() {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}
const apiPort = await freePort(), pagePort = await freePort()
const python = join(backend, process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python')
const child = spawn(python, ['-B', '-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', String(apiPort)], {
  cwd: backend, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
})
let log = '', server, browser, failSatellite = false
child.stdout.on('data', value => { log += value.toString() })
child.stderr.on('data', value => { log += value.toString() })
const report = { checks: [], errors: [], csv_requests: [], sources: [], timings: [] }
const responses = []
try {
  let ready = false
  for (let attempt = 0; attempt < 90; attempt++) {
    if (child.exitCode !== null) throw new Error(log.slice(-1800))
    try { ready = (await fetch(`http://127.0.0.1:${apiPort}/health`)).ok } catch {}
    if (ready) break
    await delay(500)
  }
  assert.ok(ready, 'Drought verification backend did not start')
  const proxy = Object.fromEntries(Object.entries(config.server.proxy).map(([prefix, options]) => [prefix, { ...options, target: `http://127.0.0.1:${apiPort}` }]))
  server = await preview({ ...config, root: frontend, configFile: false, preview: { host: '127.0.0.1', port: pagePort, strictPort: true, proxy } })
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
  page.on('pageerror', error => report.errors.push(error.message))
  page.on('request', request => { if (/\.csv(?:\?|$)/i.test(request.url())) report.csv_requests.push(request.url()) })
  page.on('response', response => {
    if (/\/api\/(drought-monitoring|hydrology|satellite)\//.test(response.url()) && response.ok()) {
      responses.push(response.json().then(data => report.sources.push({ path: new URL(response.url()).pathname, source_mode: data.source_mode, tables: data.source_tables })))
    }
  })
  await page.route('https://fonts.googleapis.com/**', route => route.abort())
  await page.route('https://fonts.gstatic.com/**', route => route.abort())
  await page.route('**/niwis-api/api/predictions/latest', route => route.fulfill({ json: { predictions: [] } }))
  await page.route('**/api/satellite/**', route => failSatellite
    ? route.fulfill({ status: 503, json: { detail: 'Satellite database unavailable for verification' } })
    : route.continue())
  const base = `http://127.0.0.1:${pagePort}`
  async function enter(path, selector) {
    await page.setViewportSize({ width: 1600, height: 1000 })
    const started = Date.now()
    await page.goto(base + path, { waitUntil: 'domcontentloaded' })
    await page.locator(selector).first().waitFor({ timeout: 120000 })
    report.timings.push({ path, first_visible_ms: Date.now() - started })
    assert.equal(await page.getByRole('button', { name: 'Analysis Studio', exact: true }).count(), 0)
    assert.equal(await page.getByRole('button', { name: 'Prediction Engine', exact: true }).count(), 0)
  }
  async function snapshots(name) {
    assert.equal(await page.locator('.nw-main [role="alert"]').count(), 0)
    await page.screenshot({ path: join(output, `${name}-desktop.png`), fullPage: true })
    await page.setViewportSize({ width: 390, height: 844 })
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2), `${name}: mobile overflow`)
    await page.screenshot({ path: join(output, `${name}-mobile.png`), fullPage: true })
  }
  async function districtOption(select, name) {
    const options = await select.locator('option').evaluateAll(nodes => nodes.map(node => ({ label: node.label, value: node.value })))
    const option = options.find(option => option.label.trim().toLowerCase() === name.toLowerCase())
    assert.ok(option, `Missing district ${name}`)
    return option.value
  }

  await enter('/drought', '.dm-dashboard .dm-metric')
  assert.equal(await page.locator('.dm-metric').count(), 6)
  assert.equal(await page.getByLabel('Monitoring region').locator('option').count(), 52)
  await page.locator('.dm-map-panel path[role="button"]').first().waitFor({ timeout: 30000 })
  assert.equal(await page.locator('.dm-map-panel path[role="button"]').count(), 52)
  assert.match(await page.locator('.dm-source-pill').innerText(), /Supabase observations/)
  await Promise.all([
    page.waitForResponse(response => response.url().includes('/api/drought-monitoring/region?') && response.url().includes('Alfred') && response.ok()),
    page.getByLabel('Monitoring region').selectOption({ label: 'Alfred Nzo' }),
  ])
  await page.locator('.dm-metric').first().waitFor()
  await page.locator('.dm-map-panel path[role="button"]').first().waitFor({ timeout: 30000 })
  assert.equal(await page.locator('.dm-map-panel path[role="button"]').count(), 52)
  await page.getByRole('button', { name: 'SSI', exact: true }).click()
  await page.locator('.dm-map-panel path[role="button"]').first().waitFor({ timeout: 30000 })
  assert.equal(await page.locator('.dm-map-panel path[role="button"]').count(), 52)
  assert.ok(await page.locator('.dm-dashboard .recharts-surface').count() >= 3)
  await snapshots('drought-monitoring')
  report.checks.push('Drought Monitoring: database label, six metrics, charts, region/layer selection and all 52 districts')
  console.log('PASS Drought Monitoring: charts, district selection, map and mobile layout')

  await enter('/hydrological-drought', '.hydro-kpi-val')
  const districts = page.getByLabel('Select South African District')
  assert.equal(await districts.locator('option').count(), 52)
  await page.getByRole('button', { name: 'National (52)', exact: true }).click()
  const hydroMap = page.locator('.hydro-map-svg-area svg')
  const frame = await hydroMap.getAttribute('viewBox')
  assert.equal(await hydroMap.locator('path').count(), 52)
  await districts.selectOption({ label: 'Vhembe' })
  await page.locator('.hydro-panel-title').filter({ hasText: /Vhembe/ }).first().waitFor({ timeout: 60000 })
  assert.equal(await hydroMap.locator('path').count(), 52)
  assert.equal(await hydroMap.getAttribute('viewBox'), frame)
  assert.match(await page.locator('.hydro-container').innerText(), /Database hydrological_drought_master/)
  await snapshots('hydrological-drought')
  report.checks.push('Hydrological Drought: database observations, district charts and complete national map after district selection')
  console.log('PASS Hydrological Drought: database observations, 52 map districts and mobile layout')

  await enter('/satellite-drought', '.sat-kpi-strip')
  const satellite = page.getByLabel('Satellite region')
  assert.equal(await satellite.locator('option').count(), 53)
  await page.locator('.sat-chart svg').waitFor({ timeout: 60000 })
  const satelliteDistrict = await districtOption(satellite, 'Vhembe')
  const [satelliteHistoryResponse] = await Promise.all([
    page.waitForResponse(response => response.url().includes('/api/satellite/history?') && response.url().toLowerCase().includes('vhembe') && response.ok()),
    satellite.selectOption(satelliteDistrict),
  ])
  const satelliteHistory = await satelliteHistoryResponse.json()
  assert.ok(satelliteHistory.history.length > 12)
  await page.locator('.sat-chart svg').waitFor({ timeout: 60000 })
  await Promise.all([
    page.waitForResponse(response => response.url().includes('/api/satellite/stations?date=2024-01-01') && response.ok()),
    page.getByLabel('Satellite map date').selectOption('2024-01-01'),
  ])
  await page.locator('.sat-map-wrap path[role="button"]').first().waitFor()
  assert.equal(await page.locator('.sat-map-wrap path[role="button"]').count(), 52)
  assert.match(await page.locator('.sat-note').innerText(), new RegExp(`${satelliteHistory.history.length} database observations for vhembe`, 'i'))
  await snapshots('satellite-drought')
  report.checks.push('Satellite drought: rendered history count matches API, dated map, charts and 52 districts after filtering')
  console.log('PASS Satellite Drought: database observations, dated maps and mobile layout')

  failSatellite = true
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.getByRole('alert').filter({ hasText: 'Satellite database unavailable for verification' }).waitFor({ timeout: 30000 })
  assert.equal(await page.locator('.sat-kpi-strip').count(), 0)
  report.checks.push('Database outage is shown explicitly without substituting CSV observations')
  await Promise.all(responses)
  assert.deepEqual(report.errors, [])
  assert.deepEqual(report.csv_requests, [])
  assert.ok(report.sources.length >= 8)
  assert.ok(report.sources.every(source => source.source_mode === 'database'))
  report.status = 'passed'
  console.log(JSON.stringify({ status: report.status, checks: report.checks, timings: report.timings, javascript_errors: report.errors.length }))
} catch (error) {
  report.status = 'failed'
  report.error = error.message
  if (browser) {
    const page = browser.contexts()[0]?.pages()[0]
    if (page) {
      report.page_text = (await page.locator('body').innerText()).slice(-12000)
      await page.screenshot({ path: join(output, 'browser-failure.png'), fullPage: true })
    }
  }
  throw error
} finally {
  await writeFile(join(output, 'browser-verification.json'), JSON.stringify(report, null, 2) + '\n')
  if (browser) await browser.close()
  if (server) await server.httpServer.close()
  if (child.exitCode === null) {
    const stopped = once(child, 'exit')
    if (process.platform === 'win32') {
      const kill = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' })
      await once(kill, 'exit')
    } else child.kill()
    await stopped
  }
}
