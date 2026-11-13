import { DCLASS, GEO, LABELPOS, LESOTHO } from './demoData'
import { useMemo } from 'react'
import DashboardMap from '../components/DashboardMap'
import { chartColor } from '../lib/chartTheme'

function projX(lon) { return ((lon - 16.2) / 17) * 680 }
function projY(lat) { return ((-22.0 - lat) / 13) * 560 }
function poly(pts) { return pts.map((p) => `${projX(p[0]).toFixed(1)},${projY(p[1]).toFixed(1)}`).join(' ') }

export function LineChart({ sets, labels = [], min, max, h = 190, dec = 0, split }) {
  const W = 560
  const H = h
  const P = { l: 40, r: 12, t: 12, b: 26 }
  const all = sets.flatMap((s) => s.data.filter((v) => v != null))
  let lo = min !== undefined ? min : Math.min(...all)
  let hi = max !== undefined ? max : Math.max(...all)
  if (hi === lo) hi = lo + 1
  const pad = (hi - lo) * 0.12
  if (min === undefined) lo -= pad
  if (max === undefined) hi += pad
  const n = sets[0]?.data.length || 1
  const X = (i) => P.l + (i * (W - P.l - P.r)) / Math.max(1, n - 1)
  const Y = (v) => P.t + ((hi - v) / (hi - lo)) * (H - P.t - P.b)
  const ticks = 4
  return (
    <>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto' }}>
        {Array.from({ length: ticks + 1 }, (_, t) => {
          const v = lo + ((hi - lo) * t) / ticks
          const y = Y(v)
          return (
            <g key={t}>
              <line x1={P.l} y1={y} x2={W - P.r} y2={y} stroke="var(--chart-grid, #1B3A49)" />
              <text x={P.l - 6} y={y + 3.5} textAnchor="end" fontSize="9.5" fill="var(--chart-text, #6A8896)">{v.toFixed(dec)}</text>
            </g>
          )
        })}
        {split !== undefined && (
          <>
            <rect x={X(split)} y={P.t} width={W - P.r - X(split)} height={H - P.t - P.b} fill={chartColor('#8C7BE0')} opacity=".07" />
            <line x1={X(split)} y1={P.t} x2={X(split)} y2={H - P.b} stroke={chartColor('#8C7BE0')} strokeDasharray="3 3" />
          </>
        )}
        {sets.map((s) => {
          const d = s.data.map((v, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(' ')
          return (
            <g key={s.n}>
              {s.area && <path d={`${d} L${X(n - 1)},${Y(lo)} L${X(0)},${Y(lo)} Z`} fill={chartColor(s.c)} opacity=".12" />}
              <path d={d} fill="none" stroke={chartColor(s.c)} strokeWidth={s.w || 2} strokeDasharray={s.dash || undefined} strokeLinejoin="round" />
            </g>
          )
        })}
        {labels.map((l, i) => (n > 8 && i % 2 ? null : (
          <text key={l + i} x={X(i)} y={H - 8} textAnchor="middle" fontSize="9" fill="var(--chart-text, #6A8896)">{l}</text>
        )))}
      </svg>
      {sets.length > 1 && (
        <div className="nw-legend">{sets.map((s) => <span key={s.n}><i style={{ background: chartColor(s.c) }} />{s.n}</span>)}</div>
      )}
    </>
  )
}

export function BarChart({ labels, vals, color = 'var(--river)', h = 190, max }) {
  const W = 560
  const H = h
  const P = { l: 38, r: 10, t: 10, b: 34 }
  const hi = max || Math.max(...vals) * 1.15
  const bw = (W - P.l - P.r) / vals.length
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto' }}>
      {[0, 1, 2, 3].map((t) => {
        const y = P.t + (1 - t / 3) * (H - P.t - P.b)
        return (
          <g key={t}>
            <line x1={P.l} y1={y} x2={W - P.r} y2={y} stroke="var(--chart-grid, #1B3A49)" />
            <text x={P.l - 6} y={y + 3.5} textAnchor="end" fontSize="9.5" fill="var(--chart-text, #6A8896)">{(hi * t / 3).toFixed(0)}</text>
          </g>
        )
      })}
      {vals.map((v, i) => {
        const height = Math.max(1, (v / hi) * (H - P.t - P.b))
        const x = P.l + i * bw + bw * 0.18
        const y = H - P.b - height
        const c = typeof color === 'function' ? color(v, i) : color
        return (
          <g key={labels[i]}>
            <rect x={x} y={y} width={bw * 0.64} height={height} rx="2" fill={chartColor(c)} />
            <text x={P.l + i * bw + bw / 2} y={H - 12} textAnchor="middle" fontSize="9" fill="var(--chart-text, #6A8896)">{labels[i]}</text>
          </g>
        )
      })}
    </svg>
  )
}

export function BarEl({ v, color, max = 100 }) {
  return <div className="nw-bar"><i style={{ width: `${Math.max(2, Math.min(100, (v / max) * 100))}%`, background: color }} /></div>
}

export function MapSVG({ provinces, selected, onSelect, colorFn, points, valueFn }) {
  const geographicFeatures = useMemo(() => provinces.filter(province => GEO[province.id]?.length >= 3).map(province => {
    const ring = GEO[province.id]
    const first = ring[0], last = ring[ring.length - 1]
    const closedRing = first[0] === last[0] && first[1] === last[1] ? ring : [...ring, first]
    return { type: 'Feature', id: province.id, properties: { provinceCode: province.id, provinceName: province.name, province, boundary_precision: 'Generalized province display boundary' }, geometry: { type: 'Polygon', coordinates: [closedRing] } }
  }), [provinces])
  const markers = (points || []).filter(point => point.lon != null && point.lat != null && Number.isFinite(Number(point.lon)) && Number.isFinite(Number(point.lat))).map((point, index) => ({ id: `${point.t}-${index}`, longitude: Number(point.lon), latitude: Number(point.lat), color: point.c, radius: 5, label: point.t }))
  const originalMap = (
    <div className="nw-map">
      <svg viewBox="0 0 680 590">
        <polygon points={poly(LESOTHO)} fill="#0A1720" stroke="#2A4E5E" strokeDasharray="3 3" />
        {provinces.map((p) => {
          const g = GEO[p.id]
          if (!g) return null
          return (
            <polygon
              key={p.id}
              className={`nw-prov ${selected === p.id ? 'sel' : ''}`}
              points={poly(g)}
              fill={colorFn(p)}
              onClick={() => onSelect(p.id)}
            >
              <title>{p.name}{valueFn ? ` · ${valueFn(p)}` : ''}</title>
            </polygon>
          )
        })}
        {provinces.map((p) => {
          const l = LABELPOS[p.id]
          if (!l) return null
          const value = valueFn ? valueFn(p) : null
          return (
            <g key={`l${p.id}`}>
              <text className="nw-mlabel" x={projX(l[0])} y={projY(l[1]) - (value != null ? 7 : 0)} textAnchor="middle">{p.name}</text>
              {value != null && <text className="nw-mlabel-value" x={projX(l[0])} y={projY(l[1]) + 10} textAnchor="middle">{value}</text>}
            </g>
          )
        })}
        {(points || []).map((s) => (
          <circle key={s.t} cx={projX(s.lon)} cy={projY(s.lat)} r="5" fill={s.c} stroke="#08161D" strokeWidth="1.5">
            <title>{s.t}</title>
          </circle>
        ))}
        <text x={projX(28.5)} y={projY(-29.6)} className="nw-mlabel" fill="#6A8896" textAnchor="middle">LESOTHO</text>
      </svg>
    </div>
  )
  return <DashboardMap className="dashboard-map-province" height={520} original={originalMap} features={geographicFeatures} featureStyle={feature => ({ fillColor: colorFn(feature.properties.province), fillOpacity: 0.65, color: selected === feature.properties.provinceCode ? '#ffffff' : '#2a4e5e', weight: selected === feature.properties.provinceCode ? 2.4 : 1 })} featureLabel={feature => `${feature.properties.provinceName}${valueFn ? ` · ${valueFn(feature.properties.province)}` : ''} · Generalized province display boundary`} onFeatureSelect={feature => onSelect?.(feature.properties.provinceCode)} selectedFeature={geographicFeatures.find(feature => feature.properties.provinceCode === selected)} markers={markers} mapLabel="Provincial dashboard map" />
}

export function DTag({ d }) {
  const c = DCLASS[d] || DCLASS['-']
  return <span className={`nw-tag ${c.t}`}>{d === '-' ? 'No drought' : `${d} · ${c.n.split(' ')[0]}`}</span>
}
