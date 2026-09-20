import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ArrowRight,
  CircleAlert,
  FolderOpen,
  LoaderCircle,
  MessageSquare,
  RefreshCw,
  Search,
} from 'lucide-react'
import type { EngineWorkspace } from '../../../shared/engines/workspace'
import type { SessionHistoryPage, SessionSnapshot } from '../../../shared/sessions/schema'
import {
  sessionListCounts,
  sessionListFilters,
  sessionListView,
  sessionStatusGroup,
  type SessionListFilter,
} from '../../../shared/sessions/list'
import { formatError } from '../../../shared/errors'
import { useI18n } from '../i18n'
import { api } from '../lib/api'
import { ConfigurationReport } from './ConfigurationReport'
import { SessionHistory } from './SessionHistory'
import { Transcript } from './SessionTranscript'
import { Alert, AlertDescription } from './ui/alert'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Card, CardContent } from './ui/card'
import { Input } from './ui/input'
import { Skeleton } from './ui/skeleton'
import { TabList, TabTrigger } from './ui/tabs'
import { cn } from '../lib/utils'

const badges = {
  active: 'success',
  attention: 'warning',
  finished: 'muted',
  failed: 'destructive',
} as const

export function SessionListPanel({
  workspace,
  desktop,
  onOpenSession,
}: {
  workspace: EngineWorkspace
  desktop: boolean
  onOpenSession: (sessionId: string) => void
}) {
  const { t, locale, number } = useI18n()
  const [sessions, setSessions] = useState<SessionSnapshot[] | null>(null)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<SessionListFilter>('all')
  const [selected, setSelected] = useState<string | null>(null)
  const [record, setRecord] = useState<SessionHistoryPage | null>(null)
  const [loadingRecord, setLoadingRecord] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [showConfiguration, setShowConfiguration] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [refresh, setRefresh] = useState(0)

  useEffect(() => {
    let active = true,
      polling = false
    const load = async () => {
      if (polling) return
      polling = true
      try {
        const values = await api.sessions.list()
        if (!active) return
        setSessions(values)
        setSelected((id) => (id && values.some((item) => item.id === id) ? id : null))
      } catch (failure) {
        if (active) setError(failure)
      } finally {
        polling = false
      }
    }
    void load()
    const timer = window.setInterval(() => void load(), 5000)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [refresh])

  const agentName = useCallback(
    (session: SessionSnapshot) =>
      workspace.agents.find((agent) => agent.id === session.agentId)?.name ??
      t('sessionList.missingAgent'),
    [workspace.agents, t],
  )
  const visible = useMemo(
    () => sessionListView(sessions ?? [], { filter, search: query, agentName }),
    [sessions, filter, query, agentName],
  )
  const state = visible.find((session) => session.id === selected) ?? null
  // The saved record is re-read whenever the selected conversation advances.
  const recordId = state?.id ?? null
  const recordCursor = state?.cursor ?? 0

  useEffect(() => {
    if (!recordId || recordCursor === 0) {
      setRecord(null)
      return
    }
    let active = true
    setLoadingRecord(true)
    void api.sessions
      .history({
        sessionId: recordId,
        throughCursor: recordCursor,
        fromCursor: recordCursor,
        direction: 'backward',
        limit: 40,
      })
      .then((page) => {
        if (active) setRecord(page)
      })
      .catch((failure) => {
        if (active) {
          setRecord(null)
          setError(failure)
        }
      })
      .finally(() => {
        if (active) setLoadingRecord(false)
      })
    return () => {
      active = false
    }
  }, [recordId, recordCursor])

  const counts = sessionListCounts(sessions ?? [])

  return (
    <>
      {showHistory && state && (
        <SessionHistory key={state.id} session={state} onClose={() => setShowHistory(false)} />
      )}
      {showConfiguration && state && (
        <ConfigurationReport
          key={state.id}
          session={state}
          workspaceRevision={workspace.revision}
          onClose={() => setShowConfiguration(false)}
        />
      )}
      <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <div className="eyebrow">
            <span />
            {t('sessionList.eyebrow')}
          </div>
          <h1>{t('nav.sessionList')}</h1>
          <p className="mt-2 max-w-3xl text-xs leading-relaxed text-muted-foreground">
            {t('sessionList.description')}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => setRefresh((value) => value + 1)}>
          <RefreshCw aria-hidden="true" />
          {t('sessions.refresh')}
        </Button>
      </div>
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
        {(
          [
            ['sessionList.total', counts.total],
            ['sessionList.active', counts.active],
            ['sessionList.waiting', counts.attention],
            ['sessionList.finished', counts.finished],
            ['sessionList.failed', counts.failed],
          ] as const
        ).map(([key, value]) => (
          <Card key={key} className="gap-1 py-3">
            <CardContent className="grid gap-1">
              <span className="text-[11px] text-muted-foreground">{t(key)}</span>
              <strong className="text-xl leading-none font-semibold">{number(value)}</strong>
            </CardContent>
          </Card>
        ))}
      </div>
      {error != null && (
        <Alert variant="destructive" className="mb-4" role="alert">
          <CircleAlert aria-hidden="true" />
          <AlertDescription>{formatError(error, locale)}</AlertDescription>
        </Alert>
      )}
      {!desktop && (
        <p className="mb-4 text-xs text-muted-foreground">{t('sessionList.desktopOnly')}</p>
      )}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <TabList aria-label={t('sessionList.filter')}>
          {sessionListFilters.map((value) => (
            <TabTrigger
              key={value}
              active={filter === value}
              aria-controls="session-list-results"
              onClick={() => setFilter(value)}
            >
              {t(`sessionList.filter.${value}`)}
            </TabTrigger>
          ))}
        </TabList>
        <label className="relative flex min-w-56 flex-1 items-center">
          <Search
            className="pointer-events-none absolute left-3 size-4 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            className="pl-9"
            aria-label={t('sessionList.search')}
            placeholder={t('sessionList.search')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <span className="text-xs text-muted-foreground">
          {t('sessionList.count', { count: number(visible.length) })}
        </span>
      </div>
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(280px,380px)_minmax(0,1fr)]">
        <div
          id="session-list-results"
          className="grid max-h-[62vh] gap-2 overflow-y-auto pr-1"
          aria-label={t('nav.sessionList')}
        >
          {sessions === null &&
            [0, 1, 2].map((index) => <Skeleton key={index} className="h-20 w-full" />)}
          {sessions !== null && visible.length === 0 && (
            <p className="rounded-lg border border-dashed border-border p-6 text-center text-xs text-muted-foreground">
              {sessions.length ? t('sessionList.noResults') : t('sessionList.empty')}
            </p>
          )}
          {visible.map((session) => (
            <button
              key={session.id}
              type="button"
              data-session-list-id={session.id}
              aria-current={selected === session.id}
              onClick={() => setSelected(session.id)}
              className={cn(
                'grid gap-1.5 rounded-lg border border-border bg-card p-3 text-left transition-colors hover:bg-accent/60 focus-visible:ring-[3px] focus-visible:ring-ring/45 focus-visible:outline-none',
                selected === session.id && 'border-primary/60 bg-accent',
              )}
            >
              <span className="flex items-center justify-between gap-2">
                <strong className="truncate text-xs font-semibold">{agentName(session)}</strong>
                <Badge variant={badges[sessionStatusGroup(session.status)]}>
                  {t(`sessions.status.${session.status}`)}
                </Badge>
              </span>
              <span className="truncate font-mono text-[11px] text-muted-foreground">
                {session.cwd}
              </span>
              <span className="text-[11px] text-muted-foreground">
                {new Date(session.updatedAt).toLocaleString(locale)} · {session.engineVersion}
              </span>
            </button>
          ))}
        </div>
        <Card className="min-h-[24rem]">
          {!state ? (
            <CardContent className="flex h-full items-center justify-center py-10 text-xs text-muted-foreground">
              {t('sessionList.select')}
            </CardContent>
          ) : (
            <CardContent className="grid gap-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="flex items-center gap-2 text-sm font-semibold">
                    <MessageSquare className="size-4 text-primary" aria-hidden="true" />
                    {agentName(state)}
                  </h2>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {t('sessionList.created', {
                      time: new Date(state.createdAt).toLocaleString(locale),
                    })}{' '}
                    ·{' '}
                    {t('sessionList.updated', {
                      time: new Date(state.updatedAt).toLocaleString(locale),
                    })}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" onClick={() => onOpenSession(state.id)}>
                    {t('sessionList.open')}
                    <ArrowRight aria-hidden="true" />
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!desktop}
                    onClick={() => setShowHistory(true)}
                  >
                    {t('sessionList.fullHistory')}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!desktop}
                    onClick={() => setShowConfiguration(true)}
                  >
                    {t('sessionList.report')}
                  </Button>
                </div>
              </div>
              <dl className="grid gap-3 sm:grid-cols-3">
                <div className="grid gap-1">
                  <dt className="text-[11px] text-muted-foreground">{t('sessionList.engine')}</dt>
                  <dd className="text-xs">
                    {state.engineVersion} · {state.mode}
                  </dd>
                </div>
                <div className="grid gap-1 sm:col-span-2">
                  <dt className="flex items-center gap-1 text-[11px] text-muted-foreground">
                    <FolderOpen className="size-3" aria-hidden="true" />
                    {t('sessionList.directory')}
                  </dt>
                  <dd className="font-mono text-[11px] break-all">{state.cwd}</dd>
                </div>
                <div className="grid gap-1 sm:col-span-3">
                  <dt className="text-[11px] text-muted-foreground">{t('sessionList.lastTurn')}</dt>
                  <dd className="text-xs">
                    {state.lastTurn
                      ? `${t(`sessions.outcome.${state.lastTurn.outcome}`)} · ${new Date(
                          state.lastTurn.endedAt,
                        ).toLocaleString(locale)}`
                      : t('sessionList.noTurns')}
                  </dd>
                </div>
              </dl>
              {state.pendingRequests.length > 0 && (
                <Alert variant="warning" role="status">
                  <CircleAlert aria-hidden="true" />
                  <AlertDescription>{t('sessionList.pending')}</AlertDescription>
                </Alert>
              )}
              <div className="grid gap-2">
                <h3 className="text-xs font-semibold">{t('sessionList.recent')}</h3>
                <div className="transcript max-h-[38vh] overflow-y-auto rounded-lg border border-border bg-surface p-3">
                  {loadingRecord ? (
                    <p className="flex items-center gap-2 text-xs text-muted-foreground">
                      <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
                      {t('sessionList.loadingRecord')}
                    </p>
                  ) : record && record.events.length > 0 ? (
                    <Transcript events={record.events} history />
                  ) : (
                    <p className="text-xs text-muted-foreground">{t('history.empty')}</p>
                  )}
                </div>
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  {t('sessionList.recordHint')}
                </p>
              </div>
            </CardContent>
          )}
        </Card>
      </div>
    </>
  )
}
