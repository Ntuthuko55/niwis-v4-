import { droughtIndicatorLabel } from './droughtIndicators.js'

// Keep date filtering and CSV encoding shared across daily, monthly and yearly sources.
export function exportDate(value) {
  const text = String(value ?? '').trim()
  const match = text.match(/^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?(?:T.*)?$/)
  if (!match) return ''
  const year = Number(match[1]), month = Number(match[2] || 1), day = Number(match[3] || 1)
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return ''
  return `${match[1]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

export function exportPeriod(value, granularity) {
  const date = exportDate(value)
  return granularity === 'year' ? date.slice(0, 4) : granularity === 'month' ? date.slice(0, 7) : date
}

export function exportDateBound(value, granularity, end = false) {
  const date = exportDate(value)
  if (!date) return ''
  if (granularity === 'year') return `${date.slice(0, 4)}-${end ? '12-31' : '01-01'}`
  if (granularity === 'month') {
    const [year, month] = date.split('-').map(Number)
    return `${date.slice(0, 7)}-${end ? String(new Date(Date.UTC(year, month, 0)).getUTCDate()) : '01'}`
  }
  return date
}

export function normalizeExportMetrics(metrics) {
  const unique = new Map()
  for (const metric of metrics || []) {
    if (!metric) continue
    const item = typeof metric === 'string' ? { key: metric, label: metric } : metric
    if (item.key && !unique.has(String(item.key))) unique.set(String(item.key), { ...item, key: String(item.key), label: droughtIndicatorLabel(item.key, item.label || item.name), unit: item.unit || '' })
  }
  return [...unique.values()]
}

export function filterExportRows(rows, { dateField, granularity, start, end, rowMetricField = '', selectedKeys = [] }) {
  if (!exportDate(start) || !exportDate(end) || exportDate(start) > exportDate(end)) return []
  const first = exportPeriod(start, granularity), last = exportPeriod(end, granularity)
  if (!first || !last || first > last) return []
  const allowed = new Set(selectedKeys)
  return (rows || []).filter(row => {
    if (!row || typeof row !== 'object') return false
    const period = exportPeriod(row[dateField], granularity)
    return period && period >= first && period <= last && (!rowMetricField || allowed.has(String(row[rowMetricField])))
  }).sort((left, right) => String(left[dateField]).localeCompare(String(right[dateField])))
}

export function hasExportValues(rows, metrics, rowMetricField = '', valueField = 'value') {
  const hasValue = value => value != null && value !== '' && !(typeof value === 'number' && !Number.isFinite(value))
  return rows.some(row => rowMetricField ? hasValue(row[valueField]) : metrics.some(metric => hasValue(row[metric.key])))
}

function csvCell(value) {
  const text = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value)
  // Preserve signed numeric observations while escaping spreadsheet formulas in text.
  const numeric = /^\s*[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?\s*$/i.test(text)
  const safe = typeof value === 'string' && !numeric && /^[\s]*[=+@-]/.test(text) ? `'${text}` : text
  return `"${safe.replaceAll('"', '""')}"`
}

export function buildExportCsv({ rows, metrics, dateField, context = {}, extraFields = [], rowMetricField = '', valueField = 'value', unitField = 'unit', metricLabelField = 'indicator' }) {
  const contextEntries = Object.entries(context).filter(([, value]) => value != null && value !== '')
  const fields = extraFields.map(field => typeof field === 'string' ? { key: field, label: field } : field)
  const dateLabel = /year/i.test(dateField) ? 'Year' : /month|period/i.test(dateField) ? 'Month' : 'Date'
  const headers = [...contextEntries.map(([key]) => key), ...fields.map(field => field.label), dateLabel,
    ...(rowMetricField ? ['Indicator', 'Value', 'Unit'] : metrics.map(item => `${item.label}${item.unit ? ` (${item.unit})` : ''}`))]
  const data = rows.map(row => [...contextEntries.map(([, value]) => value), ...fields.map(field => row[field.key]), row[dateField],
    ...(rowMetricField ? [row[metricLabelField], row[valueField], row[unitField]] : metrics.map(item => row[item.key]))])
  return `\uFEFF${[headers, ...data].map(row => row.map(csvCell).join(',')).join('\r\n')}`
}

export function saveExportCsv(content, filename) {
  const safeName = String(filename || 'NIWIS-data').normalize('NFKD').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'NIWIS-data'
  const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8;' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `${safeName}.csv`
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
