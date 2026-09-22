import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  interactionRequestSchema,
  sessionEventDataSchema,
  type InteractionResponse,
} from '../../../shared/sessions/schema'
import {
  RuntimeFailure,
  type RuntimeOutput,
  type RuntimeTurnHandlers,
  type RuntimeTurnResult,
} from '../runtime'
import { RedactedTail, redactText } from '../process/redacted-tail'
import type { PiDialog, PiDialogAnswer, PiRecord } from './protocol'

const record = z.looseObject({ type: z.string() })
const content = z.looseObject({
  type: z.string(),
  text: z.string().optional(),
  thinking: z.string().optional(),
})
const message = z.looseObject({
  role: z.string(),
  content: z.union([z.string(), z.array(content)]).optional(),
})
const usage = z.looseObject({
  input: z.number().int().nonnegative().safe(),
  output: z.number().int().nonnegative().safe(),
  cacheRead: z.number().int().nonnegative().safe(),
  cacheWrite: z.number().int().nonnegative().safe(),
})
type Channel = 'assistant' | 'reasoning'
interface Block {
  channel: Channel
  text: string
  id: string
  filter: RedactedTail
}
type Tool = Extract<RuntimeOutput, { kind: 'tool.updated' }>
export const piIdleEvents = new Set([
  'entry_appended',
  'session_info_changed',
  'thinking_level_changed',
  'queue_update',
  'extension_ui_request',
])

/** Pi's acceptance response and agent_end are not completion. Only agent_settled ends a model turn. */
export class PiTurn {
  private readonly lifetime = new AbortController()
  private readonly blocks = new Map<number, Block>()
  private readonly tools = new Map<string, Tool>()
  private assistantOpen = false
  private messageCharacters = 0
  private ended = false
  private started = false
  private lastStop: string | null = null
  private hasUsage = false
  private missingUsage = false
  private inputTokens = 0
  private outputTokens = 0
  private extensionFailed = false
  private complete!: (result: RuntimeTurnResult) => void
  private reject!: (error: RuntimeFailure) => void
  readonly settled = new Promise<RuntimeTurnResult>((resolve, reject) => {
    this.complete = resolve
    this.reject = reject
  })
  cancelled = false
  constructor(
    private readonly secrets: readonly string[],
    private readonly handlers: RuntimeTurnHandlers,
  ) {
    void this.settled.catch(() => {})
  }
  cancel(): void {
    this.cancelled = true
    this.lifetime.abort()
  }
  /** Only a verified selected extension's completed command/input handler can use this path. */
  finishExtensionOnly(): void {
    if (this.started || this.ended || this.assistantOpen || this.tools.size) return
    this.ended = true
    this.lifetime.abort()
    this.complete({
      outcome: this.cancelled ? 'cancelled' : this.extensionFailed ? 'failed' : 'completed',
      nativeStopReason: 'extension-handled',
      usage: null,
    })
  }
  fail(error: RuntimeFailure): void {
    this.ended = true
    this.lifetime.abort()
    this.reject(error)
  }
  private redact(value: string) {
    return redactText(value, this.secrets)
  }
  private async emit(event: RuntimeOutput) {
    sessionEventDataSchema.parse(event)
    try {
      await this.handlers.output(event)
    } catch {
      throw new RuntimeFailure('storage')
    }
  }
  private async notice(
    code: Extract<RuntimeOutput, { kind: 'engine.notice' }>['code'],
    nativeType: string,
    text = '',
  ) {
    await this.emit({
      kind: 'engine.notice',
      code,
      nativeType: this.redact(nativeType).slice(0, 100),
      text: this.redact(text).slice(0, 65_536),
    })
  }
  private async text(block: Block, value: string) {
    for (let offset = 0; offset < value.length;) {
      let end = Math.min(offset + 32_768, value.length)
      if (end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1]!)) end--
      await this.emit({
        kind: 'message.delta',
        messageId: block.id,
        channel: block.channel,
        text: value.slice(offset, end),
      })
      offset = end
    }
  }
  private async append(index: number, channel: Channel, value: string, authoritative: boolean) {
    if (!this.assistantOpen || !Number.isSafeInteger(index) || index < 0 || index > 4095)
      throw new RuntimeFailure('protocol')
    let block = this.blocks.get(index)
    if (!block) {
      block = { channel, text: '', id: randomUUID(), filter: new RedactedTail(this.secrets) }
      this.blocks.set(index, block)
    }
    if (block.channel !== channel || (authoritative && !value.startsWith(block.text)))
      throw new RuntimeFailure('protocol')
    const suffix = authoritative ? value.slice(block.text.length) : value
    if (this.messageCharacters + suffix.length > 1_048_576) throw new RuntimeFailure('protocol')
    this.messageCharacters += suffix.length
    block.text += suffix
    await this.text(block, block.filter.push(Buffer.from(suffix)))
  }
  private async flush() {
    for (const block of this.blocks.values()) await this.text(block, block.filter.finish())
    this.blocks.clear()
    this.messageCharacters = 0
    this.assistantOpen = false
  }
  async event(event: PiRecord): Promise<void> {
    if (this.ended) throw new RuntimeFailure('protocol', 'pi.late-event')
    try {
      await this.consume(event)
    } catch (error) {
      throw error instanceof RuntimeFailure ? error : new RuntimeFailure('protocol')
    }
  }
  private async consume(event: PiRecord) {
    switch (event.type) {
      case 'agent_start':
        this.started = true
        return
      case 'message_start': {
        const value = message.parse(event.message)
        if (value.role === 'assistant') {
          if (this.assistantOpen) throw new RuntimeFailure('protocol')
          this.assistantOpen = true
        }
        return
      }
      case 'message_update': {
        const update = record.parse(event.assistantMessageEvent)
        if (['text_delta', 'thinking_delta', 'text_end', 'thinking_end'].includes(update.type)) {
          const final = update.type.endsWith('_end')
          const value = z.string().parse(final ? update.content : update.delta)
          await this.append(
            z.number().parse(update.contentIndex),
            update.type.startsWith('thinking') ? 'reasoning' : 'assistant',
            value,
            final,
          )
        } else if (
          ![
            'start',
            'done',
            'error',
            'text_start',
            'thinking_start',
            'toolcall_start',
            'toolcall_delta',
            'toolcall_end',
          ].includes(update.type)
        )
          throw new RuntimeFailure('unsupported', 'pi.message-event')
        return
      }
      case 'message_end': {
        const value = message.parse(event.message)
        if (value.role !== 'assistant') return
        if (!this.assistantOpen) throw new RuntimeFailure('protocol')
        const blocks = z.array(content).parse(value.content)
        for (const [index, part] of blocks.entries()) {
          if (part.type === 'text')
            await this.append(index, 'assistant', z.string().parse(part.text), true)
          else if (part.type === 'thinking')
            await this.append(index, 'reasoning', z.string().parse(part.thinking), true)
          else if (part.type !== 'toolCall')
            await this.notice('unsupported-output', part.type || 'content')
        }
        this.lastStop = z
          .enum(['stop', 'length', 'toolUse', 'aborted', 'error', 'deferred'])
          .parse(value.stopReason)
        const used = usage.safeParse(value.usage)
        if (
          used.success &&
          used.data.input + used.data.output + used.data.cacheRead + used.data.cacheWrite > 0
        ) {
          this.hasUsage = true
          this.inputTokens += used.data.input + used.data.cacheRead + used.data.cacheWrite
          this.outputTokens += used.data.output
          if (!Number.isSafeInteger(this.inputTokens) || !Number.isSafeInteger(this.outputTokens))
            throw new RuntimeFailure('protocol')
        } else this.missingUsage = true
        await this.flush()
        return
      }
      case 'tool_execution_start':
      case 'tool_execution_update':
      case 'tool_execution_end': {
        const id = z.string().min(1).max(1000).parse(event.toolCallId)
        const name = z.string().min(1).max(1000).parse(event.toolName)
        const previous = this.tools.get(id)
        if (event.type === 'tool_execution_start' ? previous !== undefined : previous === undefined)
          throw new RuntimeFailure('protocol')
        if (this.tools.size >= 2000 && !previous) throw new RuntimeFailure('protocol')
        if (previous && ['completed', 'failed'].includes(previous.status))
          throw new RuntimeFailure('protocol')
        const payload =
          event.type === 'tool_execution_start'
            ? event.args
            : event.type === 'tool_execution_update'
              ? event.partialResult
              : event.result
        const text = this.redact(JSON.stringify(payload) ?? '')
        const tool: Tool = {
          kind: 'tool.updated',
          toolCallId: previous?.toolCallId ?? randomUUID(),
          title: this.redact(name).slice(0, 1000),
          status:
            event.type === 'tool_execution_end'
              ? z.boolean().parse(event.isError)
                ? 'failed'
                : 'completed'
              : 'running',
          content: text.slice(0, 65_536),
          contentTruncated: text.length > 65_536,
        }
        this.tools.set(id, tool)
        await this.emit(tool)
        return
      }
      case 'agent_settled': {
        if (!this.started || this.assistantOpen || (!this.lastStop && !this.cancelled))
          throw new RuntimeFailure('protocol')
        if ([...this.tools.values()].some((tool) => tool.status === 'running'))
          throw new RuntimeFailure('protocol')
        this.ended = true
        this.lifetime.abort()
        this.complete({
          outcome:
            this.lastStop === 'aborted' || (!this.lastStop && this.cancelled)
              ? 'cancelled'
              : this.extensionFailed || this.lastStop === 'error' || this.lastStop === 'deferred'
                ? 'failed'
                : 'completed',
          nativeStopReason: this.lastStop,
          usage:
            this.hasUsage && !this.missingUsage
              ? {
                  scope: 'turn',
                  inputTokens: this.inputTokens,
                  outputTokens: this.outputTokens,
                  cost: null,
                }
              : null,
        })
        return
      }
      case 'auto_retry_start':
      case 'auto_retry_end':
      case 'summarization_retry_scheduled':
      case 'summarization_retry_attempt_start':
      case 'summarization_retry_finished':
        await this.notice('retry', event.type)
        return
      case 'compaction_start':
      case 'compaction_end':
        await this.notice('compaction', event.type)
        return
      case 'extension_error':
        this.extensionFailed = true
        await this.notice('extension', event.type)
        return
      case 'extension_ui_request':
        await this.notice(
          'notification',
          `extension_ui_request.${String(event.method)}`,
          typeof event.message === 'string'
            ? event.message
            : typeof event.text === 'string'
              ? event.text
              : '',
        )
        return
      case 'queue_update':
        if (
          z.array(z.string()).parse(event.steering).length ||
          z.array(z.string()).parse(event.followUp).length
        )
          throw new RuntimeFailure('unsupported', 'pi.queued-continuation')
        return
      case 'agent_end':
      case 'turn_start':
      case 'turn_end':
      case 'entry_appended':
      case 'session_info_changed':
      case 'thinking_level_changed':
        return
      default:
        throw new RuntimeFailure('unsupported', 'pi.event')
    }
  }
  async dialog(dialog: PiDialog, signal: AbortSignal): Promise<PiDialogAnswer> {
    const lifetime = AbortSignal.any([signal, this.lifetime.signal])
    if (this.ended || lifetime.aborted) return { cancelled: true }
    const common = {
      id: randomUUID(),
      title: this.redact(dialog.title).slice(0, 1000),
      deadlineAt: new Date(Date.now() + Math.min(dialog.timeout ?? 120_000, 120_000)).toISOString(),
    }
    const options =
      dialog.method === 'select'
        ? dialog.options.map((label) => ({
            id: randomUUID(),
            label: this.redact(label).slice(0, 1000),
          }))
        : []
    if (dialog.method === 'editor' && this.redact(dialog.prefill ?? '') !== (dialog.prefill ?? ''))
      throw new RuntimeFailure('unsupported', 'pi.redacted-prefill')
    const request = interactionRequestSchema.parse(
      dialog.method === 'select'
        ? { ...common, kind: 'select', options }
        : dialog.method === 'confirm'
          ? { ...common, kind: 'confirm', message: this.redact(dialog.message) }
          : {
              ...common,
              kind: 'input',
              message: '',
              placeholder:
                dialog.method === 'input'
                  ? this.redact(dialog.placeholder ?? '').slice(0, 1000)
                  : '',
              multiline: dialog.method === 'editor',
              ...(dialog.method === 'editor' ? { initialValue: dialog.prefill ?? '' } : {}),
            },
    )
    let abort = () => {}
    let answer: InteractionResponse
    try {
      answer = await Promise.race([
        Promise.resolve().then(() =>
          lifetime.aborted
            ? { kind: 'cancelled' as const }
            : this.handlers.interaction(request, lifetime),
        ),
        new Promise<InteractionResponse>((resolve) => {
          abort = () => resolve({ kind: 'cancelled' })
          if (lifetime.aborted) abort()
          else lifetime.addEventListener('abort', abort, { once: true })
        }),
      ])
    } catch {
      throw new RuntimeFailure('storage')
    } finally {
      lifetime.removeEventListener('abort', abort)
    }
    if (this.ended || lifetime.aborted || answer.kind === 'cancelled') return { cancelled: true }
    if (dialog.method === 'select' && answer.kind === 'choice') {
      const index = options.findIndex((option) => option.id === answer.optionId)
      return index < 0 ? { cancelled: true } : { value: dialog.options[index]! }
    }
    if (dialog.method === 'confirm' && answer.kind === 'confirm')
      return { confirmed: answer.accepted }
    if ((dialog.method === 'input' || dialog.method === 'editor') && answer.kind === 'input')
      return { value: answer.value }
    return { cancelled: true }
  }
}
