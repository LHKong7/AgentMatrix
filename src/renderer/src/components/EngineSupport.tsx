import { useEffect, useMemo, useState } from 'react'
import type { ResolvedAgentConfiguration } from '../../../shared/engines/resolution'
import { engineConfigurationIssues } from '../../../shared/engines/validation'
import {
  describeConfigurationCapabilities,
  type ConfigurationCapabilities,
} from '../../../shared/engines/capabilities'
import { isMessageKey } from '../../../shared/i18n'
import { useI18n } from '../i18n'

export function EngineSupport({
  configuration,
  platform,
}: {
  configuration: ResolvedAgentConfiguration
  platform?: string
}) {
  const { t, locale } = useI18n()
  const [expanded, setExpanded] = useState(false)
  const issues = useMemo(
    () => engineConfigurationIssues(configuration, { platform }),
    [configuration, platform],
  )
  const [result, setResult] = useState<{
    input: ResolvedAgentConfiguration
    platform?: string
    report: ConfigurationCapabilities | null
    error: unknown
  } | null>(null)
  useEffect(() => {
    if (!expanded) return
    let active = true
    const timer = setTimeout(() => {
      void describeConfigurationCapabilities(configuration, platform)
        .then((report) => {
          if (active) setResult({ input: configuration, platform, report, error: null })
        })
        .catch((error) => {
          if (active) setResult({ input: configuration, platform, report: null, error })
        })
    }, 250)
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [configuration, platform, expanded])
  const current = result?.input === configuration && result.platform === platform ? result : null
  const report = current?.report
  return (
    <section
      className="engine-support"
      data-testid="engine-support"
      aria-label={t('support.title')}
    >
      <h3>{t('support.title')}</h3>
      <p
        data-testid="engine-support-state"
        data-state={issues.length ? 'blocked' : 'checks-pending'}
      >
        {t(issues.length ? 'support.blocked' : 'support.eligible')}
      </p>
      {issues.length > 0 && (
        <ul className="diagnostic-list">
          {issues.map((issue, index) => (
            <li key={`${issue.code}:${issue.resourceId ?? index}`} data-engine-issue={issue.code}>
              <strong>{t(`report.field.${issue.field}`)}</strong> ·{' '}
              {t(`support.issue.${issue.code}`)}
              {issue.resourceId && <code>{issue.resourceId}</code>}
            </li>
          ))}
        </ul>
      )}
      <p className="hint">{t('support.limits')}</p>
      <details onToggle={(event) => setExpanded(event.currentTarget.open)}>
        <summary>{t('support.details')}</summary>
        {current?.error != null ? (
          <p className="form-error" role="alert">
            {t('support.unavailable')}
          </p>
        ) : !report ? (
          <p role="status">{t('common.loading')}</p>
        ) : (
          <>
            <p>
              {report.route.protocol ?? '—'} · {report.route.modelId}
            </p>
            <p className="hint">{t('support.evidenceScope')}</p>
            <div className="report-table">
              <table aria-label={t('support.details')}>
                <thead>
                  <tr>
                    <th>{t('report.field')}</th>
                    <th>{t('support.mechanism')}</th>
                    <th>{t('support.verification')}</th>
                    <th>{t('support.availability')}</th>
                  </tr>
                </thead>
                <tbody>
                  {report.capabilities.map((capability) => (
                    <tr key={capability.feature} data-capability={capability.feature}>
                      <th scope="row">
                        {t(`report.field.${capability.feature}`)}
                        <small>
                          {t(capability.requested ? 'support.requested' : 'support.unused')}
                        </small>
                      </th>
                      <td>{t(`support.mechanism.${capability.mechanism}`)}</td>
                      <td>{t(`support.verification.${capability.verification}`)}</td>
                      <td>
                        {t(`support.availability.${capability.availability}`)}
                        <small>
                          {isMessageKey(capability.reason)
                            ? t(capability.reason)
                            : t('support.reason.startup')}
                        </small>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="hint">
              {t('support.identity', {
                engine: configuration.installation.kind,
                version: configuration.installation.version ?? '—',
                mode: report.capabilities[0]?.mode ?? '—',
              })}
            </p>
            <code className="support-digest">{report.profileDigest}</code>
            <p className="hint">
              {t('support.contractEvidence', {
                time: new Date(report.assessedAt).toLocaleString(locale),
              })}
            </p>
          </>
        )}
      </details>
    </section>
  )
}
