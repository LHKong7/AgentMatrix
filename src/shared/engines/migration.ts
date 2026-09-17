import { appError } from '../errors'
import { workspaceSchema as legacyWorkspaceSchema } from '../workspace'
import { createEngineWorkspace, engineWorkspaceSchema, type EngineWorkspace } from './workspace'

/** Pure, deterministic conversion; the storage layer owns backup and atomic publication. */
export function migrateWorkspaceDocument(input: unknown): {
  workspace: EngineWorkspace
  migrated: boolean
} {
  if (typeof input !== 'object' || input === null || !('schemaVersion' in input)) {
    throw appError('error.schemaVersion')
  }
  if (input.schemaVersion === 2)
    return { workspace: engineWorkspaceSchema.parse(input), migrated: false }
  if (input.schemaVersion !== 1) throw appError('error.schemaVersion')
  const legacy = legacyWorkspaceSchema.parse(input)
  const workspace = createEngineWorkspace()
  workspace.revision = legacy.revision
  for (const agent of legacy.agents) {
    // IDs are namespaced by entity collection, preserving even 100-character legacy IDs.
    workspace.connections.push({
      id: agent.id,
      name: agent.name,
      protocol: null,
      baseUrl: agent.baseUrl,
      auth: { kind: 'unconfigured' },
      headers: {},
      secretHeaders: {},
      source: { legacyProvider: agent.provider },
    })
    workspace.models.push({
      id: agent.id,
      name: agent.name,
      connectionId: agent.id,
      modelId: agent.model,
      parameters: { temperature: agent.temperature },
    })
    workspace.prompts.push({
      id: agent.id,
      name: agent.name,
      description: '',
      enabled: true,
      purpose: 'unspecified',
      currentVersion: 1,
      versions: [{ version: 1, content: agent.systemPrompt }],
    })
    workspace.agents.push({
      id: agent.id,
      name: agent.name,
      description: agent.description,
      enabled: agent.enabled,
      engineInstallationId: null,
      modelProfileId: agent.id,
      promptBindings: [{ assetId: agent.id, selection: { follow: 'latest' }, mode: null }],
      mcpServerIds: [...agent.mcpServerIds],
      skillBindings: agent.skillIds.map((assetId) => ({
        assetId,
        selection: { follow: 'latest' },
      })),
      bundleIds: [...agent.pluginIds],
      nativePluginIds: [],
      engineOptions: null,
      execution: { cwd: '', approval: 'ask' },
    })
  }
  workspace.mcpServers = legacy.mcpServers.map((server) => {
    const common = {
      id: server.id,
      name: server.name,
      description: server.description,
      enabled: server.enabled,
    }
    return server.transport === 'stdio'
      ? {
          ...common,
          transport: 'stdio' as const,
          command: server.command,
          args: [...server.args],
          cwd: '',
          environment: {},
          envRefs: Object.fromEntries(
            Object.entries(server.envRefs).map(([key, name]) => [
              key,
              { kind: 'environment' as const, name },
            ]),
          ),
        }
      : {
          ...common,
          transport: 'streamable-http' as const,
          url: server.url,
          headers: {},
          secretHeaders: {},
          auth: server.bearerTokenEnv
            ? {
                kind: 'bearer' as const,
                secret: { kind: 'environment' as const, name: server.bearerTokenEnv },
              }
            : { kind: 'none' as const },
        }
  })
  workspace.skills = legacy.skills.map((skill) => ({
    id: skill.id,
    name: skill.name,
    description: skill.description,
    enabled: skill.enabled,
    sourcePath: skill.sourcePath,
    currentVersion: 1,
    versions: [{ version: 1, kind: 'markdown', content: skill.instructions }],
  }))
  workspace.bundles = legacy.plugins.map((plugin) => ({
    id: plugin.id,
    name: plugin.name,
    description: plugin.description,
    enabled: plugin.enabled,
    version: plugin.version,
    promptBindings: [],
    mcpServerIds: [...plugin.mcpServerIds],
    skillBindings: plugin.skillIds.map((assetId) => ({ assetId, selection: { follow: 'latest' } })),
  }))
  return { workspace: engineWorkspaceSchema.parse(workspace), migrated: true }
}
