import { isLocale, resolveLocale, type Locale } from '../../../shared/i18n'

export const localeStorageKey = 'agent-matrix:locale'

export function getInitialLocale(): Locale {
  try {
    const saved = localStorage.getItem(localeStorageKey)
    if (isLocale(saved)) return saved
  } catch {
    /* Storage may be unavailable in a restricted browser preview. */
  }
  return resolveLocale(navigator.languages.length ? navigator.languages : [navigator.language])
}

export function persistLocale(locale: Locale): void {
  try {
    localStorage.setItem(localeStorageKey, locale)
  } catch {
    /* Language switching still works for the current window. */
  }
}
