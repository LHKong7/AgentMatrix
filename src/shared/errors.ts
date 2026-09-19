import { z } from 'zod'
import { isMessageKey, translate, type Locale, type MessageKey, type MessageParams } from './i18n'

type ErrorKey = Extract<MessageKey, `error.${string}`>
const prefix = 'AGENT_MATRIX_ERROR:'
const applicationErrors = new WeakMap<Error, string>()

export function getErrorKey(error: unknown): ErrorKey | null {
  if (!(error instanceof Error) || !error.message.startsWith(prefix)) return null
  try {
    const value: unknown = JSON.parse(error.message.slice(prefix.length))
    const { key } = z.object({ key: z.string() }).parse(value)
    return isMessageKey(key) && key.startsWith('error.') ? (key as ErrorKey) : null
  } catch {
    return null
  }
}

// Electron invoke preserves Error.message, but not custom Error properties.
export function appError(key: ErrorKey, params: MessageParams = {}): Error {
  const message = `${prefix}${JSON.stringify({ key, params })}`
  const error = new Error(message)
  applicationErrors.set(error, message)
  return error
}

/** Only locally created errors are trusted at IPC boundaries; never copy stack/cause/properties. */
export function copyAppError(error: unknown): Error | null {
  if (!(error instanceof Error)) return null
  const message = applicationErrors.get(error)
  if (!message) return null
  const copy = new Error(message)
  applicationErrors.set(copy, message)
  return copy
}

export function formatError(error: unknown, locale: Locale = 'en'): string {
  const t = (key: MessageKey, params?: MessageParams) => translate(locale, key, params)
  if (error instanceof z.ZodError) {
    return error.issues
      .map((issue) => {
        let message: string
        if (isMessageKey(issue.message)) message = t(issue.message)
        else if (issue.code === 'too_small')
          message = t('validation.min', { limit: String(issue.minimum) })
        else if (issue.code === 'too_big')
          message = t('validation.max', { limit: String(issue.maximum) })
        else message = t('validation.invalid')
        return issue.path.length ? `${issue.path.join('.')}: ${message}` : message
      })
      .join('\n')
  }
  if (error instanceof SyntaxError) return t('error.invalidJson')
  if (error instanceof Error) {
    const start = error.message.indexOf(prefix)
    if (start >= 0) {
      try {
        const payload: unknown = JSON.parse(error.message.slice(start + prefix.length))
        const decoded = z
          .object({
            key: z.string(),
            params: z.record(z.string(), z.union([z.string(), z.number()])),
          })
          .parse(payload)
        if (isMessageKey(decoded.key) && decoded.key.startsWith('error.'))
          return t(decoded.key, decoded.params)
      } catch {
        /* Fall back to a readable diagnostic for unrecognized payloads. */
      }
    }
    return error.message
  }
  return t('error.failed')
}
