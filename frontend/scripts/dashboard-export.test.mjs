import test from 'node:test'
import assert from 'node:assert/strict'
import { buildExportCsv, exportDate, exportDateBound, filterExportRows, hasExportValues, normalizeExportMetrics } from '../src/lib/dashboardExport.js'
import { objectivesExportRows, quantityExportRows, servicesExportRows, tariffExportRows } from '../src/lib/dashboardExportAdapters.js'

test('date validation rejects impossible calendar dates and supports leap days', () => {
  assert.equal(exportDate('2025-02-29'), '')
  assert.equal(exportDate('2024-02-29'), '2024-02-29')
  assert.equal(exportDate('2026-13-01'), '')
  assert.equal(exportDate('not a date'), '')
  assert.equal(exportDate('2026'), '2026-01-01')
  assert.equal(exportDateBound('2024-02', 'month', true), '2024-02-29')
  assert.equal(exportDateBound(2026, 'year', true), '2026-12-31')
})

test('daily exports include both date boundaries and exclude outside records', () => {
  const source = [{ date: '2025-12-31' }, { date: '2026-01-03' }, { date: '2026-01-01' }, { date: '2026-01-02' }, { date: null }]
  const rows = filterExportRows(source, { dateField: 'date', granularity: 'day', start: '2026-01-01', end: '2026-01-02' })
  assert.deepEqual(rows.map(row => row.date), ['2026-01-01', '2026-01-02'])
  assert.equal(source[1].date, '2026-01-03', 'source order must remain unchanged')
})

test('monthly and annual exports retain whole reporting periods', () => {
  assert.deepEqual(filterExportRows([{ month: '2026-01' }, { month: '2026-02' }, { month: '2026-03' }], {
    dateField: 'month', granularity: 'month', start: '2026-01-15', end: '2026-02-10',
  }).map(row => row.month), ['2026-01', '2026-02'])
  assert.equal(filterExportRows([{ year: 2024 }, { year: 2025 }], {
    dateField: 'year', granularity: 'year', start: '2024-08-12', end: '2024-09-01',
  }).length, 1)
})

test('invalid or reversed ranges never export an unintended full history', () => {
  const rows = [{ date: '2026-01-01', value: 1 }]
  for (const [start, end] of [['', '2026-01-01'], ['2026-02-01', '2026-01-01'], ['2026-02-31', '2026-03-01']]) {
    assert.deepEqual(filterExportRows(rows, { dateField: 'date', granularity: 'day', start, end }), [])
  }
  assert.deepEqual(filterExportRows([{ year: 2026 }], { dateField: 'year', granularity: 'year', start: '2026-08-01', end: '2026-01-01' }), [])
})

test('CSV contains only selected variables and preserves missing, zero and signed values', () => {
  const csv = buildExportCsv({ dateField: 'date', context: { Region: 'Alfred Nzo' },
    metrics: [{ key: 'spi', label: 'SPI-3', unit: 'index' }, { key: 'rain', label: 'Rainfall', unit: 'mm' }],
    rows: [{ date: '2026-01-01', spi: '-0.31', rain: 0, excluded: 999 }, { date: '2026-02-01', spi: null, rain: 2.5, excluded: 777 }],
  })
  assert.equal(csv, '\uFEFF"Region","Date","SPI-3 (index)","Rainfall (mm)"\r\n"Alfred Nzo","2026-01-01","-0.31","0"\r\n"Alfred Nzo","2026-02-01","","2.5"')
  assert.ok(!csv.includes('excluded'))
  assert.ok(!csv.includes('999'))
})

test('CSV safely quotes text, commas, newlines and formulas without altering numeric strings', () => {
  const csv = buildExportCsv({ dateField: 'year', metrics: [{ key: 'value', label: 'Value' }],
    context: { Region: '=SUM(1,2)', Note: 'a,"b"\nnext' }, rows: [{ year: 2026, value: '-1.5e-3' }],
  })
  assert.ok(csv.includes('"\'=SUM(1,2)"'))
  assert.ok(csv.includes('"a,""b""\nnext"'))
  assert.ok(csv.endsWith('"-1.5e-3"'))
})

test('duplicate metric entries produce one selection and one CSV column', () => {
  assert.deepEqual(normalizeExportMetrics([{ key: 'vci', label: 'VCI', unit: '%' }, { key: 'vci' }, null]).map(item => item.key), ['vci'])
})

test('empty series are distinguished from valid zero measurements', () => {
  assert.equal(hasExportValues([{ rain: null }], [{ key: 'rain' }]), false)
  assert.equal(hasExportValues([{ rain: 0 }], [{ key: 'rain' }]), true)
  assert.equal(hasExportValues([{ indicator_key: 'rain', value: null }], [], 'indicator_key'), false)
  assert.equal(hasExportValues([{ indicator_key: 'rain', value: 0 }], [], 'indicator_key'), true)
})

test('transfer exports keep national balance measurements outside the transfers subtopic', () => {
  const payload = { region: 'Alfred Nzo', transfers: { monthly: [{ period: '2026-01', flow: 3 }] }, balance: { monthly: [{ period: '2026-01', flow: 999 }] } }
  const metadata = { transfer_indicators: [{ key: 'flow', label: 'Transfer flow', unit: 'm³/day' }], balance_indicators: [{ key: 'flow', label: 'Balance', unit: 'Mm³' }], audits: { transfers: { table: 'transfers' }, balance: { table: 'national_balance' } } }
  const rows = quantityExportRows(payload, metadata, 'transfers')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].value, 3)
  assert.equal(rows[0].scope, 'Alfred Nzo')
  assert.equal(rows[0].source_table, 'transfers')
  const selected = filterExportRows(quantityExportRows(payload, metadata), { dateField: 'period', granularity: 'month', start: '2026-01-01', end: '2026-01-31', rowMetricField: 'indicator_key', selectedKeys: ['balance:flow'] })
  assert.equal(selected.length, 1)
  assert.equal(selected[0].scope, 'National')
  assert.equal(selected[0].unit, 'Mm³')
})

test('service exports retain reporting labels, usable-region counts and provenance', () => {
  const rows = servicesExportRows({ series: [{ year: 2026, source_periods: '2025/26', access: 0 }], coverage: [{ year: 2026, access: 4 }], table: 'water_access', aggregation: 'District mean' }, [{ key: 'access', label: 'Access', unit: '%', source_column: 'access_pct' }])
  assert.equal(rows[0].value, 0)
  assert.equal(rows[0].source_periods, '2025/26')
  assert.equal(rows[0].usable_regions, 4)
  assert.equal(rows[0].source_column, 'access_pct')
})

test('objectives and tariff exports preserve source targets and categorical observations', () => {
  const section = { key: 'ecological', indicators: [{ key: 'score', label: 'SASS5', unit: 'score', limit: 'Source target' }], audit: { table: 'ecological' } }
  const eco = objectivesExportRows({ sections: { ecological: { monthly: [{ period: '2026-01', score: -1 }] } } }, section, 'monthly')
  assert.equal(eco[0].source_target, 'Source target')
  assert.equal(eco[0].value, -1)
  const tariffs = tariffExportRows({ table: 'tariffs', indicators: [{ key: 'condition', label: 'Condition', unit: 'category', points: [{ year: 2026, value: 'D2', source_period: '2025/26' }] }] })
  assert.equal(tariffs[0].value, 'D2')
  assert.equal(tariffs[0].source_period, '2025/26')
})
