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
    command: vi.fn(async () => snapshot),
    get: vi.fn(async () => snapshot),
    list: vi.fn(async () => [snapshot]),
    readEvents: vi.fn(),
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
