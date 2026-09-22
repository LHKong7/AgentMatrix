import type { ModelConnection } from './schema'

type Engine = 'opencode' | 'pi' | 'deepseek-harness'

function anthropicUrl(value: string): URL {
  const url = new URL(value)
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('Unsupported Anthropic endpoint')
  url.pathname = url.pathname.replace(/\/+$/, '') || '/'
  if (url.pathname.endsWith('/messages')) throw new Error('Expected an Anthropic base URL')
  return url
}
const serialize = (url: URL) => url.toString().replace(/\/$/, '')

/** Shared Anthropic URLs accept a provider root or a /v1 API base, including proxy prefixes. */
export function nativeProviderBaseUrl(
  protocol: ModelConnection['protocol'],
  value: string,
  engine: Engine,
): string {
  if (protocol !== 'anthropic-messages') return value
  const url = anthropicUrl(value)
  const path = url.pathname.replace(/\/$/, '')
  const apiPath = path.endsWith('/v1') ? path : `${path}/v1`
  url.pathname = engine === 'opencode' ? apiPath : apiPath.slice(0, -3) || '/'
  return serialize(url)
}

/** Preserve the native request target when converting an SDK-specific base into shared data. */
export function importedProviderBaseUrl(
  protocol: ModelConnection['protocol'],
  value: string,
  engine: Engine,
): string {
  if (protocol !== 'anthropic-messages' || !value) return value
  const url = anthropicUrl(value)
  if (engine === 'opencode') {
    if (!url.pathname.endsWith('/v1')) throw new Error('Unrepresentable native API base')
  } else url.pathname = `${url.pathname.replace(/\/$/, '')}/v1`
  return serialize(url)
}
