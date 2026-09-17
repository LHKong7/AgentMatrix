import { useEffect, useRef, useState } from 'react'
import {
  ArrowRight,
  Bot,
  Boxes,
  Check,
  ChevronRight,
  Command,
  FileText,
  FolderOpen,
  Layers3,
  LoaderCircle,
  MessageSquare,
  Plus,
  Puzzle,
  Search,
  Server,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  type LucideIcon,
} from 'lucide-react'
import type { AppInfo } from '../../shared/api'
import { appError, formatError } from '../../shared/errors'
import {
  collectionLabels,
  libraryEntryLabels,
  profileResourceCounts,
  createLibraryEntry,
  createProfile,
  removeConfiguration,
  upsertConfiguration,
  type Collection,
  type ConfigurationEntry,
  type LibraryCollection,
  type LibraryEntry,
} from '../../shared/engines/editing'
import { engineWorkspaceSchema, type EngineWorkspace } from '../../shared/engines/workspace'
import type { AgentProfile } from '../../shared/engines/schema'
import { useI18n } from './i18n'
import { api } from './lib/api'
import { AgentEditor } from './components/AgentEditor'
import { ResourceEditor } from './components/ResourceEditor'
import { LanguageSelect } from './components/LanguageSelect'
import { CredentialPanel } from './components/CredentialPanel'
import { SessionsPanel } from './components/SessionsPanel'

type Editor =
  | { kind: 'agents'; value: AgentProfile; isNew: boolean }
  | { kind: LibraryCollection; value: LibraryEntry }
const icons: Record<Collection, LucideIcon> = {
  agents: Bot,
  installations: Command,
  connections: SlidersHorizontal,
  models: Layers3,
  prompts: FileText,
  mcpServers: Server,
  skills: FileText,
  bundles: Boxes,
  nativePlugins: Puzzle,
}
const collections = Object.keys(collectionLabels) as Collection[]

export function App() {
  const { t, locale, number } = useI18n()
  const [workspace, setWorkspace] = useState<EngineWorkspace | null>(null)
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [page, setPage] = useState<Collection | 'settings' | 'sessions'>('agents')
  const [sessionAgent, setSessionAgent] = useState<string | null>(null)
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
    const handle = window.setTimeout(() => setNotice(false), 3000)
    return () => window.clearTimeout(handle)
  }, [notice])
  async function save(next: EngineWorkspace) {
    if (saveLock.current) throw appError('error.saving')
    saveLock.current = true
    setSaving(true)
    try {
      const saved = await api.saveWorkspace(engineWorkspaceSchema.parse(next))
      setWorkspace(saved)
      setError(null)
      setNotice(true)
    } finally {
      saveLock.current = false
      setSaving(false)
    }
  }
  async function action(next: EngineWorkspace) {
    try {
      await save(next)
    } catch (failure) {
      setError(failure)
    }
  }
  function navigate(next: Collection | 'settings' | 'sessions') {
    setPage(next)
    setQuery('')
  }
  function add(kind: Collection) {
    if (kind === 'agents')
      setEditor({ kind, value: createProfile(crypto.randomUUID(), locale), isNew: true })
    else
      setEditor({
        kind,
        value: createLibraryEntry(kind, crypto.randomUUID(), info?.platform ?? 'browser'),
      })
  }
  function remove(kind: Collection, value: ConfigurationEntry) {
    if (
      workspace &&
      window.confirm(
        t(kind === 'agents' ? 'agents.deleteConfirm' : 'config.deleteConfirm', {
          name: value.name,
        }),
      )
    )
      void action(removeConfiguration(workspace, kind, value.id))
  }
  const matches = (value: ConfigurationEntry) =>
    `${value.name} ${'description' in value ? value.description : ''}`
      .toLowerCase()
      .includes(query.toLowerCase())
  const label =
    page === 'sessions'
      ? t('nav.sessions')
      : page === 'settings'
        ? t('nav.settings')
        : t(collectionLabels[page])
  async function probe(installationId: string) {
    if (saveLock.current) return
    saveLock.current = true
    setSaving(true)
    setError(null)
    try {
      setWorkspace(await api.probeEngine({ installationId }))
      setNotice(true)
    } catch (failure) {
      setError(failure)
    } finally {
      saveLock.current = false
      setSaving(false)
    }
  }
  function summary(entry: LibraryEntry): string {
    if ('executable' in entry) return `${entry.kind} · ${entry.version ?? t('config.unprobed')}`
    if ('protocol' in entry) return `${entry.protocol ?? t('config.choose')} · ${entry.baseUrl}`
    if ('modelId' in entry) return entry.modelId || t('agents.modelEmpty')
    if ('versions' in entry) return t('config.revision', { version: entry.currentVersion })
    if ('transport' in entry) return entry.transport === 'stdio' ? entry.command : entry.url
    if ('nativeId' in entry) return `${entry.nativeId} · ${entry.version}`
    return `v${entry.version} · ${entry.mcpServerIds.length} MCP · ${entry.skillBindings.length} Skills`
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-symbol">
            <Boxes size={25} />
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
          <button
            className={`nav-item ${page === 'sessions' ? 'active' : ''}`}
            onClick={() => {
              setSessionAgent(null)
              navigate('sessions')
            }}
          >
            <MessageSquare size={19} />
            <span>{t('nav.sessions')}</span>
          </button>
          {collections.map((kind) => {
            const Icon = icons[kind]
            return (
              <button
                key={kind}
                className={`nav-item ${page === kind ? 'active' : ''}`}
                onClick={() => navigate(kind)}
                title={t(collectionLabels[kind])}
              >
                <Icon size={19} />
                <span>{t(collectionLabels[kind])}</span>
                {workspace && <small>{number(workspace[kind].length)}</small>}
              </button>
            )
          })}
        </nav>
        <div className="sidebar-bottom">
          <button
            className={`nav-item ${page === 'settings' ? 'active' : ''}`}
            onClick={() => navigate('settings')}
          >
            <Settings2 size={19} />
            <span>{t('nav.settings')}</span>
          </button>
          <span className="local-status">
            <ShieldCheck size={13} />
            {t(info?.storage === 'browser' ? 'storage.browser' : 'storage.desktop')}
          </span>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            <FolderOpen size={16} />
            <span>AgentMatrix</span>
            <ChevronRight size={14} />
            <strong>{label}</strong>
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
              <LoaderCircle className="spin" size={28} />
              <p>{t(error ? 'common.loadFailed' : 'common.loading')}</p>
            </div>
          ) : page === 'sessions' ? (
            <SessionsPanel
              workspace={workspace}
              desktop={info?.storage === 'desktop'}
              initialAgent={sessionAgent}
            />
          ) : (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">
                    <span />
                    {t(
                      page === 'agents'
                        ? 'agents.eyebrow'
                        : page === 'settings'
                          ? 'settings.eyebrow'
                          : 'resources.eyebrow',
                    )}
                  </div>
                  <h1>{label}</h1>
                  <p>
                    {t(
                      page === 'agents'
                        ? 'agents.description'
                        : page === 'settings'
                          ? 'settings.description'
                          : 'config.libraryHint',
                    )}
                  </p>
                </div>
                {page !== 'settings' && (
                  <button className="button primary" onClick={() => add(page)} disabled={saving}>
                    <Plus size={18} />
                    {page === 'agents'
                      ? t('agents.create')
                      : t('resources.add', { resource: t(libraryEntryLabels[page]) })}
                  </button>
                )}
              </div>
              {page !== 'settings' && (
                <div className="list-toolbar">
                  <h2>
                    {label} <span>{number(workspace[page].length)}</span>
                  </h2>
                  <label className="search">
                    <Search size={16} />
                    <input
                      aria-label={t('resources.search')}
                      placeholder={t('resources.search')}
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                    />
                  </label>
                </div>
              )}
              {page === 'agents' && (
                <>
                  <div className="card-grid">
                    {workspace.agents.filter(matches).map((agent, index) => {
                      const resources = profileResourceCounts(workspace, agent)
                      const engine = workspace.installations.find(
                        (item) => item.id === agent.engineInstallationId,
                      )
                      const model = workspace.models.find(
                        (item) => item.id === agent.modelProfileId,
                      )
                      return (
                        <article className="agent-card" key={agent.id}>
                          <div className="card-top">
                            <div className={`agent-icon tone-${index % 3}`}>
                              <Bot size={26} />
                            </div>
                            <button
                              className={`status-pill ${agent.enabled ? 'enabled' : ''}`}
                              aria-label={t(
                                agent.enabled ? 'common.disableNamed' : 'common.enableNamed',
                                { name: agent.name },
                              )}
                              disabled={saving}
                              onClick={() =>
                                void action(
                                  upsertConfiguration(workspace, 'agents', {
                                    ...agent,
                                    enabled: !agent.enabled,
                                  }),
                                )
                              }
                            >
                              <span />
                              {t(agent.enabled ? 'common.enabled' : 'common.disabled')}
                            </button>
                          </div>
                          <h3>{agent.name}</h3>
                          <p className="card-description">
                            {agent.description || t('agents.descriptionEmpty')}
                          </p>
                          <div className="model-label">
                            <Command size={13} />
                            <span>{engine?.name ?? t('resolution.engine-required')}</span>
                          </div>
                          <div className="model-label">
                            <Layers3 size={13} />
                            <span>{model?.modelId || t('agents.modelEmpty')}</span>
                          </div>
                          <div className="capability-row">
                            <span>{resources.prompts} Prompt</span>
                            <span>{resources.skills} Skills</span>
                            <span>{resources.mcp} MCP</span>
                            <span>
                              {resources.bundles} {t('config.bundles')}
                            </span>
                          </div>
                          <div className="card-footer">
                            <button
                              className="text-button"
                              disabled={saving || !agent.enabled}
                              onClick={() => {
                                setSessionAgent(agent.id)
                                navigate('sessions')
                              }}
                            >
                              <MessageSquare size={15} />
                              {t('sessions.open')}
                            </button>
                            <button
                              className="text-button"
                              aria-label={t('common.editNamed', { name: agent.name })}
                              disabled={saving}
                              onClick={() =>
                                setEditor({ kind: 'agents', value: agent, isNew: false })
                              }
                            >
                              <SlidersHorizontal size={15} />
                              {t('agents.configure')}
                              <ArrowRight size={14} />
                            </button>
                            <button
                              className="icon-button danger-hover"
                              aria-label={t('common.deleteNamed', { name: agent.name })}
                              disabled={saving}
                              onClick={() => remove('agents', agent)}
                            >
                              <Trash2 size={15} />
                            </button>
                          </div>
                        </article>
                      )
                    })}
                    {!query && (
                      <button
                        className="create-card"
                        onClick={() => add('agents')}
                        disabled={saving}
                      >
                        <span className="create-plus">
                          <Plus size={25} />
                        </span>
                        <strong>{t('agents.newIdea')}</strong>
                        <span>{t('agents.newHint')}</span>
                        <span className="create-link">
                          {t('agents.create')}
                          <ArrowRight size={15} />
                        </span>
                      </button>
                    )}
                  </div>
                  <p className="runtime-note">{t('agents.runtimeNote')}</p>
                </>
              )}
              {page !== 'agents' && page !== 'settings' && (
                <div className="resource-list">
                  {workspace[page].filter(matches).map((entry) => {
                    const Icon = icons[page]
                    return (
                      <article className="resource-card" key={entry.id}>
                        <div className="resource-icon">
                          <Icon size={23} />
                        </div>
                        <div className="resource-summary">
                          <h3>
                            {entry.name}
                            {'enabled' in entry && (
                              <span className={`tag ${entry.enabled ? 'green' : ''}`}>
                                {t(entry.enabled ? 'common.enabled' : 'common.disabled')}
                              </span>
                            )}
                          </h3>
                          {'description' in entry && (
                            <p>{entry.description || t('common.noDescription')}</p>
                          )}
                          <code>{summary(entry)}</code>
                        </div>
                        {page === 'installations' && (
                          <button
                            className="button secondary"
                            disabled={
                              saving ||
                              info?.storage !== 'desktop' ||
                              ('kind' in entry &&
                                !['opencode', 'pi', 'deepseek-harness'].includes(entry.kind))
                            }
                            onClick={() => void probe(entry.id)}
                          >
                            {t('sessions.probe')}
                          </button>
                        )}
                        <button
                          className="button secondary"
                          aria-label={t('common.editNamed', { name: entry.name })}
                          disabled={saving}
                          onClick={() => setEditor({ kind: page, value: entry })}
                        >
                          {t('common.configure')}
                        </button>
                        <button
                          className="icon-button danger-hover"
                          aria-label={t('common.deleteNamed', { name: entry.name })}
                          disabled={saving}
                          onClick={() => remove(page, entry)}
                        >
                          <Trash2 size={16} />
                        </button>
                      </article>
                    )
                  })}
                  {!workspace[page].some(matches) && (
                    <div className="empty-state">
                      <h2>
                        {query ? t('resources.noResults') : t('config.empty', { resource: label })}
                      </h2>
                      <p>{t('config.libraryHint')}</p>
                    </div>
                  )}
                </div>
              )}
              {page === 'settings' && (
                <>
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
                          {t(info?.storage === 'browser' ? 'settings.browser' : 'settings.desktop')}
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
      {workspace && editor?.kind === 'agents' && (
        <AgentEditor
          agent={editor.value}
          workspace={workspace}
          isNew={editor.isNew}
          busy={saving}
          onClose={() => setEditor(null)}
          onSave={async (agent) => {
            await save(upsertConfiguration(workspace, 'agents', agent))
            setEditor(null)
          }}
        />
      )}
      {workspace && editor && editor.kind !== 'agents' && (
        <ResourceEditor
          resource={editor.value}
          kind={editor.kind}
          workspace={workspace}
          busy={saving}
          onClose={() => setEditor(null)}
          onSave={async (entry) => {
            await save(upsertConfiguration(workspace, editor.kind, entry))
            setEditor(null)
          }}
        />
      )}
    </div>
  )
}
