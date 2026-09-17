import type { Plugin } from 'vite'

/** React Fast Refresh injects a preamble in development. Keep production CSP strict. */
export function developmentCsp(): Plugin {
  return {
    name: 'development-csp',
    apply: 'serve',
    transformIndexHtml: {
      order: 'pre',
      handler: (html) => html.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'"),
    },
  }
}
