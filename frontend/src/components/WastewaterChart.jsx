import { useId, useMemo } from 'react'
import {
  Area,
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

const PALETTE = ['#54d9cb', '#7cb7ff', '#f3bc72', '#bca0ff', '#ff98b0']

// An absent measurement must stay absent, including blank strings from a source.
const finiteNumber = value => {
  if (value == null || typeof value === 'boolean') return null
  if (typeof value !== 'number' && typeof value !== 'string') return null
  if (typeof value === 'string' && !value.trim()) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

const formatValue = value => {
  const parsed = finiteNumber(value)
  if (parsed == null) return '\u2014'
  const magnitude = Math.abs(parsed)
  const digits = magnitude > 0 && magnitude < 1 ? Math.min(8, 2 - Math.floor(Math.log10(magnitude))) : 2
  return parsed.toLocaleString('en-ZA', { maximumFractionDigits: digits })
}

export function formatWastewaterTick(value, domain, tickCount = 5) {
  const parsed = finiteNumber(value)
  if (parsed == null) return ''
  const span = Math.abs(domain[1] - domain[0])
  const step = span > 0 && Number.isFinite(span) ? span / Math.max(1, tickCount - 1) : Math.abs(parsed) * 0.08 || 1
  const magnitude = Math.abs(parsed)
  const notation = magnitude >= 10000 ? 'compact' : magnitude > 0 && magnitude < 0.0001 ? 'scientific' : 'standard'
  // Compact labels need the same precision after scaling as ordinary labels.
  // For example, a 50 m3/day tick interval becomes 0.05 in thousands.
  const divisor = notation === 'compact' ? 10 ** Math.min(12, Math.floor(Math.log10(magnitude) / 3) * 3) : 1
  const fractionDigits = notation === 'scientific'
    ? Math.max(0, Math.floor(Math.log10(magnitude)) - Math.floor(Math.log10(step)))
    : Math.max(0, Math.ceil(-Math.log10(step / divisor)))
  return parsed.toLocaleString('en-ZA', {
    notation,
    maximumFractionDigits: Math.min(20, fractionDigits),
  })
}

function ChartTooltip({ active, payload, label, metrics }) {
  if (!active) return null
  const values = (payload || []).filter(item => finiteNumber(item.value) != null)
  if (!values.length) return null

  return <div className="ww-chart-tooltip" style={{ background: '#102e43', border: '1px solid #3b6479', borderRadius: 10, padding: '10px 13px', boxShadow: '0 8px 24px #0005', color: '#ecf6ff', fontSize: 12 }}>
    <strong style={{ display: 'block', color: '#b8d1e1', marginBottom: 7 }}>{label}</strong>
    {values.map(item => {
      const metric = metrics.find(candidate => candidate.key === item.dataKey)
      return <div key={item.dataKey} style={{ display: 'flex', alignItems: 'center', gap: 9, marginTop: 5 }}>
        <span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: '50%', background: metric?.color || item.color, flexShrink: 0 }} />
        <span>{metric?.label || item.name}</span>
        <strong style={{ marginLeft: 'auto', paddingLeft: 10, whiteSpace: 'nowrap' }}>{formatValue(item.value)}{metric?.unit ? ` ${metric.unit}` : ''}</strong>
      </div>
    })}
  </div>
}

export default function WastewaterChart({ data, metrics, type = 'area', height = 260, xKey = 'year', yLabel, compact = false, referenceLine = null, referenceLines = [], referenceBand = null, horizontal = false }) {
  const chartId = `ww-chart-${useId().replace(/:/g, '')}`
  const prepared = useMemo(() => {
    const seen = new Set()
    const series = (metrics || []).filter(metric => {
      if (!metric?.key || seen.has(metric.key)) return false
      seen.add(metric.key)
      return true
    }).map((metric, index) => ({ ...metric, color: metric.color || PALETTE[index % PALETTE.length] }))
    const rows = (Array.isArray(data) ? data : []).filter(row => row && typeof row === 'object').map(row => {
      const next = { ...row }
      series.forEach(metric => { next[metric.key] = finiteNumber(row[metric.key]) })
      return next
    })
    const values = rows.flatMap(row => series.map(metric => row[metric.key])).filter(value => value != null)
    const populated = series.filter(metric => rows.some(row => row[metric.key] != null))
    return { rows, series: populated, values }
  }, [data, metrics])

  const lines = [referenceLine, ...(Array.isArray(referenceLines) ? referenceLines : [])].map(item => {
    const options = item !== null && typeof item === 'object' ? item : { value: item }
    return { value: finiteNumber(options.value ?? options.y), label: options.label, color: options.color || '#edc77d' }
  }).filter(item => item.value != null)
  const bandMin = finiteNumber(referenceBand?.min)
  const bandMax = finiteNumber(referenceBand?.max)
  const band = bandMin != null && bandMax != null && bandMin <= bandMax
    ? { min: bandMin, max: bandMax, label: referenceBand.label, color: referenceBand.color || '#54d9cb' }
    : null
  const chartType = horizontal || type === 'bar' ? 'bar' : type === 'area' && prepared.series.length === 1 ? 'area' : 'line'
  const domainValues = [...prepared.values, ...lines.map(item => item.value), ...[bandMin, bandMax].filter(value => value != null)]
  let lower = domainValues.length ? Math.min(...domainValues) : 0
  let upper = domainValues.length ? Math.max(...domainValues) : 1
  const padding = upper === lower ? Math.abs(upper) * 0.08 || 1 : (upper - lower) * 0.1
  if (chartType === 'bar') {
    lower = Math.min(0, lower < 0 ? lower - padding : lower)
    upper = Math.max(0, upper > 0 ? upper + padding : upper)
    if (lower === upper) upper = 1
  } else {
    const allNonNegative = lower >= 0
    lower -= padding
    upper += padding
    if (allNonNegative) lower = Math.max(0, lower)
  }

  const sharedUnits = [...new Set(prepared.series.map(metric => metric.unit || ''))]
  const axisLabel = yLabel || (sharedUnits.length === 1 ? sharedUnits[0] : '')
  const numericTickCount = compact && !horizontal ? 4 : 5
  const formatTick = value => formatWastewaterTick(value, [lower, upper], numericTickCount)
  const referenceDescription = [
    ...lines.map(item => `${item.label || 'Reference line'} at ${formatValue(item.value)}${axisLabel ? ` ${axisLabel}` : ''}.`),
    ...(band ? [`${band.label || 'Shaded reference range'} from ${formatValue(band.min)} to ${formatValue(band.max)}${axisLabel ? ` ${axisLabel}` : ''}.`] : []),
  ].join(' ')
  const accessibleLabel = `${prepared.series.map(metric => `${metric.label}${metric.unit ? ` (${metric.unit})` : ''}`).join(', ')} by ${xKey.replace(/_/g, ' ')}. ${prepared.rows.length} ${horizontal ? 'districts' : 'reporting periods'}. Missing observations appear as gaps.${referenceDescription ? ` ${referenceDescription}` : ''}`

  if (!prepared.values.length) {
    return <div className="ww-chart-empty" style={{ minHeight: height }} role="status">No observations for this selection.</div>
  }

  return <div className="ww-chart" role="img" aria-label={accessibleLabel} style={{ height, minWidth: 0 }}>
    <ResponsiveContainer width="100%" height="100%">
      <ComposedChart data={prepared.rows} layout={horizontal ? 'vertical' : 'horizontal'} margin={{ top: compact ? 12 : 20, right: 15, bottom: compact ? 0 : 5, left: axisLabel && !compact && !horizontal ? 8 : 0 }} accessibilityLayer>
        <defs>{prepared.series.map(metric => <linearGradient key={metric.key} id={`${chartId}-${metric.key.replace(/[^a-zA-Z0-9_-]/g, '-')}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={metric.color} stopOpacity={0.32} />
          <stop offset="100%" stopColor={metric.color} stopOpacity={0.015} />
        </linearGradient>)}</defs>
        {band && <ReferenceArea {...(horizontal ? { x1: band.min, x2: band.max } : { y1: band.min, y2: band.max })} fill={band.color} fillOpacity={0.07} stroke={band.color} strokeOpacity={0.16} label={band.label ? { value: band.label, fill: band.color, position: 'insideTopLeft', fontSize: 10 } : undefined} />}
        <CartesianGrid horizontal={!horizontal} vertical={horizontal} stroke="#315066" strokeOpacity={0.55} strokeDasharray="3 5" />
        {horizontal ? <>
          <XAxis type="number" domain={[lower, upper]} tickFormatter={formatTick} tickCount={numericTickCount} tick={{ fill: '#a7c3d5', fontSize: 10 }} tickLine={false} axisLine={false} tickMargin={9} height={axisLabel ? 48 : 30} label={axisLabel ? { value: axisLabel, position: 'insideBottom', fill: '#9fbed2', fontSize: 10, offset: 0 } : undefined} />
          <YAxis type="category" dataKey={xKey} width={105} tickFormatter={value => String(value).length > 18 ? `${String(value).slice(0, 17)}\u2026` : String(value)} tick={{ fill: '#bed3e2', fontSize: 10 }} tickLine={false} axisLine={false} interval={0} />
        </> : <>
          <XAxis dataKey={xKey} tick={{ fill: '#a7c3d5', fontSize: compact ? 10 : 11 }} tickLine={false} axisLine={{ stroke: '#36566c' }} minTickGap={compact ? 32 : 27} tickMargin={10} />
          <YAxis domain={[lower, upper]} allowDecimals tickCount={numericTickCount} tickFormatter={formatTick} tick={{ fill: '#a7c3d5', fontSize: compact ? 10 : 11 }} tickLine={false} axisLine={false} width={compact ? 48 : 64} label={axisLabel && !compact ? { value: axisLabel, angle: -90, position: 'insideLeft', fill: '#9fbed2', fontSize: 10, offset: -1 } : undefined} />
        </>}
        <Tooltip cursor={chartType === 'bar' ? { fill: '#81b5cd', fillOpacity: 0.08 } : { stroke: '#89aec6', strokeDasharray: '4 4' }} content={<ChartTooltip metrics={prepared.series} />} />
        {prepared.series.length > 1 && <Legend verticalAlign="bottom" iconType="circle" iconSize={7} wrapperStyle={{ color: '#d2e3ee', paddingTop: 15, fontSize: 11 }} formatter={value => <span style={{ color: '#d2e3ee', marginRight: 9 }}>{value}</span>} />}
        {lines.map((item, index) => <ReferenceLine key={`${item.value}-${index}`} {...(horizontal ? { x: item.value } : { y: item.value })} stroke={item.color} strokeDasharray="6 5" label={item.label ? { value: item.label, fill: item.color, position: 'insideTopRight', fontSize: 10 } : undefined} />)}
        {prepared.series.map((metric, index) => {
          const observationCount = prepared.rows.filter(row => row[metric.key] != null).length
          const common = { dataKey: metric.key, name: metric.label, isAnimationActive: false, connectNulls: false }
          const dots = observationCount <= 2 ? { r: 4, fill: metric.color, stroke: '#0b2235', strokeWidth: 2 } : props => {
            const previous = prepared.rows[props.index - 1]?.[metric.key]
            const next = prepared.rows[props.index + 1]?.[metric.key]
            if (finiteNumber(props.payload?.[metric.key]) == null || previous != null || next != null) return null
            return <circle key={props.index} cx={props.cx} cy={props.cy} r={3} fill={metric.color} stroke="#0b2235" strokeWidth={1.5} />
          }
          if (chartType === 'bar') return <Bar {...common} key={metric.key} fill={metric.color} fillOpacity={0.9} radius={horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0]} maxBarSize={compact ? 20 : 30} />
          if (chartType === 'area') return <Area {...common} key={metric.key} type="linear" stroke={metric.color} strokeWidth={2.5} fill={`url(#${chartId}-${metric.key.replace(/[^a-zA-Z0-9_-]/g, '-')})`} dot={dots} activeDot={{ r: 5, fill: metric.color, stroke: '#0b2235', strokeWidth: 2 }} />
          return <Line {...common} key={metric.key} type="linear" stroke={metric.color} strokeWidth={2.5} strokeDasharray={metric.dash || (index > 2 ? '5 3' : undefined)} dot={dots} activeDot={{ r: 5, fill: metric.color, stroke: '#0b2235', strokeWidth: 2 }} />
        })}
      </ComposedChart>
    </ResponsiveContainer>
  </div>
}

export function WastewaterSparkline({ data, metricKey, color = '#54d9cb', label, height = 44 }) {
  const gradientId = `ww-sparkline-${useId().replace(/:/g, '')}`
  const width = 180
  const inset = 4
  const values = (Array.isArray(data) ? data : []).map(row => finiteNumber(row?.[metricKey]))
  const present = values.filter(value => value != null)
  if (!present.length) return <div className="ww-sparkline ww-sparkline-empty" style={{ height }} aria-label={`${label || metricKey}: no observations`} />

  const low = Math.min(...present)
  const high = Math.max(...present)
  const scaleX = index => values.length === 1 ? width / 2 : inset + index / (values.length - 1) * (width - inset * 2)
  const scaleY = value => high === low ? height / 2 : height - inset - (value - low) / (high - low) * (height - inset * 2)
  const segments = []
  let segment = []
  values.forEach((value, index) => {
    if (value == null) {
      if (segment.length) segments.push(segment)
      segment = []
    } else segment.push([scaleX(index), scaleY(value)])
  })
  if (segment.length) segments.push(segment)
  const lastIndex = values.findLastIndex(value => value != null)
  const last = [scaleX(lastIndex), scaleY(values[lastIndex])]
  const description = `${label || metricKey} trend, ${present.length} observations. First ${formatValue(present[0])}, latest ${formatValue(present[present.length - 1])}. Missing observations appear as gaps.`

  return <svg className="ww-sparkline" viewBox={`0 0 ${width} ${height}`} width="100%" height={height} role="img" aria-label={description} preserveAspectRatio="none">
    <defs><linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={color} stopOpacity={0.24} /><stop offset="100%" stopColor={color} stopOpacity={0} /></linearGradient></defs>
    {segments.map((points, index) => {
      if (points.length === 1) return <circle key={index} cx={points[0][0]} cy={points[0][1]} r={2.5} fill={color} />
      const line = points.map(([x, y], pointIndex) => `${pointIndex ? 'L' : 'M'}${x},${y}`).join(' ')
      const area = `${line} L${points[points.length - 1][0]},${height} L${points[0][0]},${height} Z`
      return <g key={index}><path d={area} fill={`url(#${gradientId})`} /><path d={line} fill="none" stroke={color} strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" /></g>
    })}
    <circle cx={last[0]} cy={last[1]} r={3} fill={color} stroke="#0b2235" strokeWidth={1.5} />
  </svg>
}
