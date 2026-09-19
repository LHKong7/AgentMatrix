import { useEffect, useRef, useState } from 'react'
import type { UnusedRunDataPage, UnusedRunData as RunData } from '../../../shared/sessions/run-data'
import { formatError } from '../../../shared/errors'
import { api } from '../lib/api'
import { useI18n } from '../i18n'
import { Modal } from './Modal'

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
      <div className="modal-body unused-run-data" aria-busy={busy}>
        <p className="hint">{t('runData.boundary')}</p>
        {error != null && (
          <div className="error-banner" role="alert">
            {formatError(error, locale)}
          </div>
        )}
        {loading && <p role="status">{t('runData.loading')}</p>}
        {page && (
          <>
            {!page.items.length && <p role="status">{t('runData.empty')}</p>}
            {page.skipped > 0 && <p className="hint">{t('runData.skipped')}</p>}
            <ul className="unused-run-list">
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
                        <code className="unused-run-directory">{item.capture.cwd}</code>
                      </>
                    )}
                    <details>
                      <summary>{t('runData.identifier')}</summary>
                      <code>{item.target.id}</code>
                    </details>
                    <p className="hint">
                      {item.pending
                        ? t('runData.pending')
                        : t('runData.modified', {
                            date: new Date(item.modifiedAt!).toLocaleString(locale),
                          })}
                    </p>
                  </div>
                  <button
                    className="button secondary danger"
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
      <div className="modal-footer">
        <button
          className="button secondary"
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
            className="button secondary"
            disabled={busy}
            onClick={() => {
              setError(null)
              setAfter(page.next!)
            }}
          >
            {t('runData.next')}
          </button>
        )}
        <button className="button primary" disabled={working} onClick={onClose}>
          {t('common.close')}
        </button>
      </div>
    </Modal>
  )
}
