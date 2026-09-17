import type { InteractionRequest, SessionEventData } from '../../shared/sessions/schema'
import type { ProcessResult } from './process/managed-process'

export type RuntimeOutput = Extract<SessionEventData, { kind: 'message.delta' | 'tool.updated' }>
export type RuntimePermission = Extract<InteractionRequest, { kind: 'permission' }>
export interface RuntimeTurnHandlers {
  output(event: RuntimeOutput): Promise<void>
  permission(request: RuntimePermission, signal: AbortSignal): Promise<string | null>
}
export type RuntimeTurnResult = Pick<
  Extract<SessionEventData, { kind: 'turn.finished' }>,
  'outcome' | 'nativeStopReason' | 'usage'
>
export interface RuntimeSession {
  readonly nativeSessionId: string
  readonly closed: Promise<ProcessResult>
  redact(text: string): string
  send(text: string, handlers: RuntimeTurnHandlers): Promise<RuntimeTurnResult>
  cancel(): Promise<void>
  dispose(): Promise<ProcessResult>
}
export class RuntimeFailure extends Error {
  constructor(
    readonly code:
      | 'configuration'
      | 'credentials'
      | 'unsupported'
      | 'protocol'
      | 'timeout'
      | 'process-exit'
      | 'engine'
      | 'storage',
    readonly field = '',
  ) {
    super(`Agent runtime ${code}${field ? ` (${field})` : ''}`)
  }
}
