import { z } from 'zod'
import { displayName, entityId } from './engines/schema'

export const credentialInputSchema = z
  .object({
    id: entityId.optional(),
    name: displayName,
    kind: z.enum(['api-key', 'bearer']),
    value: z
      .string()
      .min(1)
      .max(65_536)
      .refine((value) => value.trim().length > 0 && !value.includes('\0')),
    expectedRevision: z.number().int().positive().nullable(),
  })
  .strict()
export const deleteCredentialSchema = z
  .object({ id: entityId, expectedRevision: z.number().int().positive() })
  .strict()
export type CredentialInput = z.infer<typeof credentialInputSchema>
export type DeleteCredentialInput = z.infer<typeof deleteCredentialSchema>
export interface CredentialMetadata {
  id: string
  name: string
  kind: 'api-key' | 'bearer'
  revision: number
  updatedAt: string
  configured: true
}
export interface CredentialStatus {
  available: boolean
  credentials: CredentialMetadata[]
}
