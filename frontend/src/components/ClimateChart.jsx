import { useId, useState } from 'react'
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'

export const CLIMATE_COLORS = {
  Tmin_C: '#3987c6', Tavg_C: '#168a82', Tmax_C: '#df7850',
  Heat_Days: '#df7850', Heat_Duration: '#c99331', Frost_Days: '#3987c6',
  Temperature_Anomaly_C: '#df7850', LST_Day_C: '#df7850', LST_Night_C: '#3987c6',
  CWD_Days: '#168a82', CDD_Days: '#c99331', Rx1day_mm: '#3987c6', Rx5day_mm: '#168a82',
  R10mm_Days: '#3987c6', R20mm_Days: '#8063b9', MAP_mm: '#3987c6',
  Daily_ET0_mm: '#3987c6', Daily_PET_mm: '#8063b9', Daily_AET_mm: '#168a82',
  Daily_Pan_Evap_mm: '#c99331', Daily_VPD_kPa: '#8063b9', SPEI_Daily: '#168a82',
  Irrigation_Water_Demand_mm: '#168a82', Rainfall_Deficit_mm: '#c99331', CWR_mm_day: '#168a82',
  Soil_Moisture_Deficit_m3m3: '#c99331', Growing_Season_Temp_C: '#df7850',
  Irrigation_Return_Flow_mm: '#3987c6', MAR_m3_year: '#3987c6',
  Q90_LowFlow_m3_year: '#c99331', Q10_FloodFlow_m3_year: '#168a82',
}

const SHORT_LABELS = {
  Tmin_C: 'Minimum', Tavg_C: 'Mean', Tmax_C: 'Maximum',
  Daily_ET0_mm: 'Reference ET\u2080', Daily_PET_mm: 'Potential ET', Daily_AET_mm: 'Actual ET',
  MAR_m3_year: 'Mean annual runoff', Q90_LowFlow_m3_year: 'Q90 low flow', Q10_FloodFlow_m3_year: 'Q10 high flow',
  CWD_Days: 'Wet days (CWD)', CDD_Days: 'Dry days (CDD)',
  Irrigation_Water_Demand_mm: 'Irrigation demand', Rainfall_Deficit_mm: 'Rainfall deficit',
}

export function climateNumber(value, digits = 1) {
  if (value == null || !Number.isFinite(Number(value))) return '\u2014'
  const number = Number(Number(value).toFixed(digits))
  return (Object.is(number, -0) ? 0 : number).toLocaleString('en-ZA', { maximumFractionDigits: digits })
}

function tickNumber(value) {
  const magnitude = Math.abs(value)
  if (magnitude >= 1e9) return `${climateNumber(value / 1e9)}B`
  if (magnitude >= 1e6) return `${climateNumber(value / 1e6)}M`
  if (magnitude >= 1e3) return `${climateNumber(value / 1e3)}k`
  return climateNumber(value, magnitude > 0 && magnitude < 1 ? 3 : 1)
}

function ChartTooltip({ active, payload, label, metrics, xKey }) {
  if (!active || !payload?.length) return null
  return <div className="cl-chart-tooltip">
    <strong>{xKey === 'Year' ? `Year ${label}` : label}</strong>
    {payload.filter(item => item.value != null).map(item => {
      const metric = metrics.find(m => m.key === item.dataKey)
      return <div key={item.dataKey}><i style={{ background: item.color }} /><span>{SHORT_LABELS[item.dataKey] || item.name}</span><b>{climateNumber(item.value, metric?.unit === 'm\u00b3/m\u00b3' ? 4 : 2)} <small>{metric?.unit}</small></b></div>
    })}
  </div>
}

export default function ClimateChart({ data, metrics, bars = false, type, xKey = 'Year', height = 275, colors, signed = false, yDomain, yTickFormatter }) {
  const gradientId = useId().replace(/:/g, '')
  const [hidden, setHidden] = useState([])
  const validMetrics = metrics.filter(Boolean)
  // Monthly source responses use ``month`` while the legacy annual response
  // uses ``Year``. Infer the available index so a monthly series is never
  // rendered against an empty annual axis.
  const indexKey = xKey === 'Year' && data?.length && !data.some(row => row.Year != null)
    ? (data.some(row => row.month != null) ? 'month' : data.some(row => row.date != null) ? 'date' : xKey)
    : xKey
  const visible = validMetrics.filter(metric => !hidden.includes(metric.key))
  const chartType = type || (bars ? 'bar' : validMetrics.length === 1 ? 'area' : 'line')
  const Component = chartType === 'bar' ? BarChart : chartType === 'area' ? AreaChart : LineChart
  const hasData = data?.some(row => visible.some(metric => row[metric.key] != null && Number.isFinite(Number(row[metric.key]))))
  const signedScale = signed || visible.some(metric => /Anomaly|SPEI|Nino34/.test(metric.key))
  const units = [...new Set(visible.map(metric => metric.unit))].join(' / ')
  const colorFor = (metric, index) => colors?.[index % colors.length] || CLIMATE_COLORS[metric.key] || ['#3987c6', '#168a82', '#8063b9', '#c99331'][index % 4]

  return <div className="cl-chart-frame">
    <div className="cl-chart-meta"><span>{units}</span><span>{chartType === 'bar' ? (indexKey === 'month' ? 'Monthly comparison' : 'Yearly comparison') : 'Change over time'}</span></div>
    {!hasData ? <div className="cl-empty" style={{ minHeight: height }}>No observations for this selection.</div> :
      <div className="cl-chart" role="img" aria-label={`${visible.map(m => m.label).join(', ')} chart in ${units}`} style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <Component data={data} margin={{ top: 18, right: 16, left: 4, bottom: 16 }} accessibilityLayer>
            <defs>{validMetrics.map((metric, index) => <linearGradient key={metric.key} id={`${gradientId}-${metric.key}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={colorFor(metric, index)} stopOpacity={0.2} /><stop offset="100%" stopColor={colorFor(metric, index)} stopOpacity={0.015} /></linearGradient>)}</defs>
            <CartesianGrid stroke="#e8eef3" strokeDasharray="3 5" vertical={false} />
            <XAxis dataKey={indexKey} tick={{ fill: '#637c8e', fontSize: 11 }} tickLine={false} axisLine={{ stroke: '#d8e3eb' }} minTickGap={36} interval="preserveStartEnd" tickMargin={12} padding={{ left: 10, right: 10 }} label={{ value: indexKey === 'Year' ? 'Year' : indexKey, position: 'insideBottom', offset: -12, fill: '#637c8e', fontSize: 11 }} />
            <YAxis tick={{ fill: '#637c8e', fontSize: 11 }} tickFormatter={yTickFormatter || tickNumber} width={64} tickLine={false} axisLine={false} tickCount={5} tickMargin={8} domain={yDomain || (chartType === 'bar' && !signedScale ? [0, 'auto'] : ['auto', 'auto'])} />
            <Tooltip content={<ChartTooltip metrics={validMetrics} xKey={indexKey} />} cursor={chartType === 'bar' ? { fill: '#edf3f8', opacity: 0.65 } : { stroke: '#94aebf', strokeDasharray: '4 4' }} />
            {signedScale && <ReferenceLine y={0} stroke="#8ba2b3" strokeDasharray="4 4" />}
            {visible.map(metric => {
              const color = colorFor(metric, validMetrics.indexOf(metric))
              const common = { dataKey: metric.key, name: metric.label, isAnimationActive: false }
              if (chartType === 'bar') return <Bar key={metric.key} {...common} fill={color} radius={[4, 4, 0, 0]} maxBarSize={30}>{signedScale && visible.length === 1 && data.map((row, index) => <Cell key={index} fill={row[metric.key] < 0 ? '#c99331' : color} />)}</Bar>
              const line = { stroke: color, strokeWidth: 2.5, dot: data.length <= 12 ? { r: 3, fill: color, stroke: '#fff', strokeWidth: 1.5 } : false, activeDot: { r: 5, stroke: '#fff', strokeWidth: 2 }, connectNulls: false, type: 'linear' }
              return chartType === 'area' ? <Area key={metric.key} {...common} {...line} fill={`url(#${gradientId}-${metric.key})`} baseValue={signedScale ? 0 : 'dataMin'} /> : <Line key={metric.key} {...common} {...line} />
            })}
          </Component>
        </ResponsiveContainer>
      </div>}
    <div className="cl-chart-legend">{validMetrics.map((metric, index) => <button type="button" key={metric.key} aria-pressed={!hidden.includes(metric.key)} onClick={() => setHidden(current => current.includes(metric.key) ? current.filter(key => key !== metric.key) : visible.length > 1 ? [...current, metric.key] : current)}><i style={{ background: colorFor(metric, index) }} />{SHORT_LABELS[metric.key] || metric.label}</button>)}</div>
  </div>
}
