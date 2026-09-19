import { appError } from '../errors'
import {
  sessionCommandSchema,
  sessionEventSchema,
  sessionSnapshotSchema,
  type InteractionRequest,
  type SessionCommand,
  type SessionEvent,
  type SessionSnapshot,
  type SessionStatus,
} from './schema'

export type SessionIdentity = Pick<
  SessionSnapshot,
  | 'id'
  | 'agentId'
  | 'installationId'
  | 'engineVersion'
  | 'mode'
  | 'cwd'
  | 'snapshotId'
  | 'snapshotDigest'
  | 'createdAt'
  | 'creationReceipt'
>

export function createSessionSnapshot(identity: SessionIdentity): SessionSnapshot {
  return sessionSnapshotSchema.parse({
    ...identity,
    updatedAt: identity.createdAt,
    cursor: 0,
    status: 'created',
    runId: null,
    nativeSessionId: null,
    activeTurn: null,
    lastTurn: null,
    pendingRequests: [],
    settledRequestIds: [],
    failure: null,
  })
}

function requireStatus(state: SessionSnapshot, allowed: SessionStatus[]): void {
  if (!allowed.includes(state.status)) throw appError('error.sessionState')
}

function requireRun(state: SessionSnapshot, runId: string | null): void {
  if (state.runId !== runId) throw appError('error.sessionStale')
}

function requireTurn(state: SessionSnapshot, turnId: string | null): void {
  if (!state.activeTurn || state.activeTurn.id !== turnId) throw appError('error.sessionStale')
}

function findRequest(state: SessionSnapshot, requestId: string): InteractionRequest {
  const request = state.pendingRequests.find((item) => item.id === requestId)
  if (!request) throw appError('error.sessionStale')
  return request
}

/** Checks address/state, not engine support. The coordinator must also validate native capabilities. */
export function validateSessionCommand(
  state: SessionSnapshot,
  input: unknown,
  now = new Date(),
): SessionCommand {
  const command = sessionCommandSchema.parse(input)
  if (command.kind === 'create') throw appError('error.sessionState')
  if (command.sessionId !== state.id) throw appError('error.sessionStale')
  if ('runId' in command) requireRun(state, command.runId)
  if ('turnId' in command) requireTurn(state, command.turnId)
  switch (command.kind) {
    case 'start':
      requireStatus(state, ['created'])
      break
    case 'send':
      requireStatus(state, ['ready'])
      if (command.messageId === state.lastTurn?.messageId) throw appError('error.sessionStale')
      break
    case 'respond': {
      requireStatus(state, ['waiting'])
      const request = findRequest(state, command.requestId)
      if (request.deadlineAt && Date.parse(request.deadlineAt) <= now.getTime())
        throw appError('error.sessionExpired')
      const response = command.response
      if (response.kind === 'cancelled') break
      if (request.kind === 'permission' || request.kind === 'select') {
        if (
          response.kind !== 'choice' ||
          !request.options.some((option) => option.id === response.optionId)
        )
          throw appError('error.sessionChoice')
      } else if (request.kind !== response.kind) throw appError('error.sessionChoice')
      break
    }
    case 'cancel':
      requireStatus(state, ['running', 'waiting', 'cancelling'])
      break
    case 'resume':
      requireStatus(state, ['interrupted', 'failed'])
      requireRun(state, command.previousRunId)
      if (!state.nativeSessionId) throw appError('error.sessionState')
      break
    case 'close':
      if (state.status === 'closed') throw appError('error.sessionState')
      break
  }
  return command
}

/** Pure projection shared by the main-process stream and renderer replay. */
export function applySessionEvent(previous: SessionSnapshot, input: SessionEvent): SessionSnapshot {
  const event = sessionEventSchema.parse(input)
  if (event.sessionId !== previous.id) throw appError('error.sessionStale')
  // Overlapping replay/live deliveries are safe, but a missing event requires resynchronization.
  if (event.cursor <= previous.cursor) return previous
  if (event.cursor !== previous.cursor + 1) throw appError('error.sessionCursor')
  if (previous.status === 'closed') throw appError('error.sessionState')
  const state = structuredClone(previous)
  const data = event.data
  if (data.kind !== 'run.starting' && data.kind !== 'run.resuming') requireRun(state, event.runId)
  const turnEvent =
    data.kind.startsWith('turn.') ||
    data.kind === 'message.delta' ||
    data.kind === 'tool.updated' ||
    data.kind === 'engine.notice' ||
    data.kind.startsWith('interaction.')
  if (turnEvent && data.kind !== 'turn.started') requireTurn(state, event.turnId)
  if (!turnEvent && event.turnId !== null) throw appError('error.sessionStale')

  switch (data.kind) {
    case 'run.starting':
    case 'run.resuming':
      requireStatus(state, data.kind === 'run.starting' ? ['created'] : ['interrupted', 'failed'])
      if (
        !event.runId ||
        event.runId === state.runId ||
        (data.kind === 'run.resuming' && !state.nativeSessionId)
      )
        throw appError('error.sessionStale')
      state.runId = event.runId
      state.status = data.kind === 'run.starting' ? 'starting' : 'resuming'
      state.failure = null
      break
    case 'run.ready':
      requireStatus(state, ['starting', 'resuming'])
      if (state.status === 'resuming' && state.nativeSessionId !== data.nativeSessionId)
        throw appError('error.sessionStale')
      state.nativeSessionId = data.nativeSessionId
      if (data.configurationChecks || data.credentialResolutions)
        state.configuration = {
          runId: event.runId!,
          snapshotDigest: state.snapshotDigest,
          nativeSessionId: data.nativeSessionId,
          checkedAt: event.timestamp,
          checks: data.configurationChecks ?? [],
          ...(data.credentialResolutions
            ? { credentialResolutions: data.credentialResolutions }
            : {}),
        }
      else delete state.configuration
      state.status = 'ready'
      break
    case 'turn.started':
      requireStatus(state, ['ready'])
      if (
        !event.turnId ||
        event.turnId === state.lastTurn?.id ||
        data.messageId === state.lastTurn?.messageId
      )
        throw appError('error.sessionStale')
      state.activeTurn = { id: event.turnId, messageId: data.messageId, startedAt: event.timestamp }
      state.settledRequestIds = []
      state.failure = null
      state.status = 'running'
      break
    case 'message.delta':
    case 'tool.updated':
    case 'engine.notice':
      requireStatus(state, ['running', 'waiting', 'cancelling', 'closing'])
      break
    case 'interaction.requested':
      requireStatus(state, ['running', 'waiting'])
      if (
        state.pendingRequests.some((request) => request.id === data.request.id) ||
        state.settledRequestIds.includes(data.request.id)
      )
        throw appError('error.sessionStale')
      state.pendingRequests.push(data.request)
      state.status = 'waiting'
      break
    case 'interaction.resolved':
      requireStatus(state, ['waiting'])
      findRequest(state, data.requestId)
      state.settledRequestIds.push(data.requestId)
      state.pendingRequests = state.pendingRequests.filter(
        (request) => request.id !== data.requestId,
      )
      state.status = state.pendingRequests.length ? 'waiting' : 'running'
      break
    case 'turn.cancelling':
      requireStatus(state, ['running', 'waiting', 'cancelling'])
      state.status = 'cancelling'
      state.pendingRequests = []
      break
    case 'turn.finished':
      requireStatus(state, ['running', 'waiting', 'cancelling', 'closing'])
      state.lastTurn = {
        ...state.activeTurn!,
        outcome: data.outcome,
        endedAt: event.timestamp,
        nativeStopReason: data.nativeStopReason,
      }
      state.activeTurn = null
      state.pendingRequests = []
      state.failure = data.failure
      if (state.status !== 'closing') state.status = 'ready'
      break
    case 'run.interrupted':
    case 'run.failed':
      requireStatus(state, [
        'starting',
        'resuming',
        'ready',
        'running',
        'waiting',
        'cancelling',
        'closing',
      ])
      if (state.activeTurn)
        state.lastTurn = {
          ...state.activeTurn,
          outcome: data.kind === 'run.interrupted' ? 'interrupted' : 'failed',
          endedAt: event.timestamp,
          nativeStopReason: null,
        }
      state.activeTurn = null
      state.pendingRequests = []
      state.failure = data.failure
      state.status = data.kind === 'run.interrupted' ? 'interrupted' : 'failed'
      break
    case 'session.closing':
      state.pendingRequests = []
      state.status = 'closing'
      break
    case 'session.closed':
      requireStatus(state, ['closing'])
      if (state.activeTurn)
        state.lastTurn = {
          ...state.activeTurn,
          outcome: 'interrupted',
          endedAt: event.timestamp,
          nativeStopReason: null,
        }
      state.activeTurn = null
      state.pendingRequests = []
      state.status = 'closed'
      break
  }
  state.cursor = event.cursor
  state.updatedAt = event.timestamp
  return sessionSnapshotSchema.parse(state)
}
