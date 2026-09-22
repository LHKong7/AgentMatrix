import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  darkClassName,
  isThemePreference,
  resolveAppearance,
  type Appearance,
  type ThemePreference,
} from '../../../shared/theme'
import { getInitialTheme, persistTheme, prefersDark, themeStorageKey } from './preferences'

interface ThemeValue {
  theme: ThemePreference
  appearance: Appearance
  setTheme: (theme: ThemePreference) => void
}

const ThemeContext = createContext<ThemeValue | null>(null)

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, updateTheme] = useState(getInitialTheme)
  const [systemDark, setSystemDark] = useState(prefersDark)
  useEffect(() => {
    let query: MediaQueryList
    try {
      query = window.matchMedia('(prefers-color-scheme: dark)')
    } catch {
      return
    }
    const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches)
    setSystemDark(query.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === themeStorageKey && isThemePreference(event.newValue))
        updateTheme(event.newValue)
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])
  const appearance = resolveAppearance(theme, systemDark)
  useEffect(() => {
    // The root class drives both the token palette and every `dark:` utility.
    document.documentElement.classList.toggle(darkClassName, appearance === 'dark')
    document.documentElement.dataset.theme = theme
  }, [appearance, theme])
  const value = useMemo<ThemeValue>(
    () => ({
      theme,
      appearance,
      setTheme(next) {
        persistTheme(next)
        updateTheme(next)
      },
    }),
    [theme, appearance],
  )
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme(): ThemeValue {
  const value = useContext(ThemeContext)
  if (!value) throw new Error('useTheme must be used inside ThemeProvider')
  return value
}
