import { appError } from '../errors'
import { workspaceSchema as legacyWorkspaceSchema } from '../workspace'
import { adapterVersionFor, type EngineProviderBinding } from './provider'
import { createEngineWorkspace, engineWorkspaceSchema, type EngineWorkspace } from './workspace'

/**
 * Grants every engine the connections its own agents already point at.
 *
 * A workspace written before connections were granted per CLI has no record of the decision, but
 * it does have the decision itself: an agent naming an engine and a model is a user who wired
 * that engine to that connection. Those pairs, and only those, become bindings — a connection no
 * agent uses on an engine stays unavailable to it.
 */
function bindingsFromAgents(workspace: EngineWorkspace, at: string): EngineProviderBinding[] {
  const bindings: EngineProviderBinding[] = []
  for (const agent of workspace.agents) {
    const installation = workspace.installations.find(
      (item) => item.id === agent.engineInstallationId,
    )
    const model = workspace.models.find((item) => item.id === agent.modelProfileId)
    const connection = workspace.connections.find((item) => item.id === model?.connectionId)
    if (!installation || !connection || !connection.protocol) continue
    if (
      bindings.some(
        (binding) =>
          binding.installationId === installation.id && binding.connectionId === connection.id,
      )
    )
      continue
    bindings.push({
      id: `binding-${installation.id}-${connection.id}`.slice(0, 100),
      installationId: installation.id,
      connectionId: connection.id,
      route: connection.protocol,
      nativeProviderId: '',
      adapterVersion: adapterVersionFor(installation.kind),
      boundAt: at,
    })
  }
  return bindings
}

/** Pure, deterministic conversion; the storage layer owns backup and atomic publication. */
export function migrateWorkspaceDocument(
  input: unknown,
  now = new Date().toISOString(),
): {
  workspace: EngineWorkspace
  migrated: boolean
  from: 1 | 2
} {
  if (typeof input !== 'object' || input === null || !('schemaVersion' in input)) {
    throw appError('error.schemaVersion')
  }
  if (input.schemaVersion === 2) {
    const workspace = engineWorkspaceSchema.parse(input)
    // A document written before this release never decided which CLI may use which connection.
    if ('engineBindings' in input) return { workspace, migrated: false, from: 2 }
    return {
      workspace: engineWorkspaceSchema.parse({
        ...workspace,
        engineBindings: bindingsFromAgents(workspace, now),
      }),
      migrated: true,
      from: 2,
    }
  }
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
  // Legacy agents had no engine installation at all, so nothing is granted to any CLI yet.
  return { workspace: engineWorkspaceSchema.parse(workspace), migrated: true, from: 1 }
}
