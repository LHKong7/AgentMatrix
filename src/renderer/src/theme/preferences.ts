import { isThemePreference, type ThemePreference } from '../../../shared/theme'

export const themeStorageKey = 'agent-matrix:theme'

export function getInitialTheme(): ThemePreference {
  try {
    const saved = localStorage.getItem(themeStorageKey)
    if (isThemePreference(saved)) return saved
  } catch {
    /* Storage may be unavailable in a restricted browser preview. */
  }
  return 'system'
}

export function persistTheme(theme: ThemePreference): void {
  try {
    localStorage.setItem(themeStorageKey, theme)
  } catch {
    /* Switching still applies to the current window. */
  }
}

export function prefersDark(): boolean {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  } catch {
    return false
  }
}
