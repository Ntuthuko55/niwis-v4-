// Label anchors are geographic coordinates, so they follow each map's projection.
const PROVINCES = [
  ['Western Cape', 20.6, -33.3],
  ['Northern Cape', 21.0, -29.2],
  ['Eastern Cape', 26.8, -32.0],
  ['Free State', 26.8, -28.8],
  ['North West', 25.2, -26.6],
  ['Gauteng', 28.1, -26.1],
  ['Mpumalanga', 30.4, -25.8],
  ['Limpopo', 29.2, -23.6],
  ['KwaZulu-Natal', 30.7, -28.6],
]

export default function ProvinceMapLabels({ project, fontSize = 17 }) {
  return <g className="province-map-labels" aria-label="Province names" style={{ pointerEvents: 'none', userSelect: 'none' }}>
    {PROVINCES.map(([name, lon, lat]) => {
      const [x, y] = project([lon, lat])
      const lines = name === 'KwaZulu-Natal' ? ['KwaZulu-', 'Natal'] : [name]
      return <text key={name} x={x} y={y} textAnchor="middle" dominantBaseline="central" aria-label={name}
        style={{ fontFamily: 'Arial, Helvetica, sans-serif', fontSize, fontWeight: 600, fill: '#173b48', stroke: '#ffffff', strokeWidth: fontSize * .18, strokeLinejoin: 'round', paintOrder: 'stroke', pointerEvents: 'none' }}>
        {lines.map((line, index) => <tspan key={line} x={x} dy={index === 0 ? -(lines.length - 1) * fontSize * .52 : fontSize * 1.04}>{line}</tspan>)}
      </text>
    })}
  </g>
}
