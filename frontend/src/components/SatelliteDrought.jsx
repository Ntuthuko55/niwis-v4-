import { dashboardFetch as fetch } from '../services/dashboardFetch'
import { useEffect, useMemo, useState } from 'react'
import { DistrictMap, normaliseDistrictName } from './DistrictMap'
import { LineChart } from '../niwis/svgCharts'
import LoadingProgress from './LoadingProgress'

const fields = [
  ['NDVI', 'NDVI', '', 2], ['VCI', 'VCI', '%', 1], ['VHI', 'VHI', '%', 1],
  ['TCI', 'TCI', '%', 1], ['LST', 'Land surface temperature', '°C', 1],
  ['surface_soil_moisture', 'Surface soil moisture', 'm³/m³', 3],
  ['rootzone_soil_moisture', 'Root-zone moisture', 'm³/m³', 3], ['NDWI', 'NDWI', '', 2],
  ['surface_water_extent_km2', 'Surface water extent', 'km²', 2], ['GRACE_TWS', 'GRACE anomaly', 'cm', 2],
]
const valid = (value) => value != null && Number.isFinite(Number(value))
const display = (value, precision = 2) => valid(value) ? Number(value).toFixed(precision) : 'No data'
const colors = {
  NDVI: (v) => v < .28 ? '#f04444' : v < .36 ? '#fa8c25' : v < .43 ? '#f4dc45' : '#64c968',
  moisture: (v) => v < .08 ? '#f6ad3c' : v < .13 ? '#75d36a' : v < .19 ? '#4dc7c7' : '#2d97c7',
  water: (v) => v < 10 ? '#1d3441' : v < 45 ? '#226f92' : v < 120 ? '#25aac9' : '#7be3ed',
  grace: (v) => v < -4 ? '#e9474e' : v < -1 ? '#fa9037' : v < 2 ? '#f5df4b' : v < 5 ? '#62c977' : '#3fa6d5',
}
function Panel({ title, children }) {
  return <section className="nw-panel"><div className="nw-phead"><h3>{title}</h3><span className="src">Supabase satellite observations</span></div>{children}</section>
}
async function read(url, signal) {
  const response = await fetch(url, { signal })
  const payload = await response.json()
  if (!response.ok) throw new Error(payload.detail || 'Unable to read satellite observations from the database.')
  return payload
}

export default function SatelliteDrought() {
  const [districts, setDistricts] = useState([])
  const [stations, setStations] = useState([])
  const [mapStations, setMapStations] = useState([])
  const [selected, setSelected] = useState('')
  const [history, setHistory] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [historyError, setHistoryError] = useState('')
  const [historyLoading, setHistoryLoading] = useState(false)
  const [months, setMonths] = useState(12)
  const [mapDate, setMapDate] = useState('')
  const [mapLoading, setMapLoading] = useState(false)
  const [mapError, setMapError] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    Promise.all([read('/south_africa_adm2.display.geojson', controller.signal), read('/api/satellite/stations', controller.signal)])
      .then(([geo, payload]) => {
        setDistricts(geo.features || [])
        setStations(payload.stations || [])
        setMapStations(payload.stations || [])
        setSelected(payload.stations?.[0]?.name || '')
        setMapDate(payload.stations?.[0]?.date || '')
      }).catch((e) => { if (!controller.signal.aborted) setError(e.message) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [])
  const values = useMemo(() => Object.fromEntries(mapStations.map((row) => [normaliseDistrictName(row.name), row])), [mapStations])
  const actual = values[normaliseDistrictName(selected)] || {}
  const mapDates = useMemo(() => [...new Set(history.map(row => String(row.date || '').slice(0, 10)))].filter(Boolean).sort(), [history])
  useEffect(() => {
    if (!mapDate) return undefined
    const controller = new AbortController()
    setMapLoading(true); setMapError('')
    read(`/api/satellite/stations?date=${encodeURIComponent(mapDate)}`, controller.signal)
      .then(payload => { if (!controller.signal.aborted) setMapStations(payload.stations || []) })
      .catch(e => { if (!controller.signal.aborted) setMapError(e.message) })
      .finally(() => { if (!controller.signal.aborted) setMapLoading(false) })
    return () => controller.abort()
  }, [mapDate])
  useEffect(() => {
    setHistory([])
    setHistoryError('')
    if (!selected) return
    const controller = new AbortController()
    setHistoryLoading(true)
    read(`/api/satellite/history?district=${encodeURIComponent(selected)}`, controller.signal)
      .then((payload) => { const next = payload.history || []; setHistory(next); const dates = next.map(row => String(row.date || '').slice(0, 10)).filter(Boolean).sort(); if (dates.length && !dates.includes(mapDate)) setMapDate(dates.at(-1)) })
      .catch((e) => { if (!controller.signal.aborted) setHistoryError(e.message) })
      .finally(() => { if (!controller.signal.aborted) setHistoryLoading(false) })
    return () => controller.abort()
  }, [selected])
  const points = history.slice(-months)
  const numeric = history.map((row) => row.NDVI).filter(valid).map(Number)
  const mean = numeric.length ? numeric.reduce((a, b) => a + b, 0) / numeric.length : null
  const chartPoints = points.filter((row) => valid(row.NDVI))
  const map = (field, color) => <DistrictMap districts={districts} values={values} valueKey={field} colorFn={color} selected={selected} onSelect={setSelected} />
  return <>
    <div className="nw-crumb">Situation / Satellite &amp; Remote Sensing Drought</div>
    <h1 className="page">Satellite &amp; Remote Sensing Drought</h1>
    <p className="nw-lede">Regional vegetation, soil moisture and water storage observations from Supabase.</p>
    {loading ? <LoadingProgress className="nw-forecast-loading" message="Loading satellite observations from the database" /> : error ? <div className="nw-error" role="alert">{error}</div> : !stations.length ? <p>No satellite observations are available in the database.</p> : <>
      <section className="sat-kpi-strip">{fields.map(([key, label, unit, precision]) => <article className="sat-kpi" key={key}><div><small>{label}</small><strong>{display(actual[key], precision)} {valid(actual[key]) ? unit : ''}</strong><em>{actual.date || 'No observation for this region'}</em></div></article>)}</section>
      <div className="sat-top-grid">
        <Panel title="Current NDVI"><p className="sat-caption">Select a district to view its database observations.</p><label>Map date <select aria-label="Satellite map date" value={mapDate} onChange={event => setMapDate(event.target.value)}>{(mapDates.length ? mapDates : [mapDate]).filter(Boolean).map(date => <option key={date}>{date}</option>)}</select></label><div className="sat-map-wrap">{mapError ? <p className="nw-error" role="alert">{mapError}</p> : mapLoading ? <LoadingProgress className="nw-map-loading" message="Loading map observations" /> : map('NDVI', colors.NDVI)}</div></Panel>
        <Panel title={`District Details – ${selected}`}><label>Region <select aria-label="Satellite region" value={actual.name || ''} onChange={(e) => setSelected(e.target.value)}><option value="" disabled>{selected}</option>{stations.map((row) => <option key={row.name} value={row.name}>{row.name}</option>)}</select></label><div className="sat-detail-grid">{fields.map(([key, label, unit, precision]) => <article className="sat-detail" key={key}><div><small>{label}</small><strong>{display(actual[key], precision)} {valid(actual[key]) ? unit : ''}</strong><b>Latest observation</b></div></article>)}</div></Panel>
        <Panel title={`Time Series – ${selected}`}><div className="sat-chart-tabs">{[3, 6, 12, 24].map((count) => <button key={count} className={months === count ? 'sel' : ''} onClick={() => setMonths(count)}>{count}M</button>)}</div>
          {historyLoading ? <LoadingProgress className="nw-map-loading" message="Loading district history" /> : historyError ? <p className="nw-error" role="alert">{historyError}</p> : !chartPoints.length ? <p>No NDVI history available for this region.</p> : <div className="sat-chart"><LineChart sets={[{ n: 'NDVI', data: chartPoints.map((row) => row.NDVI), c: '#7cd957', w: 2.5 }, { n: 'Historical mean', data: chartPoints.map(() => mean), c: '#78b5cf', dash: '4 4' }]} labels={chartPoints.map((row) => row.date.slice(0, 7))} min={-1} max={1} h={185} dec={1} /></div>}
          <div className="sat-chart-stats"><div><small>Latest NDVI</small><strong>{display(actual.NDVI)}</strong></div><div><small>Historical mean NDVI</small><strong>{display(mean)}</strong></div></div><p className="sat-note">{history.length} database observations for {selected}.</p>
        </Panel>
      </div>
      <div className="sat-bottom-grid">
        <Panel title="Satellite Indices – South Africa"><div className="sat-small-map">{map('NDVI', colors.NDVI)}</div></Panel>
        <Panel title="Soil Moisture & Water Content"><div className="sat-dual-map"><div><small>Surface soil moisture</small>{map('surface_soil_moisture', colors.moisture)}</div><div><small>Root-zone soil moisture</small>{map('rootzone_soil_moisture', colors.moisture)}</div></div></Panel>
        <Panel title="Surface Water Extent"><div className="sat-water-map">{map('surface_water_extent_km2', colors.water)}</div></Panel>
        <Panel title="GRACE Water Storage Anomaly"><div className="sat-small-map">{map('GRACE_TWS', colors.grace)}</div></Panel>
      </div>
      <p className="nw-note">Source: Supabase satellite_remote_sensing · Latest observation: {actual.date || 'No data'}</p>
    </>}
  </>
}
