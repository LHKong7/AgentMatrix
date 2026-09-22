import { describe, expect, it } from 'vitest'
import {
  applySessionEvent,
  createSessionSnapshot,
  validateSessionCommand,
} from '../src/shared/sessions/state'
import {
  sessionCommandSchema,
  sessionSnapshotSchema,
  type InteractionRequest,
  type SessionEvent,
  type SessionEventData,
  type SessionSnapshot,
} from '../src/shared/sessions/schema'

const time = '2026-09-18T00:00:00Z'
export function sessionFixture(): SessionSnapshot {
  return createSessionSnapshot({
    id: 'conversation-1',
    agentId: 'agent-1',
    installationId: 'installation-1',
    engineVersion: '1.0.0',
    mode: 'acp',
    cwd: '/project',
    snapshotId: 'snapshot-1',
    snapshotDigest: 'a'.repeat(64),
    createdAt: time,
  })
}
export function nextEvent(
  state: SessionSnapshot,
  data: SessionEventData,
  overrides: Partial<SessionEvent> = {},
): SessionEvent {
  return {
    sessionId: state.id,
    cursor: state.cursor + 1,
    timestamp: time,
    runId: state.runId,
    turnId: state.activeTurn?.id ?? null,
    data,
    ...overrides,
  }
}
function apply(state: SessionSnapshot, data: SessionEventData, overrides?: Partial<SessionEvent>) {
  return applySessionEvent(state, nextEvent(state, data, overrides))
}
export function runningSession(): SessionSnapshot {
  let state = apply(sessionFixture(), { kind: 'run.starting' }, { runId: 'run-1' })
  state = apply(state, { kind: 'run.ready', nativeSessionId: 'native/session:1' })
  return apply(
    state,
    { kind: 'turn.started', messageId: 'message-1', text: 'Inspect the project' },
    { turnId: 'turn-1' },
  )
}
const request: InteractionRequest = {
  id: 'request-1',
  kind: 'permission',
  title: 'Write file?',
  toolCallId: 'native/tool:1',
  deadlineAt: null,
  options: [
    { id: 'allow-once', label: 'Allow once', kind: 'allow_once' },
    { id: 'reject', label: 'Reject', kind: 'reject_once' },
  ],
}
function reply(state: SessionSnapshot, overrides = {}) {
  return {
    commandId: 'command-1',
    kind: 'respond',
    sessionId: state.id,
    runId: state.runId,
    turnId: state.activeTurn?.id,
    requestId: request.id,
    response: { kind: 'choice', optionId: 'allow-once' },
    ...overrides,
  }
}
const completed: SessionEventData = {
  kind: 'turn.finished',
  outcome: 'completed',
  nativeStopReason: 'end_turn',
  usage: null,
  failure: null,
}

describe('session commands and projection', () => {
  it('rejects arbitrary execution arguments, unknown response fields, and empty messages at the boundary', () => {
    expect(
      sessionCommandSchema.safeParse({
        commandId: 'c',
        kind: 'create',
        agentId: 'a',
        executable: '/bin/sh',
      }).success,
    ).toBe(false)
    const state = runningSession()
    expect(
      sessionCommandSchema.safeParse({
        ...reply(state),
        response: { kind: 'choice', optionId: 'allow-once', nativeRequestId: 'other' },
      }).success,
    ).toBe(false)
    expect(
      sessionCommandSchema.safeParse({
        commandId: 'c',
        kind: 'send',
        sessionId: state.id,
        runId: state.runId,
        messageId: 'm',
        text: '  ',
      }).success,
    ).toBe(false)
  })

  it('requires a ready attachment and allows one turn at a time without mutating prior state', () => {
    const created = sessionFixture()
    const running = runningSession()
    expect(created.status).toBe('created')
    expect(created.runId).toBeNull()
    expect(() =>
      validateSessionCommand(running, {
        commandId: 'c',
        kind: 'send',
        sessionId: running.id,
        runId: running.runId,
        messageId: 'message-2',
        text: 'Again',
      }),
    ).toThrow('sessionState')
    const finished = apply(running, completed)
    expect(finished.status).toBe('ready')
    expect(finished.lastTurn).toMatchObject({ id: 'turn-1', outcome: 'completed' })
    expect(running.activeTurn?.id).toBe('turn-1')
    const second = apply(
      finished,
      { kind: 'turn.started', messageId: 'message-2', text: 'Continue' },
      { turnId: 'turn-2' },
    )
    expect(second.activeTurn?.id).toBe('turn-2')
    expect(() => apply(second, completed, { turnId: 'turn-1' })).toThrow('sessionStale')
  })

  it('matches all four addresses and only permits choices actually offered by the pending request', () => {
    const state = apply(runningSession(), { kind: 'interaction.requested', request })
    expect(validateSessionCommand(state, reply(state)).kind).toBe('respond')
    for (const field of ['sessionId', 'runId', 'turnId', 'requestId'])
      expect(
        () => validateSessionCommand(state, reply(state, { [field]: 'stale' })),
        field,
      ).toThrow('sessionStale')
    expect(() =>
      validateSessionCommand(
        state,
        reply(state, { response: { kind: 'choice', optionId: 'allow-always' } }),
      ),
    ).toThrow('sessionChoice')
    expect(() =>
      validateSessionCommand(
        state,
        reply(state, { response: { kind: 'confirm', accepted: true } }),
      ),
    ).toThrow('sessionChoice')
  })

  it('settles independent pending requests once and never revives a settled request', () => {
    let state = apply(runningSession(), { kind: 'interaction.requested', request })
    state = apply(state, {
      kind: 'interaction.requested',
      request: { ...request, id: 'request-2' },
    })
    state = apply(state, {
      kind: 'interaction.resolved',
      requestId: request.id,
      disposition: 'answered',
    })
    expect(state.status).toBe('waiting')
    expect(state.pendingRequests.map((item) => item.id)).toEqual(['request-2'])
    expect(() => validateSessionCommand(state, reply(state))).toThrow('sessionStale')
    expect(() => apply(state, { kind: 'interaction.requested', request })).toThrow('sessionStale')
    state = apply(state, {
      kind: 'interaction.resolved',
      requestId: 'request-2',
      disposition: 'cancelled',
    })
    expect(state.status).toBe('running')
  })

  it('expires a request at its deadline and requires a matching response type for Pi dialogs', () => {
    const state = apply(runningSession(), {
      kind: 'interaction.requested',
      request: { ...request, deadlineAt: time },
    })
    expect(() => validateSessionCommand(state, reply(state), new Date(time))).toThrow(
      'sessionExpired',
    )
    const input = apply(runningSession(), {
      kind: 'interaction.requested',
      request: {
        id: request.id,
        kind: 'input',
        title: 'Input',
        message: '',
        placeholder: '',
        multiline: false,
        deadlineAt: null,
      },
    })
    expect(
      validateSessionCommand(input, reply(input, { response: { kind: 'input', value: 'Answer' } }))
        .kind,
    ).toBe('respond')
    expect(() => validateSessionCommand(input, reply(input))).toThrow('sessionChoice')
  })

  it('invalidates pending approvals immediately on cancellation and waits for native completion', () => {
    let state = apply(runningSession(), { kind: 'interaction.requested', request })
    const oldReply = reply(state)
    state = apply(state, { kind: 'turn.cancelling' })
    expect(state.status).toBe('cancelling')
    expect(state.pendingRequests).toEqual([])
    expect(() => validateSessionCommand(state, oldReply)).toThrow('sessionState')
    expect(() => apply(state, { kind: 'interaction.requested', request })).toThrow('sessionState')
    state = apply(state, {
      kind: 'message.delta',
      messageId: 'assistant:1',
      channel: 'assistant',
      text: 'A final chunk',
    })
    expect(state.status).toBe('cancelling')
    state = apply(state, { ...completed, outcome: 'cancelled', nativeStopReason: 'cancelled' })
    expect(state.status).toBe('ready')
    expect(state.lastTurn?.outcome).toBe('cancelled')
    expect(() => validateSessionCommand(state, oldReply)).toThrow('sessionStale')
  })

  it('requires a new run on resume, preserves the captured configuration, and rejects old process events', () => {
    const running = runningSession()
    let state = apply(
      running,
      { kind: 'run.interrupted', failure: { code: 'process-exit', detail: 'Exit 1' } },
      { turnId: null },
    )
    expect(state.lastTurn?.outcome).toBe('interrupted')
    expect(state.pendingRequests).toEqual([])
    expect(
      validateSessionCommand(state, {
        commandId: 'c',
        kind: 'resume',
        sessionId: state.id,
        previousRunId: 'run-1',
      }).kind,
    ).toBe('resume')
    expect(() => apply(state, { kind: 'run.resuming' })).toThrow('sessionStale')
    state = apply(state, { kind: 'run.resuming' }, { runId: 'run-2' })
    expect(() =>
      apply(state, { kind: 'run.ready', nativeSessionId: 'another-native-session' }),
    ).toThrow('sessionStale')
    state = apply(state, { kind: 'run.ready', nativeSessionId: running.nativeSessionId! })
    expect(state.snapshotId).toBe(running.snapshotId)
    expect(state.snapshotDigest).toBe(running.snapshotDigest)
    expect(() =>
      apply(
        state,
        { kind: 'run.failed', failure: { code: 'engine', detail: '' } },
        { runId: 'run-1' },
      ),
    ).toThrow('sessionStale')
  })

  it('does not expose resume before the native session identity exists', () => {
    let state = apply(sessionFixture(), { kind: 'run.starting' }, { runId: 'run-1' })
    state = apply(state, {
      kind: 'run.failed',
      failure: { code: 'protocol', detail: 'Handshake failed' },
    })
    expect(() =>
      validateSessionCommand(state, {
        commandId: 'c',
        kind: 'resume',
        sessionId: state.id,
        previousRunId: 'run-1',
      }),
    ).toThrow('sessionState')
  })

  it('deduplicates overlapping replay but detects missing events and foreign sessions', () => {
    const state = runningSession()
    const event = nextEvent(state, {
      kind: 'message.delta',
      messageId: 'm',
      channel: 'assistant',
      text: 'Hello',
    })
    const projected = applySessionEvent(state, event)
    expect(applySessionEvent(projected, event)).toBe(projected)
    expect(() => applySessionEvent(state, { ...event, cursor: event.cursor + 1 })).toThrow(
      'sessionCursor',
    )
    expect(() => applySessionEvent(projected, { ...event, sessionId: 'foreign' })).toThrow(
      'sessionStale',
    )
  })

  it('keeps close terminal even when shutdown interrupts a tool or turn', () => {
    let state = apply(runningSession(), { kind: 'interaction.requested', request })
    const staleReply = reply(state)
    state = apply(state, { kind: 'session.closing' }, { turnId: null })
    expect(() => validateSessionCommand(state, staleReply)).toThrow('sessionState')
    state = apply(state, completed)
    expect(state.status).toBe('closing')
    state = apply(state, { kind: 'session.closed' })
    expect(state.status).toBe('closed')
    expect(() => apply(state, { kind: 'run.resuming' }, { runId: 'run-2' })).toThrow('sessionState')
  })

  it('rejects inconsistent recovered snapshots and does not substitute zero for unknown usage', () => {
    const state = runningSession()
    expect(sessionSnapshotSchema.safeParse({ ...state, status: 'ready' }).success).toBe(false)
    expect(sessionSnapshotSchema.safeParse({ ...state, nativeSessionId: null }).success).toBe(false)
    const event = nextEvent(state, completed)
    expect(event.data).toMatchObject({ usage: null })
    expect(() => apply(state, { ...completed, outcome: 'failed', failure: null })).toThrow()
  })
})
