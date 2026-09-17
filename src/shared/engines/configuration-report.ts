import { z } from 'zod'
import { entityId } from './schema'
import { contentDigest } from './run-inputs'
import type { SessionSnapshot } from '../sessions/schema'

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
  observation: ConfigurationObservation | null
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
  sourceCoverage: 'partial' | 'complete'
}
