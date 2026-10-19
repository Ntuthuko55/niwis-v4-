import { useState } from 'react'
import { BarChart3, TrendingUp } from 'lucide-react'
import ClimateChart, { CLIMATE_COLORS, climateNumber } from './ClimateChart'

const PRESENTATIONS = {
  temperature: {
    title: 'Temperature over time', description: 'Compare minimum, mean and maximum temperature across the selected years.',
    lead: ['Tmax_C', 'Tavg_C', 'Tmin_C'], type: 'line',
    cards: ['Tavg_C', 'Temperature_Anomaly_C', 'Heat_Days', 'Frost_Days'],
    groups: [
      { title: 'Heat and frost', description: 'Observed days and the longest observed heat spell.', type: 'bar', choices: [['Heat_Days', 'Heat days'], ['Heat_Duration', 'Heat duration'], ['Frost_Days', 'Frost days']] },
      { title: 'Temperature anomaly', description: 'Reported departure from the source baseline.', type: 'bar', signed: true, keys: ['Temperature_Anomaly_C'] },
      { title: 'Land surface temperature', description: 'Daytime and nighttime satellite surface temperature.', keys: ['LST_Day_C', 'LST_Night_C'], type: 'line' },
    ],
  },
  spells: {
    title: 'Wet and dry spells', description: 'Compare the longest reported wet and dry runs in each year.',
    lead: ['CWD_Days', 'CDD_Days'], type: 'bar',
    cards: ['CWD_Days', 'CDD_Days', 'Rx1day_mm', 'SDII_mm_per_wet_day'],
    groups: [
      { title: 'Rainfall extremes', description: 'Maximum rainfall over one day and five consecutive days.', keys: ['Rx1day_mm', 'Rx5day_mm'], type: 'bar' },
      { title: 'Heavy rainfall days', description: 'Annual days meeting the 10 mm and 20 mm thresholds.', keys: ['R10mm_Days', 'R20mm_Days'], type: 'bar' },
      { title: 'Wet-day rainfall', description: 'Explore annual wet-day precipitation and daily intensity.', choices: [['PRCPTOT_mm', 'Wet-day total'], ['SDII_mm_per_wet_day', 'Daily intensity']] },
    ],
  },
  rainfall: {
    title: 'Annual rainfall over time', description: 'Follow reported annual precipitation for the selected region.',
    lead: ['MAP_mm'], type: 'bar', cards: ['MAP_mm', 'Precip_DJF_mm', 'Precip_JJA_mm', 'Nino34_Annual_Mean'],
    groups: [
      { title: 'ENSO index', description: 'Reported annual Ni\u00f1o 3.4 values, shown in their own temperature scale.', keys: ['Nino34_Annual_Mean'], signed: true, type: 'bar' },
    ],
  },
  evaporation: {
    title: 'Evapotranspiration over time', description: 'Compare reference, potential and actual evapotranspiration in mm/day.',
    lead: ['Daily_ET0_mm', 'Daily_PET_mm', 'Daily_AET_mm'], type: 'line',
    cards: ['Daily_ET0_mm', 'Daily_PET_mm', 'Daily_VPD_kPa', 'SPEI_Daily'],
    groups: [
      { title: 'Pan evaporation', description: 'Mean daily Class A pan evaporation in each selected year.', keys: ['Daily_Pan_Evap_mm'] },
      { title: 'Atmospheric dryness', description: 'Vapour pressure deficit on its own kPa scale.', keys: ['Daily_VPD_kPa'] },
      { title: 'Reported SPEI', description: 'Yearly mean of the supplied daily index; its accumulation window is unspecified.', keys: ['SPEI_Daily'], type: 'bar', signed: true },
    ],
  },
  irrigation: {
    title: 'Irrigation demand and rainfall deficit', description: 'Compare yearly totals over the days observed in the source.',
    lead: ['Irrigation_Water_Demand_mm', 'Rainfall_Deficit_mm'], type: 'bar',
    cards: ['Irrigation_Water_Demand_mm', 'CWR_mm_day', 'Soil_Moisture_Deficit_m3m3', 'Irrigation_Return_Flow_mm'],
    groups: [
      { title: 'Crop water requirement', description: 'Mean daily water requirement for the selected period.', keys: ['CWR_mm_day'] },
      { title: 'Soil moisture deficit', description: 'Volumetric moisture deficit, shown in the source unit.', keys: ['Soil_Moisture_Deficit_m3m3'] },
      { title: 'Growing season temperature', description: 'Mean temperature reported for the crop growth period.', keys: ['Growing_Season_Temp_C'] },
      { title: 'Irrigation return flow', description: 'Yearly return-flow totals over observed days.', keys: ['Irrigation_Return_Flow_mm'], type: 'bar' },
    ],
  },
  streamflow: {
    title: 'Annual runoff and flow thresholds', description: 'Compare runoff with Q90 and Q10 in the supplied annual volume units.',
    lead: ['MAR_m3_year', 'Q90_LowFlow_m3_year', 'Q10_FloodFlow_m3_year'], type: 'line',
    cards: ['MAR_m3_year', 'Streamflow_Anomaly_percent', 'Rainfall_Runoff_Ratio', 'Climate_Streamflow_Elasticity'],
    groups: [
      { title: 'Streamflow anomaly', description: 'Reported percentage departure from the long-term source mean.', keys: ['Streamflow_Anomaly_percent'], type: 'bar', signed: true },
      { title: 'Rainfall-runoff ratio', description: 'Runoff coefficient for the selected region.', keys: ['Rainfall_Runoff_Ratio'] },
      { title: 'Climate-streamflow elasticity', description: 'Reported sensitivity of streamflow to changes in rainfall.', keys: ['Climate_Streamflow_Elasticity'] },
    ],
  },
}

function Panel({ title, description, children, className = '' }) {
  return <section className={`cl-panel ${className}`}><div className="cl-panel-heading"><div><h2>{title}</h2><p>{description}</p></div></div>{children}</section>
}

function IndicatorPanel({ group, catalogue, data }) {
  const [active, setActive] = useState(group.choices?.[0][0])
  const metrics = (group.choices ? [active] : group.keys).map(key => catalogue[key]).filter(Boolean)
  return <Panel title={group.title} description={group.description}>
    {group.choices && <div className="cl-tabs" role="group" aria-label={`${group.title} indicators`}>{group.choices.map(([key, label]) => <button type="button" key={key} aria-pressed={active === key} onClick={() => setActive(key)}>{label}</button>)}</div>}
    <ClimateChart key={metrics.map(m => m.key).join('-')} data={data} metrics={metrics} type={group.type} signed={group.signed} />
  </Panel>
}

function SummaryCards({ keys, catalogue, summary }) {
  return <div className="cl-section-kpis">{keys.map(key => {
    const metric = catalogue[key]
    if (!metric) return null
    const value = summary[key]
    const volume = metric.unit === 'm\u00b3/year'
    return <div className="cl-section-kpi" key={key} style={{ '--indicator-color': CLIMATE_COLORS[key] || '#3987c6' }}><span>{metric.label}</span><strong>{climateNumber(volume && value != null ? value / 1e9 : value, metric.unit === 'm\u00b3/m\u00b3' ? 4 : 2)}<small>{volume ? 'billion m\u00b3/year' : metric.unit}</small></strong><p>Selected-period mean</p></div>
  })}</div>
}

export default function ClimateSectionCharts({ section, catalogue, result, monthlyResult, map }) {
  const config = PRESENTATIONS[section]
  const [chartType, setChartType] = useState(config.type)
  const monthlySections = new Set(['temperature', 'evaporation', 'irrigation'])
  const useMonthly = monthlySections.has(section) && monthlyResult?.series?.length
  const displayResult = useMonthly ? {
    ...result,
    ...monthlyResult,
    season: 'Monthly',
    summary: monthlyResult.summary || result.summary,
    warnings: result.warnings || [],
  } : result
  const stats = displayResult.rainfall_statistics || {}
  const leadMetrics = config.lead.map(key => catalogue[key]).filter(Boolean)
  const series = displayResult.series || []
  return <>
    <div className="cl-context"><span><strong>{displayResult.region === 'National' ? 'South Africa' : displayResult.region}</strong><span aria-hidden="true"> / </span>{displayResult.start} - {displayResult.end}<span aria-hidden="true"> / </span>{displayResult.season}</span><span>{displayResult.aggregation}</span></div>
    <SummaryCards keys={config.cards} catalogue={catalogue} summary={displayResult.summary} />
    <div className="cl-section-primary">
      <Panel title="District patterns" description="Selected-period mean. Click a district to explore." className="cl-map-panel cl-section-map">{map}</Panel>
      <Panel title={section === 'temperature' ? `Temperature trends of ${displayResult.region === 'National' ? 'South Africa' : displayResult.region}` : config.title} description={useMonthly ? config.description.replace('year', 'month') : config.description} className="cl-feature-chart">
        <div className="cl-chart-toolbar" role="group" aria-label="Main chart style"><button type="button" aria-pressed={chartType === 'line'} onClick={() => setChartType('line')}><TrendingUp size={14} /> Lines</button><button type="button" aria-pressed={chartType === 'bar'} onClick={() => setChartType('bar')}><BarChart3 size={14} /> Bars</button></div>
        <ClimateChart key={section} data={series} metrics={leadMetrics} type={chartType} height={330} />
      </Panel>
    </div>
    <div className="cl-section-details">
      {section === 'rainfall' && <Panel title="Rainfall by season" description="Compare the reported seasonal totals, averaged over the selected years."><ClimateChart data={['MAM', 'JJA', 'SON', 'DJF'].map(season => ({ Season: season, Rainfall: displayResult.summary[`Precip_${season}_mm`] }))} metrics={[{ key: 'Rainfall', label: 'Seasonal rainfall', unit: 'mm' }]} type="bar" xKey="Season" /></Panel>}
      {config.groups.map(group => <IndicatorPanel key={group.title} group={group} data={series} catalogue={catalogue} />)}
      {section === 'rainfall' && <Panel title="Rainfall variability and trend" description="Statistics calculated for the selected years." className="cl-rainfall-statistics">
        <div className="cl-stat-strip"><span>Rainfall variability (CV)<strong>{climateNumber(stats.cv_percent)} <small>%</small></strong></span><span>Sen's slope<strong>{climateNumber(stats.sens_slope, 2)} <small>mm/year</small></strong></span><span>Kendall trend p-value<strong>{climateNumber(stats.kendall_p, 3)}</strong></span><span>ENSO-rainfall correlation<strong>{climateNumber(stats.enso_r, 3)}</strong></span></div>
        <p>ENSO correlation uses {stats.enso_pairs} paired annual observations. National values are equal-weight district means.</p>
      </Panel>}
    </div>
  </>
}
