import {
  libraryImpactQuerySchema,
  type LibraryImpact,
  type LibraryImpactQuery,
} from '../../shared/engines/impact'
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { appError } from '../../shared/errors'
import {
  sessionCommandSchema,
  sessionEventSchema,
  sessionQuerySchema,
  sessionEventQuerySchema,
  sessionHistoryQuerySchema,
  type SessionCommand,
  type SessionSnapshot,
  type SessionDelivery,
  type SessionEventData,
  type SessionEvent,
  sessionSubscriptionSchema,
  type InteractionRequest,
  type InteractionResponse,
} from '../../shared/sessions/schema'
import {
  createSessionSnapshot,
  validateSessionCommand,
  applySessionEvent,
  type SessionIdentity,
} from '../../shared/sessions/state'
import { RuntimeFailure, type RuntimeSession } from '../engines/runtime'
import { SessionJournal } from './journal'
import { SessionEventStream } from './event-stream'
import type { ConfigurationReport } from '../../shared/engines/configuration-report'

type Failure = NonNullable<SessionSnapshot['failure']>
type CreateCommand = Extract<SessionCommand, { kind: 'create' }>
type Identity = Omit<SessionIdentity, 'id' | 'createdAt' | 'creationReceipt'>
export interface SessionRuntimeFactory {
  /** Capture inputs without launching an agent. The ID is stable across retries of creation. */
  create(sessionId: string, command: CreateCommand): Promise<Identity>
  /** Restore only the supplied native ID when status is resuming. Failed connection owns cleanup. */
  connect(snapshot: SessionSnapshot, signal: AbortSignal): Promise<RuntimeSession>
  impact?(query: LibraryImpactQuery, snapshots: SessionSnapshot[]): Promise<LibraryImpact>
  configuration?(snapshot: SessionSnapshot): Promise<ConfigurationReport>
}
interface PendingInteraction {
  resolve(answer: InteractionResponse): void
  signal: AbortSignal
  clean(): void
}
interface Attachment {
  runId: string
  abort: AbortController
  launched: Promise<void>
  runtime?: RuntimeSession
  stopping?: 'close' | 'shutdown' | 'cancel-timeout' | 'failure' | 'storage'
  failure?: Failure
  stopped?: Promise<void>
  cancelTurn?: string
  cancelTimer?: ReturnType<typeof setTimeout>
}
interface Context {
  stream: SessionEventStream
  attachment?: Attachment
  interactions: Map<string, PendingInteraction>
  storageFailed: boolean
}
const appendSchema = sessionEventSchema.omit({ sessionId: true, cursor: true, timestamp: true })
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`
  return JSON.stringify(value)
}
const failureOf = (error: unknown): Failure => ({
  code: error instanceof RuntimeFailure ? error.code : 'engine',
  detail: '',
})

/** Serialize durable decisions per session; never hold that queue while waiting for native work. */
export class SessionCoordinator {
  async impact(input: unknown): Promise<LibraryImpact> {
    const query = libraryImpactQuerySchema.parse(input)
    if (!this.factory.impact) throw appError('error.runtimeUnsupported')
    return this.factory.impact(query, await this.list())
  }
  async configuration(input: unknown): Promise<ConfigurationReport> {
    const query = sessionQuerySchema.parse(input)
    if (!this.factory.configuration) throw appError('error.runtimeUnsupported')
    return this.factory.configuration(await this.get(query))
  }
  private readonly contexts = new Map<string, Context>()
  private readonly queues = new Map<string, Promise<unknown>>()
  private stopping = false
  private shutdownTask?: Promise<void>
  private readonly cancelTimeoutMs: number

  constructor(
    private readonly journal: SessionJournal,
    private readonly factory: SessionRuntimeFactory,
    options: { cancelTimeoutMs?: number } = {},
  ) {
    this.cancelTimeoutMs = z
      .number()
      .int()
      .min(10)
      .max(30_000)
      .parse(options.cancelTimeoutMs ?? 5000)
  }

  command(input: unknown): Promise<SessionSnapshot> {
    const command = sessionCommandSchema.parse(input)
    const receipt = { id: command.commandId, digest: digest(canonical(command)) }
    const id =
      command.kind === 'create' ? `session-${digest(command.commandId)}` : command.sessionId
    return this.serial(id, async () => {
      if (this.stopping) throw appError('error.sessionStopping')
      if (command.kind === 'create') {
        let existing: SessionSnapshot | null = null
        try {
          existing = await this.journal.get(id)
        } catch (error) {
          if (
            !(error instanceof Error) ||
            error.message !== appError('error.sessionMissing').message
          )
            throw error
        }
        if (existing) {
          if (existing.creationReceipt?.digest !== receipt.digest)
            throw appError('error.sessionCommandConflict')
          this.healthy(await this.context(id))
          return existing
        }
        const identity = await this.factory.create(id, command)
        const snapshot = await this.journal.create(
          createSessionSnapshot({
            ...identity,
            id,
            creationReceipt: receipt,
            createdAt: new Date().toISOString(),
          }),
        )
        this.contexts.set(id, {
          stream: new SessionEventStream(snapshot),
          interactions: new Map(),
          storageFailed: false,
        })
        return snapshot
      }
      const context = await this.context(id)
      this.healthy(context)
      const previous = await this.journal
        .receipt(id, command.commandId)
        .catch(() => this.storageFailure(context))
      if (previous) {
        if (previous.digest !== receipt.digest) throw appError('error.sessionCommandConflict')
        return context.stream.snapshot()
      }
      const state = context.stream.snapshot()
      validateSessionCommand(state, command)
      switch (command.kind) {
        case 'start':
        case 'resume': {
          if (context.attachment) throw appError('error.sessionState')
          const runId = randomUUID()
          await this.append(context, {
            runId,
            turnId: null,
            receipt,
            data: { kind: command.kind === 'start' ? 'run.starting' : 'run.resuming' },
          })
          const attachment: Attachment = {
            runId,
            abort: new AbortController(),
            launched: Promise.resolve(),
          }
          context.attachment = attachment
          attachment.launched = this.launch(context, attachment)
          if (this.stopping) void this.stop(context, attachment, 'shutdown').catch(() => {})
          break
        }
        case 'send': {
          const attachment = this.attached(context, command.runId)
          if (!attachment.runtime || attachment.stopping) throw appError('error.sessionState')
          const turnId = randomUUID()
          await this.append(context, {
            runId: attachment.runId,
            turnId,
            receipt,
            data: {
              kind: 'turn.started',
              messageId: command.messageId,
              text: attachment.runtime.redact(command.text),
            },
          })
          void this.send(context, attachment, turnId, command.text)
          break
        }
        case 'respond': {
          const pending = context.interactions.get(command.requestId)
          if (!pending || pending.signal.aborted) throw appError('error.sessionStale')
          await this.append(context, {
            runId: command.runId,
            turnId: command.turnId,
            receipt,
            data: {
              kind: 'interaction.resolved',
              requestId: command.requestId,
              disposition: command.response.kind === 'cancelled' ? 'cancelled' : 'answered',
            },
          })
          this.settle(
            context,
            command.requestId,
            pending.signal.aborted ? { kind: 'cancelled' } : command.response,
          )
          break
        }
        case 'cancel': {
          const attachment = this.attached(context, command.runId)
          await this.append(context, {
            runId: command.runId,
            turnId: command.turnId,
            receipt,
            data: { kind: 'turn.cancelling' },
          })
          this.settleAll(context)
          if (attachment.cancelTurn !== command.turnId) {
            attachment.cancelTurn = command.turnId
            attachment.cancelTimer = setTimeout(() => {
              void this.serial(id, async () => {
                if (this.active(context, attachment, command.turnId))
                  void this.stop(context, attachment, 'cancel-timeout').catch(() => {})
              }).catch(() => {})
            }, this.cancelTimeoutMs)
            void attachment.runtime!.cancel().catch(() => {
              void this.serial(id, async () => {
                if (this.active(context, attachment, command.turnId))
                  void this.stop(context, attachment, 'failure', {
                    code: 'engine',
                    detail: '',
                  }).catch(() => {})
              }).catch(() => {})
            })
          }
          break
        }
        case 'close': {
          await this.append(context, {
            runId: state.runId,
            turnId: null,
            receipt,
            data: { kind: 'session.closing' },
          })
          this.settleAll(context)
          if (context.attachment)
            void this.stop(context, context.attachment, 'close').catch(() => {})
          else
            await this.append(context, {
              runId: state.runId,
              turnId: null,
              data: { kind: 'session.closed' },
            })
          break
        }
      }
      return context.stream.snapshot()
    })
  }

  get(input: unknown): Promise<SessionSnapshot> {
    const { sessionId } = sessionQuerySchema.parse(input)
    return this.serial(sessionId, async () => {
      const context = await this.context(sessionId)
      this.healthy(context)
      return this.journal.get(sessionId).catch(() => this.storageFailure(context))
    })
  }
  list() {
    return this.journal.list()
  }
  readEvents(input: unknown) {
    const query = sessionEventQuerySchema.parse(input)
    return this.serial(query.sessionId, async () => {
      const context = await this.context(query.sessionId)
      this.healthy(context)
      return this.journal.readEvents(query).catch((error) => {
        if (error instanceof Error && error.message === appError('error.sessionCursor').message)
          throw error
        this.storageFailure(context)
      })
    })
  }
  history(input: unknown) {
    const query = sessionHistoryQuerySchema.parse(input)
    return this.serial(query.sessionId, async () => {
      const context = await this.context(query.sessionId)
      this.healthy(context)
      return this.journal.readHistory(query).catch((error) => {
        if (error instanceof Error && error.message === appError('error.sessionCursor').message)
          throw error
        this.storageFailure(context)
      })
    })
  }
  subscribe(
    owner: string,
    input: z.infer<typeof sessionSubscriptionSchema>,
    receive: (delivery: SessionDelivery) => void,
  ) {
    const query = sessionSubscriptionSchema.parse(input)
    return this.serial(query.sessionId, async () => {
      const context = await this.context(query.sessionId)
      this.healthy(context)
      return context.stream.subscribe(owner, query, receive)
    })
  }
  unsubscribe(owner: string, sessionId: string, subscriptionId: string): void {
    this.contexts.get(sessionId)?.stream.unsubscribe(owner, subscriptionId)
  }
  removeOwner(owner: string): void {
    for (const context of this.contexts.values()) context.stream.removeOwner(owner)
  }

  shutdown(): Promise<void> {
    if (this.shutdownTask) return this.shutdownTask
    this.stopping = true
    const firstStops = Promise.allSettled(
      [...this.contexts.values()].flatMap((context) =>
        context.attachment ? [this.stop(context, context.attachment, 'shutdown')] : [],
      ),
    )
    this.shutdownTask = (async () => {
      await Promise.allSettled([...this.queues.values()])
      const results = await Promise.allSettled(
        [...this.contexts.values()].flatMap((context) =>
          context.attachment ? [this.stop(context, context.attachment, 'shutdown')] : [],
        ),
      )
      if ([...(await firstStops), ...results].some((result) => result.status === 'rejected'))
        throw appError('error.sessionStorage')
    })()
    void this.shutdownTask.catch(() => {
      this.shutdownTask = undefined
    })
    return this.shutdownTask
  }

  private serial<T>(id: string, action: () => Promise<T>): Promise<T> {
    const task = (this.queues.get(id) ?? Promise.resolve()).then(action)
    const settled = task.catch(() => {})
    this.queues.set(id, settled)
    void settled.then(() => {
      if (this.queues.get(id) === settled) this.queues.delete(id)
    })
    return task
  }
  private async context(id: string): Promise<Context> {
    let context = this.contexts.get(id)
    if (!context) {
      context = {
        stream: new SessionEventStream(await this.journal.get(id)),
        interactions: new Map(),
        storageFailed: false,
      }
      this.contexts.set(id, context)
    }
    return context
  }
  private healthy(context: Context): void {
    if (context.storageFailed) throw appError('error.sessionStorage')
  }
  private attached(context: Context, runId: string): Attachment {
    if (context.attachment?.runId !== runId) throw appError('error.sessionStale')
    return context.attachment
  }
  private active(context: Context, attachment: Attachment, turnId?: string): boolean {
    return (
      !context.storageFailed &&
      context.attachment === attachment &&
      !attachment.stopping &&
      (turnId === undefined || context.stream.snapshot().activeTurn?.id === turnId)
    )
  }
  private async append(
    context: Context,
    input: z.input<typeof appendSchema>,
  ): Promise<SessionEvent> {
    this.healthy(context)
    const data = appendSchema.parse(input)
    const state = context.stream.snapshot()
    const projected = applySessionEvent(state, {
      ...data,
      sessionId: state.id,
      cursor: state.cursor + 1,
      timestamp: new Date().toISOString(),
    })
    if (Buffer.byteLength(JSON.stringify(projected)) > 4 * 1024 * 1024)
      throw new RuntimeFailure('protocol')
    try {
      const event = await this.journal.append(state.id, state.cursor, data)
      context.stream.append(data, event.timestamp)
      return event
    } catch {
      this.storageFailure(context)
    }
  }
  private storageFailure(context: Context): never {
    context.storageFailed = true
    context.stream.fail()
    this.settleAll(context)
    if (context.attachment) void this.stop(context, context.attachment, 'storage').catch(() => {})
    throw appError('error.sessionStorage')
  }
  private settle(context: Context, id: string, answer: InteractionResponse): void {
    const pending = context.interactions.get(id)
    if (!pending) return
    context.interactions.delete(id)
    pending.clean()
    pending.resolve(answer)
  }
  private settleAll(context: Context): void {
    for (const id of context.interactions.keys()) this.settle(context, id, { kind: 'cancelled' })
  }
  private clearCancel(attachment: Attachment): void {
    clearTimeout(attachment.cancelTimer)
    attachment.cancelTurn = undefined
  }

  private async launch(context: Context, attachment: Attachment): Promise<void> {
    const snapshot = context.stream.snapshot()
    try {
      const runtime = await this.factory.connect(snapshot, attachment.abort.signal)
      attachment.runtime = runtime
      void runtime.closed
        .then(
          () => this.exited(context, attachment, true),
          () => this.exited(context, attachment, false),
        )
        .catch(() => {})
      await this.serial(snapshot.id, async () => {
        if (!this.active(context, attachment) || this.stopping) return
        if (snapshot.status === 'resuming' && runtime.nativeSessionId !== snapshot.nativeSessionId)
          throw new RuntimeFailure('protocol')
        await this.append(context, {
          runId: attachment.runId,
          turnId: null,
          data: {
            kind: 'run.ready',
            nativeSessionId: runtime.nativeSessionId,
            ...(runtime.nativeRuntime ? { nativeRuntime: runtime.nativeRuntime } : {}),
            ...(runtime.credentialResolutions
              ? { credentialResolutions: runtime.credentialResolutions }
              : {}),
            ...(runtime.configurationChecks
              ? { configurationChecks: runtime.configurationChecks }
              : {}),
          },
        })
      })
    } catch (error) {
      await this.serial(snapshot.id, async () => {
        if (!this.active(context, attachment)) return
        void this.stop(context, attachment, 'failure', failureOf(error)).catch(() => {})
      }).catch(() => {})
    }
  }
  private async send(
    context: Context,
    attachment: Attachment,
    turnId: string,
    text: string,
  ): Promise<void> {
    const id = context.stream.snapshot().id
    try {
      const result = await attachment.runtime!.send(text, {
        output: (data) =>
          this.serial(id, async () => {
            if (!this.active(context, attachment, turnId)) return
            await this.append(context, { runId: attachment.runId, turnId, data })
          }),
        interaction: (request, signal) =>
          this.interaction(context, attachment, turnId, request, signal),
      })
      await this.serial(id, async () => {
        if (!this.active(context, attachment, turnId)) return
        this.clearCancel(attachment)
        await this.append(context, {
          runId: attachment.runId,
          turnId,
          data: {
            kind: 'turn.finished',
            ...result,
            failure: result.outcome === 'failed' ? { code: 'engine', detail: '' } : null,
          },
        })
        this.settleAll(context)
      })
    } catch (error) {
      await this.serial(id, async () => {
        if (this.active(context, attachment, turnId))
          void this.stop(context, attachment, 'failure', failureOf(error)).catch(() => {})
      }).catch(() => {})
    }
  }
  private async interaction(
    context: Context,
    attachment: Attachment,
    turnId: string,
    request: InteractionRequest,
    signal: AbortSignal,
  ): Promise<InteractionResponse> {
    let resolve!: (answer: InteractionResponse) => void
    const answer = new Promise<InteractionResponse>((done) => {
      resolve = done
    })
    const id = context.stream.snapshot().id
    const accepted = await this.serial(id, async () => {
      if (
        !this.active(context, attachment, turnId) ||
        signal.aborted ||
        context.stream.snapshot().status === 'cancelling'
      )
        return false
      if (request.deadlineAt && Date.parse(request.deadlineAt) <= Date.now()) return false
      await this.append(context, {
        runId: attachment.runId,
        turnId,
        data: { kind: 'interaction.requested', request },
      })
      let timer: ReturnType<typeof setTimeout> | undefined
      const expire = (disposition: 'expired' | 'cancelled') => {
        void this.serial(id, async () => {
          if (!context.interactions.has(request.id)) return
          if (
            this.active(context, attachment, turnId) &&
            context.stream.snapshot().pendingRequests.some((item) => item.id === request.id)
          )
            await this.append(context, {
              runId: attachment.runId,
              turnId,
              data: { kind: 'interaction.resolved', requestId: request.id, disposition },
            })
          this.settle(context, request.id, { kind: 'cancelled' })
        }).catch(() => this.settle(context, request.id, { kind: 'cancelled' }))
      }
      const abort = () => expire('cancelled')
      context.interactions.set(request.id, {
        resolve,
        signal,
        clean: () => {
          clearTimeout(timer)
          signal.removeEventListener('abort', abort)
        },
      })
      signal.addEventListener('abort', abort, { once: true })
      if (request.deadlineAt)
        timer = setTimeout(
          () => expire('expired'),
          Math.max(0, Math.min(2_147_483_647, Date.parse(request.deadlineAt) - Date.now())),
        )
      if (signal.aborted) abort()
      return true
    })
    return accepted ? answer : { kind: 'cancelled' }
  }
  private async exited(context: Context, attachment: Attachment, cleaned: boolean): Promise<void> {
    await this.serial(context.stream.snapshot().id, async () => {
      if (!this.active(context, attachment)) return
      this.clearCancel(attachment)
      this.settleAll(context)
      if (cleaned) context.attachment = undefined
      await this.append(context, {
        runId: attachment.runId,
        turnId: null,
        data: {
          kind: cleaned ? 'run.interrupted' : 'run.failed',
          failure: { code: 'process-exit', detail: '' },
        },
      })
    })
  }
  private stop(
    context: Context,
    attachment: Attachment,
    reason: NonNullable<Attachment['stopping']>,
    failure?: Failure,
  ): Promise<void> {
    if (reason === 'close' || !attachment.stopping) attachment.stopping = reason
    attachment.failure ??= failure
    attachment.abort.abort()
    this.clearCancel(attachment)
    this.settleAll(context)
    if (attachment.stopped) return attachment.stopped
    const id = context.stream.snapshot().id
    attachment.stopped = (async () => {
      try {
        await attachment.launched
        await attachment.runtime?.dispose()
        await this.serial(id, async () => {
          if (context.attachment !== attachment) return
          context.attachment = undefined
          if (context.storageFailed) return
          const data: SessionEventData =
            context.stream.snapshot().status === 'closing'
              ? { kind: 'session.closed' }
              : attachment.stopping === 'failure'
                ? {
                    kind: 'run.failed',
                    failure: attachment.failure ?? { code: 'engine', detail: '' },
                  }
                : {
                    kind: 'run.interrupted',
                    failure: {
                      code: attachment.stopping === 'cancel-timeout' ? 'timeout' : 'interrupted',
                      detail: '',
                    },
                  }
          await this.append(context, { runId: attachment.runId, turnId: null, data })
        })
      } catch {
        attachment.stopped = undefined
        await this.serial(id, async () => {
          if (
            context.storageFailed ||
            context.attachment !== attachment ||
            context.stream.snapshot().status === 'failed'
          )
            return
          await this.append(context, {
            runId: attachment.runId,
            turnId: null,
            data: { kind: 'run.failed', failure: { code: 'process-exit', detail: '' } },
          })
        }).catch(() => {})
        throw appError('error.sessionState')
      }
    })()
    return attachment.stopped
  }
}
