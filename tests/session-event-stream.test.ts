import { describe, expect, it } from 'vitest'
import { SessionEventStream } from '../src/main/sessions/event-stream'
import { createSessionSnapshot } from '../src/shared/sessions/state'
import type { SessionDelivery } from '../src/shared/sessions/schema'

function streamFixture(limits = {}) {
  return new SessionEventStream(
    createSessionSnapshot({
      id: 's',
      agentId: 'a',
      installationId: 'i',
      engineVersion: '1',
      mode: 'pi-rpc',
      cwd: '/project',
      snapshotId: 'snapshot',
      snapshotDigest: 'b'.repeat(64),
      createdAt: '2026-09-18T00:00:00Z',
    }),
    limits,
  )
}
function start(stream: SessionEventStream) {
  stream.append({ runId: 'run', turnId: null, data: { kind: 'run.starting' } })
  stream.append({
    runId: 'run',
    turnId: null,
    data: { kind: 'run.ready', nativeSessionId: 'native' },
  })
  stream.append({
    runId: 'run',
    turnId: 'turn',
    data: { kind: 'turn.started', messageId: 'user', text: 'Hello' },
  })
}
function chunk(stream: SessionEventStream, text = 'Hello') {
  return stream.append({
    runId: 'run',
    turnId: 'turn',
    data: { kind: 'message.delta', messageId: 'assistant', channel: 'assistant', text },
  })
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

describe('bounded session event stream', () => {
  it('delivers replay and live events in cursor order across a subscription boundary', async () => {
    const stream = streamFixture()
    start(stream)
    const deliveries: SessionDelivery[] = []
    const subscription = stream.subscribe(
      'frame-a',
      { sessionId: 's', subscriptionId: 'sub', afterCursor: 1 },
      (delivery) => deliveries.push(delivery),
    )
    chunk(stream)
    expect(subscription.snapshot.cursor).toBe(3)
    await flush()
    expect(
      deliveries.map((delivery) => (delivery.kind === 'event' ? delivery.event.cursor : 'gap')),
    ).toEqual([2, 3, 4])
    subscription.unsubscribe()
    chunk(stream)
    await flush()
    expect(deliveries).toHaveLength(3)
  })

  it('requires explicit resynchronization when a cursor expires or a subscriber falls behind', async () => {
    const stream = streamFixture({ maxEvents: 2 })
    start(stream)
    expect(() => stream.read({ sessionId: 's', afterCursor: 0 })).toThrow('sessionCursor')
    const deliveries: SessionDelivery[] = []
    stream.subscribe(
      'frame',
      { sessionId: 's', subscriptionId: 'sub', afterCursor: 0 },
      (delivery) => deliveries.push(delivery),
    )
    chunk(stream)
    await flush()
    expect(deliveries).toMatchObject([{ kind: 'reset-required', snapshot: { cursor: 4 } }])
    chunk(stream)
    chunk(stream)
    chunk(stream)
    await flush()
    expect(deliveries[1]).toMatchObject({ kind: 'reset-required', snapshot: { cursor: 7 } })
  })

  it('paginates retained events and rejects foreign or future cursors without changing state', () => {
    const stream = streamFixture()
    start(stream)
    const page = stream.read({ sessionId: 's', afterCursor: 0, limit: 2 })
    expect(page).toMatchObject({ nextCursor: 2, latestCursor: 3, hasMore: true })
    expect(stream.read({ sessionId: 's', afterCursor: page.nextCursor })).toMatchObject({
      nextCursor: 3,
      hasMore: false,
    })
    expect(() => stream.read({ sessionId: 's', afterCursor: 4 })).toThrow('sessionCursor')
    expect(() => stream.read({ sessionId: 'other', afterCursor: 0 })).toThrow('sessionStale')
    expect(stream.snapshot().cursor).toBe(3)
  })

  it('isolates subscribers and prevents one frame from cancelling another frame subscription', async () => {
    const stream = streamFixture()
    const a: SessionDelivery[] = []
    const b: SessionDelivery[] = []
    stream.subscribe(
      'a',
      { sessionId: 's', subscriptionId: 'same-id', afterCursor: 0 },
      (delivery) => {
        a.push(delivery)
        if (delivery.kind === 'event') delivery.event.cursor = 999
      },
    )
    stream.subscribe(
      'b',
      { sessionId: 's', subscriptionId: 'same-id', afterCursor: 0 },
      (delivery) => b.push(delivery),
    )
    stream.unsubscribe('foreign', 'same-id')
    start(stream)
    await flush()
    expect(a).toHaveLength(3)
    expect(b.map((delivery) => (delivery.kind === 'event' ? delivery.event.cursor : null))).toEqual(
      [1, 2, 3],
    )
    expect(stream.read({ sessionId: 's', afterCursor: 0 }).events[0]?.cursor).toBe(1)
    stream.removeOwner('a')
    chunk(stream)
    await flush()
    expect(a).toHaveLength(3)
    expect(b).toHaveLength(4)
  })

  it('does not corrupt projection or delivery on oversized or invalid events and drops broken listeners', async () => {
    const stream = streamFixture({ maxBytes: 1024 })
    start(stream)
    stream.subscribe('broken', { sessionId: 's', subscriptionId: 'sub', afterCursor: 3 }, () => {
      throw new Error('closed renderer')
    })
    expect(() => chunk(stream, '中'.repeat(1000))).toThrow('sessionOverflow')
    expect(stream.snapshot().cursor).toBe(3)
    expect(() =>
      stream.append({ runId: 'old-run', turnId: 'turn', data: { kind: 'turn.cancelling' } }),
    ).toThrow('sessionStale')
    chunk(stream)
    await flush()
    expect(() =>
      stream.subscribe(
        'broken',
        { sessionId: 's', subscriptionId: 'sub', afterCursor: 4 },
        () => undefined,
      ),
    ).not.toThrow()
  })

  it('cancels queued delivery on owner teardown and bounds the number of subscriptions', async () => {
    const stream = streamFixture({ maxSubscribers: 1 })
    const deliveries: SessionDelivery[] = []
    stream.subscribe(
      'frame',
      { sessionId: 's', subscriptionId: 'sub', afterCursor: 0 },
      (delivery) => deliveries.push(delivery),
    )
    expect(() =>
      stream.subscribe(
        'other',
        { sessionId: 's', subscriptionId: 'sub', afterCursor: 0 },
        () => undefined,
      ),
    ).toThrow('sessionOverflow')
    start(stream)
    stream.removeOwner('frame')
    await flush()
    expect(deliveries).toEqual([])
  })
})
