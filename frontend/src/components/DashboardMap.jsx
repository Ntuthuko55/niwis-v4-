import { lazy, Suspense, useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { loadBasemapConfig } from '../services/basemapConfig'
import { mapViews, saveMapView } from '../services/dashboardMapState'
import '../niwis/dashboard-map.css'

const EMPTY = []
const InteractiveDashboardMap = lazy(() => import('./InteractiveDashboardMap'))
const defaultLabel = feature => feature?.properties?.shapeName || feature?.properties?.MUNICNAME || feature?.properties?.DISTRICT_N || feature?.properties?.province || feature?.properties?.name || 'Map area'

/** Add map choices while preserving the dashboard's original map as an option. */
export default function DashboardMap({
  original, features = EMPTY, featureStyle, featureLabel = defaultLabel,
  onFeatureSelect, onFeatureHover, selectedFeature, markers = EMPTY,
  mapLabel = 'Dashboard map', mapId, height = 430, onViewChange, className = '', fixedView,
}) {
  const stateKey = `${window.location.pathname}:${mapId || mapLabel}`
  const [view, setView] = useState(() => fixedView || mapViews.get(stateKey)?.view || 'boundaries')
  const activeView = fixedView || view
  const [config, setConfig] = useState(null)
  const [configError, setConfigError] = useState('')
  const [configRetry, setConfigRetry] = useState(0)
  useEffect(() => {
    if (fixedView) return undefined
    let active = true
    loadBasemapConfig({ refresh: configRetry > 0 }).then(value => {
      if (active) {
        setConfig(value)
        setConfigError('')
        if (!value.configured) setView(current => {
          if (current !== 'satellite') return current
          saveMapView(stateKey, { view: 'boundaries' })
          return 'boundaries'
        })
      }
    }).catch(error => { if (active) setConfigError(error.message) })
    return () => { active = false }
  }, [configRetry, fixedView])
  const changeView = event => {
    setView(event.target.value)
    saveMapView(stateKey, { view: event.target.value })
    onViewChange?.(event.target.value)
  }
  return <div className={`dashboard-map dashboard-map--${activeView} ${className}`.trim()} style={{ '--dashboard-map-height': typeof height === 'number' ? `${height}px` : height }}>
    {!fixedView && <div className="dashboard-map-toolbar">
      <label className="dashboard-map-choice"><span>Map view</span><select aria-label="Map view" value={view} onChange={changeView}>
        <option value="existing">Standard map</option>
        <option value="satellite" disabled={!config?.configured}>Satellite</option>
        <option value="streets">Street map</option>
        <option value="boundaries">Interactive boundaries</option>
      </select></label>
      {!config?.configured && <span className="dashboard-map-availability">{configError ? 'Background service unavailable' : config ? 'Satellite unavailable' : 'Checking backgrounds…'}</span>}
      {configError && <button type="button" className="dashboard-map-config-retry" onClick={() => setConfigRetry(value => value + 1)} aria-label="Retry map background options"><RefreshCw size={13} /> Retry</button>}
    </div>}
    {activeView === 'existing' ? <div className="dashboard-map-original">{original}</div> : <Suspense fallback={<div className="dashboard-map-loading" role="status">Loading interactive map...</div>}><InteractiveDashboardMap
      view={activeView} config={config} features={features} featureStyle={featureStyle} featureLabel={featureLabel}
      onFeatureSelect={onFeatureSelect} onFeatureHover={onFeatureHover} selectedFeature={selectedFeature}
      markers={markers} mapLabel={mapLabel} stateKey={stateKey}
    /></Suspense>}
  </div>
}
