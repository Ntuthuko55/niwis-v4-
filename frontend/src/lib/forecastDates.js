export function normaliseForecastDate(value, frequency) {
  if (value == null || value === '') return ''
  const text = String(value)
  if (frequency === 'annual' && /^\d{4}$/.test(text)) return `${text}-12-31`
  if (/^\d{4}-\d{2}$/.test(text)) return `${text}-01`
  return text
}
