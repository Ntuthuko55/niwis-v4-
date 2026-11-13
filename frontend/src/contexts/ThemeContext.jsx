import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { chartColorVariables } from '../lib/chartTheme'
import { getThemePreference, normalizeTheme, THEME_STORAGE_KEY } from '../services/themePreference'

const ThemeContext = createContext(null)

export function ThemeProvider({ children }) {
  const [theme, setThemeState] = useState(getThemePreference)
  const setTheme = useCallback(value => setThemeState(normalizeTheme(value)), [])

  useLayoutEffect(() => {
    const root = document.documentElement
    root.dataset.niwisTheme = theme
    root.style.colorScheme = theme === 'light' ? 'light' : 'dark'
    for (const [name, value] of Object.entries(chartColorVariables(theme))) root.style.setProperty(name, value)
    try { window.localStorage.setItem(THEME_STORAGE_KEY, theme) } catch { /* The choice still works when storage is blocked. */ }
    window.dispatchEvent(new CustomEvent('niwis-theme-change', { detail: theme }))
  }, [theme])

  useEffect(() => {
    const sync = event => {
      if (event.key === THEME_STORAGE_KEY || event.key === null) setThemeState(getThemePreference())
    }
    window.addEventListener('storage', sync)
    return () => window.removeEventListener('storage', sync)
  }, [])

  const value = useMemo(() => ({ theme, setTheme }), [theme, setTheme])
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme() {
  const context = useContext(ThemeContext)
  if (!context) throw new Error('Theme controls require ThemeProvider.')
  return context
}
