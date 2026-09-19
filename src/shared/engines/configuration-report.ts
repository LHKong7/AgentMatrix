import { z } from 'zod'
import { entityId } from './schema'
import {
  contentDigest,
  type ExternalDirectory,
  type InstructionSources,
  type PluginDependencySources,
  type ExternalFile,
} from './run-inputs'
import type { SessionSnapshot } from '../sessions/schema'
import { credentialResolutionsSchema, type CredentialReport } from './credential-observation'
import { nativeRuntimeSchema, type SessionCapabilityReport } from './session-capabilities'
import { mcpObservationSchema, type McpReport } from './mcp-observation'

// Only fixed check identifiers cross the runtime boundary. Raw native configuration may contain keys.
export const configurationCheckSchema = z.enum([
  'inputs.integrity',
  'sources.unchanged',
  'cli.version',
  'opencode.config',
  'opencode.instance-config',
  'opencode.skill-sources',
  'opencode.instance-skills',
  'opencode.session-model',
  'opencode.session-agent',
  'opencode.plugins',
  'pi.state',
  'pi.skills',
  'pi.skill-sources',
  'pi.plugins',
  'dsh.composition',
  'dsh.mcp-startup',
  'dsh.skill-sources',
  'dsh.plugins',
  'dsh.session-model',
  'dsh.session-reasoning',
])
export type ConfigurationCheck = z.infer<typeof configurationCheckSchema>
export const configurationChecksSchema = z
  .array(configurationCheckSchema)
  .max(20)
  .refine((values) => new Set(values).size === values.length)
export const configurationObservationSchema = z
  .object({
    runId: entityId,
    snapshotDigest: contentDigest,
    nativeSessionId: z.string().min(1).max(1000),
    checkedAt: z.iso.datetime(),
    checks: configurationChecksSchema,
    credentialResolutions: credentialResolutionsSchema.optional(),
    nativeRuntime: nativeRuntimeSchema.optional(),
    mcpConnections: mcpObservationSchema.optional(),
  })
  .strict()
export type ConfigurationObservation = z.infer<typeof configurationObservationSchema>
export const configurationFieldSchema = z.enum([
  'installation',
  'connection',
  'authentication',
  'model',
  'sampling',
  'reasoning',
  'execution',
  'engine-options',
  'prompts',
  'skills',
  'mcp',
  'plugins',
])
export type ConfigurationField = z.infer<typeof configurationFieldSchema>
/** Fixed identifiers and captured source indices only; never native keys, values, paths or errors. */
export const configurationDiagnosticSchema = z
  .object({
    check: z.enum([
      'snapshot',
      'sources',
      'installation',
      'opencode-config',
      'opencode-instance-config',
      'opencode-skills',
      'opencode-instance-skills',
      'opencode-session',
      'pi-state',
      'pi-skills',
      'pi-controls',
      'dsh-composition',
      'dsh-mcp',
      'dsh-skills',
      'dsh-session',
      'dsh-controls',
    ]),
    reason: z.enum(['mismatch', 'unavailable', 'changed']),
    fields: z
      .array(configurationFieldSchema)
      .max(12)
      .refine((fields) => new Set(fields).size === fields.length),
    sourceMatches: z
      .array(
        z
          .object({
            sourceIndex: z.number().int().min(0).max(999),
            fields: z
              .array(configurationFieldSchema)
              .min(1)
              .max(12)
              .refine((fields) => new Set(fields).size === fields.length),
          })
          .strict(),
      )
      .max(1000)
      .optional(),
  })
  .strict()
  .refine(
    (value) =>
      !value.sourceMatches ||
      (['opencode-config', 'opencode-instance-config'].includes(value.check) &&
        value.reason === 'mismatch' &&
        new Set(value.sourceMatches.map((source) => source.sourceIndex)).size ===
          value.sourceMatches.length &&
        value.sourceMatches.every((source) =>
          source.fields.every((field) => value.fields.includes(field)),
        )),
  )
export type ConfigurationDiagnostic = z.infer<typeof configurationDiagnosticSchema>
export interface ConfigurationReport {
  sessionId: string
  snapshotId: string
  snapshotDigest: string
  capturedAt: string
  workspaceRevision: number
  currentWorkspaceRevision: number
  engine: string
  engineVersion: string
  adapter: { id: string; version: string }
  cwd: string
  nativeSessionId: string | null
  observation: Omit<
    ConfigurationObservation,
    'credentialResolutions' | 'nativeRuntime' | 'mcpConnections'
  > | null
  credentials: CredentialReport
  retainedCredentialRedaction: boolean
  mcp: McpReport
  capabilities: SessionCapabilityReport
  observationIsCurrent: boolean
  failure: NonNullable<SessionSnapshot['failure']>['code'] | null
  diagnostic: ConfigurationDiagnostic | null
  overrideSources: { path: string; fields: ConfigurationField[] }[] | null
  savedState: 'same' | 'pending' | 'draft' | 'missing'
  fields: {
    id: ConfigurationField
    value: string
    status: 'planned' | 'observed' | 'composition' | 'unknown'
    checks: ConfigurationCheck[]
    changed: boolean | null
    rejected: boolean
  }[]
  assets: {
    kind: 'prompt' | 'skill'
    id: string
    version: number
    source: string
    mode: 'append' | 'replace' | 'project-rule' | null
    path: string
    digest: string | null
    libraryVersion: number | null
    nextVersion: number | null
    nativeSourceVerification:
      'pi-rpc' | 'opencode-probe' | 'opencode-acp' | 'dsh-registry' | 'unknown' | null
    nativeEntry: string | null
  }[]
  sources: { path: string; exists: boolean; digest: string | null }[]
  instructionSources: InstructionSources | null
  pluginDependencies:
    | {
        pluginId: string
        name: string
        files: ExternalFile[]
        unobserved: PluginDependencySources['bindings'][number]['unobserved']
      }[]
    | null
  resourceDirectories:
    | {
        path: string
        kind: ExternalDirectory['kind']
        exists: boolean
        resolvedPath: string | null
        files: {
          path: string
          resolvedPath: string | null
          exists: boolean
          digest: string | null
        }[]
      }[]
    | null
  sourceCoverage: 'partial' | 'complete'
}
