import { z } from 'zod'
import type {
  McpObservation,
  McpConnectionStatus,
} from '../../../../shared/engines/mcp-observation'
import type { prepareOpenCodeInstanceHttp } from './instance-http'

/** A native status sample at attachment, not a tool probe or continuing liveness guarantee. */
export async function observeOpenCodeMcp(
  instance: Awaited<ReturnType<typeof prepareOpenCodeInstanceHttp>>,
  serverIds: string[],
  pid: number | undefined,
  signal: AbortSignal,
  sessionId: string,
): Promise<McpObservation> {
  const statuses = await instance.observe(pid, signal, sessionId, async (read) => {
    const actual = z.record(z.string(), z.unknown()).parse(await read('/mcp'))
    return serverIds.map((id): Exclude<McpConnectionStatus, 'startup-complete'> => {
      const entry = actual[`agentmatrix-${id}`]
      const status = z.object({ status: z.string() }).safeParse(entry)
      if (!status.success) return 'unknown'
      switch (status.data.status) {
        case 'connected':
          return 'connected'
        case 'disabled':
          return 'disabled'
        case 'failed':
          return 'failed'
        case 'needs_auth':
          return 'authentication-required'
        case 'needs_client_registration':
          return 'registration-required'
        default:
          return 'unknown'
      }
    })
  })
  return {
    source: 'opencode-acp',
    checkedAt: new Date().toISOString(),
    statuses: statuses ?? serverIds.map(() => 'unknown'),
  }
}
