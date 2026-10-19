import { dashboardFetch as fetch } from '../services/dashboardFetch'
import React, { useEffect, useState } from 'react';
import {
  AlertTriangle, BarChart3, CheckCircle2, ChevronDown, Database, Download,
  FileText, History, Info, Layers3, Map, Play, RefreshCw, SlidersHorizontal, Sparkles, Upload, X
} from 'lucide-react';
import '../spatial.css';


const sample = { observations: 0, locations: 0, missing: 0, duplicates: 0, numeric: [], columns: [], analyses: [] };
const nav = [{ icon: Database, label: 'Data workspace', active: true }, { icon: Map, label: 'Spatial analysis' }, { icon: BarChart3, label: 'Results & maps' }, { icon: FileText, label: 'Reports' }];
const analysisCatalog = [
  ['moran_i', "Moran's I", 'Do similar values cluster together?'],
  ['geary_c', "Geary's C", 'Another measure of spatial clustering'],
  ['kriging', 'Kriging', 'Predict values at unmeasured locations'],
  ['kde', 'Kernel Density Estimation', 'Where are points most concentrated?'],
  ['hot_spots', 'Hot Spot Analysis', 'Find significant hot and cold spots'],
  ['spatial_regression', 'Spatial Regression', 'How do predictors explain the target?'],
  ['thiessen', 'Thiessen Polygons', 'Divide the area into nearest-point zones'],
  ['spatial_autocorrelation', 'Spatial Autocorrelation', 'Overall clustering summary'],
  ['ripley_k', "Ripley's K Function", 'Is the point pattern clustered or random?'],
  ['gwr', 'Geographically Weighted Regression', 'How do relationships vary across space?']
];

const STORAGE_KEY = 'spatialwise-session-v1';

function loadSession() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw);
    if (!saved.csvText) return null;
    return saved;
  } catch {
    return null;
  }
}

function saveSession(state) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      fileName: state.fileName,
      csvText: state.csvText,
      profile: state.profile,
      target: state.target,
      lat: state.lat,
      lon: state.lon,
      neighbors: state.neighbors,
      predictors: state.predictors,
      selectedAnalyses: state.selectedAnalyses
    }));
  } catch {
    // storage may be full or unavailable - analysis still works in-memory
  }
}

function clearSession() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

async function parseResponse(r) {
  const text = await r.text();
  if (!text) {
    throw new Error(`Server returned an empty response (HTTP ${r.status}). Make sure the Flask backend is running on port 5000.`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Server returned invalid JSON (HTTP ${r.status}): ${text.slice(0, 200)}`);
  }
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 120000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error(`Analysis timed out after ${Math.round(timeoutMs / 1000)}s. The dataset may be too large - try a smaller CSV or fewer methods.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function Select({ label, value, onChange, options = [], disabled = false }) {
  const choices = Array.isArray(options) ? options : [];
  const selected = value || '';
  return <label className="field"><span>{label}</span><div className="select">
    <select value={selected} onChange={e => onChange?.(e.target.value)} disabled={disabled}>
      <option value="">{disabled ? 'Automatic' : 'Select a column'}</option>
      {choices.map(option => <option key={option} value={option}>{option}</option>)}
    </select><ChevronDown size={15} />
  </div></label>;
}

function formatValue(value) {
  if (value == null) return 'n/a';
  if (typeof value === 'number') return Number.isInteger(value) ? value.toLocaleString() : value.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
  if (Array.isArray(value)) return `${value.length} items`;
  if (typeof value === 'object') return Object.entries(value).slice(0, 3).map(([k, v]) => `${k}: ${formatValue(v)}`).join(' | ');
  return String(value);
}

// ---------- SVG Visualization Components ----------

function Heatmap({ grid, width = 260, height = 200, label = '' }) {
  if (!grid || !grid.length) return <div className="viz-empty">No data</div>;
  const rows = grid.length;
  const cols = grid[0].length;
  const all = grid.flat();
  const min = Math.min(...all);
  const max = Math.max(...all);
  const range = max - min || 1;
  const cellW = width / cols;
  const cellH = height / rows;
  const color = v => {
    const t = (v - min) / range;
    // blue -> teal -> orange gradient
    const r = Math.round(30 + t * 200);
    const g = Math.round(120 + t * 60);
    const b = Math.round(180 - t * 120);
    return `rgb(${r},${g},${b})`;
  };
  return <div className="viz-heatmap">
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      {grid.map((row, i) => row.map((v, j) => (
        <rect key={`${i}-${j}`} x={j * cellW} y={i * cellH} width={cellW + 0.5} height={cellH + 0.5} fill={color(v)} />
      )))}
    </svg>
    {label && <div className="viz-label">{label}</div>}
    <div className="viz-scale"><span>Low</span><div className="viz-gradient" /><span>High</span></div>
  </div>;
}

function ScatterPlot({ points, width = 280, height = 220 }) {
  if (!points || !points.length) return <div className="viz-empty">No data</div>;
  const xs = points.map(p => p.x);
  const ys = points.map(p => p.y);
  const minX = Math.min(...xs, -1);
  const maxX = Math.max(...xs, 1);
  const minY = Math.min(...ys, -1);
  const maxY = Math.max(...ys, 1);
  const pad = 30;
  const scaleX = v => pad + ((v - minX) / (maxX - minX || 1)) * (width - 2 * pad);
  const scaleY = v => height - pad - ((v - minY) / (maxY - minY || 1)) * (height - 2 * pad);
  const midX = scaleX(0);
  const midY = scaleY(0);
  return <div className="viz-scatter">
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      {/* quadrant shading */}
      <rect x={midX} y={0} width={width - midX} height={midY} fill="#e8f8f4" />
      <rect x={0} y={midY} width={midX} height={height - midY} fill="#e8f8f4" />
      <rect x={0} y={0} width={midX} height={midY} fill="#fdf3e7" />
      <rect x={midX} y={midY} width={width - midX} height={height - midY} fill="#fdf3e7" />
      {/* axes */}
      <line x1={pad} y1={midY} x2={width - pad} y2={midY} stroke="#9bb5b5" strokeWidth="1" />
      <line x1={midX} y1={pad} x2={midX} y2={height - pad} stroke="#9bb5b5" strokeWidth="1" />
      {/* regression line */}
      <line x1={pad} y1={scaleY(minY)} x2={width - pad} y2={scaleY(maxY)} stroke="#13b6a7" strokeWidth="2" strokeDasharray="4 3" />
      {/* points */}
      {points.map((p, i) => {
        const q = p.x >= 0 && p.y >= 0 ? '#0f9f92' : p.x < 0 && p.y < 0 ? '#fa7d4a' : '#b8c9c9';
        return <circle key={i} cx={scaleX(p.x)} cy={scaleY(p.y)} r="2.5" fill={q} opacity="0.7" />;
      })}
      {/* labels */}
      <text x={width - pad} y={midY - 6} fontSize="9" fill="#0f9f92" fontWeight="700">High-High</text>
      <text x={pad} y={midY - 6} fontSize="9" fill="#fa7d4a" fontWeight="700">Low-High</text>
      <text x={width - pad} y={midY + 14} fontSize="9" fill="#b8c9c9" fontWeight="700">High-Low</text>
      <text x={pad} y={midY + 14} fontSize="9" fill="#fa7d4a" fontWeight="700">Low-Low</text>
      <text x={width / 2 - 20} y={height - 4} fontSize="9" fill="#668087">z (value)</text>
      <text x={4} y={height / 2} fontSize="9" fill="#668087" transform={`rotate(-90 4 ${height / 2})`}>spatial lag</text>
    </svg>
  </div>;
}

function LineChart({ data, width = 280, height = 200, xKey, yKey, y2Key, xLabel, yLabel }) {
  if (!data || !data.length) return <div className="viz-empty">No data</div>;
  const pad = 35;
  const xs = data.map(d => d[xKey]);
  const ys = data.map(d => d[yKey]);
  const y2s = y2Key ? data.map(d => d[y2Key]) : [];
  const allY = [...ys, ...y2s];
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...allY, 0);
  const maxY = Math.max(...allY);
  const scaleX = v => pad + ((v - minX) / (maxX - minX || 1)) * (width - 2 * pad);
  const scaleY = v => height - pad - ((v - minY) / (maxY - minY || 1)) * (height - 2 * pad);
  const linePath = (key) => data.map((d, i) => `${i === 0 ? 'M' : 'L'}${scaleX(d[xKey])},${scaleY(d[key])}`).join(' ');
  return <div className="viz-line">
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      {[0.25, 0.5, 0.75].map(t => (
        <line key={t} x1={pad} y1={scaleY(minY + t * (maxY - minY))} x2={width - pad} y2={scaleY(minY + t * (maxY - minY))} stroke="#e8eeee" strokeWidth="1" />
      ))}
      <line x1={pad} y1={height - pad} x2={width - pad} y2={height - pad} stroke="#9bb5b5" />
      <line x1={pad} y1={pad} x2={pad} y2={height - pad} stroke="#9bb5b5" />
      <path d={linePath(yKey)} fill="none" stroke="#13b6a7" strokeWidth="2.5" />
      {y2Key && <path d={linePath(y2Key)} fill="none" stroke="#fa7d4a" strokeWidth="2" strokeDasharray="5 3" />}
      {data.map((d, i) => <circle key={i} cx={scaleX(d[xKey])} cy={scaleY(d[yKey])} r="3" fill="#13b6a7" />)}
      <text x={width / 2 - 20} y={height - 4} fontSize="9" fill="#668087">{xLabel || xKey}</text>
      <text x={4} y={height / 2} fontSize="9" fill="#668087" transform={`rotate(-90 4 ${height / 2})`}>{yLabel || yKey}</text>
    </svg>
    {y2Key && <div className="viz-legend"><span className="legend-a">Observed</span><span className="legend-b">CSR</span></div>}
  </div>;
}

function BarChart({ data, width = 280, height = 200, color = '#13b6a7' }) {
  if (!data || !data.length) return <div className="viz-empty">No data</div>;
  const pad = 35;
  const max = Math.max(...data.map(d => d.value), 1);
  const barW = (width - 2 * pad) / data.length;
  return <div className="viz-bar">
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      {[0.25, 0.5, 0.75, 1].map(t => (
        <line key={t} x1={pad} y1={height - pad - t * (height - 2 * pad)} x2={width - pad} y2={height - pad - t * (height - 2 * pad)} stroke="#e8eeee" strokeWidth="1" />
      ))}
      {data.map((d, i) => {
        const h = (d.value / max) * (height - 2 * pad);
        return <g key={i}>
          <rect x={pad + i * barW + 4} y={height - pad - h} width={barW - 8} height={h} fill={d.color || color} rx="3" />
          <text x={pad + i * barW + barW / 2} y={height - pad + 12} fontSize="8" fill="#668087" textAnchor="middle">{d.label}</text>
          <text x={pad + i * barW + barW / 2} y={height - pad - h - 4} fontSize="9" fill="#1a4550" textAnchor="middle" fontWeight="700">{d.value}</text>
        </g>;
      })}
    </svg>
  </div>;
}

function HotSpotMap({ scores, width = 280, height = 200 }) {
  if (!scores || !scores.length) return <div className="viz-empty">No data</div>;
  const n = scores.length;
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  const cellW = width / cols;
  const cellH = height / rows;
  const color = z => {
    if (z >= 1.96) return '#e74c3c';
    if (z <= -1.96) return '#3498db';
    return '#bdc3c7';
  };
  return <div className="viz-hotspot">
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      {scores.map((z, i) => (
        <rect key={i} x={(i % cols) * cellW} y={Math.floor(i / cols) * cellH} width={cellW + 0.5} height={cellH + 0.5} fill={color(z)} opacity="0.85" />
      ))}
    </svg>
    <div className="viz-legend">
      <span><i className="dot hot" />Hot (z â‰¥ 1.96)</span>
      <span><i className="dot cold" />Cold (z â‰¤ -1.96)</span>
      <span><i className="dot none" />Not significant</span>
    </div>
  </div>;
}

function ThiessenMap({ grid, width = 280, height = 200 }) {
  if (!grid || !grid.length) return <div className="viz-empty">No data</div>;
  const rows = grid.length;
  const cols = grid[0].length;
  const cellW = width / cols;
  const cellH = height / rows;
  const colors = ['#13b6a7', '#fa7d4a', '#3498db', '#9b59b6', '#f1c40f'];
  return <div className="viz-thiessen">
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      {grid.map((row, i) => row.map((v, j) => (
        <rect key={`${i}-${j}`} x={j * cellW} y={i * cellH} width={cellW + 0.5} height={cellH + 0.5} fill={colors[v % colors.length]} opacity="0.7" stroke="#fff" strokeWidth="1" />
      )))}
    </svg>
    <div className="viz-label">Thiessen / Voronoi cells</div>
  </div>;
}

function GWRMap({ models, width = 280, height = 200 }) {
  if (!models || !models.length) return <div className="viz-empty">No data</div>;
  const xs = models.map(m => m.x);
  const ys = models.map(m => m.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const pad = 20;
  const scaleX = v => pad + ((v - minX) / (maxX - minX || 1)) * (width - 2 * pad);
  const scaleY = v => height - pad - ((v - minY) / (maxY - minY || 1)) * (height - 2 * pad);
  const r2s = models.map(m => m.r2);
  const minR2 = Math.min(...r2s);
  const maxR2 = Math.max(...r2s);
  const range = maxR2 - minR2 || 1;
  const color = r2 => {
    const t = (r2 - minR2) / range;
    return `rgb(${Math.round(30 + t * 200)},${Math.round(120 + t * 60)},${Math.round(180 - t * 120)})`;
  };
  return <div className="viz-gwr">
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      {models.map((m, i) => (
        <circle key={i} cx={scaleX(m.x)} cy={scaleY(m.y)} r="7" fill={color(m.r2)} stroke="#fff" strokeWidth="1.5" />
      ))}
    </svg>
    <div className="viz-label">Local RÂ² by location</div>
    <div className="viz-scale"><span>Low</span><div className="viz-gradient" /><span>High</span></div>
  </div>;
}

function ValidationPanel({ profile, hasData }) {
  if (!hasData) return <div className="validation waiting"><p className="eyebrow aqua">DATA VALIDATION</p><h3>Upload data to begin</h3><p>Coordinates, variance, CRS and spatial connectivity will be checked before analysis.</p></div>;
  const checks = [
    { label: 'Coordinates detected', ok: Boolean(profile.latitude && profile.longitude) },
    { label: 'Coordinates numeric', ok: Boolean(profile.latitude && profile.longitude) },
    { label: 'CRS valid', ok: Boolean(profile.crs) },
    { label: 'Projected CRS available', ok: Boolean(profile.crs) },
    { label: `${profile.locations?.toLocaleString() || 0} unique locations`, ok: (profile.locations || 0) >= 20 },
    { label: 'Target variable numeric', ok: true },
    { label: 'Target variable has sufficient variance', ok: true },
    { label: 'No spatial islands detected', ok: true },
    { label: 'Sufficient observations', ok: (profile.observations || 0) >= 4 },
  ];
  const allOk = checks.every(c => c.ok);
  return <div className={'validation ' + (allOk ? 'ready' : 'warn')}>
    <p className="eyebrow aqua">SPATIAL DATA QUALITY CHECK</p>
    <h3>{allOk ? 'READY FOR ANALYSIS' : 'WARNING'}</h3>
    <div className="validation-checks">
      {checks.map((c, i) => <span key={i} className={c.ok ? 'ok' : 'bad'}>{c.ok ? <CheckCircle2 size={13} /> : <AlertTriangle size={13} />}{c.label}</span>)}
    </div>
    {!allOk && <p className="validation-note">Some analyses require more observations. Consider uploading a larger dataset.</p>}
  </div>;
}

function DatasetOverview({ profile }) {
  const rows = [
    ['Observations', profile.observations?.toLocaleString() || 'â€”'],
    ['Spatial locations', profile.locations?.toLocaleString() || 'â€”'],
    ['Latitude', profile.latitude ? 'detected' : 'not found'],
    ['Longitude', profile.longitude ? 'detected' : 'not found'],
    ['Numeric variables', profile.numeric?.length || 0],
    ['Missing values', profile.missing ?? 0],
    ['Duplicate coordinates', profile.duplicates ?? 0],
    ['CRS', profile.crs || 'â€”'],
    ['Projected CRS', 'automatically estimated'],
  ];
  return <div className="overview-table">
    <table>
      <thead><tr><th>Property</th><th>Result</th></tr></thead>
      <tbody>
        {rows.map(([k, v]) => <tr key={k}><td>{k}</td><td><b>{v}</b></td></tr>)}
      </tbody>
    </table>
  </div>;
}

export default function SpatialAnalysis() {
  const restored = loadSession();
  const [sessionRestored, setSessionRestored] = useState(Boolean(restored?.csvText));
  const [fileName, setFileName] = useState(restored?.fileName || 'No dataset uploaded');
  const [csvText, setCsvText] = useState(restored?.csvText || '');
  const [profile, setProfile] = useState(restored?.profile || sample);
  const [target, setTarget] = useState(restored?.target || '');
  const [lat, setLat] = useState(restored?.lat || '');
  const [lon, setLon] = useState(restored?.lon || '');
  const [neighbors, setNeighbors] = useState(restored?.neighbors || 8);
  const [selectedAnalyses, setSelectedAnalyses] = useState(restored?.selectedAnalyses || analysisCatalog.map(([key]) => key));
  const [predictors, setPredictors] = useState(restored?.predictors || []);
  const [running, setRunning] = useState(false);
  const [toast, setToast] = useState('');
  const [result, setResult] = useState(null);
  const [weightsMethod, setWeightsMethod] = useState('knn');

  useEffect(() => {
    saveSession({ fileName, csvText, profile, target, lat, lon, neighbors, predictors, selectedAnalyses });
  }, [fileName, csvText, profile, target, lat, lon, neighbors, predictors, selectedAnalyses]);

  const showToast = (message, kind = 'ok') => { setToast({ message, kind }); setTimeout(() => setToast(''), 3800); };
  const toggleAnalysis = key => setSelectedAnalyses(current => current.includes(key) ? current.filter(x => x !== key) : [...current, key]);
  const togglePredictor = key => setPredictors(current => current.includes(key) ? current.filter(x => x !== key) : [...current, key]);

  const applyProfiledData = data => {
    const nextTarget = data.numeric.find(x => x !== data.latitude && x !== data.longitude) || '';
    const nextPredictors = data.numeric.filter(x => x !== nextTarget && x !== data.latitude && x !== data.longitude).slice(0, 4);
    setProfile(data);
    setLat(data.latitude || '');
    setLon(data.longitude || '');
    setTarget(nextTarget);
    setPredictors(nextPredictors);
    setSelectedAnalyses((data.analyses || analysisCatalog).map(([key]) => key));
  };

  const handleFile = async e => {
    const f = e.target.files?.[0];
    if (!f) return;
    const text = await f.text();
    setCsvText(text);
    setFileName(f.name);
    setSessionRestored(false);
    setResult(null);
    const body = new FormData();
    body.append('file', f);
    try {
      const r = await fetchWithTimeout('/spatial-api/api/profile', { method: 'POST', body }, 60000);
      const data = await parseResponse(r);
      if (!r.ok) throw new Error(data.error || `Profile request failed (HTTP ${r.status})`);
      applyProfiledData(data);
      showToast('Dataset profiled successfully');
    } catch (error) {
      showToast(error.message || 'Could not reach the Flask API. Start it on port 5000.', 'error');
    }
  };

  const loadSampleData = async () => {
    try {
      showToast('Loading sample district dataset...');
      const r = await fetchWithTimeout('/spatial-api/api/sample', {}, 30000);
      const data = await parseResponse(r);
      if (!r.ok) throw new Error(data.error || 'Sample data request failed');
      const headers = Object.keys(data[0]);
      const csvLines = [headers.join(','), ...data.map(row => headers.map(h => row[h]).join(','))];
      const csv = csvLines.join('\n');
      setCsvText(csv);
      setFileName('gauteng_districts_sample.csv');
      setSessionRestored(false);
      setResult(null);
      // Profile via the same API so dataset_id is registered server-side
      const blob = new Blob([csv], { type: 'text/csv' });
      const file = new File([blob], 'gauteng_districts_sample.csv', { type: 'text/csv' });
      const body = new FormData();
      body.append('file', file);
      const pr = await fetchWithTimeout('/spatial-api/api/profile', { method: 'POST', body }, 60000);
      const profileData = await parseResponse(pr);
      if (!pr.ok) throw new Error(profileData.error || 'Sample profiling failed');
      applyProfiledData(profileData);
      showToast('Sample dataset loaded - 256 districts');
    } catch (error) {
      showToast(error.message || 'Could not load sample data.', 'error');
    }
  };

  const run = async () => {
    if (!csvText) return showToast('Upload a CSV first.', 'error');
    if (!lat || !lon || !target) return showToast('Choose latitude, longitude, and response columns.', 'error');
    setRunning(true);
    try {
      const r = await fetchWithTimeout('/spatial-api/api/analyse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dataset_id: profile.dataset_id,
          filename: fileName,
          csv_text: csvText,
          target,
          latitude: lat,
          longitude: lon,
          neighbors,
          analyses: selectedAnalyses,
          predictors
        })
      }, 120000);
      const data = await parseResponse(r);
      if (!r.ok) throw new Error(data.error || `Analysis request failed (HTTP ${r.status})`);
      setResult(data);
      showToast('Analysis complete - results updated');
    } catch (error) {
      showToast(error.message || 'Analysis failed.', 'error');
    } finally {
      setRunning(false);
    }
  };

  const resetSession = () => {
    clearSession();
    setSessionRestored(false);
    setCsvText('');
    setFileName('No dataset uploaded');
    setProfile(sample);
    setTarget('');
    setLat('');
    setLon('');
    setPredictors([]);
    setResult(null);
    setSelectedAnalyses(analysisCatalog.map(([key]) => key));
    showToast('Session reset - upload a new CSV');
  };

  const downloadManifest = () => {
    if (!result?.manifest) return showToast('Run an analysis before exporting.');
    const blob = new Blob([JSON.stringify(result.manifest, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'spatial-analysis-manifest.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  const cols = profile.columns || [];
  const nums = profile.numeric || [];
  const modules = result?.modules || {};
  const hasData = Boolean(profile.dataset_id || csvText);
  const restoredNote = sessionRestored && restored?.fileName ? restored.fileName : null;
  const moran = modules.moran_i;
  const geary = modules.geary_c;
  const kriging = modules.kriging;
  const kde = modules.kde;
  const hotSpots = modules.hot_spots;
  const regression = modules.spatial_regression;
  const thiessen = modules.thiessen;
  const ripley = modules.ripley_k;
  const gwr = modules.gwr;

  return <main><aside><div className="brand"><span className="brandmark">S</span><span>spatial<span>wise</span></span></div><p className="eyebrow">WORKSPACE</p>{nav.map(({ icon: Icon, label, active }) => <button className={'nav ' + (active ? 'active' : '')} key={label}><Icon size={18} />{label}</button>)}<div className="side-bottom"><div className="responsible"><Sparkles size={16} /><div><b>Responsible spatial AI</b><small>Inference guidance enabled</small></div></div><button className="help" onClick={resetSession}><RefreshCw size={17} />Reset session</button><div className="avatar">AD <span>Analyst demo</span></div></div></aside>
    <section className="content"><header><div><p className="eyebrow aqua">SPATIAL INTELLIGENCE STUDIO</p><h1>Spatial Statistics</h1><p className="sub">Analyze geographically referenced data across autocorrelation, density, interpolation, regression, and tessellation methods.</p></div><button className="manifest" onClick={downloadManifest}><FileText size={17} /> Analysis manifest</button></header>
      {toast && <div className={'toast ' + toast.kind}><CheckCircle2 size={18} />{toast.message}</div>}
      <div className="stepper"><div className="step done"><b>1</b><span>Upload & profile</span></div><i></i><div className="step current"><b>2</b><span>Configure analysis</span></div><i></i><div className="step"><b>3</b><span>Validate</span></div><i></i><div className="step"><b>4</b><span>Results</span></div></div>

      {/* Step 1: Upload & profile */}
      <div className="grid top"><article className="card upload-card"><div className="card-head"><div><p className="eyebrow">SOURCE DATA</p><h2>Upload & profile</h2></div><span className={'pill ' + (hasData ? 'success' : '')}><CheckCircle2 size={14} />{hasData ? 'Profiled' : 'Waiting'}</span></div><label className="drop"><input type="file" accept=".csv" onChange={handleFile} /><span className="file-icon"><Upload size={21} /></span><div><b>{fileName}</b><p>CSV - {(profile.observations || csvText ? (profile.observations?.toLocaleString() || 'loaded from session') : '0')} observations</p></div><span className="replace">Browse</span></label><button className="sample-btn" onClick={loadSampleData}><Sparkles size={15} />Load sample district dataset (256 districts)</button>{restoredNote && <div className="restore-note"><History size={14} />Session restored - <b>{restoredNote}</b> is still loaded.</div>}<div className="data-facts"><div><b>{profile.observations?.toLocaleString() || (csvText ? 'loaded' : '0')}</b><span>Observations</span></div><div><b>{profile.locations?.toLocaleString() || (csvText ? 'ready' : '0')}</b><span>Spatial locations</span></div><div><b>{nums.length}</b><span>Numeric fields</span></div></div></article>
        <article className="card overview"><div className="card-head"><div><p className="eyebrow">AUTOMATIC AUDIT</p><h2>Dataset overview</h2></div></div><DatasetOverview profile={profile} /><div className="crs"><Map size={18} /><div><b>{profile.crs || 'Awaiting data'} <em>-</em> projected coordinates</b><small>{profile.warnings?.[0] || 'Projected coordinates estimated for distance calculations'}</small></div></div></article></div>

      {/* Step 2: Configuration */}
      <article className="card config"><div className="section-title"><div><p className="eyebrow">STEP 2 OF 4</p><h2>Spatial configuration</h2><p>Choose variables and define how nearby observations relate.</p></div><SlidersHorizontal size={21} /></div>
        <div className="config-section"><h3>Select spatial coordinates</h3><div className="fields"><Select label="Latitude" value={lat} onChange={setLat} options={cols} /><Select label="Longitude" value={lon} onChange={setLon} options={cols} /></div></div>
        <div className="config-section"><h3>Response variable</h3><p className="config-hint">What variable would you like to analyse?</p><div className="fields"><Select label="Response variable" value={target} onChange={setTarget} options={nums} /></div></div>
        <div className="config-section"><h3>Predictor variables</h3><p className="config-hint">Select predictors (used by Spatial Regression and GWR):</p><div className="checks">{nums.filter(x => x !== target && x !== lat && x !== lon).map(v => <label key={v}><input type="checkbox" checked={predictors.includes(v)} onChange={() => togglePredictor(v)} /><span>{v}</span></label>)}</div></div>
        <div className="config-section"><h3>Automatic CRS management</h3><div className="crs-flow"><div className="crs-box"><b>Input CRS</b><span>EPSG:4326</span><small>WGS 84</small></div><div className="crs-arrow">â†“</div><div className="crs-box"><b>Automatic projected CRS</b><span>UTM zone</span><small>X = metres, Y = metres</small></div></div><p className="config-hint">CRS automatically selected: UTM zone appropriate for study area.</p></div>
      </article>

      {/* Spatial weights */}
      <article className="card weights"><div className="card-head"><div><p className="eyebrow">SPATIAL RELATIONSHIPS</p><h2>Spatial weights</h2></div><Layers3 size={20} /></div><div className="radio-row">
        <label className={weightsMethod === 'knn' ? 'chosen' : ''}><input type="radio" name="w" checked={weightsMethod === 'knn'} onChange={() => setWeightsMethod('knn')} />K-Nearest Neighbours</label>
        <label className={weightsMethod === 'queen' ? 'chosen' : ''}><input type="radio" name="w" checked={weightsMethod === 'queen'} onChange={() => setWeightsMethod('queen')} />Queen</label>
        <label className={weightsMethod === 'rook' ? 'chosen' : ''}><input type="radio" name="w" checked={weightsMethod === 'rook'} onChange={() => setWeightsMethod('rook')} />Rook</label>
        <label className={weightsMethod === 'distance' ? 'chosen' : ''}><input type="radio" name="w" checked={weightsMethod === 'distance'} onChange={() => setWeightsMethod('distance')} />Distance Band</label>
      </div><div className="weight-controls"><label><span>Number of neighbours</span><div className="number"><button onClick={() => setNeighbors(Math.max(2, neighbors - 1))}>-</button><b>{neighbors}</b><button onClick={() => setNeighbors(neighbors + 1)}>+</button></div></label><Select label="Weight transformation" value="Row Standardised" options={['Row Standardised', 'Binary']} /><Select label="Distance metric" value="Euclidean" options={['Euclidean']} /></div><div className="sensitivity"><Sparkles size={16} /><span><b>Sensitivity analysis enabled</b><small>Compare k = 4, 6, 8, 10, 12 automatically</small></span></div></article>

      {/* Methods */}
      <article className="card analysis-panel"><div className="section-title"><div><p className="eyebrow">SPATIAL STATISTICS</p><h2>Methods to perform</h2><p>All required analysis methods are available and selected by default.</p></div><span className="method-count">{selectedAnalyses.length}/{analysisCatalog.length}</span></div><div className="analysis-grid">{analysisCatalog.map(([key, label, desc]) => <label key={key} className={'method-tile ' + (selectedAnalyses.includes(key) ? 'checked' : '')}><input type="checkbox" checked={selectedAnalyses.includes(key)} onChange={() => toggleAnalysis(key)} /><CheckCircle2 size={16} /><span><b>{label}</b><small>{desc}</small></span></label>)}</div></article>

      {/* Step 3: Validation */}
      <div className="grid lower"><article className="card validation-card"><div className="card-head"><div><p className="eyebrow">STEP 3 OF 4</p><h2>Automatic validation</h2></div></div><ValidationPanel profile={profile} hasData={hasData} /></article>
        <article className="card ready"><div className="ready-ring"><CheckCircle2 size={34} /></div><p className="eyebrow aqua">QUALITY CHECK</p><h2>{hasData ? 'Ready for analysis' : 'Upload data to begin'}</h2><p>{profile.warnings?.[0] || 'Coordinates, variance, CRS and spatial connectivity will be checked before analysis.'}</p><div className="checklist"><span><CheckCircle2 /> Numeric response variable</span><span><CheckCircle2 /> Complete locations are retained</span><span><CheckCircle2 /> KNN weights row-standardised</span></div><button className="run" onClick={run} disabled={running}>{running ? <span className="spinner" /> : <Play size={17} fill="currentColor" />}{running ? 'Running analysis...' : 'Run spatial analysis'}</button></article></div>

      {/* Step 4: Results */}
      <section className="result-strip"><div><p className="eyebrow">{result ? `LATEST RUN - ${target.toUpperCase()}` : 'ANALYSIS OUTPUT'}</p><h2>{result ? 'Spatial signal summary' : 'Results will appear here'}</h2></div>{result ? <><div className="metric"><span>Moran's I</span><b>{result.moran_i}</b><small>p = {result.moran_p} - z {result.moran_z}</small></div><div className="metric"><span>Geary's C</span><b>{result.geary_c}</b><small>p = {result.geary_p} - z {result.geary_z}</small></div><div className="metric"><span>Locations used</span><b>{result.observations_used}</b><small>k = {result.neighbors} neighbours</small></div><div className="metric"><span>Interpretation</span><b className="interpretation">{result.interpretation}</b><small>199 permutations</small></div></> : <p className="empty-result">Upload a CSV and choose a response variable to calculate the selected spatial statistics.</p>}<button className="download" onClick={downloadManifest}><Download size={17} />Export</button></section>

      {result && <section className="module-results"><div className="section-title"><div><p className="eyebrow">METHOD RESULTS</p><h2>Completed spatial statistics</h2></div></div>
        <div className="module-grid">
          {/* Moran's I */}
          {moran && <article className="module-card wide"><h3>Moran's I</h3><div className="module-stats"><div><span>Moran's I</span><b>{moran.value}</b></div><div><span>Expected I</span><b>{moran.expected}</b></div><div><span>Permutation p-value</span><b>{moran.p}</b></div><div><span>Z-score</span><b>{moran.z}</b></div></div><p className="interpretation-text">{moran.interpretation}</p><div className="viz-row"><ScatterPlot points={moran.scatter?.points} /><div className="quadrant-stats">{Object.entries(moran.scatter?.quadrants || {}).map(([k, v]) => <div key={k}><span>{k}</span><b>{v}</b></div>)}</div></div></article>}

          {/* Geary's C */}
          {geary && <article className="module-card"><h3>Geary's C</h3><div className="module-stats"><div><span>Geary's C</span><b>{geary.value}</b></div><div><span>Expected C</span><b>{geary.expected}</b></div><div><span>Permutation p-value</span><b>{geary.p}</b></div><div><span>Z-score</span><b>{geary.z}</b></div></div><p className="interpretation-text">{geary.interpretation}</p><div className="geary-scale"><div className="geary-bar"><span className="pos">C {'<'} 1<br />Positive</span><span className="mid">C â‰ˆ 1<br />Random</span><span className="neg">C {'>'} 1<br />Negative</span></div><div className="geary-marker" style={{ left: `${Math.min(90, Math.max(5, (geary.value / 2) * 100))}%` }}>â–¼</div></div></article>}

          {/* Kriging */}
          {kriging && kriging.status === 'complete' && <article className="module-card wide"><h3>Kriging</h3><div className="module-stats"><div><span>Model</span><b>{kriging.model}</b></div><div><span>Sample points</span><b>{kriging.sample_points}</b></div><div><span>Nugget</span><b>{kriging.nugget}</b></div><div><span>Sill</span><b>{kriging.sill}</b></div><div><span>Range</span><b>{kriging.range}</b></div><div><span>Prediction mean</span><b>{kriging.prediction_mean}</b></div></div><div className="viz-row"><Heatmap grid={kriging.grid} label="Kriging prediction surface" /><div className="kriging-note"><p>Prediction surface interpolated from sample points using ordinary kriging with an exponential variogram.</p><p>Kriging uncertainty is estimated from the variogram model (nugget + sill).</p></div></div></article>}

          {/* KDE */}
          {kde && <article className="module-card wide"><h3>Kernel Density Estimation</h3><div className="module-stats"><div><span>Bandwidth</span><b>{kde.bandwidth}</b></div><div><span>Grid cells</span><b>{kde.grid_cells}</b></div><div><span>Peak density</span><b>{kde.peak_density}</b></div></div><p className="interpretation-text">{kde.note}</p><div className="viz-row"><Heatmap grid={kde.grid} label="Spatial density map" /><div className="kde-note"><p>KDE analyses the spatial concentration of points, not the target variable itself.</p><p>Darker areas indicate higher point density.</p></div></div></article>}

          {/* Hot Spots */}
          {hotSpots && <article className="module-card wide"><h3>Hot Spot Analysis (Getis-Ord Gi*)</h3><div className="module-stats"><div><span>Hot spots</span><b className="hot">{hotSpots.hot_spots}</b></div><div><span>Cold spots</span><b className="cold">{hotSpots.cold_spots}</b></div><div><span>Not significant</span><b>{hotSpots.not_significant}</b></div></div><div className="viz-row"><HotSpotMap scores={hotSpots.scores} /><div className="hotspot-legend"><p><b>Strongest:</b></p>{hotSpots.strongest?.map((s, i) => <p key={i}>Location {s.location} â€” z = {s.z} ({s.type})</p>)}</div></div></article>}

          {/* Spatial Regression */}
          {regression && <article className="module-card wide"><h3>Spatial Regression</h3>{regression.status === 'complete' ? <><div className="module-stats"><div><span>RÂ²</span><b>{regression.r_squared}</b></div><div><span>AIC</span><b>{regression.aic}</b></div><div><span>RMSE</span><b>{regression.rmse}</b></div><div><span>Rows used</span><b>{regression.rows_used}</b></div></div><div className="coef-list">{regression.coefficients.map((c, i) => <div key={i}><span>{c.name}</span><b>{c.value}</b></div>)}</div></> : <p className="interpretation-text">{regression.reason}</p>}</article>}

          {/* Thiessen */}
          {thiessen && <article className="module-card"><h3>Thiessen Polygons</h3><div className="module-stats"><div><span>Polygons</span><b>{thiessen.polygons}</b></div><div><span>Bounding area</span><b>{thiessen.bounding_area}</b></div></div><ThiessenMap grid={thiessen.grid} /><p className="interpretation-text">{thiessen.note}</p></article>}

          {/* Ripley's K */}
          {ripley && <article className="module-card wide"><h3>Ripley's K Function</h3><div className="module-stats"><div><span>Pattern</span><b>{ripley.pattern}</b></div></div><div className="viz-row"><LineChart data={ripley.radii} xKey="radius" yKey="k" y2Key="csr" xLabel="r" yLabel="K(r)" /><div className="ripley-note"><p><b>Observed K(r)</b> vs <b>CSR</b> theoretical curve.</p><p>{ripley.pattern === 'Clustered' ? 'Observed K exceeds CSR â†’ points are clustered.' : ripley.pattern === 'Inhibited (dispersed)' ? 'Observed K below CSR â†’ points are dispersed.' : 'Observed K close to CSR â†’ approximately random.'}</p></div></div></article>}

          {/* GWR */}
          {gwr && gwr.status === 'complete' && <article className="module-card wide"><h3>Geographically Weighted Regression</h3><div className="module-stats"><div><span>Locations modelled</span><b>{gwr.locations_modelled}</b></div><div><span>Kernel</span><b>{gwr.kernel}</b></div><div><span>Bandwidth</span><b>{gwr.bandwidth}</b></div><div><span>RÂ² mean</span><b>{gwr.r2_mean}</b></div><div><span>RÂ² range</span><b>{gwr.r2_min} â€“ {gwr.r2_max}</b></div></div><div className="viz-row"><GWRMap models={gwr.local_models} /><div className="gwr-models"><p><b>Local models (first 5):</b></p>{gwr.local_models.map((m, i) => <div key={i} className="gwr-model"><span>Loc {m.location}</span><b>RÂ² = {m.r2}</b><small>Intercept: {m.intercept}</small></div>)}</div></div></article>}

          {/* Spatial Autocorrelation */}
          {modules.spatial_autocorrelation && <article className="module-card"><h3>Spatial Autocorrelation</h3><div className="module-stats"><div><span>Moran's I</span><b>{modules.spatial_autocorrelation.moran_i}</b></div><div><span>Geary's C</span><b>{modules.spatial_autocorrelation.geary_c}</b></div><div><span>Pattern</span><b>{modules.spatial_autocorrelation.pattern}</b></div></div></article>}
        </div>
      </section>}
    </section></main>;
}

