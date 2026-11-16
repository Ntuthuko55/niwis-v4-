import { dashboardFetch as fetch } from '../services/dashboardFetch'
import { useEffect, useMemo, useState } from 'react'
import Plot from './LazyPlot'
import { buildDistrictMapScale, buildStandardizedIndexScale, DistrictMap, normaliseDistrictName as normalise } from './DistrictMap'
import MonitoringMapPanel from './MonitoringMapPanel'
import LoadingProgress from './LoadingProgress'
import DashboardDataExport from './DashboardDataExport'
import DroughtIndicatorHelp from './DroughtIndicatorHelp'
import { DROUGHT_PERIODS, droughtIndicatorDetails, droughtIndicatorLabel } from '../lib/droughtIndicators'

const weatherMetrics = [
  ['daily_rainfall_mm_day', 'Daily rainfall', 'mm'], ['monthly_rainfall_mm_month', 'Monthly rainfall', 'mm'],
  ['rainfall_anomaly_pct', 'Rainfall anomaly', '%'], ['tavg_c', 'Mean temperature', '°C'],
  ['pet_mm_day', 'Potential evapotranspiration', 'mm/day'], ['relative_humidity_pct', 'Relative humidity', '%'],
]
const droughtMetrics = ['spi', 'spei'].flatMap(family => DROUGHT_PERIODS.map(months => {
  const key = `${family}_${months}`
  return [key, droughtIndicatorLabel(key), 'index']
}))
const metrics = [...droughtMetrics, ...weatherMetrics]
const exportMetrics = [
  ...metrics.map(([key, label, unit]) => ({ key, label, unit })),
  { key: 'seasonal_rainfall_mm_season', label: 'Seasonal rainfall', unit: 'mm/season' },
  { key: 'rainfall_anomaly_mm', label: 'Rainfall anomaly', unit: 'mm' },
  { key: 'rainfall_intensity_mm_h', label: 'Rainfall intensity', unit: 'mm/h' },
  { key: 'tmin_c', label: 'Minimum temperature', unit: '°C' },
  { key: 'tmax_c', label: 'Maximum temperature', unit: '°C' },
  { key: 'temp_anomaly_c', label: 'Temperature anomaly', unit: '°C' },
  { key: 'et0_mm_day', label: 'Reference evapotranspiration', unit: 'mm/day' },
  { key: 'solar_radiation_wm2', label: 'Solar radiation', unit: 'W/m²' },
  { key: 'wind_speed_2m_ms', label: 'Wind speed at 2 m', unit: 'm/s' },
]
async function read(url, signal) {
  const response = await fetch(url, { signal })
  const data = await response.json()
  if (!response.ok) throw new Error(data.detail || 'Unable to load meteorological observations.')
  return data
}

export default function MeteorologicalDrought({ renderForecast }) {
  const [districts, setDistricts] = useState([])
  const [rows, setRows] = useState([])
  const [mapRows, setMapRows] = useState([])
  const [selected, setSelected] = useState('')
  const [history, setHistory] = useState([])
  const [historyStartDate, setHistoryStartDate] = useState('')
  const [historyEndDate, setHistoryEndDate] = useState('')
  const [historyChartType, setHistoryChartType] = useState('line')
  const [metric, setMetric] = useState('spi_3')
  const [error, setError] = useState('')
  const [historyError, setHistoryError] = useState('')
  const [loading, setLoading] = useState(true)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [mapDate, setMapDate] = useState('')
  const [mapLoading, setMapLoading] = useState(false)
  const [mapError, setMapError] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    Promise.all([read('/south_africa_adm2.display.geojson', controller.signal), read('/api/meteorological/regions', controller.signal)])
      .then(([geo, data]) => {
        setDistricts(geo.features || [])
        setRows(data.regions || [])
        setMapRows(data.regions || [])
        setSelected(data.regions?.[0]?.district_name || '')
        setMapDate(data.regions?.[0]?.date || '')
      }).catch((e) => { if (e.name !== 'AbortError') setError(e.message) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [])
  const values = useMemo(() => Object.fromEntries(mapRows.map((r) => [normalise(r.district_name), r])), [mapRows])
  const current = mapError || mapLoading ? undefined : values[normalise(selected)]
  const region = rows.find(row => normalise(row.district_name) === normalise(selected))?.district_name || selected
  const mapDates = useMemo(() => [...new Set(history.map(row => String(row.date || '').slice(0, 10)))].filter(Boolean).sort(), [history])
  const orderedHistory = useMemo(() => history
    .map(row => ({ ...row, chartDate: String(row.date || '').slice(0, 10) }))
    .filter(row => /^\d{4}-\d{2}-\d{2}$/.test(row.chartDate))
    .sort((left, right) => left.chartDate.localeCompare(right.chartDate)), [history])
  const historyDateBounds = {
    min: orderedHistory[0]?.chartDate || '',
    max: orderedHistory.at(-1)?.chartDate || '',
  }
  const visibleHistory = useMemo(() => orderedHistory.filter(row =>
    (!historyStartDate || row.chartDate >= historyStartDate)
    && (!historyEndDate || row.chartDate <= historyEndDate)), [orderedHistory, historyStartDate, historyEndDate])
  const historyChartData = useMemo(() => [{
    x: visibleHistory.map(row => row.chartDate),
    y: visibleHistory.map(row => {
      if (row[metric] == null || row[metric] === '') return null
      const value = Number(row[metric])
      return Number.isFinite(value) ? value : null
    }),
    type: historyChartType === 'bar' ? 'bar' : 'scatter',
    ...(historyChartType === 'bar' ? { marker: { color: '#64c968' } } : { mode: 'lines', connectgaps: false, line: { color: '#64c968' } }),
    name: metrics.find(([key]) => key === metric)?.[1] || metric,
  }], [visibleHistory, metric, historyChartType])
  useEffect(() => {
    if (!mapDate) return undefined
    const controller = new AbortController()
    setMapLoading(true); setMapError('')
    read(`/api/meteorological/regions?date=${encodeURIComponent(mapDate)}`, controller.signal)
      .then(data => { if (!controller.signal.aborted) setMapRows(data.regions || []) })
      .catch(e => { if (!controller.signal.aborted) setMapError(e.message) })
      .finally(() => { if (!controller.signal.aborted) setMapLoading(false) })
    return () => controller.abort()
  }, [mapDate])
  useEffect(() => {
    setHistory([])
    setHistoryStartDate('')
    setHistoryEndDate('')
    setHistoryError('')
    if (!region) { setHistoryLoading(false); return }
    const controller = new AbortController()
    setHistoryLoading(true)
    read(`/api/meteorological/history?region=${encodeURIComponent(region)}`, controller.signal)
      .then((data) => {
        const next = data.history || []
        const dates = next.map(row => String(row.date || '').slice(0, 10)).filter(date => /^\d{4}-\d{2}-\d{2}$/.test(date)).sort()
        setHistory(next)
        setHistoryStartDate(dates[0] || '')
        setHistoryEndDate(dates.at(-1) || '')
        if (dates.length && !dates.includes(mapDate)) setMapDate(dates.at(-1))
      })
      .catch((e) => { if (e.name !== 'AbortError') setHistoryError(e.message) })
      .finally(() => { if (!controller.signal.aborted) setHistoryLoading(false) })
    return () => controller.abort()
  }, [region])
  const label = metrics.find(([key]) => key === metric)
  const selectedIndex = droughtIndicatorDetails(metric)
  const detailMonths = selectedIndex?.months || 3
  const detailMetrics = [
    ...droughtMetrics.filter(([key]) => key === `spi_${detailMonths}` || key === `spei_${detailMonths}`),
    ...weatherMetrics,
  ]
  const mapScale = useMemo(() => /^(spi|spei)_/.test(metric)
    ? buildStandardizedIndexScale(selectedIndex.chartLabel)
    : buildDistrictMapScale(mapRows, metric, label[1], label[2], undefined, districts.length || 52), [mapRows, metric, label, districts.length])
  return <>
    <div className="nw-crumb">Situation / Meteorological drought</div>
    <h1 className="page">Meteorological drought</h1>
    <p className="nw-lede">Regional rainfall and drought observations. Select a region to inspect its measurements and history.</p>
    {loading && <LoadingProgress className="nw-forecast-loading" message="Loading meteorological regions" />}
    {error && <div className="nw-error" role="alert">{error}</div>}
    {!loading && !error && !rows.length && <p>No meteorological observations are available.</p>}
    {!rows.length && <MonitoringMapPanel title="Meteorological monitoring map" indicators={metrics.map(([key, title, unit]) => ({ key, label: title, unit }))} indicator={metric} onIndicatorChange={setMetric} features={districts} geographyAvailable={false} noDataReason={error || (loading ? 'Meteorological observations are loading.' : 'No meteorological observations are available.')} />}
    {!!rows.length && <>
      <div className="nw-overview-grid">
        <section className="nw-panel"><div className="nw-phead"><h3>Regional {label[1]}</h3><span className="src">Observations for {mapDate || rows[0]?.date}</span></div>


          {mapError && <p className="nw-error" role="alert">{mapError}</p>}{mapLoading && <LoadingProgress className="nw-map-loading" message="Loading map observations" />}<DistrictMap districts={districts} values={mapError || mapLoading ? {} : values} valueKey={metric} valueLabel={label[1]} valueUnit={label[2]} indicatorOptions={metrics.map(([key, title, unit]) => ({ key, label: title, unit }))} indicatorValue={metric} onIndicatorChange={setMetric} colorFn={mapScale.color} legend={mapScale.legend} selected={selected} onSelect={setSelected} />
          <p className="nw-note">Grey regions have no observation for the selected date.</p>
        </section>
        <section className="nw-panel"><div className="nw-phead"><h3>Region details</h3></div>
          <label>Region <select aria-label="Region" value={region || ''} onChange={(e) => setSelected(e.target.value)}><option value="" disabled>{selected || 'Select a region'}</option>{rows.map((r) => <option key={r.district_name} value={r.district_name}>{r.district_name}</option>)}</select></label>
          <p>{selected} · {current?.date || 'No observation for this region'}</p>
          <div className="nw-grid nw-g2">{detailMetrics.map(([key, title, unit]) => <article className="nw-kpi" key={key}><div className="lab">{title}</div><div className="val">{current?.[key] == null ? '—' : Number(current[key]).toFixed(2)}<small>{unit}</small></div></article>)}</div>
        </section>
        <section className="nw-panel nw-overview-forecast">
          <div className="nw-panel-header"><span>Forecast · {region || selected}</span><span className="nw-panel-link">LSTM default · user-selectable</span></div>
          {region ? renderForecast?.(region) : <p className="nw-note">Select a region with observations to load the forecasting studio.</p>}
        </section>
      </div>
      <section className="nw-panel nw-meteorological-history-panel" style={{ marginTop: 16 }}><div className="nw-phead"><h3>Observation history · {selected}</h3><span className="src">Supabase meteorological observations</span><DashboardDataExport
        rows={history}
        disabled={historyLoading || !!historyError}
        source={{ url: '/api/meteorological/history', params: { region }, queryPeriod: false, selectRows: payload => payload.history }}
        dateField="date"
        metrics={exportMetrics}
        context={{ Region: region }}
        filename={`NIWIS-meteorological-drought-${region || 'data'}`}
      /></div>
        <div className="nw-meteo-history-controls">
          <label htmlFor="nw-meteo-history-measurement">Measurement<select id="nw-meteo-history-measurement" aria-label="Meteorological history measurement" title={label[1]} value={metric} onChange={(e) => setMetric(e.target.value)}>{['spi', 'spei'].map(family => <optgroup key={family} label={family === 'spi' ? 'Rainfall drought indicators (SPI)' : 'Rainfall & evaporation drought indicators (SPEI)'}>{droughtMetrics.filter(([key]) => key.startsWith(`${family}_`)).map(([key, title]) => <option key={key} value={key}>{title}</option>)}</optgroup>)}<optgroup label="Weather observations">{weatherMetrics.map(([key, title]) => <option key={key} value={key}>{title}</option>)}</optgroup></select></label>
          <label htmlFor="nw-meteo-history-start">Start date<input id="nw-meteo-history-start" type="date" min={historyDateBounds.min || undefined} max={historyDateBounds.max || undefined} value={historyStartDate} disabled={historyLoading || !historyDateBounds.min} onChange={(e) => { const value = e.target.value; setHistoryStartDate(value); if (value && historyEndDate && value > historyEndDate) setHistoryEndDate(value) }} /></label>
          <label htmlFor="nw-meteo-history-end">End date<input id="nw-meteo-history-end" type="date" min={historyDateBounds.min || undefined} max={historyDateBounds.max || undefined} value={historyEndDate} disabled={historyLoading || !historyDateBounds.max} onChange={(e) => { const value = e.target.value; setHistoryEndDate(value); if (value && historyStartDate && value < historyStartDate) setHistoryStartDate(value) }} /></label>
          <label htmlFor="nw-meteo-history-chart-type">Chart type<select id="nw-meteo-history-chart-type" aria-label="Meteorological history chart type" value={historyChartType} onChange={(e) => setHistoryChartType(e.target.value)}><option value="line">Line graph</option><option value="bar">Bar graph</option></select></label>
        </div>
        <DroughtIndicatorHelp indicator={metric} />
        {historyLoading ? <LoadingProgress className="nw-map-loading" message="Loading region history" /> : historyError ? <p className="nw-error" role="alert">{historyError}</p> : !orderedHistory.length ? <p>No history available for this region.</p> : !visibleHistory.length ? <p className="nw-note" role="status">No observations fall within the selected date range.</p> : <Plot data={historyChartData} layout={{ height: 340, paper_bgcolor: 'transparent', plot_bgcolor: 'transparent', font: { color: '#93aebb' }, margin: { l: 65, r: 20, t: 25, b: 45 }, xaxis: { title: { text: 'Date' }, gridcolor: '#1B3A49', zerolinecolor: '#2A4E5E' }, yaxis: { title: { text: selectedIndex ? `${selectedIndex.code} (index)` : `${label[1]} ${label[2]}`, standoff: 8 }, automargin: true, gridcolor: '#1B3A49', zerolinecolor: '#7299af' }, autosize: true, bargap: 0.2 }} config={{ responsive: true, displayModeBar: false }} useResizeHandler style={{ width: '100%' }} />}
      </section>
    </>}
  </>
}
