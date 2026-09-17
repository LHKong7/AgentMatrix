import { useI18n } from '../i18n'
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

export const resourceLabels = {
  mcpServers: 'resources.mcpServers',
  skills: 'resources.skills',
  plugins: 'resources.plugins',
} as const

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
  const { t, locale } = useI18n()
  const [draft, setDraft] = useState(resource)
  const initialArgs = 'args' in resource ? resource.args.join('\n') : ''
  const initialEnv = JSON.stringify('envRefs' in resource ? resource.envRefs : {}, null, 2)
  const [args, setArgs] = useState(initialArgs)
  const [env, setEnv] = useState(initialEnv)
  const [error, setError] = useState<unknown>(null)
  const close = () => {
    const dirty =
      JSON.stringify(draft) !== JSON.stringify(resource) ||
      args !== initialArgs ||
      env !== initialEnv
    if (!dirty || window.confirm(t('common.unsaved'))) onClose()
  }
  async function submit(event: FormEvent) {
    event.preventDefault()
    setError(null)
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
      setError(failure)
    }
  }

  return (
    <Modal
      title={t(resource.name ? 'resources.edit' : 'resources.add', {
        resource: t(resourceLabels[kind]),
      })}
      subtitle={t('resourceEditor.subtitle')}
      onClose={close}
      busy={busy}
    >
      <form onSubmit={submit}>
        <fieldset disabled={busy}>
          <div className="modal-body">
            <label className="field">
              {t('common.name')}
              <input
                autoFocus
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                maxLength={80}
              />
            </label>
            <label className="field">
              {t('common.description')}
              <input
                value={draft.description}
                onChange={(event) => setDraft({ ...draft, description: event.target.value })}
                maxLength={500}
              />
            </label>
            {'transport' in draft && (
              <>
                <label className="field">
                  {t('resourceEditor.transport')}
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
                    <option value="stdio">{t('resourceEditor.stdio')}</option>
                    <option value="streamable-http">{t('resourceEditor.http')}</option>
                  </select>
                </label>
                {draft.transport === 'stdio' ? (
                  <>
                    <label className="field">
                      {t('resourceEditor.command')}
                      <input
                        className="code-input"
                        value={draft.command}
                        placeholder={t('resourceEditor.commandPlaceholder')}
                        onChange={(event) => setDraft({ ...draft, command: event.target.value })}
                      />
                    </label>
                    <label className="field">
                      {t('resourceEditor.args')}{' '}
                      <span className="optional">{t('resourceEditor.argsHint')}</span>
                      <textarea
                        className="code-input"
                        rows={3}
                        value={args}
                        placeholder={'-y\npackage-name'}
                        onChange={(event) => setArgs(event.target.value)}
                      />
                    </label>
                    <label className="field">
                      {t('resourceEditor.env')}{' '}
                      <span className="optional">{t('resourceEditor.envHint')}</span>
                      <textarea
                        className="code-input"
                        rows={3}
                        value={env}
                        onChange={(event) => setEnv(event.target.value)}
                      />
                    </label>
                    <p className="hint">
                      {t('resourceEditor.envExample', { example: '{"API_TOKEN": "MY_API_TOKEN"}' })}
                    </p>
                  </>
                ) : (
                  <>
                    <label className="field">
                      {t('resourceEditor.url')}
                      <input
                        value={draft.url}
                        placeholder="https://example.com/mcp"
                        onChange={(event) => setDraft({ ...draft, url: event.target.value })}
                      />
                    </label>
                    <label className="field">
                      {t('resourceEditor.token')}{' '}
                      <span className="optional">{t('common.optional')}</span>
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
                <p className="hint">{t('resourceEditor.runtimeHint')}</p>
              </>
            )}
            {'instructions' in draft && (
              <>
                <label className="field">
                  {t('resourceEditor.source')}{' '}
                  <span className="optional">{t('resourceEditor.sourceHint')}</span>
                  <input
                    value={draft.sourcePath}
                    placeholder="/path/to/SKILL.md"
                    onChange={(event) => setDraft({ ...draft, sourcePath: event.target.value })}
                  />
                </label>
                <div className="field">
                  <label htmlFor="skill-instructions">{t('resourceEditor.instructions')}</label>
                  <textarea
                    id="skill-instructions"
                    className="code-input"
                    rows={10}
                    value={draft.instructions}
                    placeholder={t('resourceEditor.instructionsPlaceholder')}
                    onChange={(event) => setDraft({ ...draft, instructions: event.target.value })}
                  />
                </div>
              </>
            )}
            {'version' in draft && (
              <>
                <label className="field">
                  {t('resourceEditor.version')}
                  <input
                    value={draft.version}
                    placeholder="1.0.0"
                    onChange={(event) => setDraft({ ...draft, version: event.target.value })}
                  />
                </label>
                <p className="hint">{t('resourceEditor.pluginHint')}</p>
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
              {t('resourceEditor.enable')}
            </label>
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
            <button type="submit" className="button primary">
              <Save size={16} />
              {busy ? t('common.saving') : t('common.saveConfig')}
            </button>
          </div>
        </fieldset>
      </form>
    </Modal>
  )
}
