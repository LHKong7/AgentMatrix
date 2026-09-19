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
export const piImportKinds = [
  'models.json',
  'auth.json',
  'settings.json',
  'SYSTEM.md',
  'APPEND_SYSTEM.md',
] as const
export const piImportKindSchema = z.enum(piImportKinds)
export type PiImportKind = z.infer<typeof piImportKindSchema>
export const dshImportKinds = [
  'cordis.yml',
  'cordis.patch.yml',
  'settings.yaml',
  '.credentials.yaml',
] as const
export const dshImportKindSchema = z.enum(dshImportKinds)
export type DshImportKind = z.infer<typeof dshImportKindSchema>
export type NativeImportEngine = 'opencode' | 'pi' | 'deepseek-harness'
export interface OpenCodePromptReference {
  path: string
  reference: string
  mode: 'replace' | 'append'
  selectedPath?: string
}
export const nativeImportSourceSchema = z
  .object({
    path: absolutePath,
    resolvedPath: absolutePath,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    bytes: z.number().int().min(0).max(1_048_576),
  })
  .strict()
const recordBase = z
  .object({
    id: z.uuid(),
    installationId: entityId,
    importedAt: z.iso.datetime(),
    source: nativeImportSourceSchema,
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
            code: z.enum([
              'unconverted',
              'invalid-value',
              'unresolved-reference',
              'review-policy',
              'review-precedence',
              'review-prompt-selection',
            ]),
          })
          .strict(),
      )
      .max(4000),
  })
  .strict()
export const nativeImportRecordSchema = z.discriminatedUnion('engine', [
  recordBase
    .extend({
      engine: z.literal('opencode'),
      contractVersion: z.literal('1.18.16'),
      source: nativeImportSourceSchema.extend({ bytes: z.number().int().min(1).max(1_048_576) }),
      additionalSources: z
        .array(
          z
            .object({
              kind: z.literal('opencode-prompt'),
              referencePath: pointer,
              source: nativeImportSourceSchema,
            })
            .strict(),
        )
        .min(1)
        .max(16)
        .optional(),
    })
    .refine(
      (record) =>
        !record.additionalSources ||
        (new Set(record.additionalSources.map((file) => file.referencePath)).size ===
          record.additionalSources.length &&
          record.source.bytes +
            record.additionalSources.reduce((total, file) => total + file.source.bytes, 0) <=
            1_048_576),
    ),
  recordBase
    .extend({
      engine: z.literal('deepseek-harness'),
      contractVersion: z.literal('0.1.5-rc.2'),
      sourceKind: dshImportKindSchema,
      additionalSources: z
        .array(z.object({ kind: dshImportKindSchema, source: nativeImportSourceSchema }).strict())
        .max(3),
    })
    .refine(
      (record) =>
        new Set([record.sourceKind, ...record.additionalSources.map((item) => item.kind)]).size ===
          record.additionalSources.length + 1 &&
        record.source.bytes +
          record.additionalSources.reduce((total, item) => total + item.source.bytes, 0) <=
          1_048_576,
    ),
  recordBase
    .extend({
      engine: z.literal('pi'),
      contractVersion: z.literal('0.85.1'),
      sourceKind: piImportKindSchema,
      additionalSources: z
        .array(z.object({ kind: piImportKindSchema, source: nativeImportSourceSchema }).strict())
        .max(4),
    })
    .refine((record) => {
      const kinds = [record.sourceKind, ...record.additionalSources.map((item) => item.kind)]
      return (
        new Set(kinds).size === kinds.length &&
        record.source.bytes +
          record.additionalSources.reduce((total, item) => total + item.source.bytes, 0) <=
          1_048_576
      )
    }),
])
export type NativeImportRecord = z.infer<typeof nativeImportRecordSchema>
export function nativeImportSources(record: NativeImportRecord) {
  return record.engine !== 'opencode'
    ? [{ kind: record.sourceKind, source: record.source }, ...record.additionalSources]
    : [{ kind: 'opencode' as const, source: record.source }, ...(record.additionalSources ?? [])]
}
export interface NativeImportPreview {
  promptReferences?: OpenCodePromptReference[]
  id: string
  workspaceRevision: number
  record: NativeImportRecord
  entities: { collection: ImportCollection; id: string; name: string }[]
  credentials: number
  expiresAt: string
}
export const nativeImportQuerySchema = z
  .object({
    installationId: entityId,
    previousPreviewId: z.uuid().optional(),
    referencePath: pointer.optional(),
  })
  .strict()
  .refine((query) => query.referencePath === undefined || query.previousPreviewId !== undefined)
export const nativeImportApplySchema = z
  .object({ id: z.uuid(), workspaceRevision: z.number().int().nonnegative() })
  .strict()
