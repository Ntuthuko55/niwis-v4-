import { useEffect, useState } from 'react'

const modules = { dams: 'reservoirs', surface: 'surface-water', overview: 'meteorological',
  monitoring: 'drought-monitoring', 'groundwater-reserve': 'groundwater-reserve', 'water-quality': 'water-quality' }

export default function DataFreshness({ view }) {
  const [status, setStatus] = useState(null)
  useEffect(() => {
    setStatus(null)
    const module = view.startsWith('climate') ? 'climate' : modules[view] || view
    const update = event => {
      if (event.detail.path.startsWith(`/api/${module}/`)) setStatus(event.detail)
    }
    window.addEventListener('niwis:data-loaded', update)
    return () => window.removeEventListener('niwis:data-loaded', update)
  }, [view])
  if (!status) return null
  const date = new Date(status.loadedAt)
  return <p className="nw-data-freshness" role="status" style={{ margin: '0 0 10px', color: '#93b6c8', fontSize: 11 }}>
    Last loaded {date.toLocaleTimeString('en-ZA', { timeZone: 'Africa/Johannesburg', hour: '2-digit', minute: '2-digit', second: '2-digit' })} SAST{status.cached ? ' · Cached API response' : ''}. Observation dates appear on each dashboard.
  </p>
}
