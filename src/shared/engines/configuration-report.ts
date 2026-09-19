import { z } from 'zod'
import { entityId } from './schema'
import { contentDigest, type ExternalDirectory } from './run-inputs'
import type { SessionSnapshot } from '../sessions/schema'
import { credentialResolutionsSchema, type CredentialReport } from './credential-observation'
import { nativeRuntimeSchema, type SessionCapabilityReport } from './session-capabilities'

// Only fixed check identifiers cross the runtime boundary. Raw native configuration may contain keys.
export const configurationCheckSchema = z.enum([
  'inputs.integrity',
  'sources.unchanged',
  'cli.version',
  'opencode.config',
  'opencode.session-model',
  'opencode.session-agent',
  'opencode.plugins',
  'pi.state',
  'pi.skills',
  'pi.plugins',
  'dsh.composition',
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
  })
  .strict()
export type ConfigurationObservation = z.infer<typeof configurationObservationSchema>
export type ConfigurationField =
  | 'installation'
  | 'connection'
  | 'authentication'
  | 'model'
  | 'sampling'
  | 'reasoning'
  | 'execution'
  | 'engine-options'
  | 'prompts'
  | 'skills'
  | 'mcp'
  | 'plugins'
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
  observation: Omit<ConfigurationObservation, 'credentialResolutions' | 'nativeRuntime'> | null
  credentials: CredentialReport
  capabilities: SessionCapabilityReport
  observationIsCurrent: boolean
  failure: NonNullable<SessionSnapshot['failure']>['code'] | null
  savedState: 'same' | 'pending' | 'draft' | 'missing'
  fields: {
    id: ConfigurationField
    value: string
    status: 'planned' | 'observed' | 'composition' | 'unknown'
    checks: ConfigurationCheck[]
    changed: boolean | null
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
  }[]
  sources: { path: string; exists: boolean; digest: string | null }[]
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
