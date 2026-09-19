import type {
  ConfigurationCheck,
  ConfigurationField,
  ConfigurationReport,
} from '../../shared/engines/configuration-report'
import type { RunInputManifest } from '../../shared/engines/run-inputs'
import { buildMcpReport } from './mcp-report'
import type { EngineWorkspace } from '../../shared/engines/workspace'
import type { SessionSnapshot } from '../../shared/sessions/schema'
import { resolveAgentProfile, type ProfileResolution } from '../../shared/engines/resolution'
import { RuntimeFailure } from './runtime'
import { piThinking } from './adapters/pi/configuration'
import { capturedIntent, resolvedIntent, canonicalIntent } from '../../shared/engines/intent'
import { credentialReport } from './credential-report'
import type { CredentialVersions } from '../credentials/vault'
import { buildSessionCapabilities } from './session-capabilities'

const origin = (value: string) => {
  try {
    return new URL(value).origin
  } catch {
    return ''
  }
}

/** Read-only, allowlisted projection. Never resolve a credential or copy raw config, headers, prompts or argv. */
export function buildConfigurationReport(
  manifest: RunInputManifest,
  snapshot: SessionSnapshot,
  workspace: EngineWorkspace,
  resolved: ProfileResolution = resolveAgentProfile(workspace, snapshot.agentId),
  versions: CredentialVersions | null = null,
  skillEntries: Record<string, string> = {},
): ConfigurationReport {
  if (
    manifest.id !== snapshot.snapshotId ||
    manifest.digest !== snapshot.snapshotDigest ||
    manifest.agent.id !== snapshot.agentId ||
    manifest.installation.id !== snapshot.installationId ||
    manifest.installation.version !== snapshot.engineVersion ||
    manifest.cwd !== snapshot.cwd ||
    manifest.launch.mode !== snapshot.mode
  )
    throw new RuntimeFailure('configuration', 'report.identity')
  const observation = snapshot.configuration ?? null
  if (
    observation &&
    (observation.snapshotDigest !== manifest.digest ||
      observation.nativeSessionId !== snapshot.nativeSessionId)
  )
    throw new RuntimeFailure('configuration', 'report.evidence')
  const current = resolved.status === 'resolved' ? resolved.configuration : null
  const diagnostic = snapshot.failure?.configuration ?? null
  const desired = current ? resolvedIntent(current) : null
  const captured = capturedIntent(manifest)
  const configCheck: ConfigurationCheck = observation?.checks.includes('opencode.instance-config')
    ? 'opencode.instance-config'
    : 'opencode.config'
  const kind = manifest.installation.kind
  const evidence: Partial<Record<ConfigurationField, ConfigurationCheck[]>> = {
    installation: ['cli.version'],
    ...(kind === 'opencode'
      ? ({
          connection: [configCheck],
          authentication: [configCheck],
          model: [configCheck, 'opencode.session-model'],
          sampling:
            manifest.model.parameters.temperature !== undefined ||
            manifest.model.parameters.topP !== undefined
              ? [configCheck]
              : [],
          execution: [configCheck],
          'engine-options': ['opencode.session-agent'],
          prompts: [configCheck],
          skills: [
            configCheck,
            ...(observation?.checks.includes('opencode.instance-skills')
              ? ['opencode.instance-skills' as const]
              : []),
            ...(observation?.checks.includes('opencode.skill-sources')
              ? ['opencode.skill-sources' as const]
              : []),
          ],
          mcp: [configCheck],
          plugins: manifest.nativePlugins.length ? ['opencode.plugins'] : [],
        } as Partial<Record<ConfigurationField, ConfigurationCheck[]>>)
      : kind === 'pi'
        ? ({
            connection: ['pi.state'],
            model: ['pi.state'],
            reasoning: ['pi.state'],
            skills: [
              'pi.skills',
              ...(observation?.checks.includes('pi.skill-sources')
                ? ['pi.skill-sources' as const]
                : []),
            ],
            plugins: manifest.nativePlugins.length ? ['pi.plugins'] : [],
          } as Partial<Record<ConfigurationField, ConfigurationCheck[]>>)
        : kind === 'deepseek-harness'
          ? ({
              connection: ['dsh.composition'],
              authentication: ['dsh.composition'],
              model: ['dsh.session-model'],
              reasoning: ['dsh.session-reasoning'],
              execution: ['dsh.composition'],
              'engine-options': ['dsh.composition'],
              prompts: ['dsh.composition'],
              skills: [
                'dsh.composition',
                ...(observation?.checks.includes('dsh.skill-sources')
                  ? ['dsh.skill-sources' as const]
                  : []),
              ],
              mcp: ['dsh.composition'],
              plugins: manifest.nativePlugins.length ? ['dsh.plugins'] : [],
            } as Partial<Record<ConfigurationField, ConfigurationCheck[]>>)
          : {}),
  }
  const values: Record<ConfigurationField, string> = {
    installation: `${manifest.installation.kind} ${manifest.installation.version ?? ''}\n${manifest.executable.path}`,
    connection: `${manifest.connection.protocol ?? ''}\n${origin(manifest.connection.baseUrl)}`,
    authentication: manifest.connection.auth.kind,
    model: manifest.model.modelId,
    sampling:
      manifest.model.parameters.temperature !== undefined ||
      manifest.model.parameters.topP !== undefined
        ? JSON.stringify(captured.sampling)
        : 'default',
    reasoning:
      kind === 'pi'
        ? piThinking(manifest)
        : kind === 'deepseek-harness'
          ? (manifest.model.parameters.reasoning ?? 'off')
          : (manifest.model.parameters.reasoning ?? 'default'),
    execution: manifest.agent.execution.approval,
    'engine-options': JSON.stringify(manifest.agent.engineOptions),
    prompts: String(manifest.prompts.length),
    skills: String(manifest.skills.length),
    mcp: String(manifest.mcpServers.length),
    plugins: String(manifest.nativePlugins.length),
  }
  const fields: ConfigurationReport['fields'] = (Object.keys(captured) as ConfigurationField[]).map(
    (id) => {
      const checks = (evidence[id] ?? []).filter((check) => observation?.checks.includes(check))
      return {
        id,
        value: values[id],
        checks,
        status: !observation
          ? 'planned'
          : !checks.length || checks.length !== evidence[id]?.length
            ? 'unknown'
            : checks.every((check) => check === 'dsh.composition')
              ? 'composition'
              : 'observed',
        changed: desired ? canonicalIntent(captured[id]) !== canonicalIntent(desired[id]) : null,
        rejected: diagnostic?.fields.includes(id) ?? false,
      }
    },
  )
  return {
    sessionId: snapshot.id,
    snapshotId: manifest.id,
    snapshotDigest: manifest.digest,
    capturedAt: manifest.createdAt,
    workspaceRevision: manifest.workspaceRevision,
    currentWorkspaceRevision: workspace.revision,
    engine: kind,
    engineVersion: manifest.installation.version!,
    adapter: manifest.adapter,
    cwd: manifest.cwd,
    nativeSessionId: snapshot.nativeSessionId,
    observation: observation
      ? {
          runId: observation.runId,
          snapshotDigest: observation.snapshotDigest,
          nativeSessionId: observation.nativeSessionId,
          checkedAt: observation.checkedAt,
          checks: observation.checks,
        }
      : null,
    credentials: credentialReport(manifest, observation?.credentialResolutions, versions),
    retainedCredentialRedaction: manifest.redactionHistoryVersion === 1,
    capabilities: buildSessionCapabilities(manifest, snapshot),
    mcp: buildMcpReport(manifest, observation),
    observationIsCurrent: Boolean(
      observation &&
      observation.runId === snapshot.runId &&
      ['ready', 'running', 'waiting', 'cancelling'].includes(snapshot.status),
    ),
    failure: snapshot.failure?.code ?? null,
    diagnostic,
    overrideSources:
      diagnostic?.sourceMatches && kind === 'opencode'
        ? diagnostic.sourceMatches.flatMap((match) => {
            const source = manifest.externalSources.files[match.sourceIndex]
            if (!source?.exists) throw new RuntimeFailure('configuration', 'report.evidence')
            return [{ path: source.path, fields: match.fields }]
          })
        : null,
    savedState: !workspace.agents.some((agent) => agent.id === snapshot.agentId)
      ? 'missing'
      : !desired
        ? 'draft'
        : fields.some((field) => field.changed)
          ? 'pending'
          : 'same',
    fields,
    assets: [
      ...manifest.prompts.map((prompt) => ({
        kind: 'prompt' as const,
        id: prompt.assetId,
        version: prompt.version,
        source: prompt.source,
        mode: prompt.mode,
        path: prompt.path,
        digest: manifest.files.find((file) => file.path === prompt.path)?.sha256 ?? null,
        libraryVersion:
          workspace.prompts.find((item) => item.id === prompt.assetId)?.currentVersion ?? null,
        nextVersion:
          current?.prompts.find((item) => item.assetId === prompt.assetId)?.version ?? null,
        nativeSourceVerification: null,
        nativeEntry: null,
      })),
      ...manifest.skills.map((skill) => ({
        kind: 'skill' as const,
        id: skill.assetId,
        version: skill.version,
        source: skill.source,
        mode: null,
        path: skill.path,
        digest:
          skill.directoryDigest ??
          manifest.files.find((file) => file.path === `${skill.path}/SKILL.md`)?.sha256 ??
          null,
        libraryVersion:
          workspace.skills.find((item) => item.id === skill.assetId)?.currentVersion ?? null,
        nextVersion:
          current?.skills.find((item) => item.assetId === skill.assetId)?.revision.version ?? null,
        nativeSourceVerification:
          kind === 'pi' && observation?.checks.includes('pi.skill-sources')
            ? ('pi-rpc' as const)
            : kind === 'opencode' && observation?.checks.includes('opencode.instance-skills')
              ? ('opencode-acp' as const)
              : kind === 'opencode' && observation?.checks.includes('opencode.skill-sources')
                ? ('opencode-probe' as const)
                : kind === 'deepseek-harness' && observation?.checks.includes('dsh.skill-sources')
                  ? ('dsh-registry' as const)
                  : ('unknown' as const),
        nativeEntry: manifest.files.some((file) => file.path === skillEntries[skill.assetId])
          ? skillEntries[skill.assetId]!
          : null,
      })),
    ],
    sources: manifest.externalSources.files.map((file) => ({
      path: file.path,
      exists: file.exists,
      digest: file.exists ? file.sha256 : null,
    })),
    instructionSources: manifest.externalSources.instructionSources
      ? structuredClone(manifest.externalSources.instructionSources)
      : null,
    pluginDependencies:
      manifest.externalSources.pluginDependencies?.bindings.map((binding) => ({
        pluginId: binding.pluginId,
        name:
          manifest.nativePlugins.find((plugin) => plugin.id === binding.pluginId)?.name ??
          binding.pluginId,
        files: binding.files.map((path) =>
          structuredClone(manifest.externalSources.files.find((file) => file.path === path)!),
        ),
        unobserved: structuredClone(binding.unobserved),
      })) ?? null,
    resourceDirectories:
      manifest.externalSources.directories?.map((directory) => ({
        path: directory.path,
        kind: directory.kind,
        exists: directory.observation.exists,
        resolvedPath: directory.observation.exists ? directory.observation.resolvedPath : null,
        files: directory.observation.exists
          ? directory.observation.files.map((file) => ({
              path: file.path,
              resolvedPath: file.exists ? file.resolvedPath : null,
              exists: file.exists,
              digest: file.exists ? file.sha256 : null,
            }))
          : [],
      })) ?? null,
    sourceCoverage: manifest.externalSources.coverage,
  }
}
