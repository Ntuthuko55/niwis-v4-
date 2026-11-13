import { Moon, Sun } from 'lucide-react'
import { useTheme } from '../contexts/ThemeContext'
import '../niwis/theme-controls.css'

export default function ThemeSelector() {
  const { theme, setTheme } = useTheme()
  const Icon = theme === 'light' ? Sun : Moon
  return <label className="nw-theme-selector">
    <Icon size={15} aria-hidden="true" />
    <span>Theme</span>
    <select aria-label="Colour theme" value={theme} onChange={event => setTheme(event.target.value)}>
      <option value="navy">Navy</option>
      <option value="light">Light</option>
    </select>
  </label>
}
