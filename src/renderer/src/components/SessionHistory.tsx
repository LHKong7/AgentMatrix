import { useEffect, useState } from 'react'
import type {
  SessionHistoryPage,
  SessionSnapshot,
  SessionExportResult,
} from '../../../shared/sessions/schema'
import { formatError } from '../../../shared/errors'
import { api } from '../lib/api'
import { useI18n } from '../i18n'
import { Modal } from './Modal'
import { Transcript } from './SessionTranscript'
import { buttonVariants } from './ui/button'

export function SessionHistory({
  session,
  onClose,
}: {
  session: SessionSnapshot
  onClose: () => void
}) {
  const { t, locale } = useI18n()
  const [query, setQuery] = useState({
    sessionId: session.id,
    throughCursor: session.cursor,
    fromCursor: session.cursor,
    direction: 'backward' as 'backward' | 'forward',
  })
  const [page, setPage] = useState<SessionHistoryPage | null>(null)
  const [loading, setLoading] = useState(true)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [exported, setExported] = useState<SessionExportResult | null>(null)
  useEffect(() => {
    let active = true
    setLoading(true)
    setError(null)
    void api.sessions
      .history(query)
      .then((value) => {
        if (active) setPage(value)
      })
      .catch((failure) => {
        if (active) {
          setPage(null)
          setError(failure)
        }
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [query])
  const busy = loading || working
  const first = page?.events[0]?.cursor ?? 0
  const last = page?.events.at(-1)?.cursor ?? 0
  async function act(operation: () => Promise<void>) {
    if (busy) return
    setWorking(true)
    setError(null)
    try {
      await operation()
    } catch (failure) {
      setError(failure)
    } finally {
      setWorking(false)
    }
  }
  const navigate = (fromCursor: number, direction: 'forward' | 'backward') => {
    setLoading(true)
    setQuery({ ...query, fromCursor, direction })
    setExported(null)
  }
  return (
    <Modal
      title={t('history.title')}
      subtitle={t('history.description')}
      onClose={onClose}
      busy={working}
    >
      <div
        className="session-history grid gap-3 min-h-0 flex-1 overflow-y-auto px-6 py-5"
        aria-busy={busy}
      >
        <p className="text-xs leading-relaxed text-muted-foreground">{t('history.boundary')}</p>
        <div className="flex flex-wrap gap-2">
          <button
            className={buttonVariants({ variant: 'outline', size: 'sm' })}
            disabled={busy || !page?.hasEarlier}
            onClick={() => navigate(1, 'forward')}
          >
            {t('history.first')}
          </button>
          <button
            className={buttonVariants({ variant: 'outline', size: 'sm' })}
            disabled={busy || !page?.hasEarlier}
            onClick={() => navigate(first - 1, 'backward')}
          >
            {t('history.earlier')}
          </button>
          <button
            className={buttonVariants({ variant: 'outline', size: 'sm' })}
            disabled={busy || !page?.hasLater}
            onClick={() => navigate(last + 1, 'forward')}
          >
            {t('history.later')}
          </button>
          <button
            className={buttonVariants({ variant: 'outline', size: 'sm' })}
            disabled={busy || !page?.hasLater}
            onClick={() => navigate(query.throughCursor, 'backward')}
          >
            {t('history.latest')}
          </button>
        </div>
        <p
          className="history-range text-xs text-muted-foreground"
          role="status"
          data-history-first={first}
          data-history-last={last}
          data-history-through={query.throughCursor}
        >
          {loading
            ? t('common.loading')
            : t('history.range', { first, last, total: query.throughCursor })}
        </p>
        {Math.max(session.cursor, page?.latestCursor ?? 0) > query.throughCursor && (
          <p className="text-xs leading-relaxed text-muted-foreground">{t('history.newEvents')}</p>
        )}
        {error != null && (
          <p
            className="rounded-lg border border-destructive/35 bg-destructive/10 px-4 py-3 text-xs leading-relaxed text-destructive"
            role="alert"
          >
            {formatError(error, locale)}
          </p>
        )}
        {!loading && page && (
          <div
            className="grid max-h-[50vh] gap-4 overflow-y-auto rounded-lg border border-border p-3"
            key={`${first}:${last}`}
          >
            {page.events.length ? (
              <Transcript events={page.events} history />
            ) : (
              <p>{t('history.empty')}</p>
            )}
          </div>
        )}
        {exported && (
          <p className="history-exported text-xs break-all text-muted-foreground" role="status">
            {t('history.exported', { count: exported.eventCount, path: exported.path })}
          </p>
        )}
        <p className="text-xs leading-relaxed text-muted-foreground">{t('history.exportHint')}</p>
      </div>
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-border px-6 py-4">
        <button
          className={buttonVariants({ variant: 'outline', size: 'sm' })}
          disabled={busy}
          onClick={() =>
            void act(async () => {
              const latest = await api.sessions.get({ sessionId: session.id })
              setLoading(true)
              setQuery({
                sessionId: session.id,
                throughCursor: latest.cursor,
                fromCursor: latest.cursor,
                direction: 'backward',
              })
              setExported(null)
            })
          }
        >
          {t('history.refresh')}
        </button>
        <button
          className={buttonVariants({ variant: 'outline', size: 'sm' })}
          disabled={busy || !page}
          onClick={() =>
            void act(async () => {
              setExported(null)
              setExported(
                await api.sessions.exportHistory({
                  sessionId: session.id,
                  throughCursor: query.throughCursor,
                }),
              )
            })
          }
        >
          {t('history.export')}
        </button>
        <button className={buttonVariants()} disabled={working} onClick={onClose}>
          {t('common.close')}
        </button>
      </div>
    </Modal>
  )
}
