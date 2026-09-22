import { useEffect, useRef, useState } from 'react'
import {
  ArrowRight,
  Bot,
  Boxes,
  Check,
  ChevronRight,
  CircleAlert,
  Command,
  FileText,
  FolderOpen,
  Layers3,
  Layers,
  ListTree,
  LoaderCircle,
  MessageSquare,
  Palette,
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
  bindConnectionToEngine,
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
import { bindingFor, installationsBoundTo } from '../../shared/engines/provider'
import { isSupportedEngine } from '../../shared/engines/contracts'
import { EvidenceBadge } from './components/EvidenceBadge'
import type { AgentProfile } from '../../shared/engines/schema'
import type { MessageKey } from '../../shared/i18n'
import { useI18n } from './i18n'
import { api } from './lib/api'
import { AgentEditor } from './components/AgentEditor'
import { ResourceEditor } from './components/ResourceEditor'
import { LanguageSelect } from './components/LanguageSelect'
import { ThemeToggle } from './components/ThemeToggle'
import { CredentialPanel } from './components/CredentialPanel'
import { NativeImportPanel } from './components/NativeImportPanel'
import { EngineDiscoveryPanel } from './components/EngineDiscoveryPanel'
import { SessionsPanel } from './components/SessionsPanel'
import { SessionListPanel } from './components/SessionListPanel'
import { SharedSetupPanel } from './components/SharedSetupPanel'
import { EngineGrants } from './components/EngineGrants'
import { Badge } from './components/ui/badge'
import { Button } from './components/ui/button'
import { Alert, AlertDescription } from './components/ui/alert'
import { Card, CardContent, CardFooter, CardHeader } from './components/ui/card'
import { Input } from './components/ui/input'
import { cn } from './lib/utils'

type Editor =
  | { kind: 'agents'; value: AgentProfile; isNew: boolean }
  | { kind: LibraryCollection; value: LibraryEntry }
type Page = Collection | 'settings' | 'sessions' | 'sessionList' | 'sharedSetup'
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
/**
 * The workspace read in the order it is used: what a CLI runs, who it reaches, and what it
 * knows. Engines own the installation, its granted connections and the model routes; the
 * library owns everything that is shared across every CLI.
 */
const engineArea: Collection[] = ['installations', 'connections', 'models', 'nativePlugins']
const navigation = [
  { label: 'nav.group.agents', items: ['agents'] },
  {
    label: 'nav.group.engines',
    items: ['installations', 'connections', 'models', 'nativePlugins'],
  },
  { label: 'nav.group.library', items: ['prompts', 'mcpServers', 'skills', 'bundles'] },
] as const satisfies readonly { label: MessageKey; items: readonly Collection[] }[]

function NavHeading({ label, first = false }: { label: string; first?: boolean }) {
  return (
    <span
      className={cn(
        'px-3 pb-1 text-[10px] font-medium tracking-[0.14em] text-muted-foreground uppercase',
        !first && 'pt-3',
      )}
    >
      {label}
    </span>
  )
}

function NavItem({
  icon: Icon,
  label,
  active,
  count,
  onClick,
}: {
  icon: LucideIcon
  label: string
  active: boolean
  count?: string
  onClick: () => void
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      title={label}
      aria-current={active ? 'page' : undefined}
      onClick={onClick}
      className={cn(
        'h-9 w-full justify-start gap-3 px-3 font-normal text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
        active && 'bg-sidebar-accent font-medium text-sidebar-accent-foreground',
      )}
    >
      <Icon size={18} aria-hidden="true" />
      <span className="truncate">{label}</span>
      {count !== undefined && (
        <small className="ml-auto font-mono text-[10px] text-muted-foreground">{count}</small>
      )}
    </Button>
  )
}

export function App() {
  const { t, locale, number } = useI18n()
  const [workspace, setWorkspace] = useState<EngineWorkspace | null>(null)
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [page, setPage] = useState<Page>('agents')
  const [sessionAgent, setSessionAgent] = useState<string | null>(null)
  const [sessionSelection, setSessionSelection] = useState<string | null>(null)
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
  function navigate(next: Page) {
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
      : page === 'sessionList'
        ? t('nav.sessionList')
        : page === 'sharedSetup'
          ? t('nav.sharedSetup')
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
    <div className="flex min-h-screen bg-background">
      <aside className="fixed inset-y-0 left-0 flex w-59 flex-col gap-4 overflow-y-auto border-r border-sidebar-border bg-sidebar px-4 py-6 text-sidebar-foreground">
        <div className="flex items-center gap-3">
          <div className="grid size-11 shrink-0 place-items-center rounded-xl bg-brand text-brand-foreground">
            <Boxes size={24} aria-hidden="true" />
          </div>
          <span className="grid min-w-0">
            <span className="text-sm font-semibold">
              Agent<span className="font-normal text-muted-foreground">Matrix</span>
            </span>
            <small className="text-[9px] tracking-[0.14em] uppercase">{t('brand.tagline')}</small>
          </span>
        </div>
        <div className="flex items-center gap-3 rounded-lg border border-sidebar-border bg-card p-3">
          <div className="grid size-8 place-items-center rounded-md bg-muted text-xs font-semibold">
            M
          </div>
          <div className="grid min-w-0 flex-1 gap-0.5">
            <strong className="truncate text-xs">{t('workspace.personal')}</strong>
            <span className="truncate text-[11px] text-muted-foreground">
              {t('workspace.local')}
            </span>
          </div>
          <span className="size-2 rounded-full bg-success" aria-hidden="true" />
        </div>
        <nav aria-label={t('nav.main')} className="grid gap-0.5">
          <NavHeading label={t('nav.group.sessions')} first />
          <NavItem
            icon={MessageSquare}
            label={t('nav.sessions')}
            active={page === 'sessions'}
            onClick={() => {
              setSessionAgent(null)
              setSessionSelection(null)
              navigate('sessions')
            }}
          />
          <NavItem
            icon={ListTree}
            label={t('nav.sessionList')}
            active={page === 'sessionList'}
            onClick={() => navigate('sessionList')}
          />
          {navigation.map((group) => (
            <div key={group.label} className="grid gap-0.5">
              <NavHeading label={t(group.label)} />
              {group.items.map((kind) => (
                <NavItem
                  key={kind}
                  icon={icons[kind]}
                  label={t(collectionLabels[kind])}
                  active={page === kind}
                  count={workspace ? number(workspace[kind].length) : undefined}
                  onClick={() => navigate(kind)}
                />
              ))}
              {group.label === 'nav.group.agents' && (
                <NavItem
                  icon={Layers}
                  label={t('nav.sharedSetup')}
                  active={page === 'sharedSetup'}
                  onClick={() => navigate('sharedSetup')}
                />
              )}
            </div>
          ))}
        </nav>
        <div className="mt-auto grid gap-3">
          <NavItem
            icon={Settings2}
            label={t('nav.settings')}
            active={page === 'settings'}
            onClick={() => navigate('settings')}
          />
          <span className="flex items-center gap-1.5 px-3 text-[10px] leading-relaxed text-muted-foreground">
            <ShieldCheck size={13} aria-hidden="true" />
            {t(info?.storage === 'browser' ? 'storage.browser' : 'storage.desktop')}
          </span>
        </div>
      </aside>
      <div className="ml-59 flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex flex-wrap items-center justify-between gap-4 border-b border-border bg-background/85 px-8 py-4 backdrop-blur">
          <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
            <FolderOpen size={16} aria-hidden="true" />
            <span>AgentMatrix</span>
            <ChevronRight size={14} aria-hidden="true" />
            <strong className="truncate text-foreground">{label}</strong>
          </div>
          <div className="flex items-center gap-2">
            <LanguageSelect />
            <ThemeToggle />
            <Badge variant="outline" className="font-mono">
              v{info?.version ?? '0.1.0'}
            </Badge>
            <span className="grid size-8 place-items-center rounded-full bg-muted text-[10px] font-semibold">
              ME
            </span>
          </div>
        </header>
        <main className="min-w-0 flex-1 px-8 py-7">
          {error != null && (
            <Alert variant="destructive" className="mb-5" role="alert">
              <CircleAlert aria-hidden="true" />
              <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
                <span>{formatError(error, locale)}</span>
                <Button variant="outline" size="sm" onClick={() => void load()}>
                  {t('common.reload')}
                </Button>
              </AlertDescription>
            </Alert>
          )}
          {!workspace ? (
            <div className="grid justify-items-center gap-3 py-24 text-sm text-muted-foreground">
              <LoaderCircle className="size-7 animate-spin" aria-hidden="true" />
              <p>{t(error ? 'common.loadFailed' : 'common.loading')}</p>
            </div>
          ) : page === 'sessions' ? (
            <SessionsPanel
              workspace={workspace}
              desktop={info?.storage === 'desktop'}
              initialAgent={sessionAgent}
              initialSession={sessionSelection}
              platform={info?.platform}
            />
          ) : page === 'sharedSetup' ? (
            <SharedSetupPanel workspace={workspace} busy={saving} onSave={save} />
          ) : page === 'sessionList' ? (
            <SessionListPanel
              workspace={workspace}
              desktop={info?.storage === 'desktop'}
              onOpenSession={(sessionId) => {
                setSessionSelection(sessionId)
                setSessionAgent(null)
                navigate('sessions')
              }}
            />
          ) : (
            <>
              <div className="mb-6 flex flex-wrap items-end justify-between gap-5">
                <div className="min-w-0">
                  <div className="mb-3 flex items-center gap-2 text-[10px] font-semibold tracking-[0.18em] text-muted-foreground uppercase">
                    <span className="size-1.5 rounded-full bg-brand" aria-hidden="true" />
                    {t(
                      page === 'agents'
                        ? 'agents.eyebrow'
                        : page === 'settings'
                          ? 'settings.eyebrow'
                          : engineArea.includes(page)
                            ? 'engines.eyebrow'
                            : 'resources.eyebrow',
                    )}
                  </div>
                  <h1>{label}</h1>
                  <p className="mt-2 max-w-3xl text-xs leading-relaxed text-muted-foreground">
                    {t(
                      page === 'agents'
                        ? 'agents.description'
                        : page === 'settings'
                          ? 'settings.description'
                          : engineArea.includes(page)
                            ? 'engines.description'
                            : 'config.libraryHint',
                    )}
                  </p>
                </div>
                {page !== 'settings' && (
                  <Button onClick={() => add(page)} disabled={saving}>
                    <Plus aria-hidden="true" />
                    {page === 'agents'
                      ? t('agents.create')
                      : t('resources.add', { resource: t(libraryEntryLabels[page]) })}
                  </Button>
                )}
              </div>
              {page === 'installations' && (
                <>
                  <EngineDiscoveryPanel
                    workspace={workspace}
                    desktop={info?.storage === 'desktop'}
                    platform={info?.platform}
                    busy={saving}
                    onSave={save}
                    onWorkspace={setWorkspace}
                  />
                  <EngineGrants workspace={workspace} busy={saving} onSave={save} />
                </>
              )}
              {page !== 'settings' && (
                <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                  <h2 className="flex items-center gap-2">
                    {label}
                    <Badge variant="muted">{number(workspace[page].length)}</Badge>
                  </h2>
                  <label className="relative flex min-w-56 items-center">
                    <Search
                      className="pointer-events-none absolute left-3 size-4 text-muted-foreground"
                      aria-hidden="true"
                    />
                    <Input
                      className="pl-9"
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
                  <div className="card-grid grid gap-4 sm:grid-cols-2 2xl:grid-cols-3">
                    {workspace.agents.filter(matches).map((agent) => {
                      const resources = profileResourceCounts(workspace, agent)
                      const engine = workspace.installations.find(
                        (item) => item.id === agent.engineInstallationId,
                      )
                      const model = workspace.models.find(
                        (item) => item.id === agent.modelProfileId,
                      )
                      return (
                        <Card asChild key={agent.id}>
                          <article>
                            <CardHeader className="flex flex-row items-start justify-between gap-3">
                              <div className="grid size-11 place-items-center rounded-xl bg-muted text-muted-foreground">
                                <Bot size={22} aria-hidden="true" />
                              </div>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 gap-1.5 px-2 text-[11px] font-normal"
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
                                <span
                                  className={cn(
                                    'size-1.5 rounded-full',
                                    agent.enabled ? 'bg-success' : 'bg-muted-foreground',
                                  )}
                                  aria-hidden="true"
                                />
                                {t(agent.enabled ? 'common.enabled' : 'common.disabled')}
                              </Button>
                            </CardHeader>
                            <CardContent className="grid gap-3">
                              <div className="grid gap-1">
                                <h3 className="flex flex-wrap items-center gap-2 text-sm">
                                  {agent.name}
                                  <EvidenceBadge
                                    workspace={workspace}
                                    subject={{ kind: 'agent', id: agent.id }}
                                  />
                                </h3>
                                <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                                  {agent.description || t('agents.descriptionEmpty')}
                                </p>
                              </div>
                              <div className="grid gap-1.5">
                                <span className="flex items-center gap-2 truncate rounded-md bg-muted px-2 py-1 font-mono text-[11px] text-muted-foreground">
                                  <Command size={12} aria-hidden="true" />
                                  {engine?.name ?? t('resolution.engine-required')}
                                </span>
                                <span className="flex items-center gap-2 truncate rounded-md bg-muted px-2 py-1 font-mono text-[11px] text-muted-foreground">
                                  <Layers3 size={12} aria-hidden="true" />
                                  {model?.modelId || t('agents.modelEmpty')}
                                </span>
                              </div>
                              <div className="flex flex-wrap gap-1.5">
                                <Badge variant="muted">{resources.prompts} Prompt</Badge>
                                <Badge variant="muted">{resources.skills} Skills</Badge>
                                <Badge variant="muted">{resources.mcp} MCP</Badge>
                                <Badge variant="muted">
                                  {resources.bundles} {t('config.bundles')}
                                </Badge>
                              </div>
                            </CardContent>
                            <CardFooter className="mt-auto border-t border-border pt-3">
                              <Button
                                variant="ghost"
                                size="sm"
                                className="flex-1"
                                disabled={saving || !agent.enabled}
                                onClick={() => {
                                  setSessionSelection(null)
                                  setSessionAgent(agent.id)
                                  navigate('sessions')
                                }}
                              >
                                <MessageSquare aria-hidden="true" />
                                {t('sessions.open')}
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="flex-1 [&>svg:last-child]:ml-auto"
                                aria-label={t('common.editNamed', { name: agent.name })}
                                disabled={saving}
                                onClick={() =>
                                  setEditor({ kind: 'agents', value: agent, isNew: false })
                                }
                              >
                                <SlidersHorizontal aria-hidden="true" />
                                {t('agents.configure')}
                                <ArrowRight aria-hidden="true" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                                aria-label={t('common.deleteNamed', { name: agent.name })}
                                disabled={saving}
                                onClick={() => remove('agents', agent)}
                              >
                                <Trash2 aria-hidden="true" />
                              </Button>
                            </CardFooter>
                          </article>
                        </Card>
                      )
                    })}
                    {!query && (
                      <button
                        className="grid min-h-56 place-content-center justify-items-center gap-2 rounded-xl border border-dashed border-border p-6 text-center transition-colors hover:border-ring hover:bg-accent/50 focus-visible:ring-[3px] focus-visible:ring-ring/45 focus-visible:outline-none disabled:opacity-60"
                        onClick={() => add('agents')}
                        disabled={saving}
                      >
                        <span className="grid size-11 place-items-center rounded-full bg-muted text-muted-foreground">
                          <Plus size={22} aria-hidden="true" />
                        </span>
                        <strong className="text-sm">{t('agents.newIdea')}</strong>
                        <span className="max-w-64 text-xs leading-relaxed text-muted-foreground">
                          {t('agents.newHint')}
                        </span>
                        <span className="mt-1 flex items-center gap-1.5 text-xs font-medium">
                          {t('agents.create')}
                          <ArrowRight size={14} aria-hidden="true" />
                        </span>
                      </button>
                    )}
                  </div>
                  <p className="mt-5 text-xs text-muted-foreground">{t('agents.runtimeNote')}</p>
                </>
              )}
              {page !== 'agents' && page !== 'settings' && (
                <div className="grid gap-3">
                  {workspace[page].filter(matches).map((entry) => {
                    const Icon = icons[page]
                    return (
                      <Card asChild key={entry.id}>
                        <article className="flex-row flex-wrap items-center gap-4 px-4">
                          <div className="grid size-10 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
                            <Icon size={20} aria-hidden="true" />
                          </div>
                          <div className="grid min-w-0 flex-1 gap-1">
                            <h3 className="flex flex-wrap items-center gap-2">
                              {entry.name}
                              {'enabled' in entry && (
                                <Badge variant={entry.enabled ? 'success' : 'muted'}>
                                  {t(entry.enabled ? 'common.enabled' : 'common.disabled')}
                                </Badge>
                              )}
                              {page === 'connections' && (
                                <>
                                  <Badge variant="muted">
                                    {t('grants.engines', {
                                      count: number(
                                        installationsBoundTo(workspace, entry.id).length,
                                      ),
                                      total: number(
                                        workspace.installations.filter((item) =>
                                          isSupportedEngine(item.kind),
                                        ).length,
                                      ),
                                    })}
                                  </Badge>
                                  <EvidenceBadge
                                    workspace={workspace}
                                    subject={{ kind: 'connection', id: entry.id }}
                                  />
                                </>
                              )}
                              {page === 'installations' && (
                                <EvidenceBadge
                                  workspace={workspace}
                                  subject={{ kind: 'installation', id: entry.id }}
                                />
                              )}
                            </h3>
                            {'description' in entry && (
                              <p className="text-xs text-muted-foreground">
                                {entry.description || t('common.noDescription')}
                              </p>
                            )}
                            <code className="text-muted-foreground">{summary(entry)}</code>
                          </div>
                          {page === 'installations' && (
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={
                                saving ||
                                info?.storage !== 'desktop' ||
                                ('kind' in entry &&
                                  !['opencode', 'pi', 'deepseek-harness'].includes(entry.kind))
                              }
                              onClick={() => void probe(entry.id)}
                            >
                              {t('sessions.probe')}
                            </Button>
                          )}
                          <Button
                            variant="outline"
                            size="sm"
                            aria-label={t('common.editNamed', { name: entry.name })}
                            disabled={saving}
                            onClick={() => setEditor({ kind: page, value: entry })}
                          >
                            {t('common.configure')}
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                            aria-label={t('common.deleteNamed', { name: entry.name })}
                            disabled={saving}
                            onClick={() => remove(page, entry)}
                          >
                            <Trash2 aria-hidden="true" />
                          </Button>
                        </article>
                      </Card>
                    )
                  })}
                  {!workspace[page].some(matches) && (
                    <div className="grid justify-items-center gap-2 rounded-xl border border-dashed border-border px-6 py-16 text-center">
                      <h2>
                        {query ? t('resources.noResults') : t('config.empty', { resource: label })}
                      </h2>
                      <p className="max-w-lg text-xs leading-relaxed text-muted-foreground">
                        {t('config.libraryHint')}
                      </p>
                    </div>
                  )}
                </div>
              )}
              {page === 'settings' && (
                <>
                  <Card className="mb-5">
                    <CardContent className="grid gap-3">
                      <h2 className="flex items-center gap-2 text-base font-semibold">
                        <Palette className="size-4 text-primary" aria-hidden="true" />
                        {t('settings.theme')}
                      </h2>
                      <div className="flex">
                        <ThemeToggle compact={false} />
                      </div>
                      <p className="text-xs leading-relaxed text-muted-foreground">
                        {t('settings.themeHint')}
                      </p>
                    </CardContent>
                  </Card>
                  <Card className="mb-5" asChild>
                    <section>
                      <CardContent className="grid gap-3">
                        <h2>{t('settings.language')}</h2>
                        <div className="flex">
                          <LanguageSelect />
                        </div>
                        <p className="text-xs leading-relaxed text-muted-foreground">
                          {t('settings.languageHint')}
                        </p>
                      </CardContent>
                    </section>
                  </Card>
                  <NativeImportPanel
                    workspace={workspace}
                    desktop={info?.storage === 'desktop'}
                    onImported={setWorkspace}
                  />
                  <CredentialPanel key={workspace.nativeImports?.length ?? 0} />
                  <Card className="mb-5" asChild>
                    <section>
                      <CardContent className="grid gap-4">
                        <h2 className="flex items-center gap-2">
                          <ShieldCheck size={16} aria-hidden="true" />
                          {t('workspace.local')}
                        </h2>
                        <dl className="sm:grid-cols-2">
                          <div>
                            <dt>{t('settings.version')}</dt>
                            <dd>AgentMatrix {info?.version}</dd>
                          </div>
                          <div>
                            <dt>{t('settings.environment')}</dt>
                            <dd>
                              {info?.platform} ·{' '}
                              {t(
                                info?.storage === 'browser'
                                  ? 'settings.browser'
                                  : 'settings.desktop',
                              )}
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
                        <p className="text-xs leading-relaxed text-muted-foreground">
                          {t('settings.storageHint')}
                        </p>
                      </CardContent>
                    </section>
                  </Card>
                </>
              )}
            </>
          )}
        </main>
      </div>
      {notice && (
        <div
          role="status"
          className="fixed right-6 bottom-6 z-50 flex items-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-xs font-medium text-primary-foreground shadow-lg"
        >
          <Check size={15} aria-hidden="true" />
          {t('common.saved')}
        </div>
      )}
      {workspace && editor?.kind === 'agents' && (
        <AgentEditor
          agent={editor.value}
          workspace={workspace}
          isNew={editor.isNew}
          platform={info?.platform}
          busy={saving}
          onClose={() => setEditor(null)}
          onGrant={(installationId, connectionId) =>
            save(
              bindConnectionToEngine(workspace, {
                // Re-granting a connection that moved to another route replaces its grant.
                id: bindingFor(workspace, installationId, connectionId)?.id ?? crypto.randomUUID(),
                installationId,
                connectionId,
              }),
            )
          }
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
