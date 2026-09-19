import { z } from 'zod'

export const mcpConnectionStatusSchema = z.enum([
  'connected',
  'disabled',
  'failed',
  'authentication-required',
  'registration-required',
  'unknown',
])
export type McpConnectionStatus = z.infer<typeof mcpConnectionStatusSchema>

/** Entries follow the immutable manifest's MCP order. No native names, errors or headers. */
export const mcpObservationSchema = z
  .object({
    source: z.literal('opencode-acp'),
    checkedAt: z.iso.datetime(),
    statuses: z.array(mcpConnectionStatusSchema).min(1).max(200),
  })
  .strict()
export type McpObservation = z.infer<typeof mcpObservationSchema>
export interface McpReport {
  source: McpObservation['source'] | 'unknown'
  checkedAt: string | null
  entries: {
    slot: number
    name: string
    transport: 'stdio' | 'streamable-http' | 'legacy-sse'
    status: McpConnectionStatus
  }[]
}
