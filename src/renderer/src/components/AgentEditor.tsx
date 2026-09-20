import { EngineSupport } from './EngineSupport'
import { useRef, useState, type FormEvent } from 'react'
import { Save } from 'lucide-react'
import { formatError } from '../../../shared/errors'
import {
  agentProfileSchema,
  type AgentProfile,
  type EngineKind,
} from '../../../shared/engines/schema'
import { upsertConfiguration } from '../../../shared/engines/editing'
import { resolveAgentProfile } from '../../../shared/engines/resolution'
import type { EngineWorkspace } from '../../../shared/engines/workspace'
import { useI18n } from '../i18n'
import { Modal } from './Modal'
import { ModelRequirements } from './ModelRequirements'
import { TabList, TabTrigger } from './ui/tabs'
import { isSupportedEngine } from '../../../shared/engines/contracts'
import { protocolRequirement } from '../../../shared/engines/model-requirements'
import { sharedSetupFor } from '../../../shared/engines/resolution'
import { Badge } from './ui/badge'
import { AssetBindings } from './AssetBindings'
import { ResourcePicker } from './ResourcePicker'
import { NumberField, SelectField, TextField } from './ConfigurationFields'
import { buttonVariants } from './ui/button'
import { Checkbox } from './ui/checkbox'

function defaultOptions(kind: EngineKind | undefined): AgentProfile['engineOptions'] {
  if (kind === 'opencode') return { kind, agent: 'build' }
  if (kind === 'pi') return { kind }
  if (kind === 'deepseek-harness') return { kind, profileTemplate: 'acp', patchReload: 'startup' }
  return null
}

export function AgentEditor({
  agent,
  workspace,
  platform,
  isNew,
  busy,
  onSave,
  onClose,
}: {
  agent: AgentProfile
  workspace: EngineWorkspace
  platform?: string
  isNew: boolean
  busy: boolean
  onSave: (agent: AgentProfile) => Promise<void>
  onClose: () => void
}) {
  const { t, locale } = useI18n()
  const [draft, setDraft] = useState(agent)
  const [tab, setTab] = useState<'general' | 'bindings' | 'engine' | 'preview'>('general')
  const [error, setError] = useState<unknown>(null)
  const options = useRef<Partial<Record<EngineKind, AgentProfile['engineOptions']>>>({})
  const patch = (changes: Partial<AgentProfile>) =>
    setDraft((current) => ({ ...current, ...changes }))
  // The selected CLI decides which model values can be filled in at all.
  const engineKind = (() => {
    const kind = workspace.installations.find(
      (item) => item.id === draft.engineInstallationId,
    )?.kind
    return kind && isSupportedEngine(kind) ? kind : null
  })()
  const selectedModel = workspace.models.find((item) => item.id === draft.modelProfileId) ?? null
  const selectedConnection =
    workspace.connections.find((item) => item.id === selectedModel?.connectionId) ?? null
  const close = () => {
    if (JSON.stringify(draft) === JSON.stringify(agent) || window.confirm(t('common.unsaved')))
      onClose()
  }
  async function submit(event: FormEvent) {
    event.preventDefault()
    setError(null)
    try {
      await onSave(agentProfileSchema.parse(draft))
    } catch (failure) {
      setError(failure)
    }
  }

  return (
    <Modal
      title={t(isNew ? 'agents.create' : 'agents.edit')}
      subtitle={t('agentEditor.subtitle')}
      onClose={close}
      busy={busy}
    >
      <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
        <fieldset disabled={busy} className="flex min-h-0 flex-1 flex-col">
          <div className="border-b border-border px-7 py-3">
            <TabList aria-label={t('agentEditor.tabs')}>
              {(
                [
                  ['general', 'agentEditor.general'],
                  ['bindings', 'config.bindings'],
                  ['engine', 'config.engineSettings'],
                  ['preview', 'config.preview'],
                ] as const
              ).map(([key, label]) => (
                <TabTrigger
                  key={key}
                  active={tab === key}
                  aria-controls={`panel-${key}`}
                  id={`tab-${key}`}
                  onClick={() => setTab(key)}
                >
                  {t(label)}
                </TabTrigger>
              ))}
            </TabList>
          </div>
          <div
            className="min-h-0 flex-1 overflow-y-auto px-6 py-5 [&>p]:-mt-3 [&>p]:mb-5"
            role="tabpanel"
            id={`panel-${tab}`}
            aria-labelledby={`tab-${tab}`}
          >
            {tab === 'general' && (
              <>
                <TextField
                  label={t('common.name')}
                  value={draft.name}
                  maxLength={80}
                  onChange={(name) => patch({ name })}
                />
                <TextField
                  label={t('common.description')}
                  value={draft.description}
                  rows={2}
                  maxLength={500}
                  onChange={(description) => patch({ description })}
                />
                <SelectField
                  label={t('config.engine')}
                  value={draft.engineInstallationId ?? ''}
                  onChange={(id) => {
                    if (draft.engineOptions)
                      options.current[draft.engineOptions.kind] = draft.engineOptions
                    const kind = workspace.installations.find(
                      (installation) => installation.id === id,
                    )?.kind
                    patch({
                      engineInstallationId: id || null,
                      engineOptions: kind ? (options.current[kind] ?? defaultOptions(kind)) : null,
                    })
                  }}
                >
                  <option value="">{t('config.choose')}</option>
                  {workspace.installations.map((installation) => (
                    <option key={installation.id} value={installation.id}>
                      {installation.name} · {installation.kind}
                    </option>
                  ))}
                </SelectField>
                <SelectField
                  label={t('config.model')}
                  value={draft.modelProfileId ?? ''}
                  onChange={(modelProfileId) => patch({ modelProfileId: modelProfileId || null })}
                >
                  <option value="">{t('config.choose')}</option>
                  {workspace.models.map((model) => {
                    const protocol =
                      workspace.connections.find((item) => item.id === model.connectionId)
                        ?.protocol ?? null
                    const usable =
                      !engineKind || !protocol || Boolean(protocolRequirement(engineKind, protocol))
                    return (
                      <option key={model.id} value={model.id}>
                        {model.name} · {model.modelId || t('agents.modelEmpty')}
                        {usable ? '' : ` · ${t('requirements.protocolUnsupported', { protocol })}`}
                      </option>
                    )
                  })}
                </SelectField>
                <ModelRequirements
                  kind={engineKind}
                  connection={selectedConnection}
                  model={selectedModel}
                />
                <TextField
                  label={t('config.cwd')}
                  value={draft.execution.cwd}
                  onChange={(cwd) => patch({ execution: { ...draft.execution, cwd } })}
                />
                <SelectField
                  label={t('config.approval')}
                  value={draft.execution.approval}
                  onChange={(approval) =>
                    patch({
                      execution: {
                        ...draft.execution,
                        approval: approval as AgentProfile['execution']['approval'],
                      },
                    })
                  }
                >
                  {(['ask', 'deny', 'unrestricted'] as const).map((policy) => (
                    <option key={policy} value={policy}>
                      {t(`config.approval.${policy}`)}
                    </option>
                  ))}
                </SelectField>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {t('config.policyHint')}
                </p>
                <NumberField
                  label={t('config.timeout')}
                  value={draft.execution.timeoutMs}
                  min={1000}
                  max={86400000}
                  step={1}
                  onChange={(timeoutMs) => patch({ execution: { ...draft.execution, timeoutMs } })}
                />
                <label className="mb-5 flex items-center gap-2 text-xs font-medium">
                  <Checkbox
                    checked={draft.enabled}
                    onChange={(event) => patch({ enabled: event.target.checked })}
                  />
                  {t('agentEditor.enable')}
                </label>
              </>
            )}
            {tab === 'bindings' && (
              <>
                <InheritedSetup workspace={workspace} agentId={draft.id} />
                <h3 className="mb-3">{t('sharedSetup.own')}</h3>
                <AssetBindings
                  title={t('config.prompts')}
                  assets={workspace.prompts}
                  bindings={draft.promptBindings}
                  prompts
                  onChange={(promptBindings) => patch({ promptBindings })}
                />
                <ResourcePicker
                  title="MCP Servers"
                  items={workspace.mcpServers}
                  selected={draft.mcpServerIds}
                  onChange={(mcpServerIds) => patch({ mcpServerIds })}
                />
                <AssetBindings
                  title="Skills"
                  assets={workspace.skills}
                  bindings={draft.skillBindings}
                  onChange={(skillBindings) => patch({ skillBindings })}
                />
                <ResourcePicker
                  title={t('config.bundles')}
                  items={workspace.bundles}
                  selected={draft.bundleIds}
                  onChange={(bundleIds) => patch({ bundleIds })}
                />
                <ResourcePicker
                  title={t('config.nativePlugins')}
                  items={workspace.nativePlugins.map((plugin) => ({
                    ...plugin,
                    enabled: true,
                    description: `${plugin.nativeId} · ${workspace.installations.find((installation) => installation.id === plugin.engineInstallationId)?.name ?? ''}`,
                  }))}
                  selected={draft.nativePluginIds}
                  onChange={(nativePluginIds) => patch({ nativePluginIds })}
                />
              </>
            )}
            {tab === 'engine' && (
              <>
                {!draft.engineOptions && (
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    {t('resolution.engine-required')}
                  </p>
                )}
                {draft.engineOptions?.kind === 'opencode' && (
                  <TextField
                    label={t('config.opencodeAgent')}
                    value={draft.engineOptions.agent}
                    onChange={(name) => patch({ engineOptions: { kind: 'opencode', agent: name } })}
                  />
                )}
                {draft.engineOptions?.kind === 'pi' && (
                  <>
                    <TextField
                      label={t('config.thinking')}
                      value={draft.engineOptions.thinkingLevel ?? ''}
                      onChange={(thinkingLevel) =>
                        patch({
                          engineOptions: {
                            ...draft.engineOptions,
                            kind: 'pi',
                            thinkingLevel: thinkingLevel || undefined,
                          },
                        })
                      }
                    />
                    <SelectField
                      label={t('config.piTrust')}
                      value={draft.engineOptions.projectTrust ?? 'deny'}
                      onChange={(value) =>
                        patch({
                          engineOptions: {
                            ...draft.engineOptions,
                            kind: 'pi',
                            projectTrust: value as 'deny' | 'trust-once',
                          },
                        })
                      }
                    >
                      <option value="deny">{t('config.piTrust.deny')}</option>
                      <option value="trust-once">{t('config.piTrust.trust-once')}</option>
                    </SelectField>
                    <SelectField
                      label={t('config.piContext')}
                      value={draft.engineOptions.contextFiles ?? 'inherit'}
                      onChange={(value) =>
                        patch({
                          engineOptions: {
                            ...draft.engineOptions,
                            kind: 'pi',
                            contextFiles: value as 'inherit' | 'ignore',
                          },
                        })
                      }
                    >
                      <option value="inherit">{t('config.piContext.inherit')}</option>
                      <option value="ignore">{t('config.piContext.ignore')}</option>
                    </SelectField>
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      {t('config.piTrustHint')}
                    </p>
                  </>
                )}
                {draft.engineOptions?.kind === 'deepseek-harness' && (
                  <>
                    <SelectField
                      label={t('config.dshProfile')}
                      value={draft.engineOptions.profileTemplate}
                      onChange={(profileTemplate) =>
                        patch({
                          engineOptions: {
                            kind: 'deepseek-harness',
                            patchReload: 'startup',
                            ...(draft.engineOptions?.kind === 'deepseek-harness'
                              ? { appendPosition: draft.engineOptions.appendPosition }
                              : {}),
                            profileTemplate: profileTemplate as 'acp' | 'sdk' | 'sdk-minimal',
                          },
                        })
                      }
                    >
                      <option value="acp">ACP</option>
                      <option value="sdk">SDK</option>
                      <option value="sdk-minimal">SDK minimal</option>
                    </SelectField>
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      {t('config.dshHint')}
                    </p>
                    <SelectField
                      label={t('config.dshAppendPosition')}
                      value={draft.engineOptions.appendPosition ?? 'suffix'}
                      onChange={(appendPosition) => {
                        if (draft.engineOptions?.kind === 'deepseek-harness')
                          patch({
                            engineOptions: {
                              ...draft.engineOptions,
                              appendPosition: appendPosition as 'prefix' | 'suffix',
                            },
                          })
                      }}
                    >
                      <option value="suffix">{t('config.dshAppendSuffix')}</option>
                      <option value="prefix">{t('config.dshAppendPrefix')}</option>
                    </SelectField>
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      {t('config.dshAppendHint')}
                    </p>
                  </>
                )}
              </>
            )}
            {tab === 'preview' && (
              <ProfilePreview workspace={workspace} profile={draft} platform={platform} />
            )}
            <p className="text-xs leading-relaxed text-muted-foreground">
              {t('config.savedForNewSessions')}
            </p>
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
              {t(busy ? 'common.saving' : 'agentEditor.save')}
            </button>
          </div>
        </fieldset>
      </form>
    </Modal>
  )
}

function ProfilePreview({
  workspace,
  profile,
  platform,
}: {
  workspace: EngineWorkspace
  profile: AgentProfile
  platform?: string
}) {
  const { t, locale } = useI18n()
  try {
    const result = resolveAgentProfile(
      upsertConfiguration(workspace, 'agents', profile),
      profile.id,
    )
    return (
      <div className="grid gap-3">
        <p className="text-xs leading-relaxed text-muted-foreground">
          {t('config.notRuntimeVerified')}
        </p>
        {result.status === 'invalid' ? (
          <ul className="grid gap-1 text-xs text-warning">
            {result.issues.map((issue, index) => (
              <li key={`${issue.code}:${index}`}>
                <strong>{t(`resolution.${issue.code}`)}</strong>
                <code>{issue.path}</code>
              </li>
            ))}
          </ul>
        ) : (
          <>
            <EngineSupport configuration={result.configuration} platform={platform} />
            <h3>{t('config.resolved')}</h3>
            <dl>
              <dt>{t('config.engine')}</dt>
              <dd>
                {result.configuration.installation.name} ·{' '}
                {result.configuration.installation.version}
              </dd>
              <dt>{t('config.model')}</dt>
              <dd>{result.configuration.model.modelId}</dd>
              <dt>{t('config.protocol')}</dt>
              <dd>{result.configuration.connection.protocol}</dd>
              <dt>API Base URL</dt>
              <dd>{result.configuration.connection.baseUrl}</dd>
            </dl>
            {result.configuration.prompts.map((prompt) => (
              <details key={prompt.assetId}>
                <summary>
                  {workspace.prompts.find((asset) => asset.id === prompt.assetId)?.name} ·{' '}
                  {t('config.revision', { version: prompt.version })} ·{' '}
                  {t(`config.mode.${prompt.mode}`)}
                </summary>
                <pre>{prompt.content}</pre>
                <code>{prompt.source}</code>
              </details>
            ))}
            <ul>
              {result.configuration.skills.map((skill) => (
                <li key={skill.assetId}>
                  {skill.name} · {t('config.revision', { version: skill.revision.version })}
                </li>
              ))}
              {result.configuration.mcpServers.map((server) => (
                <li key={server.id}>
                  {server.name} · {server.transport}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    )
  } catch (error) {
    return (
      <p
        role="alert"
        className="rounded-lg border border-destructive/35 bg-destructive/10 px-3 py-2 text-xs text-destructive"
      >
        {formatError(error, locale)}
      </p>
    )
  }
}

/** What this agent already receives from the workspace-wide setup, before its own bindings. */
function InheritedSetup({ workspace, agentId }: { workspace: EngineWorkspace; agentId: string }) {
  const { t, number } = useI18n()
  const setup = sharedSetupFor(workspace, agentId)
  const named = (ids: string[], items: { id: string; name: string }[]) =>
    ids.map((id) => items.find((item) => item.id === id)?.name).filter(Boolean) as string[]
  if (!setup)
    return (
      <p className="mb-5 rounded-lg border border-border px-3 py-2 text-xs text-muted-foreground">
        {t('sharedSetup.excluded')}
      </p>
    )
  const entries = [
    ...named(
      setup.promptBindings.map((binding) => binding.assetId),
      workspace.prompts,
    ),
    ...named(
      setup.skillBindings.map((binding) => binding.assetId),
      workspace.skills,
    ),
    ...named(setup.mcpServerIds, workspace.mcpServers),
    ...named(setup.bundleIds, workspace.bundles),
  ]
  return (
    <section
      className="mb-5 grid gap-2 rounded-lg border border-border p-3"
      data-testid="inherited-setup"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3>{t('sharedSetup.inherited')}</h3>
        <Badge variant="muted">
          {t('sharedSetup.count', {
            prompts: number(setup.promptBindings.length),
            skills: number(setup.skillBindings.length),
            tools: number(setup.mcpServerIds.length),
            bundles: number(setup.bundleIds.length),
          })}
        </Badge>
      </div>
      {entries.length ? (
        <div className="flex flex-wrap gap-1.5">
          {entries.map((name) => (
            <Badge key={name} variant="outline">
              {name}
            </Badge>
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">{t('sharedSetup.inheritedEmpty')}</p>
      )}
      <p className="text-xs leading-relaxed text-muted-foreground">
        {t('sharedSetup.inheritedHint')}
      </p>
    </section>
  )
}
