import { z } from 'zod'
import { absolutePath, entityId } from './schema'

export const importCollectionSchema = z.enum([
  'connections',
  'models',
  'agents',
  'prompts',
  'mcpServers',
])
export type ImportCollection = z.infer<typeof importCollectionSchema>
const pointer = z.string().max(4000)
export const nativeImportRecordSchema = z
  .object({
    id: z.uuid(),
    engine: z.literal('opencode'),
    installationId: entityId,
    contractVersion: z.literal('1.18.16'),
    importedAt: z.iso.datetime(),
    source: z
      .object({
        path: absolutePath,
        resolvedPath: absolutePath,
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        bytes: z.number().int().min(1).max(1_048_576),
      })
      .strict(),
    mappings: z
      .array(
        z
          .object({
            path: pointer,
            collection: importCollectionSchema,
            id: entityId,
            field: z.string().min(1).max(200),
          })
          .strict(),
      )
      .max(4000),
    diagnostics: z
      .array(
        z
          .object({
            path: pointer,
            code: z.enum(['unconverted', 'invalid-value', 'unresolved-reference', 'review-policy']),
          })
          .strict(),
      )
      .max(4000),
  })
  .strict()
export type NativeImportRecord = z.infer<typeof nativeImportRecordSchema>
export interface NativeImportPreview {
  id: string
  workspaceRevision: number
  record: NativeImportRecord
  entities: { collection: ImportCollection; id: string; name: string }[]
  credentials: number
  expiresAt: string
}
export const nativeImportQuerySchema = z.object({ installationId: entityId }).strict()
export const nativeImportApplySchema = z
  .object({ id: z.uuid(), workspaceRevision: z.number().int().nonnegative() })
  .strict()
