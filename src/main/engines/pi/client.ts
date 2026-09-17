import { randomUUID } from 'node:crypto'
import {
  PiFailure,
  piFrameLimit,
  piDialogSchema,
  readPiRecords,
  validDialogAnswer,
  type PiCommand,
  type PiDialog,
  type PiDialogAnswer,
  type PiRecord,
} from './protocol'

export interface PiHandlers {
  /** Persist/normalize events in order; do not wait for user input in this callback. */
  event(record: PiRecord, signal: AbortSignal): Promise<void>
  /** Extension dialogs are separate from tool permissions and never imply a sandbox. */
  dialog(request: PiDialog, signal: AbortSignal): Promise<PiDialogAnswer>
}
interface PiLimits {
  requestTimeoutMs: number
  dialogTimeoutMs: number
  pendingRequests: number
  pendingEvents: number
  pendingEventBytes: number
  pendingDialogs: number
}
interface Pending {
  command: string
  received: boolean
  resolve(value: unknown): void
  reject(error: PiFailure): void
  timer: ReturnType<typeof setTimeout>
}

/** Main-process Pi 0.85.1 RPC mechanics. A prompt response is acceptance, not completion. */
export class PiClient {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>
  private readonly writer: WritableStreamDefaultWriter<Uint8Array>
  private readonly lifecycle = new AbortController()
  private readonly pending = new Map<string, Pending>()
  private readonly dialogs = new Map<string, AbortController>()
  private readonly limits: PiLimits
  private events: Promise<void> = Promise.resolve()
  private writes: Promise<void> = Promise.resolve()
  private eventCount = 0
  private eventBytes = 0
  private failure: PiFailure | null = null
  private finish!: () => void
  readonly closed = new Promise<void>((resolve) => {
    this.finish = resolve
  })

  constructor(
    input: ReadableStream<Uint8Array>,
    output: WritableStream<Uint8Array>,
    private readonly handlers: PiHandlers,
    limits: Partial<PiLimits> = {},
  ) {
    this.limits = {
      requestTimeoutMs: 30_000,
      dialogTimeoutMs: 120_000,
      pendingRequests: 8,
      pendingEvents: 256,
      pendingEventBytes: 4_194_304,
      pendingDialogs: 32,
      ...limits,
    }
    if (
      Object.values(this.limits).some(
        (value) => !Number.isSafeInteger(value) || value <= 0 || value > 86_400_000,
      )
    )
      throw new PiFailure('invalid-state')
    this.reader = input.getReader()
    this.writer = output.getWriter()
    void readPiRecords(this.reader, (record, bytes) => this.receive(record, bytes)).then(
      () => this.close(),
      (error) => this.close(error instanceof PiFailure ? error : new PiFailure('closed')),
    )
  }
  get signal(): AbortSignal {
    return this.lifecycle.signal
  }
  close(reason = new PiFailure('closed')): void {
    if (this.failure) return
    this.failure = reason
    this.lifecycle.abort(reason)
    for (const dialog of this.dialogs.values()) dialog.abort()
    for (const request of this.pending.values()) {
      clearTimeout(request.timer)
      request.reject(reason)
    }
    this.pending.clear()
    this.finish()
    void Promise.allSettled([this.reader.cancel(), this.writer.abort()])
  }

  request(command: PiCommand, timeoutMs = this.limits.requestTimeoutMs): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure)
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 86_400_000)
      return Promise.reject(new PiFailure('invalid-state'))
    if (this.pending.size >= this.limits.pendingRequests)
      return Promise.reject(new PiFailure('overload'))
    if (['abort', 'new_session', 'switch_session'].includes(command.type))
      for (const dialog of this.dialogs.values()) dialog.abort()
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      this.pending.set(id, {
        command: command.type,
        received: false,
        resolve,
        reject,
        timer: setTimeout(() => this.close(new PiFailure('timeout')), timeoutMs),
      })
      void this.write({ ...command, id }).catch((error) =>
        this.close(error instanceof PiFailure ? error : new PiFailure('closed')),
      )
    })
  }

  private write(record: object | (() => object)): Promise<void> {
    if (this.failure) return Promise.reject(this.failure)
    const operation = this.writes.then(async () => {
      if (this.failure) throw this.failure
      let encoded: Uint8Array
      try {
        encoded = new TextEncoder().encode(
          JSON.stringify(typeof record === 'function' ? record() : record) + '\n',
        )
      } catch {
        throw new PiFailure('protocol')
      }
      if (encoded.length - 1 > piFrameLimit) throw new PiFailure('protocol')
      await this.writer.write(encoded)
    })
    this.writes = operation.catch(() => {})
    return operation
  }

  private receive(record: PiRecord, bytes: number): void {
    if (this.failure) return
    if (record.type === 'response') {
      const request = typeof record.id === 'string' ? this.pending.get(record.id) : undefined
      if (
        !request ||
        request.received ||
        record.command !== request.command ||
        typeof record.success !== 'boolean' ||
        (!record.success && typeof record.error !== 'string')
      )
        throw new PiFailure('protocol')
      request.received = true
      // A response is observable only after all earlier events have been persisted.
      void this.events.then(() => {
        if (this.failure) return
        clearTimeout(request.timer)
        this.pending.delete(record.id as string)
        if (record.success) request.resolve(record.data)
        else request.reject(new PiFailure('engine'))
      })
      return
    }
    if (
      record.type === 'extension_ui_request' &&
      ['select', 'confirm', 'input', 'editor'].includes(String(record.method))
    ) {
      const parsed = piDialogSchema.safeParse(record)
      if (!parsed.success) throw new PiFailure('protocol')
      if (this.dialogs.has(parsed.data.id)) throw new PiFailure('protocol')
      if (this.dialogs.size >= this.limits.pendingDialogs) throw new PiFailure('overload')
      this.receiveDialog(parsed.data)
      return
    }
    if (
      record.type === 'extension_ui_request' &&
      !['notify', 'setStatus', 'setWidget', 'setTitle', 'set_editor_text'].includes(
        String(record.method),
      )
    )
      throw new PiFailure('protocol')
    if (
      this.eventCount >= this.limits.pendingEvents ||
      this.eventBytes + bytes > this.limits.pendingEventBytes
    )
      throw new PiFailure('overload')
    this.eventCount++
    this.eventBytes += bytes
    this.events = this.events
      .then(async () => {
        if (!this.failure) await this.handlers.event(record, this.signal)
      })
      .catch(() => this.close(new PiFailure('protocol')))
      .finally(() => {
        this.eventCount--
        this.eventBytes -= bytes
      })
  }

  private receiveDialog(dialog: PiDialog): void {
    const abort = new AbortController()
    this.dialogs.set(dialog.id, abort)
    const timer = setTimeout(
      () => abort.abort(),
      Math.min(dialog.timeout ?? Infinity, this.limits.dialogTimeoutMs),
    )
    let remove = () => {}
    const cancelled = new Promise<PiDialogAnswer>((resolve) => {
      const listener = () => resolve({ cancelled: true })
      abort.signal.addEventListener('abort', listener, { once: true })
      remove = () => abort.signal.removeEventListener('abort', listener)
    })
    const operation = this.events.then(() =>
      abort.signal.aborted
        ? { cancelled: true as const }
        : this.handlers.dialog(dialog, abort.signal),
    )
    void (async () => {
      try {
        const answer = await Promise.race([operation, cancelled])
        if (this.failure) return
        const finalAnswer = abort.signal.aborted ? { cancelled: true as const } : answer
        if (!validDialogAnswer(dialog, finalAnswer)) throw new PiFailure('protocol')
        await this.write(() => ({
          type: 'extension_ui_response',
          id: dialog.id,
          ...(abort.signal.aborted ? { cancelled: true } : finalAnswer),
        }))
      } catch {
        this.close(new PiFailure('protocol'))
      } finally {
        clearTimeout(timer)
        remove()
        abort.abort()
        this.dialogs.delete(dialog.id)
      }
    })()
  }
}
