import { en, type MessageKey } from './en'
import { zhCN } from './zh-CN'

export type { MessageKey } from './en'
export type Locale = 'en' | 'zh-CN'
export type MessageParams = Record<string, string | number>
export const catalogs = { en, 'zh-CN': zhCN }

export function isLocale(value: unknown): value is Locale {
  return value === 'en' || value === 'zh-CN'
}

export function resolveLocale(languages: readonly string[]): Locale {
  for (const language of languages) {
    if (/^zh(?:-|_|$)/i.test(language)) return 'zh-CN'
    if (/^en(?:-|_|$)/i.test(language)) return 'en'
  }
  return 'en'
}

export function isMessageKey(value: string): value is MessageKey {
  return Object.hasOwn(en, value)
}

export function translate(locale: Locale, key: MessageKey, params: MessageParams = {}): string {
  return catalogs[locale][key].replace(/\{(\w+)\}/g, (placeholder, name: string) => {
    const value = params[name]
    return value === undefined ? placeholder : String(value)
  })
}
