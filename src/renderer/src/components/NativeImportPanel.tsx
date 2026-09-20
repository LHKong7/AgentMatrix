import { useRef, useState } from 'react'
import { FileInput } from 'lucide-react'
import type { NativeImportPreview, NativeImportRecord } from '../../../shared/engines/native-import'
import { nativeImportSources } from '../../../shared/engines/native-import'
import type { EngineWorkspace } from '../../../shared/engines/workspace'
import { collectionLabels } from '../../../shared/engines/editing'
import { formatError } from '../../../shared/errors'
import { useI18n } from '../i18n'
import { api } from '../lib/api'
import { buttonVariants } from './ui/button'

function SourceDetails({ record }: { record: NativeImportRecord }) {
  const { t, locale, number } = useI18n()
  return (
    <div className="native-import-source">
      <strong>{t('nativeImport.source')}</strong>
      {nativeImportSources(record).map((entry, index) => (
        <p key={index}>
          <code>{entry.source.path}</code> · {number(entry.source.bytes)} B
          {'referencePath' in entry && (
            <>
              <br />
              <code>{entry.referencePath}</code>
            </>
          )}
        </p>
      ))}
      <p className="hint">
        {record.engine === 'pi'
          ? 'Pi'
          : record.engine === 'deepseek-harness'
            ? 'DeepSeek Harness'
            : 'OpenCode'}{' '}
        {record.contractVersion} · {new Date(record.importedAt).toLocaleString(locale)}
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
  const installations = workspace.installations.filter((entry) =>
    ['opencode', 'pi', 'deepseek-harness'].includes(entry.kind),
  )
  const [selected, setSelected] = useState('')
  const installationId = installations.some((entry) => entry.id === selected)
    ? selected
    : (installations[0]?.id ?? '')
  const [preview, setPreview] = useState<NativeImportPreview | null>(null)
  const [busy, setBusy] = useState<'reading' | 'adding' | 'importing' | null>(null)
  const lock = useRef(false)
  const [error, setError] = useState<unknown>(null)
  const [saved, setSaved] = useState(false)
  async function run(action: 'reading' | 'adding' | 'importing', referencePath?: string) {
    if (lock.current) return
    lock.current = true
    setBusy(action)
    setError(null)
    setSaved(false)
    try {
      if (action === 'reading' || action === 'adding') {
        const previousPreviewId = action === 'adding' ? preview?.id : undefined
        if (action === 'reading') setPreview(null)
        const next = await api.previewNativeImport({
          installationId,
          ...(previousPreviewId ? { previousPreviewId } : {}),
          ...(referencePath ? { referencePath } : {}),
        })
        if (next || action === 'reading') setPreview(next)
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
      if (action === 'adding') setPreview(null)
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
      {installations.find((entry) => entry.id === installationId)?.kind === 'pi' && (
        <p className="hint">{t('nativeImport.piFiles')}</p>
      )}
      {installations.find((entry) => entry.id === installationId)?.kind === 'deepseek-harness' && (
        <p className="hint">{t('nativeImport.dshFiles')}</p>
      )}
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
        className={buttonVariants({ variant: 'outline', size: 'sm' })}
        disabled={!!busy || !desktop || !installationId}
        onClick={() => void run('reading')}
      >
        {t(busy === 'reading' ? 'nativeImport.reading' : 'nativeImport.choose')}
      </button>
      {preview?.record.engine === 'deepseek-harness' && (
        <button
          className={buttonVariants({ variant: 'outline', size: 'sm' })}
          disabled={!!busy}
          onClick={() => void run('adding')}
        >
          {t(busy === 'adding' ? 'nativeImport.reading' : 'nativeImport.addFiles')}
        </button>
      )}
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
          {!!preview.promptReferences?.length && (
            <section className="native-import-references">
              <h4>{t('nativeImport.promptFiles')}</h4>
              <p className="hint">{t('nativeImport.promptFilesHint')}</p>
              {preview.promptReferences.map((reference) => (
                <div
                  className="native-import-source"
                  key={reference.path}
                  data-import-reference={reference.path}
                >
                  <strong>
                    {t(
                      reference.mode === 'replace'
                        ? 'nativeImport.replacePrompt'
                        : 'nativeImport.appendPrompt',
                    )}
                  </strong>
                  <p>
                    <code>{reference.path}</code>
                  </p>
                  <p>
                    <code>{reference.reference}</code>
                  </p>
                  {reference.selectedPath && (
                    <p>
                      {t('nativeImport.selectedPrompt')}: <code>{reference.selectedPath}</code>
                    </p>
                  )}
                  <button
                    className={buttonVariants({ variant: 'outline', size: 'sm' })}
                    disabled={!!busy}
                    onClick={() => void run('adding', reference.path)}
                  >
                    {t(
                      reference.selectedPath
                        ? 'nativeImport.replaceFile'
                        : 'nativeImport.selectPromptFile',
                    )}
                  </button>
                </div>
              ))}
            </section>
          )}
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
            className={buttonVariants()}
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
