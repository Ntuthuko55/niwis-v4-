import { lazy, Suspense, useEffect, useState } from 'react'
import NIWISHome from './components/NIWISHome'

const NIWISPortal = lazy(() => import('./components/NIWISPortal'))

function currentPath() {
  return window.location.pathname.replace(/\/+$/, '') || '/'
}

export default function App() {
  const [path, setPath] = useState(currentPath)

  useEffect(() => {
    const onPopState = () => setPath(currentPath())
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  if (path === '/' || path === '/home') return <NIWISHome />

  return (
    <Suspense fallback={
      <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: '#061a2c', color: '#e6f3ff', padding: 24 }}>
        <p role="status" aria-live="polite">Loading NIWIS dashboard…</p>
      </main>
    }>
      <NIWISPortal />
    </Suspense>
  )
}
