import { useEffect, useRef, useState } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { LocateFixed, Maximize2 } from 'lucide-react'
import { basemapDefinition } from '../services/basemapConfig'
import { mapViews, saveMapView } from '../services/dashboardMapState'
import { PROVINCES } from './ProvinceMapLabels'

const SOUTH_AFRICA_BOUNDS = [[-37.5, 15], [-20, 35]]
const defaultLabel = feature => feature?.properties?.shapeName || feature?.properties?.MUNICNAME || feature?.properties?.DISTRICT_N || feature?.properties?.province || feature?.properties?.name || 'Map area'
const featureKey = feature => feature?.id ?? feature?.properties?.shapeID ?? feature?.properties?.CAT_B ?? feature?.properties?.province_code ?? feature?.properties?.shapeName ?? feature?.properties?.MUNICNAME ?? feature?.properties?.name

export default function InteractiveDashboardMap(props) {
  const host = useRef(null), shell = useRef(null), mapRef = useRef(null)
  const polygonRef = useRef(null), markerRef = useRef(null), fullBounds = useRef(null)
  const restoredViewport = useRef(null)
  const callbacks = useRef(props)
  callbacks.current = props
  const [ready, setReady] = useState(false)
  const [tileState, setTileState] = useState('idle')
  const [tileRetry, setTileRetry] = useState(0)
  const [mapError, setMapError] = useState('')

  const styleFor = feature => {
    const current = callbacks.current
    const supplied = current.featureStyle?.(feature) || {}
    const selected = current.selectedFeature && (current.selectedFeature === feature || (featureKey(feature) != null && featureKey(current.selectedFeature) === featureKey(feature)))
    return {
      color: '#85b5ca', weight: 1, fillColor: '#278eaa', fillOpacity: current.view === 'boundaries' ? 0.6 : 0.36,
      ...supplied,
      ...(current.view === 'boundaries' ? {} : { fillOpacity: Math.min(supplied.fillOpacity ?? 0.58, 0.58) }),
      ...(selected ? { color: 'var(--map-selection-stroke, #ffffff)', weight: Math.max(2.4, supplied.weight || 0) } : {}),
    }
  }

  useEffect(() => {
    if (!host.current) return undefined
    let map
    let frame = 0
    try {
      // Keep the current raster tiles visible during the zoom transition. The
      // replacement zoom level is requested after the animation completes.
      map = L.map(host.current, { zoomControl: false, attributionControl: true, minZoom: 4, maxZoom: 18, zoomSnap: 1, zoomDelta: 1, zoomAnimation: true, scrollWheelZoom: true, maxBounds: SOUTH_AFRICA_BOUNDS, maxBoundsViscosity: 0.8 })
      const savedState = mapViews.get(props.stateKey)
      const savedViewport = savedState?.viewport
      map.setView(savedViewport?.center || [-29, 25], savedViewport?.zoom ?? 5)
      restoredViewport.current = savedViewport ? savedState.extent : null
      map.on('moveend', () => {
        if (mapRef.current !== map) return
        const center = map.getCenter()
        saveMapView(callbacks.current.stateKey, { viewport: { center: [center.lat, center.lng], zoom: map.getZoom() } })
      })
      L.control.zoom({ position: 'bottomright' }).addTo(map)
      L.control.scale({ position: 'bottomleft', imperial: false }).addTo(map)
      map.createPane('dashboardMapLabels')
      map.getPane('dashboardMapLabels').style.pointerEvents = 'none'
      PROVINCES.forEach(([name, longitude, latitude]) => {
        const text = document.createElement('span')
        text.textContent = name
        const icon = L.divIcon({ className: 'dashboard-map-province-label', html: text, iconSize: [120, 18], iconAnchor: [60, 9] })
        L.marker([latitude, longitude], { icon, interactive: false, keyboard: false, pane: 'dashboardMapLabels' }).addTo(map)
      })
      mapRef.current = map
      setReady(true)
    } catch (error) {
      setMapError(error.message || 'The interactive map could not be initialized.')
      return undefined
    }
    const resize = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        if (mapRef.current !== map) return
        map.invalidateSize({ pan: false })
      })
    }
    // Older dashboard styles size every descendant SVG as a chart. Leaflet
    // needs the pixel dimensions it writes on its overlay renderer instead.
    const protectSvgSize = () => {
      map.getPanes().overlayPane.querySelectorAll('svg').forEach(svg => {
        const width = Number(svg.getAttribute('width')), height = Number(svg.getAttribute('height'))
        if (width > 0) svg.style.width = `${width}px`
        if (height > 0) svg.style.height = `${height}px`
      })
    }
    const vectorObserver = new MutationObserver(protectSvgSize)
    vectorObserver.observe(map.getPanes().overlayPane, { childList: true, subtree: true, attributes: true, attributeFilter: ['width', 'height'] })
    const observer = new ResizeObserver(resize)
    observer.observe(host.current)
    document.addEventListener('fullscreenchange', resize)
    resize()
    return () => {
      observer.disconnect()
      vectorObserver.disconnect()
      document.removeEventListener('fullscreenchange', resize)
      cancelAnimationFrame(frame)
      polygonRef.current = null
      markerRef.current = null
      mapRef.current = null
      fullBounds.current = null
      const center = map.getCenter()
      saveMapView(callbacks.current.stateKey, { viewport: { center: [center.lat, center.lng], zoom: map.getZoom() } })
      map.remove()
    }
  }, [])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return undefined
    const definition = basemapDefinition(props.view, props.config || {})
    if (!definition) { setTileState('idle'); return undefined }
    let active = true
    let timer
    let loadedTiles = 0
    let failedTiles = 0
    const tiles = L.tileLayer(definition.url, {
      attribution: definition.attribution,
      maxZoom: Math.min(definition.maxZoom, map.getMaxZoom()),
      // Leaflet's standard two-tile buffer supports panning without making an
      // oversized burst of provider requests that can delay the zoomed view.
      keepBuffer: 2,
      updateWhenIdle: true,
      updateWhenZooming: false,
    })
    const beginTileBatch = () => {
      loadedTiles = 0
      failedTiles = 0
      if (timer) clearTimeout(timer)
      setTileState('loading')
      timer = setTimeout(() => {
        if (!active) return
        setTileState(loadedTiles ? failedTiles ? 'partial' : 'loaded' : 'error')
      }, 15_000)
    }
    tiles.on('loading', beginTileBatch)
    tiles.on('tileload', () => { if (active) loadedTiles += 1 })
    tiles.on('tileerror', () => { if (active) failedTiles += 1 })
    tiles.on('load', () => {
      if (!active) return
      if (timer) clearTimeout(timer)
      setTileState(loadedTiles ? failedTiles ? 'partial' : 'loaded' : failedTiles ? 'error' : 'idle')
    })
    beginTileBatch()
    tiles.addTo(map)
    return () => { active = false; if (timer) clearTimeout(timer); tiles.off(); map.removeLayer(tiles) }
  }, [ready, props.view, props.config, tileRetry])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return undefined
    try {
      const polygons = L.geoJSON({ type: 'FeatureCollection', features: props.features.filter(feature => feature?.geometry) }, {
        style: styleFor,
        onEachFeature(feature, layer) {
          layer.on('click', () => callbacks.current.onFeatureSelect?.(feature))
          layer.on('mouseover', () => callbacks.current.onFeatureHover?.(feature))
          layer.on('mouseout', () => callbacks.current.onFeatureHover?.(null))
          layer.on('add', () => {
            const element = layer.getElement?.()
            if (element && callbacks.current.onFeatureSelect) {
              const key = featureKey(feature)
              const selectedKey = featureKey(callbacks.current.selectedFeature)
              element.setAttribute('tabindex', '0')
              element.setAttribute('role', 'button')
              element.setAttribute('aria-label', String(callbacks.current.featureLabel?.(feature) || defaultLabel(feature)))
              element.setAttribute('aria-pressed', String(key != null && selectedKey != null && selectedKey === key))
              L.DomEvent.on(element, 'focus', () => callbacks.current.onFeatureHover?.(feature))
              L.DomEvent.on(element, 'blur', () => callbacks.current.onFeatureHover?.(null))
              L.DomEvent.on(element, 'keydown', event => {
                if (event.key === 'Enter' || event.key === ' ') {
                  L.DomEvent.preventDefault(event)
                  L.DomEvent.stopPropagation(event)
                  callbacks.current.onFeatureSelect?.(feature)
                }
              })
            }
          })
        },
      }).addTo(map)
      polygonRef.current = polygons
      const bounds = polygons.getBounds()
      if (bounds.isValid()) {
        const changed = !fullBounds.current || !fullBounds.current.equals(bounds, 0.001)
        fullBounds.current = bounds
        const extent = bounds.toBBoxString()
        if (changed && restoredViewport.current !== extent) map.fitBounds(bounds, { padding: [22, 22], maxZoom: 9, animate: false })
        saveMapView(callbacks.current.stateKey, { extent })
        restoredViewport.current = null
      }
      setMapError('')
      return () => { polygonRef.current = null; polygons.off(); map.removeLayer(polygons) }
    } catch (error) {
      setMapError('The supplied map boundaries could not be displayed. Choose Standard map to continue.')
      return undefined
    }
  }, [ready, props.features])

  // Measurements, hover and selection can change without replacing source
  // geometry. Update styling and tooltip text without destroying map layers.
  useEffect(() => {
    const polygons = polygonRef.current
    if (!polygons) return
    polygons.setStyle(styleFor)
    polygons.eachLayer(layer => {
      const feature = layer.feature
      const text = document.createElement('span')
      text.textContent = String(props.featureLabel?.(feature) || defaultLabel(feature))
      if (layer.getTooltip()) layer.setTooltipContent(text)
      else layer.bindTooltip(text, { sticky: true, className: 'dashboard-map-tooltip' })
      const element = layer.getElement?.()
      if (element) {
        element.setAttribute('aria-label', text.textContent)
        element.setAttribute('aria-pressed', String(Boolean(props.selectedFeature && featureKey(feature) != null && featureKey(props.selectedFeature) === featureKey(feature))))
      }
    })
  })

  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return undefined
    const points = L.featureGroup()
    props.markers.forEach(marker => {
      const latitude = Number(marker.latitude), longitude = Number(marker.longitude)
      if (marker.latitude == null || marker.longitude == null || !Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return
      const point = L.circleMarker([latitude, longitude], { radius: marker.radius || 5, color: '#ffffff', weight: 1.1, fillColor: marker.color || '#32b9c0', fillOpacity: 0.95 })
      const text = document.createElement('span')
      text.textContent = marker.label || 'Source location'
      point.bindTooltip(text, { sticky: true, className: 'dashboard-map-tooltip' })
      if (marker.onSelect) {
        point.on('click', marker.onSelect)
        point.on('add', () => {
          const element = point.getElement()
          if (!element) return
          element.setAttribute('tabindex', '0')
          element.setAttribute('role', 'button')
          element.setAttribute('aria-label', text.textContent)
          L.DomEvent.on(element, 'keydown', event => {
            if (event.key === 'Enter' || event.key === ' ') {
              L.DomEvent.preventDefault(event)
              L.DomEvent.stopPropagation(event)
              marker.onSelect()
            }
          })
        })
      }
      point.addTo(points)
    })
    points.addTo(map)
    markerRef.current = points
    if (!fullBounds.current?.isValid() && points.getBounds().isValid()) {
      fullBounds.current = points.getBounds()
      const extent = fullBounds.current.toBBoxString()
      if (restoredViewport.current !== extent) map.fitBounds(fullBounds.current, { padding: [22, 22], maxZoom: 9, animate: false })
      saveMapView(callbacks.current.stateKey, { extent })
      restoredViewport.current = null
    }
    return () => { markerRef.current = null; points.clearLayers(); map.removeLayer(points) }
  }, [ready, props.markers])

  const reset = () => {
    const map = mapRef.current
    if (map && fullBounds.current?.isValid()) map.fitBounds(fullBounds.current, { padding: [22, 22], maxZoom: 9, animate: false })
  }
  const expand = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen()
      else await shell.current?.requestFullscreen()
    } catch { setMapError('This browser could not expand the map. You can continue using the map here.') }
  }
  return <div ref={shell} className={`dashboard-map-interactive dashboard-map-interactive--${props.view}`}>
    <div ref={host} className="dashboard-map-leaflet" role="region" aria-label={props.mapLabel} />
    <div className="dashboard-map-actions"><button type="button" onClick={reset} aria-label="Show all map areas" title="Show all map areas"><LocateFixed size={16} /></button><button type="button" onClick={expand} aria-label="Expand map" title="Expand map"><Maximize2 size={16} /></button></div>
    {tileState === 'loading' && <span className="dashboard-map-tile-status" role="status">Loading map background…</span>}
    {(tileState === 'error' || tileState === 'partial' || mapError) && <div className="dashboard-map-message" role="status"><span>{mapError || (tileState === 'partial' ? 'Some background tiles could not load. The rest of the map remains available.' : 'Map background unavailable. Your source areas and observations remain visible.')}</span>{(tileState === 'error' || tileState === 'partial') && <button type="button" onClick={() => setTileRetry(value => value + 1)}>Retry background</button>}</div>}
    {!props.features.length && !props.markers.length && !mapError && <div className="dashboard-map-message" role="status">No source geometry is available for this view.</div>}
  </div>
}
