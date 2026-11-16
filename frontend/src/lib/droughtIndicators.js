// Display names describe accumulation periods; API requests keep native source keys.
export const DROUGHT_PERIODS = [1, 3, 6, 12, 24]

const PERIOD_HELP = {
  1: 'Shows recent changes in dry or wet conditions.',
  3: 'Shows conditions across a season, useful for crop and soil-moisture monitoring.',
  6: 'Shows persistent conditions across seasons.',
  12: 'Shows conditions across one year, useful for monitoring longer droughts and water availability.',
  24: 'Shows conditions across two years, useful for monitoring prolonged drought and pressure on water storage.',
}

export function droughtIndicatorDetails(key) {
  const match = String(key || '').match(/^(spi|spei)[ _-]?(\d+)(?:[ _-]?months?)?$/i)
  if (!match) return null
  const family = match[1].toUpperCase()
  const months = Number(match[2])
  if (!DROUGHT_PERIODS.includes(months)) return null
  const period = `${months} ${months === 1 ? 'month' : 'months'}`
  const code = `${family}-${months}`
  const name = family === 'SPI' ? 'Rainfall drought indicator' : 'Rainfall & evaporation drought indicator'
  return {
    family, months, period, code,
    label: `${name} — ${period} (${code})`,
    shortLabel: `${family === 'SPI' ? 'Rainfall drought' : 'Rainfall & evaporation drought'} (${period})`,
    chartLabel: `${code} · ${period}`,
    description: family === 'SPI'
      ? `SPI compares rainfall accumulated over ${period} with the usual rainfall for the same period.`
      : `SPEI describes the balance between rainfall and potential water loss through evaporation and plant use over ${period}.`,
    purpose: PERIOD_HELP[months],
  }
}

export function droughtIndicatorLabel(key, fallback) {
  return droughtIndicatorDetails(key)?.label || fallback || key
}

export function labelDroughtMetric(metric) {
  return { ...metric, label: droughtIndicatorLabel(metric.key, metric.label) }
}
