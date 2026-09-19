import { z } from 'zod'
import {
  absolutePath,
  agentProfileSchema,
  engineInstallationSchema,
  entityId,
  environmentName,
  modelConnectionSchema,
  modelProfileSchema,
  runtimeModeSchema,
  secretReferenceSchema,
} from './schema'
import { assetRelativePath, mcpDefinitionSchema, nativePluginSchema } from './workspace'

export const contentDigest = z.string().regex(/^[a-f0-9]{64}$/)
export const inputFileSchema = z
  .object({
    path: assetRelativePath,
    sha256: contentDigest,
    bytes: z.number().int().nonnegative().max(20_000_000),
    executable: z.boolean(),
  })
  .strict()
export const externalFileSchema = z.discriminatedUnion('exists', [
  z.object({ path: absolutePath, exists: z.literal(false) }).strict(),
  z
    .object({
      path: absolutePath,
      exists: z.literal(true),
      resolvedPath: absolutePath,
      sha256: contentDigest,
      bytes: z.number().int().nonnegative(),
    })
    .strict(),
])
export const nativeResourceKindSchema = z.enum([
  'opencode-agent',
  'opencode-mode',
  'opencode-command',
])
export const externalDirectorySchema = z
  .object({
    path: absolutePath,
    kind: nativeResourceKindSchema,
    observation: z.discriminatedUnion('exists', [
      z.object({ exists: z.literal(false) }).strict(),
      z
        .object({
          exists: z.literal(true),
          resolvedPath: absolutePath,
          files: z
            .array(externalFileSchema)
            .max(1000)
            .refine((files) => new Set(files.map((file) => file.path)).size === files.length),
        })
        .strict(),
    ]),
  })
  .strict()
export type ExternalDirectory = z.infer<typeof externalDirectorySchema>
export const instructionSearchSchema = z
  .object({
    cwd: absolutePath,
    pattern: z
      .string()
      .min(1)
      .max(1024)
      .refine((value) => !value.includes('\0')),
    dot: z.boolean(),
  })
  .strict()
export const instructionSourcesSchema = z
  .object({
    version: z.literal(1),
    patterns: z
      .array(
        z
          .object({
            source: absolutePath,
            index: z.number().int().nonnegative(),
            searches: z.array(instructionSearchSchema).min(1).max(100),
            files: z.array(externalFileSchema).max(1000),
          })
          .strict(),
      )
      .max(200),
    unobserved: z
      .array(
        z
          .object({
            source: absolutePath,
            index: z.number().int().nonnegative().nullable(),
            reason: z.enum(['remote', 'dynamic', 'configuration']),
          })
          .strict(),
      )
      .max(1000),
  })
  .strict()
export type InstructionSearch = z.infer<typeof instructionSearchSchema>
export type InstructionSources = z.infer<typeof instructionSourcesSchema>
export const launchEnvironmentSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('literal'),
      value: z
        .string()
        .max(1_048_576)
        .refine((value) => !value.includes('\0')),
    })
    .strict(),
  z.object({ kind: z.literal('input-file'), path: assetRelativePath }).strict(),
  z.object({ kind: z.literal('input-directory'), path: assetRelativePath }).strict(),
  z.object({ kind: z.literal('state-directory'), path: assetRelativePath }).strict(),
  z
    .object({
      kind: z.literal('secret'),
      reference: secretReferenceSchema,
      encoding: z.enum(['raw', 'json-string']).optional(),
    })
    .strict(),
])
export const plannedLaunchSchema = z
  .object({
    mode: runtimeModeSchema,
    args: z
      .array(
        z
          .string()
          .max(8000)
          .refine((value) => !value.includes('\0')),
      )
      .max(200),
    environment: z.record(environmentName, launchEnvironmentSchema),
  })
  .strict()
export const runInputManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: entityId,
    createdAt: z.iso.datetime(),
    workspaceRevision: z.number().int().nonnegative(),
    adapter: z.object({ id: entityId, version: z.string().min(1).max(100) }).strict(),
    agent: agentProfileSchema,
    installation: engineInstallationSchema,
    executable: z
      .object({ path: absolutePath, sha256: contentDigest, bytes: z.number().int().positive() })
      .strict(),
    cwd: absolutePath,
    connection: modelConnectionSchema,
    model: modelProfileSchema,
    mcpServers: z.array(mcpDefinitionSchema).max(200),
    nativePlugins: z.array(nativePluginSchema).max(200),
    prompts: z
      .array(
        z
          .object({
            assetId: entityId,
            version: z.number().int().positive(),
            source: z.string().max(200),
            mode: z.enum(['append', 'replace', 'project-rule']),
            path: assetRelativePath,
          })
          .strict(),
      )
      .max(200),
    skills: z
      .array(
        z
          .object({
            assetId: entityId,
            version: z.number().int().positive(),
            source: z.string().max(200),
            name: z.string().max(80),
            path: assetRelativePath,
            directoryDigest: contentDigest.nullable(),
          })
          .strict(),
      )
      .max(200),
    launch: plannedLaunchSchema,
    externalSources: z
      .object({
        coverage: z.enum(['partial', 'complete']),
        files: z.array(externalFileSchema).max(1000),
        // No default: adding a field while reading a legacy snapshot would change its digest.
        directories: z.array(externalDirectorySchema).max(1000).optional(),
        instructionSources: instructionSourcesSchema.optional(),
      })
      .strict(),
    files: z.array(inputFileSchema).max(4096),
    digest: contentDigest,
  })
  .strict()
export type RunInputManifest = z.infer<typeof runInputManifestSchema>
export type PlannedLaunch = z.infer<typeof plannedLaunchSchema>
export type ExternalFile = z.infer<typeof externalFileSchema>

/** Adapter output contains references and templates, never resolved credential values. */
export const generatedInputsSchema = z
  .object({
    adapter: runInputManifestSchema.shape.adapter,
    launch: plannedLaunchSchema,
    promptPaths: z.record(entityId, assetRelativePath),
    skillPaths: z.record(entityId, assetRelativePath),
    files: z
      .array(
        z
          .object({
            path: assetRelativePath,
            content: z.string().max(20_000_000),
            executable: z.boolean().optional(),
          })
          .strict(),
      )
      .max(4096),
    externalSources: runInputManifestSchema.shape.externalSources,
  })
  .strict()
export type GeneratedInputs = z.infer<typeof generatedInputsSchema>
export interface RunPaths {
  root: string
  inputs: string
  state: string
}
