import { useCallback, useEffect, useRef, useState } from 'react';
import { GeoJSON, MapContainer, ScaleControl, TileLayer, useMap, useMapEvents, ZoomControl } from 'react-leaflet';
import L, { type PathOptions } from 'leaflet';
import type { Feature, FeatureCollection } from 'geojson';
import { CircleAlert, LocateFixed, Maximize2, Plus } from 'lucide-react';
import type { LayerId, LayerState, SelectedFeature, VectorLayer, Viewport } from './types';
import { fetchJson } from './api';

interface Props {
  provinces: FeatureCollection | null;
  province: string;
  enabled: Record<LayerId, boolean>;
  layers: Partial<Record<VectorLayer, LayerState>>;
  onViewport: (viewport: Viewport) => void;
  onSelect: (selection: SelectedFeature) => void;
  retry: number;
}

type Basemap = 'satellite' | 'streets' | 'local';

const vectorLayerIds: VectorLayer[] = ['districts', 'municipalities', 'wards', 'settlements', 'informal-settlements', 'roads', 'waterways', 'irrigation', 'waterpoints'];
const layerStyles: Record<VectorLayer, PathOptions> = {
  municipalities: { color: '#866da1', weight: 1.2, fillColor: '#866da1', fillOpacity: 0.025 },
  districts: { color: '#657ba6', weight: 1.7, fillColor: '#657ba6', fillOpacity: 0.025 },
  wards: { color: '#b66c65', weight: 0.8, fillColor: '#b66c65', fillOpacity: 0.035 },
  settlements: { color: '#c18d3a', weight: 0.55, fillColor: '#d9a64c', fillOpacity: 0.2 },
  'informal-settlements': { color: '#965b78', weight: 1.1, fillColor: '#c7759d', fillOpacity: 0.32 },
  roads: { color: '#b17c41', weight: 2, opacity: 0.9 },
  waterways: { color: '#3589ba', weight: 2.1, opacity: 0.9 },
  irrigation: { color: '#6d9857', weight: 1, fillColor: '#78a85e', fillOpacity: 0.85 },
  waterpoints: { color: '#168c91', weight: 1.2, fillColor: '#28b8b2', fillOpacity: 0.95 },
};

function MapControls({ provinces, province, onViewport }: Pick<Props, 'provinces' | 'province' | 'onViewport'>) {
  const map = useMap();
  const publish = useCallback(() => {
    const b = map.getBounds();
    const bounds: [number, number, number, number] = [Math.max(-180, b.getWest()), Math.max(-85, b.getSouth()), Math.min(180, b.getEast()), Math.min(85, b.getNorth())];
    const zoom = Math.floor(map.getZoom());
    onViewport({ bounds, zoom, key: `${bounds.map(n => n.toFixed(5)).join(',')}:${zoom}` });
  }, [map, onViewport]);
  useMapEvents({ moveend: publish, zoomend: publish });
  const fit = useCallback((all = false) => {
    map.invalidateSize({ pan: false });
    if (provinces) {
      const feature = all ? null : provinces.features.find(f => f.properties?.province_code === province);
      const bounds = L.geoJSON(feature || provinces).getBounds();
      if (bounds.isValid()) map.fitBounds(bounds, { padding: [24, 24], maxZoom: 9, animate: false });
    }
    publish();
  }, [province, provinces, map, publish]);
  useEffect(() => {
    const frame = requestAnimationFrame(() => fit());
    return () => cancelAnimationFrame(frame);
  }, [fit]);
  useEffect(() => {
    let frame = 0;
    let lastSize = '';
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      const size = `${Math.round(width)}:${Math.round(height)}`;
      if (!width || !height || lastSize === size) return;
      lastSize = size;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => map.invalidateSize({ pan: false }));
    });
    observer.observe(map.getContainer());
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, [map]);
  return <div className="map-extra-controls">
    <button title="Show all South Africa" aria-label="Show all South Africa" onClick={() => {
      if (provinces) fit(true);
      else map.setView([-29, 25], 5);
    }}><LocateFixed size={18} /></button>
    <button title="Expand map" aria-label="Expand map" onClick={() => {
      const shell = map.getContainer().closest('.map-shell');
      if (document.fullscreenElement) void document.exitFullscreen();
      else if (shell?.requestFullscreen) void shell.requestFullscreen().catch(() => {});
    }}><Maximize2 size={17} /></button>
  </div>;
}

export default function MapView(props: Props) {
  const [basemap, setBasemap] = useState<Basemap>('local');
  const [satelliteAvailable, setSatelliteAvailable] = useState(false);
  const [basemapLoading, setBasemapLoading] = useState(false);
  const [basemapFailed, setBasemapFailed] = useState(false);
  const [basemapPartial, setBasemapPartial] = useState(false);
  const [basemapRetry, setBasemapRetry] = useState(0);
  const [rasterFailed, setRasterFailed] = useState(false);
  const basemapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const basemapTiles = useRef({ loaded: 0, failed: 0 });
  const userSelectedBasemap = useRef(false);
  const checkBasemapTimeout = useCallback(() => {
    const { loaded, failed } = basemapTiles.current;
    setBasemapLoading(false);
    setBasemapFailed(loaded === 0);
    setBasemapPartial(loaded > 0 && failed > 0);
  }, []);
  const beginBasemapBatch = useCallback(() => {
    basemapTiles.current = { loaded: 0, failed: 0 };
    setBasemapLoading(true);
    setBasemapFailed(false);
    setBasemapPartial(false);
    if (basemapTimer.current) clearTimeout(basemapTimer.current);
    basemapTimer.current = setTimeout(checkBasemapTimeout, 15000);
  }, [checkBasemapTimeout]);
  const tileLoaded = useCallback(() => {
    basemapTiles.current.loaded += 1;
  }, []);
  const tileFailed = useCallback(() => {
    basemapTiles.current.failed += 1;
  }, []);
  const finishBasemapBatch = useCallback(() => {
    if (basemapTimer.current) clearTimeout(basemapTimer.current);
    basemapTimer.current = null;
    const { loaded, failed } = basemapTiles.current;
    setBasemapLoading(false);
    setBasemapFailed(loaded === 0 && failed > 0);
    setBasemapPartial(loaded > 0 && failed > 0);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    fetchJson<{ configured: boolean }>('/spatial-api/basemap/status', controller.signal).then(status => {
      if (controller.signal.aborted) return;
      setSatelliteAvailable(status.configured);
      if (!userSelectedBasemap.current) setBasemap(status.configured ? 'satellite' : 'streets');
    }).catch(() => { if (!controller.signal.aborted && !userSelectedBasemap.current) setBasemap('streets'); });
    return () => controller.abort();
  }, [props.retry]);
  useEffect(() => {
    setBasemapFailed(false);
    setBasemapPartial(false);
    setBasemapLoading(basemap !== 'local');
    if (basemap === 'local') return;
    basemapTiles.current = { loaded: 0, failed: 0 };
    const timer = setTimeout(checkBasemapTimeout, 15000);
    basemapTimer.current = timer;
    return () => {
      if (basemapTimer.current) clearTimeout(basemapTimer.current);
      basemapTimer.current = null;
    };
  }, [basemap, basemapRetry, props.retry, checkBasemapTimeout]);
  useEffect(() => { setRasterFailed(false); }, [props.enabled.landcover, props.retry]);
  const select = (layer: LayerId) => (feature: Feature, leafletLayer: L.Layer) => {
    leafletLayer.on('click', () => props.onSelect({ layer, feature }));
    const values = feature.properties || {};
    const label = values.province || values.MUNICNAME || values.DISTRICT_N || values.Municipali || values.INFORMAL_SETTLEMENTS_NAME || values.TOWN || values.scheme_nam || values.water_source || values.type || values.highway || values.name || values.fclass;
    if (label) {
      const span = document.createElement('span'); span.textContent = String(label);
      leafletLayer.bindTooltip(span, { sticky: true, className: 'spatial-map-tooltip' });
    }
  };
  return <div className="map-shell">
    <MapContainer center={[-29, 25]} zoom={5} zoomSnap={1} zoomDelta={1} minZoom={4} maxZoom={17} maxBounds={[[-47, 5], [-10, 45]]} maxBoundsViscosity={0.8} scrollWheelZoom zoomControl={false} preferCanvas attributionControl>
      {basemap !== 'local' && <TileLayer key={`${basemap}-${basemapRetry}-${props.retry}`} url={basemap === 'satellite' ? '/spatial-api/basemap/tiles/{z}/{x}/{y}.jpg' : '/spatial-api/basemap/streets/{z}/{x}/{y}.png'} keepBuffer={4} updateWhenZooming={false} attribution={basemap === 'satellite' ? '&copy; <a href="https://www.maptiler.com/copyright/">MapTiler</a> satellite imagery' : `${satelliteAvailable ? '&copy; <a href="https://www.maptiler.com/copyright/">MapTiler</a> ' : ''}&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors`} eventHandlers={{ loading: beginBasemapBatch, tileload: tileLoaded, tileerror: tileFailed, load: finishBasemapBatch }} />}
      {props.enabled.landcover && <TileLayer key={`landcover-${props.retry}`} url="/spatial-api/land-cover/tiles/{z}/{x}/{y}.png" opacity={0.65} maxNativeZoom={14} keepBuffer={4} updateWhenZooming={false} attribution="Land cover: DFFE / SANSA, 2022" eventHandlers={{ tileerror: () => setRasterFailed(true) }} />}
      {props.enabled.provinces && props.provinces && <GeoJSON data={props.provinces} style={{ color: '#267e79', weight: 1.8, fillColor: '#278f81', fillOpacity: 0.055 }} onEachFeature={select('provinces')} />}
      {vectorLayerIds.map(layer => {
        const data = props.layers[layer]?.data;
        if (!props.enabled[layer] || !data) return null;
        const radius = layer === 'waterpoints' ? 6 : 4;
        return <GeoJSON key={`${layer}-${props.layers[layer]?.key || 'local'}`} data={data} style={layerStyles[layer]} pointToLayer={(_feature, latlng) => L.circleMarker(latlng, { ...layerStyles[layer], radius })} onEachFeature={select(layer)} />;
      })}
      <MapControls provinces={props.provinces} province={props.province} onViewport={props.onViewport} />
      <ZoomControl position="bottomright" />
      <ScaleControl position="bottomleft" imperial={false} />
    </MapContainer>
    <div className="map-location-chip"><span className="live-dot" /> South Africa <span className="map-chip-divider" /> WGS 84</div>
    <label className="map-basemap-control"><span>Basemap</span><select aria-label="Select basemap" value={basemap} onChange={event => { userSelectedBasemap.current = true; setBasemap(event.target.value as Basemap); }}>
      {satelliteAvailable && <option value="satellite">Satellite</option>}
      <option value="streets">Street map</option><option value="local">Local boundaries</option>
    </select>{basemapLoading && <span className="basemap-loading" role="status">Loading…</span>}</label>
    <div className="north-arrow"><span>N</span><Plus size={24} strokeWidth={1.2} /><i /></div>
    {(basemapFailed || basemapPartial || rasterFailed) && <div className="map-error" role="status"><CircleAlert size={15} /><span>{rasterFailed ? 'Some land-cover tiles could not load. Refresh data to retry.' : basemapPartial ? `Some ${basemap === 'satellite' ? 'satellite' : 'street'} tiles could not load. The rest of the map remains available.` : `${basemap === 'satellite' ? 'Satellite' : 'Street'} basemap unavailable. Local boundaries and GIS layers still work.`}</span>{(basemapFailed || basemapPartial) && <button type="button" className="map-error-retry" onClick={() => setBasemapRetry(value => value + 1)}>Retry basemap</button>}</div>}
  </div>;
}
