import { z } from 'zod'
import { isVerifiedCapability, type Capability } from './schema'
import type { ConfigurationCheck } from './configuration-report'

/** Only consumed native protocol facts; never persist raw initialization responses. */
export const nativeRuntimeSchema = z.discriminatedUnion('protocol', [
  z
    .object({
      protocol: z.literal('acp'),
      version: z.literal(1),
      restoration: z.enum(['resume', 'load', 'unavailable']),
      restored: z.boolean(),
    })
    .strict()
    .refine((value) => !value.restored || value.restoration !== 'unavailable'),
  z
    .object({
      protocol: z.literal('pi-rpc'),
      restoration: z.literal('switch-session'),
      restored: z.boolean(),
    })
    .strict(),
])
export type NativeRuntimeObservation = z.infer<typeof nativeRuntimeSchema>
export const sessionCapabilityFeatures = [
  'installation-version',
  'session-protocol',
  'native-restore',
  'model-selection',
  'connection-mapping',
  'credential-resolution',
  'model-service',
  'sampling-mapping',
  'reasoning-selection',
  'prompt-mapping',
  'prompt-loading',
  'skill-mapping',
  'skill-discovery',
  'mcp-mapping',
  'mcp-connectivity',
  'plugin-activation',
  'policy-mapping',
  'policy-enforcement',
] as const
export type SessionCapabilityFeature = (typeof sessionCapabilityFeatures)[number]
export interface SessionCapability extends Capability {
  feature: SessionCapabilityFeature
  requested: boolean
  advertised: boolean | null
  checks: ConfigurationCheck[]
}
export interface SessionCapabilityReport {
  identity: {
    sessionId: string
    profileId: string
    snapshotDigest: string
    installationId: string
    engineVersion: string
    mode: Capability['mode']
    adapter: { id: string; version: string }
    connectionId: string
    protocol: string | null
    modelId: string
    runId: string | null
    nativeSessionId: string | null
  }
  observedAt: string | null
  current: boolean
  contractMatches: boolean
  capabilities: SessionCapability[]
}

/** Compare exact attachment identity. Callers must refresh lifecycle state before using the report. */
export function isCurrentSessionCapability(
  report: SessionCapabilityReport,
  feature: SessionCapabilityFeature,
  current: SessionCapabilityReport['identity'],
): boolean {
  const identity = report.identity
  const row = report.capabilities.find((entry) => entry.feature === feature)
  return Boolean(
    report.current &&
    report.contractMatches &&
    row &&
    identity.runId &&
    identity.nativeSessionId &&
    (Object.keys(identity) as (keyof typeof identity)[]).every((key) =>
      key === 'adapter'
        ? identity.adapter.id === current.adapter.id &&
          identity.adapter.version === current.adapter.version
        : identity[key] === current[key],
    ) &&
    isVerifiedCapability(row, {
      installationId: current.installationId,
      engineVersion: current.engineVersion,
      mode: current.mode,
      profileDigest: current.snapshotDigest,
    }),
  )
}
