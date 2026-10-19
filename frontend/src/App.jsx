import { lazy, Suspense, useState } from 'react'
import LoadingProgress from './components/LoadingProgress'
import { Clock, CloudRain, Database, Map, Sparkles } from 'lucide-react'
const SpatialAnalysis = lazy(() => import('./components/SpatialAnalysis'))
const MultivariateStatistics = lazy(() => import('./components/MultivariateStatistics'))
const TimeSeriesDashboard = lazy(() => import('./components/TimeSeriesDashboard'))
import NIWISPortal from './components/NIWISPortal'

export default function App() {
  const [activeWorkspace, setActiveWorkspace] = useState('niwis')

  if (activeWorkspace === 'niwis') {
    return <NIWISPortal />
  }

  return (
    <Suspense fallback={<LoadingProgress message="Loading workspace" />}>
      <nav className="workspace-tabs" aria-label="Analysis workspaces">
        <div className="workspace-brand">
          <span><Sparkles size={17} /></span>
          <strong>SignalLab</strong>
          <small>STUDIO</small>
        </div>
        <div className="workspace-links">
          <button
            className={activeWorkspace === 'timeseries' ? 'active' : ''}
            onClick={() => setActiveWorkspace('timeseries')}
            aria-pressed={activeWorkspace === 'timeseries'}
          >
            <Clock size={16} /> Time Series Studio
          </button>
          <button
            className={activeWorkspace === 'spatial' ? 'active' : ''}
            onClick={() => setActiveWorkspace('spatial')}
            aria-pressed={activeWorkspace === 'spatial'}
          >
            <Map size={16} /> Spatial Analysis
          </button>
          <button
            className={activeWorkspace === 'multivariate' ? 'active' : ''}
            onClick={() => setActiveWorkspace('multivariate')}
            aria-pressed={activeWorkspace === 'multivariate'}
          >
            <Database size={16} /> Multivariate Statistics
          </button>
          <button
            className={activeWorkspace === 'niwis' ? 'active' : ''}
            onClick={() => setActiveWorkspace('niwis')}
            aria-pressed={activeWorkspace === 'niwis'}
          >
            <CloudRain size={16} /> Predictions
          </button>
        </div>
        <div className="workspace-actions">
          <button className="help-button">Documentation</button>
          <div className="user-avatar">DS</div>
        </div>
      </nav>

      {activeWorkspace === 'timeseries' && <TimeSeriesDashboard />}
      {activeWorkspace === 'spatial' && <SpatialAnalysis />}
      {activeWorkspace === 'multivariate' && <MultivariateStatistics />}
    </Suspense>
  )
}
