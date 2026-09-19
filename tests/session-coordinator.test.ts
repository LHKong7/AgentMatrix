import { mkdtemp, readFile, rm, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionCoordinator, type SessionRuntimeFactory } from '../src/main/sessions/coordinator'
import { SessionJournal } from '../src/main/sessions/journal'
import {
  RuntimeFailure,
  type RuntimeSession,
  type RuntimeTurnHandlers,
  type RuntimeTurnResult,
} from '../src/main/engines/runtime'
import type { ProcessResult } from '../src/main/engines/process/managed-process'
import { redactText } from '../src/main/engines/process/redacted-tail'
import type {
  SessionSnapshot,
  SessionDelivery,
  SessionCommand,
  InteractionRequest,
  InteractionResponse,
} from '../src/shared/sessions/schema'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
const result: ProcessResult = {
  code: 0,
  signal: null,
  forced: false,
  outputTruncated: false,
  failure: null,
  stderr: '',
  cleanup: 'posix-process-group',
}
class FakeRuntime implements RuntimeSession {
  readonly ended = deferred<ProcessResult>()
  readonly closed = this.ended.promise
  readonly turns: {
    text: string
    handlers: RuntimeTurnHandlers
    signal: AbortController
    done: ReturnType<typeof deferred<RuntimeTurnResult>>
  }[] = []
  autoCancel = true
  constructor(readonly nativeSessionId: string) {}
  redact(text: string) {
    return redactText(text, ['synthetic-secret'])
  }
  send(text: string, handlers: RuntimeTurnHandlers): Promise<RuntimeTurnResult> {
    const turn = {
      text,
      handlers,
      signal: new AbortController(),
      done: deferred<RuntimeTurnResult>(),
    }
    this.turns.push(turn)
    return Promise.race([
      turn.done.promise,
      this.closed.then(() => {
        throw new RuntimeFailure('process-exit')
      }),
    ]).finally(() => turn.signal.abort())
  }
  finish(outcome: 'completed' | 'cancelled' = 'completed') {
    this.turns.at(-1)!.done.resolve({
      outcome,
      nativeStopReason: outcome === 'cancelled' ? 'cancelled' : 'end_turn',
      usage: null,
    })
  }
  cancel = vi.fn(async () => {
    if (this.autoCancel) this.finish('cancelled')
  })
  dispose = vi.fn(async () => {
    this.ended.resolve(result)
    return result
  })
  ask(deadlineAt: string | null = null) {
    const turn = this.turns.at(-1)!
    return turn.handlers
      .interaction(
        {
          kind: 'permission',
          id: 'approval',
          title: 'Read file',
          toolCallId: 'tool',
          deadlineAt,
          options: [
            { id: 'yes', label: 'Allow once', kind: 'allow_once' },
            { id: 'no', label: 'Reject once', kind: 'reject_once' },
          ],
        },
        turn.signal.signal,
      )
      .then((answer) => (answer.kind === 'choice' ? answer.optionId : null))
  }
}
const roots: string[] = []
const coordinators: SessionCoordinator[] = []
const runtimes: FakeRuntime[] = []
async function fixture(cancelTimeoutMs = 100) {
  const root = await mkdtemp(join(tmpdir(), 'agentmatrix-coordinator-'))
  roots.push(root)
  const journal = new SessionJournal(root)
  const connections: { snapshot: SessionSnapshot; signal: AbortSignal; runtime: FakeRuntime }[] = []
  const create = vi.fn<SessionRuntimeFactory['create']>(async (sessionId, command) => ({
    agentId: command.agentId,
    installationId: 'installed',
    engineVersion: '1',
    mode: 'acp',
    cwd: command.cwd ?? '/project',
    snapshotId: sessionId,
    snapshotDigest: 'a'.repeat(64),
  }))
  const connect = vi.fn<SessionRuntimeFactory['connect']>(async (snapshot, signal) => {
    const runtime = new FakeRuntime(snapshot.nativeSessionId ?? `native-${connections.length}`)
    runtimes.push(runtime)
    connections.push({ snapshot, signal, runtime })
    return runtime
  })
  const factory = {
    create,
    connect,
    removeSnapshot: vi.fn<NonNullable<SessionRuntimeFactory['removeSnapshot']>>(async () => {}),
  }
  const coordinator = new SessionCoordinator(journal, factory, { cancelTimeoutMs })
  coordinators.push(coordinator)
  const wait = async (id: string, status: SessionSnapshot['status']) => {
    await vi.waitFor(async () =>
      expect((await coordinator.get({ sessionId: id })).status).toBe(status),
    )
    return coordinator.get({ sessionId: id })
  }
  const start = async (commandId = 'create') => {
    const initial = await coordinator.command({ kind: 'create', commandId, agentId: 'profile' })
    await coordinator.command({ kind: 'start', commandId: 'start', sessionId: initial.id })
    const ready = await wait(initial.id, 'ready')
    return { ready, runtime: connections.at(-1)!.runtime }
  }
  const send = (state: SessionSnapshot, commandId = 'send') =>
    coordinator.command({
      kind: 'send',
      commandId,
      sessionId: state.id,
      runId: state.runId!,
      messageId: `message-${commandId}`,
      text: 'Read the project',
    })
  return { root, journal, factory, coordinator, wait, start, send, connections }
}
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) runtime.ended.resolve(result)
  await Promise.allSettled(coordinators.splice(0).map((coordinator) => coordinator.shutdown()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('durable session coordination', () => {
  it('journals safe configuration diagnostics, preserves them after restart, and clears them on successful resume', async () => {
    const f = await fixture()
    const { ready, runtime } = await f.start()
    runtime.ended.resolve(result)
    await f.wait(ready.id, 'interrupted')
    const diagnostic = {
      check: 'opencode-config' as const,
      reason: 'mismatch' as const,
      fields: ['prompts' as const],
    }
    f.factory.connect.mockRejectedValueOnce(
      new RuntimeFailure('configuration', 'PRIVATE_NATIVE_DETAIL', diagnostic),
    )
    await f.coordinator.command({
      kind: 'resume',
      commandId: 'rejected',
      sessionId: ready.id,
      previousRunId: ready.runId!,
    })
    const failed = await f.wait(ready.id, 'failed')
    expect(failed.failure).toEqual({ code: 'configuration', detail: '', configuration: diagnostic })
    expect(failed.nativeSessionId).toBe(ready.nativeSessionId)
    expect(failed.snapshotDigest).toBe(ready.snapshotDigest)
    await f.coordinator.shutdown()
    const restarted = new SessionCoordinator(new SessionJournal(f.root), f.factory)
    coordinators.push(restarted)
    expect((await restarted.get({ sessionId: ready.id })).failure).toEqual(failed.failure)
    await restarted.command({
      kind: 'resume',
      commandId: 'retry',
      sessionId: ready.id,
      previousRunId: failed.runId!,
    })
    await vi.waitFor(async () =>
      expect((await restarted.get({ sessionId: ready.id })).status).toBe('ready'),
    )
    expect((await restarted.get({ sessionId: ready.id })).failure).toBeNull()
    const persisted = await readFile(join(f.root, `${ready.id}.jsonl`), 'utf8')
    expect(persisted).toContain('opencode-config')
    expect(persisted).not.toContain('PRIVATE_NATIVE_DETAIL')
  })

  it('drops invalid diagnostic payloads rather than persisting native values', async () => {
    const f = await fixture()
    const error = new RuntimeFailure('configuration', 'PRIVATE_FIELD')
    Object.assign(error, {
      diagnostic: {
        check: 'opencode-config',
        reason: 'mismatch',
        fields: ['prompts'],
        actual: 'PRIVATE_VALUE',
      },
    })
    f.factory.connect.mockRejectedValueOnce(error)
    const initial = await f.coordinator.command({
      kind: 'create',
      commandId: 'create',
      agentId: 'profile',
    })
    await f.coordinator.command({ kind: 'start', commandId: 'start', sessionId: initial.id })
    expect((await f.wait(initial.id, 'failed')).failure).toEqual({
      code: 'configuration',
      detail: '',
    })
    expect(await readFile(join(f.root, `${initial.id}.jsonl`), 'utf8')).not.toContain('PRIVATE')
  })
  it.each([
    [
      { kind: 'select', options: [{ id: 'selected', label: 'Choose' }] },
      { kind: 'choice', optionId: 'selected' },
    ],
    [
      { kind: 'confirm', message: 'Continue?' },
      { kind: 'confirm', accepted: false },
    ],
    [
      {
        kind: 'input',
        message: 'Edit',
        placeholder: '',
        multiline: true,
        initialValue: 'original',
      },
      { kind: 'input', value: 'private response text' },
    ],
  ] as const)(
    'delivers a typed $0.kind answer only after recording its resolution',
    async (shape, response) => {
      const f = await fixture()
      const { ready, runtime } = await f.start()
      const running = await f.send(ready)
      const request: InteractionRequest = {
        id: 'dialog',
        title: 'Extension request',
        deadlineAt: null,
        ...structuredClone(shape),
      } as InteractionRequest
      let received: InteractionResponse | undefined
      const answer = runtime.turns[0]!.handlers.interaction(
        request,
        runtime.turns[0]!.signal.signal,
      ).then((value) => {
        received = value
      })
      await f.wait(ready.id, 'waiting')
      const append = f.journal.append.bind(f.journal)
      vi.spyOn(f.journal, 'append').mockImplementation(async (...args) => {
        if (args[2].data.kind === 'interaction.resolved') expect(received).toBeUndefined()
        return append(...args)
      })
      await f.coordinator.command({
        kind: 'respond',
        commandId: 'answer',
        sessionId: ready.id,
        runId: ready.runId!,
        turnId: running.activeTurn!.id,
        requestId: request.id,
        response,
      })
      await answer
      expect(received).toEqual(response)
      expect(await readFile(join(f.root, `${ready.id}.jsonl`), 'utf8')).not.toContain(
        'private response text',
      )
    },
  )
  it('keeps sessions independent while permissions wait and shuts all attachments down', async () => {
    const f = await fixture()
    const first = await f.start('first'),
      second = await f.start('second')
    const a = await f.send(first.ready),
      b = await f.send(second.ready)
    const permissionA = first.runtime.ask(),
      permissionB = second.runtime.ask()
    await f.wait(a.id, 'waiting')
    await f.wait(b.id, 'waiting')
    await expect(
      f.coordinator.command({
        kind: 'respond',
        commandId: 'foreign',
        sessionId: b.id,
        runId: a.runId!,
        turnId: a.activeTurn!.id,
        requestId: 'approval',
        response: { kind: 'choice', optionId: 'yes' },
      }),
    ).rejects.toThrow('sessionStale')
    await f.coordinator.command({
      kind: 'respond',
      commandId: 'answer-a',
      sessionId: a.id,
      runId: a.runId!,
      turnId: a.activeTurn!.id,
      requestId: 'approval',
      response: { kind: 'choice', optionId: 'yes' },
    })
    expect(await permissionA).toBe('yes')
    expect((await f.coordinator.get({ sessionId: b.id })).status).toBe('waiting')
    await f.coordinator.shutdown()
    expect(await permissionB).toBeNull()
    for (const session of [a, b])
      expect((await f.coordinator.get({ sessionId: session.id })).status).toBe('interrupted')
    expect(first.runtime.dispose).toHaveBeenCalledOnce()
    expect(second.runtime.dispose).toHaveBeenCalledOnce()
  })

  it('records connection failures and rejects a replacement native identity on resume', async () => {
    const f = await fixture()
    f.factory.connect.mockRejectedValueOnce(new RuntimeFailure('unsupported'))
    const initial = await f.coordinator.command({
      kind: 'create',
      commandId: 'bad-create',
      agentId: 'profile',
    })
    await f.coordinator.command({ kind: 'start', commandId: 'start', sessionId: initial.id })
    expect((await f.wait(initial.id, 'failed')).failure?.code).toBe('unsupported')
    const { ready, runtime } = await f.start('good-create')
    runtime.ended.resolve(result)
    await f.wait(ready.id, 'interrupted')
    const wrong = new FakeRuntime('unexpected-new-conversation')
    runtimes.push(wrong)
    f.factory.connect.mockResolvedValueOnce(wrong)
    await f.coordinator.command({
      kind: 'resume',
      commandId: 'resume',
      sessionId: ready.id,
      previousRunId: ready.runId!,
    })
    const failed = await f.wait(ready.id, 'failed')
    expect(failed).toMatchObject({
      failure: { code: 'protocol' },
      nativeSessionId: ready.nativeSessionId,
    })
    expect(wrong.dispose).toHaveBeenCalledOnce()
  })

  it('stops an active runtime when a query discovers externally changed history', async () => {
    const f = await fixture()
    const { ready, runtime } = await f.start()
    await appendFile(join(f.root, `${ready.id}.jsonl`), 'foreign edit')
    await expect(f.coordinator.get({ sessionId: ready.id })).rejects.toThrow('sessionStorage')
    await vi.waitFor(() => expect(runtime.dispose).toHaveBeenCalledOnce())
    expect(
      (await readFile(join(f.root, `${ready.id}.jsonl`), 'utf8')).endsWith('foreign edit'),
    ).toBe(true)
  })

  it('deduplicates concurrent create/start/send commands and rejects reused IDs with changed data', async () => {
    const f = await fixture()
    const create = { kind: 'create', commandId: 'create', agentId: 'profile' } as const
    const [a, b] = await Promise.all([f.coordinator.command(create), f.coordinator.command(create)])
    expect(a).toEqual(b)
    expect(f.factory.create).toHaveBeenCalledTimes(1)
    await expect(f.coordinator.command({ ...create, cwd: '/other' })).rejects.toThrow(
      'sessionCommandConflict',
    )
    const start = { kind: 'start', commandId: 'start', sessionId: a.id } as const
    await Promise.all([f.coordinator.command(start), f.coordinator.command(start)])
    const ready = await f.wait(a.id, 'ready')
    expect(f.factory.connect).toHaveBeenCalledTimes(1)
    const send: SessionCommand = {
      kind: 'send',
      commandId: 'send',
      sessionId: a.id,
      runId: ready.runId!,
      messageId: 'message',
      text: 'Use synthetic-secret privately',
    }
    await Promise.all([f.coordinator.command(send), f.coordinator.command(send)])
    const runtime = f.connections[0]!.runtime
    expect(runtime.turns).toHaveLength(1)
    expect(runtime.turns[0]!.text).toBe(send.text)
    expect(await readFile(join(f.root, `${a.id}.jsonl`), 'utf8')).not.toContain('synthetic-secret')
    const history = await f.coordinator.readEvents({ sessionId: a.id, afterCursor: 0 })
    expect(history.events.at(-1)?.data).toMatchObject({ text: 'Use [redacted] privately' })
    await expect(f.coordinator.command({ ...send, text: 'different' })).rejects.toThrow(
      'sessionCommandConflict',
    )
    await expect(f.send(ready, 'concurrent-send')).rejects.toThrow('sessionState')
    runtime.finish()
    await f.wait(a.id, 'ready')
    await f.coordinator.command(send)
    expect(runtime.turns).toHaveLength(1)
  })

  it('does not grant a permission until its receipt and resolution are durable', async () => {
    const f = await fixture()
    const { ready, runtime } = await f.start()
    const running = await f.send(ready)
    let answer: string | null | undefined
    const permission = runtime.ask().then((value) => {
      answer = value
    })
    await f.wait(ready.id, 'waiting')
    const entered = deferred<void>(),
      release = deferred<void>()
    const append = f.journal.append.bind(f.journal)
    vi.spyOn(f.journal, 'append').mockImplementation(async (...args) => {
      if (args[2].data.kind === 'interaction.resolved') {
        entered.resolve()
        await release.promise
      }
      return append(...args)
    })
    const respond: SessionCommand = {
      kind: 'respond',
      commandId: 'approve',
      sessionId: ready.id,
      runId: ready.runId!,
      turnId: running.activeTurn!.id,
      requestId: 'approval',
      response: { kind: 'choice', optionId: 'yes' },
    }
    const pending = f.coordinator.command(respond)
    await entered.promise
    expect(answer).toBeUndefined()
    release.resolve()
    await pending
    await permission
    expect(answer).toBe('yes')
    expect(await f.journal.receipt(ready.id, 'approve')).toMatchObject({ id: 'approve' })
    await f.coordinator.command(respond)
    const events = (await f.coordinator.readEvents({ sessionId: ready.id, afterCursor: 0 })).events
    expect(events.filter((event) => event.data.kind === 'interaction.resolved')).toHaveLength(1)
    expect(JSON.stringify(events)).not.toContain('optionId')
  })

  it('cancels pending controls immediately and uses the native terminal result', async () => {
    const f = await fixture()
    const { ready, runtime } = await f.start()
    const running = await f.send(ready)
    const permission = runtime.ask()
    await f.wait(ready.id, 'waiting')
    const cancel: SessionCommand = {
      kind: 'cancel',
      commandId: 'cancel',
      sessionId: ready.id,
      runId: ready.runId!,
      turnId: running.activeTurn!.id,
    }
    expect((await f.coordinator.command(cancel)).status).toBe('cancelling')
    expect(await permission).toBeNull()
    expect((await f.wait(ready.id, 'ready')).lastTurn?.outcome).toBe('cancelled')
    await f.coordinator.command(cancel)
    expect(runtime.cancel).toHaveBeenCalledTimes(1)
    await expect(
      f.coordinator.command({
        kind: 'respond',
        commandId: 'late',
        sessionId: ready.id,
        runId: ready.runId!,
        turnId: running.activeTurn!.id,
        requestId: 'approval',
        response: { kind: 'choice', optionId: 'yes' },
      }),
    ).rejects.toThrow('sessionStale')
  })

  it('interrupts an unacknowledged cancellation only after disposing the process', async () => {
    const f = await fixture(25)
    const { ready, runtime } = await f.start()
    runtime.autoCancel = false
    const running = await f.send(ready)
    await f.coordinator.command({
      kind: 'cancel',
      commandId: 'cancel',
      sessionId: ready.id,
      runId: ready.runId!,
      turnId: running.activeTurn!.id,
    })
    const interrupted = await f.wait(ready.id, 'interrupted')
    expect(runtime.dispose).toHaveBeenCalledTimes(1)
    expect(interrupted).toMatchObject({
      failure: { code: 'timeout' },
      lastTurn: { outcome: 'interrupted' },
      nativeSessionId: runtime.nativeSessionId,
    })
  })

  it('closes a late connection without publishing ready and waits for cleanup before closed', async () => {
    const f = await fixture()
    const connected = deferred<RuntimeSession>(),
      cleanup = deferred<void>()
    const runtime = new FakeRuntime('late-native')
    runtimes.push(runtime)
    runtime.dispose.mockImplementation(async () => {
      await cleanup.promise
      runtime.ended.resolve(result)
      return result
    })
    f.factory.connect.mockImplementation(async () => connected.promise)
    const created = await f.coordinator.command({
      kind: 'create',
      commandId: 'create',
      agentId: 'profile',
    })
    const starting = await f.coordinator.command({
      kind: 'start',
      commandId: 'start',
      sessionId: created.id,
    })
    const closing = await f.coordinator.command({
      kind: 'close',
      commandId: 'close',
      sessionId: created.id,
      runId: starting.runId,
    })
    expect(closing.status).toBe('closing')
    connected.resolve(runtime)
    await vi.waitFor(() => expect(runtime.dispose).toHaveBeenCalledOnce())
    expect((await f.coordinator.get({ sessionId: created.id })).status).toBe('closing')
    await expect(
      f.coordinator.remove({ sessionId: created.id, expectedCursor: closing.cursor }),
    ).rejects.toThrow('sessionState')
    expect(f.factory.removeSnapshot).not.toHaveBeenCalled()
    cleanup.resolve()
    await f.wait(created.id, 'closed')
    expect(
      (await f.coordinator.readEvents({ sessionId: created.id, afterCursor: 0 })).events.some(
        (event) => event.data.kind === 'run.ready',
      ),
    ).toBe(false)
    const closed = await f.coordinator.get({ sessionId: created.id })
    await f.coordinator.remove({ sessionId: created.id, expectedCursor: closed.cursor })
    expect(f.factory.removeSnapshot).toHaveBeenCalledExactlyOnceWith(created.snapshotId)
  })

  it('keeps failed cleanup from claiming closed or opening a second attachment', async () => {
    const f = await fixture()
    const { ready, runtime } = await f.start()
    runtime.dispose.mockRejectedValueOnce(new Error('cleanup incomplete'))
    await f.coordinator.command({
      kind: 'close',
      commandId: 'close',
      sessionId: ready.id,
      runId: ready.runId,
    })
    await f.wait(ready.id, 'failed')
    await expect(
      f.coordinator.remove({ sessionId: ready.id, expectedCursor: ready.cursor }),
    ).rejects.toThrow('sessionState')
    expect(f.factory.removeSnapshot).not.toHaveBeenCalled()
    await expect(
      f.coordinator.command({
        kind: 'resume',
        commandId: 'resume',
        sessionId: ready.id,
        previousRunId: ready.runId!,
      }),
    ).rejects.toThrow('sessionState')
    expect(f.factory.connect).toHaveBeenCalledTimes(1)
    await f.coordinator.command({
      kind: 'close',
      commandId: 'retry-close',
      sessionId: ready.id,
      runId: ready.runId,
    })
    await f.wait(ready.id, 'closed')
  })

  it('recovers receipts after restart and resumes the original snapshot with a new run ID', async () => {
    const f = await fixture()
    const { ready, runtime } = await f.start()
    const running = await f.send(ready)
    const permission = runtime.ask()
    await f.wait(ready.id, 'waiting')
    await f.coordinator.shutdown()
    expect(await permission).toBeNull()
    const interrupted = await f.coordinator.get({ sessionId: ready.id })
    expect(interrupted).toMatchObject({
      status: 'interrupted',
      lastTurn: { outcome: 'interrupted' },
      pendingRequests: [],
    })
    await expect(
      f.coordinator.command({
        kind: 'resume',
        commandId: 'early',
        sessionId: ready.id,
        previousRunId: ready.runId!,
      }),
    ).rejects.toThrow('sessionStopping')
    const restarted = new SessionCoordinator(new SessionJournal(f.root), f.factory)
    coordinators.push(restarted)
    expect(
      (await restarted.command({ kind: 'create', commandId: 'create', agentId: 'profile' })).id,
    ).toBe(ready.id)
    const replay = await restarted.command({
      kind: 'send',
      commandId: 'send',
      sessionId: ready.id,
      runId: ready.runId!,
      messageId: 'message-send',
      text: 'Read the project',
    })
    expect(replay.cursor).toBe(interrupted.cursor)
    expect(runtime.turns).toHaveLength(1)
    expect(replay.lastTurn?.id).toBe(running.activeTurn?.id)
    await restarted.command({
      kind: 'resume',
      commandId: 'resume',
      sessionId: ready.id,
      previousRunId: ready.runId!,
    })
    await vi.waitFor(async () =>
      expect((await restarted.get({ sessionId: ready.id })).status).toBe('ready'),
    )
    const restored = await restarted.get({ sessionId: ready.id })
    expect(restored.runId).not.toBe(ready.runId)
    expect(restored.nativeSessionId).toBe(ready.nativeSessionId)
    expect(f.factory.create).toHaveBeenCalledTimes(1)
    expect(f.connections[1]!.snapshot).toMatchObject({
      snapshotId: ready.snapshotId,
      snapshotDigest: ready.snapshotDigest,
      nativeSessionId: ready.nativeSessionId,
      status: 'resuming',
    })
  })

  it('fails closed on a rejected permission write without publishing or granting it', async () => {
    const f = await fixture()
    const { ready, runtime } = await f.start()
    const running = await f.send(ready)
    const permission = runtime.ask()
    const waiting = await f.wait(ready.id, 'waiting')
    const deliveries: SessionDelivery[] = []
    await expect(
      f.coordinator.readEvents({ sessionId: ready.id, afterCursor: ready.cursor + 100 }),
    ).rejects.toThrow('sessionCursor')
    await expect(
      f.coordinator.history({
        sessionId: ready.id,
        throughCursor: waiting.cursor + 100,
        fromCursor: 1,
        direction: 'forward',
      }),
    ).rejects.toThrow('sessionCursor')
    const archived = await f.coordinator.history({
      sessionId: ready.id,
      throughCursor: waiting.cursor,
      fromCursor: 1,
      direction: 'forward',
    })
    expect(archived.events.some((event) => event.data.kind === 'interaction.requested')).toBe(true)
    expect((await f.coordinator.get({ sessionId: ready.id })).status).toBe('waiting')
    expect(runtime.dispose).not.toHaveBeenCalled()
    await f.coordinator.subscribe(
      'frame',
      { sessionId: ready.id, subscriptionId: 'view', afterCursor: waiting.cursor },
      (delivery) => deliveries.push(delivery),
    )
    const append = f.journal.append.bind(f.journal)
    vi.spyOn(f.journal, 'append').mockImplementation(async (...args) => {
      if (args[2].data.kind === 'interaction.resolved') throw new Error('private database detail')
      return append(...args)
    })
    await expect(
      f.coordinator.command({
        kind: 'respond',
        commandId: 'approve',
        sessionId: ready.id,
        runId: ready.runId!,
        turnId: running.activeTurn!.id,
        requestId: 'approval',
        response: { kind: 'choice', optionId: 'yes' },
      }),
    ).rejects.toThrow('sessionStorage')
    expect(await permission).toBeNull()
    await vi.waitFor(() => expect(runtime.dispose).toHaveBeenCalledOnce())
    await vi.waitFor(() =>
      expect(deliveries).toMatchObject([
        { kind: 'unavailable', failure: { code: 'storage', detail: '' } },
      ]),
    )
    expect(await f.journal.receipt(ready.id, 'approve')).toBeNull()
    expect((await f.journal.get(ready.id)).cursor).toBe(waiting.cursor)
    await expect(f.coordinator.get({ sessionId: ready.id })).rejects.toThrow('sessionStorage')
    expect((await new SessionJournal(f.root).get(ready.id)).status).toBe('interrupted')
  })

  it('does not publish credential revision evidence when the Ready write fails', async () => {
    const f = await fixture()
    const runtime = new FakeRuntime('native')
    runtimes.push(runtime)
    Object.defineProperty(runtime, 'credentialResolutions', {
      value: [
        {
          slot: 1,
          resolvedAt: new Date().toISOString(),
          version: {
            source: 'vault',
            versionId: '10000000-0000-4000-8000-000000000001',
            revision: 1,
            updatedAt: new Date().toISOString(),
          },
        },
      ],
    })
    Object.defineProperty(runtime, 'nativeRuntime', {
      value: { protocol: 'acp', version: 1, restoration: 'resume', restored: false },
    })
    f.factory.connect.mockResolvedValueOnce(runtime)
    const initial = await f.coordinator.command({
      kind: 'create',
      commandId: 'create',
      agentId: 'profile',
    })
    const append = f.journal.append.bind(f.journal)
    vi.spyOn(f.journal, 'append').mockImplementation(async (...args) => {
      if (args[2].data.kind === 'run.ready') throw new Error('write failed')
      return append(...args)
    })
    await f.coordinator.command({ kind: 'start', commandId: 'start', sessionId: initial.id })
    await vi.waitFor(() => expect(runtime.dispose).toHaveBeenCalledOnce())
    const reopened = await new SessionJournal(f.root).get(initial.id)
    expect(reopened.status).toBe('interrupted')
    expect(reopened.configuration).toBeUndefined()
    await expect(f.coordinator.get({ sessionId: initial.id })).rejects.toThrow('sessionStorage')
  })

  it('does not spawn when the start decision cannot be saved', async () => {
    const f = await fixture()
    const initial = await f.coordinator.command({
      kind: 'create',
      commandId: 'create',
      agentId: 'profile',
    })
    vi.spyOn(f.journal, 'append').mockRejectedValueOnce(new Error('disk unavailable'))
    await expect(
      f.coordinator.command({ kind: 'start', commandId: 'start', sessionId: initial.id }),
    ).rejects.toThrow('sessionStorage')
    expect(f.factory.connect).not.toHaveBeenCalled()
    expect((await f.journal.get(initial.id)).status).toBe('created')
  })

  it('expires a permission without approval and ignores callbacks from a lost process', async () => {
    const f = await fixture()
    const { ready, runtime } = await f.start()
    await f.send(ready)
    const answer = runtime.ask(new Date(Date.now() + 75).toISOString())
    await f.wait(ready.id, 'waiting')
    expect(await answer).toBeNull()
    await f.wait(ready.id, 'running')
    runtime.ended.resolve(result)
    const interrupted = await f.wait(ready.id, 'interrupted')
    const handlers = runtime.turns[0]!.handlers
    await handlers.output({
      kind: 'message.delta',
      channel: 'assistant',
      messageId: 'late',
      text: 'late content',
    })
    expect((await f.coordinator.get({ sessionId: ready.id })).cursor).toBe(interrupted.cursor)
    expect(await runtime.ask()).toBeNull()
    expect(
      (await f.coordinator.readEvents({ sessionId: ready.id, afterCursor: 0 })).events.some(
        (event) =>
          event.data.kind === 'interaction.resolved' && event.data.disposition === 'expired',
      ),
    ).toBe(true)
  })

  it('publishes persisted events in order and allows a reloaded frame to replay without resending', async () => {
    const f = await fixture()
    const { ready, runtime } = await f.start()
    const deliveries: SessionDelivery[] = []
    const subscription = { sessionId: ready.id, subscriptionId: 'old', afterCursor: ready.cursor }
    const subscribed = f.coordinator.subscribe('old-frame', subscription, (event) =>
      deliveries.push(event),
    )
    subscription.sessionId = 'changed-while-queued'
    subscription.subscriptionId = 'changed'
    await subscribed
    await f.send(ready)
    await runtime.turns[0]!.handlers.output({
      kind: 'message.delta',
      channel: 'assistant',
      messageId: 'assistant',
      text: 'response',
    })
    runtime.finish()
    const finished = await f.wait(ready.id, 'ready')
    await vi.waitFor(() =>
      expect(deliveries.filter((event) => event.kind === 'event')).toHaveLength(3),
    )
    const persisted = await f.coordinator.readEvents({
      sessionId: ready.id,
      afterCursor: ready.cursor,
    })
    expect(deliveries.every((delivery) => delivery.subscriptionId === 'old')).toBe(true)
    expect(deliveries.flatMap((event) => (event.kind === 'event' ? [event.event] : []))).toEqual(
      persisted.events,
    )
    f.coordinator.removeOwner('old-frame')
    const replay: SessionDelivery[] = []
    await f.coordinator.subscribe(
      'new-frame',
      { sessionId: ready.id, subscriptionId: 'new', afterCursor: ready.cursor },
      (event) => replay.push(event),
    )
    await vi.waitFor(() => expect(replay.filter((event) => event.kind === 'event')).toHaveLength(3))
    expect((await f.coordinator.get({ sessionId: ready.id })).cursor).toBe(finished.cursor)
    expect(runtime.turns).toHaveLength(1)
  })
})
