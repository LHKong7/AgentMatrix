import { z } from 'zod'

/** Random storage-version identifiers are not hashes of credential values. */
export const credentialVersionSchema = z.discriminatedUnion('source', [
  z.object({ source: z.literal('environment') }).strict(),
  z
    .object({
      source: z.literal('vault'),
      versionId: z.uuid(),
      revision: z.number().int().positive(),
      updatedAt: z.iso.datetime(),
    })
    .strict(),
])
export type CredentialVersion = z.infer<typeof credentialVersionSchema>
export const credentialResolutionSchema = z
  .object({
    slot: z.number().int().min(1).max(256),
    resolvedAt: z.iso.datetime(),
    version: credentialVersionSchema,
  })
  .strict()
export const credentialResolutionsSchema = z
  .array(credentialResolutionSchema)
  .max(256)
  .refine((entries) => new Set(entries.map((entry) => entry.slot)).size === entries.length)
export type CredentialResolution = z.infer<typeof credentialResolutionSchema>
export type CredentialPurpose =
  'model-auth' | 'model-header' | 'mcp-auth' | 'mcp-header' | 'mcp-env' | 'other'
export interface CredentialReport {
  checkedAt: string
  entries: {
    slot: number
    source: 'vault' | 'environment'
    purposes: CredentialPurpose[]
    state: 'same' | 'changed' | 'missing' | 'unverified' | 'environment' | 'unavailable'
    attachment: { revision: number; updatedAt: string; resolvedAt: string } | null
    current: { revision: number; updatedAt: string } | null
  }[]
}
