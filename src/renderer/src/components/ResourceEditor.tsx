import { LibraryImpactPreview } from './LibraryImpactPreview'
import { NativePluginInspection } from './NativePluginInspection'
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
import type { SupportedEngine } from '../../../shared/engines/contracts'
import {
  defaultTargetEngine,
  enginesForProtocol,
  protocolRequirement,
} from '../../../shared/engines/model-requirements'
import { api } from '../lib/api'
import { useI18n } from '../i18n'
import { Modal } from './Modal'
import { ResourcePicker } from './ResourcePicker'
import { AssetBindings } from './AssetBindings'
import { EngineTargetSelect, ModelRequirements, engineNames } from './ModelRequirements'
import { buttonVariants } from './ui/button'
import { Checkbox } from './ui/checkbox'
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
  // Which CLI the model fields are described for. It guides the editor, it is not saved.
  const [targetEngine, setTargetEngine] = useState<SupportedEngine | null>(() =>
    defaultTargetEngine(workspace, {
      modelId: 'modelId' in resource ? resource.id : undefined,
      connectionId: 'protocol' in resource ? resource.id : undefined,
    }),
  )
  const [content, setContent] = useState(contentOf(resource))
  const [dirty, setDirty] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [credentials, setCredentials] = useState<CredentialMetadata[]>([])
  const [importing, setImporting] = useState(false)
  const isNew = !workspace[kind].some((item) => item.id === resource.id)
  const pluginEngine =
    'nativeId' in draft
      ? workspace.installations.find((item) => item.id === draft.engineInstallationId)?.kind
      : null
  // Retain the saved engine's options when switching installations; conversion must be explicit.
  const pluginOptionsKind =
    'nativeId' in draft
      ? (draft.options?.kind ??
        (pluginEngine === 'opencode' || pluginEngine === 'deepseek-harness' ? pluginEngine : null))
      : null
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
  // The route the target engine maps for the draft's protocol, for both editors below.
  const connectionRoute =
    targetEngine && 'protocol' in draft ? protocolRequirement(targetEngine, draft.protocol) : null
  const modelConnection =
    'modelId' in draft
      ? (workspace.connections.find((item) => item.id === draft.connectionId) ?? null)
      : null
  const modelRoute =
    targetEngine && modelConnection
      ? protocolRequirement(targetEngine, modelConnection.protocol)
      : null
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
      <form
        onSubmit={submit}
        onChange={() => setDirty(true)}
        className="flex min-h-0 flex-1 flex-col"
      >
        <fieldset disabled={busy || importing} className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5 [&>p]:-mt-3 [&>p]:mb-5">
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
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {draft.version ?? t('config.unprobed')} · {t('config.probeHint')}
                </p>
              </>
            )}
            {'protocol' in draft && (
              <>
                <EngineTargetSelect value={targetEngine} onChange={setTargetEngine} />
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {t('requirements.hint')}
                </p>
                <SelectField
                  label={t('config.protocol')}
                  value={draft.protocol ?? ''}
                  onChange={(value) => {
                    const protocol = value ? modelProtocolSchema.parse(value) : null
                    // The route decides the API-key header, so switching it rewrites the header.
                    const header =
                      targetEngine && protocol
                        ? protocolRequirement(targetEngine, protocol)?.apiKeyHeader
                        : null
                    setDraft({
                      ...draft,
                      protocol,
                      auth:
                        draft.auth.kind === 'api-key' && header
                          ? { ...draft.auth, header }
                          : draft.auth,
                    })
                  }}
                >
                  <option value="">{t('config.choose')}</option>
                  {modelProtocolSchema.options.map((protocol) => {
                    const engines = enginesForProtocol(protocol)
                    const unsupported = targetEngine
                      ? !protocolRequirement(targetEngine, protocol)
                      : engines.length === 0
                    return (
                      <option key={protocol} value={protocol}>
                        {unsupported
                          ? t('requirements.protocolUnsupported', { protocol })
                          : `${protocol} · ${
                              engines.length
                                ? t('requirements.engineSupport', {
                                    engines: engines.map((kind) => engineNames[kind]).join(', '),
                                  })
                                : t('requirements.noEngines')
                            }`}
                      </option>
                    )
                  })}
                </SelectField>
                <TextField
                  label="API Base URL"
                  value={draft.baseUrl}
                  placeholder="https://api.example.com/v1"
                  onChange={(baseUrl) => setDraft({ ...draft, baseUrl })}
                />
                {draft.protocol === 'anthropic-messages' && (
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    {t('config.anthropicEndpoint')}
                  </p>
                )}
                <SelectField
                  label={t('config.auth')}
                  value={draft.auth.kind}
                  onChange={(kind) => {
                    const header =
                      (targetEngine && draft.protocol
                        ? protocolRequirement(targetEngine, draft.protocol)?.apiKeyHeader
                        : null) ?? 'x-api-key'
                    const auth: ModelConnection['auth'] =
                      kind === 'api-key'
                        ? { kind, header, secret: null }
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
                    // Every strategy stays selectable: one connection can serve several engines.
                    <option key={kind} value={kind}>
                      {t(`config.auth.${kind}`)}
                      {connectionRoute &&
                      kind !== 'unconfigured' &&
                      !connectionRoute.auth.includes(kind)
                        ? ` · ${t('requirements.authUnsupported')}`
                        : ''}
                    </option>
                  ))}
                </SelectField>
                {draft.auth.kind === 'api-key' && connectionRoute?.apiKeyHeader && (
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    {t('requirements.headerFixed', { header: connectionRoute.apiKeyHeader })}
                  </p>
                )}
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
                  {connectionRoute?.headers === 'none' && (
                    <p className="text-xs leading-relaxed text-warning">
                      {t('requirements.headersNone')}
                    </p>
                  )}
                  {connectionRoute?.headers === 'reserved-user-agent' && (
                    <p className="text-xs leading-relaxed text-warning">
                      {t('requirements.headersReserved')}
                    </p>
                  )}
                </details>
                <ModelRequirements kind={targetEngine} connection={draft} />
              </>
            )}
            {'modelId' in draft && (
              <>
                <EngineTargetSelect value={targetEngine} onChange={setTargetEngine} />
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {t('requirements.hint')}
                </p>
                <SelectField
                  label={t('config.connection')}
                  value={draft.connectionId ?? ''}
                  onChange={(connectionId) =>
                    setDraft({ ...draft, connectionId: connectionId || null })
                  }
                >
                  <option value="">{t('config.choose')}</option>
                  {workspace.connections.map((connection) => (
                    // The option text stays the saved name; the route is described below.
                    <option key={connection.id} value={connection.id}>
                      {connection.name}
                    </option>
                  ))}
                </SelectField>
                {modelConnection?.protocol && (
                  <p
                    className={`text-xs leading-relaxed ${
                      targetEngine && !modelRoute ? 'text-warning' : 'text-muted-foreground'
                    }`}
                  >
                    {targetEngine && !modelRoute
                      ? t('requirements.protocolUnsupported', {
                          protocol: modelConnection.protocol,
                        })
                      : t('requirements.engineSupport', {
                          engines: enginesForProtocol(modelConnection.protocol)
                            .map((kind) => engineNames[kind])
                            .join(', '),
                        })}
                  </p>
                )}
                <TextField
                  label={t('agentEditor.model')}
                  value={draft.modelId}
                  placeholder={modelRoute?.modelIdExample ?? ''}
                  onChange={(modelId) => setDraft({ ...draft, modelId })}
                />
                {modelRoute && (
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    {t('requirements.modelIdHint', { example: modelRoute.modelIdExample })}
                  </p>
                )}
                <div className="grid gap-4 sm:grid-cols-2">
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
                {modelRoute && !modelRoute.sampling && (
                  <p className="text-xs leading-relaxed text-warning">
                    {t('requirements.samplingUnsupported')}
                  </p>
                )}
                {modelRoute?.reasoning ? (
                  <SelectField
                    label={t('config.reasoning')}
                    value={draft.parameters.reasoning ?? ''}
                    onChange={(reasoning) =>
                      setDraft({
                        ...draft,
                        parameters: { ...draft.parameters, reasoning: reasoning || undefined },
                      })
                    }
                  >
                    <option value="">{t('requirements.reasoningEmpty')}</option>
                    {draft.parameters.reasoning &&
                      !modelRoute.reasoning.includes(draft.parameters.reasoning) && (
                        <option value={draft.parameters.reasoning}>
                          {t('requirements.reasoningCustom', { value: draft.parameters.reasoning })}
                        </option>
                      )}
                    {modelRoute.reasoning.map((value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                  </SelectField>
                ) : (
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
                )}
                {modelRoute && modelRoute.reasoning === null && (
                  <p className="text-xs leading-relaxed text-warning">
                    {t('requirements.reasoningUnsupported')}
                  </p>
                )}
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {t('config.optionalParameters')}
                </p>
                <ModelRequirements kind={targetEngine} connection={modelConnection} model={draft} />
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
                      className={buttonVariants({ variant: 'outline', size: 'sm' })}
                      type="button"
                      onClick={() => void importDirectory()}
                    >
                      {t(importing ? 'config.importingSkill' : 'config.importSkill')}
                    </button>
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      {t('config.importSkillHint')}
                    </p>
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
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      {t('config.directoryReadOnly')}
                    </p>
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      {t('config.skillFiles', {
                        count: number(directoryRevision.files.length),
                        bytes: number(
                          directoryRevision.files.reduce((sum, file) => sum + file.bytes, 0),
                        ),
                      })}
                    </p>
                    <code className="font-mono text-[11px] break-all text-muted-foreground">
                      SHA-256: {directoryRevision.digest}
                    </code>
                    <details>
                      <summary>{t('config.skillFileList')}</summary>
                      <ul className="grid gap-1">
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
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {t('config.historyHint')}
                </p>
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
                      <p className="text-xs leading-relaxed text-muted-foreground">
                        {t('config.secret.hint')}
                      </p>
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
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {t('config.bundleHint')}
                </p>
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
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {t('plugin.idHint')}
                </p>
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
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {t('config.nativeHint')}
                </p>
                {pluginOptionsKind && (
                  <>
                    <JsonField
                      key={pluginOptionsKind}
                      label={t(
                        pluginOptionsKind === 'opencode'
                          ? 'plugin.opencodeOptions'
                          : 'plugin.dshOptions',
                      )}
                      value={draft.options?.config ?? {}}
                      onChange={(config) =>
                        setDraft({ ...draft, options: { kind: pluginOptionsKind, config } })
                      }
                    />
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      {t(
                        pluginOptionsKind === 'opencode'
                          ? 'plugin.opencodeOptionsHint'
                          : 'plugin.dshOptionsHint',
                      )}
                    </p>
                    {pluginEngine !== pluginOptionsKind && (
                      <p className="text-xs leading-relaxed text-muted-foreground">
                        {t('plugin.optionsEngineMismatch')}
                      </p>
                    )}
                    {draft.options && (
                      <button
                        type="button"
                        className={buttonVariants({ variant: 'outline', size: 'sm' })}
                        onClick={() => setDraft({ ...draft, options: undefined })}
                      >
                        {t('plugin.clearOptions')}
                      </button>
                    )}
                  </>
                )}
                <NativePluginInspection
                  key={JSON.stringify([
                    draft.engineInstallationId,
                    draft.path,
                    workspace.installations.find((item) => item.id === draft.engineInstallationId),
                  ])}
                  installation={workspace.installations.find(
                    (item) => item.id === draft.engineInstallationId,
                  )}
                  path={draft.path}
                  version={draft.version}
                  onUseVersion={(version) => setDraft({ ...draft, version })}
                />
              </>
            )}
            {'enabled' in draft && (
              <label className="mb-5 flex items-center gap-2 text-xs font-medium">
                <Checkbox
                  checked={draft.enabled}
                  onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
                />
                {t('resourceEditor.enable')}
              </label>
            )}
            <LibraryImpactPreview candidate={candidate} kind={kind} revision={workspace.revision} />
          </div>
          {error != null && (
            <p
              className="rounded-lg border border-destructive/35 bg-destructive/10 px-3 py-2 text-xs text-destructive"
              role="alert"
            >
              {formatError(error, locale)}
            </p>
          )}
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-border px-6 py-4">
            <button
              type="button"
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
              onClick={close}
            >
              {t('common.cancel')}
            </button>
            <button className={buttonVariants()} type="submit">
              <Save size={16} />
              {t(busy ? 'common.saving' : 'common.saveConfig')}
            </button>
          </div>
        </fieldset>
      </form>
    </Modal>
  )
}
