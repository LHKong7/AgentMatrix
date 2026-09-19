import { z } from 'zod'

export const mcpConnectionStatusSchema = z.enum([
  'connected',
  'disabled',
  'failed',
  'authentication-required',
  'registration-required',
  'unknown',
  'startup-complete',
])
export type McpConnectionStatus = z.infer<typeof mcpConnectionStatusSchema>

/** Entries follow the immutable manifest's MCP order. No native names, errors or headers. */
export const mcpObservationSchema = z.discriminatedUnion('source', [
  z
    .object({
      source: z.literal('opencode-acp'),
      checkedAt: z.iso.datetime(),
      statuses: z
        .array(mcpConnectionStatusSchema.exclude(['startup-complete']))
        .min(1)
        .max(200),
    })
    .strict(),
  z
    .object({
      source: z.literal('dsh-mcp-startup'),
      checkedAt: z.iso.datetime(),
      statuses: z.array(z.literal('startup-complete')).min(1).max(200),
    })
    .strict(),
])
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
