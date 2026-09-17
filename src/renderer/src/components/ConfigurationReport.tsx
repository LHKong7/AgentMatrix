import { useEffect, useState } from 'react'
import type { SessionSnapshot } from '../../../shared/sessions/schema'
import type { ConfigurationReport as Report } from '../../../shared/engines/configuration-report'
import { formatError } from '../../../shared/errors'
import { useI18n } from '../i18n'
import { api } from '../lib/api'
import { Modal } from './Modal'

export function ConfigurationReport({
  session,
  workspaceRevision,
  onClose,
}: {
  session: SessionSnapshot
  workspaceRevision: number
  onClose(): void
}) {
  const { t, locale } = useI18n()
  const [report, setReport] = useState<Report | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    let active = true
    setReport(null)
    setError(null)
    void api.sessions
      .configuration({ sessionId: session.id })
      .then((value) => {
        if (active) setReport(value)
      })
      .catch((failure) => {
        if (active) setError(failure)
      })
    return () => {
      active = false
    }
  }, [
    session.id,
    session.runId,
    session.status,
    session.configuration?.checkedAt,
    workspaceRevision,
    refresh,
  ])
  return (
    <Modal title={t('report.title')} subtitle={t('report.description')} onClose={onClose}>
      <div className="modal-body configuration-report">
        {error ? (
          <p role="alert" className="error-banner">
            {formatError(error, locale)}
          </p>
        ) : !report ? (
          <p>{t('common.loading')}</p>
        ) : (
          <>
            <p className="report-summary" data-testid="configuration-saved-state">
              {t(`report.saved.${report.savedState}`)}
            </p>
            <p className="hint">{t('report.limits')}</p>
            <dl>
              <dt>{t('report.captured')}</dt>
              <dd>
                {new Date(report.capturedAt).toLocaleString(locale)} ·{' '}
                {t('report.revisions', {
                  captured: report.workspaceRevision,
                  current: report.currentWorkspaceRevision,
                })}
              </dd>
              <dt>{t('report.adapter')}</dt>
              <dd>
                {report.engine} {report.engineVersion} · {report.adapter.id} /{' '}
                {report.adapter.version}
              </dd>
              <dt>{t('report.cwd')}</dt>
              <dd>{report.cwd}</dd>
              <dt>{t('report.nativeId')}</dt>
              <dd>{report.nativeSessionId ?? '—'}</dd>
              <dt>{t('report.observation')}</dt>
              <dd>
                {report.observation ? (
                  <>
                    {new Date(report.observation.checkedAt).toLocaleString(locale)} ·{' '}
                    {t(
                      report.observationIsCurrent
                        ? 'report.currentObservation'
                        : 'report.historicalObservation',
                    )}
                  </>
                ) : (
                  t('report.noObservation')
                )}
              </dd>
            </dl>
            {report.failure && (
              <p className="error-banner">
                {t('report.failed')} {t(`sessions.failure.${report.failure}`)}
              </p>
            )}
            <div className="report-table">
              <table aria-label={t('report.fields')}>
                <thead>
                  <tr>
                    <th>{t('report.field')}</th>
                    <th>{t('report.capturedValue')}</th>
                    <th>{t('report.evidence')}</th>
                    <th>{t('report.update')}</th>
                  </tr>
                </thead>
                <tbody>
                  {report.fields.map((field) => (
                    <tr key={field.id} data-report-field={field.id}>
                      <th scope="row">{t(`report.field.${field.id}`)}</th>
                      <td>
                        <code>{field.value === 'default' ? t('report.default') : field.value}</code>
                      </td>
                      <td>
                        <strong>{t(`report.status.${field.status}`)}</strong>
                        {field.checks.map((check) => (
                          <small key={check}>{t(`report.check.${check}`)}</small>
                        ))}
                      </td>
                      <td>
                        {field.changed === null
                          ? t('report.unknown')
                          : t(field.changed ? 'report.pending' : 'report.unchanged')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <h3>{t('report.assets')}</h3>
            {report.assets.length === 0 ? (
              <p>{t('report.noAssets')}</p>
            ) : (
              <div className="report-table">
                <table aria-label={t('report.assets')}>
                  <thead>
                    <tr>
                      <th>{t('report.asset')}</th>
                      <th>{t('report.capturedVersion')}</th>
                      <th>{t('report.nextVersion')}</th>
                      <th>{t('report.libraryVersion')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.assets.map((asset) => (
                      <tr key={`${asset.kind}:${asset.id}`} data-report-asset={asset.id}>
                        <th scope="row">
                          {asset.id}
                          <small>
                            {t(`report.asset.${asset.kind}`)} · {asset.source}
                            {asset.mode ? ` · ${asset.mode}` : ''}
                          </small>
                          <small>{asset.path}</small>
                          <small>{asset.digest ?? '—'}</small>
                        </th>
                        <td>v{asset.version}</td>
                        <td>{asset.nextVersion === null ? '—' : `v${asset.nextVersion}`}</td>
                        <td>{asset.libraryVersion === null ? '—' : `v${asset.libraryVersion}`}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="hint">{t('report.assetHint')}</p>
            <details>
              <summary>{t('report.sources', { count: report.sources.length })}</summary>
              <p className="hint">{t(`report.coverage.${report.sourceCoverage}`)}</p>
              <ul>
                {report.sources.map((source) => (
                  <li key={source.path}>
                    <code>{source.path}</code>
                    <small>{source.exists ? source.digest : t('report.sourceAbsent')}</small>
                  </li>
                ))}
              </ul>
            </details>
            <details>
              <summary>{t('report.integrity')}</summary>
              <code>
                {report.snapshotId}
                <br />
                {report.snapshotDigest}
              </code>
              <ul>
                {report.observation?.checks.map((check) => (
                  <li key={check}>{t(`report.check.${check}`)}</li>
                ))}
              </ul>
            </details>
            <p className="hint">{t('report.credentials')}</p>
          </>
        )}
      </div>
      <div className="modal-footer">
        <button className="button secondary" onClick={() => setRefresh((value) => value + 1)}>
          {t('common.reload')}
        </button>
        <button className="button primary" onClick={onClose}>
          {t('common.close')}
        </button>
      </div>
    </Modal>
  )
}
