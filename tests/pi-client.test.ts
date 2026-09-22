import { afterEach, describe, expect, it, vi } from 'vitest'
import { PiClient, type PiHandlers } from '../src/main/engines/pi/client'
import {
  PiFailure,
  piFrameLimit,
  readPiRecords,
  type PiRecord,
  type PiDialogAnswer,
} from '../src/main/engines/pi/protocol'
import { attachPiProcess } from '../src/main/engines/pi/attachment'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { resolve, promise }
}
const clients: PiClient[] = []
afterEach(() => clients.splice(0).forEach((client) => client.close()))
function fixture(
  handlers: Partial<PiHandlers> = {},
  limits: ConstructorParameters<typeof PiClient>[3] = {},
  onWrite: (record: PiRecord) => Promise<void> = async () => {},
) {
  let source!: ReadableStreamDefaultController<Uint8Array>
  const sent: PiRecord[] = []
  const client = new PiClient(
    new ReadableStream({
      start(controller) {
        source = controller
      },
    }),
    new WritableStream({
      async write(bytes) {
        const record = JSON.parse(new TextDecoder().decode(bytes)) as PiRecord
        sent.push(record)
        await onWrite(record)
      },
    }),
    { event: async () => {}, dialog: async () => ({ cancelled: true }), ...handlers },
    limits,
  )
  clients.push(client)
  const send = (value: object) => source.enqueue(Buffer.from(JSON.stringify(value) + '\n'))
  return {
    client,
    sent,
    source,
    send,
    reply: (command: PiRecord, data?: unknown) =>
      send({ type: 'response', id: command.id, command: command.type, success: true, data }),
    take: async (type: string) => {
      await vi.waitFor(() => expect(sent.some((item) => item.type === type)).toBe(true))
      return sent.splice(
        sent.findIndex((item) => item.type === type),
        1,
      )[0]!
    },
  }
}
const dialog = {
  type: 'extension_ui_request',
  method: 'select',
  id: 'native-choice',
  title: 'Choose',
  options: ['First', 'Second'],
}

describe('Pi LF framing', () => {
  it('keeps Unicode separators and split UTF-8 inside CRLF/LF records', async () => {
    const values: PiRecord[] = []
    const bytes = Buffer.from(
      JSON.stringify({ type: 'message_update', text: '中文🙂\u2028\u2029end' }) +
        '\r\n\n{"type":"agent_settled"}\n',
    )
    const boundary = bytes.indexOf(Buffer.from('🙂')) + 2
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.subarray(0, boundary))
        controller.enqueue(bytes.subarray(boundary))
        controller.close()
      },
    })
    await readPiRecords(input.getReader(), (value) => {
      values.push(value)
    })
    expect(values).toEqual([
      { type: 'message_update', text: '中文🙂\u2028\u2029end' },
      { type: 'agent_settled' },
    ])
  })
  it.each([
    Buffer.from('{"type":"agent_settled"}'),
    Buffer.from('[]\n'),
    Buffer.from('{}\n'),
    Buffer.from('{"type":7}\n'),
    Buffer.from([123, 34, 116, 121, 112, 101, 34, 58, 34, 255, 34, 125, 10]),
    Buffer.alloc(piFrameLimit + 1, 32),
  ])(
    'rejects incomplete, invalid, or oversized frames without native diagnostics',
    async (bytes) => {
      const reader = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes)
          controller.close()
        },
      }).getReader()
      await expect(readPiRecords(reader, () => {})).rejects.toThrow('Pi RPC protocol')
    },
  )
})

describe('Pi RPC correlation and ordered delivery', () => {
  it('correlates reversed responses while persisting earlier events before returning', async () => {
    const gate = deferred<void>()
    const events: PiRecord[] = []
    const f = fixture({
      event: async (value) => {
        await gate.promise
        events.push(value)
      },
    })
    const first = f.client.request({ type: 'get_state' })
    const second = f.client.request({ type: 'get_messages' })
    const a = await f.take('get_state'),
      b = await f.take('get_messages')
    f.send({ type: 'bash_execution_update', id: a.id, chunk: 'ordinary event' })
    f.reply(b, ['history'])
    f.reply(a, { sessionId: 'native' })
    let finished = false
    void second.then(() => {
      finished = true
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(finished).toBe(false)
    gate.resolve()
    expect(await first).toEqual({ sessionId: 'native' })
    expect(await second).toEqual(['history'])
    expect(events).toHaveLength(1)
  })
  it('returns prompt acceptance separately from later settlement and masks native rejection text', async () => {
    const events: PiRecord[] = []
    const f = fixture({
      event: async (value) => {
        events.push(value)
      },
    })
    const accepted = f.client.request({ type: 'prompt', message: 'hi' })
    f.reply(await f.take('prompt'))
    await accepted
    expect(events).toEqual([])
    f.send({ type: 'agent_end', willRetry: true })
    f.send({ type: 'agent_settled' })
    await vi.waitFor(() =>
      expect(events.map((item) => item.type)).toEqual(['agent_end', 'agent_settled']),
    )
    const failure = expect(f.client.request({ type: 'get_state' })).rejects.toThrow(
      /^Pi RPC engine$/,
    )
    const command = await f.take('get_state')
    f.send({
      type: 'response',
      id: command.id,
      command: command.type,
      success: false,
      error: 'secret native key',
    })
    await failure
    expect(f.client.signal.aborted).toBe(false)
  })
  it.each(['foreign-id', 'wrong-command', 'duplicate'])(
    'closes on a %s response',
    async (fault) => {
      const f = fixture()
      const result = f.client.request({ type: 'get_state' }).catch((error) => error)
      const request = await f.take('get_state')
      const response = { type: 'response', id: request.id, command: 'get_state', success: true }
      if (fault === 'foreign-id') response.id = 'elsewhere'
      if (fault === 'wrong-command') response.command = 'prompt'
      f.send(response)
      if (fault === 'duplicate') f.send(response)
      await f.client.closed
      expect(f.client.signal.reason).toBeInstanceOf(PiFailure)
      await result
    },
  )
  it('bounds outstanding work and stops timed-out requests', async () => {
    const f = fixture({}, { requestTimeoutMs: 30, pendingRequests: 1 })
    const request = expect(f.client.request({ type: 'get_state' })).rejects.toThrow('timeout')
    await expect(f.client.request({ type: 'get_messages' })).rejects.toThrow('overload')
    await request
    expect(f.client.signal.aborted).toBe(true)
  })
  it('closes on a slow event-consumer overflow or failed persistence', async () => {
    const gate = deferred<void>()
    const f = fixture({ event: () => gate.promise }, { pendingEvents: 1 })
    f.source.enqueue(Buffer.from('{"type":"agent_start"}\n{"type":"agent_settled"}\n'))
    await f.client.closed
    expect(f.client.signal.reason.code).toBe('overload')
    gate.resolve()
    const g = fixture({
      event: async () => {
        throw new Error('storage secret')
      },
    })
    g.send({ type: 'agent_start' })
    await g.client.closed
    expect(g.client.signal.reason.message).toBe('Pi RPC protocol')
  })
})

describe('Pi extension dialogs', () => {
  it('rechecks cancellation when a queued answer finally reaches stdin', async () => {
    const blocked = deferred<void>()
    const handler = vi.fn(async () => ({ value: 'First' }))
    const f = fixture({ dialog: handler }, {}, (record) =>
      record.type === 'get_state' ? blocked.promise : Promise.resolve(),
    )
    const state = f.client.request({ type: 'get_state' })
    const stateCommand = await f.take('get_state')
    f.send(dialog)
    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce())
    const abort = f.client.request({ type: 'abort' })
    blocked.resolve()
    expect(await f.take('extension_ui_response')).toEqual({
      type: 'extension_ui_response',
      id: dialog.id,
      cancelled: true,
    })
    f.reply(stateCommand)
    f.reply(await f.take('abort'))
    await Promise.all([state, abort])
  })
  it('preserves a negative confirmation and Unicode input without coercing either into permission', async () => {
    const f = fixture({
      dialog: async (request) =>
        request.method === 'confirm' ? { confirmed: false } : { value: '中文\u2028answer' },
    })
    f.send({ ...dialog, method: 'confirm', message: 'Confirm?' })
    expect(await f.take('extension_ui_response')).toEqual({
      type: 'extension_ui_response',
      id: dialog.id,
      confirmed: false,
    })
    f.send({ ...dialog, id: 'input', method: 'input' })
    expect(await f.take('extension_ui_response')).toEqual({
      type: 'extension_ui_response',
      id: 'input',
      value: '中文\u2028answer',
    })
  })
  it('allows state/cancel commands while a dialog waits and suppresses late answers', async () => {
    const answer = deferred<PiDialogAnswer>()
    const handler = vi.fn(async () => answer.promise)
    const f = fixture({ dialog: handler })
    f.send(dialog)
    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce())
    const state = f.client.request({ type: 'get_state' })
    f.reply(await f.take('get_state'), { isStreaming: true })
    expect(await state).toEqual({ isStreaming: true })
    const aborted = f.client.request({ type: 'abort' })
    expect(await f.take('extension_ui_response')).toEqual({
      type: 'extension_ui_response',
      id: dialog.id,
      cancelled: true,
    })
    f.reply(await f.take('abort'))
    await aborted
    answer.resolve({ value: 'First' })
    await Promise.resolve()
    expect(f.sent).toHaveLength(0)
  })
  it('cancels timed-out dialogs and rejects invalid or failed answers', async () => {
    const pending = deferred<PiDialogAnswer>()
    const f = fixture({ dialog: () => pending.promise }, { dialogTimeoutMs: 20 })
    f.send(dialog)
    expect(await f.take('extension_ui_response')).toMatchObject({ cancelled: true })
    pending.resolve({ value: 'First' })
    for (const handler of [
      async () => ({ value: 'Not offered' }),
      async () => {
        throw new Error('storage failed')
      },
    ]) {
      const g = fixture({ dialog: handler })
      g.send(dialog)
      await g.client.closed
      expect(g.client.signal.reason.code).toBe('protocol')
      expect(g.sent).toEqual([])
    }
  })
  it('cleans up the owned process on malformed native output', async () => {
    const attachment = await attachPiProcess(
      {
        executable: process.execPath,
        args: ['-e', 'process.stdout.write("not JSON\\n"); setInterval(() => {}, 1000)'],
        cwd: process.cwd(),
        environment: {},
      },
      { event: async () => {}, dialog: async () => ({ cancelled: true }) },
    )
    try {
      expect((await attachment.closed).cleanup).toBe('posix-process-group')
      expect(attachment.process.done).toBe(true)
    } finally {
      await attachment.close()
    }
  })
})
