import { EventEmitter } from 'node:events'
import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { registerSessionIpc, verifyRenderer } from '../src/main/sessions/ipc'
import type { SessionCoordinator } from '../src/main/sessions/coordinator'
import { sessionChannels } from '../src/shared/sessions/channels'
import { createSessionSnapshot } from '../src/shared/sessions/state'
import type { SessionDelivery } from '../src/shared/sessions/schema'

const url = 'file:///trusted/index.html'
function fixture() {
  const frame = { url, send: vi.fn() }
  const contents = Object.assign(new EventEmitter(), { mainFrame: frame }) as unknown as WebContents
  const event = { sender: contents, senderFrame: frame } as unknown as IpcMainInvokeEvent
  const snapshot = createSessionSnapshot({
    id: 's',
    agentId: 'a',
    installationId: 'i',
    engineVersion: '1',
    mode: 'acp',
    cwd: '/project',
    snapshotId: 'inputs',
    snapshotDigest: '0'.repeat(64),
    createdAt: new Date().toISOString(),
  })
  let receive: (delivery: SessionDelivery) => void = () => {}
  const unsubscribe = vi.fn()
  const coordinator = {
    unusedRunData: vi.fn(async () => ({ items: [], next: null, skipped: 0 })),
    removeUnusedRunData: vi.fn(),
    remove: vi.fn(),
    pendingRemovals: vi.fn(async () => []),
    command: vi.fn(async () => snapshot),
    get: vi.fn(async () => snapshot),
    list: vi.fn(async () => [snapshot]),
    readEvents: vi.fn(),
    history: vi.fn(),
    configuration: vi.fn(),
    impact: vi.fn(),
    removeOwner: vi.fn(),
    unsubscribe: vi.fn(),
    subscribe: vi.fn(
      async (_owner: string, _query: unknown, listener: (delivery: SessionDelivery) => void) => {
        receive = listener
        return { snapshot, unsubscribe }
      },
    ),
  }
  const handles = new Map<string, Parameters<IpcMain['handle']>[1]>()
  const ipc = {
    handle: (channel: string, handle: Parameters<IpcMain['handle']>[1]) => {
      handles.set(channel, handle)
    },
  }
  const bridge = registerSessionIpc(ipc, coordinator as unknown as SessionCoordinator, (input) =>
    verifyRenderer(input, contents, url),
  )
  bridge.attach(contents)
  return {
    contents,
    frame,
    event,
    coordinator,
    unsubscribe,
    snapshot,
    invoke: (channel: string, input?: unknown, sender = event) =>
      Promise.resolve(handles.get(channel)!(sender, input)),
    emit: (delivery: SessionDelivery) => receive(delivery),
  }
}
describe('session IPC ownership', () => {
  it('requires current renderer ownership for unused-run discovery and removal', async () => {
    const f = fixture(),
      request = { target: { kind: 'capture', id: 'orphan' }, token: 'a'.repeat(64) }
    await f.invoke(sessionChannels.unusedRunData, {})
    await f.invoke(sessionChannels.removeUnusedRunData, request)
    expect(f.coordinator.removeUnusedRunData).toHaveBeenCalledExactlyOnceWith(request)
    f.contents.emit('destroyed')
    await expect(f.invoke(sessionChannels.unusedRunData, {})).rejects.toThrow('untrusted')
    await expect(f.invoke(sessionChannels.removeUnusedRunData, request)).rejects.toThrow(
      'untrusted',
    )
    expect(f.coordinator.unusedRunData).toHaveBeenCalledOnce()
  })
  it('protects deletion and pending cleanup with the current renderer owner', async () => {
    const f = fixture()
    const input = { sessionId: 's', expectedCursor: 3 }
    await f.invoke(sessionChannels.remove, input)
    expect(f.coordinator.remove).toHaveBeenCalledWith(input)
    expect(await f.invoke(sessionChannels.pendingRemovals)).toEqual([])
    f.contents.emit('destroyed')
    await expect(f.invoke(sessionChannels.remove, input)).rejects.toThrow('untrusted')
    await expect(f.invoke(sessionChannels.pendingRemovals)).rejects.toThrow('untrusted')
    expect(f.coordinator.remove).toHaveBeenCalledTimes(1)
    expect(f.coordinator.pendingRemovals).toHaveBeenCalledTimes(1)
  })
  it('routes history pages through the same sender checks as live events', async () => {
    const f = fixture()
    const query = { sessionId: 's', throughCursor: 0, fromCursor: 0, direction: 'backward' }
    await f.invoke(sessionChannels.history, query)
    expect(f.coordinator.history).toHaveBeenCalledWith(query)
    await expect(
      f.invoke(sessionChannels.history, query, {
        ...f.event,
        senderFrame: { url },
      } as IpcMainInvokeEvent),
    ).rejects.toThrow('untrusted')
    expect(f.coordinator.history).toHaveBeenCalledTimes(1)
  })
  it('rejects a different window, subframe, and changed document URL before invoking the service', async () => {
    const f = fixture()
    for (const event of [
      { ...f.event, sender: {} },
      { ...f.event, senderFrame: { url } },
    ]) {
      await expect(
        f.invoke(sessionChannels.command, {}, event as IpcMainInvokeEvent),
      ).rejects.toThrow('untrusted')
    }
    f.frame.url = 'https://untrusted.example/'
    await expect(f.invoke(sessionChannels.configuration, { sessionId: 's' })).rejects.toThrow(
      'untrusted',
    )
    expect(f.coordinator.configuration).not.toHaveBeenCalled()
    await expect(f.invoke(sessionChannels.list)).rejects.toThrow('untrusted')
    expect(f.coordinator.command).not.toHaveBeenCalled()
    expect(f.coordinator.list).not.toHaveBeenCalled()
  })
  it('routes report reads through the same verified session owner', async () => {
    const f = fixture()
    await f.invoke(sessionChannels.configuration, { sessionId: 's' })
    expect(f.coordinator.configuration).toHaveBeenCalledWith({ sessionId: 's' })
    f.contents.emit('destroyed')
    await expect(f.invoke(sessionChannels.configuration, { sessionId: 's' })).rejects.toThrow(
      'untrusted',
    )
  })
  it('routes impact reads through the verified owner and never calls an untrusted service', async () => {
    const f = fixture(),
      query = { revision: 1, change: { collection: 'prompts', entry: {} } }
    await f.invoke(sessionChannels.impact, query)
    expect(f.coordinator.impact).toHaveBeenCalledWith(query)
    f.coordinator.impact.mockClear()
    for (const event of [
      { ...f.event, sender: {} },
      { ...f.event, senderFrame: { url } },
    ])
      await expect(
        f.invoke(sessionChannels.impact, query, event as IpcMainInvokeEvent),
      ).rejects.toThrow('untrusted')
    f.contents.emit('destroyed')
    await expect(f.invoke(sessionChannels.impact, query)).rejects.toThrow('untrusted')
    expect(f.coordinator.impact).not.toHaveBeenCalled()
  })
  it('invalidates frame subscriptions on reload and cannot send into the next document', async () => {
    const f = fixture()
    await f.invoke(sessionChannels.subscribe, {
      sessionId: 's',
      subscriptionId: 'sub',
      afterCursor: 0,
    })
    const owner = f.coordinator.subscribe.mock.calls[0]![0]
    f.emit({ kind: 'reset-required', subscriptionId: 'sub', snapshot: f.snapshot })
    expect(f.frame.send).toHaveBeenCalledTimes(1)
    f.contents.emit('did-start-navigation', {}, url, false, true)
    expect(f.coordinator.removeOwner).toHaveBeenCalledWith(owner)
    f.emit({ kind: 'reset-required', subscriptionId: 'sub', snapshot: f.snapshot })
    expect(f.frame.send).toHaveBeenCalledTimes(1)
    await f.invoke(sessionChannels.unsubscribe, { sessionId: 's', subscriptionId: 'sub' })
    expect(f.coordinator.unsubscribe.mock.calls[0]![0]).not.toBe(owner)
  })
  it('removes a subscription that finishes registering after navigation', async () => {
    const f = fixture()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    f.coordinator.subscribe.mockImplementationOnce(async () => {
      await gate
      return { snapshot: f.snapshot, unsubscribe: f.unsubscribe }
    })
    const pending = f.invoke(sessionChannels.subscribe, {
      sessionId: 's',
      subscriptionId: 'sub',
      afterCursor: 0,
    })
    await vi.waitFor(() => expect(f.coordinator.subscribe).toHaveBeenCalled())
    f.contents.emit('did-start-navigation', {}, url, false, true)
    release()
    await expect(pending).rejects.toThrow('untrusted')
    expect(f.unsubscribe).toHaveBeenCalledOnce()
  })
  it('keeps raw errors and invalid subscribe payloads out of IPC replies', async () => {
    const f = fixture()
    f.coordinator.command.mockRejectedValueOnce(new Error('private native error with secret'))
    await expect(f.invoke(sessionChannels.command, {})).rejects.toThrow('runtimeOperation')
    await expect(
      f.invoke(sessionChannels.subscribe, {
        sessionId: '../s',
        subscriptionId: 's',
        afterCursor: 0,
      }),
    ).rejects.toThrow('invalidData')
    f.contents.emit('destroyed')
    await expect(f.invoke(sessionChannels.get, { sessionId: 's' })).rejects.toThrow('untrusted')
  })
})

describe('application error boundary', () => {
  it.each(['raw', 'forged-code', 'schema'] as const)(
    'replaces %s exceptions without retaining their message, cause or properties',
    async (kind) => {
      const { safeSessionOperation } = await import('../src/main/sessions/ipc')
      const { z } = await import('zod')
      const secret = 'synthetic-ipc-error-secret'
      const error =
        kind === 'schema'
          ? z
              .object({})
              .strict()
              .safeParse({ [secret]: true }).error!
          : new Error(
              kind === 'forged-code'
                ? `AGENT_MATRIX_ERROR:${JSON.stringify({ key: 'error.conflict', params: { private: secret } })}`
                : secret,
              { cause: new Error(secret) },
            )
      Object.assign(error, { private: secret })
      const caught = await safeSessionOperation(async () => {
        throw error
      }).catch((value) => value)
      expect(caught).not.toBe(error)
      expect(caught.message).toContain(
        kind === 'schema' ? 'error.invalidData' : 'error.runtimeOperation',
      )
      expect(caught.cause).toBeUndefined()
      expect(caught.private).toBeUndefined()
      expect(String(caught.stack)).not.toContain(secret)
      expect(JSON.stringify(caught)).not.toContain(secret)
    },
  )

  it('rebuilds trusted application errors from their original payload and preserves localization', async () => {
    const { safeSessionOperation } = await import('../src/main/sessions/ipc')
    const { appError, formatError } = await import('../src/shared/errors')
    const params = { feature: 'skill.frontmatter' }
    const original = appError('error.piConfiguration', params)
    params.feature = 'synthetic-mutated-secret'
    original.message = 'synthetic-mutated-secret'
    original.stack = 'synthetic-mutated-secret'
    Object.assign(original, {
      cause: new Error('synthetic-mutated-secret'),
      private: 'synthetic-mutated-secret',
    })
    const caught = await safeSessionOperation(async () => {
      throw original
    }).catch((value) => value)
    expect(caught).not.toBe(original)
    expect(caught.cause).toBeUndefined()
    expect(caught.private).toBeUndefined()
    expect(String(caught.stack)).not.toContain('synthetic-mutated-secret')
    expect(formatError(caught, 'en')).toContain('skill.frontmatter')
    expect(formatError(caught, 'zh-CN')).toContain('无法映射')
    expect(caught.message).toContain('error.piConfiguration')
  })
})

describe('shared application invoke registration', () => {
  it.each(['sync', 'async'] as const)(
    'sanitizes %s service failures before Electron receives them',
    async (kind) => {
      const { registerApplicationHandler } = await import('../src/main/sessions/ipc')
      let invoke!: Parameters<IpcMain['handle']>[1]
      const verify = vi.fn()
      const privateError = Object.assign(new Error('synthetic-service-secret'), {
        private: 'synthetic-service-secret',
      })
      const operation = vi.fn(() => {
        if (kind === 'async') return Promise.reject(privateError)
        throw privateError
      })
      registerApplicationHandler(
        {
          handle: (_channel, listener) => {
            invoke = listener
          },
        },
        'test:service',
        verify,
        operation,
      )
      const event = {} as IpcMainInvokeEvent
      const error = await invoke(event, { value: 1 }).catch((value: unknown) => value)
      expect(error.message).toContain('error.failed')
      expect(String(error.stack)).not.toContain('synthetic-service-secret')
      expect(error.private).toBeUndefined()
      expect(verify).toHaveBeenCalledExactlyOnceWith(event)
      expect(operation).toHaveBeenCalledExactlyOnceWith(event, { value: 1 })
    },
  )

  it('checks ownership before service execution and preserves the trusted rejection code', async () => {
    const { registerApplicationHandler } = await import('../src/main/sessions/ipc')
    const { appError } = await import('../src/shared/errors')
    let invoke!: Parameters<IpcMain['handle']>[1]
    const operation = vi.fn()
    registerApplicationHandler(
      {
        handle: (_channel, listener) => {
          invoke = listener
        },
      },
      'test:service',
      () => {
        throw appError('error.untrusted')
      },
      operation,
    )
    await expect(invoke({} as IpcMainInvokeEvent)).rejects.toThrow('error.untrusted')
    expect(operation).not.toHaveBeenCalled()
  })
})
