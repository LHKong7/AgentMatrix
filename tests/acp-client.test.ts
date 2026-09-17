import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RequestPermissionResponse, SessionNotification } from '@agentclientprotocol/sdk'
import { AcpClient, type AcpHandlers, type AcpLimits } from '../src/main/engines/acp/client'
import { AcpFailure, boundedAcpStream } from '../src/main/engines/acp/stream'

type Message = {
  jsonrpc: '2.0'
  id?: number | string
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
class NativeFixture {
  controller!: ReadableStreamDefaultController<Uint8Array>
  ended = false
  sent: Message[] = []
  private waiters: { match: (message: Message) => boolean; resolve: (message: Message) => void }[] =
    []
  readonly input = new ReadableStream<Uint8Array>({
    start: (controller) => {
      this.controller = controller
    },
    cancel: () => {
      this.ended = true
    },
  })
  readonly output = new WritableStream<Uint8Array>({
    write: (bytes) => {
      const message = JSON.parse(new TextDecoder().decode(bytes)) as Message
      const index = this.waiters.findIndex((waiter) => waiter.match(message))
      if (index < 0) this.sent.push(message)
      else this.waiters.splice(index, 1)[0]!.resolve(message)
    },
  })
  send(message: Message) {
    this.controller.enqueue(new TextEncoder().encode(JSON.stringify(message) + '\n'))
  }
  reply(request: Message, result: unknown) {
    this.send({ jsonrpc: '2.0', id: request.id, result })
  }
  take(match: string | ((message: Message) => boolean)): Promise<Message> {
    const predicate =
      typeof match === 'string' ? (message: Message) => message.method === match : match
    const index = this.sent.findIndex(predicate)
    if (index >= 0) return Promise.resolve(this.sent.splice(index, 1)[0]!)
    return new Promise((resolve) => {
      this.waiters.push({ match: predicate, resolve })
    })
  }
  async initialize(peer: AcpClient, capabilities: object = {}) {
    const initialized = peer.initialize('0.1.0')
    const request = await this.take('initialize')
    this.reply(request, { protocolVersion: 1, agentCapabilities: capabilities, authMethods: [] })
    await initialized
    return request
  }
}
const clients: AcpClient[] = []
afterEach(() => {
  clients.splice(0).forEach((peer) => peer.close())
})
function setup(handlers: Partial<AcpHandlers> = {}, limits: Partial<AcpLimits> = {}) {
  const native = new NativeFixture()
  const peer = new AcpClient(
    native.input,
    native.output,
    {
      update: async () => {},
      permission: async () => ({ outcome: { outcome: 'cancelled' } }),
      ...handlers,
    },
    limits,
  )
  clients.push(peer)
  return { peer, native }
}
const prompt = { sessionId: 'native-session', prompt: [{ type: 'text' as const, text: 'hello' }] }
const permission = {
  sessionId: prompt.sessionId,
  toolCall: { toolCallId: 'tool-1', title: 'Write file', status: 'pending', kind: 'edit' },
  options: [
    { optionId: 'yes', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'no', name: 'Reject once', kind: 'reject_once' },
  ],
}
function update(text: string): Message {
  return {
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
      sessionId: prompt.sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
    },
  }
}
function textOf(notification: SessionNotification) {
  return notification.update.sessionUpdate === 'agent_message_chunk' &&
    notification.update.content.type === 'text'
    ? notification.update.content.text
    : ''
}

describe('bounded ACP v1 framing', () => {
  it('preserves split UTF-8 and multiple LF/CRLF frames', async () => {
    let source!: ReadableStreamDefaultController<Uint8Array>
    const bridge = boundedAcpStream(
      new ReadableStream({
        start(controller) {
          source = controller
        },
      }),
      new WritableStream(),
    )
    const reader = bridge.stream.readable.getReader()
    const bytes = Buffer.from(
      '{"jsonrpc":"2.0","method":"event","params":{"text":"中文🙂"}}\r\n{"jsonrpc":"2.0","id":7,"result":{}}\n',
    )
    const boundary = bytes.indexOf(Buffer.from('🙂')) + 2
    source.enqueue(bytes.subarray(0, boundary))
    source.enqueue(bytes.subarray(boundary))
    source.close()
    expect((await reader.read()).value).toMatchObject({ params: { text: '中文🙂' } })
    expect((await reader.read()).value).toMatchObject({ id: 7, result: {} })
    expect((await reader.read()).done).toBe(true)
    await bridge.dispose()
  })
  it.each([
    Buffer.from('{"jsonrpc":"2.0","method":"event"}'),
    Buffer.from('not json\n'),
    Buffer.from('[{"jsonrpc":"2.0","id":1,"result":{}}]\n'),
    Buffer.from('{"jsonrpc":"1.0","method":"event"}\n'),
    Buffer.from('{"jsonrpc":"2.0","id":1,"result":{},"error":{}}\n'),
    Buffer.from([0xff, 10]),
    Buffer.alloc(65, 65),
  ])('fails closed on malformed, truncated, or oversized input (%#)', async (bytes) => {
    const bridge = boundedAcpStream(
      new ReadableStream({
        start(controller) {
          controller.enqueue(bytes)
          controller.close()
        },
      }),
      new WritableStream(),
      64,
    )
    await expect(bridge.stream.readable.getReader().read()).rejects.toMatchObject({
      code: 'protocol',
    })
    await bridge.dispose()
  })
  it('bounds outgoing frames before writing bytes', async () => {
    const write = vi.fn()
    const bridge = boundedAcpStream(new ReadableStream(), new WritableStream({ write }), 32)
    await expect(
      bridge.stream.writable
        .getWriter()
        .write({ jsonrpc: '2.0', method: 'long', params: { text: 'secret'.repeat(50) } }),
    ).rejects.toMatchObject({ code: 'protocol' })
    expect(write).not.toHaveBeenCalled()
    await bridge.dispose()
  })
})

describe('ACP client lifecycle and requests', () => {
  it('advertises only implemented services and refuses unavailable recovery methods', async () => {
    const { peer, native } = setup()
    const request = await native.initialize(peer)
    expect(request.params).toMatchObject({ protocolVersion: 1, clientCapabilities: {} })
    expect(() => peer.loadSession({ sessionId: 's', cwd: '/tmp', mcpServers: [] })).toThrow(
      'unsupported',
    )
    expect(() => peer.resumeSession({ sessionId: 's', cwd: '/tmp', mcpServers: [] })).toThrow(
      'unsupported',
    )
    expect(() => peer.closeSession('s')).toThrow('unsupported')
    await expect(peer.initialize('0.1.0')).rejects.toThrow('invalid-state')
    native.send({
      jsonrpc: '2.0',
      id: 'fs',
      method: 'fs/read_text_file',
      params: { sessionId: 's', path: '/private/secret' },
    })
    expect(await native.take((message) => message.id === 'fs')).toMatchObject({
      error: { code: -32601 },
    })
  })
  it('closes on unsupported protocol versions without retaining peer payloads in errors', async () => {
    const { peer, native } = setup()
    const result = peer.initialize('0.1.0')
    const request = await native.take('initialize')
    native.reply(request, { protocolVersion: 2, agentCapabilities: {}, authMethods: [] })
    await expect(result).rejects.toMatchObject({ code: 'unsupported' })
    await peer.closed
    expect(peer.signal.aborted).toBe(true)
  })
  it('correlates out-of-order responses and copies advertised capabilities', async () => {
    const { peer, native } = setup()
    await native.initialize(peer, { loadSession: true })
    const capabilities = peer.capabilities!
    capabilities.agentCapabilities!.loadSession = false
    expect(peer.capabilities?.agentCapabilities?.loadSession).toBe(true)
    const first = peer.newSession({ cwd: '/tmp/one', mcpServers: [] })
    const second = peer.newSession({ cwd: '/tmp/two', mcpServers: [] })
    const one = await native.take('session/new')
    const two = await native.take('session/new')
    expect(one.id).not.toBe(two.id)
    native.reply(two, { sessionId: 'two' })
    native.reply(one, { sessionId: 'one' })
    expect(await first).toMatchObject({ sessionId: 'one' })
    expect(await second).toMatchObject({ sessionId: 'two' })
  })
  it('waits for ordered update persistence before returning the prompt result', async () => {
    const started = deferred<void>()
    const release = deferred<void>()
    const observed: string[] = []
    const { peer, native } = setup({
      update: async (notification) => {
        const text = textOf(notification)
        if (text === 'A') {
          started.resolve()
          await release.promise
        }
        observed.push(text)
      },
    })
    await native.initialize(peer)
    let finished = false
    const result = peer.prompt(prompt, 2000).then((value) => {
      finished = true
      return value
    })
    const request = await native.take('session/prompt')
    native.send(update('A'))
    native.send(update('B'))
    native.reply(request, { stopReason: 'end_turn' })
    await started.promise
    expect(finished).toBe(false)
    release.resolve()
    expect(await result).toMatchObject({ stopReason: 'end_turn' })
    expect(observed).toEqual(['A', 'B'])
  })
  it('times out the entire attachment and rejects all pending calls', async () => {
    const { peer, native } = setup({}, { requestTimeoutMs: 30 })
    await native.initialize(peer)
    const first = peer.newSession({ cwd: '/tmp', mcpServers: [] })
    const second = peer.newSession({ cwd: '/tmp', mcpServers: [] })
    const results = await Promise.allSettled([first, second])
    expect(
      results.every(
        (result) =>
          result.status === 'rejected' &&
          result.reason instanceof AcpFailure &&
          result.reason.code === 'timeout',
      ),
    ).toBe(true)
    expect(peer.signal.aborted).toBe(true)
    expect(native.ended).toBe(true)
  })
  it('rejects request overload without losing the first request', async () => {
    const { peer, native } = setup({}, { pendingRequests: 1 })
    await native.initialize(peer)
    const first = peer.newSession({ cwd: '/tmp', mcpServers: [] })
    await expect(peer.newSession({ cwd: '/tmp', mcpServers: [] })).rejects.toMatchObject({
      code: 'overload',
    })
    native.reply(await native.take('session/new'), { sessionId: 'one' })
    expect(await first).toMatchObject({ sessionId: 'one' })
    expect(peer.signal.aborted).toBe(false)
  })
  it.each(['queue', 'bytes', 'handler'] as const)('closes on update failure: %s', async (mode) => {
    const release = deferred<void>()
    const { peer, native } = setup(
      {
        update: async () => {
          if (mode === 'handler') throw new Error('private token must not leak')
          await release.promise
        },
      },
      mode === 'bytes' ? { pendingUpdateBytes: 10 } : { pendingUpdates: 1 },
    )
    await native.initialize(peer)
    const result = peer.prompt(prompt, 2000)
    const rejected = expect(result).rejects.toMatchObject({
      code: mode === 'handler' ? 'protocol' : 'overload',
    })
    await native.take('session/prompt')
    native.send(update('A'))
    if (mode === 'queue') native.send(update('B'))
    await rejected
    expect(String(peer.signal.reason)).not.toContain('private token')
    release.resolve()
  })
  it('redacts native RPC errors while preserving their numeric code', async () => {
    const { peer, native } = setup()
    await native.initialize(peer)
    const request = peer.newSession({ cwd: '/tmp', mcpServers: [] })
    native.send({
      jsonrpc: '2.0',
      id: (await native.take('session/new')).id,
      error: { code: -32001, message: 'SECRET', data: { apiKey: 'SECRET' } },
    })
    await expect(request).rejects.toMatchObject({ message: 'ACP engine (-32001)', rpcCode: -32001 })
  })
})

describe('ACP permission boundaries', () => {
  it('aborts permission controls and the active turn when native stdout closes', async () => {
    const asked = deferred<AbortSignal>()
    const { peer, native } = setup({
      permission: async (_request, signal) => {
        asked.resolve(signal)
        return new Promise(() => {})
      },
    })
    await native.initialize(peer)
    const result = peer.prompt(prompt, 2000)
    const rejected = expect(result).rejects.toMatchObject({ code: 'closed' })
    await native.take('session/prompt')
    native.send({
      jsonrpc: '2.0',
      id: 'p',
      method: 'session/request_permission',
      params: permission,
    })
    const signal = await asked.promise
    native.controller.close()
    await rejected
    expect(signal.aborted).toBe(true)
    expect(peer.signal.reason).toBeInstanceOf(AcpFailure)
  })
  it('bounds outstanding permissions and cancels overflow without authorizing a tool', async () => {
    const asked = deferred<void>()
    const { peer, native } = setup(
      {
        permission: async () => {
          asked.resolve()
          return new Promise(() => {})
        },
      },
      { pendingPermissions: 1 },
    )
    await native.initialize(peer)
    const result = peer.prompt(prompt, 2000)
    const request = await native.take('session/prompt')
    native.send({
      jsonrpc: '2.0',
      id: 'one',
      method: 'session/request_permission',
      params: permission,
    })
    await asked.promise
    native.send({
      jsonrpc: '2.0',
      id: 'two',
      method: 'session/request_permission',
      params: permission,
    })
    expect(await native.take((message) => message.id === 'two')).toMatchObject({
      result: { outcome: { outcome: 'cancelled' } },
    })
    await peer.cancel(prompt.sessionId)
    expect(await native.take((message) => message.id === 'one')).toMatchObject({
      result: { outcome: { outcome: 'cancelled' } },
    })
    native.reply(request, { stopReason: 'cancelled' })
    await result
  })
  it('cancels pending/late requests and accepts late output until the native prompt finishes', async () => {
    const asked = deferred<AbortSignal>()
    const answer = deferred<RequestPermissionResponse>()
    const observed: string[] = []
    const { peer, native } = setup({
      permission: async (_request, signal) => {
        asked.resolve(signal)
        return answer.promise
      },
      update: async (notification) => {
        observed.push(textOf(notification))
      },
    })
    await native.initialize(peer)
    let finished = false
    const turn = peer.prompt(prompt, 2000).then((result) => {
      finished = true
      return result
    })
    const turnRequest = await native.take('session/prompt')
    await expect(peer.prompt(prompt, 2000)).rejects.toThrow('invalid-state')
    native.send({
      jsonrpc: '2.0',
      id: 'permission',
      method: 'session/request_permission',
      params: permission,
    })
    const signal = await asked.promise
    await peer.cancel(prompt.sessionId)
    expect(signal.aborted).toBe(true)
    expect(await native.take((message) => message.id === 'permission')).toMatchObject({
      result: { outcome: { outcome: 'cancelled' } },
    })
    expect((await native.take('session/cancel')).params).toEqual({ sessionId: prompt.sessionId })
    native.send({
      jsonrpc: '2.0',
      id: 'late',
      method: 'session/request_permission',
      params: permission,
    })
    expect(await native.take((message) => message.id === 'late')).toMatchObject({
      result: { outcome: { outcome: 'cancelled' } },
    })
    native.send(update('final cleanup'))
    expect(finished).toBe(false)
    native.reply(turnRequest, { stopReason: 'cancelled' })
    expect(await turn).toMatchObject({ stopReason: 'cancelled' })
    expect(observed).toEqual(['final cleanup'])
    answer.resolve({ outcome: { outcome: 'selected', optionId: 'yes' } })
    await Promise.resolve()
    expect(native.sent.filter((message) => message.id === 'permission')).toEqual([])
  })
  it.each(['yes', 'unknown', 'timeout', 'throw'] as const)(
    'settles only a valid choice before expiry: %s',
    async (choice) => {
      let signal: AbortSignal | undefined
      const { peer, native } = setup(
        {
          permission: async (_request, pendingSignal) => {
            signal = pendingSignal
            if (choice === 'throw') throw new Error('private failure')
            if (choice === 'timeout') return new Promise(() => {})
            return { outcome: { outcome: 'selected', optionId: choice } }
          },
        },
        { permissionTimeoutMs: 20 },
      )
      await native.initialize(peer)
      const turn = peer.prompt(prompt, 2000)
      const request = await native.take('session/prompt')
      native.send({
        jsonrpc: '2.0',
        id: 'p',
        method: 'session/request_permission',
        params: permission,
      })
      const response = await native.take((message) => message.id === 'p')
      expect(response.result).toEqual({
        outcome:
          choice === 'yes' ? { outcome: 'selected', optionId: 'yes' } : { outcome: 'cancelled' },
      })
      if (choice === 'timeout') expect(signal?.aborted).toBe(true)
      expect(peer.signal.aborted).toBe(false)
      native.reply(request, { stopReason: 'end_turn' })
      await turn
    },
  )
  it('never prompts for permission outside an active turn or for another session', async () => {
    const handler = vi.fn(async () => ({
      outcome: { outcome: 'selected' as const, optionId: 'yes' },
    }))
    const { peer, native } = setup({ permission: handler })
    await native.initialize(peer)
    native.send({
      jsonrpc: '2.0',
      id: 10,
      method: 'session/request_permission',
      params: permission,
    })
    expect(await native.take((message) => message.id === 10)).toMatchObject({
      result: { outcome: { outcome: 'cancelled' } },
    })
    const turn = peer.prompt(prompt, 2000)
    const request = await native.take('session/prompt')
    native.send({
      jsonrpc: '2.0',
      id: 11,
      method: 'session/request_permission',
      params: { ...permission, sessionId: 'different' },
    })
    expect(await native.take((message) => message.id === 11)).toMatchObject({
      result: { outcome: { outcome: 'cancelled' } },
    })
    expect(handler).not.toHaveBeenCalled()
    native.reply(request, { stopReason: 'end_turn' })
    await turn
  })
})
