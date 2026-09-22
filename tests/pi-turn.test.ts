import { describe, expect, it, vi } from 'vitest'
import { PiTurn } from '../src/main/engines/pi/turn'
import type { RuntimeOutput, RuntimeTurnHandlers } from '../src/main/engines/runtime'
import type { InteractionRequest, InteractionResponse } from '../src/shared/sessions/schema'
import type { PiDialog } from '../src/main/engines/pi/protocol'

function fixture(
  secrets: string[] = [],
  interaction: RuntimeTurnHandlers['interaction'] = async () => ({ kind: 'cancelled' }),
) {
  const events: RuntimeOutput[] = []
  const handlers: RuntimeTurnHandlers = {
    output: async (event) => {
      events.push(event)
    },
    interaction,
  }
  return { events, handlers, turn: new PiTurn(secrets, handlers) }
}
const used = { input: 10, output: 3, cacheRead: 2, cacheWrite: 1 }
async function start(turn: PiTurn) {
  await turn.event({ type: 'agent_start' })
  await turn.event({ type: 'message_start', message: { role: 'assistant', content: [] } })
}
const delta = (turn: PiTurn, text: string, index = 0, thinking = false) =>
  turn.event({
    type: 'message_update',
    assistantMessageEvent: {
      type: thinking ? 'thinking_delta' : 'text_delta',
      contentIndex: index,
      delta: text,
    },
  })
const end = (turn: PiTurn, text: string, stopReason = 'stop', usage: unknown = used) =>
  turn.event({
    type: 'message_end',
    message: { role: 'assistant', content: [{ type: 'text', text }], stopReason, usage },
  })

describe('Pi turn normalization', () => {
  it('finishes verified extension-only work without inventing model usage', async () => {
    const f = fixture()
    f.turn.finishExtensionOnly()
    expect(await f.turn.settled).toEqual({
      outcome: 'completed',
      nativeStopReason: 'extension-handled',
      usage: null,
    })
    const cancelled = fixture()
    cancelled.turn.cancel()
    cancelled.turn.finishExtensionOnly()
    expect((await cancelled.turn.settled).outcome).toBe('cancelled')
  })
  it('does not let an extension-only receipt finish an active model turn', async () => {
    const f = fixture(),
      completed = vi.fn()
    void f.turn.settled.then(completed)
    await start(f.turn)
    f.turn.finishExtensionOnly()
    await Promise.resolve()
    expect(completed).not.toHaveBeenCalled()
    await end(f.turn, 'Model response')
    await f.turn.event({ type: 'agent_settled' })
    expect((await f.turn.settled).nativeStopReason).toBe('stop')
  })
  it('redacts split secrets, preserves Unicode, and reconciles final text without duplicates', async () => {
    const secret = 'synthetic-中文-secret'
    const f = fixture([secret])
    await start(f.turn)
    await delta(f.turn, '🙂\u2028\u2029' + secret.slice(0, 6))
    await delta(f.turn, secret.slice(6))
    await end(f.turn, '🙂\u2028\u2029' + secret + ' final suffix')
    await f.turn.event({ type: 'agent_settled' })
    expect(
      f.events.flatMap((event) => (event.kind === 'message.delta' ? event.text : [])).join(''),
    ).toBe('🙂\u2028\u2029[redacted] final suffix')
    expect(await f.turn.settled).toMatchObject({
      outcome: 'completed',
      nativeStopReason: 'stop',
      usage: { scope: 'turn', inputTokens: 13, outputTokens: 3, cost: null },
    })
  })
  it('waits through agent_end and retry/compaction notices until final settlement', async () => {
    const f = fixture()
    const finished = vi.fn()
    void f.turn.settled.then(finished)
    await start(f.turn)
    await end(f.turn, 'attempt', 'error', null)
    await f.turn.event({ type: 'agent_end', messages: [], willRetry: true })
    await f.turn.event({ type: 'auto_retry_start', attempt: 1, errorMessage: 'not journaled' })
    await f.turn.event({ type: 'compaction_start', reason: 'overflow' })
    await f.turn.event({ type: 'compaction_end', reason: 'overflow', willRetry: true })
    expect(finished).not.toHaveBeenCalled()
    await start(f.turn)
    await end(f.turn, 'success')
    await f.turn.event({ type: 'agent_end', messages: [] })
    expect(finished).not.toHaveBeenCalled()
    await f.turn.event({ type: 'agent_settled' })
    expect(await f.turn.settled).toMatchObject({ outcome: 'completed', usage: null })
    expect(f.events.filter((event) => event.kind === 'engine.notice')).toHaveLength(3)
    expect(JSON.stringify(f.events)).not.toContain('not journaled')
    expect(
      new Set(f.events.flatMap((event) => (event.kind === 'message.delta' ? event.messageId : [])))
        .size,
    ).toBe(2)
  })
  it('separates thinking from assistant text and redacts incomplete secret prefixes', async () => {
    const f = fixture(['hidden-secret'])
    await start(f.turn)
    await delta(f.turn, 'Think hidden-', 0, true)
    await delta(f.turn, 'Answer', 1)
    await f.turn.event({
      type: 'message_end',
      message: {
        role: 'assistant',
        stopReason: 'aborted',
        content: [
          { type: 'thinking', thinking: 'Think hidden-' },
          { type: 'text', text: 'Answer' },
        ],
      },
    })
    await f.turn.event({ type: 'agent_settled' })
    expect(f.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channel: 'reasoning',
          text: expect.stringContaining('[redacted]'),
        }),
      ]),
    )
    expect(await f.turn.settled).toMatchObject({ outcome: 'cancelled', usage: null })
  })
  it('reports zero-filled provider usage as unknown', async () => {
    const f = fixture()
    await start(f.turn)
    await end(f.turn, 'hello', 'stop', { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
    await f.turn.event({ type: 'agent_settled' })
    expect(await f.turn.settled).toMatchObject({ outcome: 'completed', usage: null })
  })
  it('redacts native notice identifiers as well as display text', async () => {
    const f = fixture(['private-type'])
    await start(f.turn)
    await f.turn.event({
      type: 'message_end',
      message: {
        role: 'assistant',
        stopReason: 'stop',
        content: [{ type: 'private-type' }],
      },
    })
    expect(f.events).toEqual([
      { kind: 'engine.notice', code: 'unsupported-output', nativeType: '[redacted]', text: '' },
    ])
  })
  it('correlates bounded tool output through completion using application IDs', async () => {
    const f = fixture(['synthetic-key'])
    await start(f.turn)
    await end(f.turn, '', 'toolUse')
    await f.turn.event({
      type: 'tool_execution_start',
      toolCallId: 'native-synthetic-key',
      toolName: 'read',
      args: { path: 'synthetic-key' },
    })
    await f.turn.event({
      type: 'tool_execution_update',
      toolCallId: 'native-synthetic-key',
      toolName: 'read',
      partialResult: { content: 'x'.repeat(70_000) },
    })
    await f.turn.event({
      type: 'tool_execution_end',
      toolCallId: 'native-synthetic-key',
      toolName: 'read',
      result: { content: 'synthetic-key' },
      isError: false,
    })
    const tools = f.events.filter((event) => event.kind === 'tool.updated')
    expect(tools[1]).toMatchObject({ contentTruncated: true, content: expect.any(String) })
    expect(tools[1]!.content?.length).toBe(65_536)
    expect(tools[2]).toMatchObject({
      toolCallId: tools[0]!.toolCallId,
      status: 'completed',
      contentTruncated: false,
    })
    expect(JSON.stringify(f.events)).not.toContain('synthetic-key')
    await expect(
      f.turn.event({
        type: 'tool_execution_end',
        toolCallId: 'native-synthetic-key',
        toolName: 'read',
        isError: false,
      }),
    ).rejects.toMatchObject({ code: 'protocol' })
  })
  it.each(['error', 'deferred', 'aborted', 'length'])(
    'preserves the terminal reason %s',
    async (reason) => {
      const f = fixture()
      await start(f.turn)
      await end(f.turn, '', reason)
      await f.turn.event({ type: 'agent_settled' })
      expect(await f.turn.settled).toMatchObject({
        nativeStopReason: reason,
        outcome:
          reason === 'aborted'
            ? 'cancelled'
            : ['error', 'deferred'].includes(reason)
              ? 'failed'
              : 'completed',
      })
    },
  )
  it('maps selects with duplicate or redacted labels back to the exact native value', async () => {
    let request: InteractionRequest | undefined
    const f = fixture(['private'], async (value) => {
      request = value
      if (value.kind !== 'select') throw new Error('Expected select')
      return { kind: 'choice', optionId: value.options[1]!.id }
    })
    const result = await f.turn.dialog(
      {
        type: 'extension_ui_request',
        id: 'native-private',
        title: 'Pick private',
        method: 'select',
        options: ['private', 'private'],
      },
      new AbortController().signal,
    )
    expect(result).toEqual({ value: 'private' })
    expect(request?.kind === 'select' && request.options[0]!.id).not.toBe(
      request?.kind === 'select' && request.options[1]!.id,
    )
    expect(JSON.stringify(request)).not.toContain('private')
  })
  it.each([
    [
      { method: 'confirm', message: 'Continue?' },
      { kind: 'confirm', accepted: false },
      { confirmed: false },
    ],
    [{ method: 'input', placeholder: 'Name' }, { kind: 'input', value: '中文' }, { value: '中文' }],
    [
      { method: 'editor', prefill: 'Keep\nthese lines' },
      { kind: 'input', value: 'Keep\nthese lines' },
      { value: 'Keep\nthese lines' },
    ],
  ] as const)('keeps $0.method responses distinct', async (native, response, expected) => {
    const f = fixture([], async (request) => {
      if (native.method === 'editor')
        expect(request).toMatchObject({
          kind: 'input',
          multiline: true,
          initialValue: native.prefill,
        })
      return response
    })
    expect(
      await f.turn.dialog(
        { type: 'extension_ui_request', id: 'native', title: 'Request', ...native } as PiDialog,
        new AbortController().signal,
      ),
    ).toEqual(expected)
  })
  it('invalidates waiting dialogs on cancellation and ignores late answers', async () => {
    let finish!: (answer: InteractionResponse) => void
    const f = fixture(
      [],
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const pending = f.turn.dialog(
      {
        type: 'extension_ui_request',
        id: 'native',
        title: 'Confirm',
        method: 'confirm',
        message: '',
      },
      new AbortController().signal,
    )
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    f.turn.cancel()
    expect(await pending).toEqual({ cancelled: true })
    finish({ kind: 'confirm', accepted: true })
  })
  it('does not hide persistence failures, malformed events, or unsafe editor prefills', async () => {
    const f = fixture(['private'])
    await expect(
      f.turn.dialog(
        {
          type: 'extension_ui_request',
          id: 'native',
          title: 'Edit',
          method: 'editor',
          prefill: 'private',
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'unsupported' })
    await expect(f.turn.event({ type: 'unknown' })).rejects.toMatchObject({ code: 'unsupported' })
    await expect(delta(f.turn, 'before message')).rejects.toMatchObject({ code: 'protocol' })
    await start(f.turn)
    await delta(f.turn, 'original')
    await expect(end(f.turn, 'different')).rejects.toMatchObject({ code: 'protocol' })
    const broken = fixture()
    broken.handlers.output = async () => {
      throw new Error('private storage error')
    }
    await start(broken.turn)
    await expect(delta(broken.turn, 'hello')).rejects.toMatchObject({
      code: 'storage',
      message: 'Agent runtime storage',
    })
  })
})
