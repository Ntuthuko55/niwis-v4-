import { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, ArrowDownToLine, ArrowRight, ArrowUpRight, Building2, Check, ChevronDown, ChevronRight, CircleAlert, CircleCheck, Compass, Database, Droplets, ExternalLink, FileSearch, FileWarning, FolderOpen, HardDrive, Info, Layers3, Leaf, LoaderCircle, Map, MapPin, Menu, Network, RefreshCw, Route, Search, ShieldCheck, SlidersHorizontal, Sprout, Waves, X } from 'lucide-react';
import type { FeatureCollection } from 'geojson';
import MapView from './MapView';
import { bytes, fetchJson, saveFile } from './api';
import type { Catalogue, Dataset, Indicator, LayerId, LayerState, Page, RasterLegend, SelectedFeature, VectorLayer, Viewport } from './types';

const number = new Intl.NumberFormat('en-ZA');
const emptyLayer: LayerState = { data: null, loading: false, error: null, message: null, key: '' };
const vectorLayerIds: VectorLayer[] = ['municipalities', 'districts', 'wards', 'settlements', 'informal-settlements', 'roads', 'waterways', 'waterpoints', 'irrigation'];
const minZoom: Record<VectorLayer, number> = { municipalities: 6, districts: 5, wards: 8, settlements: 8, 'informal-settlements': 8, roads: 10, waterways: 8, waterpoints: 5, irrigation: 5 };
const layerDetails: { id: LayerId; title: string; subtitle: string; icon: typeof Map; color: string }[] = [
  { id: 'provinces', title: 'Provincial boundaries', subtitle: '9 administrative areas', icon: Map, color: '#258477' },
  { id: 'districts', title: 'District boundaries', subtitle: '2026 MDB polygons', icon: Map, color: '#657ba6' },
  { id: 'municipalities', title: 'Municipal boundaries', subtitle: '2026 MDB polygons', icon: Map, color: '#866da1' },
  { id: 'wards', title: 'Ward boundaries', subtitle: '2026 MDB - zoom 8+', icon: Map, color: '#b66c65' },
  { id: 'settlements', title: 'Settlement extents', subtitle: 'GRID3 2024 - zoom 8+', icon: Building2, color: '#c18d3a' },
  { id: 'informal-settlements', title: 'Informal settlements', subtitle: 'DPME DHS - 2,088 polygons - zoom 8+', icon: Building2, color: '#965b78' },
  { id: 'waterpoints', title: 'Reported water points', subtitle: '15 WPdx records - historical', icon: Droplets, color: '#168c91' },
  { id: 'irrigation', title: 'Smallholder irrigation', subtitle: '310 Agriculture GIS points', icon: Sprout, color: '#6d9857' },
  { id: 'roads', title: 'Road network', subtitle: 'Explore at zoom 10+', icon: Route, color: '#b17c41' },
  { id: 'waterways', title: 'Rivers & waterways', subtitle: 'Explore at zoom 8+', icon: Waves, color: '#3589ba' },
  { id: 'landcover', title: 'Land cover - 2022', subtitle: 'Classified raster - all classes', icon: Sprout, color: '#73945b' },
];

function normalizeCatalogue(payload: unknown): Catalogue {
  const raw = payload && typeof payload === 'object' ? payload as Partial<Catalogue> : {};
  const size = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : 0;
  const datasets: Dataset[] = Array.isArray(raw.datasets) ? raw.datasets.map(item => ({
    ...item,
    id: item.id || 'unknown',
    title: item.title || 'Untitled dataset',
    description: item.description || '',
    status: item.status || 'missing',
    geometry: item.geometry || '',
    record_count: Number.isFinite(item.record_count) ? item.record_count : null,
    size_bytes: Number.isFinite(item.size_bytes) ? item.size_bytes : 0,
    source: item.source || '',
    vintage: item.vintage || '',
    issue: item.issue ?? null,
    map_layer: item.map_layer ?? null,
    files: Array.isArray(item.files) ? item.files : [],
    source_links: Array.isArray(item.source_links) ? item.source_links : [],
  })) : [];
  const indicators: Indicator[] = Array.isArray(raw.indicators) ? raw.indicators.map(item => ({
    ...item,
    id: item.id || 'unknown',
    title: item.title || 'Indicator',
    status: item.status || 'missing',
    description: item.description || '',
    missing: Array.isArray(item.missing) ? item.missing : [],
    sources: Array.isArray(item.sources) ? item.sources : [],
  })) : [];
  return {
    datasets,
    indicators,
    storage: {
      total_bytes: size(raw.storage?.total_bytes),
      working_bytes: size(raw.storage?.working_bytes),
      excluded_bytes: size(raw.storage?.excluded_bytes),
      file_count: size(raw.storage?.file_count),
    },
    verification: typeof raw.verification === 'string' ? raw.verification : 'Catalogue returned without verification details.',
  };
}

function useVectorLayers(enabled: Record<LayerId, boolean>, page: Page, viewport: Viewport | null, retry: number) {
  const [states, setStates] = useState<Partial<Record<VectorLayer, LayerState>>>({});
  const activeKey = page === 'explorer' ? vectorLayerIds.filter(layer => enabled[layer]).join(',') : '';
  useEffect(() => {
    const active = activeKey ? activeKey.split(',') as VectorLayer[] : [];
    const initial: Partial<Record<VectorLayer, LayerState>> = {};
    for (const layer of active) initial[layer] = viewport && viewport.zoom >= minZoom[layer]
      ? { ...emptyLayer, loading: true }
      : { ...emptyLayer, message: `Zoom in to level ${minZoom[layer]} to explore ${layer}.` };
    setStates(initial);
    if (!viewport || !active.length) return;
    // Query only the South African source extent, including a border margin.
    // A wide or fullscreen map can otherwise exceed bounded API query sizes.
    const bounds = [Math.max(15, viewport.bounds[0]), Math.max(-36, viewport.bounds[1]), Math.min(34, viewport.bounds[2]), Math.min(-21, viewport.bounds[3])];
    if (bounds[0] >= bounds[2] || bounds[1] >= bounds[3]) {
      setStates(Object.fromEntries(active.map(layer => [layer, { ...emptyLayer, message: 'Move the map back to South Africa to explore this source.' }])));
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      const visible = active.filter(layer => viewport.zoom >= minZoom[layer]);
      visible.forEach(async layer => {
        try {
          const data = await fetchJson<LayerState['data']>(`/spatial-api/layers/${layer}/features?bbox=${bounds.join(',')}&zoom=${viewport.zoom}&limit=1200`, controller.signal);
          if (!data || data.type !== 'FeatureCollection' || !Array.isArray(data.features) || (data.metadata?.returned != null && data.metadata.returned !== data.features.length)) {
            throw new Error('The spatial service returned incomplete map geometry. Refresh data to retry.');
          }
          if (!controller.signal.aborted) setStates(current => ({ ...current, [layer]: { data, loading: false, error: null, message: data.metadata?.message || null, key: viewport.key } }));
        } catch (error) {
          if (!controller.signal.aborted) setStates(current => ({ ...current, [layer]: { ...emptyLayer, error: error instanceof Error ? error.message : 'Could not load this layer.' } }));
        }
      });
    }, 300);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [activeKey, page, viewport?.key, retry]);
  return states;
}

function StatusBadge({ status }: { status: Dataset['status'] | 'ready' }) {
  return <span className={`status-badge ${status}`}><span />{status === 'available' ? 'Map ready' : status === 'partial' ? 'Needs data' : status === 'excluded' ? 'Excluded' : status === 'ready' ? 'Ready' : 'Missing'}</span>;
}

function App() {
  const [page, setPage] = useState<Page>('explorer');
  const [menuOpen, setMenuOpen] = useState(false);
  const [catalogue, setCatalogue] = useState<Catalogue | null>(null);
  const [provinces, setProvinces] = useState<FeatureCollection | null>(null);
  const [catalogueError, setCatalogueError] = useState<string | null>(null);
  const [provinceError, setProvinceError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  const [province, setProvince] = useState('all');
  const [viewport, setViewport] = useState<Viewport | null>(null);
  const [enabled, setEnabled] = useState<Record<LayerId, boolean>>({ provinces: true, municipalities: false, districts: true, wards: false, settlements: false, 'informal-settlements': false, roads: false, waterways: false, waterpoints: false, irrigation: false, landcover: false });
  const [selected, setSelected] = useState<SelectedFeature | null>(null);
  const [legend, setLegend] = useState<RasterLegend | null>(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [toast, setToast] = useState<string | null>(null);
  const vectorLayers = useVectorLayers(enabled, page, viewport, retry);

  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setCatalogueError(null); setProvinceError(null);
    Promise.allSettled([
      fetchJson<unknown>('/spatial-api/catalog', controller.signal).then(payload => setCatalogue(normalizeCatalogue(payload))).catch(e => { if (!controller.signal.aborted) setCatalogueError(e.message); }),
      fetchJson<FeatureCollection>('/spatial-api/provinces', controller.signal).then(setProvinces).catch(e => { if (!controller.signal.aborted) setProvinceError(e.message); }),
    ]).then(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [retry]);
  useEffect(() => {
    if (!enabled.landcover || legend) return;
    const controller = new AbortController();
    fetchJson<RasterLegend>('/spatial-api/land-cover/legend', controller.signal).then(setLegend).catch(() => {});
    return () => controller.abort();
  }, [enabled.landcover, legend]);
  useEffect(() => { if (toast) { const t = setTimeout(() => setToast(null), 4500); return () => clearTimeout(t); } }, [toast]);

  const navigate = (next: Page) => { setPage(next); setMenuOpen(false); setSelected(null); };
  const dataset = (id: string) => catalogue?.datasets.find(d => d.id === id);
  const activeCount = Object.values(enabled).filter(Boolean).length;
  const mapReady = catalogue?.datasets.filter(d => d.map_layer && d.status !== 'missing' && d.status !== 'excluded').length || 0;
  const visibleFeatureCount = (enabled.provinces ? provinces?.features.length || 0 : 0) + vectorLayerIds.reduce((count, layer) => count + (enabled[layer] ? vectorLayers[layer]?.data?.features.length || 0 : 0), 0);
  const changedViewport = useCallback((next: Viewport) => setViewport(old => old?.key === next.key ? old : next), []);
  const filtered = useMemo(() => catalogue?.datasets.filter(d => (filter === 'all' || d.status === filter) && `${d.title} ${d.source} ${d.description}`.toLowerCase().includes(search.toLowerCase())) || [], [catalogue, search, filter]);

  function exportFeatures() {
    const collections = [enabled.provinces ? provinces : null, ...vectorLayerIds.filter(layer => enabled[layer]).map(layer => vectorLayers[layer]?.data || null)].filter(Boolean);
    const features = collections.flatMap(c => c!.features);
    if (!features.length) { setToast('Enable a vector layer and load features before exporting.'); return; }
    const output = {
      type: 'FeatureCollection', features,
      metadata: { exported_at: new Date().toISOString(), description: 'Loaded display features only. Viewport layers may be generalized, simplified or capped. Raster not included.', viewport: viewport?.bounds, layers: Object.fromEntries(vectorLayerIds.map(layer => [layer, vectorLayers[layer]?.data?.metadata])) },
    };
    saveFile('niwis-spatial-loaded-display-features.geojson', JSON.stringify(output), 'application/geo+json');
    setToast(`Exported ${number.format(features.length)} loaded vector features. Raster is not included.`);
  }

  function exportCatalogue() {
    if (!catalogue) return;
    const escape = (v: unknown) => `"${String(v ?? '').replaceAll('"', '""')}"`;
    const lines = [['Dataset', 'Status', 'Records', 'Bytes', 'Source', 'Vintage', 'Issue'].map(escape).join(','), ...catalogue.datasets.map(d => [d.title, d.status, d.record_count, d.size_bytes, d.source, d.vintage, d.issue].map(escape).join(','))];
    saveFile('niwis-spatial-dataset-catalogue.csv', '\uFEFF' + lines.join('\r\n'), 'text/csv;charset=utf-8');
    setToast('Dataset catalogue exported.');
  }

  return <div className="app-shell">
    {menuOpen && <button className="sidebar-backdrop" aria-label="Close navigation" onClick={() => setMenuOpen(false)} />}
    <aside className={`sidebar ${menuOpen ? 'open' : ''}`}>
      <a className="brand" href="#" onClick={e => { e.preventDefault(); navigate('explorer'); }} aria-label="NIWIS Spatial Intelligence home"><span className="brand-mark"><Layers3 size={26} strokeWidth={1.5} /></span><span>NIWIS<small>SPATIAL INTELLIGENCE</small></span></a>
      <div className="workspace-label"><span className="live-dot" /> NIWIS spatial workspace</div>
      <div className="nav-section-label">WORKSPACE</div>
      <nav aria-label="Main navigation">
        {([{ id: 'explorer', label: 'Map explorer', icon: Compass }, { id: 'catalogue', label: 'Data catalogue', icon: Database }, { id: 'readiness', label: 'Data readiness', icon: ShieldCheck }] as const).map(item => <button key={item.id} className={`nav-item ${page === item.id ? 'active' : ''}`} aria-current={page === item.id ? 'page' : undefined} onClick={() => navigate(item.id)}><item.icon size={19} /><span>{item.label}</span>{page === item.id && <ChevronRight size={15} />}</button>)}
      </nav>
      <div className="sidebar-focus"><div className="nav-section-label">OUR FOCUS</div><div className="focus-icon"><Droplets size={21} /></div><h3>Water access,<br />with context.</h3><p>Connect places, infrastructure and the landscapes around them.</p><span className="section-tag">SECTION 20.3 <ArrowUpRight size={13} /></span></div>
      <div className="sidebar-bottom"><div className="storage-head"><HardDrive size={16} /><span>Local data workspace</span></div><div className="storage-number">{catalogue ? bytes(catalogue.storage.working_bytes) : '—'}<span>working set</span></div><div className="storage-track"><span /></div><p>{catalogue ? `${bytes(catalogue.storage.excluded_bytes)} oversized export excluded` : 'Source files stay on this computer'}</p><div className="sidebar-foot"><span className="local-icon" /><span>LOCAL DEVELOPMENT</span><span>v0.1</span></div></div>
    </aside>

    <div className="main-shell">
      <header className="topbar"><div className="breadcrumb"><button className="mobile-menu icon-button" aria-label="Open navigation" onClick={() => setMenuOpen(true)}><Menu size={21} /></button><span>Workspace</span><ChevronRight size={13} /><strong>{page === 'explorer' ? 'Map explorer' : page === 'catalogue' ? 'Data catalogue' : 'Data readiness'}</strong></div><div className="topbar-right"><span className={`connection-status ${catalogueError ? 'offline' : ''}`}><span />{catalogueError ? 'API unavailable' : loading ? 'Connecting' : 'Local API connected'}</span><div className="topbar-divider" /><span className="country-badge">ZA</span><span className="country-name">South Africa</span></div></header>
      <main>
        <section className="page-intro"><div><div className="eyebrow"><span />SPATIAL GIS VARIABLES <span className="eyebrow-slash">/</span> 20.3</div><h1>{page === 'explorer' ? <>A clearer view of <span>water access.</span></> : page === 'catalogue' ? <>Know the data <span>behind the map.</span></> : <>Good decisions start with <span>good data.</span></>}</h1><p>{page === 'explorer' ? 'Explore South Africa’s places, networks and natural resources in the NIWIS spatial workspace.' : page === 'catalogue' ? 'A transparent inventory of your source files, their coverage and their limitations.' : 'See what supports each indicator today, and exactly what is still needed.'}</p></div><div className="intro-actions"><button className="button secondary" onClick={() => setRetry(v => v + 1)} disabled={loading}><RefreshCw size={15} className={loading ? 'spin' : ''} />Refresh data</button><button className="button primary" disabled={!catalogue} onClick={page === 'explorer' ? exportFeatures : exportCatalogue}><ArrowDownToLine size={16} />{page === 'explorer' ? 'Export loaded features' : 'Export catalogue'}</button></div></section>

        {catalogueError && <div className="error-banner" role="alert"><CircleAlert size={20} /><div><strong>Could not connect to the GIS API</strong><p>{catalogueError}. Start the FastAPI backend on port 8010, then retry.</p></div><button className="button secondary" onClick={() => setRetry(v => v + 1)}>Retry connection</button></div>}

        <section className="metric-grid" aria-label="Dataset overview">
          <Metric icon={Layers3} label="Map-ready layers" value={catalogue ? String(mapReady).padStart(2, '0') : '—'} detail="From your local source files" color="teal" />
          <Metric icon={Map} label="Provinces mapped" value={dataset('provinces')?.record_count != null ? String(dataset('provinces')!.record_count).padStart(2, '0') : '—'} detail="Administrative boundaries" color="blue" />
          <Metric icon={Route} label="Road-related features" value={dataset('roads')?.record_count != null ? `${(dataset('roads')!.record_count! / 1e6).toFixed(2)}m` : '—'} detail="OSM inventory · mixed geometry" color="amber" />
          <Metric icon={Waves} label="Waterway features" value={dataset('waterways')?.record_count != null ? number.format(dataset('waterways')!.record_count!) : '—'} detail="Rivers, streams, canals & drains" color="blue" />
        </section>

        {page === 'explorer' && <>
          <section className="explorer-card">
            <div className="explorer-toolbar"><div className="panel-title"><span className="panel-icon"><Map size={18} /></span><div><h2>Explore the landscape</h2><span>Local source layers · interactive map</span></div></div><div className="map-toolbar-actions"><label className="province-select"><MapPin size={15} /><select aria-label="Select province" value={province} onChange={e => { setProvince(e.target.value); setSelected(null); }}><option value="all">All provinces</option>{provinces?.features.map(f => <option key={f.properties?.province_code} value={f.properties?.province_code}>{f.properties?.province}</option>)}</select><ChevronDown size={13} /></label><span className="active-layer-count"><Layers3 size={14} />{activeCount} active</span></div></div>
            <div className="map-workspace"><MapView provinces={provinces} province={province} enabled={enabled} layers={vectorLayers} onViewport={changedViewport} onSelect={setSelected} retry={retry} />
              <aside className="layer-panel"><div className="layer-panel-heading"><h3>{selected ? 'Feature details' : 'Map layers'}</h3>{selected ? <button className="icon-button" aria-label="Close feature details" onClick={() => setSelected(null)}><X size={16} /></button> : <SlidersHorizontal size={16} />}</div>
                {selected ? <FeatureInspector selected={selected} catalogue={catalogue} /> : <><p className="panel-hint">Build your view with the available layers.</p><div className="layer-list">{layerDetails.map(layer => {
                  const source = catalogue?.datasets.find(d => d.map_layer === layer.id);
                  const unavailable = !!catalogue && (!source || source.status === 'missing' || source.status === 'excluded');
                  return <label className={`layer-toggle ${enabled[layer.id] ? 'enabled' : ''} ${unavailable ? 'disabled' : ''}`} key={layer.id}><span className="layer-icon" style={{ color: layer.color }}><layer.icon size={19} /></span><span className="layer-text"><strong>{layer.title}</strong><small>{unavailable ? 'Source unavailable' : layer.subtitle}</small></span><input type="checkbox" checked={enabled[layer.id]} disabled={unavailable} onChange={e => setEnabled(v => ({ ...v, [layer.id]: e.target.checked }))} /><span className="toggle-track" /></label>;
                })}</div><div className="legend"><h4>MAP LEGEND</h4>{layerDetails.filter(layer => enabled[layer.id]).map(layer => <div key={layer.id}><span className={`legend-swatch ${layer.id === 'provinces' ? 'area' : ''}`} style={{ backgroundColor: layer.color }} /><span>{layer.title}</span></div>)}</div>
                {enabled.landcover && <div className="raster-note"><Leaf size={16} /><p>Source raster colours represent land-cover classes. Agricultural labels require the verified 2022 legend.</p>{legend?.items.length ? <div className="raster-colours">{legend.items.slice(0, 18).map(item => <span key={item.value} title={`${item.label} (${item.value})`} style={{ backgroundColor: item.color }} />)}</div> : null}</div>}
                <div className="missing-layers"><div><CircleAlert size={16} /><strong>Still needs verified coverage</strong></div><p>Official current water assets and DWS groundwater records are not yet in the local workspace. The 15 WPdx records are historical and partial.</p><button onClick={() => navigate('readiness')}>Review missing data <ArrowRight size={14} /></button></div></>}
              </aside>
            </div>
            <div className="map-statusbar"><div><span className={`status-dot ${Object.values(vectorLayers).some(state => state?.loading) ? 'busy' : ''}`} />{Object.values(vectorLayers).some(state => state?.loading) ? 'Loading features for this area…' : `${number.format(visibleFeatureCount)} loaded vector features`}</div><span>Zoom {viewport?.zoom ?? '—'}<span className="status-separator">·</span>Display features may be simplified</span></div>
          </section>
          {(provinceError || vectorLayerIds.some(layer => vectorLayers[layer]?.error)) && <div className="error-banner compact" role="alert"><CircleAlert size={17} /><p>{provinceError || vectorLayerIds.map(layer => vectorLayers[layer]?.error).find(Boolean)}</p><button onClick={() => setRetry(v => v + 1)}>Retry</button></div>}
          {vectorLayerIds.filter(layer => vectorLayers[layer]?.message || vectorLayers[layer]?.data?.metadata?.truncated).map(layer => <div className="map-notice" key={layer}><Info size={16} /><span><strong>{layerDetails.find(item => item.id === layer)?.title}:</strong> {vectorLayers[layer]?.data?.metadata?.truncated ? `Showing a bounded subset in this area. Zoom further in for more detail.` : vectorLayers[layer]?.message} {vectorLayers[layer]?.data?.metadata?.display_note}</span></div>)}
          <section className="context-grid"><div className="context-card"><span className="context-icon"><Network size={22} /></span><div><span className="card-eyebrow">DESIGNED FOR SPATIAL CONTEXT</span><h3>Understand the connections.</h3><p>Compare administrative areas, road access and natural waterways. Select a feature on the map to inspect its source attributes.</p></div></div><div className="context-card amber-card"><span className="context-icon"><FileWarning size={22} /></span><div><span className="card-eyebrow">KNOW WHAT THE DATA CAN TELL YOU</span><h3>A waterway is not a water point.</h3><p>The supplied “boreholes” export contains waterways. Water availability and settlement-to-source distances are not established.</p><button onClick={() => navigate('readiness')}>View indicator readiness <ArrowUpRight size={14} /></button></div></div></section>
        </>}

        {page === 'catalogue' && <section className="catalogue-card"><div className="catalogue-heading"><div><h2>Source catalogue <span>{catalogue?.datasets.length || 0}</span></h2><p>Geometry, provenance and readiness at a glance.</p></div><div className="catalogue-filters"><label className="search-input"><Search size={17} /><input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search datasets…" aria-label="Search datasets" />{search && <button aria-label="Clear search" onClick={() => setSearch('')}><X size={14} /></button>}</label><select className="status-select" aria-label="Filter by dataset status" value={filter} onChange={e => setFilter(e.target.value)}><option value="all">All statuses</option><option value="available">Map ready</option><option value="partial">Needs data</option><option value="missing">Missing</option><option value="excluded">Excluded</option></select></div></div><div className="dataset-list">{loading && !catalogue ? <div className="loading-state"><LoaderCircle className="spin" /> Loading source inventory…</div> : filtered.length ? filtered.map(d => <DatasetCard key={d.id} dataset={d} onExplore={() => { if (d.map_layer) setEnabled(v => ({ ...v, [d.map_layer!]: true })); navigate('explorer'); }} />) : <div className="empty-state"><FileSearch size={32} /><h3>No matching datasets</h3><p>Try a different name or status filter.</p><button className="button secondary" onClick={() => { setSearch(''); setFilter('all'); }}>Clear filters</button></div>}</div><div className="catalogue-foot"><Info size={15} /><p>Counts describe the audited source inventory. Missing or changed files are reported by the API. Source data stays outside the application build.</p></div></section>}

        {page === 'readiness' && <>
          <section className="readiness-intro"><div className="readiness-illustration"><ShieldCheck size={36} strokeWidth={1.4} /></div><div><span className="card-eyebrow">SIX INDICATORS. CLEAR REQUIREMENTS.</span><h2>See what is mapped and where to get the rest.</h2><p>Downloaded data now adds 2026 boundaries, GRID3 settlement extents, reported WPdx points and smallholder irrigation sites. Operational water assets and NGA groundwater records still need custodian verification.</p></div><span className="readiness-count">{catalogue?.indicators.filter(i => i.status !== 'ready').length ?? '?'}<small>indicators need<br />additional data</small></span></section>
          <div className="indicator-grid">{catalogue?.indicators.map((indicator, index) => <article className="indicator-card" key={indicator.id}><div className="indicator-heading"><span className="indicator-number">{String(index + 1).padStart(2, '0')}</span><StatusBadge status={indicator.status} /></div><h3>{indicator.title}</h3><p>{indicator.description}</p><div className="requirements"><h4>{indicator.missing.length ? 'STILL NEEDED' : 'AVAILABLE FOR ANALYSIS'}</h4>{indicator.missing.length ? <ul>{indicator.missing.map(item => <li key={item}><span /><span>{item}</span></li>)}</ul> : <p><Check size={15} /> Required spatial inputs are available.</p>}</div><div className="source-links readiness-source-links"><h4>WHERE TO GET THE DATA</h4>{indicator.sources.map(source => <div className="source-link-item" key={source.url + source.label}><a href={source.url} target="_blank" rel="noreferrer">{source.label}<ExternalLink size={13} /></a>{source.note && <p>{source.note}</p>}</div>)}</div></article>)}</div>
          <div className="supplier-note"><FolderOpen size={24} /><div><h3>Request custodian data where downloads are restricted.</h3><p>Ask DWS NGA for geosite coordinates, status, yield and water-quality dates; ask each Water Services Authority for a current public water-asset register and operational condition. The Data Readiness links explain which published layers are only context.</p></div><button className="button secondary" onClick={() => navigate('catalogue')}>Review downloaded files <ArrowRight size={15} /></button></div>
        </>}
        <footer className="page-footer"><span><Layers3 size={14} /> NIWIS Spatial Intelligence</span><span>South Africa <span>·</span> Section 20.3 <span>·</span> Local GIS workspace</span></footer>
      </main>
    </div>
    {toast && <div className="toast" role="status"><CircleCheck size={18} /><span>{toast}</span><button aria-label="Dismiss notification" onClick={() => setToast(null)}><X size={15} /></button></div>}
  </div>;
}

function Metric({ icon: Icon, label, value, detail, color }: { icon: typeof Map; label: string; value: string; detail: string; color: string }) {
  return <article className="metric"><div className="metric-top"><span>{label}</span><span className={`metric-icon ${color}`}><Icon size={18} /></span></div><strong>{value}</strong><p>{detail}</p></article>;
}

function DatasetCard({ dataset: d, onExplore }: { dataset: Dataset; onExplore: () => void }) {
  const [expanded, setExpanded] = useState(false);
  return <article className={`dataset-card ${d.status}`}><div className="dataset-main"><span className="dataset-icon">{d.status === 'excluded' ? <FileWarning size={22} /> : d.map_layer ? <Layers3 size={22} /> : <Database size={22} />}</span><div className="dataset-title"><h3>{d.title}</h3><p>{d.description}</p><div className="dataset-meta"><span>{d.record_count == null ? 'Records not available' : `${number.format(d.record_count)} records`}</span><span>{d.size_bytes ? bytes(d.size_bytes) : 'No source file'}</span><span>{d.geometry || 'Geometry unavailable'}</span></div></div><StatusBadge status={d.status} /><button className="icon-button" onClick={() => setExpanded(v => !v)} aria-label={`${expanded ? 'Hide' : 'Show'} details for ${d.title}`} aria-expanded={expanded}><ChevronDown size={18} className={expanded ? 'rotate' : ''} /></button></div>{expanded && <div className="dataset-expanded"><div><span>SOURCE</span><p>{d.source}</p></div><div><span>VINTAGE</span><p>{d.vintage || 'Not supplied'}</p></div>{d.issue && <div className="dataset-issue"><CircleAlert size={16} /><p>{d.issue}</p></div>}<div className="dataset-files"><span>FILES</span>{d.files.length ? d.files.map(file => <code key={file}>{file}</code>) : <p>Awaiting source dataset.</p>}</div>{d.source_links.length > 0 && <div className="catalogue-source-links"><span>SOURCE LINKS</span>{d.source_links.map(source => <a key={source.label} href={source.url} target="_blank" rel="noreferrer">{source.label}<ExternalLink size={13} /></a>)}</div>}{d.map_layer && d.status !== 'missing' && d.status !== 'excluded' && <button className="text-button" onClick={onExplore}>Explore this layer <ArrowUpRight size={15} /></button>}</div>}</article>;
}

function FeatureInspector({ selected, catalogue }: { selected: SelectedFeature; catalogue: Catalogue | null }) {
  const props = selected.feature.properties || {};
  const source = catalogue?.datasets.find(d => d.map_layer === selected.layer);
  const fields = Object.entries(props).filter(([key, value]) => value !== null && value !== '' && !/geometry|wkt/i.test(key));
  return <div className="feature-inspector"><span className="inspector-layer"><span />{layerDetails.find(l => l.id === selected.layer)?.title}</span><h3>{props.province || props.MUNICNAME || props.DISTRICT_N || props.scheme_nam || props.water_source || props.type || props.name || props.highway || props.fclass || 'Selected feature'}</h3><p className="feature-geometry">{selected.feature.geometry?.type}</p><dl>{fields.map(([key, value]) => <div key={key}><dt>{key.replaceAll('_', ' ')}</dt><dd>{typeof value === 'object' ? JSON.stringify(value) : String(value)}</dd></div>)}</dl><div className="inspector-source"><Info size={15} /><p>{source?.source || 'Local source dataset'}{source?.issue ? ` · ${source.issue}` : ''}</p></div></div>;
}

export default App;
