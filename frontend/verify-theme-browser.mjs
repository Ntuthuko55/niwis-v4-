import assert from 'node:assert/strict'
import { existsSync, readdirSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const base = process.env.NIWIS_VERIFY_URL || 'http://localhost:5173'
const output = fileURLToPath(new URL('../output/theme-verification/', import.meta.url))
await mkdir(output, { recursive: true })
const browserRoot = join(process.env.LOCALAPPDATA || '', 'ms-playwright')
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || (existsSync(browserRoot)
  ? readdirSync(browserRoot).filter(name => /^chromium-\d+$/.test(name)).sort().reverse().map(name => join(browserRoot, name, 'chrome-win64', 'chrome.exe')).find(existsSync)
  : undefined)
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : { channel: 'msedge' }) })
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' })
page.setDefaultTimeout(45000)
const errors = []
page.on('pageerror', error => errors.push(error.message))
const checks = {}

async function contrastAudit() {
  return page.evaluate(() => {
    const rgb = value => {
      const parts = value.match(/[\d.]+/g)?.map(Number)
      return parts?.length >= 3 ? [...parts.slice(0, 3), parts[3] ?? 1] : [0, 0, 0, 0]
    }
    const compose = (front, back) => front.slice(0, 3).map((value, i) => value * front[3] + back[i] * (1 - front[3]))
    const background = element => {
      const ancestry = []
      for (let current = element; current; current = current.parentElement) ancestry.unshift(current)
      return ancestry.reduce((colour, current) => {
        const style = getComputedStyle(current)
        let next = rgb(style.backgroundColor)
        const gradient = style.backgroundImage.match(/rgba?\([^)]+\)/g)
        if (gradient?.length) next = rgb(gradient[0])
        return compose(next, colour)
      }, [255, 255, 255])
    }
    const luminance = colour => colour.map(value => value / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4).reduce((sum, value, i) => sum + value * [.2126, .7152, .0722][i], 0)
    const failures = []
    for (const element of document.querySelectorAll('.nw *')) {
      if (!Array.from(element.childNodes).some(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim())) continue
      if (element.closest('svg, .leaflet-container, [disabled], [aria-disabled="true"], .nw-nav:not(.open)') && innerWidth <= 760) continue
      if (element.closest('svg, .leaflet-container, [disabled], [aria-disabled="true"]')) continue
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      if (!rect.width || !rect.height || style.visibility !== 'visible' || Number(style.opacity) < .8) continue
      const bg = background(element)
      const fg = compose(rgb(style.color), bg)
      const lighter = Math.max(luminance(fg), luminance(bg))
      const darker = Math.min(luminance(fg), luminance(bg))
      const ratio = (lighter + .05) / (darker + .05)
      const large = Number.parseFloat(style.fontSize) >= 24 || (Number.parseFloat(style.fontSize) >= 18.66 && Number(style.fontWeight) >= 700)
      if (ratio < (large ? 3 : 4.5) - .05) failures.push({ tag: element.tagName, className: String(element.className), parentClass: String(element.parentElement?.className), text: element.textContent.trim().slice(0, 80), colour: style.color, background: bg.map(Math.round), ratio: Number(ratio.toFixed(2)) })
    }
    return failures.filter((entry, index, all) => all.findIndex(other => other.className === entry.className && other.colour === entry.colour && other.ratio === entry.ratio) === index).slice(0, 100)
  })
}

try {
  await page.goto(`${base}/drought`, { waitUntil: 'domcontentloaded' })
  await page.locator('.dm-chart .recharts-wrapper').first().waitFor()
  assert.equal(await page.getByLabel('Colour theme').inputValue(), 'navy')
  const region = await page.getByLabel('Monitoring region').inputValue()
  await page.getByLabel('Colour theme').selectOption('light')
  assert.equal(await page.evaluate(() => document.documentElement.dataset.niwisTheme), 'light')
  assert.equal(await page.evaluate(() => localStorage.getItem('niwis-color-theme')), 'light')
  assert.equal(await page.getByLabel('Monitoring region').inputValue(), region)
  await page.waitForTimeout(250)
  await page.screenshot({ path: join(output, 'drought-light-desktop.png') })
  checks.droughtContrast = await contrastAudit()
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.getByLabel('Colour theme').waitFor()
  assert.equal(await page.getByLabel('Colour theme').inputValue(), 'light')
  checks.savedPreference = true

  const routes = process.env.NIWIS_THEME_QUICK ? [] : [
    '/climate', '/vegetation', '/rainfall', '/runoff', '/surface-water',
    '/groundwater', '/groundwater-reserve', '/water-quality', '/reservoirs',
    '/wastewater-compliance', '/drinking-water-compliance',
    '/resource-water-quality-objectives', '/water-resource-management',
    '/water-quantity-assessment', '/water-services', '/water-tariffs-and-quality-costs',
    '/hydrological-drought', '/meteorological', '/satellite-drought',
  ]
  checks.dashboards = []
  for (const route of routes) {
    await page.goto(`${base}${route}`, { waitUntil: 'domcontentloaded' })
    await page.getByLabel('Colour theme').waitFor()
    assert.equal(await page.getByLabel('Colour theme').inputValue(), 'light')
    await page.waitForFunction(() => document.querySelector('.nw-main .recharts-wrapper, .nw-main .hydro-chart-canvas svg, .nw-main .nw-chart svg, .nw-main .sat-chart svg, .nw-main .js-plotly-plot .main-svg, .nw-main .nw-overview-grid .nw-kpi') || Array.from(document.querySelectorAll('.nw-main [role="alert"]')).some(node => /unavailable|failed|could not|error/i.test(node.textContent)))
    const issues = await contrastAudit()
    checks.dashboards.push({ route, issues })
    await writeFile(join(output, 'progress.json'), JSON.stringify({ checks, errors }, null, 2))
    await page.screenshot({ path: join(output, `${route.slice(1).replaceAll('/', '-')}-light.png`) })
    console.log(`${route}: ${issues.length} contrast issues`)
  }

  await page.goto(`${base}/spatial`, { waitUntil: 'domcontentloaded' })
  const frame = page.frameLocator('iframe[title="Ally Spatial Intelligence workspace"]')
  await frame.getByText('Local API connected', { exact: true }).waitFor()
  const child = page.frames().find(item => item.url().includes('spatial-workspace.html'))
  await child.waitForFunction(() => document.documentElement.dataset.niwisTheme === 'light')
  await page.getByLabel('Colour theme').selectOption('navy')
  await child.waitForFunction(() => document.documentElement.dataset.niwisTheme === 'navy')
  await page.getByLabel('Colour theme').selectOption('light')
  await child.waitForFunction(() => document.documentElement.dataset.niwisTheme === 'light')
  checks.spatialThemeSync = true
  await page.screenshot({ path: join(output, 'spatial-light.png') })

  await page.goto(`${base}/drought`, { waitUntil: 'domcontentloaded' })
  await page.locator('.dm-chart .recharts-wrapper').first().waitFor()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(250)
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false)
  await page.getByLabel('Colour theme').selectOption('navy')
  assert.equal(await page.evaluate(() => document.documentElement.dataset.niwisTheme), 'navy')
  await page.getByLabel('Colour theme').selectOption('light')
  await page.screenshot({ path: join(output, 'drought-light-mobile.png') })
  checks.mobileToggleAndLayout = true
  assert.deepEqual(errors, [])
  await writeFile(join(output, 'verification.json'), JSON.stringify({ base, checks, errors }, null, 2))
  console.log(JSON.stringify({ savedPreference: checks.savedPreference, spatialThemeSync: checks.spatialThemeSync, mobileToggleAndLayout: checks.mobileToggleAndLayout, droughtContrastIssues: checks.droughtContrast.length, dashboards: checks.dashboards.map(item => ({ route: item.route, contrastIssues: item.issues.length })), errors, output }, null, 2))
} catch (error) {
  await page.screenshot({ path: join(output, 'failure.png'), fullPage: true }).catch(() => {})
  await writeFile(join(output, 'failure.json'), JSON.stringify({ checks, errors, message: error.message }, null, 2))
  throw error
} finally {
  await browser.close()
}
