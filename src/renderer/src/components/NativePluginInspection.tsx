import { useEffect, useRef, useState } from 'react'
import type { EngineInstallation } from '../../../shared/engines/schema'
import type { PluginInspection } from '../../../shared/engines/plugin-inspection'
import { formatError } from '../../../shared/errors'
import { api } from '../lib/api'
import { useI18n } from '../i18n'

/** The caller keys this component by selection so an old result cannot describe a new path. */
export function NativePluginInspection({
  installation,
  path,
  version,
  onUseVersion,
}: {
  installation: EngineInstallation | undefined
  path: string
  version: string
  onUseVersion: (version: string) => void
}) {
  const { t, locale } = useI18n()
  const mounted = useRef(true)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<PluginInspection | null>(null)
  const [error, setError] = useState<unknown>(null)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  async function inspect() {
    if (!installation || busy) return
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const value = await api.inspectNativePlugin({ installationId: installation.id, path })
      if (mounted.current) setResult(value)
    } catch (failure) {
      if (mounted.current) setError(failure)
    } finally {
      if (mounted.current) setBusy(false)
    }
  }
  return (
    <section className="plugin-inspection" aria-label={t('plugin.result')} aria-busy={busy}>
      <button
        type="button"
        className="button secondary"
        disabled={busy || !path || installation?.kind !== 'opencode'}
        onClick={() => void inspect()}
      >
        {t(busy ? 'plugin.inspecting' : 'plugin.inspect')}
      </button>
      {installation?.kind !== 'opencode' && <p className="hint">{t('plugin.engineHint')}</p>}
      {error !== null && (
        <p className="form-error" role="alert">
          {formatError(error, locale)}
        </p>
      )}
      {result && (
        <>
          <p role="status">{t('plugin.filesOnly')}</p>
          <p className="hint">{t('plugin.scope')}</p>
          {result.engineVersion !== result.resolverVersion && (
            <p className="hint">{t('plugin.versionHint', { version: result.resolverVersion })}</p>
          )}
          <dl>
            <dt>{t('plugin.package')}</dt>
            <dd>{result.package?.name ?? t('plugin.unknown')}</dd>
            <dt>{t('plugin.version')}</dt>
            <dd>{result.package?.version ?? t('plugin.unknown')}</dd>
            <dt>{t('plugin.localSource')}</dt>
            <dd>{result.localSpecifier}</dd>
            <dt>{t('plugin.entry')}</dt>
            <dd>{result.entry.resolvedPath}</dd>
            <dt>{t('plugin.checkedAt')}</dt>
            <dd>{new Date(result.checkedAt).toLocaleString(locale)}</dd>
          </dl>
          {result.package?.engineRange && (
            <p className="hint">
              {t('plugin.range')}: {result.package.engineRange}
            </p>
          )}
          <p data-testid="plugin-engine-range" data-range-status={result.rangeStatus}>
            {t(`plugin.range.${result.rangeStatus}`, {
              version: result.engineVersion ?? t('plugin.unknown'),
            })}
          </p>
          <p className="hint">{t('plugin.rangeHint')}</p>
          {result.package?.version && result.package.version !== version && (
            <>
              {version && <p className="hint">{t('plugin.versionMismatch')}</p>}
              <button
                type="button"
                className="button secondary"
                onClick={() => onUseVersion(result.package!.version!)}
              >
                {t('plugin.useVersion')}
              </button>
            </>
          )}
          <details>
            <summary>SHA-256</summary>
            <dl>
              <dt>{t('plugin.digest')}</dt>
              <dd>
                <code>{result.entry.sha256}</code>
              </dd>
              {result.package && (
                <>
                  <dt>{t('plugin.metadataDigest')}</dt>
                  <dd>
                    <code>{result.package.file.sha256}</code>
                  </dd>
                </>
              )}
            </dl>
          </details>
        </>
      )}
    </section>
  )
}
