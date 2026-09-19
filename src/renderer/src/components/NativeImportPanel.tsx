import { useRef, useState } from 'react'
import { FileInput } from 'lucide-react'
import type { NativeImportPreview, NativeImportRecord } from '../../../shared/engines/native-import'
import type { EngineWorkspace } from '../../../shared/engines/workspace'
import { collectionLabels } from '../../../shared/engines/editing'
import { formatError } from '../../../shared/errors'
import { useI18n } from '../i18n'
import { api } from '../lib/api'

function SourceDetails({ record }: { record: NativeImportRecord }) {
  const { t, locale, number } = useI18n()
  return (
    <div className="native-import-source">
      <p>
        <strong>{t('nativeImport.source')}</strong>
        <br />
        <code>{record.source.path}</code>
      </p>
      <p className="hint">
        OpenCode {record.contractVersion} · {new Date(record.importedAt).toLocaleString(locale)} ·{' '}
        {number(record.source.bytes)} B
      </p>
      <details>
        <summary>
          {t('nativeImport.mapping')} ({number(record.mappings.length)})
        </summary>
        <ul className="native-import-list">
          {record.mappings.map((mapping, index) => (
            <li key={index}>
              <code>{mapping.path || '/'}</code> → {t(collectionLabels[mapping.collection])}
              <br />
              <code>
                {mapping.id} · {mapping.field}
              </code>
            </li>
          ))}
        </ul>
      </details>
      <details open={record.diagnostics.length > 0}>
        <summary>
          {t('nativeImport.diagnostics')} ({number(record.diagnostics.length)})
        </summary>
        {record.diagnostics.length === 0 ? (
          <p className="hint">{t('nativeImport.none')}</p>
        ) : (
          <ul className="native-import-list">
            {record.diagnostics.map((diagnostic, index) => (
              <li key={index}>
                <code>{diagnostic.path || '/'}</code>
                <br />
                {t(`nativeImport.diagnostic.${diagnostic.code}`)}
              </li>
            ))}
          </ul>
        )}
      </details>
    </div>
  )
}

export function NativeImportPanel({
  workspace,
  desktop,
  onImported,
}: {
  workspace: EngineWorkspace
  desktop: boolean
  onImported: (workspace: EngineWorkspace) => void
}) {
  const { t, locale, number } = useI18n()
  const installations = workspace.installations.filter((entry) => entry.kind === 'opencode')
  const [selected, setSelected] = useState('')
  const installationId = installations.some((entry) => entry.id === selected)
    ? selected
    : (installations[0]?.id ?? '')
  const [preview, setPreview] = useState<NativeImportPreview | null>(null)
  const [busy, setBusy] = useState<'reading' | 'importing' | null>(null)
  const lock = useRef(false)
  const [error, setError] = useState<unknown>(null)
  const [saved, setSaved] = useState(false)
  async function run(action: 'reading' | 'importing') {
    if (lock.current) return
    lock.current = true
    setBusy(action)
    setError(null)
    setSaved(false)
    try {
      if (action === 'reading') {
        setPreview(null)
        setPreview(await api.previewNativeImport({ installationId }))
      } else if (preview) {
        const result = await api.applyNativeImport({
          id: preview.id,
          workspaceRevision: preview.workspaceRevision,
        })
        onImported(result)
        setPreview(null)
        setSaved(true)
      }
    } catch (failure) {
      setError(failure)
    } finally {
      lock.current = false
      setBusy(null)
    }
  }
  return (
    <section className="settings-panel native-import-panel" aria-labelledby="native-import-heading">
      <h2 id="native-import-heading">
        <FileInput size={20} />
        {t('nativeImport.title')}
      </h2>
      <p className="hint">{t('nativeImport.description')}</p>
      {!desktop && <p className="hint">{t('error.nativeImportDesktopOnly')}</p>}
      {!installations.length && <p className="hint">{t('nativeImport.noInstallation')}</p>}
      <label className="field">
        {t('nativeImport.installation')}
        <select
          value={installationId}
          disabled={!!busy || !desktop || !installations.length}
          onChange={(event) => {
            setSelected(event.target.value)
            setPreview(null)
            setSaved(false)
            setError(null)
          }}
        >
          {installations.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.name}
            </option>
          ))}
        </select>
      </label>
      <button
        className="button secondary"
        disabled={!!busy || !desktop || !installationId}
        onClick={() => void run('reading')}
      >
        {t(busy === 'reading' ? 'nativeImport.reading' : 'nativeImport.choose')}
      </button>
      {error !== null && (
        <p className="error-banner" role="alert">
          {formatError(error, locale)}
        </p>
      )}
      {saved && <p role="status">{t('nativeImport.saved')}</p>}
      {preview && (
        <div className="native-import-preview">
          <h3>{t('nativeImport.preview')}</h3>
          <p className="hint">{t('nativeImport.scope')}</p>
          <p className="hint">{t('nativeImport.archive')}</p>
          <p>{t('nativeImport.secrets', { count: number(preview.credentials) })}</p>
          <h4>
            {t('nativeImport.entities')} ({number(preview.entities.length)})
          </h4>
          <ul className="native-import-list">
            {preview.entities.map((entry) => (
              <li key={entry.id}>
                {t(collectionLabels[entry.collection])} · <strong>{entry.name}</strong>
              </li>
            ))}
          </ul>
          <SourceDetails record={preview.record} />
          <button
            className="button primary"
            disabled={!!busy}
            onClick={() => void run('importing')}
          >
            {t(busy === 'importing' ? 'nativeImport.importing' : 'nativeImport.apply')}
          </button>
        </div>
      )}
      <h3>{t('nativeImport.history')}</h3>
      {workspace.nativeImports?.length ? (
        [...workspace.nativeImports].reverse().map((record) => (
          <details key={record.id} className="native-import-history">
            <summary>{record.source.path}</summary>
            <SourceDetails record={record} />
          </details>
        ))
      ) : (
        <p className="hint">{t('nativeImport.empty')}</p>
      )}
    </section>
  )
}
