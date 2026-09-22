import type { SessionCapabilityReport } from '../../../shared/engines/session-capabilities'
import { isMessageKey } from '../../../shared/i18n'
import { useI18n } from '../i18n'
import { Table } from './ui/table'

export function SessionCapabilities({ report }: { report: SessionCapabilityReport }) {
  const { t, locale } = useI18n()
  return (
    <details className="session-capabilities">
      <summary>{t('capability.title')}</summary>
      <p className="text-xs leading-relaxed text-muted-foreground">{t('capability.hint')}</p>
      <p data-testid="capability-current">
        {t(report.current ? 'capability.current' : 'capability.historical')}
      </p>
      <p className="text-xs leading-relaxed text-muted-foreground">{t('capability.identity')}</p>
      <code className="font-mono text-[11px] break-all text-muted-foreground">
        {report.identity.snapshotDigest}
      </code>
      <code className="font-mono text-[11px] break-all text-muted-foreground">
        {report.identity.runId ?? '—'}
      </code>
      <Table aria-label={t('capability.title')}>
        <thead>
          <tr>
            <th>{t('capability.feature')}</th>
            <th>{t('support.mechanism')}</th>
            <th>{t('support.verification')}</th>
            <th>{t('support.availability')}</th>
          </tr>
        </thead>
        <tbody>
          {report.capabilities.map((entry) => (
            <tr
              key={entry.feature}
              data-session-capability={entry.feature}
              data-verification={entry.verification}
              data-availability={entry.availability}
            >
              <th scope="row">
                {t(`capability.feature.${entry.feature}`)}
                <small>{t(`capability.scope.${entry.feature}`)}</small>
                {!entry.requested && <small>{t('support.unused')}</small>}
              </th>
              <td>{t(`support.mechanism.${entry.mechanism}`)}</td>
              <td>
                {t(`capability.verification.${entry.verification}`)}
                <details>
                  <summary>{t('capability.evidence')}</summary>
                  {entry.evidence.map((evidence, index) => (
                    <small key={index}>
                      {t(`capability.evidence.${evidence.kind}`)} · {evidence.source} ·{' '}
                      {new Date(evidence.checkedAt).toLocaleString(locale)}
                    </small>
                  ))}
                </details>
              </td>
              <td>
                {entry.availability === 'unknown'
                  ? t('capability.availability.unknown')
                  : t(`support.availability.${entry.availability}`)}
                <small>
                  {isMessageKey(entry.reason) ? t(entry.reason) : t('capability.reason.unknown')}
                </small>
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
    </details>
  )
}
