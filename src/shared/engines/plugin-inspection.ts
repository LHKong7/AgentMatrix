import { z } from 'zod'
import { absolutePath, entityId } from './schema'

export const pluginInspectionQuerySchema = z
  .object({ installationId: entityId, path: absolutePath })
  .strict()

const inspectedFileSchema = z
  .object({
    path: absolutePath,
    resolvedPath: absolutePath,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    bytes: z.number().int().nonnegative(),
  })
  .strict()

/** A read-only observation, never an activation receipt or a persisted capability claim. */
export const pluginInspectionSchema = z
  .object({
    installationId: entityId,
    engineVersion: z.string().max(100).nullable(),
    resolverVersion: z.string().max(100),
    checkedAt: z.iso.datetime(),
    selectedPath: absolutePath,
    resolvedPath: absolutePath,
    localSpecifier: z.string().max(40000),
    entryKind: z.enum(['server-export', 'main', 'index', 'file']),
    entry: inspectedFileSchema,
    package: z
      .object({
        file: inspectedFileSchema,
        name: z.string().max(200).nullable(),
        version: z.string().max(100).nullable(),
        engineRange: z.string().max(200).nullable(),
      })
      .strict()
      .nullable(),
    verification: z.literal('files-only'),
    rangeStatus: z.enum([
      'matched',
      'mismatched',
      'undeclared',
      'invalid-range',
      'engine-unverified',
      'invalid-version',
    ]),
  })
  .strict()

export type PluginInspectionQuery = z.infer<typeof pluginInspectionQuerySchema>
// Retain this OpenCode shape unchanged: run captures use a subset of it for native identity.
export type OpenCodePluginInspection = z.infer<typeof pluginInspectionSchema>

const multiEngineInspectionSchema = z
  .object({
    engine: z.enum(['pi', 'deepseek-harness']),
    installationId: entityId,
    engineVersion: z.string().max(100).nullable(),
    resolverVersion: z.string().max(100),
    checkedAt: z.iso.datetime(),
    selectedPath: absolutePath,
    resolvedPath: absolutePath,
    localSpecifier: z.string().max(40000),
    entries: z.array(inspectedFileSchema).min(1).max(100),
    package: pluginInspectionSchema.shape.package.unwrap().omit({ engineRange: true }).nullable(),
    requirements: z
      .array(
        z
          .object({
            name: z.string().min(1).max(200),
            range: z.string().max(200).nullable(),
            version: z.string().max(100).nullable(),
            source: z.enum(['saved-engine', 'unverified-dependency']),
            status: pluginInspectionSchema.shape.rangeStatus,
          })
          .strict(),
      )
      .min(1)
      .max(8),
    verification: z.literal('files-only'),
  })
  .strict()

export const nativePluginInspectionSchema = z.union([
  pluginInspectionSchema.extend({ engine: z.literal('opencode') }),
  multiEngineInspectionSchema,
])
export type PluginInspection = z.infer<typeof nativePluginInspectionSchema>
