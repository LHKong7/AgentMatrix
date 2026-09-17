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
import { AssetBindings } from './AssetBindings'
import { ResourcePicker } from './ResourcePicker'
import { NumberField, SelectField, TextField } from './ConfigurationFields'

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
      <form onSubmit={submit}>
        <fieldset disabled={busy}>
          <div className="tabs" role="tablist" aria-label={t('agentEditor.tabs')}>
            {(
              [
                ['general', 'agentEditor.general'],
                ['bindings', 'config.bindings'],
                ['engine', 'config.engineSettings'],
                ['preview', 'config.preview'],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={tab === key}
                aria-controls={`panel-${key}`}
                id={`tab-${key}`}
                className={tab === key ? 'active' : ''}
                onClick={() => setTab(key)}
              >
                {t(label)}
              </button>
            ))}
          </div>
          <div
            className="modal-body"
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
                  {workspace.models.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.name} · {model.modelId || t('agents.modelEmpty')}
                    </option>
                  ))}
                </SelectField>
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
                <p className="hint">{t('config.policyHint')}</p>
                <NumberField
                  label={t('config.timeout')}
                  value={draft.execution.timeoutMs}
                  min={1000}
                  max={86400000}
                  step={1}
                  onChange={(timeoutMs) => patch({ execution: { ...draft.execution, timeoutMs } })}
                />
                <label className="check-field">
                  <input
                    type="checkbox"
                    checked={draft.enabled}
                    onChange={(event) => patch({ enabled: event.target.checked })}
                  />
                  {t('agentEditor.enable')}
                </label>
              </>
            )}
            {tab === 'bindings' && (
              <>
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
                {!draft.engineOptions && <p className="hint">{t('resolution.engine-required')}</p>}
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
                    <p className="hint">{t('config.piTrustHint')}</p>
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
                    <p className="hint">{t('config.dshHint')}</p>
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
                    <p className="hint">{t('config.dshAppendHint')}</p>
                  </>
                )}
              </>
            )}
            {tab === 'preview' && (
              <ProfilePreview workspace={workspace} profile={draft} platform={platform} />
            )}
            <p className="hint">{t('config.savedForNewSessions')}</p>
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
      <div className="configuration-preview">
        <p className="hint">{t('config.notRuntimeVerified')}</p>
        {result.status === 'invalid' ? (
          <ul className="diagnostic-list">
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
      <p role="alert" className="form-error">
        {formatError(error, locale)}
      </p>
    )
  }
}
