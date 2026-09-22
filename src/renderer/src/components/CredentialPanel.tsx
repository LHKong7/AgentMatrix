import { useEffect, useState, type FormEvent } from 'react'
import { KeyRound } from 'lucide-react'
import type { CredentialMetadata, CredentialStatus } from '../../../shared/credentials'
import { formatError } from '../../../shared/errors'
import { useI18n } from '../i18n'
import { api } from '../lib/api'
import { buttonVariants } from './ui/button'
import { Badge } from './ui/badge'
import { Input, Select } from './ui/input'

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
    <section
      className="credential-panel mb-5 grid gap-3 rounded-xl border border-border bg-card p-5 shadow-xs"
      aria-labelledby="credentials-heading"
    >
      <h2 id="credentials-heading" className="flex items-center gap-2">
        <KeyRound size={16} aria-hidden="true" />
        {t('credentials.title')}
      </h2>
      <p className="text-xs leading-relaxed text-muted-foreground">{t('credentials.hint')}</p>
      <p className="text-xs leading-relaxed text-muted-foreground">{t('credentials.retention')}</p>
      {error !== null && (
        <p
          className="rounded-lg border border-destructive/35 bg-destructive/10 px-4 py-3 text-xs leading-relaxed text-destructive"
          role="alert"
        >
          {formatError(error, locale)}
        </p>
      )}
      {notice && <p role="status">{t(notice)}</p>}
      {!status && !error && <p role="status">{t('credentials.loading')}</p>}
      {status && !status.available && <p role="status">{t('credentials.unavailable')}</p>}
      {status && (
        <>
          <ul className="grid list-none gap-2 pl-0">
            {status.credentials.map((item) => (
              <li
                key={item.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border px-3 py-2"
              >
                <div className="grid min-w-0 gap-1">
                  <strong className="text-xs">{item.name}</strong>
                  <code className="text-muted-foreground">{item.id}</code>
                  <Badge variant="muted">{item.kind === 'api-key' ? 'API Key' : 'Bearer'}</Badge>
                </div>
                <div className="flex flex-wrap gap-2">
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
          {status.credentials.length === 0 && (
            <p className="text-xs leading-relaxed text-muted-foreground">
              {t('credentials.empty')}
            </p>
          )}
          <form onSubmit={save}>
            <fieldset disabled={busy || !status.available}>
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="mb-5 grid gap-2 text-xs font-medium">
                  {t('credentials.name')}
                  <Input
                    required
                    maxLength={80}
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                  />
                </label>
                <label className="mb-5 grid gap-2 text-xs font-medium">
                  {t('credentials.kind')}
                  <Select
                    value={kind}
                    onChange={(event) => setKind(event.target.value as 'api-key' | 'bearer')}
                  >
                    <option value="api-key">API Key</option>
                    <option value="bearer">Bearer</option>
                  </Select>
                </label>
              </div>
              <label className="mb-5 grid gap-2 text-xs font-medium">
                {t('credentials.value')}
                <Input
                  required
                  type="password"
                  autoComplete="new-password"
                  spellCheck={false}
                  maxLength={65536}
                  value={value}
                  onChange={(event) => setValue(event.target.value)}
                />
              </label>
              <div className="flex flex-wrap gap-2">
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
