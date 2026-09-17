import { z } from 'zod'
import { appError } from '../../shared/errors'
import { applySessionEvent } from '../../shared/sessions/state'
import {
  sessionEventQuerySchema,
  sessionEventSchema,
  sessionSnapshotSchema,
  sessionSubscriptionSchema,
  type SessionDelivery,
  type SessionEvent,
  type SessionEventPage,
  type SessionSnapshot,
} from '../../shared/sessions/schema'

const appendSchema = sessionEventSchema.omit({ sessionId: true, cursor: true, timestamp: true })
const limitsSchema = z
  .object({
    maxEvents: z.number().int().min(1).max(100_000).default(2000),
    maxBytes: z
      .number()
      .int()
      .min(1024)
      .max(64 * 1024 * 1024)
      .default(8 * 1024 * 1024),
    maxSubscribers: z.number().int().min(1).max(1000).default(32),
  })
  .strict()
interface Subscriber {
  owner: string
  id: string
  receive: (delivery: SessionDelivery) => void
  queue: SessionDelivery[]
  bytes: number
  scheduled: boolean
}

const sizeOf = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8')

/** A bounded recent-event stream. Durable history and secret redaction belong upstream. */
export class SessionEventStream {
  private state: SessionSnapshot
  private events: { event: SessionEvent; bytes: number }[] = []
  private bytes = 0
  private subscribers = new Map<string, Subscriber>()
  private readonly limits: z.output<typeof limitsSchema>

  constructor(snapshot: SessionSnapshot, limits: z.input<typeof limitsSchema> = {}) {
    this.state = sessionSnapshotSchema.parse(snapshot)
    this.limits = limitsSchema.parse(limits)
  }

  snapshot(): SessionSnapshot {
    return structuredClone(this.state)
  }

  append(input: z.input<typeof appendSchema>, timestamp = new Date().toISOString()): SessionEvent {
    const event = sessionEventSchema.parse({
      ...appendSchema.parse(input),
      sessionId: this.state.id,
      cursor: this.state.cursor + 1,
      timestamp,
    })
    const bytes = sizeOf(event)
    if (bytes > this.limits.maxBytes) throw appError('error.sessionOverflow')
    const next = applySessionEvent(this.state, event)
    if (sizeOf(next) > 4 * 1024 * 1024) throw appError('error.sessionOverflow')
    this.state = next
    this.events.push({ event, bytes })
    this.bytes += bytes
    while (this.events.length > this.limits.maxEvents || this.bytes > this.limits.maxBytes) {
      this.bytes -= this.events.shift()!.bytes
    }
    for (const subscriber of this.subscribers.values()) {
      this.enqueue(subscriber, { kind: 'event', subscriptionId: subscriber.id, event })
    }
    return structuredClone(event)
  }

  read(input: z.input<typeof sessionEventQuerySchema>): SessionEventPage {
    const query = sessionEventQuerySchema.parse(input)
    if (query.sessionId !== this.state.id) throw appError('error.sessionStale')
    this.checkCursor(query.afterCursor)
    const events = this.events
      .filter(({ event }) => event.cursor > query.afterCursor)
      .slice(0, query.limit)
      .map(({ event }) => structuredClone(event))
    const nextCursor = events.at(-1)?.cursor ?? query.afterCursor
    return {
      events,
      nextCursor,
      latestCursor: this.state.cursor,
      hasMore: nextCursor < this.state.cursor,
    }
  }

  /** Owner is a trusted frame identity supplied by IPC, never a renderer-supplied argument. */
  subscribe(
    owner: string,
    input: z.infer<typeof sessionSubscriptionSchema>,
    receive: Subscriber['receive'],
  ): { snapshot: SessionSnapshot; unsubscribe: () => void } {
    const query = sessionSubscriptionSchema.parse(input)
    if (query.sessionId !== this.state.id) throw appError('error.sessionStale')
    if (query.afterCursor > this.state.cursor) throw appError('error.sessionCursor')
    const key = JSON.stringify([owner, query.subscriptionId])
    if (this.subscribers.has(key)) throw appError('error.sessionStale')
    if (this.subscribers.size >= this.limits.maxSubscribers) throw appError('error.sessionOverflow')
    const subscriber: Subscriber = {
      owner,
      id: query.subscriptionId,
      receive,
      queue: [],
      bytes: 0,
      scheduled: false,
    }
    // Register and capture replay without yielding: an append cannot fall between them.
    this.subscribers.set(key, subscriber)
    if (this.isExpired(query.afterCursor)) {
      this.enqueue(subscriber, {
        kind: 'reset-required',
        subscriptionId: subscriber.id,
        snapshot: this.snapshot(),
      })
    } else {
      for (const { event } of this.events) {
        if (event.cursor > query.afterCursor)
          this.enqueue(subscriber, { kind: 'event', subscriptionId: subscriber.id, event })
      }
    }
    return {
      snapshot: this.snapshot(),
      unsubscribe: () => this.unsubscribe(owner, query.subscriptionId),
    }
  }

  unsubscribe(owner: string, subscriptionId: string): void {
    this.subscribers.delete(JSON.stringify([owner, subscriptionId]))
  }

  removeOwner(owner: string): void {
    for (const [key, subscriber] of this.subscribers) {
      if (subscriber.owner === owner) this.subscribers.delete(key)
    }
  }

  private isExpired(afterCursor: number): boolean {
    return afterCursor < (this.events[0]?.event.cursor ?? this.state.cursor + 1) - 1
  }

  private checkCursor(afterCursor: number): void {
    if (afterCursor > this.state.cursor || this.isExpired(afterCursor))
      throw appError('error.sessionCursor')
  }

  private enqueue(subscriber: Subscriber, delivery: SessionDelivery): void {
    if (
      subscriber.queue[0]?.kind === 'reset-required' ||
      subscriber.queue.length >= this.limits.maxEvents ||
      subscriber.bytes + sizeOf(delivery) > this.limits.maxBytes
    ) {
      // A slow renderer gets an explicit gap, never a silent truncated transcript.
      subscriber.queue = [
        { kind: 'reset-required', subscriptionId: subscriber.id, snapshot: this.snapshot() },
      ]
      subscriber.bytes = sizeOf(subscriber.queue[0])
    } else {
      subscriber.queue.push(delivery)
      subscriber.bytes += sizeOf(delivery)
    }
    if (subscriber.scheduled) return
    subscriber.scheduled = true
    setImmediate(() => this.drain(subscriber))
  }

  private drain(subscriber: Subscriber): void {
    subscriber.scheduled = false
    const key = JSON.stringify([subscriber.owner, subscriber.id])
    if (this.subscribers.get(key) !== subscriber) return
    const deliveries = subscriber.queue
    subscriber.queue = []
    subscriber.bytes = 0
    for (const delivery of deliveries) {
      if (this.subscribers.get(key) !== subscriber) return
      try {
        subscriber.receive(structuredClone(delivery))
      } catch {
        this.subscribers.delete(key)
        return
      }
    }
  }
}
