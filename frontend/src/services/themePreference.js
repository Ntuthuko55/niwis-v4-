export const THEME_STORAGE_KEY = 'niwis-color-theme'

export function normalizeTheme(value) {
  return value === 'light' ? 'light' : 'navy'
}

export function getThemePreference() {
  try {
    return normalizeTheme(window.localStorage.getItem(THEME_STORAGE_KEY))
  } catch {
    return 'navy'
  }
}

export function initializeTheme() {
  const theme = getThemePreference()
  document.documentElement.dataset.niwisTheme = theme
  document.documentElement.style.colorScheme = theme === 'light' ? 'light' : 'dark'
  return theme
}
