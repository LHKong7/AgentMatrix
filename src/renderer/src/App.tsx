import { useI18n } from './i18n'
import { LanguageSelect } from './components/LanguageSelect'
import { CredentialPanel } from './components/CredentialPanel'
import { appError } from '../../shared/errors'
import { useEffect, useRef, useState } from 'react'
import {
  ArrowRight,
  Bot,
  Boxes,
  Check,
  ChevronRight,
  CircleHelp,
  Code2,
  Command,
  FileText,
  FolderOpen,
  Layers3,
  LoaderCircle,
  Plus,
  Puzzle,
  Search,
  Server,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  type LucideIcon,
} from 'lucide-react'
import type { AppInfo } from '../../shared/api'
import {
  createAgent,
  createResource,
  formatError,
  removeResource,
  resolveResources,
  workspaceSchema,
  type Agent,
  type Resource,
  type ResourceKind,
  type Workspace,
} from '../../shared/workspace'
import { api } from './lib/api'
import { AgentEditor } from './components/AgentEditor'
import { ResourceEditor, resourceLabels } from './components/ResourceEditor'

type Page = 'agents' | ResourceKind | 'settings'
type Editor =
  | { type: 'agent'; value: Agent; isNew: boolean }
  | { type: 'resource'; kind: ResourceKind; value: Resource }

export function App() {
  const { t, locale, number } = useI18n()
  const navigation: { page: Page; label: string; icon: LucideIcon }[] = [
    { page: 'agents', label: t('nav.agents'), icon: Bot },
    { page: 'mcpServers', label: 'MCP Servers', icon: Server },
    { page: 'skills', label: 'Skills', icon: FileText },
    { page: 'plugins', label: t('nav.plugins'), icon: Puzzle },
  ]

  const resourceCopy = {
    mcpServers: {
      title: t('mcp.title'),
      description: t('mcp.description'),
      icon: Server,
      empty: t('mcp.empty'),
      detail: t('mcp.detail'),
    },
    skills: {
      title: t('skills.title'),
      description: t('skills.description'),
      icon: FileText,
      empty: t('skills.empty'),
      detail: t('skills.detail'),
    },
    plugins: {
      title: t('plugins.title'),
      description: t('plugins.description'),
      icon: Puzzle,
      empty: t('plugins.empty'),
      detail: t('plugins.detail'),
    },
  }

  const [workspace, setWorkspace] = useState<Workspace | null>(null)
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [page, setPage] = useState<Page>('agents')
  const [query, setQuery] = useState('')
  const [editor, setEditor] = useState<Editor | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [notice, setNotice] = useState(false)
  const [saving, setSaving] = useState(false)
  const saveLock = useRef(false)

  async function load() {
    setError(null)
    try {
      const [state, appInfo] = await Promise.all([api.loadWorkspace(), api.getAppInfo()])
      setWorkspace(state)
      setInfo(appInfo)
    } catch (failure) {
      setError(failure)
    }
  }
  useEffect(() => {
    void load()
  }, [])
  useEffect(() => {
    if (!notice) return
    const timeout = window.setTimeout(() => setNotice(false), 3000)
    return () => window.clearTimeout(timeout)
  }, [notice])

  async function save(next: Workspace) {
    if (saveLock.current) throw appError('error.saving')
    saveLock.current = true
    setSaving(true)
    try {
      const saved = await api.saveWorkspace(workspaceSchema.parse(next))
      setWorkspace(saved)
      setError(null)
      setNotice(true)
    } finally {
      saveLock.current = false
      setSaving(false)
    }
  }
  async function action(next: Workspace) {
    try {
      await save(next)
    } catch (failure) {
      setError(failure)
    }
  }
  function navigate(next: Page) {
    setPage(next)
    setQuery('')
  }
  function newAgent() {
    setEditor({ type: 'agent', value: createAgent(crypto.randomUUID(), locale), isNew: true })
  }
  function newResource(kind: ResourceKind) {
    setEditor({ type: 'resource', kind, value: createResource(kind, crypto.randomUUID()) })
  }
  function deleteAgent(agent: Agent) {
    if (workspace && window.confirm(t('agents.deleteConfirm', { name: agent.name }))) {
      void action({
        ...workspace,
        agents: workspace.agents.filter((entry) => entry.id !== agent.id),
      })
    }
  }
  function deleteResource(kind: ResourceKind, resource: Resource) {
    if (workspace && window.confirm(t('resources.deleteConfirm', { name: resource.name }))) {
      void action(removeResource(workspace, kind, resource.id))
    }
  }
  const matches = (entry: { name: string; description: string }) =>
    `${entry.name} ${entry.description}`.toLowerCase().includes(query.toLowerCase())
  const currentLabel =
    page === 'settings' ? t('nav.settings') : navigation.find((item) => item.page === page)?.label

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-symbol">
            <Boxes size={25} strokeWidth={1.8} />
          </div>
          <span>
            Agent<span className="brand-light">Matrix</span>
            <small>{t('brand.tagline')}</small>
          </span>
        </div>
        <div className="workspace-switch">
          <div className="workspace-avatar">M</div>
          <div>
            <strong>{t('workspace.personal')}</strong>
            <span>{t('workspace.local')}</span>
          </div>
          <span className="local-dot" />
        </div>
        <span className="nav-caption">{t('workspace.title')}</span>
        <nav aria-label={t('nav.main')}>
          {navigation.map(({ page: target, label, icon: Icon }) => (
            <button
              key={target}
              className={`nav-item ${page === target ? 'active' : ''}`}
              onClick={() => navigate(target)}
            >
              <Icon size={19} />
              <span>{label}</span>
              {workspace && <small>{workspace[target as ResourceKind | 'agents'].length}</small>}
            </button>
          ))}
        </nav>
        <div className="sidebar-note">
          <Layers3 size={20} />
          <strong>{t('sidebar.title')}</strong>
          <p>{t('sidebar.description')}</p>
          <button onClick={() => navigate('plugins')}>
            {t('sidebar.plugins')} <ArrowRight size={14} />
          </button>
        </div>
        <div className="sidebar-bottom">
          <button
            className={`nav-item ${page === 'settings' ? 'active' : ''}`}
            onClick={() => navigate('settings')}
          >
            <Settings2 size={19} />
            <span>{t('nav.settings')}</span>
          </button>
          <div className="local-status">
            <ShieldCheck size={15} />
            <span>{info?.storage === 'browser' ? t('storage.browser') : t('storage.desktop')}</span>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            <FolderOpen size={16} />
            <span>{t('workspace.title')}</span>
            <ChevronRight size={14} />
            <strong>{currentLabel}</strong>
          </div>
          <div className="topbar-right">
            <LanguageSelect />
            <span className="version">v{info?.version ?? '0.1.0'}</span>
            <span className="avatar">ME</span>
          </div>
        </header>
        <main>
          {error != null && (
            <div className="error-banner" role="alert">
              <span>{formatError(error, locale)}</span>
              <button onClick={() => void load()}>{t('common.reload')}</button>
            </div>
          )}
          {!workspace ? (
            <div className="loading">
              {error ? <CircleHelp size={28} /> : <LoaderCircle className="spin" size={28} />}
              <p>{error ? t('common.loadFailed') : t('common.loading')}</p>
            </div>
          ) : (
            <>
              {page === 'agents' && (
                <>
                  <div className="page-heading">
                    <div>
                      <div className="eyebrow">
                        <span />
                        {t('agents.eyebrow')}
                      </div>
                      <h1>
                        {t('agents.title')}
                        <span className="accent">。</span>
                      </h1>
                      <p>{t('agents.description')}</p>
                    </div>
                    <button className="button primary" onClick={newAgent} disabled={saving}>
                      <Plus size={18} />
                      {t('agents.create')}
                    </button>
                  </div>
                  <div className="stats-grid">
                    <Stat
                      label="Agents"
                      value={workspace.agents.length}
                      icon={Bot}
                      detail={t('agents.enabledCount', {
                        count: number(workspace.agents.filter((agent) => agent.enabled).length),
                      })}
                    />
                    <Stat
                      label="MCP Servers"
                      value={workspace.mcpServers.length}
                      icon={Server}
                      detail={t('stats.mcp')}
                    />
                    <Stat
                      label="Skills"
                      value={workspace.skills.length}
                      icon={FileText}
                      detail={t('stats.skills')}
                    />
                    <Stat
                      label={t('nav.plugins')}
                      value={workspace.plugins.length}
                      icon={Puzzle}
                      detail={t('stats.plugins')}
                    />
                  </div>
                  <div className="list-toolbar">
                    <div>
                      <h2>
                        {t('nav.agents')} <span>{workspace.agents.length}</span>
                      </h2>
                      <p>{t('agents.listHint')}</p>
                    </div>
                    <SearchInput
                      value={query}
                      onChange={setQuery}
                      placeholder={t('agents.search')}
                    />
                  </div>
                  <div className="card-grid">
                    {workspace.agents.filter(matches).map((agent, index) => {
                      const resources = resolveResources(workspace, agent)
                      return (
                        <article className="agent-card" key={agent.id}>
                          <div className="card-top">
                            <div className={`agent-icon tone-${index % 3}`}>
                              <Bot size={26} strokeWidth={1.7} />
                            </div>
                            <button
                              className={`status-pill ${agent.enabled ? 'enabled' : ''}`}
                              aria-label={t(
                                agent.enabled ? 'common.disableNamed' : 'common.enableNamed',
                                { name: agent.name },
                              )}
                              disabled={saving}
                              onClick={() =>
                                void action({
                                  ...workspace,
                                  agents: workspace.agents.map((entry) =>
                                    entry.id === agent.id
                                      ? { ...entry, enabled: !entry.enabled }
                                      : entry,
                                  ),
                                })
                              }
                            >
                              <span />
                              {agent.enabled ? t('common.enabled') : t('common.disabled')}
                            </button>
                          </div>
                          <h3>{agent.name}</h3>
                          <p className="card-description">
                            {agent.description || t('agents.descriptionEmpty')}
                          </p>
                          <div className="model-label">
                            <Command size={13} />
                            <span>{agent.model || t('agents.modelEmpty')}</span>
                          </div>
                          <div className="capability-row">
                            <span>
                              <Server size={13} />
                              {resources.mcpServers.length} MCP
                            </span>
                            <span>
                              <FileText size={13} />
                              {resources.skills.length} Skills
                            </span>
                            <span>
                              <Puzzle size={13} />
                              {t('agents.pluginCount', { count: number(resources.plugins.length) })}
                            </span>
                          </div>
                          <div className="card-footer">
                            <button
                              className="text-button"
                              aria-label={t('common.editNamed', { name: agent.name })}
                              onClick={() =>
                                setEditor({ type: 'agent', value: agent, isNew: false })
                              }
                              disabled={saving}
                            >
                              <SlidersHorizontal size={15} />
                              {t('agents.configure')}
                              <ArrowRight size={14} />
                            </button>
                            <button
                              className="icon-button danger-hover"
                              aria-label={t('common.deleteNamed', { name: agent.name })}
                              onClick={() => deleteAgent(agent)}
                              disabled={saving}
                            >
                              <Trash2 size={15} />
                            </button>
                          </div>
                        </article>
                      )
                    })}
                    {!query && (
                      <button className="create-card" onClick={newAgent} disabled={saving}>
                        <span className="create-plus">
                          <Plus size={25} />
                        </span>
                        <strong>{t('agents.newIdea')}</strong>
                        <span>{t('agents.newHint')}</span>
                        <span className="create-link">
                          {t('agents.create')} <ArrowRight size={15} />
                        </span>
                      </button>
                    )}
                  </div>
                  {query && !workspace.agents.some(matches) && (
                    <p className="no-results">{t('agents.noResults')}</p>
                  )}
                  <div className="getting-started">
                    <div className="guide-icon">
                      <Sparkles size={22} />
                    </div>
                    <div>
                      <strong>{t('agents.guideTitle')}</strong>
                      <p>{t('agents.guideBody')}</p>
                    </div>
                    <button className="text-button" onClick={() => navigate('skills')}>
                      {t('agents.manageSkills')} <ArrowRight size={16} />
                    </button>
                  </div>
                  <p className="runtime-note">{t('agents.runtimeNote')}</p>
                </>
              )}
              {page !== 'agents' &&
                page !== 'settings' &&
                (() => {
                  const copy = resourceCopy[page]
                  const Icon = copy.icon
                  const entries = workspace[page].filter(matches)
                  return (
                    <>
                      <div className="page-heading">
                        <div>
                          <div className="eyebrow">
                            <span />
                            {t('resources.eyebrow')}
                          </div>
                          <h1>{copy.title}</h1>
                          <p>{copy.description}</p>
                        </div>
                        <button
                          className="button primary"
                          onClick={() => newResource(page)}
                          disabled={saving}
                        >
                          <Plus size={18} />
                          {t('resources.add', { resource: t(resourceLabels[page]) })}
                        </button>
                      </div>
                      <div className="list-toolbar">
                        <h2>
                          {currentLabel} <span>{workspace[page].length}</span>
                        </h2>
                        <SearchInput
                          value={query}
                          onChange={setQuery}
                          placeholder={t('resources.search')}
                        />
                      </div>
                      {entries.length ? (
                        <div className="resource-list">
                          {entries.map((resource) => (
                            <article className="resource-card" key={resource.id}>
                              <div className="resource-icon">
                                <Icon size={23} />
                              </div>
                              <div className="resource-summary">
                                <h3>
                                  {resource.name}
                                  <span className={`tag ${resource.enabled ? 'green' : ''}`}>
                                    {resource.enabled ? t('common.enabled') : t('common.disabled')}
                                  </span>
                                </h3>
                                <p>{resource.description || t('common.noDescription')}</p>
                                <code>
                                  {'transport' in resource
                                    ? resource.transport === 'stdio'
                                      ? resource.command
                                      : resource.url
                                    : 'version' in resource
                                      ? t('resources.summary', {
                                          version: resource.version,
                                          mcp: number(resource.mcpServerIds.length),
                                          skills: number(resource.skillIds.length),
                                        })
                                      : resource.sourcePath || t('resources.inline')}
                                </code>
                              </div>
                              <button
                                className="button secondary"
                                aria-label={t('common.editNamed', { name: resource.name })}
                                onClick={() =>
                                  setEditor({ type: 'resource', kind: page, value: resource })
                                }
                                disabled={saving}
                              >
                                {t('common.configure')}
                              </button>
                              <button
                                className="icon-button danger-hover"
                                aria-label={t('common.deleteNamed', { name: resource.name })}
                                onClick={() => deleteResource(page, resource)}
                                disabled={saving}
                              >
                                <Trash2 size={16} />
                              </button>
                            </article>
                          ))}
                        </div>
                      ) : (
                        <div className="empty-state">
                          <div className="empty-icon">
                            <Icon size={34} strokeWidth={1.5} />
                          </div>
                          <h2>{query ? t('resources.noResults') : copy.empty}</h2>
                          <p>{query ? t('resources.trySearch') : copy.detail}</p>
                          {!query && (
                            <button className="button secondary" onClick={() => newResource(page)}>
                              <Plus size={16} />
                              {t('resources.add', { resource: t(resourceLabels[page]) })}
                            </button>
                          )}
                        </div>
                      )}
                    </>
                  )
                })()}
              {page === 'settings' && (
                <>
                  <div className="page-heading">
                    <div>
                      <div className="eyebrow">
                        <span />
                        {t('settings.eyebrow')}
                      </div>
                      <h1>{t('settings.title')}</h1>
                      <p>{t('settings.description')}</p>
                    </div>
                  </div>
                  <section className="settings-panel language-settings">
                    <h2>{t('settings.language')}</h2>
                    <LanguageSelect />
                    <p className="hint">{t('settings.languageHint')}</p>
                  </section>
                  <CredentialPanel />
                  <section className="settings-panel">
                    <h2>
                      <ShieldCheck size={20} />
                      {t('workspace.local')}
                    </h2>
                    <dl>
                      <div>
                        <dt>{t('settings.version')}</dt>
                        <dd>AgentMatrix {info?.version}</dd>
                      </div>
                      <div>
                        <dt>{t('settings.environment')}</dt>
                        <dd>
                          {info?.platform} ·{' '}
                          {info?.storage === 'browser'
                            ? t('settings.browser')
                            : t('settings.desktop')}
                        </dd>
                      </div>
                      <div>
                        <dt>{t('settings.path')}</dt>
                        <dd>
                          <code>
                            {info?.storage === 'browser'
                              ? t('storage.browserPath')
                              : info?.configPath}
                          </code>
                        </dd>
                      </div>
                      <div>
                        <dt>{t('settings.format')}</dt>
                        <dd>
                          {t('settings.dataFormat', {
                            schema: workspace.schemaVersion,
                            revision: number(workspace.revision),
                          })}
                        </dd>
                      </div>
                    </dl>
                    <p className="hint">{t('settings.storageHint')}</p>
                  </section>
                  <section className="settings-panel">
                    <h2>
                      <Code2 size={20} />
                      {t('settings.roadmap')}
                    </h2>
                    <div className="roadmap-row">
                      <Check size={18} />
                      <div>
                        <strong>{t('settings.configTitle')}</strong>
                        <p>{t('settings.configBody')}</p>
                      </div>
                      <span className="tag green">{t('settings.supported')}</span>
                    </div>
                    <div className="roadmap-row pending">
                      <Layers3 size={18} />
                      <div>
                        <strong>{t('settings.runtimeTitle')}</strong>
                        <p>{t('settings.runtimeBody')}</p>
                      </div>
                      <span className="tag">{t('settings.planned')}</span>
                    </div>
                    <div className="roadmap-row pending">
                      <Puzzle size={18} />
                      <div>
                        <strong>{t('settings.pluginsTitle')}</strong>
                        <p>{t('settings.pluginsBody')}</p>
                      </div>
                      <span className="tag">{t('settings.planned')}</span>
                    </div>
                  </section>
                </>
              )}
            </>
          )}
        </main>
      </div>
      {notice && (
        <div className="toast" role="status">
          <Check size={16} />
          {t('common.saved')}
        </div>
      )}
      {workspace && editor?.type === 'agent' && (
        <AgentEditor
          agent={editor.value}
          workspace={workspace}
          isNew={editor.isNew}
          busy={saving}
          onClose={() => setEditor(null)}
          onSave={async (agent) => {
            await save({
              ...workspace,
              agents: editor.isNew
                ? [...workspace.agents, agent]
                : workspace.agents.map((entry) => (entry.id === agent.id ? agent : entry)),
            })
            setEditor(null)
          }}
        />
      )}
      {workspace && editor?.type === 'resource' && (
        <ResourceEditor
          resource={editor.value}
          kind={editor.kind}
          workspace={workspace}
          busy={saving}
          onClose={() => setEditor(null)}
          onSave={async (resource) => {
            const entries = workspace[editor.kind]
            const updated = entries.some((entry) => entry.id === resource.id)
              ? entries.map((entry) => (entry.id === resource.id ? resource : entry))
              : [...entries, resource]
            await save({ ...workspace, [editor.kind]: updated })
            setEditor(null)
          }}
        />
      )}
    </div>
  )
}

function Stat({
  label,
  value,
  icon: Icon,
  detail,
}: {
  label: string
  value: number
  icon: LucideIcon
  detail: string
}) {
  return (
    <div className="stat-card">
      <div className="stat-label">
        <span>{label}</span>
        <Icon size={18} />
      </div>
      <strong>{String(value).padStart(2, '0')}</strong>
      <span className="stat-detail">{detail}</span>
    </div>
  )
}

function SearchInput({
  value,
  onChange,
  placeholder,
}: {
  value: string
  onChange: (value: string) => void
  placeholder: string
}) {
  return (
    <label className="search">
      <Search size={16} />
      <input
        aria-label={placeholder}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  )
}
