import { useEffect, useMemo, useRef, useState } from 'react'
import {
  libraryImpactQuerySchema,
  type LibraryImpact,
  type LibraryImpactQuery,
} from '../../../shared/engines/impact'
import type { LibraryCollection, LibraryEntry } from '../../../shared/engines/editing'
import { formatError } from '../../../shared/errors'
import { useI18n } from '../i18n'
import { api } from '../lib/api'
import { buttonVariants } from './ui/button'

interface Result {
  query: LibraryImpactQuery
  cursor: string | undefined
  refresh: number
  report: LibraryImpact | null
  error: unknown
}

export function LibraryImpactPreview({
  candidate,
  kind,
  revision,
}: {
  candidate: LibraryEntry
  kind: LibraryCollection
  revision: number
}) {
  const { t, locale } = useI18n()
  const query = useMemo(() => {
    const parsed = libraryImpactQuerySchema.safeParse({
      revision,
      change: { collection: kind, entry: candidate },
    })
    return parsed.success ? parsed.data : null
  }, [candidate, kind, revision])
  const [request, setRequest] = useState<{
    query: LibraryImpactQuery | null
    cursor?: string
    refresh: number
  }>({ query: null, refresh: 0 })
  const cursor = request.query === query ? request.cursor : undefined
  const refresh = request.query === query ? request.refresh : 0
  const [result, setResult] = useState<Result | null>(null)
  const queue = useRef(Promise.resolve())
  useEffect(() => {
    if (!query) return
    let active = true
    const timer = setTimeout(() => {
      // Serialize reads and skip obsolete drafts even if an earlier disk read is still in flight.
      queue.current = queue.current.then(async () => {
        if (!active) return
        try {
          const page = await api.sessions.impact({
            ...query,
            ...(cursor ? { afterSessionId: cursor } : {}),
          })
          if (!active) return
          setResult((previous) => {
            const prior =
              cursor && previous?.query === query && previous.refresh === refresh
                ? previous.report
                : null
            const report = prior
              ? {
                  ...page,
                  sessions: [
                    ...new Map(
                      [...prior.sessions, ...page.sessions].map((session) => [session.id, session]),
                    ).values(),
                  ],
                  scannedSessions: prior.scannedSessions + page.scannedSessions,
                }
              : page
            return { query, cursor, refresh, report, error: null }
          })
        } catch (error) {
          if (active) setResult({ query, cursor, refresh, error, report: null })
        }
      })
    }, 500)
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [query, cursor, refresh])

  const current = result?.query === query && result?.refresh === refresh ? result : null
  const report = current?.report
  const loading = query !== null && (!current || current.cursor !== cursor)
  const changed =
    report?.profiles.filter((profile) =>
      ['changed', 'blocked', 'resolved'].includes(profile.effect),
    ).length ?? 0
  return (
    <section className="library-impact" data-testid="library-impact" aria-label={t('impact.title')}>
      <h3>{t('impact.title')}</h3>
      <p className="hint">{t('impact.description')}</p>
      {!query && <p role="status">{t('impact.incomplete')}</p>}
      {loading && <p role="status">{t('impact.loading')}</p>}
      {current?.error != null && (
        <p role="alert" className="form-error">
          {formatError(current.error, locale)}
        </p>
      )}
      {report && (
        <>
          <p data-testid="impact-profile-summary">
            {t('impact.profiles', { count: report.profiles.length, changed })}
          </p>
          {report.profiles.length === 0 && <p className="hint">{t('impact.noProfiles')}</p>}
          <ul className="impact-profiles">
            {report.profiles.map((profile) => (
              <li key={profile.id} data-impact-profile={profile.id} data-effect={profile.effect}>
                <strong>{profile.name}</strong>
                <span>{t(`impact.profile.${profile.effect}`)}</span>
                {profile.fields.length > 0 && (
                  <small>
                    {profile.fields.map((field) => t(`report.field.${field}`)).join(' · ')}
                  </small>
                )}
                {profile.issues.map((issue) => (
                  <small key={issue}>{t(`resolution.${issue}`)}</small>
                ))}
              </li>
            ))}
          </ul>
          {report.sessionScope === 'browser' ? (
            <p className="hint">{t('impact.browser')}</p>
          ) : (
            <>
              <h4>{t('impact.sessions')}</h4>
              <p className="hint">{t('impact.retained')}</p>
              <p className="hint">{t('impact.scanned', { count: report.scannedSessions })}</p>
              {report.sessions.length === 0 && (
                <p>{t(report.nextSessionId ? 'impact.noSessionsYet' : 'impact.noSessions')}</p>
              )}
              {report.sessions.map((session) => (
                <details
                  key={session.id}
                  data-impact-session={session.id}
                  data-effect={session.effect}
                >
                  <summary>
                    {report.profiles.find((profile) => profile.id === session.agentId)?.name ??
                      session.agentId}{' '}
                    · {t(`impact.session.${session.effect}`)}
                  </summary>
                  <p className="hint">
                    {session.id}
                    <br />
                    {new Date(session.createdAt).toLocaleString(locale)} ·{' '}
                    {t(`sessions.status.${session.status}`)}
                  </p>
                  {session.alreadyPending && <p className="hint">{t('impact.alreadyPending')}</p>}
                  {session.fields.length > 0 && (
                    <p>{session.fields.map((field) => t(`report.field.${field}`)).join(' · ')}</p>
                  )}
                  <ul>
                    {session.assets.map((asset) => (
                      <li key={`${asset.kind}:${asset.id}`} data-impact-asset={asset.id}>
                        {t(`report.asset.${asset.kind}`)} · {asset.id} ·{' '}
                        {t('impact.versions', {
                          captured: asset.capturedVersion,
                          proposed:
                            asset.proposedVersion === null ? '—' : `v${asset.proposedVersion}`,
                        })}
                      </li>
                    ))}
                  </ul>
                </details>
              ))}
            </>
          )}
        </>
      )}
      {query && (
        <div className="impact-actions">
          {report?.nextSessionId && (
            <button
              type="button"
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
              disabled={loading}
              onClick={() => setRequest({ query, cursor: report.nextSessionId!, refresh })}
            >
              {t('impact.more')}
            </button>
          )}
          <button
            type="button"
            className={buttonVariants({ variant: 'outline', size: 'sm' })}
            disabled={loading}
            onClick={() => setRequest({ query, refresh: refresh + 1 })}
          >
            {t('common.reload')}
          </button>
        </div>
      )}
      <p className="hint">{t('impact.limits')}</p>
    </section>
  )
}
