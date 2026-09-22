import { useEffect, useRef, useState } from 'react'
import type { UnusedRunDataPage, UnusedRunData as RunData } from '../../../shared/sessions/run-data'
import { formatError } from '../../../shared/errors'
import { api } from '../lib/api'
import { useI18n } from '../i18n'
import { Modal } from './Modal'
import { buttonVariants } from './ui/button'

export function UnusedRunData({ onClose }: { onClose: () => void }) {
  const { t, locale } = useI18n()
  const [page, setPage] = useState<UnusedRunDataPage | null>(null)
  const [after, setAfter] = useState<string | undefined>()
  const [revision, setRevision] = useState(0)
  const [loading, setLoading] = useState(true)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const locked = useRef(false)
  useEffect(() => {
    let active = true
    setLoading(true)
    setPage(null)
    void api.sessions
      .unusedRunData(after ? { after } : {})
      .then((value) => {
        if (active) setPage(value)
      })
      .catch((failure) => {
        if (active) setError(failure)
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [after, revision])
  async function remove(item: RunData) {
    if (
      locked.current ||
      loading ||
      (!item.pending && !window.confirm(t('runData.confirm', { id: item.target.id })))
    )
      return
    locked.current = true
    setWorking(true)
    setError(null)
    try {
      await api.sessions.removeUnusedRunData({ target: item.target, token: item.token })
    } catch (failure) {
      setError(failure)
    } finally {
      locked.current = false
      setWorking(false)
      setRevision((value) => value + 1)
    }
  }
  const busy = loading || working
  return (
    <Modal
      title={t('runData.title')}
      subtitle={t('runData.description')}
      onClose={onClose}
      busy={working}
    >
      <div className="grid gap-3 min-h-0 flex-1 overflow-y-auto px-6 py-5" aria-busy={busy}>
        <p className="text-xs leading-relaxed text-muted-foreground">{t('runData.boundary')}</p>
        {error != null && (
          <div
            className="rounded-lg border border-destructive/35 bg-destructive/10 px-4 py-3 text-xs leading-relaxed text-destructive"
            role="alert"
          >
            {formatError(error, locale)}
          </div>
        )}
        {loading && <p role="status">{t('runData.loading')}</p>}
        {page && (
          <>
            {!page.items.length && <p role="status">{t('runData.empty')}</p>}
            {page.skipped > 0 && (
              <p className="text-xs leading-relaxed text-muted-foreground">
                {t('runData.skipped')}
              </p>
            )}
            <ul className="grid gap-2">
              {page.items.map((item) => (
                <li key={`${item.target.kind}:${item.target.id}`} data-unused-run={item.target.id}>
                  <div>
                    <strong>
                      {t(item.target.kind === 'capture' ? 'runData.capture' : 'runData.stage')}
                    </strong>
                    {item.capture && (
                      <>
                        <p>
                          {item.capture.agent} · {item.capture.engine}
                        </p>
                        <code className="grid gap-1 rounded-lg border border-border p-3">
                          {item.capture.cwd}
                        </code>
                      </>
                    )}
                    <details>
                      <summary>{t('runData.identifier')}</summary>
                      <code>{item.target.id}</code>
                    </details>
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      {item.pending
                        ? t('runData.pending')
                        : t('runData.modified', {
                            date: new Date(item.modifiedAt!).toLocaleString(locale),
                          })}
                    </p>
                  </div>
                  <button
                    className={buttonVariants({
                      variant: 'outline',
                      size: 'sm',
                      className: 'text-destructive hover:bg-destructive/10 hover:text-destructive',
                    })}
                    disabled={busy}
                    onClick={() => void remove(item)}
                  >
                    {t(item.pending ? 'runData.retry' : 'runData.remove')}
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-border px-6 py-4">
        <button
          className={buttonVariants({ variant: 'outline', size: 'sm' })}
          disabled={busy}
          onClick={() => {
            setError(null)
            setAfter(undefined)
            setRevision((value) => value + 1)
          }}
        >
          {t('runData.refresh')}
        </button>
        {page?.next && (
          <button
            className={buttonVariants({ variant: 'outline', size: 'sm' })}
            disabled={busy}
            onClick={() => {
              setError(null)
              setAfter(page.next!)
            }}
          >
            {t('runData.next')}
          </button>
        )}
        <button className={buttonVariants()} disabled={working} onClick={onClose}>
          {t('common.close')}
        </button>
      </div>
    </Modal>
  )
}
