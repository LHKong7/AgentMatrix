import { useEffect, useState, type FormEvent } from 'react'
import { KeyRound } from 'lucide-react'
import type { CredentialMetadata, CredentialStatus } from '../../../shared/credentials'
import { formatError } from '../../../shared/errors'
import { useI18n } from '../i18n'
import { api } from '../lib/api'
import { buttonVariants } from './ui/button'
import { Badge } from './ui/badge'

export function CredentialPanel() {
  const { t, locale } = useI18n()
  const [status, setStatus] = useState<CredentialStatus | null>(null)
  const [selected, setSelected] = useState<CredentialMetadata | null>(null)
  const [name, setName] = useState('')
  const [kind, setKind] = useState<'api-key' | 'bearer'>('api-key')
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [notice, setNotice] = useState<'credentials.saved' | 'credentials.deleted' | null>(null)
  useEffect(() => {
    let active = true
    void api
      .getCredentialStatus()
      .then((result) => {
        if (active) setStatus(result)
      })
      .catch((failure) => {
        if (active) setError(failure)
      })
    return () => {
      active = false
    }
  }, [])
  function reset() {
    setSelected(null)
    setName('')
    setKind('api-key')
    setValue('')
  }
  async function save(event: FormEvent) {
    event.preventDefault()
    if (busy || !status?.available) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const saved = await api.setCredential({
        id: selected?.id,
        name,
        kind,
        value,
        expectedRevision: selected?.revision ?? null,
      })
      setStatus(
        (current) =>
          current && {
            ...current,
            credentials: [...current.credentials.filter((item) => item.id !== saved.id), saved],
          },
      )
      reset()
      setNotice('credentials.saved')
    } catch (failure) {
      setError(failure)
    } finally {
      setBusy(false)
    }
  }
  async function remove(item: CredentialMetadata) {
    if (busy || !window.confirm(t('credentials.confirmDelete', { name: item.name }))) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await api.deleteCredential({ id: item.id, expectedRevision: item.revision })
      setStatus(
        (current) =>
          current && {
            ...current,
            credentials: current.credentials.filter((entry) => entry.id !== item.id),
          },
      )
      if (selected?.id === item.id) reset()
      setNotice('credentials.deleted')
    } catch (failure) {
      setError(failure)
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="settings-panel credential-panel" aria-labelledby="credentials-heading">
      <h2 id="credentials-heading">
        <KeyRound size={20} />
        {t('credentials.title')}
      </h2>
      <p className="hint">{t('credentials.hint')}</p>
      <p className="hint">{t('credentials.retention')}</p>
      {error !== null && (
        <p className="error-banner" role="alert">
          {formatError(error, locale)}
        </p>
      )}
      {notice && <p role="status">{t(notice)}</p>}
      {!status && !error && <p role="status">{t('credentials.loading')}</p>}
      {status && !status.available && <p role="status">{t('credentials.unavailable')}</p>}
      {status && (
        <>
          <ul className="credential-list">
            {status.credentials.map((item) => (
              <li key={item.id}>
                <div>
                  <strong>{item.name}</strong>
                  <code>{item.id}</code>
                  <Badge variant="muted">{item.kind === 'api-key' ? 'API Key' : 'Bearer'}</Badge>
                </div>
                <div className="credential-actions">
                  <button
                    type="button"
                    className={buttonVariants({ variant: 'outline', size: 'sm' })}
                    disabled={busy || !status.available}
                    onClick={() => {
                      setSelected(item)
                      setName(item.name)
                      setKind(item.kind)
                      setValue('')
                      setNotice(null)
                      setError(null)
                    }}
                  >
                    {t('credentials.replace')}
                  </button>
                  <button
                    type="button"
                    className={buttonVariants({ variant: 'outline', size: 'sm' })}
                    disabled={busy}
                    onClick={() => void remove(item)}
                  >
                    {t('credentials.delete')}
                  </button>
                </div>
              </li>
            ))}
          </ul>
          {status.credentials.length === 0 && <p className="hint">{t('credentials.empty')}</p>}
          <form onSubmit={save}>
            <fieldset disabled={busy || !status.available}>
              <div className="field-grid">
                <label className="field">
                  {t('credentials.name')}
                  <input
                    required
                    maxLength={80}
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                  />
                </label>
                <label className="field">
                  {t('credentials.kind')}
                  <select
                    value={kind}
                    onChange={(event) => setKind(event.target.value as 'api-key' | 'bearer')}
                  >
                    <option value="api-key">API Key</option>
                    <option value="bearer">Bearer</option>
                  </select>
                </label>
              </div>
              <label className="field">
                {t('credentials.value')}
                <input
                  required
                  type="password"
                  autoComplete="new-password"
                  spellCheck={false}
                  maxLength={65536}
                  value={value}
                  onChange={(event) => setValue(event.target.value)}
                />
              </label>
              <div className="credential-actions">
                <button className={buttonVariants()} type="submit">
                  {t(selected ? 'credentials.replace' : 'credentials.create')}
                </button>
                {selected && (
                  <button
                    type="button"
                    className={buttonVariants({ variant: 'outline', size: 'sm' })}
                    onClick={reset}
                  >
                    {t('credentials.cancel')}
                  </button>
                )}
              </div>
            </fieldset>
          </form>
        </>
      )}
    </section>
  )
}
