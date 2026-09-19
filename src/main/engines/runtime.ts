import type {
  InteractionRequest,
  InteractionResponse,
  SessionEventData,
} from '../../shared/sessions/schema'
import type { ProcessResult } from './process/managed-process'
import type { ConfigurationCheck } from '../../shared/engines/configuration-report'
import type { CredentialResolution } from '../../shared/engines/credential-observation'
import type { NativeRuntimeObservation } from '../../shared/engines/session-capabilities'

export type RuntimeOutput = Extract<
  SessionEventData,
  { kind: 'message.delta' | 'tool.updated' | 'engine.notice' }
>
export type RuntimePermission = Extract<InteractionRequest, { kind: 'permission' }>
export interface RuntimeTurnHandlers {
  output(event: RuntimeOutput): Promise<void>
  interaction(request: InteractionRequest, signal: AbortSignal): Promise<InteractionResponse>
}
export type RuntimeTurnResult = Pick<
  Extract<SessionEventData, { kind: 'turn.finished' }>,
  'outcome' | 'nativeStopReason' | 'usage'
>
export interface RuntimeSession {
  readonly configurationChecks?: ConfigurationCheck[]
  readonly credentialResolutions?: CredentialResolution[]
  readonly nativeRuntime?: NativeRuntimeObservation
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
