import { LibraryImpactPreview } from './LibraryImpactPreview'
import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Save } from 'lucide-react'
import { formatError } from '../../../shared/errors'
import type { CredentialMetadata } from '../../../shared/credentials'
import {
  libraryEntryLabels,
  reviseMarkdownSkill,
  revisePrompt,
  type LibraryCollection,
  type LibraryEntry,
} from '../../../shared/engines/editing'
import {
  initialEngineKinds,
  modelProtocolSchema,
  type EngineInstallation,
  type ModelConnection,
} from '../../../shared/engines/schema'
import type { EngineWorkspace, McpDefinition, PromptAsset } from '../../../shared/engines/workspace'
import { importSkillRevision } from '../../../shared/engines/skill-import'
import { api } from '../lib/api'
import { useI18n } from '../i18n'
import { Modal } from './Modal'
import { ResourcePicker } from './ResourcePicker'
import { AssetBindings } from './AssetBindings'
import {
  ArgumentField,
  JsonField,
  NumberField,
  SecretField,
  SelectField,
  TextField,
} from './ConfigurationFields'

function contentOf(resource: LibraryEntry): string {
  if (!('versions' in resource)) return ''
  const revision = resource.versions.find((item) => item.version === resource.currentVersion)
  return revision && 'content' in revision ? revision.content : ''
}

export function ResourceEditor({
  resource,
  kind,
  workspace,
  busy,
  onSave,
  onClose,
}: {
  resource: LibraryEntry
  kind: LibraryCollection
  workspace: EngineWorkspace
  busy: boolean
  onSave: (resource: LibraryEntry) => Promise<void>
  onClose: () => void
}) {
  const { t, locale, number } = useI18n()
  const [draft, setDraft] = useState(resource)
  const [content, setContent] = useState(contentOf(resource))
  const [dirty, setDirty] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [credentials, setCredentials] = useState<CredentialMetadata[]>([])
  const [importing, setImporting] = useState(false)
  const isNew = !workspace[kind].some((item) => item.id === resource.id)
  const candidate = useMemo(() => {
    let candidate = draft
    if ('purpose' in draft)
      candidate = isNew
        ? { ...draft, versions: [{ version: 1, content }] }
        : revisePrompt(draft, content)
    if (
      'sourcePath' in draft &&
      draft.versions.find((item) => item.version === draft.currentVersion)?.kind === 'markdown'
    )
      candidate = isNew
        ? { ...draft, versions: [{ version: 1, kind: 'markdown', content }] }
        : reviseMarkdownSkill(draft, content)
    return candidate
  }, [draft, content, isNew])
  useEffect(() => {
    let mounted = true
    void api
      .getCredentialStatus()
      .then((status) => {
        if (mounted) setCredentials(status.credentials)
      })
      .catch((failure) => {
        if (mounted) setError(failure)
      })
    return () => {
      mounted = false
    }
  }, [])
  const close = () => {
    if (
      (!dirty &&
        JSON.stringify(draft) === JSON.stringify(resource) &&
        content === contentOf(resource)) ||
      window.confirm(t('common.unsaved'))
    )
      onClose()
  }
  async function submit(event: FormEvent) {
    event.preventDefault()
    setError(null)
    try {
      await onSave(candidate)
    } catch (failure) {
      setError(failure)
    }
  }
  const changeInstallation = (value: EngineInstallation, patch: Partial<EngineInstallation>) =>
    setDraft({ ...value, ...patch, version: null, modes: [], probedAt: null })

  async function importDirectory() {
    if (!('sourcePath' in draft)) return
    setImporting(true)
    setError(null)
    try {
      const captured = await api.importSkillDirectory()
      if (!captured) return
      setDraft(importSkillRevision(draft, captured, isNew))
      setContent('')
      setDirty(true)
    } catch (failure) {
      setError(failure)
    } finally {
      setImporting(false)
    }
  }
  const directoryRevision =
    'versions' in draft
      ? draft.versions.find(
          (item) =>
            item.version === draft.currentVersion && 'kind' in item && item.kind === 'directory',
        )
      : undefined

  return (
    <Modal
      title={t(isNew ? 'resources.add' : 'resources.edit', {
        resource: t(libraryEntryLabels[kind]),
      })}
      subtitle={t('config.libraryHint')}
      onClose={close}
      busy={busy || importing}
    >
      <form onSubmit={submit} onChange={() => setDirty(true)}>
        <fieldset disabled={busy || importing}>
          <div className="modal-body">
            <TextField
              label={t('common.name')}
              value={draft.name}
              maxLength={80}
              onChange={(name) => setDraft({ ...draft, name })}
            />
            {'description' in draft && (
              <TextField
                label={t('common.description')}
                value={draft.description}
                rows={2}
                maxLength={500}
                onChange={(description) => setDraft({ ...draft, description })}
              />
            )}
            {'executable' in draft && (
              <>
                <SelectField
                  label={t('config.engineKind')}
                  value={draft.kind}
                  onChange={(kind) =>
                    changeInstallation(draft, { kind: kind as EngineInstallation['kind'] })
                  }
                >
                  {!initialEngineKinds.some((kind) => kind === draft.kind) && (
                    <option value={draft.kind}>{draft.kind}</option>
                  )}
                  <option value="opencode">OpenCode</option>
                  <option value="pi">Pi</option>
                  <option value="deepseek-harness">DeepSeek Harness</option>
                </SelectField>
                <TextField
                  label={t('config.executable')}
                  value={draft.executable}
                  onChange={(executable) => changeInstallation(draft, { executable })}
                />
                <ArgumentField
                  label={t('config.prefixArgs')}
                  value={draft.prefixArgs}
                  onChange={(prefixArgs) => changeInstallation(draft, { prefixArgs })}
                />
                <SelectField
                  label={t('config.platform')}
                  value={draft.platform}
                  onChange={(platform) =>
                    changeInstallation(draft, {
                      platform: platform as EngineInstallation['platform'],
                    })
                  }
                >
                  <option value="darwin">macOS</option>
                  <option value="win32">Windows</option>
                  <option value="linux">Linux</option>
                </SelectField>
                <p className="hint">
                  {draft.version ?? t('config.unprobed')} · {t('config.probeHint')}
                </p>
              </>
            )}
            {'protocol' in draft && (
              <>
                <SelectField
                  label={t('config.protocol')}
                  value={draft.protocol ?? ''}
                  onChange={(protocol) =>
                    setDraft({
                      ...draft,
                      protocol: protocol ? modelProtocolSchema.parse(protocol) : null,
                    })
                  }
                >
                  <option value="">{t('config.choose')}</option>
                  {modelProtocolSchema.options.map((protocol) => (
                    <option key={protocol} value={protocol}>
                      {protocol}
                    </option>
                  ))}
                </SelectField>
                <TextField
                  label="API Base URL"
                  value={draft.baseUrl}
                  placeholder="https://api.example.com/v1"
                  onChange={(baseUrl) => setDraft({ ...draft, baseUrl })}
                />
                <SelectField
                  label={t('config.auth')}
                  value={draft.auth.kind}
                  onChange={(kind) => {
                    const auth: ModelConnection['auth'] =
                      kind === 'api-key'
                        ? { kind, header: 'x-api-key', secret: null }
                        : kind === 'bearer'
                          ? { kind, secret: null }
                          : kind === 'cloud-identity'
                            ? { kind, provider: 'aws' }
                            : { kind: kind as 'none' | 'unconfigured' | 'engine-login' }
                    setDraft({ ...draft, auth })
                  }}
                >
                  {(
                    [
                      'unconfigured',
                      'none',
                      'api-key',
                      'bearer',
                      'engine-login',
                      'cloud-identity',
                    ] as const
                  ).map((kind) => (
                    <option key={kind} value={kind}>
                      {t(`config.auth.${kind}`)}
                    </option>
                  ))}
                </SelectField>
                {draft.auth.kind === 'api-key' && (
                  <TextField
                    label={t('config.header')}
                    value={draft.auth.header}
                    onChange={(header) => {
                      if (draft.auth.kind === 'api-key')
                        setDraft({ ...draft, auth: { ...draft.auth, header } })
                    }}
                  />
                )}
                {(draft.auth.kind === 'api-key' || draft.auth.kind === 'bearer') && (
                  <SecretField
                    value={draft.auth.secret}
                    credentials={credentials}
                    onChange={(secret) => {
                      if (draft.auth.kind === 'api-key' || draft.auth.kind === 'bearer')
                        setDraft({ ...draft, auth: { ...draft.auth, secret } })
                    }}
                  />
                )}
                {draft.auth.kind === 'cloud-identity' && (
                  <>
                    <SelectField
                      label={t('config.cloudProvider')}
                      value={draft.auth.provider}
                      onChange={(provider) => {
                        if (draft.auth.kind === 'cloud-identity')
                          setDraft({
                            ...draft,
                            auth: {
                              ...draft.auth,
                              provider: provider as 'aws' | 'google' | 'azure',
                            },
                          })
                      }}
                    >
                      {['aws', 'google', 'azure'].map((provider) => (
                        <option key={provider}>{provider}</option>
                      ))}
                    </SelectField>
                    <TextField
                      label={t('config.cloudProfile')}
                      value={draft.auth.profile ?? ''}
                      onChange={(profile) => {
                        if (draft.auth.kind === 'cloud-identity')
                          setDraft({
                            ...draft,
                            auth: { ...draft.auth, profile: profile || undefined },
                          })
                      }}
                    />
                  </>
                )}
                <details>
                  <summary>{t('config.advanced')}</summary>
                  <JsonField
                    label={t('config.headers')}
                    value={draft.headers}
                    onChange={(headers) => setDraft({ ...draft, headers })}
                  />
                  <JsonField
                    label={t('config.secretHeaders')}
                    value={draft.secretHeaders}
                    onChange={(secretHeaders) => setDraft({ ...draft, secretHeaders })}
                  />
                </details>
              </>
            )}
            {'modelId' in draft && (
              <>
                <SelectField
                  label={t('config.connection')}
                  value={draft.connectionId ?? ''}
                  onChange={(connectionId) =>
                    setDraft({ ...draft, connectionId: connectionId || null })
                  }
                >
                  <option value="">{t('config.choose')}</option>
                  {workspace.connections.map((connection) => (
                    <option key={connection.id} value={connection.id}>
                      {connection.name}
                    </option>
                  ))}
                </SelectField>
                <TextField
                  label={t('agentEditor.model')}
                  value={draft.modelId}
                  onChange={(modelId) => setDraft({ ...draft, modelId })}
                />
                <div className="field-grid">
                  <NumberField
                    label="Temperature"
                    value={draft.parameters.temperature}
                    min={0}
                    max={2}
                    onChange={(temperature) =>
                      setDraft({ ...draft, parameters: { ...draft.parameters, temperature } })
                    }
                  />
                  <NumberField
                    label="Top P"
                    value={draft.parameters.topP}
                    min={0}
                    max={1}
                    onChange={(topP) =>
                      setDraft({ ...draft, parameters: { ...draft.parameters, topP } })
                    }
                  />
                </div>
                <TextField
                  label={t('config.reasoning')}
                  value={draft.parameters.reasoning ?? ''}
                  onChange={(reasoning) =>
                    setDraft({
                      ...draft,
                      parameters: { ...draft.parameters, reasoning: reasoning || undefined },
                    })
                  }
                />
                <p className="hint">{t('config.optionalParameters')}</p>
              </>
            )}
            {'versions' in draft && (
              <>
                {'purpose' in draft && (
                  <SelectField
                    label={t('config.purpose')}
                    value={draft.purpose}
                    onChange={(purpose) =>
                      setDraft({ ...draft, purpose: purpose as PromptAsset['purpose'] })
                    }
                  >
                    {(
                      [
                        'unspecified',
                        'role',
                        'project-rule',
                        'system-template',
                        'compaction-template',
                      ] as const
                    ).map((purpose) => (
                      <option key={purpose} value={purpose}>
                        {t(`config.purpose.${purpose}`)}
                      </option>
                    ))}
                  </SelectField>
                )}
                {'sourcePath' in draft && (
                  <>
                    <TextField
                      label={t('resourceEditor.source')}
                      value={draft.sourcePath}
                      onChange={(sourcePath) => setDraft({ ...draft, sourcePath })}
                    />
                    <button
                      className="button secondary"
                      type="button"
                      onClick={() => void importDirectory()}
                    >
                      {t(importing ? 'config.importingSkill' : 'config.importSkill')}
                    </button>
                    <p className="hint">{t('config.importSkillHint')}</p>
                  </>
                )}
                <SelectField
                  label={t('resourceEditor.version')}
                  value={String(draft.currentVersion)}
                  onChange={(value) => {
                    const next = { ...draft, currentVersion: Number(value) }
                    setDraft(next)
                    setContent(contentOf(next))
                  }}
                >
                  {draft.versions.map((revision) => (
                    <option key={revision.version} value={revision.version}>
                      {t('config.revision', { version: revision.version })}
                    </option>
                  ))}
                </SelectField>
                {directoryRevision && 'files' in directoryRevision ? (
                  <>
                    <p className="hint">{t('config.directoryReadOnly')}</p>
                    <p className="hint">
                      {t('config.skillFiles', {
                        count: number(directoryRevision.files.length),
                        bytes: number(
                          directoryRevision.files.reduce((sum, file) => sum + file.bytes, 0),
                        ),
                      })}
                    </p>
                    <code className="asset-digest">SHA-256: {directoryRevision.digest}</code>
                    <details>
                      <summary>{t('config.skillFileList')}</summary>
                      <ul className="asset-file-list">
                        {directoryRevision.files.map((file) => (
                          <li key={file.path}>
                            <code>{file.path}</code> · {number(file.bytes)} B{' '}
                            {file.executable ? ` · ${t('config.executableFile')}` : ''}
                          </li>
                        ))}
                      </ul>
                    </details>
                  </>
                ) : (
                  <TextField
                    label={t(
                      'purpose' in draft ? 'config.instructions' : 'resourceEditor.instructions',
                    )}
                    value={content}
                    rows={12}
                    maxLength={100000}
                    onChange={setContent}
                  />
                )}
                <p className="hint">{t('config.historyHint')}</p>
              </>
            )}
            {'transport' in draft && (
              <>
                <SelectField
                  label={t('resourceEditor.transport')}
                  value={draft.transport}
                  onChange={(transport) => {
                    const base = {
                      id: draft.id,
                      name: draft.name,
                      description: draft.description,
                      enabled: draft.enabled,
                      timeoutMs: draft.timeoutMs,
                    }
                    setDraft(
                      transport === 'stdio'
                        ? {
                            ...base,
                            transport,
                            command: '',
                            args: [],
                            cwd: '',
                            environment: {},
                            envRefs: {},
                          }
                        : {
                            ...base,
                            transport: transport as 'streamable-http' | 'legacy-sse',
                            url: '',
                            headers: {},
                            secretHeaders: {},
                            auth: { kind: 'none' },
                          },
                    )
                  }}
                >
                  <option value="stdio">{t('resourceEditor.stdio')}</option>
                  <option value="streamable-http">{t('resourceEditor.http')}</option>
                  <option value="legacy-sse">{t('config.mcpSse')}</option>
                </SelectField>
                {draft.transport === 'stdio' ? (
                  <>
                    <TextField
                      label={t('resourceEditor.command')}
                      value={draft.command}
                      onChange={(command) => setDraft({ ...draft, command })}
                    />
                    <ArgumentField
                      label={t('resourceEditor.args')}
                      value={draft.args}
                      onChange={(args) => setDraft({ ...draft, args })}
                    />
                    <TextField
                      label={t('config.cwd')}
                      value={draft.cwd}
                      onChange={(cwd) => setDraft({ ...draft, cwd })}
                    />
                    <details>
                      <summary>{t('config.advanced')}</summary>
                      <JsonField
                        label={t('config.envValues')}
                        value={draft.environment}
                        onChange={(environment) => setDraft({ ...draft, environment })}
                      />
                      <JsonField
                        label={t('config.envRefs')}
                        value={draft.envRefs}
                        onChange={(envRefs) => setDraft({ ...draft, envRefs })}
                      />
                      <p className="hint">{t('config.secret.hint')}</p>
                    </details>
                  </>
                ) : (
                  <>
                    <TextField
                      label={t('resourceEditor.url')}
                      value={draft.url}
                      onChange={(url) => setDraft({ ...draft, url })}
                    />
                    <SelectField
                      label={t('config.auth')}
                      value={draft.auth.kind}
                      onChange={(kind) => {
                        const auth: Exclude<McpDefinition, { transport: 'stdio' }>['auth'] =
                          kind === 'bearer'
                            ? { kind, secret: null }
                            : kind === 'oauth'
                              ? { kind, owner: 'engine', scopes: [] }
                              : { kind: 'none' }
                        setDraft({ ...draft, auth })
                      }}
                    >
                      {(['none', 'bearer', 'oauth'] as const).map((kind) => (
                        <option key={kind} value={kind}>
                          {t(`config.auth.${kind}`)}
                        </option>
                      ))}
                    </SelectField>
                    {draft.auth.kind === 'bearer' && (
                      <SecretField
                        value={draft.auth.secret}
                        credentials={credentials}
                        onChange={(secret) =>
                          setDraft({ ...draft, auth: { kind: 'bearer', secret } })
                        }
                      />
                    )}
                    {draft.auth.kind === 'oauth' && (
                      <TextField
                        label={t('config.oauthScopes')}
                        rows={3}
                        value={draft.auth.scopes.join('\n')}
                        onChange={(text) =>
                          setDraft({
                            ...draft,
                            auth: {
                              kind: 'oauth',
                              owner: 'engine',
                              scopes: text.split('\n').filter(Boolean),
                            },
                          })
                        }
                      />
                    )}
                    <details>
                      <summary>{t('config.advanced')}</summary>
                      <JsonField
                        label={t('config.headers')}
                        value={draft.headers}
                        onChange={(headers) => setDraft({ ...draft, headers })}
                      />
                      <JsonField
                        label={t('config.secretHeaders')}
                        value={draft.secretHeaders}
                        onChange={(secretHeaders) => setDraft({ ...draft, secretHeaders })}
                      />
                    </details>
                  </>
                )}
                <NumberField
                  label={t('config.timeout')}
                  value={draft.timeoutMs}
                  min={1000}
                  max={300000}
                  step={1}
                  onChange={(timeoutMs) => setDraft({ ...draft, timeoutMs })}
                />
              </>
            )}
            {'promptBindings' in draft && (
              <>
                <TextField
                  label={t('resourceEditor.version')}
                  value={draft.version}
                  onChange={(version) => setDraft({ ...draft, version })}
                />
                <p className="hint">{t('config.bundleHint')}</p>
                <AssetBindings
                  title={t('config.prompts')}
                  assets={workspace.prompts}
                  bindings={draft.promptBindings}
                  onChange={(promptBindings) => setDraft({ ...draft, promptBindings })}
                  prompts
                />
                <ResourcePicker
                  title="MCP Servers"
                  items={workspace.mcpServers}
                  selected={draft.mcpServerIds}
                  onChange={(mcpServerIds) => setDraft({ ...draft, mcpServerIds })}
                />
                <AssetBindings
                  title="Skills"
                  assets={workspace.skills}
                  bindings={draft.skillBindings}
                  onChange={(skillBindings) => setDraft({ ...draft, skillBindings })}
                />
              </>
            )}
            {'nativeId' in draft && (
              <>
                <SelectField
                  label={t('config.engine')}
                  value={draft.engineInstallationId}
                  onChange={(engineInstallationId) => setDraft({ ...draft, engineInstallationId })}
                >
                  <option value="">{t('config.choose')}</option>
                  {workspace.installations.map((engine) => (
                    <option key={engine.id} value={engine.id}>
                      {engine.name}
                    </option>
                  ))}
                </SelectField>
                <TextField
                  label={t('config.nativeId')}
                  value={draft.nativeId}
                  onChange={(nativeId) => setDraft({ ...draft, nativeId })}
                />
                <TextField
                  label={t('resourceEditor.version')}
                  value={draft.version}
                  onChange={(version) => setDraft({ ...draft, version })}
                />
                <TextField
                  label={t('config.source')}
                  value={draft.source}
                  onChange={(source) => setDraft({ ...draft, source })}
                />
                <TextField
                  label={t('config.path')}
                  value={draft.path}
                  onChange={(path) => setDraft({ ...draft, path })}
                />
                <p className="hint">{t('config.nativeHint')}</p>
              </>
            )}
            {'enabled' in draft && (
              <label className="check-field">
                <input
                  type="checkbox"
                  checked={draft.enabled}
                  onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
                />
                {t('resourceEditor.enable')}
              </label>
            )}
            <LibraryImpactPreview candidate={candidate} kind={kind} revision={workspace.revision} />
          </div>
          {error != null && (
            <p className="form-error" role="alert">
              {formatError(error, locale)}
            </p>
          )}
          <div className="modal-footer">
            <button type="button" className="button secondary" onClick={close}>
              {t('common.cancel')}
            </button>
            <button className="button primary" type="submit">
              <Save size={16} />
              {t(busy ? 'common.saving' : 'common.saveConfig')}
            </button>
          </div>
        </fieldset>
      </form>
    </Modal>
  )
}
