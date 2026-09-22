import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  isLocale,
  translate,
  type Locale,
  type MessageKey,
  type MessageParams,
} from '../../../shared/i18n'
import { getInitialLocale, localeStorageKey, persistLocale } from './preferences'

interface I18nValue {
  locale: Locale
  setLocale: (locale: Locale) => void
  t: (key: MessageKey, params?: MessageParams) => string
  number: (value: number) => string
}

const I18nContext = createContext<I18nValue | null>(null)

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, updateLocale] = useState(getInitialLocale)
  useEffect(() => {
    document.documentElement.lang = locale
    const onStorage = (event: StorageEvent) => {
      if (event.key === localeStorageKey && isLocale(event.newValue)) updateLocale(event.newValue)
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [locale])
  const value = useMemo<I18nValue>(
    () => ({
      locale,
      setLocale(next) {
        persistLocale(next)
        updateLocale(next)
      },
      t: (key, params) => translate(locale, key, params),
      number: (count) => new Intl.NumberFormat(locale).format(count),
    }),
    [locale],
  )
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext)
  if (!value) throw new Error('useI18n must be used inside I18nProvider')
  return value
}
