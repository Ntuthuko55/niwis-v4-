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
const output = resolve(frontend, '../output/runoff-database')
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
let failDatabase = false
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
  await page.route('**/api/runoff/**', route => failDatabase ? route.fulfill({ status: 502, json: { detail: 'Runoff database unavailable for verification' } }) : route.continue())
  const base = `http://127.0.0.1:${pagePort}`
  async function enter() {
    await page.goto(base + '/runoff', { waitUntil: 'domcontentloaded' })
    if (await page.locator('.nw-role').count()) await page.locator('.nw-role').first().click()
  }
  const paths = () => page.locator('.rf-map-panel path[role="button"]')
  async function readyCharts() {
    await page.locator('.runoff-dashboard .rf-kpi').first().waitFor({ timeout: 180000 })
    await page.waitForFunction(() => !document.querySelector('.runoff-dashboard .rf-loading'))
    await page.locator('.runoff-dashboard .rf-daily-grid .rf-panel').first().locator('.recharts-wrapper > .recharts-surface').waitFor({ timeout: 90000 })
    assert.equal(await page.locator('.runoff-dashboard .rf-kpi').count(), 6)
    assert.equal(await paths().count(), 52)
    assert.ok(await page.locator('.runoff-dashboard .recharts-surface').count() >= 8)
  }
  await enter()
  await readyCharts()
  assert.equal(await page.getByLabel('Runoff region', { exact: true }).locator('option').count(), 53)
  assert.equal(await page.getByLabel('Runoff end month', { exact: true }).inputValue(), '2026-08')
  assert.match(await page.locator('.rf-context').innerText(), /Database observations through 2026-09-06/)
  await page.screenshot({ path: join(output, 'national-desktop.png'), fullPage: true })
  report.checks.push('National dashboard: six KPIs, charts, 52 districts and database source')

  await page.getByLabel('Runoff region', { exact: true }).selectOption('City of Tshwane')
  await page.getByLabel('Runoff start month', { exact: true }).fill('2024-02')
  await page.getByLabel('Runoff end month', { exact: true }).fill('2024-03')
  const changed = page.waitForResponse(response => response.url().includes('/api/runoff/dashboard?') && response.url().includes('start=2024-02') && response.ok())
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click()
  await changed
  await readyCharts()
  assert.match(await page.locator('.rf-context').innerText(), /City of Tshwane/)
  const dailyChanged = page.waitForResponse(response => response.url().includes('/api/runoff/daily?') && response.url().includes('month=2024-02') && response.ok())
  await page.getByLabel('Runoff daily month', { exact: true }).selectOption('2024-02')
  await dailyChanged
  const downloaded = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Daily CSV', exact: true }).click()
  const download = await downloaded
  const stream = await download.createReadStream()
  assert.ok(stream, 'Daily CSV download did not produce a readable stream')
  let exported = ''
  try {
    for await (const chunk of stream) exported += chunk.toString('utf8')
    assert.equal(exported.trim().split(/\r?\n/).length, 30)
  } finally {
    await download.delete()
  }
  await page.screenshot({ path: join(output, 'district-desktop.png'), fullPage: true })
  report.checks.push('District filters preserve all 52 map districts; daily export contains 29 February observations')

  await page.setViewportSize({ width: 390, height: 844 })
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2))
  await page.screenshot({ path: join(output, 'district-mobile.png'), fullPage: true })
  report.checks.push('Mobile layout fits the viewport')

  failDatabase = true
  await page.reload({ waitUntil: 'domcontentloaded' })
  if (await page.locator('.nw-role').count()) await page.locator('.nw-role').first().click()
  await page.getByRole('alert').filter({ hasText: 'Runoff database unavailable for verification' }).waitFor({ timeout: 30000 })
  assert.equal(await page.locator('.runoff-dashboard .rf-kpi').count(), 0)
  failDatabase = false
  await page.getByRole('button', { name: 'Retry', exact: true }).click()
  await readyCharts()
  report.checks.push('Database failure is visible; retry restores the dashboard without a CSV fallback')
  await Promise.all(responses)
  assert.deepEqual(errors, [])
  assert.deepEqual(csvRequests, [])
  assert.ok(snapshots.length >= 5)
  assert.ok(snapshots.every(item => item.source === 'Supabase' && item.source_mode === 'database'))
  report.status = 'passed'
  console.log(JSON.stringify({ status: report.status, checks: report.checks, csv_requests: csvRequests.length, javascript_errors: errors.length }))
} catch (error) {
  report.status = 'failed'
  report.error = error.message
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
