import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { preview } from 'vite'
import { chromium } from 'playwright'
import config from './vite.config.js'

const frontend = dirname(fileURLToPath(import.meta.url))
const backend = resolve(frontend, '../backend')
const output = resolve(frontend, '../output/dashboard-removal')
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
const python = process.platform === 'win32' ? join(backend, '.venv/Scripts/python.exe') : join(backend, '.venv/bin/python')
const child = spawn(python, ['-B', '-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', String(apiPort)], {
  cwd: backend, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
})
let serverLog = '', server, browser
child.stdout.on('data', value => { serverLog += value.toString() })
child.stderr.on('data', value => { serverLog += value.toString() })
const errors = [], csvRequests = [], responses = [], snapshots = []
const report = { checks: [], errors, csv_requests: csvRequests, api_responses: snapshots }

try {
  let ready = false
  for (let attempt = 0; attempt < 90; attempt++) {
    if (child.exitCode !== null) throw new Error(`Verification API exited: ${serverLog.slice(-1500)}`)
    try { ready = (await fetch(`http://127.0.0.1:${apiPort}/health`)).ok } catch {}
    if (ready) break
    await delay(500)
  }
  assert.ok(ready, 'Verification API did not start')
  const proxy = Object.fromEntries(Object.entries(config.server.proxy).map(([prefix, options]) => [prefix, { ...options, target: `http://127.0.0.1:${apiPort}` }]))
  server = await preview({ ...config, root: frontend, configFile: false, preview: { host: '127.0.0.1', port: pagePort, strictPort: true, proxy } })
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true })
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => { if (/\.csv(?:\?|$)/i.test(request.url())) csvRequests.push(request.url()) })
  page.on('response', response => {
    if (response.url().includes('/api/runoff/') && response.status() === 200) {
      responses.push(response.json().then(data => {
        snapshots.push({ path: new URL(response.url()).pathname, source: data.source, source_mode: data.source_mode, tables: data.source_tables, map_rows: data.map?.length })
      }))
    }
  })
  await page.route('https://fonts.googleapis.com/**', route => route.abort())
  await page.route('https://fonts.gstatic.com/**', route => route.abort())
  await page.route('**/niwis-api/api/predictions/latest', route => route.fulfill({ json: { predictions: [] } }))
  const base = `http://127.0.0.1:${pagePort}`
  const api = `http://127.0.0.1:${apiPort}`
  for (const [method, path] of [
    ['GET', '/spatial-api/api/health'], ['GET', '/multivariate-api/api/health'],
    ['POST', '/upload'], ['POST', '/analysis'], ['POST', '/analysis/comprehensive'],
    ['POST', '/feature-engineering/generate'], ['POST', '/report/pdf'],
    ['POST', '/forecast'], ['POST', '/dashboard/forecast'], ['POST', '/kzn/forecast'],
    ['POST', '/provinces/gauteng/load'], ['GET', '/provinces'],
  ]) {
    assert.equal((await fetch(api + path, { method })).status, 404, path)
  }
  report.checks.push('Retired standalone API routes return 404')
  const openapi = await (await fetch(api + '/api/openapi.json')).json()
  for (const path of ['/dashboard/dataset', '/models/train', '/models/jobs/{job_id}', '/meteorological/load', '/provinces/series/{dataset_id}']) {
    assert.ok(openapi.paths[path], `Shared dashboard API preserved: ${path}`)
  }
  await page.goto(base + '/runoff', { waitUntil: 'domcontentloaded' })
  await page.locator('.runoff-dashboard .rf-kpi').first().waitFor({ timeout: 180000 })
  assert.equal(await page.locator('.rf-map-panel path[role="button"]').count(), 52)
  assert.equal(await page.getByRole('button', { name: 'Analysis Studio', exact: true }).count(), 0)
  assert.equal(await page.getByRole('button', { name: 'Prediction Engine', exact: true }).count(), 0)
  assert.equal(await page.getByText('Intelligence', { exact: true }).count(), 0)
  assert.ok(await page.getByRole('button', { name: /Groundwater Level Monitoring Network/ }).count())
  assert.match(await page.locator('.nw-topactions').innerText(), /Supabase observations/)
  await page.screenshot({ path: join(output, 'monitoring-desktop.png'), fullPage: true })
  report.checks.push('Desktop navigation excludes both pages; Runoff database charts and 52 districts remain')

  await page.getByRole('button', { name: 'Open forecasting studio', exact: true }).click()
  const studio = page.getByRole('region', { name: 'Runoff forecasting studio' })
  await studio.getByLabel('Target', { exact: true }).waitFor({ timeout: 180000 })
  await studio.getByLabel('Model', { exact: true }).selectOption('Naive')
  await studio.getByLabel('Horizon', { exact: true }).selectOption('180')
  await studio.getByRole('button', { name: 'Run Naive', exact: true }).click()
  await studio.getByText(/Forecast complete.*6 future observations/).waitFor({ timeout: 90000 })
  await studio.locator('.js-plotly-plot').waitFor({ timeout: 30000 })
  report.checks.push('Retained dashboard forecast: real Runoff source, registration, Naive worker, polling and six plotted future observations')

  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: 'Toggle menu', exact: true }).click()
  assert.equal(await page.locator('.nw-nav.open').count(), 1)
  assert.equal(await page.getByRole('button', { name: 'Analysis Studio', exact: true }).count(), 0)
  assert.equal(await page.getByRole('button', { name: 'Prediction Engine', exact: true }).count(), 0)
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2))
  await page.screenshot({ path: join(output, 'monitoring-mobile.png'), fullPage: true })
  report.checks.push('Mobile menu retains monitoring navigation and fits the viewport')

  // Old bookmarks reach the normal monitoring route; source failures are isolated
  // here because only route fallback, not the drought data, is under test.
  await page.route('**/api/drought-monitoring/**', route => route.fulfill({ status: 503, json: { detail: 'Route verification: monitoring source not requested' } }))
  for (const path of ['/studio', '/prediction']) {
    await page.goto(base + path, { waitUntil: 'domcontentloaded' })
    await page.locator('.dm-dashboard').waitFor({ timeout: 30000 })
    assert.equal(new URL(page.url()).pathname, '/drought')
    assert.match(await page.locator('.nw-navitem.sel').first().innerText(), /1\.\s*Drought/)
  }
  report.checks.push('Removed page bookmarks fall back to Drought Monitoring')
  await Promise.all(responses)
  assert.deepEqual(errors, [])
  assert.deepEqual(csvRequests, [])
  assert.ok(snapshots.length >= 3)
  assert.ok(snapshots.every(item => item.source === 'Supabase' && item.source_mode === 'database'))
  report.status = 'passed'
  console.log(JSON.stringify({ status: report.status, checks: report.checks, csv_requests: csvRequests.length, javascript_errors: errors.length }))
} catch (error) {
  report.status = 'failed'
  report.error = error.message
  throw error
} finally {
  await writeFile(join(output, 'verification.json'), JSON.stringify(report, null, 2) + '\n')
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
