import { useState, type FormEvent } from 'react'
import { Save } from 'lucide-react'
import {
  formatError,
  mcpServerSchema,
  pluginSchema,
  skillSchema,
  type Resource,
  type ResourceKind,
  type Workspace,
} from '../../../shared/workspace'
import { Modal } from './Modal'
import { ResourcePicker } from './ResourcePicker'

export const resourceLabels = { mcpServers: 'MCP Server', skills: 'Skill', plugins: '插件' }

export function ResourceEditor({
  resource,
  kind,
  workspace,
  busy,
  onSave,
  onClose,
}: {
  resource: Resource
  kind: ResourceKind
  workspace: Workspace
  busy: boolean
  onSave: (resource: Resource) => Promise<void>
  onClose: () => void
}) {
  const [draft, setDraft] = useState(resource)
  const initialArgs = 'args' in resource ? resource.args.join('\n') : ''
  const initialEnv = JSON.stringify('envRefs' in resource ? resource.envRefs : {}, null, 2)
  const [args, setArgs] = useState(initialArgs)
  const [env, setEnv] = useState(initialEnv)
  const [error, setError] = useState('')
  const close = () => {
    const dirty =
      JSON.stringify(draft) !== JSON.stringify(resource) ||
      args !== initialArgs ||
      env !== initialEnv
    if (!dirty || window.confirm('有未保存的修改，确定放弃吗？')) onClose()
  }
  async function submit(event: FormEvent) {
    event.preventDefault()
    setError('')
    try {
      let candidate = draft
      if ('transport' in draft && draft.transport === 'stdio') {
        candidate = {
          ...draft,
          args: args.split('\n').filter((arg) => arg.length > 0),
          envRefs: JSON.parse(env),
        }
      }
      const schema = { mcpServers: mcpServerSchema, skills: skillSchema, plugins: pluginSchema }[
        kind
      ]
      await onSave(schema.parse(candidate))
    } catch (failure) {
      setError(formatError(failure))
    }
  }

  return (
    <Modal
      title={`${resource.name ? '编辑' : '添加'} ${resourceLabels[kind]}`}
      subtitle="维护一次配置，供多个 Agent 复用。"
      onClose={close}
      busy={busy}
    >
      <form onSubmit={submit}>
        <fieldset disabled={busy}>
          <div className="modal-body">
            <label className="field">
              名称
              <input
                autoFocus
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                maxLength={80}
              />
            </label>
            <label className="field">
              描述
              <input
                value={draft.description}
                onChange={(event) => setDraft({ ...draft, description: event.target.value })}
                maxLength={500}
              />
            </label>
            {'transport' in draft && (
              <>
                <label className="field">
                  传输方式
                  <select
                    value={draft.transport}
                    onChange={(event) => {
                      const base = {
                        id: draft.id,
                        name: draft.name,
                        description: draft.description,
                        enabled: draft.enabled,
                      }
                      setDraft(
                        event.target.value === 'stdio'
                          ? { ...base, transport: 'stdio', command: '', args: [], envRefs: {} }
                          : { ...base, transport: 'streamable-http', url: '', bearerTokenEnv: '' },
                      )
                    }}
                  >
                    <option value="stdio">stdio · 本地进程</option>
                    <option value="streamable-http">Streamable HTTP · 远程服务</option>
                  </select>
                </label>
                {draft.transport === 'stdio' ? (
                  <>
                    <label className="field">
                      启动命令
                      <input
                        className="code-input"
                        value={draft.command}
                        placeholder="例如 npx、uvx 或可执行文件路径"
                        onChange={(event) => setDraft({ ...draft, command: event.target.value })}
                      />
                    </label>
                    <label className="field">
                      参数 <span className="optional">每行一个参数，无需 shell 引号</span>
                      <textarea
                        className="code-input"
                        rows={3}
                        value={args}
                        placeholder={'-y\npackage-name'}
                        onChange={(event) => setArgs(event.target.value)}
                      />
                    </label>
                    <label className="field">
                      环境变量引用 <span className="optional">JSON：子进程变量名 → 系统变量名</span>
                      <textarea
                        className="code-input"
                        rows={3}
                        value={env}
                        onChange={(event) => setEnv(event.target.value)}
                      />
                    </label>
                    <p className="hint">
                      例如 {`{"API_TOKEN": "MY_API_TOKEN"}`}，填写变量名，无需填写密钥。
                    </p>
                  </>
                ) : (
                  <>
                    <label className="field">
                      服务 URL
                      <input
                        value={draft.url}
                        placeholder="https://example.com/mcp"
                        onChange={(event) => setDraft({ ...draft, url: event.target.value })}
                      />
                    </label>
                    <label className="field">
                      Bearer Token 环境变量 <span className="optional">可选</span>
                      <input
                        value={draft.bearerTokenEnv}
                        placeholder="MY_MCP_TOKEN"
                        onChange={(event) =>
                          setDraft({ ...draft, bearerTokenEnv: event.target.value })
                        }
                      />
                    </label>
                  </>
                )}
                <p className="hint">保存服务配置；连接与工具调用将在运行时接入后提供。</p>
              </>
            )}
            {'instructions' in draft && (
              <>
                <label className="field">
                  来源路径 <span className="optional">可选 · 仅记录来源，不自动读取</span>
                  <input
                    value={draft.sourcePath}
                    placeholder="/path/to/SKILL.md"
                    onChange={(event) => setDraft({ ...draft, sourcePath: event.target.value })}
                  />
                </label>
                <div className="field">
                  <label htmlFor="skill-instructions">Skill 指令</label>
                  <textarea
                    id="skill-instructions"
                    className="code-input"
                    rows={10}
                    value={draft.instructions}
                    placeholder="粘贴或编写可复用的 Markdown 指令…"
                    onChange={(event) => setDraft({ ...draft, instructions: event.target.value })}
                  />
                </div>
              </>
            )}
            {'version' in draft && (
              <>
                <label className="field">
                  版本
                  <input
                    value={draft.version}
                    placeholder="1.0.0"
                    onChange={(event) => setDraft({ ...draft, version: event.target.value })}
                  />
                </label>
                <p className="hint">插件是可复用的能力集合，将 MCP 和 Skills 打包绑定给 Agent。</p>
                <ResourcePicker
                  title="MCP Servers"
                  items={workspace.mcpServers}
                  selected={draft.mcpServerIds}
                  onChange={(mcpServerIds) => setDraft({ ...draft, mcpServerIds })}
                />
                <ResourcePicker
                  title="Skills"
                  items={workspace.skills}
                  selected={draft.skillIds}
                  onChange={(skillIds) => setDraft({ ...draft, skillIds })}
                />
              </>
            )}
            <label className="check-field">
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
              />
              启用此配置
            </label>
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
            <button type="submit" className="button primary">
              <Save size={16} />
              {busy ? '保存中…' : '保存配置'}
            </button>
          </div>
        </fieldset>
      </form>
    </Modal>
  )
}
