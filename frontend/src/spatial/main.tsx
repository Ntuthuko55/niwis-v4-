import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import 'leaflet/dist/leaflet.css'
import './styles.css'
import './map-size.css'
import './theme.css'
import App from './App'

const storageKey = 'niwis-color-theme'
const applyTheme = (value: unknown) => {
  const theme = value === 'light' ? 'light' : 'navy'
  document.documentElement.dataset.niwisTheme = theme
  document.documentElement.style.colorScheme = theme === 'light' ? 'light' : 'dark'
}
try { applyTheme(localStorage.getItem(storageKey)) } catch { applyTheme('navy') }
window.addEventListener('storage', event => {
  if (event.key === storageKey || event.key === null) {
    try { applyTheme(localStorage.getItem(storageKey)) } catch { applyTheme('navy') }
  }
})
window.addEventListener('niwis-theme-change', event => {
  const value = (event as CustomEvent).detail
  applyTheme(typeof value === 'string' ? value : value?.theme)
})

const root = document.getElementById('spatial-root')
if (!root) throw new Error('Spatial application root is missing.')

createRoot(root).render(<StrictMode><App /></StrictMode>)
