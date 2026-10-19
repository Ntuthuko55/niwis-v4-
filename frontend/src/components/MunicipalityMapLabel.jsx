function labelAnchor(geometry, project) {
  const polygons = geometry?.type === 'Polygon' ? [geometry.coordinates] : geometry?.type === 'MultiPolygon' ? geometry.coordinates : []
  let largest = null
  let largestArea = 0
  for (const polygon of polygons) {
    const ring = polygon[0]?.map(project) || []
    let area = 0, x = 0, y = 0
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length]
      const cross = a[0] * b[1] - b[0] * a[1]
      area += cross
      x += (a[0] + b[0]) * cross
      y += (a[1] + b[1]) * cross
    }
    if (Math.abs(area) > largestArea) {
      largestArea = Math.abs(area)
      largest = [x / (3 * area), y / (3 * area)]
    }
  }
  return largest
}

export default function MunicipalityMapLabel({ feature, project, width = 680, height = 560, fontSize = 24 }) {
  if (!feature) return null
  const anchor = labelAnchor(feature.geometry, project)
  if (!anchor) return null
  const name = feature.properties?.shapeName || 'Unknown district'
  const lines = ['']
  for (const word of name.split(' ')) {
    const last = lines.length - 1
    if (lines[last] && `${lines[last]} ${word}`.length > 26) lines.push(word)
    else lines[last] = `${lines[last]} ${word}`.trim()
  }
  const boxWidth = Math.min(width - 16, Math.max(...lines.map(line => line.length)) * fontSize * 0.58 + 24)
  const boxHeight = lines.length * fontSize * 1.2 + 18
  const x = Math.max(8, Math.min(width - boxWidth - 8, anchor[0] - boxWidth / 2))
  const y = Math.max(8, Math.min(height - boxHeight - 8, anchor[1] - boxHeight - 20))
  return <g className="municipality-map-label" aria-label={`Municipality: ${name}`} style={{ pointerEvents: 'none' }}>
    <line x1={anchor[0]} y1={anchor[1]} x2={Math.max(x + 8, Math.min(x + boxWidth - 8, anchor[0]))} y2={y + boxHeight} stroke="#bceaff" strokeWidth={2} />
    <circle cx={anchor[0]} cy={anchor[1]} r={4} fill="#34c9ff" stroke="#fff" strokeWidth={2} />
    <rect x={x} y={y} width={boxWidth} height={boxHeight} rx={7} fill="#09243b" stroke="#63ccf9" strokeWidth={1.5} />
    <text x={x + boxWidth / 2} y={y + 9 + fontSize * 0.85} textAnchor="middle" style={{ fill: '#eef8ff', fontSize, fontWeight: 600, fontFamily: 'Arial, Helvetica, sans-serif' }}>
      {lines.map((line, index) => <tspan key={line} x={x + boxWidth / 2} dy={index ? fontSize * 1.2 : 0}>{line}</tspan>)}
    </text>
  </g>
}
