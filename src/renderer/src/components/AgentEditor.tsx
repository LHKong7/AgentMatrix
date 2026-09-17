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
  const [draft, setDraft] = useState(agent)
  const [tab, setTab] = useState<'general' | 'prompt' | 'resources'>('general')
  const [error, setError] = useState('')
  const patch = (changes: Partial<Agent>) => setDraft((current) => ({ ...current, ...changes }))
  const close = () => {
    if (
      JSON.stringify(draft) === JSON.stringify(agent) ||
      window.confirm('有未保存的修改，确定放弃吗？')
    )
      onClose()
  }
  async function submit(event: FormEvent) {
    event.preventDefault()
    setError('')
    try {
      await onSave(agentSchema.parse(draft))
    } catch (failure) {
      setError(formatError(failure))
    }
  }

  return (
    <Modal
      title={isNew ? '创建 Agent' : '编辑 Agent'}
      subtitle="为你的 Agent 定义角色、模型和能力。"
      onClose={close}
      busy={busy}
    >
      <form onSubmit={submit}>
        <fieldset disabled={busy}>
          <div className="tabs" role="tablist" aria-label="Agent 配置">
            {(
              [
                ['general', '基本配置'],
                ['prompt', 'System Prompt'],
                ['resources', '能力与插件'],
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
                  名称
                  <input
                    autoFocus
                    value={draft.name}
                    maxLength={80}
                    onChange={(event) => patch({ name: event.target.value })}
                  />
                </label>
                <div className="field">
                  <label htmlFor="agent-description">描述</label>
                  <textarea
                    id="agent-description"
                    rows={2}
                    value={draft.description}
                    maxLength={500}
                    placeholder="这个 Agent 擅长什么？"
                    onChange={(event) => patch({ description: event.target.value })}
                  />
                </div>
                <div className="field-grid">
                  <label className="field">
                    模型提供方
                    <select
                      value={draft.provider}
                      onChange={(event) =>
                        patch({ provider: event.target.value as Agent['provider'] })
                      }
                    >
                      <option value="openai-compatible">OpenAI Compatible</option>
                      <option value="anthropic">Anthropic</option>
                      <option value="ollama">Ollama / 本地模型</option>
                    </select>
                  </label>
                  <label className="field">
                    模型 ID
                    <input
                      value={draft.model}
                      placeholder="填写模型标识"
                      onChange={(event) => patch({ model: event.target.value })}
                    />
                  </label>
                </div>
                <label className="field">
                  API Base URL <span className="optional">可选</span>
                  <input
                    value={draft.baseUrl}
                    placeholder="https://api.example.com/v1"
                    onChange={(event) => patch({ baseUrl: event.target.value })}
                  />
                </label>
                <label className="field">
                  Temperature <span className="optional">0–2 · 运行时需遵循所选模型范围</span>
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
                  启用此 Agent 配置
                </label>
                <p className="hint">当前版本用于配置管理，模型调用将在后续接入。</p>
              </>
            )}
            {tab === 'prompt' && (
              <>
                <div className="field">
                  <label htmlFor="agent-system-prompt">系统指令</label>
                  <textarea
                    id="agent-system-prompt"
                    className="code-input prompt-input"
                    rows={15}
                    value={draft.systemPrompt}
                    placeholder="描述 Agent 的角色、行为准则和输出要求…"
                    onChange={(event) => patch({ systemPrompt: event.target.value })}
                  />
                </div>
                <div className="field-footer">
                  <span>定义角色与边界，让每次协作保持一致。</span>
                  <span>{draft.systemPrompt.length.toLocaleString()} 字符</span>
                </div>
              </>
            )}
            {tab === 'resources' && (
              <>
                <p className="hint">组合所需能力。插件内的资源会合并去重，已停用的资源不会生效。</p>
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
                  title="插件"
                  items={workspace.plugins}
                  selected={draft.pluginIds}
                  onChange={(pluginIds) => patch({ pluginIds })}
                />
              </>
            )}
          </div>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <div className="modal-footer">
            <button type="button" className="button secondary" onClick={close}>
              取消
            </button>
            <button className="button primary" type="submit">
              <Save size={16} />
              {busy ? '保存中…' : '保存 Agent'}
            </button>
          </div>
        </fieldset>
      </form>
    </Modal>
  )
}
