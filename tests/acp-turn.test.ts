import { describe, expect, it, vi } from 'vitest'
import type { RequestPermissionRequest, SessionNotification } from '@agentclientprotocol/sdk'
import { AcpTurn } from '../src/main/engines/acp/turn'
import type { RuntimeOutput, RuntimeTurnHandlers } from '../src/main/engines/runtime'

function fixture(secrets: string[] = [], permission?: RuntimeTurnHandlers['permission']) {
  const events: RuntimeOutput[] = []
  const handlers: RuntimeTurnHandlers = {
    output: async (event) => {
      events.push(event)
    },
    permission: permission ?? (async () => null),
  }
  return { events, handlers, turn: new AcpTurn('native-session', secrets, handlers) }
}
function message(text: string, reasoning = false): SessionNotification {
  return {
    sessionId: 'native-session',
    update: {
      sessionUpdate: reasoning ? 'agent_thought_chunk' : 'agent_message_chunk',
      content: { type: 'text', text },
    },
  }
}
function request(): RequestPermissionRequest {
  return {
    sessionId: 'native-session',
    toolCall: {
      toolCallId: 'native-tool',
      title: 'Read file',
      status: 'pending',
      rawInput: { path: '/fixture.txt' },
    },
    options: [
      { optionId: 'native-yes', kind: 'allow_once', name: 'Allow once' },
      { optionId: 'native-no', kind: 'reject_once', name: 'Reject once' },
    ],
  }
}

describe('ACP turn normalization', () => {
  it('redacts split secrets on independent channels without losing long streamed output', async () => {
    const secret = 'synthetic-key-中文'
    const { turn, events } = fixture([secret])
    await turn.update(message('x'.repeat(100_000) + secret.slice(0, 8)))
    await turn.update(message('Reason ' + secret.slice(0, 8), true))
    await turn.update(message(secret.slice(8) + ' answer'))
    await turn.update(message(secret.slice(8) + ' thought', true))
    await turn.finish()
    const chunks = events.filter((event) => event.kind === 'message.delta')
    const text = (channel: string) =>
      chunks
        .filter((event) => event.channel === channel)
        .map((event) => event.text)
        .join('')
    expect(text('assistant')).toBe('x'.repeat(100_000) + '[redacted] answer')
    expect(text('reasoning')).toBe('Reason [redacted] thought')
    expect(chunks.every((event) => event.text.length <= 32_768)).toBe(true)
    expect(new Set(chunks.map((event) => event.messageId)).size).toBe(2)
    expect(JSON.stringify(events)).not.toContain('synthetic')
    await turn.update(message('late text'))
    await turn.finish()
    expect(text('assistant')).not.toContain('late text')
  })

  it('ignores another session and masks unfinished credential prefixes at turn end', async () => {
    const { turn, events } = fixture(['abcdef-secret'])
    await turn.update({ ...message('foreign'), sessionId: 'foreign' })
    await turn.update(message('result abcdef-'))
    await turn.finish()
    expect(
      events.flatMap((event) => (event.kind === 'message.delta' ? event.text : [])).join(''),
    ).toBe('result [redacted]')
  })

  it('merges partial tool updates using opaque IDs and marks truncated content', async () => {
    const { turn, events } = fixture(['synthetic-key'])
    await turn.update({
      sessionId: 'native-session',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'native-id-synthetic-key',
        title: 'Read synthetic-key',
        status: 'in_progress',
        content: [{ type: 'content', content: { type: 'text', text: 'x'.repeat(70_000) } }],
      },
    })
    await turn.update({
      sessionId: 'native-session',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'native-id-synthetic-key',
        status: 'completed',
      },
    })
    const [first, second] = events
    expect(first).toMatchObject({
      kind: 'tool.updated',
      status: 'running',
      title: 'Read [redacted]',
      contentTruncated: true,
    })
    expect(second).toMatchObject({ ...first, status: 'completed' })
    expect(first?.kind === 'tool.updated' && first.content?.length).toBe(65_536)
    expect(JSON.stringify(events)).not.toContain('synthetic-key')
    await turn.update({
      sessionId: 'native-session',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'native-id-synthetic-key',
        content: [],
      },
    })
    expect(events.at(-1)).toMatchObject({ content: '', contentTruncated: false })
  })

  it('publishes tool details before permission choices and maps the selected opaque ID back', async () => {
    const { turn, events } = fixture([], async (permission) => {
      expect(events.at(-1)).toMatchObject({
        kind: 'tool.updated',
        content: '{"path":"/fixture.txt"}',
        toolCallId: permission.toolCallId,
      })
      expect(permission.options.map((option) => option.id)).not.toContain('native-yes')
      return permission.options[0]!.id
    })
    expect(await turn.permission(request(), new AbortController().signal)).toEqual({
      outcome: { outcome: 'selected', optionId: 'native-yes' },
    })
  })

  it.each(['abort', 'finish'] as const)(
    'settles a stuck permission handler on %s and ignores a late answer',
    async (ending) => {
      let answer: (id: string) => void = () => {}
      let arrived = () => {}
      const ready = new Promise<void>((resolve) => {
        arrived = resolve
      })
      let id = ''
      let signal: AbortSignal | undefined
      const { turn } = fixture([], async (permission, lifetime) => {
        id = permission.options[0]!.id
        signal = lifetime
        arrived()
        return new Promise<string>((resolve) => {
          answer = resolve
        })
      })
      const abort = new AbortController()
      const pending = turn.permission(request(), abort.signal)
      await ready
      if (ending === 'abort') abort.abort()
      else await turn.finish()
      expect(await pending).toEqual({ outcome: { outcome: 'cancelled' } })
      expect(signal?.aborted).toBe(true)
      answer(id)
    },
  )

  it('rejects unknown choices and permissions outside the active turn', async () => {
    const permission = vi.fn(async () => 'native-yes')
    const { turn } = fixture([], permission)
    const signal = new AbortController().signal
    expect(await turn.permission({ ...request(), sessionId: 'foreign' }, signal)).toEqual({
      outcome: { outcome: 'cancelled' },
    })
    expect(permission).not.toHaveBeenCalled()
    expect(await turn.permission(request(), signal)).toEqual({ outcome: { outcome: 'cancelled' } })
    await turn.finish()
    await turn.permission(request(), signal)
    expect(permission).toHaveBeenCalledTimes(1)
  })

  it('exposes persistence failures as static errors without leaking callback text', async () => {
    const { turn, handlers } = fixture([], async () => {
      throw new Error('private permission value')
    })
    await expect(turn.permission(request(), new AbortController().signal)).rejects.toMatchObject({
      code: 'storage',
      message: 'Agent runtime storage',
    })
    handlers.output = async () => {
      throw new Error('private output value')
    }
    await expect(turn.update(message('safe text'))).rejects.toMatchObject({
      code: 'storage',
      message: 'Agent runtime storage',
    })
    await expect(turn.finish()).rejects.toMatchObject({ code: 'storage' })
  })

  it('preserves native stop reasons and labels ACP usage as cumulative session totals', () => {
    const { turn } = fixture()
    expect(
      turn.result({
        stopReason: 'max_tokens',
        usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
      }),
    ).toMatchObject({
      outcome: 'completed',
      nativeStopReason: 'max_tokens',
      usage: { scope: 'session', inputTokens: 10, outputTokens: 2 },
    })
    expect(turn.result({ stopReason: 'cancelled' })).toMatchObject({
      outcome: 'cancelled',
      usage: null,
    })
  })
})
