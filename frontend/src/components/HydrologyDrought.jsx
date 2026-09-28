import { useEffect, useState, useMemo } from 'react'
import {
  Droplets, Waves, Gauge, Activity, Calendar, User, MapPin,
  AlertTriangle, AlertCircle, CheckCircle2, ArrowDown, ArrowUp,
  ChevronRight, Compass, Layers, Info, Loader2
} from 'lucide-react'
import '../niwis/hydrology.css'

// Helper to format real numerical values from hydrology.csv
function formatMetric(val) {
  if (val === null || val === undefined || isNaN(val)) return 'N/A'
  const num = Number(val)
  if (num === 0) return '0.00'
  const abs = Math.abs(num)
  if (abs < 0.001) return num.toExponential(2)
  if (abs < 0.1) return num.toFixed(4)
  if (abs < 10) return num.toFixed(2)
  return num.toFixed(1)
}

export default function HydrologyDrought() {
  const [selectedDistrict, setSelectedDistrict] = useState('City of Tshwane')
  const [selectedDate, setSelectedDate] = useState(null)
  const [allStations, setAllStations] = useState([])
  const [availableDates, setAvailableDates] = useState([])
  const [latestDate, setLatestDate] = useState(null)
  const [historyData, setHistoryData] = useState(null)
  const [districtsGeoJson, setDistrictsGeoJson] = useState([])
  const [loading, setLoading] = useState(true)
  const [mapMode, setMapMode] = useState('regional') // 'regional' or 'national'

  // Fetch stations list & GeoJSON
  useEffect(() => {
    Promise.all([
      fetch(`/api/hydrology/stations?date=${encodeURIComponent(selectedDate)}`).then((r) => r.ok ? r.json() : Promise.reject()),
      fetch('/south_africa_adm2.geojson').then((r) => r.ok ? r.json() : Promise.reject())
    ]).then(([stationsRes, geojsonRes]) => {
      setAllStations(stationsRes.stations || [])
      setAvailableDates(stationsRes.available_dates || [])
      setDistrictsGeoJson(geojsonRes.features || [])
      // set latest dataset date from backend
      if (stationsRes.date) {
        setLatestDate(stationsRes.date)
        if (!selectedDate) setSelectedDate(stationsRes.date)
      }
    }).catch((err) => {
      console.error('Failed to load stations or GeoJSON', err)
    })
  }, [selectedDate])

  // Fetch detailed history whenever district or date changes
  useEffect(() => {
    setLoading(true)
    const url = `/api/hydrology/history?district=${encodeURIComponent(selectedDistrict)}&date=${encodeURIComponent(selectedDate)}`
    console.debug('[Hydrology] fetching history ->', { selectedDistrict, selectedDate, url })
    fetch(url)
      .then((r) => r.ok ? r.json() : Promise.reject(r))
      .then((data) => {
        console.debug('[Hydrology] history response', { district: selectedDistrict, items: data })
        setHistoryData(data)
        if (data.available_dates && data.available_dates.length) {
          setAvailableDates(data.available_dates)
        }
      })
      .catch((err) => {
        console.error('Failed to load district history from CSV', err)
      })
      .finally(() => setLoading(false))
  }, [selectedDistrict, selectedDate])

  // Developer logs: track changes to selectedDistrict/Date and historyData
  useEffect(() => {
    console.debug('[Hydrology] selectedDistrict changed ->', { selectedDistrict, selectedDate })
  }, [selectedDistrict, selectedDate])

  useEffect(() => {
    if (historyData) console.debug('[Hydrology] historyData updated', {
      district: historyData?.district,
      date: historyData?.date,
      metrics: historyData?.metrics ? {
        river_discharge: historyData.metrics.river_discharge,
        ssi: historyData.metrics.ssi,
        dam_inflow: historyData.metrics.dam_inflow,
        dam_outflow: historyData.metrics.dam_outflow,
        surface_runoff: historyData.metrics.surface_runoff,
        baseflow: historyData.metrics.baseflow,
      } : null,
    })
  }, [historyData])

  const m = historyData?.metrics
  const districtName = historyData?.district || selectedDistrict
  const provinceName = historyData?.province || 'South Africa'
  const droughtStatus = historyData?.drought_status

  // Classification helpers (transparent, documented thresholds)
  const classifySSI = (ssi) => {
    if (ssi === null || ssi === undefined || isNaN(ssi)) return { label: 'N/A', severity: 'unknown' }
    const v = Number(ssi)
    if (v >= -0.5) return { label: 'Normal', severity: 'normal' }
    if (v >= -0.99) return { label: 'Mild dryness', severity: 'mild' }
    if (v >= -1.49) return { label: 'Moderate drought', severity: 'moderate' }
    if (v >= -1.99) return { label: 'Severe drought', severity: 'severe' }
    return { label: 'Extreme drought', severity: 'extreme' }
  }

  const classifySGI = (sgi) => {
    if (sgi === null || sgi === undefined || isNaN(sgi)) return { label: 'N/A', severity: 'unknown' }
    const v = Number(sgi)
    if (v >= -0.5) return { label: 'Normal', severity: 'normal' }
    if (v >= -1.0) return { label: 'Below Normal', severity: 'mild' }
    if (v >= -1.5) return { label: 'Moderate Groundwater Drought', severity: 'moderate' }
    return { label: 'Severe Groundwater Drought', severity: 'severe' }
  }

  const computeAlerts = (metrics) => {
    if (!metrics) return []
    const alerts = []
    const ssi = metrics.ssi
    const sgi = metrics.sgi
    // SSI based alerts
    if (ssi != null) {
      if (ssi <= -1.5) alerts.push({ level: 'Severe', reason: 'SSI <= -1.5', variable: 'SSI', current: ssi, threshold: -1.5 })
      else if (ssi <= -1.0) alerts.push({ level: 'Warning', reason: 'SSI <= -1.0', variable: 'SSI', current: ssi, threshold: -1.0 })
    }
    // SGI based alerts
    if (sgi != null && sgi <= -1.0) alerts.push({ level: 'Warning', reason: 'SGI <= -1.0', variable: 'SGI', current: sgi, threshold: -1.0 })
    // Low flow: compare current discharge to historical monthly average
    if (metrics.discharge_hist_avg != null && metrics.river_discharge != null) {
      const pct = metrics.discharge_change
      if (pct <= -25) alerts.push({ level: 'Warning', reason: 'River discharge >25% below historical average', variable: 'River Discharge', current: metrics.river_discharge, baseline: metrics.discharge_hist_avg, change_pct: pct })
    }
    // Runoff and baseflow
    if (metrics.runoff_change != null && metrics.runoff_change <= -25) alerts.push({ level: 'Warning', reason: 'Surface runoff substantially below historical', variable: 'Surface Runoff', current: metrics.surface_runoff, change_pct: metrics.runoff_change })
    if (metrics.baseflow_change != null && metrics.baseflow_change <= -25) alerts.push({ level: 'Warning', reason: 'Baseflow substantially below historical', variable: 'Baseflow', current: metrics.baseflow, change_pct: metrics.baseflow_change })
    return alerts
  }

  const alerts = computeAlerts(m)

  // Render SVG Sparkline Chart dynamically from points
  const renderSparkline = (points = [], strokeColor = '#38bdf8') => {
    if (!points || points.length === 0) return null
    const vals = points.map((p) => Number(p.value)).filter((v) => !isNaN(v))
    if (!vals.length) return null

    const min = Math.min(...vals)
    const max = Math.max(...vals)
    const range = max - min || Math.abs(max) || 0.001
    const yMin = min - range * 0.1
    const yMax = max + range * 0.1

    const w = 150
    const h = 55
    const pad = 6
    const n = points.length
    const xStep = (w - pad * 2) / Math.max(1, n - 1)

    const calcY = (val) => {
      return h - pad - ((val - yMin) / (yMax - yMin)) * (h - pad * 2)
    }

    const pathD = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${pad + i * xStep},${calcY(p.value)}`).join(' ')

    return (
      <svg viewBox={`0 0 ${w} ${h}`} style={{ width: '100%', height: '55px', overflow: 'visible' }}>
        <line x1={pad} y1={pad} x2={w - pad} y2={pad} stroke="rgba(255,255,255,0.06)" strokeWidth="1" strokeDasharray="2 2" />
        <line x1={pad} y1={h / 2} x2={w - pad} y2={h / 2} stroke="rgba(255,255,255,0.06)" strokeWidth="1" strokeDasharray="2 2" />
        <line x1={pad} y1={h - pad} x2={w - pad} y2={h - pad} stroke="rgba(255,255,255,0.06)" strokeWidth="1" strokeDasharray="2 2" />
        <path d={pathD} fill="none" stroke={strokeColor} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
        {points.map((p, i) => (
          <circle key={i} cx={pad + i * xStep} cy={calcY(p.value)} r="3" fill="#071b29" stroke={strokeColor} strokeWidth="2" />
        ))}
      </svg>
    )
  }

  // Projection for National GeoJSON map
  const project = ([lon, lat]) => [((lon - 16.45) / 16.5) * 440, ((-22.12 - lat) / 12.75) * 230]
  const ringsFor = (geometry) => geometry?.type === 'Polygon' ? [geometry.coordinates] : geometry?.type === 'MultiPolygon' ? geometry.coordinates : []
  const pathFor = (geometry) => ringsFor(geometry).flatMap((polygon) => polygon.map((ring) => ring.map((point, index) => {
    const [x, y] = project(point)
    return `${index ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`
  }).join(' ') + 'Z')).join(' ')

  if (loading && !historyData) {
    return (
      <div className="hydro-container" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '60vh' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', color: '#38bdf8', fontSize: '15px' }}>
          <Loader2 size={24} className="nw-spin" style={{ animation: 'spin 1s linear infinite' }} />
          <span>Reading observations from csv's/hydrology.csv…</span>
        </div>
      </div>
    )
  }

  return (
    <div className="hydro-container">
      {/* ---------------- 1. Top Header Bar ---------------- */}
      <header className="hydro-header-bar">
        <div className="hydro-title-section">
          <div className="hydro-icon-bubble">
            <Droplets size={22} />
          </div>
          <div className="hydro-title-text">
            <h2>Hydrological Drought Monitoring</h2>
            <div className="hydro-title-sub">
              Rivers <span>|</span> Reservoirs <span>|</span> Groundwater <span>|</span> Runoff <span>|</span> Baseflow
            </div>
          </div>
        </div>

        <div className="hydro-meta-section">
          {/* Observation Date Selector */}
          <div className="hydro-meta-item">
            <Calendar size={18} className="icon" />
            <div className="meta-col">
              <span className="meta-label">Observation Date</span>
            <select
              value={selectedDate || latestDate || ''}
              onChange={(e) => setSelectedDate(e.target.value)}
              style={{
                background: 'transparent',
                border: 'none',
                color: '#ffffff',
                fontSize: '12px',
                fontWeight: '600',
                outline: 'none',
                cursor: 'pointer'
              }}
              aria-label="Select Date from hydrology.csv"
            >
              {availableDates.length > 0 ? (
                availableDates.map((d) => (
                  <option key={d} value={d} style={{ background: '#092031', color: '#ffffff' }}>
                    {new Date(d).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })} ({d})
                  </option>
                ))
              ) : (
                <option value="">No dates</option>
              )}
            </select>
            </div>
          </div>

          <div className="hydro-meta-item">
            <User size={18} className="icon" />
            <div className="meta-col">
              <span className="meta-label">User Access</span>
              <span className="meta-val">Data Scientist</span>
            </div>
          </div>
        </div>
      </header>

      {/* ---------------- 2. Location & 7-KPI Strip ---------------- */}
      <section className="hydro-kpi-bar" aria-label="Hydrological key indicators">
        {/* District Selector Pill */}
        <div className="hydro-district-card">
          <div className="hydro-district-head">
            <MapPin size={15} />
            <span>{districtName}</span>
          </div>
          <div className="hydro-district-select-wrap">
            <select
              value={selectedDistrict}
              onChange={(e) => setSelectedDistrict(e.target.value)}
              aria-label="Select South African District"
            >
              {allStations.length > 0 ? (
                allStations.map((s) => (
                  <option key={s.name} value={s.name}>
                    {s.name}
                  </option>
                ))
              ) : (
                <option value="City of Tshwane">City of Tshwane</option>
              )}
            </select>
          </div>
          <div className="hydro-district-sub">
            Municipality | {provinceName}
          </div>
        </div>

        {/* 1. River Discharge */}
        <div className="hydro-kpi-cell">
          <div className="hydro-kpi-top">
            <span className="hydro-kpi-title">River Discharge</span>
            <Waves size={16} className="hydro-kpi-icon" />
          </div>
          <div className="hydro-kpi-val-row">
            <span className="hydro-kpi-val">{formatMetric(m?.river_discharge)}</span>
            <span className="hydro-kpi-unit">m³/s</span>
            {m?.discharge_change != null && (
              <span className={`hydro-kpi-badge ${m.discharge_change < 0 ? 'down-danger' : 'up-success'}`}>
                {m.discharge_change < 0 ? <ArrowDown size={11} /> : <ArrowUp size={11} />}
                {Math.abs(m.discharge_change).toFixed(0)}%
              </span>
            )}
          </div>
          <div className="hydro-kpi-note">vs historical average: {formatMetric(m?.discharge_hist_avg)} m³/s</div>
        </div>

        {/* 2. Flow Percentile (P10) */}
        <div className="hydro-kpi-cell">
          <div className="hydro-kpi-top">
            <span className="hydro-kpi-title">Flow Percentile (P10)</span>
            <Activity size={16} className="hydro-kpi-icon" />
          </div>
          <div className="hydro-kpi-val-row">
            <span className="hydro-kpi-val">{formatMetric(m?.p10)}</span>
            <span className="hydro-kpi-unit">m³/s</span>
            {m?.p10_change != null && (
              <span className={`hydro-kpi-badge ${m.p10_change < 0 ? 'down-danger' : 'up-success'}`}>
                {m.p10_change < 0 ? <ArrowDown size={11} /> : <ArrowUp size={11} />}
                {Math.abs(m.p10_change).toFixed(0)}%
              </span>
            )}
          </div>
          <div className="hydro-kpi-note">{m?.river_discharge <= m?.p10 ? 'dry condition' : 'normal condition'}</div>
        </div>

        {/* 3. SSI (Streamflow) */}
        <div className="hydro-kpi-cell">
          <div className="hydro-kpi-top">
            <span className="hydro-kpi-title">SSI (Streamflow)</span>
            <Gauge size={16} className="hydro-kpi-icon" />
          </div>
          <div className="hydro-kpi-val-row">
            <span className="hydro-kpi-val">{m?.ssi != null ? Number(m.ssi).toFixed(2) : 'N/A'}</span>
          </div>
          <div className="hydro-kpi-note">{classifySSI(m?.ssi).label}</div>
        </div>

        {/* 4. Groundwater Level */}
        <div className="hydro-kpi-cell">
          <div className="hydro-kpi-top">
            <span className="hydro-kpi-title">Groundwater Level</span>
            <Activity size={16} className="hydro-kpi-icon" />
          </div>
          <div className="hydro-kpi-val-row">
            <span className="hydro-kpi-val">{formatMetric(m?.borehole)}</span>
            <span className="hydro-kpi-unit">m bgl</span>
            {m?.borehole_change != null && (
              <span className={`hydro-kpi-badge ${m.borehole_change >= 0 ? 'up-success' : 'down-danger'}`}>
                {m.borehole_change >= 0 ? <ArrowUp size={11} /> : <ArrowDown size={11} />}
                {m.borehole_change >= 0 ? '+' : ''}{m.borehole_change.toFixed(0)}%
              </span>
            )}
          </div>
          <div className="hydro-kpi-note">(vs. last month)</div>
        </div>

        {/* 5. SGI (Groundwater) */}
        <div className="hydro-kpi-cell">
          <div className="hydro-kpi-top">
            <span className="hydro-kpi-title">SGI (Groundwater)</span>
            <Gauge size={16} className="hydro-kpi-icon" />
          </div>
          <div className="hydro-kpi-val-row">
            <span className="hydro-kpi-val">{m?.sgi != null ? Number(m.sgi).toFixed(2) : 'N/A'}</span>
          </div>
          <div className="hydro-kpi-note">{classifySGI(m?.sgi).label}</div>
        </div>

        {/* 6. Surface Runoff */}
        <div className="hydro-kpi-cell">
          <div className="hydro-kpi-top">
            <span className="hydro-kpi-title">Surface Runoff</span>
            <Waves size={16} className="hydro-kpi-icon" />
          </div>
          <div className="hydro-kpi-val-row">
            <span className="hydro-kpi-val">{formatMetric(m?.surface_runoff)}</span>
            <span className="hydro-kpi-unit">m³/s</span>
            {m?.runoff_change != null && (
              <span className={`hydro-kpi-badge ${m.runoff_change < 0 ? 'down-danger' : 'up-success'}`}>
                {m.runoff_change < 0 ? <ArrowDown size={11} /> : <ArrowUp size={11} />}
                {Math.abs(m.runoff_change).toFixed(0)}%
              </span>
            )}
          </div>
          <div className="hydro-kpi-note">(vs. historical avg)</div>
        </div>

        {/* 7. Baseflow */}
        <div className="hydro-kpi-cell">
          <div className="hydro-kpi-top">
            <span className="hydro-kpi-title">Baseflow</span>
            <Waves size={16} className="hydro-kpi-icon" />
          </div>
          <div className="hydro-kpi-val-row">
            <span className="hydro-kpi-val">{formatMetric(m?.baseflow)}</span>
            <span className="hydro-kpi-unit">m³/s</span>
            {m?.baseflow_change != null && (
              <span className={`hydro-kpi-badge ${m.baseflow_change < 0 ? 'down-danger' : 'up-success'}`}>
                {m.baseflow_change < 0 ? <ArrowDown size={11} /> : <ArrowUp size={11} />}
                {Math.abs(m.baseflow_change).toFixed(0)}%
              </span>
            )}
          </div>
          <div className="hydro-kpi-note">(vs. historical avg)</div>
        </div>
      </section>

      {/* ---------------- 3. Row 1: Map + Discharge Chart + Flow Duration Curve ---------------- */}
      <div className="hydro-grid-row">
        {/* Panel 1: Hydrological Overview Map */}
        <section className="hydro-panel">
          <div className="hydro-panel-head">
            <span className="hydro-panel-title">{districtName} – Hydrological Overview</span>
            <div className="hydro-panel-actions">
              <button
                type="button"
                className={`hydro-badge-toggle ${mapMode === 'regional' ? 'active' : ''}`}
                onClick={() => setMapMode('regional')}
              >
                Watershed
              </button>
              <button
                type="button"
                className={`hydro-badge-toggle ${mapMode === 'national' ? 'active' : ''}`}
                onClick={() => setMapMode('national')}
              >
                National (52)
              </button>
            </div>
          </div>

          <div className="hydro-map-wrap">
            {mapMode === 'regional' ? (
              <div className="hydro-map-svg-area">
                <svg viewBox="0 0 380 230" preserveAspectRatio="xMidYMid meet">
                  <defs>
                    <radialGradient id="regionGlow" cx="50%" cy="50%" r="60%">
                      <stop offset="0%" stopColor="#0d3c5c" stopOpacity="0.8" />
                      <stop offset="100%" stopColor="#061623" stopOpacity="1" />
                    </radialGradient>
                    <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
                      <feGaussianBlur stdDeviation="1.8" result="blur" />
                      <feComposite in="SourceGraphic" in2="blur" operator="over" />
                    </filter>
                  </defs>

                  <rect width="380" height="230" fill="url(#regionGlow)" />

                  {/* Adjacent District Boundaries */}
                  <path d="M 60,10 L 260,8 L 320,50 L 230,70 L 100,55 Z" fill="#09283d" stroke="#164361" strokeWidth="1" strokeDasharray="3 3" opacity="0.7" />
                  <text x="120" y="32" fill="#719bb3" fontSize="8" fontWeight="600">Catchment North</text>

                  <path d="M 20,90 L 80,70 L 110,130 L 30,140 Z" fill="#0a2c42" stroke="#164361" strokeWidth="1" strokeDasharray="3 3" opacity="0.7" />
                  <text x="32" y="112" fill="#719bb3" fontSize="8" fontWeight="600">Catchment West</text>

                  <path d="M 280,70 L 370,80 L 360,150 L 290,130 Z" fill="#09283d" stroke="#164361" strokeWidth="1" strokeDasharray="3 3" opacity="0.7" />
                  <text x="300" y="100" fill="#719bb3" fontSize="8" fontWeight="600">Catchment East</text>

                  <path d="M 220,160 L 340,165 L 320,225 L 230,220 Z" fill="#0a2d45" stroke="#164361" strokeWidth="1" strokeDasharray="3 3" opacity="0.7" />
                  <text x="248" y="196" fill="#719bb3" fontSize="8" fontWeight="600">Catchment South</text>

                  {/* Core Selected District Polygon */}
                  <path
                    d="M 110,65 L 210,60 L 265,95 L 280,145 L 225,175 L 135,170 L 95,125 Z"
                    fill="#082b42"
                    stroke="#38bdf8"
                    strokeWidth="1.8"
                    filter="url(#glow)"
                  />

                  {/* Glowing River Tributary Network inside district */}
                  <g stroke="#00e5ff" strokeLinecap="round" filter="url(#glow)">
                    <path d="M 195,65 Q 185,90 170,110 T 155,145 T 145,170" fill="none" strokeWidth="2.2" />
                    <path d="M 120,95 Q 140,105 170,110" fill="none" strokeWidth="1.2" opacity="0.85" />
                    <path d="M 110,130 Q 130,135 155,145" fill="none" strokeWidth="1.1" opacity="0.8" />
                    <path d="M 245,85 Q 215,95 185,90" fill="none" strokeWidth="1.4" opacity="0.85" />
                    <path d="M 260,125 Q 210,120 170,110" fill="none" strokeWidth="1.3" opacity="0.85" />
                  </g>

                  {/* Center Pin for Selected District */}
                  <g transform="translate(170, 110)">
                    <circle cx="0" cy="0" r="14" fill="rgba(56, 189, 248, 0.2)" />
                    <circle cx="0" cy="0" r="6" fill="#38bdf8" stroke="#ffffff" strokeWidth="1.5" />
                    <rect x="-50" y="9" width="100" height="15" rx="3" fill="#071b29" stroke="#38bdf8" strokeWidth="0.8" />
                    <text x="0" y="20" fill="#ffffff" fontSize="8" fontWeight="700" textAnchor="middle">{districtName}</text>
                  </g>
                </svg>
              </div>
            ) : (
              <div className="hydro-map-svg-area">
                <svg viewBox="0 0 440 230" preserveAspectRatio="xMidYMid meet">
                  {districtsGeoJson.map((feature) => {
                    const name = feature.properties?.shapeName || ''
                    const isSelected = name.toLowerCase().replace(/[^a-z0-9]/g, '') === selectedDistrict.toLowerCase().replace(/[^a-z0-9]/g, '')
                    return (
                      <path
                        key={feature.properties?.shapeID || name}
                        d={pathFor(feature.geometry)}
                        fill={isSelected ? '#0284c7' : '#0a273b'}
                        stroke={isSelected ? '#ffffff' : '#143c55'}
                        strokeWidth={isSelected ? '2' : '0.7'}
                        cursor="pointer"
                        onClick={() => setSelectedDistrict(name)}
                      >
                        <title>{name}</title>
                      </path>
                    )
                  })}
                </svg>
              </div>
            )}

            {/* Map Legend Aside */}
            <aside className="hydro-map-legend-aside">
              <div className="hydro-legend-group">
                <strong>River Discharge (m³/s)</strong>
                <div className="hydro-legend-item"><i className="hydro-legend-color" style={{ background: '#0284c7' }} /><span>&gt; 0.05</span></div>
                <div className="hydro-legend-item"><i className="hydro-legend-color" style={{ background: '#06b6d4' }} /><span>0.03 – 0.05</span></div>
                <div className="hydro-legend-item"><i className="hydro-legend-color" style={{ background: '#10b981' }} /><span>0.02 – 0.03</span></div>
                <div className="hydro-legend-item"><i className="hydro-legend-color" style={{ background: '#eab308' }} /><span>0.015 – 0.02</span></div>
                <div className="hydro-legend-item"><i className="hydro-legend-color" style={{ background: '#f97316' }} /><span>0.01 – 0.015</span></div>
                <div className="hydro-legend-item"><i className="hydro-legend-color" style={{ background: '#ef4444' }} /><span>&lt; 0.01</span></div>
              </div>

              <div className="hydro-legend-group">
                <strong>SSI Classification</strong>
                <div className="hydro-legend-item"><i className="hydro-legend-color" style={{ background: '#06b6d4' }} /><span>&gt; 0.5 (Wet)</span></div>
                <div className="hydro-legend-item"><i className="hydro-legend-color" style={{ background: '#38bdf8' }} /><span>-0.5 to 0.5 (Normal)</span></div>
                <div className="hydro-legend-item"><i className="hydro-legend-color" style={{ background: '#eab308' }} /><span>-0.8 to -0.5 (Dry)</span></div>
                <div className="hydro-legend-item"><i className="hydro-legend-color" style={{ background: '#f97316' }} /><span>-1.3 to -0.8 (Moderate)</span></div>
                <div className="hydro-legend-item"><i className="hydro-legend-color" style={{ background: '#ef4444' }} /><span>&le; -1.3 (Severe)</span></div>
              </div>
            </aside>

            {/* Compass & Scale Overlay */}
            <div className="hydro-map-decorations">
              <div className="hydro-compass">
                <span>N</span>
                <i className="hydro-compass-arrow" />
              </div>
              <div className="hydro-scalebar">
                <div className="hydro-scale-ticks">
                  <span>0</span>
                  <span>10</span>
                  <span>20</span>
                  <span>30</span>
                  <span>40</span>
                  <span>50 km</span>
                </div>
                <div className="hydro-scale-line" />
              </div>
            </div>
          </div>
        </section>

        {/* Panel 2: River Discharge – Monthly Time Series strictly from CSV */}
        <section className="hydro-panel">
          <div className="hydro-panel-head">
            <span className="hydro-panel-title">River Discharge – {districtName}</span>
            <div className="hydro-panel-actions" style={{ fontSize: '9px', gap: '10px' }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', color: '#38bdf8' }}>
                <i style={{ width: '10px', height: '2px', background: '#38bdf8', display: 'inline-block' }} /> Current (CSV)
              </span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', color: '#7ba7be' }}>
                <i style={{ width: '10px', height: '2px', background: '#7ba7be', display: 'inline-block', borderTop: '1px dashed #7ba7be' }} /> Historical Avg
              </span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', color: '#4d88a8' }}>
                <i style={{ width: '8px', height: '8px', background: 'rgba(56,189,248,0.18)', display: 'inline-block' }} /> Range (±1σ)
              </span>
            </div>
          </div>

              <div style={{ height: '170px', width: '100%', position: 'relative' }} key={`discharge-${selectedDistrict}-${selectedDate || latestDate}`}>
            {(() => {
              const series = historyData?.river_discharge_12m || []
              if (!series.length) {
                return <div style={{ color: '#7ba7be', fontSize: '12px', padding: '20px' }}>No time series observations for selected date.</div>
              }

              const allVals = series.flatMap((s) => [s.current, s.historical_avg, s.range_max]).filter((v) => !isNaN(v))
              const maxVal = Math.max(...allVals, 0.01) * 1.15
              const minVal = 0

              const w = 320
              const h = 145
              const padL = 34
              const padR = 10
              const padT = 10
              const padB = 22
              const n = series.length

              const calcX = (i) => padL + (i / Math.max(1, n - 1)) * (w - padL - padR)
              const calcY = (v) => h - padB - ((v - minVal) / (maxVal - minVal)) * (h - padT - padB)

              const topPoints = series.map((s, i) => `${calcX(i)},${calcY(s.range_max)}`).join(' ')
              const botPoints = [...series].reverse().map((s, i) => `${calcX(n - 1 - i)},${calcY(s.range_min)}`).join(' ')

              const curPath = series.map((s, i) => `${i === 0 ? 'M' : 'L'} ${calcX(i)},${calcY(s.current)}`).join(' ')
              const histPath = series.map((s, i) => `${i === 0 ? 'M' : 'L'} ${calcX(i)},${calcY(s.historical_avg)}`).join(' ')

              const ticks = [0, maxVal * 0.33, maxVal * 0.66, maxVal]

              return (
                <svg viewBox={`0 0 ${w} ${h}`} style={{ width: '100%', height: '100%' }}>
                  {ticks.map((v) => (
                    <g key={v}>
                      <line x1={padL} y1={calcY(v)} x2={w - padR} y2={calcY(v)} stroke="rgba(255,255,255,0.06)" strokeWidth="1" />
                      <text x={padL - 5} y={calcY(v) + 3} fill="#5f889f" fontSize="7" textAnchor="end">{formatMetric(v)}</text>
                    </g>
                  ))}
                  <polygon points={`${topPoints} ${botPoints}`} fill="rgba(56, 189, 248, 0.12)" />
                  <path d={histPath} fill="none" stroke="#7ba7be" strokeWidth="1.6" strokeDasharray="4 3" />
                  <path d={curPath} fill="none" stroke="#38bdf8" strokeWidth="2.2" />
                  {series.map((s, i) => (
                    <circle key={i} cx={calcX(i)} cy={calcY(s.current)} r="2.5" fill="#092031" stroke="#38bdf8" strokeWidth="1.8">
                      <title>{`${s.month}: ${formatMetric(s.current)} m³/s (Hist Avg: ${formatMetric(s.historical_avg)})`}</title>
                    </circle>
                  ))}
                  {series.map((s, i) => (
                    <text key={i} x={calcX(i)} y={h - 6} fill="#628ea6" fontSize="6.5" textAnchor="middle">
                      {s.month.slice(0, 3)}
                    </text>
                  ))}
                  <text x="8" y={h / 2} fill="#5f889f" fontSize="7" transform={`rotate(-90 8 ${h / 2})`} textAnchor="middle">Discharge (m³/s)</text>
                </svg>
              )
            })()}
          </div>

          <div className="hydro-chart-stats-row">
            <div className="hydro-stat-col">
              <small>Current Discharge</small>
              <strong>
                {formatMetric(m?.river_discharge)} m³/s
                {m?.discharge_change != null && (
                  <em className={m.discharge_change < 0 ? 'down-danger' : 'up-success'}>
                    {m.discharge_change < 0 ? <ArrowDown size={10} /> : <ArrowUp size={10} />}
                    {Math.abs(m.discharge_change).toFixed(0)}%
                  </em>
                )}
              </strong>
            </div>
            <div className="hydro-stat-col">
              <small>Historical Avg</small>
              <strong>{formatMetric(m?.discharge_hist_avg)} m³/s</strong>
            </div>
            <div className="hydro-stat-col">
              <small>Discharge Change</small>
              <strong>
                <em className={m?.discharge_change < 0 ? 'down-danger' : 'up-success'}>
                  {m?.discharge_change < 0 ? <ArrowDown size={12} /> : <ArrowUp size={12} />}
                  {Math.abs(m?.discharge_change || 0).toFixed(1)}%
                </em>
              </strong>
            </div>
          </div>
        </section>

        {/* Panel 3: Flow Duration Curve strictly from CSV */}
        <section className="hydro-panel">
          <div className="hydro-panel-head">
            <span className="hydro-panel-title">Flow Duration Curve – {districtName}</span>
            <div className="hydro-panel-actions" style={{ fontSize: '9px', gap: '10px' }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', color: '#38bdf8' }}>
                <i style={{ width: '10px', height: '2px', background: '#38bdf8', display: 'inline-block' }} /> Recent (12m)
              </span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', color: '#7ba7be' }}>
                <i style={{ width: '10px', height: '2px', background: '#7ba7be', display: 'inline-block', borderTop: '1px dashed #7ba7be' }} /> Full History (25y)
              </span>
            </div>
          </div>

          <div style={{ height: '170px', width: '100%', position: 'relative' }} key={`fdc-${selectedDistrict}-${selectedDate || latestDate}`}>
            {(() => {
              const points = historyData?.fdc || []
              if (!points.length) return null

              const allVals = points.flatMap((pt) => [pt.current, pt.historical]).filter((v) => v > 0)
              const maxVal = Math.max(...allVals, 0.05)
              const minVal = Math.min(...allVals, 0.005)

              const w = 320
              const h = 145
              const padL = 34
              const padR = 10
              const padT = 10
              const padB = 22

              const calcX = (p) => padL + (p / 100) * (w - padL - padR)
              const calcY = (q) => {
                const clamped = Math.max(minVal, q)
                const ratio = (clamped - minVal) / (maxVal - minVal || 1)
                return h - padB - ratio * (h - padT - padB)
              }

              const curPath = points.map((pt, i) => `${i === 0 ? 'M' : 'L'} ${calcX(pt.p)},${calcY(pt.current)}`).join(' ')
              const histPath = points.map((pt, i) => `${i === 0 ? 'M' : 'L'} ${calcX(pt.p)},${calcY(pt.historical)}`).join(' ')

              const yTicks = [minVal, minVal + (maxVal - minVal) * 0.5, maxVal]

              return (
                <svg viewBox={`0 0 ${w} ${h}`} style={{ width: '100%', height: '100%' }}>
                  {yTicks.map((v) => (
                    <g key={v}>
                      <line x1={padL} y1={calcY(v)} x2={w - padR} y2={calcY(v)} stroke="rgba(255,255,255,0.06)" strokeWidth="1" />
                      <text x={padL - 5} y={calcY(v) + 3} fill="#5f889f" fontSize="7" textAnchor="end">{formatMetric(v)}</text>
                    </g>
                  ))}
                  {[0, 20, 40, 60, 80, 100].map((p) => (
                    <g key={p}>
                      <line x1={calcX(p)} y1={padT} x2={calcX(p)} y2={h - padB} stroke="rgba(255,255,255,0.04)" strokeWidth="1" />
                      <text x={calcX(p)} y={h - 6} fill="#628ea6" fontSize="6.5" textAnchor="middle">{p}%</text>
                    </g>
                  ))}
                  <path d={histPath} fill="none" stroke="#7ba7be" strokeWidth="1.6" strokeDasharray="4 3" />
                  <path d={curPath} fill="none" stroke="#38bdf8" strokeWidth="2.2" />
                  <text x="8" y={h / 2} fill="#5f889f" fontSize="7" transform={`rotate(-90 8 ${h / 2})`} textAnchor="middle">Flow (m³/s)</text>
                  <text x={w / 2} y={h} fill="#5f889f" fontSize="7" textAnchor="middle">Exceedance probability (%)</text>
                </svg>
              )
            })()}
          </div>

          <div className="hydro-chart-stats-row" style={{ gridTemplateColumns: '1fr 1fr' }}>
            <div className="hydro-stat-col">
              <small>P10 (Low Flow)</small>
              <strong>
                {formatMetric(m?.p10)} m³/s
                {m?.p10_change != null && (
                  <em className={m.p10_change < 0 ? 'down-danger' : 'up-success'}>
                    {m.p10_change < 0 ? <ArrowDown size={10} /> : <ArrowUp size={10} />}
                    {Math.abs(m.p10_change).toFixed(0)}%
                  </em>
                )}
              </strong>
            </div>
            <div className="hydro-stat-col">
              <small>P50 (Median Flow)</small>
              <strong>
                {formatMetric(m?.p50)} m³/s
                {m?.p50_change != null && (
                  <em className={m.p50_change < 0 ? 'down-warning' : 'up-success'}>
                    {m.p50_change < 0 ? <ArrowDown size={10} /> : <ArrowUp size={10} />}
                    {Math.abs(m.p50_change).toFixed(0)}%
                  </em>
                )}
              </strong>
            </div>
          </div>
        </section>
      </div>

      {/* ---------------- 4. Row 2: Status + Groundwater + Runoff & Baseflow ---------------- */}
      <div className="hydro-grid-row">
        {/* Panel 1: Hydrological Drought Status */}
        <section className="hydro-panel">
          <div className="hydro-panel-head">
            <span className="hydro-panel-title">Hydrological Drought Status – {districtName}</span>
          </div>

          <div className="hydro-status-wrap">
            <div className="hydro-donut-gauge">
              <svg viewBox="0 0 120 120" style={{ width: '100%', height: '100%', transform: 'rotate(-90deg)' }}>
                <circle cx="60" cy="60" r="46" fill="none" stroke="#102f44" strokeWidth="12" />
                <circle
                  cx="60"
                  cy="60"
                  r="46"
                  fill="none"
                  stroke={m?.ssi <= -1.3 ? '#ef4444' : m?.ssi <= -0.5 ? '#f59e0b' : '#38bdf8'}
                  strokeWidth="12"
                  strokeDasharray="289"
                  strokeDashoffset={Math.max(50, Math.min(260, 160 - (m?.ssi || 0) * 45))}
                  strokeLinecap="round"
                />
              </svg>
              <div className="hydro-gauge-text">
                <span className="gauge-tag">SSI</span>
                <span className="gauge-val">{m?.ssi != null ? m.ssi.toFixed(2) : '—'}</span>
                <span className="gauge-cond">({droughtStatus?.condition || 'Normal'})</span>
              </div>
            </div>

            <div className="hydro-status-info">
              <div className="hydro-info-row">
                <small>Current Status</small>
                <strong>
                  <i className="dot gold" style={{ background: droughtStatus?.status?.includes('Drought') ? '#f59e0b' : '#38bdf8' }} />
                  {droughtStatus?.status || 'Normal'}
                </strong>
              </div>
              <div className="hydro-info-row">
                <small>Trend</small>
                <strong className={droughtStatus?.trend === 'Worsening' ? 'worsening' : ''}>
                  {droughtStatus?.trend === 'Worsening' ? <ArrowDown size={14} /> : <ArrowUp size={14} />}
                  {droughtStatus?.trend || 'Stable'}
                </strong>
              </div>
              <div className="hydro-info-row">
                <small>Confidence</small>
                <strong>
                  <i className="dot gold" /> High (CSV Derived)
                </strong>
              </div>
            </div>
          </div>
        </section>

        {/* Panel 2: Groundwater strictly from CSV */}
        <section className="hydro-panel">
          <div className="hydro-panel-head">
            <span className="hydro-panel-title">Groundwater – {districtName}</span>
          </div>

          <div className="hydro-dual-subgrid">
            {/* Sub-card: Borehole Water Level */}
            <div className="hydro-sub-box">
              <div className="hydro-sub-box-head">
                <span className="sub-label">Borehole Water Level</span>
                <div className="sub-val-row">
                  <span className="sub-val">{formatMetric(m?.borehole)} m bgl</span>
                  {m?.borehole_change != null && (
                    <span className={`sub-delta ${m.borehole_change >= 0 ? 'green' : 'red'}`}>
                      {m.borehole_change >= 0 ? <ArrowUp size={10} /> : <ArrowDown size={10} />}
                      {m.borehole_change >= 0 ? '+' : ''}{m.borehole_change.toFixed(1)}%
                    </span>
                  )}
                </div>
                <small style={{ fontSize: '8.5px', color: '#688fa5' }}>(vs. last month)</small>
              </div>

                <div className="hydro-spark-chart" key={`gw-${selectedDistrict}-${selectedDate || latestDate}`}>
                  {renderSparkline(historyData?.groundwater_6m, '#38bdf8')}
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '7px', color: '#648da4', marginTop: '2px' }}>
                  {historyData?.groundwater_6m?.map((g, i) => (
                    <span key={i}>{g.month}</span>
                  ))}
                </div>
              </div>
            </div>

            {/* Sub-card: SGI (Groundwater) */}
            <div className="hydro-sub-box">
              <div className="hydro-sub-box-head">
                <span className="sub-label">SGI (Groundwater)</span>
                <div className="sub-val-row">
                  <span className="sub-val">{m?.sgi != null ? m.sgi.toFixed(2) : '—'}</span>
                  {m?.sgi_change != null && (
                    <span className={`sub-delta ${m.sgi_change >= 0 ? 'green' : 'red'}`}>
                      {m.sgi_change >= 0 ? <ArrowUp size={10} /> : <ArrowDown size={10} />}
                      {m.sgi_change >= 0 ? '+' : ''}{m.sgi_change.toFixed(1)}%
                    </span>
                  )}
                </div>
                <small style={{ fontSize: '8.5px', color: '#688fa5' }}>(vs. last month)</small>
              </div>

              <div className="hydro-spark-chart" key={`sgi-${selectedDistrict}-${selectedDate || latestDate}`}>
                {renderSparkline(historyData?.sgi_6m, '#06b6d4')}
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '7px', color: '#648da4', marginTop: '2px' }}>
                  {historyData?.sgi_6m?.map((s, i) => (
                    <span key={i}>{s.month}</span>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Panel 3: Runoff & Baseflow strictly from CSV */}
        <section className="hydro-panel">
          <div className="hydro-panel-head">
            <span className="hydro-panel-title">Runoff &amp; Baseflow – {districtName}</span>
          </div>

          <div className="hydro-dual-subgrid">
            {/* Sub-card: Surface Runoff */}
            <div className="hydro-sub-box">
              <div className="hydro-sub-box-head">
                <span className="sub-label">Surface Runoff</span>
                <div className="sub-val-row">
                  <span className="sub-val">{formatMetric(m?.surface_runoff)} m³/s</span>
                  {m?.runoff_change != null && (
                    <span className={`sub-delta ${m.runoff_change < 0 ? 'red' : 'green'}`}>
                      {m.runoff_change < 0 ? <ArrowDown size={10} /> : <ArrowUp size={10} />}
                      {Math.abs(m.runoff_change).toFixed(1)}%
                    </span>
                  )}
                </div>
              </div>

              <div className="hydro-spark-chart" key={`runoff-${selectedDistrict}-${selectedDate || latestDate}`}>
                {renderSparkline(historyData?.runoff_6m, '#38bdf8')}
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '7px', color: '#648da4', marginTop: '2px' }}>
                  {historyData?.runoff_6m?.map((r, i) => (
                    <span key={i}>{r.month}</span>
                  ))}
                </div>
              </div>
            </div>

            {/* Sub-card: Baseflow */}
            <div className="hydro-sub-box">
              <div className="hydro-sub-box-head">
                <span className="sub-label">Baseflow</span>
                <div className="sub-val-row">
                  <span className="sub-val">{formatMetric(m?.baseflow)} m³/s</span>
                  {m?.baseflow_change != null && (
                    <span className={`sub-delta ${m.baseflow_change < 0 ? 'red' : 'green'}`}>
                      {m.baseflow_change < 0 ? <ArrowDown size={10} /> : <ArrowUp size={10} />}
                      {Math.abs(m.baseflow_change).toFixed(1)}%
                    </span>
                  )}
                </div>
              </div>

              <div className="hydro-spark-chart" key={`baseflow-${selectedDistrict}-${selectedDate || latestDate}`}>
                {renderSparkline(historyData?.baseflow_6m, '#06b6d4')}
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '7px', color: '#648da4', marginTop: '2px' }}>
                  {historyData?.baseflow_6m?.map((b, i) => (
                    <span key={i}>{b.month}</span>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </section>
      </div>

      {/* ---------------- 5. Row 3: Variables Table + Key Insights + Recommendations ---------------- */}
      <div className="hydro-grid-row">
        {/* Panel 1: Complete Hydrological Variables Table strictly from CSV */}
        <section className="hydro-panel">
          <div className="hydro-panel-head">
            <span className="hydro-panel-title">Hydrological Variables – {districtName}</span>
          </div>

          <div className="hydro-table-shell">
            <table className="hydro-table">
              <thead>
                <tr>
                  <th>Variable</th>
                  <th>Value (from CSV)</th>
                  <th>Unit</th>
                  <th>Trend</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {(historyData?.variables_table || []).map((row) => (
                  <tr key={row.variable}>
                    <td style={{ color: '#dbeafe', fontWeight: '500' }}>{row.variable}</td>
                    <td style={{ fontWeight: '700' }}>{formatMetric(row.value)}</td>
                    <td style={{ color: '#88afc5', fontSize: '9.5px' }}>{row.unit}</td>
                    <td style={{ color: row.trend.includes('↑') ? '#34d399' : row.trend.includes('↓') ? '#f87171' : '#94a3b8', fontWeight: '600' }}>
                      {row.trend}
                    </td>
                    <td>
                      <span className={`hydro-tag-pill ${row.tone}`}>
                        {row.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* Panel 2: Key Insights strictly generated from CSV observations */}
        <section className="hydro-panel">
          <div className="hydro-panel-head">
            <span className="hydro-panel-title">Key Insights – {districtName}</span>
          </div>

          <div className="hydro-insights-list">
            {(historyData?.insights || []).map((ins, i) => (
              <div key={i} className={`hydro-insight-item ${ins.type}`}>
                {ins.type === 'danger' ? (
                  <AlertTriangle size={17} style={{ color: '#ef4444', flexShrink: 0 }} />
                ) : ins.type === 'warning' ? (
                  <AlertCircle size={17} style={{ color: '#f59e0b', flexShrink: 0 }} />
                ) : (
                  <Info size={17} style={{ color: '#38bdf8', flexShrink: 0 }} />
                )}
                <span>{ins.text}</span>
              </div>
            ))}
          </div>
        </section>

        {/* Panel 3: Recommendations derived from district state */}
        <section className="hydro-panel">
          <div className="hydro-panel-head">
            <span className="hydro-panel-title">Recommendations</span>
          </div>

          <div className="hydro-recom-list">
            {(historyData?.recommendations || []).map((rec, i) => (
              <div key={i} className="hydro-recom-item">
                <CheckCircle2 size={16} className="check-icon" />
                <span>{rec.text}</span>
              </div>
            ))}
          </div>

          <button
            type="button"
            className="hydro-btn-report"
            onClick={() => alert(`Operational hydrological report exported for ${districtName} (${selectedDate}) from csv's/hydrology.csv.`)}
          >
            Export CSV Report <ChevronRight size={14} />
          </button>
        </section>
      </div>

      {/* ---------------- 6. Footer Status Bar ---------------- */}
      <footer className="hydro-footer-strip">
        <div className="hydro-footer-links">
          <strong>NIWIS v1.0</strong>
          <span>|</span>
          <span>Hydrological Drought Intelligence</span>
          <span>|</span>
          <span>52 Districts &amp; Municipalities</span>
          <span>|</span>
          <span>Live Data: csv's/hydrology.csv</span>
          <span>|</span>
          <span>Data-driven Decisions for a Water Secure South Africa</span>
        </div>

        <div className="hydro-system-online">
          <i className="online-dot" />
          <span>System Online</span>
        </div>
      </footer>
    </div>
  )
}
