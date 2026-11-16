// Keep source identity and units on each observation when a module has multiple datasets.
export function quantityExportRows(payload, metadata, section) {
  if (!payload || !metadata) return []
  return [
    ...(section === 'balance' ? [] : payload.transfers.monthly.flatMap(row => metadata.transfer_indicators.map(metric => ({
      period: row.period, dataset: 'Transfers', scope: payload.region === 'National' ? 'Source district mean' : payload.region,
      indicator_key: `transfer:${metric.key}`, indicator: metric.label, value: row[metric.key], unit: metric.unit,
      source_table: metadata.audits.transfers.table,
    })))),
    ...(section === 'transfers' ? [] : payload.balance.monthly.flatMap(row => metadata.balance_indicators.map(metric => ({
      period: row.period, dataset: 'National balance', scope: 'National',
      indicator_key: `balance:${metric.key}`, indicator: metric.label, value: row[metric.key], unit: metric.unit,
      source_table: metadata.audits.balance.table,
    })))),
  ]
}

export function servicesExportRows(payload, metrics) {
  if (!payload) return []
  const coverage = new Map((payload.coverage || []).map(row => [row.year, row]))
  return (payload.series || []).flatMap(row => metrics.map(metric => ({
    year: row.year, source_periods: row.source_periods, indicator_key: metric.key,
    indicator: metric.label, value: row[metric.key], unit: metric.unit,
    usable_regions: coverage.get(row.year)?.[metric.key], source_table: payload.table,
    source_column: metric.source_column, aggregation: payload.aggregation,
  })))
}

export function objectivesExportRows(payload, section, cadence) {
  if (!payload || !section) return []
  const data = payload.sections[section.key]
  return (cadence === 'annual' ? data.series : data.monthly).flatMap(row => section.indicators.map(metric => ({
    year: row.year, period: row.period, indicator_key: metric.key, indicator: metric.label,
    value: row[metric.key], unit: metric.unit, source_target: metric.limit,
    source_table: section.audit.table,
  })))
}

export function tariffExportRows(payload) {
  if (!payload) return []
  return (payload.indicators || []).flatMap(metric => metric.points.map(point => ({
    year: point.year, source_period: point.source_period, indicator_key: metric.key,
    indicator: metric.label, value: point.value, unit: metric.unit,
    source_table: payload.table, source_column: metric.source_column,
  })))
}
