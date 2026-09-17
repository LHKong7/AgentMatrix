import { describe, expect, it, vi } from 'vitest'
import { SessionFeed, type SessionView } from '../src/renderer/src/lib/session-feed'
import { SessionEventStream } from '../src/main/sessions/event-stream'
import { createSessionSnapshot } from '../src/shared/sessions/state'
import type { SessionApi, SessionDelivery, SessionEvent } from '../src/shared/sessions/schema'

function fixture() {
  const stream = new SessionEventStream(
    createSessionSnapshot({
      id: 's',
      agentId: 'a',
      installationId: 'i',
      engineVersion: '1',
      mode: 'acp',
      cwd: '/project',
      snapshotId: 'input',
      snapshotDigest: '0'.repeat(64),
      createdAt: new Date().toISOString(),
    }),
  )
  const events: SessionEvent[] = []
  events.push(stream.append({ runId: 'r', turnId: null, data: { kind: 'run.starting' } }))
  events.push(
    stream.append({
      runId: 'r',
      turnId: null,
      data: { kind: 'run.ready', nativeSessionId: 'native' },
    }),
  )
  events.push(
    stream.append({
      runId: 'r',
      turnId: 't',
      data: { kind: 'turn.started', messageId: 'user', text: 'question' },
    }),
  )
  let listener: (delivery: SessionDelivery) => void = () => {}
  const unsubscribe = vi.fn(async () => {})
  const api = {
    configuration: vi.fn(),
    command: vi.fn(),
    list: vi.fn(),
    get: vi.fn(async () => stream.snapshot()),
    subscribe: vi.fn<SessionApi['subscribe']>(async (_input, receive) => {
      listener = receive
      return { snapshot: stream.snapshot(), unsubscribe }
    }),
    readEvents: vi.fn<SessionApi['readEvents']>(async (query) => {
      const page = events
        .filter((event) => event.cursor > query.afterCursor)
        .slice(0, query.limit ?? 100)
      const nextCursor = page.at(-1)?.cursor ?? query.afterCursor
      return {
        events: page,
        nextCursor,
        latestCursor: stream.snapshot().cursor,
        hasMore: nextCursor < stream.snapshot().cursor,
      }
    }),
  } satisfies SessionApi
  const views: SessionView[] = []
  const feed = new SessionFeed(api, 's', (view) => views.push(view))
  const delta = (text: string, deliver = true) => {
    const event = stream.append({
      runId: 'r',
      turnId: 't',
      data: { kind: 'message.delta', messageId: 'assistant', channel: 'assistant', text },
    })
    events.push(event)
    if (deliver) listener({ kind: 'event', subscriptionId: 'view', event })
    return event
  }
  return {
    api,
    feed,
    views,
    delta,
    events,
    unsubscribe,
    stream,
    deliver: (delivery: SessionDelivery) => listener(delivery),
  }
}
describe('renderer session reattachment', () => {
  it('joins history and concurrent live output without duplicate text or commands', async () => {
    const f = fixture()
    let release!: () => void
    const wait = new Promise<void>((resolve) => {
      release = resolve
    })
    const read = f.api.readEvents.getMockImplementation()!
    f.api.readEvents.mockImplementationOnce(async (query) => {
      await wait
      return read(query)
    })
    const starting = f.feed.start()
    await vi.waitFor(() => expect(f.api.readEvents).toHaveBeenCalled())
    const event = f.delta('once')
    f.deliver({ kind: 'event', subscriptionId: 'view', event })
    release()
    await starting
    expect(f.views.at(-1)?.events.filter((item) => item.cursor === event.cursor)).toHaveLength(1)
    expect(f.views.at(-1)?.snapshot?.cursor).toBe(event.cursor)
    expect(f.api.command).not.toHaveBeenCalled()
    f.feed.dispose()
    expect(f.unsubscribe).toHaveBeenCalledOnce()
  })
  it('recovers a delivery gap from durable history without resubmitting the turn', async () => {
    const f = fixture()
    await f.feed.start()
    f.delta('missed', false)
    const last = f.delta('later')
    await vi.waitFor(() => expect(f.views.at(-1)?.snapshot?.cursor).toBe(last.cursor))
    expect(f.views.at(-1)?.events).toEqual(f.events)
    expect(f.api.command).not.toHaveBeenCalled()
    f.feed.dispose()
  })
  it('bounds the transcript and labels omitted history while retaining current state', async () => {
    const f = fixture()
    for (let index = 0; index < 1100; index++) f.delta('text', false)
    await f.feed.start()
    expect(f.views.at(-1)).toMatchObject({ truncated: true, loading: false, unavailable: false })
    expect(f.views.at(-1)?.events).toHaveLength(1000)
    expect(f.api.readEvents.mock.calls[0]![0].afterCursor).toBe(103)
    f.feed.dispose()
  })
  it('disables controls on storage loss and unsubscribes even when disposed before registration finishes', async () => {
    const f = fixture()
    await f.feed.start()
    f.deliver({
      kind: 'unavailable',
      subscriptionId: 'view',
      failure: { code: 'storage', detail: '' },
    })
    const cursor = f.views.at(-1)?.snapshot?.cursor
    f.delta('not trusted')
    expect(f.views.at(-1)).toMatchObject({ unavailable: true, snapshot: { cursor } })
    f.feed.dispose()
    const late = fixture()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    late.api.subscribe.mockImplementationOnce(async () => {
      await gate
      return { snapshot: late.stream.snapshot(), unsubscribe: late.unsubscribe }
    })
    const pending = late.feed.start()
    late.feed.dispose()
    release()
    await pending
    expect(late.unsubscribe).toHaveBeenCalledOnce()
    expect(late.views).toHaveLength(0)
  })
})
