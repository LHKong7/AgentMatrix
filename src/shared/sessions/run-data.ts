import { z } from 'zod'
import { entityId } from '../engines/schema'

export const runDataIdentitySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('capture'), id: entityId }).strict(),
  z.object({ kind: z.literal('stage'), id: z.uuid() }).strict(),
])
export const runDataRemovalSchema = z
  .object({
    target: runDataIdentitySchema,
    token: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
export const runDataQuerySchema = z
  .object({
    after: z
      .string()
      .max(110)
      .regex(/^(capture|stage):[a-zA-Z0-9_-]+$/)
      .optional(),
  })
  .strict()
export type RunDataIdentity = z.infer<typeof runDataIdentitySchema>
export type RunDataRemoval = z.infer<typeof runDataRemovalSchema>
export type RunDataQuery = z.infer<typeof runDataQuerySchema>
export interface UnusedRunData extends RunDataRemoval {
  capture?: { agent: string; engine: string; cwd: string }
  modifiedAt: string | null
  pending: boolean
}
export interface UnusedRunDataPage {
  items: UnusedRunData[]
  next: string | null
  skipped: number
}
