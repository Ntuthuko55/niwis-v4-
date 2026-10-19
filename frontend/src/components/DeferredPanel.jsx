import { Suspense, useState } from 'react'
import LoadingProgress from './LoadingProgress'

// Keep an opened panel mounted so scrolling never discards a running job.
export default function DeferredPanel({ children, label = 'Forecasting studio' }) {
  const [visible, setVisible] = useState(false)
  // A visibility observer would fire while the dashboard is still a short
  // loading placeholder and start forecasting before its charts have arrived.
  return <div className="nw-deferred-panel">
    {visible ? <Suspense fallback={<LoadingProgress message={`Loading ${label.toLowerCase()}`} />}>{children}</Suspense>
      : <section className="nw-panel"><button type="button" className="nw-btn" onClick={() => setVisible(true)}>Open {label.toLowerCase()}</button></section>}
  </div>
}
