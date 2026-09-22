import type {
  SessionApi,
  SessionDelivery,
  SessionEvent,
  SessionSnapshot,
} from '../../../shared/sessions/schema'
import { applySessionEvent } from '../../../shared/sessions/state'
import { appError } from '../../../shared/errors'

export interface SessionView {
  snapshot: SessionSnapshot | null
  events: SessionEvent[]
  loading: boolean
  unavailable: boolean
  truncated: boolean
  error: unknown
}
export const emptySessionView = (): SessionView => ({
  snapshot: null,
  events: [],
  loading: true,
  unavailable: false,
  truncated: false,
  error: null,
})

/** Subscribe before reading history; recover gaps without issuing any session commands. */
export class SessionFeed {
  private view = emptySessionView()
  private disposed = false
  private syncing = false
  private needsSync = false
  private pending: SessionDelivery[] = []
  private pendingBytes = 0
  private unsubscribe?: () => Promise<void>
  private readonly maxEvents = 1000
  private readonly maxBytes = 4 * 1024 * 1024
  constructor(
    private readonly api: SessionApi,
    private readonly id: string,
    private readonly changed: (view: SessionView) => void,
  ) {}

  async start(): Promise<void> {
    try {
      const subscription = await this.api.subscribe(
        { sessionId: this.id, subscriptionId: crypto.randomUUID(), afterCursor: 0 },
        (delivery) => this.receive(delivery),
      )
      this.unsubscribe = subscription.unsubscribe
      if (this.disposed) {
        await subscription.unsubscribe()
        return
      }
      await this.sync()
    } catch (error) {
      this.fail(error)
    }
  }
  dispose(): void {
    this.disposed = true
    this.pending = []
    void this.unsubscribe?.().catch(() => {})
  }
  private emit(): void {
    if (!this.disposed) this.changed({ ...this.view, events: [...this.view.events] })
  }
  private fail(error: unknown): void {
    this.view = { ...this.view, loading: false, unavailable: true, error }
    this.emit()
  }
  private receive(delivery: SessionDelivery): void {
    if (this.disposed || this.view.unavailable) return
    if (delivery.kind === 'unavailable') {
      this.fail(appError('error.sessionStorage'))
      return
    }
    if (this.syncing || !this.view.snapshot) {
      const bytes = JSON.stringify(delivery).length * 2
      this.pendingBytes += bytes
      if (this.pending.length >= this.maxEvents || this.pendingBytes > this.maxBytes) {
        this.pending = []
        this.pendingBytes = bytes
        this.needsSync = true
      }
      this.pending.push(delivery)
      return
    }
    if (delivery.kind === 'reset-required') {
      if (delivery.snapshot.cursor > this.view.snapshot.cursor) void this.sync()
      return
    }
    const event = delivery.event
    if (event.cursor <= this.view.snapshot.cursor) return
    if (event.cursor !== this.view.snapshot.cursor + 1) {
      void this.sync()
      return
    }
    try {
      this.view = {
        ...this.view,
        snapshot: applySessionEvent(this.view.snapshot, event),
        events: [...this.view.events, event],
      }
      this.trim()
      this.emit()
    } catch (error) {
      this.fail(error)
    }
  }
  private trim(): void {
    let bytes = this.view.events.reduce((sum, event) => sum + JSON.stringify(event).length * 2, 0)
    while (this.view.events.length > this.maxEvents || bytes > this.maxBytes) {
      bytes -= JSON.stringify(this.view.events.shift()!).length * 2
      this.view.truncated = true
    }
  }
  private async sync(): Promise<void> {
    if (this.syncing) {
      this.needsSync = true
      return
    }
    this.syncing = true
    try {
      do {
        this.needsSync = false
        const snapshot = await this.api.get({ sessionId: this.id })
        const events: SessionEvent[] = []
        let cursor = Math.max(0, snapshot.cursor - this.maxEvents)
        while (cursor < snapshot.cursor && !this.disposed && !this.view.unavailable) {
          const page = await this.api.readEvents({
            sessionId: this.id,
            afterCursor: cursor,
            limit: 500,
          })
          if (page.nextCursor <= cursor) throw appError('error.sessionCursor')
          events.push(...page.events.filter((event) => event.cursor <= snapshot.cursor))
          cursor = page.nextCursor
        }
        if (this.disposed || this.view.unavailable) return
        this.view = {
          snapshot,
          events,
          loading: false,
          unavailable: false,
          truncated: snapshot.cursor > this.maxEvents,
          error: null,
        }
        this.trim()
        const buffered = this.pending.splice(0)
        this.pendingBytes = 0
        // Apply buffered deliveries synchronously; a duplicate cursor never repeats text.
        this.syncing = false
        for (const delivery of buffered) {
          if (
            delivery.kind === 'event' &&
            delivery.event.cursor > (this.view.snapshot?.cursor ?? 0) + 1
          )
            this.needsSync = true
          else if (
            delivery.kind === 'reset-required' &&
            delivery.snapshot.cursor > (this.view.snapshot?.cursor ?? 0)
          )
            this.needsSync = true
          else this.receive(delivery)
        }
        this.syncing = true
        this.emit()
      } while (this.needsSync && !this.disposed && !this.view.unavailable)
    } catch (error) {
      this.fail(error)
    } finally {
      this.syncing = false
    }
  }
}
