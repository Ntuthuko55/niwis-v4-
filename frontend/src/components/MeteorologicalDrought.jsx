import { dashboardFetch as fetch } from '../services/dashboardFetch'
import { useEffect, useMemo, useState } from 'react'
import Plot from './LazyPlot'
import { DistrictMap, normaliseDistrictName as normalise } from './DistrictMap'
import LoadingProgress from './LoadingProgress'

const metrics = [
  ['spi_3', 'SPI-3', ''], ['spei_3', 'SPEI-3', ''],
  ['daily_rainfall_mm_day', 'Daily rainfall', 'mm'], ['monthly_rainfall_mm_month', 'Monthly rainfall', 'mm'],
  ['rainfall_anomaly_pct', 'Rainfall anomaly', '%'], ['tavg_c', 'Mean temperature', '°C'],
  ['pet_mm_day', 'Potential evapotranspiration', 'mm/day'], ['relative_humidity_pct', 'Relative humidity', '%'],
]
const color = (v) => v <= -2 ? '#f04444' : v <= -1.5 ? '#fa8c25' : v <= -1 ? '#f4dc45' : v <= 1 ? '#64c968' : '#2196c4'
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
  const current = values[normalise(selected)]
  const region = current?.district_name
  const mapDates = useMemo(() => [...new Set(history.map(row => String(row.date || '').slice(0, 10)))].filter(Boolean).sort(), [history])
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
    setHistoryError('')
    if (!region) { setHistoryLoading(false); return }
    const controller = new AbortController()
    setHistoryLoading(true)
    read(`/api/meteorological/history?region=${encodeURIComponent(region)}`, controller.signal)
      .then((data) => { const next = data.history || []; setHistory(next); const dates = next.map(row => String(row.date || '').slice(0, 10)).filter(Boolean).sort(); if (dates.length && !dates.includes(mapDate)) setMapDate(dates.at(-1)) })
      .catch((e) => { if (e.name !== 'AbortError') setHistoryError(e.message) })
      .finally(() => { if (!controller.signal.aborted) setHistoryLoading(false) })
    return () => controller.abort()
  }, [region])
  const label = metrics.find(([key]) => key === metric)
  return <>
    <div className="nw-crumb">Situation / Meteorological drought</div>
    <h1 className="page">Meteorological drought</h1>
    <p className="nw-lede">Regional rainfall and drought observations. Select a region to inspect its measurements and history.</p>
    {loading && <LoadingProgress className="nw-forecast-loading" message="Loading meteorological regions" />}
    {error && <div className="nw-error" role="alert">{error}</div>}
    {!loading && !error && !rows.length && <p>No meteorological observations are available.</p>}
    {!!rows.length && <>
      <div className="nw-overview-grid">
        <section className="nw-panel"><div className="nw-phead"><h3>Regional SPI-3</h3><span className="src">Observations for {mapDate || rows[0]?.date}</span></div>
          <label>Map date <select aria-label="Meteorological map date" value={mapDate} onChange={event => setMapDate(event.target.value)}>{(mapDates.length ? mapDates : [mapDate]).filter(Boolean).map(date => <option key={date}>{date}</option>)}</select></label>
          {mapError ? <p className="nw-error" role="alert">{mapError}</p> : mapLoading ? <LoadingProgress className="nw-map-loading" message="Loading map observations" /> : <DistrictMap districts={districts} values={values} valueKey="spi_3" colorFn={color} selected={selected} onSelect={setSelected} />}
          <p className="nw-note">Grey regions have no observation for the selected date.</p>
        </section>
        <section className="nw-panel"><div className="nw-phead"><h3>Region details</h3></div>
          <label>Region <select aria-label="Region" value={region || ''} onChange={(e) => setSelected(e.target.value)}><option value="" disabled>{selected || 'Select a region'}</option>{rows.map((r) => <option key={r.district_name} value={r.district_name}>{r.district_name}</option>)}</select></label>
          <p>{selected} · {current?.date || 'No observation for this region'}</p>
          <div className="nw-grid nw-g2">{metrics.map(([key, title, unit]) => <article className="nw-kpi" key={key}><div className="lab">{title}</div><div className="val">{current?.[key] == null ? '—' : Number(current[key]).toFixed(2)}<small>{unit}</small></div></article>)}</div>
        </section>
        <section className="nw-panel nw-overview-forecast">
          <div className="nw-panel-header"><span>Forecast · {region || selected} (SPI-3)</span><span className="nw-panel-link">LSTM default · user-selectable</span></div>
          {region ? renderForecast?.(region) : <p className="nw-note">Select a region with observations to load the forecasting studio.</p>}
        </section>
      </div>
      <section className="nw-panel" style={{ marginTop: 16 }}><div className="nw-phead"><h3>Observation history · {selected}</h3><span className="src">Supabase meteorological observations</span></div>
        <label>Measurement <select value={metric} onChange={(e) => setMetric(e.target.value)}>{metrics.map(([key, title]) => <option key={key} value={key}>{title}</option>)}</select></label>
        {historyLoading ? <LoadingProgress className="nw-map-loading" message="Loading region history" /> : historyError ? <p className="nw-error" role="alert">{historyError}</p> : history.length ? <Plot data={[{ x: history.map((r) => r.date), y: history.map((r) => r[metric]), type: 'scatter', mode: 'lines', name: label[1], connectgaps: false, line: { color: '#64c968' } }]} layout={{ height: 340, paper_bgcolor: 'transparent', plot_bgcolor: 'transparent', font: { color: '#93aebb' }, margin: { l: 65, r: 20, t: 25, b: 45 }, xaxis: { title: 'Date' }, yaxis: { title: `${label[1]} ${label[2]}` }, autosize: true }} config={{ responsive: true, displayModeBar: false }} useResizeHandler style={{ width: '100%' }} /> : <p>No history available for this region.</p>}
      </section>
    </>}
  </>
}
