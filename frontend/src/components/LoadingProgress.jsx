import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'

// Network responses do not expose a reliable byte-level total for every
// dashboard endpoint. This progress indicator therefore shows a paced
// retrieval estimate and leaves the final step to the request itself.
export default function LoadingProgress({ message = 'Retrieving dashboard data', className = '' }) {
  const [progress, setProgress] = useState(8)

  useEffect(() => {
    const timer = window.setInterval(() => {
      setProgress((current) => {
        if (current >= 92) return current
        const step = current < 45 ? 8 : current < 75 ? 4 : 2
        return Math.min(92, current + step)
      })
    }, 420)
    return () => window.clearInterval(timer)
  }, [])

  return (
    <div className={`${className} loading-progress`} role="status" aria-live="polite" aria-label={`${message} ${progress}%`}>
      <div className="loading-progress-header">
        <span className="loading-progress-label"><RefreshCw size={20} /> {message}</span>
        <strong>{progress}%</strong>
      </div>
      <div className="loading-progress-track" aria-hidden="true"><i style={{ width: `${progress}%` }} /></div>
      <span className="loading-progress-caption">Data is still being retrieved…</span>
    </div>
  )
}
