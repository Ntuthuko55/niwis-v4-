export const modelGroups = [
  {
    label: 'Auto / Single-variable',
    items: ['Auto', 'Naive', 'Historic Average', 'Window Average', 'Seasonal Naive', 'Prophet']
  },
  {
    label: 'Classical AR-family',
    items: ['AR(1)', 'MA(1)', 'ARMA(1,1)', 'ARIMA', 'SARIMA']
  },
  {
    label: 'Multivariate',
    items: ['VAR', 'VARMAX']
  },
  {
    label: 'State & Volatility',
    items: ['GARCH', 'State Space']
  },
  {
    label: 'Sequence / Deep',
    items: ['LSTM', 'Transformer']
  }
]

export const modelKey = (model) => {
  const normalized = String(model).toLowerCase()
  if (normalized === 'auto') return 'auto'
  if (normalized === 'historic average') return 'historicaverage'
  if (normalized === 'window average') return 'windowaverage'
  if (normalized === 'seasonal naive') return 'seasonalnaive'
  if (normalized === 'ar(1)') return 'ar'
  if (normalized === 'ma(1)') return 'ma'
  if (normalized === 'arma(1,1)') return 'arma'
  if (normalized === 'sarima') return 'sarima'
  if (normalized === 'var') return 'var'
  if (normalized === 'varmax') return 'varmax'
  if (normalized === 'garch') return 'garch'
  if (normalized === 'state space') return 'state_space'
  if (normalized === 'lstm') return 'lstm'
  if (normalized === 'transformer') return 'transformer'
  if (normalized === 'prophet') return 'prophet'
  return normalized.replace(/\s+/g, '')
}

export const requiresFeatureSelection = (value) => {
  const normalized = String(value).trim().toLowerCase()
  return ['var', 'varmax', 'garch', 'lstm', 'transformer', 'state space', 'state_space'].includes(normalized)
}

export const lstmDefaultFeatures = [
  'monthly_rainfall', 'monthly_tmean', 'monthly_pet',
  'monthly_relative_humidity', 'monthly_solar_radiation_mj_m2_day',
  'monthly_wind_speed_2m_m_s', 'rainfall_accumulation_3m',
  'water_balance_accumulation_3m',
]

export function preferredForecastTarget(columns = []) {
  return columns.find((column) => column === 'spi_3')
    || columns.find((column) => /spi[_ ]?3/i.test(column))
    || columns[0]
    || ''
}
