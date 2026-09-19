import type { RunInputManifest } from '../../shared/engines/run-inputs'
import type { SessionSnapshot } from '../../shared/sessions/schema'
import type { ConfigurationCheck } from '../../shared/engines/configuration-report'
import { engineContracts, isSupportedEngine } from '../../shared/engines/contracts'
import {
  sessionCapabilityFeatures,
  type SessionCapabilityFeature,
  type SessionCapabilityReport,
} from '../../shared/engines/session-capabilities'
import type { Capability } from '../../shared/engines/schema'
import { credentialSlots } from './credential-report'
import { RuntimeFailure } from './runtime'
import { mcpObservation } from './mcp-report'

/** Aggregate only the captured session's evidence. Never transfer it to a saved-profile preview. */
export function buildSessionCapabilities(
  manifest: RunInputManifest,
  session: SessionSnapshot,
): SessionCapabilityReport {
  const observation = session.configuration
  const mcp = mcpObservation(manifest, observation)
  const native = observation?.nativeRuntime
  if (
    manifest.id !== session.snapshotId ||
    manifest.digest !== session.snapshotDigest ||
    manifest.agent.id !== session.agentId ||
    manifest.installation.id !== session.installationId ||
    manifest.installation.version !== session.engineVersion ||
    manifest.launch.mode !== session.mode ||
    manifest.cwd !== session.cwd ||
    (observation &&
      (observation.snapshotDigest !== manifest.digest ||
        observation.nativeSessionId !== session.nativeSessionId)) ||
    (native && native.protocol !== manifest.launch.mode)
  )
    throw new RuntimeFailure('configuration', 'report.capability-identity')
  const configCheck: ConfigurationCheck = observation?.checks.includes('opencode.instance-config')
    ? 'opencode.instance-config'
    : 'opencode.config'
  const kind = manifest.installation.kind
  const contract = isSupportedEngine(kind) ? engineContracts[kind] : null
  const contractMatches = Boolean(
    contract &&
    contract.id === manifest.adapter.id &&
    contract.version === manifest.adapter.version &&
    contract.engineVersion === manifest.installation.version &&
    contract.mode === manifest.launch.mode,
  )
  const current = Boolean(
    contractMatches &&
    observation &&
    observation.runId === session.runId &&
    ['ready', 'running', 'waiting', 'cancelling'].includes(session.status),
  )
  const slots = credentialSlots(manifest)
  const credentialsResolved =
    slots.length > 0 &&
    slots.every((slot) =>
      observation?.credentialResolutions?.some(
        (entry) =>
          entry.slot === slot.slot &&
          (entry.version.source === 'vault') === (slot.reference.kind === 'credential'),
      ),
    )
  const requested = (feature: SessionCapabilityFeature): boolean => {
    if (feature.startsWith('prompt-')) return manifest.prompts.length > 0
    if (feature.startsWith('skill-')) return manifest.skills.length > 0
    if (feature.startsWith('mcp-')) return manifest.mcpServers.length > 0
    if (feature === 'plugin-activation') return manifest.nativePlugins.length > 0
    if (feature === 'credential-resolution') return slots.length > 0
    if (feature === 'sampling-mapping')
      return (
        manifest.model.parameters.temperature !== undefined ||
        manifest.model.parameters.topP !== undefined
      )
    return true
  }
  const mappings: Partial<Record<SessionCapabilityFeature, ConfigurationCheck[]>> = {
    'installation-version': ['cli.version'],
    ...(kind === 'opencode'
      ? {
          'model-selection': [configCheck, 'opencode.session-model'],
          'connection-mapping': [configCheck],
          'sampling-mapping': [configCheck],
          'prompt-mapping': [configCheck],
          'skill-mapping': [configCheck],
          'mcp-mapping': [configCheck],
          'policy-mapping': [configCheck],
          'plugin-activation': ['opencode.plugins'],
        }
      : kind === 'pi'
        ? {
            'model-selection': ['pi.state'],
            'connection-mapping': ['pi.state'],
            'reasoning-selection': ['pi.state'],
            'skill-mapping': ['pi.skills'],
            'skill-discovery': ['pi.skills'],
            'plugin-activation': ['pi.plugins'],
          }
        : kind === 'deepseek-harness'
          ? {
              'model-selection': ['dsh.session-model'],
              'connection-mapping': ['dsh.composition'],
              'reasoning-selection':
                manifest.connection.protocol === 'deepseek-official'
                  ? ['dsh.session-reasoning']
                  : [],
              'prompt-mapping': ['dsh.composition'],
              'skill-mapping': ['dsh.composition'],
              'mcp-mapping': ['dsh.composition'],
              'policy-mapping': ['dsh.composition'],
              'plugin-activation': ['dsh.plugins'],
            }
          : {}),
  }
  const assessedAt = new Date().toISOString()
  return {
    identity: {
      sessionId: session.id,
      profileId: manifest.agent.id,
      snapshotDigest: manifest.digest,
      installationId: manifest.installation.id,
      engineVersion: session.engineVersion,
      mode: manifest.launch.mode,
      adapter: { ...manifest.adapter },
      connectionId: manifest.connection.id,
      protocol: manifest.connection.protocol,
      modelId: manifest.model.modelId,
      runId: observation?.runId ?? null,
      nativeSessionId: observation?.nativeSessionId ?? null,
    },
    observedAt: observation?.checkedAt ?? null,
    contractMatches,
    current,
    capabilities: sessionCapabilityFeatures.map((feature) => {
      const used = requested(feature)
      let mechanism: Capability['mechanism'] =
        feature.endsWith('-mapping') || feature === 'credential-resolution' ? 'adapter' : 'native'
      if (kind === 'pi' && feature.startsWith('mcp-')) mechanism = 'extension-required'
      if (
        (feature === 'sampling-mapping' &&
          (kind === 'deepseek-harness' ||
            (kind === 'pi' && !manifest.connection.protocol?.startsWith('openai-')))) ||
        (feature === 'reasoning-selection' &&
          (kind === 'opencode' ||
            (kind === 'deepseek-harness' &&
              manifest.connection.protocol !== 'deepseek-official'))) ||
        (feature === 'policy-enforcement' && kind === 'pi')
      )
        mechanism = 'unsupported'
      if (!contract) mechanism = 'unknown'
      const required = mappings[feature] ?? []
      const checks =
        contractMatches && used
          ? required.filter((check) => observation?.checks.includes(check))
          : []
      let verified = used && checks.length > 0 && checks.length === required.length
      let failed = false
      let advertised: boolean | null = null
      const evidence: Capability['evidence'] = [
        {
          kind: 'contract',
          source: contract ? `adapter:${contract.id}@${contract.version}` : 'adapter:unavailable',
          checkedAt: assessedAt,
        },
      ]
      if (observation && contractMatches && used) {
        if (feature === 'mcp-connectivity' && mcp) {
          verified = mcp.statuses.every((status) => status === 'connected')
          failed = mcp.statuses.some((status) => status !== 'connected' && status !== 'unknown')
          evidence.push({
            kind: 'runtime',
            source: 'opencode.mcp-status-at-attachment',
            checkedAt: mcp.checkedAt,
          })
        }
        for (const check of checks)
          evidence.push({ kind: 'runtime', source: check, checkedAt: observation.checkedAt })
        if (feature === 'credential-resolution' && credentialsResolved) {
          verified = true
          evidence.push({
            kind: 'runtime',
            source: 'launch.secret-resolution',
            checkedAt: observation.checkedAt,
          })
        }
        if (feature === 'session-protocol' && native) {
          verified = true
          evidence.push({
            kind: 'runtime',
            source:
              native.protocol === 'acp' ? 'acp.session-acknowledged' : 'pi.state-acknowledged',
            checkedAt: observation.checkedAt,
          })
        }
        if (feature === 'native-restore' && native) {
          if (native.protocol === 'acp') {
            advertised = native.restoration !== 'unavailable'
            evidence.push({
              kind: 'advertisement',
              source: `acp.restore.${native.restoration}`,
              checkedAt: observation.checkedAt,
            })
          }
          if (native.restored) {
            verified = true
            evidence.push({
              kind: 'runtime',
              source: `native.restore.${native.restoration}`,
              checkedAt: observation.checkedAt,
            })
          }
        }
      }
      const availability: Capability['availability'] = !contractMatches
        ? 'unknown'
        : mechanism === 'extension-required'
          ? 'missing-dependency'
          : mechanism === 'unsupported'
            ? 'blocked'
            : !used || !current
              ? 'unknown'
              : advertised === false || failed
                ? 'blocked'
                : verified || advertised === true
                  ? 'ready'
                  : 'unknown'
      const reason = !contractMatches
        ? 'contract-changed'
        : mechanism === 'extension-required'
          ? 'extension-required'
          : mechanism === 'unsupported'
            ? 'unsupported'
            : !used
              ? 'unused'
              : observation && !current
                ? 'historical'
                : failed
                  ? 'mcp-unavailable'
                  : advertised === false
                    ? 'not-advertised'
                    : verified
                      ? 'verified'
                      : advertised === true
                        ? 'advertised'
                        : 'unknown'
      return {
        feature,
        requested: used,
        advertised,
        checks,
        mechanism,
        verification: verified && contractMatches ? 'passed' : failed ? 'failed' : 'untested',
        availability,
        reason: `capability.reason.${reason}`,
        installationId: manifest.installation.id,
        engineVersion: session.engineVersion,
        mode: manifest.launch.mode,
        profileDigest: manifest.digest,
        evidence,
      }
    }),
  }
}
