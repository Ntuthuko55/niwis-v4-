import test from 'node:test'
import assert from 'node:assert/strict'
import { DROUGHT_PERIODS, droughtIndicatorDetails, droughtIndicatorLabel, labelDroughtMetric } from '../src/lib/droughtIndicators.js'
import { buildExportCsv, normalizeExportMetrics } from '../src/lib/dashboardExport.js'

test('each supplied SPI and SPEI period has an explicit name and month count', () => {
  assert.deepEqual(DROUGHT_PERIODS, [1, 3, 6, 12, 24])
  for (const family of ['spi', 'spei']) for (const months of DROUGHT_PERIODS) {
    const item = droughtIndicatorDetails(`${family}_${months}`)
    assert.equal(item.months, months)
    assert.equal(item.family, family.toUpperCase())
    assert.ok(item.label.includes(`${months} ${months === 1 ? 'month' : 'months'}`))
    assert.ok(item.label.includes(`${family.toUpperCase()}-${months}`))
    assert.ok(item.label.includes('drought indicator'))
  }
})

test('source aliases show the same period across meteorological, rainfall and vegetation dashboards', () => {
  assert.equal(droughtIndicatorLabel('spi_12'), droughtIndicatorLabel('spi12'))
  assert.equal(droughtIndicatorLabel('spi_3'), droughtIndicatorLabel('SPI_3_month'))
  assert.equal(droughtIndicatorLabel('spei_6'), droughtIndicatorLabel('SPEI_6_month'))
  assert.equal(droughtIndicatorDetails('SPEI-24').months, 24)
})

test('unknown accumulation periods are never inferred from daily reporting frequency', () => {
  assert.equal(droughtIndicatorDetails('SPEI_Daily'), null)
  assert.equal(droughtIndicatorLabel('SPEI_Daily', 'Reported SPEI'), 'Reported SPEI')
  assert.equal(droughtIndicatorLabel('rainfall_mm', 'Rainfall'), 'Rainfall')
  assert.equal(droughtIndicatorDetails('spi_9'), null)
})

test('readable labels preserve API keys, units and subtopic metadata', () => {
  const source = { key: 'spi_24', label: 'SPI-24', unit: 'index', category: 'Weather', source_column: 'spi_24' }
  const labelled = labelDroughtMetric(source)
  assert.equal(labelled.key, 'spi_24')
  assert.equal(labelled.source_column, 'spi_24')
  assert.equal(labelled.unit, 'index')
  assert.equal(labelled.category, 'Weather')
  assert.equal(source.label, 'SPI-24')
})

test('CSV headers explain the selected index while exporting its original values', () => {
  const metrics = normalizeExportMetrics([{ key: 'spi_12', label: 'SPI-12', unit: 'index' }, { key: 'spei_24', label: 'SPEI-24', unit: 'index' }])
  const csv = buildExportCsv({ dateField: 'date', metrics, rows: [{ date: '2025-01-01', spi_12: -1.25, spei_24: 0, spi_3: 999 }] })
  assert.ok(csv.includes('12 months (SPI-12)'))
  assert.ok(csv.includes('24 months (SPEI-24)'))
  assert.ok(csv.endsWith('"2025-01-01","-1.25","0"'))
  assert.ok(!csv.includes('999'))
})
