import { useEffect, useMemo, useRef, useState } from 'react'
import { LoaderCircle, MessageSquare, Plus, RefreshCw, Send, Square } from 'lucide-react'
import type { EngineWorkspace } from '../../../shared/engines/workspace'
import { resolveAgentProfile } from '../../../shared/engines/resolution'
import type {
  SessionCommand,
  SessionEvent,
  SessionSnapshot,
  InteractionRequest,
} from '../../../shared/sessions/schema'
import { formatError } from '../../../shared/errors'
import { api } from '../lib/api'
import { SessionFeed, emptySessionView } from '../lib/session-feed'
import { useI18n } from '../i18n'
import { ConfigurationReport } from './ConfigurationReport'

const selectedKey = 'agentmatrix.selected-session'
type Response = Extract<SessionCommand, { kind: 'respond' }>['response']

export function SessionsPanel({
  workspace,
  desktop,
  initialAgent,
}: {
  workspace: EngineWorkspace
  desktop: boolean
  initialAgent: string | null
}) {
  const { t, locale } = useI18n()
  const [agentId, setAgentId] = useState(initialAgent ?? workspace.agents[0]?.id ?? '')
  const [sessions, setSessions] = useState<SessionSnapshot[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [view, setView] = useState(emptySessionView)
  const [message, setMessage] = useState('')
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const [showConfiguration, setShowConfiguration] = useState(false)
  const locked = useRef(false)
  const pendingMessage = useRef<string | null>(null)
  const transcript = useRef<HTMLDivElement>(null)
  const following = useRef(true)
  const state = view.snapshot?.id === selected ? view.snapshot : null
  const blocked = busy || view.loading || view.unavailable
  const profile = workspace.agents.find((agent) => agent.id === agentId)
  const supported = ['opencode', 'pi', 'deepseek-harness'].includes(
    workspace.installations.find((engine) => engine.id === profile?.engineInstallationId)?.kind ??
      '',
  )
  const resolution = profile ? resolveAgentProfile(workspace, profile.id) : null

  useEffect(() => {
    let active = true,
      polling = false
    const load = async () => {
      if (polling) return
      polling = true
      try {
        const values = await api.sessions.list()
        if (!active) return
        setSessions((previous) =>
          values.map((value) => {
            const old = previous.find((item) => item.id === value.id)
            return old && old.cursor > value.cursor ? old : value
          }),
        )
        setSelected((id) => {
          if (id && values.some((item) => item.id === id)) return id
          let saved: string | null = null
          try {
            saved = localStorage.getItem(selectedKey)
          } catch {
            /* Session selection is optional. */
          }
          return values.find((item) => item.id === saved)?.id ?? values[0]?.id ?? null
        })
      } catch (failure) {
        if (active) setError(failure)
      } finally {
        polling = false
      }
    }
    void load()
    const timer = window.setInterval(() => void load(), 3000)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [refresh])
  useEffect(() => {
    if (!selected) return
    try {
      localStorage.setItem(selectedKey, selected)
    } catch {
      /* No conversation content is cached here. */
    }
    setView(emptySessionView())
    following.current = true
    setAnswers({})
    const feed = new SessionFeed(api.sessions, selected, (next) => {
      setView(next)
      if (next.snapshot) {
        const snapshot = next.snapshot
        setSessions((values) => [snapshot, ...values.filter((item) => item.id !== snapshot.id)])
        if (
          pendingMessage.current &&
          [snapshot.activeTurn?.messageId, snapshot.lastTurn?.messageId].includes(
            pendingMessage.current,
          )
        ) {
          pendingMessage.current = null
          setMessage('')
        }
      }
    })
    void feed.start()
    return () => feed.dispose()
  }, [selected, refresh])
  useEffect(() => {
    if (following.current && transcript.current)
      transcript.current.scrollTop = transcript.current.scrollHeight
  }, [view.events, locale])

  async function act(operation: () => Promise<unknown>) {
    if (locked.current) return
    locked.current = true
    setBusy(true)
    setError(null)
    try {
      await operation()
    } catch (failure) {
      setError(failure)
    } finally {
      locked.current = false
      setBusy(false)
    }
  }
  const command = (input: SessionCommand) =>
    act(async () => {
      const snapshot = await api.sessions.command(input)
      setSessions((values) => [snapshot, ...values.filter((item) => item.id !== snapshot.id)])
    })
  const respond = (request: InteractionRequest, response: Response) => {
    if (!state?.runId || !state.activeTurn) return
    void command({
      kind: 'respond',
      commandId: crypto.randomUUID(),
      sessionId: state.id,
      runId: state.runId,
      turnId: state.activeTurn.id,
      requestId: request.id,
      response,
    })
  }
  const toolContext = (request: InteractionRequest) => {
    if (request.kind !== 'permission' || !request.toolCallId) return null
    const event = [...view.events]
      .reverse()
      .find(
        (event) =>
          event.turnId === state?.activeTurn?.id &&
          event.data.kind === 'tool.updated' &&
          event.data.toolCallId === request.toolCallId,
      )
    return event?.data.kind === 'tool.updated' ? event.data.content : null
  }
  return (
    <>
      {showConfiguration && state && (
        <ConfigurationReport
          key={state.id}
          session={state}
          workspaceRevision={workspace.revision}
          onClose={() => setShowConfiguration(false)}
        />
      )}
      <div className="page-heading session-page-heading">
        <div>
          <div className="eyebrow">
            <span />
            AgentMatrix
          </div>
          <h1>{t('nav.sessions')}</h1>
          <p>{t('sessions.description')}</p>
        </div>
        <button
          className="button secondary"
          onClick={() => {
            setError(null)
            setRefresh((value) => value + 1)
          }}
        >
          <RefreshCw size={16} />
          {t('sessions.refresh')}
        </button>
      </div>
      <section className="session-create settings-panel">
        <label>
          {t('sessions.agent')}
          <select value={agentId} onChange={(event) => setAgentId(event.target.value)}>
            <option value="">{t('sessions.choose')}</option>
            {workspace.agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </select>
        </label>
        <button
          className="button primary"
          disabled={
            !desktop || busy || !profile?.enabled || !supported || resolution?.status !== 'resolved'
          }
          onClick={() =>
            void act(async () => {
              const created = await api.sessions.command({
                kind: 'create',
                commandId: crypto.randomUUID(),
                agentId,
              })
              setSessions((values) => [created, ...values])
              setSelected(created.id)
              await api.sessions.command({
                kind: 'start',
                commandId: crypto.randomUUID(),
                sessionId: created.id,
              })
            })
          }
        >
          <Plus size={16} />
          {t('sessions.new')}
        </button>
        <p className="hint">{desktop ? t('sessions.support') : t('error.runtimeDesktopOnly')}</p>
        {resolution?.status === 'invalid' && (
          <div className="session-diagnostics">
            {resolution.issues.map((issue, index) => (
              <span key={index}>{t(`resolution.${issue.code}`)}</span>
            ))}
            <span>{t('sessions.probeHint')}</span>
          </div>
        )}
      </section>
      {(error != null || view.error != null) && (
        <div className="error-banner" role="alert">
          {formatError(error ?? view.error, locale)}
        </div>
      )}
      <div className="sessions-layout">
        <aside className="session-list" aria-label={t('nav.sessions')}>
          {!sessions.length && <p>{t('sessions.empty')}</p>}
          {sessions.map((session) => (
            <button
              key={session.id}
              className={selected === session.id ? 'selected' : ''}
              onClick={() => {
                setSelected(session.id)
                setError(null)
                setMessage('')
              }}
            >
              <MessageSquare size={16} />
              <span>
                <strong>
                  {workspace.agents.find((agent) => agent.id === session.agentId)?.name ??
                    session.agentId}
                </strong>
                <small>
                  {t(`sessions.status.${session.status}`)} ·{' '}
                  {new Date(session.createdAt).toLocaleString(locale)}
                </small>
              </span>
            </button>
          ))}
        </aside>
        <section
          className="conversation"
          aria-label={t('sessions.message')}
          data-session-id={state?.id}
        >
          {!selected ? (
            <p className="empty-state">{t('sessions.select')}</p>
          ) : !state ? (
            <div className="loading">
              {view.loading && <LoaderCircle className="spin" size={22} />}
              {t(view.loading ? 'common.loading' : 'common.loadFailed')}
            </div>
          ) : (
            <>
              <div className="conversation-header">
                <div>
                  <strong data-testid="session-status">
                    {t(`sessions.status.${state.status}`)}
                  </strong>
                  <small>
                    {state.engineVersion} · {state.mode} · {state.cwd}
                  </small>
                </div>
                <div className="session-actions">
                  <button
                    className="button secondary"
                    disabled={blocked}
                    onClick={() => setShowConfiguration(true)}
                  >
                    {t('report.title')}
                  </button>
                  {state.status === 'created' && (
                    <button
                      className="button secondary"
                      disabled={blocked}
                      onClick={() =>
                        void command({
                          kind: 'start',
                          commandId: crypto.randomUUID(),
                          sessionId: state.id,
                        })
                      }
                    >
                      {t('sessions.start')}
                    </button>
                  )}
                  {['failed', 'interrupted'].includes(state.status) &&
                    state.nativeSessionId &&
                    state.runId && (
                      <button
                        className="button primary"
                        disabled={blocked}
                        title={t('sessions.resumeHint')}
                        onClick={() =>
                          void command({
                            kind: 'resume',
                            commandId: crypto.randomUUID(),
                            sessionId: state.id,
                            previousRunId: state.runId!,
                          })
                        }
                      >
                        {t('sessions.resume')}
                      </button>
                    )}
                  {state.activeTurn &&
                    state.runId &&
                    ['running', 'waiting'].includes(state.status) && (
                      <button
                        className="button secondary"
                        disabled={blocked}
                        onClick={() =>
                          void command({
                            kind: 'cancel',
                            commandId: crypto.randomUUID(),
                            sessionId: state.id,
                            runId: state.runId!,
                            turnId: state.activeTurn!.id,
                          })
                        }
                      >
                        <Square size={14} />
                        {t('sessions.cancel')}
                      </button>
                    )}
                  {!['closed', 'closing'].includes(state.status) && (
                    <button
                      className="button secondary"
                      disabled={blocked}
                      onClick={() =>
                        void command({
                          kind: 'close',
                          commandId: crypto.randomUUID(),
                          sessionId: state.id,
                          runId: state.runId,
                        })
                      }
                    >
                      {t('sessions.close')}
                    </button>
                  )}
                </div>
              </div>
              <p className="hint captured-hint">{t('sessions.captured')}</p>
              {state.failure && (
                <p className="error-banner" role="status">
                  {t(`sessions.failure.${state.failure.code}`)}
                </p>
              )}
              <div
                className="transcript"
                aria-label={t('nav.sessions')}
                ref={transcript}
                onScroll={(event) => {
                  const node = event.currentTarget
                  following.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48
                }}
              >
                {view.truncated && (
                  <p className="hint">
                    {t('sessions.historyLimit', { count: view.events.length })}
                  </p>
                )}
                <Transcript events={view.events} />
              </div>
              {state.pendingRequests.map((request) => (
                <section className="permission-card" key={request.id}>
                  <strong>
                    {t('sessions.permission')}: {request.title}
                  </strong>
                  {request.deadlineAt && (
                    <small>
                      {t('sessions.deadline', {
                        time: new Date(request.deadlineAt).toLocaleTimeString(locale),
                      })}
                    </small>
                  )}
                  {toolContext(request) && (
                    <pre className="permission-context">{toolContext(request)}</pre>
                  )}
                  <fieldset
                    disabled={
                      blocked ||
                      Boolean(request.deadlineAt && Date.parse(request.deadlineAt) <= Date.now())
                    }
                  >
                    {(request.kind === 'permission' || request.kind === 'select') &&
                      request.options.map((option) => (
                        <button
                          key={option.id}
                          className="button secondary"
                          onClick={() => respond(request, { kind: 'choice', optionId: option.id })}
                        >
                          {request.kind === 'permission' && 'kind' in option
                            ? t(`sessions.permission.${option.kind}`)
                            : option.label}
                          <small>{request.kind === 'permission' ? option.label : ''}</small>
                        </button>
                      ))}
                    {request.kind === 'confirm' && (
                      <>
                        <p>{request.message}</p>
                        <button
                          className="button primary"
                          onClick={() => respond(request, { kind: 'confirm', accepted: true })}
                        >
                          {t('sessions.confirm')}
                        </button>
                        <button
                          className="button secondary"
                          onClick={() => respond(request, { kind: 'confirm', accepted: false })}
                        >
                          {t('sessions.reject')}
                        </button>
                      </>
                    )}
                    {request.kind === 'input' && (
                      <>
                        <p>{request.message}</p>
                        <textarea
                          aria-label={request.title}
                          placeholder={request.placeholder}
                          rows={request.multiline ? 3 : 1}
                          value={answers[request.id] ?? request.initialValue ?? ''}
                          onChange={(event) =>
                            setAnswers((values) => ({
                              ...values,
                              [request.id]: event.target.value,
                            }))
                          }
                        />
                        <button
                          className="button primary"
                          onClick={() =>
                            respond(request, {
                              kind: 'input',
                              value: answers[request.id] ?? request.initialValue ?? '',
                            })
                          }
                        >
                          {t('sessions.respond')}
                        </button>
                      </>
                    )}
                    <button
                      className="text-button"
                      onClick={() => respond(request, { kind: 'cancelled' })}
                    >
                      {t('sessions.dismiss')}
                    </button>
                  </fieldset>
                </section>
              ))}
              {state.status === 'ready' && (
                <form
                  className="composer"
                  onSubmit={(event) => {
                    event.preventDefault()
                    if (!state.runId || state.status !== 'ready' || blocked || !message.trim())
                      return
                    const messageId = crypto.randomUUID()
                    following.current = true
                    pendingMessage.current = messageId
                    void command({
                      kind: 'send',
                      commandId: crypto.randomUUID(),
                      sessionId: state.id,
                      runId: state.runId,
                      messageId,
                      text: message,
                    })
                  }}
                >
                  <label>
                    {t('sessions.message')}
                    <textarea
                      value={message}
                      onChange={(event) => setMessage(event.target.value)}
                      placeholder={t('sessions.placeholder')}
                      maxLength={65_536}
                      rows={3}
                      disabled={view.unavailable}
                    />
                  </label>
                  <button
                    className="button primary"
                    type="submit"
                    disabled={blocked || state.status !== 'ready' || !message.trim()}
                  >
                    <Send size={16} />
                    {t('sessions.send')}
                  </button>
                </form>
              )}
            </>
          )}
        </section>
      </div>
    </>
  )
}

function Transcript({ events }: { events: SessionEvent[] }) {
  const { t, number } = useI18n()
  const rows = useMemo(() => {
    const output: { id: string; data: SessionEvent['data'] }[] = []
    const positions = new Map<string, number>()
    for (const event of events) {
      const data = event.data
      if (data.kind === 'message.delta' || data.kind === 'tool.updated') {
        const id = `${event.turnId}:${data.kind}:${data.kind === 'message.delta' ? data.messageId : data.toolCallId}`
        const previous = positions.get(id)
        if (previous !== undefined) {
          const row = output[previous]!
          row.data =
            data.kind === 'message.delta' && row.data.kind === 'message.delta'
              ? { ...data, text: row.data.text + data.text }
              : data
        } else {
          positions.set(id, output.length)
          output.push({ id, data: { ...data } })
        }
      } else if (
        data.kind === 'turn.started' ||
        data.kind === 'turn.finished' ||
        data.kind === 'engine.notice'
      )
        output.push({ id: String(event.cursor), data })
    }
    return output
  }, [events])
  return rows.map(({ id, data }) => {
    if (data.kind === 'engine.notice')
      return (
        <article className="message" key={id}>
          <strong>{t(`sessions.notice.${data.code}`)}</strong>
          {data.text && <pre>{data.text}</pre>}
        </article>
      )
    if (data.kind === 'turn.started' || data.kind === 'message.delta') {
      const channel = data.kind === 'turn.started' ? 'user' : data.channel
      return (
        <article className={`message ${channel}`} key={id}>
          <strong>{t(`sessions.${channel}`)}</strong>
          <pre>{data.text}</pre>
        </article>
      )
    }
    if (data.kind === 'tool.updated')
      return (
        <details className="tool-event" key={id}>
          <summary>
            {data.title} <span>{t(`sessions.tool.${data.status}`)}</span>
          </summary>
          {data.content && <pre>{data.content}</pre>}
          {data.contentTruncated && <small>{t('sessions.truncated')}</small>}
        </details>
      )
    if (data.kind === 'turn.finished')
      return (
        <div className="turn-result" key={id}>
          <strong>{t(`sessions.outcome.${data.outcome}`)}</strong>
          <span>
            {t('sessions.tokens')}:{' '}
            {data.usage
              ? `${data.usage.inputTokens ?? t('sessions.unknown')} / ${data.usage.outputTokens ?? t('sessions.unknown')} (${t(`sessions.usage.${data.usage.scope ?? 'unknown'}`)})`
              : t('sessions.unknown')}
          </span>
          <span>
            {t('sessions.cost')}:{' '}
            {data.usage?.cost
              ? `${number(data.usage.cost.amount)} ${data.usage.cost.currency}`
              : t('sessions.unknown')}
          </span>
          {data.nativeStopReason && (
            <small>
              {t('sessions.stopReason')}: {data.nativeStopReason}
            </small>
          )}
        </div>
      )
    return null
  })
}
