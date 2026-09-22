import { randomUUID } from 'node:crypto'
import type {
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
  ToolCallUpdate,
} from '@agentclientprotocol/sdk'
import {
  sessionEventDataSchema,
  interactionRequestSchema,
  type InteractionResponse,
} from '../../../shared/sessions/schema'
import { RedactedTail } from '../process/redacted-tail'
import {
  RuntimeFailure,
  type RuntimeOutput,
  type RuntimeTurnHandlers,
  type RuntimeTurnResult,
} from '../runtime'

type ToolEvent = Extract<RuntimeOutput, { kind: 'tool.updated' }>
const cancelled = (): RequestPermissionResponse => ({ outcome: { outcome: 'cancelled' } })

/** One turn's native IDs, output redactors, and permission choices never escape their scope. */
export class AcpTurn {
  private readonly streams: { assistant: RedactedTail; reasoning: RedactedTail }
  private readonly messageIds = { assistant: randomUUID(), reasoning: randomUUID() }
  private readonly tools = new Map<string, ToolEvent>()
  private events: Promise<void> = Promise.resolve()
  private readonly lifecycle = new AbortController()
  private ended = false
  constructor(
    readonly nativeSessionId: string,
    private readonly secrets: readonly string[],
    private readonly handlers: RuntimeTurnHandlers,
  ) {
    this.streams = { assistant: new RedactedTail(secrets), reasoning: new RedactedTail(secrets) }
  }

  redact(value: string): string {
    const filter = new RedactedTail(this.secrets)
    return filter.push(Buffer.from(value)) + filter.finish()
  }
  private emit(event: RuntimeOutput): Promise<void> {
    const operation = this.events.then(async () => {
      sessionEventDataSchema.parse(event)
      try {
        await this.handlers.output(event)
      } catch {
        throw new RuntimeFailure('storage')
      }
    })
    this.events = operation
    void operation.catch(() => {})
    return operation
  }
  private async text(channel: 'assistant' | 'reasoning', value: string) {
    // Bound each journal event independently of the native frame size.
    for (let offset = 0; offset < value.length;) {
      let end = Math.min(offset + 32_768, value.length)
      if (end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1]!)) end--
      await this.emit({
        kind: 'message.delta',
        messageId: this.messageIds[channel],
        channel,
        text: value.slice(offset, end),
      })
      offset = end
    }
  }
  async update(notification: SessionNotification): Promise<void> {
    if (this.ended || notification.sessionId !== this.nativeSessionId) return
    const update = notification.update
    if (
      update.sessionUpdate === 'agent_message_chunk' ||
      update.sessionUpdate === 'agent_thought_chunk'
    ) {
      if (update.content.type !== 'text') return
      const channel = update.sessionUpdate === 'agent_message_chunk' ? 'assistant' : 'reasoning'
      await this.text(channel, this.streams[channel].push(Buffer.from(update.content.text)))
    } else if (
      update.sessionUpdate === 'tool_call' ||
      update.sessionUpdate === 'tool_call_update'
    ) {
      await this.tool(update)
    }
  }
  private async tool(update: ToolCallUpdate): Promise<ToolEvent> {
    let previous = this.tools.get(update.toolCallId)
    if (!previous) {
      if (this.tools.size >= 2000) throw new RuntimeFailure('protocol', 'tools.limit')
      previous = {
        kind: 'tool.updated',
        toolCallId: randomUUID(),
        title: '',
        status: 'pending',
        content: null,
      }
    }
    const parts: string[] = []
    if (update.rawInput !== undefined) parts.push(JSON.stringify(update.rawInput))
    if (update.rawOutput !== undefined) parts.push(JSON.stringify(update.rawOutput))
    for (const item of update.content ?? []) {
      if (item.type === 'content' && item.content.type === 'text') parts.push(item.content.text)
      else if (item.type === 'diff')
        parts.push(`${item.path}\n${item.oldText ?? ''}\n${item.newText}`)
    }
    const replaced = parts.length > 0 || (update.content !== undefined && update.content !== null)
    const content = replaced ? this.redact(parts.join('\n')) : previous.content
    const event: ToolEvent = {
      ...previous,
      title:
        update.title === null || update.title === undefined
          ? previous.title
          : this.redact(update.title).slice(0, 1000),
      status: update.status === 'in_progress' ? 'running' : (update.status ?? previous.status),
      content: content?.slice(0, 65_536) ?? null,
      contentTruncated: replaced
        ? content !== null && content.length > 65_536
        : (previous.contentTruncated ?? false),
    }
    this.tools.set(update.toolCallId, event)
    await this.emit(event)
    return event
  }
  async permission(
    request: RequestPermissionRequest,
    signal: AbortSignal,
  ): Promise<RequestPermissionResponse> {
    if (this.ended || signal.aborted || request.sessionId !== this.nativeSessionId)
      return cancelled()
    const tool = await this.tool(request.toolCall)
    if (this.ended || signal.aborted) return cancelled()
    const choices = request.options.map((option) => ({
      id: randomUUID(),
      label: this.redact(option.name).slice(0, 1000),
      kind: option.kind,
    }))
    const mapped = interactionRequestSchema.parse({
      kind: 'permission',
      id: randomUUID(),
      title: tool.title,
      toolCallId: tool.toolCallId,
      deadlineAt: new Date(Date.now() + 120_000).toISOString(),
      options: choices,
    })
    if (mapped.kind !== 'permission') throw new RuntimeFailure('protocol')
    const lifetime = AbortSignal.any([signal, this.lifecycle.signal])
    let abort = () => {}
    let answer: InteractionResponse | null
    try {
      answer = await Promise.race([
        Promise.resolve().then(() =>
          lifetime.aborted ? null : this.handlers.interaction(mapped, lifetime),
        ),
        new Promise<null>((resolve) => {
          abort = () => resolve(null)
          if (lifetime.aborted) abort()
          else lifetime.addEventListener('abort', abort, { once: true })
        }),
      ])
    } catch {
      throw new RuntimeFailure('storage')
    } finally {
      lifetime.removeEventListener('abort', abort)
    }
    if (this.ended || lifetime.aborted || answer?.kind !== 'choice') return cancelled()
    const index = choices.findIndex((choice) => choice.id === answer.optionId)
    return index < 0
      ? cancelled()
      : { outcome: { outcome: 'selected', optionId: request.options[index]!.optionId } }
  }
  async finish(): Promise<void> {
    if (this.ended) return
    this.ended = true
    this.lifecycle.abort()
    await this.text('assistant', this.streams.assistant.finish())
    await this.text('reasoning', this.streams.reasoning.finish())
    await this.events
  }
  result(response: PromptResponse): RuntimeTurnResult {
    const usage = response.usage
      ? {
          scope: 'session' as const,
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
          cost: null,
        }
      : null
    const event = sessionEventDataSchema.parse({
      kind: 'turn.finished',
      outcome: response.stopReason === 'cancelled' ? 'cancelled' : 'completed',
      nativeStopReason: response.stopReason,
      usage,
      failure: null,
    })
    if (event.kind !== 'turn.finished') throw new RuntimeFailure('protocol')
    return { outcome: event.outcome, nativeStopReason: event.nativeStopReason, usage: event.usage }
  }
}
