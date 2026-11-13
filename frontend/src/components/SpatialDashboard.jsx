import { useCallback, useEffect, useRef } from 'react'
import { useTheme } from '../contexts/ThemeContext'
import '../niwis/spatial-dashboard.css'

export default function SpatialDashboard() {
  const frame = useRef(null)
  const { theme } = useTheme()
  const syncTheme = useCallback(() => {
    try {
      const target = frame.current?.contentWindow
      if (!target?.document.documentElement) return
      target.document.documentElement.dataset.niwisTheme = theme
      target.dispatchEvent(new target.CustomEvent('niwis-theme-change', { detail: theme }))
    } catch {
      // A future external workspace cannot expose its document to this portal.
    }
  }, [theme])
  useEffect(syncTheme, [syncTheme])
  return <iframe
    ref={frame}
    onLoad={syncTheme}
    className="spatial-workspace-frame"
    src="/spatial-workspace.html"
    title="NIWIS Spatial Intelligence workspace"
    loading="eager"
    allowFullScreen
  />
}
