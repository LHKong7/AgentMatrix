import { z } from 'zod'
import { absolutePath, entityId, runtimeModeSchema } from '../engines/schema'

const text = z.string().max(65_536)
const nativeId = z.string().min(1).max(1000)
export const sessionCursorSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
export const sessionFailureSchema = z
  .object({
    code: z.enum([
      'configuration',
      'unsupported',
      'credentials',
      'process-exit',
      'protocol',
      'timeout',
      'interrupted',
      'storage',
      'engine',
    ]),
    // Adapters supply a redacted diagnostic, never an Error/command/environment dump.
    detail: z.string().max(4000),
  })
  .strict()

const requestFields = {
  id: entityId,
  title: z.string().max(1000),
  deadlineAt: z.iso.datetime().nullable(),
}
const choice = z.object({ id: nativeId, label: z.string().max(1000) }).strict()
export const interactionRequestSchema = z
  .discriminatedUnion('kind', [
    z
      .object({
        ...requestFields,
        kind: z.literal('permission'),
        toolCallId: nativeId.nullable(),
        options: z
          .array(
            choice.extend({
              kind: z.enum(['allow_once', 'allow_always', 'reject_once', 'reject_always']),
            }),
          )
          .min(1)
          .max(100),
      })
      .strict(),
    z
      .object({
        ...requestFields,
        kind: z.literal('select'),
        options: z.array(choice).min(1).max(100),
      })
      .strict(),
    z.object({ ...requestFields, kind: z.literal('confirm'), message: text }).strict(),
    z
      .object({
        ...requestFields,
        kind: z.literal('input'),
        message: text,
        placeholder: z.string().max(1000),
        multiline: z.boolean(),
      })
      .strict(),
  ])
  .superRefine((request, context) => {
    if (
      'options' in request &&
      new Set(request.options.map((option) => option.id)).size !== request.options.length
    )
      context.addIssue({ code: 'custom', path: ['options'], message: 'validation.duplicateIds' })
  })
export type InteractionRequest = z.infer<typeof interactionRequestSchema>

export const interactionResponseSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('choice'), optionId: nativeId }).strict(),
  z.object({ kind: z.literal('confirm'), accepted: z.boolean() }).strict(),
  z.object({ kind: z.literal('input'), value: text }).strict(),
  z.object({ kind: z.literal('cancelled') }).strict(),
])

const addressed = { commandId: entityId, sessionId: entityId }
const attached = { ...addressed, runId: entityId }
const turnAddressed = { ...attached, turnId: entityId }
export const sessionCommandSchema = z.discriminatedUnion('kind', [
  z
    .object({
      commandId: entityId,
      kind: z.literal('create'),
      agentId: entityId,
      cwd: absolutePath.optional(),
    })
    .strict(),
  z.object({ ...addressed, kind: z.literal('start') }).strict(),
  z
    .object({
      ...attached,
      kind: z.literal('send'),
      messageId: entityId,
      text: text.refine((value) => value.trim().length > 0),
    })
    .strict(),
  z
    .object({
      ...turnAddressed,
      kind: z.literal('respond'),
      requestId: entityId,
      response: interactionResponseSchema,
    })
    .strict(),
  z.object({ ...turnAddressed, kind: z.literal('cancel') }).strict(),
  z.object({ ...addressed, kind: z.literal('resume'), previousRunId: entityId }).strict(),
  z.object({ ...addressed, kind: z.literal('close'), runId: entityId.nullable() }).strict(),
])
export type SessionCommand = z.infer<typeof sessionCommandSchema>

const turnFields = { id: entityId, messageId: entityId, startedAt: z.iso.datetime() }
const completedTurnSchema = z
  .object({
    ...turnFields,
    outcome: z.enum(['completed', 'cancelled', 'failed', 'interrupted']),
    endedAt: z.iso.datetime(),
    nativeStopReason: z.string().max(1000).nullable(),
  })
  .strict()

export const sessionSnapshotSchema = z
  .object({
    id: entityId,
    agentId: entityId,
    installationId: entityId,
    engineVersion: z.string().min(1).max(100),
    mode: runtimeModeSchema,
    cwd: absolutePath,
    snapshotId: entityId,
    snapshotDigest: z.string().regex(/^[a-f0-9]{64}$/),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    cursor: sessionCursorSchema,
    status: z.enum([
      'created',
      'starting',
      'resuming',
      'ready',
      'running',
      'waiting',
      'cancelling',
      'closing',
      'interrupted',
      'failed',
      'closed',
    ]),
    // A run identifies one process attachment. A native ID is scoped to this installation/session.
    runId: entityId.nullable(),
    nativeSessionId: nativeId.nullable(),
    activeTurn: z.object(turnFields).strict().nullable(),
    lastTurn: completedTurnSchema.nullable(),
    pendingRequests: z.array(interactionRequestSchema).max(100),
    settledRequestIds: z.array(entityId).max(1000),
    failure: sessionFailureSchema.nullable(),
  })
  .strict()
  .superRefine((snapshot, context) => {
    const invalid = (path: string) =>
      context.addIssue({ code: 'custom', path: [path], message: 'validation.invalid' })
    if (snapshot.status === 'created' && (snapshot.runId !== null || snapshot.cursor !== 0))
      invalid('status')
    if (!['created', 'closing', 'closed'].includes(snapshot.status) && !snapshot.runId)
      invalid('runId')
    if (
      ['ready', 'running', 'waiting', 'cancelling', 'resuming'].includes(snapshot.status) &&
      !snapshot.nativeSessionId
    )
      invalid('nativeSessionId')
    if (['running', 'waiting', 'cancelling'].includes(snapshot.status) && !snapshot.activeTurn)
      invalid('activeTurn')
    if (
      !['running', 'waiting', 'cancelling', 'closing'].includes(snapshot.status) &&
      snapshot.activeTurn
    )
      invalid('activeTurn')
    if ((snapshot.status === 'waiting') !== snapshot.pendingRequests.length > 0)
      invalid('pendingRequests')
    const requestIds = [
      ...snapshot.pendingRequests.map((request) => request.id),
      ...snapshot.settledRequestIds,
    ]
    if (new Set(requestIds).size !== requestIds.length) invalid('pendingRequests')
  })
export type SessionSnapshot = z.infer<typeof sessionSnapshotSchema>
export type SessionStatus = SessionSnapshot['status']

const usageSchema = z
  .object({
    scope: z.enum(['turn', 'session']).optional(),
    inputTokens: z.number().int().nonnegative().nullable(),
    outputTokens: z.number().int().nonnegative().nullable(),
    cost: z
      .object({ amount: z.number().nonnegative(), currency: z.string().regex(/^[A-Z]{3}$/) })
      .strict()
      .nullable(),
  })
  .strict()

export const sessionEventDataSchema = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('run.starting') }).strict(),
    z.object({ kind: z.literal('run.resuming') }).strict(),
    z.object({ kind: z.literal('run.ready'), nativeSessionId: nativeId }).strict(),
    z.object({ kind: z.literal('turn.started'), messageId: entityId, text }).strict(),
    z
      .object({
        kind: z.literal('message.delta'),
        messageId: nativeId,
        channel: z.enum(['assistant', 'reasoning']),
        text,
      })
      .strict(),
    z
      .object({
        kind: z.literal('tool.updated'),
        toolCallId: nativeId,
        title: z.string().max(1000),
        status: z.enum(['pending', 'running', 'completed', 'failed']),
        content: text.nullable(),
        contentTruncated: z.boolean().optional(),
      })
      .strict(),
    z
      .object({ kind: z.literal('interaction.requested'), request: interactionRequestSchema })
      .strict(),
    // Response content is intentionally absent from the event journal.
    z
      .object({
        kind: z.literal('interaction.resolved'),
        requestId: entityId,
        disposition: z.enum(['answered', 'cancelled', 'expired']),
      })
      .strict(),
    z.object({ kind: z.literal('turn.cancelling') }).strict(),
    z
      .object({
        kind: z.literal('turn.finished'),
        outcome: z.enum(['completed', 'cancelled', 'failed']),
        nativeStopReason: z.string().max(1000).nullable(),
        usage: usageSchema.nullable(),
        failure: sessionFailureSchema.nullable(),
      })
      .strict(),
    z.object({ kind: z.literal('run.interrupted'), failure: sessionFailureSchema }).strict(),
    z.object({ kind: z.literal('run.failed'), failure: sessionFailureSchema }).strict(),
    z.object({ kind: z.literal('session.closing') }).strict(),
    z.object({ kind: z.literal('session.closed') }).strict(),
  ])
  .superRefine((data, context) => {
    if (data.kind === 'turn.finished' && (data.outcome === 'failed') !== (data.failure !== null))
      context.addIssue({ code: 'custom', path: ['failure'], message: 'validation.invalid' })
  })
export const sessionEventSchema = z
  .object({
    sessionId: entityId,
    cursor: sessionCursorSchema.refine((value) => value > 0),
    timestamp: z.iso.datetime(),
    runId: entityId.nullable(),
    turnId: entityId.nullable(),
    data: sessionEventDataSchema,
  })
  .strict()
export type SessionEvent = z.infer<typeof sessionEventSchema>
export type SessionEventData = SessionEvent['data']

export const sessionQuerySchema = z.object({ sessionId: entityId }).strict()
export const sessionEventQuerySchema = sessionQuerySchema
  .extend({
    afterCursor: sessionCursorSchema,
    limit: z.number().int().min(1).max(500).default(100),
  })
  .strict()
export const sessionSubscriptionSchema = sessionQuerySchema
  .extend({
    subscriptionId: entityId,
    afterCursor: sessionCursorSchema,
  })
  .strict()
export interface SessionEventPage {
  events: SessionEvent[]
  nextCursor: number
  latestCursor: number
  hasMore: boolean
}
export type SessionDelivery =
  | { kind: 'event'; subscriptionId: string; event: SessionEvent }
  | { kind: 'reset-required'; subscriptionId: string; snapshot: SessionSnapshot }

/** The preload must register its listener before invoking subscribe to avoid lost events. */
export interface SessionApi {
  command(input: SessionCommand): Promise<SessionSnapshot>
  get(input: z.infer<typeof sessionQuerySchema>): Promise<SessionSnapshot>
  list(): Promise<SessionSnapshot[]>
  readEvents(input: z.input<typeof sessionEventQuerySchema>): Promise<SessionEventPage>
  subscribe(
    input: z.infer<typeof sessionSubscriptionSchema>,
    receive: (delivery: SessionDelivery) => void,
  ): Promise<{ snapshot: SessionSnapshot; unsubscribe: () => Promise<void> }>
}

export const sessionChannels = {
  command: 'sessions:command',
  get: 'sessions:get',
  list: 'sessions:list',
  events: 'sessions:events',
  subscribe: 'sessions:subscribe',
  unsubscribe: 'sessions:unsubscribe',
  delivery: 'sessions:delivery',
} as const
