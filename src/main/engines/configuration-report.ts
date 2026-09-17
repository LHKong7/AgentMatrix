import type {
  ConfigurationCheck,
  ConfigurationField,
  ConfigurationReport,
} from '../../shared/engines/configuration-report'
import type { RunInputManifest } from '../../shared/engines/run-inputs'
import type { EngineWorkspace } from '../../shared/engines/workspace'
import type { SessionSnapshot } from '../../shared/sessions/schema'
import { resolveAgentProfile } from '../../shared/engines/resolution'
import { RuntimeFailure } from './runtime'
import { piThinking } from './adapters/pi/configuration'

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`
  return JSON.stringify(value)
}
const connectionIdentity = (value: RunInputManifest['connection']) => ({
  id: value.id,
  protocol: value.protocol,
  baseUrl: value.baseUrl,
  auth: value.auth,
  headers: value.headers,
  secretHeaders: value.secretHeaders,
})
const installationIdentity = (value: RunInputManifest['installation']) => ({
  id: value.id,
  kind: value.kind,
  executable: value.executable,
  prefixArgs: value.prefixArgs,
  version: value.version,
  platform: value.platform,
  modes: value.modes,
})
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
  const resolved = resolveAgentProfile(workspace, snapshot.agentId)
  const current = resolved.status === 'resolved' ? resolved.configuration : null
  const desired: Record<ConfigurationField, unknown> | null = current
    ? {
        installation: installationIdentity(current.installation),
        connection: connectionIdentity(current.connection),
        authentication: {
          auth: current.connection.auth,
          secretHeaders: current.connection.secretHeaders,
        },
        model: current.model.modelId,
        sampling: {
          temperature: current.model.parameters.temperature,
          topP: current.model.parameters.topP,
        },
        reasoning: current.model.parameters.reasoning ?? null,
        execution: current.agent.execution,
        'engine-options': current.agent.engineOptions,
        prompts: current.prompts.map(({ assetId, version, source, mode }) => ({
          assetId,
          version,
          source,
          mode,
        })),
        skills: current.skills.map(({ assetId, revision, source, name }) => ({
          assetId,
          version: revision.version,
          source,
          name,
        })),
        mcp: current.mcpServers,
        plugins: current.nativePlugins,
      }
    : null
  const captured: Record<ConfigurationField, unknown> = {
    installation: installationIdentity(manifest.installation),
    connection: connectionIdentity(manifest.connection),
    authentication: {
      auth: manifest.connection.auth,
      secretHeaders: manifest.connection.secretHeaders,
    },
    model: manifest.model.modelId,
    sampling: {
      temperature: manifest.model.parameters.temperature,
      topP: manifest.model.parameters.topP,
    },
    reasoning: manifest.model.parameters.reasoning ?? null,
    execution: manifest.agent.execution,
    'engine-options': manifest.agent.engineOptions,
    prompts: manifest.prompts.map(({ assetId, version, source, mode }) => ({
      assetId,
      version,
      source,
      mode,
    })),
    skills: manifest.skills.map(({ assetId, version, source, name }) => ({
      assetId,
      version,
      source,
      name,
    })),
    mcp: manifest.mcpServers,
    plugins: manifest.nativePlugins,
  }
  const kind = manifest.installation.kind
  const evidence: Partial<Record<ConfigurationField, ConfigurationCheck[]>> = {
    installation: ['cli.version'],
    ...(kind === 'opencode'
      ? ({
          connection: ['opencode.config'],
          authentication: ['opencode.config'],
          model: ['opencode.config', 'opencode.session-model'],
          sampling:
            manifest.model.parameters.temperature !== undefined ||
            manifest.model.parameters.topP !== undefined
              ? ['opencode.config']
              : [],
          execution: ['opencode.config'],
          'engine-options': ['opencode.session-agent'],
          prompts: ['opencode.config'],
          skills: ['opencode.config'],
          mcp: ['opencode.config'],
        } as Partial<Record<ConfigurationField, ConfigurationCheck[]>>)
      : kind === 'pi'
        ? ({
            connection: ['pi.state'],
            model: ['pi.state'],
            reasoning: ['pi.state'],
            skills: ['pi.skills'],
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
              skills: ['dsh.composition'],
              mcp: ['dsh.composition'],
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
        changed: desired ? canonical(captured[id]) !== canonical(desired[id]) : null,
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
    observation,
    observationIsCurrent: Boolean(
      observation &&
      observation.runId === snapshot.runId &&
      ['ready', 'running', 'waiting', 'cancelling'].includes(snapshot.status),
    ),
    failure: snapshot.failure?.code ?? null,
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
      })),
    ],
    sources: manifest.externalSources.files.map((file) => ({
      path: file.path,
      exists: file.exists,
      digest: file.exists ? file.sha256 : null,
    })),
    sourceCoverage: manifest.externalSources.coverage,
  }
}
