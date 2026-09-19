import type {
  CredentialPurpose,
  CredentialReport,
  CredentialResolution,
} from '../../shared/engines/credential-observation'
import type { RunInputManifest } from '../../shared/engines/run-inputs'
import type { SecretReference } from '../../shared/engines/schema'
import type { CredentialVersions, ResolvedCredential } from '../credentials/vault'
import { RuntimeFailure } from './runtime'

type CredentialInputs = Pick<RunInputManifest, 'launch' | 'connection' | 'mcpServers'>
const key = (reference: SecretReference) =>
  JSON.stringify(
    reference.kind === 'credential'
      ? ['credential', reference.id]
      : ['environment', reference.name],
  )

/** Slots are stable within immutable inputs; secret IDs and environment names stay in main. */
export function credentialSlots(manifest: CredentialInputs) {
  const references = new Map<string, SecretReference>()
  for (const [, value] of Object.entries(manifest.launch.environment).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  ))
    if (value.kind === 'secret') references.set(key(value.reference), value.reference)
  return [...references.values()].map((reference, index) => {
    const purposes = new Set<CredentialPurpose>()
    const matches = (other: SecretReference | null) => other && key(other) === key(reference)
    if ('secret' in manifest.connection.auth && matches(manifest.connection.auth.secret))
      purposes.add('model-auth')
    if (Object.values(manifest.connection.secretHeaders).some(matches)) purposes.add('model-header')
    for (const mcp of manifest.mcpServers) {
      if (mcp.transport === 'stdio') {
        if (Object.values(mcp.envRefs).some(matches)) purposes.add('mcp-env')
      } else {
        if ('secret' in mcp.auth && matches(mcp.auth.secret)) purposes.add('mcp-auth')
        if (Object.values(mcp.secretHeaders).some(matches)) purposes.add('mcp-header')
      }
    }
    if (!purposes.size) purposes.add('other')
    return { slot: index + 1, reference, purposes: [...purposes] }
  })
}

export function trackCredentialResolution(
  manifest: CredentialInputs,
  resolve: (reference: SecretReference) => Promise<ResolvedCredential>,
) {
  const slots = credentialSlots(manifest)
  if (slots.length > 256) throw new RuntimeFailure('credentials')
  const resolved = new Map<string, Promise<ResolvedCredential>>()
  const observations = new Map<number, CredentialResolution>()
  return {
    async resolve(reference: SecretReference) {
      const slot = slots.find((item) => key(item.reference) === key(reference))
      if (!slot) throw new RuntimeFailure('credentials')
      let pending = resolved.get(key(reference))
      if (!pending) {
        pending = resolve(reference)
        resolved.set(key(reference), pending)
      }
      const result = await pending
      if ((reference.kind === 'credential') !== (result.version.source === 'vault'))
        throw new RuntimeFailure('credentials')
      observations.set(slot.slot, {
        slot: slot.slot,
        resolvedAt: result.resolvedAt,
        version: result.version,
      })
      return result.value
    },
    complete() {
      if (observations.size !== slots.length) throw new RuntimeFailure('credentials')
      return [...observations.values()].sort((left, right) => left.slot - right.slot)
    },
    clear() {
      resolved.clear()
    },
  }
}

export function credentialReport(
  manifest: CredentialInputs,
  observations: CredentialResolution[] | undefined,
  versions: CredentialVersions | null,
): CredentialReport {
  const slots = credentialSlots(manifest)
  if (
    observations?.some(
      (entry) =>
        !slots.some(
          (slot) =>
            slot.slot === entry.slot &&
            (slot.reference.kind === 'credential') === (entry.version.source === 'vault'),
        ),
    )
  )
    throw new RuntimeFailure('configuration', 'report.credentials')
  return {
    checkedAt: new Date().toISOString(),
    entries: slots.map(({ slot, reference, purposes }) => {
      const observed = observations?.find((entry) => entry.slot === slot)
      const attached = observed?.version.source === 'vault' ? observed.version : null
      const current =
        reference.kind === 'credential'
          ? versions?.entries.find((entry) => entry.id === reference.id)
          : null
      return {
        slot,
        purposes,
        source: reference.kind === 'credential' ? 'vault' : 'environment',
        attachment: attached
          ? {
              revision: attached.revision,
              updatedAt: attached.updatedAt,
              resolvedAt: observed!.resolvedAt,
            }
          : null,
        current: current ? { revision: current.revision, updatedAt: current.updatedAt } : null,
        state:
          reference.kind === 'environment'
            ? 'environment'
            : !versions?.available
              ? 'unavailable'
              : !current
                ? 'missing'
                : !attached || !current.versionId
                  ? 'unverified'
                  : attached.versionId === current.versionId &&
                      attached.revision === current.revision &&
                      attached.updatedAt === current.updatedAt
                    ? 'same'
                    : 'changed',
      }
    }),
  }
}
