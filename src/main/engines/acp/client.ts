import {
  client,
  RequestError,
  type ClientConnection,
  type InitializeResponse,
  type LoadSessionRequest,
  type NewSessionRequest,
  type PromptRequest,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type ResumeSessionRequest,
  type SessionNotification,
  type AgentRequestMethod,
  type AgentRequestParamsByMethod,
  type AgentRequestResponsesByMethod,
} from '@agentclientprotocol/sdk'
import { AcpFailure, boundedAcpStream } from './stream'

export interface AcpHandlers {
  update: (notification: SessionNotification, signal: AbortSignal) => Promise<void>
  permission: (
    request: RequestPermissionRequest,
    signal: AbortSignal,
  ) => Promise<RequestPermissionResponse>
}
interface PermissionWait {
  sessionId: string
  abort: AbortController
}
export interface AcpLimits {
  requestTimeoutMs: number
  permissionTimeoutMs: number
  pendingRequests: number
  pendingPermissions: number
  pendingUpdates: number
  pendingUpdateBytes: number
}
const defaultLimits: AcpLimits = {
  requestTimeoutMs: 30_000,
  permissionTimeoutMs: 120_000,
  pendingRequests: 8,
  pendingPermissions: 100,
  pendingUpdates: 256,
  pendingUpdateBytes: 4_194_304,
}
const cancelled = (): RequestPermissionResponse => ({ outcome: { outcome: 'cancelled' } })

/** Main-process ACP mechanics. Native capabilities are advertisements, not runtime evidence. */
export class AcpClient {
  private readonly connection: ClientConnection
  private readonly disposeTransport: () => Promise<void>
  private readonly limits: AcpLimits
  private failure: AcpFailure | null = null
  private initializing = false
  private initialized: InitializeResponse | null = null
  private requests = 0
  private updateCount = 0
  private updateBytes = 0
  private updates: Promise<void> = Promise.resolve()
  private readonly permissions = new Set<PermissionWait>()
  private readonly lifecycle = new AbortController()
  private readonly activePrompts = new Set<string>()
  private readonly cancelledSessions = new Set<string>()

  constructor(
    input: ReadableStream<Uint8Array>,
    output: WritableStream<Uint8Array>,
    private readonly handlers: AcpHandlers,
    limits: Partial<AcpLimits> = {},
  ) {
    this.limits = { ...defaultLimits, ...limits }
    for (const value of Object.values(this.limits))
      if (!Number.isSafeInteger(value) || value <= 0) throw new AcpFailure('invalid-state')
    const transport = boundedAcpStream(input, output)
    this.disposeTransport = transport.dispose
    this.connection = client({ name: 'agentmatrix' })
      .onNotification('session/update', ({ params }) => this.receiveUpdate(params))
      .onRequest('session/request_permission', ({ params, signal }) =>
        this.receivePermission(params, signal),
      )
      .connect(transport.stream)
    this.connection.signal.addEventListener(
      'abort',
      () => {
        this.failure ??=
          this.connection.signal.reason instanceof AcpFailure
            ? this.connection.signal.reason
            : new AcpFailure('closed')
        this.lifecycle.abort(this.failure)
        for (const pending of this.permissions) pending.abort.abort()
        void this.disposeTransport()
      },
      { once: true },
    )
  }

  get signal(): AbortSignal {
    return this.lifecycle.signal
  }
  get closed(): Promise<void> {
    return this.connection.closed
  }
  get capabilities(): InitializeResponse | null {
    return this.initialized ? structuredClone(this.initialized) : null
  }

  close(reason = new AcpFailure('closed')): void {
    if (this.signal.aborted) return
    this.failure = reason
    this.connection.close(reason)
  }

  async initialize(version: string): Promise<InitializeResponse> {
    if (this.initialized || this.initializing) throw new AcpFailure('invalid-state')
    this.initializing = true
    try {
      const response = await this.request('initialize', {
        protocolVersion: 1,
        clientInfo: { name: 'agentmatrix', title: 'AgentMatrix', version },
        // No fs, terminal, auth terminal, or elicitation services are implemented.
        clientCapabilities: {},
      })
      if (response.protocolVersion !== 1) {
        const failure = new AcpFailure('unsupported')
        this.close(failure)
        throw failure
      }
      this.initialized = response
      return structuredClone(response)
    } catch (error) {
      this.close(error instanceof AcpFailure ? error : new AcpFailure('protocol'))
      throw error
    } finally {
      this.initializing = false
    }
  }

  private ready() {
    if (!this.initialized || this.signal.aborted)
      throw this.failure ?? new AcpFailure('invalid-state')
  }
  newSession(params: NewSessionRequest) {
    this.ready()
    return this.request('session/new', params)
  }
  listSessions(params: AgentRequestParamsByMethod['session/list']) {
    this.ready()
    if (!this.initialized?.agentCapabilities?.sessionCapabilities?.list)
      throw new AcpFailure('unsupported')
    return this.request('session/list', params)
  }
  setSessionConfigOption(params: AgentRequestParamsByMethod['session/set_config_option']) {
    this.ready()
    return this.request('session/set_config_option', params)
  }
  async prompt(params: PromptRequest, timeoutMs: number) {
    this.ready()
    if (this.activePrompts.has(params.sessionId)) throw new AcpFailure('invalid-state')
    this.activePrompts.add(params.sessionId)
    this.cancelledSessions.delete(params.sessionId)
    try {
      return await this.request('session/prompt', params, timeoutMs)
    } finally {
      this.activePrompts.delete(params.sessionId)
      this.cancelledSessions.delete(params.sessionId)
      this.cancelPermissions(params.sessionId)
    }
  }
  loadSession(params: LoadSessionRequest) {
    this.ready()
    if (!this.initialized?.agentCapabilities?.loadSession) throw new AcpFailure('unsupported')
    return this.request('session/load', params)
  }
  resumeSession(params: ResumeSessionRequest) {
    this.ready()
    if (!this.initialized?.agentCapabilities?.sessionCapabilities?.resume)
      throw new AcpFailure('unsupported')
    return this.request('session/resume', params)
  }
  closeSession(sessionId: string) {
    this.ready()
    if (!this.initialized?.agentCapabilities?.sessionCapabilities?.close)
      throw new AcpFailure('unsupported')
    if (this.activePrompts.has(sessionId)) this.cancelledSessions.add(sessionId)
    this.cancelPermissions(sessionId)
    return this.request('session/close', { sessionId })
  }
  async cancel(sessionId: string): Promise<void> {
    this.ready()
    if (this.activePrompts.has(sessionId)) this.cancelledSessions.add(sessionId)
    this.cancelPermissions(sessionId)
    // This is a notification. The prompt response determines when cancellation actually finishes.
    try {
      await this.connection.agent.notify('session/cancel', { sessionId })
    } catch {
      throw this.failure ?? new AcpFailure('closed')
    }
  }
  private cancelPermissions(sessionId: string) {
    for (const pending of this.permissions)
      if (pending.sessionId === sessionId) pending.abort.abort()
  }

  private async request<M extends AgentRequestMethod>(
    method: M,
    params: AgentRequestParamsByMethod[M],
    timeoutMs = this.limits.requestTimeoutMs,
  ): Promise<AgentRequestResponsesByMethod[M]> {
    if (this.signal.aborted) throw this.failure ?? new AcpFailure('closed')
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 86_400_000)
      throw new AcpFailure('invalid-state')
    if (this.requests >= this.limits.pendingRequests) throw new AcpFailure('overload')
    this.requests++
    const timer = setTimeout(() => this.close(new AcpFailure('timeout')), timeoutMs)
    let aborted = () => {}
    const closed = new Promise<never>((_resolve, reject) => {
      aborted = () => reject(this.failure ?? new AcpFailure('closed'))
      this.signal.addEventListener('abort', aborted, { once: true })
    })
    try {
      const operation = async () => {
        const response = await this.connection.agent.request(method, params)
        await this.updates
        if (this.signal.aborted) throw this.failure ?? new AcpFailure('closed')
        return response
      }
      return await Promise.race([operation(), closed])
    } catch (error) {
      if (error instanceof AcpFailure) throw error
      if (error instanceof RequestError) throw new AcpFailure('engine', error.code)
      throw this.failure ?? new AcpFailure(this.signal.aborted ? 'closed' : 'protocol')
    } finally {
      clearTimeout(timer)
      this.signal.removeEventListener('abort', aborted)
      this.requests--
    }
  }

  private receiveUpdate(notification: SessionNotification): Promise<void> {
    if (this.signal.aborted) return Promise.resolve()
    const bytes = Buffer.byteLength(JSON.stringify(notification))
    if (
      this.updateCount >= this.limits.pendingUpdates ||
      this.updateBytes + bytes > this.limits.pendingUpdateBytes
    ) {
      this.close(new AcpFailure('overload'))
      return Promise.resolve()
    }
    this.updateCount++
    this.updateBytes += bytes
    const task = this.updates
      .then(async () => {
        if (!this.signal.aborted) await this.handlers.update(notification, this.signal)
      })
      .catch(() => this.close(new AcpFailure('protocol')))
      .finally(() => {
        this.updateCount--
        this.updateBytes -= bytes
      })
    this.updates = task
    return task
  }

  private async receivePermission(
    request: RequestPermissionRequest,
    signal: AbortSignal,
  ): Promise<RequestPermissionResponse> {
    if (
      this.signal.aborted ||
      !this.activePrompts.has(request.sessionId) ||
      this.cancelledSessions.has(request.sessionId) ||
      this.permissions.size >= this.limits.pendingPermissions ||
      request.options.length === 0 ||
      request.options.length > 100 ||
      new Set(request.options.map((option) => option.optionId)).size !== request.options.length
    )
      return cancelled()
    const pending = { sessionId: request.sessionId, abort: new AbortController() }
    const abort = () => pending.abort.abort()
    signal.addEventListener('abort', abort, { once: true })
    this.permissions.add(pending)
    if (signal.aborted) abort()
    const timer = setTimeout(
      () => pending.abort.abort(new AcpFailure('timeout')),
      this.limits.permissionTimeoutMs,
    )
    let cancelledBySignal = () => {}
    try {
      const result = await Promise.race([
        Promise.resolve().then(() =>
          pending.abort.signal.aborted
            ? cancelled()
            : this.handlers.permission(request, pending.abort.signal),
        ),
        new Promise<RequestPermissionResponse>((resolve) => {
          cancelledBySignal = () => resolve(cancelled())
          if (pending.abort.signal.aborted) resolve(cancelled())
          else
            pending.abort.signal.addEventListener('abort', cancelledBySignal, {
              once: true,
            })
        }),
      ])
      if (pending.abort.signal.aborted || !result?.outcome) return cancelled()
      const outcome = result.outcome
      if (
        outcome.outcome === 'selected' &&
        request.options.some((option) => option.optionId === outcome.optionId)
      )
        return result
      return cancelled()
    } catch {
      return cancelled()
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      pending.abort.signal.removeEventListener('abort', cancelledBySignal)
      this.permissions.delete(pending)
    }
  }
}
