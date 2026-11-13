// Series keep their existing colours in Navy. Light uses the same hues at a
// darker value so lines, legends, and tooltip values remain visible on white.
const colours = new Set([
  '39d7ef', '17669e', '2ecbff', '42d5e8', '688cff', '6ee6ae', '3fbcff',
  '79e2ad', 'ff9861', '53b7ff', 'a599ff', '52a5ff', '72dcbf', '3987c6',
  '168a82', 'df7850', 'c99331', '8063b9', '7cd957', '78b5cf', '8c7be0',
])
const resolved = new Map()

function normaliseHex(value) {
  if (typeof value !== 'string' || !/^#[\da-f]{3,4}$|^#[\da-f]{6}(?:[\da-f]{2})?$/i.test(value)) return null
  const hex = value.slice(1).toLowerCase()
  return hex.length <= 4 ? [...hex].map(character => character + character).join('') : hex
}

function rawColour(value) {
  if (typeof value !== 'string') return value
  const variable = value.match(/^var\(--niwis-chart-([\da-f]{6}(?:[\da-f]{2})?),/i)
  return variable ? `#${variable[1]}` : value
}

function luminance(rgb) {
  const linear = rgb.map(channel => {
    const value = channel / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722
}

/** A concrete colour, for chart libraries such as Plotly that reject CSS vars. */
export function resolveChartColor(value, theme = 'navy') {
  value = rawColour(value)
  const hex = normaliseHex(value)
  if (!hex || theme !== 'light') return value
  const key = `light:${hex}`
  if (resolved.has(key)) return resolved.get(key)
  const rgb = [0, 2, 4].map(index => Number.parseInt(hex.slice(index, index + 2), 16))
  if (1.05 / (luminance(rgb) + 0.05) >= 4.5) return value
  const navy = [23, 51, 77]
  let lower = 0
  let upper = 1
  let result = navy
  for (let index = 0; index < 14; index += 1) {
    const amount = (lower + upper) / 2
    const candidate = rgb.map((channel, i) => Math.round(navy[i] + (channel - navy[i]) * amount))
    if (1.05 / (luminance(candidate) + 0.05) >= 4.5) {
      result = candidate
      lower = amount
    } else upper = amount
  }
  const colour = `#${result.map(channel => channel.toString(16).padStart(2, '0')).join('')}${hex.slice(6)}`
  resolved.set(key, colour)
  return colour
}

/** Use the same variable for a series, its legend key, and its tooltip swatch. */
export function chartColor(value) {
  const hex = normaliseHex(value)
  if (!hex) return value
  colours.add(hex)
  const theme = typeof document === 'undefined' ? 'navy' : document.documentElement.dataset.niwisTheme
  return `var(--niwis-chart-${hex}, ${resolveChartColor(value, theme)})`
}

/** Apply when the theme changes; newly loaded series also have a themed fallback. */
export function chartColorVariables(theme) {
  return Object.fromEntries([...colours].map(hex => [`--niwis-chart-${hex}`, resolveChartColor(`#${hex}`, theme)]))
}
