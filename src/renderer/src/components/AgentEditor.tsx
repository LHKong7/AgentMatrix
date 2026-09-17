import { useI18n } from '../i18n'
import { useState, type FormEvent } from 'react'
import { Save } from 'lucide-react'
import { agentSchema, formatError, type Agent, type Workspace } from '../../../shared/workspace'
import { Modal } from './Modal'
import { ResourcePicker } from './ResourcePicker'

export function AgentEditor({
  agent,
  workspace,
  isNew,
  busy,
  onSave,
  onClose,
}: {
  agent: Agent
  workspace: Workspace
  isNew: boolean
  busy: boolean
  onSave: (agent: Agent) => Promise<void>
  onClose: () => void
}) {
  const { t, locale, number } = useI18n()
  const [draft, setDraft] = useState(agent)
  const [tab, setTab] = useState<'general' | 'prompt' | 'resources'>('general')
  const [error, setError] = useState<unknown>(null)
  const patch = (changes: Partial<Agent>) => setDraft((current) => ({ ...current, ...changes }))
  const close = () => {
    if (JSON.stringify(draft) === JSON.stringify(agent) || window.confirm(t('common.unsaved')))
      onClose()
  }
  async function submit(event: FormEvent) {
    event.preventDefault()
    setError(null)
    try {
      await onSave(agentSchema.parse(draft))
    } catch (failure) {
      setError(failure)
    }
  }

  return (
    <Modal
      title={isNew ? t('agents.create') : t('agents.edit')}
      subtitle={t('agentEditor.subtitle')}
      onClose={close}
      busy={busy}
    >
      <form onSubmit={submit}>
        <fieldset disabled={busy}>
          <div className="tabs" role="tablist" aria-label={t('agentEditor.tabs')}>
            {(
              [
                ['general', t('agentEditor.general')],
                ['prompt', 'System Prompt'],
                ['resources', t('agentEditor.resources')],
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
                {label}
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
                <label className="field">
                  {t('common.name')}
                  <input
                    autoFocus
                    value={draft.name}
                    maxLength={80}
                    onChange={(event) => patch({ name: event.target.value })}
                  />
                </label>
                <div className="field">
                  <label htmlFor="agent-description">{t('common.description')}</label>
                  <textarea
                    id="agent-description"
                    rows={2}
                    value={draft.description}
                    maxLength={500}
                    placeholder={t('agentEditor.descriptionPlaceholder')}
                    onChange={(event) => patch({ description: event.target.value })}
                  />
                </div>
                <div className="field-grid">
                  <label className="field">
                    {t('agentEditor.provider')}
                    <select
                      value={draft.provider}
                      onChange={(event) =>
                        patch({ provider: event.target.value as Agent['provider'] })
                      }
                    >
                      <option value="openai-compatible">OpenAI Compatible</option>
                      <option value="anthropic">Anthropic</option>
                      <option value="ollama">{t('agentEditor.localModel')}</option>
                    </select>
                  </label>
                  <label className="field">
                    {t('agentEditor.model')}
                    <input
                      value={draft.model}
                      placeholder={t('agentEditor.modelPlaceholder')}
                      onChange={(event) => patch({ model: event.target.value })}
                    />
                  </label>
                </div>
                <label className="field">
                  API Base URL <span className="optional">{t('common.optional')}</span>
                  <input
                    value={draft.baseUrl}
                    placeholder="https://api.example.com/v1"
                    onChange={(event) => patch({ baseUrl: event.target.value })}
                  />
                </label>
                <label className="field">
                  Temperature <span className="optional">{t('agentEditor.temperatureHint')}</span>
                  <input
                    type="number"
                    min="0"
                    max="2"
                    step="0.1"
                    value={draft.temperature}
                    onChange={(event) => patch({ temperature: event.target.valueAsNumber })}
                  />
                </label>
                <label className="check-field">
                  <input
                    type="checkbox"
                    checked={draft.enabled}
                    onChange={(event) => patch({ enabled: event.target.checked })}
                  />
                  {t('agentEditor.enable')}
                </label>
                <p className="hint">{t('agentEditor.runtimeHint')}</p>
              </>
            )}
            {tab === 'prompt' && (
              <>
                <div className="field">
                  <label htmlFor="agent-system-prompt">{t('agentEditor.instructions')}</label>
                  <textarea
                    id="agent-system-prompt"
                    className="code-input prompt-input"
                    rows={15}
                    value={draft.systemPrompt}
                    placeholder={t('agentEditor.promptPlaceholder')}
                    onChange={(event) => patch({ systemPrompt: event.target.value })}
                  />
                </div>
                <div className="field-footer">
                  <span>{t('agentEditor.promptHint')}</span>
                  <span>
                    {t('agentEditor.characters', { count: number(draft.systemPrompt.length) })}
                  </span>
                </div>
              </>
            )}
            {tab === 'resources' && (
              <>
                <p className="hint">{t('agentEditor.resourcesHint')}</p>
                <ResourcePicker
                  title="MCP Servers"
                  items={workspace.mcpServers}
                  selected={draft.mcpServerIds}
                  onChange={(mcpServerIds) => patch({ mcpServerIds })}
                />
                <ResourcePicker
                  title="Skills"
                  items={workspace.skills}
                  selected={draft.skillIds}
                  onChange={(skillIds) => patch({ skillIds })}
                />
                <ResourcePicker
                  title={t('nav.plugins')}
                  items={workspace.plugins}
                  selected={draft.pluginIds}
                  onChange={(pluginIds) => patch({ pluginIds })}
                />
              </>
            )}
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
              {busy ? t('common.saving') : t('agentEditor.save')}
            </button>
          </div>
        </fieldset>
      </form>
    </Modal>
  )
}
