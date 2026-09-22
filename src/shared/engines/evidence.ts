import { z } from 'zod'
import { sha256Hex } from '../digest'
import type { EngineProviderBinding } from './provider'
import {
  entityId,
  type AgentProfile,
  type EngineInstallation,
  type ModelConnection,
  type ModelProfile,
  type SecretReference,
} from './schema'

/**
 * What has actually been observed about a subject, in the order that costs more to obtain.
 * Finding a CLI on disk says nothing about whether its credential works, and a working credential
 * says nothing about whether a session starts, so each state is recorded separately.
 */
export const evidenceKinds = [
  'discovered',
  'configuration-valid',
  'connection-tested',
  'session-ready',
  'model-response',
] as const
export const evidenceKindSchema = z.enum(evidenceKinds)
export type EvidenceKind = (typeof evidenceKinds)[number]
export const evidenceSubjectKindSchema = z.enum(['installation', 'connection', 'binding', 'agent'])
export type EvidenceSubjectKind = z.infer<typeof evidenceSubjectKindSchema>
export const evidenceSubjectSchema = z
  .object({ kind: evidenceSubjectKindSchema, id: entityId })
  .strict()
export type EvidenceSubject = z.infer<typeof evidenceSubjectSchema>

export const verificationEvidenceSchema = z
  .object({
    id: entityId,
    subject: evidenceSubjectSchema,
    kind: evidenceKindSchema,
    result: z.enum(['pass', 'fail']),
    observedAt: z.iso.datetime(),
    /** The adapter that made the observation. */
    adapterVersion: z.string().min(1).max(100),
    /** The subject's state when it was observed; a different state retires the record. */
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    /** A message key or short native detail, never a credential. */
    detail: z.string().max(2000),
  })
  .strict()
export type VerificationEvidence = z.infer<typeof verificationEvidenceSchema>

interface EvidenceWorkspace {
  installations: EngineInstallation[]
  connections: ModelConnection[]
  models: ModelProfile[]
  agents: AgentProfile[]
  engineBindings: EngineProviderBinding[]
  evidence: VerificationEvidence[]
}

export function evidenceRank(kind: EvidenceKind): number {
  return evidenceKinds.indexOf(kind) + 1
}

/**
 * Whether what was observed covers what is being asked for.
 *
 * Observing more than was asked for counts — a model that answered proves its session started.
 * Observing less never does: a CLI found on disk is not a validated configuration, and a valid
 * configuration is not a tested credential. Nothing in this module promotes a record.
 */
export function meetsEvidence(observed: EvidenceKind | null, required: EvidenceKind): boolean {
  return observed !== null && evidenceRank(observed) >= evidenceRank(required)
}

const unit = '\u0000'
function secret(reference: SecretReference | null): string {
  if (!reference) return '-'
  return reference.kind === 'credential' ? `credential:${reference.id}` : `env:${reference.name}`
}
function describeConnection(connection: ModelConnection): string {
  const auth = connection.auth
  const authority =
    auth.kind === 'api-key'
      ? `api-key${unit}${auth.header}${unit}${secret(auth.secret)}`
      : auth.kind === 'bearer'
        ? `bearer${unit}${secret(auth.secret)}`
        : auth.kind === 'cloud-identity'
          ? `cloud-identity${unit}${auth.provider}${unit}${auth.profile ?? ''}`
          : auth.kind
  const identity = connection.provider
  return [
    connection.protocol ?? '-',
    connection.baseUrl,
    authority,
    ...Object.entries(connection.headers)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}: ${value}`),
    ...Object.entries(connection.secretHeaders)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}: ${secret(value)}`),
    identity
      ? `${identity.vendor}/${identity.product}/${identity.region}/${identity.organization}/${identity.endpointScope}`
      : '-',
  ].join(unit)
}
function describeInstallation(installation: EngineInstallation): string {
  return [
    installation.kind,
    installation.executable,
    installation.prefixArgs.join(' '),
    installation.platform,
    installation.version ?? '-',
    [...installation.modes].sort().join(','),
  ].join(unit)
}

/**
 * The subject's current state, as a digest. Evidence carries the fingerprint it was observed
 * under: when the state changes the record stops applying instead of vouching for the new one.
 */
export function fingerprintFor(
  workspace: EvidenceWorkspace,
  subject: EvidenceSubject,
): string | null {
  const find = <T extends { id: string }>(items: T[], id: string | null) =>
    items.find((item) => item.id === id) ?? null
  switch (subject.kind) {
    case 'installation': {
      const installation = find(workspace.installations, subject.id)
      return installation ? sha256Hex(describeInstallation(installation)) : null
    }
    case 'connection': {
      const connection = find(workspace.connections, subject.id)
      return connection ? sha256Hex(describeConnection(connection)) : null
    }
    case 'binding': {
      const binding = find(workspace.engineBindings, subject.id)
      if (!binding) return null
      const installation = find(workspace.installations, binding.installationId)
      const connection = find(workspace.connections, binding.connectionId)
      if (!installation || !connection) return null
      return sha256Hex(
        [
          describeInstallation(installation),
          describeConnection(connection),
          binding.route,
          binding.nativeProviderId,
          binding.adapterVersion,
        ].join(unit),
      )
    }
    case 'agent': {
      const agent = find(workspace.agents, subject.id)
      if (!agent) return null
      const installation = find(workspace.installations, agent.engineInstallationId)
      const model = find(workspace.models, agent.modelProfileId)
      const connection = find(workspace.connections, model?.connectionId ?? null)
      const binding =
        installation && connection
          ? (workspace.engineBindings.find(
              (item) =>
                item.installationId === installation.id && item.connectionId === connection.id,
            ) ?? null)
          : null
      return sha256Hex(
        [
          installation ? describeInstallation(installation) : '-',
          connection ? describeConnection(connection) : '-',
          model ? `${model.modelId}${unit}${JSON.stringify(model.parameters)}` : '-',
          binding ? `${binding.route}${unit}${binding.adapterVersion}` : '-',
          JSON.stringify(agent.engineOptions),
          agent.execution.cwd,
          agent.execution.approval,
        ].join(unit),
      )
    }
  }
}

export interface EvidenceStatus {
  /** The strongest state still observed for the subject as it stands now. */
  level: EvidenceKind | null
  /** Records that applied to an earlier state of the subject and no longer vouch for it. */
  stale: VerificationEvidence[]
  /** Current records that failed. A failure never cancels a separate passing observation. */
  failures: VerificationEvidence[]
  current: VerificationEvidence[]
}

export function evidenceStatus(
  workspace: EvidenceWorkspace,
  subject: EvidenceSubject,
): EvidenceStatus {
  const fingerprint = fingerprintFor(workspace, subject)
  const records = workspace.evidence.filter(
    (item) => item.subject.kind === subject.kind && item.subject.id === subject.id,
  )
  const current = fingerprint
    ? records.filter((item) => item.fingerprint === fingerprint)
    : ([] as VerificationEvidence[])
  const stale = records.filter((item) => !current.includes(item))
  const passing = current.filter((item) => item.result === 'pass')
  const level = passing.reduce<EvidenceKind | null>(
    (best, item) =>
      best === null || evidenceRank(item.kind) > evidenceRank(best) ? item.kind : best,
    null,
  )
  return {
    level,
    stale,
    failures: current.filter((item) => item.result === 'fail'),
    current,
  }
}

/** Whether the subject has been observed in this exact state, at or above the asked-for level. */
export function hasEvidence(
  workspace: EvidenceWorkspace,
  subject: EvidenceSubject,
  required: EvidenceKind,
): boolean {
  return meetsEvidence(evidenceStatus(workspace, subject).level, required)
}

/** One record per subject and kind; a newer observation of the same kind replaces the older. */
export function mergeEvidence(
  existing: VerificationEvidence[],
  entry: VerificationEvidence,
): VerificationEvidence[] {
  const kept = existing.filter(
    (item) =>
      item.id !== entry.id &&
      !(
        item.subject.kind === entry.subject.kind &&
        item.subject.id === entry.subject.id &&
        item.kind === entry.kind
      ),
  )
  return [...kept, entry]
}

/** Drops records whose subject is gone, so removing an engine cannot leave it vouched for. */
export function pruneEvidence(workspace: EvidenceWorkspace): VerificationEvidence[] {
  const present: Record<EvidenceSubjectKind, Set<string>> = {
    installation: new Set(workspace.installations.map((item) => item.id)),
    connection: new Set(workspace.connections.map((item) => item.id)),
    binding: new Set(workspace.engineBindings.map((item) => item.id)),
    agent: new Set(workspace.agents.map((item) => item.id)),
  }
  return workspace.evidence.filter((item) => present[item.subject.kind].has(item.subject.id))
}
