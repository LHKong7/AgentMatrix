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

const navigation: { page: Page; label: string; icon: LucideIcon }[] = [
  { page: 'agents', label: '我的 Agents', icon: Bot },
  { page: 'mcpServers', label: 'MCP Servers', icon: Server },
  { page: 'skills', label: 'Skills', icon: FileText },
  { page: 'plugins', label: '插件', icon: Puzzle },
]

const resourceCopy = {
  mcpServers: {
    title: '连接工具，拓展边界。',
    description: '集中管理本地和远程 MCP 服务，让 Agent 拥有更多工具。',
    icon: Server,
    empty: '添加你的第一个 MCP Server',
    detail: '配置本地命令或远程服务地址，随时绑定给需要它的 Agent。',
  },
  skills: {
    title: '把经验，变成能力。',
    description: '将可复用的指令与工作流程整理为 Skills。',
    icon: FileText,
    empty: '添加你的第一个 Skill',
    detail: '写下擅长的工作流程，让不同 Agent 复用同一份经验。',
  },
  plugins: {
    title: '自由组合，即刻复用。',
    description: '将 MCP 和 Skills 组合成插件，为 Agent 配置成套能力。',
    icon: Puzzle,
    empty: '创建你的第一个插件',
    detail: '从资源库选择 MCP 和 Skills，组成适合你的能力集合。',
  },
}

export function App() {
  const [workspace, setWorkspace] = useState<Workspace | null>(null)
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [page, setPage] = useState<Page>('agents')
  const [query, setQuery] = useState('')
  const [editor, setEditor] = useState<Editor | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [saving, setSaving] = useState(false)
  const saveLock = useRef(false)

  async function load() {
    setError('')
    try {
      const [state, appInfo] = await Promise.all([api.loadWorkspace(), api.getAppInfo()])
      setWorkspace(state)
      setInfo(appInfo)
    } catch (failure) {
      setError(formatError(failure))
    }
  }
  useEffect(() => {
    void load()
  }, [])
  useEffect(() => {
    if (!notice) return
    const timeout = window.setTimeout(() => setNotice(''), 3000)
    return () => window.clearTimeout(timeout)
  }, [notice])

  async function save(next: Workspace) {
    if (saveLock.current) throw new Error('正在保存，请稍后重试。')
    saveLock.current = true
    setSaving(true)
    try {
      const saved = await api.saveWorkspace(workspaceSchema.parse(next))
      setWorkspace(saved)
      setError('')
      setNotice('配置已保存')
    } finally {
      saveLock.current = false
      setSaving(false)
    }
  }
  async function action(next: Workspace) {
    try {
      await save(next)
    } catch (failure) {
      setError(formatError(failure))
    }
  }
  function navigate(next: Page) {
    setPage(next)
    setQuery('')
  }
  function newAgent() {
    setEditor({ type: 'agent', value: createAgent(crypto.randomUUID()), isNew: true })
  }
  function newResource(kind: ResourceKind) {
    setEditor({ type: 'resource', kind, value: createResource(kind, crypto.randomUUID()) })
  }
  function deleteAgent(agent: Agent) {
    if (workspace && window.confirm(`删除「${agent.name}」？此操作不会删除共享资源。`)) {
      void action({
        ...workspace,
        agents: workspace.agents.filter((entry) => entry.id !== agent.id),
      })
    }
  }
  function deleteResource(kind: ResourceKind, resource: Resource) {
    if (
      workspace &&
      window.confirm(`删除「${resource.name}」？Agent 和插件中的相关绑定也会移除。`)
    ) {
      void action(removeResource(workspace, kind, resource.id))
    }
  }
  const matches = (entry: { name: string; description: string }) =>
    `${entry.name} ${entry.description}`.toLowerCase().includes(query.toLowerCase())
  const currentLabel =
    page === 'settings' ? '设置' : navigation.find((item) => item.page === page)?.label

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-symbol">
            <Boxes size={25} strokeWidth={1.8} />
          </div>
          <span>
            Agent<span className="brand-light">Matrix</span>
            <small>YOUR AGENT WORKSPACE</small>
          </span>
        </div>
        <div className="workspace-switch">
          <div className="workspace-avatar">M</div>
          <div>
            <strong>个人工作空间</strong>
            <span>Local workspace</span>
          </div>
          <span className="local-dot" />
        </div>
        <span className="nav-caption">工作空间</span>
        <nav aria-label="主导航">
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
          <strong>你的工作方式，你来定义</strong>
          <p>
            连接工具、沉淀经验，
            <br />
            让每个 Agent 各有所长。
          </p>
          <button onClick={() => navigate('plugins')}>
            探索插件配置 <ArrowRight size={14} />
          </button>
        </div>
        <div className="sidebar-bottom">
          <button
            className={`nav-item ${page === 'settings' ? 'active' : ''}`}
            onClick={() => navigate('settings')}
          >
            <Settings2 size={19} />
            <span>设置</span>
          </button>
          <div className="local-status">
            <ShieldCheck size={15} />
            <span>
              {info?.storage === 'browser' ? '浏览器预览 · 独立存储' : '本地存储 · 由你掌控'}
            </span>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            <FolderOpen size={16} />
            <span>工作空间</span>
            <ChevronRight size={14} />
            <strong>{currentLabel}</strong>
          </div>
          <div className="topbar-right">
            <span className="version">v{info?.version ?? '0.1.0'}</span>
            <span className="avatar">ME</span>
          </div>
        </header>
        <main>
          {error && (
            <div className="error-banner" role="alert">
              <span>{error}</span>
              <button onClick={() => void load()}>重新加载</button>
            </div>
          )}
          {!workspace ? (
            <div className="loading">
              {error ? <CircleHelp size={28} /> : <LoaderCircle className="spin" size={28} />}
              <p>{error ? '配置加载失败，请检查文件后重试。' : '正在打开工作空间…'}</p>
            </div>
          ) : (
            <>
              {page === 'agents' && (
                <>
                  <div className="page-heading">
                    <div>
                      <div className="eyebrow">
                        <span />
                        AGENT COLLECTION
                      </div>
                      <h1>
                        你的 Agent，各司其职<span className="accent">。</span>
                      </h1>
                      <p>在一个工作空间里，构建、配置并管理你的 AI 助手。</p>
                    </div>
                    <button className="button primary" onClick={newAgent} disabled={saving}>
                      <Plus size={18} />
                      创建 Agent
                    </button>
                  </div>
                  <div className="stats-grid">
                    <Stat
                      label="Agents"
                      value={workspace.agents.length}
                      icon={Bot}
                      detail={`${workspace.agents.filter((agent) => agent.enabled).length} 个配置已启用`}
                    />
                    <Stat
                      label="MCP Servers"
                      value={workspace.mcpServers.length}
                      icon={Server}
                      detail="连接外部工具与数据"
                    />
                    <Stat
                      label="Skills"
                      value={workspace.skills.length}
                      icon={FileText}
                      detail="可复用的知识与指令"
                    />
                    <Stat
                      label="插件"
                      value={workspace.plugins.length}
                      icon={Puzzle}
                      detail="自由组合的能力集合"
                    />
                  </div>
                  <div className="list-toolbar">
                    <div>
                      <h2>
                        我的 Agents <span>{workspace.agents.length}</span>
                      </h2>
                      <p>为不同的工作，配置合适的伙伴。</p>
                    </div>
                    <SearchInput value={query} onChange={setQuery} placeholder="搜索 Agent…" />
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
                              aria-label={`${agent.enabled ? '停用' : '启用'} ${agent.name}`}
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
                              {agent.enabled ? '已启用' : '已停用'}
                            </button>
                          </div>
                          <h3>{agent.name}</h3>
                          <p className="card-description">
                            {agent.description || '为这个 Agent 添加描述，定义它的专长。'}
                          </p>
                          <div className="model-label">
                            <Command size={13} />
                            <span>{agent.model || '尚未配置模型'}</span>
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
                              {resources.plugins.length} 插件
                            </span>
                          </div>
                          <div className="card-footer">
                            <button
                              className="text-button"
                              aria-label={`编辑 ${agent.name}`}
                              onClick={() =>
                                setEditor({ type: 'agent', value: agent, isNew: false })
                              }
                              disabled={saving}
                            >
                              <SlidersHorizontal size={15} />
                              配置 Agent
                              <ArrowRight size={14} />
                            </button>
                            <button
                              className="icon-button danger-hover"
                              aria-label={`删除 ${agent.name}`}
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
                        <strong>新的想法，新的 Agent</strong>
                        <span>从角色设定开始，赋予它独特的能力</span>
                        <span className="create-link">
                          创建 Agent <ArrowRight size={15} />
                        </span>
                      </button>
                    )}
                  </div>
                  {query && !workspace.agents.some(matches) && (
                    <p className="no-results">没有找到匹配的 Agent。</p>
                  )}
                  <div className="getting-started">
                    <div className="guide-icon">
                      <Sparkles size={22} />
                    </div>
                    <div>
                      <strong>从一个 Agent，开始你的工作流</strong>
                      <p>定义 System Prompt → 添加 MCP 与 Skills → 组合专属能力。</p>
                    </div>
                    <button className="text-button" onClick={() => navigate('skills')}>
                      管理 Skills <ArrowRight size={16} />
                    </button>
                  </div>
                  <p className="runtime-note">
                    配置工作区已就绪 · 对话与 Agent 运行将在后续版本接入
                  </p>
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
                            CAPABILITY LIBRARY
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
                          添加 {resourceLabels[page]}
                        </button>
                      </div>
                      <div className="list-toolbar">
                        <h2>
                          {currentLabel} <span>{workspace[page].length}</span>
                        </h2>
                        <SearchInput value={query} onChange={setQuery} placeholder="搜索资源…" />
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
                                    {resource.enabled ? '已启用' : '已停用'}
                                  </span>
                                </h3>
                                <p>{resource.description || '暂无描述'}</p>
                                <code>
                                  {'transport' in resource
                                    ? resource.transport === 'stdio'
                                      ? resource.command
                                      : resource.url
                                    : 'version' in resource
                                      ? `v${resource.version} · ${resource.mcpServerIds.length} MCP · ${resource.skillIds.length} Skills`
                                      : resource.sourcePath || '内联 Markdown 指令'}
                                </code>
                              </div>
                              <button
                                className="button secondary"
                                aria-label={`编辑 ${resource.name}`}
                                onClick={() =>
                                  setEditor({ type: 'resource', kind: page, value: resource })
                                }
                                disabled={saving}
                              >
                                配置
                              </button>
                              <button
                                className="icon-button danger-hover"
                                aria-label={`删除 ${resource.name}`}
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
                          <h2>{query ? '没有找到匹配的资源' : copy.empty}</h2>
                          <p>{query ? '换个关键词试试。' : copy.detail}</p>
                          {!query && (
                            <button className="button secondary" onClick={() => newResource(page)}>
                              <Plus size={16} />
                              添加 {resourceLabels[page]}
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
                        WORKSPACE SETTINGS
                      </div>
                      <h1>一切，尽在掌握。</h1>
                      <p>查看工作空间信息与当前版本的能力。</p>
                    </div>
                  </div>
                  <section className="settings-panel">
                    <h2>
                      <ShieldCheck size={20} />
                      本地工作空间
                    </h2>
                    <dl>
                      <div>
                        <dt>应用版本</dt>
                        <dd>AgentMatrix {info?.version}</dd>
                      </div>
                      <div>
                        <dt>运行环境</dt>
                        <dd>
                          {info?.platform}{' '}
                          {info?.storage === 'browser' ? '· 浏览器预览' : '· Electron 桌面端'}
                        </dd>
                      </div>
                      <div>
                        <dt>配置位置</dt>
                        <dd>
                          <code>{info?.configPath}</code>
                        </dd>
                      </div>
                      <div>
                        <dt>数据格式</dt>
                        <dd>
                          JSON · Schema v{workspace.schemaVersion} · Revision {workspace.revision}
                        </dd>
                      </div>
                    </dl>
                    <p className="hint">
                      桌面配置保存在应用数据目录，重启后保留。浏览器预览使用独立存储。
                    </p>
                  </section>
                  <section className="settings-panel">
                    <h2>
                      <Code2 size={20} />
                      从配置，到协作
                    </h2>
                    <div className="roadmap-row">
                      <Check size={18} />
                      <div>
                        <strong>配置管理</strong>
                        <p>Agent、System Prompt、MCP、Skills、插件组合与本地持久化。</p>
                      </div>
                      <span className="tag green">已支持</span>
                    </div>
                    <div className="roadmap-row pending">
                      <Layers3 size={18} />
                      <div>
                        <strong>Agent 运行时</strong>
                        <p>模型接入、密钥管理、流式对话与 MCP 工具调用。</p>
                      </div>
                      <span className="tag">待接入</span>
                    </div>
                    <div className="roadmap-row pending">
                      <Puzzle size={18} />
                      <div>
                        <strong>插件生态</strong>
                        <p>插件安装、SKILL.md 文件发现与权限管理。</p>
                      </div>
                      <span className="tag">待接入</span>
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
          {notice}
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
